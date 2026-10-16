import {
  ApprovalDecisionSchema, DelegationRequestSchema, RoleMessageSchema, SessionManifestSchema,
  type JsonValue, type OperationResult, type RoleMessage, type SessionManifest
} from "@bflow/contracts";
import { digest, json, record, textField } from "./journal.js";
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
      const run = record(await runtime.inspect(decision.runId));
      const correlationId = textField(record(run.delegation).correlationId);
      return enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: `approval-${digest(decision)}`,
        correlation_id: correlationId, run_id: decision.runId,
        sender: { role: "conversation", agent_id: conversation!.agentId, pane_id: conversation!.paneId },
        recipient: { role: "coordinator", agent_id: coordinator!.agentId, pane_id: coordinator!.paneId },
        type: "approval.decision", payload: json(decision), artifact_references: decision.feedbackArtifacts,
        occurred_at: decision.decidedAt, idempotency_key: decision.idempotencyKey }));
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
  const gateway = new module.ConversationGateway({ sessionId: manifest.conversationSessionId, herdrSessionId: manifest.sessionId,
    conversationAgentId: conversation.agentId, paneId: conversation.paneId, bridge,
    contextStore: new module.FileConversationContextStore(options.contextDirectory) });
  const initialized = await gateway.initializeOrRecoverSession();
  if (!initialized.ok) throw new Error(initialized.error.message);
  return {
    handleUserTurn: input => gateway.handleUserTurn(input),
    async receiveHerdr(input) {
      const message = RoleMessageSchema.parse(input);
      if (!await runtime.ports.authenticateMessage(message) || message.recipient.role !== "conversation") throw new Error("Unauthenticated Conversation delivery");
      return gateway.handleCoordinatorRoleMessage(message);
    },
    setBusy: busy => gateway.setAgentBusyState(busy),
    flush: () => gateway.flushPendingInboundQueue()
  };
}

/** Example host response wrapper; never interprets a Herdr terminal snapshot as an envelope. */
export function serializeHostResult(value: unknown): JsonValue { return json(value); }
