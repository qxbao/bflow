import { describe, expect, it } from "vitest";
import { VerificationEngine } from "../src/engine.js";
import { createVerificationPlan } from "../src/model.js";
import { fixture } from "./fixtures.js";

describe("reviewWaiver verification planning", () => {
  it("rejects plan without review check and without waiver", async () => {
    const f = await fixture();
    expect(() => createVerificationPlan({ ...f.input, checks: f.input.checks.slice(0, 2) })).toThrow(
      "An independent Reviewer or QA check is required"
    );
  });

  it("accepts deterministic_coverage waiver when every required criterion is automated and covered", async () => {
    const f = await fixture({
      reviewWaiver: { kind: "deterministic_coverage", reason: "All required criteria are automated and covered" }
    });
    expect(f.plan.reviewWaiver).toEqual({
      kind: "deterministic_coverage",
      reason: "All required criteria are automated and covered"
    });
  });

  it("rejects deterministic_coverage when any active criterion is manual_review", async () => {
    const f = await fixture();
    expect(() =>
      createVerificationPlan({
        ...f.input,
        checks: f.input.checks.slice(0, 2),
        reviewWaiver: { kind: "deterministic_coverage", reason: "Attempt to waive with active manual_review criterion" }
      })
    ).toThrow("review_waiver_manual_criterion: deterministic_coverage waiver cannot cover manual_review criteria");
  });

  it("rejects deterministic_coverage when any required criterion is not mapped to a deterministic check", async () => {
    const f = await fixture({
      reviewWaiver: { kind: "deterministic_coverage", reason: "Automated criteria" }
    });
    expect(() =>
      createVerificationPlan({
        ...f.input,
        checks: f.input.checks.slice(0, 1),
        reviewWaiver: { kind: "deterministic_coverage", reason: "Missing deterministic check for ac-types" }
      })
    ).toThrow("review_waiver_unmapped_criterion: deterministic_coverage waiver requires a deterministic check mapping for ac-types");
  });

  it("rejects deterministic_coverage when tddDecision.mode is required", async () => {
    const f = await fixture({
      reviewWaiver: { kind: "deterministic_coverage", reason: "Automated criteria" }
    });
    const tddDecision = {
      ...f.input.strategy.tddDecision,
      mode: "required" as const,
      requiresFailingTestFirst: true
    };
    const strategy = { ...f.input.strategy, tddDecision };
    const specification = { ...f.specification, tddDecision, testStrategy: strategy };
    expect(() =>
      createVerificationPlan({
        ...f.input,
        specification,
        strategy
      })
    ).toThrow("review_waiver_tdd_required: deterministic_coverage waiver is not allowed when TDD is required");
  });

  it("rejects deterministic_coverage when targetCommands is empty", async () => {
    const f = await fixture({
      reviewWaiver: { kind: "deterministic_coverage", reason: "Automated criteria" }
    });
    const strategy = { ...f.input.strategy, targetCommands: [] };
    const specification = { ...f.specification, testStrategy: strategy };
    expect(() =>
      createVerificationPlan({
        ...f.input,
        specification,
        strategy
      })
    ).toThrow("review_waiver_no_commands: deterministic_coverage waiver requires at least one target command");
  });

  it("rejects deterministic_coverage on workflow scope and identical_integrated_tree on task scope", async () => {
    const wf = await fixture({
      scope: "workflow",
      reviewWaiver: {
        kind: "identical_integrated_tree",
        reason: "Single-task integrated tree matches verified task tree",
        taskVerificationIds: ["verify-task-1"],
        taskTree: "a".repeat(40),
        integratedTree: "a".repeat(40)
      }
    });
    expect(() =>
      createVerificationPlan({
        ...wf.input,
        reviewWaiver: { kind: "deterministic_coverage", reason: "Wrong scope" }
      })
    ).toThrow("review_waiver_scope: deterministic_coverage waiver is only valid for task verification");

    const task = await fixture({
      reviewWaiver: { kind: "deterministic_coverage", reason: "Automated criteria" }
    });
    expect(() =>
      createVerificationPlan({
        ...task.input,
        reviewWaiver: {
          kind: "identical_integrated_tree",
          reason: "Wrong scope",
          taskVerificationIds: ["verify-task-1"],
          taskTree: "a".repeat(40),
          integratedTree: "a".repeat(40)
        }
      })
    ).toThrow("review_waiver_scope: identical_integrated_tree waiver is only valid for workflow verification");
  });

  it("accepts identical_integrated_tree with matching tree hashes and task verification ids", async () => {
    const waiver = {
      kind: "identical_integrated_tree" as const,
      reason: "Single-task integrated tree matches verified task tree",
      taskVerificationIds: ["verify-task-1"],
      taskTree: "a".repeat(40),
      integratedTree: "a".repeat(40)
    };
    const wf = await fixture({ scope: "workflow", reviewWaiver: waiver });
    expect(wf.plan.reviewWaiver).toEqual(waiver);
  });

  it("rejects identical_integrated_tree when integratedTree !== taskTree", async () => {
    const wf = await fixture({
      scope: "workflow",
      reviewWaiver: {
        kind: "identical_integrated_tree",
        reason: "Single-task integrated tree matches verified task tree",
        taskVerificationIds: ["verify-task-1"],
        taskTree: "a".repeat(40),
        integratedTree: "a".repeat(40)
      }
    });
    expect(() =>
      createVerificationPlan({
        ...wf.input,
        reviewWaiver: {
          kind: "identical_integrated_tree",
          reason: "Tree mismatch",
          taskVerificationIds: ["verify-task-1"],
          taskTree: "a".repeat(40),
          integratedTree: "b".repeat(40)
        }
      })
    ).toThrow("review_waiver_tree_mismatch: integrated tree does not match verified task tree");
  });

  it("rejects waiver when a review check is still present", async () => {
    const f = await fixture();
    expect(() =>
      createVerificationPlan({
        ...f.input,
        reviewWaiver: { kind: "deterministic_coverage", reason: "Ambiguous waiver with review check" }
      })
    ).toThrow("review_waiver_with_review: Review waiver cannot be combined with a review check");
  });

  it("planId changes when waiver changes and engine re-validation accepts waived plan", async () => {
    const first = await fixture({
      reviewWaiver: { kind: "deterministic_coverage", reason: "Waiver reason A" }
    });
    const second = createVerificationPlan({
      ...first.input,
      reviewWaiver: { kind: "deterministic_coverage", reason: "Waiver reason B" }
    });
    expect(second.planId).not.toBe(first.plan.planId);

    const engine = new VerificationEngine(first.ports);
    const cycle = engine.start(first.plan, "cycle-waived");
    const outcome = await engine.verify(first.plan, cycle, await first.change());
    expect(outcome.result.status).toBe("passed");
    expect(outcome.cycle.status).toBe("passed");
  });
});
