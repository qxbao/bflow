import { describe, expect, it } from "vitest";
import type { ApprovalRequest, RoleMessage } from "@bflow/contracts";
import {
  ConversationGateway,
  HerdrConversationBridge,
  InMemoryConversationContextStore,
  MockHerdrAgentTransport
} from "../src/index.js";

const SESSION_ID = "session-approval-lifecycle";
const NOW = "2031-01-01T00:00:00.000Z";

function designApproval(runId: string, approvalId = "apr-design-1"): ApprovalRequest {
  return {
    schemaVersion: 2,
    approvalId,
    runId,
    sessionId: SESSION_ID,
    status: "pending",
    target: { type: "specification", specId: "spec-storage" },
    revision: 1,
    generation: 0,
    requestedBy: "coordinator",
    requestedAt: NOW,
    reason: "Duyệt đặc tả lưu trữ",
    evidence: [],
    idempotencyKey: `idemp-${approvalId}`,
    metadata: {}
  };
}

function runtimeMessage(correlationId: string, runId: string, type: string, payload: unknown, messageId: string): RoleMessage {
  return {
    schema_version: 2,
    message_id: messageId,
    correlation_id: correlationId,
    run_id: runId,
    sender: { role: "runtime", agent_id: "runtime" },
    recipient: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" },
    type,
    payload: JSON.parse(JSON.stringify(payload)) as unknown,
    artifact_references: []
  } as RoleMessage;
}

async function openRun(content: string) {
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
    content,
    provenance: { origin: "user", authenticatedUser: true }
  });
  if (!start.ok) throw new Error(start.error.message);
  return { gateway, transport, correlationId: start.value.correlationId, runId: start.value.runId! };
}

async function requestApproval(gateway: ConversationGateway, correlationId: string, request: ApprovalRequest) {
  const result = await gateway.handleCoordinatorRoleMessage(
    runtimeMessage(correlationId, request.runId, "approval.request", request, `msg-${request.approvalId}`)
  );
  if (!result.ok) throw new Error(result.error.message);
}

