import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConfigurationSchema, ApprovalDecisionSchema, ApprovalRequestSchema, DelegationRequestSchema, PaneBindingSchema,
  RoleMessageSchema, SessionManifestSchema, type AgentRole, type ApprovalDecision, type PaneBinding, type RoleMessage } from "@bflow/contracts";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { draft } from "../../../specification/test/fixtures.js";
import { AgenticJournal, type JournalState } from "../../src/agentic/journal.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { createAgenticConversationHost, type AgenticConversationHost } from "../../src/agentic/conversation.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { parseUserDecisionToolInput } from "../../src/agentic/decision-routing.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";

const SESSION = "session-1";
const RUN = "run-1";
const TASK = "task-implement";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

type Entry = { message: RoleMessage; status: string; error?: string; selector: string };
type UserDecisionState = { status: string; role: string; answer?: { outcome: string; selectedOption?: string } };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

function pane(role: AgentRole, agentId: string, paneId: string): PaneBinding {
  const developer = role === "developer";
  return PaneBindingSchema.parse({ schemaVersion: 2, bindingId: `binding-${role}`, sessionId: SESSION, role, agentId, paneId,
    workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude", cwd: developer ? "/tmp/worktree" : "/tmp",
    ...(developer ? { worktreePath: "/tmp/worktree" } : {}), readOnlyWorkspace: !developer, isolationMode: "dedicated_pane",
    transportState: "idle", boundAt: new Date().toISOString(), session: { source: "herdr:claude", kind: "id", value: `native-${role}` } });
}

