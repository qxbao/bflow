import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostReceiptJournal, MAX_NOTICE_REBLOCKS, parseConversationResumeRequest } from "../../src/agentic/host-receipts.js";
import { TaskActivityLog } from "../../src/agentic/task-activity-log.js";
import { isProviderInputEmpty, reminderDelayMs, reminderDue, afterReminder } from "../../src/agentic/conversation-inbox.js";
import { blockedNoticeFields, containsCode, FAST_PATH_DESIGN_AUTO_APPROVED_NOTICE, FAST_PATH_TASK_WAIVER_NOTICE, formatFastPathDowngradeNotice, formatFriendlyExpiry, lastAssistantText, mustShowSection, noticeDisplayed, notificationBody, renderConversationNotice, sanitizeCardProse } from "../../src/agentic/conversation-notice-render.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const action of cleanups.splice(0).reverse()) await action(); });
async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-notice-render-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

const RULE = "─".repeat(72);
const APPROVAL_ID = "apr-user-decision-0123456789abcdef";
const decisionPayload = {
  approvalId: APPROVAL_ID, runId: "run-42", status: "pending", expiresAt: "2026-10-20T04:00:00.000Z",
  metadata: { kind: "user_decision", question: "Dùng schema v2 hay giữ v1?", requestedByRole: "coordinator", options: ["Schema v2", "Giữ v1", "Hoãn"] }
};
function notice(messageId: string, type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  const summary = JSON.stringify(payload);
  // Receipts written since aliases exist carry a work label for every run notice; legacy tests pass runLabel: undefined.
  return { messageId, type, senderRole: "coordinator", runId: "run-42", correlationId: "corr-1", receivedAt: "2026-10-20T03:16:58.000Z",
    runLabel: "Việc #1", summary, truncated: summary.length > 4096, ...extra };
}

describe("isProviderInputEmpty on the current Claude layout", () => {
  // Captured live: the prompt line carries a draft or ghost suggestion after a no-break space.
  const liveDraft = [
    "● earlier answer", "", RULE, "❯ cập nhật prompt cho agent bên ngoài với thông tin mới", RULE,
    "  ⏵⏵ don't ask on (shift+tab to cycle) · ← 2 agents"
  ].join("\n");
  const liveEmpty = ["● earlier answer", "", RULE, "❯ ", RULE, "  ⏵⏵ don't ask on (shift+tab to cycle) · ← 2 agents"].join("\n");
  it("treats an empty prompt between rules as empty, with or without the status line", () => {
    expect(isProviderInputEmpty("claude", liveEmpty)).toBe(true);
    expect(isProviderInputEmpty("claude", [RULE, "❯   ", RULE].join("\n"))).toBe(true);
    expect(isProviderInputEmpty("claude", [RULE, "❯", RULE, "", ""].join("\n"))).toBe(true);
  });
  it("treats any text after the prompt as not empty, including a ghost suggestion", () => {
    expect(isProviderInputEmpty("claude", liveDraft)).toBe(false);
    expect(isProviderInputEmpty("claude", [RULE, "❯ ok", RULE].join("\n"))).toBe(false);
  });
  it("fails closed on unexpected layouts", () => {
    expect(isProviderInputEmpty("claude", ["❯ ", "some text", RULE].join("\n"))).toBe(false);
    expect(isProviderInputEmpty("claude", [RULE, "❯ ", RULE, "status", "more", "lines"].join("\n"))).toBe(false);
    expect(isProviderInputEmpty("claude", [RULE, "❯ ", RULE, "❯ other"].join("\n"))).toBe(false);
    expect(isProviderInputEmpty("codex", liveEmpty)).toBe(false);
  });
  it("still recognises the old boxed layout", () => {
    expect(isProviderInputEmpty("claude", "Previous answer\n╭────────────────────╮\n│ >                  │\n╰────────────────────╯\n\n")).toBe(true);
    expect(isProviderInputEmpty("claude", "╭────╮\n│ > fix the bug │\n╰────╯")).toBe(false);
  });
});

