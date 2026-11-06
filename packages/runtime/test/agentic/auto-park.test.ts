import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgenticJournal, digest } from "../../src/agentic/journal.js";
import { selectAutoParkCandidates, selectAutoParkStopCandidates, type AutoParkState } from "../../src/agentic/auto-park.js";
import { executeHostWatchdogPass } from "../../src/agentic/host.js";
import { DirectorStore } from "../../src/director/store.js";
import { cleanups, fixture, unwrap } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const policy = { enabled: true, maxAutoResumesBeforePark: 3 };
type Fixture = Awaited<ReturnType<typeof fixture>>;
const snap = async (f: Fixture) => unwrap(await f.ports.engine.getSnapshot("run-1"))!;
async function escalate(f: Fixture, attempts = 3, recovery: "manual" | "auto_resume" = "manual") {
  await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async (s, save) => {
    const source = s.outbound.find(out => out.message.type === "task.assignment")!;
    const run = s.runs[0]!;
    run.status = "escalated";
    run.pendingAction = { actionId: `next-${digest([run.runId, source.message.message_id])}`, kind: "resume_coordinator", owner: "coordinator", reason: "Recipient pane unavailable",
      sourceMessageId: source.message.message_id, createdAt: new Date(Date.now() - 3600_000).toISOString(), state: "pending", previousStatus: "implementing", recovery,
      resumeAttempts: attempts };
    await save();
  });
}
async function running(director = true, createBlocker = true) {
  const f = await fixture({ director });
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
  for (const pane of f.panes.bindings.filter(item => item.role === "developer")) pane.metadata = { taskId: "run-1-implement", runId: "run-1" };
  f.ports.stopDeveloperExecutionScope = async handle => ({ source: "linux_pid_namespace", handle, observedAt: new Date().toISOString(),
    scopeId: randomUUID(), bootId: randomUUID(), initPid: 123, initStartTime: "1", namespace: "pid:[123]", receiptDigest: "a".repeat(64) });
  if (createBlocker) await escalate(f);
  return f;
}
async function verificationFacts() {
  const f = await fixture({ director: true });
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
  await f.evidence("implement"); await f.submit(); await f.runtime.tick();
  const raw = await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async s => structuredClone(s));
  const s: AutoParkState = { ...raw, snapshots: { "run-1": await snap(f) } };
  const run = s.runs[0]!, task = run.tasks[0]!, current = s.snapshots["run-1"]!.tasks[0]!;
  delete current.agentExecution; current.status = "blocked";
  for (const out of s.outbound) if (out.taskId === task.taskId) delete out.handle;
  delete run.pendingAction; delete run.approval; delete run.decision;
  run.status = "escalated";
  return { f, s, run, task, current };
}
let base: AutoParkState;
let sourceHandle: import("@bflow/contracts").AgentExecutionHandle;
beforeAll(async () => {
  const f = await running();
  const raw = await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async s => structuredClone(s));
  sourceHandle = structuredClone(raw.outbound.find(out => out.message.type === "task.assignment")!.handle!);
  base = { ...raw, snapshots: { "run-1": await snap(f) } };
  // Selection-only baseline without a live execution; integration below verifies the real stop path.
  delete base.snapshots["run-1"]!.tasks[0]!.agentExecution;
  for (const out of base.outbound) if (out.taskId === "implement") delete out.handle;
});
const choose = (s: AutoParkState) => selectAutoParkCandidates(s, policy, Date.now());

