import { AcceptanceCriterionSchema, IdentifierSchema, RiskLevelSchema } from "@bflow/contracts";
import { z } from "zod";

const Text = z.string().trim().min(1);
export const VerificationMethodSchema = AcceptanceCriterionSchema.innerType().shape.verificationMethod;
export const TestLevelSchema = z.enum(["unit", "integration", "e2e", "property", "regression", "smoke"]);
const SurfaceSchema = z.enum([
  "domain_logic", "bugfix", "api_contract", "validation", "transformation", "state_machine",
  "integration", "refactoring", "ui_layout", "infrastructure", "configuration",
  "documentation", "formatting", "exploratory_spike"
]);

/** Private policy payload carried by Specification.metadata.conditionalTdd. */
export const AssessmentSchema = z.object({
  policyVersion: z.literal(1),
  taskId: IdentifierSchema,
  taskType: SurfaceSchema,
  changeImpact: z.object({
    surfaces: z.array(SurfaceSchema).min(1),
    behaviorChanged: z.boolean(),
    deterministic: z.boolean(),
    regressionReproducible: z.boolean(),
    securitySensitive: z.boolean(),
    dataMigration: z.boolean(),
    scope: z.enum(["local", "cross_module", "system"])
  }).strict(),
  infrastructure: z.object({
    readiness: z.enum(["ready", "partial", "absent"]),
    commands: z.array(z.object({
      method: VerificationMethodSchema,
      command: Text,
      level: TestLevelSchema.optional()
    }).strict())
  }).strict(),
  testability: z.object({
    level: z.enum(["automated", "partial", "none"]),
    rationale: z.string().trim().min(10)
  }).strict(),
  riskClassification: RiskLevelSchema,
  conventions: z.object({
    tdd: z.enum(["contextual", "preferred", "required"]),
    requiredMethods: z.array(VerificationMethodSchema),
    suggestedLevels: z.array(TestLevelSchema)
  }).strict()
}).strict();
export type Assessment = z.infer<typeof AssessmentSchema>;
export type VerificationMethod = z.infer<typeof VerificationMethodSchema>;
export type TestLevel = z.infer<typeof TestLevelSchema>;

export const EvidenceDetailsSchema = z.object({
  phase: z.enum(["red", "green", "refactor", "verification"]),
  decisionId: IdentifierSchema,
  specId: IdentifierSchema,
  sourceRevision: Text,
  testRevision: Text,
  testNames: z.array(Text).min(1),
  failureKind: z.enum(["target_behavior", "infrastructure", "unrelated"]).optional(),
  observations: z.array(z.object({
    method: VerificationMethodSchema,
    criterionId: IdentifierSchema,
    evidenceArtifactId: IdentifierSchema,
    summary: Text,
    command: Text.optional(),
    exitCode: z.number().int().optional()
  }).strict()).min(1)
}).strict();

export const PolicySnapshotSchema = z.object({
  policyVersion: z.literal(1),
  assessment: AssessmentSchema,
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  affectedPaths: z.array(Text).min(1),
  riskLevel: RiskLevelSchema,
  requiredVerificationMethods: z.array(VerificationMethodSchema).min(1),
  suggestedTestLevels: z.array(TestLevelSchema),
  evidenceRequirements: z.array(Text).min(1)
}).strict();
