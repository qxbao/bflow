import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

const APPROVAL_ID = "apr-user-decision-0123456789abcdef";
const decisionNotice = {
  messageId: "decision-" + APPROVAL_ID, type: "approval.request", senderRole: "coordinator", runId: "run-42", correlationId: "corr-1",
  receivedAt: "2026-10-20T03:16:58.000Z", truncated: false,
  summary: JSON.stringify({ approvalId: APPROVAL_ID, runId: "run-42", metadata: { kind: "user_decision", question: "Dùng schema v2 hay giữ v1?",
    requestedByRole: "coordinator", options: ["Schema v2", "Giữ v1"] } })
};

/** A fake host socket answering each RPC from `replies`; a real Claude Stop hook process runs against it. */
async function fixture(replies: Record<string, unknown>, provider = "claude") {
  const root = await mkdtemp("/tmp/bf-notice-hook-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "host.sock"), calls: { method: string; params: any }[] = [];
  const server = createServer(socket => {
    let input = "";
    socket.on("data", chunk => {
      input += String(chunk);
      if (!input.includes("\n")) return;
      const call = JSON.parse(input.split("\n")[0]!);
      calls.push(call);
      socket.end(JSON.stringify({ ok: true, value: replies[call.method] ?? { recorded: true } }) + "\n");
    });
  });
  await new Promise<void>(accept => server.listen(socketPath, accept));
  cleanup.push(() => new Promise<void>(accept => server.close(() => accept())));
  const path = join(root, "role.json");
  await writeFile(path, JSON.stringify({ socketPath, token: "role-token", role: "conversation", provider, sessionId: "session", herdrBinary: "unused" }), { mode: 0o600 });
  const transcript = (lines: unknown[]) => { const file = join(root, "transcript.jsonl"); return writeFile(file, lines.map(line => JSON.stringify(line)).join("\n")).then(() => file); };
  return { calls, transcript, invoke: async (event: string, input: object) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url)), "hook", path, event], {
      env: { ...process.env, HERDR_PANE_ID: "pane-1", HERDR_SOCKET_PATH: "", BFLOW_ENVIRONMENT_ID: "env-test", BFLOW_LAUNCH_ID: "" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += String(chunk));
    child.stderr.on("data", chunk => stderr += String(chunk));
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
      child.once("error", reject);
      child.once("exit", code => accept({ code, stdout, stderr }));
    });
    child.stdin.end(JSON.stringify(input));
    return done;
  } };
}

const assistantTurn = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