describe("selectAutoParkCandidates", () => {
  it.each([
    ["stall", "transport_failure", "Task không trả kết quả"],
    ["structural delivery", "transport_failure", "Recipient pane unavailable"],
    ["invalid message", "other", "Too many refused messages"]
  ])("maps %s", (_name, kind, reason) => {
    const s = structuredClone(base); s.runs[0]!.pendingAction!.reason = reason;
    expect(choose(s)).toMatchObject([{ taskId: "implement", kind, episodeKey: "run-1:implement:1" }]);
  });
  it.each(["switch_budget_exhausted", "old_execution_stop_budget_exhausted"])("maps blocked failover %s", reason => {
    const s = structuredClone(base);
    s.runs[0]!.tasks[0]!.failovers = [{ phase: "blocked", reason, sourceHandle, stopProof: { source: "correlated_transport", handle: sourceHandle, observedAt: new Date().toISOString() } } as any];
    expect(choose(s)[0]?.kind).toBe("provider_failure");
  });
  it("pins invalid-message candidates to the recorded outbound and current implementation attempt", () => {
    const s = structuredClone(base), run = s.runs[0]!;
    const source = s.outbound.find(out => out.message.type === "task.assignment")!;
    run.pendingAction!.sourceMessageId = "refused-inbound";
    run.pendingAction!.invalidAssignment = { messageId: source.message.message_id, taskId: "implement", attemptId: source.attemptId,
      implementationAttemptId: s.snapshots["run-1"]!.tasks[0]!.attemptId! };
    run.pendingAction!.reason = "Rejected invalid developer RoleMessage before transport";
    expect(choose(s)[0]?.kind).toBe("other");
    run.pendingAction!.invalidAssignment!.implementationAttemptId = "stale-attempt";
    expect(choose(s)).toEqual([]);
  });
  it("does not auto-park a newer Core attempt because its pending blocker points to old writer A", () => {
    const s = structuredClone(base), source = s.outbound.find(out => out.message.type === "task.assignment")!;
    const current = s.snapshots["run-1"]!.tasks.find(task => task.taskId === "implement")!;
    const currentAttempt = current.attemptId!;
    source.attemptId = "writer-a";
    if (source.handle) source.handle.attemptId = "writer-a";
    current.attemptId = "writer-b";
    s.runs[0]!.pendingAction!.sourceMessageId = source.message.message_id;
    expect(choose(s)).toEqual([]);
    // Uncertain old work remains a fence even though it cannot drive B's business park.
    source.status = "unknown_delivery";
    expect(selectAutoParkStopCandidates(s, policy, Date.now())).toEqual([]);
    expect(currentAttempt).toBeTruthy();
  });
  it("does not treat other failover holds as an exhausted provider budget", () => {
    const s = structuredClone(base);
    s.runs[0]!.tasks[0]!.failovers = [{ phase: "blocked", reason: "pending_human_gate", sourceHandle,
      stopProof: { source: "correlated_transport", handle: sourceHandle, observedAt: new Date().toISOString() } } as any];
    expect(choose(s)).toEqual([]);
    expect(selectAutoParkStopCandidates(s, policy, Date.now())).toEqual([]);
  });
  it.each([
    ["unknown_delivery", (s: AutoParkState) => { s.outbound.find(out => out.message.type === "task.assignment")!.status = "unknown_delivery"; }],
    ["sending", (s: AutoParkState) => { s.outbound.find(out => out.message.type === "task.assignment")!.status = "sending"; }],
    ["native delivery", (s: AutoParkState) => { s.runs[0]!.nativeDeliveries = [{ operationId: "native-1", message: s.outbound[0]!.message }]; }],
    ["cancelled", (s: AutoParkState) => { s.runs[0]!.cancelled = true; }],
    ["v2 run", (s: AutoParkState) => { s.runs[0]!.delegation.requestedBy = "conversation"; }],
    ["workflow verification", (s: AutoParkState) => { s.runs[0]!.tasks[0]!.taskId = "workflow-verification"; }],
    ["human gate", (s: AutoParkState) => { s.runs[0]!.approval = { ...s.runs[0]!.tasks[0]!.spec.request, status: "pending", target: { type: "task", taskId: "implement" } }; delete s.runs[0]!.decision; }],
    ["user decision", (s: AutoParkState) => { s.runs[0]!.userDecisions = { one: { taskId: "implement", status: "pending" } as any }; }],
    ["active verification", (s: AutoParkState) => { s.runs[0]!.tasks[0]!.verificationPending = true; }],
    ["unspent budget", (s: AutoParkState) => { Object.assign(s.runs[0]!.pendingAction!, { recovery: "auto_resume", resumeAttempts: 2 }); }]
  ])("excludes %s", (_name, mutate) => { const s = structuredClone(base); mutate(s); expect(choose(s)).toEqual([]); });
  it("does not select live or foreign-proof executions, and preparation retains all other fences", async () => {
    const f = await running();
    const raw = await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async s => structuredClone(s));
    const s = { ...raw, snapshots: { "run-1": await snap(f) } };
    expect(choose(s)).toEqual([]); expect(selectAutoParkStopCandidates(s, policy, Date.now())).toHaveLength(1);
    const out = s.outbound.find(item => item.message.type === "task.assignment")!;
    out.parkStop = { requestedAt: new Date().toISOString(), observations: 1, proof: { source: "correlated_transport", handle: { ...out.handle!, executionId: "foreign" }, observedAt: new Date().toISOString() } };
    expect(choose(s)).toEqual([]);
    out.status = "unknown_delivery"; expect(selectAutoParkStopCandidates(s, policy, Date.now())).toEqual([]);
  });
  it("maps only current, exhausted rework and rejects incomplete/stale cycles or fail policy", async () => {
    const { s, run, task, current } = await verificationFacts();
    expect(task.cycle).toBeDefined();
    task.cycle!.status = "escalated"; task.cycle!.currentIteration = task.cycle!.maxIterations;
    current.blockage = { code: "quality_gate", message: "Review failed", since: new Date().toISOString(), retryable: false };
    run.definition!.tasks[0]!.rework = { maxReworks: 3, onExhausted: "require_human" };
    expect(choose(s)[0]?.kind).toBe("rework_exhausted");
    for (const mutation of [
      (copy: AutoParkState) => { copy.runs[0]!.tasks[0]!.cycle!.currentIteration = 1; },
      (copy: AutoParkState) => { copy.runs[0]!.definition!.tasks[0]!.rework!.onExhausted = "fail"; },
      (copy: AutoParkState) => { copy.runs[0]!.tasks[0]!.cycle!.taskId = "other"; },
      (copy: AutoParkState) => { copy.runs[0]!.tasks[0]!.cycle!.history.at(-1)!.attemptId = "stale-attempt"; }
    ]) { const copy = structuredClone(s); mutation(copy); expect(choose(copy)).toEqual([]); }
  });
  it("maps exhausted durable verification only for the exact current cycle and attempt", async () => {
    const { s, run, task } = await verificationFacts();
    const result = task.cycle!.history.at(-1)!;
    s.pendingVerifications = [{ job: { runId: run.runId, taskId: task.taskId, plan: { scope: "task" }, cycle: structuredClone(task.cycle!), change: task.changeSet! } as any,
      outcome: { result: structuredClone(result), cycle: structuredClone(task.cycle!) } as any, stuck: true, attempts: 3 }];
    task.verificationPending = true;
    expect(choose(s)[0]?.kind).toBe("verification_exhausted");
    for (const mutation of [
      (copy: AutoParkState) => { (copy.pendingVerifications[0]!.job as any).cycle.cycleId = "stale-cycle"; },
      (copy: AutoParkState) => { (copy.pendingVerifications[0]!.outcome as any).result.attemptId = "stale-attempt"; },
      (copy: AutoParkState) => { copy.pendingVerifications.push({ ...structuredClone(copy.pendingVerifications[0]!), stuck: false }); },
      (copy: AutoParkState) => { copy.pendingVerifications[0]!.attempts = 2; },
      (copy: AutoParkState) => { (copy.pendingVerifications[0]!.job as any).plan.scope = "workflow"; }
    ]) { const copy = structuredClone(s); mutation(copy); expect(choose(copy)).toEqual([]); }
  });
  it("uses monotonically increasing episode numbers after history truncation", () => {
    const s = structuredClone(base); s.runs[0]!.tasks[0]!.parkHistory = [{ at: new Date().toISOString(), reason: "Treo", kind: "other", source: "auto", episode: 27 }];
    expect(choose(s)[0]!.episodeKey).toBe("run-1:implement:28");
    expect(selectAutoParkCandidates(s, { enabled: false, maxAutoResumesBeforePark: 0 }, Date.now())).toEqual([]);
  });
});

