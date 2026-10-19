import { describe, expect, it } from "vitest";
import type { ApprovalRequest, RoleMessage } from "@bflow/contracts";
import {
  ConversationGateway,
  HerdrConversationBridge,
  InMemoryConversationContextStore,
  MockHerdrAgentTransport,
  classifyUserIntent,
  classifyTrustedApprovalReply,
  formatCoordinatorMessageForUser,
  isUserDecisionRequest,
  renderUserDecisionPrompt,
  resolveUserDecisionReply,
  type ConversationContextSnapshot,
  type UserTurnInput
} from "../src/index.js";

const SESSION_ID = "session-user-decision";
const OPTIONS = ["SQLite", "Postgres"];

function userDecisionRequest(overrides: Partial<ApprovalRequest> = {}, metadataOverrides: Record<string, unknown> = {}): ApprovalRequest {
  return {
    schemaVersion: 2,
    approvalId: "apr-user-decision-abc123",
    runId: "run-ud-1",
    sessionId: SESSION_ID,
    status: "pending",
    target: { type: "task", taskId: "task-7" },
    revision: 1,
    generation: 0,
    requestedBy: "developer",
    requestedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    reason: "Which storage backend?",
    evidence: [],
    idempotencyKey: "user-decision:abc123",
    metadata: {
      kind: "user_decision",
      question: "Which storage backend?",
      options: OPTIONS,
      context: "Both adapters exist.",
      requestedByRole: "developer",
      ...metadataOverrides
    },
    ...overrides
  };
}

function contextWith(request: ApprovalRequest): ConversationContextSnapshot {
  return {
    session: {
      sessionId: SESSION_ID,
      status: "awaiting_user_approval",
      activeRunId: request.runId,
      activeApprovalIds: [request.approvalId]
    },
    pendingApprovals: { [request.approvalId]: request },
    pendingClarifications: {},
    runIdToCorrelationId: { [request.runId]: "corr-ud-1" }
  } as unknown as ConversationContextSnapshot;
}

function turn(content: string): UserTurnInput {
  return { sessionId: SESSION_ID, content, provenance: { origin: "user", authenticatedUser: true } };
}

describe("trusted hook approval routing", () => {
  const designContext = () => contextWith(userDecisionRequest({ metadata: {}, requestedBy: "coordinator" }));
  it.each([
    "Yêu cầu workflow loại spike: khảo sát cơ chế phê duyệt, chỉ đọc.",
    'Yêu cầu workflow: kiểm tra token "approve" trong parser',
    "apr-user-decision-abc123: Yêu cầu workflow khảo sát token approve"
  ])("does not approve a pending design because a new request mentions approval: %s", content => {
    expect(classifyTrustedApprovalReply(turn(content), designContext())).toBeUndefined();
  });
  it.each(["approve", "Phê duyệt apr-user-decision-abc123", "apr-user-decision-abc123: approve", "reject", "Cần sửa thêm tiêu chí"])("retains an explicit governance reply: %s", content => {
    const result = classifyTrustedApprovalReply(turn(content), designContext());
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value.intent).toBe("approval_response");
  });
  it("retains exact specialist option replies", () => {
    const result = classifyTrustedApprovalReply(turn("2"), contextWith(userDecisionRequest()));
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value.approvalInput?.selectedOption).toBe("Postgres");
  });
  it("requires a named request for free-text specialist answers", () => {
    const context = contextWith(userDecisionRequest({ metadata: { kind: "user_decision", question: "Choose the storage backend" } }));
    expect(classifyTrustedApprovalReply(turn("Tạo spike: khảo sát quyền MCP của từng role"), context)).toBeUndefined();
    expect(classifyTrustedApprovalReply(turn("apr-user-decision-abc123: chọn PostgreSQL vì cần giao dịch"), context)?.ok).toBe(true);
  });
});

