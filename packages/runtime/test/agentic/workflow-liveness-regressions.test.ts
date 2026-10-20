import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { ApprovalRequestSchema, DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema,
  type OperationResult, type PaneBinding, type RoleMessage } from "@bflow/contracts";
import { AgenticJournal, digest, type JournalState, type RunRecord } from "../../src/agentic/journal.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { RoleCapabilityPreflightError, type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { isCoordinatorTrigger } from "../../src/agentic/host-receipts.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { draft } from "../../../specification/test/fixtures.js";

const T0 = "2026-10-20T10:00:00.000Z";
const cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });

class Panes implements PanePolicy {
  readonly bindings: PaneBinding[] = ["conversation", "coordinator", "specifier", "architect", "planner", "reviewer", "qa", "tester", "security", "developer"].map(role =>
    PaneBindingSchema.parse({ schemaVersion: 2, bindingId: `binding-${role}`, sessionId: "session-1", role, paneGroup: "coordination",
      agentId: `${role}-agent`, workspaceId: "workspace-1", tabId: "tab-1", paneId: `pane-${role}`, provider: "test", agentKind: "test",
      cwd: "/tmp", isolationMode: "dedicated_pane", readOnlyWorkspace: role !== "developer",
      session: { source: "test", kind: "id", value: `session-${role}` }, transportState: "idle", boundAt: T0 }));
  async getManifest() {
    return { ok: true as const, value: { schemaVersion: 2 as const, sessionId: "session-1", projectName: "Test", workspaceRoot: "/tmp",
      herdrWorkspaceId: "workspace-1", herdrTabId: "tab-1", status: "up" as const, conversationSessionId: "session-1", activeRunIds: [],
      panes: this.bindings, attachTarget: { role: "conversation" as const, paneId: "pane-conversation" }, createdAt: T0, updatedAt: T0 } };
  }
  async getRoleBinding(selector: string): Promise<OperationResult<PaneBinding | null>> {
    return { ok: true, value: this.bindings.find(item => [item.role, item.bindingId, item.paneId, item.agentId].includes(selector)) ?? null };
  }
  async inspectRoleHealth(selector: string) {
    const pane = this.bindings.find(item => [item.role, item.bindingId, item.paneId, item.agentId].includes(selector));
    if (!pane) return { ok: false, error: { code: "not_found", message: "No pane", retryable: false } } as never;
    return { ok: true as const, value: { readyForPrompt: true, occupantMatches: true, paneId: pane.paneId, agentId: pane.agentId } };
  }
  async allocateDeveloper(): Promise<never> { throw new Error("not used in workflow liveness regressions"); }
  async releaseDeveloper() { return { ok: true as const, value: undefined }; }
}

const specification = draft("api");
function delegation(runId = "run-1") {
  return DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: `delegation-${runId}`, messageId: `intake-${runId}`,
    correlationId: `correlation-${runId}`, sessionId: "session-1", runId, requestedBy: "conversation", targetRole: "coordinator",
    title: "Workflow liveness regression", objective: "Exercise durable next actions", specificationId: specification.specId,
    sddLevel: specification.level, acceptanceCriteria: specification.acceptanceCriteria, inputArtifacts: [], priority: "normal",
    requestedAt: T0, idempotencyKey: `intake-${runId}` });
}
function run(runId: string, status: RunRecord["status"], overrides: Partial<RunRecord> = {}): RunRecord {
  return { runId, delegation: delegation(runId), status, tasks: [], coreCreated: false, cancelled: false, maxIterations: 3, ...overrides };
}
function envelope(id: string, runId: string, recipient: RoleMessage["recipient"], extra: Record<string, unknown> = {}): RoleMessage {
  return RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: `correlation-${runId}`, run_id: runId,
    sender: { role: "runtime" }, recipient, type: "task.status", payload: { headline: id }, artifact_references: [],
    occurred_at: T0, idempotency_key: id, ...extra });
}
function delegationEnvelope(runId = "run-1"): RoleMessage {
  const value = delegation(runId);
  return RoleMessageSchema.parse({ schema_version: 2, message_id: value.messageId, correlation_id: value.correlationId, run_id: runId,
    sender: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" }, recipient: { role: "coordinator" },
    type: "delegation.request", payload: value, artifact_references: [], occurred_at: T0, idempotency_key: value.idempotencyKey });
}

