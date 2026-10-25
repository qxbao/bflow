import { describe, expect, it } from "vitest";
import type { Specification, TestStrategy, WorkflowDefinition } from "@bflow/contracts";
import { classifyChange, type ChangeAssessment } from "../../../specification/src/classification.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";
import {
  evaluateFastPath,
  FAST_PATH_BLOCKERS,
  FAST_PATH_MAX_PATHS,
  type EvaluateFastPathInput,
  type FastPathBlocker
} from "../../src/agentic/fast-path.js";

const now = "2026-10-26T00:00:00.000Z";

function makeAssessment(overrides: Partial<ChangeAssessment> = {}): ChangeAssessment {
  return {
    kind: "documentation",
    behaviorChange: false,
    modules: ["runtime"],
    securityImpact: false,
    publicApiImpact: false,
    dataSchemaImpact: false,
    architectureImpact: false,
    migrationRequired: false,
    risk: "low",
    unresolvedQuestions: [],
    ...overrides
  };
}

function makeStrategy(
  mode: "required" | "recommended" | "not_applicable" = "not_applicable",
  targetCommands: string[] = []
): TestStrategy {
  const decision = {
    schemaVersion: 2 as const,
    decisionId: "tdd-1",
    runId: "run-1",
    specId: "spec-1",
    mode,
    rationale: mode === "not_applicable" ? "Documentation only" : "Verification check",
    verifiableConditions: ["Check passes"],
    changeClassification: mode === "not_applicable" ? ("documentation" as const) : ("refactoring_without_behavior_change" as const),
    requiresFailingTestFirst: mode === "required",
    ...(mode === "not_applicable" ? { alternativeVerificationMethods: ["manual_review" as const] } : {}),
    decidedBy: "coordinator" as const,
    decidedAt: now
  };
  return {
    schemaVersion: 2,
    strategyId: "strategy-1",
    specId: "spec-1",
    tddDecision: decision,
    requiredTestLevels: mode === "not_applicable" ? [] : ["unit"],
    targetCommands,
    independentVerificationRequired: true,
    criterionMappings: [{ criterionId: "ac-1", testNames: ["fast-path check"] }],
    ...(mode === "not_applicable"
      ? {
          alternativeEvidence: [
            {
              method: "manual_review" as const,
              description: "Documentation check",
              artifactIds: ["artifact-1"],
              verified: false
            }
          ]
        }
      : {}),
    createdAt: now
  };
}

function makeEligibleInput(overrides: Partial<EvaluateFastPathInput> = {}): EvaluateFastPathInput {
  const assessment = makeAssessment();
  const affectedPaths = ["docs/guide.md"];
  const classification = classifyChange(assessment, affectedPaths);
  const spec: Specification = {
    ...draft("documentation"),
    level: classification.level,
    complexity: classification.complexity,
    riskLevel: classification.riskLevel,
    affectedPaths,
    metadata: {
      sdd: {
        policyVersion: 1,
        assessment
      }
    }
  };
  const definition: WorkflowDefinition = workflow(["implement"]);
  return {
    mode: "auto",
    classification,
    assessment,
    delegationSddLevel: "lightweight",
    draft: spec,
    definition,
    strategies: [makeStrategy("not_applicable")],
    specialistRequested: false,
    ...overrides
  };
}

