import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SpecificationSchema, TestStrategySchema, type Specification, type TestStrategy } from "@bflow/contracts";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import { parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { TestRunnerSource, describeTestRunners, resolveTaskCommands } from "../../src/agentic/task-commands.js";
import { detectTestRunners } from "../../src/agentic/runner-detection.js";
import { WorkflowProposalRejected, reportsToUser } from "../../src/agentic/workflow-rejection.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";

/** Zero user configuration: no `.bflow/verification.json`, no owner commands. Runtime detects the runner itself. */
const TEST_NAME = "ac-1: Target behavior matches expected output";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function repository(files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "auto-runner-")));
  roots.push(root);
  await write(root, files);
  return root;
}
async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}
/** A repository with vitest 2.x declared and installed at the root (installed files are fakes; detection reads manifests only). */
const vitestRepository = {
  "package.json": JSON.stringify({ devDependencies: { vitest: "^2.1.8" } }),
  "node_modules/vitest/package.json": '{"version":"2.1.9"}',
  "node_modules/vitest/vitest.mjs": ""
};

/** An accepted-looking specification whose automated criteria use `auto:unit` (or `auto:integration`) with mapped names. */
function proposal(affectedPaths: string[], method: "unit_test" | "integration_test" = "unit_test"): { specification: Specification; strategy: TestStrategy } {
  const label = method === "unit_test" ? "auto:unit" : "auto:integration";
  const assessed = assessment("domain_logic", { infrastructure: { readiness: "ready", commands: [{ method, command: label, level: method === "unit_test" ? "unit" : "integration" }] } });
  const specification = SpecificationSchema.parse({ ...spec(assessed, method), affectedPaths });
  const strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification),
    criterionMappings: [{ criterionId: "ac-1", testNames: [TEST_NAME] }] });
  return { specification, strategy };
}

function verificationWith(runners: TestRunnerSource): HostVerification {
  return new HostVerification(() => ({} as AgenticWorkflowRuntime), () => { throw new Error("artifact store is not used"); }, undefined, runners);
}
function rejectionOf(check: () => void): WorkflowProposalRejected {
  try { check(); } catch (error) {
    if (error instanceof WorkflowProposalRejected) return error;
    throw error;
  }
  throw new Error("expected a structured rejection");
}

describe("role prompts for automatic runners", () => {
  it("tells the Coordinator and Developer the automatic labels, test-file listing and exact naming rules", async () => {
    const coordinator = await readFile(fileURLToPath(new URL("../../../../agents/coordinator/system-prompt.md", import.meta.url)), "utf8");
    const developer = await readFile(fileURLToPath(new URL("../../../../agents/developer/system-prompt.md", import.meta.url)), "utf8");
    expect(coordinator).toMatch(/auto:unit/);
    expect(coordinator).toMatch(/auto:integration/);
    expect(coordinator).toMatch(/testRunners/);
    expect(coordinator).toMatch(/missing_test_paths/);
    expect(coordinator).toMatch(/no_test_runner_detected/);
    expect(coordinator).toMatch(/never change|Never change/);
    expect(developer).toMatch(/affectedPaths/);
    expect(developer).toMatch(/exactly as its criterion mapping|exact names/i);
  });
});

