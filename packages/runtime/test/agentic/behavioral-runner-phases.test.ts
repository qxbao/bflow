import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { afterEach, describe, expect, it } from "vitest";
import { QualityGateContextSchema } from "@bflow/contracts";
import { assertEvidenceComplete, assertReadyToImplement } from "../../../test-strategy/src/index.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostBehavioralFailure, HostVerification, boundQaReviewCommands } from "../../src/agentic/host-verification.js";
import { measureBehavior, parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { cleanups, testName, testSource, fixture } from "../helpers/behavioral-runner-fixture.js";

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe.skipIf((await probeBehavioralSandbox()).status !== "ready")("independent behavioral command measurements", () => {
  it.each([true, false])("exposes real owner-run tests at the integrated QA revision and prevents a false pass (passing=%s)", async passing => {
    const f = await fixture();
    if (passing) { await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2;\n"); f.commit("integrated implementation"); }
    const revision = f.git("rev-parse", "HEAD"), binding = { ...f.binding, role: "qa" as const, session: { source: "test", kind: "id" as const, value: "workflow-qa-native" } };
    const context = QualityGateContextSchema.parse({ runId: "run-1", taskId: "workflow-verification", attemptId: "workflow-attempt",
      definition: { id: "host-qa", name: "QA", evaluator: "native-herdr-review", required: true, timeout: { executionTimeoutMs: 300000, onTimeout: "block" },
        configuration: { kind: "review", role: "qa", method: "manual_review", criterionIds: ["ac-1"], testNames: [testName], levels: [] } },
      artifacts: [], input: { scope: "workflow", sourceRevision: revision, baseRevision: f.base, sourceWorktreePath: f.cwd, specFingerprint: "a".repeat(64) } });
    const runtime = { inspect: async (runId?: string) => runId ? { baseRevision: f.base, workflowSpec: { specification: f.specification, strategy: f.strategy }, tasks: [] }
      : { outbound: [{ status: "accepted", message: { message_id: "workflow-qa", type: "verification.requested", payload: context }, handle: { target: { paneId: binding.paneId, agentId: binding.agentId, session: binding.session } } }] } } as unknown as AgenticWorkflowRuntime;
    const reopen = () => new HostVerification(() => runtime, () => f.store, new HostReceiptJournal(join(f.cwd, "..", "workflow-qa-receipts"), f.cwd, "session-1"), [f.command]);
    const host = reopen();
    const observed = await host.inspectReview(binding, { messageId: "workflow-qa" }) as any;
    expect(observed.qaBehavioralObservation).toMatchObject({ sourceRevision: revision, passed: passing, measurements: [{ exitCode: passing ? 0 : 1, tests: 1 }] });
    const legacyReceipts = new HostReceiptJournal(join(f.cwd, "..", "workflow-qa-receipts"), f.cwd, "session-1");
    await legacyReceipts.putObservation("review", "legacy-diff-only", { binding, context, observation: observed.observation });
    await expect(reopen().completeReview(binding, { reviewId: "legacy-diff-only", criteria: [{ criterionId: "ac-1", passed: true, summary: "Code review" }], summary: "Legacy observation" })).rejects.toThrow(/new inspect_review/);
    const complete = await reopen().completeReview(binding, { reviewId: observed.reviewId, criteria: [{ criterionId: "ac-1", passed: true, summary: "Code review" }], summary: "Reviewed integrated revision" });
    expect(complete.result.status).toBe(passing ? "passed" : "failed");
    expect(complete.result.metadata?.hostQaBehavioralObservation).toEqual(observed.qaBehavioralObservation);
    await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*3;\n"); f.commit("worktree advanced after immutable completion");
    expect((await reopen().completeReview(binding, { reviewId: observed.reviewId, criteria: [{ criterionId: "ac-1", passed: true, summary: "Code review" }], summary: "Reviewed integrated revision" })).result).toEqual(complete.result);
    expect(f.strategy.metadata?.tddEvidence ?? []).toHaveLength(0);
  });

  it("bounds aggregate QA execution without changing owner argv and refuses a batch without setup budget", async () => {
    const f = await fixture();
    const original = { ...f.command, timeoutMs: 180000, prepare: { args: ["owner-build"], timeoutMs: 120000 } };
    const [bounded] = boundQaReviewCommands([original], 270000);
    expect(bounded!.timeoutMs + bounded!.prepare!.timeoutMs + 90000).toBeLessThanOrEqual(270000);
    expect(bounded!.args).toEqual(original.args); expect(bounded!.prepare!.args).toEqual(original.prepare.args);
    expect(original.timeoutMs).toBe(180000); expect(original.prepare.timeoutMs).toBe(120000);
    expect(() => boundQaReviewCommands([original, original, original], 270000)).toThrow(/aggregate/);
  });

  it("returns a bounded test repair for non-assertion Red failures without granting implementation authority", async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, "test/behavior.test.cjs"), `const {test}=require('node:test'); const value=require('../source.cjs'); test(${JSON.stringify(testName)},()=>value.multiply(2,3));\n`);
    f.commit("Red calls an absent export without an assertion");
    let failure: unknown;
    try { await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(HostBehavioralFailure);
    if (!(failure instanceof HostBehavioralFailure)) throw failure;
    expect(failure.message).toContain("assertion");
    expect(() => assertReadyToImplement(f.strategy)).toThrow(/Red/);
    const chunks: Uint8Array[] = [];
    for await (const chunk of f.store.get(failure.evidence)) {
      if (!chunk.ok) throw new Error(chunk.error.message);
      chunks.push(chunk.value);
    }
    const observed = JSON.parse(Buffer.concat(chunks).toString());
    expect(observed.accepted).toBe(false);
    expect(observed.measurementFailure.outcome.stdout).toContain("TypeError");
    expect(observed.measurementFailure.outcome.exitCode).toBe(1);
    await writeFile(join(f.cwd, "test/behavior.test.cjs"), `const {test}=require('node:test'); const assert=require('node:assert/strict'); const value=require('../source.cjs'); test(${JSON.stringify(testName)},()=>assert.equal(typeof value.multiply,'function'));\n`);
    const corrected = f.commit("Assert the missing target behavior before calling it");
    const red = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" });
    expect(red.result.status).toBe("failed");
    expect((red.result.metadata!.conditionalTdd as any).sourceRevision).toBe(corrected);
    f.accept(red.result);
    expect(() => assertReadyToImplement(f.strategy)).not.toThrow();
  }, 30000);

  it("bounds aggregate command time and output within host transport capacity", async () => {
    const f = await fixture();
    expect(() => parseBehavioralCommands([{ ...f.command, timeoutMs: 300_001 }])).toThrow("execution bounds");
    expect(() => parseBehavioralCommands([{ ...f.command, maxOutputBytes: 4_194_305 }])).toThrow("execution bounds");
    expect(() => parseBehavioralCommands([{ ...f.command, timeoutMs: 300_000 },
      { ...f.command, id: "second", command: "owner:second", timeoutMs: 300_000 }])).toThrow("Aggregate");
  });
  it.each(["node_tap", "vitest_json"] as const)("%s observes Red before authorization, then Green/Refactor with immutable tests and trusted artifacts", async reporter => {
    const f = await fixture("bugfix", reporter);
    expect(() => assertReadyToImplement(f.strategy)).toThrow(/Red/);
    const red = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" });
    expect(red.result.status).toBe("failed"); expect(await f.host.authenticateEvidence(red.result)).toBe(true);
    expect((red.result.metadata!.conditionalTdd as any).sourceRevision).toBe(f.redRevision);
    f.accept(red.result); expect(() => assertReadyToImplement(f.strategy)).not.toThrow();
    await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2;\n"); const greenRevision = f.commit("fix behavior");
    const green = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "green" }); f.accept(green.result);
    expect(() => assertEvidenceComplete(f.strategy)).toThrow();
    await writeFile(join(f.cwd, "source.cjs"), "const double=x=>2*x; module.exports=double;\n"); const refactorRevision = f.commit("refactor implementation");
    const refactor = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "refactor" }); f.accept(refactor.result);
    expect(() => assertEvidenceComplete(f.strategy)).not.toThrow();
    for (const [result, sourceRevision] of [[green.result, greenRevision], [refactor.result, refactorRevision]] as const) {
      expect(result.metadata!.conditionalTdd).toMatchObject({ sourceRevision, testRevision: f.redRevision, testNames: [testName] });
      expect(result.evidenceArtifacts[0]!.trust).toBe("stored");
    }
    expect(await f.host.authenticateEvidence({ ...green.result, status: "failed" })).toBe(false);
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  }, 120_000);
  it.each(["node_tap", "vitest_json"] as const)("%s replays an identical durable phase after host restart and rejects a changed verifier binding", async reporter => {
    const f = await fixture("bugfix", reporter);
    const first = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" });
    const restored = f.restart();
    expect(await restored.authenticateEvidence(first.result)).toBe(true);
    const replay = await restored.behavioralEvidence({ ...f.binding, transportState: "done" }, { runId: "run-1", taskId: "task-1", phase: "red" });
    expect(replay.result).toEqual(first.result);
    f.accept(first.result);
    expect((await restored.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" })).result).toEqual(first.result);
    await expect(restored.behavioralEvidence({ ...f.binding, session: { source: "test", kind: "id", value: "different-native-session" } }, { runId: "run-1", taskId: "task-1", phase: "red" })).rejects.toThrow("another verifier binding");
  }, 120_000);
  it("rejects changed Red test bytes, stale phases, self verification and agent supplied success claims", async () => {
    const f = await fixture();
    await expect(f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "green" })).rejects.toThrow("Expected red");
    await expect(f.host.behavioralEvidence({ ...f.binding, agentId: "developer" }, { runId: "run-1", taskId: "task-1", phase: "red" })).rejects.toThrow("Implementer");
    await expect(f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red", passed: true })).rejects.toThrow("host owned");
    const red = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" }); f.accept(red.result);
    await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2;\n");
    await writeFile(join(f.cwd, "test/behavior.test.cjs"), testSource + "// Test replacement is forbidden even if its name remains unchanged.\n"); f.commit("replace tests");
    await expect(f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "green" })).rejects.toThrow("exact committed Red test files");
  });
  it.each([
    ["zero tests", "// no tests\n"],
    ["module loading error", "require('./missing-file.cjs');\n"],
    ["syntax error", "const = broken syntax;\n"],
    ["unrelated exception", `const {test}=require('node:test'); test(${JSON.stringify(testName)},()=>{throw new Error('infrastructure unavailable')});\n`],
    ["nonzero process", "process.exit(2);\n"],
    ["skipped tests", `const {test}=require('node:test'); test.skip(${JSON.stringify(testName)},()=>{});\n`]
  ])("blocks %s instead of minting Red", async (_label, source) => {
    const f = await fixture(); await writeFile(join(f.cwd, "test/behavior.test.cjs"), source); f.commit("broken infrastructure");
    await expect(f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" })).rejects.toThrow();
    expect(() => assertReadyToImplement(f.strategy)).toThrow(/Red/);
  });
  it("rejects an unrelated assertion failure when the mapped target test passes", async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2;\n");
    await writeFile(join(f.cwd, "test/behavior.test.cjs"), testSource + "test('unrelated health check',()=>assert.equal(false,true));\n"); f.commit("unrelated regression");
    const host = f.restart([{ ...f.command, testNames: [testName, "unrelated health check"] }]);
    await expect(host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" })).rejects.toThrow("unrelated test");
    expect(() => assertReadyToImplement(f.strategy)).toThrow(/Red/);
  });
  it("blocks spawn/deadline/output failures, dirty sources and zero-exit commands without tests", async () => {
    const f = await fixture();
    await expect(measureBehavior({ ...f.command, executable: "/missing/bflow-node" }, f.cwd, f.redRevision)).rejects.toThrow("infrastructure failure");
    await expect(measureBehavior({ ...f.command, timeoutMs: 1 }, f.cwd, f.redRevision)).rejects.toThrow("infrastructure failure");
    await expect(measureBehavior({ ...f.command, maxOutputBytes: 10 }, f.cwd, f.redRevision)).rejects.toThrow("infrastructure failure");
    await expect(measureBehavior({ ...f.command, args: ["-e", "process.exit(0)"] }, f.cwd, f.redRevision)).rejects.toThrow("complete Node TAP");
    await writeFile(join(f.cwd, "uncommitted.txt"), "dirty\n");
    await expect(measureBehavior(f.command, f.cwd, f.redRevision)).rejects.toThrow("clean worktree");
  });
});