describe("P30 T8 conversation user-decision relay", () => {
  describe("rendering", () => {
    it("identifies user-decision requests by metadata marker only", () => {
      expect(isUserDecisionRequest(userDecisionRequest())).toBe(true);
      expect(isUserDecisionRequest({ metadata: { bundleFingerprint: "x" } })).toBe(false);
    });

    it("renders asking role, question, numbered options and expiry, distinct from design approval wording", () => {
      const request = userDecisionRequest();
      const text = renderUserDecisionPrompt(JSON.parse(JSON.stringify(request)) as Record<string, unknown>);
      expect(text).toContain("CẦN QUYẾT ĐỊNH CỦA BẠN");
      expect(text).toContain("developer");
      expect(text).toContain("task-7");
      expect(text).toContain("Which storage backend?");
      expect(text).toContain("1. SQLite");
      expect(text).toContain("2. Postgres");
      expect(text).toContain(`Hết hạn:** ${request.expiresAt}`);
      expect(text).not.toContain("YÊU CẦU PHÊ DUYỆT");
    });

    it("wraps specialist-supplied context as untrusted content and omits options when there are none", () => {
      const withContext = renderUserDecisionPrompt(JSON.parse(JSON.stringify(userDecisionRequest())) as Record<string, unknown>);
      expect(withContext).toContain("<untrusted_repository_content>");
      const freeText = renderUserDecisionPrompt(JSON.parse(JSON.stringify(
        userDecisionRequest({}, { options: undefined, context: undefined })
      )) as Record<string, unknown>);
      expect(freeText).not.toContain("Các lựa chọn");
      expect(freeText).toContain("Trả lời trực tiếp");
    });

    it("formats the approval.request RoleMessage as a user question in the response formatter", () => {
      const request = userDecisionRequest();
      const roleMessage: RoleMessage = {
        schema_version: 2,
        message_id: `decision-${request.approvalId}`,
        correlation_id: "corr-ud-1",
        run_id: request.runId,
        sender: { role: "runtime", agent_id: "runtime" },
        recipient: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" },
        type: "approval.request",
        payload: JSON.parse(JSON.stringify(request)) as unknown,
        artifact_references: []
      } as RoleMessage;
      const formatted = formatCoordinatorMessageForUser({
        sessionId: SESSION_ID,
        turnSequence: 1,
        roleMessage,
        createdAt: new Date().toISOString()
      });
      expect(formatted.ok).toBe(true);
      if (!formatted.ok) return;
      expect(formatted.value.message.intent).toBe("approval_prompt");
      expect(formatted.value.message.content).toContain("CẦN QUYẾT ĐỊNH CỦA BẠN");
      expect(formatted.value.message.content).toContain("2. Postgres");
    });
  });

  describe("reply mapping", () => {
    it("maps a valid option number and option text to the selected option", () => {
      expect(resolveUserDecisionReply(userDecisionRequest(), "2")).toMatchObject({ kind: "answer", selectedOption: "Postgres" });
      expect(resolveUserDecisionReply(userDecisionRequest(), "  sqlite. ")).toMatchObject({ kind: "answer", selectedOption: "SQLite" });
      expect(resolveUserDecisionReply(userDecisionRequest(), "chọn 1")).toMatchObject({ kind: "answer", selectedOption: "SQLite" });
    });

    it("re-asks for ambiguous or out-of-range replies and never picks a default", () => {
      for (const reply of ["9", "approve", "đồng ý", "I think the first one", "0"]) {
        const result = resolveUserDecisionReply(userDecisionRequest(), reply);
        expect(result.kind, reply).toBe("ambiguous");
        if (result.kind === "ambiguous") {
          expect(result.message).toContain("1. SQLite");
          expect(result.message).toContain("2. Postgres");
        }
      }
    });

    it("maps reject words to a rejection that carries the reply as reason", () => {
      expect(resolveUserDecisionReply(userDecisionRequest(), "từ chối vì chưa rõ")).toEqual({
        kind: "reject",
        reason: "từ chối vì chưa rõ"
      });
      expect(resolveUserDecisionReply(userDecisionRequest(), "Reject")).toEqual({ kind: "reject", reason: "Reject" });
    });

    it("accepts a free-text answer when the question offers no options", () => {
      const request = userDecisionRequest({ metadata: { kind: "user_decision", question: "Choose the storage backend" } });
      expect(resolveUserDecisionReply(request, "Use the existing module")).toEqual({
        kind: "answer",
        reason: "Use the existing module"
      });
      expect(resolveUserDecisionReply(request, "   ")).toMatchObject({ kind: "ambiguous" });
    });
  });

  describe("classification", () => {
    it("routes a valid option reply to approval_response carrying selectedOption", () => {
      const request = userDecisionRequest();
      const result = classifyUserIntent(turn("2"), contextWith(request));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.intent).toBe("approval_response");
      expect(result.value.approvalInput).toMatchObject({
        approvalId: request.approvalId,
        decision: "approved",
        selectedOption: "Postgres"
      });
      expect(result.value.targetRunId).toBe(request.runId);
      expect(result.value.targetCorrelationId).toBe("corr-ud-1");
    });

    it("re-asks through conversation_only without an approval change when the reply is ambiguous", () => {
      const request = userDecisionRequest();
      const result = classifyUserIntent(turn("approve"), contextWith(request));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.intent).toBe("conversation_only");
      expect(result.value.approvalInput).toBeUndefined();
      expect(result.value.directReply).toContain("chưa xác định");
    });

    it("targets one of several pending user decisions by its approval id", () => {
      const first = userDecisionRequest();
      const second = userDecisionRequest({ approvalId: "apr-user-decision-second", runId: "run-ud-2" }, { question: "Which cache?", options: ["Redis", "Memory"] });
      const context = {
        ...contextWith(first),
        pendingApprovals: { [first.approvalId]: first, [second.approvalId]: second }
      } as unknown as ConversationContextSnapshot;

      const ambiguous = classifyUserIntent(turn("2"), context);
      expect(ambiguous.ok && ambiguous.value.intent).toBe("conversation_only");

      const targeted = classifyUserIntent(turn("apr-user-decision-second: 1"), context);
      expect(targeted.ok).toBe(true);
      if (!targeted.ok) return;
      expect(targeted.value.intent).toBe("approval_response");
      expect(targeted.value.approvalInput).toMatchObject({ approvalId: "apr-user-decision-second", decision: "approved", selectedOption: "Redis" });
    });

    it("does not map a bare option number when no user decision is pending", () => {
      const result = classifyUserIntent(turn("2"), {
        session: { sessionId: SESSION_ID, status: "active", activeApprovalIds: [] },
        pendingApprovals: {},
        pendingClarifications: {},
        workflows: {},
        runIdToCorrelationId: {}
      } as unknown as ConversationContextSnapshot);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.intent).not.toBe("approval_response");
    });

    it("leaves an explicitly named non-user approval to the existing approval path", () => {
      const request = userDecisionRequest();
      const designApproval = { ...request, approvalId: "apr-design-1", metadata: { bundleFingerprint: "f" } } as ApprovalRequest;
      const context = {
        ...contextWith(request),
        pendingApprovals: { [request.approvalId]: request, [designApproval.approvalId]: designApproval }
      } as unknown as ConversationContextSnapshot;
      const result = classifyUserIntent(turn("approve apr-design-1"), context);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.intent).toBe("approval_response");
        expect(result.value.approvalInput).toMatchObject({ approvalId: "apr-design-1", decision: "approved" });
        expect(result.value.approvalInput?.selectedOption).toBeUndefined();
      }
    });
  });

  describe("gateway round trip", () => {
    async function openGatewayWithDecision(request: ApprovalRequest) {
      const transport = new MockHerdrAgentTransport();
      const bridge = new HerdrConversationBridge({
        transport,
        sessionId: SESSION_ID,
        conversationAgentId: "chat",
        conversationPaneId: "pane-chat",
        coordinatorTarget: { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator" }
      });
      const gateway = new ConversationGateway({
        sessionId: SESSION_ID,
        herdrSessionId: `herdr-${SESSION_ID}`,
        conversationAgentId: "chat",
        paneId: "pane-chat",
        bridge,
        contextStore: new InMemoryConversationContextStore()
      });
      await gateway.initializeOrRecoverSession();
      const start = await gateway.handleUserTurn({
        sessionId: SESSION_ID,
        content: "Triển khai lưu trữ trong packages/storage",
        provenance: { origin: "user", authenticatedUser: true }
      });
      if (!start.ok) throw new Error(start.error.message);
      const runtimeMessage: RoleMessage = {
        schema_version: 2,
        message_id: `decision-${request.approvalId}`,
        correlation_id: start.value.correlationId,
        run_id: request.runId,
        sender: { role: "runtime", agent_id: "runtime" },
        recipient: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" },
        type: "approval.request",
        payload: JSON.parse(JSON.stringify({ ...request, runId: request.runId })) as unknown,
        artifact_references: []
      } as RoleMessage;
      const prompted = await gateway.handleCoordinatorRoleMessage(runtimeMessage);
      if (!prompted.ok) throw new Error(prompted.error.message);
      return { gateway, transport, correlationId: start.value.correlationId };
    }

    it("sends the user's option reply to Coordinator as a user-scoped approval.decision", async () => {
      const request = userDecisionRequest({ runId: "run-gw-1" });
      const { gateway, transport } = await openGatewayWithDecision(request);
      expect(gateway.getContextSnapshot().pendingApprovals[request.approvalId]).toBeDefined();

      const answer = await gateway.handleUserTurn(turn("2"));
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.value.recognizedIntent).toBe("approval_response");
      expect(answer.value.approvalDecision?.decision).toBe("approved");
      expect(answer.value.approvalDecision?.metadata).toMatchObject({ selectedOption: "Postgres", kind: "user_decision" });
      expect(answer.value.approvalDecision?.decidedBy).toBe("user");
      expect(gateway.getContextSnapshot().pendingApprovals[request.approvalId]).toBeUndefined();
      const sent = transport.sentRoleMessages[transport.sentRoleMessages.length - 1];
      expect(sent?.type).toBe("approval.decision");
      expect(sent?.recipient.role).toBe("coordinator");
    });

    it("keeps the request pending and re-asks on an ambiguous reply", async () => {
      const request = userDecisionRequest({ runId: "run-gw-2" });
      const { gateway } = await openGatewayWithDecision(request);
      const reply = await gateway.handleUserTurn(turn("đồng ý"));
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(reply.value.recognizedIntent).toBe("conversation_only");
      expect(reply.value.approvalDecision).toBeUndefined();
      expect(gateway.getContextSnapshot().pendingApprovals[request.approvalId]).toBeDefined();
    });

    it("rejects an answer to a user decision after its expiry", async () => {
      const request = userDecisionRequest({
        runId: "run-gw-3",
        expiresAt: new Date(Date.now() - 1000).toISOString()
      });
      const { gateway } = await openGatewayWithDecision(request);
      const late = await gateway.handleUserTurn(turn("1"));
      expect(late.ok).toBe(false);
      if (late.ok) return;
      expect(late.error.message).toContain("expired");
    });

    it("drops an expired prompt on Runtime's expiry notice and tells the user", async () => {
      const request = userDecisionRequest({ runId: "run-gw-4" });
      const { gateway, correlationId } = await openGatewayWithDecision(request);
      expect(gateway.getContextSnapshot().pendingApprovals[request.approvalId]).toBeDefined();

      const notice = await gateway.handleCoordinatorRoleMessage({
        schema_version: 2,
        message_id: `p19-expired-${request.approvalId}`,
        correlation_id: correlationId,
        run_id: request.runId,
        sender: { role: "coordinator" },
        recipient: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" },
        type: "conversation.progress",
        payload: { kind: "user_decision_expired", approvalId: request.approvalId, requestedByRole: "developer", taskId: "task-7" },
        artifact_references: []
      } as RoleMessage);
      expect(notice.ok).toBe(true);
      if (!notice.ok) return;
      expect(notice.value.userNotification?.content).toContain("HẾT HẠN");
      expect(gateway.getContextSnapshot().pendingApprovals[request.approvalId]).toBeUndefined();
      expect(gateway.getContextSnapshot().session.activeApprovalIds).not.toContain(request.approvalId);

      const late = await gateway.handleUserTurn(turn("1"));
      expect(late.ok && late.value.approvalDecision).toBeFalsy();
    });

    it("never drops a design approval on an expiry notice that names a non-user request", async () => {
      const request = userDecisionRequest({ runId: "run-gw-5" });
      const { gateway, correlationId } = await openGatewayWithDecision(request);
      await gateway.handleCoordinatorRoleMessage({
        schema_version: 2,
        message_id: "p19-expired-design",
        correlation_id: correlationId,
        run_id: request.runId,
        sender: { role: "coordinator" },
        recipient: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" },
        type: "conversation.progress",
        payload: { kind: "user_decision_expired", approvalId: "apr-design-1" },
        artifact_references: []
      } as RoleMessage);
      expect(gateway.getContextSnapshot().pendingApprovals[request.approvalId]).toBeDefined();
    });
  });

  describe("expired entries and design approvals sharing the queue", () => {
    function expiredRequest(overrides: Partial<ApprovalRequest> = {}, metadataOverrides: Record<string, unknown> = {}): ApprovalRequest {
      return userDecisionRequest({
        approvalId: "apr-user-decision-expired",
        runId: "run-ud-old",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        ...overrides
      }, metadataOverrides);
    }

    function designApproval(): ApprovalRequest {
      return {
        schemaVersion: 2,
        approvalId: "apr-design-1",
        runId: "run-ud-1",
        sessionId: SESSION_ID,
        status: "pending",
        target: { type: "task", taskId: "task-7" },
        revision: 1,
        generation: 0,
        requestedBy: "runtime",
        requestedAt: new Date(Date.now() - 60_000).toISOString(),
        reason: "Approve the design",
        evidence: [],
        idempotencyKey: "design-approval-1",
        metadata: {}
      } as ApprovalRequest;
    }

    it("does not count an expired user decision as one of several pending questions", () => {
      const live = userDecisionRequest();
      const expired = expiredRequest({}, { question: "Which cache?", options: ["Redis", "Memory"] });
      const context = {
        ...contextWith(live),
        pendingApprovals: { [live.approvalId]: live, [expired.approvalId]: expired }
      } as unknown as ConversationContextSnapshot;

      const result = classifyUserIntent(turn("2"), context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.intent).toBe("approval_response");
      expect(result.value.approvalInput).toMatchObject({ approvalId: live.approvalId, selectedOption: "Postgres" });
    });

    it("lets a design approval receive 'approve' while a user decision is also pending", () => {
      const question = userDecisionRequest();
      const design = designApproval();
      const context = {
        ...contextWith(question),
        session: { ...contextWith(question).session, activeApprovalIds: [question.approvalId, design.approvalId] },
        pendingApprovals: { [question.approvalId]: question, [design.approvalId]: design }
      } as unknown as ConversationContextSnapshot;

      const result = classifyUserIntent(turn("approve"), context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.intent).toBe("approval_response");
      expect(result.value.approvalInput).toMatchObject({ approvalId: design.approvalId, decision: "approved" });
    });

    it("keeps answering the user decision by option number or exact option text while a design approval is pending", () => {
      const question = userDecisionRequest();
      const design = designApproval();
      const context = {
        ...contextWith(question),
        session: { ...contextWith(question).session, activeApprovalIds: [question.approvalId, design.approvalId] },
        pendingApprovals: { [question.approvalId]: question, [design.approvalId]: design }
      } as unknown as ConversationContextSnapshot;

      for (const reply of ["1", "Postgres"]) {
        const result = classifyUserIntent(turn(reply), context);
        expect(result.ok, reply).toBe(true);
        if (!result.ok) return;
        expect(result.value.approvalInput, reply).toMatchObject({ approvalId: question.approvalId });
        expect(result.value.approvalInput?.selectedOption, reply).toBe(reply === "1" ? "SQLite" : "Postgres");
      }
    });

    it("does not let an unmatched reply answer the user decision while a design approval is pending", () => {
      const question = userDecisionRequest();
      const design = designApproval();
      const context = {
        ...contextWith(question),
        session: { ...contextWith(question).session, activeApprovalIds: [question.approvalId, design.approvalId] },
        pendingApprovals: { [question.approvalId]: question, [design.approvalId]: design }
      } as unknown as ConversationContextSnapshot;

      const result = classifyUserIntent(turn("maybe, not sure"), { ...context, workflows: {} } as ConversationContextSnapshot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.approvalInput?.approvalId).not.toBe(question.approvalId);
      expect(result.value.intent).not.toBe("conversation_only");
    });
  });
});
