import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SpecificationSchema, WorkflowDefinitionSchema } from "@bflow/contracts";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { TestRunnerSource, resolveTaskCommands } from "../../src/agentic/task-commands.js";
import { WorkflowProposalRejected } from "../../src/agentic/workflow-rejection.js";
import type { RunnerDetection, RunnerProfile } from "../../src/agentic/behavioral-runner.js";

// Sanitized historical input; the profiles model binding only, never execution readiness/evidence.
const historical = JSON.parse(await readFile(new URL("./fixtures/runner-proposal.json", import.meta.url), "utf8"));
const spec = SpecificationSchema.parse(historical.specification);
const definition = WorkflowDefinitionSchema.parse(historical.definition);
const strategy = new TestStrategyResolver().resolve(spec);
function profiles(): RunnerProfile[] {
  return ([ ["unit", "unit_test"], ["integration", "integration_test"] ] as const).map(([level, method]) => ({
    id: `auto-${level}`, command: `auto:${level}`, method, levels: [level, "regression"], source: "detected",
    executable: process.execPath, args: ["node_modules/vitest/vitest.mjs", "run", "--reporter=json"], reporter: "vitest_json",
    timeoutMs: 180_000, prepare: { args: ["node_modules/typescript/bin/tsc", "-b"], timeoutMs: 120_000 },
    checkoutDependencyRoots: ["node_modules"], dependencySource: process.cwd()
  }));
}
async function verification(detection: RunnerDetection = { status: "detected", profiles: profiles(), notes: ["vitest 2.1.9"] }) {
  const source = new TestRunnerSource([], process.cwd(), async () => detection);
  await source.refresh();
  return new HostVerification(() => { throw new Error("no Runtime access in binding check"); }, () => { throw new Error("no artifact writes in binding check"); }, undefined, source);
}
function refusal(action: () => unknown) {
  let observed: unknown;
  try { action(); } catch (error) { observed = error; }
  expect(observed).toBeInstanceOf(WorkflowProposalRejected);
  return (observed as WorkflowProposalRejected).rejection;
}

describe("historical workflow proposal binding", () => {
  it("accepts all three original criterion mappings at specification scope and refuses their bundled 780s task", async () => {
    const host = await verification();
    expect(spec.acceptanceCriteria.map(c => c.id)).toEqual(["ac-1", "ac-2", "ac-3"]);
    expect(() => host.assertSupported(spec, strategy)).not.toThrow();
    const error = refusal(() => host.assertTaskSupported(spec, strategy, definition.tasks[0]!.metadata!.ownedPaths as string[]));
    expect(error.code).toBe("missing_test_mapping");
    expect(error.reason).toContain("independent execution deadline");
    expect(() => resolveTaskCommands({ owner: [], profiles: profiles(), specification: spec, strategy,
      ownedPaths: definition.tasks[0]!.metadata!.ownedPaths as string[] })).toThrow("independent execution deadline");
  });
  it("accepts the same criteria and verification methods split into dependency-ordered tasks", async () => {
    const base = definition.tasks[0]!;
    const split = WorkflowDefinitionSchema.parse({ ...definition, tasks: [
      { ...base, id: "unit", acceptanceCriteria: ["ac-1", "ac-3"] },
      { ...base, id: "integration", acceptanceCriteria: ["ac-2"] }
    ], dependencies: [{ taskId: "integration", dependsOnTaskId: "unit", condition: "succeeded" }] });
    const host = await verification();
    expect(() => host.assertSupported(spec, strategy, split)).not.toThrow();
  });
  it.each([
    ["unsupported setup", { status: "unsupported", agentFixable: true, reason: "Reporter unavailable", remediation: ["Reviewed repository setup"] }, "runner_setup_required"],
    ["no supported ecosystem", { status: "unsupported", reason: "No supported runner", remediation: [] }, "no_test_runner_detected"]
  ] as const)("fails closed for %s despite a claimed ready strategy", async (_label, detected, code) => {
    const host = await verification({ ...detected, remediation: [...detected.remediation] });
    expect(refusal(() => host.assertSupported(spec, strategy)).code).toBe(code);
  });
  it("rejects absent mapping, unknown command, and missing test scope with their exact reasons", async () => {
    const host = await verification();
    expect(refusal(() => host.assertSupported(spec, { ...strategy, criterionMappings: [] })).code).toBe("missing_test_mapping");
    expect(refusal(() => host.assertSupported(spec, { ...strategy, targetCommands: [...strategy.targetCommands, "unknown"] })).code).toBe("unknown_test_command");
    expect(refusal(() => host.assertSupported({ ...spec, affectedPaths: ["src/log.ts"] }, strategy)).code).toBe("missing_test_paths");
  });
  it("rejects malformed DAGs at the exported schema ingress", async () => {
    const host = await verification();
    expect(() => host.assertSupported(spec, strategy, { tasks: [] })).toThrow();
  });
  it("rejects partial criterion coverage in a monorepo task after both profiles bind globally", async () => {
    const unit = { ...profiles()[0]!, timeoutMs: 1000, prepare: undefined };
    const integration: RunnerProfile = { ...profiles()[1]!, timeoutMs: 1000, prepare: undefined, adapter: {
      adapterId: "node", version: "22", executable: process.execPath, projectDirectory: "integration", format: "node_tap",
      nameRule: "test title", mounts: [], environment: {}, protectedPaths: [], bind: ({ testPaths }) => ({ args: ["--test", ...testPaths] })
    } };
    const scoped = SpecificationSchema.parse({ ...spec, affectedPaths: ["unit/log.test.ts", "integration/log.test.ts"] });
    const host = await verification({ status: "detected", profiles: [unit, integration], notes: [] });
    expect(() => host.assertSupported(scoped, strategy)).not.toThrow();
    expect(() => host.assertTaskSupported(scoped, strategy, ["unit/log.test.ts"])).toThrow(WorkflowProposalRejected);
    const error = refusal(() => host.assertTaskSupported(scoped, strategy, ["unit/log.test.ts"]));
    expect(error.code).toBe("missing_test_mapping");
    expect(error.reason).toContain("ac-2");
    expect(error.reason).toContain("owned paths");
  });
});
