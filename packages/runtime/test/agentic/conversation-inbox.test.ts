import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoleMessageSchema, type RoleMessage } from "@bflow/contracts";
import { AgenticJournal } from "../../src/agentic/journal.js";
import { HerdrOutbox } from "../../src/agentic/outbox.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { BFLOW_INBOX_NUDGE, isProviderInputEmpty } from "../../src/agentic/conversation-inbox.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanups.splice(0).reverse()) await action(); });
async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-conversation-inbox-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const REPOSITORY = "/tmp/bflow-inbox-repository";
function notice(id: string, payload: unknown = { headline: "Progress" }): RoleMessage {
  return RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: "correlation-1", run_id: "run-1",
    sender: { role: "coordinator", agent_id: "coordinator-agent", pane_id: "pane-coordinator" },
    recipient: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" },
    type: "conversation.progress", payload, artifact_references: [], occurred_at: "2026-10-20T00:00:00.000Z", idempotency_key: `key-${id}` });
}
/** Ports for the outbox only. Lease and transport fakes record calls, so a leased or transport send would be visible. */
function outboxPorts(deliver: (message: RoleMessage) => Promise<void>) {
  const calls = { deliver: [] as string[], send: 0, acquire: 0 };
  const ports = {
    deliverToConversation: async (message: RoleMessage) => { calls.deliver.push(message.message_id); await deliver(message); },
    panes: { getRoleBinding: async () => ({ ok: true as const, value: { paneId: "pane-conversation", agentId: "conversation-agent" } }) },
    transport: { send: async () => { calls.send++; return { ok: false as const, error: { code: "unsupported", retryable: false, message: "unused" } }; } },
    registry: { acquireLease: async () => { calls.acquire++; return { ok: false as const, error: { code: "unsupported", retryable: false, message: "unused" } }; } }
  } as unknown as AgenticRuntimePorts;
  return { ports, calls };
}

describe("Conversation inbox delivery", () => {
  it("only writes ahead Conversation messages under the lock, without a Gateway call, lease or transport", async () => {
    const journal = new AgenticJournal(await directory(), REPOSITORY);
    const { ports, calls } = outboxPorts(async () => undefined);
    await journal.exclusive(async (state, save) => {
      const outbox = new HerdrOutbox(ports, state, save);
      outbox.enqueue(notice("progress-1"));
      await outbox.flush(async () => undefined);
    });
    expect(calls).toEqual({ deliver: [], send: 0, acquire: 0 });
    // The write-ahead survives a reload without request, handle or lease, and a later locked pass keeps it for Runtime.
    await journal.exclusive(async (state, save) => {
      expect(state.outbound[0]).toMatchObject({ status: "sending" });
      expect(state.outbound[0]!.lease).toBeUndefined();
      expect(state.outbound[0]!.request).toBeUndefined();
      await new HerdrOutbox(ports, state, save).flush(async () => undefined);
      expect(state.outbound[0]).toMatchObject({ status: "sending" });
    });
    await journal.exclusive(async (state, save) => { state.outbound[0]!.status = "delivered"; await save(); });
    await journal.exclusive(async state => { expect(state.outbound[0]).toMatchObject({ status: "delivered" }); });
  });
});

describe("Conversation notice inbox", () => {
  const notices = (value: HostReceiptJournal) => value.unsurfacedConversationNotices();

  it("appends idempotently, surfaces once and survives reload", async () => {
    const root = await directory();
    const receipts = new HostReceiptJournal(join(root, "receipts"), REPOSITORY, "session-1");
    expect(await receipts.appendConversationNotice(notice("notice-1"))).toBe(true);
    expect(await receipts.appendConversationNotice(notice("notice-1"))).toBe(false);
    await receipts.appendConversationNotice(notice("notice-2"));
    const pending = await notices(receipts);
    expect(pending.map(item => item.messageId).sort()).toEqual(["notice-1", "notice-2"]);
    expect(pending[0]).toMatchObject({ type: "conversation.progress", senderRole: "coordinator", runId: "run-1", correlationId: "correlation-1", truncated: false });
    await receipts.markConversationNoticesSurfaced(["notice-1"]);
    await receipts.markConversationNoticesSurfaced(["notice-1"]);
    const reloaded = new HostReceiptJournal(join(root, "receipts"), REPOSITORY, "session-1");
    expect((await notices(reloaded)).map(item => item.messageId)).toEqual(["notice-2"]);
    await expect(reloaded.markConversationNoticesSurfaced(["never-appended"])).rejects.toThrow("Unknown Conversation notice");
  });

  it("truncates an oversized summary to the inbox limit", async () => {
    const receipts = new HostReceiptJournal(join(await directory(), "receipts"), REPOSITORY, "session-1");
    await receipts.appendConversationNotice(notice("notice-big", { text: "x".repeat(6000) }));
    const [item] = await notices(receipts);
    expect(item).toMatchObject({ truncated: true });
    expect(item!.summary.length).toBe(4096);
  });
});

describe("isProviderInputEmpty", () => {
  const emptyClaude = "Previous answer\n╭────────────────────╮\n│ >                  │\n╰────────────────────╯\n\n";
  it("accepts only a verifiably empty Claude input box", () => {
    expect(isProviderInputEmpty("claude", emptyClaude)).toBe(true);
    expect(isProviderInputEmpty("claude", "╭──╮\n│ > │\n╰──╯")).toBe(true);
  });
  it("rejects a draft, placeholder, other providers and unrecognised layouts", () => {
    expect(isProviderInputEmpty("claude", emptyClaude.replace("│ >                  │", "│ > fix the bug     │"))).toBe(false);
    expect(isProviderInputEmpty("claude", emptyClaude.replace("│ >                  │", "│ > Try \"refactor\"  │"))).toBe(false);
    expect(isProviderInputEmpty("codex", emptyClaude)).toBe(false);
    expect(isProviderInputEmpty("claude", "garbage")).toBe(false);
    expect(isProviderInputEmpty("claude", "")).toBe(false);
    expect(isProviderInputEmpty("claude", "│ >  │\n╰──╯\n" + "trailing text")).toBe(false);
  });
  it("exposes the fixed nudge as a non-user marker", () => {
    expect(BFLOW_INBOX_NUDGE).toContain("[bflow]");
  });
});