describe("Conversation notice rendering", () => {
  it("shows the Coordinator's clarification questions instead of only saying that questions arrived", () => {
    const rendered = renderConversationNotice(notice("clarify-1", "conversation.clarification", {
      headline: "Specification requires additional verification methods", sdlcStatus: "clarifying",
      questions: ["Should securitySensitive be false for pure arithmetic?", "Keep unit_test only for the four criteria?"]
    }));
    expect(rendered.display).toContain("Việc #1: Specification requires additional verification methods");
    expect(rendered.display).toContain("1. Should securitySensitive be false for pure arithmetic?");
    expect(rendered.display).toContain("2. Keep unit_test only for the four criteria?");
    expect(rendered.display).not.toContain("Đã nhận câu hỏi làm rõ");
  });

  it.each([
    "SDD mismatch: policy requires lightweight SDD, not full SDD.",
    "Xung đột SDD: giữ lightweight, không cần full SDD.",
    "SDD mismatch: lightweight is allowed; no full SDD is required.",
    "SDD conflict: lightweight chosen; this does not mean full SDD is required.",
    "Xung đột SDD: giữ lightweight, không phải full SDD là bắt buộc."
  ])("does not recommend full when the blocker says otherwise: %s", reason => {
    const rendered = renderConversationNotice(notice("blocked-negative", "conversation.progress", {
      kind: "workflow_blocked", reason, requested_action: "authorized_requirement_revision"
    }));
    expect(rendered.reply).not.toContain("sang bản đặc tả đầy đủ");
    expect(rendered.display).not.toContain("Đổi sang bản đặc tả đầy đủ");
  });

  it("recognises an affirmative full requirement expressed after the SDD level", () => {
    const rendered = renderConversationNotice(notice("blocked-postfix", "conversation.progress", {
      kind: "workflow_blocked", reason: "SDD conflict: lightweight accepted; full SDD is required."
    }));
    expect(rendered.reply).toContain("sang bản đặc tả đầy đủ");
  });

  it("requires the revision action to be shown, not just an id or the blocker headline", () => {
    const rendered = renderConversationNotice(notice("blocked-ack", "conversation.progress", {
      kind: "workflow_blocked", reason: "SDD conflict: accepted lightweight but policy requires full SDD."
    }));
    expect(noticeDisplayed(rendered, "Đã nhận blocked-ack")).toBe(false);
    expect(noticeDisplayed(rendered, rendered.headline)).toBe(false);
    expect(noticeDisplayed(rendered, rendered.display)).toBe(true);
    expect(noticeDisplayed(rendered, rendered.display.replace("đổi yêu cầu", "**đổi yêu cầu**"))).toBe(true);
  });

  it("keeps the run-specific action in a bounded notification even when the cause is long", () => {
    const rendered = renderConversationNotice(notice("blocked-notification", "conversation.progress", {
      kind: "workflow_blocked", reason: "SDD conflict: lightweight accepted; policy requires full SDD. " + "detail ".repeat(150)
    }));
    const body = notificationBody(rendered);
    expect(body.length).toBeLessThanOrEqual(400);
    expect(body).toContain("đổi yêu cầu việc #1 sang bản đặc tả đầy đủ");
    expect(body).toContain("giữ nguyên phạm vi và tiêu chí nghiệm thu");
  });

  it("gives legacy SDD-conflict notices a concrete revision reply instead of the ineffective resume loop", () => {
    const rendered = renderConversationNotice(notice("blocked-sdd", "conversation.progress", {
      kind: "workflow_blocked", reason: "Coordinator blocked: accepted lightweight SDD conflicts with P15 requiring full SDD.",
      options: ["Khắc phục capability rồi yêu cầu tiếp tục run", "Hủy run"]
    }));
    expect(rendered.display).toContain("đổi yêu cầu việc #1 sang bản đặc tả đầy đủ");
    expect(rendered.display).toContain("giữ nguyên phạm vi");
    expect(rendered.display).toContain("không sửa yêu cầu");
    expect(rendered.display).not.toContain("Khắc phục capability");
    expect(rendered.display).toContain("hủy việc #1");
    expect(noticeDisplayed(rendered, rendered.display)).toBe(true);
  });

  it("renders a user decision as a 3-part Vietnamese card with short alias, friendly expiry and reply syntax", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-20T03:16:58.000Z") });
    const rendered = renderConversationNotice(notice("decision-" + APPROVAL_ID, "approval.request", decisionPayload, {
      shortId: "#2", runLabel: "Việc #1: Thêm trang đăng nhập"
    }));
    expect(rendered).toMatchObject({
      kind: "user_decision",
      approvalId: APPROVAL_ID,
      ackToken: "#2",
      shortId: "#2",
      runLabel: "Việc #1: Thêm trang đăng nhập",
      question: "Dùng schema v2 hay giữ v1?",
      requestedByRole: "coordinator"
    });
    expect(rendered.options).toEqual([{ number: 1, text: "Schema v2" }, { number: 2, text: "Giữ v1" }, { number: 3, text: "Hoãn" }]);
    expect(rendered.display).toContain("🔔 Cần bạn quyết định · #2");
    expect(rendered.display).toContain("Việc #1: Thêm trang đăng nhập");
    expect(rendered.display).toContain("Trưởng nhóm kỹ thuật hỏi: Dùng schema v2 hay giữ v1?\n  1. Schema v2\n  2. Giữ v1\n  3. Hoãn");
    expect(rendered.display).toContain(`Bạn trả lời: "#2: 1" — ${formatFriendlyExpiry(decisionPayload.expiresAt)}`);
    expect(rendered.display).toContain("còn 43 phút");
    expect(rendered.display).not.toContain("apr-");
    expect(rendered.display).not.toContain("run-42");
    expect(rendered.display).not.toContain("approval.request");
    expect(rendered.display).not.toContain('{"');
  });

  it("renders an approval card in plain Vietnamese without leaking artifact URIs or raw IDs", () => {
    const rendered = renderConversationNotice(notice("apr-msg-1", "approval.request", {
      approvalId: "design-abc123",
      runId: "run-42",
      target: { type: "run", runId: "run-42" },
      reason: "Duyệt bản thiết kế xác thực người dùng",
      requestedBy: "coordinator",
      expiresAt: "2026-10-20T04:00:00.000Z",
      evidence: [
        { kind: "specification", uri: "artifact://store/spec-1" },
        { kind: "patch", uri: "artifact://store/patch-1" }
      ]
    }, { shortId: "#2", runLabel: "Việc #1: Thêm trang đăng nhập" }));
    expect(rendered).toMatchObject({ kind: "approval", approvalId: "design-abc123", ackToken: "#2", shortId: "#2" });
    expect(rendered.display).toContain("🔔 Cần bạn duyệt · #2");
    expect(rendered.display).toContain("Việc #1: Thêm trang đăng nhập");
    expect(rendered.display).toContain("Cần bạn duyệt: Duyệt bản thiết kế xác thực người dùng (do Trưởng nhóm kỹ thuật gửi)");
    expect(rendered.display).toContain('Kèm 2 tài liệu (gõ "xem chi tiết #2" để xem)');
    expect(rendered.display).toContain("  1. Đồng ý\n  2. Từ chối hẳn (ghi lý do, dừng công việc)");
    // A revision request keeps the work; only an explicit rejection ends it, so the card never steers a fix towards "2".
    expect(rendered.display).toContain('Bạn trả lời: "#2: đồng ý" (hoặc "#2: 1") để duyệt, "#2: cần sửa <góp ý>" để yêu cầu sửa và giữ công việc, hoặc "#2: từ chối vì <lý do>" (hoặc "#2: 2 <lý do>") để từ chối hẳn và dừng công việc');
    expect(rendered.display).not.toContain("nếu cần sửa");
    expect(rendered.display).not.toContain("artifact://");
    expect(rendered.display).not.toContain("design-abc123");
    expect(rendered.display).not.toContain("run-42");
    expect(rendered.display).not.toContain('{"');
  });

  it("says there is no expiry when the request has none", () => {
    const { expiresAt: _omit, ...payload } = decisionPayload;
    const rendered = renderConversationNotice(notice("decision-" + APPROVAL_ID, "approval.request", payload));
    expect(rendered.display).toContain("chưa giới hạn thời gian — đang chờ bạn trả lời");
  });
  it("falls back to a truncated update when the stored summary is cut off", () => {
    const full = JSON.stringify(decisionPayload);
    const rendered = renderConversationNotice({ messageId: "decision-" + APPROVAL_ID, type: "approval.request", summary: full.slice(0, 40), truncated: true });
    expect(rendered).toMatchObject({ kind: "update" });
    expect(rendered.ackToken).toBeUndefined();
    expect(rendered.display).toContain("bị cắt ngắn");
    expect(renderConversationNotice({ messageId: "m", type: "approval.request", summary: "{not json" }).kind).toBe("update");
  });
  it("renders blocked payloads with 3 parts (Chuyện gì xảy ra / Ảnh hưởng / Bạn cần làm gì), acknowledged by shortId", () => {
    const payload = { kind: "workflow_blocked", reason: "Developer không phản hồi: {\"code\":\"timeout\"}", options: ["Thử lại", "Dừng run"], runId: "run-42" };
    const rendered = renderConversationNotice(notice("blocked-1", "conversation.progress", payload, { shortId: "#3", runLabel: "Việc #1: Thêm trang đăng nhập" }));
    expect(rendered).toMatchObject({ kind: "blocked", ackToken: "#3", shortId: "#3", runId: "run-42" });
    expect(rendered.display).toContain("⚠️ Tạm dừng vì vướng mắc · #3");
    expect(rendered.display).toContain("Việc #1: Thêm trang đăng nhập");
    expect(rendered.display).toContain("Chuyện gì xảy ra: Công việc đang tạm dừng vì vướng mắc — Lập trình viên không phản hồi.");
    expect(rendered.display).toContain("Ảnh hưởng: Việc #1 đang tạm dừng và chờ xử lý trước khi làm tiếp.");
    expect(rendered.display).toContain('Bạn cần làm gì: Gõ "tiếp tục việc #1" sau khi xử lý xong, hoặc gõ "hủy việc #1" nếu muốn dừng hẳn.');
    expect(rendered.display).not.toContain("<số lựa chọn>");
    expect(rendered.display).not.toContain('{"');
    expect(rendered.display).not.toContain("run-42");
    expect(rendered.display).not.toContain("conversation.progress");
  });
  it("accepts the exact resume phrase a blocked notice suggests", () => {
    const rendered = renderConversationNotice(notice("blocked-2", "conversation.progress", { kind: "workflow_blocked", reason: "Handoff refused", options: ["Ask Coordinator to resend"], runId: "run-7" }));
    expect(rendered.display).toContain("tiếp tục việc #1");
    expect(parseConversationResumeRequest("tiếp tục việc #1")).toEqual({ runId: "việc #1" });
    expect(parseConversationResumeRequest(`tiếp tục ${rendered.runId}`)).toEqual({ runId: "run-7" });
    expect(renderConversationNotice(notice("blocked-3", "conversation.progress", { kind: "workflow_blocked", reason: "x", options: ["Retry"] })).reply)
      .not.toContain("<số lựa chọn>");
  });
  it("keeps other notices as short plain-language headlines", () => {
    const rendered = renderConversationNotice(notice("progress-1", "conversation.progress", { headline: "x" }));
    expect(rendered).toMatchObject({ kind: "update" });
    expect(rendered.display).toBe("▶ Việc #1: x");
    expect(rendered.ackToken).toBe("Việc #1: x");
  });
  it("counts a reformatted update as displayed only when it names this notice or its work/run and exact text", () => {
    // Observed in conv-bf-daac1a7e8152c8d655d6: the agent dropped the [id] marker and bolded the headline, and was re-blocked twice.
    const rendered = renderConversationNotice(notice("p19-7631", "delegation.accepted", { headline: "Coordinator accepted the objective" }));
    expect(noticeDisplayed(rendered, rendered.display)).toBe(true);
    expect(noticeDisplayed(rendered, "ℹ️ **Cập nhật** · run `run-42`:\n\n**Coordinator accepted the objective** ✅")).toBe(true);
    expect(noticeDisplayed(rendered, "Cập nhật p19-7631 đã nhận")).toBe(true);
    expect(noticeDisplayed(rendered, "ℹ️ Coordinator đã chấp nhận mục tiêu · run run-42")).toBe(false);
    expect(noticeDisplayed(rendered, "Coordinator accepted the objective (run run-99)")).toBe(false);
    expect(noticeDisplayed(renderConversationNotice({ messageId: "notice-1" }), "notice-1")).toBe(false);
  });
  it("counts a blocked notice as displayed when its shortId or its run and leading reason are shown", () => {
    const reason = "Đặc tả không được hỗ trợ bởi cấu hình kiểm thử hiện tại: [\n  {\n    \"code\": \"invalid_type\"\n  }\n]";
    const rendered = renderConversationNotice(notice("p19-2f63", "conversation.progress", { kind: "workflow_rejected", reason, options: ["Hủy run này"], runId: "run-42" }, { shortId: "#3" }));
    expect(rendered.kind).toBe("blocked");
    expect(rendered.display).not.toContain("invalid_type");
    expect(noticeDisplayed(rendered, rendered.display)).toBe(true);
    expect(noticeDisplayed(rendered, "Đã hiển thị cảnh báo #3 cho bạn")).toBe(true);
    expect(noticeDisplayed(rendered, "⚠️ **Workflow bị từ chối** (run `run-42`)\n\n**Lỗi**: Đặc tả không được hỗ trợ bởi cấu hình kiểm thử hiện tại:\n```\n{ \"code\": \"invalid_type\" }\n```")).toBe(true);
    expect(noticeDisplayed(rendered, "Workflow bị từ chối (run run-42)")).toBe(false);
  });
  it("acknowledges decisions and approvals by #n shortId and degrades to approvalId for legacy notices", () => {
    const rendered = renderConversationNotice(notice("decision-" + APPROVAL_ID, "approval.request", decisionPayload, { shortId: "#2" }));
    expect(noticeDisplayed(rendered, "Câu hỏi #2: Dùng schema v2 hay giữ v1?")).toBe(true);
    expect(noticeDisplayed(rendered, `Câu hỏi ${APPROVAL_ID}`)).toBe(true);
    expect(noticeDisplayed(rendered, `${rendered.question} (run run-42)`)).toBe(false);
  });
  it("tolerates partial notices from a host reply without leaking raw message types", () => {
    const partial = renderConversationNotice({ messageId: "notice-1" });
    expect(partial.display).toContain("▶ Hệ thống Bflow:");
    expect(partial.display).not.toContain("(notice)");
  });
  it("puts user decisions and blocks first in the MUST SHOW section without VERBATIM/[id] boilerplate", () => {
    const section = mustShowSection([
      notice("progress-1", "conversation.progress", { headline: "x" }),
      notice("decision-" + APPROVAL_ID, "approval.request", decisionPayload, { shortId: "#1" })
    ]);
    expect(section.startsWith("MUST SHOW TO USER:\n🔔")).toBe(true);
    expect(section).not.toContain("VERBATIM");
    expect(section).not.toContain("[id] marker");
    expect(section).toContain("giữ nguyên mã #n");
    expect(section.indexOf("#1")).toBeLessThan(section.indexOf("▶ Việc #1"));
    expect(mustShowSection([])).toBe("");
  });
  it("clips notification bodies while keeping the shortId and reply line", () => {
    const long = { ...decisionPayload, metadata: { ...decisionPayload.metadata, question: "q".repeat(1000) } };
    const body = notificationBody(renderConversationNotice(notice("decision-" + APPROVAL_ID, "approval.request", long, { shortId: "#2" })));
    expect(body.length).toBeLessThanOrEqual(400);
    expect(body).toContain("#2");
    expect(body).toContain('Bạn trả lời: "#2: 1"');
    const short = notificationBody(renderConversationNotice(notice("decision-" + APPROVAL_ID, "approval.request", decisionPayload, { shortId: "#2" })));
    expect(short).toContain("Dùng schema v2 hay giữ v1?");
  });
});

