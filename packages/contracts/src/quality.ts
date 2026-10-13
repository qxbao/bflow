import { z } from "zod";
import { AgentResultSchema } from "./agent.js";
import { ArtifactReferenceSchema } from "./artifact.js";
import { IdentifierSchema, IsoDateTimeSchema, JsonValueSchema, MetadataSchema } from "./common.js";
import { ExecutionErrorSchema, TimeoutPolicySchema } from "./execution.js";

export const QualityGateDefinitionSchema = z
  .object({
    id: IdentifierSchema,
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    evaluator: z.string().min(1),
    required: z.boolean(),
    timeout: TimeoutPolicySchema,
    configuration: JsonValueSchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();

export const QualityFindingSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1),
    artifactId: IdentifierSchema.optional(),
    location: z.string().min(1).optional(),
    details: JsonValueSchema.optional()
  })
  .strict();

export const QualityGateContextSchema = z
  .object({
    runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    definition: QualityGateDefinitionSchema,
    agentResult: AgentResultSchema.optional(),
    artifacts: z.array(ArtifactReferenceSchema),
    input: JsonValueSchema.optional()
  })
  .strict();

export const QualityGateResultSchema = z
  .object({
    gateId: IdentifierSchema,
    status: z.enum(["passed", "failed", "blocked", "error"]),
    findings: z.array(QualityFindingSchema),
    producedArtifacts: z.array(ArtifactReferenceSchema),
    error: ExecutionErrorSchema.optional(),
    evaluatedAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export type QualityGateDefinition = z.infer<typeof QualityGateDefinitionSchema>;
export type QualityFinding = z.infer<typeof QualityFindingSchema>;
export type QualityGateContext = z.infer<typeof QualityGateContextSchema>;
export type QualityGateResult = z.infer<typeof QualityGateResultSchema>;
