import { describe, expect, it } from "vitest";
import type { ApprovalRequest, RoleMessage } from "@bflow/contracts";
import {
  ConversationGateway,
  HerdrConversationBridge,
  InMemoryConversationContextStore,
  MockHerdrAgentTransport,
  classifyTrustedApprovalReply,
  closeClarificationsForApproval,
  closeSettledApprovalClarifications,
  explainUnrecordedApprovalReply,
  type ConversationContextSnapshot,
  type PendingClarificationContext,
  type UserTurnInput
} from "../src/index.js";

// Real-session shaped ids: specialist decisions are `apr-user-decision-<hex>`, design approvals `design-<hex>`.
const SESSION_ID = "session-approval-replies";
const APR_A = "apr-user-decision-ad63f1e2c4b5a6978877665544332211aabbccdd";
const APR_B = "apr-user-decision-e90848cac7c8f5388192f4ea6a3673590a03bf28";
const DESIGN = "design-1404c0ffee5a7d9b2e3f4a5b6c7d8e9f";

function userDecision(approvalId: string): ApprovalRequest {
  return {
    schemaVersion: 2, approvalId, runId: "run-1", sessionId: SESSION_ID, status: "pending",
    target: { type: "task", taskId: "task-1" }, revision: 1, generation: 0, requestedBy: "coordinator",
    requestedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    reason: "Chọn phương án", evidence: [], idempotencyKey: `idem-${approvalId}`,
    metadata: { kind: "user_decision", question: "Chọn phương án?", options: ["Đóng run", "Đổi ac-4", "Hardening", "Hủy run"], requestedByRole: "coordinator" }
  } as ApprovalRequest;
}

function designApproval(approvalId = DESIGN): ApprovalRequest {
  return {
    schemaVersion: 2, approvalId, runId: "run-1", sessionId: SESSION_ID, status: "pending",
    target: { type: "run", runId: "run-1" }, revision: 1, generation: 0, requestedBy: "runtime",
    requestedAt: new Date(Date.now() - 60_000).toISOString(), reason: "Approve the design", evidence: [],
    idempotencyKey: `idem-${approvalId}`, metadata: { bundleFingerprint: "fingerprint-1" }
  } as ApprovalRequest;
}

function contextWith(...requests: ApprovalRequest[]): ConversationContextSnapshot {
  return {
    session: { sessionId: SESSION_ID, status: "awaiting_user_approval", activeRunId: "run-1",
      activeApprovalIds: requests.map(request => request.approvalId), unresolvedQuestions: [] },
    pendingApprovals: Object.fromEntries(requests.map(request => [request.approvalId, request])),
    pendingClarifications: {},
    approvalDecisions: {},
    runIdToCorrelationId: { "run-1": "corr-run-1" }
  } as unknown as ConversationContextSnapshot;
}

function turn(content: string): UserTurnInput {
  return { sessionId: SESSION_ID, content, provenance: { origin: "user", authenticatedUser: true } };
}

function decided(content: string, context: ConversationContextSnapshot) {
  const result = classifyTrustedApprovalReply(turn(content), context);
  return result?.ok ? result.value.approvalInput : undefined;
}

describe("trusted approval replies observed in conv-bf-daac1a7e8152c8d655d6", () => {
  it("row 1: an apr id with an option number while two decisions are pending", () => {
    expect(decided(`${APR_A}: 1`, contextWith(userDecision(APR_A), userDecision(APR_B))))
      .toMatchObject({ approvalId: APR_A, decision: "approved", selectedOption: "Đóng run" });
  });

  it("row 2: an apr id with an option number while one decision is pending", () => {
    expect(decided(`${APR_B}: 1`, contextWith(userDecision(APR_B))))
      .toMatchObject({ approvalId: APR_B, decision: "approved", selectedOption: "Đóng run" });
  });

  it("row 3: a design id with approve", () => {
    expect(decided(`${DESIGN}: approve`, contextWith(designApproval()))).toMatchObject({ approvalId: DESIGN, decision: "approved" });
  });

  it("row 4: a bare 1 approves the only pending design approval", () => {
    expect(decided("1", contextWith(designApproval()))).toMatchObject({ approvalId: DESIGN, decision: "approved" });
  });

  it("row 5: a bare approve still approves the only pending design approval", () => {
    expect(decided("approve", contextWith(designApproval()))).toMatchObject({ approvalId: DESIGN, decision: "approved" });
  });

  it("row 6: a two-line reply naming two decisions records nothing and explains why", () => {
    const context = contextWith(userDecision(APR_A), userDecision(APR_B));
    const content = `${APR_B}: 1\n${APR_A}) hiển thị lại câu hỏi`;
    expect(classifyTrustedApprovalReply(turn(content), context)).toBeUndefined();
    const warning = explainUnrecordedApprovalReply(turn(content), context);
    expect(warning).toContain("CHƯA ghi nhận");
    expect(warning).toContain(APR_A);
    expect(warning).toContain(APR_B);
  });
});

