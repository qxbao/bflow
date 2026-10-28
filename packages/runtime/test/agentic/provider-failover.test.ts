import { afterEach, describe, expect, it } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanups, fixture, git } from "../helpers/agentic-integration-fixture.js";
import { AgenticJournal } from "../../src/agentic/journal.js";
const target = { provider: "codex", model: "backup-model", profile: "backup" };
const policy = { schemaVersion: 3, policyVersion: "approved-1", role: "developer", candidates: [target], maxSwitches: 2, cooldownMs: 0, maxRetries: 2 };
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(options: { tdd?: boolean } = {}) {
  const f = await fixture(options);
  let mutationSafe = true, stopped = true;
  const selected: unknown[] = [];
  (f.ports as any).providerFailover = {
    policyFor: () => ({ policy, current: { provider: "claude", model: "primary-model", profile: "primary" } }),
    authenticate: async () => true,
    assertMutationSafe: async () => { if (!mutationSafe) throw new Error("unknown mutation"); },
    preflight: async (candidate: unknown) => { selected.push(candidate); }
  };
  f.ports.stopDeveloperExecutionScope = async handle => stopped ? { source: "correlated_transport", handle, observedAt: new Date().toISOString() } : undefined;
  const allocate = f.panes.allocateDeveloper.bind(f.panes);
  (f.panes as any).allocateDeveloper = async (request: any) => {
    const result = await allocate(request);
    Object.assign(result.value, { provider: request.failoverCandidate?.provider ?? "claude", model: request.failoverCandidate?.model ?? "primary-model",
      session: { source: request.failoverCandidate?.provider ?? "claude", kind: "id", value: `native-${request.agentName}` } });
    return result;
  };
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
  const state = await f.runtime.inspect() as any;
  const out = state.outbound.find((item: any) => item.message.type === "task.assignment");
  const binding = f.panes.bindings.find(item => item.paneId === out.handle.target.paneId)!;
  const failure = { schemaVersion: 3, provider: "claude", kind: "quota_exhausted", source: "provider_structured",
    executionId: out.handle.executionId, observedAt: new Date().toISOString(), evidenceDigest: "a".repeat(64) };
  return { ...f, get runtime() { return f.runtime; }, out, binding, failure, selected, setMutationSafe: (value: boolean) => { mutationSafe = value; }, setStopped: (value: boolean) => { stopped = value; } };
}
describe("task provider continuation through real Runtime/Core/Git/Registry/storage", () => {
  it("preserves required TDD evidence and selects the host-validated source handover", async () => {
    const f = await setup({ tdd: true });
    await f.evidence("implement", "red");
    const before = await f.runtime.inspect("run-1") as any;
    const context = await f.runtime.taskHandover(f.binding, { runId: "run-1", taskId: "implement" }) as any;
    const proposed = await f.runtime.taskHandover(f.binding, { proposal: { schemaVersion: 1, binding: context.binding,
      content: { nextAction: "Continue the implementation after accepted Red", decisions: ["Keep the approved criteria"],
        disprovedHypotheses: [], untestedAngles: ["Fallback recovery"], references: [] } } }) as any;
    expect(proposed.handover.status).toBe("accepted");
    await f.runtime.observeProviderFailure(f.binding, f.failure); await f.runtime.continueProviderFailovers(); await f.runtime.flushOutbound();
    const run = await f.runtime.inspect("run-1") as any;
    expect(run.tasks[0].spec.strategy).toEqual(before.tasks[0].spec.strategy);
    const destination = run.tasks[0].failovers[0].destinationBinding;
    const resumed = await f.runtime.taskHandover(destination, {}) as any;
    expect(resumed.handover).toMatchObject({ status: "selected", envelope: { content: { nextAction: "Continue the implementation after accepted Red" } } });
  });
  it("blocks a stale source lease and a cancellation admitted before continuation", async () => {
    const f = await setup();
    await f.runtime.observeProviderFailure(f.binding, f.failure);
    const released = await f.ports.registry.releaseLease({ leaseId: f.out.lease.leaseId, fencingToken: f.out.lease.fencingToken,
      expectedVersion: f.out.lease.version, releasedAt: new Date().toISOString(), idempotencyKey: "revoke-source" });
    expect(released.ok).toBe(true);
    await f.runtime.continueProviderFailovers();
    expect((await f.runtime.inspect("run-1") as any).tasks[0].failovers[0]).toMatchObject({ phase: "blocked", reason: "lease_not_current" });
    await f.runtime.cancel("run-1", "Owner cancelled during failover"); await f.runtime.continueProviderFailovers(); await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.filter(item => item.role === "developer")).toHaveLength(1);
    expect((await f.runtime.inspect("run-1") as any).cancelled).toBe(true);
  });
  it("retains uncertain replacement delivery and the spent budget across restart without resending", async () => {
    const f = await setup();
    f.transport.customSendHandler = request => ({ ok: true, value: { status: "unknown_delivery", requestId: request.requestId,
      attemptId: request.attemptId, runId: request.runId, taskId: request.taskId, idempotencyKey: request.idempotency.key,
      target: request.target, observedAt: new Date().toISOString(), reason: "controlled lost acknowledgement", resendAllowed: false, manualInterventionRequired: true } });
    await f.runtime.observeProviderFailure(f.binding, f.failure); await f.runtime.continueProviderFailovers(); await f.runtime.flushOutbound();
    const before = (await f.runtime.inspect("run-1") as any).tasks[0].failovers[0];
    f.restart(); await f.runtime.continueProviderFailovers(); await f.runtime.flushOutbound();
    const after = (await f.runtime.inspect("run-1") as any).tasks[0].failovers[0];
    expect(after.spentAt).toBe(before.spentAt);
    expect(after.phase).toBe("allocated");
    expect(f.transport.sentRequests.filter(item => item.role === "developer")).toHaveLength(2);
  });
  it("does not return to a tried profile or exceed the switch limit after another quota failure", async () => {
    const f = await setup();
    (f.ports.providerFailover as any).policyFor = () => ({ policy: { ...policy, maxSwitches: 1 }, current: { provider: "claude", model: "primary-model", profile: "primary" } });
    await f.runtime.observeProviderFailure(f.binding, f.failure); await f.runtime.continueProviderFailovers(); await f.runtime.flushOutbound();
    const run = await f.runtime.inspect("run-1") as any, next = run.tasks[0].failovers[0].destinationBinding;
    const state = await f.runtime.inspect() as any;
    const source = state.outbound.find((out: any) => out.message.message_id === run.tasks[0].failovers[0].destinationMessageId);
    await f.runtime.observeProviderFailure(next, { ...f.failure, provider: "codex", executionId: source.handle.executionId,
      observedAt: new Date().toISOString(), evidenceDigest: "b".repeat(64) });
    await f.runtime.continueProviderFailovers(); await f.runtime.flushOutbound();
    expect((await f.runtime.inspect("run-1") as any).tasks[0].failovers[1]).toMatchObject({ phase: "blocked", reason: "switch_budget_exhausted" });
    expect(f.transport.sentRequests.filter(item => item.role === "developer")).toHaveLength(2);
  });
  it("uses a bounded conservative retry on the same approved profile for transient rate limits", async () => {
    const f = await setup();
    let clock = Date.now(); f.ports.clock = () => new Date(clock);
    await f.runtime.observeProviderFailure(f.binding, { ...f.failure, kind: "transient_rate_limit" });
    await f.runtime.continueProviderFailovers();
    expect(f.transport.sentRequests.filter(item => item.role === "developer")).toHaveLength(1);
    clock += 61_000;
    await f.runtime.continueProviderFailovers(); await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.filter(item => item.role === "developer")).toHaveLength(2);
    const entry = (await f.runtime.inspect("run-1") as any).tasks[0].failovers[0];
    expect(entry.destination).toEqual({ provider: "claude", model: "primary-model", profile: "primary" });
    expect(entry.phase).toBe("dispatched");
  });
  it.each(["observed", "stopping", "stopped", "retired", "allocating", "allocated", "dispatched"])("preserves intent and budget across restart after durable %s", async phase => {
    const f = await setup();
    const exclusive = AgenticJournal.prototype.exclusive;
    let crashed = false;
    AgenticJournal.prototype.exclusive = function(action: any) {
      return exclusive.call(this, (state: any, save: any) => action(state, async () => {
        await save();
        const entry = state.runs.flatMap((run: any) => run.tasks).flatMap((task: any) => task.failovers ?? [])[0];
        if (!crashed && entry?.phase === phase) { crashed = true; throw new Error("controlled durable-boundary crash"); }
      }));
    } as typeof exclusive;
    try {
      await f.runtime.observeProviderFailure(f.binding, f.failure);
      await f.runtime.continueProviderFailovers();
      await f.runtime.flushOutbound();
    } catch (error) { expect(String(error)).toContain("controlled durable-boundary crash"); }
    finally { AgenticJournal.prototype.exclusive = exclusive; }
    expect(crashed).toBe(true);
    f.restart();
    await f.runtime.continueProviderFailovers(); await f.runtime.flushOutbound();
    const run = await f.runtime.inspect("run-1") as any;
    const entry = run.tasks[0].failovers[0];
    expect(run.tasks[0].failovers).toHaveLength(1);
    expect(f.transport.sentRequests.filter(item => item.role === "developer").length).toBeLessThanOrEqual(2);
    if (phase === "allocating") {
      expect(entry.phase).toBe("blocked"); expect(entry.spentAt).toBeDefined();
    } else expect(entry.phase, JSON.stringify((await f.runtime.inspect() as any).outbound.map((out: any) => ({ status: out.status, error: out.error, type: out.message.type })))).toBe("dispatched");
  });
  it("adopts the exact pane after a crash following the allocation side effect", async () => {
    const f = await setup();
    await f.runtime.observeProviderFailure(f.binding, f.failure);
    const allocate = f.panes.allocateDeveloper.bind(f.panes);
    let allocations = 0;
    (f.panes as any).allocateDeveloper = async (request: any) => { allocations++; await allocate(request); throw new Error("crash after pane creation"); };
    await expect(f.runtime.continueProviderFailovers()).rejects.toThrow("crash after pane creation");
    (f.panes as any).allocateDeveloper = allocate;
    f.restart(); await f.runtime.continueProviderFailovers(); await f.runtime.flushOutbound();
    expect(allocations).toBe(1);
    expect((await f.runtime.inspect("run-1") as any).tasks[0].failovers[0].phase).toBe("dispatched");
  });
  it("continues on an approved provider with the same worktree, specification and task attempt", async () => {
    const f = await setup(), path = f.binding.worktreePath!;
    await writeFile(join(path, "guide.md"), "unfinished work\n");
    const before = await f.runtime.inspect("run-1") as any;
    await (f.runtime as any).observeProviderFailure(f.binding, f.failure);
    await (f.runtime as any).continueProviderFailovers();
    await f.runtime.flushOutbound();
    const state = await f.runtime.inspect() as any;
    const assignments = state.outbound.filter((item: any) => item.message.type === "task.assignment");
    expect(assignments).toHaveLength(2);
    expect(assignments[1].handle.target.worktreePath).toBe(path);
    expect(assignments[1].handle.executionId).not.toBe(f.out.handle.executionId);
    expect(assignments[1].handle.attemptId).toBe(f.out.handle.attemptId);
    expect(assignments[1].message.payload.specification).toEqual(before.tasks[0].spec.specification);
    expect(await readFile(join(path, "guide.md"), "utf8")).toBe("unfinished work\n");
    expect(git(path, "rev-parse", "HEAD")).toBe(before.tasks[0].worktrees[0].baseCommitHash);
    expect((await f.runtime.inspect("run-1") as any).status).not.toBe("completed");
    await expect(f.runtime.withDeveloperWorkspace(f.binding, "run-1", "implement", async () => undefined)).rejects.toThrow();
    await f.evidence("implement"); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
    const verified = await f.runtime.inspect("run-1") as any;
    expect(verified.status).toBe("awaiting_approval");
    expect(verified.tasks[0].verificationPlan.implementerIds).toEqual(expect.arrayContaining(assignments.map((item: any) => item.handle.target.agentId)));
  });
  it.each(["mutation", "running", "delivery"])("holds the task for %s uncertainty", async condition => {
    const f = await setup();
    if (condition === "mutation") f.setMutationSafe(false);
    if (condition === "running") f.setStopped(false);
    if (condition === "delivery") await f.runtime.recordNativeDeliveryIntent(f.envelope("task.status", { status: "blocked" }), "uncertain-operation");
    await (f.runtime as any).observeProviderFailure(f.binding, f.failure);
    await (f.runtime as any).continueProviderFailovers();
    await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.filter(item => item.role === "developer")).toHaveLength(1);
  });
  it("blocks an incompatible candidate and reports the exhausted approved chain", async () => {
    const f = await setup();
    (f.ports as any).providerFailover.preflight = async () => { throw new Error("missing required tool"); };
    await (f.runtime as any).observeProviderFailure(f.binding, f.failure);
    await (f.runtime as any).continueProviderFailovers();
    const run = await f.runtime.inspect("run-1") as any;
    expect(run.status).toBe("escalated");
    expect(run.tasks[0].failovers[0]).toMatchObject({ phase: "blocked", reason: "no_eligible_candidate" });
    expect(f.transport.sentRequests.filter(item => item.role === "developer")).toHaveLength(1);
  });
  it("refuses a stale or unauthenticated observation before recording switch intent", async () => {
    const f = await setup();
    await expect((f.runtime as any).observeProviderFailure(f.binding, { ...f.failure, executionId: "stale" })).rejects.toThrow();
    (f.ports as any).providerFailover.authenticate = async () => false;
    await expect((f.runtime as any).observeProviderFailure(f.binding, f.failure)).rejects.toThrow();
    expect((await f.runtime.inspect("run-1") as any).tasks[0].failovers).toBeUndefined();
  });
});
