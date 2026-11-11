import { describe, expect, it } from "vitest";
import type { Specification, TestStrategy } from "@bflow/contracts";
import type { RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { resolveTaskCommands } from "../../src/agentic/task-commands.js";

const profile: RunnerProfile = {
  id: "node-unit",
  command: "auto:unit",
  executable: "/usr/bin/node",
  args: ["--test"],
  method: "unit_test",
  levels: ["unit"],
  reporter: "node_tap",
  timeoutMs: 30_000,
  checkoutDependencyRoots: [],
  dependencySource: "/tmp",
  source: "detected"
};
const declared = ["test/first.test.cjs", "test/second.test.cjs", "test/future.test.cjs", "test/later.test.cjs"];
const specification = {
  affectedPaths: declared,
  acceptanceCriteria: [{ id: "ac-1", required: true, status: "pending", verificationMethod: "unit_test" }]
} as unknown as Specification;
const strategy = {
  targetCommands: ["auto:unit"],
  criterionMappings: [{ criterionId: "ac-1", testNames: ["first behavior", "second behavior"] }]
} as unknown as TestStrategy;

describe("committed task diff test selection", () => {
  it("binds changed tests inside ownership even when the plan omitted one, and reports declared files not observed", () => {
    const selection = resolveTaskCommands({ owner: [], profiles: [profile], specification, strategy,
      ownedPaths: ["test"],
      changedPaths: ["test/first.test.cjs", "test/second.test.cjs", "test/extra.test.cjs", "test/extra.test.cjs",
        "outside/foreign.test.cjs", "test/helper.txt", "test/../escape.test.cjs"] });

    expect(selection).toMatchObject({
      commands: [{ command: "auto:unit", testPaths: ["test/first.test.cjs", "test/second.test.cjs", "test/extra.test.cjs"] }],
      coverageGaps: ["test/future.test.cjs", "test/later.test.cjs"]
    });
  });

  it("chooses the runner whose project contains an owned changed test", () => {
    const inProject = (projectDirectory: string): RunnerProfile => ({
      ...profile,
      id: `unit-${projectDirectory.replaceAll("/", "-")}`,
      adapter: {
        adapterId: "node", version: "22", executable: "/usr/bin/node", projectDirectory,
        format: "node_tap", nameRule: "test title", mounts: [], environment: {}, protectedPaths: [],
        bind: () => ({ args: [] })
      }
    });
    const selected = resolveTaskCommands({
      owner: [], profiles: [inProject("packages/a"), inProject("packages/b")], specification, strategy,
      ownedPaths: ["packages/a"],
      changedPaths: ["packages/a/test/a.test.cjs", "packages/b/test/b.test.cjs"]
    });

    expect(selected.commands).toMatchObject([{ id: "unit-packages-a", testPaths: ["packages/a/test/a.test.cjs"] }]);
  });
});
