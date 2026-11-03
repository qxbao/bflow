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
async function running(director = true) {
  const f = await fixture({ director });
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
  for (const pane of f.panes.bindings.filter(item => item.role === "developer")) pane.metadata = { taskId: "run-1-implement", runId: "run-1" };
  f.ports.stopDeveloperExecutionScope = async handle => ({ source: "linux_pid_namespace", handle, observedAt: new Date().toISOString(),
    scopeId: randomUUID(), bootId: randomUUID(), initPid: 123, initStartTime: "1", namespace: "pid:[123]", receiptDigest: "a".repeat(64) });
  await escalate(f);
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
