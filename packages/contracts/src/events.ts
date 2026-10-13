import { z } from "zod";
import { AgentResultSchema } from "./agent.js";
import { ApprovalDecisionSchema } from "./approval.js";
import { ArtifactReferenceSchema } from "./artifact.js";
import {
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataSchema
} from "./common.js";
import { BlockageSchema, CancellationRequestSchema, RunStatusSchema, TaskStatusSchema } from "./execution.js";
import { QualityGateResultSchema } from "./quality.js";

const eventEnvelopeShape = {
  eventId: IdentifierSchema,
  runId: IdentifierSchema,
  taskId: IdentifierSchema.optional(),
  sequence: z.number().int().nonnegative(),
  aggregateVersion: z.number().int().nonnegative(),
  occurredAt: IsoDateTimeSchema,
  correlationId: IdentifierSchema,
  causationId: IdentifierSchema.optional(),
  idempotencyKey: IdempotencyKeySchema,
  metadata: MetadataSchema.optional()
};

export const RunCreatedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run.created"),
    payload: z
      .object({
        workflowId: IdentifierSchema,
        workflowVersion: z.string().min(1),
        input: JsonValueSchema.optional()
      })
      .strict()
  })
  .strict();

export const RunStatusChangedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run.status_changed"),
    payload: z
      .object({
        from: RunStatusSchema,
        to: RunStatusSchema,
        reason: z.string().min(1).optional()
      })
      .strict()
  })
  .strict();

export const TaskStatusChangedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("task.status_changed"),
    payload: z
      .object({
        from: TaskStatusSchema,
        to: TaskStatusSchema,
        attempt: z.number().int().nonnegative(),
        blockage: BlockageSchema.optional(),
        reason: z.string().min(1).optional()
      })
      .strict()
  })
  .strict();

export const TaskDispatchRequestedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("task.dispatch_requested"),
    payload: z
      .object({
        requestId: IdentifierSchema,
        agentId: IdentifierSchema,
        attempt: z.number().int().min(1)
      })
      .strict()
  })
  .strict();

export const AgentResultRecordedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("agent.result_recorded"),
    payload: AgentResultSchema
  })
  .strict();

export const ArtifactStoredEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("artifact.stored"),
    payload: ArtifactReferenceSchema
  })
  .strict();

export const ApprovalDecidedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("approval.decided"),
    payload: ApprovalDecisionSchema
  })
  .strict();

export const QualityGateEvaluatedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("quality_gate.evaluated"),
    payload: QualityGateResultSchema
  })
  .strict();

export const RunCancellationRequestedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run.cancellation_requested"),
    payload: CancellationRequestSchema
  })
  .strict();

export const CheckpointSavedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run.checkpoint_saved"),
    payload: z
      .object({
        checkpointId: IdentifierSchema,
        eventSequence: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

export const DomainEventSchema = z.discriminatedUnion("type", [
  RunCreatedEventSchema,
  RunStatusChangedEventSchema,
  TaskStatusChangedEventSchema,
  TaskDispatchRequestedEventSchema,
  AgentResultRecordedEventSchema,
  ArtifactStoredEventSchema,
  ApprovalDecidedEventSchema,
  QualityGateEvaluatedEventSchema,
  RunCancellationRequestedEventSchema,
  CheckpointSavedEventSchema
]);

export type DomainEvent = z.infer<typeof DomainEventSchema>;
