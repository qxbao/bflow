import { mkdtemp, open, readFile, rm, type FileHandle } from "node:fs/promises";
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

describe("Slice 5 agent-registry regressions", () => {
  let folder: string;
  let stateFile: string;
  let time: Date;
  let registry: FileAgentRegistry;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "bflow-s5-reg-"));
    stateFile = join(folder, "registry.json");
    time = new Date("2026-10-31T00:00:00.000Z");
    registry = new FileAgentRegistry({ stateFile, clock: () => time });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });

  it("sweeps expired active:true leases to active:false, advances lastNow, and prunes stale renew receipts across observations and failed renewals while preserving monotonic fencing", async () => {
    await registry.upsert(config("agent-1"));
    await registry.upsert(config("agent-2"));

    const l1 = await registry.acquireLease({
      leaseId: "lease-1",
      agentId: "agent-1",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "att-1",
      ttlMs: 1_000,
      requestedAt: time.toISOString(),
      idempotencyKey: "acq-1"
    });
    const l2 = await registry.acquireLease({
      leaseId: "lease-2",
      agentId: "agent-2",
      runId: "run-1",
      taskId: "task-2",
      attemptId: "att-2",
      ttlMs: 1_000,
      requestedAt: time.toISOString(),
      idempotencyKey: "acq-2"
    });
    if (!l1.ok || !l2.ok) throw new Error("expected leases");

    const renewed = await registry.renewLease({
      leaseId: "lease-1",
      fencingToken: l1.value.fencingToken,
      expectedVersion: 0,
      ttlMs: 1_000,
      requestedAt: time.toISOString(),
      idempotencyKey: "renew:lease-1:0"
    });
    expect(renewed.ok).toBe(true);

    // Advance clock 2 hours past TTL expiry (mirrors production cutover report)
    time = new Date(time.getTime() + 2 * 60 * 60 * 1_000);

    // Observation (list) reconciles expired active:true leases on disk and updates lastNow
    const listed = await registry.list("developer");
    expect(listed.ok).toBe(true);

    const persistedAfterList = JSON.parse(await readFile(stateFile, "utf8")) as {
      lastNow: string;
      nextFencing: Record<string, number>;
      leases: Record<string, { active: boolean }>;
      receipts: Record<string, unknown>;
    };
    expect(persistedAfterList.leases["lease-1"]?.active).toBe(false);
    expect(persistedAfterList.leases["lease-2"]?.active).toBe(false);
    expect(persistedAfterList.lastNow).toBe(time.toISOString());
    expect(Object.keys(persistedAfterList.receipts).filter(k => k.startsWith("renew:"))).toEqual([]);
    expect(persistedAfterList.nextFencing["agent-1"]).toBe(1);
    expect(persistedAfterList.nextFencing["agent-2"]).toBe(1);

    // Acquire a new lease: fencingToken must continue monotonically at 2, then expire and fail renewLease
    const l3 = await registry.acquireLease({
      leaseId: "lease-3",
      agentId: "agent-1",
      runId: "run-1",
      taskId: "task-3",
      attemptId: "att-3",
      ttlMs: 1_000,
      requestedAt: time.toISOString(),
      idempotencyKey: "acq-3"
    });
    expect(l3).toMatchObject({ ok: true, value: { fencingToken: 2 } });

    time = new Date(time.getTime() + 5_000);
    const failedRenew = await registry.renewLease({
      leaseId: "lease-3",
      fencingToken: 2,
      expectedVersion: 0,
      ttlMs: 1_000,
      requestedAt: time.toISOString(),
      idempotencyKey: "renew:lease-3:0"
    });
    expect(failedRenew).toMatchObject({ ok: false, error: { code: "conflict" } });

    const persistedAfterFailedRenew = JSON.parse(await readFile(stateFile, "utf8")) as {
      lastNow: string;
      leases: Record<string, { active: boolean }>;
    };
    expect(persistedAfterFailedRenew.leases["lease-3"]?.active).toBe(false);
    expect(persistedAfterFailedRenew.lastNow).toBe(time.toISOString());
  });

  it("fails closed with structured validation OperationResult instead of throwing RangeError/corruption on non-finite clock Date", async () => {
    const brokenClockRegistry = new FileAgentRegistry({
      stateFile,
      clock: () => new Date(Number.NaN)
    });
    const res = await brokenClockRegistry.upsert(config("agent-nan"));
    expect(res).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("tolerates FUSE/NTFS directory fsync EINVAL/ENOTSUP/EPERM after atomic rename while failing closed on EIO", async () => {
    const fhProto = await getFileHandleProto(folder);
    const origSync = fhProto.sync;

    for (const code of ["EINVAL", "ENOTSUP", "EPERM"] as const) {
      vi.spyOn(fhProto, "sync").mockImplementation(async function (this: FileHandle) {
        const st = await this.stat();
        if (st.isDirectory()) {
          throw Object.assign(new Error(`directory fsync unsupported: ${code}`), { code });
        }
        return origSync.call(this);
      });

      const res = await registry.upsert(config(`agent-${code.toLowerCase()}`));
      expect(res).toEqual({ ok: true, value: undefined });
      vi.restoreAllMocks();
    }

    vi.spyOn(fhProto, "sync").mockImplementation(async function (this: FileHandle) {
      const st = await this.stat();
      if (st.isDirectory()) {
        throw Object.assign(new Error("Input/output error"), { code: "EIO" });
      }
      return origSync.call(this);
    });

    const ioRes = await registry.upsert(config("agent-eio"));
    expect(ioRes.ok).toBe(false);
  });
});
