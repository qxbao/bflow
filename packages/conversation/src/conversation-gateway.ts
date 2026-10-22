import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  ApprovalRequestSchema,
  CancellationRequestSchema,
  ContractErrorSchema,
  ConversationMessageSchema,
  DelegationRequestSchema,
  type AgentTransportState,
  type ApprovalRequest,
  type ConversationMessage,
  type ConversationSession,
  type ConversationSessionStatus,
  type ContractError,
  type OperationOptions,
  type OperationResult,
  type SdlcWorkStatus
} from "@bflow/contracts";

import type { ConversationContextStore } from "./context-store.js";
import {
  buildApprovalDecision,
  buildCancellationRequest,
  buildDelegationRequest
} from "./delegation-builder.js";
import { HerdrConversationBridge } from "./herdr-bridge.js";
import { classifyUserIntent } from "./intent-classifier.js";
import { resolveChatDecision } from "./chat-decision.js";
import { closeClarificationsForApproval, expireStaleClarifications } from "./clarification-lifecycle.js";
import { closedApprovalNotice, isTerminalRunStatus, supersededApprovals } from "./approval-lifecycle.js";
import {
  isUserDecisionRequest,
  optionPosition,
  renderUserDecisionOutcome,
  renderUserDecisionPrompt,
  userDecisionExpiredApprovalId
} from "./user-decision.js";
import {
  formatCoordinatorMessageForUser,
  formatStatusSummaryForUser
} from "./response-formatter.js";
import {
  assertConversationRoleBoundaries,
  inspectRepositoryContentSafety,
  verifyUserApprovalProvenance
} from "./safety.js";
import { sanitizeReasonForUser, wrapUntrustedRepositoryContent } from "./safety.js";
import {
  MAX_QUEUE_PROCESSING_ATTEMPTS,
  RuntimeCancellationTargetSchema,
  UserTurnInputSchema,
  type ApprovalReconciliation,
  type CancellationBatch,
  type ClosedApproval,
  type DeadLetterItem,
  type QueueProcessingFailure,
  type QueueReport,
  type ConversationContextSnapshot,
  type CoordinatorUpdateOutcome,
  type ExtractedRequirementDraft,
  type PendingClarificationContext,
  type PendingInboundItem,
  type UserFriendlyResponse,
  type UserTurnInput,
  type WorkflowRequestContext
} from "./types.js";

/**
 * Configuration options for ConversationGateway.
 */
export interface ConversationGatewayConfig {
  readonly sessionId: string;
  readonly herdrSessionId: string;
  readonly conversationAgentId?: string; // default "chat"
  readonly paneId: string;
  readonly bridge: HerdrConversationBridge;
  readonly contextStore: ConversationContextStore;
  readonly now?: () => string;
  readonly idGenerator?: (prefix: string) => string;
}

/**
 * ConversationGateway is the central coordinator for the Conversation Agent in Herdr.
 *
 * Responsibilities:
 * 1. Sole user interface for requirement intake, clarification dialogue, status queries, and approval mediation.
 * 2. Strict architectural boundary enforcement (no direct developer assignment, no source code modification, no unilateral task completion).
 * 3. Structured DelegationRequest creation and handoff to Coordinator Agent via Herdr RoleMessage envelopes.
 * 4. Multi-workflow session management preserving independent correlation IDs and run IDs.
 * 5. Busy-state FIFO queueing ensuring zero message loss when chat is actively processing or working.
 * 6. Crash recovery via ConversationContextStore.
 */
export class ConversationGateway {
  readonly config: ConversationGatewayConfig;
  private snapshot: ConversationContextSnapshot | null = null;
  private isProcessingTurn = false;
  private isFlushingQueue = false;
  private isDrainingSingleQueueItem = false;

  constructor(config: ConversationGatewayConfig) {
    this.config = config;
    this.config.bridge.setInboundMessageHandler((msg, opts) => this.handleCoordinatorRoleMessage(msg, opts));
  }

  /**
   * Persists an updated snapshot while safely preserving any items appended
   * to pendingInboundQueue concurrently during async turn execution or storage I/O.
   */
  private async persistUpdatedSnapshot(
    candidate: ConversationContextSnapshot,
    removedQueueIds?: ReadonlySet<string>
  ): Promise<OperationResult<ConversationContextSnapshot>> {
    // 1. Merge any items currently in this.snapshot.pendingInboundQueue that are not yet in candidate.pendingInboundQueue
    // (unless candidate explicitly removed a specific queueId in removedQueueIds during flush)
    const candidateQueueIds = new Set(candidate.pendingInboundQueue.map((item) => item.queueId));
    const currentQueue = this.snapshot?.pendingInboundQueue ?? [];
    const missingItems: PendingInboundItem[] = [];

    for (const item of currentQueue) {
      if (!candidateQueueIds.has(item.queueId)) {
        if (!removedQueueIds || !removedQueueIds.has(item.queueId)) {
          missingItems.push(item);
        }
      }
    }

    let toSave: ConversationContextSnapshot = {
      ...candidate,
      pendingInboundQueue: [...candidate.pendingInboundQueue, ...missingItems]
    };

    // Update in-memory snapshot immediately so any concurrent tick observes merged state
    this.snapshot = toSave;

    const saveRes = await this.config.contextStore.save(toSave);
    if (!saveRes.ok) {
      return saveRes;
    }

    // 2. Check if new items were appended to this.snapshot.pendingInboundQueue while awaiting save()
    const latestQueue = this.snapshot?.pendingInboundQueue ?? [];
    const savedQueueIds = new Set(saveRes.value.pendingInboundQueue.map((item) => item.queueId));
    const newArrivalsDuringSave: PendingInboundItem[] = [];

    for (const item of latestQueue) {
      if (!savedQueueIds.has(item.queueId)) {
        if (!removedQueueIds || !removedQueueIds.has(item.queueId)) {
          newArrivalsDuringSave.push(item);
        }
      }
    }

    if (newArrivalsDuringSave.length > 0) {
      const doubleMerged: ConversationContextSnapshot = {
        ...saveRes.value,
        pendingInboundQueue: [...saveRes.value.pendingInboundQueue, ...newArrivalsDuringSave]
      };
      this.snapshot = doubleMerged;
      const secondSaveRes = await this.config.contextStore.save(doubleMerged);
      if (!secondSaveRes.ok) {
        return secondSaveRes;
      }
      this.snapshot = secondSaveRes.value;
      return { ok: true, value: this.snapshot };
    }

    this.snapshot = saveRes.value;
    return { ok: true, value: this.snapshot };
  }

  private getNow(): string {
    return this.config.now ? this.config.now() : new Date().toISOString();
  }

