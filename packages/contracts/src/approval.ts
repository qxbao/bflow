import { z } from "zod";
import { ArtifactReferenceSchema } from "./artifact.js";
import { IdempotencyKeySchema, IdentifierSchema, IsoDateTimeSchema, MetadataSchema } from "./common.js";

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "changes_requested",
  "rejected",
  "expired",
  "cancelled",
  "superseded"
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run") }).strict(),
  z.object({ type: z.literal("task"), taskId: IdentifierSchema }).strict(),
  z
    .object({
      type: z.literal("quality_gate"),
      taskId: IdentifierSchema.optional(),
      gateId: IdentifierSchema
    })
    .strict(),
  z.object({ type: z.literal("specification"), specId: IdentifierSchema }).strict(),
  z.object({ type: z.literal("tdd_decision"), decisionId: IdentifierSchema, taskId: IdentifierSchema.optional() }).strict(),
  z.object({ type: z.literal("verification_escalation"), cycleId: IdentifierSchema, taskId: IdentifierSchema }).strict(),
  z.object({ type: z.literal("git_changeset"), changeSetId: IdentifierSchema, taskId: IdentifierSchema }).strict(),
  z.object({ type: z.literal("delegation"), delegationId: IdentifierSchema }).strict()
]);

export const ApprovalRequestSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    approvalId: IdentifierSchema,
    runId: IdentifierSchema,
    sessionId: IdentifierSchema.optional(),
    status: ApprovalStatusSchema.optional(),
    expiresAt: IsoDateTimeSchema.optional(),
    target: ApprovalTargetSchema,
    revision: z.number().int().positive(),
    generation: z.number().int().nonnegative(),
    requestedBy: z.string().min(1),
    requestedAt: IsoDateTimeSchema,
    reason: z.string().min(1),
    evidence: z.array(ArtifactReferenceSchema),
    idempotencyKey: IdempotencyKeySchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export const ApprovalDecisionSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    approvalId: IdentifierSchema,
    runId: IdentifierSchema,
    sessionId: IdentifierSchema.optional(),
    target: ApprovalTargetSchema,
    revision: z.number().int().positive(),
    generation: z.number().int().nonnegative(),
    decision: z.enum(["approved", "rejected", "changes_requested"]),
    decidedBy: z.string().min(1),
    decidedAt: IsoDateTimeSchema,
    reason: z.string().min(1).optional(),
    feedbackArtifacts: z.array(ArtifactReferenceSchema),
    idempotencyKey: IdempotencyKeySchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.decision !== "approved" && decision.reason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reason is required for rejection or requested changes",
        path: ["reason"]
      });
    }
  });

export type ApprovalTarget = z.infer<typeof ApprovalTargetSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
