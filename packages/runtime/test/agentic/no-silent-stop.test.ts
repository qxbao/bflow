import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaneBindingSchema, RoleMessageSchema, type PaneBinding, type RoleMessage } from "@bflow/contracts";
import { HostReceiptJournal, deliveryFailureNotice, isCoordinatorTrigger } from "../../src/agentic/host-receipts.js";
import { isUserFacingNotice, renderConversationNotice, mustShowSection, type NoticeLike } from "../../src/agentic/conversation-notice-render.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanups.splice(0).reverse()) await action(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-no-silent-stop-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const journal = new HostReceiptJournal(join(root, "receipts"), root, "herdr-session");
  const at = new Date().toISOString();
  const binding = (role: PaneBinding["role"], paneId: string) => PaneBindingSchema.parse({ schemaVersion: 2, bindingId: `${role}-binding`, sessionId: "herdr-session",
    role, agentId: role, paneId, workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude", cwd: root, isolationMode: "dedicated_pane",
    readOnlyWorkspace: role === "conversation", permanent: true, transportState: "idle", boundAt: at,
    session: { source: "herdr:claude", kind: "id", value: `native-${role}` } });
  return { journal, binding, at };
}
const participant = (role: string) => ({ role, agent_id: role, pane_id: `pane-${role}` });
const message = (overrides: Record<string, unknown>): RoleMessage => RoleMessageSchema.parse({ schema_version: 2, message_id: "m-1", correlation_id: "c-1",
  run_id: "run-1", sender: participant("developer"), recipient: participant("coordinator"), type: "task.status", payload: {}, artifact_references: [],
  idempotency_key: "k-1", ...overrides });
const notice = (overrides: Partial<NoticeLike> & { messageId: string }): NoticeLike => ({ senderRole: "coordinator", runId: "run-1", ...overrides });

describe("renderer: design and task approvals carry full content", () => {
  const evidence = [{ kind: "specification", uri: "artifact://store/spec-1" }, { kind: "patch", uri: "artifact://store/patch-1" }];
  const payload = { approvalId: "design-abc", runId: "run-1", target: { type: "run" }, revision: 1, generation: 0, requestedBy: "coordinator",
    requestedAt: "2026-10-20T01:00:00.000Z", reason: "Human design approval required before implementation", evidence, expiresAt: "2026-10-21T01:00:00.000Z",
    idempotencyKey: "design:run-1", metadata: { bundleFingerprint: "x" } };
  it("renders target, reason, requester, evidence, deadline and numbered approve/reject actions", () => {
    const rendered = renderConversationNotice(notice({ messageId: "p19-1", type: "approval.request", summary: JSON.stringify(payload), truncated: false, shortId: "#1" }));
    expect(rendered).toMatchObject({ kind: "approval", approvalId: "design-abc", ackToken: "#1", runId: "run-1" });
    expect(rendered.display).toContain("🔔 Cần bạn duyệt · #1");
    expect(rendered.display).toContain("Cần bạn duyệt: Human design approval required before implementation (do Trưởng nhóm kỹ thuật gửi)");
    expect(rendered.display).toContain('Kèm 2 tài liệu (gõ "xem chi tiết #1" để xem)');
    expect(rendered.display).toContain("1. Đồng ý\n  2. Chưa đồng ý (ghi lý do)");
    expect(rendered.display).toContain('Bạn trả lời: "#1: đồng ý"');
    expect(isUserFacingNotice(rendered)).toBe(true);
  });
  it("uses the bounded structured fields when the raw summary was truncated", () => {
    const rendered = renderConversationNotice(notice({ messageId: "p19-2", type: "approval.request", summary: "{\"approvalId\"", truncated: true, shortId: "#1",
      approval: { approvalId: "design-abc", target: "run", reason: "Human design approval required", requestedBy: "coordinator", evidence: evidence.slice(0, 1), evidenceCount: 12 } }));
    expect(rendered).toMatchObject({ kind: "approval", ackToken: "#1" });
    expect(rendered.display).toContain("Cần bạn duyệt: Human design approval required (do Trưởng nhóm kỹ thuật gửi)");
    expect(rendered.display).toContain("Kèm 12 tài liệu");
    expect(rendered.display).not.toContain("bị cắt ngắn");
  });
  it("stores structured approval fields with the receipt so truncation cannot hide the approval", async () => {
    const f = await fixture();
    const big = { ...payload, evidence: Array.from({ length: 200 }, (_, index) => ({ kind: "patch", uri: `artifact://store/patch-${index}-${"x".repeat(60)}` })) };
    await f.journal.appendConversationNotice(message({ message_id: "p19-big", type: "approval.request", sender: participant("coordinator"),
      recipient: participant("conversation"), payload: big, idempotency_key: "approval-big" }));
    const [stored] = await f.journal.unsurfacedConversationNotices();
    expect(stored!.truncated).toBe(true);
    expect(renderConversationNotice(stored!)).toMatchObject({ kind: "approval", ackToken: "#1" });
    expect(renderConversationNotice(stored!).display).toContain("Kèm 200 tài liệu");
    await f.journal.markConversationNoticesSurfaced(["p19-big"]);
    expect((await f.journal.undisplayedUserFacingNotices()).map(item => item.messageId)).toEqual(["p19-big"]);
    await f.journal.markConversationNoticesDisplayed(["p19-big"]);
    expect(await f.journal.undisplayedUserFacingNotices()).toEqual([]);
  });
});

