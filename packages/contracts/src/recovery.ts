import { z } from "zod";
import { ApprovalDecisionSchema, ApprovalRequestSchema } from "./approval.js";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";
import { CommandReceiptSchema } from "./events.js";
import {
  CancellationRequestSchema, CancellationResultSchema, CancellationStopConfirmationSchema
} from "./execution.js";
import { WorkflowAdvanceResultSchema } from "./orchestration.js";
import { QualityGateBindingSchema } from "./quality.js";
import { GitChangeSetSchema, SpecificationSchema, VerificationCycleSchema } from "./sdlc.js";
import {
  AgentAssignmentSchema,
  ConversationSessionSchema,
  SessionManifestSchema
} from "./session.js";
import { WorkflowRunSnapshotSchema } from "./workflow.js";

export const CreateCheckpointCommandSchema = z.object({
  runId: IdentifierSchema,
  expectedVersion: z.number().int().nonnegative(),
  checkpointId: IdentifierSchema,
  createdAt: IsoDateTimeSchema
}).strict();

export const SdlcRecoveryContextSchema = z
  .object({
    conversationSession: ConversationSessionSchema.optional(),
    sessionManifest: SessionManifestSchema.optional(),
    specifications: z.array(SpecificationSchema).optional(),
    activeAssignments: z.array(AgentAssignmentSchema).optional(),
    verificationCycles: z.array(VerificationCycleSchema).optional(),
    gitChangeSets: z.array(GitChangeSetSchema).optional()
  })
  .strict();

export const WorkflowAggregateCheckpointStateSchema = z.object({
  schemaVersion: z.literal(1),
  snapshot: WorkflowRunSnapshotSchema,
  sdlcContext: SdlcRecoveryContextSchema.optional(),
  approvals: z.array(z.object({ request: ApprovalRequestSchema, decision: ApprovalDecisionSchema.optional() }).strict()),
  gateRequests: z.array(z.object({
    evaluationId: IdentifierSchema,
    gateId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    attemptId: IdentifierSchema.optional(),
    generation: z.number().int().nonnegative(),
    phase: QualityGateBindingSchema.shape.phase
  }).strict()),
  gateOutcomes: z.array(z.object({
    gateId: IdentifierSchema,
    taskId: IdentifierSchema.optional(),
    attemptId: IdentifierSchema.optional(),
    generation: z.number().int().nonnegative(),
    phase: QualityGateBindingSchema.shape.phase,
    status: z.enum(["passed", "failed", "blocked", "error"])
  }).strict()),
  successfulAttempts: z.array(z.object({
    taskId: IdentifierSchema, generation: z.number().int().nonnegative(), attemptId: IdentifierSchema
  }).strict()),
  cancellations: z.array(z.object({
    request: CancellationRequestSchema,
    result: CancellationResultSchema.optional(),
    confirmations: z.array(CancellationStopConfirmationSchema)
  }).strict()),
  retrySchedules: z.array(z.object({
    taskId: IdentifierSchema,
    generation: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    attemptId: IdentifierSchema,
    eligibleAt: IsoDateTimeSchema
  }).strict()),
  attemptBaselines: z.array(z.object({
    taskId: IdentifierSchema,
    generation: z.number().int().nonnegative(),
    baseline: z.number().int().nonnegative()
  }).strict()),
  commands: z.array(z.object({ receipt: CommandReceiptSchema, result: WorkflowAdvanceResultSchema }).strict())
}).strict().superRefine((state, context) => {
  const seen = new Set<string>();
  const unique = (kind: string, key: string, path: (string | number)[]) => {
    const identity = `${kind}\u0000${key}`;
    if (seen.has(identity)) context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate ${kind}: ${key}`, path });
    seen.add(identity);
  };
  state.snapshot.tasks.forEach((task, index) => unique("task", task.taskId, ["snapshot", "tasks", index]));
  state.approvals.forEach((item, index) => {
    unique("approval", item.request.approvalId, ["approvals", index]);
    if (item.request.runId !== state.snapshot.runId || item.decision?.runId !== undefined && item.decision.runId !== state.snapshot.runId ||
      item.decision !== undefined && (item.decision.approvalId !== item.request.approvalId ||
        JSON.stringify(item.decision.target) !== JSON.stringify(item.request.target) ||
        item.decision.generation !== item.request.generation || item.decision.revision !== item.request.revision)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "approval ownership or decision mismatch", path: ["approvals", index] });
    }
  });
  state.gateRequests.forEach((item, index) => unique("gate request", item.evaluationId, ["gateRequests", index]));
  state.cancellations.forEach((item, index) => {
    unique("cancellation", item.request.cancellationId, ["cancellations", index]);
    if (item.request.runId !== state.snapshot.runId ||
      item.result !== undefined && item.result.cancellationId !== item.request.cancellationId ||
      item.confirmations.some((confirmation) => confirmation.cancellationId !== item.request.cancellationId) ||
      new Set(item.confirmations.map((confirmation) => confirmation.executionId ?? "unbound")).size !==
        item.confirmations.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "cancellation ownership mismatch", path: ["cancellations", index] });
    }
  });
  state.commands.forEach((item, index) => {
    unique("command", item.receipt.idempotencyKey, ["commands", index]);
    if (item.result.snapshot.runId !== state.snapshot.runId || item.result.snapshot.version > state.snapshot.version) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "command result position or run mismatch", path: ["commands", index] });
    }
  });
});

export type CreateCheckpointCommand = z.infer<typeof CreateCheckpointCommandSchema>;
export type SdlcRecoveryContext = z.infer<typeof SdlcRecoveryContextSchema>;
export type WorkflowAggregateCheckpointState = z.infer<typeof WorkflowAggregateCheckpointStateSchema>;
