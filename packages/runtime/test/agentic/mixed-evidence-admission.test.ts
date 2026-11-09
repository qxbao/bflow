import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpecificationSchema, TestStrategySchema, WorkflowDefinitionSchema, type Specification, type TestStrategy, type WorkflowDefinition } from "@bflow/contracts";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";
import { assessment } from "../../../test-strategy/test/fixtures.js";
import { HostVerification, defaultHostChecks } from "../../src/agentic/host-verification.js";
import { projectTaskSpecificationInput, taskPolicyAssessment } from "../../src/agentic/task-projection.js";
import { TestRunnerSource } from "../../src/agentic/task-commands.js";
import { AGENT_FIXABLE_REJECTIONS, WorkflowProposalRejected, WorkflowRejectionCodeSchema, reportsToUser } from "../../src/agentic/workflow-rejection.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const NAME = "ac-1: Target behavior matches expected output";
const now = "2026-11-09T01:00:00Z";

async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mixed-admission-")));
  roots.push(root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ devDependencies: { vitest: "^2.1.8" } }),
    "node_modules/vitest/package.json": '{"version":"2.1.9"}', "node_modules/vitest/vitest.mjs": "",
    "docs/testing.md": "# testing\n"
  };
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}
const criterion = (id: string, method: string, description = `${id}: Target behavior matches expected output`) =>
  ({ id, description, category: "functional", verificationMethod: method, required: true, status: "pending", evidenceArtifactIds: [] });
const retry = { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false };
function task(id: string, criteria: string[], ownedPaths: string[]) {
  return { id, title: id, role: "developer", instruction: id, acceptanceCriteria: criteria, retry, timeout: { executionTimeoutMs: 1000, onTimeout: "block" },
    requiresApproval: false, qualityGates: [], metadata: { ownedPaths } };
}
function definition(tasks: ReturnType<typeof task>[]): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({ schemaVersion: "1", id: "def", name: "mixed", version: "1.0.0", tasks, dependencies: [], qualityGates: [], maxConcurrency: 1, failurePolicy: "block",
    recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" } });
}
/** Mixed workflow: ac-1 is behavioral code work, ac-2 is a manual review of documentation. */
function proposal(): { specification: Specification; strategy: TestStrategy } {
  const assessed = assessment("domain_logic", { infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: "auto:unit", level: "unit" }] } });
  const specification = SpecificationSchema.parse({ schemaVersion: 2, specId: "spec-mixed", runId: "run-1", sessionId: "s", level: "lightweight",
    title: "Mixed", summary: "Code and docs", problemStatement: "p", scope: { inScope: ["x"], outOfScope: [] },
    acceptanceCriteria: [criterion("ac-1", "unit_test"), criterion("ac-2", "manual_review", "ac-2: Testing guide explains the shards")],
    affectedPaths: ["packages/example/src/logic.ts", "packages/example/test", "docs/testing.md"], status: "draft", createdBy: "architect",
    createdAt: now, updatedAt: now, metadata: { conditionalTdd: assessed } });
  const strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification), criterionMappings: [{ criterionId: "ac-1", testNames: [NAME] }] });
  return { specification, strategy };
}
async function host(): Promise<HostVerification> {
  const runners = new TestRunnerSource([], await repository());
  await runners.refresh();
  return new HostVerification(() => ({}) as AgenticWorkflowRuntime, () => { throw new Error("unused"); }, undefined, runners, undefined, undefined, [], { suites: [] }, defaultHostChecks());
}
function rejection(action: () => unknown): WorkflowProposalRejected {
  try { action(); } catch (error) { if (error instanceof WorkflowProposalRejected) return error; throw error; }
  throw new Error("expected a structured rejection");
}
const resolver = new TestStrategyResolver();
const resolve = (spec: Specification) => resolver.resolve(spec);
const split = () => definition([task("task-code", ["ac-1"], ["packages/example"]), task("task-docs", ["ac-2"], ["docs/testing.md"])]);

