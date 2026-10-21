import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostReceiptJournal, MAX_NOTICE_REBLOCKS, parseConversationResumeRequest } from "../../src/agentic/host-receipts.js";
import { isProviderInputEmpty, reminderDelayMs, reminderDue, afterReminder } from "../../src/agentic/conversation-inbox.js";
import { lastAssistantText, mustShowSection, notificationBody, renderConversationNotice } from "../../src/agentic/conversation-notice-render.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanups.splice(0).reverse()) await action(); });
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
  return { messageId, type, senderRole: "coordinator", runId: "run-42", correlationId: "corr-1", receivedAt: "2026-10-20T03:16:58.000Z",
    summary, truncated: summary.length > 4096, ...extra };
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
  it("renders a user decision with options, expiry and the reply syntax", () => {
    const rendered = renderConversationNotice(notice("decision-" + APPROVAL_ID, "approval.request", decisionPayload));
    expect(rendered).toMatchObject({ kind: "user_decision", approvalId: APPROVAL_ID, ackToken: APPROVAL_ID, question: "Dùng schema v2 hay giữ v1?", requestedByRole: "coordinator" });
    expect(rendered.options).toEqual([{ number: 1, text: "Schema v2" }, { number: 2, text: "Giữ v1" }, { number: 3, text: "Hoãn" }]);
    expect(rendered.display).toContain(`[${APPROVAL_ID}] Coordinator cần bạn quyết định (run run-42)`);
    expect(rendered.display).toContain("Dùng schema v2 hay giữ v1?\n1. Schema v2\n2. Giữ v1\n3. Hoãn");
    expect(rendered.display).toContain("Hạn: 2026-10-20T04:00:00.000Z");
    expect(rendered.display).toContain(`Trả lời: ${APPROVAL_ID}: <số lựa chọn>`);
  });
  it("says there is no expiry when the request has none", () => {
    const { expiresAt: _omit, ...payload } = decisionPayload;
    const rendered = renderConversationNotice(notice("decision-" + APPROVAL_ID, "approval.request", payload));
    expect(rendered.display).toContain("Hạn: Không có hạn — đang chờ bạn trả lời");
  });
  it("falls back to a truncated update when the stored summary is cut off", () => {
    const full = JSON.stringify(decisionPayload);
    const rendered = renderConversationNotice({ messageId: "decision-" + APPROVAL_ID, type: "approval.request", summary: full.slice(0, 40), truncated: true });
    expect(rendered).toMatchObject({ kind: "update" });
    expect(rendered.ackToken).toBeUndefined();
    expect(rendered.display).toContain("bị cắt ngắn");
    expect(renderConversationNotice({ messageId: "m", type: "approval.request", summary: "{not json" }).kind).toBe("update");
  });
  it("renders blocked payloads with reason and numbered options, acknowledged by message id", () => {
    const payload = { kind: "workflow_blocked", reason: "Developer không phản hồi", options: ["Thử lại", "Dừng run"], runId: "run-42" };
    const rendered = renderConversationNotice(notice("blocked-1", "conversation.progress", payload));
    expect(rendered).toMatchObject({ kind: "blocked", ackToken: "blocked-1", runId: "run-42" });
    expect(rendered.display).toContain("Developer không phản hồi");
    expect(rendered.display).toContain("- Thử lại\n- Dừng run");
    expect(rendered.display).not.toContain("<số lựa chọn>");
    expect(rendered.reply).toBe(`Trả lời "tiếp tục run-42" sau khi khắc phục, hoặc "hủy run-42" để hủy run.`);
  });
  it("accepts the exact resume phrase a blocked notice suggests", () => {
    const rendered = renderConversationNotice(notice("blocked-2", "conversation.progress", { kind: "workflow_blocked", reason: "Handoff refused", options: ["Ask Coordinator to resend"], runId: "run-7" }));
    expect(rendered.display).toContain("tiếp tục run-7");
    expect(parseConversationResumeRequest(`tiếp tục ${rendered.runId}`)).toEqual({ runId: "run-7" });
    expect(renderConversationNotice(notice("blocked-3", "conversation.progress", { kind: "workflow_blocked", reason: "x", options: ["Retry"] })).reply)
      .not.toContain("<số lựa chọn>");
  });
  it("keeps other notices as short headlines", () => {
    const rendered = renderConversationNotice(notice("progress-1", "conversation.progress", { headline: "x" }));
    expect(rendered).toMatchObject({ kind: "update" });
    expect(rendered.ackToken).toBeUndefined();
  });
  it("tolerates partial notices from a host reply", () => {
    expect(renderConversationNotice({ messageId: "notice-1" }).display).toContain("Cập nhật từ runtime (notice)");
  });
  it("puts user decisions and blocks first in the MUST SHOW section", () => {
    const section = mustShowSection([
      notice("progress-1", "conversation.progress", { headline: "x" }),
      notice("decision-" + APPROVAL_ID, "approval.request", decisionPayload)
    ]);
    expect(section.startsWith("MUST SHOW TO USER VERBATIM:\n🔔")).toBe(true);
    expect(section.indexOf(APPROVAL_ID)).toBeLessThan(section.indexOf("ℹ️"));
    expect(mustShowSection([])).toBe("");
  });
  it("clips notification bodies while keeping the approval id and reply line", () => {
    const long = { ...decisionPayload, metadata: { ...decisionPayload.metadata, question: "q".repeat(1000) } };
    const body = notificationBody(renderConversationNotice(notice("decision-" + APPROVAL_ID, "approval.request", long)));
    expect(body.length).toBeLessThanOrEqual(400);
    expect(body).toContain(APPROVAL_ID);
    expect(body).toContain(`Trả lời: ${APPROVAL_ID}: <số lựa chọn>`);
    const short = notificationBody(renderConversationNotice(notice("decision-" + APPROVAL_ID, "approval.request", decisionPayload)));
    expect(short).toContain("Dùng schema v2 hay giữ v1?");
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
    expect(undisplayed.map(item => item.messageId)).toEqual(["decision-" + APPROVAL_ID]);
    expect(undisplayed[0]).toMatchObject({ reblocks: 0, type: "approval.request" });
    expect(typeof undisplayed[0]!.surfacedAt).toBe("string");
    // Surfacing again keeps the first time and creates no second receipt.
    await receipts.markConversationNoticesSurfaced(["decision-" + APPROVAL_ID]);
    expect(await receipts.recordNoticeReblock("decision-" + APPROVAL_ID)).toBe(1);
    expect(await receipts.recordNoticeReblock("decision-" + APPROVAL_ID)).toBe(2);
    expect(MAX_NOTICE_REBLOCKS).toBe(2);
    expect((await receipts.undisplayedUserFacingNotices())[0]!.reblocks).toBe(2);
    // Unknown, unsurfaced or non-user-facing ids are ignored, never marked displayed.
    expect(await receipts.markConversationNoticesDisplayed(["progress-1", "never-appended"])).toEqual([]);
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
    expect(rendered.display).toContain("Developer cần bạn quyết định");
    expect(rendered.display).toContain("Dùng schema nào?");
    expect(rendered.display).toContain("1. Schema v2\n2. Giữ v1");
    expect(rendered.display).toContain("Hạn: 2026-10-20T04:00:00.000Z");
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