describe("automatic test runner proposals (no owner configuration)", () => {
  it("accepts unit_test criteria on a detected runner with no owner commands and no user notice", async () => {
    const root = await repository(vitestRepository);
    const runners = new TestRunnerSource([], root);
    await runners.refresh();
    expect(runners.current).toMatchObject({ status: "detected" });
    const { specification, strategy } = proposal(["packages/example/src/logic.ts", "packages/example/test/logic.test.ts"]);
    expect(strategy.targetCommands).toEqual(["auto:unit"]);
    const verification = verificationWith(runners);
    expect(() => verification.assertSupported(specification, strategy)).not.toThrow();
    expect(verification.configuredMethods()).toEqual(["unit_test", "integration_test"]);
  });

  it("refuses a proposal whose affectedPaths lack test files with a Coordinator-fixable code that is never reported to the user", async () => {
    const root = await repository(vitestRepository);
    const runners = new TestRunnerSource([], root);
    await runners.refresh();
    const { specification, strategy } = proposal(["packages/example/src/logic.ts"]);
    const rejection = rejectionOf(() => verificationWith(runners).assertSupported(specification, strategy)).rejection;
    expect(rejection).toMatchObject({ code: "missing_test_paths" });
    expect(rejection.reason).toContain("affectedPaths");
    expect(reportsToUser(rejection)).toBe(false);
  });

  it("refuses a missing test-name mapping as a Coordinator-fixable rejection", async () => {
    const root = await repository(vitestRepository);
    const runners = new TestRunnerSource([], root);
    await runners.refresh();
    const { specification, strategy } = proposal(["packages/example/test/logic.test.ts"]);
    const unmapped = { ...strategy, criterionMappings: [] };
    const rejection = rejectionOf(() => verificationWith(runners).assertSupported(specification, unmapped)).rejection;
    expect(rejection).toMatchObject({ code: "missing_test_mapping" });
    expect(reportsToUser(rejection)).toBe(false);
  });

  it("reports an unsupported repository as no_test_runner_detected with two informational options and no manual configuration", async () => {
    const root = await repository({ "package.json": JSON.stringify({ scripts: { test: "echo ok" } }), "node_modules/.keep": "" });
    const runners = new TestRunnerSource([], root);
    await runners.refresh();
    expect(runners.current).toMatchObject({ status: "unsupported" });
    const { specification, strategy } = proposal(["packages/example/test/logic.test.ts"]);
    const rejection = rejectionOf(() => verificationWith(runners).assertSupported(specification, strategy)).rejection;
    expect(rejection).toMatchObject({ code: "no_test_runner_detected" });
    expect(reportsToUser(rejection)).toBe(true);
    expect(rejection.options).toEqual(["Coordinator thêm task thiết lập test runner (vitest) rồi đề xuất lại workflow", "Hủy run"]);
    expect(JSON.stringify(rejection)).not.toContain("verification.json");
  });

  it("re-detects an unsupported runner on the next refresh, so installed dependencies apply without a restart", async () => {
    const root = await repository({ "package.json": JSON.stringify({ devDependencies: { vitest: "^2.1.8" } }) });
    const runners = new TestRunnerSource([], root);
    await runners.refresh();
    expect(runners.current).toMatchObject({ status: "unsupported" });
    const { specification, strategy } = proposal(["packages/example/test/logic.test.ts"]);
    const verification = verificationWith(runners);
    expect(rejectionOf(() => verification.assertSupported(specification, strategy)).rejection).toMatchObject({ code: "no_test_runner_detected" });

    await write(root, { "node_modules/vitest/package.json": '{"version":"2.1.9"}', "node_modules/vitest/vitest.mjs": "" });
    await runners.refresh();
    expect(runners.current).toMatchObject({ status: "detected" });
    expect(() => verification.assertSupported(specification, strategy)).not.toThrow();
  });

  it("does not re-detect once detection succeeded", async () => {
    const root = await repository(vitestRepository);
    let calls = 0;
    const runners = new TestRunnerSource([], root, async path => { calls += 1; return detectTestRunners(path); });
    await runners.refresh();
    await runners.refresh();
    expect(calls).toBe(1);
  });

  it("binds profile names and test files per task and filters by ownership; owner commands stay unchanged", async () => {
    const root = await repository(vitestRepository);
    const runners = new TestRunnerSource([], root);
    await runners.refresh();
    const { specification, strategy } = proposal(["packages/example/src/logic.ts", "packages/example/test/logic.test.ts", "packages/other/test/other.test.ts"]);
    const [bound] = resolveTaskCommands({ owner: [], profiles: runners.profiles, strategy, specification });
    expect(bound).toMatchObject({ command: "auto:unit", method: "unit_test", reporter: "vitest_json",
      testNames: [TEST_NAME], testPaths: ["packages/example/test/logic.test.ts", "packages/other/test/other.test.ts"] });
    expect(bound!.args.slice(-2)).toEqual(["packages/example/test/logic.test.ts", "packages/other/test/other.test.ts"]);

    const [owned] = resolveTaskCommands({ owner: [], profiles: runners.profiles, strategy, specification, ownedPaths: ["packages/example"] });
    expect(owned!.testPaths).toEqual(["packages/example/test/logic.test.ts"]);
    expect(resolveTaskCommands({ owner: [], profiles: runners.profiles, strategy, specification, ownedPaths: ["packages/none"] })).toEqual([]);

    const owner = parseBehavioralCommands([{ id: "unit", command: "owner:test-unit", executable: process.execPath, args: ["--test"], method: "unit_test",
      levels: ["unit"], testNames: [TEST_NAME], testPaths: ["test/a.test.cjs"], timeoutMs: 1000 }]);
    const ownerStrategy = { ...strategy, targetCommands: ["owner:test-unit"] };
    expect(resolveTaskCommands({ owner, profiles: runners.profiles, strategy: ownerStrategy, specification })).toEqual(owner);
  });

  it("binds a dependency-free node --test profile whose checkout has no dependency roots", async () => {
    const root = await repository({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "test/a.test.cjs": "" });
    const runners = new TestRunnerSource([], root);
    await runners.refresh();
    const { specification, strategy } = proposal(["test/a.test.cjs"]);
    const [bound] = resolveTaskCommands({ owner: [], profiles: runners.profiles, strategy, specification });
    expect(bound).toMatchObject({ reporter: "node_tap", checkoutDependencyRoots: [], testPaths: ["test/a.test.cjs"], testNames: [TEST_NAME] });
  });

  it("describes the detected runner for Coordinator planning with its naming rules", async () => {
    const root = await repository(vitestRepository);
    const runners = new TestRunnerSource([], root);
    await runners.refresh();
    const planning = describeTestRunners(runners);
    expect(planning.testRunners).toEqual([expect.objectContaining({ command: "auto:unit", method: "unit_test", source: "detected" }),
      expect.objectContaining({ command: "auto:integration", method: "integration_test", source: "detected" })]);
    expect(planning.testRunners[0]).toMatchObject({ testNameRule: expect.stringContaining("single space") });
    expect(planning.testRunnerDetection).toMatchObject({ status: "detected" });
  });
});
