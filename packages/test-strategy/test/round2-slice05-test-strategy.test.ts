import { describe, expect, it } from "vitest";
import { recordEvidence, TestStrategyResolver } from "../src/index.js";
import { assessment, nonBehavior, result, spec } from "./fixtures.js";

const resolver = new TestStrategyResolver();

describe("Round 2 Slice 5 test-strategy hardening", () => {
  it("accepts flat JSON null optional fields in AssessmentSchema (command.level, conventions.requiredMethods, conventions.suggestedLevels)", () => {
    const a = assessment("domain_logic") as unknown as Record<string, unknown>;
    const infra = a.infrastructure as { commands: Array<Record<string, unknown>> };
    infra.commands = [{ method: "unit_test", command: "pnpm test", level: null }];
    a.conventions = {
      tdd: "contextual",
      requiredMethods: null,
      suggestedLevels: null
    };

    const resolved = resolver.resolve(spec(a as unknown as ReturnType<typeof assessment>));
    expect(resolved.tddDecision.mode).toBe("required");
    expect(resolved.targetCommands).toEqual(["pnpm test"]);
  });

  it("normalizes Vietnamese Unicode NFC/NFD in criterion testNames and Windows backslash paths in evaluatePolicy", () => {
    const baseSpec = spec(assessment("domain_logic"));
    const vietnameseNfd = "Xử lý lỗi kết nối mạng và khôi phục phiên".normalize("NFD");
    const vietnameseNfc = "Xử lý lỗi kết nối mạng và khôi phục phiên".normalize("NFC");
    const s = {
      ...baseSpec,
      acceptanceCriteria: [
        {
          ...baseSpec.acceptanceCriteria[0]!,
          description: vietnameseNfd
        }
      ]
    };

    const strategy = resolver.resolve(s);
    expect(strategy.criterionMappings[0]?.testNames).toEqual([`ac-1: ${vietnameseNfc}`]);

    // Evidence submitted with NFC (or NFD) testNames must match without false rejection
    const red = result(strategy, "red");
    red.metadata.conditionalTdd.testNames = [`ac-1: ${vietnameseNfd}`];
    expect(() => recordEvidence(strategy, red)).not.toThrow();

    // Windows backslash path under test/__fixtures__ must be recognized as a test/fixture path
    // (a documentation task touching non-doc code paths fails closed unless recognized as test/fixture!)
    const docAssessment = nonBehavior("documentation");
    const docSpec = {
      ...spec(docAssessment, "manual_review"),
      affectedPaths: ["packages\\core\\test\\__fixtures__\\logic.json"]
    };
    const docStrategy = resolver.resolve(docSpec);
    expect(docStrategy.tddDecision.mode).toBe("not_applicable");
  });

  it("rejects duplicate extra verification phase records in non-required TDD modes and rejects inverted completedAt < startedAt timestamps", () => {
    // 1. not_applicable / recommended mode allows at most ONE verification phase receipt
    const docAssessment = nonBehavior("documentation");
    docAssessment.conventions.requiredMethods = ["lint"];
    const baseDocSpec = spec(docAssessment, "lint");
    const naStrategy = resolver.resolve(baseDocSpec);
    expect(naStrategy.tddDecision.mode).toBe("not_applicable");

    const v1 = result(naStrategy, "verification");
    v1.evaluatedCriteria = [
      {
        criterionId: "ac-1",
        passed: true,
        command: "pnpm lint",
        exitCode: 0,
        evidenceArtifactId: "evidence-verification",
        summary: "Lint passed cleanly"
      }
    ];
    v1.metadata.conditionalTdd.testNames = naStrategy.criterionMappings[0]!.testNames;
    v1.metadata.conditionalTdd.observations = [
      {
        method: "lint",
        criterionId: "ac-1",
        evidenceArtifactId: "evidence-verification",
        summary: "Lint passed cleanly",
        command: "pnpm lint",
        exitCode: 0
      }
    ];
    const afterFirst = recordEvidence(naStrategy, v1);

    const v2 = structuredClone(v1);
    v2.verificationId = "result-verification-2";
    v2.attemptId = "attempt-verification-2";
    v2.startedAt = "2026-10-16T01:15:00Z";
    v2.completedAt = "2026-10-16T01:16:00Z";
    v2.evidenceArtifacts[0] = {
      ...v2.evidenceArtifacts[0]!,
      artifactId: "evidence-verification-2",
      uri: "artifact://tests/evidence-verification-2",
      createdAt: "2026-10-16T01:15:30Z"
    };
    v2.evaluatedCriteria[0] = {
      ...v2.evaluatedCriteria[0]!,
      evidenceArtifactId: "evidence-verification-2"
    };
    v2.metadata.conditionalTdd.observations[0] = {
      ...v2.metadata.conditionalTdd.observations[0]!,
      evidenceArtifactId: "evidence-verification-2"
    };
    expect(() => recordEvidence(afterFirst, v2)).toThrow(/no further evidence phase/i);

    // 2. Inverted timestamps (completedAt < startedAt) within a single VerificationResult must fail closed
    const reqStrategy = resolver.resolve(spec());
    const invertedRed = result(reqStrategy, "red");
    invertedRed.startedAt = "2026-10-16T01:05:00Z";
    invertedRed.completedAt = "2026-10-16T01:04:00Z";
    expect(() => recordEvidence(reqStrategy, invertedRed)).toThrow(/monotonic|completedAt must be greater than or equal to startedAt/i);
  });
});
