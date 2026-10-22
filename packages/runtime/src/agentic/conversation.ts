import {
  ApprovalDecisionSchema, ApprovalRequestSchema, ConversationMessageSchema, DelegationRequestSchema, RoleMessageSchema, SessionManifestSchema,
  type JsonValue, type OperationResult, type RoleMessage, type SessionManifest
} from "@bflow/contracts";
import { digest, json, record, textField } from "./journal.js";
import { redactString } from "../resilience/redaction.js";
import { validateUserDecisionAnswer } from "./decision-routing.js";
import type { AgenticWorkflowRuntime } from "./runtime.js";

export interface AgenticConversationHost {
  handleUserTurn(input: unknown): Promise<unknown>;
  getContext(): Promise<unknown>;
  parseDecision(input: unknown): Promise<unknown>;
  validateDecision(input: unknown): Promise<void>;
  handleTrustedApproval(input: unknown): Promise<unknown | undefined>;
  receiveHerdr(input: unknown): Promise<unknown>;
  /** Runtime's own outbox only: the message was validated at its ingress, so no Herdr signature is required. */
  receiveRuntime(input: unknown): Promise<unknown>;
  setBusy(busy: boolean): Promise<unknown>;
  flush(): Promise<unknown>;
  /** Registers Runtime-pending approvals Conversation missed; read-only toward Runtime, never decides anything. */
  reconcileApprovals(): Promise<unknown>;
}
/** Compose the actual P14 Gateway with P19's durable Herdr outbox, retaining P14 dialogue/queue policies. */
export async function createAgenticConversationHost(options: {
  runtime: AgenticWorkflowRuntime; manifest: SessionManifest; contextDirectory: string;
  onHumanDecision?: (decision: import("@bflow/contracts").ApprovalDecision) => Promise<void>;
  /** Independently authenticated host receipts only; Gateway context is never human authority. */
  recoveredHumanDecisions?: readonly import("@bflow/contracts").ApprovalDecision[];
}): Promise<AgenticConversationHost> {
  const manifest = SessionManifestSchema.parse(options.manifest);
  const conversation = manifest.panes.find(pane => pane.role === "conversation");
  const coordinator = manifest.panes.find(pane => pane.role === "coordinator");
  if (!conversation || !coordinator) throw new Error("Conversation and Coordinator panes are required");
  const module = await import(new URL("../../../conversation/dist/index.js", import.meta.url).href);
  const runtime = options.runtime;
  const enqueue = async (message: RoleMessage): Promise<OperationResult<void>> => {
    try { await runtime.queueHerdr(message); return { ok: true, value: undefined }; }
    catch (error) {
      // Runtime refusing a request is a decision about its content, not damaged data; the user already has its notice.
      const refused = error instanceof Error && error.name === "AdmissionRejectedError";
      return { ok: false, error: { code: refused ? "validation" : "corruption", retryable: false, message: String(error) } };
    }
  };
  const enqueueDecision = async (input: unknown): Promise<OperationResult<void>> => {
    const decision = ApprovalDecisionSchema.parse(input);
    // Preserve the original envelope (including pane identity) if already queued or uncertain.
    const state = record(await runtime.inspect());
    const messageId = `approval-${digest(decision)}`;
    const existing = (state.outbound as { message: unknown }[]).find(item => record(item.message).message_id === messageId);
    if (existing) {
      const message = RoleMessageSchema.parse(existing.message);
      if (message.type !== "approval.decision" || digest(message.payload) !== digest(decision)) throw new Error("Conflicting recovered human decision");
      return { ok: true, value: undefined };
    }
    const run = record(await runtime.inspect(decision.runId));
    if (run.cancelled === true || ["completed", "failed", "cancelled"].includes(String(run.status)))
      throw new Error("Run is terminal; approval cannot continue it");
    const userDecision = (run.userDecisions as Record<string, { request: unknown; status?: string } | undefined> | undefined)?.[decision.approvalId];
    if (userDecision) {
      // Specialist user decisions have their own record; they never occupy the single design/task approval slot.
      // A reply for an already answered/expired request is refused here, not queued for Runtime to reject later.
      if (userDecision.status !== "pending") throw new Error("User decision is no longer pending");
      validateUserDecisionAnswer(ApprovalRequestSchema.parse(userDecision.request), decision, new Date().toISOString());
    } else {
      const request = ApprovalRequestSchema.parse(run.approval);
      if (request.approvalId !== decision.approvalId || request.runId !== decision.runId || request.sessionId !== decision.sessionId ||
          request.revision !== decision.revision || request.generation !== decision.generation || digest(request.target) !== digest(decision.target))
        throw new Error("Recovered decision does not match the exact approval request");
    }
    const correlationId = textField(record(run.delegation).correlationId);
    return enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: messageId,
      correlation_id: correlationId, run_id: decision.runId,
      sender: { role: "conversation", agent_id: conversation!.agentId, pane_id: conversation!.paneId },
      recipient: { role: "coordinator", agent_id: coordinator!.agentId, pane_id: coordinator!.paneId },
      type: "approval.decision", payload: json(decision), artifact_references: decision.feedbackArtifacts,
      occurred_at: decision.decidedAt, idempotency_key: decision.idempotencyKey }));
  };
  class DurableBridge extends module.HerdrConversationBridge {
    constructor(config: unknown) { super(config); }
    async handOffToCoordinator(input: unknown): Promise<OperationResult<void>> {
      const request = DelegationRequestSchema.parse(input);
      const runId = request.runId ?? `run-${request.correlationId}`;
      return enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: request.messageId, correlation_id: request.correlationId,
        run_id: runId, sender: { role: "conversation", agent_id: conversation!.agentId, pane_id: conversation!.paneId },
        recipient: { role: "coordinator", agent_id: coordinator!.agentId, pane_id: coordinator!.paneId }, type: "delegation.request",
        payload: json({ ...request, runId }), artifact_references: request.inputArtifacts,
        occurred_at: request.requestedAt, idempotency_key: request.idempotencyKey }));
    }
    async receiveApprovalDecision(input: unknown): Promise<OperationResult<void>> {
      const decision = ApprovalDecisionSchema.parse(input);
      await options.onHumanDecision?.(decision);
      return enqueueDecision(decision);
    }
    async reportProgressToConversation(): Promise<OperationResult<void>> {
      throw new Error("Runtime must queue a RoleMessage through Herdr; local progress callbacks are disabled");
    }
    async promptApproval(): Promise<OperationResult<void>> {
      throw new Error("Runtime must queue an approval.request through Herdr; local approval callbacks are disabled");
    }
  }
  const bridge = new DurableBridge({ transport: runtime.ports.transport, sessionId: manifest.conversationSessionId,
    conversationAgentId: conversation.agentId, conversationPaneId: conversation.paneId,
    coordinatorTarget: { transport: "herdr", agentId: coordinator.agentId, paneId: coordinator.paneId,
      workspaceId: coordinator.workspaceId, tabId: coordinator.tabId } });
  const contextStore = new module.FileConversationContextStore(options.contextDirectory);
  const gateway = new module.ConversationGateway({ sessionId: manifest.conversationSessionId, herdrSessionId: manifest.sessionId,
    conversationAgentId: conversation.agentId, paneId: conversation.paneId, bridge,
    contextStore });
  const initialized = await gateway.initializeOrRecoverSession();
  if (!initialized.ok) throw new Error(initialized.error.message);
  for (const decision of options.recoveredHumanDecisions ?? []) {
    const result = await enqueueDecision(decision);
    if (!result.ok) throw new Error(result.error.message);
    // A crash can happen after the trusted receipt/outbox write but before P14 saves its turn.
    // Restore governance state without inventing a user message or resubmitting the decision.
    const loaded = await contextStore.load(manifest.conversationSessionId);
    if (!loaded.ok) throw new Error(loaded.error.message);
    if (!loaded.value) throw new Error("Conversation context disappeared during approval recovery");
    const snapshot = loaded.value, cached = snapshot.approvalDecisions[decision.approvalId];
    if (cached && digest(cached) !== digest(decision)) throw new Error("Cached decision conflicts with trusted human receipt");
    const pending = snapshot.pendingApprovals[decision.approvalId];
    if (!pending) continue;
    if (pending.runId !== decision.runId || pending.sessionId !== decision.sessionId || pending.revision !== decision.revision ||
        pending.generation !== decision.generation || digest(pending.target) !== digest(decision.target)) throw new Error("Cached approval request conflicts with trusted human receipt");
    const pendingApprovals = { ...snapshot.pendingApprovals }; delete pendingApprovals[decision.approvalId];
    const activeApprovalIds = snapshot.session.activeApprovalIds.filter((id: string) => id !== decision.approvalId);
    const workflows = Object.fromEntries(Object.entries(snapshot.workflows).map(([id, workflow]) => [id, {
      ...record(workflow), activeApprovalIds: (record(workflow).activeApprovalIds as string[]).filter(value => value !== decision.approvalId)
    }]));
    const saved = await contextStore.save(module.closeClarificationsForApproval({ ...snapshot, pendingApprovals, workflows,
      approvalDecisions: { ...snapshot.approvalDecisions, [decision.approvalId]: decision },
      session: { ...snapshot.session, activeApprovalIds,
        status: activeApprovalIds.length ? "awaiting_user_approval" : "reporting_progress" } }, decision.approvalId, new Date().toISOString()));
    if (!saved.ok) throw new Error(saved.error.message);
  }
  if (options.recoveredHumanDecisions?.length) {
    const refreshed = await gateway.initializeOrRecoverSession();
    if (!refreshed.ok) throw new Error(refreshed.error.message);
  }
  // Runtime journal is authoritative for status, including cancellation. This is local projection reconciliation,
  // never a fabricated Herdr receipt or a human decision; the Gateway validates the exported nested contracts.
  let runtimeRunIds: string[] = [];
  let projectionWarnings: string[] = [];
  const reconcileRuns = async () => {
    const state = record(await runtime.inspect());
    if (!Array.isArray(state.runs)) throw new Error("Runtime returned invalid run status snapshot");
    const entries = state.runs.map(input => {
      const run = record(input), delegation = DelegationRequestSchema.parse(run.delegation);
      return { runId: run.runId, delegation, status: run.status, cancelled: run.cancelled };
    }).filter(run => run.delegation.sessionId === manifest.conversationSessionId);
    const result = await gateway.reconcileRuntimeRuns(entries);
    if (!result.ok) throw new Error(result.error.message);
    projectionWarnings = result.value.rejected.map((reason: string) => `Runtime projection could not be reconciled: ${reason}`);
    runtimeRunIds = entries.map(run => run.delegation.runId!);
  };
  const runtimeStatus = () => {
    const known = new Set(runtimeRunIds);
    const snapshotOnlyRunIds = Object.values(gateway.getContextSnapshot().workflows)
      .map(input => textField(record(input).runId)).filter(runId => !known.has(runId));
    return { runtimeRunIds, snapshotOnlyRunIds,
      ...(snapshotOnlyRunIds.length ? { warning: "Conversation entries without a matching Runtime run are historical projection only; they do not prove running or fully stopped work." } : {}) };
  };
  /** Asks Runtime what is pending for this session and registers what Conversation lacks. Warnings stay until a later reconcile clears them. */
  let approvalWarnings: string[] = [];
  const reconcileApprovals = async () => {
    try {
      await reconcileRuns();
      const pending = await runtime.pendingApprovals({ sessionId: manifest.conversationSessionId });
      const result = await gateway.reconcilePendingApprovals(pending);
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.busy) return result.value;
      const runOf = new Map(pending.map(item => [item.request.approvalId, item.request.runId]));
      approvalWarnings = result.value.rejected.map((item: { approvalId: string; reason: string }) =>
        `Runtime đang chờ quyết định của người dùng (${item.approvalId}${runOf.has(item.approvalId) ? `, run ${runOf.get(item.approvalId)}` : ""}) ` +
        `nhưng Conversation không đăng ký được: ${item.reason}.`);
      return result.value;
    } catch (error) {
      approvalWarnings = [`Không truy vấn được approval đang chờ từ Runtime: ${error instanceof Error ? error.message : String(error)}.`];
      throw error;
    }
  };
  /** Why the current user turn's approval-shaped reply was not recorded; replaced on every trusted turn. */
  let turnWarnings: string[] = [];
  const withWarnings = (result: unknown) =>
    result && typeof result === "object" ? { ...(result as object), runtimeStatus: runtimeStatus(),
      ...([...approvalWarnings, ...projectionWarnings].length ? { approvalWarnings: [...approvalWarnings, ...projectionWarnings] } : {}) } : result;
  return {
    reconcileApprovals,
    async handleUserTurn(input) {
      await reconcileApprovals().catch(() => undefined);
      return withWarnings(await gateway.handleUserTurn(input));
    },
    async getContext() {
      await reconcileRuns().catch(error => { projectionWarnings = [`Runtime status unavailable: ${redactString(String(error))}`]; });
      const context = gateway.getContextSnapshot();
      return json({ session: context.session, pendingClarifications: context.pendingClarifications,
        pendingApprovals: context.pendingApprovals, approvalWarnings: [...turnWarnings, ...approvalWarnings, ...projectionWarnings], workflows: context.workflows,
        runIdToCorrelationId: context.runIdToCorrelationId, agentBusy: context.agentBusy, runtimeStatus: runtimeStatus(),
        messages: context.messages.slice(-20).map((input: unknown) => {
          const { metadata: _metadata, ...message } = ConversationMessageSchema.parse(input); return message;
        }) });
    },
    async parseDecision(input) { return module.ChatDecisionSchema.parse(input); },
    async validateDecision(input) {
      await reconcileRuns();
      const result = module.resolveChatDecision(module.ChatDecisionSchema.parse(input), gateway.getContextSnapshot());
      if (!result.ok) throw new Error(result.error.message);
    },
    async handleTrustedApproval(input) {
      await reconcileRuns();
      turnWarnings = [];
      const context = gateway.getContextSnapshot();
      const parsed = module.UserTurnInputSchema.parse(input);
      // Resume the same hook turn from Gateway state; reapplying could misroute an already-decided approval.
      const committed = parsed.messageId === undefined ? -1 : context.messages.findIndex((message: { sender: string; messageId: string }) =>
        message.sender === "user" && message.messageId === parsed.messageId);
      if (committed >= 0) {
        const userMessage = ConversationMessageSchema.parse(context.messages[committed]);
        const agentReply = context.messages[committed + 1] ? ConversationMessageSchema.parse(context.messages[committed + 1]) : undefined;
        if (userMessage.intent !== "approval_response" || userMessage.content !== parsed.content || agentReply?.sender !== "conversation")
          throw new Error("Trusted approval message ID conflicts with a committed Conversation turn");
        return { ok: true, value: { sessionId: context.session.sessionId, correlationId: userMessage.correlationId,
          ...(userMessage.runId ? { runId: userMessage.runId } : {}), recognizedIntent: "approval_response",
          sessionStatus: context.session.status, userMessage, agentReply, queuedBecauseBusy: false, substantiveUpdate: true } };
      }
      const queued = parsed.messageId !== undefined && context.pendingInboundQueue.some((item: { kind: string; input?: { messageId?: string } }) =>
        item.kind === "user_turn" && item.input?.messageId === parsed.messageId);
      if (queued) return { ok: true, value: { sessionId: context.session.sessionId, recognizedIntent: "approval_response",
        sessionStatus: context.session.status, queuedBecauseBusy: true, substantiveUpdate: false } };
      // A lost approval.request must not strand the user's answer: ask Runtime what is pending before classifying.
      const named: string | undefined = module.namedApprovalId(parsed.content, context);
      let current = context;
      if (named !== undefined || Object.keys(context.pendingApprovals).length === 0) {
        await reconcileApprovals().catch(() => undefined);
        current = gateway.getContextSnapshot();
      }
      if (named !== undefined && !current.pendingApprovals[named]) {
        const rest = parsed.content.replace(named, "").replace(/^[\s:,-]+|[\s:,.!?-]+$/gu, "");
        // Only a short reply shaped like "apr-...: answer" is an approval attempt; longer text is ordinary discussion for Chat.
        if (rest.length > 0 && rest.length <= 40) return { ok: false, error: { code: "not_found", retryable: false,
          message: `Không tìm thấy approval ${named} đang chờ trong session này${current.session.activeRunId ? ` (run ${current.session.activeRunId})` : ""}; câu trả lời chưa được ghi nhận.` +
            (approvalWarnings.length ? ` ${approvalWarnings.join(" ")}` : "") } };
      }
      if (Object.keys(current.pendingApprovals).length === 0) return undefined;
      const classified = module.classifyTrustedApprovalReply(parsed, current);
      if (!classified?.ok) {
        // Not recorded: say why in this turn's context so the Conversation model never drops the reply silently.
        const unrecorded: string | undefined = module.explainUnrecordedApprovalReply(parsed, current);
        if (unrecorded !== undefined) turnWarnings = [unrecorded];
        return undefined;
      }
      return gateway.handleUserTurn(parsed);
    },
    async receiveHerdr(input) {
      const message = RoleMessageSchema.parse(input);
      if (!await runtime.ports.authenticateMessage(message) || message.recipient.role !== "conversation") throw new Error("Unauthenticated Conversation delivery");
      const result = await gateway.handleCoordinatorRoleMessage(message);
      if (!result.ok) throw new Error(result.error.message);
      return result;
    },
    async receiveRuntime(input) {
      const message = RoleMessageSchema.parse(input);
      if (message.recipient.role !== "conversation") throw new Error("Wrong Conversation inbox recipient");
      // Gateway drops an already processed message_id, so a redelivery after a crash is harmless.
      const result = await gateway.handleCoordinatorRoleMessage(message);
      if (!result.ok) throw new Error(result.error.message);
      return result;
    },
    setBusy: busy => gateway.setAgentBusyState(busy),
    flush: () => gateway.flushPendingInboundQueue()
  };
}

/** Example host response wrapper; never interprets a Herdr terminal snapshot as an envelope. */
export function serializeHostResult(value: unknown): JsonValue { return json(value); }
