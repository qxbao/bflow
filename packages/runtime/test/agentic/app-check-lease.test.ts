import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppCheckBrowserLeases, type AppCheckLease } from "../../src/agentic/app-check-lease.js";

let directory: string;
let clock: { now: number };
const now = () => new Date(clock.now);
const TTL = 60_000;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bflow-app-lease-test-"));
  clock = { now: Date.parse("2026-10-27T00:00:00.000Z") };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function requireLease(result: Awaited<ReturnType<AppCheckBrowserLeases["acquire"]>>): AppCheckLease {
  if (!result.ok) throw new Error(`expected lease, got ${result.code}`);
  return result.lease;
}

describe("AppCheckBrowserLeases", () => {
  it("grants one lease and reports busy with the current holder while it is live", async () => {
    const leases = new AppCheckBrowserLeases(directory, now);
    const first = requireLease(await leases.acquire("app-check-browser", "run-a", TTL));
    expect(first).toMatchObject({ resourceKey: "app-check-browser", holder: "run-a", fencingToken: 1 });
    const busy = await leases.acquire("app-check-browser", "run-b", TTL);
    expect(busy).toEqual({ ok: false, code: "busy", holder: "run-a", expiresAt: first.expiresAt });
  });

  it("renews a current lease and extends its expiry", async () => {
    const leases = new AppCheckBrowserLeases(directory, now);
    const lease = requireLease(await leases.acquire("app-check-browser", "run-a", TTL));
    clock.now += 30_000;
    const renewed = await leases.renew(lease, TTL);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(Date.parse(renewed.lease.expiresAt)).toBe(clock.now + TTL);
    expect(renewed.lease.leaseId).toBe(lease.leaseId);
    expect(renewed.lease.fencingToken).toBe(lease.fencingToken);
  });

  it("refuses renewal after expiry and keeps the expired lease unusable", async () => {
    const leases = new AppCheckBrowserLeases(directory, now);
    const lease = requireLease(await leases.acquire("app-check-browser", "run-a", TTL));
    clock.now += TTL;
    expect(await leases.renew(lease, TTL)).toEqual({ ok: false, code: "lease_expired" });
    expect(await leases.assertCurrent(lease)).toEqual({ ok: false, code: "lease_expired" });
  });

  it("takes over an expired lease with a larger fencing token and fails the old holder", async () => {
    const leases = new AppCheckBrowserLeases(directory, now);
    const old = requireLease(await leases.acquire("app-check-browser", "run-a", TTL));
    clock.now += TTL + 1;
    const fresh = requireLease(await leases.acquire("app-check-browser", "run-b", TTL));
    expect(fresh.fencingToken).toBe(old.fencingToken + 1);
    expect(fresh.leaseId).not.toBe(old.leaseId);
    expect(await leases.assertCurrent(old)).toEqual({ ok: false, code: "lease_lost" });
    expect(await leases.renew(old, TTL)).toEqual({ ok: false, code: "lease_lost" });
    expect((await leases.assertCurrent(fresh)).ok).toBe(true);
  });

  it("release is idempotent and a foreign release does not drop the new holder", async () => {
    const leases = new AppCheckBrowserLeases(directory, now);
    const old = requireLease(await leases.acquire("app-check-browser", "run-a", TTL));
    clock.now += TTL + 1;
    const fresh = requireLease(await leases.acquire("app-check-browser", "run-b", TTL));
    await leases.release(old);
    await leases.release(old);
    expect((await leases.assertCurrent(fresh)).ok).toBe(true);
    await leases.release(fresh);
    await leases.release(fresh);
    const next = requireLease(await leases.acquire("app-check-browser", "run-c", TTL));
    expect(next.fencingToken).toBe(fresh.fencingToken + 1);
  });

  it("never reissues a fencing token after release", async () => {
    const leases = new AppCheckBrowserLeases(directory, now);
    const first = requireLease(await leases.acquire("app-check-browser", "run-a", TTL));
    await leases.release(first);
    const second = requireLease(await leases.acquire("app-check-browser", "run-a", TTL));
    expect(second.fencingToken).toBe(first.fencingToken + 1);
  });

  it("keeps resource keys independent", async () => {
    const leases = new AppCheckBrowserLeases(directory, now);
    requireLease(await leases.acquire("browser-a", "run-a", TTL));
    expect((await leases.acquire("browser-b", "run-b", TTL)).ok).toBe(true);
  });

  it("shares state through the directory across instances", async () => {
    const writer = new AppCheckBrowserLeases(directory, now);
    const reader = new AppCheckBrowserLeases(directory, now);
    const lease = requireLease(await writer.acquire("app-check-browser", "run-a", TTL));
    expect(await reader.acquire("app-check-browser", "run-b", TTL)).toMatchObject({ ok: false, code: "busy", holder: "run-a" });
    expect((await reader.assertCurrent(lease)).ok).toBe(true);
    await reader.release(lease);
    expect((await writer.acquire("app-check-browser", "run-c", TTL)).ok).toBe(true);
  });

  it("persists owner-only state files and rejects a corrupted state file", async () => {
    const leases = new AppCheckBrowserLeases(directory, now);
    requireLease(await leases.acquire("app-check-browser", "run-a", TTL));
    const state = JSON.parse(await readFile(join(directory, "app-check-leases.json"), "utf8"));
    expect(state).toMatchObject({ schemaVersion: 1, resources: { "app-check-browser": { fencingToken: 1 } } });
    expect((await stat(join(directory, "app-check-leases.json"))).mode & 0o777).toBe(0o600);
    await writeFile(join(directory, "app-check-leases.json"), "{not json");
    await expect(leases.acquire("app-check-browser", "run-b", TTL)).rejects.toThrow();
  });

  it("removes a stale lock left by a crashed writer but waits for a live one", async () => {
    const leases = new AppCheckBrowserLeases(directory, now);
    const lock = join(directory, "app-check-leases.lock");
    await writeFile(lock, "");
    const { utimes } = await import("node:fs/promises");
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    requireLease(await leases.acquire("app-check-browser", "run-a", TTL));
    await writeFile(lock, "");
    await expect(leases.acquire("app-check-browser", "run-b", TTL)).rejects.toThrow(/lock/);
    await rm(lock, { force: true });
  });
});
