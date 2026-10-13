import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileAgentRegistry } from "../src/index.js";

let folder: string;
let stateFile: string;
let time: Date;
let registry: FileAgentRegistry;
const config = (patch: Record<string, unknown> = {}) => ({
  agentId: "agent-1", role: "implementer", transport: "herdr", enabled: true, priority: 10,
  maxConcurrentTasks: 1, capabilities: ["typescript", "review"],
  settings: { provider: "openai", kind: "codex", execution: { paneId: "pane-1" } }, ...patch
});
const context = { runId: "run-1", taskId: "task-1", requiredCapabilities: ["typescript"] };
const acquire = (leaseId = "lease-1", key = leaseId) => ({ leaseId, agentId: "agent-1", runId: "run-1", taskId: leaseId, attemptId: `${leaseId}-attempt`, ttlMs: 1_000, requestedAt: time.toISOString(), idempotencyKey: key });

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "ai-flow-registry-"));
  stateFile = join(folder, "registry.json");
  time = new Date("2026-01-01T00:00:00.000Z");
  registry = new FileAgentRegistry({ stateFile, clock: () => time });
});
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

describe("file-backed agent registry", () => {
  it("validates configuration and resolves by role/capability/priority", async () => {
    expect(await registry.upsert(config({ maxConcurrentTasks: 0 }))).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await registry.upsert(config())).toEqual({ ok: true, value: undefined });
    expect(await registry.upsert(config({ agentId: "agent-2", priority: 20, capabilities: ["typescript"] }))).toMatchObject({ ok: true });
    expect(await registry.resolve("implementer", context)).toMatchObject({ ok: true, value: { agentId: "agent-2" } });
    expect(await registry.resolve("implementer", { ...context, preferredAgentId: "agent-1" })).toMatchObject({ ok: true, value: { agentId: "agent-1" } });
    expect(await registry.resolve("implementer", { ...context, requiredCapabilities: ["rust"] })).toEqual({ ok: true, value: null });
    expect(await registry.resolve("unknown", context)).toEqual({ ok: true, value: null });
    expect(await registry.resolve("", context)).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await registry.list("implementer")).toMatchObject({ ok: true, value: [{ agentId: "agent-1" }, { agentId: "agent-2" }] });
  });

  it("persists normalized agent IDs rather than unparsed caller values", async () => {
    expect(await registry.upsert(config({ agentId: " agent-1 " }))).toMatchObject({ ok: true });
    expect(await registry.resolve("implementer", context)).toMatchObject({ ok: true, value: { agentId: "agent-1" } });
  });

  it("serializes concurrent acquisitions across instances at capacity one", async () => {
    await registry.upsert(config());
    const second = new FileAgentRegistry({ stateFile, clock: () => time });
    const results = await Promise.all([registry.acquireLease(acquire("lease-a")), second.acquireLease(acquire("lease-b"))]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([{ error: { code: "conflict" } }]);
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    expect(Object.values(persisted.leases)).toHaveLength(1);
  });

  it("prevents two active leases for the same run/task/attempt", async () => {
    await registry.upsert(config({ maxConcurrentTasks: 2 }));
    await registry.acquireLease(acquire("lease-1"));
    expect(await registry.acquireLease({ ...acquire("lease-2"), taskId: "lease-1", attemptId: "lease-1-attempt" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("persists lease, release, idempotency and monotonic fencing across restart", async () => {
    await registry.upsert(config());
    const first = await registry.acquireLease(acquire());
    expect(first).toMatchObject({ ok: true, value: { fencingToken: 1, version: 0 } });
    if (!first.ok) throw new Error("expected lease");
    const restarted = new FileAgentRegistry({ stateFile, clock: () => time });
    expect(await restarted.acquireLease(acquire())).toEqual(first);
    expect(await restarted.acquireLease({ ...acquire(), ttlMs: 2_000 })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const release = { leaseId: "lease-1", fencingToken: first.value.fencingToken, expectedVersion: 0, releasedAt: time.toISOString(), idempotencyKey: "release-1" };
    expect(await restarted.releaseLease(release)).toEqual({ ok: true, value: undefined });
    expect(await registry.releaseLease(release)).toEqual({ ok: true, value: undefined });
    expect(await registry.acquireLease(acquire("lease-2"))).toMatchObject({ ok: true, value: { fencingToken: 2 } });
  });

  it("rejects stale token/version and expired lease, then frees capacity", async () => {
    await registry.upsert(config());
    const first = await registry.acquireLease(acquire());
    if (!first.ok) throw new Error("expected lease");
    const renew = { leaseId: "lease-1", fencingToken: 999, expectedVersion: 0, ttlMs: 1_000, requestedAt: time.toISOString(), idempotencyKey: "renew-1" };
    expect(await registry.renewLease(renew)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await registry.renewLease({ ...renew, fencingToken: first.value.fencingToken })).toMatchObject({ ok: true, value: { version: 1 } });
    expect(await registry.renewLease({ ...renew, fencingToken: first.value.fencingToken, idempotencyKey: "renew-2" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    time = new Date(time.getTime() + 2_000);
    expect(await registry.renewLease({ ...renew, fencingToken: first.value.fencingToken, expectedVersion: 1, idempotencyKey: "renew-3", requestedAt: time.toISOString() })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await registry.acquireLease(acquire("lease-2"))).toMatchObject({ ok: true, value: { fencingToken: 2 } });
  });

  it("guards active leases against config removal or capacity reduction", async () => {
    await registry.upsert(config({ maxConcurrentTasks: 2 }));
    await registry.acquireLease(acquire());
    await registry.acquireLease(acquire("lease-2"));
    expect(await registry.remove("agent-1")).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await registry.upsert(config({ maxConcurrentTasks: 1 }))).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await registry.upsert(config({ maxConcurrentTasks: 2, settings: { provider: "different", kind: "other" } }))).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await registry.remove("missing")).toEqual({ ok: true, value: false });
  });

  it("fails closed on corrupted or incompatible durable state", async () => {
    await writeFile(stateFile, "not json");
    expect(await registry.list()).toMatchObject({ ok: false, error: { code: "corruption" } });
    await writeFile(stateFile, JSON.stringify({ schemaVersion: 99 }));
    expect(await registry.list()).toMatchObject({ ok: false, error: { code: "corruption" } });
  });

  it("times out closed when the process-shared lock is unavailable", async () => {
    await writeFile(`${stateFile}.lock`, "held");
    expect(await registry.list(undefined, { timeoutMs: 20 })).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started" } });
  });
});
