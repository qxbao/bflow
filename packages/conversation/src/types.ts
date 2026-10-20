import { z } from "zod";
import {
  AcceptanceCriterionSchema,
  AgentExecutionHandleSchema,
  AgentTargetLocatorSchema,
  AgentTransportStateSchema,
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  ArtifactReferenceSchema,
  ConversationMessageSchema,
  ConversationSessionSchema,
  IdempotencyKeySchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  MetadataSchema,
  RoleMessageSchema,
  SddPolicyLevelSchema,
  SdlcWorkStatusSchema
} from "@bflow/contracts";
import type {
  AcceptanceCriterion,
  AgentExecutionHandle,
  AgentRole,
  AgentTargetLocator,
  AgentTransportState,
  ApprovalDecision,
  ApprovalRequest,
  ArtifactReference,
  CancellationRequest,
  ContractError,
  ConversationMessage,
  ConversationSession,
  ConversationSessionStatus,
  DelegationRequest,
  JsonValue,
  OperationResult,
  RoleMessage,
  SddPolicyLevel,
  SdlcWorkStatus,
  TddDecision
} from "@bflow/contracts";

type Metadata = Record<string, JsonValue>;


export const RECOGNIZED_INTENTS = [
  "conversation_only",
  "clarify",
  "workflow_request",
  "status_query",
  "approval_response",
  "cancellation_request"
] as const;

export type RecognizedIntent = (typeof RECOGNIZED_INTENTS)[number];

export type WorkflowRequestKind = "feature" | "bugfix" | "refactor" | "spike";

export const MessageProvenanceSchema = z
  .object({
    origin: z.enum(["user", "coordinator", "runtime", "repository", "unknown"]),
    authenticatedUser: z.boolean(),
    userId: z.string().min(1).optional(),
    paneId: z.string().min(1).optional(),
    channel: z.enum(["herdr_attach", "cli", "internal", "untrusted"]).optional()
  })
  .strict();

export interface MessageProvenance {
  readonly origin: "user" | "coordinator" | "runtime" | "repository" | "unknown";
  readonly authenticatedUser: boolean;
  readonly userId?: string | undefined;
  readonly paneId?: string | undefined;
  readonly channel?: "herdr_attach" | "cli" | "internal" | "untrusted" | undefined;
}

