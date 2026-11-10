import { expect, it } from "vitest";
import { SpecificationSchema, TestStrategySchema } from "@bflow/contracts";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import type { RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { plannedRunnerCommands } from "../../src/agentic/task-commands.js";

const profile: RunnerProfile = { id: "node-unit", command: "auto:unit", executable: process.execPath, args: ["--test"], method: "unit_test",
  levels: ["unit"], reporter: "node_tap", timeoutMs: 30_000, checkoutDependencyRoots: [], dependencySource: "/repo", definitionBlobs: {}, source: "detected" };
const plan = (affectedPaths: string[], targetCommand = "auto:unit") => {
  const assessed = assessment("bugfix", { infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: targetCommand, level: "unit" }] } });
  const specification = SpecificationSchema.parse({ ...spec(assessed, "unit_test"), affectedPaths });
  const strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification), criterionMappings: [{ criterionId: "ac-1", testNames: ["adds"] }] });
  return { specification, strategy };
};

it("needs only a selected runner when the plan names a test directory and no test file", () => {
  const { specification, strategy } = plan(["src/math.ts", "test"]);
  expect(plannedRunnerCommands({ owner: [], profiles: [profile], specification, strategy, ownedPaths: ["src", "test"] })).toHaveLength(1);
});

it("is still unready for a directory-only plan when no profile matches the strategy's target command", () => {
  const { specification, strategy } = plan(["src/math.ts", "test"]);
  expect(plannedRunnerCommands({ owner: [], profiles: [{ ...profile, command: "auto:other" }], specification, strategy, ownedPaths: ["src", "test"] })).toHaveLength(0);
});

it("binds a plan that names a literal test file through the normal resolver", () => {
  const { specification, strategy } = plan(["src/math.ts", "test/math.test.cjs"]);
  expect(plannedRunnerCommands({ owner: [], profiles: [profile], specification, strategy, ownedPaths: ["src", "test"] })).toMatchObject([{ command: "auto:unit", testPaths: ["test/math.test.cjs"] }]);
});

it("keeps the resolver's blocker for a plan with no test path at all", () => {
  const { specification, strategy } = plan(["src/math.ts"]);
  expect(() => plannedRunnerCommands({ owner: [], profiles: [profile], specification, strategy, ownedPaths: ["src", "test"] })).toThrow(/runner_identity_unselectable/);
});
