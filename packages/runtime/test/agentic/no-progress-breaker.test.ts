import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AgenticJournal, digest } from "../../src/agentic/journal.js";
import { blockerOf } from "../../src/agentic/blockers.js";
import { HostVerification, DEFAULT_HOST_CHECKS } from "../../src/agentic/host-verification.js";
import { cleanups, connectedPhaseFixture } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe("non-resumable policy phase blocker", () => {
  async function blocked(director = false) {
    const f = await connectedPhaseFixture("node_tap", 3, false, { director } as any);
    f.ports.preflightRoleCapabilities = async (binding, required) => {
      if (required.some(capability => !f.ports.roleCapabilities[binding.role]?.includes(capability))) throw new Error("Missing role capability");
    };
    await f.addTests();
    const { pending, head } = await f.request("red");
    const verifier = new HostVerification(() => f.runtime, () => f.ports.artifactStore, f.receipts,
      [{ ...f.command, testPaths: [f.testPath, "test/missing.test.cjs"] }], undefined, undefined, [], { suites: [] }, DEFAULT_HOST_CHECKS);
    let measuredError: unknown;
    try { await verifier.behavioralEvidence(f.qa, { runId: "run-1", taskId: "implement", phase: "red" }); }
    catch (error) { measuredError = error; }
    const blocker = blockerOf(measuredError);
    expect(blocker?.code).toBe("declared_test_missing");
    expect(blocker?.details).toMatchObject({ paths: ["test/missing.test.cjs"], revision: head });
    await f.runtime.recordPhaseFailure(f.qa, pending.message.message_id, blocker!.message, false, undefined, blocker);
    return { f, pending, head };
  }
  it("stores a pinned declared_test_missing blocker and escalates the run", async () => {
    const { f, pending, head } = await blocked();
    const state = await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async s => structuredClone(s));
    const failed = state.outbound.find(out => out.message.message_id === pending.message.message_id)!;
    expect(state.version).toBe(9);
    expect(failed.phaseFailure?.blocker).toMatchObject({ code: "declared_test_missing", fixableBy: "director",
      sourceRevision: head, specDigest: digest(state.runs[0]!.tasks[0]!.spec.specification),
      strategyDigest: digest(state.runs[0]!.tasks[0]!.spec.strategy) });
    expect(failed.phaseFailure?.blocker?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await f.inspect()).error).toContain("Plan mismatch (declared_test_missing)");
    expect(await f.runtime.telemetryReport("run-1", new Date().toISOString())).toMatchObject({
      blockers: [{ code: "declared_test_missing", fixableBy: "director", count: 1, resumeSkipped: 0 }] });
  }, 120_000);

  it("does not authorize or enqueue the same phase measurement after explicit resume, including after restart", async () => {
    const { f, pending } = await blocked();
    f.restart();
    const before = await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async s =>
      s.outbound.filter(out => out.message.type === "verification.requested").length);
    const actionId = (await f.inspect()).pendingAction.actionId;
    const resumed = await f.runtime.resumeBlockedRun("run-1", actionId, { conversationUserMessageId: "user-resume-1" }) as any;
    expect(resumed.nonResumablePhaseFailures).toMatchObject([{ requestId: pending.message.message_id, code: "declared_test_missing" }]);
    expect((await f.inspect()).pendingAction.recovery).toBe("manual");
    expect(await f.runtime.resumeRecoverableRuns()).toMatchObject({ resumed: 0 });
    // Repeated calls with the same authenticated turn are idempotent.
    for (let i = 0; i < 3; i++) expect(await f.runtime.resumeBlockedRun("run-1", actionId,
      { conversationUserMessageId: "user-resume-1" })).toMatchObject({ nonResumablePhaseFailures: [{ requestId: pending.message.message_id }] });
    const state = await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async s => structuredClone(s));
    const failed = state.outbound.find(out => out.message.message_id === pending.message.message_id)!;
    expect(failed.phaseFailure?.retryAuthorized).toBeUndefined();
    expect(state.outbound.filter(out => out.message.type === "verification.requested")).toHaveLength(before);
    expect(state.outbound.find(out => out.message.message_id === resumed.messageId)?.message.payload).toMatchObject({
      nonResumablePhaseFailures: [{ requestId: pending.message.message_id, code: "declared_test_missing" }] });
  }, 120_000);

  it("keeps the phase blocked across three distinct owner resume turns on an unchanged plan", async () => {
    const { f, pending } = await blocked();
    const actionId = (await f.inspect()).pendingAction.actionId;
    const journal = new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository);
    const originalCount = await journal.exclusive(async s => s.outbound.filter(out => out.message.type === "verification.requested").length);
    for (let turn = 1; turn <= 3; turn++) {
      if (turn > 1) await journal.exclusive(async (s, save) => {
        // Model Coordinator reporting the same unresolved blocker after the prior owner wake.
        const run = s.runs.find(item => item.runId === "run-1")!;
        run.status = "escalated"; run.pendingAction!.state = "pending"; run.pendingAction!.previousStatus = "implementing";
        await save();
      });
      const result = await f.runtime.resumeBlockedRun("run-1", actionId, { conversationUserMessageId: `owner-turn-${turn}` }) as any;
      expect(result.nonResumablePhaseFailures).toMatchObject([{ requestId: pending.message.message_id }]);
      const state = await journal.exclusive(async s => structuredClone(s));
      expect(state.outbound.find(out => out.message.message_id === pending.message.message_id)?.phaseFailure?.retryAuthorized).toBeUndefined();
      expect(state.outbound.filter(out => out.message.type === "verification.requested")).toHaveLength(originalCount);
    }
  }, 120_000);

  it("auto-parks a Director task with plan_mismatch and completes the run with a parked issue", async () => {
    const { f, pending } = await blocked(true);
    for (const pane of f.panes.bindings.filter(item => item.role === "developer"))
      pane.metadata = { taskId: "run-1-implement", runId: "run-1" };
    f.ports.stopDeveloperExecutionScope = async handle => ({ source: "linux_pid_namespace", handle, observedAt: new Date().toISOString(),
      scopeId: randomUUID(), bootId: randomUUID(), initPid: 123, initStartTime: "1", namespace: "pid:[123]", receiptDigest: "a".repeat(64) });
    expect(await f.runtime.autoParkPass({ enabled: true, maxAutoResumesBeforePark: 3 })).toMatchObject({
      parked: [{ runId: "run-1", taskId: "implement", kind: "plan_mismatch" }] });
    expect((await f.inspect()).status).toBe("completed_with_parked");
    expect([...f.director!.issues.values()]).toMatchObject([{ kind: "plan_mismatch" }]);
    const state = await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async s => structuredClone(s));
    expect(state.outbound.find(out => out.message.message_id === pending.message.message_id)?.phaseFailure?.blocker?.code).toBe("declared_test_missing");
  }, 120_000);

  it("still authorizes an untyped infrastructure phase failure on resume", async () => {
    const f = await connectedPhaseFixture("node_tap");
    f.ports.preflightRoleCapabilities = async (binding, required) => {
      if (required.some(capability => !f.ports.roleCapabilities[binding.role]?.includes(capability))) throw new Error("Missing role capability");
    };
    await f.addTests();
    const { pending } = await f.request("red");
    await f.runtime.recordPhaseFailure(f.qa, pending.message.message_id, "Sandbox unavailable", false);
    const actionId = (await f.inspect()).pendingAction.actionId;
    await f.runtime.resumeBlockedRun("run-1", actionId);
    const state = await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async s => structuredClone(s));
    expect(state.outbound.find(out => out.message.message_id === pending.message.message_id)?.phaseFailure?.retryAuthorized).toBe(true);
  }, 120_000);

  it("workflow retry_verification cannot authorize a blocked policy phase", async () => {
    const { f, pending } = await blocked();
    await expect(f.runtime.retryVerification("run-1")).rejects.toThrow();
    const state = await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async s => structuredClone(s));
    expect(state.outbound.find(out => out.message.message_id === pending.message.message_id)?.phaseFailure?.retryAuthorized).toBeUndefined();
  }, 120_000);
});
