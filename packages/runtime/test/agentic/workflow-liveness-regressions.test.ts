import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { ApprovalDecisionSchema, ApprovalRequestSchema, DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema,
  type OperationResult, type PaneBinding, type RoleMessage } from "@bflow/contracts";
import { AgenticJournal, digest, type JournalState, type RunRecord } from "../../src/agentic/journal.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { RoleCapabilityPreflightError, type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { isCoordinatorTrigger, parseConversationResumeRequest } from "../../src/agentic/host-receipts.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { routeNativeConversationMessage } from "../../src/agentic/workspace.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { CoreSession } from "../../src/agentic/core-session.js";
import { vi } from "vitest";
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

async function fixture(options: { runs?: RunRecord[]; preflight?: (binding: PaneBinding, required: readonly string[]) => Promise<void>;
  authenticate?: (message: RoleMessage) => Promise<boolean> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-liveness-regression-")));
  cleanup.push(root);
  const panes = new Panes(), transport = new FakeAgentTransport();
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });
  const conversationNotices: RoleMessage[] = [];
  const roleCapabilities: Record<string, string[]> = Object.fromEntries(panes.bindings.map(pane => [pane.role, pane.role === "conversation" ? ["conversation"] : ["repository.read"]]));
  let now = Date.parse(T0);
  const ports = { clock: () => new Date(now), authenticateMessage: options.authenticate ?? (async () => true), authorizeHuman: async () => true,
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

describe("workflow liveness recovery boundaries", () => {
  it("inspects durable state without recovering Core or performing pending business work", async () => {
    const f = await fixture();
    const restore = vi.spyOn(CoreSession.prototype, "restore").mockRejectedValue(new Error("Recovery must not run during a status read"));
    try {
      await expect(f.runtime.inspect("run-1")).resolves.toMatchObject({ runId: "run-1", status: "implementing" });
      await expect(f.runtime.inspect()).resolves.toMatchObject({ runs: [{ runId: "run-1" }] });
      expect(restore).not.toHaveBeenCalled();
    } finally { restore.mockRestore(); }
  });

  it("durably receives a known native review while paused, then applies it once after authorized resume", async () => {
    const f = await fixture();
    f.runtime.ports.authenticateGateResult = async () => true;
    const request = envelope("review-request", "run-1", { role: "reviewer" }, { type: "verification.requested", payload: { definition: { id: "review-gate" }, taskId: "review-task" } });
    await f.runtime.queueHerdr(request); await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(pane => pane.role === "reviewer")!;
    const reply = envelope("review-result", "run-1", { role: "coordinator" }, { type: "review.verdict", causation_id: request.message_id,
      sender: { role: binding.role, agent_id: binding.agentId, pane_id: binding.paneId },
      payload: { gateId: "review-gate", runId: "run-1", taskId: "review-task", evaluationId: "evaluation", status: "passed", findings: [], producedArtifacts: [], evaluatedAt: T0 } });
    await f.runtime.reportRoleToolFailure(binding, { ...reply, artifact_references: undefined }, "artifact_references: Required");
    const pending = (await f.inspect()).runs[0]!.pendingAction!;
    await f.runtime.recordNativeDeliveryIntent(reply, "review-operation");
    await expect(f.runtime.receiveHerdr(reply)).resolves.toMatchObject({ received: true, deferred: true });
    let state = await f.inspect();
    expect(state.runs[0]).toMatchObject({ status: "escalated", pendingAction: pending });
    expect(state.inbox.find(item => item.message.message_id === reply.message_id)?.status).toBe("received");
    expect(state.runs[0]!.nativeDeliveries).toEqual([]);
    const restarted = f.makeRuntime();
    await restarted.reportUncertainNativeDelivery(reply, "review-operation", "Stale ACK snapshot");
    await restarted.recoverMissingCoordinatorWakeups();
    expect((await f.inspect()).runs[0]!.nativeDeliveries).toEqual([]);
    await restarted.resumeBlockedRun("run-1", pending.actionId);
    await restarted.recoverMissingCoordinatorWakeups(); await restarted.recoverMissingCoordinatorWakeups();
    state = await f.inspect();
    expect(state.inbox.filter(item => item.message.message_id === reply.message_id).map(item => item.status)).toEqual(["applied"]);
    expect(f.transport.sentRequests.filter(item => item.role === "reviewer")).toHaveLength(1);
    expect(state.runs[0]!.delegation.acceptanceCriteria).toEqual(delegation().acceptanceCriteria);
  });

  it.each(["payload", "causation", "message_id"] as const)("does not settle an uncertain intent from a conflicting signed reply with changed %s", async field => {
    const f = await fixture();
    const request = envelope("review-conflict-request", "run-1", { role: "reviewer" }, { type: "verification.requested" });
    await f.runtime.queueHerdr(request); await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(pane => pane.role === "reviewer")!;
    const original = envelope("review-conflict-result", "run-1", { role: "coordinator" }, { type: "review.verdict", causation_id: request.message_id,
      sender: { role: binding.role, agent_id: binding.agentId, pane_id: binding.paneId },
      payload: { gateId: "review-gate", runId: "run-1", taskId: "review-task", evaluationId: "original-evaluation", status: "passed", findings: [], producedArtifacts: [], evaluatedAt: T0 } });
    await f.runtime.reportRoleToolFailure(binding, { ...original, artifact_references: undefined }, "artifact_references: Required");
    const actionId = (await f.inspect()).runs[0]!.pendingAction!.actionId;
    await f.runtime.recordNativeDeliveryIntent(original, "original-operation");
    const changed = field === "payload" ? { ...original, payload: { ...original.payload as object, evaluationId: "different-evaluation" } }
      : field === "causation" ? { ...original, causation_id: "another-request" }
      : { ...original, message_id: "another-message-with-the-same-key" };
    await expect(f.runtime.receiveHerdr(changed)).rejects.toThrow(/Conflicting native delivery/);
    const state = await f.inspect();
    expect(state.inbox.some(item => item.message.message_id === original.message_id)).toBe(false);
    expect(state.runs[0]!.nativeDeliveries).toEqual([{ operationId: "original-operation", message: original }]);
    await expect(f.runtime.resumeBlockedRun("run-1", actionId)).rejects.toThrow(/Unknown.*delivery/);
  });

  it("retains exact Specialist Stop evidence while another native delivery is unresolved", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const first = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const unrelated = envelope("unrelated-native", "run-1", { role: "coordinator" }, { sender: { role: "planner" } });
    await f.runtime.recordNativeDeliveryIntent(unrelated, "other-operation");
    await f.runtime.specialistTurnStopped(f.panes.bindings.find(pane => pane.role === "architect")!, "architect");
    await expect(f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", [])).rejects.toThrow(/Unknown.*delivery/);
    const restarted = f.makeRuntime();
    await restarted.reconcileNativeDelivery(unrelated.message_id);
    const next = await restarted.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    expect(next.message_id).not.toBe(first.message_id);
    expect((await restarted.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage).message_id).toBe(next.message_id);
    await restarted.flushOutbound();
    expect(f.transport.sentRequests.filter(item => item.role === "architect")).toHaveLength(2);
  });

  it("does not treat a watchdog warning or resume as proof that an accepted specialist attempt stopped", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const first = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    await f.runtime.flushOutbound();
    await f.runtime.reportRunStalled("run-1", "episode-1");
    const action = (await f.inspect()).runs[0]!.pendingAction!;
    await f.runtime.resumeBlockedRun("run-1", action.actionId);
    const retried = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    expect(retried.message_id).toBe(first.message_id);
    await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.filter(req => req.role === "architect")).toHaveLength(1);
    expect((await f.inspect()).runs[0]!.tasks).toEqual([]);
  });

  it("does not use a legacy uncorrelated no-response wake as permission for a replacement attempt", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const first = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    await f.runtime.queueHerdr(envelope(`p19-wake-${digest(["run-1", `specialist_no_response:${first.message_id}`])}`, "run-1", { role: "coordinator" },
      { causation_id: first.message_id, payload: { kind: "specialist_no_response", fromRole: "architect", sourceMessageId: first.message_id } }));
    expect((await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage).message_id).toBe(first.message_id);
  });

  it("retains native uncertainty across a schema blocker, restart and repeated reports; resume cannot hide it", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const assignment = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(pane => pane.role === "architect")!;
    const reply = envelope("corrected-reply", "run-1", { role: "coordinator" }, {
      sender: { role: binding.role, agent_id: binding.agentId, pane_id: binding.paneId },
      causation_id: assignment.message_id, type: "spec.draft", payload: { summary: "Findings" }
    });
    await f.runtime.reportRoleToolFailure(binding, { ...reply, artifact_references: undefined }, "artifact_references: Required");
    await f.runtime.reportUncertainNativeDelivery(reply, "native-result", "ACK not observed");
    const restarted = f.makeRuntime();
    await restarted.reportUncertainNativeDelivery(reply, "native-result", "ACK still not observed");
    const current = await restarted.inspect("run-1") as unknown as RunRecord;
    await expect(restarted.resumeBlockedRun("run-1", current.pendingAction!.actionId)).rejects.toThrow(/Unknown.*delivery/i);
    expect(await f.notices("delivery_failure")).toHaveLength(1);
    expect(f.transport.sentRequests.filter(req => req.role === "architect")).toHaveLength(1);
    expect(await restarted.reconcileNativeDelivery(reply.message_id)).toBe(true);
    await restarted.resumeBlockedRun("run-1", current.pendingAction!.actionId);
    await restarted.receiveHerdr(reply);
    await restarted.receiveHerdr(reply);
    await restarted.recoverMissingCoordinatorWakeups();
    await restarted.recoverMissingCoordinatorWakeups();
    const state = await f.inspect();
    expect(state.inbox.filter(item => item.message.message_id === reply.message_id && item.status === "applied")).toHaveLength(1);
    expect(state.outbound.filter(out => out.message.message_id === `p19-wake-${digest(["run-1", reply.message_id])}`)).toHaveLength(1);
    expect(state.runs[0]!.delegation.acceptanceCriteria).toEqual(delegation().acceptanceCriteria);
    expect(state.runs).toHaveLength(1);
    expect(f.transport.sentRequests.filter(req => req.role === "architect")).toHaveLength(1);
  });

  it("does not attach a startup or stale-session Stop to an assignment of another native session", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const first = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(pane => pane.role === "architect")!;
    await f.runtime.specialistTurnStopped({ ...binding, session: { ...binding.session!, value: "other-session" } }, "architect");
    await f.runtime.specialistTurnStopped(binding, "architect", T0); // startup Stop precedes this accepted handle
    expect(await f.notices("specialist_no_response")).toEqual([]);
    await f.runtime.reportRoleToolFailure({ ...binding, session: { ...binding.session!, value: "other-session" } },
      { run_id: "run-1", message_id: "old-invalid-output", causation_id: first.message_id }, "artifact_references: Required");
    expect((await f.inspect()).runs[0]!.status).toBe("specifying");
    const retried = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    expect(retried.message_id).toBe(first.message_id);
  });

  it("watchdog reports the actual delivery state, task, attempt and acceptance time once per episode", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []);
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const accepted = (await f.inspect()).outbound.find(out => out.message.recipient.role === "architect")!;
    await f.runtime.reportRunStalled("run-1", "episode-1");
    await f.runtime.reportRunStalled("run-1", "episode-1");
    const notices = await f.notices("run_stalled");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message.payload).toMatchObject({ role: "architect", paneId: "pane-architect", taskId: accepted.taskId,
      attemptId: accepted.attemptId, acceptedAt: accepted.handle!.acceptedAt, deliveryStatus: "released" });
    expect(String((notices[0]!.message.payload as { reason: string }).reason)).toContain("transport accepted at");
  });

  it.each(["completed", "blocked"])("accepts a late exact native specialist %s result during a schema pause without approving or resuming the run", async status => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const assignment = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(pane => pane.role === "architect")!;
    const reply = envelope("late-native-result", "run-1", { role: "coordinator" }, { type: "spec.draft", causation_id: assignment.message_id,
      sender: { role: "architect", agent_id: binding.agentId, pane_id: binding.paneId }, payload: { status, summary: "Impact analysis" } });
    await f.runtime.reportRoleToolFailure(binding, { ...reply, artifact_references: undefined }, "artifact_references: Required");
    const actionId = (await f.inspect()).runs[0]!.pendingAction!.actionId;
    await f.runtime.recordNativeDeliveryIntent(reply, "native-late");
    await expect(f.runtime.receiveHerdr(reply)).resolves.toEqual({ accepted: true });
    await f.runtime.reconcileNativeDelivery(reply.message_id);
    expect(await f.runtime.inspect("run-1")).toMatchObject({ status: "escalated", pendingAction: { actionId, state: "pending" }, tasks: [] });
    await f.runtime.resumeBlockedRun("run-1", actionId);
    expect((await f.inspect()).runs[0]!.delegation).toEqual(delegation());
    expect(f.transport.sentRequests.filter(req => req.role === "architect")).toHaveLength(1);
  });

  it("replays an exact received native reply after restart while retaining the schema pause", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const assignment = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(pane => pane.role === "architect")!;
    const reply = envelope("crash-before-native-apply", "run-1", { role: "coordinator" }, { type: "spec.draft", causation_id: assignment.message_id,
      sender: { role: "architect", agent_id: binding.agentId, pane_id: binding.paneId }, payload: { summary: "Findings" } });
    await f.runtime.reportRoleToolFailure(binding, { ...reply, artifact_references: undefined }, "artifact_references: Required");
    await f.runtime.recordNativeDeliveryIntent(reply, "native-crash");
    await f.journal.exclusive(async (state, save) => { state.inbox.push({ message: reply, status: "received" }); await save(); });
    const restarted = f.makeRuntime();
    await restarted.recoverMissingCoordinatorWakeups(); await restarted.recoverMissingCoordinatorWakeups();
    const state = await f.inspect();
    expect(state.inbox.find(item => item.message.message_id === reply.message_id)?.status).toBe("applied");
    expect(state.runs[0]!).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", state: "pending" } });
    expect(state.runs[0]!.nativeDeliveries).toEqual([]);
    expect(state.outbound.filter(out => out.message.message_id === `p19-wake-${digest(["run-1", reply.message_id])}`)).toHaveLength(1);
  });

  it("recovers private native intents and durable ACKs before any capability-repair resume", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const binding = f.panes.bindings.find(pane => pane.role === "architect")!;
    await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []); await f.runtime.flushOutbound();
    await f.runtime.reportRoleToolFailure(binding, { run_id: "run-1", message_id: "invalid-output" }, "artifact_references: Required");
    await f.journal.exclusive(async (state, save) => { state.runs[0]!.pendingAction!.recovery = "capability_repair"; await save(); });
    const receipts = new HostReceiptJournal(join(f.root, "native-receipts"), join(f.root, "repo"), "session-1");
    const reply = envelope("native-host-only", "run-1", { role: "coordinator" }, { type: "spec.draft", sender: { role: "architect" } });
    await receipts.recordNativeIntent("host-operation", reply);
    const restarted = f.makeRuntime();
    await receipts.recoverNativeDeliveries(restarted);
    expect(await restarted.resumeRecoverableRuns()).toMatchObject({ resumed: 0 });
    // Crash after private host ACK write but before Runtime reconciliation; the next restart must consume that ACK.
    await receipts.recordNativeAcknowledgement(reply);
    const restartedAgain = f.makeRuntime();
    await receipts.recoverNativeDeliveries(restartedAgain);
    expect((await restartedAgain.inspect("run-1") as unknown as RunRecord).nativeDeliveries).toEqual([]);
    expect(await restartedAgain.resumeRecoverableRuns()).toMatchObject({ resumed: 1 });
  });

  it("keeps two native intents independent, immutable and blocking every new work dispatch until both settle", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const reply = envelope("native-1", "run-1", { role: "coordinator" }, { sender: { role: "architect" }, type: "spec.draft" });
    await f.runtime.recordNativeDeliveryIntent(reply, "op-1");
    await f.runtime.recordNativeDeliveryIntent({ ...reply, message_id: "native-2", idempotency_key: "native-2" }, "op-2");
    await expect(f.runtime.recordNativeDeliveryIntent({ ...reply, payload: { changed: true } }, "op-1")).rejects.toThrow(/Conflicting/);
    await expect(f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", [])).rejects.toThrow(/Unknown.*delivery/i);
    // queueHerdr callers cannot bypass the dispatch guard with a differently named assignment.
    await f.runtime.queueHerdr(envelope("another-assignment", "run-1", { role: "architect" }, { type: "delegation.request", sender: { role: "coordinator" } }));
    await f.runtime.flushOutbound();
    expect(f.transport.sentRequests).toHaveLength(0);
    await f.runtime.reconcileNativeDelivery("native-1");
    await f.runtime.flushOutbound();
    expect(f.transport.sentRequests).toHaveLength(0);
    expect((await f.inspect()).runs[0]!.nativeDeliveries).toHaveLength(1);
    await f.runtime.reconcileNativeDelivery("native-2");
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.filter(req => req.role === "architect")).toHaveLength(1);
  });

  it("coalesces simultaneous capability failures for one run and reloads the durable action", async () => {
    const f = await fixture({ preflight: async binding => {
      if (binding.role === "architect" || binding.role === "planner") throw new RoleCapabilityPreflightError(`${binding.role} tools unavailable`);
    } });
    await f.runtime.queueHerdr(envelope("cap-architect", "run-1", { role: "architect" }));
    await f.runtime.queueHerdr(envelope("cap-planner", "run-1", { role: "planner" }));
    await f.flushPreflight();
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
    await f.flushPreflight();
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
  it("delivers Coordinator status updates to Conversation when no live run matches (unknown, completed, other correlation)", async () => {
    const f = await fixture({ runs: [run("run-1", "implementing"), run("run-done", "completed")],
      authenticate: async message => message.message_id !== "forged" });
    const delivered: string[] = [];
    const conversation = { receiveHerdr: async (message: RoleMessage) => { delivered.push(message.message_id); return { ok: true }; } };
    const coordinator = { role: "coordinator", agent_id: "coordinator-agent", pane_id: "pane-coordinator" };
    const status = (id: string, runId: string | undefined, extra: Record<string, unknown> = {}) => RoleMessageSchema.parse({ schema_version: 2,
      message_id: id, correlation_id: `correlation-${runId ?? "none"}`, ...(runId ? { run_id: runId } : {}), sender: coordinator,
      recipient: { role: "conversation" }, type: "task.status", payload: { status: "completed", headline: id }, artifact_references: [],
      occurred_at: T0, idempotency_key: id, ...extra });
    // RoleMessageSchema already requires run_id for these workflow-scoped types; the Runtime no-op covers legacy callers.
    for (const message of [status("unknown-run", "run-missing"), status("final-after-complete", "run-done"),
      status("other-correlation", "run-1", { correlation_id: "correlation-other" })])
      await expect(routeNativeConversationMessage(f.runtime as never, conversation as never, message)).resolves.toEqual({ ok: true });
    expect(delivered).toEqual(["unknown-run", "final-after-complete", "other-correlation"]);
    expect((await f.inspect()).inbox).toEqual([]);
    expect((await f.runtime.inspect("run-done") as unknown as RunRecord).status).toBe("completed");
    await expect(routeNativeConversationMessage(f.runtime as never, conversation as never, status("forged", "run-1"))).rejects.toThrow(/Unauthenticated/);
    expect(delivered).not.toContain("forged");
  });

  it("keeps the run live on a transient inbound failure and escalates only a final one", async () => {
    const f = await fixture();
    const result = (id: string) => RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: "correlation-run-1", run_id: "run-1",
      causation_id: "assignment", sender: { role: "architect", agent_id: "architect-agent", pane_id: "pane-architect" }, recipient: { role: "coordinator" },
      type: "spec.draft", payload: { status: "completed", summary: id }, artifact_references: [], occurred_at: T0, idempotency_key: id });
    await f.runtime.reportInboundFailure(result("transient"), "Error: Conversation host is not ready");
    await f.runtime.reportInboundFailure(result("journal"), "Error: EBUSY: journal write failed");
    let current = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(current.status).toBe("implementing"); expect(current.pendingAction).toBeUndefined();
    expect(await f.notices("delivery_failure")).toHaveLength(2); // still visible, never silent
    await f.runtime.reportInboundFailure(result("dropped"), "Error: Wrong run correlation (dropped after 5 attempts)");
    current = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(current).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", sourceMessageId: "dropped", previousStatus: "implementing" } });
  });

  it("defers a specialist result that arrives while the run is paused for resume and applies it exactly once afterwards", async () => {
    let plannerReady = false;
    const f = await fixture({ runs: [run("run-1", "specifying")], preflight: async binding => {
      if (binding.role === "planner" && !plannerReady) throw new RoleCapabilityPreflightError("planner tools/list proof missing");
    } });
    const architect = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    await f.runtime.flushOutbound();
    await f.runtime.requestSpecialist("run-1", "planner", "Plan tasks", []);
    await f.flushPreflight();
    const paused = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(paused).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", state: "pending" } });
    const reply = RoleMessageSchema.parse({ schema_version: 2, message_id: "architect-draft", correlation_id: "correlation-run-1", run_id: "run-1",
      causation_id: architect.message_id, sender: { role: "architect", agent_id: "architect-agent", pane_id: "pane-architect" },
      recipient: { role: "coordinator" }, type: "spec.draft", payload: { status: "completed", summary: "Impact analysis" },
      artifact_references: [], occurred_at: T0, idempotency_key: "architect-draft" });
    const error = await f.runtime.receiveHerdr(reply).then(() => undefined, (failure: unknown) => String(failure));
    expect(error).toMatch(new RegExp(`paused awaiting resume of action ${paused.pendingAction!.actionId}; retry this same call after the run resumes`));
    await f.runtime.reportInboundFailure(reply, error!); // ingress `failed` callback
    await f.runtime.recoverMissingCoordinatorWakeups(); // replay during the pause defers it again
    let state = await f.inspect();
    expect(state.inbox.find(item => item.message.message_id === "architect-draft")?.status).toBe("received");
    expect(await f.notices("delivery_failure")).toHaveLength(0);
    plannerReady = true;
    await f.runtime.resumeBlockedRun("run-1", paused.pendingAction!.actionId);
    await f.runtime.tick(); await f.runtime.tick();
    state = await f.inspect();
    expect(state.inbox.filter(item => item.message.message_id === "architect-draft").map(item => item.status)).toEqual(["applied"]);
    const wakes = state.outbound.filter(out => out.message.recipient.role === "coordinator" && out.message.causation_id === "architect-draft");
    expect(wakes).toHaveLength(1);
    expect(f.transport.sentRequests.filter(request => request.role === "architect")).toHaveLength(1);
    expect(f.transport.sentRequests.filter(request => request.role === "planner")).toHaveLength(1);
    const current = state.runs.find(item => item.runId === "run-1")!;
    expect(current.status).not.toBe("escalated");
    const owes = (f.runtime as unknown as { outboundOwesResult(state: JournalState, run: RunRecord, out: unknown): boolean }).outboundOwesResult;
    expect(owes.call(f.runtime, state, current, state.outbound.find(out => out.message.message_id === architect.message_id))).toBe(false);
    expect(await f.notices("delivery_failure")).toHaveLength(0);
  });
  it("accepts natural explicit resume replies and refuses negations or other instructions", () => {
    for (const phrase of ["tiếp tục", "Tiếp tục.", "tiếp tục đi", "ok tiếp tục", "oke tiếp tục nhé", "tiếp tục nhé", "được, tiếp tục nha",
      "hãy tiếp tục giúp mình", "vui lòng tiếp tục", "Continue please", "please resume", "resume!", "OK continue"])
      expect(parseConversationResumeRequest(phrase), phrase).toEqual({});
    expect(parseConversationResumeRequest("tiếp tục run-1 nhé")).toEqual({ runId: "run-1" });
    expect(parseConversationResumeRequest("resume run run-1 please")).toEqual({ runId: "run-1" });
    for (const phrase of ["không tiếp tục", "đừng tiếp tục", "don't continue", "do not resume", "tiếp tục không", "tiếp tục và sửa file README",
      "continue but skip tests", "ok", "tiếp", "tiếp tục đi rồi xoá branch", "please please please continue"])
      expect(parseConversationResumeRequest(phrase), phrase).toBeUndefined();
  });
  it("re-dispatches an identical specialist request as a new attempt only after the holder stopped without a result", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const first = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    expect((await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage).message_id).toBe(first.message_id);
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.filter(request => request.role === "architect")).toHaveLength(1);
    await f.runtime.specialistTurnStopped(f.panes.bindings.find(pane => pane.role === "architect")!, "architect");
    const second = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage;
    expect(second.message_id).not.toBe(first.message_id);
    expect((second.payload as { idempotencyKey: string }).idempotencyKey).toMatch(/#attempt-2$/);
    expect((await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", []) as unknown as RoleMessage).message_id).toBe(second.message_id);
    await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.filter(request => request.role === "architect")).toHaveLength(2);
    const state = await f.inspect(), current = state.runs[0]!;
    const owes = (f.runtime as unknown as { outboundOwesResult(state: JournalState, run: RunRecord, out: unknown): boolean }).outboundOwesResult;
    expect(owes.call(f.runtime, state, current, state.outbound.find(out => out.message.message_id === first.message_id))).toBe(false);
    expect(owes.call(f.runtime, state, current, state.outbound.find(out => out.message.message_id === second.message_id))).toBe(true);
  });
  it("retries a transient capability preflight failure instead of failing the unsent message on the first error", async () => {
    let failures = 1;
    const f = await fixture({ preflight: async binding => {
      if (binding.role === "architect" && failures-- > 0) throw new RoleCapabilityPreflightError("herdr agent get timed out");
    } });
    await f.runtime.queueHerdr(envelope("transient-architect", "run-1", { role: "architect" }));
    await f.flushPreflight();
    expect((await f.inspect()).outbound.find(out => out.message.message_id === "transient-architect")?.status).toMatch(/accepted|released/);
    expect(f.transport.sentRequests).toHaveLength(1);
    expect(await f.runtime.inspect("run-1")).toMatchObject({ status: "implementing" });
    expect(await f.notices("workflow_blocked")).toEqual([]);
  });

  it("turns a capability failure held during an approval wait into a resumable action once the wait resolves", async () => {
    let ready = false;
    const approval = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: "approval-run-1", runId: "run-1", sessionId: "session-1",
      status: "pending", target: { type: "run" }, revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: T0,
      reason: "Human design approval", evidence: [], idempotencyKey: "approval-run-1" });
    const f = await fixture({ runs: [run("run-1", "awaiting_approval", { approval, approvalKind: "design" })],
      preflight: async binding => { if (binding.role === "coordinator" && !ready) throw new RoleCapabilityPreflightError("Coordinator tool proof missing"); } });
    await f.runtime.queueHerdr(envelope("wake-during-approval", "run-1", { role: "coordinator" }));
    await f.flushPreflight();
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord).pendingAction).toBeUndefined();
    await f.journal.exclusive(async (state: JournalState, save) => { // the human decision resolved the gate
      const current = state.runs[0]!; current.status = "implementing"; delete current.approval; delete current.approvalKind; await save(); });
    await f.runtime.flushOutbound();
    const blocked = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(blocked).toMatchObject({ status: "escalated", pendingAction: { sourceMessageId: "wake-during-approval", state: "pending", previousStatus: "implementing" } });
    ready = true;
    await f.runtime.resumeBlockedRun("run-1", blocked.pendingAction!.actionId); await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.filter(request => request.instruction.includes("wake-during-approval"))).toHaveLength(1);
  });

  it("does not auto-resume a blocker that merely mentions the repository and keeps the automatic budget across episodes", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const coordinator = { role: "coordinator", agent_id: "coordinator-agent", pane_id: "pane-coordinator" };
    const blocked = (id: string, reason: string) => RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: "correlation-run-1",
      run_id: "run-1", sender: coordinator, recipient: { role: "conversation" }, type: "task.status", payload: { status: "blocked", reason },
      artifact_references: [], occurred_at: T0, idempotency_key: id });
    await f.runtime.observeCoordinatorOutcome(blocked("free-text", "The repository has no tests for this module"));
    const manual = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(manual.pendingAction).toMatchObject({ recovery: "manual", resumeAttempts: 0 });
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    // A capability blocker backed by a recorded preflight failure carries the automatic budget of the episode it follows.
    let ready = false;
    const g = await fixture({ runs: [run("run-1", "specifying")], preflight: async binding => {
      if (binding.role === "architect" && !ready) throw new RoleCapabilityPreflightError("architect tools/list proof missing"); } });
    await g.runtime.queueHerdr(envelope("cap-architect", "run-1", { role: "architect" }));
    await g.flushPreflight();
    await g.journal.exclusive(async (state: JournalState, save) => { // three automatic resumes of this episode already happened
      const current = state.runs[0]!; current.status = "specifying"; current.pendingAction = { ...current.pendingAction!, state: "queued", resumeAttempts: 3 };
      await save(); });
    await g.runtime.observeCoordinatorOutcome(blocked("still-blocked", "architect repository read-only tool is still unavailable"));
    expect((await g.runtime.inspect("run-1") as unknown as RunRecord).pendingAction).toMatchObject({ recovery: "capability_repair", resumeAttempts: 3, state: "pending" });
    ready = true;
    expect(await g.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await g.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect((await g.notices("workflow_blocked")).filter(out => /Automatic resume stopped/.test(String((out.message.payload as { headline?: string }).headline)))).toHaveLength(1);
    expect((await g.inspect()).outbound.filter(out => (out.message.payload as { kind?: string }).kind === "resume_run")).toEqual([]);
  });
  it("records native delivery uncertainty without escalating and settles it on the late ACK or application", async () => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const reply = RoleMessageSchema.parse({ schema_version: 2, message_id: "late-ack-draft", correlation_id: "correlation-run-1", run_id: "run-1",
      sender: { role: "architect", agent_id: "architect-agent", pane_id: "pane-architect" }, recipient: { role: "coordinator" }, type: "spec.draft",
      payload: { status: "completed", summary: "Impact analysis" }, artifact_references: [], occurred_at: T0, idempotency_key: "late-ack-draft" });
    await f.runtime.reportUncertainNativeDelivery(reply, "op-late", "Native delivery acknowledgement was not observed");
    expect(await f.runtime.inspect("run-1")).toMatchObject({ status: "specifying",
      pendingAction: { kind: "reconcile_delivery", recovery: "reconcile_delivery", sourceMessageId: "late-ack-draft", state: "pending" } });
    expect(await f.notices("delivery_failure")).toHaveLength(1);
    await f.runtime.receiveHerdr(reply); // the message was delivered after all
    await f.runtime.recoverMissingCoordinatorWakeups();
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord).pendingAction?.kind).not.toBe("reconcile_delivery");
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord).status).toBe("specifying");
    // A host ACK alone (e.g. a Conversation-bound message) also settles it.
    await f.runtime.reportUncertainNativeDelivery({ ...reply, message_id: "late-ack-2", idempotency_key: "late-ack-2" }, "op-2", "ACK not observed");
    expect(await f.runtime.reconcileNativeDelivery("late-ack-2")).toBe(true);
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord).pendingAction).toBeUndefined();
    expect(f.transport.sentRequests).toEqual([]); // never resent
  });

  it("lets an authorized resume wake the Coordinator for a legacy escalated native-uncertainty record without resending", async () => {
    const sourceMessageId = "legacy-uncertain";
    const action = { actionId: `next-${digest(["run-1", sourceMessageId])}`, kind: "reconcile_delivery" as const, owner: "coordinator" as const,
      reason: "Unknown delivery", sourceMessageId, createdAt: T0, state: "pending" as const, previousStatus: "planning" as const };
    const f = await fixture({ runs: [run("run-1", "escalated", { pendingAction: action, error: "Unknown delivery" })] });
    await expect(f.runtime.resumeBlockedRun("run-1", action.actionId)).resolves.toMatchObject({ queued: true });
    expect(await f.runtime.inspect("run-1")).toMatchObject({ status: "planning", pendingAction: { state: "queued" } });
    const outbound = (await f.inspect()).outbound;
    expect(outbound.filter(out => (out.message.payload as { kind?: string }).kind === "resume_run")).toHaveLength(1);
    expect(outbound.some(out => out.message.message_id === sourceMessageId)).toBe(false);
  });
  it("admits a requirement revision for a run paused on a resumable blocker and settles the pause like a resume", async () => {
    const sourceMessageId = "clarify-source";
    const action = { actionId: `next-${digest(["run-1", sourceMessageId])}`, kind: "resume_coordinator" as const, owner: "coordinator" as const,
      reason: "Coordinator blocked: which deployment target?", sourceMessageId, createdAt: T0, state: "pending" as const,
      previousStatus: "specifying" as const, resumeAttempts: 0, recovery: "manual" as const };
    const revised = (runId: string) => { const base = delegation(runId);
      const value = DelegationRequestSchema.parse({ ...base, messageId: `intake-2-${runId}`, idempotencyKey: `intake-2-${runId}`, objective: "Clarified objective",
        metadata: { isRequirementChange: true, revision: 2 } });
      return RoleMessageSchema.parse({ schema_version: 2, message_id: value.messageId, correlation_id: value.correlationId, run_id: runId,
        sender: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" }, recipient: { role: "coordinator" },
        type: "delegation.request", payload: value, artifact_references: [], occurred_at: T0, idempotency_key: value.idempotencyKey }); };
    const f = await fixture({ runs: [run("run-1", "escalated", { pendingAction: action, error: action.reason }),
      run("run-terminal", "escalated", { error: "Task blocked or implementation retry policy exhausted" }),
      run("run-cancelled", "specifying", { cancelled: true })] });
    await expect(f.runtime.queueHerdr(revised("run-1"))).resolves.toBeDefined();
    const current = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(current).toMatchObject({ status: "specifying", pendingAction: { actionId: action.actionId, state: "queued", resumeAttempts: 1 },
      resumeReceipts: [{ actionId: action.actionId, messageId: "intake-2-run-1" }] });
    expect(current.error).toBeUndefined();
    await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.filter(request => request.role === "coordinator" && request.instruction.includes("intake-2-run-1"))).toHaveLength(1);
    await f.runtime.receiveHerdr(revised("run-1")); // its ingress admits the revision against the restored live run
    expect(await f.runtime.inspect("run-1")).toMatchObject({ status: "intake", delegation: { objective: "Clarified objective" } });
    await expect(f.runtime.queueHerdr(revised("run-terminal"))).rejects.toThrow(/escalated; requirement revisions are not accepted/);
    await expect(f.runtime.queueHerdr(revised("run-cancelled"))).rejects.toThrow(/cancelled/);
  });
  describe("human changes_requested continues as a follow-up run", () => {
    const designApproval = (runId: string) => ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: `design-${runId}`, runId, sessionId: "session-1",
      status: "pending", target: { type: "run" }, revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: T0,
      reason: "Human design approval required before implementation", evidence: [], idempotencyKey: `design:${runId}` });
    const awaitingDesign = (runId: string, metadata: Record<string, unknown> = {}) => {
      const base = run(runId, "awaiting_approval", { approval: designApproval(runId), approvalKind: "design", baseRevision: "a".repeat(40) });
      if (Object.keys(metadata).length) base.delegation = DelegationRequestSchema.parse({ ...base.delegation, metadata });
      return base;
    };
    const decide = (runId: string, decision: "changes_requested" | "rejected", id = `decision-${runId}-${decision}`) => RoleMessageSchema.parse({ schema_version: 2,
      message_id: id, correlation_id: `correlation-${runId}`, run_id: runId, sender: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" },
      recipient: { role: "coordinator" }, type: "approval.decision", artifact_references: [], occurred_at: T0, idempotency_key: id,
      payload: ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: `design-${runId}`, runId, sessionId: "session-1", target: { type: "run" },
        revision: 1, generation: 0, decision, reason: "Use a feature flag", decidedBy: "human-1", decidedAt: T0, feedbackArtifacts: [], idempotencyKey: id }) });
    const wakes = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.inspect()).outbound.filter(out =>
      out.message.recipient.role === "coordinator" && (out.message.payload as { kind?: string }).kind === "changes_requested");

    it("continues a design-approval changes_requested as run-r2 with the feedback, unchanged criteria and the parent's base", async () => {
      const f = await fixture({ runs: [awaitingDesign("run-1")] });
      await f.runtime.receiveHerdr(decide("run-1", "changes_requested"));
      const parent = await f.runtime.inspect("run-1") as unknown as RunRecord, child = await f.runtime.inspect("run-1-r2") as unknown as RunRecord;
      expect(parent).toMatchObject({ status: "escalated", supersededBy: "run-1-r2", error: "Changes requested; continued as run-1-r2", decision: { decision: "changes_requested" } });
      expect(parent.pendingAction).toBeUndefined();
      expect(child).toMatchObject({ status: "planning", coreCreated: false, baseRevision: "a".repeat(40),
        delegation: { runId: "run-1-r2", correlationId: "correlation-run-1", sessionId: "session-1", specificationId: parent.delegation.specificationId,
          acceptanceCriteria: parent.delegation.acceptanceCriteria, objective: expect.stringContaining("Use a feature flag"),
          metadata: { parentRunId: "run-1", originRunId: "run-1", followUp: 2, supersededApprovalId: "design-run-1" } } });
      const [wake] = await wakes(f);
      expect(wake!.message).toMatchObject({ run_id: "run-1-r2", sender: { role: "runtime" },
        payload: { kind: "changes_requested", runId: "run-1", followUpRunId: "run-1-r2", approvalKind: "design", feedback: "Use a feature flag" } });
      expect(isCoordinatorTrigger(wake!.message)).toBe(true);
      expect(await f.notices("workflow_continued")).toHaveLength(1);
      // The parent points to its follow-up instead of resuming, and is never reported as stalled.
      await expect(f.runtime.resumeBlockedRun("run-1", "anything")).rejects.toThrow(/continued as follow-up run run-1-r2/);
      expect((await f.runtime.watchdogSnapshot("session-1")).find(item => item.runId === "run-1")).toMatchObject({ live: false });
    });

    it("is idempotent across a restart: the replayed decision creates no second child or wake", async () => {
      const f = await fixture({ runs: [awaitingDesign("run-1")] });
      const message = decide("run-1", "changes_requested");
      await f.runtime.receiveHerdr(message);
      const restarted = f.makeRuntime();
      await restarted.receiveHerdr(message);
      await restarted.recoverMissingCoordinatorWakeups(); await restarted.tick();
      const state = await restarted.inspect() as unknown as JournalState;
      expect(state.runs.map(item => item.runId).sort()).toEqual(["run-1", "run-1-r2"]);
      expect(state.outbound.filter(out => (out.message.payload as { kind?: string }).kind === "changes_requested")).toHaveLength(1);
      expect(state.outbound.filter(out => (out.message.payload as { kind?: string }).kind === "workflow_continued")).toHaveLength(1);
    });

    it("is bounded: after five follow-ups a further changes_requested escalates normally", async () => {
      const f = await fixture({ runs: [awaitingDesign("run-1-r6", { originRunId: "run-1", parentRunId: "run-1-r5", followUp: 6 })] });
      await f.runtime.receiveHerdr(decide("run-1-r6", "changes_requested"));
      const last = await f.runtime.inspect("run-1-r6") as unknown as RunRecord;
      expect(last).toMatchObject({ status: "escalated", error: "Use a feature flag" });
      expect(last.supersededBy).toBeUndefined();
      expect((await f.inspect()).runs.some(item => item.runId === "run-1-r7")).toBe(false);
      expect(await wakes(f)).toEqual([]);
    });

    it("still fails the run on rejected, and the follow-up child can be cancelled like any run", async () => {
      const f = await fixture({ runs: [awaitingDesign("run-1"), awaitingDesign("run-2")] });
      await f.runtime.receiveHerdr(decide("run-2", "rejected"));
      expect(await f.runtime.inspect("run-2")).toMatchObject({ status: "failed" });
      expect((await f.inspect()).runs.some(item => item.runId === "run-2-r2")).toBe(false);
      await f.runtime.receiveHerdr(decide("run-1", "changes_requested"));
      await f.runtime.cancel("run-1-r2", "User cancelled the follow-up");
      await f.runtime.tick();
      expect(await f.runtime.inspect("run-1-r2")).toMatchObject({ status: "cancelled", cancelled: true });
      expect(await f.runtime.inspect("run-1")).toMatchObject({ status: "escalated", supersededBy: "run-1-r2" });
      expect(f.transport.sentRequests.filter(request => request.role === "developer")).toEqual([]);
    });
  });
});