describe("review fixes: aliases, display acknowledgement and expiry", () => {
  it("does not count a work label, a longer code or another id as showing card #1", () => {
    const rendered = renderConversationNotice(notice("decision-" + APPROVAL_ID, "approval.request", decisionPayload, { shortId: "#1" }));
    expect(noticeDisplayed(rendered, "Việc #1 đang chạy bình thường.")).toBe(false);
    expect(noticeDisplayed(rendered, "**Việc  #1**: tiến độ")).toBe(false);
    expect(noticeDisplayed(rendered, "Câu hỏi #12 đã có câu trả lời")).toBe(false);
    expect(noticeDisplayed(rendered, "mã x#1 nội bộ")).toBe(false);
    expect(noticeDisplayed(rendered, "🔔 Cần bạn quyết định · #1")).toBe(true);
    expect(noticeDisplayed(rendered, "Trả lời **#1**: 1")).toBe(true);
    expect(containsCode("Việc #12 xong", "Việc #1")).toBe(false);
    expect(containsCode("Việc #1: xong", "Việc #1")).toBe(true);
  });
  it("keeps legacy notices on their exact ids instead of a guessed #1 / Việc #1", () => {
    const legacy = { runLabel: undefined };
    const decision = renderConversationNotice(notice("decision-" + APPROVAL_ID, "approval.request", decisionPayload, legacy));
    expect(decision).toMatchObject({ ackToken: APPROVAL_ID, shortId: APPROVAL_ID });
    expect(decision.display).not.toMatch(/#1\b/u);
    expect(noticeDisplayed(decision, "Việc #1 và câu hỏi #1")).toBe(false);
    const blocked = renderConversationNotice(notice("blocked-legacy", "conversation.progress", { kind: "workflow_blocked", reason: "Handoff refused", runId: "run-7" }, legacy));
    expect(blocked.ackToken).toBe("blocked-legacy");
    expect(blocked.display).toContain('"tiếp tục run-7"');
    expect(blocked.display).not.toContain("Việc #1");
    expect(renderConversationNotice(notice("progress-legacy", "conversation.progress", { headline: "x" }, legacy)).display).toBe("▶ run run-42: x");
  });
  it("never rewrites another approval or run id to this card's own labels", () => {
    const identity = { approvalId: APPROVAL_ID, code: "#2", runId: "run-42", workTag: "Việc #1" };
    expect(sanitizeCardProse(`Giống ${APPROVAL_ID} trong run run-42`, identity)).toBe("Giống #2 trong Việc #1");
    expect(sanitizeCardProse("Giống apr-other-1 trong run run-99", identity)).toBe("Giống một yêu cầu duyệt khác trong một công việc khác");
  });
  it("formats expiry in the local time zone and measures remaining time at render time", () => {
    const expiresAt = "2026-10-20T04:00:00.000Z", zone = "Asia/Ho_Chi_Minh";
    expect(formatFriendlyExpiry(expiresAt, Date.parse("2026-10-20T03:17:00.000Z"), zone)).toBe("còn 43 phút (hết hạn lúc 11:00)");
    expect(formatFriendlyExpiry(expiresAt, Date.parse("2026-10-20T03:50:00.000Z"), zone)).toBe("còn 10 phút (hết hạn lúc 11:00)");
    expect(formatFriendlyExpiry(expiresAt, Date.parse("2026-10-20T04:05:00.000Z"), zone)).toBe("đã hết hạn lúc 11:00");
    expect(formatFriendlyExpiry("2026-10-22T04:00:00.000Z", Date.parse("2026-10-20T03:00:00.000Z"), zone)).toBe("hết hạn lúc 11:00 ngày 22/10");
  });
  it("assigns distinct #n aliases to concurrently appended decisions", async () => {
    const root = await directory();
    const receipts = new HostReceiptJournal(join(root, "receipts"), "/tmp/bflow-notice-render-repo", "session-1",
      TaskActivityLog.open(join(root, "task-activity.jsonl")));
    const message = (index: number) => ({ schema_version: 2, message_id: `decision-${index}`, correlation_id: "corr-1", run_id: "run-42",
      sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "approval.request", artifact_references: [],
      payload: { ...decisionPayload, approvalId: `apr-user-decision-${index}` } });
    await Promise.all([1, 2, 3, 4, 5].map(index => receipts.appendConversationNotice(message(index) as never)));
    const aliases = await receipts.noticeAliases();
    expect(Object.keys(aliases.approvalShortIds).sort()).toEqual(["#1", "#2", "#3", "#4", "#5"]);
    expect(new Set(Object.values(aliases.approvalShortIds)).size).toBe(5);
  });
});

describe("transcript and reminder helpers", () => {
  it("reads only the final assistant turn", () => {
    const jsonl = [
      "partial line that is not json",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "old answer apr-old" }] } }),
      JSON.stringify({ type: "user", message: { content: "next" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "x" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `Cần bạn quyết định ${APPROVAL_ID}` }] } })
    ].join("\n");
    expect(lastAssistantText(jsonl)).toBe(`Cần bạn quyết định ${APPROVAL_ID}`);
    expect(lastAssistantText("")).toBe("");
  });
  it("backs off 60, 120, 240 and then 600 seconds", () => {
    expect([1, 2, 3, 4, 5].map(reminderDelayMs)).toEqual([60_000, 120_000, 240_000, 600_000, 600_000]);
    let state = afterReminder(undefined, 1_000);
    expect(state).toEqual({ shows: 1, nextAt: 61_000 });
    expect(reminderDue(state, 60_999)).toBe(false);
    expect(reminderDue(state, 61_000)).toBe(true);
    state = afterReminder(state, 61_000);
    expect(state.nextAt).toBe(181_000);
    expect(reminderDue(undefined, 0)).toBe(true);
  });
});

