import { describe, expect, it } from "vitest";
import { recordEvidence, TestStrategyResolver } from "../src/index.js";
import { assessment, result, spec } from "./fixtures.js";

const resolver = new TestStrategyResolver();

describe("Slice 5 test-strategy regressions", () => {
  it("normalizes whitespace in custom criterionMappings testNames and discards stale/duplicate existingMappings during resolve()", () => {
    // 1. Custom testNames with surrounding whitespace must still match trimmed EvidenceDetailsSchema testNames in Red phase
    const s = spec();
    const initial = resolver.resolve(s);
    const withPaddedMapping = {
      ...s,
      testStrategy: {
        ...initial,
        criterionMappings: [{ criterionId: "ac-1", testNames: ["  should round properly  "] }]
      }
    };
    const resolved = resolver.resolve(withPaddedMapping);
    expect(resolved.criterionMappings[0]?.testNames).toEqual(["should round properly"]);

    const red = result(resolved, "red");
    red.metadata.conditionalTdd.testNames = ["should round properly"];
    expect(() => recordEvidence(resolved, red)).not.toThrow();

    // 2. Stale unknown criterionId in pre-existing spec.testStrategy.criterionMappings is discarded by resolve(), and rejected by validate()
    const withStaleMapping = {
      ...s,
      testStrategy: {
        ...initial,
        criterionMappings: [
          { criterionId: "ac-1", testNames: ["valid test"] },
          { criterionId: "ac-removed", testNames: ["stale test"] }
        ]
      }
    };
    const cleaned = resolver.resolve(withStaleMapping);
    expect(cleaned.criterionMappings.map(m => m.criterionId)).toEqual(["ac-1"]);

    expect(() =>
      resolver.validate({
        ...cleaned,
        criterionMappings: [
          { criterionId: "ac-1", testNames: ["t1"] },
          { criterionId: "ac-unknown", testNames: ["t2"] }
        ]
      })
    ).toThrow(/unknown or duplicate criterion mapping/i);
  });

  it("allows passing non-behavioral checks (e.g. typecheck exit 0) beside failing behavioral test (exit 1) on the same criterion in Red, and rejects contradictory passed:true with failing observation", () => {
    const a = assessment("domain_logic");
    a.conventions.requiredMethods = ["typecheck"];
    const s = resolver.resolve(spec(a));

    const red = result(s, "red");
    delete red.evaluatedCriteria[0]!.command;
    delete red.evaluatedCriteria[0]!.exitCode;
    // typecheck (exitCode 0) appears BEFORE unit_test (exitCode 1) on the same criterion ac-1
    red.metadata.conditionalTdd.observations = [
      {
        method: "typecheck",
        criterionId: "ac-1",
        evidenceArtifactId: "evidence-red",
        summary: "New Red test compiles cleanly",
        command: "pnpm typecheck",
        exitCode: 0
      },
      {
        method: "unit_test",
        criterionId: "ac-1",
        evidenceArtifactId: "evidence-red",
        summary: "Target behavior fails as expected",
        command: "pnpm test:unit",
        exitCode: 1
      }
    ];
    expect(() => recordEvidence(s, red)).not.toThrow();

    // Contradictory passed:true on ac-existing when one of its observations failed (exitCode 1) must be rejected
    const multiSpec = spec(a);
    multiSpec.acceptanceCriteria.push({
      ...multiSpec.acceptanceCriteria[0]!,
      id: "ac-existing",
      description: "Existing behavior"
    });
    const multiStrategy = resolver.resolve(multiSpec);
    const badRed = result(multiStrategy, "red");
    badRed.evaluatedCriteria.push({
      criterionId: "ac-existing",
      passed: true,
      evidenceArtifactId: "evidence-red",
      summary: "Claimed pass despite failing check"
    });
    badRed.metadata.conditionalTdd.observations.push(
      {
        method: "unit_test",
        criterionId: "ac-existing",
        evidenceArtifactId: "evidence-red",
        summary: "First check passed",
        command: "pnpm test:unit",
        exitCode: 0
      },
      {
        method: "unit_test",
        criterionId: "ac-existing",
        evidenceArtifactId: "evidence-red",
        summary: "Second unit check failed",
        command: "pnpm test:unit",
        exitCode: 1
      }
    );
    badRed.metadata.conditionalTdd.testNames.push("ac-existing: Existing behavior");
    expect(() => recordEvidence(multiStrategy, badRed)).toThrow(/Observation must agree/i);
  });

  it("rejects tampered decisionInput fields in validateAgainstSpecification even when decisionId and mode match", () => {
    const s = spec(assessment("refactoring"));
    const resolved = resolver.resolve(s);
    expect(resolved.tddDecision.mode).toBe("recommended");

    const tamperedDecision = {
      ...resolved.tddDecision,
      rationale: "Tampered rationale pretending checks were waived by coordinator"
    };
    expect(() => resolver.validateAgainstSpecification(resolved, s, tamperedDecision)).toThrow(
      /TDD decision does not match/i
    );
  });
});
