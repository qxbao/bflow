import { describe, expect, it } from "vitest";
import { ConversationGateway, HerdrConversationBridge, InMemoryConversationContextStore, MockHerdrAgentTransport, classifyUserIntent } from "../src/index.js";

async function setup() {
  const transport = new MockHerdrAgentTransport();
  const gateway = new ConversationGateway({ sessionId: "session-routing", herdrSessionId: "herdr-routing", conversationAgentId: "chat", paneId: "pane-chat",
    contextStore: new InMemoryConversationContextStore(), bridge: new HerdrConversationBridge({ transport, sessionId: "session-routing", conversationAgentId: "chat", conversationPaneId: "pane-chat", coordinatorTarget: { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator" } }) });
  await gateway.initializeOrRecoverSession();
  const turn = (content: string, extra = {}) => gateway.handleUserTurn({ sessionId: "session-routing", content, provenance: { origin: "user", authenticatedUser: true }, ...extra });
  return { gateway, transport, turn };
}

describe("Conversation authority and intent regressions", () => {
  it("keeps a positive change request while excluding a protected package", async () => {
    const { turn } = await setup();
    const result = await turn("Sửa packages/parser, không thay đổi packages/core");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recognizedIntent).toBe("workflow_request");
    expect(result.value.delegationRequest?.metadata?.affectedPaths).toEqual(["packages/parser"]);
  });

  it.each(["Bạn có những MCP nào", "Soạn sẵn prompt để tôi gửi cho session mới", "Draft a prompt to fix packages/conversation in another session", "Giải thích ví dụ: cancel workflow", "Explain `stop run run-old`", "Khảo sát packages/core và báo cáo nguyên nhân, chưa sửa code"])("keeps conversational intent without run: %s", async content => {
    const { turn, transport, gateway } = await setup();
    const response = await turn(content);
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.value.recognizedIntent).toBe("conversation_only");
    expect(transport.sentRequests).toHaveLength(0);
    expect(Object.keys(gateway.getContextSnapshot().workflows)).toHaveLength(0);
  });

  it.each(["A", "1", "Chọn B"])("never promotes a short choice into implementation: %s", async choice => {
    const { turn, transport } = await setup();
    await turn("Thêm tính năng mới");
    const result = await turn(choice);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.delegationRequest).toBeUndefined();
    expect(transport.sentRequests).toHaveLength(0);
  });

  it.each([false, true])("starts an independent request instead of merging pending clarification (correlated=%s)", async correlated => {
    const { turn } = await setup();
    const old = await turn("Thêm tính năng mới");
    const next = await turn("Sửa lỗi parser trong packages/parser khi chuỗi rỗng phải trả lỗi", correlated && old.ok ? { correlationId: old.value.correlationId } : {});
    expect(old.ok && next.ok).toBe(true);
    if (old.ok && next.ok) {
      expect(next.value.correlationId).not.toBe(old.value.correlationId);
      expect(next.value.delegationRequest?.objective).not.toContain("Bổ sung");
      expect(next.value.delegationRequest?.title).toContain("parser");
    }
  });

  it("asks for actual scope instead of inventing packages/app", async () => {
    const { turn, transport } = await setup();
    const result = await turn("Triển khai tính năng xác thực JWT với thời hạn token 15 phút và test đầy đủ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recognizedIntent).toBe("clarify");
    expect(transport.sentRequests).toHaveLength(0);
  });

  it("strips paste wrappers, retains full SDD and splits requested acceptance cases", async () => {
    const { turn } = await setup();
    const result = await turn("Sửa lỗi packages/parser theo full SDD\n<pasted_content>\n- Chuỗi rỗng trả lỗi EMPTY\n- Unicode được giữ nguyên\n- Token hết hạn trả lỗi EXPIRED\n</pasted_content>");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const request = result.value.delegationRequest!;
    expect(request).toBeDefined();
    expect(request.objective).not.toContain("pasted_content");
    expect(request.sddLevel).toBe("full");
    expect(request.metadata?.affectedPaths).toEqual(["packages/parser"]);
    expect(request.acceptanceCriteria.map(ac => ac.description)).toEqual(["Chuỗi rỗng trả lỗi EMPTY", "Unicode được giữ nguyên", "Token hết hạn trả lỗi EXPIRED"]);
  });

  it("does not cancel for quoted commands in a code-change request", async () => {
    const { turn, transport } = await setup();
    await turn("Triển khai parser trong packages/parser");
    const result = await turn('Sửa lỗi packages/parser để chuỗi "cancel workflow" được coi là dữ liệu');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recognizedIntent).toBe("workflow_request");
    expect(transport.sentRoleMessages.some(msg => msg.payload.metadata?.action === "cancel")).toBe(false);
  });

  it("cancels the named run and also delegates the new request", async () => {
    const { turn, gateway, transport } = await setup();
    const old = await turn("Triển khai auth trong packages/auth");
    const active = await turn("Triển khai parser trong packages/parser");
    if (!old.ok || !active.ok) throw new Error("setup failed");
    const result = await turn(`Hủy run ${old.value.runId}; sửa lỗi packages/parser khi chuỗi rỗng trả lỗi EMPTY`, { runId: active.value.runId, correlationId: active.value.correlationId });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.cancellationRequest?.runId).toBe(old.value.runId);
    const snapshot = gateway.getContextSnapshot();
    expect(snapshot.workflows[old.value.correlationId]?.sdlcStatus).toBe("intake");
    expect(snapshot.workflows[active.value.correlationId]?.sdlcStatus).not.toBe("cancelled");
    expect(transport.sentRoleMessages).toHaveLength(4);
    expect(transport.sentRoleMessages[2]?.correlation_id).toBe(old.value.correlationId);
    expect(transport.sentRoleMessages[3]?.payload.objective).toContain("EMPTY");
    expect(transport.sentRoleMessages[3]?.run_id).not.toBe(active.value.runId);
  });

  it("resolves descriptive old run without silently cancelling the active run", async () => {
    const { turn, gateway } = await setup();
    const old = await turn("Triển khai auth trong packages/auth");
    await turn("Triển khai parser trong packages/parser");
    const result = await turn("Hủy workflow cũ");
    expect(result.ok).toBe(true);
    if (old.ok && result.ok) {
      expect(result.value.cancellationRequest?.runId).toBe(old.value.runId);
      expect(gateway.getContextSnapshot().workflows[old.value.correlationId]?.sdlcStatus).toBe("intake");
    }
  });

  it("clarifies unknown or ambiguous cancellation targets without side effects", async () => {
    const { turn, transport } = await setup();
    await turn("Triển khai parser trong packages/parser");
    for (const content of ["Hủy workflow thanh toán", "Cancel the old authentication run", "Hủy run-missing", "Hủy run-one và run-two"]) {
      const result = await turn(content);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.recognizedIntent).toBe("clarify");
    }
    expect(transport.sentRequests).toHaveLength(1);
  });

  it("does not let a status keyword suppress a code-change request", async () => {
    const { turn } = await setup();
    const result = await turn("Sửa status parser trong packages/parser khi chuỗi rỗng trả lỗi");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recognizedIntent).toBe("workflow_request");
  });

  it("preserves original pending clarification through a choice and scope answer", async () => {
    const { turn, gateway } = await setup();
    const initial = await turn("Thêm tính năng mới");
    if (!initial.ok) throw new Error("setup failed");
    await turn("A");
    const pending = gateway.getContextSnapshot().pendingClarifications[initial.value.correlationId];
    expect(pending?.originalRequestText).toBe("Thêm tính năng mới");
    const result = await turn("Phạm vi packages/billing, hóa đơn phải giữ nguyên đơn vị tiền tệ", { correlationId: initial.value.correlationId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.delegationRequest?.objective).toContain("Thêm tính năng mới");
      expect(result.value.delegationRequest?.objective).not.toContain("Bổ sung: A");
    }
  });

  it.each(["Có nên đổi sang OAuth2 trong packages/auth không?", "Tôi thấy ví dụ như sau:\ncancel run-old", "Không sửa packages/auth; chỉ giải thích lỗi"])("does not infer authority from an incidental keyword: %s", async content => {
    const { turn, transport } = await setup();
    await turn("Triển khai auth trong packages/auth");
    const result = await turn(content);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recognizedIntent).toBe("conversation_only");
    expect(transport.sentRequests).toHaveLength(1);
  });

  it("keeps a code request containing approval wording as implementation", async () => {
    const { turn } = await setup();
    const result = await turn("Sửa packages/parser để approve và reject được parse như token");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recognizedIntent).toBe("workflow_request");
  });

  it("recognizes actual tests paths without dropping the root", async () => {
    const { turn } = await setup();
    const result = await turn("Sửa tests/platform/parser.test.ts để Unicode giữ nguyên");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.delegationRequest?.metadata?.affectedPaths).toEqual(["tests/platform/parser.test.ts"]);
  });

  it("describes transport handoff as awaiting Runtime acceptance", async () => {
    const { turn } = await setup();
    const result = await turn("Sửa lỗi packages/parser khi chuỗi rỗng trả EMPTY");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agentReply.content).toContain("chờ Runtime/Coordinator xác nhận");
      expect(result.value.agentReply.content).not.toContain("bàn giao thành công");
    }
  });

  it("never retargets an unknown named requirement change to the input active correlation", async () => {
    const { turn, transport } = await setup();
    const active = await turn("Triển khai auth trong packages/auth");
    if (!active.ok) throw new Error("setup failed");
    const result = await turn("Thay đổi yêu cầu cho run-missing: sửa packages/auth để token hết hạn trả lỗi", { runId: active.value.runId, correlationId: active.value.correlationId });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recognizedIntent).toBe("clarify");
    expect(transport.sentRequests).toHaveLength(1);
  });

  it.each(["Sửa lỗi packages/conversation", "Bugfix Conversation Gateway intent classifier và spike điều tra McpGateway\nScope: packages/conversation"])("keeps bugfix authority separate from investigation: %s", async title => {
    const { turn } = await setup();
    const result = await turn(`${title}\n2. Spike packages/mcp-gateway: chỉ điều tra, chưa sửa code\n- Báo cáo nguyên nhân\n- Không thay đổi production`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recognizedIntent).toBe("workflow_request");
    expect(result.value.delegationRequest?.metadata?.affectedPaths).toEqual(["packages/conversation"]);
    expect(result.value.delegationRequest?.metadata?.investigationTasks).toEqual([expect.objectContaining({ affectedPaths: ["packages/mcp-gateway"], codeChangesAuthorized: false })]);
  });

  it("does not infer scope from a forbidden fabricated default", async () => {
    const { turn, transport } = await setup();
    const result = await turn("Sửa lỗi Conversation Gateway. affectedPaths phải phản ánh phạm vi thật, không mặc định là packages/app.");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recognizedIntent).toBe("clarify");
    expect(transport.sentRequests).toHaveLength(0);
  });

  it("processes a new code request followed by a known explicit cancellation", async () => {
    const { turn, transport } = await setup();
    const old = await turn("Triển khai auth trong packages/auth");
    if (!old.ok) throw new Error("setup failed");
    const result = await turn(`Sửa lỗi packages/parser khi chuỗi rỗng trả EMPTY; hủy ${old.value.runId}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recognizedIntent).toBe("workflow_request");
    expect(transport.sentRoleMessages).toHaveLength(3);
    expect(transport.sentRoleMessages[1]?.payload.objective).toContain("EMPTY");
    expect(transport.sentRoleMessages[2]?.payload.metadata?.targetRunId).toBe(old.value.runId);
  });

  it("asks for target selection for plural old runs without touching the active run", async () => {
    const { turn, transport } = await setup();
    await turn("Triển khai auth trong packages/auth");
    await turn("Triển khai parser trong packages/parser");
    await turn("Triển khai cache trong packages/cache");
    const result = await turn("Hủy các run cũ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.recognizedIntent).toBe("clarify");
    expect(transport.sentRequests).toHaveLength(3);
  });

  it("treats a negative acceptance case as behavior, not a global editing veto", async () => {
    const { turn } = await setup();
    const result = await turn("Bugfix packages/conversation\n- Không sửa code khi người dùng chỉ hỏi thông tin\n- Chỉ tạo workflow khi được yêu cầu rõ ràng");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recognizedIntent).toBe("workflow_request");
      expect(result.value.delegationRequest?.acceptanceCriteria).toHaveLength(2);
    }
  });

  it("keeps a new ambiguous imperative separate from the old clarification", async () => {
    const { turn, gateway } = await setup();
    const old = await turn("Thêm tính năng mới");
    const next = await turn("Sửa lỗi parser");
    expect(old.ok && next.ok).toBe(true);
    if (old.ok && next.ok) {
      expect(next.value.recognizedIntent).toBe("clarify");
      expect(next.value.correlationId).not.toBe(old.value.correlationId);
      expect(gateway.getContextSnapshot().pendingClarifications[next.value.correlationId]?.originalRequestText).toBe("Sửa lỗi parser");
    }
  });

  it("records investigation as spike detail without code authority", async () => {
    const { gateway } = await setup();
    const result = classifyUserIntent({ sessionId: "session-routing", content: "Spike khảo sát packages/core và báo cáo nguyên nhân, chưa sửa code" }, gateway.getContextSnapshot());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.intent).toBe("conversation_only");
      expect(result.value.requirementDraft?.kind).toBe("spike");
      expect(result.value.requirementDraft?.affectedPaths).toEqual(["packages/core"]);
    }
  });
});

describe("Turn correlation with pending clarifications", () => {
  const STALE_REQUEST = "Thêm tính năng mới";
  const INDEPENDENT_REQUEST = "Sửa lỗi parser trong packages/parser khi chuỗi rỗng phải trả lỗi";
  const CONVERSATION_REQUEST = "Soạn sẵn prompt để tôi gửi cho session mới";

  it.each([false, true])("keeps a conversation-only turn off a stale pending clarification while a run is active (explicit correlation=%s)", async explicit => {
    const { turn, gateway, transport } = await setup();
    const stale = await turn(STALE_REQUEST);
    const run = await turn(INDEPENDENT_REQUEST);
    if (!stale.ok || !run.ok) throw new Error("setup failed");
    expect(run.value.recognizedIntent).toBe("workflow_request");
    expect(transport.sentRequests).toHaveLength(1);
    // The independent request closed the abandoned clarification and its questions.
    expect(gateway.getContextSnapshot().pendingClarifications[stale.value.correlationId]).toBeUndefined();
    expect(gateway.getContextSnapshot().session.unresolvedQuestions).toEqual([]);

    const result = await turn(CONVERSATION_REQUEST, explicit ? { correlationId: stale.value.correlationId } : {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recognizedIntent).toBe("conversation_only");
    // Without an explicit id the turn gets a fresh one; an explicit id of the closed clarification no longer refers to anything.
    if (!explicit) expect(result.value.correlationId).not.toBe(stale.value.correlationId);
    expect(result.value.correlationId).not.toBe(run.value.correlationId);
    expect(gateway.getContextSnapshot().pendingClarifications).toEqual({});
    expect(gateway.getContextSnapshot().workflows[stale.value.correlationId]).toBeUndefined();
  });

  it("gives an independent new request its own correlation despite a stale pending clarification", async () => {
    const { turn } = await setup();
    const stale = await turn(STALE_REQUEST);
    const next = await turn(INDEPENDENT_REQUEST);
    if (!stale.ok || !next.ok) throw new Error("setup failed");
    expect(next.value.recognizedIntent).toBe("workflow_request");
    expect(next.value.correlationId).not.toBe(stale.value.correlationId);
  });

  it.each([false, true])("still reuses the clarification correlation for a scope answer (correlated=%s)", async correlated => {
    const { turn } = await setup();
    const stale = await turn(STALE_REQUEST);
    if (!stale.ok) throw new Error("setup failed");
    const answer = await turn("Phạm vi packages/billing, hóa đơn phải giữ nguyên đơn vị tiền tệ",
      correlated ? { correlationId: stale.value.correlationId } : {});
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(answer.value.correlationId).toBe(stale.value.correlationId);
  });
});
