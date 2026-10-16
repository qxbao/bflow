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

export interface MessageProvenance {
  readonly origin: "user" | "coordinator" | "runtime" | "repository" | "unknown";
  readonly authenticatedUser: boolean;
  readonly userId?: string;
  readonly paneId?: string;
  readonly channel?: "herdr_attach" | "cli" | "internal" | "untrusted";
}

export interface UserTurnInput {
  readonly messageId?: string;
  readonly sessionId: string;
  readonly content: string;
  readonly correlationId?: string;
  readonly runId?: string;
  readonly occurredAt?: string;
  readonly provenance?: MessageProvenance;
  readonly repositoryContext?: string;
  readonly inputArtifacts?: readonly ArtifactReference[];
  readonly metadata?: Metadata;
}

export interface ExtractedRequirementDraft {
  readonly title: string;
  readonly objective: string;
  readonly kind: WorkflowRequestKind;
  readonly sddLevel: SddPolicyLevel;
  readonly priority: "low" | "normal" | "high" | "critical";
  readonly scopeDefined: boolean;
  readonly isLargeTask: boolean;
  readonly affectedPaths: readonly string[];
  readonly acceptanceCriteriaDescriptions: readonly string[];
  readonly isRequirementChange: boolean;
  readonly targetRunId?: string;
  readonly targetCorrelationId?: string;
}

export interface ExtractedApprovalInput {
  readonly approvalId?: string;
  readonly decision: "approved" | "rejected" | "changes_requested";
  readonly reason?: string;
}

export interface ExtractedCancellationInput {
  readonly runId?: string;
  readonly taskId?: string;
  readonly reason?: string;
}

export interface IntentClassificationResult {
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

export interface PendingClarificationContext {
  readonly correlationId: string;
  readonly originalRequestText: string;
  readonly accumulatedDetails: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly draft: ExtractedRequirementDraft;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProgressSnapshot {
  readonly taskId?: string;
  readonly sdlcStatus?: SdlcWorkStatus;
  readonly taskState?: "starting" | "running" | "blocked" | "completed" | "failed";
  readonly progressPercentage?: number;
  readonly headline: string;
  readonly blockageReason?: string;
  readonly failureSummary?: string;
  readonly escalated?: boolean;
  readonly updatedAt: string;
  readonly fingerprint: string;
}

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
  readonly lastProgress?: ProgressSnapshot;
  readonly progressHistory: readonly ProgressSnapshot[];
  readonly blockedReason?: string;
  readonly failureReason?: string;
  readonly completedVerified: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PendingInboundItem =
  | {
      readonly queueId: string;
      readonly kind: "coordinator_message";
      readonly enqueuedAt: string;
      readonly message: RoleMessage;
    }
  | {
      readonly queueId: string;
      readonly kind: "user_turn";
      readonly enqueuedAt: string;
      readonly input: UserTurnInput;
    };

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
  readonly handle?: AgentExecutionHandle;
  readonly updatedAt: string;
}

export interface ConversationContextSnapshot {
  readonly schemaVersion: 2;
  readonly session: ConversationSession;
  readonly messages: readonly ConversationMessage[];
  readonly workflows: Readonly<Record<string, WorkflowRequestContext>>;
  readonly runIdToCorrelationId: Readonly<Record<string, string>>;
  readonly pendingClarifications: Readonly<Record<string, PendingClarificationContext>>;
  readonly pendingApprovals: Readonly<Record<string, ApprovalRequest>>;
  readonly approvalDecisions: Readonly<Record<string, ApprovalDecision>>;
  readonly pendingInboundQueue: readonly PendingInboundItem[];
  readonly processedMessageIds: readonly string[];
  readonly deliveryRecords: Readonly<Record<string, DeliveryTrackingRecord>>;
  readonly agentBusy: boolean;
  readonly transportState: AgentTransportState;
}

export interface UserFriendlyResponse {
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
