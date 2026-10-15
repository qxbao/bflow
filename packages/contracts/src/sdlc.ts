import { z } from "zod";
import { ArtifactIdSchema, ArtifactReferenceSchema } from "./artifact.js";
import { IdentifierSchema, IsoDateTimeSchema, MetadataSchema } from "./common.js";
import { QualityFindingSchema, QualityGateResultSchema } from "./quality.js";

export const SdlcWorkStatusSchema = z.enum([
  "intake",
  "clarifying",
  "specifying",
  "planning",
  "tdd_deciding",
  "implementing",
  "verifying",
  "reviewing",
  "awaiting_approval",
  "completed",
  "escalated",
  "failed",
  "cancelled"
]);
export type SdlcWorkStatus = z.infer<typeof SdlcWorkStatusSchema>;

export const SddPolicyLevelSchema = z.enum(["lightweight", "full"]);
export type SddPolicyLevel = z.infer<typeof SddPolicyLevelSchema>;

export const ChangeComplexitySchema = z.enum(["trivial", "standard", "complex"]);
export type ChangeComplexity = z.infer<typeof ChangeComplexitySchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const AcceptanceCriterionSchema = z
  .object({
    id: IdentifierSchema,
    description: z.string().trim().min(1),
    category: z.enum(["functional", "non_functional", "security", "performance", "edge_case", "regression"]),
    verificationMethod: z.enum([
      "unit_test",
      "integration_test",
      "e2e_test",
      "typecheck",
      "lint",
      "static_analysis",
      "manual_review"
    ]),
    required: z.boolean(),
    status: z.enum(["pending", "satisfied", "failed", "waived"]),
    evidenceArtifactIds: z.array(ArtifactIdSchema),
    waiverReason: z.string().min(1).optional()
  })
  .strict()
  .superRefine((criterion, context) => {
    if (
      criterion.status === "satisfied" &&
      criterion.verificationMethod !== "manual_review" &&
      criterion.evidenceArtifactIds.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "satisfied criterion requires at least one evidence artifact unless verification method is manual_review",
        path: ["evidenceArtifactIds"]
      });
    }
    if (criterion.status === "waived" && (!criterion.waiverReason || criterion.waiverReason.trim().length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "waiverReason is required when criterion is waived",
        path: ["waiverReason"]
      });
    }
  });
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const TddModeSchema = z.enum(["required", "recommended", "not_applicable"]);
export type TddMode = z.infer<typeof TddModeSchema>;

export const ChangeClassificationSchema = z.enum([
  "domain_logic",
  "bugfix",
  "api_contract",
  "refactoring",
  "ui_layout",
  "documentation",
  "configuration",
  "exploratory_spike"
]);
export type ChangeClassification = z.infer<typeof ChangeClassificationSchema>;

export const TddDecisionSchema = z
  .object({
    schemaVersion: z.literal(2),
    decisionId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    specId: IdentifierSchema,
    mode: TddModeSchema,
    rationale: z.string().trim().min(10),
    verifiableConditions: z.array(z.string().trim().min(1)).min(1),
    changeClassification: ChangeClassificationSchema,
    requiresFailingTestFirst: z.boolean(),
    decidedBy: z.enum(["coordinator", "planner", "architect", "human_operator"]),
    decidedAt: IsoDateTimeSchema,
    verifiedByGateId: IdentifierSchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.mode === "required" && !decision.requiresFailingTestFirst) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "required TDD mode must enforce requiresFailingTestFirst = true",
        path: ["requiresFailingTestFirst"]
      });
    }
    if (decision.mode === "not_applicable" && decision.requiresFailingTestFirst) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "not_applicable TDD mode cannot set requiresFailingTestFirst = true",
        path: ["requiresFailingTestFirst"]
      });
    }
    if (
      decision.mode === "not_applicable" &&
      (decision.changeClassification === "domain_logic" || decision.changeClassification === "bugfix") &&
      decision.metadata?.humanOverrideApproved !== true
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "domain_logic and bugfix changes cannot be marked not_applicable without explicit humanOverrideApproved metadata",
        path: ["mode"]
      });
    }
  });
export type TddDecision = z.infer<typeof TddDecisionSchema>;

export const TestStrategySchema = z
  .object({
    schemaVersion: z.literal(2),
    strategyId: IdentifierSchema,
    specId: IdentifierSchema,
    tddDecision: TddDecisionSchema,
    requiredTestLevels: z.array(z.enum(["unit", "integration", "e2e", "property", "regression", "smoke"])),
    targetCommands: z.array(z.string().trim().min(1)),
    coverageThresholdPercent: z.number().min(0).max(100).optional(),
    independentVerificationRequired: z.literal(true),
    criterionMappings: z.array(
      z
        .object({
          criterionId: IdentifierSchema,
          testNames: z.array(z.string().min(1)).min(1)
        })
        .strict()
    ),
    createdAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((strategy, context) => {
    if (strategy.tddDecision.specId !== strategy.specId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tddDecision.specId must match strategy specId",
        path: ["tddDecision", "specId"]
      });
    }
    if (strategy.tddDecision.mode === "required") {
      if (strategy.requiredTestLevels.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "requiredTestLevels must have length >= 1 when TDD mode is required",
          path: ["requiredTestLevels"]
        });
      }
      if (strategy.targetCommands.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "targetCommands must have length >= 1 when TDD mode is required",
          path: ["targetCommands"]
        });
      }
    }
  });