describe("display acknowledgement receipts", () => {
  it("retains the full-SDD action when classification text lies past the bounded reason", async () => {
    const root = await directory(), path = join(root, "receipts");
    const receipts = new HostReceiptJournal(path, "/tmp/bflow-notice-render-repo", "session-1");
    await receipts.appendConversationNotice({ schema_version: 2, message_id: "blocked-tail", correlation_id: "corr-1", run_id: "run-42",
      sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "conversation.progress",
      payload: { kind: "workflow_blocked", reason: "detail ".repeat(800) + "SDD conflict: accepted lightweight; policy requires full SDD.",
        requested_action: "authorized_requirement_revision" }, artifact_references: [], idempotency_key: "blocked-tail" });
    const stored = (await new HostReceiptJournal(path, "/tmp/bflow-notice-render-repo", "session-1").unsurfacedConversationNotices())[0]!;
    expect(stored.truncated).toBe(true);
    expect(renderConversationNotice(stored).reply).toContain("đổi yêu cầu việc #1 sang bản đặc tả đầy đủ");
  });

  it("keeps the cause and revision action visible after an oversized summary is stored and reopened", async () => {
    const root = await directory(), path = join(root, "receipts");
    const receipts = new HostReceiptJournal(path, "/tmp/bflow-notice-render-repo", "session-1");
    await receipts.appendConversationNotice({ schema_version: 2, message_id: "blocked-long-sdd", correlation_id: "corr-1", run_id: "run-42",
      sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "conversation.progress",
      payload: { kind: "workflow_blocked", reason: "Accepted lightweight SDD conflicts with P15 requiring full SDD.",
        requested_action: "authorized_requirement_revision", blockers: ["Need authorized requirement revision"],
        diagnostics: "long detail ".repeat(1000) }, artifact_references: [], idempotency_key: "blocked-long-sdd" });
    const reopened = new HostReceiptJournal(path, "/tmp/bflow-notice-render-repo", "session-1");
    const stored = (await reopened.unsurfacedConversationNotices())[0]!;
    expect(stored.truncated).toBe(true);
    const rendered = renderConversationNotice(stored);
    expect(rendered.kind).toBe("blocked");
    expect(rendered.display).toContain("đổi yêu cầu việc #1 sang bản đặc tả đầy đủ");
    expect(rendered.display).toContain("không sửa yêu cầu");
    await reopened.markConversationNoticesSurfaced([stored.messageId]);
    expect((await reopened.undisplayedUserFacingNotices()).map(item => item.messageId)).toContain(stored.messageId);
  });

  it("assigns monotonic #n and Việc #k aliases across notices and persists them across journal restart", async () => {
    const root = await directory(), path = join(root, "receipts");
    const receipts = new HostReceiptJournal(path, "/tmp/bflow-notice-render-repo", "session-1");
    await receipts.appendConversationNotice({
      schema_version: 2, message_id: "progress-run-1", correlation_id: "corr-1", run_id: "run-42",
      sender: { role: "coordinator" }, recipient: { role: "conversation" }, type: "conversation.progress",
      payload: { headline: "Đang lập kế hoạch", title: "Thêm trang đăng nhập" }, artifact_references: [], idempotency_key: "p-1"
    });
    await receipts.appendConversationNotice({
      schema_version: 2, message_id: "decision-1", correlation_id: "corr-1", run_id: "run-42",
      sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "approval.request",
      payload: decisionPayload, artifact_references: [], idempotency_key: "d-1"
    });
    const reopened = new HostReceiptJournal(path, "/tmp/bflow-notice-render-repo", "session-1");
    await reopened.appendConversationNotice({
      schema_version: 2, message_id: "blocked-run-2", correlation_id: "corr-2", run_id: "run-99",
      sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "conversation.progress",
      payload: { kind: "workflow_blocked", reason: "Thiếu cấu hình", title: "Nâng cấp bộ nhớ đệm" }, artifact_references: [], idempotency_key: "b-2"
    });
    const unsurfaced = await reopened.unsurfacedConversationNotices();
    const byId = Object.fromEntries(unsurfaced.map(item => [item.messageId, item]));
    expect(byId["progress-run-1"]).toMatchObject({ runLabel: "Việc #1: Thêm trang đăng nhập" });
    expect(byId["decision-1"]).toMatchObject({ shortId: "#1", runLabel: "Việc #1: Thêm trang đăng nhập" });
    expect(byId["blocked-run-2"]).toMatchObject({ shortId: "#2", runLabel: "Việc #2: Nâng cấp bộ nhớ đệm" });
    const aliases = await reopened.noticeAliases();
    expect(aliases.approvalShortIds["#1"]).toBe(APPROVAL_ID);
    expect(aliases.runShortIds["việc #1"]).toBe("run-42");
    expect(aliases.runShortIds["việc #2"]).toBe("run-99");
  });

  it("retains surfaced substantive progress until user display, including after reopening", async () => {
    const root = await directory(), path = join(root, "receipts");
    const receipts = new HostReceiptJournal(path, "/tmp/bflow-notice-render-repo", "session-1");
    await receipts.appendConversationNotice({ schema_version: 2, message_id: "progress-runner-found", correlation_id: "corr-1", run_id: "run-42",
      sender: { role: "coordinator" }, recipient: { role: "conversation" }, type: "conversation.progress",
      payload: { headline: "Root E2E runner exists", sdlcStatus: "specifying" }, artifact_references: [], idempotency_key: "progress-runner-found" });
    await receipts.markConversationNoticesSurfaced(["progress-runner-found"]);
    const reopened = new HostReceiptJournal(path, "/tmp/bflow-notice-render-repo", "session-1");
    expect(await reopened.unsurfacedConversationNotices()).toEqual([]);
    expect(await reopened.undisplayedUserFacingNotices()).toEqual([expect.objectContaining({ messageId: "progress-runner-found", reblocks: 0 })]);
    expect(await reopened.markConversationNoticesDisplayed(["progress-runner-found"])).toEqual(["progress-runner-found"]);
    expect(await receipts.undisplayedUserFacingNotices()).toEqual([]);
  });

  it("lists surfaced user decisions until they are displayed, and bounds re-blocks", async () => {
    const root = await directory();
    const receipts = new HostReceiptJournal(join(root, "receipts"), "/tmp/bflow-notice-render-repo", "session-1");
    await receipts.appendConversationNotice({
      schema_version: 2, message_id: "decision-" + APPROVAL_ID, correlation_id: "corr-1", run_id: "run-42",
      sender: { role: "runtime", agent_id: "runtime", pane_id: "pane-runtime" },
      recipient: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" },
      type: "approval.request", payload: decisionPayload, artifact_references: [], occurred_at: "2026-10-20T03:16:58.000Z", idempotency_key: "k"
    } as never);
    await receipts.appendConversationNotice({
      schema_version: 2, message_id: "progress-1", correlation_id: "corr-1", run_id: "run-42",
      sender: { role: "coordinator", agent_id: "c", pane_id: "pane-c" }, recipient: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" },
      type: "conversation.progress", payload: { headline: "x" }, artifact_references: [], occurred_at: "2026-10-20T03:17:00.000Z", idempotency_key: "k2"
    } as never);
    expect(await receipts.undisplayedUserFacingNotices()).toEqual([]);
    await receipts.markConversationNoticesSurfaced(["decision-" + APPROVAL_ID, "progress-1"]);
    const undisplayed = await receipts.undisplayedUserFacingNotices();
    expect(undisplayed.map(item => item.messageId)).toEqual(["decision-" + APPROVAL_ID, "progress-1"]);
    expect(undisplayed[0]).toMatchObject({ reblocks: 0, type: "approval.request" });
    expect(typeof undisplayed[0]!.surfacedAt).toBe("string");
    // Surfacing again keeps the first time and creates no second receipt.
    await receipts.markConversationNoticesSurfaced(["decision-" + APPROVAL_ID]);
    expect(await receipts.recordNoticeReblock("decision-" + APPROVAL_ID)).toBe(1);
    expect(await receipts.recordNoticeReblock("decision-" + APPROVAL_ID)).toBe(2);
    expect(MAX_NOTICE_REBLOCKS).toBe(2);
    expect((await receipts.undisplayedUserFacingNotices())[0]!.reblocks).toBe(2);
    // Progress has its own display receipt; unknown ids are ignored.
    expect(await receipts.markConversationNoticesDisplayed(["progress-1", "never-appended"])).toEqual(["progress-1"]);
    expect(await receipts.markConversationNoticesDisplayed(["decision-" + APPROVAL_ID])).toEqual(["decision-" + APPROVAL_ID]);
    expect(await receipts.markConversationNoticesDisplayed(["decision-" + APPROVAL_ID])).toEqual([]);
    const reloaded = new HostReceiptJournal(join(root, "receipts"), "/tmp/bflow-notice-render-repo", "session-1");
    expect(await reloaded.undisplayedUserFacingNotices()).toEqual([]);
    expect((await reloaded.unsurfacedConversationNotices()).map(item => item.messageId)).toEqual([]);
  });
});

