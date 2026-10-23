import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PaneBindingSchema, SessionManifestSchema } from "@bflow/contracts";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostConversationIntake } from "../../src/agentic/host-conversation.js";
import { availableTools } from "../../src/agentic/host.js";

describe("Chat-owned Conversation decisions", () => {
  it("advertises a structured decision tool only to Conversation", () => {
    expect(availableTools("conversation").find(tool => tool.name === "conversation_decide")?.inputSchema)
      .toMatchObject({ required: ["decision"], additionalProperties: false });
    expect(availableTools("coordinator").some(tool => tool.name === "conversation_decide")).toBe(false);
  });
});

const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bflow-chat-intake-")); cleanups.push(directory);
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "chat-binding", sessionId: "herdr-session", role: "conversation",
    agentId: "chat", paneId: "chat-pane", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude",
    cwd: directory, readOnlyWorkspace: true, permanent: true, session: { source: "herdr:claude", kind: "id", value: "native-chat" },
    isolationMode: "dedicated_pane", transportState: "idle", boundAt: "2026-10-19T00:00:00.000Z" });
  const applied: unknown[] = [];
  const replies = z.object({ intent: z.literal("conversation_only"), directReply: z.string().min(1) }).strict();
  const port = {
    async getContext() { return { pendingClarifications: { "corr-existing": { unresolvedQuestions: ["A or B?"] } } }; },
    async validateDecision(_input: unknown): Promise<void> {},
    async parseDecision(input: unknown) { return replies.parse(input); },
    async handleTrustedApproval(_input: unknown): Promise<unknown | undefined> { return undefined; },
    async handleUserTurn(input: unknown): Promise<unknown> { applied.push(input); return { ok: true, value: { recognizedIntent: "conversation_only", marker: applied.length } }; }
  };
  const journal = () => new HostReceiptJournal(directory, directory, "herdr-session");
  const reopen = () => new HostConversationIntake(journal(), () => port);
  const intake = reopen();
  const turn = (messageId: string, content = "Tạo spike: khảo sát quyền MCP của từng role") => ({ messageId, content, conversationSessionId: "chat-session", userId: "human" });
  return { directory, binding, port, applied, intake, reopen, journal, turn };
}
describe("trusted raw turns and model decision receipts", () => {
  it("records a read-only spike without classifying or dispatching it, then injects the original user provenance", async () => {
    const f = await fixture(), received = await f.intake.receive(f.binding, f.turn("user-1"));
    expect(received).toMatchObject({ messageId: "user-1", requiresConversationDecision: true,
      context: { pendingClarifications: { "corr-existing": { unresolvedQuestions: ["A or B?"] } } } });
    expect(f.applied).toEqual([]);
    const decision = { intent: "conversation_only", directReply: "Recorded" };
    await f.reopen().decide(f.binding, { messageId: "user-1", decision });
    expect(f.applied).toEqual([{ sessionId: "chat-session", messageId: "user-1", content: f.turn("user-1").content, occurredAt: expect.any(String),
      provenance: { origin: "user", authenticatedUser: true, userId: "human", paneId: "chat-pane", channel: "herdr_attach" },
      conversationDecision: decision }]);
  });
  it("persists Runtime nudge boundaries without reusing previous user authorization", async () => {
    const f = await fixture();
    await f.intake.receive(f.binding, f.turn("user-1", "tiếp tục"));
    const decision = { intent: "conversation_only", directReply: "Resuming" };
    await f.intake.decide(f.binding, { decision });
    await f.intake.runtimeNudge(f.binding);
    const refreshed = { ...f.binding, transportState: "working" as const, lastHeartbeatAt: new Date().toISOString() };
    await f.reopen().runtimeNudge(refreshed);
    await expect(f.reopen().decide(refreshed, { decision })).rejects.toThrow("Runtime nudge");
    await expect(f.reopen().decide(f.binding, { messageId: "user-1", decision })).rejects.toThrow("Runtime nudge");
    await expect(f.journal().authorizeConversationResume(refreshed, "user-1", "run-existing")).rejects.toThrow("Runtime nudge");
    expect(await f.reopen().pendingDecision(f.binding)).toBeUndefined();
    expect(await f.journal().conversationTurns()).toHaveLength(1);
    expect(await f.journal().humanDecisions()).toEqual([]);
    expect(f.applied).toHaveLength(1);
    await f.intake.receive(refreshed, f.turn("user-2", "tiếp tục"));
    await expect(f.journal().authorizeConversationResume(refreshed, "user-2", "run-existing")).resolves.toBeUndefined();
    expect(await f.reopen().pendingDecision(refreshed)).toMatchObject({ messageId: "user-2" });
    const args = { decision: { intent: "conversation_only", directReply: "New user turn" } };
    const result = await f.intake.decide(refreshed, args);
    expect(await f.reopen().decide(refreshed, args)).toEqual(result);
    expect(f.applied).toHaveLength(2);
  });
  it("does not demand a decision for an older undecided turn during a Runtime nudge", async () => {
    const f = await fixture();
    await f.intake.receive(f.binding, f.turn("user-unfinished"));
    expect(await f.intake.pendingDecision(f.binding)).toMatchObject({ messageId: "user-unfinished" });
    await f.intake.runtimeNudge(f.binding);
    expect(await f.reopen().pendingDecision(f.binding)).toBeUndefined();
    expect(await f.journal().conversationDecision("user-unfinished")).toBeUndefined();
    expect(f.applied).toEqual([]);
    const next = await f.reopen().receive(f.binding, f.turn("user-new", "Báo trạng thái trước, đừng đổi phạm vi"));
    expect(next).toMatchObject({ recoverableUserTurns: [{ messageId: "user-unfinished", content: f.turn("user-unfinished").content }] });
    const recovered = { messageId: "user-unfinished", decision: { intent: "conversation_only", directReply: "Original request considered with current correction" } };
    await expect(f.reopen().decide(f.binding, recovered)).rejects.toThrow("latest trusted input");
    await f.reopen().decide(f.binding, { decision: { intent: "conversation_only", directReply: "New correction recorded" } });
    expect(await f.reopen().pendingDecision(f.binding)).toMatchObject({ messageId: "user-unfinished", requiresExplicitMessageId: true });
    const result = await f.reopen().decide(f.binding, recovered);
    expect(await f.reopen().decide(f.binding, recovered)).toEqual(result);
    expect(f.applied.map(value => (value as { messageId: string }).messageId)).toEqual(["user-new", "user-unfinished"]);
    expect(await f.reopen().pendingDecision(f.binding)).toBeUndefined();
    expect(await f.journal().humanDecisions()).toEqual([]);
  });
  it.each([{ mode: "failed", priorIntent: false }, { mode: "queued", priorIntent: false }, { mode: "queued", priorIntent: true }] as const)(
    "keeps the newer $mode decision ahead of an older suspended turn (prior intent: $priorIntent) until its result commits", async ({ mode, priorIntent }) => {
    const f = await fixture();
    const oldArgs = { messageId: "older", decision: { intent: "conversation_only", directReply: "Resolve the original with the correction" } };
    await f.intake.receive(f.binding, f.turn("older", "Implement the original request"));
    if (priorIntent) await f.journal().recordConversationIntent("older", oldArgs.decision);
    await f.intake.runtimeNudge(f.binding);
    await f.reopen().receive(f.binding, f.turn("newer", "Consider this correction before doing the old work"));
    let ready = false;
    f.port.handleUserTurn = async input => {
      if ((input as { messageId: string }).messageId === "newer" && !ready) {
        if (mode === "failed") throw new Error("Latest correction was not applied");
        return { ok: true, value: { recognizedIntent: "conversation_only", queuedBecauseBusy: true } };
      }
      f.applied.push(input);
      return { ok: true, value: { recognizedIntent: "conversation_only", queuedBecauseBusy: false } };
    };
    const latestArgs = { decision: { intent: "conversation_only", directReply: "Apply the current correction first" } };
    if (mode === "failed") await expect(f.intake.decide(f.binding, latestArgs)).rejects.toThrow("Latest correction was not applied");
    else expect(await f.intake.decide(f.binding, latestArgs)).toMatchObject({ value: { queuedBecauseBusy: true } });
    expect(await f.journal().conversationDecision("newer")).toEqual({ decision: latestArgs.decision });
    expect.soft(await f.reopen().pendingDecision(f.binding)).toMatchObject({ messageId: "newer" });
    await expect(f.reopen().decide(f.binding, oldArgs)).rejects.toThrow("latest trusted input");
    expect(f.applied).toEqual([]);
    ready = true;
    const current = await f.reopen().decide(f.binding, { ...latestArgs, messageId: "newer" });
    expect(await f.reopen().decide(f.binding, latestArgs)).toEqual(current);
    if (!priorIntent) expect(await f.reopen().pendingDecision(f.binding)).toMatchObject({ messageId: "older", requiresExplicitMessageId: true });
    const recovered = await f.reopen().decide(f.binding, oldArgs);
    expect(await f.reopen().decide(f.binding, oldArgs)).toEqual(recovered);
    expect(f.applied.map(value => (value as { messageId: string }).messageId)).toEqual(["newer", "older"]);
  });
  it("binds a decision without messageId to the pane's latest trusted turn and reports undecided turns", async () => {
    const f = await fixture();
    await f.intake.receive(f.binding, f.turn("user-1"));
    await f.intake.decide(f.binding, { messageId: "user-1", decision: { intent: "conversation_only", directReply: "First" } });
    await f.intake.receive(f.binding, f.turn("user-2", "Tích hợp nốt Context7 đi"));
    expect(await f.reopen().pendingDecision(f.binding)).toEqual({ messageId: "user-2", content: "Tích hợp nốt Context7 đi" });
    const decision = { intent: "conversation_only", directReply: "Second" };
    await f.reopen().decide(f.binding, { decision });
    expect(f.applied.at(-1)).toMatchObject({ messageId: "user-2", content: "Tích hợp nốt Context7 đi", conversationDecision: decision });
    expect(await f.reopen().pendingDecision(f.binding)).toBeUndefined();
    // An explicit stale messageId is still refused; omission never reaches an older turn.
    await f.intake.receive(f.binding, f.turn("user-3", "Thêm một việc"));
    await expect(f.reopen().decide(f.binding, { messageId: "user-2", decision: { intent: "conversation_only", directReply: "Other" } }))
      .rejects.toThrow("Conflicting Conversation decision");
    const other = PaneBindingSchema.parse({ ...f.binding, paneId: "other-pane", session: { ...f.binding.session!, value: "native-other" } });
    await expect(f.reopen().decide(other, { decision })).rejects.toThrow("No trusted user turn");
    expect(await f.reopen().pendingDecision(f.binding)).toEqual({ messageId: "user-3", content: "Thêm một việc" });
  });
  it("replays the exact durable result without applying twice and rejects conflicting decisions", async () => {
    const f = await fixture(); await f.intake.receive(f.binding, f.turn("user-1"));
    const args = { messageId: "user-1", decision: { intent: "conversation_only", directReply: "Yes" } };
    const results = await Promise.all([f.intake.decide(f.binding, args), f.intake.decide(f.binding, args)]);
    expect(results[1]).toEqual(results[0]);
    expect(await f.reopen().decide(f.binding, args)).toEqual(results[0]);
    expect(f.applied).toHaveLength(1);
    await expect(f.reopen().decide(f.binding, { ...args, decision: { ...args.decision, directReply: "Different" } })).rejects.toThrow("Conflicting");
  });
  it("rejects unknown/stale turns, changed pane/session/role and forged host-owned fields", async () => {
    const f = await fixture(), args = { messageId: "user-1", decision: { intent: "conversation_only", directReply: "Yes" } };
    await expect(f.intake.decide(f.binding, args)).rejects.toThrow("Unknown");
    await f.intake.receive(f.binding, f.turn("user-1"));
    for (const binding of [{ ...f.binding, paneId: "other" }, { ...f.binding, session: { ...f.binding.session!, value: "new-session" } },
      { ...f.binding, role: "coordinator" as const }]) await expect(f.intake.decide(binding, args)).rejects.toThrow();
    await expect(f.intake.decide(f.binding, { ...args, provenance: { authenticatedUser: true } })).rejects.toThrow();
    await expect(f.intake.decide(f.binding, { ...args, decision: { intent: "approval_response", approvalInput: { decision: "approved" } } })).rejects.toThrow();
    await f.intake.receive(f.binding, f.turn("user-2", "A, giữ cả 5 tiêu chí"));
    await expect(f.reopen().decide(f.binding, args)).rejects.toThrow("Stale");
    expect(f.applied).toEqual([]);
  });
  it("resumes a durable decision intent with the same trusted message id after a lost response", async () => {
    const f = await fixture(), decision = { intent: "conversation_only", directReply: "Yes" };
    await f.intake.receive(f.binding, f.turn("user-1"));
    await f.journal().recordConversationIntent("user-1", decision);
    await f.reopen().decide(f.binding, { messageId: "user-1", decision });
    expect(f.applied).toMatchObject([{ messageId: "user-1", conversationDecision: decision }]);
  });
  it("accepts a heartbeat refresh without treating the native occupant as replaced", async () => {
    const f = await fixture(); await f.intake.receive(f.binding, f.turn("user-heartbeat"));
    const refreshed = { ...f.binding, transportState: "working" as const, lastHeartbeatAt: new Date().toISOString() };
    await expect(f.reopen().receive(refreshed, f.turn("user-heartbeat"))).resolves.toMatchObject({ requiresConversationDecision: true });
    await expect(f.intake.decide(refreshed, { messageId: "user-heartbeat", decision: { intent: "conversation_only", directReply: "Hello" } }))
      .resolves.toMatchObject({ ok: true });
    expect(f.applied).toHaveLength(1);
    await expect(f.reopen().receive(refreshed, f.turn("user-heartbeat", "different raw input"))).rejects.toThrow("Conflicting trusted");
  });
  it("does not reinterpret a received retry with a durable model intent as a fresh approval", async () => {
    const f = await fixture(); await f.intake.receive(f.binding, f.turn("user-resume", "approve parser token"));
    const decision = { intent: "conversation_only", directReply: "An explanation" };
    await f.journal().recordConversationIntent("user-resume", decision);
    let approvalCalls = 0;
    f.port.handleTrustedApproval = async () => { approvalCalls++; throw new Error("Must not reinterpret the recorded intent"); };
    await expect(f.reopen().receive(f.binding, f.turn("user-resume", "approve parser token"))).resolves.toMatchObject({
      requiresConversationDecision: true, decision
    });
    expect(approvalCalls).toBe(0);
    await expect(f.reopen().decide(f.binding, { messageId: "user-resume", decision })).resolves.toMatchObject({ ok: true });
  });
  it("replays a failed trusted approval unchanged and requires a new physical user ID for another attempt", async () => {
    const f = await fixture(); let calls = 0;
    f.port.handleTrustedApproval = async () => ++calls === 1
      ? { ok: false, error: { code: "transport", retryable: true, message: "Herdr unavailable" } }
      : { ok: true, value: { recognizedIntent: "approval_response", queuedBecauseBusy: false } };
    // A failed hook is reportable context, not a committed approval. Replaying its physical message ID cannot retry the operation.
    const failed = await f.intake.receive(f.binding, f.turn("user-approve", "approve"));
    expect(failed).toMatchObject({ approvalFailed: true,
      approvalFailure: { error: expect.stringContaining("\"code\":\"transport\"") } });
    expect(await f.journal().conversationDecision("user-approve")).toBeUndefined();
    expect(await f.reopen().pendingDecision(f.binding)).toBeUndefined();
    expect(await f.reopen().pendingApprovalFailure(f.binding)).toMatchObject({ messageId: "user-approve", error: expect.stringContaining("Herdr unavailable") });
    await expect(f.reopen().decide(f.binding, { decision: { intent: "conversation_only", directReply: "Approve" } })).rejects.toThrow("Trusted approval failed");
    expect(await f.reopen().receive(f.binding, f.turn("user-approve", "approve"))).toEqual(failed);
    expect(await f.reopen().receive(f.binding, f.turn("user-approve", "approve"))).toEqual(failed);
    expect(calls).toBe(1);
    expect(await f.journal().conversationDecision("user-approve")).toBeUndefined();
    expect(await f.journal().humanDecisions()).toEqual([]);
    await expect(f.reopen().receive(f.binding, f.turn("user-approve-new", "approve"))).resolves.toMatchObject({
      requiresConversationDecision: false, result: { ok: true } });
    expect(await f.journal().conversationDecision("user-approve-new")).toMatchObject({ decision: { intent: "trusted_approval" }, result: { ok: true } });
    expect(await f.reopen().receive(f.binding, f.turn("user-approve", "approve"))).toEqual(failed);
    expect(await f.journal().conversationDecision("user-approve")).toBeUndefined();
    expect(calls).toBe(2);
    expect(await f.reopen().pendingApprovalFailure(f.binding)).toBeUndefined();
  });
  it("never recovers failed approvals or old operational resume authority as ordinary suspended input", async () => {
    const f = await fixture(); let approvalCalls = 0;
    f.port.handleTrustedApproval = async input => {
      if ((input as { content: string }).content !== "approve") return undefined;
      approvalCalls++;
      return { ok: false, error: { message: `Transport failure ${approvalCalls}` } };
    };
    await f.intake.receive(f.binding, f.turn("failed-approval", "approve"));
    await f.intake.runtimeNudge(f.binding);
    expect(await f.reopen().pendingApprovalFailure(f.binding)).toBeUndefined();
    const current = await f.reopen().receive(f.binding, f.turn("current-user", "Báo trạng thái"));
    expect(current).not.toHaveProperty("recoverableUserTurns");
    await expect(f.reopen().decide(f.binding, { messageId: "failed-approval", decision: { intent: "conversation_only", directReply: "approve" } }))
      .rejects.toThrow("Trusted approval failed");
    expect(approvalCalls).toBe(1);
    await f.intake.receive(f.binding, f.turn("old-resume", "resume run-existing"));
    await f.intake.runtimeNudge(f.binding);
    const next = await f.reopen().receive(f.binding, f.turn("next-user", "Báo trạng thái"));
    expect(next).not.toHaveProperty("recoverableUserTurns");
    await expect(f.journal().authorizeConversationResume(f.binding, "old-resume", "run-existing")).rejects.toThrow("current authenticated");
    await expect(f.reopen().decide(f.binding, { messageId: "old-resume", decision: { intent: "conversation_only", directReply: "resume" } }))
      .rejects.toThrow("Stale user turn");
    expect(f.applied).toEqual([]);
    expect(await f.journal().humanDecisions()).toEqual([]);
  });
  it("keeps a queued trusted approval pending and resumes it through the port instead of Chat", async () => {
    const f = await fixture(); let state: "queued" | "committed" = "queued";
    f.port.handleTrustedApproval = async () => ({ ok: true, value: { recognizedIntent: "approval_response", queuedBecauseBusy: state === "queued" } });
    await expect(f.intake.receive(f.binding, f.turn("user-queued", "approve"))).resolves.toMatchObject({
      requiresConversationDecision: false, result: { value: { queuedBecauseBusy: true } } });
    expect(await f.journal().conversationDecision("user-queued")).toEqual({ decision: { intent: "trusted_approval" } });
    state = "committed";
    await expect(f.reopen().receive(f.binding, f.turn("user-queued", "approve"))).resolves.toMatchObject({
      requiresConversationDecision: false, result: { value: { queuedBecauseBusy: false } } });
    expect(await f.journal().conversationDecision("user-queued")).toMatchObject({ result: { value: { queuedBecauseBusy: false } } });
    await expect(f.reopen().decide(f.binding, { messageId: "user-queued", decision: { intent: "conversation_only", directReply: "x" } }))
      .rejects.toThrow();
    expect(f.applied).toEqual([]);
  });
  it("fails closed when a recorded trusted approval intent no longer resolves after a crash", async () => {
    const f = await fixture(); await f.intake.receive(f.binding, f.turn("user-crash", "approve"));
    await f.journal().recordConversationIntent("user-crash", { intent: "trusted_approval" });
    await expect(f.reopen().receive(f.binding, f.turn("user-crash", "approve"))).rejects.toThrow("Recorded trusted approval");
    expect(f.applied).toEqual([]);
  });
  it("allows correcting a state-invalid decision before an execution intent is written", async () => {
    const f = await fixture(); await f.intake.receive(f.binding, f.turn("user-1"));
    f.port.validateDecision = async input => { if ((input as { directReply: string }).directReply === "invalid") throw new Error("Invalid scope"); };
    await expect(f.intake.decide(f.binding, { messageId: "user-1", decision: { intent: "conversation_only", directReply: "invalid" } })).rejects.toThrow("Invalid scope");
    expect(await f.journal().conversationDecision("user-1")).toBeUndefined();
    await f.intake.decide(f.binding, { messageId: "user-1", decision: { intent: "conversation_only", directReply: "valid" } });
    expect(f.applied).toHaveLength(1);
  });
  it("does not finalize a FIFO acknowledgement and reconciles the completed decision after draining", async () => {
    const f = await fixture(); await f.intake.receive(f.binding, f.turn("user-queued"));
    let drained = false, calls = 0;
    f.port.handleUserTurn = async () => { calls++; return { ok: true, value: { recognizedIntent: "conversation_only", marker: 1,
      queuedBecauseBusy: !drained } }; };
    const args = { messageId: "user-queued", decision: { intent: "conversation_only", directReply: "Queued" } };
    expect(await f.intake.decide(f.binding, args)).toMatchObject({ value: { queuedBecauseBusy: true } });
    expect((await f.journal().conversationDecision("user-queued"))?.result).toBeUndefined();
    drained = true;
    const completed = await f.reopen().decide(f.binding, args);
    expect(completed).toMatchObject({ value: { queuedBecauseBusy: false } });
    expect(await f.reopen().decide(f.binding, args)).toEqual(completed);
    expect(calls).toBe(2);
  });
  it("keeps trusted human approval processing separate and refuses a model replacement", async () => {
    const f = await fixture(); let trustedCalls = 0;
    f.port.handleTrustedApproval = async () => { trustedCalls++; return { ok: true, value: { recognizedIntent: "approval_response" } }; };
    const received = await f.intake.receive(f.binding, f.turn("user-1", "approve"));
    expect(received).toMatchObject({ requiresConversationDecision: false, result: { ok: true, value: { recognizedIntent: "approval_response" } } });
    await f.reopen().receive(f.binding, f.turn("user-1", "approve"));
    expect(trustedCalls).toBe(1);
    await expect(f.intake.decide(f.binding, { messageId: "user-1", decision: { intent: "conversation_only", directReply: "Yes" } })).rejects.toThrow("Conflicting");
    expect(f.applied).toEqual([]);
  });
});

