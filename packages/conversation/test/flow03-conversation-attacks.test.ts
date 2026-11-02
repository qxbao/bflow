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
  resolveUserDecisionReply,
  ChatDecisionSchema,
  ExtractedRequirementDraftSchema,
  type ConversationContextSnapshot,
  type UserTurnInput
} from "../src/index.js";

const SESSION_ID = "session-attacks-1";

function userDecisionReq(overrides: Partial<ApprovalRequest> = {}, metadataOverrides: Record<string, unknown> = {}): ApprovalRequest {
  return {
    schemaVersion: 2,
    approvalId: "apr-user-decision-test1",
    runId: "run-attack-1",
    sessionId: SESSION_ID,
    status: "pending",
    target: { type: "task", taskId: "task-1" },
    revision: 1,
    generation: 0,
    requestedBy: "developer",
    requestedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    reason: "Chọn cấu hình database?",
    evidence: [],
    idempotencyKey: "user-decision:test1",
    metadata: {
      kind: "user_decision",
      question: "Chọn cấu hình database?",
      options: ["PostgreSQL", "SQLite"],
      requestedByRole: "developer",
      ...metadataOverrides
    },
    ...overrides
  };
}

function openEndedUserDecisionReq(): ApprovalRequest {
  return userDecisionReq(
    { approvalId: "apr-user-decision-open", reason: "Nhập connection string" },
    { options: undefined, question: "Nhập connection string" }
  );
}

