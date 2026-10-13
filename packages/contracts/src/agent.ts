import { z } from "zod";
import { ArtifactProposalSchema, ArtifactReferenceSchema } from "./artifact.js";
import {
  IdempotencyKeySchema,
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

export const AgentSessionLocatorSchema = z
  .object({
    source: z.string().min(1),
    kind: z.enum(["id", "path", "opaque"]),
    value: z.string().min(1)
  })
  .strict();

export const AgentTargetLocatorSchema = z
  .object({
    transport: z.string().min(1),
    agentId: IdentifierSchema,
    workspaceId: IdentifierSchema.optional(),
    tabId: IdentifierSchema.optional(),
    paneId: IdentifierSchema.optional(),
    terminalId: IdentifierSchema.optional(),
    session: AgentSessionLocatorSchema.optional(),
    worktreeId: IdentifierSchema.optional(),
    worktreePath: z.string().min(1).optional(),
    providerData: JsonValueSchema.optional()
  })
  .strict()
  .superRefine((locator, context) => {
    if (locator.paneId === undefined && locator.terminalId === undefined && locator.session === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a durable pane, terminal, or session locator is required"
      });
    }
  });

export const SubmissionCorrelationSchema = z
  .object({
    token: z.string().min(1),
    provenance: z.enum(["remote", "transport", "orchestrator"]),
    verified: z.boolean()
  })
  .strict()
  .superRefine((correlation, context) => {
    if (correlation.provenance === "orchestrator" && correlation.verified) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an orchestrator-generated token cannot prove remote correlation",
        path: ["verified"]
      });
    }
  });

export const AgentRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    attemptId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    role: z.string().min(1),
    target: AgentTargetLocatorSchema,
    instruction: z.string().min(1),
    workingDirectory: z.string().min(1).optional(),
    inputs: z.array(ArtifactReferenceSchema),
    context: JsonValueSchema.optional(),
    attempt: z.number().int().min(1),
    retry: RetryPolicySchema,
    timeout: TimeoutPolicySchema,
    idempotency: IdempotencyPolicySchema.refine((policy) => policy.scope === "agent-request", {
      message: "agent requests require agent-request idempotency scope"
    }),
    createdAt: IsoDateTimeSchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((request, context) => {
    if (request.timeout.deadline !== undefined && Date.parse(request.timeout.deadline) <= Date.parse(request.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "deadline must be after createdAt",
        path: ["timeout", "deadline"]
      });
    }
  });

export const AgentResultStatusSchema = z.enum([
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "timed_out",
  "unverified"
]);

export const AgentOutcomeVerificationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("verified"),
      evidence: z.string().min(1),
      correlation: SubmissionCorrelationSchema
    })
    .strict(),
  z
    .object({
      status: z.literal("unverified"),
      reason: z.string().min(1),
      manualInterventionRequired: z.boolean()
    })
    .strict()
]);

