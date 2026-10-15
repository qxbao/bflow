import { z } from "zod";
import {
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataSchema
} from "./common.js";

export const TaskStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "waiting",
  "retrying",
  "blocked",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled"
]);

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled"
]);

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1),
    strategy: z.enum(["fixed", "linear", "exponential"]),
    initialDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative(),
    multiplier: z.number().positive().optional(),
    jitter: z.boolean(),
    retryableErrorCodes: z.array(z.string().min(1)).optional()
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.maxDelayMs < policy.initialDelayMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "maxDelayMs must be greater than or equal to initialDelayMs",
        path: ["maxDelayMs"]
      });
    }
    if (policy.strategy === "exponential" && (policy.multiplier === undefined || policy.multiplier <= 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exponential retry requires multiplier greater than 1",
        path: ["multiplier"]
      });
    }
    if (policy.strategy !== "exponential" && policy.multiplier !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "multiplier is only valid for exponential retry",
        path: ["multiplier"]
      });
    }
  });

/** maxReworks counts transitions to a new generation, excluding generation zero. */
export const ReworkPolicySchema = z
  .object({
    maxReworks: z.number().int().nonnegative(),
    onExhausted: z.enum(["fail", "require_human"])
  })
  .strict();

export const TimeoutPolicySchema = z
  .object({
    executionTimeoutMs: z.number().int().positive(),
    heartbeatTimeoutMs: z.number().int().positive().optional(),
    deadline: IsoDateTimeSchema.optional(),
    onTimeout: z.enum(["fail", "retry", "block"])
  })
  .strict();

export const IdempotencyPolicySchema = z
  .object({
    key: IdempotencyKeySchema,
    scope: z.enum(["run", "task", "agent-request", "artifact"]),
    fingerprint: z.string().min(1),
    retentionMs: z.number().int().positive().optional()
  })
  .strict();

export const RecoveryPolicySchema = z
  .object({
    checkpoint: z.enum(["disabled", "task-boundary", "event-interval"]),
    eventInterval: z.number().int().positive().optional(),
    resumeStrategy: z.enum(["replay", "checkpoint-then-replay"]),
    staleExecution: z.enum(["reconcile", "retry", "block"])
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.checkpoint === "event-interval" && policy.eventInterval === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "eventInterval is required for event-interval checkpointing",
        path: ["eventInterval"]
      });
    }
  });

export const ExecutionErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    details: JsonValueSchema.optional()
  })
  .strict();

export const BlockageSchema = z
  .object({
    code: z.enum([
      "waiting_dependency",
      "awaiting_approval",
      "agent_unavailable",
      "external_dependency",
      "quality_gate",
      "manual_intervention"
    ]),
    message: z.string().min(1),
    since: IsoDateTimeSchema,
    retryable: z.boolean(),
    details: JsonValueSchema.optional()
  })
  .strict();

export const CancellationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    cancellationId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    requestedBy: z.string().min(1),
    requestedAt: IsoDateTimeSchema,
    expectedVersion: z.number().int().nonnegative(),
    executionId: IdentifierSchema.optional(),
    reason: z.string().min(1).optional(),
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export const CancellationResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(1),
      cancellationId: IdentifierSchema,
      status: z.literal("accepted"),
      executionId: IdentifierSchema.optional(),
      observedAt: IsoDateTimeSchema,
      details: JsonValueSchema.optional()
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      cancellationId: IdentifierSchema,
      status: z.enum(["refused", "already_terminal", "not_found"]),
      reason: z.string().min(1),
      observedAt: IsoDateTimeSchema,
      details: JsonValueSchema.optional()
    })
    .strict()
]);

export const CancellationStopConfirmationSchema = z
  .object({
    schemaVersion: z.literal(1),
    cancellationId: IdentifierSchema,
    executionId: IdentifierSchema.optional(),
    stoppedAt: IsoDateTimeSchema,
    terminalStatus: z.enum(["cancelled", "succeeded", "failed"]),
    details: JsonValueSchema.optional()
  })
  .strict();

export const RecoveryCheckpointSchema = z
  .object({
    checkpointSchemaVersion: z.literal(1),
    codec: z.discriminatedUnion("name", [
      z.object({ name: z.literal("bflow.workflow-run-snapshot+json"), version: z.literal(1) }).strict(),
      z.object({ name: z.literal("bflow.workflow-aggregate+json"), version: z.literal(1) }).strict()
    ]),
    checkpointId: IdentifierSchema,
    runId: IdentifierSchema,
    eventSequence: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    state: JsonValueSchema,
    resumeCursor: z.string().min(1).optional(),
    createdAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type ReworkPolicy = z.infer<typeof ReworkPolicySchema>;
export type TimeoutPolicy = z.infer<typeof TimeoutPolicySchema>;
export type IdempotencyPolicy = z.infer<typeof IdempotencyPolicySchema>;
export type RecoveryPolicy = z.infer<typeof RecoveryPolicySchema>;
export type ExecutionError = z.infer<typeof ExecutionErrorSchema>;
export type Blockage = z.infer<typeof BlockageSchema>;
export type CancellationRequest = z.infer<typeof CancellationRequestSchema>;
export type CancellationResult = z.infer<typeof CancellationResultSchema>;
export type CancellationStopConfirmation = z.infer<typeof CancellationStopConfirmationSchema>;
export type RecoveryCheckpoint = z.infer<typeof RecoveryCheckpointSchema>;
