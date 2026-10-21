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
  let now = Date.parse(T0);
  const ports = { clock: () => new Date(now), authenticateMessage: async () => true, authorizeHuman: async () => true,
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
  /** Flushes through the bounded capability-preflight retry backoff so a persistent failure becomes the durable blocker. */
  const flushPreflight = async () => { for (let attempt = 0; attempt < 5; attempt++) { await runtime.flushOutbound(); now += 60_000; } };
  return { root, panes, transport, registry, journal, runtime, makeRuntime, inspect, notices, conversationNotices, flushPreflight };
}

describe("root acceptance of durable next actions", () => {
  it("escalates an original Coordinator delegation that stopped with no next action", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const turn = delegationEnvelope();
    await f.runtime.queueHerdr(turn);
    await f.runtime.flushOutbound();
    await f.runtime.coordinatorTurnStopped(turn, f.panes.bindings.find(pane => pane.role === "coordinator")!);
    const current = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(current).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", owner: "coordinator" } });
  });

  it("recovers an applied specialist result with a missing Coordinator wake exactly once after restart", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const request = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", "Read repository", []));
    await f.runtime.flushOutbound();
    const reply = RoleMessageSchema.parse({ schema_version: 2, message_id: "applied-reply", correlation_id: request.correlation_id,
      causation_id: request.message_id, run_id: "run-1", sender: { role: "architect", agent_id: "architect-agent", pane_id: "pane-architect" },
      recipient: { role: "coordinator" }, type: "spec.draft", payload: { status: "blocked", reason: "Read capability missing" },
      artifact_references: [], occurred_at: T0, idempotency_key: "applied-reply" });
    await f.runtime.receiveHerdr(reply);
    await f.journal.exclusive(async (state, save) => {
      state.outbound = state.outbound.filter(out => !(out.message.sender.role === "runtime" && out.message.recipient.role === "coordinator" &&
        out.message.causation_id === reply.message_id));
      delete state.runs[0]!.pendingAction;
      await save();
    });
    const restarted = f.makeRuntime();
    await restarted.initialize();
    await restarted.tick();
    await restarted.tick();
    const state = await restarted.inspect() as unknown as JournalState;
    expect(state.outbound.filter(out => out.message.sender.role === "runtime" && out.message.recipient.role === "coordinator" &&
      out.message.causation_id === reply.message_id)).toHaveLength(1);
    expect(f.transport.sentRequests.filter(item => item.target.paneId === "pane-architect")).toHaveLength(1);
  });
  it("replays already-authenticated received inbox rows after transport authentication context expires", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const request = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", "Read repository", []));
    await f.runtime.flushOutbound();
    const reply = RoleMessageSchema.parse({ schema_version: 2, message_id: "received-reply", correlation_id: request.correlation_id,
      causation_id: request.message_id, run_id: "run-1", sender: { role: "architect", agent_id: "architect-agent", pane_id: "pane-architect" },
      recipient: { role: "coordinator" }, type: "spec.draft", payload: { status: "blocked", reason: "Read capability missing" },
      artifact_references: [], occurred_at: T0, idempotency_key: "received-reply" });
    await f.runtime.receiveHerdr(reply);
    await f.journal.exclusive(async (state, save) => {
      state.inbox.find(item => item.message.message_id === reply.message_id)!.status = "received";
      state.outbound = state.outbound.filter(out => !(out.message.sender.role === "runtime" && out.message.recipient.role === "coordinator" &&
        out.message.causation_id === reply.message_id));
      delete state.runs[0]!.pendingAction;
      await save();
    });
    f.runtime.ports.authenticateMessage = async () => false;
    const restarted = f.makeRuntime();
    await restarted.recoverMissingCoordinatorWakeups();
    const state = await restarted.inspect() as unknown as JournalState;
    expect(state.inbox.find(item => item.message.message_id === reply.message_id)?.status).toBe("applied");
    expect(state.outbound.filter(out => out.message.sender.role === "runtime" && out.message.recipient.role === "coordinator" &&
      out.message.causation_id === reply.message_id)).toHaveLength(1);
    await expect(restarted.receiveHerdr({ ...reply, message_id: "forged-new", idempotency_key: "forged-new" })).rejects.toThrow("Unauthenticated");
  });

  it("reconciles a legacy acknowledged Coordinator blocker through owned receipt provenance", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const { HostReceiptJournal } = await import("../../src/agentic/host-receipts.js");
    const { authenticateNativeHerdrMessage } = await import("../../src/agentic/herdr-ingress.js");
    const receiptStore = new HostReceiptJournal(join(f.root, "host-receipts"), f.journal.repository, "session-1");
    const message = envelope("legacy-blocker", "run-1", { role: "conversation" }, {
      sender: { role: "coordinator", agent_id: "coordinator-agent", pane_id: "pane-coordinator" },
      payload: { status: "blocked", reason: "Repository read capability unavailable" } });
    await receiptStore.recordNativeAcknowledgement(message);
    f.runtime.ports.authenticateMessage = authenticateNativeHerdrMessage;
    expect(await authenticateNativeHerdrMessage(message)).toBe(false);
    const reopened = new HostReceiptJournal(receiptStore.directory, receiptStore.repository, "session-1");
    await reopened.replayAcknowledgedCoordinatorOutcomes(input => f.runtime.observeCoordinatorOutcome(input));
    expect(await f.runtime.inspect("run-1")).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator" } });
    expect(await authenticateNativeHerdrMessage(message)).toBe(false);
  });

  it("allows a second bounded repair when capability is revoked before the resumed unsent intent dispatches", async () => {
    let ready = false;
    const f = await fixture({ runs: [run("run-1", "specifying")], preflight: async () => {
      if (!ready) throw new RoleCapabilityPreflightError("Read proof revoked");
    } });
    await f.runtime.queueHerdr(envelope("repair-race", "run-1", { role: "coordinator" }));
    await f.flushPreflight();
    const actionId = (await f.runtime.inspect("run-1") as unknown as RunRecord).pendingAction!.actionId;
    ready = true; await f.runtime.resumeBlockedRun("run-1", actionId);
    ready = false; await f.flushPreflight();
    expect(f.transport.sentRequests).toHaveLength(0);
    ready = true; await f.runtime.resumeBlockedRun("run-1", actionId); await f.runtime.flushOutbound();
    expect(f.transport.sentRequests).toHaveLength(1);
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord).status).toBe("specifying");
  });

  it("keeps an unknown delivery actionable and never diagnoses it as idle work or resends it", async () => {
    const f = await fixture({ runs: [run("run-1", "planning")] });
    f.transport.customSendHandler = request => ({ ok: true, value: { status: "unknown_delivery", requestId: request.requestId,
      attemptId: request.attemptId, runId: request.runId, taskId: request.taskId, observedAt: T0, reason: "ACK unknown" } as never });
    await f.runtime.queueHerdr(envelope("unknown-1", "run-1", { role: "architect" }));
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const { evaluateWatchdog } = await import("../../src/agentic/run-watchdog.js");
    const runs = await f.runtime.watchdogSnapshot("session-1");
    expect(evaluateWatchdog({ now: Date.parse(T0) + 600_000, runs, notices: [], panes: [{ role: "architect", status: "idle" }] })).toEqual([]);
    expect(await f.runtime.inspect("run-1")).toMatchObject({ pendingAction: { owner: "coordinator", recovery: "reconcile_delivery", sourceMessageId: "unknown-1" } });
    expect(f.transport.sentRequests).toHaveLength(1);
  });

  it("retains the result obligation while a specialist sends progress and is still working", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const request = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", "Inspect repository", []));
    await f.runtime.flushOutbound();
    await f.runtime.receiveHerdr(envelope("architect-progress", "run-1", { role: "coordinator" }, {
      sender: { role: "architect", agent_id: "architect-agent", pane_id: "pane-architect" }, causation_id: request.message_id,
      payload: { status: "working", headline: "Reading source" } }));
    const runs = await f.runtime.watchdogSnapshot("session-1");
    expect(runs[0]!.acceptedRoles).toContain("architect");
    const { evaluateWatchdog } = await import("../../src/agentic/run-watchdog.js");
    expect(evaluateWatchdog({ now: Date.parse(T0) + 600_000, runs, notices: [], panes: [
      { role: "architect", paneId: "pane-architect", status: "working" }, { role: "coordinator", paneId: "pane-coordinator", status: "idle" } ] })).toEqual([]);
  });

  it("persists intake and a resumable blocker when the first Coordinator dispatch fails capability preflight", async () => {
    let ready = false;
    const f = await fixture({ runs: [], preflight: async () => { if (!ready) throw new RoleCapabilityPreflightError("Coordinator reader unavailable"); } });
    const request = delegationEnvelope();
    await f.runtime.queueHerdr(request); await f.flushPreflight();
    const current = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(current).toMatchObject({ status: "escalated", coreCreated: false, pendingAction: { recovery: "capability_repair" } });
    expect(f.transport.sentRequests).toHaveLength(0);
    ready = true; await f.runtime.resumeBlockedRun("run-1", current.pendingAction!.actionId); await f.runtime.flushOutbound();
    expect(f.transport.sentRequests).toHaveLength(1);
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord).runId).toBe("run-1");
    expect((await f.inspect()).inbox).toHaveLength(0);
  });

});
