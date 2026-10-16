import { z } from "zod";
import {
  AgentRequestSchema,
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  ConversationMessageSchema,
  DelegationRequestSchema,
  RoleMessageSchema,
  type AgentExecutionHandle,
  type AgentMessage,
  type AgentReconciliationRequest,
  type AgentReconciliationResult,
  type AgentRequest,
  type AgentSubmissionReceipt,
  type AgentTargetLocator,
  type AgentTransport,
  type AgentTransportCapabilities,
  type AgentTransportInitialization,
  type AgentTransportObservation,
  type AgentWaitOptions,
  type AgentReadOptions,
  type ApprovalDecision,
  type ApprovalRequest,
  type CancellationRequest,
  type CancellationResult,
  type ConversationCoordinatorPort,
  type ConversationMessage,
  type DelegationRequest,
  type JsonValue,
  type OperationOptions,
  type OperationResult,
  type RoleMessage,
  type SdlcWorkStatus
} from "@bflow/contracts";
import type { DeliveryTrackingRecord } from "./types.js";

export const OutboundCoordinatorMessageTypeSchema = z.enum([
  "delegation.request",
  "approval.decision"
]);

export const OutboundCoordinatorPayloadSchema = z.union([
  DelegationRequestSchema,
  ApprovalDecisionSchema,
  z.record(z.unknown())
]);

/**
 * Configuration options for HerdrConversationBridge.
 */
export interface HerdrConversationBridgeConfig {
  readonly transport: AgentTransport;
  readonly sessionId: string;
  readonly conversationAgentId?: string; // default "chat"
  readonly conversationPaneId: string;
  readonly coordinatorTarget: AgentTargetLocator; // e.g. { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator" }
  readonly now?: () => string;
}

/**
 * HerdrConversationBridge connects the Conversation Agent to the Coordinator Agent
 * via Herdr protocol envelopes (RoleMessage schema_version 2) and AgentTransport.
 *
 * Implements ConversationCoordinatorPort from @bflow/contracts.
 */
export class HerdrConversationBridge implements ConversationCoordinatorPort {
  readonly config: HerdrConversationBridgeConfig;
  private readonly deliveryRecords = new Map<string, DeliveryTrackingRecord>();
  private inboundHandler?: (message: RoleMessage, options?: OperationOptions) => Promise<OperationResult<unknown>>;

  constructor(config: HerdrConversationBridgeConfig) {
    this.config = config;
  }

  setInboundMessageHandler(
    handler: (message: RoleMessage, options?: OperationOptions) => Promise<OperationResult<unknown>>
  ): void {
    this.inboundHandler = handler;
  }

  private getNow(): string {
    return this.config.now ? this.config.now() : new Date().toISOString();
  }

  /**
   * Restores tracking records from a recovered ConversationContextSnapshot.
   */
  restoreDeliveryRecords(records: Readonly<Record<string, DeliveryTrackingRecord>>): void {
    for (const [key, record] of Object.entries(records)) {
      this.deliveryRecords.set(key, record);
    }
  }

  /**
   * Gets a delivery record by message ID.
   */
  getDeliveryRecord(messageId: string): DeliveryTrackingRecord | undefined {
    return this.deliveryRecords.get(messageId);
  }

  /**
   * Returns a snapshot of all delivery records tracked by this bridge.
   */
  getAllDeliveryRecords(): Readonly<Record<string, DeliveryTrackingRecord>> {
    const res: Record<string, DeliveryTrackingRecord> = {};
    for (const [k, v] of this.deliveryRecords.entries()) {
      res[k] = v;
    }
    return res;
  }