describe("Runtime auto-park", () => {
  it("stops with exact proof, parks once, upserts once per episode and retains attempts", async () => {
    const f = await running();
    const store = new DirectorStore({ directory: join(f.root, "director-issues") });
    f.ports.director!.upsertIssue = async input => { await store.upsertIssue(input); };
    expect(await f.runtime.autoParkPass(policy)).toMatchObject({ parked: [{ kind: "transport_failure", taskId: "implement" }] });
    expect((await snap(f)).tasks[0]!.status).toBe("parked");
    const revision = (await store.version()).issuesRevision;
    expect(await f.runtime.autoParkPass(policy)).toEqual({ parked: [] });
    expect((await store.version()).issuesRevision).toBe(revision);
    expect(await store.listIssues()).toMatchObject([{ attempts: 3, summary: expect.any(String) }]);
    expect(await store.listIssues()).toHaveLength(1);
  });
  it("repairs an issue upsert after a port failure and Runtime restart", async () => {
    const f = await running();
    const upsert = vi.spyOn(f.ports.director!, "upsertIssue").mockRejectedValueOnce(new Error("Controlled store failure"));
    await expect(f.runtime.autoParkPass(policy)).rejects.toThrow("Controlled store failure");
    expect((await snap(f)).tasks[0]!.status).toBe("parked");
    f.restart(); await f.runtime.autoParkPass(policy);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1]![0].key).toBe(upsert.mock.calls[0]![0].key);
    expect(upsert.mock.calls[1]![0].attempts).toBe(3);
  });
  it.each(["disabled", "v2", "unconfirmed stop"])("never parks when %s", async mode => {
    const f = await running(mode !== "v2");
    if (mode === "unconfirmed stop") {
      delete f.ports.stopDeveloperExecutionScope;
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "done", correlationVerified: true, observedAt: new Date().toISOString() } });
    }
    expect(await f.runtime.autoParkPass({ ...policy, enabled: mode !== "disabled" })).toEqual({ parked: [] });
    expect((await snap(f)).tasks[0]!.status).toBe("running");
  });
  it("settles only an exact exhausted task verification outcome while parking, retaining its cycle evidence", async () => {
    const f = await fixture({ director: true, failReview: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def, 1); await f.runtime.tick();
    await f.evidence("implement"); await f.submit(); await f.runtime.tick();
    const j = new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository);
    for (const pane of f.panes.bindings.filter(item => item.role === "developer")) pane.metadata = { runId: "run-1", taskId: "run-1-implement" };
    f.ports.stopDeveloperExecutionScope = async handle => ({ source: "linux_pid_namespace", handle, observedAt: new Date().toISOString(),
      scopeId: randomUUID(), bootId: randomUUID(), initPid: 123, initStartTime: "1", namespace: "pid:[123]", receiptDigest: "a".repeat(64) });
    expect((await snap(f)).tasks[0]!.status).toBe("blocked");
    let cycleId = "";
    await j.exclusive(async (s, save) => {
      const run = s.runs[0]!, task = run.tasks[0]!; cycleId = task.cycle!.cycleId;
      const result = task.cycle!.history.at(-1)!;
      s.pendingVerifications.push({ job: { runId: run.runId, taskId: task.taskId, plan: task.verificationPlan!, cycle: task.cycle!, change: task.changeSet! } as any,
        outcome: { result, cycle: task.cycle!, messages: [] } as any, stuck: true, attempts: 3 });
      task.verificationPending = true;
      // Storage/finalization can fail before the returned verdict updates task.cycle.
      task.cycle = { ...task.cycle!, status: "in_progress", history: [] };
      (s.pendingVerifications.at(-1)!.job as any).cycle = structuredClone(task.cycle);
      await save();
    });
    expect(await f.runtime.autoParkPass(policy)).toMatchObject({ parked: [{ kind: "verification_exhausted" }] });
    expect((await snap(f)).tasks[0]!.status).toBe("parked");
    await j.exclusive(async s => {
      expect(s.pendingVerifications).toHaveLength(0);
      expect(s.runs[0]!.tasks[0]!.cycle!.cycleId).toBe(cycleId);
      expect(s.runs[0]!.tasks[0]!.parkedVerifications).toMatchObject([{ episode: 1, attempts: 3, outcome: { result: { taskId: "implement", status: "failed" } } }]);
    });
  });
  it("preserves disabled-auto-park, capability repair and verification retry resume budgets", async () => {
    const f = await running();
    const resume = vi.spyOn(f.runtime, "resumeBlockedRun").mockResolvedValue({ resumed: true });
    const retry = vi.spyOn(f.runtime, "retryVerification").mockResolvedValue({ retried: true });
    const j = new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository);
    await escalate(f, 0, "auto_resume");
    expect(await f.runtime.resumeRecoverableRuns({ enabled: false, maxAutoResumesBeforePark: 0 })).toEqual({ resumed: 1 });
    expect(resume).toHaveBeenCalledTimes(1);
    await j.exclusive(async (s, save) => { s.runs[0]!.pendingAction!.recovery = "capability_repair"; await save(); });
    expect(await f.runtime.resumeRecoverableRuns({ enabled: true, maxAutoResumesBeforePark: 0 })).toEqual({ resumed: 1 });
    expect(resume).toHaveBeenCalledTimes(2);
    await j.exclusive(async (s, save) => { s.runs[0]!.pendingAction!.recovery = "auto_resume"; s.runs[0]!.error = "Verification delivery/storage requires reconciliation: fixture"; await save(); });
    expect(await f.runtime.resumeRecoverableRuns({ enabled: true, maxAutoResumesBeforePark: 0 })).toEqual({ resumed: 1 });
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1, 2])("reduced threshold %s prevents the next default resume and auto-parks", async limit => {
    const f = await running(); await escalate(f, limit, "auto_resume");
    const reduced = { enabled: true, maxAutoResumesBeforePark: limit };
    expect(await f.runtime.resumeRecoverableRuns(reduced)).toEqual({ resumed: 0 });
    expect(await f.runtime.autoParkPass(reduced)).toMatchObject({ parked: [{ taskId: "implement" }] });
  });
});