async function fixture(options: { runs?: RunRecord[]; preflight?: (binding: PaneBinding, required: readonly string[]) => Promise<void> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-liveness-regression-")));
  cleanup.push(root);
  const panes = new Panes(), transport = new FakeAgentTransport();
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });
  const conversationNotices: RoleMessage[] = [];
  const roleCapabilities: Record<string, string[]> = Object.fromEntries(panes.bindings.map(pane => [pane.role, pane.role === "conversation" ? ["conversation"] : ["repository.read"]]));
  const ports = { clock: () => new Date(T0), authenticateMessage: async () => true, authorizeHuman: async () => true,
    deliverToConversation: async (message: RoleMessage) => { conversationNotices.push(message); }, transport, registry, panes, roleCapabilities,
    preflightRoleCapabilities: options.preflight ?? (async () => undefined), engine: {}, runStore: {}, artifactStore: {}, policies: {},
    taskChecks: [], workflowChecks: [] } as unknown as AgenticRuntimePorts;
  const journalDirectory = join(root, "journal"), repository = join(root, "repo");
  const journal = new AgenticJournal(journalDirectory, repository);
  await journal.exclusive(async (state: JournalState, save) => { state.runs.push(...(options.runs ?? [run("run-1", "implementing")])); await save(); });
  const makeRuntime = () => new AgenticWorkflowRuntime(ports, { journalDirectory, repositoryPath: repository });
  const runtime = makeRuntime();
  const inspect = async () => await runtime.inspect() as unknown as JournalState;
  const notices = async (kind: string) => (await inspect()).outbound.filter(out => out.message.recipient.role === "conversation" &&
    (out.message.payload as { kind?: string }).kind === kind);
  return { root, panes, transport, registry, journal, runtime, makeRuntime, inspect, notices, conversationNotices };
}

