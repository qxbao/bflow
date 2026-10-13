import { z } from "zod";
import { AgentResultSchema } from "./agent.js";
import { ApprovalDecisionSchema } from "./approval.js";
import {
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataSchema,
  PageRequestSchema
} from "./common.js";
import { DomainEventSchema } from "./events.js";
import { RecoveryCheckpointSchema, RunStatusSchema, TaskStatusSchema } from "./execution.js";
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
    reason: z.string().min(1).optional(),
    idempotencyKey: IdempotencyKeySchema,
    occurredAt: IsoDateTimeSchema
  })
  .strict();

export const RecordAgentResultCommandSchema = z
  .object({
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    expectedVersion: z.number().int().nonnegative(),
    result: AgentResultSchema,
    idempotencyKey: IdempotencyKeySchema,
    occurredAt: IsoDateTimeSchema
  })
  .strict();

export const ApplyApprovalCommandSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    decision: ApprovalDecisionSchema,
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

export const AppendEventsRequestSchema = z
  .object({
    runId: IdentifierSchema,
    expectedVersion: z.number().int().nonnegative(),
    events: z.array(DomainEventSchema).min(1),
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();

export const AppendEventsResultSchema = z
  .object({
    version: z.number().int().nonnegative(),
    lastSequence: z.number().int().nonnegative(),
    duplicate: z.boolean()
  })
  .strict();

export type CreateRunCommand = z.infer<typeof CreateRunCommandSchema>;
export type AdvanceRunCommand = z.infer<typeof AdvanceRunCommandSchema>;
export type TaskTransitionCommand = z.infer<typeof TaskTransitionCommandSchema>;
export type RecordAgentResultCommand = z.infer<typeof RecordAgentResultCommandSchema>;
export type ApplyApprovalCommand = z.infer<typeof ApplyApprovalCommandSchema>;
export type RecoverRunCommand = z.infer<typeof RecoverRunCommandSchema>;
export type WorkflowAdvanceResult = z.infer<typeof WorkflowAdvanceResultSchema>;
export type StoredRun = z.infer<typeof StoredRunSchema>;
export type RunQuery = z.infer<typeof RunQuerySchema>;
export type AppendEventsRequest = z.infer<typeof AppendEventsRequestSchema>;
export type AppendEventsResult = z.infer<typeof AppendEventsResultSchema>;