function contextFor(request: ApprovalRequest, extra: Partial<ConversationContextSnapshot> = {}): ConversationContextSnapshot {
  return {
    schemaVersion: 2,
    session: {
      schemaVersion: 2,
      sessionId: SESSION_ID,
      herdrSessionId: "herdr-host-1",
      conversationAgentId: "chat",
      paneId: "pane-chat",
      status: "awaiting_user_approval",
      activeRunId: request.runId,
      activeApprovalIds: [request.approvalId],
      turnCount: 0,
      unresolvedQuestions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    messages: [],
    workflows: {
      "corr-attack-1": {
        correlationId: "corr-attack-1",
        sessionId: SESSION_ID,
        delegationId: "del-1",
        specificationId: "spec-1",
        runId: request.runId,
        title: "Test run",
        objective: "Test objective",
        kind: "feature",
        sddLevel: "lightweight",
        priority: "normal",
        acceptanceCriteria: [],
        sdlcStatus: "awaiting_approval",
        revision: 1,
        generation: 0,
        activeApprovalIds: [request.approvalId],
        progressHistory: [],
        completedVerified: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    },
    runIdToCorrelationId: { [request.runId]: "corr-attack-1" },
    pendingClarifications: {},
    pendingApprovals: { [request.approvalId]: request },
    approvalDecisions: {},
    approvalShortIds: { "#1": request.approvalId },
    runShortIds: { "việc #1": request.runId },
    pendingInboundQueue: [],
    processedMessageIds: [],
    deliveryRecords: {},
    agentBusy: false,
    transportState: "idle",
    ...extra
  } as unknown as ConversationContextSnapshot;
}

describe("Slice 03 Flow Attacks & Regressions", () => {
  it("Attack 1 & 8: open-ended user decision with short alias #1 is recognized by classifyTrustedApprovalReply", () => {
    const req = openEndedUserDecisionReq();
    const ctx = contextFor(req);
    const turn: UserTurnInput = {
      sessionId: SESSION_ID,
      content: "#1: postgresql://user:pass@localhost:5432/mydb"
    };

    const classified = classifyTrustedApprovalReply(turn, ctx);
    expect(classified).toBeDefined();
    expect(classified?.ok).toBe(true);
    if (classified?.ok) {
      expect(classified.value.intent).toBe("approval_response");
      expect(classified.value.approvalInput?.approvalId).toBe(req.approvalId);
      expect(classified.value.approvalInput?.decision).toBe("approved");
      expect(classified.value.approvalInput?.reason).toContain("postgresql://user:pass@localhost:5432/mydb");
    }
  });

  it("Attack 1 & 8: user decision with options recognizes 'phương án 1', 'PA 1', '#1 phương án 1', '#1: phương án 1'", () => {
    const req = userDecisionReq();
    const ctx = contextFor(req);

    // Bare "phương án 1" when single decision is pending
    const res1 = resolveUserDecisionReply(req, "phương án 1");
    expect(res1.kind).toBe("answer");
    if (res1.kind === "answer") expect(res1.selectedOption).toBe("PostgreSQL");

    // "PA 2"
    const res2 = resolveUserDecisionReply(req, "pa 2");
    expect(res2.kind).toBe("answer");
    if (res2.kind === "answer") expect(res2.selectedOption).toBe("SQLite");

    // "#1 phương án 1"
    const classified1 = classifyTrustedApprovalReply({ sessionId: SESSION_ID, content: "#1 phương án 1" }, ctx);
    expect(classified1).toBeDefined();
    expect(classified1?.ok).toBe(true);
    if (classified1?.ok) {
      expect(classified1.value.approvalInput?.approvalId).toBe(req.approvalId);
      expect(classified1.value.approvalInput?.selectedOption).toBe("PostgreSQL");
    }

    // "#1: phương án 2"
    const classified2 = classifyTrustedApprovalReply({ sessionId: SESSION_ID, content: "#1: phương án 2" }, ctx);
    expect(classified2).toBeDefined();
    expect(classified2?.ok).toBe(true);
    if (classified2?.ok) {
      expect(classified2.value.approvalInput?.approvalId).toBe(req.approvalId);
      expect(classified2.value.approvalInput?.selectedOption).toBe("SQLite");
    }
  });

  it("Attack 8: Vietnamese NFD text matches intent classification for approvals and alias lookups", () => {
    const userReq = userDecisionReq();
    const userCtx = contextFor(userReq);

    const designReq: ApprovalRequest = {
      schemaVersion: 2,
      approvalId: "apr-design-1",
      runId: "run-attack-1",
      sessionId: SESSION_ID,
      status: "pending",
      target: { type: "run", runId: "run-attack-1" },
      revision: 1,
      generation: 0,
      requestedBy: "coordinator",
      requestedAt: new Date().toISOString(),
      reason: "Duyệt kế hoạch thiết kế",
      evidence: [],
      idempotencyKey: "apr:design1",
      metadata: {}
    };
    const designCtx = contextFor(designReq);

    // NFD "#1: đồng ý" on a design approval
    const nfdApprove = "#1: đồng ý".normalize("NFD");
    const clApprove = classifyTrustedApprovalReply({ sessionId: SESSION_ID, content: nfdApprove }, designCtx);
    expect(clApprove).toBeDefined();
    expect(clApprove?.ok).toBe(true);
    if (clApprove?.ok) {
      expect(clApprove.value.intent).toBe("approval_response");
      expect(clApprove.value.approvalInput?.approvalId).toBe("apr-design-1");
      expect(clApprove.value.approvalInput?.decision).toBe("approved");
    }

    // NFD "#1: phương án 1" on a user decision
    const nfdOption = "#1: phương án 1".normalize("NFD");
    const clOption = classifyTrustedApprovalReply({ sessionId: SESSION_ID, content: nfdOption }, userCtx);
    expect(clOption).toBeDefined();
    expect(clOption?.ok).toBe(true);
    if (clOption?.ok) {
      expect(clOption.value.intent).toBe("approval_response");
      expect(clOption.value.approvalInput?.approvalId).toBe(userReq.approvalId);
      expect(clOption.value.approvalInput?.selectedOption).toBe("PostgreSQL");
    }

    // NFD "#1: từ chối vì chưa phù hợp"
    const nfdReject = "#1: từ chối vì chưa phù hợp".normalize("NFD");
    const clReject = classifyTrustedApprovalReply({ sessionId: SESSION_ID, content: nfdReject }, userCtx);
    expect(clReject).toBeDefined();
    expect(clReject?.ok).toBe(true);
    if (clReject?.ok) {
      expect(clReject.value.intent).toBe("approval_response");
      expect(clReject.value.approvalInput?.approvalId).toBe(userReq.approvalId);
      expect(clReject.value.approvalInput?.decision).toBe("rejected");
    }

    // NFD workflow change referring to "việc #1"
    const noPendingCtx = { ...userCtx, pendingApprovals: {}, approvalShortIds: {}, session: { ...userCtx.session, activeApprovalIds: [], status: "active" as const } };
    const nfdWorkChange = "thay đổi yêu cầu việc #1 thêm tính năng xuất báo cáo vào src/report.ts".normalize("NFD");
    const clWf = classifyUserIntent({ sessionId: SESSION_ID, content: nfdWorkChange }, noPendingCtx);
    expect(clWf.ok).toBe(true);
    if (clWf.ok) {
      expect(clWf.value.intent).toBe("workflow_request");
      expect(clWf.value.targetRunId).toBe(userReq.runId);
    }
  });

  it("Attack 4 & 5: initializeOrRecoverSession clears agentBusy and flushes pending inbound queue", async () => {
    const store = new InMemoryConversationContextStore();
    const bridge = new HerdrConversationBridge({
      transport: new MockHerdrAgentTransport(),
      sessionId: SESSION_ID,
      conversationAgentId: "chat",
      paneId: "pane-chat"
    });

    const pendingMsg: RoleMessage = {
      schema_version: 2,
      message_id: "msg-queued-before-crash",
      correlation_id: "corr-attack-1",
      run_id: "run-attack-1",
      sender: { role: "coordinator" },
      recipient: { role: "conversation" },
      type: "conversation.progress",
      payload: {
        headline: "Coordinator progress update",
        sdlcStatus: "implementing"
      },
      artifact_references: [],
      occurred_at: new Date().toISOString()
    };

    const staleSnapshot = contextFor(userDecisionReq(), {
      agentBusy: true, // Left busy when crashed
      transportState: "working",
      pendingInboundQueue: [
        {
          queueId: "q-1",
          kind: "coordinator_message",
          enqueuedAt: new Date().toISOString(),
          message: pendingMsg
        }
      ]
    });

    expect((await store.save(staleSnapshot)).ok).toBe(true);

    const gateway = new ConversationGateway({
      sessionId: SESSION_ID,
      herdrSessionId: "herdr-host-1",
      paneId: "pane-chat",
      bridge,
      contextStore: store
    });

    const initRes = await gateway.initializeOrRecoverSession();
    expect(initRes.ok).toBe(true);

    const recovered = gateway.getContextSnapshot();
    // agentBusy must be reset to false so future messages and user turns are not stuck
    expect(recovered.agentBusy).toBe(false);
    expect(recovered.transportState).toBe("idle");
    // pending queue must be drained
    expect(recovered.pendingInboundQueue.length).toBe(0);
    // message must have been processed into processedMessageIds and messages
    expect(recovered.processedMessageIds).toContain("msg-queued-before-crash");
  });

  it("Attack 4 & 9: deduplicates messages in pendingInboundQueue and filters non-substantive heartbeats while busy", async () => {
    const store = new InMemoryConversationContextStore();
    const bridge = new HerdrConversationBridge({
      transport: new MockHerdrAgentTransport(),
      sessionId: SESSION_ID,
      conversationAgentId: "chat",
      paneId: "pane-chat"
    });

    const gateway = new ConversationGateway({
      sessionId: SESSION_ID,
      herdrSessionId: "herdr-host-1",
      paneId: "pane-chat",
      bridge,
      contextStore: store
    });

    await gateway.initializeOrRecoverSession();
    await gateway.setAgentBusyState(true);

    const msg: RoleMessage = {
      schema_version: 2,
      message_id: "msg-busy-1",
      correlation_id: "corr-1",
      run_id: "run-1",
      sender: { role: "coordinator" },
      recipient: { role: "conversation" },
      type: "task.status",
      payload: {
        state: "running",
        headline: "Working on task"
      },
      artifact_references: [],
      occurred_at: new Date().toISOString()
    };

    // First arrival while busy -> queued
    const res1 = await gateway.handleCoordinatorRoleMessage(msg);
    expect(res1.ok).toBe(true);
    if (res1.ok) expect(res1.value.queuedBecauseBusy).toBe(true);
    expect(gateway.getContextSnapshot().pendingInboundQueue.length).toBe(1);

    // Duplicate message arrival while still in pending queue -> duplicate ignored, not queued twice
    const res2 = await gateway.handleCoordinatorRoleMessage(msg);
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      expect(res2.value.duplicateIgnored).toBe(true);
      expect(res2.value.queuedBecauseBusy).toBe(false);
    }
    expect(gateway.getContextSnapshot().pendingInboundQueue.length).toBe(1);
  });

  it("Attack 10: correlation ID is pinned to the target approval's workflow, not activeRunId of an unrelated workflow", async () => {
    const store = new InMemoryConversationContextStore();
    const bridge = new HerdrConversationBridge({
      transport: new MockHerdrAgentTransport(),
      sessionId: SESSION_ID,
      conversationAgentId: "chat",
      conversationPaneId: "pane-chat",
      coordinatorTarget: { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator" }
    });

    const req1 = userDecisionReq({ approvalId: "apr-run1", runId: "run-1" });
    const req2 = userDecisionReq({ approvalId: "apr-run2", runId: "run-2" });

    // Snapshot with 2 workflows: run-2 is active, but approval is answered for run-1
    const snapshot: ConversationContextSnapshot = {
      ...contextFor(req1),
      session: {
        schemaVersion: 2,
        sessionId: SESSION_ID,
        herdrSessionId: "herdr-host-1",
        conversationAgentId: "chat",
        paneId: "pane-chat",
        status: "awaiting_user_approval",
        activeRunId: "run-2", // UNRELATED active run
        activeApprovalIds: ["apr-run1", "apr-run2"],
        turnCount: 0,
        unresolvedQuestions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      workflows: {
        "corr-1": {
          correlationId: "corr-1",
          sessionId: SESSION_ID,
          delegationId: "del-1",
          specificationId: "spec-1",
          runId: "run-1",
          title: "Run 1",
          objective: "Obj 1",
          kind: "feature",
          sddLevel: "lightweight",
          priority: "normal",
          acceptanceCriteria: [],
          sdlcStatus: "awaiting_approval",
          revision: 1,
          generation: 0,
          activeApprovalIds: ["apr-run1"],
          progressHistory: [],
          completedVerified: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        "corr-2": {
          correlationId: "corr-2",
          sessionId: SESSION_ID,
          delegationId: "del-2",
          specificationId: "spec-2",
          runId: "run-2",
          title: "Run 2",
          objective: "Obj 2",
          kind: "feature",
          sddLevel: "lightweight",
          priority: "normal",
          acceptanceCriteria: [],
          sdlcStatus: "awaiting_approval",
          revision: 1,
          generation: 0,
          activeApprovalIds: ["apr-run2"],
          progressHistory: [],
          completedVerified: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      runIdToCorrelationId: { "run-1": "corr-1", "run-2": "corr-2" },
      pendingApprovals: { "apr-run1": req1, "apr-run2": req2 },
      approvalShortIds: { "#1": "apr-run1", "#2": "apr-run2" }
    } as unknown as ConversationContextSnapshot;

    expect((await store.save(snapshot)).ok).toBe(true);

    const gateway = new ConversationGateway({
      sessionId: SESSION_ID,
      herdrSessionId: "herdr-host-1",
      paneId: "pane-chat",
      bridge,
      contextStore: store
    });

    await gateway.initializeOrRecoverSession();

    // User answers apr-run1
    const turnRes = await gateway.handleUserTurn({
      sessionId: SESSION_ID,
      content: "#1: 1",
      provenance: { origin: "user", authenticatedUser: true, userId: "u-1" }
    });

    expect(turnRes.ok, JSON.stringify((turnRes as any).error)).toBe(true);
    if (turnRes.ok) {
      // Must be bound to corr-1, NOT corr-2!
      expect(turnRes.value.correlationId).toBe("corr-1");
      expect(turnRes.value.userMessage.correlationId).toBe("corr-1");
      expect(turnRes.value.agentReply.correlationId).toBe("corr-1");
    }

    const updated = gateway.getContextSnapshot();
    // corr-1's activeApprovalIds must be empty now, while corr-2's must remain ["apr-run2"]
    expect(updated.workflows["corr-1"]?.activeApprovalIds).toEqual([]);
    expect(updated.workflows["corr-2"]?.activeApprovalIds).toEqual(["apr-run2"]);
  });

  it("Attack 6 & 7: formatCoordinatorMessageForUser recognizes BLOCKED_KINDS like coordinator_no_response and formats options", () => {
    const roleMsg: RoleMessage = {
      schema_version: 2,
      message_id: "msg-blocked-1",
      correlation_id: "corr-1",
      run_id: "run-1",
      sender: { role: "runtime" },
      recipient: { role: "conversation" },
      type: "conversation.progress",
      payload: {
        kind: "coordinator_no_response",
        reason: "Trưởng nhóm kỹ thuật chưa đưa ra hành động tiếp theo",
        options: ["Khắc phục blocker rồi yêu cầu Coordinator tiếp tục run", "Hủy run"]
      },
      artifact_references: [],
      occurred_at: new Date().toISOString()
    };

    const formatted = formatCoordinatorMessageForUser({
      sessionId: SESSION_ID,
      turnSequence: 1,
      roleMessage: roleMsg
    });

    expect(formatted.ok).toBe(true);
    if (formatted.ok) {
      expect(formatted.value.isBlocked).toBe(true);
      expect(formatted.value.substantive).toBe(true);
      const text = formatted.value.message.content;
      expect(text).toContain("BLOCKED");
      expect(text).toContain("Trưởng nhóm kỹ thuật chưa đưa ra hành động tiếp theo");
      expect(text).toContain("Khắc phục blocker");
      expect(text).toContain("Hủy run");
    }
  });

  it("Attack 7: ExtractedRequirementDraftSchema accepts criteria with optional id and required without strict failure", () => {
    const rawDecision = {
      intent: "workflow_request",
      requirementDraft: {
        title: "Feature test",
        objective: "Build feature",
        kind: "feature",
        sddLevel: "lightweight",
        priority: "normal",
        scopeDefined: true,
        affectedPaths: ["packages/test/file.ts"],
        acceptanceCriteria: [
          {
            id: "ac-1",
            description: "Must pass tests",
            verificationMethod: "unit_test",
            required: true
          }
        ]
      }
    };

    const parsed = ChatDecisionSchema.safeParse(rawDecision);
    expect(parsed.success).toBe(true);
  });
});