export const AgentResultSchema = z
  .object({
    requestId: IdentifierSchema,
    attemptId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    executionId: IdentifierSchema,
    status: AgentResultStatusSchema,
    verification: AgentOutcomeVerificationSchema,
    output: JsonValueSchema.optional(),
    artifactProposals: z.array(ArtifactProposalSchema),
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
    if (result.status === "unverified" && result.verification.status !== "unverified") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unverified status requires unverified outcome evidence",
        path: ["verification"]
      });
    }
    if (result.status !== "unverified" && result.verification.status !== "verified") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a task outcome requires verified correlation",
        path: ["verification"]
      });
    }
    if (["succeeded", "cancelled", "unverified"].includes(result.status) && result.retryable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${result.status} results cannot be retryable`,
        path: ["retryable"]
      });
    }
    if (
      (result.status === "failed" || result.status === "timed_out") &&
      result.error !== undefined &&
      result.retryable !== result.error.retryable
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "result retryable must match error retryability",
        path: ["retryable"]
      });
    }
    if (result.status === "blocked" && result.blockage !== undefined && result.retryable !== result.blockage.retryable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "result retryable must match blockage retryability",
        path: ["retryable"]
      });
    }
    if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completedAt must not precede startedAt",
        path: ["completedAt"]
      });
    }
    for (const [index, proposal] of result.artifactProposals.entries()) {
      if (proposal.runId !== result.runId || proposal.taskId !== result.taskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "artifact proposal ownership must match the agent result",
          path: ["artifactProposals", index]
        });
      }
    }
  });

export const AgentExecutionHandleSchema = z
  .object({
    executionId: IdentifierSchema,
    requestId: IdentifierSchema,
    attemptId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    idempotencyKey: IdempotencyKeySchema,
    target: AgentTargetLocatorSchema,
    correlation: SubmissionCorrelationSchema,
    acceptedAt: IsoDateTimeSchema,
    resumeCursor: z.string().min(1).optional()
  })
  .strict();

export const AgentSubmissionReceiptSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("accepted"),
        requestId: IdentifierSchema,
        attemptId: IdentifierSchema,
        runId: IdentifierSchema,
        taskId: IdentifierSchema,
        observedAt: IsoDateTimeSchema,
        handle: AgentExecutionHandleSchema
      })
      .strict(),
    z
      .object({
        status: z.literal("rejected"),
        requestId: IdentifierSchema,
        attemptId: IdentifierSchema,
        runId: IdentifierSchema,
        taskId: IdentifierSchema,
        observedAt: IsoDateTimeSchema,
        reason: z.string().min(1)
      })
      .strict(),
    z
      .object({
        status: z.literal("unknown_delivery"),
        requestId: IdentifierSchema,
        attemptId: IdentifierSchema,
        runId: IdentifierSchema,
        taskId: IdentifierSchema,
        idempotencyKey: IdempotencyKeySchema,
        target: AgentTargetLocatorSchema,
        observedAt: IsoDateTimeSchema,
        reason: z.string().min(1),
        resendAllowed: z.literal(false),
        manualInterventionRequired: z.boolean()
      })
      .strict()
  ])
  .superRefine((receipt, context) => {
    if (receipt.status === "accepted" && receipt.requestId !== receipt.handle.requestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "receipt requestId must match handle requestId",
        path: ["handle", "requestId"]
      });
    }
    if (
      receipt.status === "accepted" &&
      (receipt.attemptId !== receipt.handle.attemptId ||
        receipt.runId !== receipt.handle.runId ||
        receipt.taskId !== receipt.handle.taskId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "receipt execution identity must match its handle",
        path: ["handle"]
      });
    }
  });

export const AgentTransportStateSchema = z.enum([
  "starting",
  "accepted",
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
  "disconnected",
  "cancelled"
]);

export const AgentTransportObservationSchema = z
  .object({
    handle: AgentExecutionHandleSchema,
    state: AgentTransportStateSchema,
    observedAt: IsoDateTimeSchema,
    stateChangeSequence: z.number().int().nonnegative().optional(),
    targetRevision: z.number().int().nonnegative().optional(),
    correlationVerified: z.boolean(),
    details: JsonValueSchema.optional()
  })
  .strict();

export const AgentReconciliationRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    attemptId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    idempotencyKey: IdempotencyKeySchema,
    target: AgentTargetLocatorSchema,
    requestedAt: IsoDateTimeSchema
  })
  .strict();

export const AgentReconciliationResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("bound"), handle: AgentExecutionHandleSchema }).strict(),
  z
    .object({
      status: z.literal("not_delivered"),
      requestId: IdentifierSchema,
      retrySafe: z.literal(true),
      observedAt: IsoDateTimeSchema
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown_delivery"),
      requestId: IdentifierSchema,
      retrySafe: z.literal(false),
      observedAt: IsoDateTimeSchema,
      reason: z.string().min(1),
      manualInterventionRequired: z.literal(true)
    })
    .strict()
]);

export const AgentMessageSchema = z
  .object({
    executionId: IdentifierSchema,
    sequence: z.number().int().nonnegative(),
    kind: z.enum(["stdout", "stderr", "status", "artifact", "heartbeat"]),
    occurredAt: IsoDateTimeSchema,
    data: JsonValueSchema.optional(),
    artifactProposal: ArtifactProposalSchema.optional()
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
    protocolVersion: z.string().min(1),
    supportsStreaming: z.boolean(),
    supportsCancellation: z.boolean(),
    supportsResume: z.boolean(),
    supportsSubmissionCorrelation: z.boolean(),
    metadata: MetadataSchema.optional()
  })
  .strict();

export type AgentSessionLocator = z.infer<typeof AgentSessionLocatorSchema>;
export type AgentTargetLocator = z.infer<typeof AgentTargetLocatorSchema>;
export type SubmissionCorrelation = z.infer<typeof SubmissionCorrelationSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentResultStatus = z.infer<typeof AgentResultStatusSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type AgentExecutionHandle = z.infer<typeof AgentExecutionHandleSchema>;
export type AgentSubmissionReceipt = z.infer<typeof AgentSubmissionReceiptSchema>;
export type AgentTransportState = z.infer<typeof AgentTransportStateSchema>;
export type AgentTransportObservation = z.infer<typeof AgentTransportObservationSchema>;
export type AgentReconciliationRequest = z.infer<typeof AgentReconciliationRequestSchema>;
export type AgentReconciliationResult = z.infer<typeof AgentReconciliationResultSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type AgentTransportInitialization = z.infer<typeof AgentTransportInitializationSchema>;
export type AgentTransportCapabilities = z.infer<typeof AgentTransportCapabilitiesSchema>;
