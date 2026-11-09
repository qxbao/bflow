import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgenticJournal, digest } from "../../src/agentic/journal.js";
import { blockerOf } from "../../src/agentic/blockers.js";
import { HostVerification, DEFAULT_HOST_CHECKS } from "../../src/agentic/host-verification.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { cleanups, connectedPhaseFixture } from "../helpers/agentic-integration-fixture.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { assertRunExecutionPlan, bindAcceptedExecutionPlan, createExecutionResolutionReader, readExecutionRepositorySnapshot } from "../../src/agentic/execution-binding.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const MISSING = "test/missing.test.cjs";
const read = (f: any) => new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async (s: any) => structuredClone(s));

async function stopped(director = false, extra: Record<string, unknown> = {}) {
  const f = await connectedPhaseFixture("node_tap", 3, false, { director, plannedExtraPaths: [MISSING], ...extra } as any);
  f.ports.preflightRoleCapabilities = async (binding, required) => {
    if (required.some(capability => !f.ports.roleCapabilities[binding.role]?.includes(capability))) throw new Error("Missing role capability");
  };
  await f.addTests();
  const { pending, head } = await f.request("red");
  const verifier = new HostVerification(() => f.runtime, () => f.ports.artifactStore, f.receipts,
    [{ ...f.command, testPaths: [f.testPath, MISSING] }], undefined, undefined, [], { suites: [] }, DEFAULT_HOST_CHECKS);
  let error: unknown;
  try { await verifier.behavioralEvidence(f.qa, { runId: "run-1", taskId: "implement", phase: "red" }); } catch (e) { error = e; }
  const blocker = blockerOf(error)!;
  expect(blocker.code).toBe("declared_test_missing");
  await f.runtime.recordPhaseFailure(f.qa, pending.message.message_id, blocker.message, false, undefined, blocker);
  return { f, pending, head };
}
const drop = { runId: "run-1", taskId: "implement", reason: "The second test file was never written; the plan only listed it as expected",
  changes: [{ kind: "drop_planned_paths", paths: [MISSING] }] };