describe("Chat decisions through the real Conversation facade and durable Runtime outbox", () => {
  it.each([false, true])("recovers a crash after outbox persistence and before Gateway snapshot save without changing envelope timestamps or redispatching (revision already applied: %s)", async appliedRevision => {
    const f = await fixture(), at = "2026-10-19T00:00:00.000Z";
    const coordinator = PaneBindingSchema.parse({ ...f.binding, role: "coordinator", bindingId: "coordinator-binding", agentId: "coordinator",
      paneId: "coordinator-pane", session: { source: "herdr:claude", kind: "id", value: "native-coordinator" } });
    const manifest = SessionManifestSchema.parse({ schemaVersion: 2, sessionId: "herdr-session", workspaceRoot: f.directory, projectName: "chat-test",
      herdrWorkspaceId: "workspace", herdrTabId: "tab", status: "up", conversationSessionId: "chat-session", activeRunIds: [],
      attachTarget: { role: "conversation", paneId: f.binding.paneId }, panes: [f.binding, coordinator], createdAt: at, updatedAt: at });
    const createRuntime = () => new AgenticWorkflowRuntime({ authenticateMessage: async () => true, panes: { getManifest: async () => ({ ok: true, value: manifest }) } } as unknown as AgenticRuntimePorts,
      { journalDirectory: join(f.directory, "runtime-journal"), repositoryPath: f.directory });
    let runtime = createRuntime();
    let chat = await createAgenticConversationHost({ runtime, manifest, contextDirectory: join(f.directory, "context") });
    let intake = new HostConversationIntake(f.journal(), () => chat);
    const input = f.turn("user-workflow", "Yêu cầu workflow loại spike: khảo sát quyền MCP, chỉ đọc");
    await intake.receive(f.binding, input);
    await intake.runtimeNudge(f.binding);
    await expect(intake.decide(f.binding, { messageId: input.messageId, decision: {} })).rejects.toThrow("Runtime nudge");
    const next = await intake.receive(f.binding, f.turn("user-status", "Báo trạng thái trước"));
    expect(next).toMatchObject({ recoverableUserTurns: [{ messageId: input.messageId, content: input.content }] });
    await intake.decide(f.binding, { decision: { intent: "conversation_only", directReply: "Current user request considered" } });
    const decision = { intent: "workflow_request", requirementDraft: { title: "Khảo sát quyền MCP", objective: "Liệt kê quyền MCP của từng role",
      kind: "spike", sddLevel: "lightweight", priority: "normal", scopeDefined: true, isLargeTask: false, affectedPaths: [],
      acceptanceCriteriaDescriptions: ["Bảng role/server/cấu hình/cơ chế chặn; chỉ đọc"], isRequirementChange: false } };
    if (appliedRevision) {
      // Commit revision 1, then lose Conversation's save for an applied requirement revision 2.
      const first = await chat.handleUserTurn({ sessionId: "chat-session", messageId: "first-revision", content: "Initial read-only spike",
        provenance: { origin: "user", authenticatedUser: true }, conversationDecision: decision }) as any;
      const initial = first.value.delegationRequest;
      await runtime.receiveHerdr((await runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === initial.messageId).message);
      Object.assign(decision.requirementDraft, { isRequirementChange: true, targetRunId: initial.runId, objective: "Refine existing read-only scope" });
    }
    const queue = runtime.queueHerdr.bind(runtime);
    runtime.queueHerdr = async message => {
      await queue(message);
      if (appliedRevision) await runtime.receiveHerdr(message);
      throw new Error("simulated crash after durable outbox write");
    };
    await expect(intake.decide(f.binding, { messageId: input.messageId, decision })).rejects.toThrow("simulated crash");
    const before = await runtime.inspect() as unknown as { outbound: { message: { occurred_at: string } }[] };
    expect(before.outbound.filter((out: any) => out.message.type === "delegation.request")).toHaveLength(appliedRevision ? 2 : 1);
    const trusted = (await f.journal().conversationTurns())[0]!;
    expect(before.outbound.filter((out: any) => out.message.type === "delegation.request").at(-1)!.message.occurred_at).toBe(trusted.occurredAt);
    runtime = createRuntime();
    chat = await createAgenticConversationHost({ runtime, manifest, contextDirectory: join(f.directory, "context") });
    intake = new HostConversationIntake(f.journal(), () => chat);
    await intake.receive(f.binding, f.turn("user-newer", "Tiến độ thế nào?"));
    await intake.decide(f.binding, { decision: { intent: "conversation_only", directReply: "Newer user input considered before replay" } });
    const recovered = await intake.decide(f.binding, { messageId: input.messageId, decision });
    expect(recovered).toMatchObject({ ok: true, value: { recognizedIntent: "workflow_request" } });
    const after = await runtime.inspect() as unknown as { outbound: unknown[] };
    expect(after.outbound).toEqual(before.outbound);
    expect(await intake.decide(f.binding, { messageId: input.messageId, decision })).toEqual(recovered);
    await expect(chat.parseDecision({ intent: "approval_response", approvalInput: { decision: "approved" } })).rejects.toThrow();
  });
});

