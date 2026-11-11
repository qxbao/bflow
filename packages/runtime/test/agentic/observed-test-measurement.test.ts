import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { QualityGateContextSchema, SpecificationSchema, TestStrategySchema } from "@bflow/contracts";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";
import { recordEvidence } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import type { RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { HostBehavioralFailure, HostVerification } from "../../src/agentic/host-verification.js";
import { TestRunnerSource } from "../../src/agentic/task-commands.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { cleanups, fixture } from "../helpers/behavioral-runner-fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("measures only owned tests committed in the task diff when four files were planned", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-observed-tests-")));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "commit.gpgSign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Bflow test");
  git("config", "user.email", "bflow@example.test");
  await write("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await write("test/first.test.cjs", "const {test}=require('node:test'); test('first behavior',()=>{});\n");
  await write("test/second.test.cjs", "const {test}=require('node:test'); test('second behavior',()=>{});\n");
  git("add", "."); git("commit", "-m", "two committed tests");
  const head = git("rev-parse", "HEAD");
  const assessed = assessment("domain_logic", { infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: "auto:unit", level: "unit" }] } });
  const specification = SpecificationSchema.parse({ ...spec(assessed, "unit_test"),
    affectedPaths: ["test/first.test.cjs", "test/second.test.cjs", "test/future.test.cjs", "test/later.test.cjs"] });
  const strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification),
    criterionMappings: [{ criterionId: "ac-1", testNames: ["first behavior", "second behavior"] }] });
  const profile: RunnerProfile = { id: "node-unit", command: "auto:unit", executable: process.execPath, args: ["--test", "--test-reporter=tap"],
    method: "unit_test", levels: ["unit"], reporter: "node_tap", timeoutMs: 30_000,
    checkoutDependencyRoots: [], dependencySource: root, definitionBlobs: { "package.json": git("rev-parse", `${base}:package.json`) }, source: "detected" };
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

  if (!result.ok) throw new Error(JSON.stringify(result.error));
  expect(result.value.status).toBe("passed");
  const execution = result.value.metadata?.hostExecution as { testBlobs: Record<string, string>; testNames: string[] };
  expect(Object.keys(execution.testBlobs).filter(path => path.startsWith("test/"))).toEqual(["test/first.test.cjs", "test/second.test.cjs"]);
  expect(execution.testBlobs).toHaveProperty("package.json");
  expect(execution.testNames).toEqual(["first behavior", "second behavior"]);
});

it("measures independent Red from committed diff tests without demanding future planned files", async () => {
  const f = await fixture();
  const assessed = assessment("bugfix", { infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: "auto:unit", level: "unit" }] } });
  const specification = SpecificationSchema.parse({ ...spec(assessed, "unit_test"), status: "approved", approvedBy: "architect", artifactRef: f.specification.artifactRef,
    affectedPaths: ["source.cjs", "test/behavior.test.cjs", "test/future.test.cjs", "test/later.test.cjs"] });
  const strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification),
    criterionMappings: [{ criterionId: "ac-1", testNames: [f.command.testNames[0]!] }] });
  const profile: RunnerProfile = { id: "node-unit", command: "auto:unit", executable: process.execPath,
    args: ["--test", "--test-reporter=tap"], method: "unit_test", levels: ["unit"], reporter: "node_tap",
    timeoutMs: 30_000, checkoutDependencyRoots: [], dependencySource: f.cwd, definitionBlobs: {}, source: "detected" };
  const runners = new TestRunnerSource([], f.cwd, async () => ({ status: "detected", profiles: [profile], notes: [] }));
  await runners.refresh();
  const runtime = { inspect: async (runId?: string) => runId ? { baseRevision: f.base,
    definition: { tasks: [{ id: "task-1", metadata: { ownedPaths: ["source.cjs", "test"] } }] },
    tasks: [{ taskId: "task-1", worktrees: [{ baseCommitHash: f.base }], spec: { specification, strategy } }] }
    : { outbound: [{ taskId: "task-1", message: { message_id: "assignment", type: "task.assignment", run_id: "run-1" },
      handle: f.implementationHandle }] }, ports: { policies: { recordEvidence } } } as unknown as AgenticWorkflowRuntime;
  const host = new HostVerification(() => runtime, () => f.store, undefined, runners);

  const red = await host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" });

  expect(red.result.status).toBe("failed");
  expect(red.result.metadata?.hostBehavioralMeasurements).toMatchObject([{ testNames: [f.command.testNames[0]],
    testBlobs: { "test/behavior.test.cjs": expect.any(String) } }]);
});

it("routes an uncovered required criterion to repairable Red evidence", async () => {
  const f = await fixture();
  const assessed = assessment("bugfix", { infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: "auto:unit", level: "unit" }] } });
  const draft = spec(assessed, "unit_test");
  const specification = SpecificationSchema.parse({ ...draft, status: "approved", approvedBy: "architect", artifactRef: f.specification.artifactRef,
    affectedPaths: ["source.cjs", "test/behavior.test.cjs", "test/future.test.cjs"],
    acceptanceCriteria: [...draft.acceptanceCriteria, { ...draft.acceptanceCriteria[0], id: "ac-2", description: "Future behavior" }] });
  const strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification), criterionMappings: [
    { criterionId: "ac-1", testNames: [f.command.testNames[0]!] }, { criterionId: "ac-2", testNames: ["future behavior"] }] });
  const profile: RunnerProfile = { id: "node-unit", command: "auto:unit", executable: process.execPath,
    args: ["--test", "--test-reporter=tap"], method: "unit_test", levels: ["unit"], reporter: "node_tap",
    timeoutMs: 30_000, checkoutDependencyRoots: [], dependencySource: f.cwd, definitionBlobs: {}, source: "detected" };
  const runners = new TestRunnerSource([], f.cwd, async () => ({ status: "detected", profiles: [profile], notes: [] }));
  await runners.refresh();
  const runtime = { inspect: async (runId?: string) => runId ? { baseRevision: f.base,
    definition: { tasks: [{ id: "task-1", metadata: { ownedPaths: ["source.cjs", "test"] } }] },
    tasks: [{ taskId: "task-1", worktrees: [{ baseCommitHash: f.base }], spec: { specification, strategy } }] }
    : { outbound: [{ taskId: "task-1", message: { message_id: "assignment", type: "task.assignment", run_id: "run-1" },
      handle: f.implementationHandle }] }, ports: { policies: { recordEvidence } } } as unknown as AgenticWorkflowRuntime;
  const host = new HostVerification(() => runtime, () => f.store, undefined, runners);

  const failure = await host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(HostBehavioralFailure);
  if (!(failure instanceof HostBehavioralFailure)) return;
  const chunks: Uint8Array[] = [];
  for await (const chunk of f.store.get(failure.evidence)) {
    if (!chunk.ok) throw new Error(chunk.error.message);
    chunks.push(chunk.value);
  }
  const artifact = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(artifact.findings).toContainEqual({ code: "criterion_without_test", criterionId: "ac-2", fixableBy: "developer" });
});