describe("A1: approvals of a terminated or superseded run are closed", () => {
  it("expires the pending approvals of a run that Runtime reports cancelled and releases the active run", async () => {
    const { gateway, transport, correlationId, runId } = await openRun("Triển khai lưu trữ trong packages/storage");
    await requestApproval(gateway, correlationId, designApproval(runId));

    const cancelled = await gateway.handleCoordinatorRoleMessage(runtimeMessage(correlationId, runId, "conversation.progress",
      { headline: "Run đã bị hủy", sdlcStatus: "cancelled" }, "msg-run-cancelled"));
    expect(cancelled.ok).toBe(true);

    const snapshot = gateway.getContextSnapshot();
    expect(snapshot.pendingApprovals["apr-design-1"]).toBeUndefined();
    expect(snapshot.session.activeApprovalIds).toEqual([]);
    expect(snapshot.session.activeRunId).toBeUndefined();
    expect(snapshot.session.status).toBe("reporting_progress");
    expect(snapshot.workflows[correlationId]?.activeApprovalIds).toEqual([]);
    expect(snapshot.closedApprovals?.["apr-design-1"]).toMatchObject({ runId, status: "expired" });
    expect(transport.sentRoleMessages).toHaveLength(1);
  });

  it("refuses a human decision on an approval closed by run termination without sending it to Coordinator", async () => {
    const { gateway, transport, correlationId, runId } = await openRun("Triển khai lưu trữ trong packages/storage");
    await requestApproval(gateway, correlationId, designApproval(runId));
    await gateway.handleCoordinatorRoleMessage(runtimeMessage(correlationId, runId, "conversation.progress",
      { headline: "Run đã thất bại", sdlcStatus: "failed" }, "msg-run-failed"));
    const sentBefore = transport.sentRoleMessages.length;

    const reply = await gateway.handleUserTurn({
      sessionId: SESSION_ID,
      content: "apr-design-1: approve",
      provenance: { origin: "user", authenticatedUser: true }
    });

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value.approvalDecision).toBeUndefined();
    expect(reply.value.agentReply.content).toContain("apr-design-1");
    expect(reply.value.agentReply.content).toContain("không còn hiệu lực");
    expect(reply.value.agentReply.content).toContain("không có quyết định nào được áp dụng");
    expect(transport.sentRoleMessages).toHaveLength(sentBefore);
    expect(gateway.getContextSnapshot().approvalDecisions["apr-design-1"]).toBeUndefined();
  });

  it("does not register a replayed approval.request for an approval that was already closed", async () => {
    const { gateway, correlationId, runId } = await openRun("Triển khai lưu trữ trong packages/storage");
    await requestApproval(gateway, correlationId, designApproval(runId));
    await gateway.handleCoordinatorRoleMessage(runtimeMessage(correlationId, runId, "conversation.progress",
      { headline: "Run đã bị hủy", sdlcStatus: "cancelled" }, "msg-run-cancelled-replay"));

    const replay = await gateway.handleCoordinatorRoleMessage(
      runtimeMessage(correlationId, runId, "approval.request", designApproval(runId), "msg-replayed-approval")
    );

    expect(replay.ok && replay.value.duplicateIgnored).toBe(true);
    expect(gateway.getContextSnapshot().pendingApprovals["apr-design-1"]).toBeUndefined();
    expect(gateway.getContextSnapshot().session.activeApprovalIds).toEqual([]);
  });

  it("supersedes approvals listed by a Runtime approval_superseded notice and keeps other approvals open", async () => {
    const { gateway, correlationId, runId } = await openRun("Triển khai lưu trữ trong packages/storage");
    await requestApproval(gateway, correlationId, designApproval(runId, "apr-design-1"));
    await requestApproval(gateway, correlationId, designApproval(runId, "apr-design-2"));

    const notice = await gateway.handleCoordinatorRoleMessage(runtimeMessage(correlationId, runId, "conversation.progress",
      { headline: "Yêu cầu đã được cập nhật", kind: "approval_superseded", approvalIds: ["apr-design-1"], reason: "Revision 2 thay thế tiêu chí" },
      "msg-superseded"));
    expect(notice.ok).toBe(true);

    const snapshot = gateway.getContextSnapshot();
    expect(snapshot.pendingApprovals["apr-design-1"]).toBeUndefined();
    expect(snapshot.pendingApprovals["apr-design-2"]).toBeDefined();
    expect(snapshot.session.activeApprovalIds).toEqual(["apr-design-2"]);
    expect(snapshot.session.status).toBe("awaiting_user_approval");
    expect(snapshot.closedApprovals?.["apr-design-1"]).toMatchObject({ runId, status: "superseded", reason: "Revision 2 thay thế tiêu chí" });
  });

  it("does not close approvals of another run when one run terminates", async () => {
    const { gateway, correlationId, runId } = await openRun("Triển khai lưu trữ trong packages/storage");
    await requestApproval(gateway, correlationId, designApproval(runId, "apr-run-one"));
    const second = await gateway.handleUserTurn({
      sessionId: SESSION_ID,
      content: "Sửa lỗi parser trong packages/parser khi chuỗi rỗng phải trả lỗi",
      provenance: { origin: "user", authenticatedUser: true }
    });
    if (!second.ok || !second.value.runId) throw new Error("second workflow did not start");
    await requestApproval(gateway, second.value.correlationId, designApproval(second.value.runId, "apr-run-two"));

    await gateway.handleCoordinatorRoleMessage(runtimeMessage(correlationId, runId, "conversation.progress",
      { headline: "Run một đã bị hủy", sdlcStatus: "cancelled" }, "msg-run-one-cancelled"));

    const snapshot = gateway.getContextSnapshot();
    expect(snapshot.pendingApprovals["apr-run-one"]).toBeUndefined();
    expect(snapshot.pendingApprovals["apr-run-two"]).toBeDefined();
    expect(snapshot.session.activeApprovalIds).toEqual(["apr-run-two"]);
  });
});
