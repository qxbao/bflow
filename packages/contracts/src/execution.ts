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
  });

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
    cancellationId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    requestedBy: z.string().min(1),
    requestedAt: IsoDateTimeSchema,
    reason: z.string().min(1).optional(),
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export const CancellationResultSchema = z
  .object({
    cancellationId: IdentifierSchema,
    accepted: z.boolean(),
    status: z.enum(["accepted", "already-terminal", "not-found", "rejected"]),
    observedAt: IsoDateTimeSchema,
    details: JsonValueSchema.optional()
  })
  .strict();

export const RecoveryCheckpointSchema = z
  .object({
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
export type TimeoutPolicy = z.infer<typeof TimeoutPolicySchema>;
export type IdempotencyPolicy = z.infer<typeof IdempotencyPolicySchema>;
export type RecoveryPolicy = z.infer<typeof RecoveryPolicySchema>;
export type ExecutionError = z.infer<typeof ExecutionErrorSchema>;
export type Blockage = z.infer<typeof BlockageSchema>;
export type CancellationRequest = z.infer<typeof CancellationRequestSchema>;
export type CancellationResult = z.infer<typeof CancellationResultSchema>;
export type RecoveryCheckpoint = z.infer<typeof RecoveryCheckpointSchema>;