class Panes {
  readonly bindings = [pane("conversation", "conversation-agent", "pane-conversation"),
    pane("coordinator", "coordinator-agent", "pane-coordinator"), pane("developer", "developer-agent", "pane-developer")];
  async getManifest() {
    return { ok: true as const, value: SessionManifestSchema.parse({ schemaVersion: 2, sessionId: SESSION, projectName: "Test",
      workspaceRoot: "/tmp", herdrWorkspaceId: "workspace", herdrTabId: "tab", status: "up", conversationSessionId: SESSION,
      activeRunIds: [], panes: this.bindings, attachTarget: { role: "conversation", paneId: "pane-conversation" },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) };
  }
  async getRoleBinding(selector: string) {
    return { ok: true as const, value: this.bindings.find(p => [p.role, p.bindingId, p.paneId, p.agentId].includes(selector)) ?? null };
  }
  async inspectRoleHealth(selector: string) {
    const binding = this.bindings.find(p => [p.role, p.bindingId, p.paneId, p.agentId].includes(selector));
    if (!binding) throw new Error("No pane");
    return { ok: true as const, value: { readyForPrompt: true, occupantMatches: true, paneId: binding.paneId, agentId: binding.agentId } };
  }
}

async function fixture(options: { design?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-user-decision-e2e-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo"); await mkdir(repository);
  const journalDirectory = join(root, "journal");
  // One clock for every component: the Conversation gateway and enqueueDecision read the global Date,
  // so expiry tests move Date (vi.setSystemTime) rather than only the Runtime clock.
  const clock = () => new Date();
  const receipts = new HostReceiptJournal(join(root, "host-receipts"), repository, SESSION);
  const transport = new FakeAgentTransport();
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });
  const panes = new Panes();
  const ports = {
    clock, transport, registry, panes,
    authenticateMessage: async () => true,
    authorizeHuman: (decision: ApprovalDecision) => receipts.authenticateHuman(decision),
    roleCapabilities: { conversation: ["conversation"], coordinator: ["coordination"], developer: ["implementation"] }
  } as unknown as AgenticRuntimePorts;
  const journal = new AgenticJournal(journalDirectory, repository);
  const requestedAt = clock().toISOString();
  const specification = draft("api");
  await journal.exclusive(async (state: JournalState, save) => {
    const delegation = DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "delegation", messageId: "intake",
      correlationId: "correlation", sessionId: SESSION, runId: RUN, requestedBy: "conversation", targetRole: "coordinator",
      title: "User decision e2e", objective: "Choose a storage backend", specificationId: specification.specId, sddLevel: specification.level,
      acceptanceCriteria: specification.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt, idempotencyKey: "intake" });
    // Pre-implementation status: tick() skips these runs, so the decision path is tested without a Core workflow.
    state.runs.push({ runId: RUN, delegation, status: "intake", tasks: [], coreCreated: false, cancelled: false, maxIterations: 3 });
    if (options.design) {
      // A design approval occupies the single run.approval slot while the Developer asks a user decision.
      state.runs[0]!.status = "awaiting_approval";
      state.runs[0]!.approvalKind = "design";
      state.runs[0]!.approval = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: "apr-design-1", runId: RUN, sessionId: SESSION,
        status: "pending", target: { type: "task", taskId: TASK }, revision: 1, generation: 0, requestedBy: "runtime",
        requestedAt, reason: "Approve the design", evidence: [], idempotencyKey: "design-approval-1", metadata: {} });
    }
    const assignment = RoleMessageSchema.parse({ schema_version: 2, message_id: "assign-1", correlation_id: "correlation", run_id: RUN,
      sender: { role: "coordinator" }, recipient: { role: "developer", agent_id: "developer-agent", pane_id: "pane-developer" },
      type: "delegation.request", payload: { objective: "Implement" }, artifact_references: [], occurred_at: requestedAt, idempotency_key: "assign-1" });
    state.outbound.push({ message: assignment, status: "released", selector: "developer", taskId: TASK, attemptId: "attempt-1", capabilities: [],
      handle: { executionId: "exec-1", requestId: "request-1", attemptId: "attempt-1", runId: RUN, taskId: TASK, idempotencyKey: "assign-1",
        target: { transport: "herdr", agentId: "developer-agent", paneId: "pane-developer" },
        correlation: { token: "assign-1", provenance: "transport", verified: true }, acceptedAt: requestedAt } });
    await save();
  });
  const conversationPane = panes.bindings[0]!;
  const provenance = (messageId: string) => ({ origin: "UserPromptSubmit" as const, binding: conversationPane, nativeSessionId: "native-conversation",
    conversationSessionId: SESSION, userId: "human-1", messageId, promptDigest: sha(messageId) });
  const runtime = () => new AgenticWorkflowRuntime(ports, { journalDirectory, repositoryPath: repository });
  /** Builds a Conversation host over a runtime instance, recording human receipts exactly as the host does. */
  const chat = async (instance: AgenticWorkflowRuntime, recordReceipts = true): Promise<AgenticConversationHost> => createAgenticConversationHost({
    runtime: instance, manifest: unwrap(await panes.getManifest()), contextDirectory: join(root, "conversation"),
    onHumanDecision: recordReceipts ? decision => receipts.recordHuman(decision, provenance("user-reply")) : undefined
  });
  return { root, transport, registry, receipts, runtime, chat, provenance, developer: panes.bindings[2]!, journal };
}

const outbound = async (instance: AgenticWorkflowRuntime): Promise<Entry[]> =>
  (await instance.inspect() as unknown as { outbound: Entry[] }).outbound;
const userDecisions = async (instance: AgenticWorkflowRuntime, approvalId: string): Promise<UserDecisionState | undefined> =>
  ((await instance.inspect(RUN)) as unknown as { userDecisions?: Record<string, UserDecisionState> }).userDecisions?.[approvalId];
const sentTo = (transport: FakeAgentTransport, role: string, type?: string) =>
  transport.sentRequests.filter(request => request.role === role && (type === undefined || (JSON.parse(request.instruction) as { type?: string }).type === type));

async function request(instance: AgenticWorkflowRuntime, developer: PaneBinding, extra: Record<string, unknown> = {}): Promise<string> {
  const receipt = await instance.requestUserDecision(developer, "developer", parseUserDecisionToolInput({ runId: RUN, taskId: TASK,
    question: "Which storage backend should we use?", options: ["SQLite", "Postgres"], expiresInMinutes: 30, ...extra }));
  return (receipt as unknown as { approvalId: string }).approvalId;
}

