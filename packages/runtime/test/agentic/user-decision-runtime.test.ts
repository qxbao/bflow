import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDecisionSchema, DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema,
  type ApprovalDecision, type PaneBinding } from "@bflow/contracts";
import { draft } from "../../../specification/test/fixtures.js";
import { AgenticJournal, type JournalState } from "../../src/agentic/journal.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { USER_DECISION_TOOL, guardDirectUserInteraction, parseUserDecisionToolInput } from "../../src/agentic/decision-routing.js";
import { availableTools } from "../../src/agentic/host.js";

const T0 = "2026-10-18T10:00:00.000Z";
const T1 = "2026-10-18T10:01:00.000Z";
const T2 = "2026-10-18T10:02:00.000Z";
const cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });

const developerPane = (): PaneBinding => PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "developer-binding", sessionId: "session-1",
  role: "developer", agentId: "developer-agent", paneId: "pane-developer", workspaceId: "workspace", tabId: "tab", provider: "claude",
  agentKind: "claude", cwd: "/tmp", worktreePath: "/tmp", readOnlyWorkspace: false, isolationMode: "dedicated_pane", transportState: "idle",
  boundAt: T0, session: { source: "herdr:claude", kind: "id", value: "native-developer" } });
const coordinatorPane = (): PaneBinding => PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "coordinator-binding", sessionId: "session-1",
  role: "coordinator", agentId: "coordinator-agent", paneId: "pane-coordinator", workspaceId: "workspace", tabId: "tab", provider: "claude",
  agentKind: "claude", cwd: "/tmp", readOnlyWorkspace: true, isolationMode: "dedicated_pane", transportState: "idle", boundAt: T0,
  session: { source: "herdr:claude", kind: "id", value: "native-coordinator" } });

async function fixture(options: { humanId?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-user-decision-")));
  cleanup.push(root);
  const repository = join(root, "repo"), journalDirectory = join(root, "journal");
  let now = T0;
  const conversationInbox: unknown[] = [];
  const ports = {
    clock: () => new Date(now),
    authenticateMessage: async () => true,
    deliverToConversation: async (message: unknown) => { conversationInbox.push(message); },
    authorizeHuman: async (decision: ApprovalDecision) => decision.decidedBy === (options.humanId ?? "human-1")
  } as unknown as AgenticRuntimePorts;
  const journal = new AgenticJournal(journalDirectory, repository);
  const specification = draft("api");
  // Seed a run whose Developer holds a released specialist execution, as Runtime would after dispatch.
  await journal.exclusive(async (state: JournalState, save) => {
    const delegation = DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "delegation", messageId: "intake",
      correlationId: "correlation", sessionId: "session-1", runId: "run-1", requestedBy: "conversation", targetRole: "coordinator",
      title: "User decision test", objective: "Choose a storage backend", specificationId: specification.specId, sddLevel: specification.level,
      acceptanceCriteria: specification.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: T0, idempotencyKey: "intake" });
    state.runs.push({ runId: "run-1", delegation, status: "implementing", tasks: [], coreCreated: false, cancelled: false, maxIterations: 3 });
    const assignment = RoleMessageSchema.parse({ schema_version: 2, message_id: "assign-1", correlation_id: "correlation", run_id: "run-1",
      sender: { role: "coordinator" }, recipient: { role: "developer", agent_id: "developer-agent", pane_id: "pane-developer" },
      type: "delegation.request", payload: { objective: "Implement" }, artifact_references: [], occurred_at: T0, idempotency_key: "assign-1" });
    state.outbound.push({ message: assignment, status: "released", selector: "developer", taskId: "task-implement", attemptId: "attempt-1",
      capabilities: [], handle: { executionId: "exec-1", requestId: "request-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-implement",
        idempotencyKey: "assign-1", target: { transport: "herdr", agentId: "developer-agent", paneId: "pane-developer" },
        correlation: { token: "assign-1", provenance: "transport", verified: true }, acceptedAt: T0 } });
    await save();
  });
  return {
    root, journalDirectory, ports, setNow: (value: string) => { now = value; },
    runtime: () => new AgenticWorkflowRuntime(ports, { journalDirectory, repositoryPath: repository }),
    journal
  };
}

const request = (runtime: AgenticWorkflowRuntime, pane: PaneBinding, input: Record<string, unknown> = {}) =>
  runtime.requestUserDecision(pane, pane.role, parseUserDecisionToolInput({ runId: "run-1", taskId: "task-implement",
    question: "Which storage backend should we use?", options: ["SQLite", "Postgres"], expiresInMinutes: 30, ...input }));

