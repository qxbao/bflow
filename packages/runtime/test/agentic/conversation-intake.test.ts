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
      .toMatchObject({ required: ["messageId", "decision"], additionalProperties: false });
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
  it("journals no final result for a failed trusted approval, so the same turn can be retried", async () => {
    const f = await fixture(); let calls = 0;
    f.port.handleTrustedApproval = async () => ++calls === 1
      ? { ok: false, error: { code: "transport", retryable: true, message: "Herdr unavailable" } }
      : { ok: true, value: { recognizedIntent: "approval_response", queuedBecauseBusy: false } };
    // The failure is returned as context for the provider hook (not thrown, so the hook is never silent), and nothing is recorded.
    await expect(f.intake.receive(f.binding, f.turn("user-approve", "approve"))).resolves.toMatchObject({ approvalFailed: true,
      approvalFailure: { error: { error: { code: "transport" } } } });
    expect(await f.journal().conversationDecision("user-approve")).toBeUndefined();
    await expect(f.reopen().receive(f.binding, f.turn("user-approve", "approve"))).resolves.toMatchObject({
      requiresConversationDecision: false, result: { ok: true } });
    expect(await f.journal().conversationDecision("user-approve")).toMatchObject({ decision: { intent: "trusted_approval" }, result: { ok: true } });
    expect(calls).toBe(2);
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
  it("recovers a crash after outbox persistence and before Gateway snapshot save without changing envelope timestamps or redispatching", async () => {
    const f = await fixture(), at = "2026-10-19T00:00:00.000Z";
    const coordinator = PaneBindingSchema.parse({ ...f.binding, role: "coordinator", bindingId: "coordinator-binding", agentId: "coordinator",
      paneId: "coordinator-pane", session: { source: "herdr:claude", kind: "id", value: "native-coordinator" } });
    const manifest = SessionManifestSchema.parse({ schemaVersion: 2, sessionId: "herdr-session", workspaceRoot: f.directory, projectName: "chat-test",
      herdrWorkspaceId: "workspace", herdrTabId: "tab", status: "up", conversationSessionId: "chat-session", activeRunIds: [],
      attachTarget: { role: "conversation", paneId: f.binding.paneId }, panes: [f.binding, coordinator], createdAt: at, updatedAt: at });
    const createRuntime = () => new AgenticWorkflowRuntime({} as AgenticRuntimePorts,
      { journalDirectory: join(f.directory, "runtime-journal"), repositoryPath: f.directory });
    let runtime = createRuntime();
    let chat = await createAgenticConversationHost({ runtime, manifest, contextDirectory: join(f.directory, "context") });
    let intake = new HostConversationIntake(f.journal(), () => chat);
    const input = f.turn("user-workflow", "Yêu cầu workflow loại spike: khảo sát quyền MCP, chỉ đọc");
    await intake.receive(f.binding, input);
    const decision = { intent: "workflow_request", requirementDraft: { title: "Khảo sát quyền MCP", objective: "Liệt kê quyền MCP của từng role",
      kind: "spike", sddLevel: "lightweight", priority: "normal", scopeDefined: true, isLargeTask: false, affectedPaths: [],
      acceptanceCriteriaDescriptions: ["Bảng role/server/cấu hình/cơ chế chặn; chỉ đọc"], isRequirementChange: false } };
    const queue = runtime.queueHerdr.bind(runtime);
    runtime.queueHerdr = async message => { await queue(message); throw new Error("simulated crash after durable outbox write"); };
    await expect(intake.decide(f.binding, { messageId: input.messageId, decision })).rejects.toThrow("simulated crash");
    const before = await runtime.inspect() as unknown as { outbound: { message: { occurred_at: string } }[] };
    expect(before.outbound).toHaveLength(1);
    const trusted = (await f.journal().conversationTurns())[0]!;
    expect(before.outbound[0]!.message.occurred_at).toBe(trusted.occurredAt);
    runtime = createRuntime();
    chat = await createAgenticConversationHost({ runtime, manifest, contextDirectory: join(f.directory, "context") });
    intake = new HostConversationIntake(f.journal(), () => chat);
    await intake.receive(f.binding, f.turn("user-newer", "Tiến độ thế nào?"));
    const recovered = await intake.decide(f.binding, { messageId: input.messageId, decision });
    expect(recovered).toMatchObject({ ok: true, value: { recognizedIntent: "workflow_request" } });
    const after = await runtime.inspect() as unknown as { outbound: unknown[] };
    expect(after.outbound).toEqual(before.outbound);
    expect(await intake.decide(f.binding, { messageId: input.messageId, decision })).toEqual(recovered);
    await expect(chat.parseDecision({ intent: "approval_response", approvalInput: { decision: "approved" } })).rejects.toThrow();
  });
});