describe("in-run scope amendment", () => {
  it("refuses to amend a task that no plan mismatch stopped", async () => {
    const f = await connectedPhaseFixture("node_tap", 3, false, { plannedExtraPaths: [MISSING] } as any);
    await expect(f.runtime.amendTaskScope(drop, { source: "coordinator" })).rejects.toThrow(/plan mismatch/i);
  }, 120_000);

  it("amends inside the run: spec v2, audit record, stale phase failure kept, resume re-measures, no new run", async () => {
    const { f, pending } = await stopped();
    const before = await read(f);
    const oldSpec = before.runs[0]!.tasks[0]!.spec.specification;
    const actionId = (await f.inspect()).pendingAction.actionId;
    expect(await f.runtime.resumeBlockedRun("run-1", actionId, { conversationUserMessageId: "u-1" })).toMatchObject({ nonResumablePhaseFailures: [{ requestId: pending.message.message_id }] });
    const result = await f.runtime.amendTaskScope(drop, { source: "coordinator" }) as any;
    expect(result).toMatchObject({ amended: true, specVersion: (oldSpec.version ?? 1) + 1, affectedPaths: expect.not.arrayContaining([MISSING]) });
    const state = await read(f);
    const task = state.runs[0]!.tasks[0]!;
    expect(state.version).toBe(10);
    expect(task.spec.specification.affectedPaths).not.toContain(MISSING);
    expect(task.spec.specification.acceptanceCriteria).toEqual(oldSpec.acceptanceCriteria);
    expect(task.spec.strategy.tddDecision.mode).toBe(before.runs[0]!.tasks[0]!.spec.strategy.tddDecision.mode);
    expect(task.scopeAmendments).toMatchObject([{ source: "coordinator", fromSpecDigest: digest(oldSpec), toSpecDigest: digest(task.spec.specification),
      diff: { droppedAffectedPaths: [MISSING] } }]);
    // The old failure is evidence, never edited by hand.
    const failed = state.outbound.find((out: any) => out.message.message_id === pending.message.message_id)!;
    expect(failed.phaseFailure?.blocker?.code).toBe("declared_test_missing");
    expect(failed.phaseFailure?.retryAuthorized).toBeUndefined();
    // Idempotent repeat.
    expect(await f.runtime.amendTaskScope(drop, { source: "coordinator" })).toMatchObject({ amended: false, duplicate: true });
    // Resume now measures again because the digests changed.
    f.restart();
    const again = (await f.inspect()).pendingAction;
    expect(await f.runtime.resumeBlockedRun("run-1", again.actionId, { conversationUserMessageId: "u-2" })).toMatchObject({ nonResumablePhaseFailures: [] });
    const after = await read(f);
    expect(after.outbound.find((out: any) => out.message.message_id === pending.message.message_id)?.phaseFailure?.retryAuthorized).toBe(true);
    expect(after.runs).toHaveLength(1);
  }, 180_000);

  it("rejects every attempt to weaken the contract of the run", async () => {
    const { f } = await stopped();
    const call = (changes: unknown[], extra: object = {}) => f.runtime.amendTaskScope({ ...drop, changes, ...extra }, { source: "coordinator" });
    await expect(call([{ kind: "drop_planned_paths", paths: ["src"] }])).rejects.toThrow(/not recorded as missing/);
    await expect(call([{ kind: "waive_criterion", criterionId: "ac-1" }])).rejects.toThrow();
    await expect(call([{ kind: "drop_planned_paths", paths: [MISSING] }], { criteria: [] })).rejects.toThrow();
    await expect(call([{ kind: "set_test_names", criterionId: "ac-404", testNames: ["x"] }])).rejects.toThrow(/not part of this task/);
    await expect(call([{ kind: "expand_owned_paths", paths: ["docs"] }])).rejects.toThrow();
    await expect(call([{ kind: "add_paths_within_ownership", paths: ["docs/x.md"] }])).rejects.toThrow(/outside the task's current ownership/);
    expect((await read(f)).runs[0]!.tasks[0]!.scopeAmendments).toBeUndefined();
    // Nothing above freed the circuit breaker.
    expect(await f.runtime.resumeBlockedRun("run-1", (await f.inspect()).pendingAction.actionId, { conversationUserMessageId: "u-3" })).toMatchObject({
      nonResumablePhaseFailures: [{ code: "declared_test_missing" }] });
  }, 180_000);
});

describe("scope amendment: plan digest, Core consistency and tool wiring", () => {
  it("leaves the accepted definition, Core and execution plan consistent, including after a restart", async () => {
    const { f } = await stopped();
    const configPath = join(f.root, "owner-config.json");
    await writeFile(configPath, JSON.stringify({ model: "configured" }));
    const reader = await createExecutionResolutionReader({ schemaVersion: 3, repositoryRoot: f.repository,
      files: [{ component: "owner-config", path: configPath, format: "json" }],
      plan: { schemaVersion: 3, resolverVersion: "1", policyVersion: "1", repository: await readExecutionRepositorySnapshot(f.repository), mode: "intake" } });
    f.ports.readExecutionResolution = reader;
    await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async (state, save) => {
      await bindAcceptedExecutionPlan(state.runs[0]!, reader); await save();
    });
    const before = await read(f);
    await f.runtime.amendTaskScope(drop, { source: "coordinator" });
    const after = await read(f);
    expect(after.runs[0]!.definition).toEqual(before.runs[0]!.definition);
    expect(after.runs[0]!.executionPlan!.fingerprint).toBe(before.runs[0]!.executionPlan!.fingerprint);
    await expect(assertRunExecutionPlan(after.runs[0]!, reader)).resolves.toBeUndefined();
    f.restart();
    await f.runtime.initialize?.();
    expect((await f.inspect()).tasks[0].spec.specification.version).toBe(2);
  }, 180_000);

  it("lets a Director amend a task parked as plan_mismatch while the run is completed_with_parked, then reopen it", async () => {
    const { f } = await stopped(true);
    for (const pane of f.panes.bindings.filter(item => item.role === "developer")) pane.metadata = { taskId: "run-1-implement", runId: "run-1" };
    f.ports.stopDeveloperExecutionScope = async handle => ({ source: "linux_pid_namespace", handle, observedAt: new Date().toISOString(),
      scopeId: randomUUID(), bootId: randomUUID(), initPid: 123, initStartTime: "1", namespace: "pid:[123]", receiptDigest: "a".repeat(64) });
    expect(await f.runtime.autoParkPass({ enabled: true, maxAutoResumesBeforePark: 3 })).toMatchObject({ parked: [{ kind: "plan_mismatch" }] });
    expect((await f.inspect()).status).toBe("completed_with_parked");
    expect(await f.runtime.amendTaskScope(drop, { source: "director" })).toMatchObject({ amended: true, nextStep: expect.stringContaining("set_issue_status retrying") });
    expect((await f.inspect()).status).toBe("completed_with_parked");
    expect(await f.runtime.unparkTask({ runId: "run-1", taskId: "implement", source: "director" })).toMatchObject({ unparked: true, runStatus: "implementing" });
    const state = await read(f);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]!.tasks[0]!.scopeAmendments).toMatchObject([{ source: "director" }]);
    expect(state.runs[0]!.tasks[0]!.parkHistory).toMatchObject([{ kind: "plan_mismatch" }]);
  }, 180_000);

  it("is reachable through the Coordinator and Director tool entry points", async () => {
    const { f } = await stopped();
    const tools = new CoordinatorTools(f.runtime);
    await expect(tools.invoke("amend_task_scope", { ...drop, changes: [{ kind: "drop_planned_paths", paths: ["src"] }] }, { role: "coordinator" })).rejects.toThrow(/not recorded as missing/);
    await expect(tools.invoke("amend_task_scope", drop, { role: "developer" })).rejects.toThrow(/Only Coordinator/);
    expect(await tools.invoke("amend_task_scope", drop, { role: "coordinator" })).toMatchObject({ amended: true });
  }, 180_000);
});

describe.skipIf((await probeBehavioralSandbox()).status !== "ready")("scenario 06/11 end to end", () => {
  it("breaker trips, scope is amended, the same run re-measures and completes", async () => {
    const { f } = await stopped();
    const first = (await f.inspect()).pendingAction.actionId;
    await f.runtime.resumeBlockedRun("run-1", first, { conversationUserMessageId: "u-1" });
    await f.runtime.amendTaskScope(drop, { source: "coordinator" });
    await f.runtime.resumeBlockedRun("run-1", (await f.inspect()).pendingAction?.actionId ?? first, { conversationUserMessageId: "u-2" });
    const red = await f.measure("red"); expect(red.status).toBe("failed");
    expect(await f.runtime.authorizeImplementation("run-1", "implement")).toMatchObject({ authorized: true });
    await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), "module.exports=x=>x*2;\n");
    await f.commit("Green: double the input");
    expect((await f.measure("green")).status).toBe("passed");
    await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), "const double=x=>2*x; module.exports=double;\n");
    await f.commit("Refactor: name the doubling operation");
    expect((await f.measure("refactor")).status).toBe("passed");
    await f.submit("implement", null); await f.tickWithReviews(); await f.tickWithReviews();
    await f.approve();
    const state = await read(f);
    expect((await f.inspect()).status).toBe("completed");
    expect(state.runs.map((run: any) => run.runId)).toEqual(["run-1"]);
  }, 240_000);
});
