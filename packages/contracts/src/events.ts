import { z } from "zod";
import {
  AgentExecutionHandleSchema,
  AgentReconciliationResultSchema,
  AgentResultSchema,
  AgentTargetLocatorSchema
} from "./agent.js";
import { ApprovalDecisionSchema, ApprovalRequestSchema } from "./approval.js";
import { ArtifactReferenceSchema } from "./artifact.js";
import {
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataSchema
} from "./common.js";
import {
  BlockageSchema,
  CancellationRequestSchema,
  CancellationResultSchema,
  CancellationStopConfirmationSchema,
  RunStatusSchema,
  TaskStatusSchema
} from "./execution.js";
import { QualityGateResultSchema } from "./quality.js";
import { validateRunTransition, validateTaskTransition } from "./transitions.js";

export const CURRENT_DOMAIN_EVENT_SCHEMA_VERSION = 1 as const;

const eventEnvelopeShape = {
  schemaVersion: z.literal(CURRENT_DOMAIN_EVENT_SCHEMA_VERSION),
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
        intent: z.enum(["normal", "retry", "rework", "cancel"]),
        attempt: z.number().int().nonnegative(),
        generationFrom: z.number().int().nonnegative(),
        generationTo: z.number().int().nonnegative(),
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
        attemptId: IdentifierSchema,
        agentId: IdentifierSchema,
        attempt: z.number().int().min(1),
        target: AgentTargetLocatorSchema
      })
      .strict()
  })
  .strict();

export const AgentExecutionBoundEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("agent.execution_bound"),
    payload: z
      .object({
        handle: AgentExecutionHandleSchema,
        attempt: z.number().int().min(1)
      })
      .strict()
  })
  .strict();

export const AgentDeliveryUncertainEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("agent.delivery_uncertain"),
    payload: z
      .object({
        requestId: IdentifierSchema,
        attemptId: IdentifierSchema,
        target: AgentTargetLocatorSchema,
        reason: z.string().min(1),
        resendAllowed: z.literal(false)
      })
      .strict()
  })
  .strict();

export const AgentDeliveryReconciledEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("agent.delivery_reconciled"),
    payload: AgentReconciliationResultSchema
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

export const ApprovalRequestedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("approval.requested"),
    payload: ApprovalRequestSchema
  })
  .strict();

export const ApprovalDecidedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("approval.decided"),
    payload: ApprovalDecisionSchema
  })
  .strict();

export const QualityGateEvaluationRequestedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("quality_gate.evaluation_requested"),
    payload: z
      .object({
        evaluationId: IdentifierSchema,
        gateId: IdentifierSchema,
        attemptId: IdentifierSchema.optional()
      })
      .strict()
  })
  .strict();

export const QualityGateEvaluatedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("quality_gate.evaluated"),
    payload: QualityGateResultSchema
  })
  .strict();

export const CancellationRequestedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("cancellation.requested"),
    payload: CancellationRequestSchema
  })
  .strict();

export const CancellationAcceptedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("cancellation.accepted"),
    payload: CancellationResultSchema.refine((value) => value.status === "accepted")
  })
  .strict();

export const CancellationRefusedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("cancellation.refused"),
    payload: CancellationResultSchema.refine((value) => value.status !== "accepted")
  })
  .strict();

export const CancellationStopConfirmedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("cancellation.stop_confirmed"),
    payload: CancellationStopConfirmationSchema
  })
  .strict();

export const CheckpointSavedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run.checkpoint_saved"),
    payload: z
      .object({
        checkpointId: IdentifierSchema,
        checkpointSchemaVersion: z.literal(1),
        codecVersion: z.literal(1),
        eventSequence: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

export const DomainEventSchema = z
  .discriminatedUnion("type", [
    RunCreatedEventSchema,
    RunStatusChangedEventSchema,
    TaskStatusChangedEventSchema,
    TaskDispatchRequestedEventSchema,
    AgentExecutionBoundEventSchema,
    AgentDeliveryUncertainEventSchema,
    AgentDeliveryReconciledEventSchema,
    AgentResultRecordedEventSchema,
    ArtifactStoredEventSchema,
    ApprovalRequestedEventSchema,
    ApprovalDecidedEventSchema,
    QualityGateEvaluationRequestedEventSchema,
    QualityGateEvaluatedEventSchema,
    CancellationRequestedEventSchema,
    CancellationAcceptedEventSchema,
    CancellationRefusedEventSchema,
    CancellationStopConfirmedEventSchema,
    CheckpointSavedEventSchema
  ])
  .superRefine((event, context) => {
    const taskScopedTypes = new Set([
      "task.status_changed",
      "task.dispatch_requested",
      "agent.execution_bound",
      "agent.delivery_uncertain",
      "agent.delivery_reconciled",
      "agent.result_recorded"
    ]);
    if (taskScopedTypes.has(event.type) && event.taskId === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "taskId is required for task-scoped events", path: ["taskId"] });
    }
    if (event.type === "task.status_changed") {
      const validation = validateTaskTransition(
        event.payload.from,
        event.payload.to,
        event.payload.intent,
        event.payload.generationTo - event.payload.generationFrom
      );
      if (!validation.valid) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: validation.reason ?? "invalid task transition" });
      }
    }
    if (event.type === "run.status_changed") {
      const validation = validateRunTransition(event.payload.from, event.payload.to);
      if (!validation.valid) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: validation.reason ?? "invalid run transition" });
      }
    }
    if (event.type === "agent.execution_bound") {
      if (event.payload.handle.runId !== event.runId || event.payload.handle.taskId !== event.taskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "bound execution ownership must match the event envelope",
          path: ["payload", "handle"]
        });
      }
    }
    if (event.type === "agent.result_recorded") {
      if (event.payload.runId !== event.runId || event.payload.taskId !== event.taskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "agent result ownership must match the event envelope",
          path: ["payload"]
        });
      }
      if (event.payload.status === "unverified") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unverified transport observations cannot be persisted as task results",
          path: ["payload", "status"]
        });
      }
    }
    if (event.type === "artifact.stored" && event.payload.runId !== event.runId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "artifact runId must match its event", path: ["payload", "runId"] });
    }
    if (
      (event.type === "approval.requested" || event.type === "approval.decided") &&
      event.payload.runId !== event.runId
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "approval runId must match its event", path: ["payload", "runId"] });
    }
    if (event.type === "quality_gate.evaluated" && event.payload.runId !== event.runId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "quality result runId must match its event", path: ["payload", "runId"] });
    }
    if (event.type === "cancellation.requested" && event.payload.runId !== event.runId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "cancellation runId must match its event", path: ["payload", "runId"] });
    }
  });

export type DomainEvent = z.infer<typeof DomainEventSchema>;