describe("approval reply targeting", () => {
  it.each([
    ["Duyệt thiết kế", DESIGN],
    ["Duyệt tác vụ", "task-approval-1234abcd"],
    ["Duyệt bàn giao", "delivery-1234abcd"]
  ])("accepts the exact Vietnamese gate label %s only for its own approval", (label, id) => {
    expect(decided(label, contextWith(designApproval(id))))
      .toMatchObject({ approvalId: id, decision: "approved" });
    expect(decided(`${id}: ${label}`, contextWith(designApproval(id))))
      .toMatchObject({ approvalId: id, decision: "approved" });
  });

  it("never treats a Vietnamese gate label as authority for a different or ambiguous gate", () => {
    for (const [label, id] of [["Duyệt thiết kế", "delivery-1234abcd"], ["Duyệt tác vụ", DESIGN], ["Duyệt bàn giao", DESIGN]]) {
      expect(decided(label!, contextWith(designApproval(id!)))).toBeUndefined();
      expect(decided(`${id}: ${label}`, contextWith(designApproval(id!)))).toBeUndefined();
    }
    for (const context of [contextWith(designApproval(), designApproval("design-2222beef")), contextWith(designApproval(), userDecision(APR_A))]) {
      expect(decided("Duyệt thiết kế", context)).toBeUndefined();
      expect(decided(`${DESIGN}: Duyệt thiết kế`, context)).toMatchObject({ approvalId: DESIGN, decision: "approved" });
    }
  });

  it.each([
    "Chưa duyệt thiết kế", "Không duyệt thiết kế", "Duyệt thiết kế nếu test đạt",
    "Duyệt thiết kế và bàn giao", "Duyệt thiết kế; chưa duyệt tác vụ", 'Ví dụ: "Duyệt thiết kế"',
    "Duyệt thiết kế\nDuyệt bàn giao"
  ])("keeps prose and combined gate replies out of the trusted hook: %s", content => {
    expect(decided(content, contextWith(designApproval()))).toBeUndefined();
  });

  it("rejects a design approval by id with the reason", () => {
    expect(decided(`${DESIGN}: reject thiếu kiểm thử hồi quy`, contextWith(designApproval())))
      .toMatchObject({ approvalId: DESIGN, decision: "rejected", reason: expect.stringContaining("thiếu kiểm thử hồi quy") });
  });

  it("rejects by number only with a reason, and asks for one otherwise", () => {
    const context = contextWith(designApproval());
    expect(decided("2 thiếu kiểm thử", context)).toMatchObject({ approvalId: DESIGN, decision: "rejected", reason: "thiếu kiểm thử" });
    expect(decided(`${DESIGN}: 2 thiếu kiểm thử`, context)).toMatchObject({ approvalId: DESIGN, decision: "rejected", reason: "thiếu kiểm thử" });
    expect(classifyTrustedApprovalReply(turn("2"), context)).toBeUndefined();
    expect(explainUnrecordedApprovalReply(turn("2"), context)).toContain("cần kèm lý do");
  });

  it("never retargets an unknown id to the pending approval", () => {
    const context = contextWith(designApproval());
    for (const content of ["design-ffff0000aaaa1111: approve", "design-ffff0000aaaa1111: 1", "apr-user-decision-0000dead: approve"]) {
      expect(classifyTrustedApprovalReply(turn(content), context), content).toBeUndefined();
    }
  });

  it("does not pick one of several pending approvals for a bare approve or number", () => {
    for (const context of [contextWith(userDecision(APR_A), userDecision(APR_B)), contextWith(designApproval(), designApproval("design-2222beef"))]) {
      for (const content of ["approve", "1"]) {
        expect(classifyTrustedApprovalReply(turn(content), context), content).toBeUndefined();
        expect(explainUnrecordedApprovalReply(turn(content), context), content).toContain("CHƯA được ghi nhận");
      }
    }
  });

  it("treats a bare number as ambiguous while a design approval and a user decision are both pending", () => {
    const context = contextWith(designApproval(), userDecision(APR_A));
    expect(classifyTrustedApprovalReply(turn("1"), context)).toBeUndefined();
    expect(explainUnrecordedApprovalReply(turn("1"), context)).toContain("CHƯA được ghi nhận");
    expect(decided(`${APR_A}: 1`, context)).toMatchObject({ approvalId: APR_A, selectedOption: "Đóng run" });
    expect(decided(`${DESIGN}: 1`, context)).toMatchObject({ approvalId: DESIGN, decision: "approved" });
  });

  it("keeps ordinary id-prefixed questions out of the approval path", () => {
    const context = contextWith(designApproval());
    expect(classifyTrustedApprovalReply(turn("run-123abc: trạng thái thế nào?"), context)).toBeUndefined();
    expect(explainUnrecordedApprovalReply(turn("run-123abc: trạng thái thế nào?"), context)).toBeUndefined();
  });

  it("maps short #n aliases (#1: 1, #2 1, #1: đồng ý, #1: từ chối vì ...) to the exact approvalId", () => {
    const context = {
      ...contextWith(designApproval(), userDecision(APR_A)),
      approvalShortIds: { "#1": DESIGN, "#2": APR_A }
    } as ConversationContextSnapshot;
    expect(decided("#1: đồng ý", context)).toMatchObject({ approvalId: DESIGN, decision: "approved" });
    expect(decided("#1: 1", context)).toMatchObject({ approvalId: DESIGN, decision: "approved" });
    expect(decided("#1: từ chối vì thiếu kiểm thử", context))
      .toMatchObject({ approvalId: DESIGN, decision: "rejected", reason: expect.stringContaining("thiếu kiểm thử") });
    expect(decided("#2: 1", context)).toMatchObject({ approvalId: APR_A, decision: "approved", selectedOption: "Đóng run" });
    expect(decided("#2 1", context)).toMatchObject({ approvalId: APR_A, decision: "approved", selectedOption: "Đóng run" });
  });

  it("refuses an unknown #n alias (#99) and never falls back to another pending approval", () => {
    const context = {
      ...contextWith(designApproval()),
      approvalShortIds: { "#1": DESIGN }
    } as ConversationContextSnapshot;
    expect(classifyTrustedApprovalReply(turn("#99: đồng ý"), context)).toBeUndefined();
    expect(classifyTrustedApprovalReply(turn("#99: 1"), context)).toBeUndefined();
  });
});

