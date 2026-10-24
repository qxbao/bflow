import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RoleMessageSchema, type RoleMessage } from "@bflow/contracts";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { afterNudge, BFLOW_INBOX_NUDGE, inboxCheckIntervalMs, isProviderInputEmpty, NUDGE_BACKOFF_MS, nudgeDue, stripGhostSuggestion } from "../../src/agentic/conversation-inbox.js";
import { ConversationInboxNotifier, type ConversationInboxPorts } from "../../src/agentic/conversation-inbox-notifier.js";
import { buildDecisionRequestMessage, buildUserDecisionRequest } from "../../src/agentic/decision-routing.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanups.splice(0).reverse()) await action(); });
async function directory(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Captured live (2026-10-20, Claude Code in Herdr): after a turn Claude shows its next-prompt suggestion as faint (SGR 2) text.
const RULE = "\x1b[0m\x1b[38;2;136;136;136m" + "─".repeat(132) + "\x1b[0m";
const STATUS = "  \x1b[0m\x1b[38;2;255;107;128m⏵⏵ don't ask on\x1b[0m\x1b[38;2;153;153;153m (shift+tab to cycle) · ← 2 agents\x1b[0m";
const pane = (prompt: string) => ["  Earlier output", "", RULE, prompt, RULE, STATUS].join("\n");
const GHOST = pane("❯ \x1b[0m\x1b[2mapr-user-decision-588189f29a9d340eb3098379301bcc76c451c4fe: 1\x1b[0m");
const DRAFT = pane("❯ \x1b[0mtôi đang gõ dở");
const COLOURED_DRAFT = pane("❯ \x1b[38;2;255;2;2mtôi đang gõ dở\x1b[0m");

describe("Claude ghost suggestion versus typed draft", () => {
  it("treats the live faint ghost suggestion as an empty input box", () => {
    expect(isProviderInputEmpty("claude", stripGhostSuggestion(GHOST))).toBe(true);
    // The plain-text snapshot used before could not tell them apart and always failed closed.
    expect(isProviderInputEmpty("claude", GHOST.replace(/\x1b\[[0-9;:]*[@-~]/g, ""))).toBe(false);
  });

  it("keeps a typed draft, including one whose colour arguments contain a 2, as not empty", () => {
    expect(isProviderInputEmpty("claude", stripGhostSuggestion(DRAFT))).toBe(false);
    expect(isProviderInputEmpty("claude", stripGhostSuggestion(COLOURED_DRAFT))).toBe(false);
    // Faint text followed by normal typed text is still a draft.
    expect(isProviderInputEmpty("claude", stripGhostSuggestion(pane("❯ \x1b[2mghost\x1b[22m typed")))).toBe(false);
  });

  it("fails closed for other providers and unknown layouts", () => {
    expect(isProviderInputEmpty("codex", stripGhostSuggestion(GHOST))).toBe(false);
    expect(isProviderInputEmpty("claude", stripGhostSuggestion("\x1b[2mno prompt here\x1b[0m"))).toBe(false);
  });

  it("recognises Agy 1.4.5 > prompt with 38;5;8 placeholder text as empty and rejects a typed draft", () => {
    const agyRule = "\x1b[0m\x1b[38;5;8m" + "─".repeat(119) + "\x1b[0m";
    const agyStatus = "\x1b[0m\x1b[38;5;8m? for shortcuts                                                                \x1b[0m\x1b[38;5;2maccept-edits\x1b[0m\x1b[2m · Gemini 3.8 Flash · medium\x1b[0m";
    const agyIdle = [
      "  pong",
      "",
      agyRule,
      "\x1b[0m\x1b[38;5;12m>\x1b[0m \x1b[0m\x1b[38;5;8mAccept-edits mode: file edits auto-approved (shift+tab to cycle)\x1b[0m",
      agyRule,
      agyStatus
    ].join("\n");
    const agyDraft = [
      "  pong",
      "",
      agyRule,
      "\x1b[0m\x1b[38;5;12m>\x1b[0m \x1b[0mđang gõ dở",
      agyRule,
      agyStatus
    ].join("\n");
    expect(isProviderInputEmpty("agy", stripGhostSuggestion(agyIdle))).toBe(true);
    expect(isProviderInputEmpty("agy", stripGhostSuggestion(agyDraft))).toBe(false);
  });

  it("checks within five seconds by default and retries unsurfaced nudges with backoff", () => {
    expect(inboxCheckIntervalMs(undefined)).toBe(2_000);
    expect(inboxCheckIntervalMs("1000")).toBe(1_000);
    expect(inboxCheckIntervalMs("10")).toBe(2_000);
    const first = afterNudge(undefined, "a", 0);
    expect(nudgeDue(first, "a", NUDGE_BACKOFF_MS[0] - 1)).toBe(false);
    expect(nudgeDue(first, "a", NUDGE_BACKOFF_MS[0])).toBe(true);
    expect(afterNudge(first, "a", 10).nextAt).toBe(10 + NUDGE_BACKOFF_MS[1]);
    // A new waiting notice is never held back by an older backoff.
    expect(nudgeDue(first, "b", 1)).toBe(true);
  });
});

const REPOSITORY = "/tmp/bflow-idle-wake-repository";
const RUN = "run-943b18a9";
const accepted: RoleMessage = RoleMessageSchema.parse({ schema_version: 2, message_id: "p19-accepted", correlation_id: "corr-run", run_id: RUN,
  sender: { role: "coordinator" }, recipient: { role: "conversation" }, type: "delegation.accepted",
  payload: { delegationId: "del-1", sdlcStatus: "intake", headline: "Coordinator accepted the objective" },
  artifact_references: [], occurred_at: "2026-10-20T04:52:35.000Z", idempotency_key: "p19-accepted" });
const decision = buildUserDecisionRequest({ input: { runId: RUN, taskId: "planning", question: "Cấu hình runner unit_test thế nào?",
  options: ["Dùng pnpm test", "Tạm dừng run"] }, role: "coordinator", sessionId: "conv-1", revision: 1, generation: 0, now: "2026-10-20T04:53:00.000Z" });
const decisionMessage = buildDecisionRequestMessage({ request: decision, correlationId: "corr-run", sender: { role: "runtime" }, conversation: { role: "conversation" } });

/** Fake Herdr for the notifier: an idle Conversation pane showing `screen`, recording notifications and typed prompts. */
function ports(receipts: HostReceiptJournal, state: { now: number; status: string; screen: string }) {
  const typed: string[] = [], notified: string[] = [];
  const value: ConversationInboxPorts = { provider: "claude",
    unsurfacedNotices: () => receipts.unsurfacedConversationNotices(), undisplayedNotices: () => receipts.undisplayedUserFacingNotices(),
    conversationPaneId: async () => "w1:pF", agentStatus: async () => state.status, readPaneAnsi: async () => state.screen,
    notify: async (_title, body) => { notified.push(body); }, prompt: async (_pane, text) => { typed.push(text); }, now: () => state.now };
  return { value, typed, notified };
}

/** Runs the real Claude UserPromptSubmit hook for the typed nudge against a host socket backed by `receipts`. */
async function nudgeHook(receipts: HostReceiptJournal) {
  const root = await directory("bf-idle-wake-hook-");
  const socketPath = join(root, "host.sock"), methods: string[] = [];
  const server = createServer(socket => {
    let input = "";
    socket.on("data", async chunk => {
      input += String(chunk);
      if (!input.includes("\n")) return;
      const call = JSON.parse(input.split("\n")[0]!);
      methods.push(call.method);
      const value = call.method === "conversation_runtime_nudge"
        ? { notices: await receipts.unsurfacedConversationNotices(), undisplayed: await receipts.undisplayedUserFacingNotices() }
        : call.method === "conversation_notices_surfaced" ? (await receipts.markConversationNoticesSurfaced(call.params.messageIds), { recorded: true })
        : { recorded: true };
      socket.end(JSON.stringify({ ok: true, value }) + "\n");
    });
  });
  await new Promise<void>(accept => server.listen(socketPath, accept));
  cleanups.push(() => new Promise<void>(accept => server.close(() => accept())));
  const config = join(root, "role.json");
  await writeFile(config, JSON.stringify({ socketPath, token: "role-token", role: "conversation", provider: "claude", sessionId: "session", herdrBinary: "unused" }), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url)), "hook", config, "UserPromptSubmit"], {
    env: { ...process.env, HERDR_PANE_ID: "w1:pF", HERDR_SOCKET_PATH: "", BFLOW_ENVIRONMENT_ID: "env-test", BFLOW_LAUNCH_ID: "" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", chunk => stdout += String(chunk));
  const code = new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("exit", accept); });
  child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: BFLOW_INBOX_NUDGE }));
  return { code: await code, stdout, methods };
}

