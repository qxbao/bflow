import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgenticJournal, digest } from "../../src/agentic/journal.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { CANCEL_STOP_OBSERVATION_LIMIT, DIRECTOR_LEGACY_RUN_MESSAGE } from "../../src/agentic/runtime.js";
import { evaluateWatchdog } from "../../src/agentic/run-watchdog.js";
import { buildDirectorProgressSnapshot } from "../../src/director/snapshot.js";
import { renderDirectorProgress } from "../../src/director/progress.js";
import { DirectorStore, DirectorTools } from "../../src/director/index.js";
import { cleanups, fixture, unwrap } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
const state = async (f: Fixture) => await f.runtime.inspect() as any;
const snapshot = async (f: Fixture) => unwrap(await f.ports.engine.getSnapshot("run-1"))!;
const journal = (f: Fixture) => new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository);
const park = (f: Fixture, taskId = "implement") => f.runtime.parkTask({ runId: "run-1", taskId, reason: "Tạm treo để xử lý sau", kind: "other", source: "director" });

async function running(parallel = false) {
  const f = await fixture({ director: true, parallel });
  f.def.maxConcurrency = 1;
  if (parallel) f.def.dependencies = [];
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
  await f.runtime.tick();
  const before = await state(f);
  const out = before.outbound.find((item: any) => item.message.type === "task.assignment");
  expect(out.status).toBe("accepted");
  for (const binding of f.panes.bindings.filter(item => item.role === "developer")) binding.metadata = { taskId: "run-1-implement", runId: "run-1" };
  f.ports.stopDeveloperExecutionScope = async handle => ({ source: "linux_pid_namespace", handle, observedAt: new Date().toISOString(),
    scopeId: randomUUID(), bootId: randomUUID(), initPid: 123, initStartTime: "1", namespace: "pid:[123]", receiptDigest: "a".repeat(64) });
  return { f, out };
}

/** Model the existing PaneManager's task/worktree ownership and one active-allocation capacity. */
async function queuedAllocation(beforeEnqueue = false) {
  const f = await fixture({ director: true, parallel: true });
  f.def.dependencies = []; f.def.maxConcurrency = 1;
  f.panes.busy.add("developer");
  const allocate = f.ports.panes.allocateDeveloper.bind(f.panes);
  let crashAfterAllocation = beforeEnqueue;
  vi.spyOn(f.ports.panes, "allocateDeveloper").mockImplementation(async request => {
    const active = f.panes.bindings.filter(binding => binding.role === "developer" && binding.metadata?.allocationStatus !== "released");
    const existing = active.find(binding => binding.metadata?.taskId === request.taskId);
    if (existing && existing.worktreePath !== request.worktreePath || !existing && active.length > 0)
      return { ok: false, error: { code: "conflict", retryable: true, message: "An active Developer allocation still owns capacity or another worktree" } };
    const result = await allocate(request);
    if (result.ok) result.value.metadata = { ...result.value.metadata, taskId: request.taskId, runId: request.runId, allocationStatus: "active" };
    if (crashAfterAllocation) { crashAfterAllocation = false; throw new Error("Controlled interruption after allocateDeveloper, before enqueue"); }
    return result;
  });
  const release = vi.spyOn(f.ports.panes, "releaseDeveloper").mockImplementation(async request => {
    const binding = f.panes.bindings.find(item => item.role === "developer" && item.metadata?.taskId === request.taskId && item.metadata?.allocationStatus !== "released");
    if (!binding) return { ok: false, error: { code: "not_found", retryable: false, message: "No active owned allocation" } };
    binding.metadata = { ...binding.metadata, allocationStatus: "released" };
    return { ok: true, value: undefined };
  });
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
  const binding = f.panes.bindings.find(item => item.role === "developer")!;
  expect(binding.metadata?.allocationStatus).toBe("active");
  expect((await snapshot(f)).tasks[0]!.agentExecution).toBeUndefined();
  return { f, binding, release };
}

