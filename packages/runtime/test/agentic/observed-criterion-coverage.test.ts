import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { QualityGateContextSchema, SpecificationSchema, TestStrategySchema } from "@bflow/contracts";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import type { RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { TestRunnerSource } from "../../src/agentic/task-commands.js";
import { parseVitestJson } from "../../src/agentic/vitest-json.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { cleanups, fixture } from "../helpers/behavioral-runner-fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("retains a real Vitest leaf when another mapped automatic name was only planned", async () => {
  const stdout = await readFile(fileURLToPath(new URL("./fixtures/vitest-2-filtered.json", import.meta.url)), "utf8");
  const outcome: QualityCommandOutcome = { executable: "/usr/bin/node", args: [], cwd: "/fixture", exitCode: 0,
    signal: null, stdout, stderr: "BFLOW_VITEST_RUNTIME_ERRORS=0\n", combinedOutput: stdout, durationMs: 1,
    timedOut: false, aborted: false, outputTruncated: false };

  expect(parseVitestJson(outcome, ["suite target", "suite future"], true, true).testNames).toEqual(["suite target"]);
  expect(() => parseVitestJson(outcome, ["suite target", "suite future"], true)).toThrow();
});

it("returns a criterion finding when a task commit contains no changed test", async () => {
  const f = await fixture();
  const assessed = assessment("bugfix", { infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: "auto:unit", level: "unit" }] } });
  const specification = SpecificationSchema.parse({ ...spec(assessed, "unit_test"), status: "approved",
    approvedBy: "architect", artifactRef: f.specification.artifactRef, affectedPaths: ["source.cjs", "test/future.test.cjs"] });
  const strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification),
    criterionMappings: [{ criterionId: "ac-1", testNames: ["future behavior"] }] });
  const profile: RunnerProfile = { id: "node-unit", command: "auto:unit", executable: process.execPath, args: ["--test", "--test-reporter=tap"],
    method: "unit_test", levels: ["unit"], reporter: "node_tap", timeoutMs: 30_000, checkoutDependencyRoots: [],
    dependencySource: f.cwd, definitionBlobs: {}, source: "detected" };
  const runners = new TestRunnerSource([], f.cwd, async () => ({ status: "detected", profiles: [profile], notes: [] }));
  await runners.refresh();
  const run = { baseRevision: f.redRevision, definition: { tasks: [{ id: "task", metadata: { ownedPaths: ["test"] } }] },
    tasks: [{ taskId: "task", worktrees: [{ baseCommitHash: f.redRevision }], spec: { specification, strategy } }] };
  const host = new HostVerification(() => ({ inspect: async () => run } as unknown as AgenticWorkflowRuntime),
    () => { throw new Error("No artifact access expected"); }, undefined, runners);
  const definition = host.behavioralChecks(specification, strategy).find(check => check.id === "host-behavioral-node-unit")!;
  const context = QualityGateContextSchema.parse({ runId: "run", taskId: "task", attemptId: "attempt", definition, artifacts: [],
    input: { sourceRevision: f.redRevision, baseRevision: f.redRevision, sourceWorktreePath: f.cwd,
      specFingerprint: "a".repeat(64), scope: "task" } });

  const result = await host.behavioralGates().find(gate => gate.id === definition.id)!.evaluate(context);

  expect(result).toMatchObject({ ok: true, value: { status: "failed", findings: [
    { code: "criterion_without_test", details: { criterionId: "ac-1", fixableBy: "developer" } }] } });
});

it("fails the host gate with a developer finding when a required criterion has no executed test", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-criterion-coverage-")));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "commit.gpgSign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  const write = async (path: string, content: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); };
  git("init", "-b", "main"); git("config", "user.name", "Bflow test"); git("config", "user.email", "bflow@example.test");
  await write("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await write("test/first.test.cjs", "const {test}=require('node:test'); test('first behavior',()=>{});\n");
  git("add", "."); git("commit", "-m", "one test");
  const head = git("rev-parse", "HEAD");
  const assessed = assessment("domain_logic", { infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: "auto:unit", level: "unit" }] } });
  const original = spec(assessed, "unit_test");
  const specification = SpecificationSchema.parse({ ...original,
    affectedPaths: ["test/first.test.cjs", "test/future.test.cjs"],
    acceptanceCriteria: [...original.acceptanceCriteria, { ...original.acceptanceCriteria[0], id: "ac-2", description: "Future behavior" }] });
  const strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification), criterionMappings: [
    { criterionId: "ac-1", testNames: ["first behavior"] }, { criterionId: "ac-2", testNames: ["future behavior"] }] });
  const profile: RunnerProfile = { id: "node-unit", command: "auto:unit", executable: process.execPath, args: ["--test", "--test-reporter=tap"],
    method: "unit_test", levels: ["unit"], reporter: "node_tap", timeoutMs: 30_000, checkoutDependencyRoots: [],
    dependencySource: root, definitionBlobs: { "package.json": git("rev-parse", `${base}:package.json`) }, source: "detected" };
  const runners = new TestRunnerSource([], root, async () => ({ status: "detected", profiles: [profile], notes: [] }));
  await runners.refresh();
  const run = { baseRevision: base, definition: { tasks: [{ id: "task", metadata: { ownedPaths: ["test"] } }] },
    tasks: [{ taskId: "task", worktrees: [{ baseCommitHash: base }], spec: { specification, strategy } }] };
  const host = new HostVerification(() => ({ inspect: async () => run } as unknown as AgenticWorkflowRuntime),
    () => { throw new Error("No artifact access expected"); }, undefined, runners);
  const definition = host.behavioralChecks(specification, strategy).find(check => check.id === "host-behavioral-node-unit")!;
  const context = QualityGateContextSchema.parse({ runId: "run", taskId: "task", attemptId: "attempt", definition, artifacts: [],
    input: { sourceRevision: head, baseRevision: base, sourceWorktreePath: root, specFingerprint: "a".repeat(64), scope: "task" } });

  const result = await host.behavioralGates().find(gate => gate.id === definition.id)!.evaluate(context);

  expect(result).toMatchObject({ ok: true, value: { status: "failed", findings: [
    { code: "criterion_without_test", details: { criterionId: "ac-2", fixableBy: "developer" } }] } });
});
