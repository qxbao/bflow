import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const fsyncEinvalTargets = new Set<string>();
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (fsyncEinvalTargets.has(String(args[0]))) {
        return new Proxy(handle, {
          get(target, prop, receiver) {
            if (prop === "sync") {
              return async () => {
                throw Object.assign(new Error("EINVAL: invalid argument, fsync"), { code: "EINVAL" });
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
      return handle;
    }) as typeof actual.open
  };
});
import {
  ChatDecisionSchema,
  ConversationGateway,
  FileConversationContextStore,
  HerdrConversationBridge,
  InMemoryConversationContextStore,
  MockHerdrAgentTransport,
  classifyTrustedApprovalReply,
  explainUnrecordedApprovalReply,
  resolveChatDecision,
  resolveDraftCriteria,
  type ConversationContextSnapshot,
  type ConversationContextStore
} from "../src/index.js";

const tempDirs: string[] = [];
afterEach(async () => {
  fsyncEinvalTargets.clear();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function setup(customStore?: ConversationContextStore) {
  const store = customStore ?? new InMemoryConversationContextStore();
  const transport = new MockHerdrAgentTransport();
  const bridge = new HerdrConversationBridge({
    transport,
    sessionId: "session-chat",
    conversationAgentId: "chat",
    conversationPaneId: "pane-chat",
    coordinatorTarget: { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator" }
  });
  const gateway = new ConversationGateway({
    sessionId: "session-chat",
    herdrSessionId: "herdr-chat",
    paneId: "pane-chat",
    contextStore: store,
    bridge
  });
  await gateway.initializeOrRecoverSession();
  let seq = 0;
  const turn = (content: string, conversationDecision?: unknown, extra: Record<string, unknown> = {}) =>
    gateway.handleUserTurn({
      sessionId: "session-chat",
      messageId: `human-${++seq}`,
      content,
      provenance: { origin: "user", authenticatedUser: true },
      ...(conversationDecision !== undefined ? { conversationDecision } : {}),
      ...extra
    } as Parameters<typeof gateway.handleUserTurn>[0]);
  return { gateway, transport, store, turn };
}

const featureDraft = (title: string, objective: string) => ({
  title,
  objective,
  kind: "feature" as const,
  sddLevel: "lightweight" as const,
  priority: "normal" as const,
  scopeDefined: true,
  isLargeTask: false,
  affectedPaths: [],
  acceptanceCriteriaDescriptions: [`Hoàn thành ${title}`],
  isRequirementChange: false
});

describe("Slice 4 — Conversation Gateway adversarial hardening", () => {
  it("resolves Vietnamese work aliases (`Việc #k` / `việc #k`) across requirement changes, cancellations, and status queries while rejecting duplicate alias+runId targets", async () => {
    const { gateway, turn, transport } = await setup();
    const r1 = await turn("Tạo việc 1", {
      intent: "workflow_request",
      requirementDraft: featureDraft("Việc đầu tiên", "Làm việc 1")
    });
    const r2 = await turn("Tạo việc 2", {
      intent: "workflow_request",
      requirementDraft: featureDraft("Việc thứ hai", "Làm việc 2")
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok || !r1.value.runId || !r2.value.runId) return;

    gateway.syncNoticeAliases({
      approvalShortIds: { "#1": "apr-other" },
      runShortIds: { "việc #1": r1.value.runId, "việc #2": r2.value.runId }
    });

    // 1. Status query by `Việc #1`
    const statusRes = await turn("Xem tiến độ Việc #1", {
      intent: "status_query",
      targetRunId: "Việc #1"
    });
    expect(statusRes.ok).toBe(true);
    if (statusRes.ok) {
      expect(statusRes.value.correlationId).toBe(r1.value.correlationId);
    }

    // 2. Requirement change by `Việc #2: Việc thứ hai`
    const changeRes = await turn("Đổi yêu cầu Việc #2", {
      intent: "workflow_request",
      targetRunId: "Việc #2: Việc thứ hai",
      requirementDraft: {
        ...featureDraft("Việc thứ hai cập nhật", "Làm việc 2 mở rộng"),
        isRequirementChange: true
      }
    });
    expect(changeRes.ok).toBe(true);
    if (changeRes.ok) {
      expect(changeRes.value.runId).toBe(r2.value.runId);
      expect(changeRes.value.delegationRequest?.metadata?.revision).toBe(2);
    }

    // 3. Duplicate resolved runIds (`["Việc #1", run1Id]`) must be rejected
    const dupCancel = resolveChatDecision(
      ChatDecisionSchema.parse({
        intent: "cancellation_request",
        cancellationInput: { runIds: ["Việc #1", r1.value.runId], reason: "Hủy trùng" }
      }),
      gateway.getContextSnapshot()
    );
    expect(dupCancel.ok).toBe(false);

    // 4. Bare `#1` must NEVER resolve as `việc #1` run alias
    const bareCardAlias = resolveChatDecision(
      ChatDecisionSchema.parse({
        intent: "cancellation_request",
        cancellationInput: { runId: "#1", reason: "Nhầm mã thẻ" }
      }),
      gateway.getContextSnapshot()
    );
    expect(bareCardAlias.ok).toBe(false);

    // 5. Cancellation by `việc #1`
    const beforeSent = transport.sentRoleMessages.length;
    const cancelRes = await turn("Hủy việc #1", {
      intent: "cancellation_request",
      cancellationInput: { runId: "việc #1", reason: "Không cần việc 1 nữa" }
    });
    expect(cancelRes.ok).toBe(true);
    if (cancelRes.ok) {
      expect(cancelRes.value.runId).toBe(r1.value.runId);
    }
    expect(transport.sentRoleMessages.length).toBe(beforeSent + 1);
  });

  it("supports clarifying an active workflow change (`Việc #1`) and closing that pending clarification when the requirement change is confirmed", async () => {
    const { gateway, turn } = await setup();
    const created = await turn("Tạo module báo cáo", {
      intent: "workflow_request",
      requirementDraft: featureDraft("Module báo cáo", "Xuất CSV")
    });
    expect(created.ok).toBe(true);
    if (!created.ok || !created.value.runId) return;
    const runId = created.value.runId;
    gateway.syncNoticeAliases({ runShortIds: { "việc #1": runId } });

    // Chat clarifies a proposed requirement change against Việc #1
    const clarifyTurn = await turn("Tôi muốn đổi định dạng báo cáo của Việc #1", {
      intent: "clarify",
      targetRunId: "Việc #1",
      targetCorrelationId: created.value.correlationId,
      clarifyingQuestions: [
        "1. Xuất thêm PDF bên cạnh CSV hay thay thế hẳn CSV?",
        "2. Có giới hạn kích thước file xuất không?",
        "3. Có cần ký số file PDF không?",
        "4. Giữ nguyên quyền truy cập hiện tại?"
      ],
      requirementDraft: {
        title: "Module báo cáo",
        objective: "Đổi định dạng xuất báo cáo",
        kind: "feature",
        sddLevel: "lightweight"
      }
    });
    expect(clarifyTurn.ok).toBe(true);
    if (!clarifyTurn.ok) return;
    const clarifyCorrelationId = clarifyTurn.value.correlationId;
    expect(clarifyCorrelationId).not.toBe(created.value.correlationId);
    expect(gateway.getContextSnapshot().workflows[created.value.correlationId]?.runId).toBe(runId);
    expect(gateway.getContextSnapshot().pendingClarifications[clarifyCorrelationId]).toBeDefined();

    // User answers; Chat submits requirement change referencing both clarifyCorrelationId and Việc #1
    const confirmed = await turn("Thay hẳn bằng PDF, tối đa 10MB, không ký số, giữ quyền hiện tại", {
      intent: "workflow_request",
      targetCorrelationId: clarifyCorrelationId,
      targetRunId: "Việc #1",
      requirementDraft: {
        ...featureDraft("Module báo cáo PDF", "Xuất PDF tối đa 10MB"),
        isRequirementChange: true
      }
    });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.value.runId).toBe(runId);
      expect(confirmed.value.correlationId).toBe(created.value.correlationId);
      expect(confirmed.value.delegationRequest?.metadata?.revision).toBe(2);
    }
    expect(gateway.getContextSnapshot().pendingClarifications).toEqual({});
    expect(gateway.getContextSnapshot().session.unresolvedQuestions).toEqual([]);
  });

  it("tolerates LLM null optional fields and empty/redundant acceptanceCriteria while still rejecting conflicting criteria", () => {
    const parsed = ChatDecisionSchema.parse({
      intent: "workflow_request",
      targetCorrelationId: null,
      targetRunId: null,
      requirementDraft: {
        title: "Sửa lỗi cache",
        objective: "Xóa cache cũ khi logout",
        kind: "bugfix",
        sddLevel: "lightweight",
        scopeDefined: true,
        acceptanceCriteria: [],
        acceptanceCriteriaDescriptions: ["Cache người dùng bị xóa ngay khi logout"],
        verificationMethods: null,
        codeChangesAuthorized: null,
        targetRunId: null,
        targetCorrelationId: null,
        investigationTasks: null
      }
    });
    expect(parsed.intent).toBe("workflow_request");
    if (parsed.intent !== "workflow_request") return;
    const emptyObjectsResolved = resolveDraftCriteria(parsed.requirementDraft);
    expect(emptyObjectsResolved).toEqual({
      ok: true,
      value: [{ description: "Cache người dùng bị xóa ngay khi logout", verificationMethod: undefined }]
    });

    // Identical echoed descriptions + acceptanceCriteria succeed
    const echoed = ChatDecisionSchema.parse({
      intent: "workflow_request",
      requirementDraft: {
        title: "Sửa lỗi cache",
        objective: "Xóa cache cũ khi logout",
        kind: "bugfix",
        sddLevel: "lightweight",
        scopeDefined: true,
        acceptanceCriteria: [{ description: "Cache bị xóa", verificationMethod: "unit_test" }],
        acceptanceCriteriaDescriptions: ["Cache bị xóa"],
        verificationMethods: ["unit_test"]
      }
    });
    if (echoed.intent !== "workflow_request") return;
    expect(resolveDraftCriteria(echoed.requirementDraft)).toEqual({
      ok: true,
      value: [{ description: "Cache bị xóa", verificationMethod: "unit_test" }]
    });

    // Conflicting descriptions + acceptanceCriteria still fail closed
    const conflicting = ChatDecisionSchema.parse({
      intent: "workflow_request",
      requirementDraft: {
        title: "Sửa lỗi cache",
        objective: "Xóa cache cũ khi logout",
        kind: "bugfix",
        sddLevel: "lightweight",
        scopeDefined: true,
        acceptanceCriteria: [{ description: "Cache bị xóa", verificationMethod: "unit_test" }],
        acceptanceCriteriaDescriptions: ["Tiêu chí khác hẳn"]
      }
    });
    if (conflicting.intent !== "workflow_request") return;
    expect(resolveDraftCriteria(conflicting.requirementDraft).ok).toBe(false);
  });

  it("cancels open pending clarifications cleanly on `scope: session_existing` even before any run is delegated, and rejects empty-session cancel", async () => {
    const { gateway, turn, transport } = await setup();

    // Empty session with neither runs nor clarifications -> rejected cleanly
    const emptyCancel = await turn("Hủy hết", {
      intent: "cancellation_request",
      cancellationInput: { scope: "session_existing", reason: "Chưa có gì" }
    });
    expect(emptyCancel.ok).toBe(false);

    // Open a pending clarification with 0 runs
    const clarified = await turn("Làm tính năng thanh toán", {
      intent: "clarify",
      clarifyingQuestions: ["Dùng cổng thanh toán nào?"]
    });
    expect(clarified.ok).toBe(true);
    expect(Object.keys(gateway.getContextSnapshot().pendingClarifications)).toHaveLength(1);

    // Cancel session_existing -> closes pending clarification without bogus "0/0 run đã vào hàng đợi Runtime"
    const cancelledIntake = await turn("Thôi hủy yêu cầu vừa rồi", {
      intent: "cancellation_request",
      cancellationInput: { scope: "session_existing", reason: "Đổi ý" }
    });
    expect(cancelledIntake.ok).toBe(true);
    if (cancelledIntake.ok) {
      expect(cancelledIntake.value.agentReply.content).not.toContain("0/0 run");
      expect(cancelledIntake.value.sessionStatus).toBe("active");
    }
    expect(gateway.getContextSnapshot().pendingClarifications).toEqual({});
    expect(gateway.getContextSnapshot().session.unresolvedQuestions).toEqual([]);
    expect(transport.sentRoleMessages).toHaveLength(0);
  });

  it("parses `#n <optionLabel>` / `#n - ...` short replies and warns when a user sends an out-of-range option or bare `#n`", async () => {
    const { gateway } = await setup();
    const corr1 = "corr-1";
    const corr2 = "corr-2";
    await gateway.handleCoordinatorRoleMessage({
      schema_version: 2,
      message_id: "m-apr-1",
      correlation_id: corr1,
      run_id: "run-1",
      sender: { role: "runtime" },
      recipient: { role: "conversation" },
      type: "approval.request",
      payload: {
        schemaVersion: 2,
        approvalId: "design-apr-1",
        runId: "run-1",
        sessionId: "session-chat",
        status: "pending",
        target: { type: "run" },
        revision: 1,
        generation: 0,
        requestedBy: "coordinator",
        requestedAt: new Date().toISOString(),
        reason: "Duyệt thiết kế?",
        evidence: [],
        idempotencyKey: "k-1"
      },
      artifact_references: []
    });
    await gateway.handleCoordinatorRoleMessage({
      schema_version: 2,
      message_id: "m-apr-2",
      correlation_id: corr2,
      run_id: "run-2",
      sender: { role: "runtime" },
      recipient: { role: "conversation" },
      type: "approval.request",
      payload: {
        schemaVersion: 2,
        approvalId: "apr-choice-2",
        runId: "run-2",
        sessionId: "session-chat",
        status: "pending",
        target: { type: "run" },
        revision: 1,
        generation: 0,
        requestedBy: "architect",
        requestedAt: new Date().toISOString(),
        reason: "Chọn cơ sở dữ liệu?",
        evidence: [],
        idempotencyKey: "k-2",
        metadata: {
          kind: "user_decision",
          question: "Chọn cơ sở dữ liệu?",
          options: ["SQLite", "PostgreSQL"]
        }
      },
      artifact_references: []
    });
    gateway.syncNoticeAliases({
      approvalShortIds: { "#1": "design-apr-1", "#2": "apr-choice-2" }
    });
    const snapshot = gateway.getContextSnapshot();

    // `#2 SQLite` (space + exact option label, no colon)
    const optionBySpace = classifyTrustedApprovalReply(
      { sessionId: "session-chat", content: "#2 SQLite", provenance: { origin: "user", authenticatedUser: true } },
      snapshot
    );
    expect(optionBySpace?.ok && optionBySpace.value.approvalInput).toMatchObject({
      approvalId: "apr-choice-2",
      decision: "approved",
      selectedOption: "SQLite"
    });

    // `#1 - đồng ý`
    const dashApprove = classifyTrustedApprovalReply(
      { sessionId: "session-chat", content: "#1 - đồng ý", provenance: { origin: "user", authenticatedUser: true } },
      snapshot
    );
    expect(dashApprove?.ok && dashApprove.value.approvalInput).toMatchObject({
      approvalId: "design-apr-1",
      decision: "approved"
    });

    // Out-of-range option `#2: 9` produces an explicit unrecorded-reply warning
    const outOfRangeWarning = explainUnrecordedApprovalReply(
      { sessionId: "session-chat", content: "#2: 9", provenance: { origin: "user", authenticatedUser: true } },
      snapshot
    );
    expect(outOfRangeWarning).toBeDefined();
    expect(outOfRangeWarning).toContain("CHƯA");

    // Bare `#2` without any choice produces an explicit unrecorded-reply warning
    const bareIdWarning = explainUnrecordedApprovalReply(
      { sessionId: "session-chat", content: "#2", provenance: { origin: "user", authenticatedUser: true } },
      snapshot
    );
    expect(bareIdWarning).toBeDefined();
    expect(bareIdWarning).toContain("CHƯA");
  });

  it("preserves monotonic short aliases across concurrent saves and handles FUSE/NTFS directory fsync EINVAL in FileConversationContextStore", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slice4-conv-store-"));
    tempDirs.push(dir);
    fsyncEinvalTargets.add(dir);

    const fileStore = new FileConversationContextStore(dir);
    let releaseFirstSave!: () => void;
    let interceptFirst = true;
    const wrappedStore: ConversationContextStore = {
      load: sessionId => fileStore.load(sessionId),
      delete: sessionId => fileStore.delete(sessionId),
      async save(snapshot: ConversationContextSnapshot) {
        if (interceptFirst && snapshot.messages.length >= 2) {
          interceptFirst = false;
          await new Promise<void>(resolve => {
            releaseFirstSave = resolve;
          });
        }
        return fileStore.save(snapshot);
      }
    };

    const { gateway, turn } = await setup(wrappedStore);
    const pendingTurn = turn("Xin chào", { intent: "conversation_only", directReply: "Chào bạn!" });
    await vi.waitFor(() => expect(releaseFirstSave).toBeTypeOf("function"));

    // While save #1 is in flight, host syncs new short aliases
    gateway.syncNoticeAliases({
      approvalShortIds: { "#1": "apr-concurrent-1" },
      runShortIds: { "việc #1": "run-concurrent-1" }
    });
    releaseFirstSave();
    const res = await pendingTurn;
    expect(res.ok).toBe(true);

    // Aliases synced during in-flight save must NOT be wiped out
    expect(gateway.getContextSnapshot().approvalShortIds).toEqual({ "#1": "apr-concurrent-1" });
    expect(gateway.getContextSnapshot().runShortIds).toEqual({ "việc #1": "run-concurrent-1" });

    // Concurrent FileConversationContextStore saves serialize cleanly without corruption
    const snap = gateway.getContextSnapshot();
    const [s1, s2] = await Promise.all([
      fileStore.save({ ...snap, approvalShortIds: { "#1": "apr-concurrent-1", "#2": "apr-2" } }),
      fileStore.save({ ...snap, approvalShortIds: { "#1": "apr-concurrent-1", "#2": "apr-2", "#3": "apr-3" } })
    ]);
    expect(s1.ok && s2.ok).toBe(true);
    const loaded = await fileStore.load("session-chat");
    expect(loaded.ok && loaded.value?.approvalShortIds).toEqual({
      "#1": "apr-concurrent-1",
      "#2": "apr-2",
      "#3": "apr-3"
    });
  });
});