describe("renderer: stuck states are blocked notices with their reason", () => {
  it.each([
    ["delivery_failure", { kind: "delivery_failure", headline: "Herdr delivery failed: patch", blockageReason: "patch to developer (m-9): transport failed. The run is waiting." }],
    ["coordinator_no_response", { kind: "coordinator_no_response", reason: "Coordinator không phản hồi", options: ["Yêu cầu Coordinator tiếp tục", "Hủy run"] }],
    ["developer_no_response", { kind: "developer_no_response", reason: "developer ended its turn", options: ["Giao lại việc"] }],
    ["verification_stuck", { kind: "verification_stuck", reason: "Verification waits", options: ["Thử lại"] }]
  ])("%s renders as blocked with reason and acknowledges by message id", (_name, payload) => {
    // A notice without a stored alias is acknowledged by its exact message id, never a guessed #1.
    const rendered = renderConversationNotice(notice({ messageId: "n-1", type: "conversation.progress", summary: JSON.stringify(payload) }));
    expect(rendered).toMatchObject({ kind: "blocked", ackToken: "n-1" });
    expect(isUserFacingNotice(rendered)).toBe(true);
    expect(rendered.display).toContain("Chuyện gì xảy ra:");
    expect(rendered.display).toContain("Ảnh hưởng:");
    expect(rendered.display).toContain("Bạn cần làm gì:");
  });
  it("shows a Runtime progress blockage instead of only the type and sender", () => {
    const rendered = renderConversationNotice(notice({ messageId: "n-2", type: "conversation.progress",
      summary: JSON.stringify({ sdlcStatus: "implementing", headline: "Run is implementing", blockageReason: "Developer is blocked on the lock" }) }));
    expect(rendered.kind).toBe("update");
    expect(rendered.display).toContain("Lập trình viên is blocked on the lock");
    expect(renderConversationNotice(notice({ messageId: "n-3", type: "conversation.progress", summary: JSON.stringify({ headline: "Planning" }) })).display).toContain("Planning");
  });
  it("puts blocked and approval notices before plain updates in the MUST SHOW block", () => {
    const section = mustShowSection([notice({ messageId: "u", type: "conversation.progress", summary: "{}" }),
      notice({ messageId: "b", type: "conversation.progress", summary: JSON.stringify({ kind: "coordinator_no_response", reason: "stuck" }) })]);
    expect(section.indexOf("stuck")).toBeLessThan(section.indexOf("Đã nhận cập nhật tiến độ"));
  });
});