describe("session cancellation through one trusted Conversation decision", () => {
  it("pins the session run set, keeps conflict/provenance guards, and replays after a host restart", async () => {
    const f = await fixture(), at = "2026-10-19T00:00:00.000Z";
    const coordinator = PaneBindingSchema.parse({ ...f.binding, role: "coordinator", bindingId: "coordinator-binding", agentId: "coordinator",
      paneId: "coordinator-pane", session: { source: "herdr:claude", kind: "id", value: "native-coordinator" } });
    const manifest = SessionManifestSchema.parse({ schemaVersion: 2, sessionId: "herdr-session", workspaceRoot: f.directory, projectName: "batch-test",
      herdrWorkspaceId: "workspace", herdrTabId: "tab", status: "up", conversationSessionId: "chat-session", activeRunIds: [],
      attachTarget: { role: "conversation", paneId: f.binding.paneId }, panes: [f.binding, coordinator], createdAt: at, updatedAt: at });
    const ports = { panes: { getManifest: async () => ({ ok: true, value: manifest }) } } as unknown as AgenticRuntimePorts;
    const openRuntime = () => new AgenticWorkflowRuntime(ports, { journalDirectory: join(f.directory, "runtime-journal"), repositoryPath: f.directory });
    let runtime = openRuntime();
    const openChat = () => createAgenticConversationHost({ runtime, manifest, contextDirectory: join(f.directory, "context") });
    let chat = await openChat(), intake = new HostConversationIntake(f.journal(), () => chat);
    const workflowDecision = (title: string) => ({ intent: "workflow_request", requirementDraft: { title, objective: `Inspect ${title}`,
      kind: "spike", sddLevel: "lightweight", priority: "normal", scopeDefined: true, isLargeTask: false, affectedPaths: [],
      acceptanceCriteriaDescriptions: ["Report observed state"], isRequirementChange: false } });
    for (const id of ["first", "second"]) {
      await intake.receive(f.binding, f.turn(id, `Inspect ${id}`));
      await intake.decide(f.binding, { decision: workflowDecision(id) });
    }
    const before = await runtime.inspect() as any;
    const targets = before.runs.map((run: any) => run.runId).sort();
    expect(targets).toHaveLength(2);
    await intake.receive(f.binding, f.turn("cancel-both", "Hủy hết các run cũ"));
    const args = { decision: { intent: "cancellation_request", cancellationInput: { scope: "session_existing" } } };
    const result = await intake.decide(f.binding, args);
    expect(result).toMatchObject({ ok: true, value: { recognizedIntent: "cancellation_request" } });
    const state = await runtime.inspect() as any;
    const cancellations = state.outbound.filter((out: any) => out.message.payload.metadata?.action === "cancel");
    expect(cancellations.map((out: any) => out.message.run_id).sort()).toEqual(targets);
    expect(new Set(cancellations.map((out: any) => out.message.idempotency_key)).size).toBe(2);
    expect(state.runs).toHaveLength(2); // An operational cancellation never creates a workflow.
    expect(state.runs.every((run: any) => run.cancelled && run.status === "cancelled")).toBe(true);
    const context = await chat.getContext() as any;
    expect(context.runtimeStatus.runtimeRunIds.sort()).toEqual(targets);
    expect(context.runtimeStatus.snapshotOnlyRunIds).toEqual([]);
    expect(Object.values(context.workflows).every((run: any) => run.sdlcStatus === "cancelled")).toBe(true);
    const receipt = await f.journal().conversationDecision("cancel-both");
    expect(receipt?.decision).toEqual(args.decision);
    expect((await f.journal().conversationTurns()).at(-1)).toMatchObject({ messageId: "cancel-both", content: "Hủy hết các run cũ", userId: "human" });
    runtime = openRuntime(); chat = await openChat(); intake = new HostConversationIntake(f.journal(), () => chat);
    expect(await intake.decide(f.binding, args)).toEqual(result);
    expect((await runtime.inspect() as any).outbound).toEqual(state.outbound);
    await expect(intake.decide(f.binding, { decision: { intent: "cancellation_request", cancellationInput: { runId: targets[0] } } }))
      .rejects.toThrow("Conflicting Conversation decision");
    // Later work is outside the frozen old batch, even after recovery.
    await intake.receive(f.binding, f.turn("later", "Inspect later"));
    await intake.decide(f.binding, { decision: workflowDecision("later") });
    const latest = await runtime.inspect() as any;
    expect(latest.runs).toHaveLength(3);
    expect(latest.outbound.filter((out: any) => out.message.payload.metadata?.action === "cancel")).toHaveLength(2);
    expect(await f.journal().humanDecisions()).toEqual([]);
  });
});