export const UserTurnInputSchema = z
  .object({
    sessionId: IdentifierSchema,
    messageId: IdentifierSchema.optional(),
    content: z.string().refine((val: string) => val.trim().length > 0, {
      message: "UserTurnInput content cannot be empty"
    }),
    occurredAt: IsoDateTimeSchema.optional(),
    correlationId: IdentifierSchema.optional(),
    runId: IdentifierSchema.optional(),
    inputArtifacts: z.array(ArtifactReferenceSchema).optional(),
    provenance: MessageProvenanceSchema.optional(),
    repositoryContext: z.string().optional(),
    conversationDecision: z.lazy(() => ChatDecisionSchema).optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();

export interface UserTurnInput {
  readonly messageId?: string | undefined;
  readonly sessionId: string;
  readonly content: string;
  readonly correlationId?: string | undefined;
  readonly runId?: string | undefined;
  readonly occurredAt?: string | undefined;
  readonly provenance?: MessageProvenance | undefined;
  readonly repositoryContext?: string | undefined;
  readonly inputArtifacts?: readonly ArtifactReference[] | undefined;
  /** Supplied by the authenticated Chat tool, never by the raw user hook. */
  readonly conversationDecision?: ChatDecision | undefined;
  readonly metadata?: Metadata | undefined;
}

/** Mirrors the verificationMethod enum of AcceptanceCriterionSchema in @bflow/contracts (sdlc.ts). */
export const VerificationMethodSchema = z.enum([
  "unit_test",
  "integration_test",
  "e2e_test",
  "typecheck",
  "lint",
  "static_analysis",
  "manual_review"
]);
export type VerificationMethod = z.infer<typeof VerificationMethodSchema>;

export const ExtractedRequirementDraftSchema = z
  .object({
    title: z.string().min(1),
    objective: z.string().min(1),
    kind: z.enum(["feature", "bugfix", "refactor", "spike"]),
    sddLevel: SddPolicyLevelSchema,
    priority: z.enum(["low", "normal", "high", "critical"]),
    scopeDefined: z.boolean(),
    isLargeTask: z.boolean(),
    affectedPaths: z.array(z.string()),
    acceptanceCriteriaDescriptions: z.array(z.string()),
    /** Optional explicit method per criterion, matched by index. Missing entries are inferred. */
    verificationMethods: z.array(VerificationMethodSchema).optional(),
    isRequirementChange: z.boolean(),
    codeChangesAuthorized: z.boolean().optional(),
    targetRunId: IdentifierSchema.optional(),
    targetCorrelationId: IdentifierSchema.optional(),
    investigationTasks: z.array(z.object({ objective: z.string().min(1), affectedPaths: z.array(z.string()), codeChangesAuthorized: z.literal(false) }).strict()).optional()
  })
  .strict();

export interface ExtractedRequirementDraft {
  readonly investigationTasks?: readonly { readonly objective: string; readonly affectedPaths: readonly string[]; readonly codeChangesAuthorized: false }[] | undefined;
  readonly title: string;
  readonly objective: string;
  readonly kind: WorkflowRequestKind;
  readonly sddLevel: SddPolicyLevel;
  readonly priority: "low" | "normal" | "high" | "critical";
  readonly scopeDefined: boolean;
  readonly isLargeTask: boolean;
  readonly affectedPaths: readonly string[];
  readonly acceptanceCriteriaDescriptions: readonly string[];
  readonly verificationMethods?: readonly VerificationMethod[] | undefined;
  readonly isRequirementChange: boolean;
  readonly codeChangesAuthorized?: boolean | undefined;
  readonly targetRunId?: string | undefined;
  readonly targetCorrelationId?: string | undefined;
}

/** Private Chat/host intake protocol. Governance approvals are deliberately absent. */
export const ChatDecisionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("conversation_only"), directReply: z.string().trim().min(1) }).strict(),
  z.object({ intent: z.literal("clarify"), clarifyingQuestions: z.array(z.string().trim().min(1)).min(1).max(3),
    requirementDraft: ExtractedRequirementDraftSchema.optional(), targetCorrelationId: IdentifierSchema.optional() }).strict(),
  z.object({ intent: z.literal("workflow_request"), requirementDraft: ExtractedRequirementDraftSchema,
    targetCorrelationId: IdentifierSchema.optional(), targetRunId: IdentifierSchema.optional() }).strict(),
  z.object({ intent: z.literal("status_query"), targetCorrelationId: IdentifierSchema.optional(), targetRunId: IdentifierSchema.optional() }).strict(),
  z.object({ intent: z.literal("cancellation_request"), cancellationInput: z.object({ runId: IdentifierSchema,
    taskId: IdentifierSchema.optional(), reason: z.string().trim().min(1).optional() }).strict(),
    targetCorrelationId: IdentifierSchema.optional(), targetRunId: IdentifierSchema.optional() }).strict()
]);

export type ChatDecision = z.infer<typeof ChatDecisionSchema>;

export interface ExtractedApprovalInput {
  readonly approvalId?: string;
  readonly decision: "approved" | "rejected" | "changes_requested";
  readonly reason?: string;
  /** Option chosen by the user for a specialist user-decision request. */
  readonly selectedOption?: string;
}

export interface ExtractedCancellationInput {
  readonly runId?: string;
  readonly taskId?: string;
  readonly reason?: string;
}

export interface IntentClassificationResult {
  /** Remaining clauses persisted through the existing inbound FIFO after the primary action. */
  readonly followUpContents?: readonly string[];
  readonly intent: RecognizedIntent;
  readonly confidence: number;
  readonly rationale: string;
  readonly clarifyingQuestions: readonly string[];
  readonly directReply?: string;
  readonly requirementDraft?: ExtractedRequirementDraft;
  readonly approvalInput?: ExtractedApprovalInput;
  readonly cancellationInput?: ExtractedCancellationInput;
  readonly targetCorrelationId?: string;
  readonly targetRunId?: string;
}