export type TestStrategy = z.infer<typeof TestStrategySchema>;

export const SpecificationSchema = z
  .object({
    schemaVersion: z.literal(2),
    specId: IdentifierSchema,
    runId: IdentifierSchema.optional(),
    sessionId: IdentifierSchema,
    level: SddPolicyLevelSchema,
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    problemStatement: z.string().trim().min(1),
    scope: z
      .object({
        inScope: z.array(z.string().min(1)).min(1),
        outOfScope: z.array(z.string().min(1))
      })
      .strict(),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
    affectedPaths: z.array(z.string().trim().min(1)).min(1),
    architectureNotes: z.string().trim().min(1).optional(),
    dataModelChanges: z.string().trim().min(1).optional(),
    securityConsiderations: z.string().trim().min(1).optional(),
    rollbackPlan: z.string().trim().min(1).optional(),
    complexity: ChangeComplexitySchema.optional(),
    riskLevel: RiskLevelSchema.optional(),
    version: z.number().int().positive().optional(),
    traceabilityTaskIds: z.array(IdentifierSchema).optional(),
    testStrategy: TestStrategySchema.optional(),
    tddDecision: TddDecisionSchema.optional(),
    status: z.enum(["draft", "review_pending", "approved", "superseded", "rejected"]),
    artifactRef: ArtifactReferenceSchema.optional(),
    createdBy: z.string().min(1),
    approvedBy: z.string().min(1).optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((spec, context) => {
    const seenCriteriaIds = new Set<string>();
    spec.acceptanceCriteria.forEach((criterion, index) => {
      if (seenCriteriaIds.has(criterion.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate acceptance criterion id: ${criterion.id}`,
          path: ["acceptanceCriteria", index, "id"]
        });
      }
      seenCriteriaIds.add(criterion.id);
    });

    if (spec.level === "full") {
      if (!spec.architectureNotes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "architectureNotes is required for full SDD level",
          path: ["architectureNotes"]
        });
      }
      if (!spec.securityConsiderations) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "securityConsiderations is required for full SDD level",
          path: ["securityConsiderations"]
        });
      }
      if (!spec.rollbackPlan) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "rollbackPlan is required for full SDD level",
          path: ["rollbackPlan"]
        });
      }
      if (!spec.testStrategy) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "testStrategy is required for full SDD level",
          path: ["testStrategy"]
        });
      }
      if (!spec.tddDecision) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "tddDecision is required for full SDD level",
          path: ["tddDecision"]
        });
      }
    }

    if (spec.status === "approved") {
      if (!spec.approvedBy) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "approvedBy is required when specification is approved",
          path: ["approvedBy"]
        });
      }
      if (!spec.artifactRef) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "artifactRef is required when specification is approved",
          path: ["artifactRef"]
        });
      }
    }
  });
export type Specification = z.infer<typeof SpecificationSchema>;

export const GitChangedFileSchema = z
  .object({
    path: z.string().min(1),
    changeType: z.enum(["added", "modified", "deleted", "renamed"]),
    previousPath: z.string().min(1).optional(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative()
  })
  .strict();
export type GitChangedFile = z.infer<typeof GitChangedFileSchema>;

export const GitChangeSetSchema = z
  .object({
    schemaVersion: z.literal(2),
    changeSetId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    attemptId: IdentifierSchema,
    worktreePath: z.string().min(1),
    branchName: z.string().min(1),
    baseCommitHash: z.string().regex(/^[a-f0-9]{7,40}$/i),
    headCommitHash: z.string().regex(/^[a-f0-9]{7,40}$/i),
    dirtyWorkingTree: z.boolean(),
    filesChanged: z.array(GitChangedFileSchema).min(1),
    patchArtifact: ArtifactReferenceSchema,
    createdAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((changeSet, context) => {
    if (changeSet.patchArtifact.kind !== "patch") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "patchArtifact kind must be 'patch'",
        path: ["patchArtifact", "kind"]
      });
    }
    if (changeSet.patchArtifact.runId !== changeSet.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "patchArtifact runId must match changeSet runId",
        path: ["patchArtifact", "runId"]
      });
    }
    changeSet.filesChanged.forEach((file, index) => {
      if (file.path.startsWith("/") || file.path.split(/[/\\]/).includes("..")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "changed file path must be repo-relative safe path",
          path: ["filesChanged", index, "path"]
        });
      }
      if (
        file.previousPath !== undefined &&
        (file.previousPath.startsWith("/") || file.previousPath.split(/[/\\]/).includes(".."))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "previousPath must be repo-relative safe path",
          path: ["filesChanged", index, "previousPath"]
        });
      }
    });
  });
export type GitChangeSet = z.infer<typeof GitChangeSetSchema>;

export const VerificationScopeSchema = z.enum(["task", "workflow"]);
export type VerificationScope = z.infer<typeof VerificationScopeSchema>;

export const VerificationResultStatusSchema = z.enum(["passed", "failed", "inconclusive", "blocked", "escalated"]);
export type VerificationResultStatus = z.infer<typeof VerificationResultStatusSchema>;

export const VerificationResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    verificationId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    cycleNumber: z.number().int().positive(),
    attemptId: IdentifierSchema,
    status: VerificationResultStatusSchema,
    verificationScope: VerificationScopeSchema.optional(),
    independentExecution: z.literal(true),
    evaluatedCriteria: z
      .array(
        z
          .object({
            criterionId: IdentifierSchema,
            passed: z.boolean(),
            command: z.string().min(1).optional(),
            exitCode: z.number().int().optional(),
            evidenceArtifactId: ArtifactIdSchema,
            summary: z.string().min(1)
          })
          .strict()
      )
      .min(1),
    qualityGateResults: z.array(QualityGateResultSchema),
    evidenceArtifacts: z.array(ArtifactReferenceSchema).min(1),
    findings: z.array(QualityFindingSchema),
    changeSet: GitChangeSetSchema.optional(),
    verifiedBy: z.enum(["quality_gate", "qa", "reviewer", "tester"]),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completedAt must be greater than or equal to startedAt",
        path: ["completedAt"]
      });
    }

    const evidenceIds = new Set(result.evidenceArtifacts.map((a) => a.artifactId));
    result.evaluatedCriteria.forEach((criterion, index) => {
      if (!evidenceIds.has(criterion.evidenceArtifactId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `evidenceArtifactId ${criterion.evidenceArtifactId} not found in evidenceArtifacts`,
          path: ["evaluatedCriteria", index, "evidenceArtifactId"]
        });
      }
    });

    result.evidenceArtifacts.forEach((art, index) => {
      if (art.runId !== result.runId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `evidenceArtifact runId ${art.runId} does not match verification runId ${result.runId}`,
          path: ["evidenceArtifacts", index, "runId"]
        });
      }
    });

    if (result.status === "passed") {
      const hasFailedCriterion = result.evaluatedCriteria.some((c) => !c.passed);
      if (hasFailedCriterion) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "all evaluatedCriteria must pass when verification status is passed",
          path: ["evaluatedCriteria"]
        });
      }
      const hasNonPassedGate = result.qualityGateResults.some((qg) => qg.status !== "passed");
      if (hasNonPassedGate) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "all qualityGateResults must pass when verification status is passed",
          path: ["qualityGateResults"]
        });
      }
      const hasErrorFinding = result.findings.some((f) => f.severity === "error");
      if (hasErrorFinding) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "findings cannot contain error severity when verification status is passed",
          path: ["findings"]
        });
      }
    }
  });
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const VerificationCycleStatusSchema = z.enum([
  "in_progress",
  "passed",
  "rework_required",
  "escalated",
  "aborted"
]);
export type VerificationCycleStatus = z.infer<typeof VerificationCycleStatusSchema>;

export const VerificationEscalationSchema = z
  .object({
    escalatedAt: IsoDateTimeSchema,
    reason: z.string().min(1),
    target: z.enum(["coordinator", "human_operator"]),
    approvalRequestId: IdentifierSchema.optional(),
    evidenceArtifacts: z.array(ArtifactReferenceSchema).min(1)
  })
  .strict();
export type VerificationEscalation = z.infer<typeof VerificationEscalationSchema>;

export const VerificationCycleSchema = z
  .object({
    schemaVersion: z.literal(2),
    cycleId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    specId: IdentifierSchema,
    verificationScope: VerificationScopeSchema.optional(),
    currentIteration: z.number().int().positive(),
    maxIterations: z.number().int().min(1).max(10).default(3),
    status: VerificationCycleStatusSchema,
    tddDecision: TddDecisionSchema,
    history: z.array(VerificationResultSchema),
    escalation: VerificationEscalationSchema.optional(),
    startedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((cycle, context) => {
    if (cycle.currentIteration > cycle.maxIterations) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "currentIteration cannot exceed maxIterations",
        path: ["currentIteration"]
      });
    }

    if (cycle.status === "passed") {
      if (cycle.history.length === 0 || cycle.history[cycle.history.length - 1]?.status !== "passed") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "passed cycle requires non-empty history with last result having passed status",
          path: ["history"]
        });
      }
    }

    if (cycle.status === "escalated" && cycle.escalation === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "escalation is required when cycle status is escalated",
        path: ["escalation"]
      });
    }

    const lastResultStatus = cycle.history[cycle.history.length - 1]?.status;
    if (
      cycle.currentIteration === cycle.maxIterations &&
      (lastResultStatus === "failed" || lastResultStatus === "inconclusive") &&
      cycle.status === "rework_required"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cycle cannot require rework when loop limit is reached; must escalate or abort",
        path: ["status"]
      });
    }
  });
export type VerificationCycle = z.infer<typeof VerificationCycleSchema>;