describe.skipIf(process.platform === "win32")("Conversation user decision display hooks", () => {
  it("blocks Stop with the question and numbered options first, then marks the notice surfaced", async () => {
    const f = await fixture({ conversation_notices: { notices: [decisionNotice], undisplayed: [] } });
    const result = await f.invoke("Stop", { hook_event_name: "Stop", session_id: "native-1", stop_hook_active: false, transcript_path: await f.transcript([]) });
    expect(result.code).toBe(0);
    const block = JSON.parse(result.stdout);
    expect(block.decision).toBe("block");
    expect(block.reason.startsWith("MUST SHOW TO USER VERBATIM:\n")).toBe(true);
    expect(block.reason).toContain("Dùng schema v2 hay giữ v1?\n1. Schema v2\n2. Giữ v1");
    expect(block.reason).toContain(`Trả lời: ${APPROVAL_ID}: <số lựa chọn>`);
    expect(block.reason).toContain("Bflow Runtime updates");
    expect(f.calls.map(call => call.method)).toEqual(["conversation_pending_decision", "conversation_notices", "conversation_notices_surfaced"]);
  });

  it("re-blocks a surfaced decision the final turn did not name, at most twice", async () => {
    const undisplayed = { ...decisionNotice, surfacedAt: "2026-10-20T03:17:00.000Z", reblocks: 0 };
    const f = await fixture({ conversation_notices: { notices: [], undisplayed: [undisplayed] } });
    const transcript = await f.transcript([{ type: "user", message: { content: "hi" } }, assistantTurn("Đã xem, không có gì mới.")]);
    const result = await f.invoke("Stop", { hook_event_name: "Stop", session_id: "native-1", transcript_path: transcript });
    expect(JSON.parse(result.stdout).reason.startsWith("MUST SHOW TO USER VERBATIM:")).toBe(true);
    expect(f.calls.map(call => call.method)).toEqual(["conversation_pending_decision", "conversation_notices", "conversation_notices_reblocked"]);
    expect(f.calls[2]!.params.messageIds).toEqual([decisionNotice.messageId]);

    const exhausted = await fixture({ conversation_notices: { notices: [], undisplayed: [{ ...undisplayed, reblocks: 2 }] } });
    const quiet = await exhausted.invoke("Stop", { hook_event_name: "Stop", session_id: "native-1", transcript_path: transcript });
    expect(quiet.stdout).toBe("");
    expect(exhausted.calls.map(call => call.method)).toEqual(["conversation_pending_decision", "conversation_notices"]);
  });

  it("records the display once the final Conversation turn names the approval id, and stays silent", async () => {
    const undisplayed = { ...decisionNotice, surfacedAt: "2026-10-20T03:17:00.000Z", reblocks: 1 };
    const f = await fixture({ conversation_notices: { notices: [], undisplayed: [undisplayed] } });
    const transcript = await f.transcript([{ type: "user", message: { content: "hi" } },
      assistantTurn(`Coordinator hỏi bạn: Dùng schema v2 hay giữ v1? Trả lời ${APPROVAL_ID}: 1`)]);
    const result = await f.invoke("Stop", { hook_event_name: "Stop", session_id: "native-1", transcript_path: transcript });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(f.calls.map(call => call.method)).toEqual(["conversation_pending_decision", "conversation_notices", "conversation_notices_displayed"]);
    expect(f.calls[2]!.params.messageIds).toEqual([decisionNotice.messageId]);
  });

  it("ignores the approval id in an earlier turn when the final turn does not show it", async () => {
    const undisplayed = { ...decisionNotice, surfacedAt: "2026-10-20T03:17:00.000Z", reblocks: 0 };
    const f = await fixture({ conversation_notices: { notices: [], undisplayed: [undisplayed] } });
    const transcript = await f.transcript([assistantTurn(`Đã hiển thị ${APPROVAL_ID}`), { type: "user", message: { content: "tiếp" } }, assistantTurn("Ok")]);
    const result = await f.invoke("Stop", { hook_event_name: "Stop", session_id: "native-1", transcript_path: transcript });
    expect(JSON.parse(result.stdout).decision).toBe("block");
    expect(f.calls.map(call => call.method)).not.toContain("conversation_notices_displayed");
  });

  it.each(["codex", "claude"])("refuses a %s Stop while the latest user turn never reached conversation_decide", async provider => {
    const f = await fixture({ conversation_pending_decision: { messageId: "user-c77c", content: "Tích hợp nốt Context7 đi", attempt: 1 },
      conversation_notices: { notices: [decisionNotice], undisplayed: [] } }, provider);
    const result = await f.invoke("Stop", { hook_event_name: "Stop", session_id: "native-1", stop_hook_active: false, last_assistant_message: "Hook chưa cung cấp messageId" });
    expect(result.code).toBe(0);
    const block = JSON.parse(result.stdout);
    expect(block.decision).toBe("block");
    expect(block.reason).toContain("messageId=user-c77c");
    expect(block.reason).toContain("Tích hợp nốt Context7 đi");
    expect(block.reason).toContain("Call conversation_decide now");
    // Notices wait for the next Stop; the decision refusal is the only output of this one.
    expect(f.calls.map(call => call.method)).toEqual(["conversation_pending_decision"]);
  });

  it("reports a trusted approval failure on Stop without asking for an ordinary decision or automatic retry", async () => {
    const f = await fixture({ conversation_pending_decision: { approvalFailure: {
      messageId: "failed-approval", error: "Herdr unavailable", note: "The approval was NOT recorded and nothing was applied." }, attempt: 1 } });
    const result = await f.invoke("Stop", { hook_event_name: "Stop", session_id: "native-1" });
    expect(result.stdout).not.toBe("");
    const blocked = JSON.parse(result.stdout);
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain("Herdr unavailable");
    expect(blocked.reason).toContain("NOT recorded");
    expect(blocked.reason).toContain("Do not call conversation_decide");
    expect(blocked.reason).not.toContain("Call conversation_decide now");
    expect(f.calls.map(call => call.method)).toEqual(["conversation_pending_decision"]);
  });

  it("requires the explicit original ID when Stop resumes a suspended ordinary turn", async () => {
    const f = await fixture({ conversation_pending_decision: { messageId: "user-original", content: "Original approved work", requiresExplicitMessageId: true, attempt: 1 } });
    const result = await f.invoke("Stop", { hook_event_name: "Stop", session_id: "native-1" });
    const reason = JSON.parse(result.stdout).reason;
    expect(reason).toContain("explicitly");
    expect(reason).toContain("user-original");
    expect(reason).toContain("newer corrections or cancellation");
    expect(reason).not.toContain("messageId may be omitted");
  });

  it("acknowledges a Codex display from last_assistant_message and does not rely on a Claude transcript", async () => {
    const undisplayed = { ...decisionNotice, surfacedAt: "2026-10-20T03:17:00.000Z", reblocks: 0 };
    const f = await fixture({ conversation_notices: { notices: [decisionNotice], undisplayed: [undisplayed] } }, "codex");
    const result = await f.invoke("Stop", { hook_event_name: "Stop", session_id: "native-1", stop_hook_active: false,
      transcript_path: null, last_assistant_message: `Coordinator hỏi bạn: Dùng schema v2 hay giữ v1? Trả lời ${APPROVAL_ID}: 1` });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(f.calls.map(call => call.method)).toEqual(["conversation_pending_decision", "conversation_notices", "conversation_notices_displayed"]);
    expect(f.calls[2]!.params.messageIds).toEqual([decisionNotice.messageId]);
  });

  it("puts the MUST SHOW section first in the inbox nudge context", async () => {
    const f = await fixture({ conversation_runtime_nudge: { notices: [decisionNotice], undisplayed: [] } });
    const result = await f.invoke("UserPromptSubmit", { hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: "[bflow] Có cập nhật mới từ Runtime" });
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("not a user message and not an approval");
    expect(context).toContain("requiresConversationDecision=false");
    expect(context).toContain("Do not call conversation_decide");
    expect(context).toContain("do not ask the user to repeat");
    expect(f.calls.map(call => call.method)).toEqual(["conversation_runtime_nudge", "conversation_notices_surfaced"]);
    expect(context.indexOf("MUST SHOW TO USER VERBATIM:")).toBeLessThan(context.indexOf("Dùng schema v2"));
    expect(context.indexOf("MUST SHOW TO USER VERBATIM:")).toBeLessThan(context.indexOf("Runtime updates:"));
  });

  it("directs an explicit resume turn and its Stop reminder to the existing run", async () => {
    const f = await fixture({ user_prompt: { messageId: "user-resume", requiresConversationDecision: true, notices: [], undisplayed: [] },
      conversation_pending_decision: { messageId: "user-resume", content: "resume run-existing", attempt: 1 } });
    const result = await f.invoke("UserPromptSubmit", { hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: "resume run-existing" });
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("resume_run");
    expect(context).toContain("conversation_only");
    expect(context).not.toContain("Call conversation_decide first");
    const stopped = await f.invoke("Stop", { hook_event_name: "Stop", session_id: "native-1" });
    const reason = JSON.parse(stopped.stdout).reason;
    expect(reason).toContain("resume_run");
    expect(reason).toContain("existing runId");
    expect(reason).not.toContain("nothing reached the Coordinator");
  });

  it("requires exactly one decision for an ordinary physical user turn", async () => {
    const f = await fixture({ user_prompt: { messageId: "user-real", requiresConversationDecision: true, notices: [], undisplayed: [] } });
    const result = await f.invoke("UserPromptSubmit", { hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: "hello" });
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("requiresConversationDecision=true. Call conversation_decide first");
    expect(f.calls.map(call => call.method)).toEqual(["user_prompt"]);
  });

  it("shows user decisions in the user-turn context before the Conversation JSON", async () => {
    const f = await fixture({ user_prompt: { messageId: "user-1", notices: [decisionNotice], undisplayed: [] } });
    const result = await f.invoke("UserPromptSubmit", { hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: "hello" });
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    expect(context.startsWith("Trusted Bflow user turn: messageId=user-1; requiresConversationDecision=false.")).toBe(true);
    expect(context).not.toContain("Call conversation_decide first");
    expect(context).toContain("Do not call conversation_decide");
    expect(context.indexOf("MUST SHOW TO USER VERBATIM:")).toBeLessThan(context.indexOf("Trusted Bflow user turn and Conversation context:"));
    expect(context).toContain("Trusted Bflow user turn and Conversation context:");
  });
});