export const PendingClarificationContextSchema = z
  .object({
    correlationId: IdentifierSchema,
    originalRequestText: z.string(),
    accumulatedDetails: z.array(z.string()),
    unresolvedQuestions: z.array(z.string()),
    draft: ExtractedRequirementDraftSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export const ClarificationRequestSchema = PendingClarificationContextSchema;

export interface PendingClarificationContext {
  readonly correlationId: string;
  readonly originalRequestText: string;
  readonly accumulatedDetails: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly draft: ExtractedRequirementDraft;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const ProgressSnapshotSchema = z
  .object({
    taskId: IdentifierSchema.optional(),
    sdlcStatus: SdlcWorkStatusSchema.optional(),
    taskState: z.enum(["starting", "running", "blocked", "completed", "failed"]).optional(),
    progressPercentage: z.number().min(0).max(100).optional(),
    headline: z.string().min(1),
    blockageReason: z.string().optional(),
    failureSummary: z.string().optional(),
    escalated: z.boolean().optional(),
    updatedAt: IsoDateTimeSchema,
    fingerprint: z.string().min(1)
  })
  .strict();

export interface ProgressSnapshot {
  readonly taskId?: string | undefined;
  readonly sdlcStatus?: SdlcWorkStatus | undefined;
  readonly taskState?: "starting" | "running" | "blocked" | "completed" | "failed" | undefined;
  readonly progressPercentage?: number | undefined;
  readonly headline: string;
  readonly blockageReason?: string | undefined;
  readonly failureSummary?: string | undefined;
  readonly escalated?: boolean | undefined;
  readonly updatedAt: string;
  readonly fingerprint: string;
}

export const WorkflowRequestContextSchema = z
  .object({
    correlationId: IdentifierSchema,
    sessionId: IdentifierSchema,
    delegationId: IdentifierSchema,
    specificationId: IdentifierSchema,
    runId: IdentifierSchema,
    title: z.string().min(1),
    objective: z.string().min(1),
    kind: z.enum(["feature", "bugfix", "refactor", "spike"]),
    sddLevel: SddPolicyLevelSchema,
    priority: z.enum(["low", "normal", "high", "critical"]),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema),
    sdlcStatus: SdlcWorkStatusSchema,
    revision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    activeApprovalIds: z.array(IdentifierSchema),
    lastProgress: ProgressSnapshotSchema.optional(),
    progressHistory: z.array(ProgressSnapshotSchema),
    blockedReason: z.string().optional(),
    failureReason: z.string().optional(),
    completedVerified: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export interface WorkflowRequestContext {
  readonly correlationId: string;
  readonly sessionId: string;
  readonly delegationId: string;
  readonly specificationId: string;
  readonly runId: string;
  readonly title: string;
  readonly objective: string;
  readonly kind: WorkflowRequestKind;
  readonly sddLevel: SddPolicyLevel;
  readonly priority: "low" | "normal" | "high" | "critical";
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly sdlcStatus: SdlcWorkStatus;
  readonly revision: number;
  readonly generation: number;
  readonly activeApprovalIds: readonly string[];
  readonly lastProgress?: ProgressSnapshot | undefined;
  readonly progressHistory: readonly ProgressSnapshot[];
  readonly blockedReason?: string | undefined;
  readonly failureReason?: string | undefined;
  readonly completedVerified: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Maximum failed processing attempts for one queued item before it is dead-lettered. */
export const MAX_QUEUE_PROCESSING_ATTEMPTS = 3;

/** Optional per-item retry bookkeeping (absent in snapshots written before attempt counting). */
const QueueAttemptFieldsSchema = {
  attempts: z.number().int().nonnegative().optional(),
  lastError: z.string().max(1000).optional()
};

export const PendingInboundItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      queueId: IdentifierSchema,
      kind: z.literal("coordinator_message"),
      enqueuedAt: IsoDateTimeSchema,
      message: RoleMessageSchema,
      ...QueueAttemptFieldsSchema
    })
    .strict(),
  z
    .object({
      queueId: IdentifierSchema,
      kind: z.literal("user_turn"),
      enqueuedAt: IsoDateTimeSchema,
      input: UserTurnInputSchema,
      ...QueueAttemptFieldsSchema
    })
    .strict()
]);

export type PendingInboundItem =
  | {
      readonly queueId: string;
      readonly kind: "coordinator_message";
      readonly enqueuedAt: string;
      readonly message: RoleMessage;
      readonly attempts?: number | undefined;
      readonly lastError?: string | undefined;
    }
  | {
      readonly queueId: string;
      readonly kind: "user_turn";
      readonly enqueuedAt: string;
      readonly input: UserTurnInput;
      readonly attempts?: number | undefined;
      readonly lastError?: string | undefined;
    };

/** A queued item that failed MAX_QUEUE_PROCESSING_ATTEMPTS times. Kept for diagnosis; never retried automatically. */
export const DeadLetterItemSchema = z
  .object({
    queueId: IdentifierSchema,
    deadLetteredAt: IsoDateTimeSchema,
    attempts: z.number().int().positive(),
    reason: z.string().max(1000),
    runId: IdentifierSchema.optional(),
    correlationId: IdentifierSchema.optional(),
    item: PendingInboundItemSchema
  })
  .strict();

export interface DeadLetterItem {
  readonly queueId: string;
  readonly deadLetteredAt: string;
  readonly attempts: number;
  readonly reason: string;
  readonly runId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly item: PendingInboundItem;
}

/** Queue report attached to turn and flush results; only present when there is something to report. */
export interface QueueReport {
  readonly queueFailures?: readonly QueueProcessingFailure[];
  readonly queueNotices?: readonly ConversationMessage[];
  readonly queueFlushError?: ContractError;
}

/** A queued item whose processing failed in this flush pass (retained unless it was dead-lettered). */
export interface QueueProcessingFailure {
  readonly queueId: string;
  readonly kind: PendingInboundItem["kind"];
  readonly attempts: number;
  readonly deadLettered: boolean;
  readonly reason: string;
  readonly runId?: string;
  readonly correlationId?: string;
}

export const DeliveryTrackingRecordSchema = z
  .object({
    messageId: IdentifierSchema,
    requestId: IdentifierSchema,
    attemptId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    correlationId: IdentifierSchema,
    idempotencyKey: IdempotencyKeySchema,
    target: AgentTargetLocatorSchema,
    status: z.enum([
      "accepted",
      "rejected",
      "unknown_delivery",
      "reconciled_not_delivered",
      "reconciled_bound"
    ]),
    resendAllowed: z.boolean(),
    handle: AgentExecutionHandleSchema.optional(),
    updatedAt: IsoDateTimeSchema
  })
  .strict();

export interface DeliveryTrackingRecord {
  readonly messageId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly target: AgentTargetLocator;
  readonly status: "accepted" | "rejected" | "unknown_delivery" | "reconciled_not_delivered" | "reconciled_bound";
  readonly resendAllowed: boolean;
  readonly handle?: AgentExecutionHandle | undefined;
  readonly updatedAt: string;
}

/**
 * An approval that Conversation stopped accepting without a human decision: its run ended (`expired`)
 * or a requirement revision replaced it (`superseded`). Kept so a late reply is refused with a reason.
 */
export const ClosedApprovalSchema = z
  .object({
    approvalId: IdentifierSchema,
    runId: IdentifierSchema,
    status: z.enum(["expired", "superseded"]),
    reason: z.string().min(1).max(500),
    closedAt: IsoDateTimeSchema
  })
  .strict();

export interface ClosedApproval {
  readonly approvalId: string;
  readonly runId: string;
  readonly status: "expired" | "superseded";
  readonly reason: string;
  readonly closedAt: string;
}

export const ConversationContextSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    session: ConversationSessionSchema,
    messages: z.array(ConversationMessageSchema),
    workflows: z.record(IdentifierSchema, WorkflowRequestContextSchema),
    runIdToCorrelationId: z.record(IdentifierSchema, IdentifierSchema),
    pendingClarifications: z.record(IdentifierSchema, PendingClarificationContextSchema),
    pendingApprovals: z.record(IdentifierSchema, ApprovalRequestSchema),
    approvalDecisions: z.record(IdentifierSchema, ApprovalDecisionSchema),
    /** Optional for snapshots written before approval closing; absent means nothing was closed. */
    closedApprovals: z.record(IdentifierSchema, ClosedApprovalSchema).optional(),
    pendingInboundQueue: z.array(PendingInboundItemSchema),
    /** Optional for snapshots written before dead-lettering; absent means no dead letters. */
    deadLetters: z.array(DeadLetterItemSchema).optional(),
    processedMessageIds: z.array(IdentifierSchema),
    deliveryRecords: z.record(IdentifierSchema, DeliveryTrackingRecordSchema),
    agentBusy: z.boolean(),
    transportState: AgentTransportStateSchema
  })
  .strict();

