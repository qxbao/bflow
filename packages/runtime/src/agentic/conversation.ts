import {
  ApprovalDecisionSchema, ApprovalRequestSchema, DelegationRequestSchema, RoleMessageSchema, SessionManifestSchema,
  type JsonValue, type OperationResult, type RoleMessage, type SessionManifest
} from "@bflow/contracts";
import { digest, json, record, textField } from "./journal.js";
import { validateUserDecisionAnswer } from "./decision-routing.js";
import type { AgenticWorkflowRuntime } from "./runtime.js";

export interface AgenticConversationHost {
  handleUserTurn(input: unknown): Promise<unknown>;
  receiveHerdr(input: unknown): Promise<unknown>;
  setBusy(busy: boolean): Promise<unknown>;
  flush(): Promise<unknown>;
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
    catch (error) { return { ok: false, error: { code: "corruption", retryable: false, message: String(error) } }; }
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
    const userDecision = (run.userDecisions as Record<string, { request: unknown } | undefined> | undefined)?.[decision.approvalId];
    if (userDecision) {
      // Specialist user decisions have their own record; they never occupy the single design/task approval slot.
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
    const saved = await contextStore.save({ ...snapshot, pendingApprovals, workflows,
      approvalDecisions: { ...snapshot.approvalDecisions, [decision.approvalId]: decision },
      session: { ...snapshot.session, activeApprovalIds,
        status: activeApprovalIds.length ? "awaiting_user_approval" : "reporting_progress" } });
    if (!saved.ok) throw new Error(saved.error.message);
  }
  if (options.recoveredHumanDecisions?.length) {
    const refreshed = await gateway.initializeOrRecoverSession();
    if (!refreshed.ok) throw new Error(refreshed.error.message);
  }
  return {
    handleUserTurn: input => gateway.handleUserTurn(input),
    async receiveHerdr(input) {
      const message = RoleMessageSchema.parse(input);
      if (!await runtime.ports.authenticateMessage(message) || message.recipient.role !== "conversation") throw new Error("Unauthenticated Conversation delivery");
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