describe("receipts: specialist Stop, Coordinator wake turns and uncertain native deliveries", () => {
  it("records every specialist Stop durably until Runtime settles it", async () => {
    const f = await fixture();
    const id = await f.journal.recordSpecialistStop(f.binding("developer", "pane-developer"));
    expect(await f.journal.pendingSpecialistStops()).toMatchObject([{ stopId: id, binding: { role: "developer", paneId: "pane-developer" } }]);
    await f.journal.completeSpecialistStop(id);
    expect(await f.journal.pendingSpecialistStops()).toEqual([]);
  });
  it("refuses to record a Conversation or Coordinator stop as a specialist stop", async () => {
    const f = await fixture();
    await expect(f.journal.recordSpecialistStop(f.binding("coordinator", "pane-coordinator"))).rejects.toThrow("Invalid specialist turn stop");
    await expect(f.journal.recordSpecialistStop(f.binding("conversation", "pane-chat"))).rejects.toThrow("Invalid specialist turn stop");
  });
  it("tracks Runtime wake-up turns of the Coordinator, not arbitrary Runtime status", async () => {
    expect(isCoordinatorTrigger(message({ sender: participant("runtime"), type: "task.status", payload: { kind: "specialist_result_ready" } }))).toBe(true);
    expect(isCoordinatorTrigger(message({ sender: participant("runtime"), type: "task.status", payload: { kind: "specialist_no_response" } }))).toBe(true);
    expect(isCoordinatorTrigger(message({ sender: participant("runtime"), type: "task.status", payload: { kind: "progress" } }))).toBe(false);
    expect(isCoordinatorTrigger(message({ sender: participant("developer"), type: "task.status", payload: { kind: "specialist_result_ready" } }))).toBe(false);
    const f = await fixture();
    const wake = message({ message_id: "p19-wake-1", sender: participant("runtime"), recipient: participant("coordinator"), type: "task.status",
      payload: { kind: "specialist_result_ready", fromRole: "architect" } });
    await expect(f.journal.startCoordinatorTurn(f.binding("coordinator", "pane-coordinator"), wake)).resolves.toBeUndefined();
    await expect(f.journal.startCoordinatorTurn(f.binding("coordinator", "pane-coordinator"),
      message({ sender: participant("runtime"), recipient: participant("coordinator"), type: "task.status", payload: { kind: "progress" } }))).rejects.toThrow("Invalid Coordinator turn observation");
  });
  it("settles a Coordinator wake-up turn that Stopped without a response, exactly once", async () => {
    const f = await fixture();
    const coordinator = f.binding("coordinator", "pane-coordinator");
    const wake = message({ message_id: "p19-wake-2", sender: participant("runtime"), recipient: participant("coordinator"), type: "task.status",
      payload: { kind: "specialist_no_response", fromRole: "architect" } });
    await f.journal.startCoordinatorTurn(coordinator, wake);
    expect(await f.journal.stopCoordinatorTurn(coordinator)).toBe(true);
    const [pending] = await f.journal.pendingCoordinatorStops();
    expect(pending).toMatchObject({ binding: { paneId: "pane-coordinator" }, message: { message_id: "p19-wake-2" } });
    expect(await f.journal.hasCoordinatorResponse(pending!)).toBe(false);
    await f.journal.completeCoordinatorStop(pending!);
    expect(await f.journal.pendingCoordinatorStops()).toEqual([]);
  });
  it("lists native deliveries without an acknowledgement and drops them once acknowledged", async () => {
    const f = await fixture();
    const intent = message({ message_id: "m-native", sender: participant("developer"), recipient: participant("coordinator"), type: "task.status" });
    await f.journal.recordNativeIntent("op-native", intent);
    expect((await f.journal.unacknowledgedNativeDeliveries()).map(item => item.operationId)).toEqual(["op-native"]);
    await f.journal.recordNativeAcknowledgement(intent);
    expect(await f.journal.unacknowledgedNativeDeliveries()).toEqual([]);
  });
});

describe("delivery failure notices", () => {
  it("writes an idempotent Conversation notice that renders as blocked with the original summary", async () => {
    const f = await fixture();
    const failed = message({ message_id: "m-failed", type: "task.assignment", sender: participant("coordinator"), recipient: participant("developer") });
    const notice = deliveryFailureNotice(failed, "Conversation pane unavailable", "Conversation không nhận được task.assignment");
    expect(notice).toMatchObject({ type: "conversation.progress", sender: { role: "runtime" }, recipient: { role: "conversation" }, run_id: "run-1" });
    expect(await f.journal.appendConversationNotice(notice)).toBe(true);
    expect(await f.journal.appendConversationNotice(deliveryFailureNotice(failed, "Conversation pane unavailable", "again"))).toBe(false);
    const [stored] = await f.journal.unsurfacedConversationNotices();
    const rendered = renderConversationNotice(stored!);
    expect(rendered).toMatchObject({ kind: "blocked", ackToken: "#1" });
    expect(rendered.display).toContain("Conversation pane unavailable");
    expect(JSON.parse(stored!.summary)).toMatchObject({ kind: "delivery_failure", summary: expect.stringContaining("m-failed") });
  });
  it("keeps a run-less dropped message visible as a clarification-typed blocked notice", () => {
    const failed = message({ message_id: "m-free", run_id: undefined, type: "conversation.clarification", sender: participant("conversation"), recipient: participant("coordinator") });
    const notice = deliveryFailureNotice(failed, "journal busy", "Không xử lý được");
    expect(notice.run_id).toBeUndefined();
    expect(notice.type).toBe("conversation.clarification");
  });
});
