import { mkdir, mkdtemp, open, readFile, rm, symlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileAgentRegistry } from "../src/index.js";

const config = (agentId = "agent-1", patch: Record<string, unknown> = {}) => ({
  agentId,
  role: "developer",
  transport: "herdr",
  enabled: true,
  priority: 10,
  maxConcurrentTasks: 1,
  capabilities: ["implementation"],
  settings: { provider: "openai", kind: "codex", execution: { paneId: `pane-${agentId}` } },
  ...patch
});

async function getFileHandleProto(folder: string): Promise<FileHandle> {
  const probe = await open(join(folder, ".fh-probe"), "w+");
  const proto = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  return proto;
}

describe("Round 2 Slice 5 agent-registry hardening", () => {
  let folder: string;
  let stateFile: string;
  let time: Date;
  let registry: FileAgentRegistry;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "bflow-r2s5-reg-"));
    stateFile = join(folder, "registry.json");
    time = new Date("2026-10-31T10:00:00.000Z");
    registry = new FileAgentRegistry({ stateFile, clock: () => time });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });

  it("tolerates FUSE/NTFS non-capability regular-file fsync codes (EINVAL, ENOTSUP, EPERM, EACCES, EROFS) while failing closed on real EIO/ENOSPC errors", async () => {
    const fhProto = await getFileHandleProto(folder);
    await registry.upsert(config("agent-1"));

    for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EROFS"]) {
      const spy = vi.spyOn(fhProto, "sync").mockImplementation(async function (this: FileHandle) {
        const st = await this.stat();
        if (st.isFile()) {
          throw Object.assign(new Error(`FUSE regular-file fsync unsupported: ${code}`), { code });
        }
      });

      const acquired = await registry.acquireLease({
        leaseId: `lease-${code}`,
        agentId: "agent-1",
        runId: "run-1",
        taskId: `task-${code}`,
        attemptId: `att-${code}`,
        ttlMs: 5_000,
        requestedAt: time.toISOString(),
        idempotencyKey: `acq-${code}`
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) throw new Error(acquired.error.message);

      const released = await registry.releaseLease({
        leaseId: acquired.value.leaseId,
        fencingToken: acquired.value.fencingToken,
        expectedVersion: acquired.value.version,
        releasedAt: time.toISOString(),
        idempotencyKey: `rel-${code}`
      });
      expect(released.ok).toBe(true);
      spy.mockRestore();
    }

    // Real storage I/O error (EIO) must still fail closed with corruption
    vi.spyOn(fhProto, "sync").mockImplementation(async function (this: FileHandle) {
      const st = await this.stat();
      if (st.isFile()) {
        throw Object.assign(new Error("Disk I/O failure"), { code: "EIO" });
      }
    });
    const failed = await registry.acquireLease({
      leaseId: "lease-eio",
      agentId: "agent-1",
      runId: "run-1",
      taskId: "task-eio",
      attemptId: "att-eio",
      ttlMs: 5_000,
      requestedAt: time.toISOString(),
      idempotencyKey: "acq-eio"
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "corruption" } });
  });

  it("heals persisted future clock skew in lastNow, sweeps expired active:true leases, and clamps future-skewed active leases without breaking monotonic fencing or expectedVersion release", async () => {
    await registry.upsert(config("agent-1", { maxConcurrentTasks: 2 }));

    // Simulate clock jumped +3 hours ahead before NTP corrected clock back to 10:00:00Z
    time = new Date("2026-10-31T13:00:00.000Z");
    const expiredDuringSkew = await registry.acquireLease({
      leaseId: "lease-skew-expired",
      agentId: "agent-1",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "att-1",
      ttlMs: 10_000,
      requestedAt: time.toISOString(),
      idempotencyKey: "acq-skew-1"
    });
    expect(expiredDuringSkew.ok).toBe(true);

    time = new Date("2026-10-31T13:00:15.000Z"); // 15s later: lease-skew-expired has expired, lease-skew-live has 30s TTL remaining
    const liveDuringSkew = await registry.acquireLease({
      leaseId: "lease-skew-live",
      agentId: "agent-1",
      runId: "run-1",
      taskId: "task-2",
      attemptId: "att-2",
      ttlMs: 30_000,
      requestedAt: time.toISOString(),
      idempotencyKey: "acq-skew-2"
    });
    if (!expiredDuringSkew.ok || !liveDuringSkew.ok) throw new Error("expected leases");

    // NTP steps system clock backward to real wall-clock 10:00:20Z
    time = new Date("2026-10-31T10:00:20.000Z");

    const postHealAcquire = await registry.acquireLease({
      leaseId: "lease-post-heal",
      agentId: "agent-1",
      runId: "run-1",
      taskId: "task-3",
      attemptId: "att-3",
      ttlMs: 60_000,
      requestedAt: time.toISOString(),
      idempotencyKey: "acq-post-heal"
    });
    expect(postHealAcquire.ok).toBe(true);
    if (!postHealAcquire.ok) throw new Error(postHealAcquire.error.message);

    // Monotonic fencing token preserved (1 -> 2 -> 3) and timestamps anchored to healed clock, NOT 13:00:15Z!
    expect(postHealAcquire.value.fencingToken).toBe(3);
    expect(postHealAcquire.value.acquiredAt).toBe("2026-10-31T10:00:20.000Z");
    expect(postHealAcquire.value.expiresAt).toBe("2026-10-31T10:01:20.000Z");

    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as {
      lastNow: string;
      leases: Record<string, { active: boolean; lease: { acquiredAt: string; expiresAt: string; version: number } }>;
    };
    expect(persisted.lastNow).toBe("2026-10-31T10:00:20.000Z");
    expect(persisted.leases["lease-skew-expired"]?.active).toBe(false);
    expect(persisted.leases["lease-skew-live"]?.active).toBe(true);
    // Remaining 30s TTL rebased onto 10:00:20Z so it expires at 10:00:50Z instead of staying wedged until 13:00:45Z!
    expect(persisted.leases["lease-skew-live"]?.lease.expiresAt).toBe("2026-10-31T10:00:50.000Z");

    // Original expectedVersion release safety on the rebased active lease still succeeds cleanly
    const releasedLive = await registry.releaseLease({
      leaseId: liveDuringSkew.value.leaseId,
      fencingToken: liveDuringSkew.value.fencingToken,
      expectedVersion: liveDuringSkew.value.version,
      releasedAt: time.toISOString(),
      idempotencyKey: "rel-skew-live"
    });
    expect(releasedLive.ok).toBe(true);
  });

  it("rejects symlink and directory stateFile collisions with O_NOFOLLOW + isFile() and serializes high-concurrency intra-process lease operations cleanly", async () => {
    // 1. Symlink stateFile pointing to a valid registry state file must still be rejected by O_NOFOLLOW
    const targetFile = join(folder, "real.json");
    const seedRegistry = new FileAgentRegistry({ stateFile: targetFile, clock: () => time });
    await seedRegistry.upsert(config("agent-seed"));
    const symlinkState = join(folder, "symlink-registry.json");
    await symlink(targetFile, symlinkState);
    const symRegistry = new FileAgentRegistry({ stateFile: symlinkState, clock: () => time });
    expect(await symRegistry.list()).toMatchObject({ ok: false, error: { code: "corruption" } });

    // 2. Directory stateFile collision rejected cleanly
    const dirState = join(folder, "dir-registry.json");
    await mkdir(dirState);
    const dirRegistry = new FileAgentRegistry({ stateFile: dirState, clock: () => time });
    expect(await dirRegistry.list()).toMatchObject({ ok: false, error: { code: "corruption" } });

    // 3. 12 concurrent intra-process acquire/release operations on same FileAgentRegistry serialize without lock starvation
    await registry.upsert(config("agent-concurrent", { maxConcurrentTasks: 12 }));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, idx) =>
        registry.acquireLease({
          leaseId: `conc-lease-${idx}`,
          agentId: "agent-concurrent",
          runId: "run-conc",
          taskId: `task-${idx}`,
          attemptId: `att-${idx}`,
          ttlMs: 30_000,
          requestedAt: time.toISOString(),
          idempotencyKey: `conc-acq-${idx}`
        })
      )
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const tokens = results
      .map((r) => (r.ok ? r.value.fencingToken : -1))
      .sort((a, b) => a - b);
    expect(tokens).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
