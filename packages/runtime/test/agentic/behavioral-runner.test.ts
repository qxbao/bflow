import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { copyIsolatedNodeDependencies } from "../helpers/isolated-node-dependencies.js";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { afterEach, describe, expect, it } from "vitest";
import { PaneBindingSchema, QualityGateContextSchema, SpecificationSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { TestStrategyResolver, assertEvidenceComplete, assertReadyToImplement, recordEvidence } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostBehavioralFailure, HostVerification, boundQaReviewCommands } from "../../src/agentic/host-verification.js";
import { parseVitestJson } from "../../src/agentic/vitest-json.js";
import { measureBehavior, parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const testName = "ac-1: Target behavior matches expected output";
const testSource = `const {test}=require('node:test'); const assert=require('node:assert/strict'); const value=require('../source.cjs'); test(${JSON.stringify(testName)},()=>assert.equal(value(2),4));\n`;
const vitestCli = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
const vitestSource = `const value=require('../source.cjs'); it(${JSON.stringify(testName)},()=>expect(value(2)).toBe(4));\n`;
async function fixture(taskType = "bugfix", reporter: "node_tap" | "vitest_json" = "node_tap") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-measurement-test-"))), cwd = join(root, "repo"); await mkdir(cwd); await mkdir(join(cwd, "test"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  await writeFile(join(cwd, "source.cjs"), "module.exports=x=>x+1;\n"); git("add", "."); git("commit", "-m", "baseline"); const base = git("rev-parse", "HEAD");
  const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  await writeFile(join(cwd, "test/behavior.test.cjs"), reporter === "vitest_json" ? vitestSource : testSource); const redRevision = commit("failing acceptance test");
  const sourceDependencies = fileURLToPath(new URL("../../../../node_modules", import.meta.url));
  const dependencies = join(root, "node_modules");
  if (reporter === "vitest_json") await copyIsolatedNodeDependencies(sourceDependencies, dependencies);
  const stagedVitest = join(dependencies, relative(sourceDependencies, vitestCli));
  const command = parseBehavioralCommands([{ id: "node-unit", command: "owner:test-unit", executable: process.execPath, args: reporter === "vitest_json" ? [stagedVitest, "run", "--globals", "--reporter=json", "--no-cache", "--maxWorkers=1", "--minWorkers=1", "test/behavior.test.cjs"] : ["--test", "--test-reporter=tap", "test/behavior.test.cjs"], ...(reporter === "vitest_json" ? { reporter, dependencyRoots: [dependencies] } : {}), method: "unit_test", levels: ["unit", "regression"], testNames: [testName], testPaths: ["test/behavior.test.cjs"],
    // A nested Vitest needs more than 3 s to start under full-suite load; deadline handling is covered with timeoutMs: 1 below.
    timeoutMs: reporter === "vitest_json" ? 15_000 : 3000 }])[0]!;
  const policyAssessment = assessment(taskType);
  const draft = SpecificationSchema.parse({ ...spec(assessment(taskType, { ...(taskType === "documentation" ? { changeImpact: { ...policyAssessment.changeImpact, behaviorChanged: false, deterministic: false, regressionReproducible: false } } : {}), infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: command.command, level: "unit" }] } })), affectedPaths: taskType === "documentation" ? ["guide.md"] : ["source.cjs", "test/behavior.test.cjs"] });
  let strategy = new TestStrategyResolver().resolve(draft);
  const opened = await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "behavioral-test" }); if (!opened.ok) throw new Error(opened.error.message);
  cleanups.push(async () => { opened.value.close(); await rm(root, { recursive: true, force: true }); });
  const bytes = Buffer.from(JSON.stringify(draft));
  const stored = await opened.value.put({ options: { artifactId: "accepted-spec", runId: "run-1", taskId: "task-1", kind: "document", mediaType: "application/json", idempotencyKey: "accepted-spec", expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length } }, content: (async function* () { yield bytes; })() });
  if (!stored.ok) throw new Error(stored.error.message);
  const specification = SpecificationSchema.parse({ ...draft, status: "approved", approvedBy: "architect", artifactRef: stored.value });
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "tester-binding", sessionId: "session-1", role: "tester", agentId: "independent-tester", paneId: "tester-pane", workspaceId: "workspace", tabId: "tab", provider: "test", agentKind: "test", cwd, isolationMode: "dedicated_pane", readOnlyWorkspace: true, transportState: "idle", boundAt: new Date().toISOString() });
  const assignment = { message_id: "assignment", type: "task.assignment", run_id: "run-1" };
  const runtime = { inspect: async (runId?: string) => runId ? { baseRevision: base, tasks: [{ taskId: "task-1", spec: { specification, strategy } }] } : { outbound: [{ taskId: "task-1", message: assignment, handle: { target: { agentId: "developer", paneId: "developer-pane", worktreePath: cwd } } }] }, ports: { policies: { recordEvidence } } } as unknown as AgenticWorkflowRuntime;
  const receiptsPath = join(root, "host-receipts");
  const host = new HostVerification(() => runtime, () => opened.value, new HostReceiptJournal(receiptsPath, cwd, "session-1"), [command]);
  return { cwd, git, commit, command, specification, redRevision, base, binding, host, store: opened.value, restart(commands = [command]) { return new HostVerification(() => runtime, () => opened.value, new HostReceiptJournal(receiptsPath, cwd, "session-1"), commands); }, get strategy() { return strategy; }, accept(result: unknown) { strategy = recordEvidence(strategy, result); } };
}
// Measurement launches require the production Bubblewrap namespace sandbox.
describe.skipIf((await probeBehavioralSandbox()).status !== "ready")("independent behavioral command measurements", () => {
  it.each([true, false])("exposes real owner-run tests at the integrated QA revision and prevents a false pass (passing=%s)", async passing => {
    const f = await fixture();
    if (passing) { await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2;\n"); f.commit("integrated implementation"); }
    const revision = f.git("rev-parse", "HEAD"), binding = { ...f.binding, role: "qa" as const };
    const context = QualityGateContextSchema.parse({ runId: "run-1", taskId: "workflow-verification", attemptId: "workflow-attempt",
      definition: { id: "host-qa", name: "QA", evaluator: "native-herdr-review", required: true, timeout: { executionTimeoutMs: 300000, onTimeout: "block" },
        configuration: { kind: "review", role: "qa", method: "manual_review", criterionIds: ["ac-1"], testNames: [testName], levels: [] } },
      artifacts: [], input: { scope: "workflow", sourceRevision: revision, baseRevision: f.base, sourceWorktreePath: f.cwd, specFingerprint: "a".repeat(64) } });
    const runtime = { inspect: async (runId?: string) => runId ? { baseRevision: f.base, workflowSpec: { specification: f.specification, strategy: f.strategy }, tasks: [] }
      : { outbound: [{ message: { message_id: "workflow-qa", type: "verification.requested", payload: context }, handle: { target: { paneId: binding.paneId } } }] } } as unknown as AgenticWorkflowRuntime;
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
  it.each([["refactoring", "node_tap"], ["documentation", "node_tap"], ["refactoring", "vitest_json"], ["documentation", "vitest_json"]] as const)("requires real passing verification for %s with %s", async (taskType, reporter) => {
    const f = await fixture(taskType, reporter); expect(f.strategy.tddDecision.mode).not.toBe("required");
    expect(() => assertEvidenceComplete(f.strategy)).toThrow();
    await expect(f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "verification" })).rejects.toThrow("Behavioral acceptance failed");
    await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2;\n"); f.commit("working behavior");
    const result = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "verification" }); f.accept(result.result);
    expect(() => assertEvidenceComplete(f.strategy)).not.toThrow();
  });
  it.each(["node_tap", "vitest_json"] as const)("%s measures task and workflow gates at the exact committed revision and blocks regressions", async reporter => {
    const f = await fixture("bugfix", reporter);
    const definition = f.host.behavioralChecks()[0]!;
    const evaluate = (scope: string, revision: string) => f.host.behavioralGates()[0]!.evaluate(QualityGateContextSchema.parse({ runId: "run-1", taskId: scope === "task" ? "task-1" : "workflow-finalization", attemptId: `attempt-${scope}`, definition: { ...definition, configuration: { ...definition.configuration, criterionIds: ["ac-1"] } }, artifacts: [], input: { sourceRevision: revision, sourceWorktreePath: f.cwd, specFingerprint: "a".repeat(64), scope } }));
    const failed = await evaluate("task", f.redRevision); expect(failed.ok && failed.value.status).toBe("failed");
    await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2;\n"); const revision = f.commit("working behavior");
    for (const scope of ["task", "workflow"]) {
      const result = await evaluate(scope, revision); expect(result.ok && result.value.status).toBe("passed");
      expect(result.ok && result.value.metadata!.verification).toMatchObject({ sourceRevision: revision, scope, independentExecution: true, exitCode: 0 });
    }
    const stale = await evaluate("workflow", f.redRevision); expect(stale.ok).toBe(false);
    await writeFile(join(f.cwd, "test/behavior.test.cjs"), "throw new Error('infrastructure failure');\n"); const broken = f.commit("break tests");
    expect((await evaluate("workflow", broken)).ok).toBe(false);
  });
  it.each([
    ["zero tests", "// no tests\n"],
    ["skipped tests", `it.skip(${JSON.stringify(testName)},()=>{});\n`],
    ["todo tests", `it.todo(${JSON.stringify(testName)});\n`],
    ["file runtime error", "throw new Error('runtime unavailable');\n"],
    ["ordinary test exception", `it(${JSON.stringify(testName)},()=>{throw new Error('unrelated infrastructure')});\n`],
    ["unhandled rejection beside an assertion failure", `it(${JSON.stringify(testName)},async()=>{Promise.reject(new Error('hidden runtime failure'));await new Promise(r=>setTimeout(r,20));expect(1).toBe(2)});\n`],
    ["hook failure beside an assertion", `afterAll(()=>{throw new Error('cleanup failed')}); ${vitestSource}`]
  ])("Vitest blocks %s before minting evidence", async (_label, source) => {
    const f = await fixture("bugfix", "vitest_json"); await writeFile(join(f.cwd, "test/behavior.test.cjs"), source); f.commit("invalid Vitest evidence");
    await expect(f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" })).rejects.toThrow();
    expect(() => assertReadyToImplement(f.strategy)).toThrow(/Red/);
  });
  it("Vitest preserves Red test blobs and rejects unrelated assertion failures", async () => {
    const f = await fixture("bugfix", "vitest_json");
    const red = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" }); f.accept(red.result);
    await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2;\n");
    await writeFile(join(f.cwd, "test/behavior.test.cjs"), vitestSource + "// changed test identity\n"); f.commit("replace Red test");
    await expect(f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "green" })).rejects.toThrow("exact committed Red test files");
    const other = await fixture("bugfix", "vitest_json");
    await writeFile(join(other.cwd, "source.cjs"), "module.exports=x=>x*2;\n");
    await writeFile(join(other.cwd, "test/behavior.test.cjs"), vitestSource + "it('unrelated health check',()=>expect(false).toBe(true));\n"); other.commit("unrelated assertion");
    const host = other.restart([{ ...other.command, testNames: [testName, "unrelated health check"] }]);
    await expect(host.behavioralEvidence(other.binding, { runId: "run-1", taskId: "task-1", phase: "red" })).rejects.toThrow("unrelated test");
  });
  it("validates real Vitest JSON aggregate/leaf counters, full names, statuses, failures and completion", async () => {
    const f = await fixture("bugfix", "vitest_json");
    await writeFile(join(f.cwd, "test/behavior.test.cjs"), `const value=require('../source.cjs');describe('nested',()=>{describe('math',()=>{it(${JSON.stringify(testName)},()=>expect(value(2)).toBe(4))})});\n`);
    const revision = f.commit("nested accepted tests"), names = [`nested math ${testName}`];
    const measured = await measureBehavior({ ...f.command, testNames: names }, f.cwd, revision);
    expect(parseVitestJson(measured.outcome, names)).toMatchObject({ tests: 1, passed: 0, failed: 1, targetFailure: true });
    const report = JSON.parse(measured.outcome.stdout);
    for (const mutate of [
      (value: any) => value.numTotalTests++, (value: any) => value.numPassedTests++, (value: any) => value.numFailedTests++,
      (value: any) => value.numTotalTestSuites++, (value: any) => value.numPassedTestSuites++, (value: any) => value.numFailedTestSuites++,
      (value: any) => value.numPendingTestSuites++, (value: any) => value.numPendingTests++, (value: any) => value.numTodoTests++,
      (value: any) => value.success = true, (value: any) => value.testResults[0].status = "passed",
      (value: any) => value.testResults[0].message = "runtime unavailable", (value: any) => value.testResults[0].assertionResults[0].status = "skipped",
      (value: any) => value.testResults[0].assertionResults[0].fullName = "renamed", (value: any) => value.testResults[0].assertionResults[0].failureMessages = [],
      (value: any) => value.testResults[0].assertionResults[0].failureMessages = ["Error: database unavailable"],
      (value: any) => value.testResults[0].assertionResults.push(value.testResults[0].assertionResults[0])
    ]) {
      const changed = structuredClone(report); mutate(changed);
      expect(() => parseVitestJson({ ...measured.outcome, stdout: JSON.stringify(changed) }, names)).toThrow();
    }
    expect(() => parseVitestJson({ ...measured.outcome, stderr: "" }, names)).toThrow("runtime errors");
    expect(() => parseVitestJson({ ...measured.outcome, stdout: measured.outcome.stdout.slice(0, -4) }, names)).toThrow("complete Vitest JSON");
    expect(() => parseVitestJson({ ...measured.outcome, exitCode: 0 }, names)).toThrow("exit code");
    expect(() => parseVitestJson({ ...measured.outcome, timedOut: true }, names)).toThrow("infrastructure");
    expect(() => parseVitestJson(measured.outcome, ["different identity"])).toThrow("identities");
  });
  it("rejects unsupported owner configuration and unmapped automated specification methods", async () => {
    const f = await fixture();
    expect(() => parseBehavioralCommands([{ ...f.command, executable: "node" }])).toThrow("absolute");
    expect(() => parseBehavioralCommands([{ ...f.command, testPaths: ["../test.cjs"] }])).toThrow("safe");
    expect(() => parseBehavioralCommands([{ ...f.command, success: true }])).toThrow("Unknown");
    expect(() => parseBehavioralCommands([{ ...f.command, reporter: "unknown" }])).toThrow("reporter");
    expect(parseBehavioralCommands([{ ...f.command, reporter: "node_tap" }])[0]?.reporter).toBe("node_tap");
    expect(f.command.reporter).toBeUndefined();
    expect(() => f.host.assertSupported({ ...f.specification, acceptanceCriteria: [{ ...f.specification.acceptanceCriteria[0], verificationMethod: "static_analysis" }] })).toThrow("No owner-configured");
  });
});