describe("workflow liveness recovery boundaries", () => {
  it("coalesces simultaneous capability failures for one run and reloads the durable action", async () => {
    const f = await fixture({ preflight: async binding => {
      if (binding.role === "architect" || binding.role === "planner") throw new RoleCapabilityPreflightError(`${binding.role} tools unavailable`);
    } });
    await f.runtime.queueHerdr(envelope("cap-architect", "run-1", { role: "architect" }));
    await f.runtime.queueHerdr(envelope("cap-planner", "run-1", { role: "planner" }));
    await f.runtime.flushOutbound();
    const before = (await f.runtime.inspect("run-1")) as unknown as RunRecord;
    expect(before).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", state: "pending",
      sourceMessageId: "cap-architect", relatedMessageIds: ["cap-planner"] } });
    expect(await f.notices("workflow_blocked")).toHaveLength(1);
    const afterRestart = await f.makeRuntime().inspect("run-1") as unknown as RunRecord;
    expect(afterRestart.pendingAction).toEqual(before.pendingAction);
  });

  it("keeps a workflow approval pending when an unrelated role capability preflight fails", async () => {
    const approval = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: "approval-run-1", runId: "run-1", sessionId: "session-1",
      status: "pending", target: { type: "run" }, revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: T0,
      reason: "Human design approval", evidence: [], idempotencyKey: "approval-run-1" });
    const f = await fixture({ runs: [run("run-1", "awaiting_approval", { approval, approvalKind: "design" })],
      preflight: async binding => { if (binding.role === "architect") throw new RoleCapabilityPreflightError("Architect tool proof missing"); } });
    await f.runtime.queueHerdr(envelope("cap-architect", "run-1", { role: "architect" }));
    await f.runtime.flushOutbound();
    const current = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(current).toMatchObject({ status: "awaiting_approval", approval: { approvalId: "approval-run-1", status: "pending" } });
    expect(current.pendingAction).toBeUndefined();
    expect((await f.inspect()).outbound.some(out => (out.message.payload as { kind?: string }).kind === "resume_run")).toBe(false);
  });

  it("refuses to resume a cancelled blocker without queuing a Coordinator message", async () => {
    const sourceMessageId = "blocked-source";
    const action = { actionId: `next-${digest(["run-1", sourceMessageId])}`, kind: "resume_coordinator" as const, owner: "coordinator" as const,
      reason: "Coordinator stopped without a next action", sourceMessageId, createdAt: T0, state: "pending" as const,
      previousStatus: "implementing" as const, resumeAttempts: 0 };
    const f = await fixture({ runs: [run("run-1", "escalated", { pendingAction: action })] });
    await f.runtime.cancel("run-1", "User cancelled");
    await expect(f.runtime.resumeBlockedRun("run-1", action.actionId)).rejects.toThrow(/cancelled/);
    expect((await f.inspect()).outbound.some(out => (out.message.payload as { kind?: string }).kind === "resume_run")).toBe(false);
  });

  it("preserves a legitimate clarification after a specialist blocker when the Coordinator stops", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const turn = delegationEnvelope();
    await f.runtime.queueHerdr(turn);
    await f.runtime.flushOutbound();
    await f.runtime.receiveHerdr(RoleMessageSchema.parse({ schema_version: 2, message_id: "architect-blocked", correlation_id: turn.correlation_id,
      causation_id: "specialist-request", run_id: "run-1", sender: { role: "architect", agent_id: "architect-agent", pane_id: "pane-architect" },
      recipient: { role: "coordinator" }, type: "task.status", payload: { status: "blocked", reason: "Need one missing requirement" },
      artifact_references: [], occurred_at: T0, idempotency_key: "architect-blocked" }));
    await f.runtime.reportProgress("run-1", "I need one clarification", ["Which deployment target should this use?"]);
    await f.runtime.coordinatorTurnStopped(turn, f.panes.bindings.find(pane => pane.role === "coordinator")!);
    const state = await f.inspect(), current = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(current.status).toBe("clarifying");
    expect(current.pendingAction?.kind).not.toBe("resume_coordinator");
    expect(state.outbound.some(out => out.message.type === "conversation.clarification" && out.status === "queued")).toBe(true);
    expect(state.outbound.some(out => (out.message.payload as { kind?: string }).kind === "coordinator_no_response")).toBe(false);
  });

  it("recognizes a durable resume_run message as a tracked Coordinator turn trigger", () => {
    const resume = envelope("resume-1", "run-1", { role: "coordinator" }, { payload: { kind: "resume_run", actionId: "next-a" } });
    expect(isCoordinatorTrigger(resume)).toBe(true);
  });

  it("does not abort recoverable-run startup or resend while a run has unknown delivery", async () => {
    const sourceMessageId = "blocked-source";
    const action = { actionId: `next-${digest(["run-1", sourceMessageId])}`, kind: "resume_coordinator" as const, owner: "coordinator" as const,
      reason: "Coordinator stopped without a next action", sourceMessageId, createdAt: T0, state: "pending" as const,
      previousStatus: "implementing" as const, resumeAttempts: 0 };
    const f = await fixture({ runs: [run("run-1", "escalated", { pendingAction: action })] });
    f.transport.customSendHandler = request => ({ ok: true, value: { status: "unknown_delivery", requestId: request.requestId,
      attemptId: request.attemptId, runId: request.runId, taskId: request.taskId, observedAt: T0, reason: "ACK unknown" } as never });
    await f.runtime.queueHerdr(envelope("uncertain-architect", "run-1", { role: "architect" }));
    await f.runtime.flushOutbound();
    expect((await f.inspect()).outbound.find(out => out.message.message_id === "uncertain-architect")?.status).toBe("unknown_delivery");
    await expect(f.runtime.resumeRecoverableRuns()).resolves.toBeDefined();
    expect(f.transport.sentRequests).toHaveLength(1);
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord).status).toBe("escalated");
  });
});