const promptOf = async (instance: AgenticWorkflowRuntime): Promise<RoleMessage> =>
  (await outbound(instance)).find(entry => entry.message.type === "approval.request")!.message;

/** User reply through the real Conversation gateway, recorded as a human receipt by the host. */
async function reply(host: AgenticConversationHost, content: string, messageId = "user-reply") {
  return await host.handleUserTurn({ sessionId: SESSION, messageId, content,
    provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: "pane-conversation", channel: "herdr_attach" } }) as
    { ok: boolean; error?: { message: string }; value: { approvalDecision: ApprovalDecision; recognizedIntent: string } };
}

const resumeOf = async (instance: AgenticWorkflowRuntime) => (await outbound(instance)).filter(entry => entry.message.type === "task.status");

describe.skipIf(process.platform !== "linux")("P30 user decisions end to end", () => {
  it("routes a specialist decision through Conversation and resumes the asker exactly once", async () => {
    const f = await fixture(); const runtime = f.runtime();
    const approvalId = await request(runtime, f.developer);
    await runtime.flushOutbound();
    const prompts = (await outbound(runtime)).filter(entry => entry.message.type === "approval.request");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.message.recipient.role).toBe("conversation");
    expect(prompts[0]!.message.payload).toMatchObject({ approvalId, metadata: { kind: "user_decision", options: ["SQLite", "Postgres"] } });
    expect(f.transport.sentRequests.filter(r => r.role === "conversation" && r.instruction.includes("approval.request"))).toHaveLength(1);

    const host = await f.chat(runtime);
    await host.receiveHerdr(await promptOf(runtime));
    const response = await reply(host, "2");
    expect(response.ok).toBe(true);
    expect(response.value.approvalDecision).toMatchObject({ approvalId, decision: "approved", metadata: { selectedOption: "Postgres" } });

    const decision = (await outbound(runtime)).find(entry => entry.message.type === "approval.decision")!.message;
    await runtime.receiveHerdr(decision);
    expect(await userDecisions(runtime, approvalId)).toMatchObject({ status: "answered", answer: { outcome: "approved", selectedOption: "Postgres" } });

    await runtime.flushOutbound(); await runtime.tick(); await runtime.flushOutbound();
    const delivered = sentTo(f.transport, "developer", "task.status");
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0]!.instruction).payload).toMatchObject({ kind: "user_decision_answer", approvalId, outcome: "approved", selectedOption: "Postgres" });
    expect(sentTo(f.transport, "conversation", "approval.request")).toHaveLength(1);
  });

  it("keeps the resume queued while the asker lease is busy and delivers it exactly once after release", async () => {
    const f = await fixture(); const runtime = f.runtime();
    const approvalId = await request(runtime, f.developer);
    await runtime.flushOutbound();
    const host = await f.chat(runtime);
    await host.receiveHerdr(await promptOf(runtime));
    // The Developer holds its only lease for another task when the answer arrives.
    await f.registry.upsert(AgentConfigurationSchema.parse({ agentId: "developer-agent", role: "developer", transport: "herdr", enabled: true,
      priority: 0, maxConcurrentTasks: 1, capabilities: ["implementation"], settings: {} }));
    const busy = unwrap(await f.registry.acquireLease({ leaseId: "lease-busy", agentId: "developer-agent", runId: RUN, taskId: "task-other",
      attemptId: "attempt-other", ttlMs: 300_000, requestedAt: new Date().toISOString(), idempotencyKey: "acquire-busy" }));
    await reply(host, "1");
    await runtime.receiveHerdr((await outbound(runtime)).find(entry => entry.message.type === "approval.decision")!.message);
    for (let i = 0; i < 3; i++) { await runtime.flushOutbound(); await runtime.tick(); }
    expect(sentTo(f.transport, "developer", "task.status")).toHaveLength(0);
    expect((await resumeOf(runtime))[0]!.status).toBe("queued");

    unwrap(await f.registry.releaseLease({ leaseId: busy.leaseId, fencingToken: busy.fencingToken, expectedVersion: busy.version,
      releasedAt: new Date().toISOString(), idempotencyKey: "release-busy" }));
    await runtime.flushOutbound();
    expect(sentTo(f.transport, "developer", "task.status")).toHaveLength(1);
    for (let i = 0; i < 3; i++) { await runtime.flushOutbound(); await runtime.tick(); }
    expect(sentTo(f.transport, "developer", "task.status")).toHaveLength(1);
    expect((await resumeOf(runtime))[0]).toMatchObject({ status: "released" });
    expect(await userDecisions(runtime, approvalId)).toMatchObject({ status: "answered" });
  });

  it("expires a pending decision on tick, resumes the asker once and rejects a late reply without state change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now(); vi.setSystemTime(start);
    const f = await fixture(); const runtime = f.runtime();
    const approvalId = await request(runtime, f.developer, { expiresInMinutes: 1 });
    await runtime.flushOutbound();
    const host = await f.chat(runtime);
    await host.receiveHerdr(await promptOf(runtime));
    vi.setSystemTime(start + 2 * 60_000);
    await runtime.tick();
    expect(await userDecisions(runtime, approvalId)).toMatchObject({ status: "expired" });
    await runtime.flushOutbound(); await runtime.tick(); await runtime.flushOutbound();
    const delivered = sentTo(f.transport, "developer", "task.status");
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0]!.instruction).payload).toMatchObject({ kind: "user_decision_answer", outcome: "expired" });

    // A late reply is refused by Conversation (expired) and never queued as an approval.decision.
    const late = await reply(host, "1", "late-reply");
    expect(late.ok).toBe(false);
    expect(late.error?.message).toMatch(/expired/);
    expect((await outbound(runtime)).some(entry => entry.message.type === "approval.decision")).toBe(false);
    // Even a directly delivered late decision is refused by the Runtime, which keeps the expired state.
    const lateDecision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId, runId: RUN, sessionId: SESSION,
      target: { type: "task", taskId: TASK }, revision: 1, generation: 0, decision: "approved", decidedBy: "human-1",
      decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: "late-direct", metadata: { selectedOption: "SQLite" } });
    await f.receipts.recordHuman(lateDecision, f.provenance("late-direct"));
    await expect(runtime.receiveHerdr(RoleMessageSchema.parse({ schema_version: 2, message_id: "late-direct", correlation_id: "correlation",
      run_id: RUN, sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "approval.decision", payload: lateDecision,
      artifact_references: [], occurred_at: lateDecision.decidedAt, idempotency_key: "late-direct" }))).rejects.toThrow("not pending");
    expect(await userDecisions(runtime, approvalId)).toMatchObject({ status: "expired" });
    await runtime.tick(); await runtime.flushOutbound();
    expect(sentTo(f.transport, "developer", "task.status")).toHaveLength(1);
  });

  it("refuses a Conversation reply for a decision the Runtime already answered out of band", async () => {
    const f = await fixture(); const runtime = f.runtime();
    const approvalId = await request(runtime, f.developer);
    await runtime.flushOutbound();
    const host = await f.chat(runtime);
    await host.receiveHerdr(await promptOf(runtime));
    // The same human answer reaches Runtime directly (Conversation still shows the prompt as pending).
    const direct = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId, runId: RUN, sessionId: SESSION,
      target: { type: "task", taskId: TASK }, revision: 1, generation: 0, decision: "approved", decidedBy: "human-1",
      decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: "direct-answer", metadata: { selectedOption: "SQLite" } });
    await f.receipts.recordHuman(direct, f.provenance("direct-answer"));
    await runtime.receiveHerdr(RoleMessageSchema.parse({ schema_version: 2, message_id: "direct-answer-msg", correlation_id: "correlation",
      run_id: RUN, sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "approval.decision", payload: direct,
      artifact_references: [], occurred_at: direct.decidedAt, idempotency_key: "direct-answer-msg" }));
    expect(await userDecisions(runtime, approvalId)).toMatchObject({ status: "answered" });

    // A second reply must not be queued as a new approval.decision for an already-answered request.
    // Without a receipt recorder this host reaches Conversation's enqueueDecision for the stale prompt.
    const stale = await f.chat(runtime, false);
    const again = await reply(stale, "2", "second-reply").catch((error: Error) => ({ ok: false, error: { message: error.message } }));
    expect(again.ok).toBe(false);
    expect((await outbound(runtime)).filter(entry => entry.message.type === "approval.decision")).toHaveLength(0);
    expect(await userDecisions(runtime, approvalId)).toMatchObject({ status: "answered" });
    await runtime.flushOutbound(); await runtime.tick(); await runtime.flushOutbound();
    expect(sentTo(f.transport, "developer", "task.status")).toHaveLength(1);
  });

  it("does not duplicate the prompt or lose the resume across runtime restarts", async () => {
    const f = await fixture();
    const first = f.runtime();
    const approvalId = await request(first, f.developer);
    await first.flushOutbound();
    // Restart between request and answer.
    const second = f.runtime();
    await second.flushOutbound();
    expect((await outbound(second)).filter(entry => entry.message.type === "approval.request")).toHaveLength(1);
    expect(sentTo(f.transport, "conversation", "approval.request")).toHaveLength(1);
    const host = await f.chat(second);
    await host.receiveHerdr(await promptOf(second));
    await reply(host, "2");
    const decision = (await outbound(second)).find(entry => entry.message.type === "approval.decision")!.message;
    await second.receiveHerdr(decision);
    // Restart between answer and resume delivery.
    const third = f.runtime();
    expect(await userDecisions(third, approvalId)).toMatchObject({ status: "answered" });
    await third.flushOutbound();
    const fourth = f.runtime();
    await fourth.flushOutbound(); await fourth.tick(); await fourth.flushOutbound();
    expect(sentTo(f.transport, "developer", "task.status")).toHaveLength(1);
    expect((await outbound(fourth)).filter(entry => entry.message.type === "approval.request")).toHaveLength(1);
    expect((await resumeOf(fourth))).toHaveLength(1);
  });

  it("re-asks on an ambiguous reply without changing state and rejects an unauthenticated decision", async () => {
    const f = await fixture(); const runtime = f.runtime();
    const approvalId = await request(runtime, f.developer);
    await runtime.flushOutbound();
    const host = await f.chat(runtime);
    await host.receiveHerdr(await promptOf(runtime));
    const response = await reply(host, "maybe, not sure");
    expect(response.ok).toBe(true);
    expect(response.value.recognizedIntent).toBe("conversation_only");
    expect((await outbound(runtime)).some(entry => entry.message.type === "approval.decision")).toBe(false);
    expect(await userDecisions(runtime, approvalId)).toMatchObject({ status: "pending" });

    // A decision without a host-recorded human receipt is not authenticated, whatever its content.
    const forged = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId, runId: RUN, sessionId: SESSION,
      target: { type: "task", taskId: TASK }, revision: 1, generation: 0, decision: "approved", decidedBy: "human-1",
      decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: "forged", metadata: { selectedOption: "SQLite" } });
    await expect(runtime.receiveHerdr(RoleMessageSchema.parse({ schema_version: 2, message_id: "forged-msg", correlation_id: "correlation",
      run_id: RUN, sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "approval.decision", payload: forged,
      artifact_references: [], occurred_at: forged.decidedAt, idempotency_key: "forged-msg" }))).rejects.toThrow("not authenticated");
    expect(await userDecisions(runtime, approvalId)).toMatchObject({ status: "pending" });
    expect(sentTo(f.transport, "developer", "task.status")).toHaveLength(0);
  });

  it("leaves a design approval in run.approval untouched while a user decision is answered", async () => {
    const f = await fixture({ design: true }); const runtime = f.runtime();
    const approvalId = await request(runtime, f.developer);
    await runtime.flushOutbound();
    const host = await f.chat(runtime);
    await host.receiveHerdr(await promptOf(runtime));
    await reply(host, "1");
    await runtime.receiveHerdr((await outbound(runtime)).find(entry => entry.message.type === "approval.decision")!.message);
    expect(await userDecisions(runtime, approvalId)).toMatchObject({ status: "answered" });
    const state = await runtime.inspect(RUN) as unknown as { status: string; approval: { approvalId: string; status: string }; decision?: unknown };
    expect(state).toMatchObject({ status: "awaiting_approval", approval: { approvalId: "apr-design-1", status: "pending" } });
    expect(state.decision).toBeUndefined();

    // The design/task approval still follows its own exact-match and human-authority path.
    const rejected = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: "apr-design-1", runId: RUN, sessionId: SESSION,
      target: { type: "task", taskId: TASK }, revision: 1, generation: 0, decision: "rejected", decidedBy: "human-1",
      decidedAt: new Date().toISOString(), reason: "Not this design", feedbackArtifacts: [], idempotencyKey: "design-reject" });
    await f.receipts.recordHuman(rejected, f.provenance("design-reject"));
    await runtime.receiveHerdr(RoleMessageSchema.parse({ schema_version: 2, message_id: "design-reject-msg", correlation_id: "correlation",
      run_id: RUN, sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "approval.decision", payload: rejected,
      artifact_references: [], occurred_at: rejected.decidedAt, idempotency_key: "design-reject-msg" }));
    expect(await runtime.inspect(RUN)).toMatchObject({ status: "failed", error: "Not this design" });
    expect(sentTo(f.transport, "developer", "task.status")).toHaveLength(0);
  });

  it("tells Conversation about an expired decision, which then drops the prompt and says so", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now(); vi.setSystemTime(start);
    const f = await fixture(); const runtime = f.runtime();
    const approvalId = await request(runtime, f.developer, { expiresInMinutes: 1 });
    await runtime.flushOutbound();
    const host = await f.chat(runtime);
    await host.receiveHerdr(await promptOf(runtime));
    vi.setSystemTime(start + 2 * 60_000);
    await runtime.tick(); await runtime.flushOutbound();

    const notice = sentTo(f.transport, "conversation", "conversation.progress")
      .map(request => JSON.parse(request.instruction) as RoleMessage)
      .find(message => (message.payload as { kind?: string }).kind === "user_decision_expired");
    expect(notice).toMatchObject({ type: "conversation.progress", recipient: { role: "conversation" },
      payload: { kind: "user_decision_expired", approvalId } });

    const result = await host.receiveHerdr(notice) as { value: { userNotification?: { content: string } } };
    expect(result.value.userNotification?.content).toContain("HẾT HẠN");
    const late = await reply(host, "1", "reply-after-notice");
    expect(late.value?.approvalDecision).toBeUndefined();
    expect((await outbound(runtime)).some(entry => entry.message.type === "approval.decision")).toBe(false);
  });

  it("closes the decisions of a completed or cancelled run silently without resuming askers", async () => {
    const f = await fixture(); const runtime = f.runtime();
    const completedId = await request(runtime, f.developer);
    await runtime.flushOutbound();
    await f.journal.exclusive(async (state, save) => { state.runs[0]!.status = "completed"; await save(); });
    await runtime.tick(); await runtime.flushOutbound();
    expect(await userDecisions(runtime, completedId)).toMatchObject({ status: "expired" });
    expect(sentTo(f.transport, "developer", "task.status")).toHaveLength(0);
    expect((await outbound(runtime)).some(entry => (entry.message.payload as { kind?: string }).kind === "user_decision_expired")).toBe(false);
  });

  it("marks decisions of a cancelled run as cancelled without a Conversation notice", async () => {
    const f = await fixture(); const runtime = f.runtime();
    const approvalId = await request(runtime, f.developer);
    await runtime.flushOutbound();
    await f.journal.exclusive(async (state, save) => { state.runs[0]!.status = "cancelled"; state.runs[0]!.cancelled = true; await save(); });
    await runtime.tick(); await runtime.flushOutbound();
    expect(await userDecisions(runtime, approvalId)).toMatchObject({ status: "cancelled" });
    expect(sentTo(f.transport, "developer", "task.status")).toHaveLength(0);
    expect((await outbound(runtime)).some(entry => (entry.message.payload as { kind?: string }).kind === "user_decision_expired")).toBe(false);
  });
});
