import { createHash } from "node:crypto";
import { writeDarwinRtkFixture } from "./rtk-fixture.js";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { afterEach, describe, expect, it } from "vitest";
import { PaneBindingSchema, QualityGateContextSchema } from "@bflow/contracts";
import { assertEvidenceComplete, assertReadyToImplement } from "../../../test-strategy/src/index.js";
import { spec } from "../../../test-strategy/test/fixtures.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { HostBehavioralFailure } from "../../src/agentic/host-verification.js";
import { FileToolUsageLedger } from "../../src/platform/tool-usage-ledger.js";
import { parseVitestJson } from "../../src/agentic/vitest-json.js";
import { BehavioralMeasurementError, measureBehavior, measurementDiagnostics, parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import { BehavioralIdentityMismatch, parseNodeTap } from "../../src/agentic/node-tap.js";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { cleanups, testName, vitestSource, fixture } from "../helpers/behavioral-runner-fixture.js";

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe.skipIf((await probeBehavioralSandbox()).status !== "ready")("independent behavioral command measurements", () => {
  it("keeps runner profile IDs separate from RTK auto mode and labels unchanged output", async () => {
    const f = await fixture();
    const executablePath = join(dirname(f.cwd), "rtk-auto-fixture");
    await writeFile(executablePath, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'rtk 1.0.1\\n'; exit 0; fi
if [ "$1" = "pipe" ] && [ "$2" = "--help" ]; then printf 'Read stdin --filter <FILTER>\\n'; exit 0; fi
if [ "$1" = "pipe" ] && [ "$#" = "1" ]; then cat; exit 0; fi
exit 1
`, { mode: 0o700 });
    await writeDarwinRtkFixture(executablePath, "passthrough");
    const digest = createHash("sha256").update(await (await import("node:fs/promises")).readFile(executablePath)).digest("hex");
    const measurement = await measureBehavior(f.command, f.cwd, f.redRevision, { rtk: {
      executablePath, version: "1.0.1", digest, filter: "auto", required: true } });
    expect(measurement).toMatchObject({ failed: 1, outcome: { exitCode: 1 }, rtk: { status: "passthrough", args: ["pipe"] } });
    expect(measurement.rtk?.compressedOutput).toBe(measurement.outcome.stdout +
      (measurement.outcome.stderr ? `\n[stderr]\n${measurement.outcome.stderr}` : ""));
  });
  it("compresses captured output through the pinned RTK filter while TAP still parses the original raw result", async () => {
    const f = await fixture();
    const rtkPath = join(dirname(f.cwd), "rtk-fixture");
    await writeFile(rtkPath, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'rtk 1.0.1\n'; exit 0; fi
if [ "$1" = "pipe" ] && [ "$2" = "--help" ]; then printf 'Read stdin --filter <FILTER>\n'; exit 0; fi
if [ "$1" = "pipe" ] && [ "$2" = "--filter" ] && [ "$3" = "node-unit" ]; then
  count=0; while IFS= read -r line; do count=$((count+1)); done
  printf 'filtered:%s lines\\n' "$count"; exit 0
fi
exit 2
`);
    await (await import("node:fs/promises")).chmod(rtkPath, 0o700);
    await writeDarwinRtkFixture(rtkPath, "count");
    const rawDigest = createHash("sha256").update(await (await import("node:fs/promises")).readFile(rtkPath)).digest("hex");

    const measured = await measureBehavior(f.command, f.cwd, f.redRevision, { rtk: {
      executablePath: rtkPath, version: "1.0.1", digest: rawDigest, filter: "node-unit", required: true
    } });

    expect(measured.outcome.exitCode).toBe(1);
    expect(measured.failed).toBe(1);
    expect(measured.rtk).toMatchObject({ status: "compressed", filter: "node-unit", compressedOutput: expect.stringContaining("filtered:") });
  });
  it("blocks a required RTK prerequisite before the runner and degrades an optional missing filter to raw output", async () => {
    const f = await fixture();
    const unavailable = { executablePath: join(f.cwd, "missing-rtk"), version: "1.0.1", digest: "a".repeat(64), filter: "node-unit" };
    await expect(measureBehavior(f.command, f.cwd, f.redRevision, { rtk: { ...unavailable, required: true } }))
      .rejects.toThrow(/RTK executable/);
    const optional = await measureBehavior(f.command, f.cwd, f.redRevision, { rtk: { ...unavailable, required: false } });
    expect(optional).toMatchObject({ failed: 1, outcome: { exitCode: 1 }, rtk: { status: "degraded", reasonCode: "rtk_binary_unavailable" } });
  });
  it("blocks required RTK formatting failure after one command while retaining the original raw result", async () => {
    const f = await fixture();
    const rtkPath = join(dirname(f.cwd), "rtk-required-filter-failure");
    await writeFile(rtkPath, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'rtk 1.0.1\\n'; exit 0; fi
if [ "$1" = "pipe" ] && [ "$2" = "--help" ]; then printf 'Read stdin --filter <FILTER>\\n'; exit 0; fi
if [ "$1" = "pipe" ] && [ "$2" = "--filter" ]; then
  input=$(cat)
  case "$input" in *'not ok'*) exit 2;; esac
  printf 'filtered probe\\n'; exit 0
fi
exit 2
`);
    await (await import("node:fs/promises")).chmod(rtkPath, 0o700);
    await writeDarwinRtkFixture(rtkPath, "fail-test-output");
    const statuses: string[] = [];
    try {
      await measureBehavior(f.command, f.cwd, f.redRevision, { rtk: {
        executablePath: rtkPath, version: "1.0.1", digest: createHash("sha256").update(await (await import("node:fs/promises")).readFile(rtkPath)).digest("hex"),
        filter: "node-unit", required: true, onResult: async result => { statuses.push(result.status); }
      } });
      throw new Error("Required RTK formatting unexpectedly succeeded");
    } catch (error) {
      expect(error).toMatchObject({ name: "RtkRequiredToolUnavailable", reasonCode: "rtk_filter_failed",
        originalOutcome: { exitCode: 1 }, rawOutput: expect.stringContaining("not ok") });
    }
    expect(statuses).toEqual(["failed"]);
  });
  it("uses the RTK path through Developer check_work and links consumption to raw feedback evidence", async () => {
    const f = await fixture();
    const developerBinding = PaneBindingSchema.parse({ ...f.binding, bindingId: "developer-binding", role: "developer", agentId: "dev-1",
      paneId: "developer-pane", worktreePath: f.cwd, readOnlyWorkspace: false });
    const state = { outbound: [{ status: "accepted", taskId: "task-1", attemptId: "attempt-1",
      message: { schema_version: 2, message_id: "assignment", correlation_id: "correlation", run_id: "run-1", sender: { role: "coordinator" },
        recipient: { role: "developer", agent_id: "dev-1", pane_id: "developer-pane" }, type: "task.assignment", payload: {},
        artifact_references: [], occurred_at: new Date().toISOString(), idempotency_key: "assignment" },
      handle: { executionId: "execution-1", requestId: "request-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-1",
        idempotencyKey: "assignment-1", target: { transport: "herdr", agentId: "dev-1", workspaceId: "workspace", tabId: "tab",
          paneId: "developer-pane", worktreePath: f.cwd }, correlation: { token: "request-1", provenance: "orchestrator", verified: false }, acceptedAt: new Date().toISOString() } }] };
    const task = { spec: { specification: f.specification, strategy: f.strategy }, worktrees: [{ baseCommitHash: f.base }] };
    const runtime = { inspect: async () => state, withDeveloperWorkspace: async (_binding: unknown, _runId: string, _taskId: string,
      use: (...args: any[]) => Promise<unknown>) => use(task, { metadata: { ownedPaths: ["source.cjs", "test/behavior.test.cjs"] } }),
      ports: { artifactStore: f.store, policies: { assertReadyToImplement: () => undefined } } } as unknown as AgenticWorkflowRuntime;
    const rtkPath = join(dirname(f.cwd), "rtk-check-work-fixture");
    await writeFile(rtkPath, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'rtk 1.0.1\\n'; exit 0; fi
if [ "$1" = "pipe" ] && [ "$2" = "--help" ]; then printf 'Read stdin --filter <FILTER>\\n'; exit 0; fi
if [ "$1" = "pipe" ] && [ "$2" = "--filter" ] && [ "$3" = "node-unit" ]; then
  count=0; while IFS= read -r line; do count=$((count+1)); done
  printf 'filtered:%s lines\\n' "$count"; exit 0
fi
exit 2
`);
    await (await import("node:fs/promises")).chmod(rtkPath, 0o700);
    await writeDarwinRtkFixture(rtkPath, "count");
    const rtkDigest = createHash("sha256").update(await (await import("node:fs/promises")).readFile(rtkPath)).digest("hex");
    const ledger = new FileToolUsageLedger(join(dirname(f.cwd), "tool-usage.json"));
    const integration = { resolve: async () => ({ executablePath: rtkPath, version: "1.0.1", digest: rtkDigest, filter: "node-unit", required: true,
      invocationId: "tool-rtk-check", onIntent: async () => ledger.begin({ schemaVersion: 3, runId: "run-1", taskId: "task-1", role: "developer",
        sessionId: "session-1", generation: 1, invocationId: "tool-rtk-check", toolId: "rtk", operation: "pipe", status: "started", observedAt: new Date().toISOString() }),
      onResult: async result => ledger.put({ schemaVersion: 3, runId: "run-1", taskId: "task-1", role: "developer", sessionId: "session-1", generation: 1,
        invocationId: "tool-rtk-check", toolId: "rtk", operation: "pipe", status: result.status, ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}), observedAt: new Date().toISOString() }) }),
      consume: async (invocationId: string, evidence: any) => {
        const previous = (await ledger.list()).find(item => item.invocationId === invocationId)!;
        await ledger.consume({ ...previous, evidenceReferences: [evidence], consumption: { status: "consumed", source: "host_context", evidenceReferences: [evidence] } });
      } };
    const development = new HostDevelopment(() => runtime, [f.command], integration);

    const feedback = await development.check(developerBinding, { runId: "run-1", taskId: "task-1" }) as any;

    expect(feedback.measurements[0]).toMatchObject({ failed: 1, outcome: { exitCode: 1 }, rtk: { status: "compressed", compressedOutput: expect.stringContaining("filtered:") } });
    expect(feedback.independentAcceptanceEvidence).toBe(false);
    expect((await ledger.list())[0]).toMatchObject({ status: "completed", consumption: { status: "consumed", source: "host_context" } });
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
  // Live regression (2026-10-28): a Vitest Red test that calls the still-absent export failed with a TypeError. node_tap
  // returns that as a bounded test repair; Vitest threw a plain error, so Runtime escalated the run as unrepairable.
  it("returns the same bounded test repair as node_tap for a Vitest Red that calls absent code", async () => {
    const f = await fixture("bugfix", "vitest_json");
    await writeFile(join(f.cwd, "test/behavior.test.cjs"), `const value=require('../source.cjs');it(${JSON.stringify(testName)},()=>value.multiply(2,3));\n`);
    f.commit("Red calls an absent export without an assertion");
    let failure: unknown;
    try { await f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(HostBehavioralFailure);
    if (!(failure instanceof HostBehavioralFailure)) throw failure;
    expect(failure.message).toContain("assertion");
    expect(() => assertReadyToImplement(f.strategy)).toThrow(/Red/);
    const chunks: Uint8Array[] = [];
    for await (const chunk of f.store.get(failure.evidence)) { if (!chunk.ok) throw new Error(chunk.error.message); chunks.push(chunk.value); }
    const observed = JSON.parse(Buffer.concat(chunks).toString());
    expect(observed.accepted).toBe(false);
    expect(observed.measurementFailure).toMatchObject({ protocol: "vitest_json", outcome: { exitCode: 1 } });
    expect(observed.measurementFailure.outcome.stdout).toContain("TypeError");
    // An unrelated exception beside an otherwise valid run is still a plain infrastructure block, never a repair.
    await writeFile(join(f.cwd, "test/behavior.test.cjs"), `afterAll(()=>{throw new Error('cleanup failed')}); ${vitestSource}`);
    f.commit("hook failure");
    await expect(f.host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" })).rejects.not.toBeInstanceOf(HostBehavioralFailure);
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
  it("attaches expected and observed names with a bounded stdout tail to identity mismatches", async () => {
    const f = await fixture();
    const error = await measureBehavior({ ...f.command, testNames: ["renamed behavior"] }, f.cwd, f.redRevision).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(BehavioralMeasurementError);
    expect(String(error)).toBe(`Error: Observed test names differ from owner-configured identities`);
    expect(error).toMatchObject({ diagnostics: { expectedNames: ["renamed behavior"], observedNames: [testName], stdoutTail: expect.stringContaining(`ok 1 - ${testName}`) } });
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

describe("behavioral measurement diagnostics", () => {
  const stdout = "TAP version 13\nok 1 - observed behavior\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  const outcome: QualityCommandOutcome = { executable: process.execPath, args: [], cwd: "/repo", exitCode: 0, signal: null, stdout, stderr: "",
    combinedOutput: stdout, durationMs: 1, timedOut: false, aborted: false, outputTruncated: false };
  it("keeps expected and observed identities with bounded raw output tails", () => {
    const command = { command: "owner:test-unit", testNames: ["expected behavior"] };
    let error: unknown;
    try { parseNodeTap(outcome, command.testNames); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(BehavioralIdentityMismatch);
    expect(measurementDiagnostics(command, outcome, error)).toEqual({ command: "owner:test-unit", cwd: "/repo", exitCode: 0, signal: null, timedOut: false,
      stdoutTail: stdout, stderrTail: "", expectedNames: ["expected behavior"], observedNames: ["observed behavior"] });
    const long = "x".repeat(10_000) + stdout;
    expect(measurementDiagnostics(command, { ...outcome, stdout: long, stderr: long }, error)).toMatchObject({
      stdoutTail: long.slice(-4096), stderrTail: long.slice(-4096) });
  });
});