  private generateId(prefix: string): string {
    if (this.config.idGenerator) {
      return this.config.idGenerator(prefix);
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  private generateTurnId(input: UserTurnInput, prefix: string): string {
    return input.conversationDecision && input.messageId
      ? `${prefix}-${createHash("sha256").update(JSON.stringify([this.config.sessionId, input.messageId, prefix])).digest("hex")}`
      : this.generateId(prefix);
  }

  private async rejectQueuedDecision(
    item: Extract<PendingInboundItem, { kind: "user_turn" }>, error: ContractError
  ): Promise<OperationResult<UserFriendlyResponse>> {
    const input = item.input, now = this.getNow();
    const correlationId = input.conversationDecision && "targetCorrelationId" in input.conversationDecision
      ? input.conversationDecision.targetCorrelationId ?? this.generateTurnId(input, "corr")
      : this.generateTurnId(input, "corr");
    const userMessage = ConversationMessageSchema.parse({ schemaVersion: 2, sessionId: this.config.sessionId,
      messageId: input.messageId, correlationId, turnSequence: this.snapshot!.session.turnCount + 1,
      sender: "user", recipient: "conversation", intent: "user_request", content: input.content,
      artifactReferences: input.inputArtifacts ?? [], createdAt: input.occurredAt ?? now,
      metadata: { conversationDecision: input.conversationDecision } });
    const agentReply = ConversationMessageSchema.parse({ schemaVersion: 2, sessionId: this.config.sessionId,
      messageId: this.generateTurnId(input, "msg-rejected"), correlationId, turnSequence: userMessage.turnSequence + 1,
      sender: "conversation", recipient: "user", intent: "error_report",
      content: `Yêu cầu trong hàng đợi không còn hợp lệ và chưa được thực thi: ${error.message}`,
      artifactReferences: [], createdAt: now, metadata: { rejectedDecision: error } });
    const saved = await this.persistUpdatedSnapshot({ ...this.snapshot!,
      session: { ...this.snapshot!.session, turnCount: agentReply.turnSequence, updatedAt: now },
      messages: [...this.snapshot!.messages, userMessage, agentReply],
      pendingInboundQueue: this.snapshot!.pendingInboundQueue.filter(pending => pending.queueId !== item.queueId)
    }, new Set([item.queueId]));
    if (!saved.ok) return saved;
    return { ok: true, value: { sessionId: this.config.sessionId, correlationId, recognizedIntent: "conversation_only",
      sessionStatus: saved.value.session.status, userMessage, agentReply, rejectedDecision: error,
      queuedBecauseBusy: false, substantiveUpdate: true } };
  }

  private validateConversationMessages(...messages: readonly ConversationMessage[]): OperationResult<void> {
    for (const msg of messages) {
      const parsed = ConversationMessageSchema.safeParse(msg);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "validation",
            retryable: false,
            message: `Invalid ConversationMessage: ${parsed.error.message}`,
            details: JSON.parse(JSON.stringify(parsed.error.issues))
          }
        };
      }
    }
    return { ok: true, value: undefined };
  }

  /**
   * Returns current memory snapshot. Throws if not initialized.
   */
  getContextSnapshot(): ConversationContextSnapshot {
    if (!this.snapshot) {
      throw new Error("ConversationGateway is not initialized. Call initializeOrRecoverSession() first.");
    }
    return this.snapshot;
  }

  /**
   * Initializes a fresh session or recovers state from ConversationContextStore.
   */
  async initializeOrRecoverSession(): Promise<OperationResult<ConversationContextSnapshot>> {
    const loadResult = await this.config.contextStore.load(this.config.sessionId);
    if (!loadResult.ok) {
      return loadResult;
    }

    if (loadResult.value !== null) {
      this.snapshot = loadResult.value;
      this.config.bridge.restoreDeliveryRecords(this.snapshot.deliveryRecords);
      return { ok: true, value: this.snapshot };
    }

    const now = this.getNow();
    const session: ConversationSession = {
      schemaVersion: 2,
      sessionId: this.config.sessionId,
      herdrSessionId: this.config.herdrSessionId,
      conversationAgentId: this.config.conversationAgentId ?? "chat",
      paneId: this.config.paneId,
      status: "active",
      activeApprovalIds: [],
      turnCount: 0,
      unresolvedQuestions: [],
      createdAt: now,
      updatedAt: now
    };

    const initialSnapshot: ConversationContextSnapshot = {
      schemaVersion: 2,
      session,
      messages: [],
      workflows: {},
      runIdToCorrelationId: {},
      pendingClarifications: {},
      pendingApprovals: {},
      approvalDecisions: {},
      pendingInboundQueue: [],
      processedMessageIds: [],
      deliveryRecords: {},
      agentBusy: false,
      transportState: "idle"
    };

    const saveResult = await this.config.contextStore.save(initialSnapshot);
    if (!saveResult.ok) {
      return saveResult;
    }

    this.snapshot = saveResult.value;
    return { ok: true, value: this.snapshot };
  }

  /**
   * Sets whether the chat agent is currently busy/working.
   *
   * Invariant: Even if transportState becomes "done", setAgentBusyState(false, "done")
   * NEVER marks any workflow or ConversationSession.status as "completed".
   *
   * Automatically flushes pending inbound messages when transitioning from busy=true to busy=false.
   */
  async setAgentBusyState(
    busy: boolean,
    transportState?: AgentTransportState
  ): Promise<OperationResult<ConversationContextSnapshot & QueueReport>> {
    if (!this.snapshot) {
      const initResult = await this.initializeOrRecoverSession();
      if (!initResult.ok) {
        return initResult;
      }
    }

    const currentSnapshot = this.snapshot!;
    const nextTransportState = transportState ?? (busy ? "working" : "idle");

    const updatedSnapshot: ConversationContextSnapshot = {
      ...currentSnapshot,
      agentBusy: busy,
      transportState: nextTransportState
    };

    const saveResult = await this.persistUpdatedSnapshot(updatedSnapshot);
    if (!saveResult.ok) {
      return saveResult;
    }

    if (!busy && this.snapshot!.pendingInboundQueue.length > 0) {
      const flushed = await this.flushPendingInboundQueue();
      if (!flushed.ok) return flushed;
      return { ok: true, value: { ...this.snapshot!, ...queueReportOf(flushed.value) } };
    }

    return { ok: true, value: this.snapshot! };
  }

  /** User-facing text for an approval reply that names no pending approval. Nothing is applied. */
  private unknownApprovalNotice(approvalId: string | undefined, alreadyDecided: boolean): string {
    if (approvalId === undefined) {
      return "Hiện không có phê duyệt nào đang chờ bạn, nên phản hồi của bạn chưa được ghi nhận. Hỏi \"trạng thái\" để xem tiến độ hiện tại.";
    }
    return [
      `Không tìm thấy phê duyệt ${approvalId} đang chờ trong session này${alreadyDecided ? " (đã được quyết định trước đó)" : " (mã sai, đã hết hạn hoặc đã được xử lý)"}.`,
      "Phản hồi của bạn chưa được ghi nhận và không có quyết định nào được áp dụng.",
      `👉 Hỏi "trạng thái" để xem danh sách phê duyệt đang chờ, rồi trả lời đúng mã: \`${approvalId}: approve\` hoặc \`${approvalId}: reject <lý do>\`.`
    ].join("\n");
  }

  /** User-facing text for an approval reply that was refused, with the reason and the way to answer. */
  private rejectedReplyNotice(approvalId: string, reason: string, offered: readonly string[] | undefined): string {
    const choices = offered && offered.length > 0 ? `\n${offered.map((option, index) => `${index + 1}. ${option}`).join("\n")}` : "";
    return [
      `Phản hồi cho ${approvalId} chưa được ghi nhận: ${sanitizeReasonForUser(reason, 300)}`,
      `👉 Trả lời lại bằng \`${approvalId}: <số hoặc nội dung lựa chọn>\`, hoặc \`${approvalId}: từ chối <lý do>\`.${choices}`
    ].join("\n");
  }

  /**
   * Handles an incoming user message turn, then drains any queued items that are now processable.
   * Queue failures and dead letters from that drain are returned with the turn, never discarded.
   */
  async handleUserTurn(
    input: UserTurnInput,
    options?: OperationOptions
  ): Promise<OperationResult<UserFriendlyResponse & QueueReport>> {
    const result = await this.handleUserTurnCore(input, options);
    return this.withQueueReportAfterTurn(result, options);
  }

  /**
   * Handles an incoming user message turn (queue drain excluded, see handleUserTurn).
   */
  private async handleUserTurnCore(
    input: UserTurnInput,
    options?: OperationOptions
  ): Promise<OperationResult<UserFriendlyResponse>> {
    const parsedInput = UserTurnInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: parsedInput.error.issues.map((i: { path: readonly (string | number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; "),
          details: JSON.parse(JSON.stringify(parsedInput.error.issues))
        }
      };
    }
    input = parsedInput.data;
    if (input.sessionId !== this.config.sessionId || (input.conversationDecision && !input.messageId)) {
      return { ok: false, error: { code: "validation", retryable: false,
        message: "Chat decisions require a user message ID in the current Conversation session" } };
    }

    if (!this.snapshot) {
      const initResult = await this.initializeOrRecoverSession();
      if (!initResult.ok) {
        return initResult;
      }
    }

    const now = this.getNow();
    const requestedAt = input.conversationDecision ? input.occurredAt ?? now : now;
    const decisionReceipt = input.conversationDecision
      ? { metadata: { conversationDecision: JSON.parse(JSON.stringify(input.conversationDecision)) } } : {};

    // Recover an already committed decision after a lost MCP response or host restart.
    if (input.conversationDecision && input.messageId) {
      const userMessage = this.snapshot!.messages.find(message => message.sender === "user" && message.messageId === input.messageId);
      if (userMessage) {
        if (userMessage.content !== input.content || !isDeepStrictEqual(userMessage.metadata?.conversationDecision, input.conversationDecision)) {
          return { ok: false, error: { code: "validation", retryable: false, message: "Conflicting Chat decision for an already processed user turn" } };
        }
        const agentReply = this.snapshot!.messages.find(message => message.sender === "conversation" && message.turnSequence === userMessage.turnSequence + 1);
        if (!agentReply) return { ok: false, error: { code: "corruption", retryable: false, message: "Committed user turn is missing its Conversation reply" } };
        // A failed save can leave an optimistic in-memory candidate. Repair it before
        // the host is allowed to journal a final result for this retry.
        const repaired = await this.persistUpdatedSnapshot(this.snapshot!);
        if (!repaired.ok) return repaired;
        const delegation = agentReply.metadata?.delegationRequest;
        const cancellation = agentReply.metadata?.cancellationRequest;
        const rejection = agentReply.metadata?.rejectedDecision;
        return { ok: true, value: { sessionId: this.config.sessionId, correlationId: userMessage.correlationId,
          ...(userMessage.runId ? { runId: userMessage.runId } : {}), recognizedIntent: rejection ? "conversation_only" : input.conversationDecision.intent,
          sessionStatus: this.snapshot!.session.status, userMessage, agentReply, queuedBecauseBusy: false,
          substantiveUpdate: input.conversationDecision.intent !== "conversation_only",
          ...(delegation ? { delegationRequest: DelegationRequestSchema.parse(delegation) } : {}),
          ...(rejection ? { rejectedDecision: ContractErrorSchema.parse(rejection) } : {}),
          ...(cancellation ? { cancellationRequest: CancellationRequestSchema.parse(cancellation) } : {}) } };
      }
    }

    const frozenBatch = input.messageId ? this.snapshot!.cancellationBatches?.[input.messageId] : undefined;
    if (frozenBatch && (frozenBatch.input.content !== input.content ||
        !isDeepStrictEqual(frozenBatch.input.conversationDecision, input.conversationDecision))) {
      return { ok: false, error: { code: "validation", retryable: false, message: "Conflicting Chat decision for a pending cancellation batch" } };
    }

    // 1. Busy-State Queueing (Requirement 10): Zero message loss
    const shouldQueue =
      (this.isProcessingTurn || this.isFlushingQueue || (this.snapshot!.agentBusy === true && input.conversationDecision?.intent !== "cancellation_request")) &&
      !this.isDrainingSingleQueueItem;

    if (shouldQueue) {
      const pending = input.conversationDecision && input.messageId
        ? this.snapshot!.pendingInboundQueue.find(item => item.kind === "user_turn" && item.input.messageId === input.messageId)
        : undefined;
      if (pending?.kind === "user_turn" && (pending.input.content !== input.content ||
          !isDeepStrictEqual(pending.input.conversationDecision, input.conversationDecision))) {
        return { ok: false, error: { code: "validation", retryable: false, message: "Conflicting Chat decision for a queued user turn" } };
      }
      const queueItem: PendingInboundItem = pending ?? {
        queueId: this.generateId("queue-user"),
        kind: "user_turn",
        enqueuedAt: now,
        input
      };

      const updatedQueue = pending ? this.snapshot!.pendingInboundQueue : [...this.snapshot!.pendingInboundQueue, queueItem];
      const queuedSnapshot: ConversationContextSnapshot = {
        ...this.snapshot!,
        pendingInboundQueue: updatedQueue
      };

      const saveRes = await this.persistUpdatedSnapshot(queuedSnapshot);
      if (!saveRes.ok) {
        return saveRes;
      }

      const userCorrelationId =
        input.correlationId ??
        (this.snapshot!.session.activeRunId
          ? this.snapshot!.runIdToCorrelationId[this.snapshot!.session.activeRunId] ?? "corr-busy"
          : "corr-busy");

      const userMsg: ConversationMessage = {
        schemaVersion: 2,
        messageId: input.messageId ?? this.generateId("msg-user"),
        sessionId: this.config.sessionId,
        correlationId: userCorrelationId,
        turnSequence: this.snapshot!.session.turnCount + 1,
        sender: "user",
        ...decisionReceipt,
        recipient: "conversation",
        intent: "user_request",
        content: input.content,
        artifactReferences: input.inputArtifacts ? [...input.inputArtifacts] : [],
        createdAt: input.occurredAt ?? now
      };

      const agentReply: ConversationMessage = {
        schemaVersion: 2,
        messageId: this.generateId("msg-chat"),
        sessionId: this.config.sessionId,
        correlationId: userCorrelationId,
        turnSequence: this.snapshot!.session.turnCount + 2,
        sender: "conversation",
        recipient: "user",
        intent: "progress_update",
        content:
          "Yêu cầu của bạn đã được đưa vào hàng đợi an toàn vì tác tử đang bận xử lý. Tôi sẽ xử lý ngay khi hoàn tất lượt này.",
        artifactReferences: [],
        createdAt: now
      };

      const msgValidation = this.validateConversationMessages(userMsg, agentReply);
      if (!msgValidation.ok) {
        return msgValidation;
      }

      return {
        ok: true,
        value: {
          sessionId: this.config.sessionId,
          correlationId: userCorrelationId,
          recognizedIntent: "conversation_only",
          sessionStatus: this.snapshot!.session.status,
          userMessage: userMsg,
          agentReply,
          queuedBecauseBusy: true,
          substantiveUpdate: false
        }
      };
    }

    // 2. Acquire in-flight lock for processing this turn
    this.isProcessingTurn = true;

    try {
      // 3. Safety inspection of repositoryContext if present (all 7 categories)
      if (input.repositoryContext) {
        const repoSafety = inspectRepositoryContentSafety(input.repositoryContext);
        if (!repoSafety.safe) {
          return {
            ok: false,
            error: {
              code: "validation",
              retryable: false,
              message: `Malicious injection detected in repository content: ${repoSafety.findings.map((f) => `[${f.category}] ${f.message}`).join("; ")}`
            }
          };
        }
      }

      // Authenticated human dialogue may quote unsafe strings for analysis. Keep repository
      // scanning and the legacy ingress policy; enforce Chat's actions through schema/role gates.
      const trustedChatTurn = input.conversationDecision !== undefined &&
        input.provenance?.origin === "user" && input.provenance.authenticatedUser === true;
      const contentSafety = trustedChatTurn ? { safe: true, findings: [] } : inspectRepositoryContentSafety(input.content);
      if (!contentSafety.safe) {
        return {
          ok: false,
          error: {
            code: "validation",
            retryable: false,
            message: `Malicious input detected in user content: ${contentSafety.findings.map((f) => `[${f.category}] ${f.message}`).join("; ")}`
          }
        };
      }

      // Clarifications idle past their TTL are closed before any reply can be matched to them.
      const unexpired = expireStaleClarifications(this.snapshot!, now);
      if (unexpired !== this.snapshot) {
        const pruned = await this.persistUpdatedSnapshot(unexpired);
        if (!pruned.ok) return pruned;
      }

      // 4. Classify user intent
      const classificationResult = frozenBatch
        ? { ok: true as const, value: { intent: "cancellation_request" as const, confidence: 1, rationale: "Resume frozen cancellation plan",
            clarifyingQuestions: [], cancellationInput: { runIds: frozenBatch.items.map(item => item.runId) },
            ...(frozenBatch.items.length === 1 ? { targetRunId: frozenBatch.items[0]!.runId,
              targetCorrelationId: frozenBatch.items[0]!.delegation.correlationId } : {}) } }
        : input.conversationDecision
        ? resolveChatDecision(input.conversationDecision, this.snapshot!)
        : classifyUserIntent(input, this.snapshot!);
      if (!classificationResult.ok) {
        return classificationResult;
      }
      const classification = classificationResult.value;

      // 5. Determine stable correlationId
      const isIndependentRequest = (classification.intent === "workflow_request" || classification.intent === "clarify") && !classification.targetCorrelationId;
      const inputCorrelationInUse = input.correlationId !== undefined &&
        (this.snapshot!.pendingClarifications[input.correlationId] !== undefined || this.snapshot!.workflows[input.correlationId] !== undefined);
      let correlationId = classification.targetCorrelationId ??
        (isIndependentRequest && inputCorrelationInUse ? undefined : input.correlationId);
      // A pending clarification's correlation is reused only when the classifier identified this turn
      // as answering it (classification.targetCorrelationId). Any other turn must not adopt it.
      if (correlationId !== undefined && correlationId !== classification.targetCorrelationId &&
          this.snapshot!.pendingClarifications[correlationId] !== undefined) {
        correlationId = undefined;
      }
      if (!correlationId && (classification.intent === "status_query" || classification.intent === "approval_response") &&
          this.snapshot!.session.activeRunId) {
        // Status and approval turns address the active run, not a clarification.
        correlationId = this.snapshot!.runIdToCorrelationId[this.snapshot!.session.activeRunId];
      }
      if (!correlationId) {
        correlationId = this.generateTurnId(input, "corr");
      }

      const turnSeq = this.snapshot!.session.turnCount;
      const userTurnSequence = turnSeq + 1;
      const agentTurnSequence = turnSeq + 2;

      // 6. Branch by recognized intent
      switch (classification.intent) {
        case "conversation_only": {
          const userMsg: ConversationMessage = {
            schemaVersion: 2,
            messageId: input.messageId ?? this.generateId("msg-user"),
            sessionId: this.config.sessionId,
            correlationId,
            turnSequence: userTurnSequence,
            sender: "user",
            ...decisionReceipt,
            recipient: "conversation",
            intent: "user_request",
            content: input.content,
            artifactReferences: input.inputArtifacts ? [...input.inputArtifacts] : [],
            createdAt: input.occurredAt ?? now
          };

          const agentReply: ConversationMessage = {
            schemaVersion: 2,
            messageId: this.generateId("msg-chat"),
            sessionId: this.config.sessionId,
            correlationId,
            turnSequence: agentTurnSequence,
            sender: "conversation",
            recipient: "user",
            intent: "progress_update",
            content:
              classification.directReply ??
              "Tôi là Bflow Conversation Agent (chat). Bạn có thể yêu cầu tôi thực hiện tính năng, sửa lỗi, kiểm tra tiến độ hoặc phê duyệt công việc.",
            artifactReferences: [],
            createdAt: now
          };

          const msgValidation = this.validateConversationMessages(userMsg, agentReply);
          if (!msgValidation.ok) return msgValidation;

          const updatedSession: ConversationSession = {
            ...this.snapshot!.session,
            turnCount: agentTurnSequence,
            updatedAt: now
          };

          const updatedSnapshot: ConversationContextSnapshot = {
            ...this.snapshot!,
            session: updatedSession,
            messages: [...this.snapshot!.messages, userMsg, agentReply]
          };

          const saveRes = await this.persistUpdatedSnapshot(updatedSnapshot);
          if (!saveRes.ok) return saveRes;

          return {
            ok: true,
            value: {
              sessionId: this.config.sessionId,
              correlationId,
              recognizedIntent: "conversation_only",
              sessionStatus: this.snapshot!.session.status,
              userMessage: userMsg,
              agentReply,
              queuedBecauseBusy: false,
              substantiveUpdate: false
            }
          };
        }

        case "clarify": {
          const userMsg: ConversationMessage = {
            schemaVersion: 2,
            messageId: input.messageId ?? this.generateId("msg-user"),
            sessionId: this.config.sessionId,
            correlationId,
            turnSequence: userTurnSequence,
            sender: "user",
            ...decisionReceipt,
            recipient: "conversation",
            intent: "user_request",
            content: input.content,
            artifactReferences: input.inputArtifacts ? [...input.inputArtifacts] : [],
            createdAt: input.occurredAt ?? now
          };

          const questions = classification.clarifyingQuestions;
          const questionsFormatted =
            questions.length > 0
              ? questions.map((q, idx) => `${idx + 1}. ${q}`).join("\n")
              : "Vui lòng cung cấp thêm thông tin về phạm vi và tiêu chí nghiệm thu của yêu cầu.";

          const agentReply: ConversationMessage = {
            schemaVersion: 2,
            messageId: this.generateId("msg-chat"),
            sessionId: this.config.sessionId,
            correlationId,
            turnSequence: agentTurnSequence,
            sender: "conversation",
            recipient: "user",
            intent: "clarification_question",
            content: `Để đảm bảo triển khai chính xác, tôi cần làm rõ một số điểm sau trước khi chuyển cho Coordinator:\n\n${questionsFormatted}`,
            artifactReferences: [],
            createdAt: now
          };

          const msgValidation = this.validateConversationMessages(userMsg, agentReply);
          if (!msgValidation.ok) return msgValidation;

          const draft: ExtractedRequirementDraft = classification.requirementDraft ?? {
            title: input.content.slice(0, 60),
            objective: input.content,
            kind: "feature",
            sddLevel: "lightweight",
            priority: "normal",
            scopeDefined: false,
            isLargeTask: false,
            affectedPaths: [],
            acceptanceCriteriaDescriptions: [],
            isRequirementChange: false
          };

          const previousClarification = this.snapshot!.pendingClarifications[correlationId];
          const pendingClarification: PendingClarificationContext = {
            correlationId,
            originalRequestText: previousClarification?.originalRequestText ?? input.content,
            accumulatedDetails: [...(previousClarification?.accumulatedDetails ?? []), input.content],
            unresolvedQuestions: [...questions],
            draft,
            createdAt: now,
            updatedAt: now
          };

          const updatedPendingClarifications = {
            ...this.snapshot!.pendingClarifications,
            [correlationId]: pendingClarification
          };
          // Only questions that were actually asked are listed; no generic placeholder is ever recorded.
          const openQuestions = Object.values(updatedPendingClarifications).flatMap((c) => c.unresolvedQuestions);

          const updatedSession: ConversationSession = {
            ...this.snapshot!.session,
            status: openQuestions.length > 0 ? "awaiting_user_clarification" : "active",
            unresolvedQuestions: openQuestions,
            turnCount: agentTurnSequence,
            updatedAt: now
          };

          const updatedSnapshot: ConversationContextSnapshot = {
            ...this.snapshot!,
            session: updatedSession,
            messages: [...this.snapshot!.messages, userMsg, agentReply],
            pendingClarifications: updatedPendingClarifications
          };

          const saveRes = await this.persistUpdatedSnapshot(updatedSnapshot);
          if (!saveRes.ok) return saveRes;

          return {
            ok: true,
            value: {
              sessionId: this.config.sessionId,
              correlationId,
              recognizedIntent: "clarify",
              sessionStatus: this.snapshot!.session.status,
              userMessage: userMsg,
              agentReply,
              queuedBecauseBusy: false,
              substantiveUpdate: true
            }
          };
        }

        case "workflow_request": {
          const draft = classification.requirementDraft!;
          const messageId = this.generateTurnId(input, "msg-delegation");
          const runId = classification.targetRunId ?? this.generateTurnId(input, "run");
          const isRequirementChange = draft.isRequirementChange;

          const existingWorkflow = this.snapshot!.workflows[correlationId];
          // Runtime may recover a durable intake before this turn's Conversation save. That projection
          // already carries this exact delegation; replay must preserve its revision and envelope.
          const sameDelegation = input.conversationDecision && existingWorkflow?.delegationId === this.generateTurnId(input, "del");
          const revision = existingWorkflow ? existingWorkflow.revision + (sameDelegation ? 0 : 1) : 1;

          const delegationResult = buildDelegationRequest({
            sessionId: this.config.sessionId,
            correlationId,
            messageId,
            runId,
            draft,
            ...(input.inputArtifacts ? { inputArtifacts: input.inputArtifacts } : {}),
            requestedAt,
            revision,
            ...(input.conversationDecision ? {
              previousDelegationId: this.generateTurnId(input, "del"),
              idempotencyKey: this.generateTurnId(input, "idemp-del")
            } : {})
          });

          if (!delegationResult.ok) {
            return delegationResult;
          }

          const delegationRequest = delegationResult.value;

          const userMsg: ConversationMessage = {
            schemaVersion: 2,
            messageId: input.messageId ?? this.generateId("msg-user"),
            sessionId: this.config.sessionId,
            correlationId,
            runId,
            turnSequence: userTurnSequence,
            sender: "user",
            ...decisionReceipt,
            recipient: "conversation",
            intent: isRequirementChange ? "clarification_answer" : "user_request",
            content: input.content,
            artifactReferences: input.inputArtifacts ? [...input.inputArtifacts] : [],
            createdAt: input.occurredAt ?? now
          };

          const agentReply: ConversationMessage = {
            schemaVersion: 2,
            messageId: this.generateId("msg-chat"),
            sessionId: this.config.sessionId,
            correlationId,
            runId,
            turnSequence: agentTurnSequence,
            sender: "conversation",
            recipient: "user",
            intent: "delegation_handoff",
            ...(input.conversationDecision ? { metadata: { delegationRequest: JSON.parse(JSON.stringify(delegationRequest)) } } : {}),
            content: (isRequirementChange
              ? `Tôi đã gửi bản cập nhật yêu cầu (phiên bản ${revision}) qua Herdr; đang chờ Runtime/Coordinator xác nhận tiếp nhận.`
              : `Yêu cầu "${draft.title}" đã được gửi qua Herdr; đang chờ Runtime/Coordinator xác nhận tiếp nhận. Tôi sẽ cập nhật tiến độ khi có thông báo.`) +
              (classification.followUpContents?.length ? ` Yêu cầu tiếp theo được lưu vào hàng đợi để xử lý riêng: ${classification.followUpContents.join("; ")}` : ""),
            artifactReferences: [],
            createdAt: now
          };

          const msgValidation = this.validateConversationMessages(userMsg, agentReply);
          if (!msgValidation.ok) return msgValidation;

          // Handoff to Coordinator via Herdr bridge
          const handOffResult = await this.config.bridge.handOffToCoordinator(delegationRequest, options);
          if (!handOffResult.ok) {
            return handOffResult;
          }

          const workflowContext: WorkflowRequestContext = {
            correlationId,
            sessionId: this.config.sessionId,
            delegationId: delegationRequest.delegationId,
            specificationId: delegationRequest.specificationId,
            runId,
            title: draft.title,
            objective: draft.objective,
            kind: draft.kind,
            sddLevel: draft.sddLevel,
            priority: draft.priority,
            acceptanceCriteria: [...delegationRequest.acceptanceCriteria],
            sdlcStatus: "intake",
            revision,
            generation: existingWorkflow ? existingWorkflow.generation : 0,
            activeApprovalIds: [],
            progressHistory: existingWorkflow ? existingWorkflow.progressHistory : [],
            completedVerified: false,
            createdAt: existingWorkflow ? existingWorkflow.createdAt : now,
            updatedAt: now
          };

          const updatedWorkflows = {
            ...this.snapshot!.workflows,
            [correlationId]: workflowContext
          };

          const updatedRunIdToCorrelationId = {
            ...this.snapshot!.runIdToCorrelationId,
            [runId]: correlationId
          };

          // A new independent request supersedes every abandoned clarification; a requirement change only closes its own.
          const independentRequest = !isRequirementChange && existingWorkflow === undefined &&
            this.snapshot!.pendingClarifications[correlationId] === undefined;
          const updatedPendingClarifications = independentRequest ? {} : { ...this.snapshot!.pendingClarifications };
          delete updatedPendingClarifications[correlationId];

          const remainingUnresolvedQuestions = Object.values(updatedPendingClarifications).flatMap(
            (c) => c.unresolvedQuestions
          );

          const updatedSession: ConversationSession = {
            ...this.snapshot!.session,
            status: "delegated_to_coordinator",
            activeRunId: runId,
            specificationId: delegationRequest.specificationId,
            unresolvedQuestions: remainingUnresolvedQuestions,
            turnCount: agentTurnSequence,
            updatedAt: now
          };

          const updatedSnapshot: ConversationContextSnapshot = {
            ...this.snapshot!,
            session: updatedSession,
            messages: [...this.snapshot!.messages, userMsg, agentReply],
            workflows: updatedWorkflows,
            runIdToCorrelationId: updatedRunIdToCorrelationId,
            pendingClarifications: updatedPendingClarifications,
            pendingInboundQueue: [...this.snapshot!.pendingInboundQueue, ...(classification.followUpContents ?? []).map(content => ({
              queueId: this.generateId("queue-followup"), kind: "user_turn" as const, enqueuedAt: now,
              input: { sessionId: input.sessionId, content, provenance: input.provenance, inputArtifacts: input.inputArtifacts }
            }))],
            deliveryRecords: this.config.bridge.getAllDeliveryRecords()
          };

          const saveRes = await this.persistUpdatedSnapshot(updatedSnapshot);
          if (!saveRes.ok) return saveRes;

          return {
            ok: true,
            value: {
              sessionId: this.config.sessionId,
              correlationId,
              runId,
              recognizedIntent: "workflow_request",
              sessionStatus: this.snapshot!.session.status,
              userMessage: userMsg,
              agentReply,
              delegationRequest,
              queuedBecauseBusy: false,
              substantiveUpdate: true
            }
          };
        }

        case "status_query": {
          const statusSummary = formatStatusSummaryForUser(
            this.snapshot!,
            classification.targetCorrelationId ?? input.correlationId
          );

          const userMsg: ConversationMessage = {
            schemaVersion: 2,
            messageId: input.messageId ?? this.generateId("msg-user"),
            sessionId: this.config.sessionId,
            correlationId,
            turnSequence: userTurnSequence,
            sender: "user",
            ...decisionReceipt,
            recipient: "conversation",
            intent: "user_request",
            content: input.content,
            artifactReferences: input.inputArtifacts ? [...input.inputArtifacts] : [],
            createdAt: input.occurredAt ?? now
          };

          const agentReply: ConversationMessage = {
            schemaVersion: 2,
            messageId: this.generateId("msg-chat"),
            sessionId: this.config.sessionId,
            correlationId,
            turnSequence: agentTurnSequence,
            sender: "conversation",
            recipient: "user",
            intent: "progress_update",
            content: statusSummary,
            artifactReferences: [],
            createdAt: now
          };

          const msgValidation = this.validateConversationMessages(userMsg, agentReply);
          if (!msgValidation.ok) return msgValidation;

          const updatedSession: ConversationSession = {
            ...this.snapshot!.session,
            turnCount: agentTurnSequence,
            updatedAt: now
          };

          const updatedSnapshot: ConversationContextSnapshot = {
            ...this.snapshot!,
            session: updatedSession,
            messages: [...this.snapshot!.messages, userMsg, agentReply]
          };

          const saveRes = await this.persistUpdatedSnapshot(updatedSnapshot);
          if (!saveRes.ok) return saveRes;

          return {
            ok: true,
            value: {
              sessionId: this.config.sessionId,
              correlationId,
              recognizedIntent: "status_query",
              sessionStatus: this.snapshot!.session.status,
              userMessage: userMsg,
              agentReply,
              queuedBecauseBusy: false,
              substantiveUpdate: false
            }
          };
        }

        case "approval_response": {
          // Rule 7 & Invariant: Only accept approvals with verified user provenance
          const provenanceCheck = verifyUserApprovalProvenance(
            input.provenance,
            input.repositoryContext,
            input.content
          );
          if (!provenanceCheck.ok) {
            return provenanceCheck;
          }

          const approvalInput = classification.approvalInput;
          if (!approvalInput) {
            return {
              ok: false,
              error: {
                code: "validation",
                retryable: false,
                message: "No approval decision details provided in message"
              }
            };
          }

          // Locate pending approval. A named apr-... id must match exactly: it never falls back to
          // another pending approval, which could approve something the user did not name.
          let targetApproval: ApprovalRequest | undefined;
          if (approvalInput.approvalId) {
            targetApproval = this.snapshot!.pendingApprovals[approvalInput.approvalId];
            if (!targetApproval) {
              const closed = this.snapshot!.closedApprovals?.[approvalInput.approvalId];
              if (closed) return this.answerWithNotice(input, correlationId, closedApprovalNotice(closed), closed.runId);
              return this.answerWithNotice(input, correlationId,
                this.unknownApprovalNotice(approvalInput.approvalId, this.snapshot!.approvalDecisions[approvalInput.approvalId] !== undefined));
            }
          } else {
            // Without an explicit id, a design/task approval is preferred over a specialist user decision.
            const pendingList = Object.values(this.snapshot!.pendingApprovals);
            const orderedPending = [
              ...pendingList.filter((request) => !isUserDecisionRequest(request)),
              ...pendingList.filter((request) => isUserDecisionRequest(request))
            ];
            // With several pending approvals an id-less reply is ambiguous; never guess which one the user meant.
            if (orderedPending.length > 1) {
              return this.answerWithNotice(input, correlationId, [
                "Đang có nhiều phê duyệt/câu hỏi chờ bạn, nên phản hồi không ghi mã chưa được ghi nhận:",
                ...orderedPending.map((request) => `- \`${request.approvalId}\`: ${sanitizeReasonForUser(request.reason, 200)}`),
                "👉 Trả lời kèm đúng mã, ví dụ `apr-…: approve` hoặc `apr-…: <số lựa chọn>`."
              ].join("\n"));
            }
            if (orderedPending.length === 1) {
              targetApproval = orderedPending[0];
            }
          }

          if (!targetApproval) {
            return this.answerWithNotice(input, correlationId, this.unknownApprovalNotice(undefined, false));
          }

          // Specialist user decisions: the selected option must be one that was offered and the
          // request must still be live. Validation failures never fall back to a default option.
          if (isUserDecisionRequest(targetApproval)) {
            const rawOffered = targetApproval.metadata?.options;
            const offered = Array.isArray(rawOffered)
              ? rawOffered.filter((option): option is string => typeof option === "string")
              : undefined;
            const selected = approvalInput.selectedOption;
            if (approvalInput.decision === "approved" && offered !== undefined && (selected === undefined || !offered.includes(selected))) {
              return this.answerWithNotice(input, correlationId, this.rejectedReplyNotice(targetApproval.approvalId,
                "Hãy trả lời bằng số hoặc đúng nội dung một lựa chọn trong danh sách.", offered));
            }
            if (selected !== undefined && (offered === undefined || !offered.includes(selected))) {
              return this.answerWithNotice(input, correlationId, this.rejectedReplyNotice(targetApproval.approvalId,
                "Lựa chọn bạn gửi không nằm trong danh sách đã đưa ra.", offered));
            }
            if (targetApproval.expiresAt !== undefined && Date.parse(now) >= Date.parse(targetApproval.expiresAt)) {
              return this.answerWithNotice(input, correlationId, this.rejectedReplyNotice(targetApproval.approvalId,
                "Câu hỏi này đã hết hạn và không còn nhận trả lời.", undefined));
            }
          }

          // The 1-based position is sent with the option text so Coordinator sees the same choice the prompt numbered.
          const chosenPosition = isUserDecisionRequest(targetApproval) && approvalInput.selectedOption !== undefined
            ? optionPosition(targetApproval, approvalInput.selectedOption)
            : undefined;
          const decisionResult = buildApprovalDecision({
            approvalRequest: targetApproval,
            decision: approvalInput.decision,
            decidedBy: input.provenance?.userId ?? "user",
            decidedAt: now,
            reason: approvalInput.reason ?? (approvalInput.decision === "approved" ? "User approved" : "User rejected"),
            provenance: input.provenance,
            repositoryContext: input.repositoryContext,
            userContent: input.content,
            feedbackArtifacts: [],
            metadata: {
              ...(targetApproval.metadata ?? {}),
              ...(approvalInput.selectedOption !== undefined ? { selectedOption: approvalInput.selectedOption } : {}),
              ...(chosenPosition !== undefined ? { selectedOptionIndex: chosenPosition } : {}),
              correlationId
            }
          });

          if (!decisionResult.ok) {
            return this.answerWithNotice(input, correlationId, this.rejectedReplyNotice(targetApproval.approvalId,
              decisionResult.error.message, undefined));
          }

          const approvalDecision = decisionResult.value;

          const userMsg: ConversationMessage = {
            schemaVersion: 2,
            messageId: input.messageId ?? this.generateId("msg-user"),
            sessionId: this.config.sessionId,
            correlationId,
            runId: targetApproval.runId,
            turnSequence: userTurnSequence,
            sender: "user",
            ...decisionReceipt,
            recipient: "conversation",
            intent: "approval_response",
            content: input.content,
            artifactReferences: input.inputArtifacts ? [...input.inputArtifacts] : [],
            createdAt: input.occurredAt ?? now
          };

          const agentReply: ConversationMessage = {
            schemaVersion: 2,
            messageId: this.generateId("msg-chat"),
            sessionId: this.config.sessionId,
            correlationId,
            runId: targetApproval.runId,
            turnSequence: agentTurnSequence,
            sender: "conversation",
            recipient: "user",
            intent: "progress_update",
            content: `${isUserDecisionRequest(targetApproval)
              ? renderUserDecisionOutcome({ approvalId: targetApproval.approvalId, decision: approvalDecision.decision,
                selectedOption: approvalInput.selectedOption, optionPosition: chosenPosition })
              : `Quyết định phê duyệt [${approvalDecision.decision.toUpperCase()}] cho "${targetApproval.reason}"`} đã được gửi qua Herdr; đang chờ Runtime/Coordinator xác nhận.`,
            artifactReferences: [],
            createdAt: now
          };

          const msgValidation = this.validateConversationMessages(userMsg, agentReply);
          if (!msgValidation.ok) return msgValidation;

          // Send approval decision to Coordinator via Herdr bridge
          const sendDecisionResult = await this.config.bridge.receiveApprovalDecision(
            approvalDecision,
            options
          );
          if (!sendDecisionResult.ok) {
            return sendDecisionResult;
          }

          const updatedPendingApprovals = { ...this.snapshot!.pendingApprovals };
          delete updatedPendingApprovals[targetApproval.approvalId];

          const updatedActiveApprovalIds = this.snapshot!.session.activeApprovalIds.filter(
            (id) => id !== targetApproval!.approvalId
          );

          // Remove targetApproval.approvalId from targetWorkflow.activeApprovalIds
          const targetWorkflow =
            this.snapshot!.workflows[correlationId] ??
            Object.values(this.snapshot!.workflows).find((w) => w.runId === targetApproval!.runId);

          const updatedWorkflows = { ...this.snapshot!.workflows };
          if (targetWorkflow) {
            updatedWorkflows[targetWorkflow.correlationId] = {
              ...targetWorkflow,
              activeApprovalIds: targetWorkflow.activeApprovalIds.filter(
                (id) => id !== targetApproval!.approvalId
              ),
              updatedAt: now
            };
          }

          const updatedApprovalDecisions = {
            ...this.snapshot!.approvalDecisions,
            [approvalDecision.approvalId]: approvalDecision
          };

          const nextSessionStatus: ConversationSessionStatus =
            updatedActiveApprovalIds.length > 0 ? "awaiting_user_approval" : "reporting_progress";

          const updatedSession: ConversationSession = {
            ...this.snapshot!.session,
            status: nextSessionStatus,
            activeApprovalIds: updatedActiveApprovalIds,
            turnCount: agentTurnSequence,
            updatedAt: now
          };

          const updatedSnapshot: ConversationContextSnapshot = closeClarificationsForApproval({
            ...this.snapshot!,
            session: updatedSession,
            messages: [...this.snapshot!.messages, userMsg, agentReply],
            workflows: updatedWorkflows,
            pendingApprovals: updatedPendingApprovals,
            approvalDecisions: updatedApprovalDecisions,
            deliveryRecords: this.config.bridge.getAllDeliveryRecords()
          }, targetApproval.approvalId, now);

          const saveRes = await this.persistUpdatedSnapshot(updatedSnapshot);
          if (!saveRes.ok) return saveRes;

          return {
            ok: true,
            value: {
              sessionId: this.config.sessionId,
              correlationId,
              runId: targetApproval.runId,
              recognizedIntent: "approval_response",
              sessionStatus: this.snapshot!.session.status,
              userMessage: userMsg,
              agentReply,
              approvalDecision,
              queuedBecauseBusy: false,
              substantiveUpdate: true
            }
          };
        }

        case "cancellation_request": {
          const cancelInput = classification.cancellationInput;
          const batchKey = input.messageId ?? this.generateId("cancel-batch");
          let batch = this.snapshot!.cancellationBatches?.[batchKey];
          const saveBatch = async (): Promise<OperationResult<unknown>> => this.persistUpdatedSnapshot({ ...this.snapshot!,
            cancellationBatches: { ...this.snapshot!.cancellationBatches, [batchKey]: batch! },
            deliveryRecords: this.config.bridge.getAllDeliveryRecords() });
          if (!batch) {
            const targets = cancelInput?.runIds ?? [cancelInput?.runId ?? classification.targetRunId ?? this.snapshot!.session.activeRunId]
              .filter((id): id is string => id !== undefined);
            const items: CancellationBatch["items"] = [];
            for (const targetRunId of targets) {
              const runtimeTarget = this.snapshot!.runtimeCancellationTargets?.[targetRunId];
              const targetWorkflow = Object.values(this.snapshot!.workflows).find(w => w.runId === targetRunId) ??
                (runtimeTarget ? { sessionId: runtimeTarget.delegation.sessionId, correlationId: runtimeTarget.delegation.correlationId,
                  revision: typeof runtimeTarget.delegation.metadata?.revision === "number" ? runtimeTarget.delegation.metadata.revision : 1 } : undefined);
              if (!targetWorkflow || targetWorkflow.sessionId !== this.config.sessionId) return { ok: false, error: { code: "not_found", retryable: false,
                message: `No workflow run ${targetRunId} found in this Conversation session` } };
              const itemInput = { ...input, messageId: `${batchKey}:${targetRunId}` };
              const cancelResult = buildCancellationRequest({ runId: targetRunId,
                ...(cancelInput?.taskId ? { taskId: cancelInput.taskId } : {}), requestedBy: "conversation", requestedAt,
                expectedVersion: targetWorkflow.revision, reason: cancelInput?.reason ?? "User requested workflow cancellation",
                cancellationId: this.generateTurnId(itemInput, "canc"), idempotencyKey: this.generateTurnId(itemInput, "idemp-canc") });
              if (!cancelResult.ok) return cancelResult;
              const cancellationRequest = cancelResult.value;
              const parsed = DelegationRequestSchema.safeParse({ schemaVersion: 2,
                delegationId: this.generateTurnId(itemInput, "del-cancel"), messageId: this.generateTurnId(itemInput, "msg-cancel"),
                correlationId: targetWorkflow.correlationId, sessionId: this.config.sessionId, runId: targetRunId,
                requestedBy: "conversation", targetRole: "coordinator", title: `Hủy workflow run: ${targetRunId}`,
                objective: cancellationRequest.reason, specificationId: `spec-cancel-${targetRunId}`, sddLevel: "lightweight",
                acceptanceCriteria: [{ id: "ac-cancel-1", description: cancellationRequest.reason, category: "functional",
                  verificationMethod: "manual_review", required: true, status: "pending", evidenceArtifactIds: [] }],
                inputArtifacts: [], priority: "critical", requestedAt, idempotencyKey: cancellationRequest.idempotencyKey,
                metadata: { action: "cancel", targetRunId, cancellationRequest,
                  requestedScope: [cancelInput?.taskId ?? targetRunId], rawUserRequest: input.content,
                  interpretedIntent: cancellationRequest.reason, userMessageId: batchKey, cancellationBatchRunIds: targets } });
              if (!parsed.success) return { ok: false, error: { code: "validation", retryable: false,
                message: `Invalid cancel DelegationRequest: ${parsed.error.message}` } };
              // Even cancelled runs are sent to Runtime for safe stop/reconciliation; a Conversation label is not proof.
              items.push({ runId: targetRunId, status: "pending", request: cancellationRequest, delegation: parsed.data });
            }
            batch = { input: UserTurnInputSchema.parse(input), items };
            const saved = await saveBatch();
            if (!saved.ok) return saved;
          }
          for (let i = 0; i < batch.items.length; i++) {
            const item = batch.items[i]!;
            if (item.status === "attempting") {
              // A crash can occur between the queue side effect and recording its receipt. Never assume not delivered.
              batch = { ...batch, items: batch.items.map((entry, index) => index !== i ? entry : { ...entry, status: "blocked",
                error: { code: "unknown_delivery", retryable: false, manualInterventionRequired: true,
                  message: "Interrupted cancellation enqueue; reconcile delivery before retrying" } }) };
              const saved = await saveBatch();
              if (!saved.ok) return saved;
              continue;
            }
            if (item.status !== "pending") continue;
            batch = { ...batch, items: batch.items.map((entry, index) => index !== i ? entry : { ...entry, status: "attempting" }) };
            const prepared = await saveBatch();
            if (!prepared.ok) return prepared;
            let sent: OperationResult<void>;
            try { sent = await this.config.bridge.handOffToCoordinator(item.delegation, options); }
            catch (error) { sent = { ok: false, error: { code: "unknown_delivery", retryable: false, manualInterventionRequired: true,
              message: `Cancellation enqueue raised an error; reconcile required: ${String(error)}` } }; }
            batch = { ...batch, items: batch.items.map((entry, index) => index !== i ? entry :
              sent.ok ? { ...entry, status: "queued" } : { ...entry, status: "blocked", error: sent.error }) };
            const saved = await saveBatch();
            if (!saved.ok) return saved;
          }
          const single = batch.items.length === 1 ? batch.items[0] : undefined;
          const summary = { items: batch.items.map(item => ({ runId: item.runId, status: item.status,
            ...(item.error ? { error: item.error } : {}) })) };
          const userMsg: ConversationMessage = { schemaVersion: 2,
            messageId: input.messageId ?? this.generateId("msg-user"), sessionId: this.config.sessionId, correlationId,
            ...(single ? { runId: single.runId } : {}), turnSequence: userTurnSequence, sender: "user", ...decisionReceipt,
            recipient: "conversation", intent: "user_request", content: input.content,
            artifactReferences: input.inputArtifacts ? [...input.inputArtifacts] : [], createdAt: input.occurredAt ?? now };
          const queued = batch.items.filter(item => item.status === "queued").length;
          const blocked = batch.items.filter(item => item.status === "blocked").length;
          const agentReply: ConversationMessage = { schemaVersion: 2, messageId: this.generateId("msg-chat"),
            sessionId: this.config.sessionId, correlationId, ...(single ? { runId: single.runId } : {}), turnSequence: agentTurnSequence,
            sender: "conversation", recipient: "user", intent: "progress_update",
            content: `Yêu cầu hủy: ${queued}/${batch.items.length} run đã vào hàng đợi Runtime; ${blocked} run bị chặn. ` +
              "Đang chờ Runtime xác nhận xử lý và dừng/reconcile; queued không có nghĩa đã bắt đầu hoặc dừng hoàn toàn." +
              batch.items.filter(item => item.error).map(item => `\n${item.runId}: ${item.error!.message}`).join(""),
            metadata: { cancellationBatch: JSON.parse(JSON.stringify(summary)),
              ...(single ? { cancellationRequest: JSON.parse(JSON.stringify(single.request)) } : {}) }, artifactReferences: [], createdAt: now };
          const valid = this.validateConversationMessages(userMsg, agentReply);
          if (!valid.ok) return valid;
          const saved = await this.persistUpdatedSnapshot({ ...this.snapshot!,
            session: { ...this.snapshot!.session, turnCount: agentTurnSequence, updatedAt: now },
            messages: [...this.snapshot!.messages, userMsg, agentReply],
            pendingInboundQueue: [...this.snapshot!.pendingInboundQueue, ...(classification.followUpContents ?? []).map(content => ({
              queueId: this.generateId("queue-followup"), kind: "user_turn" as const, enqueuedAt: now,
              input: { sessionId: input.sessionId, content, provenance: input.provenance, inputArtifacts: input.inputArtifacts } }))] });
          if (!saved.ok) return saved;
          return { ok: true, value: { sessionId: this.config.sessionId, correlationId, ...(single ? { runId: single.runId,
            cancellationRequest: single.request } : {}), recognizedIntent: "cancellation_request", sessionStatus: this.snapshot!.session.status,
            userMessage: userMsg, agentReply, queuedBecauseBusy: false, substantiveUpdate: true } };
        }

        default: {
          const unhandled: never = classification.intent;
          return {
            ok: false,
            error: {
              code: "validation",
              retryable: false,
              message: `Unhandled intent: ${String(unhandled)}`
            }
          };
        }
      }
    } finally {
      this.isProcessingTurn = false;
    }
  }

  /** Refresh display state from Runtime authority; never infer completion evidence from a status label. */
  async reconcileRuntimeRuns(rawEntries: readonly unknown[]): Promise<OperationResult<{ updated: string[]; rejected: string[]; busy?: boolean }>> {
    if (!this.snapshot) {
      const initialized = await this.initializeOrRecoverSession();
      if (!initialized.ok) return initialized;
    }
    if (this.isProcessingTurn || this.isFlushingQueue) return { ok: true, value: { updated: [], rejected: [], busy: true } };
    const updated: string[] = [], rejected: string[] = [];
    const now = this.getNow(), workflows = { ...this.snapshot!.workflows }, runMap = { ...this.snapshot!.runIdToCorrelationId };
    const pending = { ...this.snapshot!.pendingApprovals }, closed = { ...this.snapshot!.closedApprovals };
    const terminal = new Set<string>();
    const runtimeCancellationTargets = { ...this.snapshot!.runtimeCancellationTargets };
    for (const raw of rawEntries) {
      // The private projection accepts Runtime fields but parses exchanged public values with their contracts.
      const parsed = RuntimeCancellationTargetSchema.strip().safeParse(raw);
      if (!parsed.success) { rejected.push("Invalid Runtime run projection"); continue; }
      const run = parsed.data, delegation = run.delegation;
      if (delegation.sessionId !== this.config.sessionId) { rejected.push(`${run.runId}: another session`); continue; }
      if (delegation.runId !== run.runId) { rejected.push(`${run.runId}: delegation run mismatch`); continue; }
      const correlationId = delegation.correlationId;
      const previous = workflows[correlationId];
      const mapped = runMap[run.runId];
      if (mapped !== undefined && mapped !== correlationId) {
        rejected.push(`${run.runId}: conflicting workflow correlation`); continue;
      }
      runtimeCancellationTargets[run.runId] = RuntimeCancellationTargetSchema.parse(run);
      const status = run.cancelled ? "cancelled" : run.status;
      const runtimeRevision = z.number().int().nonnegative().catch(1).parse(delegation.metadata?.revision);
      // A queued newer requirement can precede Runtime ingress. Preserve its identity as a pair;
      // when Runtime is newer, adopt its revision together with the delegation id for exact-turn recovery.
      const pendingNewer = previous?.runId === run.runId && previous.revision > runtimeRevision;
      const requirement = pendingNewer ? previous : delegation;
      workflows[correlationId] = { ...previous, correlationId, sessionId: this.config.sessionId, delegationId: requirement.delegationId,
        specificationId: requirement.specificationId, runId: run.runId, title: requirement.title, objective: requirement.objective,
        kind: previous?.kind ?? "feature", sddLevel: requirement.sddLevel, priority: requirement.priority,
        acceptanceCriteria: requirement.acceptanceCriteria, revision: pendingNewer ? previous.revision : runtimeRevision, generation: previous?.generation ?? 0,
        activeApprovalIds: previous?.activeApprovalIds ?? [], progressHistory: previous?.progressHistory ?? [],
        sdlcStatus: status, completedVerified: previous?.runId === run.runId && previous.completedVerified === true && status === "completed",
        createdAt: previous?.createdAt ?? delegation.requestedAt, updatedAt: now };
      runMap[run.runId] = correlationId;
      if (isTerminalRunStatus(status)) terminal.add(run.runId);
      updated.push(run.runId);
    }
    for (const request of Object.values(pending)) {
      if (!terminal.has(request.runId)) continue;
      closed[request.approvalId] = { approvalId: request.approvalId, runId: request.runId, status: "expired",
        reason: `Runtime xác nhận run ${request.runId} đã kết thúc; không thể tiếp tục bằng approval`, closedAt: now };
      delete pending[request.approvalId];
    }
    for (const [id, workflow] of Object.entries(workflows)) {
      workflows[id] = { ...workflow, activeApprovalIds: workflow.activeApprovalIds.filter(id => pending[id] !== undefined) };
    }
    const activeApprovalIds = this.snapshot!.session.activeApprovalIds.filter(id => pending[id] !== undefined);
    const { activeRunId, ...sessionBase } = this.snapshot!.session;
    const session = { ...sessionBase, activeApprovalIds,
      ...(activeRunId !== undefined && !terminal.has(activeRunId) ? { activeRunId } : {}),
      status: sessionBase.status === "awaiting_user_approval" && activeApprovalIds.length === 0 ? "reporting_progress" as const : sessionBase.status,
      updatedAt: now };
    let reconciled: ConversationContextSnapshot = { ...this.snapshot!, session, workflows, runIdToCorrelationId: runMap,
      pendingApprovals: pending, closedApprovals: closed, runtimeCancellationTargets };
    for (const request of Object.values(this.snapshot!.pendingApprovals)) {
      if (terminal.has(request.runId)) reconciled = closeClarificationsForApproval(reconciled, request.approvalId, now);
    }
    const saved = await this.persistUpdatedSnapshot(reconciled);
    if (!saved.ok) return saved;
    return { ok: true, value: { updated, rejected } };
  }

  /**
   * Registers approvals the Runtime reports as pending but this Conversation never recorded (e.g. a lost
   * `approval.request`). Idempotent. Registration only makes the prompt answerable: it never decides anything,
   * and the answer still needs authenticated user provenance. Entries for another session, a run bound to another
   * correlation, an already decided, expired or conflicting request are rejected and reported, never silently dropped.
   */
  async reconcilePendingApprovals(rawEntries: readonly unknown[]): Promise<OperationResult<ApprovalReconciliation>> {
    if (!this.snapshot) {
      const initResult = await this.initializeOrRecoverSession();
      if (!initResult.ok) return initResult;
    }
    const outcome: { registered: string[]; alreadyKnown: string[]; rejected: { approvalId: string; reason: string }[]; userDecisionPrompts: string[] } = { registered: [], alreadyKnown: [], rejected: [], userDecisionPrompts: [] };
    if (this.isProcessingTurn || this.isFlushingQueue) return { ok: true, value: { ...outcome, busy: true } };
    const now = this.getNow();
    const pending = { ...this.snapshot!.pendingApprovals };
    let active = [...this.snapshot!.session.activeApprovalIds];
    const workflows = { ...this.snapshot!.workflows };
    const runMap = { ...this.snapshot!.runIdToCorrelationId };
    let activeRunId = this.snapshot!.session.activeRunId;
    for (const raw of rawEntries) {
      const entry = z.object({ request: ApprovalRequestSchema, correlationId: z.string().min(1) }).safeParse(raw);
      if (!entry.success) { outcome.rejected.push({ approvalId: "unknown", reason: "Runtime trả về approval không hợp lệ theo schema" }); continue; }
      const { request, correlationId } = entry.data;
      const reject = (reason: string) => { outcome.rejected.push({ approvalId: request.approvalId, reason }); };
      if (request.sessionId !== this.config.sessionId) { reject("approval thuộc session khác"); continue; }
      if (this.snapshot!.approvalDecisions[request.approvalId]) { reject("approval đã được quyết định"); continue; }
      if (this.snapshot!.closedApprovals?.[request.approvalId]) { reject("approval đã đóng vì run kết thúc hoặc được thay thế"); continue; }
      if (isUserDecisionRequest(request) && request.expiresAt !== undefined && Date.parse(now) >= Date.parse(request.expiresAt)) { reject("approval đã hết hạn"); continue; }
      const knownWorkflow = Object.values(workflows).find(item => item.runId === request.runId);
      if (knownWorkflow && isTerminalRunStatus(knownWorkflow.sdlcStatus)) { reject("run đã kết thúc"); continue; }
      const existing = pending[request.approvalId];
      if (existing) {
        if (!isDeepStrictEqual(existing, request)) { reject("approval đã đăng ký nhưng nội dung khác với Runtime"); continue; }
        outcome.alreadyKnown.push(request.approvalId); continue;
      }
      const mapped = runMap[request.runId];
      if (mapped !== undefined && mapped !== correlationId) { reject(`run ${request.runId} đang gắn với workflow khác`); continue; }
      // Runtime is authoritative for runs of this session; like a live approval.request, a missing workflow still registers.
      const workflow = workflows[correlationId];
      if (workflow?.runId !== undefined && workflow.runId !== request.runId) delete runMap[workflow.runId];
      if (activeRunId === undefined || (workflow && activeRunId === workflow.runId)) activeRunId = request.runId;
      runMap[request.runId] = correlationId;
      pending[request.approvalId] = request;
      if (!active.includes(request.approvalId)) active = [...active, request.approvalId];
      if (workflow) workflows[correlationId] = { ...workflow, runId: request.runId,
        activeApprovalIds: workflow.activeApprovalIds.includes(request.approvalId) ? workflow.activeApprovalIds : [...workflow.activeApprovalIds, request.approvalId], updatedAt: now };
      outcome.registered.push(request.approvalId);
      if (isUserDecisionRequest(request)) outcome.userDecisionPrompts.push(renderUserDecisionPrompt(request));
    }
    if (outcome.registered.length === 0) return { ok: true, value: outcome };
    const saved = await this.persistUpdatedSnapshot({ ...this.snapshot!, pendingApprovals: pending, workflows, runIdToCorrelationId: runMap,
      session: { ...this.snapshot!.session, status: "awaiting_user_approval", activeApprovalIds: active,
        ...(activeRunId !== undefined ? { activeRunId } : {}), updatedAt: now } });
    if (!saved.ok) return saved;
    return { ok: true, value: outcome };
  }

  /**
   * Handles an incoming RoleMessage from Herdr transport sent by the Coordinator or Runtime.
   */
  async handleCoordinatorRoleMessage(
    rawMessage: unknown,
    options?: OperationOptions
  ): Promise<OperationResult<CoordinatorUpdateOutcome & QueueReport>> {
    const result = await this.handleCoordinatorRoleMessageCore(rawMessage);
    return this.withQueueReportAfterTurn(result, options);
  }

  private async handleCoordinatorRoleMessageCore(
    rawMessage: unknown
  ): Promise<OperationResult<CoordinatorUpdateOutcome>> {
    if (!this.snapshot) {
      const initResult = await this.initializeOrRecoverSession();
      if (!initResult.ok) {
        return initResult;
      }
    }

    const validateResult = this.config.bridge.receiveRoleMessageFromHerdr(rawMessage);
    if (!validateResult.ok) {
      return validateResult;
    }
    const message = validateResult.value;

    const now = this.getNow();

    // Idempotency / Deduplication
    if (this.snapshot!.processedMessageIds.includes(message.message_id)) {
      return {
        ok: true,
        value: {
          sessionId: this.config.sessionId,
          correlationId: message.correlation_id,
          ...(message.run_id ? { runId: message.run_id } : {}),
          sessionStatus: this.snapshot!.session.status,
          queuedBecauseBusy: false,
          duplicateIgnored: true,
          substantiveUpdate: false
        }
      };
    }

    // BLOCKER 3: When message.type === "approval.request", validate ApprovalRequestSchema BEFORE formatting or updating state!
    let validatedApprovalRequest: ApprovalRequest | undefined;
    if (message.type === "approval.request") {
      const aprResult = ApprovalRequestSchema.safeParse(message.payload);
      if (!aprResult.success) {
        return {
          ok: false,
          error: {
            code: "validation",
            retryable: false,
            message: `Invalid ApprovalRequest payload in approval.request RoleMessage: ${aprResult.error.message}`,
            details: JSON.parse(JSON.stringify(aprResult.error.issues))
          }
        };
      }
      validatedApprovalRequest = aprResult.data;
      const approvalWorkflow = Object.values(this.snapshot!.workflows).find(item => item.runId === validatedApprovalRequest!.runId);
      if ((validatedApprovalRequest.sessionId !== undefined && validatedApprovalRequest.sessionId !== this.config.sessionId) ||
          (message.run_id !== undefined && message.run_id !== validatedApprovalRequest.runId)) {
        return { ok: false, error: { code: "validation", retryable: false, message: "Approval does not match this session/run" } };
      }
      // A closed approval never comes back: a replayed request is acknowledged without being registered.
      if (this.snapshot!.closedApprovals?.[validatedApprovalRequest.approvalId] !== undefined) {
        return {
          ok: true,
          value: {
            sessionId: this.config.sessionId,
            correlationId: message.correlation_id,
            ...(message.run_id ? { runId: message.run_id } : {}),
            sessionStatus: this.snapshot!.session.status,
            queuedBecauseBusy: false,
            duplicateIgnored: true,
            substantiveUpdate: false
          }
        };
      }
      if (approvalWorkflow && isTerminalRunStatus(approvalWorkflow.sdlcStatus)) {
        return { ok: false, error: { code: "validation", retryable: false, message: "Cannot register an approval for a terminal run" } };
      }
    }

    // Busy-State Buffering (Requirement 10)
    const shouldQueue =
      (this.isProcessingTurn || this.isFlushingQueue || this.snapshot!.agentBusy === true) &&
      !this.isDrainingSingleQueueItem;

    if (shouldQueue) {
      const queueItem: PendingInboundItem = {
        queueId: this.generateId("queue-coord"),
        kind: "coordinator_message",
        enqueuedAt: now,
        message
      };

      const updatedQueue = [...this.snapshot!.pendingInboundQueue, queueItem];
      const updatedSnapshot: ConversationContextSnapshot = {
        ...this.snapshot!,
        pendingInboundQueue: updatedQueue
      };

      const saveRes = await this.persistUpdatedSnapshot(updatedSnapshot);
      if (!saveRes.ok) return saveRes;

      return {
        ok: true,
        value: {
          sessionId: this.config.sessionId,
          correlationId: message.correlation_id,
          ...(message.run_id ? { runId: message.run_id } : {}),
          sessionStatus: this.snapshot!.session.status,
          queuedBecauseBusy: true,
          duplicateIgnored: false,
          substantiveUpdate: false
        }
      };
    }

    // Acquire in-flight processing lock
    this.isProcessingTurn = true;

    try {
      // Resolve target workflow by correlation_id or run_id
      const correlationId =
        message.correlation_id ??
        (message.run_id ? this.snapshot!.runIdToCorrelationId[message.run_id] : undefined) ??
        "corr-unknown";

      let workflow = this.snapshot!.workflows[correlationId];

      const updatedRunIdToCorrelationId = { ...this.snapshot!.runIdToCorrelationId };
      let activeRunId = this.snapshot!.session.activeRunId;

      if (message.run_id) {
        if (workflow && workflow.runId && workflow.runId !== message.run_id) {
          delete updatedRunIdToCorrelationId[workflow.runId];
          if (activeRunId === workflow.runId) {
            activeRunId = message.run_id;
          }
          workflow = {
            ...workflow,
            runId: message.run_id,
            updatedAt: now
          };
        }
        updatedRunIdToCorrelationId[message.run_id] = correlationId;
      }

      // Format message for human readability & check substantiveness
      const formattedResult = formatCoordinatorMessageForUser({
        sessionId: this.config.sessionId,
        turnSequence: this.snapshot!.session.turnCount + 1,
        roleMessage: message,
        ...(workflow ? { workflow } : {}),
        createdAt: now
      });

      if (!formattedResult.ok) {
        return formattedResult;
      }

      const formatted = formattedResult.value;
      const isSubstantive = formatted.substantive;

      let userNotification: ConversationMessage | undefined;
      let approvalPrompted: ApprovalRequest | undefined;

      const updatedProcessedMessageIds = [...this.snapshot!.processedMessageIds, message.message_id];
      const updatedWorkflows = { ...this.snapshot!.workflows };
      if (workflow) {
        updatedWorkflows[correlationId] = workflow;
      }
      const updatedPendingApprovals = { ...this.snapshot!.pendingApprovals };
      let closedApprovals: Record<string, ClosedApproval> | undefined;
      let updatedActiveApprovalIds = [...this.snapshot!.session.activeApprovalIds];
      let nextSessionStatus = this.snapshot!.session.status;
      let turnCount = this.snapshot!.session.turnCount;
      const messages = [...this.snapshot!.messages];

      if (isSubstantive) {
        userNotification = formatted.message;
        messages.push(formatted.message);
        turnCount += 1;
      }

      // Process specific message types
      if (message.type === "approval.request") {
        const apr = validatedApprovalRequest!;
        approvalPrompted = apr;
        updatedPendingApprovals[apr.approvalId] = apr;
        if (!updatedActiveApprovalIds.includes(apr.approvalId)) {
          updatedActiveApprovalIds.push(apr.approvalId);
        }
        nextSessionStatus = "awaiting_user_approval";

        // Add apr.approvalId to updatedWorkflow.activeApprovalIds (deduplicated)
        if (workflow) {
          const activeApprovalIds = workflow.activeApprovalIds.includes(apr.approvalId)
            ? workflow.activeApprovalIds
            : [...workflow.activeApprovalIds, apr.approvalId];
          updatedWorkflows[correlationId] = {
            ...workflow,
            activeApprovalIds,
            updatedAt: now
          };
        }
      } else if (message.type === "delegation.accepted") {
        nextSessionStatus = "reporting_progress";
        if (workflow && workflow.sdlcStatus !== "cancelled") {
          updatedWorkflows[correlationId] = {
            ...workflow,
            sdlcStatus: "planning",
            updatedAt: now
          };
        }
      } else if (message.type === "conversation.progress" || message.type === "task.status") {
        if (workflow) {
          const p = message.payload as Record<string, unknown>;
          const blockageReason = (p["blockageReason"] as string) ?? (formatted.isBlocked ? formatted.snapshot?.blockageReason : undefined);
          const failureReason = (p["failureSummary"] as string) ?? (formatted.isFailed ? formatted.snapshot?.failureSummary : undefined);

          // BLOCKER 3: Require explicit verification for completion
          const isExplicitlyVerifiedCompleted =
            formatted.isCompleted && (p["verified"] === true || p["completedVerified"] === true);
          const rawSdlcStatus = (p["sdlcStatus"] as SdlcWorkStatus | undefined) ?? workflow.sdlcStatus;
          const safeSdlcStatus: SdlcWorkStatus = workflow.sdlcStatus === "cancelled" ? "cancelled" : isExplicitlyVerifiedCompleted
            ? "completed"
            : rawSdlcStatus === "completed"
              ? workflow.sdlcStatus === "completed"
                ? "completed"
                : "verifying"
              : rawSdlcStatus;

          const updatedWorkflow: WorkflowRequestContext = {
            ...workflow,
            sdlcStatus: safeSdlcStatus,
            completedVerified: safeSdlcStatus === "cancelled" ? false : isExplicitlyVerifiedCompleted ? true : workflow.completedVerified,
            ...(blockageReason ? { blockedReason: blockageReason } : workflow.blockedReason ? { blockedReason: workflow.blockedReason } : {}),
            ...(failureReason ? { failureReason } : workflow.failureReason ? { failureReason: workflow.failureReason } : {}),
            ...(formatted.snapshot ? { lastProgress: formatted.snapshot } : workflow.lastProgress ? { lastProgress: workflow.lastProgress } : {}),
            progressHistory: formatted.snapshot
              ? [...workflow.progressHistory, formatted.snapshot]
              : workflow.progressHistory,
            updatedAt: now
          };

          updatedWorkflows[correlationId] = updatedWorkflow;

          if (isExplicitlyVerifiedCompleted) {
            const allCompleted = Object.values(updatedWorkflows).every((w) => w.completedVerified);
            if (allCompleted && updatedActiveApprovalIds.length === 0) {
              nextSessionStatus = "completed";
            }
          } else if (nextSessionStatus !== "awaiting_user_approval") {
            nextSessionStatus = "reporting_progress";
          }
        }
      } else if (message.type === "verification.escalation") {
        if (workflow && workflow.sdlcStatus !== "cancelled") {
          updatedWorkflows[correlationId] = {
            ...workflow,
            sdlcStatus: "escalated",
            updatedAt: now
          };
        }
      }

      // Runtime closed a specialist question: drop the prompt so it no longer counts as pending.
      // Only user-decision entries are removed; a design/task approval is never touched here.
      const expiredApprovalId = userDecisionExpiredApprovalId(message.type, message.payload);
      if (expiredApprovalId !== undefined) {
        const expired = updatedPendingApprovals[expiredApprovalId];
        if (expired !== undefined && isUserDecisionRequest(expired)) {
          delete updatedPendingApprovals[expiredApprovalId];
          updatedActiveApprovalIds = updatedActiveApprovalIds.filter((id) => id !== expiredApprovalId);
          for (const [id, workflowContext] of Object.entries(updatedWorkflows)) {
            if (workflowContext.activeApprovalIds.includes(expiredApprovalId)) {
              updatedWorkflows[id] = {
                ...workflowContext,
                activeApprovalIds: workflowContext.activeApprovalIds.filter((value) => value !== expiredApprovalId),
                updatedAt: now
              };
            }
          }
          if (nextSessionStatus === "awaiting_user_approval" && updatedActiveApprovalIds.length === 0) {
            nextSessionStatus = "reporting_progress";
          }
        }
      }

      // A run that ended, or a requirement revision that replaced approvals, closes those approvals so no human
      // decision reaches Coordinator for them. Each closure is kept so a late reply gets a clear refusal.
      const endedRun = updatedWorkflows[correlationId];
      const endedRunId = endedRun && isTerminalRunStatus(endedRun.sdlcStatus) ? endedRun.runId : undefined;
      const superseded = supersededApprovals(message.type, message.payload);
      const closures = new Map<string, { readonly status: ClosedApproval["status"]; readonly reason: string }>();
      for (const request of Object.values(updatedPendingApprovals)) {
        if (endedRunId !== undefined && request.runId === endedRunId) {
          closures.set(request.approvalId, { status: "expired", reason: `Run ${endedRunId} đã kết thúc (${endedRun!.sdlcStatus})` });
        }
      }
      for (const approvalId of superseded?.approvalIds ?? []) {
        if (updatedPendingApprovals[approvalId] !== undefined) closures.set(approvalId, { status: "superseded", reason: superseded!.reason });
      }
      if (closures.size > 0) {
        closedApprovals = { ...(this.snapshot!.closedApprovals ?? {}) };
        for (const [approvalId, closure] of closures) {
          closedApprovals[approvalId] = { approvalId, runId: updatedPendingApprovals[approvalId]!.runId, status: closure.status,
            reason: sanitizeReasonForUser(closure.reason, 300), closedAt: now };
          delete updatedPendingApprovals[approvalId];
        }
        const closedIds = new Set(closures.keys());
        updatedActiveApprovalIds = updatedActiveApprovalIds.filter((id) => !closedIds.has(id));
        for (const [id, workflowContext] of Object.entries(updatedWorkflows)) {
          if (workflowContext.activeApprovalIds.some((value) => closedIds.has(value))) {
            updatedWorkflows[id] = { ...workflowContext,
              activeApprovalIds: workflowContext.activeApprovalIds.filter((value) => !closedIds.has(value)), updatedAt: now };
          }
        }
        if (nextSessionStatus === "awaiting_user_approval" && updatedActiveApprovalIds.length === 0) {
          nextSessionStatus = "reporting_progress";
        }
      }
      if (endedRunId !== undefined && activeRunId === endedRunId) activeRunId = undefined;

      // Rebuilt without the previous activeRunId so that clearing it actually removes it from the session.
      const { activeRunId: _previousActiveRunId, ...sessionBase } = this.snapshot!.session;
      const updatedSession: ConversationSession = {
        ...sessionBase,
        status: nextSessionStatus,
        activeApprovalIds: updatedActiveApprovalIds,
        turnCount,
        ...(activeRunId !== undefined ? { activeRunId } : {}),
        updatedAt: now
      };

      const updatedSnapshot: ConversationContextSnapshot = {
        ...this.snapshot!,
        session: updatedSession,
        messages,
        workflows: updatedWorkflows,
        runIdToCorrelationId: updatedRunIdToCorrelationId,
        pendingApprovals: updatedPendingApprovals,
        processedMessageIds: updatedProcessedMessageIds,
        ...(closedApprovals !== undefined ? { closedApprovals } : {})
      };

      const saveRes = await this.persistUpdatedSnapshot(updatedSnapshot);
      if (!saveRes.ok) return saveRes;

      return {
        ok: true,
        value: {
          sessionId: this.config.sessionId,
          correlationId,
          ...(message.run_id ? { runId: message.run_id } : {}),
          sessionStatus: this.snapshot!.session.status,
          queuedBecauseBusy: false,
          duplicateIgnored: false,
          substantiveUpdate: isSubstantive,
          ...(userNotification ? { userNotification } : {}),
          ...(approvalPrompted ? { approvalPrompted } : {})
        }
      };
    } finally {
      this.isProcessingTurn = false;
    }
  }

  /**
   * Runs the queue drain that follows a turn and returns its report with the turn result.
   * Skipped when the turn itself is being drained from the queue (the outer drain reports it).
   */
  private async withQueueReportAfterTurn<T extends object>(
    result: OperationResult<T>,
    options?: OperationOptions
  ): Promise<OperationResult<T & QueueReport>> {
    let report: QueueReport = {};
    if (
      !this.isFlushingQueue &&
      !this.isDrainingSingleQueueItem &&
      this.snapshot &&
      this.snapshot.pendingInboundQueue.length > 0 &&
      !this.snapshot.agentBusy
    ) {
      const flushed = await this.flushPendingInboundQueue(options);
      report = flushed.ok ? queueReportOf(flushed.value) : { queueFlushError: flushed.error };
    }
    if (!result.ok) return result;
    return { ok: true, value: { ...result.value, ...report } };
  }

  /**
   * Drains the pending inbound queue in strict FIFO order when not busy.
   *
   * Each item stays queued until it is processed. A failing item is retried by a later drain and is
   * dead-lettered after MAX_QUEUE_PROCESSING_ATTEMPTS failures, with a user-visible notice. A failure
   * never blocks the items behind it in the same pass, and every failure is returned in the result.
   */
  async flushPendingInboundQueue(
    options?: OperationOptions
  ): Promise<
    OperationResult<{
      processedUserTurns: readonly UserFriendlyResponse[];
      processedCoordinatorUpdates: readonly CoordinatorUpdateOutcome[];
      queueFailures: readonly QueueProcessingFailure[];
      queueNotices: readonly ConversationMessage[];
    }>
  > {
    const empty = { processedUserTurns: [], processedCoordinatorUpdates: [], queueFailures: [], queueNotices: [] };
    if (!this.snapshot) {
      return { ok: true, value: empty };
    }

    if (this.isFlushingQueue || this.isProcessingTurn || this.snapshot.agentBusy) {
      return { ok: true, value: empty };
    }

    this.isFlushingQueue = true;
    const processedUserTurns: UserFriendlyResponse[] = [];
    const processedCoordinatorUpdates: CoordinatorUpdateOutcome[] = [];
    const queueFailures: QueueProcessingFailure[] = [];
    const queueNotices: ConversationMessage[] = [];

    try {
      // Only items queued when this pass started are attempted; a later call retries the failed ones.
      for (const queueId of this.snapshot.pendingInboundQueue.map((item) => item.queueId)) {
        if (this.snapshot.agentBusy) break;
        const nextItem = this.snapshot.pendingInboundQueue.find((item) => item.queueId === queueId);
        if (!nextItem) continue;

        // A structured decision whose target is gone is rejected visibly (not retried).
        if (nextItem.kind === "user_turn" && nextItem.input.conversationDecision &&
            !this.snapshot.messages.some(message => message.sender === "user" && message.messageId === nextItem.input.messageId)) {
          const currentDecision = resolveChatDecision(nextItem.input.conversationDecision, this.snapshot);
          if (!currentDecision.ok) {
            const rejected = await this.rejectQueuedDecision(nextItem, currentDecision.error);
            if (!rejected.ok) return rejected;
            processedUserTurns.push(rejected.value);
            continue;
          }
        }

        this.isDrainingSingleQueueItem = true;
        let succeeded: boolean;
        let failure: ContractError | undefined;
        try {
          if (nextItem.kind === "user_turn") {
            const turnResult = await this.handleUserTurn(nextItem.input, options);
            succeeded = turnResult.ok;
            if (turnResult.ok) processedUserTurns.push(stripQueueReport(turnResult.value));
            else failure = turnResult.error;
          } else {
            const updateResult = await this.handleCoordinatorRoleMessage(nextItem.message, options);
            succeeded = updateResult.ok;
            if (updateResult.ok) processedCoordinatorUpdates.push(stripQueueReport(updateResult.value));
            else failure = updateResult.error;
          }
        } finally {
          this.isDrainingSingleQueueItem = false;
        }

        if (succeeded) {
          const saveRes = await this.persistUpdatedSnapshot({ ...this.snapshot,
            pendingInboundQueue: this.snapshot.pendingInboundQueue.filter(item => item.queueId !== queueId) },
          new Set([queueId]));
          if (!saveRes.ok) return saveRes;
          continue;
        }

        const recorded = await this.recordQueueFailure(nextItem, failure ?? {
          code: "transport_unavailable", retryable: true, message: "Queued item processing failed without an error" });
        if (!recorded.ok) return recorded;
        queueFailures.push(recorded.value.failure);
        if (recorded.value.notice) queueNotices.push(recorded.value.notice);
      }

      return {
        ok: true,
        value: { processedUserTurns, processedCoordinatorUpdates, queueFailures, queueNotices }
      };
    } finally {
      this.isFlushingQueue = false;
    }
  }

  /**
   * Counts one failed processing attempt. Below the limit the item stays queued with its attempt count.
   * At the limit it moves to the dead-letter list and Conversation tells the user what happened.
   */
  private async recordQueueFailure(
    item: PendingInboundItem,
    error: ContractError
  ): Promise<OperationResult<{ failure: QueueProcessingFailure; notice?: ConversationMessage }>> {
    const attempts = (item.attempts ?? 0) + 1;
    const reason = sanitizeReasonForUser(error.message, 300);
    const runId = item.kind === "coordinator_message" ? item.message.run_id : item.input.runId;
    const correlationId = item.kind === "coordinator_message" ? item.message.correlation_id : item.input.correlationId;
    const failedItem = { ...item, attempts, lastError: reason } as PendingInboundItem;
    const failureBase = { queueId: item.queueId, kind: item.kind, attempts, reason,
      ...(runId !== undefined ? { runId } : {}), ...(correlationId !== undefined ? { correlationId } : {}) };

    if (attempts < MAX_QUEUE_PROCESSING_ATTEMPTS) {
      const saveRes = await this.persistUpdatedSnapshot({ ...this.snapshot!,
        pendingInboundQueue: this.snapshot!.pendingInboundQueue.map(queued => queued.queueId === item.queueId ? failedItem : queued) });
      if (!saveRes.ok) return saveRes;
      return { ok: true, value: { failure: { ...failureBase, deadLettered: false } } };
    }

    const now = this.getNow();
    const turnSequence = this.snapshot!.session.turnCount + 1;
    const sourceLabel = item.kind === "user_turn"
      ? "yêu cầu hoặc quyết định của bạn"
      : `thông điệp "${item.message.type}" từ Coordinator`;
    const notice = ConversationMessageSchema.parse({
      schemaVersion: 2,
      messageId: this.generateId("msg-deadletter"),
      sessionId: this.config.sessionId,
      correlationId: correlationId ?? `corr-${item.queueId}`,
      ...(runId !== undefined ? { runId } : {}),
      turnSequence,
      sender: "conversation",
      recipient: "user",
      intent: "error_report",
      content: [
        `⚠️ **KHÔNG XỬ LÝ ĐƯỢC MỘT MỤC ĐANG CHỜ SAU ${attempts} LẦN THỬ [${item.queueId}]**`,
        `- **Nguồn:** ${sourceLabel}`,
        `- **Run:** ${runId ?? "không xác định"}`,
        `- **Lý do:** ${wrapUntrustedRepositoryContent(reason)}`,
        "",
        "Hệ thống đã ngừng thử lại mục này để không chặn các mục khác. Bạn có thể:",
        "1. Gửi lại yêu cầu hoặc quyết định của mình, nêu rõ mã run hoặc mã phê duyệt (apr-...) nếu có.",
        "2. Hỏi \"trạng thái\" để xem tiến độ hiện tại của run.",
        "3. Nếu không cần tiếp tục, hủy run bằng \"hủy <run-id>\"."
      ].join("\n"),
      artifactReferences: [],
      createdAt: now
    });
    const deadLetter: DeadLetterItem = { queueId: item.queueId, deadLetteredAt: now, attempts, reason,
      ...(runId !== undefined ? { runId } : {}), ...(correlationId !== undefined ? { correlationId } : {}), item: failedItem };
    const saveRes = await this.persistUpdatedSnapshot({ ...this.snapshot!,
      session: { ...this.snapshot!.session, turnCount: turnSequence, updatedAt: now },
      messages: [...this.snapshot!.messages, notice],
      pendingInboundQueue: this.snapshot!.pendingInboundQueue.filter(queued => queued.queueId !== item.queueId),
      deadLetters: [...(this.snapshot!.deadLetters ?? []), deadLetter] }, new Set([item.queueId]));
    if (!saveRes.ok) return saveRes;
    return { ok: true, value: { failure: { ...failureBase, deadLettered: true }, notice } };
  }

  /**
   * Answers an approval reply that cannot be applied, visibly and without changing any state.
   */
  private async answerWithNotice(
    input: UserTurnInput,
    correlationId: string,
    content: string,
    runId?: string
  ): Promise<OperationResult<UserFriendlyResponse>> {
    const now = this.getNow();
    const userTurnSequence = this.snapshot!.session.turnCount + 1;
    const agentTurnSequence = userTurnSequence + 1;
    const userMessage = ConversationMessageSchema.parse({
      schemaVersion: 2,
      messageId: input.messageId ?? this.generateId("msg-user"),
      sessionId: this.config.sessionId,
      correlationId,
      ...(runId !== undefined ? { runId } : {}),
      turnSequence: userTurnSequence,
      sender: "user",
      recipient: "conversation",
      intent: "approval_response",
      content: input.content,
      artifactReferences: input.inputArtifacts ? [...input.inputArtifacts] : [],
      createdAt: input.occurredAt ?? now
    });
    const agentReply = ConversationMessageSchema.parse({
      schemaVersion: 2,
      messageId: this.generateId("msg-chat"),
      sessionId: this.config.sessionId,
      correlationId,
      ...(runId !== undefined ? { runId } : {}),
      turnSequence: agentTurnSequence,
      sender: "conversation",
      recipient: "user",
      intent: "error_report",
      content,
      artifactReferences: [],
      createdAt: now
    });
    const saved = await this.persistUpdatedSnapshot({ ...this.snapshot!,
      session: { ...this.snapshot!.session, turnCount: agentTurnSequence, updatedAt: now },
      messages: [...this.snapshot!.messages, userMessage, agentReply] });
    if (!saved.ok) return saved;
    return { ok: true, value: { sessionId: this.config.sessionId, correlationId, ...(runId !== undefined ? { runId } : {}),
      recognizedIntent: "conversation_only", sessionStatus: saved.value.session.status, userMessage, agentReply,
      queuedBecauseBusy: false, substantiveUpdate: false } };
  }

  // --- Negative Invariant Guard APIs (proving and enforcing prohibitions at API level) ---

  /**
   * Proves Invariant 1: Never directly assign or dispatch to developer or specialist roles.
   */
  attemptDirectDeveloperAssignment(targetRole: string): OperationResult<void> {
    return assertConversationRoleBoundaries({ targetRole });
  }

  /**
   * Proves Invariant 2: Never directly edit or mutate repository source code.
   */
  attemptSourceCodeEdit(): OperationResult<void> {
    return assertConversationRoleBoundaries({ attemptsCodeEdit: true });
  }

  /**
   * Proves Invariant 3: Never unilaterally transition a workflow or task status to completed.
   */
  attemptUnilateralCompletion(): OperationResult<void> {
    return assertConversationRoleBoundaries({ attemptsDirectCompletion: true });
  }
}

/** Extracts the queue report of a turn or flush result, omitting empty fields. */
function queueReportOf(value: { queueFailures?: readonly QueueProcessingFailure[]; queueNotices?: readonly ConversationMessage[] }): QueueReport {
  return {
    ...(value.queueFailures && value.queueFailures.length > 0 ? { queueFailures: value.queueFailures } : {}),
    ...(value.queueNotices && value.queueNotices.length > 0 ? { queueNotices: value.queueNotices } : {})
  };
}

/** Removes a queue report from a result stored as a processed item (the report is returned once, by the drain). */
function stripQueueReport<T extends QueueReport>(value: T): T {
  const { queueFailures: _failures, queueNotices: _notices, queueFlushError: _error, ...rest } = value;
  return rest as T;
}