describe("Host watchdog auto-park policy", () => {
  it.each([[true, true], [true, false], [false, true]])("Director=%s enabled=%s", async (directorSession, enabled) => {
    const calls: string[] = [];
    const resumeRecoverableRuns = vi.fn(async () => { calls.push("resume"); return null; });
    const autoParkPass = vi.fn(async () => { calls.push("park"); return { parked: [] }; });
    const workspace = { runtime: { resumeRecoverableRuns, autoParkPass, watchdogSnapshot: async () => [], ports: { panes: {} } }, conversation: {} };
    await executeHostWatchdogPass({ readState: () => ({ workspace, manifest: {}, quiesced: false, closing: false }), directorSession,
      issueQueue: { autoPark: enabled, maxAutoResumesBeforePark: 1 }, receipts: {}, inbox: {}, activeHostVerifications: new Map(),
      watchdogReported: new Set(), observeAgent: async () => ({ status: "idle" }) } as any);
    expect(calls).toEqual(directorSession && enabled ? ["resume", "park"] : ["resume"]);
    expect(resumeRecoverableRuns).toHaveBeenCalledWith(directorSession ? { enabled, maxAutoResumesBeforePark: 1 } : undefined);
  });
});


/** A lost writer-release acknowledgment leaves its accepted marker; real finalization must replay that release durably. */
async function releaseFailureFixture(parallel = false) {
  const f = await fixture({ director: true, failReview: true, parallel });
  if (parallel) f.def.tasks[1]!.requiresApproval = true;
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def, 1); await f.runtime.tick();
  const j = new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository);
  const source = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "task.assignment" && out.taskId === "implement");
  for (const pane of f.panes.bindings.filter(item => item.role === "developer")) pane.metadata = { taskId: `run-1-${pane.paneId === source.handle.target.paneId ? "implement" : "other"}`, runId: "run-1" };
  f.ports.stopDeveloperExecutionScope = async handle => ({ source: "linux_pid_namespace", handle, observedAt: new Date().toISOString(),
    scopeId: randomUUID(), bootId: randomUUID(), initPid: 123, initStartTime: "1", namespace: "pid:[123]", receiptDigest: "a".repeat(64) });
  let failedRelease = false;
  let releasedRequest: Parameters<Fixture["ports"]["registry"]["releaseLease"]>[0] | undefined;
  const release = f.ports.registry.releaseLease.bind(f.ports.registry);
  const releaseSpy = vi.spyOn(f.ports.registry, "releaseLease").mockImplementation(async request => {
    if (failedRelease && request.leaseId === source.lease.leaseId) throw new Error("Injected release failure after cycle write-ahead");
    const result = await release(request);
    if (result.ok && request.leaseId === source.lease.leaseId) releasedRequest = structuredClone(request);
    return result;
  });
  const verify = f.ports.policies.verification.verify.bind(f.ports.policies.verification);
  const verifySpy = vi.spyOn(f.ports.policies.verification, "verify").mockImplementation(async (...args) => {
    const outcome = await verify(...args);
    if (args[0].taskId === "implement") {
      // Reproduce an unacknowledged release marker while preserving the same immutable handle/lease/request identity.
      await j.exclusive(async (state, save) => {
        expect(releasedRequest).toBeDefined();
        const writer = state.outbound.find(out => out.message.message_id === source.message.message_id)!;
        writer.status = "accepted"; writer.leaseRelease = releasedRequest!; await save();
      });
      failedRelease = true; f.setFailReview(false);
    }
    return outcome;
  });
  await f.evidence("implement"); await f.submit();
  if (parallel) { await f.evidence("other"); await f.submit("other", "Independent B update\n"); }
  await f.runtime.tick();
  return { f, j, source, releaseSpy, verifySpy };
}

