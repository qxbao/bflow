import { z } from "zod";
import { ArtifactReferenceSchema } from "./artifact.js";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataSchema
} from "./common.js";
import {
  BlockageSchema,
  ExecutionErrorSchema,
  IdempotencyPolicySchema,
  RetryPolicySchema,
  TimeoutPolicySchema
} from "./execution.js";

export const AgentRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    role: z.string().min(1),
    instruction: z.string().min(1),
    workingDirectory: z.string().min(1).optional(),
    inputs: z.array(ArtifactReferenceSchema),
    context: JsonValueSchema.optional(),
    attempt: z.number().int().min(1),
    retry: RetryPolicySchema,
    timeout: TimeoutPolicySchema,
    idempotency: IdempotencyPolicySchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export const AgentResultStatusSchema = z.enum([
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "timed_out"
]);

export const AgentResultSchema = z
  .object({
    requestId: IdentifierSchema,
    executionId: IdentifierSchema,
    status: AgentResultStatusSchema,
    output: JsonValueSchema.optional(),
    artifacts: z.array(ArtifactReferenceSchema),
    error: ExecutionErrorSchema.optional(),
    blockage: BlockageSchema.optional(),
    retryable: z.boolean(),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema,
    resumeCursor: z.string().min(1).optional(),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.status === "failed" || result.status === "timed_out") && result.error === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "error is required for failed and timed_out results",
        path: ["error"]
      });
    }
    if (result.status === "blocked" && result.blockage === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "blockage is required for blocked results",
        path: ["blockage"]
      });
    }
  });

export const AgentExecutionHandleSchema = z
  .object({
    executionId: IdentifierSchema,
    requestId: IdentifierSchema,
    acceptedAt: IsoDateTimeSchema,
    resumeCursor: z.string().min(1).optional()
  })
  .strict();

export const AgentMessageSchema = z
  .object({
    executionId: IdentifierSchema,
    sequence: z.number().int().nonnegative(),
    kind: z.enum(["stdout", "stderr", "status", "artifact", "heartbeat"]),
    occurredAt: IsoDateTimeSchema,
    data: JsonValueSchema.optional(),
    artifact: ArtifactReferenceSchema.optional()
  })
  .strict();

export const AgentTransportInitializationSchema = z
  .object({
    runtimeId: IdentifierSchema,
    configuration: JsonValueSchema,
    recoveryMode: z.boolean(),
    initializedAt: IsoDateTimeSchema
  })
  .strict();

export const AgentTransportCapabilitiesSchema = z
  .object({
    transportName: z.string().min(1),
    supportsStreaming: z.boolean(),
    supportsCancellation: z.boolean(),
    supportsResume: z.boolean(),
    metadata: MetadataSchema.optional()
  })
  .strict();

export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentResultStatus = z.infer<typeof AgentResultStatusSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type AgentExecutionHandle = z.infer<typeof AgentExecutionHandleSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type AgentTransportInitialization = z.infer<typeof AgentTransportInitializationSchema>;
export type AgentTransportCapabilities = z.infer<typeof AgentTransportCapabilitiesSchema>;
