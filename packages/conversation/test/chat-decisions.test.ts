import { describe, expect, it } from "vitest";
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

  it("rejects a queued action whose target has ended and continues processing the FIFO", async () => {
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
    expect(transport.sentRoleMessages).toHaveLength(2);
    const replay = async (instance: ConversationGateway) => instance.handleUserTurn({ sessionId: "session-chat",
      messageId: "queued-cancel", content: "Hủy workflow", conversationDecision: cancellation } as never);
    const rejected = await replay(gateway);
    expect(rejected).toMatchObject({ ok: true, value: { recognizedIntent: "conversation_only",
      rejectedDecision: { code: "validation" }, agentReply: { intent: "error_report" } } });
    const recovered = new ConversationGateway(config);
    expect(await replay(recovered)).toMatchObject({ ok: true, value: { rejectedDecision: { code: "validation" } } });
    expect(transport.sentRoleMessages).toHaveLength(2);
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

  it.each([
    { intent: "approval_response", approvalInput: { decision: "approved" } },
    { intent: "workflow_request" },
    { ...spike("Khảo sát MCP"), targetCorrelationId: "corr-unknown" },
    { intent: "cancellation_request", cancellationInput: { runId: "run-missing" } },
    { intent: "clarify", clarifyingQuestions: [] }
  ])("rejects malformed or invalid-target decisions without dispatch: %j", async decision => {
    const { turn, transport } = await setup();
    expect((await turn("Yêu cầu rõ", decision)).ok).toBe(false);
    expect(transport.sentRequests).toHaveLength(0);
  });
});
