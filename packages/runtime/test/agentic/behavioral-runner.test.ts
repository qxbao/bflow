import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaneBindingSchema, QualityGateContextSchema, SpecificationSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { TestStrategyResolver, assertEvidenceComplete, assertReadyToImplement, recordEvidence } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { measureBehavior, parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const testName = "ac-1: Target behavior matches expected output";
const testSource = `const {test}=require('node:test'); const assert=require('node:assert/strict'); const value=require('../source.cjs'); test(${JSON.stringify(testName)},()=>assert.equal(value(2),4));\n`;
async function fixture(taskType = "bugfix") {
  const root = await mkdtemp("/tmp/bflow-measurement-test-"), cwd = join(root, "repo"); await mkdir(cwd); await mkdir(join(cwd, "test"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  await writeFile(join(cwd, "source.cjs"), "module.exports=x=>x+1;\n"); git("add", "."); git("commit", "-m", "baseline"); const base = git("rev-parse", "HEAD");
  const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  await writeFile(join(cwd, "test/behavior.test.cjs"), testSource); const redRevision = commit("failing acceptance test");
  const command = parseBehavioralCommands([{ id: "node-unit", command: "owner:test-unit", executable: process.execPath, args: ["--test", "--test-reporter=tap", "test/behavior.test.cjs"], method: "unit_test", levels: ["unit", "regression"], testNames: [testName], testPaths: ["test/behavior.test.cjs"], timeoutMs: 3000 }])[0]!;
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
  return { cwd, git, commit, command, specification, redRevision, base, binding, host, restart(commands = [command]) { return new HostVerification(() => runtime, () => opened.value, new HostReceiptJournal(receiptsPath, cwd, "session-1"), commands); }, get strategy() { return strategy; }, accept(result: unknown) { strategy = recordEvidence(strategy, result); } };
}
describe("independent behavioral command measurements", () => {
  it("observes Red before authorization, then Green/Refactor with immutable tests and trusted artifacts", async () => {
    const f = await fixture();
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
  });
  it("replays an identical durable phase after host restart and rejects a changed verifier binding", async () => {
    const f = await fixture();
    const first = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" });
    const restored = f.restart();
    expect(await restored.authenticateEvidence(first.result)).toBe(true);
    const replay = await restored.behavioralEvidence({ ...f.binding, transportState: "done" }, { runId: "run-1", taskId: "task-1", phase: "red" });
    expect(replay.result).toEqual(first.result);
    f.accept(first.result);
    expect((await restored.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" })).result).toEqual(first.result);
    await expect(restored.behavioralEvidence({ ...f.binding, session: { source: "test", kind: "id", value: "different-native-session" } }, { runId: "run-1", taskId: "task-1", phase: "red" })).rejects.toThrow("another verifier binding");
  });
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
  it.each(["refactoring", "documentation"])("requires real passing verification when policy mode for %s is not required", async taskType => {
    const f = await fixture(taskType); expect(f.strategy.tddDecision.mode).not.toBe("required");
    expect(() => assertEvidenceComplete(f.strategy)).toThrow();
    await expect(f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "verification" })).rejects.toThrow("Behavioral acceptance failed");
    await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2;\n"); f.commit("working behavior");
    const result = await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "verification" }); f.accept(result.result);
    expect(() => assertEvidenceComplete(f.strategy)).not.toThrow();
  });
  it("measures both task and workflow gates at the supplied exact committed revision and blocks regressions", async () => {
    const f = await fixture();
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
  it("rejects unsupported owner configuration and unmapped automated specification methods", async () => {
    const f = await fixture();
    expect(() => parseBehavioralCommands([{ ...f.command, executable: "node" }])).toThrow("absolute");
    expect(() => parseBehavioralCommands([{ ...f.command, testPaths: ["../test.cjs"] }])).toThrow("safe");
    expect(() => parseBehavioralCommands([{ ...f.command, success: true }])).toThrow("Unknown");
    expect(() => f.host.assertSupported({ ...f.specification, acceptanceCriteria: [{ ...f.specification.acceptanceCriteria[0], verificationMethod: "static_analysis" }] })).toThrow("No owner-configured");
  });
});