export interface ConversationContextSnapshot {
  readonly schemaVersion: 2;
  readonly session: ConversationSession;
  readonly messages: readonly ConversationMessage[];
  readonly workflows: Readonly<Record<string, WorkflowRequestContext>>;
  readonly runIdToCorrelationId: Readonly<Record<string, string>>;
  readonly pendingClarifications: Readonly<Record<string, PendingClarificationContext>>;
  readonly pendingApprovals: Readonly<Record<string, ApprovalRequest>>;
  readonly approvalDecisions: Readonly<Record<string, ApprovalDecision>>;
  readonly closedApprovals?: Readonly<Record<string, ClosedApproval>> | undefined;
  readonly pendingInboundQueue: readonly PendingInboundItem[];
  readonly deadLetters?: readonly DeadLetterItem[] | undefined;
  readonly processedMessageIds: readonly string[];
  readonly deliveryRecords: Readonly<Record<string, DeliveryTrackingRecord>>;
  readonly agentBusy: boolean;
  readonly transportState: AgentTransportState;
}

export interface UserFriendlyResponse {
  /** A queued proposal became invalid before execution; no handoff was performed. */
  readonly rejectedDecision?: ContractError;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly runId?: string;
  readonly recognizedIntent: RecognizedIntent;
  readonly sessionStatus: ConversationSessionStatus;
  readonly userMessage: ConversationMessage;
  readonly agentReply: ConversationMessage;
  readonly delegationRequest?: DelegationRequest;
  readonly approvalDecision?: ApprovalDecision;
  readonly cancellationRequest?: CancellationRequest;
  readonly outboundRoleMessage?: RoleMessage;
  readonly queuedBecauseBusy: boolean;
  readonly substantiveUpdate: boolean;
  /** Queued items from this flush that failed; never silently dropped. */
  readonly queueFailures?: readonly QueueProcessingFailure[];
  /** User-visible Conversation notices produced by this flush (e.g. dead-lettered items). */
  readonly queueNotices?: readonly ConversationMessage[];
  /** Set when the queue could not be persisted after this turn; the turn itself was saved. */
  readonly queueFlushError?: ContractError;
}

