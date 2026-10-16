import type { Specification } from "@bflow/contracts";
import { classifyChange, PolicyDetailsSchema } from "../src/index.js";

export const now = "2026-10-16T00:00:00.000Z";
export const later = "2026-10-16T00:01:00.000Z";

export function draft(kind: "documentation" | "bugfix" | "api" | "database" | "feature" = "documentation"): Specification {
  const assessment = {
    kind: kind === "api" || kind === "database" ? "feature" : kind,
    behaviorChange: kind !== "documentation", modules: ["example"],
    securityImpact: false, publicApiImpact: kind === "api", dataSchemaImpact: kind === "database",
    architectureImpact: false, migrationRequired: kind === "database", risk: "low",
    unresolvedQuestions: []
  };
  const affectedPaths = [kind === "documentation" ? "guide.md" : kind === "database" ? "db/migrations/001.sql" : "src/example.ts"];
  const classification = classifyChange(assessment, affectedPaths);
  const details = PolicyDetailsSchema.parse({
    policyVersion: 1, assessment,
    functionalRequirements: kind === "documentation" ? [] : ["Deliver the requested behavior without regressions"],
    ...(kind !== "documentation" ? { proposedTestStrategy: "Unit regression plus integration checks for changed behavior" } : {}),
    ...(classification.complexity === "complex" ? { designProposal: "Extend the existing boundary compatibly" } : {}),
    technicalConstraints: classification.complexity === "complex" ? ["Keep existing clients compatible"] : [],
    apiDataContracts: classification.complexity === "complex" ? ["Versioned payload with explicit validation"] : [],
    risksAndTradeoffs: classification.complexity === "complex" ? ["More validation cost in exchange for integrity"] : [],
    ...(kind === "database" ? { migrationStrategy: "Expand, backfill, validate, then contract; restore backup on rollback" } : {}),
    traceability: [{ criterionId: "ac-1", taskIds: ["implement"] }]
  });
  const decision = {
    schemaVersion: 2 as const, decisionId: "tdd-1", runId: "run-1", specId: "spec-1", mode: "required" as const,
    rationale: "Behavior change requires regression evidence first", verifiableConditions: ["Regression test fails before implementation"],
    changeClassification: kind === "api" ? "api_contract" as const : "domain_logic" as const,
    requiresFailingTestFirst: true, decidedBy: "coordinator" as const, decidedAt: now
  };
  return {
    schemaVersion: 2, specId: "spec-1", runId: "run-1", sessionId: "session-1",
    level: classification.level, complexity: classification.complexity, riskLevel: classification.riskLevel, version: 1,
    title: `Example ${kind} change`, summary: "Deliver an explicit, verifiable outcome",
    problemStatement: "The current example does not meet the requested outcome",
    scope: { inScope: ["The requested example change"], outOfScope: ["Unrelated modules"] },
    acceptanceCriteria: [{ id: "ac-1", description: "The requested outcome is independently verifiable",
      category: "functional", verificationMethod: kind === "documentation" ? "manual_review" : "unit_test",
      required: true, status: "pending", evidenceArtifactIds: [] }],
    affectedPaths, traceabilityTaskIds: ["implement"],
    ...(classification.level === "full" ? {
      architectureNotes: "Use the existing boundary and preserve compatibility",
      securityConsiderations: "Validate inputs and never expose credentials",
      rollbackPlan: "Revert the versioned change; restore data if migration fails",
      tddDecision: decision,
      testStrategy: { schemaVersion: 2 as const, strategyId: "strategy-1", specId: "spec-1", tddDecision: structuredClone(decision),
        requiredTestLevels: ["unit" as const, "integration" as const], targetCommands: ["pnpm test"],
        independentVerificationRequired: true as const,
        criterionMappings: [{ criterionId: "ac-1", testNames: ["example regression"] }], createdAt: now }
    } : {}),
    ...(kind === "database" ? { dataModelChanges: "Add a nullable field, backfill before enforcing the invariant" } : {}),
    status: "draft", createdBy: "analyst", createdAt: now, updatedAt: now, metadata: { sdd: details }
  };
}

export function workflow(taskIds = ["implement"]) {
  return {
    schemaVersion: "1", id: "flow", name: "Example", version: "1.0.0",
    tasks: taskIds.map(id => ({ id, title: id, role: "developer", instruction: "Implement linked criteria",
      acceptanceCriteria: ["ac-1"], retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
      timeout: { executionTimeoutMs: 60000, heartbeatTimeoutMs: 10000, onTimeout: "block" }, requiresApproval: false, qualityGates: [] })),
    dependencies: [], qualityGates: [], maxConcurrency: 1, failurePolicy: "block",
    recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
  };
}