describe("structured decision fields and assistant text", () => {
  it("renders a user decision from its bounded fields when the summary was truncated", () => {
    const rendered = renderConversationNotice({ messageId: "decision-" + APPROVAL_ID, type: "approval.request", summary: "{\"approval", truncated: true,
      userDecision: { approvalId: APPROVAL_ID, requestedByRole: "developer", question: "Dùng schema nào?", options: ["Schema v2", "Giữ v1"],
        expiresAt: "2026-10-20T04:00:00.000Z" } });
    expect(rendered.kind).toBe("user_decision");
    // No alias was stored: the card keeps the exact approval id instead of guessing #1.
    expect(rendered.display).toContain(`🔔 Cần bạn quyết định · ${APPROVAL_ID}`);
    expect(rendered.display).toContain("Lập trình viên hỏi: Dùng schema nào?");
    expect(rendered.display).toContain("  1. Schema v2\n  2. Giữ v1");
    expect(rendered.display).toContain(`Bạn trả lời: "${APPROVAL_ID}: 1"`);
    expect(rendered.display).not.toContain("#1");
  });
  it("degrades a malformed structured field to an update that says it was cut short", () => {
    const rendered = renderConversationNotice({ messageId: "m-1", type: "approval.request", summary: undefined, truncated: true,
      userDecision: { approvalId: 7 } });
    expect(rendered.kind).toBe("update");
    expect(rendered.display).toContain("bị cắt ngắn");
  });
  it("collects assistant text across a tool result back to the last genuine user prompt", () => {
    const entries = [
      { type: "user", message: { content: "older prompt" } },
      { type: "assistant", message: { content: [{ type: "text", text: "stale" }] } },
      { type: "user", message: { content: "new prompt" } },
      { type: "assistant", message: { content: [{ type: "text", text: "First" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Second" }] } }
    ];
    expect(lastAssistantText(entries.map(entry => JSON.stringify(entry)).join("\n"))).toBe("First\nSecond");
  });
  it("treats a user entry with a text block as the boundary, not a tool result", () => {
    const entries = [
      { type: "assistant", message: { content: [{ type: "text", text: "before" }] } },
      { type: "user", message: { content: [{ type: "text", text: "interrupt" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "after" }] } }
    ];
    expect(lastAssistantText(entries.map(entry => JSON.stringify(entry)).join("\n"))).toBe("after");
  });
});

describe("blocked notice automatic resume and blockageReason", () => {
  const automaticResume = { attempt: 2, limit: 5, notBefore: "2026-10-20T03:20:00.000Z" };
  it("renders an auto-resume reply without asking for a manual resume", () => {
    const rendered = renderConversationNotice(notice("blocked-auto", "conversation.progress", {
      kind: "workflow_blocked", runId: "run-42", reason: "Coordinator pane unavailable", blockageReason: "Coordinator pane unavailable", automaticResume }));
    expect(rendered.reply).toContain("Hệ thống Bflow sẽ tự thử chạy lại Việc #1 (lần 2/5)");
    expect(rendered.reply).toContain('"hủy việc #1"');
    expect(rendered.reply).not.toContain("sau khi xử lý xong");
    expect(rendered.reply).not.toContain('"tiếp tục');
  });
  it("ignores a malformed automaticResume and keeps the manual reply", () => {
    const rendered = renderConversationNotice(notice("blocked-bad", "conversation.progress", {
      kind: "workflow_blocked", runId: "run-42", reason: "Coordinator pane unavailable", automaticResume: { attempt: "x" } }));
    expect(rendered.reply).toContain('"tiếp tục việc #1"');
  });
  it("round-trips automaticResume through blockedNoticeFields and still parses old receipts", () => {
    const fields = blockedNoticeFields({ kind: "workflow_blocked", runId: "run-42", reason: "Pane unavailable", automaticResume });
    expect(fields?.automaticResume).toEqual(automaticResume);
    const rendered = renderConversationNotice(notice("blocked-fields", "conversation.progress", { kind: "workflow_blocked" }, { summary: "{", blocked: fields }));
    expect(rendered.reply).toContain("Hệ thống Bflow sẽ tự thử chạy lại Việc #1");
    const old = blockedNoticeFields({ kind: "workflow_blocked", runId: "run-42", reason: "Pane unavailable" });
    expect(old).toBeDefined();
    expect(old).not.toHaveProperty("automaticResume");
    expect(renderConversationNotice(notice("blocked-old", "conversation.progress", { kind: "workflow_blocked" }, { summary: "{", blocked: old })).reply).toContain('"tiếp tục việc #1"');
  });
  it("classifies a requirement-revision blocker as blocked via blockageReason", () => {
    const fields = blockedNoticeFields({ kind: "workflow_blocked", runId: "run-42", reason: "SDD conflict: full SDD required.", blockageReason: "SDD conflict: full SDD required.",
      requested_action: "authorized_requirement_revision" });
    expect(fields?.requested_action).toBe("authorized_requirement_revision");
  });
});

describe("technical detail logging and on-demand lookup", () => {
  it("records redacted notice technical details to TaskActivityLog on appendConversationNotice and survives log errors", async () => {
    const root = await directory();
    const activity = TaskActivityLog.open(join(root, "task-activity.jsonl"));
    const receipts = new HostReceiptJournal(join(root, "receipts"), "/tmp/bflow-notice-render-repo", "session-1", activity);
    await receipts.appendConversationNotice({
      schema_version: 2,
      message_id: "apr-msg-log-1",
      correlation_id: "corr-log-1",
      run_id: "run-42",
      sender: { role: "coordinator" },
      recipient: { role: "conversation" },
      type: "approval.request",
      payload: {
        approvalId: "design-abc123",
        runId: "run-42",
        title: "Thêm trang đăng nhập",
        target: { type: "run", runId: "run-42" },
        reason: "Duyệt bản thiết kế xác thực người dùng — Authorization: Bearer secret-jwt-token",
        requestedBy: "coordinator",
        expiresAt: "2026-10-20T04:00:00.000Z",
        evidence: [
          { kind: "specification", uri: "artifact://store/spec-1" },
          { kind: "patch", uri: "artifact://store/patch-1" }
        ]
      },
      artifact_references: [{
        artifactId: "log-1",
        runId: "run-42",
        trust: "stored",
        uri: "artifact://store/log-1",
        kind: "log",
        mediaType: "text/plain",
        createdAt: "2026-10-20T03:16:00.000Z",
        sizeBytes: 12,
        checksum: { algorithm: "sha256", value: "a".repeat(64) }
      }],
      idempotency_key: "apr-msg-log-1"
    });
    const entries = await activity.read({ runId: "run-42" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "notice",
      role: "coordinator",
      runId: "run-42",
      shortId: "#1",
      runLabel: "Việc #1: Thêm trang đăng nhập",
      messageType: "approval.request",
      reason: "Duyệt bản thiết kế xác thực người dùng — Authorization: Bearer [REDACTED]",
      artifacts: ["artifact://store/log-1", "artifact://store/spec-1", "artifact://store/patch-1"]
    });

    const failingLog = {
      record: async () => { throw new Error("Simulated disk full in activity log"); }
    };
    const resilientReceipts = new HostReceiptJournal(join(root, "receipts"), "/tmp/bflow-notice-render-repo", "session-1", failingLog);
    await expect(resilientReceipts.appendConversationNotice({
      schema_version: 2,
      message_id: "blocked-log-fail",
      correlation_id: "corr-log-2",
      run_id: "run-42",
      sender: { role: "runtime" },
      recipient: { role: "conversation" },
      type: "conversation.progress",
      payload: { kind: "workflow_blocked", reason: "Developer không phản hồi: {\"code\":\"timeout\"}" },
      artifact_references: [],
      idempotency_key: "blocked-log-fail"
    })).resolves.toBe(true);
    expect((await resilientReceipts.unsurfacedConversationNotices()).map(item => item.messageId)).toContain("blocked-log-fail");

    const detailByShortId = await resilientReceipts.readConversationNoticeDetail("#1");
    expect(detailByShortId).toMatchObject({
      shortId: "#1",
      runLabel: "Việc #1: Thêm trang đăng nhập",
      messageId: "apr-msg-log-1",
      type: "approval.request",
      senderRole: "coordinator",
      runId: "run-42",
      correlationId: "corr-log-1",
      approvalId: "design-abc123",
      reason: "Duyệt bản thiết kế xác thực người dùng — Authorization: Bearer [REDACTED]",
      artifacts: ["artifact://store/log-1", "artifact://store/spec-1", "artifact://store/patch-1"]
    });
    expect(detailByShortId.summary).not.toContain("secret-jwt-token");

    const detailByWorkTag = await resilientReceipts.readConversationNoticeDetail("Việc #1");
    expect(detailByWorkTag).toMatchObject({
      shortId: "#2",
      runLabel: "Việc #1: Thêm trang đăng nhập",
      messageId: "blocked-log-fail",
      type: "conversation.progress",
      senderRole: "runtime",
      runId: "run-42",
      reason: 'Developer không phản hồi: {"code":"timeout"}'
    });

    await expect(resilientReceipts.readConversationNoticeDetail("#99")).rejects.toThrow(/Unknown|not found/i);
    await expect(resilientReceipts.readConversationNoticeDetail("Việc #99")).rejects.toThrow(/Unknown|not found/i);
  });

  it("acknowledges an update notice when Conversation paraphrases it in Vietnamese with its Việc #k label", () => {
    const rendered = renderConversationNotice(notice("accepted-1", "delegation.accepted", {
      headline: "Coordinator accepted the objective"
    }, { runId: "run-1", runLabel: "Việc #1: Tạo calc.js" }));
    expect(rendered.kind).toBe("update");
    expect(noticeDisplayed(rendered, "Việc #1: Trưởng nhóm kỹ thuật đã chấp nhận mục tiêu.")).toBe(true);
    expect(noticeDisplayed(rendered, "Việc #2: Trưởng nhóm kỹ thuật đã chấp nhận mục tiêu.")).toBe(false);
  });

  it("renders fast-path waiver and downgrade notices in plain Vietnamese without leaking internal codes onto the card", async () => {
    const waived = renderConversationNotice(notice("fp-waived-1", "conversation.progress", {
      headline: FAST_PATH_TASK_WAIVER_NOTICE,
      fastPath: { status: "active", waiver: "deterministic_coverage" }
    }, { senderRole: "runtime", runId: "run-42", runLabel: "Việc #1: Refactor nhỏ" }));
    expect(waived.kind).toBe("update");
    expect(waived.display).toContain("▶ Việc #1: Thay đổi nhỏ: kết quả kiểm thử tự động đã đủ, không cần người review riêng.");
    expect(waived.display).not.toContain("deterministic_coverage");

    const designAuto = renderConversationNotice(notice("fp-design-1", "conversation.progress", {
      headline: FAST_PATH_DESIGN_AUTO_APPROVED_NOTICE
    }, { senderRole: "runtime", runId: "run-42", runLabel: "Việc #1: Refactor nhỏ" }));
    expect(designAuto.display).toContain("▶ Việc #1: Thay đổi nhỏ: tự duyệt thiết kế, bạn sẽ duyệt khi bàn giao.");

    for (const [code, expectedReason] of [
      ["waiver_rejected:review_waiver_manual_criterion", "có tiêu chí cần người kiểm tra thủ công"],
      ["waiver_rejected:review_waiver_no_commands", "chưa có lệnh kiểm thử tự động"],
      ["tree_mismatch", "cây mã nguồn sau khi gộp có thay đổi"],
      ["task_not_passed", "bước kiểm tra công việc chưa hoàn tất"],
      ["journal_legacy", "dữ liệu phiên cũ chưa hỗ trợ đường tắt"]
    ] as const) {
      const text = formatFastPathDowngradeNotice(code);
      expect(text).toBe(`Không đi đường tắt được (${expectedReason}), chạy kiểm tra đầy đủ.`);
      const rendered = renderConversationNotice(notice(`fp-down-${code}`, "conversation.progress", {
        headline: `${text} [{"code":"${code}"}]`
      }, { senderRole: "runtime", runId: "run-42", runLabel: "Việc #1: Refactor nhỏ" }));
      expect(rendered.display).toBe(`▶ Việc #1: Không đi đường tắt được (${expectedReason}), chạy kiểm tra đầy đủ.`);
      expect(rendered.display).not.toContain(code);
      expect(rendered.display).not.toContain("waiver_rejected");
      expect(rendered.display).not.toContain("review_waiver_");
    }

    const root = await directory();
    const receipts = new HostReceiptJournal(join(root, "receipts"), "/tmp/bflow-notice-render-repo", "session-1");
    await receipts.appendConversationNotice({
      schema_version: 2,
      message_id: "fp-downgrade-log",
      correlation_id: "corr-fp-1",
      run_id: "run-42",
      sender: { role: "runtime" },
      recipient: { role: "conversation" },
      type: "conversation.progress",
      payload: {
        headline: `${formatFastPathDowngradeNotice("waiver_rejected:review_waiver_no_commands")} [{"downgradeReason":"waiver_rejected:review_waiver_no_commands"}]`
      },
      artifact_references: [],
      idempotency_key: "fp-downgrade-log"
    });
    const detail = await receipts.readConversationNoticeDetail("Việc #1");
    expect(detail.summary).toContain("waiver_rejected:review_waiver_no_commands");
  });
});
