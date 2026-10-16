import { SpecificationSchema } from "@bflow/contracts";
import { AssessmentSchema } from "../src/schema.js";

export const now = "2026-10-16T01:00:00Z";
export function assessment(taskType = "domain_logic", overrides: Record<string, unknown> = {}) {
  return AssessmentSchema.parse({
    policyVersion: 1, taskId: "task-1", taskType,
    changeImpact: {
      surfaces: [taskType], behaviorChanged: true, deterministic: true,
      regressionReproducible: true, securitySensitive: false, dataMigration: false, scope: "local"
    },
    infrastructure: { readiness: "ready", commands: [
      { method: "unit_test", command: "pnpm test:unit", level: "unit" },
      { method: "integration_test", command: "pnpm test:integration", level: "integration" },
      { method: "typecheck", command: "pnpm typecheck" },
      { method: "static_analysis", command: "pnpm analyze" },
      { method: "lint", command: "pnpm lint" }
    ] },
    testability: { level: "automated", rationale: "Inputs and outputs can be tested deterministically." },
    riskClassification: "low",
    conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] },
    ...overrides
  });
}
export function spec(a = assessment(), method = "unit_test") {
  return SpecificationSchema.parse({
    schemaVersion: 2, specId: "spec-1", runId: "run-1", sessionId: "session-1", level: "lightweight",
    title: "A change", summary: "Implement the specified change", problemStatement: "Missing behavior",
    scope: { inScope: ["Target behavior"], outOfScope: [] },
    acceptanceCriteria: [{ id: "ac-1", description: "Target behavior matches expected output", category: "functional",
      verificationMethod: method, required: true, status: "pending", evidenceArtifactIds: [] }],
    affectedPaths: [a.taskType === "documentation" ? "docs/example.md" : "packages/example/src/logic.ts"], status: "draft", createdBy: "architect",
    createdAt: now, updatedAt: now, metadata: { conditionalTdd: a }
  });
}
export function nonBehavior(taskType: string) {
  const a = assessment(taskType);
  return assessment(taskType, { changeImpact: { ...a.changeImpact, behaviorChanged: false,
    deterministic: false, regressionReproducible: false },
    testability: { level: "none", rationale: "No executable behavior exists for a failing test." } });
}
export function result(strategy: ReturnType<typeof spec>["testStrategy"], phase: string, overrides: Record<string, unknown> = {}) {
  if (!strategy) throw new Error("strategy fixture is required");
  const offset = { red: 1, green: 3, refactor: 5, verification: 1 }[phase] ?? 1;
  const artifactId = `evidence-${phase}`;
  const method = phase === "verification" ? "manual_review" : "unit_test";
  return {
    schemaVersion: 2, verificationId: `result-${phase}`, runId: "run-1", taskId: "task-1",
    cycleNumber: 1, attemptId: `attempt-${phase}`, status: phase === "red" ? "failed" : "passed",
    independentExecution: true, evaluatedCriteria: [{ criterionId: "ac-1", passed: phase !== "red",
      command: "pnpm test:unit", exitCode: phase === "red" ? 1 : 0, evidenceArtifactId: artifactId,
      summary: phase === "red" ? "Expected target output was absent" : "Expected output confirmed" }],
    qualityGateResults: [], findings: [],
    evidenceArtifacts: [{ trust: "stored", artifactId, runId: "run-1", taskId: "task-1", kind: "test-result",
      uri: `artifact://tests/${artifactId}`, mediaType: "application/json", checksum: { algorithm: "sha256", value: "a".repeat(64) },
      createdAt: `2026-10-16T01:00:0${offset + 1}Z` }],
    verifiedBy: "tester", startedAt: `2026-10-16T01:00:0${offset}Z`, completedAt: `2026-10-16T01:00:0${offset + 1}Z`,
    metadata: { conditionalTdd: { phase, decisionId: strategy.tddDecision.decisionId, specId: "spec-1",
      sourceRevision: phase === "red" ? "before" : phase === "refactor" ? "refactored" : "implemented",
      testRevision: "tests-from-spec", testNames: ["ac-1: Target behavior matches expected output"],
      ...(phase === "red" ? { failureKind: "target_behavior" } : {}),
      observations: [{ method, criterionId: "ac-1", evidenceArtifactId: artifactId, summary: "Observed target behavior",
        ...(method === "manual_review" ? {} : { command: "pnpm test:unit", exitCode: phase === "red" ? 1 : 0 }) }] } },
    ...overrides
  };
}
