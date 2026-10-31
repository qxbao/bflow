import { SpecificationSchema, TestStrategySchema } from "@bflow/contracts";
import { describe, expect, it } from "vitest";
import { VerificationEngine } from "../src/engine.js";
import { createVerificationPlan } from "../src/model.js";
import { FakeToolRunner, fixture, now } from "./fixtures.js";

describe("Slice 7 verification engine hardening", () => {
  it("never marks identical_integrated_tree-waived or optional criteria passed when workflow verification is inconclusive", async () => {
    const base = await fixture({
      scope: "workflow",
      reviewWaiver: {
        kind: "identical_integrated_tree",
        reason: "Single-task integrated tree matches verified task tree",
        taskVerificationIds: ["verify-task-1"],
        taskTree: "a".repeat(40),
        integratedTree: "a".repeat(40)
      }
    });

    const strategy = TestStrategySchema.parse({
      ...base.input.strategy,
      criterionMappings: [
        ...base.input.strategy.criterionMappings,
        { criterionId: "ac-manual-waived", testNames: ["manual-review-waived"] },
        { criterionId: "ac-optional", testNames: ["optional-smoke"] }
      ]
    });
    const specDoc = {
      ...base.specification,
      artifactRef: undefined,
      testStrategy: strategy,
      acceptanceCriteria: [
        ...base.specification.acceptanceCriteria,
        {
          id: "ac-manual-waived",
          description: "Manual review satisfied by identical verified task tree",
          category: "non_functional",
          verificationMethod: "manual_review",
          required: true,
          status: "pending",
          evidenceArtifactIds: []
        },
        {
          id: "ac-optional",
          description: "Optional telemetry check",
          category: "non_functional",
          verificationMethod: "integration_test",
          required: false,
          status: "pending",
          evidenceArtifactIds: []
        }
      ]
    };
    const artifactRef = await base.store.seed("spec-inconclusive-waiver", "document", specDoc);
    const specification = SpecificationSchema.parse({ ...specDoc, artifactRef });
    base.setSpecification(specification);

    const plan = createVerificationPlan({
      ...base.input,
      specification,
      strategy
    });

    // Force deterministic check to produce malformed observation -> status = "inconclusive"
    base.runners[0]!.mode = "malformed";

    const engine = new VerificationEngine(base.ports);
    const cycle = engine.start(plan, "cycle-inconclusive-waiver");
    const outcome = await engine.verify(plan, cycle, await base.change(), {
      integration: {
        headCommitHash: "1".repeat(40),
        integratedTaskIds: ["task-1"]
      }
    });

    expect(outcome.result.status).toBe("inconclusive");
    const waivedManual = outcome.result.evaluatedCriteria.find(c => c.criterionId === "ac-manual-waived");
    const optionalCrit = outcome.result.evaluatedCriteria.find(c => c.criterionId === "ac-optional");
    expect(waivedManual?.passed).toBe(false);
    expect(optionalCrit?.passed).toBe(false);
  });

  it("emits an error finding carrying checkId when a check fails hard even if its mapped criteria are optional", async () => {
    const base = await fixture({
      reviewWaiver: { kind: "deterministic_coverage", reason: "All required criteria are automated" }
    });

    const optCheck = {
      id: "opt-bench-check",
      name: "opt-bench-check",
      evaluator: "opt-bench-check",
      required: true,
      timeout: { executionTimeoutMs: 1000, onTimeout: "block" as const },
      configuration: {
        kind: "deterministic",
        method: "unit_test",
        command: "pnpm test:opt",
        criterionIds: ["ac-opt"],
        testNames: ["opt-bench"],
        role: "tester",
        levels: ["unit"]
      }
    };

    const strategy = TestStrategySchema.parse({
      ...base.input.strategy,
      targetCommands: [...base.input.strategy.targetCommands, "pnpm test:opt"],
      criterionMappings: [
        ...base.input.strategy.criterionMappings,
        { criterionId: "ac-opt", testNames: ["opt-bench"] }
      ]
    });
    const specDoc = {
      ...base.specification,
      artifactRef: undefined,
      testStrategy: strategy,
      acceptanceCriteria: [
        ...base.specification.acceptanceCriteria,
        {
          id: "ac-opt",
          description: "Optional benchmark criterion",
          category: "performance",
          verificationMethod: "unit_test",
          required: false,
          status: "pending",
          evidenceArtifactIds: []
        }
      ]
    };
    const artifactRef = await base.store.seed("spec-opt-fail", "document", specDoc);
    const specification = SpecificationSchema.parse({ ...specDoc, artifactRef });
    base.setSpecification(specification);

    const optRunner = new FakeToolRunner("opt-bench-check");
    optRunner.mode = "failed";

    const plan = createVerificationPlan({
      ...base.input,
      specification,
      strategy,
      checks: [...base.input.checks, optCheck]
    });

    const engine = new VerificationEngine({
      ...base.ports,
      gates: [...base.runners, optRunner],
      clock: () => now
    });
    const cycle = engine.start(plan, "cycle-opt-hard-fail");
    const outcome = await engine.verify(plan, cycle, await base.change());

    expect(outcome.result.status).toBe("failed");
    const errorWithCheckId = outcome.result.findings.find(
      finding =>
        finding.severity === "error" &&
        typeof finding.details === "object" &&
        finding.details !== null &&
        (finding.details as Record<string, unknown>).checkId === "opt-bench-check"
    );
    expect(errorWithCheckId).toBeDefined();
  });
});