describe("Task14 review regressions", () => {
  it.each(["tool", "inbound refusal", "inbound content"])("parks the actual invalid-message source from %s as other", async mode => {
    const f = await running(true, false);
    const source = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "task.assignment");
    const binding = f.panes.bindings.find(pane => pane.paneId === source.handle.target.paneId)!;
    for (let n = 1; n <= 3; n++) {
      const message = f.envelope("implementation.submitted", { status: "succeeded" }, { message_id: `invalid-${n}`, causation_id: source.message.message_id,
        sender: { role: "developer", agent_id: binding.agentId, pane_id: binding.paneId }, ...(mode === "inbound refusal" ? { idempotency_key: undefined } : {}) });
      if (mode === "tool") await f.runtime.reportRoleToolFailure(binding, { ...message, type: "not-a-role-message" }, "type: Invalid enum value");
      else if (mode === "inbound refusal") await expect(f.runtime.receiveHerdr(message)).rejects.toThrow();
      else {
        let refusal: unknown;
        try { await f.runtime.receiveHerdr(message); } catch (error) { refusal = error; }
        expect(refusal).toBeDefined();
        await f.runtime.reportInboundFailure(message, `${String(refusal)} (dropped after 5 attempts)`);
      }
    }
    const run = await f.runtime.inspect("run-1") as any;
    expect(run.pendingAction).toMatchObject({ sourceMessageId: "invalid-3", invalidAssignment: {
      messageId: source.message.message_id, taskId: "implement", attemptId: source.attemptId, implementationAttemptId: source.attemptId } });
    const reduced = { enabled: true, maxAutoResumesBeforePark: 0 };
    await f.runtime.resumeRecoverableRuns(reduced);
    expect(await f.runtime.autoParkPass(reduced)).toMatchObject({ parked: [{ taskId: "implement", kind: "other" }] });
    expect([...f.director!.issues.values()]).toMatchObject([{ kind: "other" }]);
  });

  it("does not guess an assignment from ambiguous tool output or uncorrelated ingress", async () => {
    const f = await running(true, false);
    const source = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "task.assignment");
    const binding = f.panes.bindings.find(pane => pane.paneId === source.handle.target.paneId)!;
    const j = new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository);
    await j.exclusive(async (state, save) => {
      state.outbound.push({ ...structuredClone(state.outbound.find(out => out.message.message_id === source.message.message_id)!),
        message: { ...source.message, message_id: "ambiguous-assignment", idempotency_key: "ambiguous-assignment" }, status: "released" });
      await save();
    });
    expect(await f.runtime.reportRoleToolFailure(binding, { run_id: "run-1", message_id: "ambiguous-output" }, "payload: Required")).toBeUndefined();
    for (let n = 0; n < 3; n++) await expect(f.runtime.receiveHerdr(f.envelope("task.status", {}, { message_id: `uncorrelated-${n}`,
      idempotency_key: undefined, sender: { role: "developer" } }))).rejects.toThrow();
    expect((await f.runtime.inspect("run-1") as any).pendingAction.invalidAssignment).toBeUndefined();
    expect(await f.runtime.autoParkPass({ enabled: true, maxAutoResumesBeforePark: 0 })).toEqual({ parked: [] });
    expect((await snap(f)).tasks[0]!.status).toBe("running");
  });

  it("accepts the exact outcome cycle after repeated real release failures, then parks without replaying verification", async () => {
    const { f, j, releaseSpy, verifySpy } = await releaseFailureFixture();
    for (let n = 0; n < 3; n++) await f.runtime.tick();
    await j.exclusive(async state => {
      expect(state.pendingVerifications[0]).toMatchObject({ stuck: true, attempts: 3 });
      expect(digest(state.runs[0]!.tasks[0]!.cycle)).toBe(digest((state.pendingVerifications[0]!.outcome as any).cycle));
      expect(digest(state.runs[0]!.tasks[0]!.cycle)).not.toBe(digest((state.pendingVerifications[0]!.job as any).cycle));
    });
    releaseSpy.mockRestore();
    expect(await f.runtime.autoParkPass(policy)).toMatchObject({ parked: [{ taskId: "implement" }] });
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect((await snap(f)).tasks[0]!.status).toBe("parked");
    await j.exclusive(async state => { expect(state.pendingVerifications).toHaveLength(0); expect(state.runs[0]!.tasks[0]!.parkedVerifications).toHaveLength(1); });
  });

  it("settles pending verification in the park event write-ahead before a crash and never replays it after restart", async () => {
    const { f, j, releaseSpy } = await releaseFailureFixture();
    for (let n = 0; n < 3; n++) await f.runtime.tick();
    releaseSpy.mockRestore();
    const append = f.ports.runStore.appendEvents.bind(f.ports.runStore);
    const fault = vi.spyOn(f.ports.runStore, "appendEvents").mockImplementation(async request => {
      if (request.events.some(event => event.type === "task.status_changed" && event.payload.to === "parked")) throw new Error("Crash after park write-ahead");
      return append(request);
    });
    await expect(f.runtime.parkTask({ runId: "run-1", taskId: "implement", source: "auto", kind: "verification_exhausted", reason: "Treo kiểm chứng đã hết ngân sách" })).rejects.toThrow("Crash after park write-ahead");
    const saved = JSON.parse(await readFile(join(f.runtimeOptions.journalDirectory, "state.json"), "utf8"));
    expect(saved.pendingCore.some((batch: any) => batch.events.some((event: any) => event.type === "task.status_changed" && event.payload.to === "parked"))).toBe(true);
    expect(saved.pendingVerifications).toHaveLength(0);
    expect(saved.runs[0].tasks[0]).toMatchObject({ verificationPending: false, parked: { source: "auto" }, parkedVerifications: [{ attempts: 3 }] });
    expect(saved.runs[0].pendingAction).toBeUndefined();
    fault.mockRestore();
    const verify = vi.spyOn(f.ports.policies.verification, "verify");
    verify.mockClear(); f.restart(); await f.runtime.tick();
    expect((await snap(f)).tasks[0]!.status).toBe("parked"); expect(verify).not.toHaveBeenCalled();
    expect((await f.runtime.inspect("run-1") as any).status).toBe("completed_with_parked");
    await j.exclusive(async state => { expect(state.pendingCore).toHaveLength(0); expect(state.pendingVerifications).toHaveLength(0); });
  });

  it("parks exhausted A while preserving B's real task approval, then accepts B's human decision", async () => {
    const { f, j, releaseSpy } = await releaseFailureFixture(true);
    expect((await f.runtime.inspect("run-1") as any)).toMatchObject({ status: "awaiting_approval", approval: { target: { type: "task", taskId: "other" } } });
    await j.exclusive(async (state, save) => {
      state.pendingVerifications[0]!.stuck = true; state.pendingVerifications[0]!.attempts = 3;
      const run = state.runs[0]!, other = state.outbound.find(out => out.taskId === "other" && out.message.type === "task.assignment")!;
      run.pendingAction = { actionId: `next-${digest([run.runId, other.message.message_id])}`, kind: "resume_coordinator", owner: "coordinator",
        sourceMessageId: other.message.message_id, reason: "Cần đối soát task B", createdAt: new Date().toISOString(), state: "pending", recovery: "manual", previousStatus: "implementing" };
      run.error = run.pendingAction.reason; await save();
    });
    const before = await f.runtime.inspect("run-1") as any;
    releaseSpy.mockRestore();
    expect(await f.runtime.autoParkPass(policy)).toMatchObject({ parked: [{ taskId: "implement" }] });
    const after = await f.runtime.inspect("run-1") as any;
    expect(after.status).toBe("awaiting_approval"); expect(after.approval).toEqual(before.approval);
    expect(after.pendingAction).toEqual(before.pendingAction); expect(after.error).toBe(before.error);
    await f.approve();
    expect((await f.runtime.inspect("run-1") as any).decision).toMatchObject({ approvalId: before.approval.approvalId, decision: "approved" });
  });
});
