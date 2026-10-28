import { z } from "zod";
import { ExecutionContinuationSchema } from "./agent.js";
import {
  AgentExecutionHandleSchema,
  AgentReconciliationResultSchema,
  AgentResultSchema
} from "./agent.js";
import { ApprovalDecisionSchema, ApprovalRequestSchema } from "./approval.js";
import {
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataSchema,
  PageRequestSchema
} from "./common.js";
import { DomainEventSchema, type DomainEvent } from "./events.js";
import {
  CancellationResultSchema,
  CancellationStopConfirmationSchema,
  RecoveryCheckpointSchema,
  RunStatusSchema,
  TaskStatusSchema
} from "./execution.js";
import { QualityGateResultSchema } from "./quality.js";
import { validateTaskTransition } from "./transitions.js";
import { WorkflowDefinitionSchema, WorkflowRunSnapshotSchema } from "./workflow.js";

export const CreateRunCommandSchema = z
  .object({
    runId: IdentifierSchema,
    definition: WorkflowDefinitionSchema,
    input: JsonValueSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
    createdAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export const AdvanceRunCommandSchema = z
  .object({
    runId: IdentifierSchema,
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: IdempotencyKeySchema,
    occurredAt: IsoDateTimeSchema
  })
  .strict();

export const TaskTransitionCommandSchema = z
  .object({
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    expectedVersion: z.number().int().nonnegative(),
    from: TaskStatusSchema,
    to: TaskStatusSchema,
    intent: z.enum(["normal", "retry", "rework", "cancel"]),
    generationFrom: z.number().int().nonnegative(),
    generationTo: z.number().int().nonnegative(),
    reason: z.string().min(1).optional(),
    idempotencyKey: IdempotencyKeySchema,
    occurredAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((command, context) => {
    const validation = validateTaskTransition(
      command.from,
      command.to,
      command.intent,
      command.generationTo - command.generationFrom
    );
    if (!validation.valid) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: validation.reason ?? "invalid task transition" });
    }
  });

export const BindAgentExecutionCommandSchema = z
  .object({
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    expectedVersion: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    handle: AgentExecutionHandleSchema,
    continuation: ExecutionContinuationSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
    occurredAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((command, context) => {
    if (command.handle.runId !== command.runId || command.handle.taskId !== command.taskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "execution handle ownership must match the command",
        path: ["handle"]
      });
    }
  });

export const RecordDeliveryReconciliationCommandSchema = z
  .object({
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    expectedVersion: z.number().int().nonnegative(),
    requestId: IdentifierSchema,
    result: AgentReconciliationResultSchema,
    idempotencyKey: IdempotencyKeySchema,
    occurredAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((command, context) => {
    if (command.result.status === "bound" && command.result.handle.requestId !== command.requestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reconciled handle requestId must match command requestId",
        path: ["result", "handle", "requestId"]
      });
    }
    if (command.result.status !== "bound" && command.result.requestId !== command.requestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reconciliation result requestId must match command requestId",
        path: ["result", "requestId"]
      });
    }
  });

export const RecordAgentResultCommandSchema = z
  .object({
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    expectedVersion: z.number().int().nonnegative(),
    result: AgentResultSchema,
    idempotencyKey: IdempotencyKeySchema,
    occurredAt: IsoDateTimeSchema
  })
  .strict()
  .superRefine((command, context) => {
    if (command.result.status === "unverified") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unverified transport observations cannot be recorded as task results",
        path: ["result"]
      });
    }
  });

export const RequestApprovalCommandSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    request: ApprovalRequestSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export const ApplyApprovalCommandSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    decision: ApprovalDecisionSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export const EvaluateQualityGateCommandSchema = z
  .object({
    runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    evaluationId: IdentifierSchema,
    gateId: IdentifierSchema,
    attemptId: IdentifierSchema.optional(),
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: IdempotencyKeySchema,
    occurredAt: IsoDateTimeSchema
  })
  .strict();

export const RecordQualityGateResultCommandSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    result: QualityGateResultSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export const RecordCancellationResultCommandSchema = z
  .object({
    runId: IdentifierSchema,
    expectedVersion: z.number().int().nonnegative(),
    result: CancellationResultSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export const ConfirmCancellationStopCommandSchema = z
  .object({
    runId: IdentifierSchema,
    expectedVersion: z.number().int().nonnegative(),
    confirmation: CancellationStopConfirmationSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export const RecoverRunCommandSchema = z
  .object({
    runId: IdentifierSchema,
    checkpoint: RecoveryCheckpointSchema.optional(),
    events: z.array(DomainEventSchema),
    expectedVersion: z.number().int().nonnegative()
  })
  .strict();

export const WorkflowAdvanceResultSchema = z
  .object({
    snapshot: WorkflowRunSnapshotSchema,
    runnableTaskIds: z.array(IdentifierSchema),
    emittedEvents: z.array(DomainEventSchema)
  })
  .strict();

export const StoredRunSchema = z
  .object({
    snapshot: WorkflowRunSnapshotSchema,
    definition: WorkflowDefinitionSchema
  })
  .strict();

export const RunQuerySchema = PageRequestSchema.extend({
  workflowId: IdentifierSchema.optional(),
  status: z.array(RunStatusSchema).optional(),
  createdAfter: IsoDateTimeSchema.optional(),
  createdBefore: IsoDateTimeSchema.optional()
}).strict();

export interface EventBatchValidationIssue {
  readonly index: number;
  readonly field: "runId" | "sequence" | "aggregateVersion" | "eventId" | "idempotencyKey";
  readonly message: string;
}

export interface EventBatchCandidate {
  readonly runId: string;
  readonly expectedVersion: number;
  readonly expectedLastSequence: number;
  readonly events: readonly DomainEvent[];
}

export function validateEventBatch(batch: EventBatchCandidate): readonly EventBatchValidationIssue[] {
  const issues: EventBatchValidationIssue[] = [];
  const eventIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  batch.events.forEach((event, index) => {
    const expectedSequence = batch.expectedLastSequence + index + 1;
    const expectedAggregateVersion = batch.expectedVersion + index + 1;
    if (event.runId !== batch.runId) {
      issues.push({ index, field: "runId", message: "event runId does not match batch runId" });
    }
    if (event.sequence !== expectedSequence) {
      issues.push({ index, field: "sequence", message: `expected sequence ${expectedSequence}` });
    }
    if (event.aggregateVersion !== expectedAggregateVersion) {
      issues.push({
        index,
        field: "aggregateVersion",
        message: `expected aggregateVersion ${expectedAggregateVersion}`
      });
    }
    if (eventIds.has(event.eventId)) {
      issues.push({ index, field: "eventId", message: "duplicate eventId in batch" });
    }
    if (idempotencyKeys.has(event.idempotencyKey)) {
      issues.push({ index, field: "idempotencyKey", message: "duplicate event idempotencyKey in batch" });
    }
    eventIds.add(event.eventId);
    idempotencyKeys.add(event.idempotencyKey);
  });
  return issues;
}

export const AppendEventsRequestSchema = z
  .object({
    runId: IdentifierSchema,
    expectedVersion: z.number().int().nonnegative(),
    expectedLastSequence: z.number().int().nonnegative(),
    events: z.array(DomainEventSchema).min(1),
    idempotencyKey: IdempotencyKeySchema
  })
  .strict()
  .superRefine((request, context) => {
    for (const issue of validateEventBatch(request)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: ["events", issue.index, issue.field]
      });
    }
  });

export const AppendEventsResultSchema = z
  .object({
    version: z.number().int().nonnegative(),
    lastSequence: z.number().int().nonnegative(),
    duplicate: z.boolean(),
    duplicateEventIds: z.array(IdentifierSchema)
  })
  .strict();

export type CreateRunCommand = z.infer<typeof CreateRunCommandSchema>;
export type AdvanceRunCommand = z.infer<typeof AdvanceRunCommandSchema>;
export type TaskTransitionCommand = z.infer<typeof TaskTransitionCommandSchema>;
export type BindAgentExecutionCommand = z.infer<typeof BindAgentExecutionCommandSchema>;
export type RecordDeliveryReconciliationCommand = z.infer<typeof RecordDeliveryReconciliationCommandSchema>;
export type RecordAgentResultCommand = z.infer<typeof RecordAgentResultCommandSchema>;
export type RequestApprovalCommand = z.infer<typeof RequestApprovalCommandSchema>;
export type ApplyApprovalCommand = z.infer<typeof ApplyApprovalCommandSchema>;
export type EvaluateQualityGateCommand = z.infer<typeof EvaluateQualityGateCommandSchema>;
export type RecordQualityGateResultCommand = z.infer<typeof RecordQualityGateResultCommandSchema>;
export type RecordCancellationResultCommand = z.infer<typeof RecordCancellationResultCommandSchema>;
export type ConfirmCancellationStopCommand = z.infer<typeof ConfirmCancellationStopCommandSchema>;
export type RecoverRunCommand = z.infer<typeof RecoverRunCommandSchema>;
export type WorkflowAdvanceResult = z.infer<typeof WorkflowAdvanceResultSchema>;
export type StoredRun = z.infer<typeof StoredRunSchema>;
export type RunQuery = z.infer<typeof RunQuerySchema>;
export type AppendEventsRequest = z.infer<typeof AppendEventsRequestSchema>;
export type AppendEventsResult = z.infer<typeof AppendEventsResultSchema>;