const answer = (approvalId: string, overrides: Record<string, unknown> = {}): ApprovalDecision => ApprovalDecisionSchema.parse({
  schemaVersion: 2, approvalId, runId: "run-1", sessionId: "session-1", target: { type: "task", taskId: "task-implement" },
  revision: 1, generation: 0, decision: "approved", decidedBy: "human-1", decidedAt: T1, feedbackArtifacts: [],
  idempotencyKey: `answer-${approvalId}`, metadata: { selectedOption: "SQLite" }, ...overrides });

const deliver = (runtime: AgenticWorkflowRuntime, decision: ApprovalDecision) => runtime.receiveHerdr(RoleMessageSchema.parse({
  schema_version: 2, message_id: `inbound-${decision.idempotencyKey}`, correlation_id: "correlation", run_id: "run-1",
  sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "approval.decision", payload: decision,
  artifact_references: [], occurred_at: decision.decidedAt, idempotency_key: `inbound-${decision.idempotencyKey}` }));

describe("P30 T9b tool guard and MCP tool surface", () => {
  it("denies native direct user interaction for specialist and Coordinator roles only", () => {
    for (const role of ["developer", "coordinator", "architect"] as const) {
      const guard = guardDirectUserInteraction(role, "AskUserQuestion");
      expect(guard.permitted).toBe(false);
      if (!guard.permitted) expect(guard.reason).toContain("request_user_decision");
      expect(guardDirectUserInteraction(role, "mcp__elicitation__ask").permitted).toBe(false);
      expect(guardDirectUserInteraction(role, "Read").permitted).toBe(true);
    }
    expect(guardDirectUserInteraction("conversation", "AskUserQuestion")).toEqual({ permitted: true });
  });

  it("offers request_user_decision to every non-Conversation role with strict arguments", () => {
    for (const role of ["coordinator", "developer", "architect", "qa"] as const) {
      const tool = availableTools(role).find(item => item.name === USER_DECISION_TOOL);
      expect(tool, role).toBeDefined();
      expect(tool!.inputSchema).toMatchObject({ additionalProperties: false, required: ["runId", "taskId", "question"] });
    }
    expect(availableTools("conversation").some(item => item.name === USER_DECISION_TOOL)).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("P30 T9b runtime user decisions", () => {
  it("records a pending decision and emits exactly one approval.request to Conversation", async () => {
    const f = await fixture(); const runtime = f.runtime();
    const receipt = await request(runtime, developerPane());
    expect(receipt).toMatchObject({ status: "pending", instruction: expect.stringContaining("Runtime resumes you") });
    const state = await f.runtime().inspect("run-1") as unknown as { userDecisions: Record<string, { status: string; role: string; paneId: string; request: { metadata: { kind: string } } }> };
    const approvalId = (receipt as unknown as { approvalId: string }).approvalId;
    expect(state.userDecisions[approvalId]).toMatchObject({ status: "pending", role: "developer", paneId: "pane-developer" });
    expect(state.userDecisions[approvalId]!.request.metadata.kind).toBe("user_decision");
    const full = await f.journal.exclusive(async s => s);
    const prompts = full.outbound.filter(out => out.message.type === "approval.request");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.message.recipient.role).toBe("conversation");
    expect(prompts[0]!.message.sender.role).toBe("runtime");
    expect((prompts[0]!.message.payload as { metadata: { kind: string } }).metadata.kind).toBe("user_decision");
  });

  it("is idempotent for an identical pending request", async () => {
    const f = await fixture(); const runtime = f.runtime();
    const first = await request(runtime, developerPane());
    const second = await request(f.runtime(), developerPane());
    expect((second as unknown as { approvalId: string }).approvalId).toBe((first as unknown as { approvalId: string }).approvalId);
    const full = await f.journal.exclusive(async s => s);
    expect(full.outbound.filter(out => out.message.type === "approval.request")).toHaveLength(1);
  });

  it("lets the Coordinator ask for a run it coordinates without a specialist execution", async () => {
    const f = await fixture();
    const receipt = await request(f.runtime(), coordinatorPane());
    expect(receipt).toMatchObject({ status: "pending" });
  });

  it("refuses a specialist that is not bound to the run and task", async () => {
    const f = await fixture();
    const stranger = PaneBindingSchema.parse({ ...developerPane(), paneId: "pane-other", agentId: "other-agent" });
    await expect(request(f.runtime(), stranger)).rejects.toThrow("Runtime-bound specialist execution");
  });

  it("resumes the asking specialist with the selected option after an authenticated answer", async () => {
    const f = await fixture(); const receipt = await request(f.runtime(), developerPane());
    const approvalId = (receipt as unknown as { approvalId: string }).approvalId;
    f.setNow(T1);
    await deliver(f.runtime(), answer(approvalId));
    const full = await f.journal.exclusive(async s => s);
    const run = full.runs[0] as unknown as { userDecisions: Record<string, { status: string; answer: unknown }> };
    expect(run.userDecisions[approvalId]).toMatchObject({ status: "answered", answer: { outcome: "approved", selectedOption: "SQLite" } });
    const resume = full.outbound.filter(out => out.message.type === "task.status");
    expect(resume).toHaveLength(1);
    expect(resume[0]!.message.recipient).toMatchObject({ role: "developer", pane_id: "pane-developer", agent_id: "developer-agent" });
    expect(resume[0]!.message.payload).toMatchObject({ kind: "user_decision_answer", approvalId, outcome: "approved", selectedOption: "SQLite" });
    expect(full.outbound.filter(out => out.message.type === "approval.request")).toHaveLength(1);
  });

  it("rejects an unauthenticated answer and keeps the decision pending", async () => {
    const f = await fixture({ humanId: "human-1" }); const receipt = await request(f.runtime(), developerPane());
    const approvalId = (receipt as unknown as { approvalId: string }).approvalId;
    f.setNow(T1);
    await expect(deliver(f.runtime(), answer(approvalId, { decidedBy: "intruder" }))).rejects.toThrow("not authenticated");
    const full = await f.journal.exclusive(async s => s);
    expect((full.runs[0] as unknown as { userDecisions: Record<string, { status: string }> }).userDecisions[approvalId]!.status).toBe("pending");
    expect(full.outbound.some(out => out.message.type === "task.status")).toBe(false);
  });

  it("rejects a mismatched revision or generation without resuming", async () => {
    const f = await fixture(); const receipt = await request(f.runtime(), developerPane());
    const approvalId = (receipt as unknown as { approvalId: string }).approvalId;
    f.setNow(T1);
    await expect(deliver(f.runtime(), answer(approvalId, { revision: 2 }))).rejects.toThrow("revision");
    await expect(deliver(f.runtime(), answer(approvalId, { generation: 1, idempotencyKey: "answer-generation" }))).rejects.toThrow("generation");
    const full = await f.journal.exclusive(async s => s);
    expect((full.runs[0] as unknown as { userDecisions: Record<string, { status: string }> }).userDecisions[approvalId]!.status).toBe("pending");
    expect(full.outbound.some(out => out.message.type === "task.status")).toBe(false);
  });

  it("rejects an option outside the offered set", async () => {
    const f = await fixture(); const receipt = await request(f.runtime(), developerPane());
    const approvalId = (receipt as unknown as { approvalId: string }).approvalId;
    f.setNow(T1);
    await expect(deliver(f.runtime(), answer(approvalId, { metadata: { selectedOption: "Redis" } }))).rejects.toThrow("offered options");
  });

  it("resumes the asker with outcome expired when the answer arrives after expiry", async () => {
    const f = await fixture(); const receipt = await request(f.runtime(), developerPane(), { expiresInMinutes: 1 });
    const approvalId = (receipt as unknown as { approvalId: string }).approvalId;
    f.setNow("2026-10-18T10:03:00.000Z");
    await deliver(f.runtime(), answer(approvalId, { decidedAt: "2026-10-18T10:03:00.000Z" }));
    const full = await f.journal.exclusive(async s => s);
    expect((full.runs[0] as unknown as { userDecisions: Record<string, { status: string }> }).userDecisions[approvalId]!.status).toBe("expired");
    const resume = full.outbound.find(out => out.message.type === "task.status")!;
    expect(resume.message.payload).toMatchObject({ kind: "user_decision_answer", outcome: "expired" });
  });

  it("keeps a pending decision across a new runtime instance on the same journal", async () => {
    const f = await fixture(); const receipt = await request(f.runtime(), developerPane());
    const approvalId = (receipt as unknown as { approvalId: string }).approvalId;
    const restarted = f.runtime();
    const state = await restarted.inspect("run-1") as unknown as { userDecisions: Record<string, { status: string }> };
    expect(state.userDecisions[approvalId]!.status).toBe("pending");
    f.setNow(T2);
    await deliver(restarted, answer(approvalId, { decidedAt: T2 }));
    const full = await f.journal.exclusive(async s => s);
    expect(full.outbound.some(out => out.message.type === "task.status" && out.message.recipient.role === "developer")).toBe(true);
  });

  it("refuses new user decisions on a terminal run", async () => {
    const f = await fixture();
    await f.journal.exclusive(async (state, save) => { state.runs[0]!.status = "completed"; await save(); });
    await expect(request(f.runtime(), developerPane())).rejects.toThrow("Run is completed");
  });
});