describe("evaluateFastPath", () => {
  it("exports FAST_PATH_MAX_PATHS = 5 and stable FAST_PATH_BLOCKERS tuple", () => {
    expect(FAST_PATH_MAX_PATHS).toBe(5);
    expect(FAST_PATH_BLOCKERS).toEqual([
      "disabled",
      "not_trivial",
      "unresolved_questions",
      "full_sdd",
      "multi_task",
      "task_approval",
      "too_many_paths",
      "glob_paths",
      "tdd_required",
      "specialist_used"
    ]);
  });

  it("marks single-file low-risk documentation change with 1 task and tdd not_applicable as eligible", () => {
    const decision = evaluateFastPath(makeEligibleInput());
    expect(decision).toEqual({
      eligible: true,
      blockers: [],
      reasons: []
    });
  });

  it("marks 2-file same-module refactoring with targetCommands and recommended TDD as eligible", () => {
    const assessment = makeAssessment({
      kind: "refactoring",
      behaviorChange: false,
      modules: ["core"],
      risk: "low"
    });
    const affectedPaths = ["src/a.ts", "src/b.ts"];
    const classification = classifyChange(assessment, affectedPaths);
    expect(classification.complexity).toBe("trivial");
    expect(classification.level).toBe("lightweight");

    const base = makeEligibleInput();
    const decision = evaluateFastPath({
      ...base,
      classification,
      assessment,
      draft: {
        ...base.draft,
        level: classification.level,
        affectedPaths,
        metadata: { sdd: { policyVersion: 1, assessment } }
      },
      strategies: [makeStrategy("recommended", ["pnpm test"])]
    });

    expect(decision).toEqual({
      eligible: true,
      blockers: [],
      reasons: []
    });
  });

  it.each<{
    label: string;
    assessment: Partial<ChangeAssessment>;
    affectedPaths: string[];
    expectedComplexity: "standard" | "complex";
  }>([
    {
      label: "kind is bugfix",
      assessment: { kind: "bugfix", behaviorChange: false },
      affectedPaths: ["src/fix.ts"],
      expectedComplexity: "standard"
    },
    {
      label: "behaviorChange is true",
      assessment: { kind: "refactoring", behaviorChange: true },
      affectedPaths: ["src/refactor.ts"],
      expectedComplexity: "standard"
    },
    {
      label: "security path hint src/auth/x.ts escalates to complex",
      assessment: { kind: "documentation", behaviorChange: false },
      affectedPaths: ["src/auth/x.ts"],
      expectedComplexity: "complex"
    },
    {
      label: "multiple modules affected escalates to complex",
      assessment: { kind: "refactoring", behaviorChange: false, modules: ["core", "runtime"] },
      affectedPaths: ["src/a.ts"],
      expectedComplexity: "complex"
    }
  ])("blocks with not_trivial when $label", ({ assessment: overrides, affectedPaths, expectedComplexity }) => {
    const assessment = makeAssessment(overrides);
    const classification = classifyChange(assessment, affectedPaths);
    expect(classification.complexity).toBe(expectedComplexity);

    const base = makeEligibleInput();
    const decision = evaluateFastPath({
      ...base,
      classification,
      assessment,
      draft: {
        ...base.draft,
        level: "lightweight",
        affectedPaths,
        metadata: { sdd: { policyVersion: 1, assessment } }
      }
    });

    expect(decision.eligible).toBe(false);
    expect(decision.blockers).toEqual(["not_trivial"]);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it.each<{
    blocker: FastPathBlocker;
    label: string;
    buildInput: () => EvaluateFastPathInput;
  }>([
    {
      blocker: "disabled",
      label: "mode is off",
      buildInput: () => makeEligibleInput({ mode: "off" })
    },
    {
      blocker: "not_trivial",
      label: "classification complexity is standard",
      buildInput: () => {
        const base = makeEligibleInput();
        return {
          ...base,
          classification: { ...base.classification, complexity: "standard" }
        };
      }
    },
    {
      blocker: "unresolved_questions",
      label: "direct assessment has unresolvedQuestions",
      buildInput: () =>
        makeEligibleInput({
          assessment: makeAssessment({ unresolvedQuestions: ["Which file should be updated?"] })
        })
    },
    {
      blocker: "unresolved_questions",
      label: "draft.metadata.sdd.assessment has unresolvedQuestions",
      buildInput: () => {
        const base = makeEligibleInput({ assessment: undefined });
        return {
          ...base,
          draft: {
            ...base.draft,
            metadata: {
              sdd: {
                policyVersion: 1,
                assessment: makeAssessment({ unresolvedQuestions: ["Clarify target format?"] })
              }
            }
          }
        };
      }
    },
    {
      blocker: "full_sdd",
      label: "delegationSddLevel is full",
      buildInput: () => makeEligibleInput({ delegationSddLevel: "full" })
    },
    {
      blocker: "full_sdd",
      label: "draft.level is full",
      buildInput: () => {
        const base = makeEligibleInput();
        return {
          ...base,
          draft: { ...base.draft, level: "full" }
        };
      }
    },
    {
      blocker: "multi_task",
      label: "workflow definition has 2 tasks",
      buildInput: () => makeEligibleInput({ definition: workflow(["task-1", "task-2"]) })
    },
    {
      blocker: "multi_task",
      label: "workflow definition has task dependencies",
      buildInput: () => {
        const def = workflow(["implement"]);
        return makeEligibleInput({
          definition: {
            ...def,
            dependencies: [{ taskId: "implement", dependsOnTaskId: "implement", condition: "succeeded" }]
          }
        });
      }
    },
    {
      blocker: "task_approval",
      label: "single task requires human approval",
      buildInput: () => {
        const def = workflow(["implement"]);
        return makeEligibleInput({
          definition: {
            ...def,
            tasks: def.tasks.map(task => ({ ...task, requiresApproval: true }))
          }
        });
      }
    },
    {
      blocker: "too_many_paths",
      label: "affectedPaths has 6 entries (> FAST_PATH_MAX_PATHS)",
      buildInput: () => {
        const base = makeEligibleInput();
        return {
          ...base,
          draft: {
            ...base.draft,
            affectedPaths: ["docs/1.md", "docs/2.md", "docs/3.md", "docs/4.md", "docs/5.md", "docs/6.md"]
          }
        };
      }
    },
    {
      blocker: "glob_paths",
      label: "affectedPaths contains wildcard docs/*.md",
      buildInput: () => {
        const base = makeEligibleInput();
        return {
          ...base,
          draft: {
            ...base.draft,
            affectedPaths: ["docs/*.md"]
          }
        };
      }
    },
    {
      blocker: "tdd_required",
      label: "test strategy has tddDecision.mode === required",
      buildInput: () => makeEligibleInput({ strategies: [makeStrategy("required", ["pnpm test"])] })
    },
    {
      blocker: "specialist_used",
      label: "specialistRequested is true",
      buildInput: () => makeEligibleInput({ specialistRequested: true })
    }
  ])("blocks with $blocker when $label", ({ blocker, buildInput }) => {
    const decision = evaluateFastPath(buildInput());
    expect(decision.eligible).toBe(false);
    expect(decision.blockers).toEqual([blocker]);
    expect(decision.reasons).toHaveLength(1);
    expect(decision.reasons[0]).toEqual(expect.any(String));
  });

  it("returns all active blockers in the exact stable order of FAST_PATH_BLOCKERS", () => {
    const base = makeEligibleInput();
    const twoTaskDef = workflow(["task-1", "task-2"]);
    const decision = evaluateFastPath({
      mode: "off",
      classification: {
        ...base.classification,
        complexity: "complex",
        level: "full",
        humanApprovalRequired: true,
        riskLevel: "high"
      },
      assessment: makeAssessment({ unresolvedQuestions: ["Open question?"] }),
      delegationSddLevel: "full",
      draft: {
        ...base.draft,
        level: "full",
        affectedPaths: ["docs/*.md", "docs/2.md", "docs/3.md", "docs/4.md", "docs/5.md", "docs/6.md"]
      },
      definition: {
        ...twoTaskDef,
        tasks: twoTaskDef.tasks.map(t => ({ ...t, requiresApproval: true }))
      },
      strategies: [makeStrategy("required", ["pnpm test"])],
      specialistRequested: true
    });

    expect(decision.eligible).toBe(false);
    expect(decision.blockers).toEqual(FAST_PATH_BLOCKERS);
    expect(decision.reasons).toHaveLength(FAST_PATH_BLOCKERS.length);
  });

  it("records a follow-up/revision reason without blocking eligibility", () => {
    const decision = evaluateFastPath(makeEligibleInput({ followUpOrRevision: true }));
    expect(decision.eligible).toBe(true);
    expect(decision.blockers).toEqual([]);
    expect(decision.reasons).toEqual([expect.stringMatching(/follow-up|revision/i)]);
  });

  it("supports preview evaluation without definition or strategies (as in assess)", () => {
    const base = makeEligibleInput();
    const preview = evaluateFastPath({
      mode: "auto",
      classification: base.classification,
      assessment: base.assessment,
      draft: base.draft,
      specialistRequested: false
    });
    expect(preview).toEqual({
      eligible: true,
      blockers: [],
      reasons: []
    });
  });
});