describe("Runtime park/unpark", () => {
  it.each([false, true])("releases an allocated unsent writer (before enqueue=%s), then dispatches a sibling and a new unpark attempt", async beforeEnqueue => {
    const { f, binding, release } = await queuedAllocation(beforeEnqueue);
    const oldWorktree = binding.worktreePath;
    const oldOutbound = (await state(f)).outbound.find((item: any) => item.message.type === "task.assignment");
    if (beforeEnqueue) expect(oldOutbound).toBeUndefined();
    else { expect(oldOutbound.status).toBe("queued"); expect(oldOutbound.handle).toBeUndefined(); }
    expect(await park(f)).toMatchObject({ parked: true, runStatus: "implementing" });
    expect(release).toHaveBeenCalledWith({ taskId: "run-1-implement", closePane: false, removeWorktree: false });
    expect(binding.metadata?.allocationStatus).toBe("released");
    expect((await state(f)).runs[0].tasks[0]).toMatchObject({ writerReleased: true, parked: { episode: 1 } });
    expect(f.transport.cancelledHandles).toEqual([]);
    await readFile(join(oldWorktree!, "guide.md"), "utf8");
    f.panes.busy.delete("developer"); await f.runtime.tick();
    const sibling = (await state(f)).outbound.find((item: any) => item.taskId === "other" && item.message.type === "task.assignment");
    expect(sibling.status).toBe("accepted");
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", correlationVerified: true, observedAt: new Date().toISOString() } });
    await park(f, "other");
    const tick = vi.spyOn(f.runtime, "tick");
    await f.runtime.unparkTask({ runId: "run-1", taskId: "implement", source: "director" });
    await Promise.all(tick.mock.results.map(result => result.value));
    const latest = [...(await state(f)).outbound].reverse().find((item: any) => item.taskId === "implement" && item.message.type === "task.assignment");
    expect(latest.status).toBe("accepted");
    expect((await snapshot(f)).tasks[0]!.attempt).toBe(2);
    expect(latest.handle.target.worktreePath).not.toBe(oldWorktree);
    expect((await state(f)).runs[0].tasks[0].worktrees[0].worktreePath).toBe(oldWorktree);
  });

  it("retains an unsent allocation when owner/worktree is uncertain or release fails", async () => {
    const { f, binding, release } = await queuedAllocation();
    binding.metadata = { ...binding.metadata, runId: "foreign-run" };
    expect(await park(f)).toMatchObject({ parked: false });
    expect(release).not.toHaveBeenCalled();
    binding.metadata = { ...binding.metadata, runId: "run-1" };
    const worktree = binding.worktreePath!;
    binding.worktreePath = `${worktree}-foreign`;
    expect(await park(f)).toMatchObject({ parked: false });
    expect(release).not.toHaveBeenCalled();
    binding.worktreePath = worktree;
    release.mockImplementation(async () => ({ ok: false, error: { code: "conflict", retryable: true, message: "Controlled allocation release failure" } }));
    await expect(park(f)).rejects.toThrow("Controlled allocation release failure");
    expect((await snapshot(f)).tasks[0]!.status).toBe("running");
    expect((await state(f)).runs[0].tasks[0].writerReleased).not.toBe(true);
    expect((await state(f)).runs[0].tasks[0].parked).toBeUndefined();
    expect(binding.metadata?.allocationStatus).toBe("active");
  });

  it("parks a confirmed-stopped writer, releases its lease and dispatches an independent task on the next tick", async () => {
    const { f, out } = await running(true);
    await journal(f).exclusive(async (s, save) => {
      const run = s.runs[0]!;
      run.status = "escalated";
      run.pendingAction = { actionId: `next-${digest([run.runId, out.message.message_id])}`, kind: "resume_coordinator", owner: "coordinator", reason: "Task bị kẹt", sourceMessageId: out.message.message_id,
        createdAt: new Date().toISOString(), state: "pending", previousStatus: "implementing", recovery: "manual" };
      s.outbound.push({ message: { ...out.message, message_id: "queued-park-notice", idempotency_key: "queued-park-notice", type: "task.status", payload: { kind: "test-notice", taskId: "implement" } },
        status: "queued", selector: out.selector, taskId: "implement", attemptId: out.attemptId, capabilities: [], parentAssignmentId: out.message.message_id });
      await save();
    });
    const release = vi.spyOn(f.ports.registry, "releaseLease");
    expect(await park(f)).toMatchObject({ parked: true, runStatus: "implementing" });
    expect((await snapshot(f)).tasks[0]!.status).toBe("parked");
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ leaseId: out.lease.leaseId }));
    const parked = (await state(f)).runs[0].tasks[0];
    expect(parked).toMatchObject({ writerReleased: true, parked: { episode: 1, source: "director", kind: "other" } });
    expect(parked.worktrees).toHaveLength(1);
    expect((await state(f)).runs[0].pendingAction).toBeUndefined();
    expect((await state(f)).outbound.find((item: any) => item.message.message_id === "queued-park-notice")).toMatchObject({ status: "cancelled", error: "Task parked" });
    await f.runtime.tick();
    expect((await snapshot(f)).tasks.find(task => task.taskId === "other")!.status).toBe("running");
    expect((await state(f)).outbound.find((item: any) => item.taskId === "other" && item.message.type === "task.assignment").status).toBe("accepted");
    await f.evidence("other"); await f.submit("other"); await f.runtime.tick();
    expect((await state(f)).runs[0].status).toBe("completed_with_parked");
  });

  it("retains writer, lease and Core task when stop cannot be confirmed, with bounded observations", async () => {
    const { f, out } = await running();
    delete f.ports.stopDeveloperExecutionScope;
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "done", correlationVerified: true, observedAt: new Date().toISOString() } });
    const wait = vi.spyOn(f.transport, "wait");
    const release = vi.spyOn(f.ports.registry, "releaseLease");
    for (let n = 0; n < CANCEL_STOP_OBSERVATION_LIMIT + 2; n++) expect(await park(f)).toMatchObject({ parked: false, reason: expect.any(String) });
    expect(wait).toHaveBeenCalledTimes(CANCEL_STOP_OBSERVATION_LIMIT);
    expect(f.transport.cancelledHandles).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();
    expect((await snapshot(f)).tasks[0]!.status).toBe("running");
    const after = await state(f);
    expect(after.runs[0].tasks[0].parked).toBeUndefined();
    expect(after.runs[0].tasks[0].writerReleased).not.toBe(true);
    expect(after.outbound.find((item: any) => item.message.message_id === out.message.message_id).status).toBe("accepted");
  });

  it("rejects unknown delivery before attempting to stop or releasing capacity", async () => {
    const { f, out } = await running();
    const stop = vi.spyOn(f.ports, "stopDeveloperExecutionScope");
    await journal(f).exclusive(async (s, save) => { s.outbound.find(item => item.message.message_id === out.message.message_id)!.status = "unknown_delivery"; await save(); });
    await expect(park(f)).rejects.toThrow(/giao.*chưa|delivery/i);
    expect(stop).not.toHaveBeenCalled();
    expect((await snapshot(f)).tasks[0]!.status).toBe("running");
  });

  it("refuses sending/native intents and pending task approvals or user decisions before stopping", async () => {
    const { f, out } = await running();
    const stop = vi.spyOn(f.ports, "stopDeveloperExecutionScope");
    await journal(f).exclusive(async (s, save) => { s.outbound.find(item => item.message.message_id === out.message.message_id)!.status = "sending"; await save(); });
    await expect(park(f)).rejects.toThrow(/delivery/i);
    await journal(f).exclusive(async (s, save) => {
      s.outbound.find(item => item.message.message_id === out.message.message_id)!.status = "accepted";
      s.runs[0]!.nativeDeliveries = [{ operationId: "native-park-check", message: out.message }]; await save();
    });
    await expect(park(f)).rejects.toThrow(/delivery/i);
    await journal(f).exclusive(async (s, save) => {
      const run = s.runs[0]!; delete run.nativeDeliveries;
      run.approval = { ...run.tasks[0]!.spec.request, approvalId: "pending-park-approval", target: { type: "task", taskId: "implement" }, status: "pending" };
      await save();
    });
    await expect(park(f)).rejects.toThrow(/phê duyệt/);
    await journal(f).exclusive(async (s, save) => { delete s.runs[0]!.approval; await save(); });
    const binding = f.panes.bindings.find(item => item.paneId === out.handle.target.paneId)!;
    await f.runtime.requestUserDecision(binding, "developer", { runId: "run-1", taskId: "implement", question: "Chọn phương án nào?", options: ["A", "B"] });
    await expect(park(f)).rejects.toThrow(/quyết định/);
    expect(stop).not.toHaveBeenCalled();
    expect((await snapshot(f)).tasks[0]!.status).toBe("running");
  });

  it("does not accept a stop proof for a different execution", async () => {
    const { f, out } = await running();
    f.ports.stopDeveloperExecutionScope = async handle => ({ source: "linux_pid_namespace", handle: { ...handle, executionId: "foreign-execution" },
      observedAt: new Date().toISOString(), scopeId: randomUUID(), bootId: randomUUID(), initPid: 123, initStartTime: "1", namespace: "pid:[123]", receiptDigest: "a".repeat(64) });
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", correlationVerified: false, observedAt: new Date().toISOString() } });
    expect(await park(f)).toMatchObject({ parked: false });
    expect((await snapshot(f)).tasks[0]!.agentExecution!.executionId).toBe(out.handle.executionId);
    expect((await snapshot(f)).tasks[0]!.status).toBe("running");
  });

  it("counts a pending descendant behind parked as partially complete, and rejects unpark before its dependency", async () => {
    const f = await fixture({ director: true, parallel: true });
    f.def.maxConcurrency = 1;
    f.def.dependencies = [{ taskId: "other", dependsOnTaskId: "implement", condition: "succeeded" }];
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", correlationVerified: true, observedAt: new Date().toISOString() } });
    const parked = await park(f);
    expect(parked, JSON.stringify(parked)).toMatchObject({ parked: true, runStatus: "completed_with_parked" });
    expect((await snapshot(f)).tasks.find(task => task.taskId === "other")!.status).toBe("pending");
    expect(await park(f, "other")).toMatchObject({ parked: true });
    await expect(f.runtime.unparkTask({ runId: "run-1", taskId: "other", source: "director" })).rejects.toThrow(/Dependencies/);
    expect((await state(f)).runs[0].tasks.find((task: any) => task.taskId === "other").parked).toBeDefined();
  });

  it("completes partially, emits one notice, writes journal v8 and suppresses watchdog stalls", async () => {
    const { f } = await running();
    expect(await park(f)).toMatchObject({ parked: true, runStatus: "completed_with_parked" });
    await f.runtime.tick();
    const after = await state(f);
    expect(after.runs[0].status).toBe("completed_with_parked");
    const notices = after.outbound.filter((out: any) => out.message.payload.kind === "run_completed_with_parked");
    expect(notices).toHaveLength(1);
    expect(notices[0].message.payload).toMatchObject({ parkedTaskIds: ["implement"], headline: "Xong một phần: còn 1 mục trong hàng đợi lỗi" });
    expect(after.runs[0].integrationKey).toBeUndefined();
    expect(after.runs[0].workflowCycle).toBeUndefined();
    const saved = JSON.parse(await readFile(join(f.runtimeOptions.journalDirectory, "state.json"), "utf8"));
    expect(saved.version).toBe(8);
    const facts = await f.runtime.watchdogSnapshot("session-1");
    expect(facts[0]!.live).toBe(false);
    expect(evaluateWatchdog({ runs: facts, panes: [], notices: [], now: Date.now() + 1_000_000 })).toEqual([]);
    const progress = buildDirectorProgressSnapshot({ state: after, presence: "active", session: null, issues: [], now: new Date() });
    expect(progress.runs[0]!.tasks[0]!.status).toBe("parked");
    const lines = renderDirectorProgress(progress, { width: 160, height: 25, now: new Date() });
    expect(lines.join("\n")).toContain("Xong một phần — còn 1 mục treo");
    expect(lines.join("\n")).toContain("HÀNG ĐỢI LỖI");
    f.restart();
    await f.runtime.initialize();
    expect((await state(f)).runs[0].status).toBe("completed_with_parked");
  });

  it("unparks into a fresh attempt and cycle while retaining parked history and old worktree", async () => {
    const { f, out } = await running();
    const priorTask = (await state(f)).runs[0].tasks[0];
    const oldPlan = f.ports.policies.createVerificationPlan({ runId: "run-1", taskId: "implement", scope: "task", specification: priorTask.spec.specification,
      strategy: priorTask.spec.strategy, checks: f.ports.taskChecks, implementerIds: [out.handle.target.agentId], maxIterations: 3 });
    const oldCycle = f.ports.policies.verification.start(oldPlan, "cycle-before-park");
    await journal(f).exclusive(async (s, save) => { s.runs[0]!.tasks[0]!.cycle = oldCycle; s.runs[0]!.tasks[0]!.verificationPlan = oldPlan; await save(); });
    const store = new DirectorStore({ directory: join(f.root, "director") });
    const { token } = await store.register({ provider: "claude", repositoryRoot: f.repository });
    const coordinator = new CoordinatorTools(f.runtime);
    const tools = new DirectorTools({ store, coordinator: { invoke: (name, args) => coordinator.invoke(name, args, { role: "coordinator", principal: "director" }) } });
    await tools.invoke("park_task", { runId: "run-1", taskId: "implement", reason: "Thử lại sau" }, token);
    const issue = (await store.listIssues())[0]!;
    const tick = vi.spyOn(f.runtime, "tick");
    expect(await tools.invoke("set_issue_status", { issueId: issue.issueId, status: "retrying" }, token)).toMatchObject({ status: "retrying" });
    await Promise.all(tick.mock.results.map(result => result.value));
    expect((await state(f)).runs[0].status).toBe("implementing");
    await vi.waitFor(async () => { expect((await snapshot(f)).tasks[0]!.attempt).toBe(2); });
    const current = (await snapshot(f)).tasks[0]!;
    expect(current.status).toBe("running");
    expect(current.attemptId).not.toBe(out.attemptId);
    const task = (await state(f)).runs[0].tasks[0];
    expect(task.parked).toBeUndefined();
    expect(task.parkHistory).toMatchObject([{ episode: 1 }]);
    expect(task.worktrees[0].worktreePath).toBe(out.handle.target.worktreePath);
    expect(task.result).toBeUndefined();
    expect(task.writerReleased).toBe(false);
    expect(task.cycle).toBeUndefined(); // rebuilt after the new candidate, with its actual implementer in the plan
    await f.evidence("implement"); await f.submit(); await f.runtime.tick();
    const verifiedTask = (await state(f)).runs[0].tasks[0];
    expect(verifiedTask.cycle.cycleId).not.toBe(oldCycle.cycleId);
    expect(verifiedTask.cycle.status).toBe("passed");
    const latest = [...(await state(f)).outbound].reverse().find((item: any) => item.message.type === "task.assignment");
    expect(verifiedTask.verificationPlan.implementerIds).toContain(latest.handle.target.agentId);
  });

  it("keeps twenty history records and increases episode past the retained maximum", async () => {
    const { f } = await running();
    await park(f);
    await journal(f).exclusive(async (s, save) => {
      const task = s.runs[0]!.tasks[0]!, parked = task.parked!;
      task.parkHistory = Array.from({ length: 20 }, (_, i) => ({ ...parked, episode: i + 2 }));
      task.parked = { ...parked, episode: 22 }; await save();
    });
    const tick = vi.spyOn(f.runtime, "tick");
    await f.runtime.unparkTask({ runId: "run-1", taskId: "implement", source: "director" });
    await Promise.all(tick.mock.results.map(result => result.value));
    await vi.waitFor(async () => { expect((await snapshot(f)).tasks[0]!.attempt).toBe(2); });
    expect(await park(f)).toMatchObject({ parked: true, episode: 23 });
    const task = (await state(f)).runs[0].tasks[0];
    expect(task.parkHistory).toHaveLength(20);
    expect(task.parkHistory[0].episode).toBe(3);
    expect(task.parked.episode).toBe(23);
  });

  it("settles an exhausted failover hold only after confirmed park, then dispatches a new attempt without clearing its audit", async () => {
    const f = await fixture({ director: true });
    const allocate = f.panes.allocateDeveloper.bind(f.panes);
    vi.spyOn(f.panes, "allocateDeveloper").mockImplementation(async request => {
      const result = await allocate(request);
      Object.assign(result.value, { provider: "claude", model: "primary-model", metadata: { taskId: request.taskId, runId: "run-1" },
        session: { source: "claude", kind: "id", value: `native-${request.agentName}` } });
      return result;
    });
    const policy = { schemaVersion: 3 as const, policyVersion: "approved-park-test", role: "developer" as const,
      candidates: [], maxSwitches: 0, cooldownMs: 0, maxRetries: 0 };
    f.ports.providerFailover = { policyFor: () => ({ policy, current: { provider: "claude", model: "primary-model", profile: "primary" } }),
      authenticate: async () => true, assertMutationSafe: async () => undefined, preflight: async () => undefined };
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const original = (await state(f)).outbound.find((item: any) => item.message.type === "task.assignment");
    const binding = f.panes.bindings.find(item => item.paneId === original.handle.target.paneId)!;
    await f.runtime.observeProviderFailure(binding, { schemaVersion: 3, provider: "claude", kind: "quota_exhausted", source: "provider_structured",
      executionId: original.handle.executionId, observedAt: new Date().toISOString(), evidenceDigest: "a".repeat(64) });
    await f.runtime.continueProviderFailovers();
    expect((await state(f)).runs[0].tasks[0].failovers[0]).toMatchObject({ phase: "blocked", reason: "switch_budget_exhausted" });
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "working", correlationVerified: true, observedAt: new Date().toISOString() } });
    expect(await park(f)).toMatchObject({ parked: false });
    expect((await state(f)).runs[0].tasks[0].failovers[0].phase).toBe("blocked");
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", correlationVerified: true, observedAt: new Date().toISOString() } });
    expect(await park(f)).toMatchObject({ parked: true });
    const settled = (await state(f)).runs[0].tasks[0].failovers[0];
    expect(settled).toMatchObject({ phase: "cancelled", reason: "switch_budget_exhausted", policy, stopProof: { handle: original.handle } });
    const tick = vi.spyOn(f.runtime, "tick");
    await f.runtime.unparkTask({ runId: "run-1", taskId: "implement", source: "director" });
    await Promise.all(tick.mock.results.map(result => result.value));
    expect((await snapshot(f)).tasks[0]!.attempt).toBe(2);
    expect((await state(f)).outbound.filter((item: any) => item.message.type === "task.assignment" && item.status === "accepted")).toHaveLength(1);
    expect((await state(f)).runs[0].tasks[0].failovers[0].switchId).toBe(settled.switchId);
  });

  it("blocks park_task on legacy runs for the Director principal", async () => {
    const f = await fixture({ director: true });
    await journal(f).exclusive(async (s, save) => { s.runs[0]!.delegation.requestedBy = "conversation"; await save(); });
    const tools = new CoordinatorTools(f.runtime);
    await expect(tools.invoke("park_task", { runId: "run-1", taskId: "implement", reason: "Treo" }, { role: "coordinator", principal: "director" }))
      .rejects.toThrow(DIRECTOR_LEGACY_RUN_MESSAGE);
  });

  it("rejects ended or cancelled runs and workflow verification", async () => {
    const { f } = await running();
    const stop = vi.spyOn(f.ports, "stopDeveloperExecutionScope");
    await expect(park(f, "workflow-verification")).rejects.toThrow(/toàn workflow/);
    await journal(f).exclusive(async (s, save) => { s.runs[0]!.cancelled = true; await save(); });
    await expect(park(f)).rejects.toThrow(/không thể treo/);
    await journal(f).exclusive(async (s, save) => { s.runs[0]!.cancelled = false; s.runs[0]!.status = "completed"; await save(); });
    await expect(park(f)).rejects.toThrow(/không thể treo/);
    expect(stop).not.toHaveBeenCalled();
  });
});