  /**
   * Sends a structured RoleMessage envelope to the Coordinator over Herdr AgentTransport.
   *
   * Enforces:
   * - sender.role === "conversation" and recipient.role === "coordinator"
   * - No automatic resend when in status === "unknown_delivery" (Rule: reconcile required first)
   * - Proper AgentRequest packaging & AgentSubmissionReceipt handling
   */
  async sendRoleMessageToCoordinator(
    message: RoleMessage,
    options?: OperationOptions
  ): Promise<OperationResult<DeliveryTrackingRecord>> {
    const parseResult = RoleMessageSchema.safeParse(message);
    if (!parseResult.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Invalid outbound RoleMessage: ${parseResult.error.message}`,
          details: JSON.parse(JSON.stringify(parseResult.error.issues))
        }
      };
    }

    const validatedMessage = parseResult.data;

    // Boundary check: only conversation -> coordinator
    if (validatedMessage.sender.role !== "conversation" || validatedMessage.recipient.role !== "coordinator") {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Conversation bridge only sends from role 'conversation' to 'coordinator' (got sender: '${validatedMessage.sender.role}', recipient: '${validatedMessage.recipient.role}')`
        }
      };
    }

    // Protocol 22 routing matrix check: only delegation.request and approval.decision allowed
    const typeParse = OutboundCoordinatorMessageTypeSchema.safeParse(validatedMessage.type);
    if (!typeParse.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Conversation-to-Coordinator transport only permits 'delegation.request' and 'approval.decision' messages, received '${validatedMessage.type}'`
        }
      };
    }

    // Check existing delivery record for unknown_delivery prohibition
    const existingRecord =
      this.deliveryRecords.get(validatedMessage.message_id) ??
      (validatedMessage.idempotency_key
        ? Array.from(this.deliveryRecords.values()).find(
            (r) => r.idempotencyKey === validatedMessage.idempotency_key
          )
        : undefined);

    if (existingRecord && existingRecord.status === "unknown_delivery" && !existingRecord.resendAllowed) {
      return {
        ok: false,
        error: {
          code: "unknown_delivery",
          retryable: false,
          manualInterventionRequired: true,
          message: `Cannot resend message '${validatedMessage.message_id}' while delivery status is unknown_delivery; reconcile required first`
        }
      };
    }

    const runId =
      validatedMessage.run_id ??
      (this.config.sessionId.startsWith("run-")
        ? this.config.sessionId
        : `run-${validatedMessage.correlation_id}`);

    const idempotencyKey = validatedMessage.idempotency_key ?? `idemp-${validatedMessage.message_id}`;

    const rawAgentRequest = {
      requestId: `req-${validatedMessage.message_id}`,
      attemptId: `att-${validatedMessage.message_id}-1`,
      runId,
      taskId: `task-${validatedMessage.correlation_id}`,
      role: "coordinator",
      target: this.config.coordinatorTarget,
      instruction: JSON.stringify(validatedMessage),
      inputs: [...validatedMessage.artifact_references],
      context: validatedMessage as unknown as JsonValue,
      attempt: 1,
      retry: {
        maxAttempts: 3,
        strategy: "linear" as const,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        jitter: true
      },
      timeout: {
        executionTimeoutMs: 30000,
        onTimeout: "retry" as const
      },
      idempotency: {
        key: idempotencyKey,
        scope: "agent-request" as const,
        fingerprint: validatedMessage.message_id
      },
      createdAt: this.getNow()
    };

    const requestParseResult = AgentRequestSchema.safeParse(rawAgentRequest);
    if (!requestParseResult.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Failed to construct valid AgentRequest: ${requestParseResult.error.message}`,
          details: JSON.parse(JSON.stringify(requestParseResult.error.issues))
        }
      };
    }

    const agentRequest: AgentRequest = requestParseResult.data;

    let receiptResult: OperationResult<AgentSubmissionReceipt>;
    try {
      receiptResult = await this.config.transport.send(agentRequest, options);
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "transport_unavailable",
          retryable: true,
          message: `Underlying transport error sending request: ${String(err)}`
        }
      };
    }

    if (!receiptResult.ok) {
      return receiptResult;
    }

    const receipt = receiptResult.value;

    if (receipt.status === "accepted") {
      const record: DeliveryTrackingRecord = {
        messageId: validatedMessage.message_id,
        requestId: agentRequest.requestId,
        attemptId: agentRequest.attemptId,
        runId: agentRequest.runId,
        taskId: agentRequest.taskId,
        correlationId: validatedMessage.correlation_id,
        idempotencyKey,
        target: this.config.coordinatorTarget,
        status: "accepted",
        resendAllowed: false,
        handle: receipt.handle,
        updatedAt: this.getNow()
      };
      this.deliveryRecords.set(validatedMessage.message_id, record);
      return { ok: true, value: record };
    }

    if (receipt.status === "unknown_delivery") {
      const record: DeliveryTrackingRecord = {
        messageId: validatedMessage.message_id,
        requestId: agentRequest.requestId,
        attemptId: agentRequest.attemptId,
        runId: agentRequest.runId,
        taskId: agentRequest.taskId,
        correlationId: validatedMessage.correlation_id,
        idempotencyKey,
        target: this.config.coordinatorTarget,
        status: "unknown_delivery",
        resendAllowed: false,
        updatedAt: this.getNow()
      };
      this.deliveryRecords.set(validatedMessage.message_id, record);
      return {
        ok: false,
        error: {
          code: "unknown_delivery",
          retryable: false,
          manualInterventionRequired: true,
          message: receipt.reason
        }
      };
    }

    // receipt.status === "rejected"
    const record: DeliveryTrackingRecord = {
      messageId: validatedMessage.message_id,
      requestId: agentRequest.requestId,
      attemptId: agentRequest.attemptId,
      runId: agentRequest.runId,
      taskId: agentRequest.taskId,
      correlationId: validatedMessage.correlation_id,
      idempotencyKey,
      target: this.config.coordinatorTarget,
      status: "rejected",
      resendAllowed: true,
      updatedAt: this.getNow()
    };
    this.deliveryRecords.set(validatedMessage.message_id, record);
    return {
      ok: false,
      error: {
        code: "transport_unavailable",
        retryable: true,
        message: receipt.reason
      }
    };
  }

  /**
   * Reconciles an unknown_delivery status with the remote Herdr transport.
   * Only allows resend if the outcome is conclusively 'not_delivered'.
   */
  async reconcileDelivery(
    messageId: string,
    options?: OperationOptions
  ): Promise<OperationResult<DeliveryTrackingRecord>> {
    const record = this.deliveryRecords.get(messageId);
    if (!record) {
      return {
        ok: false,
        error: {
          code: "not_found",
          retryable: false,
          message: `Delivery record not found for message ID '${messageId}'`
        }
      };
    }

    const reconciliationRequest: AgentReconciliationRequest = {
      requestId: record.requestId,
      attemptId: record.attemptId,
      runId: record.runId,
      taskId: record.taskId,
      idempotencyKey: record.idempotencyKey,
      target: record.target,
      requestedAt: this.getNow()
    };

    let reconcileResult: OperationResult<AgentReconciliationResult>;
    try {
      reconcileResult = await this.config.transport.reconcile(reconciliationRequest, options);
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "transport_unavailable",
          retryable: true,
          message: `Transport error during reconciliation: ${String(err)}`
        }
      };
    }

    if (!reconcileResult.ok) {
      return reconcileResult;
    }

    const outcome = reconcileResult.value;

    if (outcome.status === "bound") {
      const updated: DeliveryTrackingRecord = {
        ...record,
        status: "reconciled_bound",
        handle: outcome.handle,
        resendAllowed: false,
        updatedAt: this.getNow()
      };
      this.deliveryRecords.set(messageId, updated);
      return { ok: true, value: updated };
    }

    if (outcome.status === "not_delivered") {
      const updated: DeliveryTrackingRecord = {
        ...record,
        status: "reconciled_not_delivered",
        resendAllowed: true,
        updatedAt: this.getNow()
      };
      this.deliveryRecords.set(messageId, updated);
      return { ok: true, value: updated };
    }

    // outcome.status === "unknown_delivery"
    const updated: DeliveryTrackingRecord = {
      ...record,
      status: "unknown_delivery",
      resendAllowed: false,
      updatedAt: this.getNow()
    };
    this.deliveryRecords.set(messageId, updated);
    return {
      ok: false,
      error: {
        code: "unknown_delivery",
        retryable: false,
        manualInterventionRequired: true,
        message: outcome.reason
      }
    };
  }

  /**
   * Validates and ingests an incoming RoleMessage received from Herdr transport.
   * Ensures sender is coordinator or runtime, and recipient is conversation.
   */
  receiveRoleMessageFromHerdr(rawMessage: unknown): OperationResult<RoleMessage> {
    const parseResult = RoleMessageSchema.safeParse(rawMessage);
    if (!parseResult.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Invalid incoming RoleMessage: ${parseResult.error.message}`,
          details: JSON.parse(JSON.stringify(parseResult.error.issues))
        }
      };
    }

    const msg = parseResult.data;
    const senderRole = msg.sender.role;
    const recipientRole = msg.recipient.role;

    if (
      (senderRole !== "coordinator" && senderRole !== "runtime") ||
      recipientRole !== "conversation"
    ) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `RoleMessage must originate from 'coordinator' or 'runtime' and be destined for 'conversation' (got sender: '${senderRole}', recipient: '${recipientRole}')`
        }
      };
    }

    return { ok: true, value: msg };
  }

  // --- ConversationCoordinatorPort implementation ---

  async handOffToCoordinator(
    request: DelegationRequest,
    options?: OperationOptions
  ): Promise<OperationResult<void>> {
    const parsedReq = DelegationRequestSchema.safeParse(request);
    if (!parsedReq.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Invalid DelegationRequest: ${parsedReq.error.message}`,
          details: JSON.parse(JSON.stringify(parsedReq.error.issues))
        }
      };
    }
    const validatedRequest = parsedReq.data;
    const runId = validatedRequest.runId ?? `run-${validatedRequest.correlationId}`;
    const roleMessage: RoleMessage = {
      schema_version: 2,
      message_id: validatedRequest.messageId,
      correlation_id: validatedRequest.correlationId,
      run_id: runId,
      sender: {
        role: "conversation",
        agent_id: this.config.conversationAgentId ?? "chat",
        pane_id: this.config.conversationPaneId
      },
      recipient: {
        role: "coordinator",
        agent_id: this.config.coordinatorTarget.agentId,
        pane_id: this.config.coordinatorTarget.paneId
      },
      type: "delegation.request",
      payload: validatedRequest as unknown as JsonValue,
      artifact_references: [...validatedRequest.inputArtifacts],
      occurred_at: validatedRequest.requestedAt,
      idempotency_key: validatedRequest.idempotencyKey
    };

    const sendResult = await this.sendRoleMessageToCoordinator(roleMessage, options);
    if (!sendResult.ok) {
      return sendResult;
    }
    return { ok: true, value: undefined };
  }

  async reportProgressToConversation(
    message: ConversationMessage,
    options?: OperationOptions
  ): Promise<OperationResult<void>> {
    const parsedMsg = ConversationMessageSchema.safeParse(message);
    if (!parsedMsg.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Invalid ConversationMessage: ${parsedMsg.error.message}`,
          details: JSON.parse(JSON.stringify(parsedMsg.error.issues))
        }
      };
    }
    const validatedMsg = parsedMsg.data;
    const correlationId = validatedMsg.correlationId;
    const runId = validatedMsg.runId ?? `run-${correlationId}`;
    const payload: Record<string, unknown> = {
      message: validatedMsg.content,
      ...(validatedMsg.metadata ?? {})
    };

    const rawRoleMsg = {
      schema_version: 2 as const,
      message_id: `msg-prog-${validatedMsg.messageId}-${Date.now()}`,
      correlation_id: correlationId,
      run_id: runId,
      sender: {
        role: "coordinator" as const,
        agent_id: this.config.coordinatorTarget.agentId,
        pane_id: this.config.coordinatorTarget.paneId
      },
      recipient: {
        role: "conversation" as const,
        agent_id: this.config.conversationAgentId ?? "chat",
        pane_id: this.config.conversationPaneId
      },
      type: "conversation.progress" as const,
      payload: payload as unknown as JsonValue,
      artifact_references: [...validatedMsg.artifactReferences],
      occurred_at: validatedMsg.createdAt
    };

    const parsedRoleMsg = RoleMessageSchema.safeParse(rawRoleMsg);
    if (!parsedRoleMsg.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Failed to construct valid RoleMessage for progress: ${parsedRoleMsg.error.message}`,
          details: JSON.parse(JSON.stringify(parsedRoleMsg.error.issues))
        }
      };
    }

    if (this.inboundHandler) {
      const handlerResult = await this.inboundHandler(parsedRoleMsg.data, options);
      if (!handlerResult.ok) {
        return { ok: false, error: handlerResult.error };
      }
    }

    return { ok: true, value: undefined };
  }

  async promptApproval(
    request: ApprovalRequest,
    options?: OperationOptions
  ): Promise<OperationResult<void>> {
    const parsedReq = ApprovalRequestSchema.safeParse(request);
    if (!parsedReq.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Invalid ApprovalRequest: ${parsedReq.error.message}`,
          details: JSON.parse(JSON.stringify(parsedReq.error.issues))
        }
      };
    }
    const validatedReq = parsedReq.data;
    const correlationId =
      typeof validatedReq.metadata?.["correlationId"] === "string"
        ? (validatedReq.metadata["correlationId"] as string)
        : validatedReq.runId;

    const rawRoleMsg = {
      schema_version: 2 as const,
      message_id: `msg-apr-prompt-${validatedReq.approvalId}-${Date.now()}`,
      correlation_id: correlationId,
      run_id: validatedReq.runId,
      sender: {
        role: "coordinator" as const,
        agent_id: this.config.coordinatorTarget.agentId,
        pane_id: this.config.coordinatorTarget.paneId
      },
      recipient: {
        role: "conversation" as const,
        agent_id: this.config.conversationAgentId ?? "chat",
        pane_id: this.config.conversationPaneId
      },
      type: "approval.request" as const,
      payload: validatedReq as unknown as JsonValue,
      artifact_references: [...validatedReq.evidence],
      occurred_at: validatedReq.requestedAt
    };

    const parsedRoleMsg = RoleMessageSchema.safeParse(rawRoleMsg);
    if (!parsedRoleMsg.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Failed to construct valid RoleMessage for approval prompt: ${parsedRoleMsg.error.message}`,
          details: JSON.parse(JSON.stringify(parsedRoleMsg.error.issues))
        }
      };
    }

    if (this.inboundHandler) {
      const handlerResult = await this.inboundHandler(parsedRoleMsg.data, options);
      if (!handlerResult.ok) {
        return { ok: false, error: handlerResult.error };
      }
    }

    return { ok: true, value: undefined };
  }

  async receiveApprovalDecision(
    decision: ApprovalDecision,
    options?: OperationOptions
  ): Promise<OperationResult<void>> {
    const parsedDecision = ApprovalDecisionSchema.safeParse(decision);
    if (!parsedDecision.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Invalid ApprovalDecision: ${parsedDecision.error.message}`,
          details: JSON.parse(JSON.stringify(parsedDecision.error.issues))
        }
      };
    }
    const validatedDecision = parsedDecision.data;
    const correlationId =
      typeof validatedDecision.metadata?.["correlationId"] === "string"
        ? (validatedDecision.metadata["correlationId"] as string)
        : validatedDecision.runId;

    const messageId = `msg-apr-${validatedDecision.approvalId}-${Date.now()}`;
    const roleMessage: RoleMessage = {
      schema_version: 2,
      message_id: messageId,
      correlation_id: correlationId,
      run_id: validatedDecision.runId,
      sender: {
        role: "conversation",
        agent_id: this.config.conversationAgentId ?? "chat",
        pane_id: this.config.conversationPaneId
      },
      recipient: {
        role: "coordinator",
        agent_id: this.config.coordinatorTarget.agentId,
        pane_id: this.config.coordinatorTarget.paneId
      },
      type: "approval.decision",
      payload: validatedDecision as unknown as JsonValue,
      artifact_references: [...validatedDecision.feedbackArtifacts],
      occurred_at: validatedDecision.decidedAt,
      idempotency_key: validatedDecision.idempotencyKey
    };

    const sendResult = await this.sendRoleMessageToCoordinator(roleMessage, options);
    if (!sendResult.ok) {
      return sendResult;
    }
    return { ok: true, value: undefined };
  }
}

/**
 * Mock Herdr AgentTransport for testing the Conversation Gateway and Herdr Bridge.
 *
 * Captures sent AgentRequests and decoded RoleMessages, allows programmatic simulation
 * of accepted/rejected/unknown_delivery receipts, reconciliation results, and Coordinator replies.
 */
export class MockHerdrAgentTransport implements AgentTransport {
  readonly sentRequests: AgentRequest[] = [];
  readonly sentRoleMessages: RoleMessage[] = [];

  nextSubmissionStatus: "accepted" | "rejected" | "unknown_delivery" = "accepted";
  nextReconcileStatus: "bound" | "not_delivered" | "unknown_delivery" = "bound";
  rejectionReason = "Transport rejected execution";
  unknownDeliveryReason = "Transport network timeout: submission state indeterminate";
  nowProvider: () => string = () => new Date().toISOString();

  async initialize(
    _initialization: AgentTransportInitialization,
    _options?: OperationOptions
  ): Promise<OperationResult<AgentTransportCapabilities>> {
    return {
      ok: true,
      value: {
        transportName: "herdr-mock",
        protocolVersion: "22",
        supportsStreaming: true,
        supportsCancellation: true,
        supportsResume: true,
        supportsSubmissionCorrelation: true
      }
    };
  }

  async send(
    request: AgentRequest,
    _options?: OperationOptions
  ): Promise<OperationResult<AgentSubmissionReceipt>> {
    this.sentRequests.push(request);

    try {
      const parsedInstruction = JSON.parse(request.instruction);
      const parsedMsg = RoleMessageSchema.safeParse(parsedInstruction);
      if (parsedMsg.success) {
        this.sentRoleMessages.push(parsedMsg.data);
      }
    } catch {
      // not a RoleMessage JSON
    }

    const now = this.nowProvider();

    if (this.nextSubmissionStatus === "accepted") {
      const handle: AgentExecutionHandle = {
        executionId: `exec-${request.requestId}`,
        requestId: request.requestId,
        attemptId: request.attemptId,
        runId: request.runId,
        taskId: request.taskId,
        idempotencyKey: request.idempotency.key,
        target: request.target,
        correlation: {
          token: `corr-token-${request.requestId}`,
          provenance: "transport",
          verified: true
        },
        acceptedAt: now
      };

      return {
        ok: true,
        value: {
          status: "accepted",
          requestId: request.requestId,
          attemptId: request.attemptId,
          runId: request.runId,
          taskId: request.taskId,
          observedAt: now,
          handle
        }
      };
    }

    if (this.nextSubmissionStatus === "rejected") {
      return {
        ok: true,
        value: {
          status: "rejected",
          requestId: request.requestId,
          attemptId: request.attemptId,
          runId: request.runId,
          taskId: request.taskId,
          observedAt: now,
          reason: this.rejectionReason
        }
      };
    }

    return {
      ok: true,
      value: {
        status: "unknown_delivery",
        requestId: request.requestId,
        attemptId: request.attemptId,
        runId: request.runId,
        taskId: request.taskId,
        idempotencyKey: request.idempotency.key,
        target: request.target,
        observedAt: now,
        reason: this.unknownDeliveryReason,
        resendAllowed: false,
        manualInterventionRequired: true
      }
    };
  }

  async reconcile(
    request: AgentReconciliationRequest,
    _options?: OperationOptions
  ): Promise<OperationResult<AgentReconciliationResult>> {
    const now = this.nowProvider();

    if (this.nextReconcileStatus === "bound") {
      const handle: AgentExecutionHandle = {
        executionId: `exec-reconciled-${request.requestId}`,
        requestId: request.requestId,
        attemptId: request.attemptId,
        runId: request.runId,
        taskId: request.taskId,
        idempotencyKey: request.idempotencyKey,
        target: request.target,
        correlation: {
          token: `corr-reconciled-${request.requestId}`,
          provenance: "transport",
          verified: true
        },
        acceptedAt: now
      };
      return {
        ok: true,
        value: {
          status: "bound",
          handle
        }
      };
    }

    if (this.nextReconcileStatus === "not_delivered") {
      return {
        ok: true,
        value: {
          status: "not_delivered",
          requestId: request.requestId,
          retrySafe: true,
          observedAt: now
        }
      };
    }

    return {
      ok: true,
      value: {
        status: "unknown_delivery",
        requestId: request.requestId,
        retrySafe: false,
        observedAt: now,
        reason: "Reconciliation remains indeterminate after query",
        manualInterventionRequired: true
      }
    };
  }

  async wait(
    handle: AgentExecutionHandle,
    _options?: AgentWaitOptions
  ): Promise<OperationResult<AgentTransportObservation>> {
    return {
      ok: true,
      value: {
        handle,
        state: "working",
        observedAt: this.nowProvider(),
        correlationVerified: true
      }
    };
  }

  async *read(
    _handle: AgentExecutionHandle,
    _options?: AgentReadOptions
  ): AsyncIterable<OperationResult<AgentMessage>> {
    // Mock empty generator
  }

  async cancel(
    _handle: AgentExecutionHandle,
    request: CancellationRequest,
    _options?: OperationOptions
  ): Promise<OperationResult<CancellationResult>> {
    return {
      ok: true,
      value: {
        schemaVersion: 1,
        cancellationId: `cancel-${request.runId}`,
        status: "accepted",
        observedAt: this.nowProvider()
      }
    };
  }

  // --- Helper generators for Coordinator replies in tests ---

  createDelegationAcceptedReply(params: {
    messageId: string;
    correlationId: string;
    runId: string;
    delegationId: string;
    coordinatorAgentId?: string;
    coordinatorPaneId?: string;
    conversationAgentId?: string;
    conversationPaneId?: string;
  }): RoleMessage {
    return {
      schema_version: 2,
      message_id: params.messageId,
      correlation_id: params.correlationId,
      run_id: params.runId,
      sender: {
        role: "coordinator",
        agent_id: params.coordinatorAgentId ?? "coordinator",
        pane_id: params.coordinatorPaneId ?? "pane-coordinator"
      },
      recipient: {
        role: "conversation",
        agent_id: params.conversationAgentId ?? "chat",
        pane_id: params.conversationPaneId ?? "pane-chat"
      },
      type: "delegation.accepted",
      payload: {
        delegationId: params.delegationId,
        runId: params.runId,
        acceptedAt: this.nowProvider()
      },
      artifact_references: [],
      occurred_at: this.nowProvider()
    };
  }

  createProgressReply(params: {
    messageId: string;
    correlationId: string;
    runId: string;
    sdlcStatus: SdlcWorkStatus;
    taskState?: "starting" | "running" | "blocked" | "completed" | "failed";
    headline: string;
    blockageReason?: string;
    failureSummary?: string;
    progressPercentage?: number;
    verified?: boolean;
    coordinatorAgentId?: string;
    coordinatorPaneId?: string;
    conversationAgentId?: string;
    conversationPaneId?: string;
  }): RoleMessage {
    const payload: Record<string, unknown> = {
      runId: params.runId,
      sdlcStatus: params.sdlcStatus,
      headline: params.headline
    };
    if (params.taskState !== undefined) payload["taskState"] = params.taskState;
    if (params.blockageReason !== undefined) payload["blockageReason"] = params.blockageReason;
    if (params.failureSummary !== undefined) payload["failureSummary"] = params.failureSummary;
    if (params.progressPercentage !== undefined) payload["progressPercentage"] = params.progressPercentage;
    if (params.verified !== undefined) payload["verified"] = params.verified;

    return {
      schema_version: 2,
      message_id: params.messageId,
      correlation_id: params.correlationId,
      run_id: params.runId,
      sender: {
        role: "coordinator",
        agent_id: params.coordinatorAgentId ?? "coordinator",
        pane_id: params.coordinatorPaneId ?? "pane-coordinator"
      },
      recipient: {
        role: "conversation",
        agent_id: params.conversationAgentId ?? "chat",
        pane_id: params.conversationPaneId ?? "pane-chat"
      },
      type: "conversation.progress",
      payload: payload as unknown as JsonValue,
      artifact_references: [],
      occurred_at: this.nowProvider()
    };
  }

  createApprovalRequestReply(params: {
    messageId: string;
    correlationId: string;
    runId: string;
    approvalRequest: ApprovalRequest;
    coordinatorAgentId?: string;
    coordinatorPaneId?: string;
    conversationAgentId?: string;
    conversationPaneId?: string;
  }): RoleMessage {
    return {
      schema_version: 2,
      message_id: params.messageId,
      correlation_id: params.correlationId,
      run_id: params.runId,
      sender: {
        role: "coordinator",
        agent_id: params.coordinatorAgentId ?? "coordinator",
        pane_id: params.coordinatorPaneId ?? "pane-coordinator"
      },
      recipient: {
        role: "conversation",
        agent_id: params.conversationAgentId ?? "chat",
        pane_id: params.conversationPaneId ?? "pane-chat"
      },
      type: "approval.request",
      payload: params.approvalRequest as unknown as JsonValue,
      artifact_references: [...params.approvalRequest.evidence],
      occurred_at: this.nowProvider()
    };
  }
}