describe("task-scoped workflow admission (B2)", () => {
  it("admits a mixed specification when manual review and behavioral criteria sit in separate tasks", async () => {
    const { specification, strategy } = proposal(), h = await host();
    expect(() => h.assertWorkflowSupported(specification, strategy, split(), resolve)).not.toThrow();
  });
  it("rejects a task mixing manual and behavioral criteria with a Coordinator-fixable code naming the task and criteria", async () => {
    const { specification, strategy } = proposal(), h = await host();
    const failure = rejection(() => h.assertWorkflowSupported(specification, strategy, definition([task("task-all", ["ac-1", "ac-2"], ["packages/example", "docs/testing.md"])]), resolve));
    expect(failure.rejection.code).toBe("task_evidence_mixed");
    expect(failure.rejection.reason).toContain("task-all");
    expect(failure.rejection.criteria).toEqual(expect.arrayContaining(["ac-1", "ac-2"]));
    expect(reportsToUser(failure.rejection)).toBe(false);
  });
  it("rejects a required criterion owned by no task", async () => {
    const { specification, strategy } = proposal(), h = await host();
    const failure = rejection(() => h.assertWorkflowSupported(specification, strategy, definition([task("task-code", ["ac-1"], ["packages/example"])]), resolve));
    expect(failure.rejection.code).toBe("invalid_specification");
    expect(failure.rejection.criteria).toEqual(["ac-2"]);
  });
  it("keeps the whole-specification check without a definition, but as a structured rejection", async () => {
    const { specification, strategy } = proposal(), h = await host();
    expect(rejection(() => h.assertSupported(specification, strategy)).rejection.code).toBe("task_evidence_mixed");
  });
});

describe("task projection (B3) and per-task policy (B4)", () => {
  it("narrows the projected affectedPaths to the task's owned paths", () => {
    const { specification } = proposal();
    const projected = projectTaskSpecificationInput(specification, "task-docs", [specification.acceptanceCriteria[1]!], "docs", undefined, ["docs/testing.md"]);
    expect(projected.affectedPaths).toEqual(["docs/testing.md"]);
    expect(projectTaskSpecificationInput(specification, "task-code", [specification.acceptanceCriteria[0]!], "code").affectedPaths).toEqual(specification.affectedPaths);
  });
  it("does not assign code-surface verification methods to a documentation-only task", () => {
    const infra = assessment("infrastructure");
    const docs = taskPolicyAssessment(infra, ["docs/testing.md"]);
    expect(docs.taskType).toBe("documentation");
    expect(docs.changeImpact.behaviorChanged).toBe(false);
    expect(taskPolicyAssessment(infra, ["pom.xml", "docs/testing.md"])).toEqual(infra);
  });
  it("reports task_policy_gap when a task weakens the assessment so the union of task methods misses a required method", async () => {
    const { specification, strategy } = proposal(), h = await host();
    const unit = [{ method: "unit_test", command: "auto:unit", level: "unit" }];
    const risky = SpecificationSchema.parse({ ...specification, metadata: { conditionalTdd: assessment("domain_logic", { riskClassification: "high", infrastructure: { readiness: "ready", commands: unit } }) } });
    const riskyStrategy = TestStrategySchema.parse({ ...resolve(risky), criterionMappings: [{ criterionId: "ac-1", testNames: [NAME] }] });
    const weak = { ...task("task-code", ["ac-1"], ["packages/example"]), metadata: { ownedPaths: ["packages/example"], conditionalTdd: assessment("domain_logic", { infrastructure: { readiness: "ready", commands: unit } }) } };
    const failure = rejection(() => h.assertWorkflowSupported(risky, riskyStrategy, definition([weak, task("task-docs", ["ac-2"], ["docs/testing.md"])]), resolve));
    expect(failure.rejection.code).toBe("task_policy_gap");
    expect(reportsToUser(failure.rejection)).toBe(false);
  });
});

describe("rejection codes (D5)", () => {
  it("adds three Coordinator-fixable codes", () => {
    for (const code of ["task_evidence_mixed", "task_policy_gap", "static_analyzer_missing"] as const) {
      expect(WorkflowRejectionCodeSchema.parse(code)).toBe(code);
      expect(AGENT_FIXABLE_REJECTIONS).toContain(code);
    }
  });
});