/** Result of registering Runtime-reported pending approvals that Conversation had not recorded. */
export interface ApprovalReconciliation {
  readonly registered: readonly string[];
  readonly alreadyKnown: readonly string[];
  readonly rejected: readonly { readonly approvalId: string; readonly reason: string }[];
  /** Full user-facing question text for each registered user decision (same rendering as a live approval.request). */
  readonly userDecisionPrompts?: readonly string[];
  /** Gateway was mid-turn; nothing changed and the caller may retry. */
  readonly busy?: boolean;
}

export interface CoordinatorUpdateOutcome {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly runId?: string;
  readonly sessionStatus: ConversationSessionStatus;
  readonly queuedBecauseBusy: boolean;
  readonly duplicateIgnored: boolean;
  readonly substantiveUpdate: boolean;
  readonly userNotification?: ConversationMessage;
  readonly approvalPrompted?: ApprovalRequest;
  readonly queueFailures?: readonly QueueProcessingFailure[];
  readonly queueNotices?: readonly ConversationMessage[];
  readonly queueFlushError?: ContractError;
}

export type DangerousContentCategory =
  | "prompt_override"
  | "role_escape"
  | "spoofed_approval"
  | "direct_developer_dispatch"
  | "code_mutation_attempt"
  | "unilateral_completion"
  | "delimiter_breakout";

export interface SafetyFinding {
  readonly category: DangerousContentCategory;
  readonly patternName: string;
  readonly matchedText: string;
  readonly message: string;
}

export interface SafetyInspectionReport {
  readonly safe: boolean;
  readonly findings: readonly SafetyFinding[];
}

export type {
  AcceptanceCriterion,
  AgentExecutionHandle,
  AgentRole,
  AgentTargetLocator,
  AgentTransportState,
  ApprovalDecision,
  ApprovalRequest,
  ArtifactReference,
  CancellationRequest,
  ContractError,
  ConversationMessage,
  ConversationSession,
  ConversationSessionStatus,
  DelegationRequest,
  Metadata,
  OperationResult,
  RoleMessage,
  SddPolicyLevel,
  SdlcWorkStatus,
  TddDecision
};
