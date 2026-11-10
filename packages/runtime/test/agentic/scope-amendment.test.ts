import { describe, expect, it } from "vitest";
import { AmendTaskScopeInputSchema, ScopeAmendmentRefusal, assertScopeInvariants, planScopeAmendment, type ScopeChange } from "../../src/agentic/scope-amendment.js";

const criterion = (id: string, required = true) => ({ id, description: `d-${id}`, category: "functional", verificationMethod: "unit_test", required, status: "pending" }) as any;
const base = () => ({
  specification: { acceptanceCriteria: [criterion("AC-1")], affectedPaths: ["src/a.ts", "test/a.test.ts", "test/live.test.ts"] },
  strategy: { criterionMappings: [{ criterionId: "AC-1", testNames: ["AC-1: works"] }] },
  ownedPaths: ["src", "test"]
});
const ctx = { missingPaths: ["test/live.test.ts"] };
const refusal = (changes: ScopeChange[], context = ctx) => {
  try { planScopeAmendment(base(), changes, context); } catch (error) { return (error as ScopeAmendmentRefusal).code; }
  return "none";
};

describe("scope amendment planning", () => {
  it("drops only paths the Runtime observed missing", () => {
    const plan = planScopeAmendment(base(), [{ kind: "drop_planned_paths", paths: ["test/live.test.ts"] }], ctx);
    expect(plan.affectedPaths).toEqual(["src/a.ts", "test/a.test.ts"]);
    expect(plan.diff.droppedAffectedPaths).toEqual(["test/live.test.ts"]);
    expect(refusal([{ kind: "drop_planned_paths", paths: ["src/a.ts"] }])).toBe("path_exists_or_unobserved");
    expect(refusal([{ kind: "drop_planned_paths", paths: ["test/other.test.ts"] }])).toBe("path_not_planned");
  });
  it("adds planned paths only inside current ownership", () => {
    expect(planScopeAmendment(base(), [{ kind: "add_paths_within_ownership", paths: ["test/b.test.ts"] }], ctx).affectedPaths).toContain("test/b.test.ts");
    expect(refusal([{ kind: "add_paths_within_ownership", paths: ["docs/x.md"] }])).toBe("not_within_ownership");
    expect(refusal([{ kind: "add_paths_within_ownership", paths: ["../etc/passwd"] }])).toBe("invalid_path");
    expect(refusal([{ kind: "add_paths_within_ownership", paths: ["/abs/x"] }])).toBe("invalid_path");
  });
  it("edits the test names of one existing criterion only", () => {
    const plan = planScopeAmendment(base(), [{ kind: "set_test_names", criterionId: "AC-1", testNames: ["AC-1: renamed"] }], ctx);
    expect(plan.criterionMappings).toEqual([{ criterionId: "AC-1", testNames: ["AC-1: renamed"] }]);
    expect(plan.diff.testNamesChanged).toEqual([{ criterionId: "AC-1", before: ["AC-1: works"], after: ["AC-1: renamed"] }]);
    expect(refusal([{ kind: "set_test_names", criterionId: "AC-9", testNames: ["x"] }])).toBe("unknown_criterion");
  });
  it("has no way to change ownership, waive a criterion or approve itself", () => {
    const ok = { runId: "r", taskId: "t", reason: "plan declared files never written" };
    for (const change of [{ kind: "expand_owned_paths", paths: ["docs"] }, { kind: "narrow_owned_paths", paths: ["src"] }])
      expect(AmendTaskScopeInputSchema.safeParse({ ...ok, changes: [change] }).success).toBe(false);
    expect(AmendTaskScopeInputSchema.safeParse({ ...ok, approvalId: "x", changes: [{ kind: "drop_planned_paths", paths: ["a"] }] }).success).toBe(false);
  });
  it("rejects unknown fields, empty or oversized input", () => {
    const ok = { runId: "r", taskId: "t", reason: "plan declared files never written", changes: [{ kind: "drop_planned_paths", paths: ["a"] }] };
    expect(AmendTaskScopeInputSchema.safeParse(ok).success).toBe(true);
    expect(AmendTaskScopeInputSchema.safeParse({ ...ok, waive: true }).success).toBe(false);
    expect(AmendTaskScopeInputSchema.safeParse({ ...ok, changes: [] }).success).toBe(false);
    expect(AmendTaskScopeInputSchema.safeParse({ ...ok, changes: [{ kind: "waive_criterion", id: "AC-1" }] }).success).toBe(false);
    expect(AmendTaskScopeInputSchema.safeParse({ ...ok, reason: "short" }).success).toBe(false);
  });
});

describe("scope invariants", () => {
  const strategy = (mode: string, names = ["n"]) => ({ tddDecision: { mode, requiresFailingTestFirst: mode === "required" },
    requiredTestLevels: ["unit"], independentVerificationRequired: true, criterionMappings: [{ criterionId: "AC-1", testNames: names }] }) as any;
  const before = { specification: { acceptanceCriteria: [criterion("AC-1")] }, strategy: strategy("required") };
  const code = (after: any) => { try { assertScopeInvariants(before, after); } catch (error) { return (error as ScopeAmendmentRefusal).code; } return "none"; };
  it("accepts an identical-criteria, same-TDD result", () => expect(code({ specification: before.specification, strategy: strategy("required", ["m"]) })).toBe("none"));
  it("rejects a changed, removed or waived criterion", () => {
    expect(code({ specification: { acceptanceCriteria: [{ ...criterion("AC-1"), description: "weaker" }] }, strategy: strategy("required") })).toBe("criteria_changed");
    expect(code({ specification: { acceptanceCriteria: [criterion("AC-1", false)] }, strategy: strategy("required") })).toBe("criteria_changed");
    expect(code({ specification: { acceptanceCriteria: [] }, strategy: strategy("required") })).toBe("criteria_changed");
  });
  it("rejects a required criterion left without a test", () =>
    expect(code({ specification: before.specification, strategy: { ...strategy("required"), criterionMappings: [] } })).toBe("criterion_unmapped"));
  it("rejects weakening TDD", () => expect(code({ specification: before.specification, strategy: strategy("not_applicable") })).toBe("tdd_weakened"));
});