describe.skipIf(process.platform === "win32")("Idle Conversation wake-up (incident 2026-10-20)", () => {
  it("nudges an idle Conversation for a new user_decision after Stop consumed delegation.accepted, and the nudge turn shows it verbatim", async () => {
    const receipts = new HostReceiptJournal(join(await directory("bflow-idle-wake-"), "receipts"), REPOSITORY, "session-1");
    const notifier = new ConversationInboxNotifier();
    const state = { now: 0, status: "idle", screen: GHOST };
    const herdr = ports(receipts, state);

    // 04:52:35 delegation.accepted arrives and the Stop hook surfaces it; Conversation goes idle.
    await receipts.appendConversationNotice(accepted);
    await receipts.markConversationNoticesSurfaced([accepted.message_id]);
    // This fixture models a consumed AND displayed update; surfacing alone now retains display recovery.
    await receipts.markConversationNoticesDisplayed([accepted.message_id]);
    expect(await notifier.tick(herdr.value)).toBe("idle");

    // 04:53:00 the user_decision approval.request is written to the inbox; the next pass (≤ 2 s) types the nudge.
    await receipts.appendConversationNotice(decisionMessage);
    state.now = 2_000;
    expect(await notifier.tick(herdr.value)).toBe("nudged");
    expect(herdr.typed).toEqual([BFLOW_INBOX_NUDGE]);
    expect(herdr.notified.join("\n")).toContain(decision.approvalId);

    // The nudge turn's hook puts the question first, verbatim, and only then marks it surfaced. No user_prompt call happens.
    const hook = await nudgeHook(receipts);
    expect(hook.code).toBe(0);
    const context = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext as string;
    expect(context.startsWith("Trusted Bflow inbox nudge, not a user message and not an approval. requiresConversationDecision=false.")).toBe(true);
    expect(context.indexOf("MUST SHOW TO USER VERBATIM:")).toBeLessThan(context.indexOf(decision.approvalId));
    expect(context).toContain(decision.approvalId);
    expect(context).toContain("Cấu hình runner unit_test thế nào?\n1. Dùng pnpm test\n2. Tạm dừng run");
    expect(hook.methods).toEqual(["conversation_runtime_nudge", "conversation_notices_surfaced"]);

    // Once surfaced there is nothing left to nudge.
    state.now = 60_000;
    expect(await notifier.tick(herdr.value)).not.toBe("nudged");
    expect(herdr.typed).toHaveLength(1);
  });

  it("retries with backoff while the notice stays unsurfaced and never types into a busy pane or over a draft", async () => {
    const receipts = new HostReceiptJournal(join(await directory("bflow-idle-wake-"), "receipts"), REPOSITORY, "session-1");
    const notifier = new ConversationInboxNotifier();
    const state = { now: 0, status: "working", screen: GHOST };
    const herdr = ports(receipts, state);
    await receipts.appendConversationNotice(decisionMessage);

    expect(await notifier.tick(herdr.value)).toBe("pane_busy");
    state.status = "idle"; state.screen = DRAFT; state.now = 1_000;
    expect(await notifier.tick(herdr.value)).toBe("input_not_empty");
    expect(herdr.typed).toHaveLength(0);

    state.screen = GHOST; state.now = 2_000;
    expect(await notifier.tick(herdr.value)).toBe("nudged");
    // The typed nudge was lost (no turn surfaced it): no spam inside the backoff, then a retry.
    state.now = 2_000 + NUDGE_BACKOFF_MS[0] - 1;
    expect(await notifier.tick(herdr.value)).toBe("nudge_backoff");
    state.now = 2_000 + NUDGE_BACKOFF_MS[0];
    expect(await notifier.tick(herdr.value)).toBe("nudged");
    expect(herdr.typed).toEqual([BFLOW_INBOX_NUDGE, BFLOW_INBOX_NUDGE]);
  });
});
