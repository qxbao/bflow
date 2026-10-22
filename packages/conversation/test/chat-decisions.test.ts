import { describe, expect, it, vi } from "vitest";
import {
  ConversationGateway, HerdrConversationBridge, InMemoryConversationContextStore, MockHerdrAgentTransport
} from "../src/index.js";

async function setup() {
  const store = new InMemoryConversationContextStore();
  const transport = new MockHerdrAgentTransport();
  const config = { sessionId: "session-chat", herdrSessionId: "herdr-chat", paneId: "pane-chat", contextStore: store,
    bridge: new HerdrConversationBridge({ transport, sessionId: "session-chat", conversationAgentId: "chat",
      conversationPaneId: "pane-chat", coordinatorTarget: { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator" } }) };
  const gateway = new ConversationGateway(config);
  await gateway.initializeOrRecoverSession();
  let seq = 0;
  const turn = (content: string, conversationDecision: unknown, extra = {}) => gateway.handleUserTurn({
    sessionId: "session-chat", messageId: `human-${++seq}`, content,
    provenance: { origin: "user", authenticatedUser: true }, conversationDecision, ...extra
  } as Parameters<typeof gateway.handleUserTurn>[0]);
  return { gateway, transport, store, config, turn };
}

const spike = (objective: string) => ({ intent: "workflow_request", requirementDraft: {
  title: "Khảo sát quyền MCP theo role", objective, kind: "spike", sddLevel: "lightweight", priority: "normal",
  scopeDefined: true, isLargeTask: false, affectedPaths: [],
  acceptanceCriteriaDescriptions: ["Liệt kê MCP được phép theo từng role, nơi cấu hình và cơ chế chặn; chỉ đọc, không sửa code"],
  isRequirementChange: false
} });

describe("Chat decides intent; Gateway validates and executes", () => {
  it.each([
    "Tạo spike: khảo sát quyền truy cập MCP của từng role (coordinator, analyst, architect, planner, developer, reviewer, verifier). Chỉ đọc, không sửa code.",
    "Yêu cầu workflow loại spike, sddLevel lightweight: khảo sát quyền truy cập MCP của từng role",
    "<pasted_content>Yêu cầu workflow loại bugfix, sddLevel lightweight: sửa Conversation Gateway. Phạm vi: intent classifier và session state machine.</pasted_content>"
  ])("dispatches a structured Chat decision without reclassifying wording: %s", async content => {
    const { turn, transport } = await setup();
    const result = await turn(content, spike(content));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recognizedIntent).toBe("workflow_request");
    expect(result.value.delegationRequest?.sddLevel).toBe("lightweight");
    expect(result.value.delegationRequest?.metadata?.codeChangesAuthorized).toBe(false);
    expect(transport.sentRoleMessages).toHaveLength(1);
  });

  it("registers Chat's actual questions and accepts its interpretation of a short choice", async () => {
    const { turn, gateway } = await setup();
    const original = "Tôi muốn fix cái việc không thể tạo task dù đã define rõ";
    const first = await turn(original, { intent: "clarify", clarifyingQuestions: [
      "A: chỉ Conversation Gateway, B: thêm thông báo lỗi. Chọn phạm vi?", "Giữ cả 5 tiêu chí đã nêu?"
    ] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(gateway.getContextSnapshot().pendingClarifications[first.value.correlationId]?.unresolvedQuestions[0]).toContain("A:");
    const decision = spike(`${original}\nPhạm vi: Conversation Gateway. Giữ cả 5 tiêu chí.`);
    const next = await turn("A, giữ cả 5 tiêu chí", { ...decision, targetCorrelationId: first.value.correlationId });
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.value.recognizedIntent).toBe("workflow_request");
      expect(next.value.correlationId).toBe(first.value.correlationId);
    }
    expect(gateway.getContextSnapshot().pendingClarifications).toEqual({});
  });

  it("creates a fresh correlation while an earlier request is delegated", async () => {
    const { turn } = await setup();
    const first = await turn("Khảo sát MCP", spike("Khảo sát MCP"));
    if (!first.ok) throw new Error(first.error.message);
    const second = await turn("Yêu cầu workflow spike: khảo sát kỹ năng", spike("Khảo sát kỹ năng"), { correlationId: first.value.correlationId });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.correlationId).not.toBe(first.value.correlationId);
      expect(second.value.runId).not.toBe(first.value.runId);
    }
  });

  it("accepts Chat's Logs revision while the old approval is still pending, preserving correlation and replay identity", async () => {
    const { turn, gateway, config, transport } = await setup();
    const first = await turn("Tích hợp realtime Logs", { intent: "workflow_request", requirementDraft: {
      ...spike("Tích hợp realtime Logs").requirementDraft, kind: "feature", title: "Logs", sddLevel: "full",
      acceptanceCriteriaDescriptions: ["Realtime Logs và kiểm tra reconnect"]
    } });
    if (!first.ok || !first.value.runId) throw new Error("setup failed");
    const runId = first.value.runId, correlationId = first.value.correlationId;
    expect((await gateway.handleCoordinatorRoleMessage({ schema_version: 2, message_id: "decision-logs", correlation_id: correlationId,
      run_id: runId, sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "approval.request",
      payload: { schemaVersion: 2, approvalId: "apr-logs-design", runId, sessionId: "session-chat", status: "pending",
        target: { type: "run" }, revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: new Date().toISOString(),
        reason: "Approve the design?", evidence: [], idempotencyKey: "logs-design", metadata: { kind: "user_decision",
          question: "Approve the design?", options: ["Approve design", "Request changes to the design"] } }, artifact_references: []
    })).ok).toBe(true);
    const feedback = "2. Bỏ realtime, chỉ hiển thị các bước tổng quan trong Logs";
    expect(gateway.getContextSnapshot().pendingApprovals["apr-logs-design"]?.status).toBe("pending");
    const decision = { intent: "workflow_request", targetRunId: runId, requirementDraft: {
      ...spike("Chỉ hiển thị các bước tổng quan trong Logs; bỏ yêu cầu realtime").requirementDraft,
      kind: "feature", title: "Logs overview", isRequirementChange: true,
      acceptanceCriteriaDescriptions: ["Logs hiển thị các bước tổng quan theo thứ tự; không cần realtime"]
    } };
    const revision = await turn(feedback, decision, { messageId: "human-logs-revision" });
    expect(revision.ok && revision.value).toMatchObject({ runId, correlationId,
      delegationRequest: { runId, metadata: { revision: 2, isRequirementChange: true } } });
    expect(Object.keys(gateway.getContextSnapshot().workflows)).toEqual([correlationId]);
    expect(gateway.getContextSnapshot().pendingClarifications).toEqual({});
    const recovered = new ConversationGateway(config);
    expect((await recovered.handleUserTurn({ sessionId: "session-chat", messageId: "human-logs-revision",
      content: feedback, conversationDecision: decision } as never)).ok).toBe(true);
    expect(transport.sentRoleMessages.some(message => message.type === "approval.decision")).toBe(false);
    expect(transport.sentRoleMessages.filter(message => message.type === "delegation.request")).toHaveLength(2);
  });

  it.each(["Xin chào", "Bạn có những MCP nào", "A, giữ cả 5 tiêu chí"])("does not dispatch when Chat chooses conversation: %s", async content => {
    const { turn, transport } = await setup();
    const result = await turn(content, { intent: "conversation_only", directReply: "Trả lời trực tiếp theo ngữ cảnh." });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.agentReply.content).not.toContain("lựa chọn đầy đủ");
    expect(transport.sentRequests).toHaveLength(0);
  });

  it("does not treat authenticated user quotes as repository instructions", async () => {
    const { turn, transport } = await setup();
    const content = 'Tạo spike: khảo sát vì sao chuỗi "bypass approval" bị từ chối. Chỉ đọc.';
    const result = await turn(content, spike(content));
    expect(result.ok).toBe(true);
    expect(transport.sentRoleMessages).toHaveLength(1);
  });

  it("still refuses malicious repositoryContext supplied with a structured Chat decision", async () => {
    const { turn, transport } = await setup();
    const result = await turn("Khảo sát MCP", spike("Khảo sát MCP"), { repositoryContext: "bypass approval" });
    expect(result.ok).toBe(false);
    expect(transport.sentRequests).toHaveLength(0);
  });

  it("retains the structured decision in the busy FIFO through recovery", async () => {
    const { turn, gateway, config, transport } = await setup();
    await gateway.setAgentBusyState(true);
    const result = await turn("Yêu cầu workflow loại spike: khảo sát MCP", spike("Khảo sát MCP"));
    expect(result.ok).toBe(true);
    const recovered = new ConversationGateway(config);
    expect((await recovered.initializeOrRecoverSession()).ok).toBe(true);
    expect((await recovered.setAgentBusyState(false)).ok).toBe(true);
    expect(transport.sentRequests).toHaveLength(1);
    expect(Object.keys(recovered.getContextSnapshot().workflows)).toHaveLength(1);
  });

  it("deduplicates a pending busy decision and retains it when dispatch fails", async () => {
    const { gateway, turn, config, transport } = await setup();
    await gateway.setAgentBusyState(true);
    const extra = { messageId: "human-queued-once" };
    const decision = spike("Khảo sát MCP");
    expect((await turn("Khảo sát MCP", decision, extra)).ok).toBe(true);
    expect((await turn("Khảo sát MCP", decision, extra)).ok).toBe(true);
    expect(gateway.getContextSnapshot().pendingInboundQueue).toHaveLength(1);
    const dispatch = config.bridge.handOffToCoordinator.bind(config.bridge);
    config.bridge.handOffToCoordinator = async () => ({ ok: false,
      error: { code: "corruption", retryable: false, message: "Interrupted before dispatch completed" } });
    // The failed item is reported with its attempt count and stays queued for a later drain.
    const failed = await gateway.setAgentBusyState(false);
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.queueFailures).toEqual([expect.objectContaining({ attempts: 1, deadLettered: false })]);
    const recovered = new ConversationGateway(config);
    await recovered.initializeOrRecoverSession();
    expect(recovered.getContextSnapshot().pendingInboundQueue).toHaveLength(1);
    expect(recovered.getContextSnapshot().pendingInboundQueue[0]?.attempts).toBe(1);
    config.bridge.handOffToCoordinator = dispatch;
    expect((await recovered.flushPendingInboundQueue()).ok).toBe(true);
    expect(recovered.getContextSnapshot().pendingInboundQueue).toHaveLength(0);
    expect(transport.sentRoleMessages).toHaveLength(1);
  });

  it("accepts cancellation while the role is busy and continues processing the FIFO", async () => {
    const { gateway, turn, config, transport } = await setup();
    const first = await turn("Khảo sát MCP", spike("Khảo sát MCP"));
    if (!first.ok || !first.value.runId) throw new Error("setup failed");
    await gateway.setAgentBusyState(true);
    const progress = { schema_version: 2, message_id: "progress-ended", correlation_id: first.value.correlationId,
      run_id: first.value.runId, sender: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" },
      recipient: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" }, type: "conversation.progress",
      payload: { sdlcStatus: "failed", failureSummary: "Workflow failed", headline: "Workflow failed" },
      artifact_references: [], occurred_at: new Date().toISOString() };
    expect((await gateway.handleCoordinatorRoleMessage(progress)).ok).toBe(true);
    const cancellation = { intent: "cancellation_request", cancellationInput: { runId: first.value.runId } };
    expect((await turn("Hủy workflow", cancellation, { messageId: "queued-cancel" })).ok).toBe(true);
    expect((await turn("Khảo sát kỹ năng", spike("Khảo sát kỹ năng"))).ok).toBe(true);
    const drained = await gateway.setAgentBusyState(false);
    expect(drained.ok).toBe(true);
    expect(gateway.getContextSnapshot().pendingInboundQueue).toHaveLength(0);
    expect(transport.sentRoleMessages).toHaveLength(3);
    const replay = async (instance: ConversationGateway) => instance.handleUserTurn({ sessionId: "session-chat",
      messageId: "queued-cancel", content: "Hủy workflow", conversationDecision: cancellation } as never);
    const rejected = await replay(gateway);
    expect(rejected).toMatchObject({ ok: true, value: { recognizedIntent: "cancellation_request" } });
    const recovered = new ConversationGateway(config);
    expect(await replay(recovered)).toMatchObject({ ok: true, value: { recognizedIntent: "cancellation_request" } });
    expect(transport.sentRoleMessages).toHaveLength(3);
  });

  it("replays a committed decision after recovery without a second handoff", async () => {
    const { turn, config, transport } = await setup();
    const decision = spike("Khảo sát MCP");
    const first = await turn("Khảo sát MCP", decision, { messageId: "human-once" });
    if (!first.ok) throw new Error(first.error.message);
    const recovered = new ConversationGateway(config);
    const second = await recovered.handleUserTurn({ sessionId: "session-chat", messageId: "human-once", content: "Khảo sát MCP", conversationDecision: decision } as never);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.runId).toBe(first.value.runId);
    expect(transport.sentRequests).toHaveLength(1);
    const conflict = await recovered.handleUserTurn({ sessionId: "session-chat", messageId: "human-once", content: "Khảo sát MCP",
      conversationDecision: { intent: "conversation_only", directReply: "khác" } } as never);
    expect(conflict.ok).toBe(false);
    expect(transport.sentRequests).toHaveLength(1);
  });

  it("retains an identical delegation envelope if persistence fails after handoff", async () => {
    const { gateway, store, config, transport } = await setup();
    const save = store.save.bind(store);
    let interrupt = true;
    store.save = async snapshot => {
      if (interrupt && Object.keys(snapshot.workflows).length) {
        interrupt = false;
        return { ok: false, error: { code: "corruption", retryable: false, message: "Interrupted after handoff" } };
      }
      return save(snapshot);
    };
    const input = { sessionId: "session-chat", messageId: "human-interrupted", occurredAt: "2026-10-19T00:00:00.000Z",
      content: "Khảo sát MCP", conversationDecision: spike("Khảo sát MCP") };
    expect((await gateway.handleUserTurn(input as never)).ok).toBe(false);
    const recovered = new ConversationGateway(config);
    expect((await recovered.handleUserTurn(input as never)).ok).toBe(true);
    expect(transport.sentRoleMessages).toHaveLength(2);
    expect(transport.sentRoleMessages[1]).toEqual(transport.sentRoleMessages[0]);
  });

  it("durably repairs a failed snapshot before acknowledging a same-instance retry", async () => {
    const { gateway, store, config, transport } = await setup();
    const save = store.save.bind(store);
    let interrupt = true;
    store.save = async snapshot => {
      if (interrupt && Object.keys(snapshot.workflows).length) {
        interrupt = false;
        return { ok: false, error: { code: "corruption", retryable: false, message: "Save failed once" } };
      }
      return save(snapshot);
    };
    const input = { sessionId: "session-chat", messageId: "human-retry", content: "Khảo sát MCP", conversationDecision: spike("Khảo sát MCP") };
    expect((await gateway.handleUserTurn(input as never)).ok).toBe(false);
    const retry = await gateway.handleUserTurn(input as never);
    expect(retry.ok).toBe(true);
    const recovered = new ConversationGateway(config);
    await recovered.initializeOrRecoverSession();
    expect(Object.keys(recovered.getContextSnapshot().workflows)).toHaveLength(1);
    expect(transport.sentRoleMessages).toHaveLength(1);
  });

  it("targets cancellation and replays the saved cancellation response", async () => {
    const { turn, config, transport } = await setup();
    const first = await turn("Khảo sát MCP", spike("Khảo sát MCP"));
    if (!first.ok || !first.value.runId) throw new Error("setup failed");
    const decision = { intent: "cancellation_request", cancellationInput: { runId: first.value.runId } };
    const cancelled = await turn("Hủy khảo sát", decision, { messageId: "human-cancel" });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    const recovered = new ConversationGateway(config);
    const repeated = await recovered.handleUserTurn({ sessionId: "session-chat", messageId: "human-cancel", content: "Hủy khảo sát", conversationDecision: decision } as never);
    expect(repeated.ok).toBe(true);
    if (repeated.ok) expect(repeated.value.cancellationRequest).toEqual(cancelled.value.cancellationRequest);
    expect(transport.sentRoleMessages).toHaveLength(2);
  });

  it("freezes one session cancellation batch, keeps enqueue distinct from cancellation, and replays it", async () => {
    const { turn, gateway, config, transport } = await setup();
    const first = await turn("Khảo sát MCP", spike("Khảo sát MCP"));
    const second = await turn("Khảo sát khác", spike("Khảo sát khác"));
    if (!first.ok || !second.ok) throw new Error("setup failed");
    const decision = { intent: "cancellation_request", cancellationInput: { runIds: [first.value.runId, second.value.runId] } };
    const result = await turn("Hủy hết các run cũ", decision, { messageId: "batch-cancel" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agentReply.metadata?.cancellationBatch).toMatchObject({ items: [
      { runId: first.value.runId, status: "queued" }, { runId: second.value.runId, status: "queued" }
    ] });
    expect(gateway.getContextSnapshot().workflows[first.value.correlationId]?.sdlcStatus).toBe("intake");
    const cancellations = transport.sentRoleMessages.filter(message => message.type === "delegation.request" &&
      (message.payload as Record<string, unknown>).metadata &&
      ((message.payload as Record<string, unknown>).metadata as Record<string, unknown>).action === "cancel");
    expect(cancellations).toHaveLength(2);
    expect(new Set(cancellations.map(message => message.message_id)).size).toBe(2);
    const recovered = new ConversationGateway(config);
    const replay = await recovered.handleUserTurn({ sessionId: "session-chat", messageId: "batch-cancel", content: "Hủy hết các run cũ", conversationDecision: decision } as never);
    expect(replay.ok && replay.value.agentReply).toEqual(result.value.agentReply);
    expect(transport.sentRoleMessages).toHaveLength(4);
    expect((await recovered.handleUserTurn({ sessionId: "session-chat", messageId: "batch-cancel", content: "Hủy hết các run cũ",
      conversationDecision: { intent: "cancellation_request", cancellationInput: { runId: first.value.runId } } } as never)).ok).toBe(false);
  });

  it("continues a cancellation batch after a failed item and reconciles cancelled runs instead of claiming they stopped", async () => {
    const { turn, gateway, config, transport } = await setup();
    const runs = ["A", "B", "C"];
    const created = [];
    for (const title of runs) {
      const item = await turn(title, spike(title));
      if (!item.ok) throw new Error("setup failed");
      created.push(item.value);
    }
    await gateway.handleCoordinatorRoleMessage({ schema_version: 2, message_id: "terminal-cancel", correlation_id: created[0]!.correlationId,
      run_id: created[0]!.runId, sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "conversation.progress",
      payload: { sdlcStatus: "cancelled", summary: "Cancelled by Runtime" }, artifact_references: [] });
    const send = config.bridge.handOffToCoordinator.bind(config.bridge);
    vi.spyOn(config.bridge, "handOffToCoordinator").mockImplementationOnce(async () => ({ ok: false,
      error: { code: "transport_unavailable", retryable: true, message: "Queue unavailable" } })).mockImplementation(send);
    const result = await turn("Hủy các run", { intent: "cancellation_request", cancellationInput: { runIds: created.map(item => item.runId) } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agentReply.metadata?.cancellationBatch).toMatchObject({ items: [
      { status: "blocked" }, { status: "queued" }, { status: "queued" }
    ] });
    expect(transport.sentRoleMessages).toHaveLength(5);
  });

  it("recovers an interrupted enqueue without resend and keeps the original session target set", async () => {
    const { turn, gateway, config, transport, store } = await setup();
    const first = await turn("A", spike("A"));
    const second = await turn("B", spike("B"));
    if (!first.ok || !second.ok) throw new Error("setup failed");
    const save = store.save.bind(store);
    let fail = true;
    vi.spyOn(store, "save").mockImplementation(async snapshot => {
      if (fail && snapshot.cancellationBatches?.["interrupted-cancel"]?.items[0]?.status === "queued") {
        fail = false;
        return { ok: false, error: { code: "corruption", retryable: false, message: "Interrupted before receipt persistence" } };
      }
      return save(snapshot);
    });
    const decision = { intent: "cancellation_request", cancellationInput: { scope: "session_existing" } };
    expect((await turn("Hủy hết các run cũ", decision, { messageId: "interrupted-cancel" })).ok).toBe(false);
    expect(transport.sentRoleMessages).toHaveLength(3);
    const recovered = new ConversationGateway(config);
    await recovered.initializeOrRecoverSession();
    const newer = await recovered.handleUserTurn({ sessionId: "session-chat", messageId: "newer", content: "C", conversationDecision: spike("C") } as never);
    expect(newer.ok).toBe(true);
    const replay = await recovered.handleUserTurn({ sessionId: "session-chat", messageId: "interrupted-cancel", content: "Hủy hết các run cũ", conversationDecision: decision } as never);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.agentReply.metadata?.cancellationBatch).toMatchObject({ items: [
      { runId: first.value.runId, status: "blocked", error: { code: "unknown_delivery" } }, { runId: second.value.runId, status: "queued" }
    ] });
    expect(transport.sentRoleMessages).toHaveLength(5);
    expect(gateway.getContextSnapshot().workflows[first.value.correlationId]?.sdlcStatus).toBe("intake");
  });

  it("reconciles Runtime-only runs and closes stale approval projections without fabricating success", async () => {
    const { turn, gateway, config } = await setup();
    const first = await turn("A", spike("A"));
    const second = await turn("B", spike("B"));
    if (!first.ok || !second.ok || !first.value.delegationRequest || !second.value.delegationRequest) throw new Error("setup failed");
    const request = { schemaVersion: 2, approvalId: "apr-stale", runId: first.value.runId, sessionId: "session-chat", status: "pending",
      target: { type: "run" }, revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: new Date().toISOString(),
      reason: "Continue?", evidence: [], idempotencyKey: "stale-decision", metadata: { kind: "user_decision", question: "Continue?", options: ["Yes", "No"] } };
    expect((await gateway.reconcilePendingApprovals([{ request, correlationId: first.value.correlationId }])).ok).toBe(true);
    expect((await turn("apr-stale", { intent: "clarify", clarifyingQuestions: ["apr-stale: Yes or No?"] })).ok).toBe(true);
    expect(Object.keys(gateway.getContextSnapshot().pendingClarifications)).toHaveLength(1);
    const missing = { ...second.value.delegationRequest, runId: "run-runtime-only", correlationId: "corr-runtime-only" };
    const foreign = { ...missing, runId: "run-foreign", correlationId: "corr-foreign", sessionId: "session-foreign" };
    const result = await gateway.reconcileRuntimeRuns([
      { runId: first.value.runId, delegation: first.value.delegationRequest, status: "cancelled", cancelled: true },
      { runId: second.value.runId, delegation: second.value.delegationRequest, status: "completed", cancelled: false },
      { runId: missing.runId, delegation: missing, status: "specifying", cancelled: false },
      { runId: foreign.runId, delegation: foreign, status: "intake", cancelled: false }
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rejected).toHaveLength(1);
    const snapshot = gateway.getContextSnapshot();
    expect(snapshot.pendingApprovals).toEqual({});
    expect(snapshot.pendingClarifications).toEqual({});
    expect(snapshot.session.unresolvedQuestions).toEqual([]);
    expect(snapshot.session.activeApprovalIds).toEqual([]);
    expect(snapshot.closedApprovals?.["apr-stale"]).toMatchObject({ status: "expired" });
    expect(snapshot.workflows[second.value.correlationId]?.completedVerified).toBe(false);
    expect(snapshot.workflows["corr-runtime-only"]?.runId).toBe("run-runtime-only");
    expect(snapshot.workflows["corr-foreign"]).toBeUndefined();
    for (const [type, payload] of [["delegation.accepted", {}], ["conversation.progress", { sdlcStatus: "completed", verified: true, headline: "Late completion" }],
      ["verification.escalation", { escalated: true }]] as const) {
      await gateway.handleCoordinatorRoleMessage({ schema_version: 2, message_id: `late-${type}`, correlation_id: first.value.correlationId,
        run_id: first.value.runId, sender: { role: "runtime" }, recipient: { role: "conversation" }, type, payload, artifact_references: [] });
      expect(gateway.getContextSnapshot().workflows[first.value.correlationId]).toMatchObject({ sdlcStatus: "cancelled", completedVerified: false });
    }
    const restored = new ConversationGateway(config);
    await restored.initializeOrRecoverSession();
    const late = await restored.handleUserTurn({ sessionId: "session-chat", content: "apr-stale: Yes", provenance: { origin: "user", authenticatedUser: true } });
    expect(late.ok && late.value.approvalDecision).toBeUndefined();
    expect((await restored.reconcilePendingApprovals([{ request, correlationId: first.value.correlationId }])).ok).toBe(true);
    expect(restored.getContextSnapshot().pendingApprovals).toEqual({});
    const batch = await restored.handleUserTurn({ sessionId: "session-chat", messageId: "cancel-runtime-only", content: "Hủy hết",
      conversationDecision: { intent: "cancellation_request", cancellationInput: { scope: "session_existing" } } } as never);
    expect(batch.ok && batch.value.agentReply.metadata?.cancellationBatch).toMatchObject({ items: [
      { runId: first.value.runId }, { runId: second.value.runId }, { runId: "run-runtime-only" }
    ] });
  });

  it("includes every Runtime follow-up run sharing one correlation in session cancellation", async () => {
    const { turn, gateway, transport } = await setup();
    const first = await turn("A", spike("A"));
    if (!first.ok || !first.value.delegationRequest) throw new Error("setup failed");
    const parent = first.value.delegationRequest;
    const child = { ...parent, runId: `${parent.runId}-r2`, delegationId: "del-follow-up", messageId: "msg-follow-up" };
    const reconciled = await gateway.reconcileRuntimeRuns([
      { runId: parent.runId, delegation: parent, status: "escalated", cancelled: false, tasks: [] },
      { runId: child.runId, delegation: child, status: "planning", cancelled: false, tasks: [] }
    ]);
    expect(reconciled.ok && reconciled.value.rejected).toEqual([]);
    expect(gateway.getContextSnapshot().workflows[first.value.correlationId]?.runId).toBe(child.runId);
    const result = await turn("Hủy hết các run cũ", { intent: "cancellation_request", cancellationInput: { scope: "session_existing" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value.agentReply.metadata?.cancellationBatch as { items: { runId: string }[] };
    expect(new Set(summary.items.map(item => item.runId))).toEqual(new Set([parent.runId, child.runId]));
    expect(transport.sentRoleMessages).toHaveLength(3);
  });

  it("renders Runtime cancellation and snapshot-only history without claiming either is running or fully stopped", async () => {
    const { turn, gateway } = await setup();
    const first = await turn("A", spike("A"));
    const historical = await turn("B", spike("B"));
    if (!first.ok || !historical.ok) throw new Error("setup failed");
    await gateway.reconcileRuntimeRuns([{ runId: first.value.runId, delegation: first.value.delegationRequest,
      status: "cancelled", cancelled: true }]);
    const status = await turn("Trạng thái", { intent: "status_query" });
    if (!status.ok) throw new Error("status failed");
    const content = status.value.agentReply.content;
    const cancelledLine = content.split("\n").find(line => line.includes(`Run: \`${first.value.runId}\``));
    const historicalLine = content.split("\n").find(line => line.includes(`Run: \`${historical.value.runId}\``));
    expect(cancelledLine).toContain("[Đã hủy]");
    expect(cancelledLine).not.toContain("[Đang chạy]");
    expect(historicalLine).toContain("[Chỉ có trong Conversation]");
    expect(historicalLine).not.toContain("[Đang chạy]");
    expect(content).toContain("reconciliation");
    expect(content).not.toContain("fully stopped");
  });

  it("refuses an unknown or foreign run before any batch item is sent", async () => {
    const { turn, transport } = await setup();
    const first = await turn("Khảo sát MCP", spike("Khảo sát MCP"));
    if (!first.ok) throw new Error("setup failed");
    const result = await turn("Hủy các run", { intent: "cancellation_request", cancellationInput: { runIds: [first.value.runId, "run-other-session"] } });
    expect(result.ok).toBe(false);
    expect(transport.sentRoleMessages).toHaveLength(1);
  });

  it.each([
    { intent: "approval_response", approvalInput: { decision: "approved" } },
    { intent: "workflow_request" },
    { ...spike("Khảo sát MCP"), targetCorrelationId: "corr-unknown" },
    { intent: "cancellation_request", cancellationInput: { runId: "run-missing" } },
    { intent: "cancellation_request", cancellationInput: { runIds: [] } },
    { intent: "cancellation_request", cancellationInput: { runIds: ["run-a", "run-a"] } },
    { intent: "cancellation_request", cancellationInput: { runId: "run-a", scope: "session_existing" } },
    { intent: "clarify", clarifyingQuestions: [] }
  ])("rejects malformed or invalid-target decisions without dispatch: %j", async decision => {
    const { turn, transport } = await setup();
    expect((await turn("Yêu cầu rõ", decision)).ok).toBe(false);
    expect(transport.sentRequests).toHaveLength(0);
  });
});