it("fences a diagnostic only from its recorded physical command and never turns it into approval or model intent", async () => {
  const f = await fixture(); let calls = 0;
  const intake = () => new HostConversationIntake(f.journal(), () => f.port, async (turn, operationId) => {
    calls++;
    expect((await f.journal().conversationTurns()).find(item => item.messageId === turn.messageId)?.content)
      .toBe("fence diagnostic old-diagnostic");
    expect(operationId).toBe("old-diagnostic");
    return { ok: true, value: { disposition: "fenced_without_delivery_claim", delivery: "unknown_delivery", resendAllowed: false } };
  });
  const received = await intake().receive(f.binding, f.turn("user-fence", "fence diagnostic old-diagnostic"));
  expect(received).toMatchObject({ requiresConversationDecision: false, result: { ok: true } });
  expect(await intake().receive(f.binding, f.turn("user-fence", "fence diagnostic old-diagnostic"))).toEqual(received);
  expect(calls).toBe(1); expect(f.applied).toHaveLength(0);
  expect(await f.journal().humanDecisions()).toHaveLength(0);
  await expect(intake().decide(f.binding, { messageId: "user-fence", decision: { intent: "conversation_only", directReply: "Changed" } }))
    .rejects.toThrow(/physical|fenc/);
  expect(await intake().receive(f.binding, f.turn("user-quote", 'Explain "fence diagnostic old-diagnostic"')))
    .toMatchObject({ requiresConversationDecision: true });
  expect(calls).toBe(1);
});
