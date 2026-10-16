import { describe, expect, it } from "vitest";
import { assertEvidenceComplete, assertReadyToImplement, recordEvidence, TestStrategyResolver } from "../src/index.js";
import { assessment, nonBehavior, result, spec } from "./fixtures.js";

const resolver = new TestStrategyResolver();
const strategy = () => resolver.resolve(spec());
describe("objective TDD evidence", () => {
  it("requires Red before implementation and the full sequence before completion", () => {
    const s = strategy();
    expect(() => assertReadyToImplement(s)).toThrow(/red/i);
    const red = recordEvidence(s, result(s, "red"));
    expect(() => assertReadyToImplement(red)).not.toThrow();
    expect(() => assertEvidenceComplete(red)).toThrow();
    const green = recordEvidence(red, result(s, "green"));
    expect(() => assertEvidenceComplete(green)).toThrow();
    const complete = recordEvidence(green, result(s, "refactor"));
    expect(() => assertEvidenceComplete(complete)).not.toThrow();
    expect(complete.metadata.tddEvidence).toHaveLength(3);
    expect(s.metadata?.tddEvidence).toBeUndefined();
  });
  it("rejects Green without Red", () => {
    const s = strategy(); expect(() => recordEvidence(s, result(s, "green"))).toThrow();
  });
  it.each(["infrastructure", "unrelated"])("rejects %s failures as Red evidence", failureKind => {
    const s = strategy(); const r = result(s, "red"); r.metadata.conditionalTdd.failureKind = failureKind;
    expect(() => recordEvidence(s, r)).toThrow();
  });
  it("rejects Red without a nonzero exit code", () => {
    const s = strategy(); const r = result(s, "red"); r.evaluatedCriteria[0]!.exitCode = 0;
    expect(() => recordEvidence(s, r)).toThrow();
  });
  it("rejects replacement tests between Red and Green", () => {
    const s = strategy(); const red = recordEvidence(s, result(s, "red"));
    const green = result(s, "green"); green.metadata.conditionalTdd.testRevision = "weakened-tests";
    expect(() => recordEvidence(red, green)).toThrow();
  });
  it.each(["runId", "taskId"])("rejects evidence from a different %s", field => {
    const s = strategy(); expect(() => recordEvidence(s, result(s, "red", { [field]: "other" }))).toThrow();
  });
  it("rejects untrusted references", () => {
    const s = strategy(); const r = result(s, "red");
    expect(() => recordEvidence(s, { ...r, evidenceArtifacts: [{ ...r.evidenceArtifacts[0], trust: "proposed" }] })).toThrow();
  });
  it("rejects overlapping or reversed phase times", () => {
    const s = strategy(); const red = recordEvidence(s, result(s, "red"));
    const r = result(s, "green", { startedAt: "2026-10-16T01:00:01Z", completedAt: "2026-10-16T01:00:02Z" });
    expect(() => recordEvidence(red, r)).toThrow();
  });
  it("deduplicates identical result retries and rejects conflicting receipt IDs", () => {
    const s = strategy(); const r = result(s, "red"); const red = recordEvidence(s, r);
    expect(recordEvidence(red, r)).toEqual(red);
    expect(() => recordEvidence(red, { ...r, attemptId: "different" })).toThrow();
  });
  it("not_applicable still requires alternative evidence", () => {
    const s = resolver.resolve(spec(nonBehavior("documentation"), "manual_review"));
    expect(() => assertReadyToImplement(s)).not.toThrow();
    expect(() => assertEvidenceComplete(s)).toThrow();
    const verified = recordEvidence(s, result(s, "verification"));
    expect(() => assertEvidenceComplete(verified)).not.toThrow();
  });
  it("rejects missing methods and criterion evidence", () => {
    const s = strategy(); const r = result(s, "red");
    r.metadata.conditionalTdd.observations[0]!.method = "manual_review";
    expect(() => recordEvidence(s, r)).toThrow();
  });
  it("rejects unknown metadata and invalid contracts before use", () => {
    const s = strategy(); const r = result(s, "red");
    expect(() => recordEvidence(s, { ...r, metadata: {} })).toThrow();
    expect(() => assertEvidenceComplete({ ...s, metadata: {} })).toThrow();
  });
  it("recommended requires successful alternative verification", () => {
    const s = resolver.resolve(spec(assessment("refactoring")));
    expect(() => assertEvidenceComplete(s)).toThrow();
    const r = result(s, "verification");
    r.metadata.conditionalTdd.observations[0]!.method = "unit_test";
    r.metadata.conditionalTdd.observations[0]!.command = "pnpm test:unit";
    r.metadata.conditionalTdd.observations[0]!.exitCode = 0;
    expect(() => assertEvidenceComplete(recordEvidence(s, r))).not.toThrow();
  });
  it("high-risk documentation cannot skip static analysis", () => {
    const a = nonBehavior("documentation"); a.riskClassification = "critical";
    const s = resolver.resolve(spec(a, "manual_review"));
    expect(() => recordEvidence(s, result(s, "verification"))).toThrow();
    const r = result(s, "verification");
    delete r.evaluatedCriteria[0]!.command;
    r.metadata.conditionalTdd.observations.push({ method: "static_analysis", criterionId: "ac-1",
      evidenceArtifactId: "evidence-verification", summary: "Static checks passed", command: "pnpm analyze", exitCode: 0 });
    expect(() => assertEvidenceComplete(recordEvidence(s, r))).not.toThrow();
  });
  it("requires criterion-specific methods, not just global method coverage", () => {
    const s0 = spec(); s0.acceptanceCriteria.push({ ...s0.acceptanceCriteria[0]!, id: "ac-2", verificationMethod: "manual_review" });
    const s = resolver.resolve(s0); const red = result(s, "red");
    const partial = recordEvidence(s, red); const green = result(s, "green");
    green.metadata.conditionalTdd.observations[0]!.method = "manual_review";
    expect(() => recordEvidence(partial, green)).toThrow();
  });
  it("does not allow a later phase to reuse the prior execution attempt", () => {
    const s = strategy(); const red = recordEvidence(s, result(s, "red"));
    expect(() => recordEvidence(red, result(s, "green", { attemptId: "attempt-red" }))).toThrow();
  });
  it("rejects a different spec or decision in otherwise correlated evidence", () => {
    const s = strategy(); const r = result(s, "red"); r.metadata.conditionalTdd.specId = "other-spec";
    expect(() => recordEvidence(s, r)).toThrow();
    r.metadata.conditionalTdd.specId = "spec-1"; r.metadata.conditionalTdd.decisionId = "other-decision";
    expect(() => recordEvidence(s, r)).toThrow();
  });
  it("rejects Green with failing observations despite a claimed passed result", () => {
    const s = strategy(); const red = recordEvidence(s, result(s, "red"));
    const r = result(s, "green"); r.metadata.conditionalTdd.observations[0]!.exitCode = 1;
    expect(() => recordEvidence(red, r)).toThrow();
  });
  it("rejects stale artifact task bindings and weakened spec-derived test names", () => {
    const s = strategy(); const r = result(s, "red"); r.evidenceArtifacts[0]!.taskId = "other-task";
    expect(() => recordEvidence(s, r)).toThrow();
    r.evidenceArtifacts[0]!.taskId = "task-1"; r.metadata.conditionalTdd.testNames = ["irrelevant test"];
    expect(() => recordEvidence(s, r)).toThrow();
  });
  it("revalidates persisted receipts instead of accepting a fabricated history", () => {
    const s = strategy();
    expect(() => assertEvidenceComplete({ ...s, metadata: { ...s.metadata, tddEvidence: [result(s, "green")] } })).toThrow();
  });
  it("accepts a high-risk TDD sequence with integration, analysis and review", () => {
    const s = resolver.resolve(spec(assessment("domain_logic", { riskClassification: "high" })));
    let recorded = recordEvidence(s, result(s, "red"));
    for (const phase of ["green", "refactor"]) {
      const r = result(s, phase); delete r.evaluatedCriteria[0]!.command;
      for (const [method, command] of [["integration_test", "pnpm test:integration"], ["static_analysis", "pnpm analyze"], ["manual_review", undefined]]) {
        r.metadata.conditionalTdd.observations.push({ method: method!, criterionId: "ac-1", evidenceArtifactId: `evidence-${phase}`,
          summary: "Independent check passed", ...(command ? { command, exitCode: 0 } : {}) });
      }
      recorded = recordEvidence(recorded, r);
    }
    expect(() => assertEvidenceComplete(recorded)).not.toThrow();
  });
  it.each([
    ["configuration", [["typecheck", "pnpm typecheck"], ["static_analysis", "pnpm analyze"]]],
    ["infrastructure", [["integration_test", "pnpm test:integration"], ["static_analysis", "pnpm analyze"]]],
    ["ui_layout", [["manual_review", ""]]],
    ["formatting", [["lint", "pnpm lint"]]]
  ])("accepts concrete alternative verification for %s", (task, checks) => {
    const a = nonBehavior(task as string);
    a.infrastructure.commands.push({ method: "lint", command: "pnpm lint" });
    const s = resolver.resolve(spec(a, "manual_review")); const r = result(s, "verification");
    delete r.evaluatedCriteria[0]!.command;
    for (const [method, command] of checks as string[][]) {
      r.metadata.conditionalTdd.observations.push({ method: method!, criterionId: "ac-1", evidenceArtifactId: "evidence-verification",
        summary: "Independent alternative check passed", ...(command ? { command, exitCode: 0 } : {}) });
    }
    expect(() => assertEvidenceComplete(recordEvidence(s, r))).not.toThrow();
  });
  it("validates multiple observations on a single acceptance criterion", () => {
    const a = assessment("domain_logic");
    a.conventions.requiredMethods = ["typecheck"];
    const s = resolver.resolve(spec(a));
    const red = recordEvidence(s, result(s, "red"));
    const green = result(s, "green");
    const artifactId2 = "evidence-green-2";
    green.evidenceArtifacts.push({
      trust: "stored", artifactId: artifactId2, runId: "run-1", taskId: "task-1", kind: "test-result",
      uri: `artifact://tests/${artifactId2}`, mediaType: "application/json", checksum: { algorithm: "sha256", value: "b".repeat(64) },
      createdAt: "2026-10-16T01:00:04Z"
    });
    green.metadata.conditionalTdd.observations.push({
      method: "typecheck", criterionId: "ac-1", evidenceArtifactId: artifactId2,
      summary: "Typecheck passed", command: "pnpm typecheck", exitCode: 0
    });
    expect(() => recordEvidence(red, green)).not.toThrow();
  });
  it("allows passing existing criteria beside the new failing behavior in Red", () => {
    const input = spec();
    input.acceptanceCriteria.push({ ...input.acceptanceCriteria[0]!, id: "ac-existing", description: "Existing behavior is preserved" });
    const s = resolver.resolve(input);
    let recorded = s;
    for (const phase of ["red", "green", "refactor"]) {
      const r = result(s, phase);
      r.evaluatedCriteria.push({ ...r.evaluatedCriteria[0]!, criterionId: "ac-existing", passed: true, exitCode: 0 });
      r.metadata.conditionalTdd.observations.push({ method: "unit_test", criterionId: "ac-existing",
        evidenceArtifactId: `evidence-${phase}`, summary: "Existing behavior passes", command: "pnpm test:unit", exitCode: 0 });
      r.metadata.conditionalTdd.testNames.push("ac-existing: Existing behavior is preserved");
      recorded = recordEvidence(recorded, r);
    }
    expect(() => assertEvidenceComplete(recorded)).not.toThrow();
  });
  it("rejects a Red result whose behavioral observations all passed", () => {
    const s = strategy(); const r = result(s, "red");
    r.evaluatedCriteria[0]!.passed = true; r.evaluatedCriteria[0]!.exitCode = 0;
    r.metadata.conditionalTdd.observations[0]!.exitCode = 0;
    expect(() => recordEvidence(s, r)).toThrow();
  });
  it("does not mix phase receipts from different verification cycles", () => {
    const s = strategy(); const red = recordEvidence(s, result(s, "red"));
    expect(() => recordEvidence(red, result(s, "green", { cycleNumber: 2 }))).toThrow();
  });
  it("rejects a manual observation with a contradictory failing exit code", () => {
    const s = resolver.resolve(spec(nonBehavior("documentation"), "manual_review"));
    const r = result(s, "verification"); r.metadata.conditionalTdd.observations[0]!.exitCode = 1;
    expect(() => recordEvidence(s, r)).toThrow();
  });
  it("requires every target command even when several commands use the same method", () => {
    const a = assessment(); a.infrastructure.commands.push({ method: "unit_test", command: "pnpm test:secondary" });
    const s = resolver.resolve(spec(a)); const red = recordEvidence(s, result(s, "red"));
    expect(() => recordEvidence(red, result(s, "green"))).toThrow();
    let recorded = red;
    for (const phase of ["green", "refactor"]) {
      const r = result(s, phase); delete r.evaluatedCriteria[0]!.command;
      r.metadata.conditionalTdd.observations.push({ method: "unit_test", criterionId: "ac-1",
        evidenceArtifactId: `evidence-${phase}`, summary: "Secondary suite passes", command: "pnpm test:secondary", exitCode: 0 });
      recorded = recordEvidence(recorded, r);
    }
    expect(() => assertEvidenceComplete(recorded)).not.toThrow();
  });
});
