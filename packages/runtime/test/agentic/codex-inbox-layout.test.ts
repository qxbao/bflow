import { describe, expect, it } from "vitest";
import { isProviderInputEmpty, stripGhostSuggestion } from "../../src/agentic/conversation-inbox.js";

// Sanitized footer captured read-only from the incident's real Codex pane on 2026-10-20.
const idle = "\x1b[0m\x1b[1m›\x1b[0m \x1b[0m\x1b[2mAsk Codex to do anything\x1b[0m\n\n" +
  "  \x1b[0m\x1b[38;2;246;226;183mGPT-6.1-Sol medium \x1b[0m· \x1b[0m/tmp/bflow-fixture\x1b[0m\n" +
  "  \x1b[0m\x1b[1m?\x1b[0m for shortcuts    ⚠ 1 warning · f2 to view";

describe("Codex Conversation input safety", () => {
  it("recognizes the observed idle layout without treating the dim placeholder as a draft", () => {
    expect(isProviderInputEmpty("codex", stripGhostSuggestion(idle))).toBe(true);
  });
  it("preserves real typed drafts, including text matching the placeholder", () => {
    const draft = idle.replace("\x1b[2mAsk Codex to do anything", "Ask Codex to do anything");
    expect(isProviderInputEmpty("codex", stripGhostSuggestion(draft))).toBe(false);
    expect(isProviderInputEmpty("codex", stripGhostSuggestion(idle.replace("Ask Codex to do anything", "\x1b[0mmy unsent request")))).toBe(false);
  });
  it("rejects wrapped drafts and unknown/modal layouts", () => {
    expect(isProviderInputEmpty("codex", stripGhostSuggestion(idle.replace("\n\n", "\nwrapped draft\n")))).toBe(false);
    expect(isProviderInputEmpty("codex", stripGhostSuggestion(idle.replace("for shortcuts", "approve this operation")))).toBe(false);
    expect(isProviderInputEmpty("codex", "›\n")).toBe(false);
    expect(isProviderInputEmpty("unknown", stripGhostSuggestion(idle))).toBe(false);
  });
});

it("bounds automatic Conversation nudges across notifier restart without consuming the notice", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { HostReceiptJournal } = await import("../../src/agentic/host-receipts.js");
  const { ConversationInboxNotifier } = await import("../../src/agentic/conversation-inbox-notifier.js");
  const { RoleMessageSchema } = await import("@bflow/contracts");
  const root = await mkdtemp("/tmp/bflow-nudge-budget-");
  try {
    const receipts = new HostReceiptJournal(root, root, "test-session");
    await receipts.appendConversationNotice(RoleMessageSchema.parse({ schema_version: 2, message_id: "blocked-notice", correlation_id: "correlation",
      run_id: "run", sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "conversation.progress",
      payload: { kind: "workflow_blocked", reason: "Capability missing", options: ["Resume", "Cancel"] }, artifact_references: [],
      occurred_at: new Date().toISOString(), idempotency_key: "blocked-notice" }));
    let prompts = 0;
    for (let restart = 0; restart < 5; restart++) {
      const recovered = new HostReceiptJournal(root, root, "test-session");
      await new ConversationInboxNotifier().tick({ provider: "codex", now: () => Date.now(),
        unsurfacedNotices: () => recovered.unsurfacedConversationNotices(), undisplayedNotices: () => recovered.undisplayedUserFacingNotices(),
        conversationPaneId: async () => "pane", agentStatus: async () => "idle", readPaneAnsi: async () => idle,
        notify: async () => undefined, prompt: async () => { prompts++; },
        reserveNudge: ids => recovered.reserveConversationNudge(ids) });
    }
    expect(prompts).toBe(3);
    expect(await receipts.unsurfacedConversationNotices()).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