describe("clarifications about a decided approval", () => {
  const clarification = (correlationId: string, originalRequestText: string, question: string): PendingClarificationContext => ({
    correlationId, originalRequestText, accumulatedDetails: [], unresolvedQuestions: [question],
    draft: { title: "x", objective: "x", kind: "feature", sddLevel: "lightweight", priority: "normal", scopeDefined: false,
      isLargeTask: false, affectedPaths: [], acceptanceCriteriaDescriptions: [], isRequirementChange: false },
    createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z"
  } as PendingClarificationContext);

  it("closes only the clarifications that were about the decided approval", () => {
    const stale = clarification("corr-stale", APR_B, `Bạn mới gửi mã ${APR_B} mà chưa kèm số lựa chọn. Bạn chọn phương án nào?`);
    const other = clarification("corr-other", "Thêm trang cài đặt", "Trang nằm ở đâu?");
    const snapshot = { ...contextWith(userDecision(APR_B)), pendingClarifications: { [stale.correlationId]: stale, [other.correlationId]: other },
      session: { ...contextWith().session, status: "awaiting_user_clarification", unresolvedQuestions: [...stale.unresolvedQuestions, ...other.unresolvedQuestions] } } as ConversationContextSnapshot;
    const closed = closeClarificationsForApproval(snapshot, APR_B, "2026-10-22T01:00:00.000Z");
    expect(Object.keys(closed.pendingClarifications)).toEqual(["corr-other"]);
    expect(closed.session.unresolvedQuestions).toEqual(other.unresolvedQuestions);
    expect(closeClarificationsForApproval(closed, APR_B, "2026-10-22T02:00:00.000Z")).toBe(closed);
  });

  it("removes the stale clarification when the Gateway records the named approval reply", async () => {
    const store = new InMemoryConversationContextStore();
    const gateway = () => new ConversationGateway({
      sessionId: SESSION_ID, herdrSessionId: `herdr-${SESSION_ID}`, conversationAgentId: "chat", paneId: "pane-chat",
      bridge: new HerdrConversationBridge({ transport: new MockHerdrAgentTransport(), sessionId: SESSION_ID, conversationAgentId: "chat",
        conversationPaneId: "pane-chat", coordinatorTarget: { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator" } }),
      contextStore: store
    });
    const first = gateway();
    await first.initializeOrRecoverSession();
    const start = await first.handleUserTurn({ sessionId: SESSION_ID, content: "Triển khai lưu trữ trong packages/storage",
      provenance: { origin: "user", authenticatedUser: true } });
    if (!start.ok) throw new Error(start.error.message);
    const request = userDecision(APR_B);
    const prompted = await first.handleCoordinatorRoleMessage({
      schema_version: 2, message_id: `decision-${APR_B}`, correlation_id: start.value.correlationId, run_id: request.runId,
      sender: { role: "runtime", agent_id: "runtime" }, recipient: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" },
      type: "approval.request", payload: JSON.parse(JSON.stringify(request)) as unknown, artifact_references: []
    } as RoleMessage);
    if (!prompted.ok) throw new Error(prompted.error.message);
    const stale = clarification("corr-stale", APR_B, `Bạn mới gửi mã ${APR_B} mà chưa kèm số lựa chọn.`);
    const snapshot = first.getContextSnapshot();
    const saved = await store.save({ ...snapshot, pendingClarifications: { ...snapshot.pendingClarifications, [stale.correlationId]: stale },
      session: { ...snapshot.session, unresolvedQuestions: [...snapshot.session.unresolvedQuestions, ...stale.unresolvedQuestions] } });
    if (!saved.ok) throw new Error(saved.error.message);

    const second = gateway();
    await second.initializeOrRecoverSession();
    expect(second.getContextSnapshot().pendingClarifications["corr-stale"]).toBeDefined();
    const reply = await second.handleUserTurn({ sessionId: SESSION_ID, messageId: "human-reply", content: `${APR_B}: 1`,
      provenance: { origin: "user", authenticatedUser: true } });
    expect(reply.ok, reply.ok ? "" : reply.error.message).toBe(true);
    if (!reply.ok) return;
    expect(reply.value.approvalDecision).toMatchObject({ approvalId: APR_B });
    const after = second.getContextSnapshot();
    expect(after.pendingClarifications["corr-stale"]).toBeUndefined();
    expect(after.session.unresolvedQuestions.join("\n")).not.toContain(APR_B);
  });

  it("closes clarifications about approvals that were already decided or closed, and keeps those about pending ones", () => {
    const decided = clarification("corr-decided", APR_B, `Bạn mới gửi mã ${APR_B} mà chưa kèm số lựa chọn.`);
    const closedOne = clarification("corr-closed", "Hỏi lại", `Bạn chọn gì cho ${DESIGN}?`);
    const pending = clarification("corr-pending", APR_A, `Bạn chọn gì cho ${APR_A}?`);
    const base = contextWith(userDecision(APR_A));
    const snapshot = { ...base,
      approvalDecisions: { [APR_B]: { approvalId: APR_B, decision: "approved" } },
      closedApprovals: { [DESIGN]: { approvalId: DESIGN, runId: "run-1", status: "expired", reason: "run ended", closedAt: "2026-10-22T00:00:00.000Z" } },
      pendingClarifications: { [decided.correlationId]: decided, [closedOne.correlationId]: closedOne, [pending.correlationId]: pending },
      session: { ...base.session, status: "awaiting_user_clarification",
        unresolvedQuestions: [...decided.unresolvedQuestions, ...closedOne.unresolvedQuestions, ...pending.unresolvedQuestions] } } as unknown as ConversationContextSnapshot;
    const pruned = closeSettledApprovalClarifications(snapshot, "2026-10-22T01:00:00.000Z");
    expect(Object.keys(pruned.pendingClarifications)).toEqual(["corr-pending"]);
    expect(pruned.session.unresolvedQuestions).toEqual(pending.unresolvedQuestions);
    expect(closeSettledApprovalClarifications(pruned, "2026-10-22T02:00:00.000Z")).toBe(pruned);
  });

  it("drops a clarification persisted before its approval was decided when the session is recovered", async () => {
    const store = new InMemoryConversationContextStore();
    const gateway = () => new ConversationGateway({
      sessionId: SESSION_ID, herdrSessionId: `herdr-${SESSION_ID}`, conversationAgentId: "chat", paneId: "pane-chat",
      bridge: new HerdrConversationBridge({ transport: new MockHerdrAgentTransport(), sessionId: SESSION_ID, conversationAgentId: "chat",
        conversationPaneId: "pane-chat", coordinatorTarget: { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator" } }),
      contextStore: store
    });
    const first = gateway();
    await first.initializeOrRecoverSession();
    const start = await first.handleUserTurn({ sessionId: SESSION_ID, content: "Triển khai lưu trữ trong packages/storage",
      provenance: { origin: "user", authenticatedUser: true } });
    if (!start.ok) throw new Error(start.error.message);
    const request = userDecision(APR_B);
    const prompted = await first.handleCoordinatorRoleMessage({
      schema_version: 2, message_id: `decision-${APR_B}`, correlation_id: start.value.correlationId, run_id: request.runId,
      sender: { role: "runtime", agent_id: "runtime" }, recipient: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" },
      type: "approval.request", payload: JSON.parse(JSON.stringify(request)) as unknown, artifact_references: []
    } as RoleMessage);
    if (!prompted.ok) throw new Error(prompted.error.message);
    const reply = await first.handleUserTurn({ sessionId: SESSION_ID, messageId: "human-reply", content: `${APR_B}: 1`,
      provenance: { origin: "user", authenticatedUser: true } });
    if (!reply.ok) throw new Error(reply.error.message);
    // State written by a version that did not close clarifications on decision: the question outlives its decided approval.
    const stale = clarification("corr-stale", APR_B, `Bạn mới gửi mã ${APR_B} mà chưa kèm số lựa chọn.`);
    const snapshot = first.getContextSnapshot();
    expect(snapshot.approvalDecisions[APR_B]).toBeDefined();
    const saved = await store.save({ ...snapshot, pendingClarifications: { ...snapshot.pendingClarifications, [stale.correlationId]: stale },
      session: { ...snapshot.session, status: "awaiting_user_clarification", unresolvedQuestions: [...snapshot.session.unresolvedQuestions, ...stale.unresolvedQuestions] } });
    if (!saved.ok) throw new Error(saved.error.message);

    const second = gateway();
    const recovered = await second.initializeOrRecoverSession();
    expect(recovered.ok).toBe(true);
    const after = second.getContextSnapshot();
    expect(after.pendingClarifications["corr-stale"]).toBeUndefined();
    expect(after.session.unresolvedQuestions.join("\n")).not.toContain(APR_B);
    expect(after.session.status).not.toBe("awaiting_user_clarification");
    const persisted = await store.load(SESSION_ID);
    expect(persisted.ok && persisted.value?.pendingClarifications["corr-stale"]).toBeFalsy();
  });
});
