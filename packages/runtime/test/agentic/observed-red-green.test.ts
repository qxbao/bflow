import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SpecificationSchema, TestStrategySchema } from "@bflow/contracts";
import { TestStrategyResolver, recordEvidence } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import type { RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { TestRunnerSource } from "../../src/agentic/task-commands.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { cleanups, fixture, testSource } from "../helpers/behavioral-runner-fixture.js";

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function automaticTddFixture() {
  const f = await fixture();
  const assessed = assessment("bugfix", { infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: "auto:unit", level: "unit" }] } });
  const specification = SpecificationSchema.parse({ ...spec(assessed, "unit_test"), status: "approved", approvedBy: "architect", artifactRef: f.specification.artifactRef,
    affectedPaths: ["source.cjs", "test/behavior.test.cjs"] });
  let strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification),
    criterionMappings: [{ criterionId: "ac-1", testNames: [f.command.testNames[0]!] }] });
  const profile: RunnerProfile = { id: "node-unit", command: "auto:unit", executable: process.execPath, args: ["--test", "--test-reporter=tap"],
    method: "unit_test", levels: ["unit"], reporter: "node_tap", timeoutMs: 30_000, checkoutDependencyRoots: [], dependencySource: f.cwd, definitionBlobs: {}, source: "detected" };
  const runners = new TestRunnerSource([], f.cwd, async () => ({ status: "detected", profiles: [profile], notes: [] }));
  await runners.refresh();
  const runtime = { inspect: async (runId?: string) => runId ? { baseRevision: f.base,
    definition: { tasks: [{ id: "task-1", metadata: { ownedPaths: ["source.cjs", "test", "extra.test.cjs"] } }] },
    tasks: [{ taskId: "task-1", worktrees: [{ baseCommitHash: f.base }], spec: { specification, strategy } }] }
    : { outbound: [{ taskId: "task-1", message: { message_id: "assignment", type: "task.assignment", run_id: "run-1" }, handle: f.implementationHandle }] },
    ports: { policies: { recordEvidence } } } as unknown as AgenticWorkflowRuntime;
  const host = new HostVerification(() => runtime, () => f.store, undefined, runners);
  return { f, host, accept: (result: unknown) => { strategy = recordEvidence(strategy, result); } };
}

// Files under test/ are runner definitions by design (runner-provenance), so the supplemental test lives outside that directory.
it("keeps Green on the Red-measured tests when a supplemental test is added after Red", async () => {
  const { f, host, accept } = await automaticTddFixture();
  const red = await host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" });
  expect(red.result.status).toBe("failed");
  accept(red.result);
  await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2;\n");
  await writeFile(join(f.cwd, "extra.test.cjs"), "const {test}=require('node:test'); test('extra supplemental',()=>{});\n");
  f.commit("fix behavior and add a supplemental test");

  const green = await host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "green" });

  expect(green.result.status).toBe("passed");
  expect(green.result.metadata?.hostBehavioralMeasurements).toMatchObject([{ testNames: [f.command.testNames[0]],
    testBlobs: { "test/behavior.test.cjs": expect.any(String) } }]);
}, 120_000);

it("still rejects Green when a Red test file was changed after Red", async () => {
  const { f, host, accept } = await automaticTddFixture();
  accept((await host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "red" })).result);
  await writeFile(join(f.cwd, "source.cjs"), "module.exports=x=>x*2;\n");
  await writeFile(join(f.cwd, "test/behavior.test.cjs"), testSource + "// A changed Red test is forbidden even if its name remains.\n");
  f.commit("replace the Red test");

  await expect(host.behavioralEvidence(f.binding, { runId: "run-1", taskId: "task-1", phase: "green" })).rejects.toThrow("exact committed Red test files");
}, 120_000);
