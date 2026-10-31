import { describe, expect, it } from "vitest";
import {
  addCriterionToDraft,
  buildTraceabilityMatrix,
  classifyChange,
  detectSpecChanges,
  parseSpecification,
  policyDetails,
  validateChangedFilesScope
} from "../src/index.js";
import { draft, later, now, workflow } from "./fixtures.js";

describe("Slice 5 specification regressions", () => {
  it("defaults omitted empty arrays for unresolvedQuestions and non-applicable PolicyDetails sections without weakening standard/complex requirements", () => {
    const rawAssessment = {
      kind: "documentation" as const,
      behaviorChange: false,
      modules: ["docs"],
      securityImpact: false,
      publicApiImpact: false,
      dataSchemaImpact: false,
      architectureImpact: false,
      migrationRequired: false,
      risk: "low" as const
      // unresolvedQuestions omitted when none exist
    };
    const cls = classifyChange(rawAssessment, ["guide.md"]);
    expect(cls.complexity).toBe("trivial");

    // Trailing slash on duplicate module name must not trigger false multi-module complex escalation
    const trailingSlashCls = classifyChange(
      { ...rawAssessment, modules: ["packages/core", "packages/core/"] },
      ["guide.md"]
    );
    expect(trailingSlashCls.complexity).toBe("trivial");

    // Trivial spec omitting complex/standard array fields succeeds with [] defaults
    const trivialSpec = draft("documentation");
    const trivialSdd = {
      policyVersion: 1 as const,
      assessment: rawAssessment,
      traceability: [{ criterionId: "ac-1", taskIds: ["implement"] }]
    };
    const parsedTrivial = parseSpecification({ ...trivialSpec, metadata: { sdd: trivialSdd } });
    expect(policyDetails(parsedTrivial).functionalRequirements).toEqual([]);
    expect(policyDetails(parsedTrivial).technicalConstraints).toEqual([]);

    // Standard spec omitting complex array fields succeeds, while omitting functionalRequirements still fails
    const standardSpec = draft("bugfix");
    const standardDetails = policyDetails(standardSpec);
    const parsedStandard = parseSpecification({
      ...standardSpec,
      metadata: {
        sdd: {
          policyVersion: 1,
          assessment: standardDetails.assessment,
          functionalRequirements: standardDetails.functionalRequirements,
          proposedTestStrategy: standardDetails.proposedTestStrategy,
          traceability: standardDetails.traceability
        }
      }
    });
    expect(parsedStandard.complexity).toBe("standard");
    expect(() =>
      parseSpecification({
        ...standardSpec,
        metadata: {
          sdd: {
            policyVersion: 1,
            assessment: standardDetails.assessment,
            proposedTestStrategy: standardDetails.proposedTestStrategy,
            traceability: standardDetails.traceability
          }
        }
      })
    ).toThrow(/functional requirements/i);
  });

  it("does not trigger false globalRequirementsChanged on criterion-only additions/edits in full-SDD specifications", () => {
    const base = draft("feature");
    const withTwo = addCriterionToDraft(
      base,
      {
        id: "ac-2",
        description: "Unaffected sibling criterion",
        category: "functional",
        verificationMethod: "unit_test",
        required: true,
        status: "pending",
        evidenceArtifactIds: []
      },
      ["task-unaffected"]
    );

    // Add ac-3 mapped to task-new without altering any global requirement field
    const added = addCriterionToDraft(
      withTwo,
      {
        id: "ac-3",
        description: "Newly added criterion",
        category: "non_functional",
        verificationMethod: "typecheck",
        required: true,
        status: "pending",
        evidenceArtifactIds: []
      },
      ["task-new"]
    );
    const next = {
      ...added,
      version: 2,
      updatedAt: later,
      tddDecision: { ...added.tddDecision!, decidedAt: later },
      testStrategy: {
        ...added.testStrategy!,
        createdAt: later,
        tddDecision: { ...added.testStrategy!.tddDecision, decidedAt: later }
      }
    };

    const impact = detectSpecChanges(withTwo, next);
    expect(impact.changedFields).toEqual([]);
    expect(impact.globalRequirementsChanged).toBe(false);
    expect(impact.addedCriterionIds).toEqual(["ac-3"]);
    expect(impact.affectedTaskIds).toEqual(["task-new"]);
    expect(impact.requiresReapproval).toBe(true);
  });

  it("handles blank optional sdd fields on contract specs, trims workflow criterion IDs, and matches dot-directories and zero-segment ** globs in validateChangedFilesScope", () => {
    // 1. Contract spec with blank optional strings in metadata.sdd does not crash policyDetails()
    const contractSpec = {
      schemaVersion: 2 as const,
      specId: "spec-contract",
      runId: "run-1",
      sessionId: "session-1",
      level: "lightweight" as const,
      title: "Contract spec",
      summary: "Summary",
      problemStatement: "Problem",
      scope: { inScope: ["a"], outOfScope: [] },
      acceptanceCriteria: [
        {
          id: "ac-1",
          description: "First",
          category: "functional" as const,
          verificationMethod: "unit_test" as const,
          required: true,
          status: "pending" as const,
          evidenceArtifactIds: []
        },
        {
          id: "ac-2",
          description: "Second",
          category: "non_functional" as const,
          verificationMethod: "lint" as const,
          required: true,
          status: "pending" as const,
          evidenceArtifactIds: []
        }
      ],
      affectedPaths: [".github", "packages/**/index.ts", "**/root-config.json", "src/exact.ts"],
      traceabilityTaskIds: ["task-a", "task-b"],
      status: "draft" as const,
      createdBy: "analyst",
      createdAt: now,
      updatedAt: now,
      metadata: {
        sdd: {
          assessment: { kind: "feature", modules: ["  "] },
          designProposal: "   ",
          technicalConstraints: ["   "]
        }
      }
    };

    const details = policyDetails(contractSpec);
    expect(details.designProposal).toBeUndefined();
    expect(details.technicalConstraints).toEqual([]);

    // 2. Partial metadata.sdd without explicit traceability infers per-task mappings from workflow & trims task.acceptanceCriteria
    const wf = workflow(["task-a", "task-b"]);
    wf.tasks[0]!.acceptanceCriteria = [" ac-1 "];
    wf.tasks[1]!.acceptanceCriteria = ["ac-2"];
    const matrix = buildTraceabilityMatrix(contractSpec, wf);
    expect(matrix.valid).toBe(true);
    expect(matrix.criterionToTasks["ac-1"]).toEqual(["task-a"]);
    expect(matrix.criterionToTasks["ac-2"]).toEqual(["task-b"]);

    // 3. validateChangedFilesScope supports dot-directory prefixes (.github) and zero-directory **/ matches while keeping file patterns strict
    const scopeCheck = validateChangedFilesScope(contractSpec, [
      ".github/workflows/ci.yml",
      "packages/index.ts",
      "packages/core/src/index.ts",
      "root-config.json",
      "nested/root-config.json",
      "src/exact.ts"
    ]);
    expect(scopeCheck).toEqual({ withinScope: true, outOfScopePaths: [] });

    const outCheck = validateChangedFilesScope(contractSpec, ["src/exact.ts/nested.ts"]);
    expect(outCheck).toEqual({ withinScope: false, outOfScopePaths: ["src/exact.ts/nested.ts"] });
  });
});
