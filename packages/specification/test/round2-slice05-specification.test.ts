import { describe, expect, it } from "vitest";
import {
  buildTraceabilityMatrix,
  classifyChange,
  parseSpecification,
  policyDetails,
  validateChangedFilesScope,
  validateTraceability
} from "../src/index.js";
import { draft, workflow } from "./fixtures.js";

describe("Round 2 Slice 5 specification hardening", () => {
  it("accepts flat JSON null optional arrays and strings in ChangeAssessment and PolicyDetails without weakening standard/complex section gates", () => {
    const rawAssessment = {
      kind: "documentation" as const,
      behaviorChange: false,
      modules: ["docs"],
      securityImpact: false,
      publicApiImpact: false,
      dataSchemaImpact: false,
      architectureImpact: false,
      migrationRequired: false,
      risk: "low" as const,
      unresolvedQuestions: null
    };
    const cls = classifyChange(rawAssessment as unknown as Parameters<typeof classifyChange>[0], ["guide.md"]);
    expect(cls.complexity).toBe("trivial");

    // Trivial proposal from LLM flat JSON tool output passing null for non-applicable sections
    const trivialSpec = draft("documentation");
    const parsedTrivial = parseSpecification({
      ...trivialSpec,
      metadata: {
        sdd: {
          policyVersion: 1,
          assessment: rawAssessment,
          functionalRequirements: null,
          technicalConstraints: null,
          apiDataContracts: null,
          risksAndTradeoffs: null,
          proposedTestStrategy: null,
          designProposal: null,
          migrationStrategy: null,
          revisionReason: null,
          traceability: [{ criterionId: "ac-1", taskIds: ["implement"] }]
        }
      }
    });
    const details = policyDetails(parsedTrivial);
    expect(details.functionalRequirements).toEqual([]);
    expect(details.proposedTestStrategy).toBeUndefined();
    expect(details.designProposal).toBeUndefined();

    // Standard proposal still enforces proposedTestStrategy when null is supplied
    const standardSpec = draft("bugfix");
    const standardDetails = policyDetails(standardSpec);
    expect(() =>
      parseSpecification({
        ...standardSpec,
        metadata: {
          sdd: {
            ...standardDetails,
            proposedTestStrategy: null,
            designProposal: null
          }
        }
      })
    ).toThrow(/proposed test strategy is required/i);

    // Standard proposal succeeds when optional complex fields are null
    const parsedStandard = parseSpecification({
      ...standardSpec,
      metadata: {
        sdd: {
          ...standardDetails,
          technicalConstraints: null,
          apiDataContracts: null,
          risksAndTradeoffs: null,
          designProposal: null,
          migrationStrategy: null
        }
      }
    });
    expect(parsedStandard.complexity).toBe("standard");
  });

  it("normalizes leading ./, Windows backslashes, repeated slashes, and Unicode NFC in classifyChange modules to prevent false multi-module complex escalation", () => {
    const nfcModule = "packages/tài-liệu".normalize("NFC");
    const nfdModule = "packages/tài-liệu".normalize("NFD");
    const cls = classifyChange(
      {
        kind: "documentation",
        behaviorChange: false,
        modules: [
          `./${nfcModule}/`,
          `${nfdModule}\\`,
          `packages//tài-liệu`
        ],
        securityImpact: false,
        publicApiImpact: false,
        dataSchemaImpact: false,
        architectureImpact: false,
        migrationRequired: false,
        risk: "low"
      },
      ["guide.md"]
    );
    expect(cls.complexity).toBe("trivial");
    expect(cls.reasons).not.toContain("multiple modules affected");
    expect(cls.humanApprovalRequired).toBe(false);
  });

  it("normalizes Unicode NFC/NFD, Windows backslashes, and leading ./ in validateChangedFilesScope and buildTraceabilityMatrix while rejecting traversal and prefix boundary leaks", () => {
    const spec = {
      ...draft("documentation"),
      affectedPaths: [
        "tài-liệu/**/*.md".normalize("NFC"),
        "packages/core/src/index.ts"
      ]
    };

    const scope = validateChangedFilesScope(spec, [
      "./tài-liệu/hướng-dẫn.md".normalize("NFD"),
      ".\\packages\\core\\src\\index.ts"
    ]);
    expect(scope.withinScope).toBe(true);
    expect(scope.outOfScopePaths).toEqual([]);

    // File-extension boundary, parent traversal, and interior dot segments remain out-of-scope
    expect(validateChangedFilesScope(spec, ["packages/core/src/../index.ts"]).withinScope).toBe(false);
    expect(validateChangedFilesScope(spec, ["packages/core/src/./index.ts"]).withinScope).toBe(false);
    const leaked = validateChangedFilesScope(spec, ["packages/core/src/index.ts/nested.ts"]);
    expect(leaked.withinScope).toBe(false);

    // buildTraceabilityMatrix matches task.acceptanceCriteria across NFC/NFD when deriving from workflow tasks
    const baseSpec = draft("bugfix");
    const nfcCriterionId = "ac-kiểm-tra-1".normalize("NFC");
    const nfdCriterionId = "ac-kiểm-tra-1".normalize("NFD");
    const specWithoutSddTraceability = {
      ...baseSpec,
      acceptanceCriteria: [{ ...baseSpec.acceptanceCriteria[0]!, id: nfcCriterionId }],
      metadata: {}
    };
    const wf = {
      ...workflow(["implement"]),
      tasks: workflow(["implement"]).tasks.map((t) => ({
        ...t,
        acceptanceCriteria: [nfdCriterionId]
      }))
    };
    const matrix = buildTraceabilityMatrix(specWithoutSddTraceability, wf);
    expect(matrix.orphanCriterionIds).toEqual([]);
    expect(matrix.criterionToTasks[nfcCriterionId]).toEqual(["implement"]);
  });

  it("includes exact offending criterion and task IDs in SpecificationDocumentSchema and validateTraceability errors", () => {
    const spec = draft("bugfix");
    const sdd = policyDetails(spec);

    expect(() =>
      parseSpecification({
        ...spec,
        metadata: {
          sdd: {
            ...sdd,
            traceability: [
              { criterionId: "ac-1", taskIds: ["implement"] },
              { criterionId: "ac-ghost", taskIds: ["implement"] }
            ]
          }
        }
      })
    ).toThrow(/unknown or duplicate mapped criterion.*ac-ghost/i);

    expect(() =>
      parseSpecification({
        ...spec,
        traceabilityTaskIds: ["wrong-task"]
      })
    ).toThrow(/traceabilityTaskIds must match mapped tasks.*wrong-task/i);

    const twoTaskWf = workflow(["implement", "unmapped-extra"]);
    expect(() => validateTraceability(spec, twoTaskWf)).toThrow(/unmapped workflow tasks.*unmapped-extra/i);
  });
});
