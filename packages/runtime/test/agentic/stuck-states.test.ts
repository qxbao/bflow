import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { ApprovalDecisionSchema, ApprovalRequestSchema, DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema,
  type OperationResult, type PaneBinding, type RoleMessage } from "@bflow/contracts";
import { AgenticJournal, digest, type JournalState, type Outbound, type RunRecord } from "../../src/agentic/journal.js";
import { CoreSession } from "../../src/agentic/core-session.js";
import { HerdrOutbox } from "../../src/agentic/outbox.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { routeNativeConversationMessage } from "../../src/agentic/workspace.js";
import { evaluateWatchdog } from "../../src/agentic/run-watchdog.js";
import type { AgenticRuntimePorts, PanePolicy } from "../../src/agentic/ports.js";
import { RoleCapabilityPreflightError } from "../../src/agentic/ports.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { draft } from "../../../specification/test/fixtures.js";

// Regression tests for the Wave 2 stuck-state audit: no run or handoff may stop without a Conversation-visible notice.

const T0 = "2026-10-18T10:00:00.000Z";
const MINUTE = 60_000;
const cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });

class Panes implements PanePolicy {
  /** Roles whose pane reads are not ready for a prompt. */
  busy = new Set<string>();
  /** Roles whose pane lookup fails (an I/O error, not "no pane"). */
  broken = new Set<string>();
  bindings: PaneBinding[] = ["conversation", "coordinator", "architect", "developer"].map(role => PaneBindingSchema.parse({
    schemaVersion: 2, bindingId: `binding-${role}`, sessionId: "session-1", role, paneGroup: "coordination", agentId: `${role}-agent`,
    workspaceId: "workspace-1", tabId: "tab-1", paneId: `pane-${role}`, provider: "test", agentKind: "test", cwd: "/tmp",
    isolationMode: "dedicated_pane", readOnlyWorkspace: role !== "developer", session: { source: "test", kind: "id", value: `session-${role}` },
    transportState: "idle", boundAt: T0 }));
  async getManifest() {
    return { ok: true as const, value: { schemaVersion: 2 as const, sessionId: "session-1", projectName: "Test", workspaceRoot: "/tmp",
      herdrWorkspaceId: "workspace-1", herdrTabId: "tab-1", status: "up" as const, conversationSessionId: "session-1", activeRunIds: [],
      panes: this.bindings, attachTarget: { role: "conversation" as const, paneId: "pane-conversation" }, createdAt: T0, updatedAt: T0 } };
  }
  private find(selector: string): PaneBinding | undefined {
    return this.bindings.find(pane => [pane.role, pane.bindingId, pane.paneId, pane.agentId].includes(selector));
  }
  async getRoleBinding(selector: string): Promise<OperationResult<PaneBinding | null>> {
    if (this.broken.has(selector)) return { ok: false, error: { code: "unavailable", message: "pane query failed", retryable: true } } as never;
    return { ok: true, value: this.find(selector) ?? null };
  }
  async inspectRoleHealth(selector: string) {
    const pane = this.find(selector);
    if (!pane) return { ok: false, error: { code: "not_found", message: "No pane", retryable: false } } as never;
    return { ok: true as const, value: { readyForPrompt: !this.busy.has(pane.role), occupantMatches: true, paneId: pane.paneId, agentId: pane.agentId } };
  }
  async allocateDeveloper(): Promise<never> { throw new Error("not used by these tests"); }
  async releaseDeveloper() { return { ok: true as const, value: undefined }; }
}

const specification = draft("api");
function delegation(runId = "run-1") {
  return DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: `delegation-${runId}`, messageId: `intake-${runId}`,
    correlationId: "correlation", sessionId: "session-1", runId, requestedBy: "conversation", targetRole: "coordinator",
    title: "Stuck-state test", objective: "Exercise recovery", specificationId: specification.specId, sddLevel: specification.level,
    acceptanceCriteria: specification.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: T0, idempotencyKey: `intake-${runId}` });
}

function run(runId: string, status: RunRecord["status"], overrides: Partial<RunRecord> = {}): RunRecord {
  return { runId, delegation: delegation(runId), status, tasks: [], coreCreated: false, cancelled: false, maxIterations: 3, ...overrides };
}

function message(id: string, overrides: Record<string, unknown> = {}): RoleMessage {
  return RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: "correlation", run_id: "run-1",
    sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status", payload: { headline: id },
    artifact_references: [], occurred_at: T0, idempotency_key: id, ...overrides });
}

async function fixture(options: { deliveryFails?: boolean; runs?: RunRecord[]; capabilityAllowed?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-stuck-states-")));
  cleanup.push(root);
  let now = Date.parse(T0);
  const panes = new Panes(), transport = new FakeAgentTransport();
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock: () => new Date(now) });
  const delivered: RoleMessage[] = [];
  const conversation = { attempts: 0, failing: options.deliveryFails ?? false };
  let capabilityAllowed = options.capabilityAllowed ?? true;
  const ports = {
    clock: () => new Date(now), authenticateMessage: async () => true, authorizeHuman: async () => true,
    deliverToConversation: async (value: RoleMessage) => {
      conversation.attempts++;
      if (conversation.failing) throw new Error("Gateway unavailable");
      delivered.push(value);
    },
    transport, registry, panes, roleCapabilities: { coordinator: ["repository.read"], architect: ["architecture", "repository.read"], developer: [], conversation: [] },
    preflightRoleCapabilities: async (_binding: PaneBinding, required: readonly string[]) => {
      if (required.includes("repository.read") && !capabilityAllowed) throw new RoleCapabilityPreflightError("Coordinator read-only tool reachability is missing");
    },
    engine: {}, runStore: {}, artifactStore: {}, policies: {}, taskChecks: [], workflowChecks: []
  } as unknown as AgenticRuntimePorts;
  const journalDirectory = join(root, "journal"), repository = join(root, "repo");
  const journal = new AgenticJournal(journalDirectory, repository);
  await journal.exclusive(async (state: JournalState, save) => { state.runs.push(...(options.runs ?? [run("run-1", "implementing")])); await save(); });
  const runtime = new AgenticWorkflowRuntime(ports, { journalDirectory, repositoryPath: repository });
  const outboundOf = async (id: string): Promise<Outbound> => {
    const found = (await runtime.inspect() as unknown as { outbound: Outbound[] }).outbound.find(out => out.message.message_id === id);
    if (!found) throw new Error(`no outbound ${id}`);
    return found;
  };
  const notices = async (kind: string, runId = "run-1") => (await runtime.inspect() as unknown as { outbound: Outbound[] }).outbound
    .filter(out => out.message.recipient.role === "conversation" && out.message.type === "conversation.progress" &&
      (out.message.payload as { kind?: string; runId?: string }).kind === kind && (out.message.payload as { runId?: string }).runId === runId);
  return {
    runtime, ports, panes, transport, registry, delivered, conversation, journal, outboundOf, notices,
    setCapabilityAllowed: (value: boolean) => { capabilityAllowed = value; },
    now: () => now, setNow: (ms: number) => { now = ms; }, advance: (ms: number) => { now += ms; }
  };
}

describe("outbox isolation and not-ready recipients", () => {
  it("records a failing outbound on that message and still dispatches later messages", async () => {
    const f = await fixture();
    f.panes.broken.add("developer");
    await f.runtime.queueHerdr(message("msg-broken", { recipient: { role: "developer" } }));
    await f.runtime.queueHerdr(message("msg-healthy"));
    await expect(f.runtime.flushOutbound()).resolves.toBeUndefined();
    expect((await f.outboundOf("msg-broken")).status).toBe("queued");
    expect((await f.outboundOf("msg-broken")).error).toContain("pane query failed");
    expect((await f.outboundOf("msg-broken")).deliveryAttempts).toBe(1);
    expect((await f.outboundOf("msg-healthy")).status).toBe("accepted");
    expect(f.transport.sentRequests.map(request => request.idempotency.key)).toEqual(["msg-healthy"]);
  });

  it("keeps a not-ready recipient queued, surfaces it once after five minutes with options, and recovers when ready", async () => {
    const f = await fixture();
    f.panes.busy.add("coordinator");
    await f.runtime.queueHerdr(message("msg-waiting"));
    await f.runtime.flushOutbound();
    expect(await f.outboundOf("msg-waiting")).toMatchObject({ status: "queued", notReadySince: T0 });
    expect((await f.outboundOf("msg-waiting")).error).toBeUndefined();
    expect(await f.notices("delivery_failure")).toHaveLength(0);

    f.advance(5 * MINUTE);
    await f.runtime.flushOutbound();
    const waiting = await f.outboundOf("msg-waiting");
    expect(waiting).toMatchObject({ status: "queued", error: `Recipient coordinator not ready since ${T0}` });
    const surfaced = await f.notices("delivery_failure");
    expect(surfaced).toHaveLength(1);
    expect((surfaced[0]!.message.payload as { options: string[] }).options.length).toBeGreaterThan(1);

    f.advance(MINUTE);
    await f.runtime.flushOutbound();
    expect(await f.notices("delivery_failure")).toHaveLength(1);

    f.panes.busy.delete("coordinator");
    await f.runtime.flushOutbound();
    expect(await f.outboundOf("msg-waiting")).toMatchObject({ status: "accepted" });
    expect((await f.outboundOf("msg-waiting")).notReadySince).toBeUndefined();
    expect((await f.outboundOf("msg-waiting")).error).toBeUndefined();
  });
});

describe("Conversation inbox delivery", () => {
  it("backs off between Gateway writes and marks the write failed after the bounded attempts", async () => {
    const f = await fixture({ deliveryFails: true });
    await f.runtime.queueHerdr(message("notice-1", { recipient: { role: "conversation" }, type: "conversation.progress" }));
    await f.runtime.flushOutbound();
    expect(f.conversation.attempts).toBe(1);
    expect(await f.outboundOf("notice-1")).toMatchObject({ status: "queued", deliveryAttempts: 1, error: "Error: Gateway unavailable" });

    await f.runtime.flushOutbound();
    expect(f.conversation.attempts).toBe(1); // inside the backoff window: no spin

    for (let attempt = 2; attempt <= 5; attempt++) { f.advance(2 * MINUTE); await f.runtime.flushOutbound(); }
    expect(f.conversation.attempts).toBe(5);
    expect(await f.outboundOf("notice-1")).toMatchObject({ status: "failed", deliveryAttempts: 5 });

    expect(await f.runtime.failedConversationDeliveries()).toEqual([expect.objectContaining({
      message: expect.objectContaining({ message_id: "notice-1" }), error: expect.stringContaining("Gateway unavailable"), attempts: 5 })]);
    f.advance(10 * MINUTE);
    await f.runtime.flushOutbound();
    expect(f.conversation.attempts).toBe(5);
  });
});

describe("run watchdog facts", () => {
  it("counts an accepted handoff as activity only while its pane works, and names the holder when it stops", async () => {
    const f = await fixture();
    await f.runtime.queueHerdr(message("assign-dev", { type: "delegation.request", payload: { objective: "Inspect" }, recipient: { role: "developer" } }));
    await f.runtime.flushOutbound();
    expect((await f.outboundOf("assign-dev")).status).toBe("accepted");
    f.panes.busy.add("developer"); // the Developer is working on it: still accepted, not released
    await f.runtime.flushOutbound();
    expect((await f.outboundOf("assign-dev")).status).toBe("accepted");

    f.setNow(Date.parse(T0) + 4 * MINUTE);
    const [facts] = await f.runtime.watchdogSnapshot("session-1");
    expect(facts).toMatchObject({ activeHandoff: false, acceptedRoles: ["developer"] });
    const idle = [{ role: "coordinator", status: "idle" }, { role: "developer", status: "idle" }];
    const paneFacts = idle.map(pane => ({ ...pane, paneId: pane.role === "developer" ? "pane-developer" : "pane-coordinator" }));
    expect(evaluateWatchdog({ now: f.now(), runs: [facts!], notices: [], panes: paneFacts })).toEqual([
      expect.objectContaining({ kind: "stalled", runId: "run-1", holders: ["developer"] })]);
    expect(evaluateWatchdog({ now: f.now(), runs: [facts!], notices: [],
      panes: [{ role: "coordinator", paneId: "pane-coordinator", status: "working" }, { role: "developer", paneId: "pane-developer", status: "idle" }] })).toEqual([
        expect.objectContaining({ kind: "stalled", runId: "run-1" })]);

    // B5: the first stall reminds the holder once through Herdr; the run stays live and the user is not asked anything yet.
    await f.runtime.reportRunStalled("run-1", `run-1@${Date.parse(T0)}`);
    await f.runtime.reportRunStalled("run-1", `run-1@${Date.parse(T0)}`);
    expect(await f.notices("developer_no_response")).toHaveLength(0);
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord)).toMatchObject({ status: "implementing" });
    const reminders = (await f.runtime.inspect() as unknown as JournalState).outbound.filter(out => (out.message.payload as { kind?: string }).kind === "result_reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.message).toMatchObject({ recipient: { role: "developer", pane_id: "pane-developer" }, causation_id: "assign-dev" });
    f.panes.busy.delete("developer");
    await f.runtime.flushOutbound();
    // Still no result in the next episode: the Coordinator is resumed automatically (bounded), and the user sees why.
    await f.runtime.reportRunStalled("run-1", "run-1@after-reminder");
    const reports = await f.notices("developer_no_response");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message.payload).toMatchObject({ role: "developer", paneId: "pane-developer", options: expect.any(Array), automaticResume: { attempt: 1 } });
    expect(await f.runtime.inspect("run-1")).toMatchObject({ status: "escalated", pendingAction: { recovery: "auto_resume", sourceMessageId: "assign-dev" } });
  });

  it("does not count a queued handoff as activity once its recipient has been not-ready past the window", async () => {
    const f = await fixture();
    f.panes.busy.add("coordinator");
    await f.runtime.queueHerdr(message("msg-queued"));
    await f.runtime.flushOutbound();
    expect((await f.runtime.watchdogSnapshot("session-1"))[0]!.activeHandoff).toBe(true);

    f.advance(5 * MINUTE);
    await f.runtime.flushOutbound();
    const [facts] = await f.runtime.watchdogSnapshot("session-1");
    expect(facts!.activeHandoff).toBe(false);
    expect(evaluateWatchdog({ now: f.now(), runs: [facts!], notices: [], panes: [{ role: "coordinator", status: "idle" }] }))
      .toEqual([expect.objectContaining({ kind: "stalled" })]);
  });

  it("does not report not-ready delivery_failure or run_stalled on a follow-up run while Coordinator works on the parent changes_requested turn", async () => {
    const approval = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: "design-1", runId: "run-1", sessionId: "session-1",
      status: "pending", target: { type: "run" }, revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: T0,
      reason: "Design review", evidence: [], idempotencyKey: "design:run-1" });
    const f = await fixture({ runs: [run("run-1", "awaiting_approval", { approval, approvalKind: "design", baseRevision: "a".repeat(40) })] });
    const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: "design-1", runId: "run-1", sessionId: "session-1",
      target: { type: "run" }, revision: 1, generation: 0, decision: "changes_requested", decidedBy: "user", decidedAt: T0,
      reason: "Keep full SDD level", feedbackArtifacts: [], idempotencyKey: "decision:design-1" });
    const decisionMsg = message("approval-decision-1", { sender: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" },
      recipient: { role: "coordinator" }, type: "approval.decision", payload: decision });
    await f.runtime.queueHerdr(decisionMsg);
    await f.runtime.flushOutbound();
    expect((await f.outboundOf("approval-decision-1")).status).toBe("accepted");

    // Coordinator starts working on approval-decision-1 and acknowledges it, creating follow-up run-1-r2 and queueing its wake.
    f.panes.busy.add("coordinator");
    await f.runtime.receiveHerdr(decisionMsg);
    const wakeId = `p19-wake-${digest(["run-1-r2", "changes_requested", "design-1"])}`;
    expect((await f.outboundOf(wakeId)).status).toBe("queued");

    f.advance(6 * MINUTE);
    await f.runtime.flushOutbound();
    const wake = await f.outboundOf(wakeId);
    expect(wake.notReadySince).toBeUndefined();
    expect(wake.error).toBeUndefined();
    expect(await f.notices("delivery_failure", "run-1-r2")).toHaveLength(0);

    const r2Facts = (await f.runtime.watchdogSnapshot("session-1")).find(item => item.runId === "run-1-r2")!;
    expect(r2Facts).toMatchObject({ activeHandoff: true, acceptedRoles: ["coordinator"],
      acceptedPanes: [{ role: "coordinator", paneId: "pane-coordinator" }] });
    expect(evaluateWatchdog({ now: f.now(), runs: [r2Facts], notices: [],
      panes: [{ role: "coordinator", paneId: "pane-coordinator", status: "working" }] })).toEqual([]);
  });
});

describe("Runtime-owned work and terminal specialist statuses", () => {
  it("never reports a run stalled while Runtime itself owns verification, however long its checks run", async () => {
    const f = await fixture({ runs: [run("run-1", "verifying", { workflowVerificationPending: true })] });
    f.advance(30 * MINUTE);
    const facts = await f.runtime.watchdogSnapshot("session-1");
    expect(facts.map(item => item.runtimeWork)).toEqual([true]);
    expect(evaluateWatchdog({ now: f.now(), runs: facts, notices: [], panes: [{ role: "coordinator", paneId: "pane-coordinator", status: "idle" }] })).toEqual([]);
    for (const runId of ["run-1"]) {
      await f.runtime.reportRunStalled(runId, `${runId}@${Date.parse(T0)}`); // the host acts on an older snapshot: recheck in the transaction
      expect(await f.runtime.inspect(runId)).toMatchObject({ status: "verifying" });
      expect((await f.runtime.inspect(runId) as unknown as RunRecord).pendingAction).toBeUndefined();
      expect(await f.notices("run_stalled", runId)).toEqual([]);
    }
  });

  it("discharges a handoff answered by a correlated terminal task.status (inconclusive/completed) for watchdog and specialist Stop", async () => {
    for (const status of ["inconclusive", "completed"]) {
      const f = await fixture();
      await f.runtime.queueHerdr(message(`ask-${status}`, { type: "delegation.request", payload: { objective: "Investigate" }, recipient: { role: "architect" } }));
      await f.runtime.flushOutbound();
      const out = await f.outboundOf(`ask-${status}`);
      expect(out.status).toBe("accepted");
      await f.runtime.receiveHerdr(message(`answer-${status}`, { causation_id: out.message.message_id, type: "task.status",
        sender: { role: "architect", agent_id: "architect-agent", pane_id: "pane-architect" }, payload: { status, summary: "Evidence is insufficient" } }));
      const state = await f.runtime.inspect() as unknown as JournalState;
      const owes = (f.runtime as unknown as { outboundOwesResult(state: JournalState, run: RunRecord, out: Outbound): boolean }).outboundOwesResult;
      expect(owes.call(f.runtime, state, state.runs[0]!, state.outbound.find(item => item.message.message_id === `ask-${status}`)!)).toBe(false);
      expect((await f.runtime.watchdogSnapshot("session-1"))[0]!.acceptedRoles).toEqual([]);
      await f.runtime.specialistTurnStopped(f.panes.bindings.find(pane => pane.role === "architect")!, "architect");
      expect((await f.runtime.inspect() as unknown as JournalState).outbound.filter(item =>
        (item.message.payload as { kind?: string }).kind === "specialist_no_response")).toEqual([]);
      expect((await f.runtime.inspect("run-1") as unknown as RunRecord).status).toBe("implementing");
    }
  });
});

describe("specialist blockers and run-step isolation", () => {
  it("persists a Coordinator blocker before Conversation delivery and exposes an idempotent resume action", async () => {
    const f = await fixture();
    const outcome = RoleMessageSchema.parse({ schema_version: 2, message_id: "coordinator-blocked-1", correlation_id: "correlation",
      run_id: "run-1", sender: { role: "coordinator", agent_id: "coordinator-agent", pane_id: "pane-coordinator" },
      recipient: { role: "conversation" }, type: "task.status", payload: { status: "blocked", reason: "Repository read capability unavailable" },
      artifact_references: [], occurred_at: T0, idempotency_key: "coordinator-blocked-1" });
    const delivered: RoleMessage[] = [];
    await routeNativeConversationMessage(f.runtime, { receiveHerdr: async input => { delivered.push(RoleMessageSchema.parse(input)); return { accepted: true }; } }, outcome);
    await routeNativeConversationMessage(f.runtime, { receiveHerdr: async input => { delivered.push(RoleMessageSchema.parse(input)); return { accepted: true }; } }, outcome);
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toEqual(outcome); // Same authenticated envelope is forwarded without mutation.
    const persisted = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(persisted).toMatchObject({ status: "escalated", error: "Coordinator blocked: Repository read capability unavailable",
      pendingAction: { kind: "resume_coordinator", owner: "coordinator", sourceMessageId: "coordinator-blocked-1", reason: "Coordinator blocked: Repository read capability unavailable" } });
    expect(await f.notices("workflow_blocked")).toHaveLength(1);
    const action = persisted.pendingAction!;
    await f.runtime.resumeBlockedRun("run-1", action.actionId);
    await f.runtime.resumeBlockedRun("run-1", action.actionId);
    const resumed = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(resumed).toMatchObject({ status: "implementing", pendingAction: { kind: "resume_coordinator", state: "queued" } });
    expect((await f.runtime.inspect() as any).outbound.filter((item: any) => item.message.payload?.kind === "resume_run")).toHaveLength(1);
  });

  it("recognizes blocked payloads on spec.draft and wakes Coordinator with a user-visible blocker", async () => {
    const f = await fixture();
    const draft = RoleMessageSchema.parse({ schema_version: 2, message_id: "architect-blocked-draft", correlation_id: "correlation",
      run_id: "run-1", sender: { role: "architect", agent_id: "architect-agent", pane_id: "pane-architect" },
      recipient: { role: "coordinator" }, type: "spec.draft", payload: { status: "blocked", summary: "Cannot read repository", blockers: ["No bounded read capability"] },
      artifact_references: [], occurred_at: T0, idempotency_key: "architect-blocked-draft" });
    await f.runtime.receiveHerdr(draft);
    const persisted = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(persisted).toMatchObject({ pendingAction: { kind: "coordinator_continuation", owner: "coordinator", reason: expect.stringContaining("Cannot read repository") } });
    expect(await f.notices("workflow_blocked")).toHaveLength(1);
    expect((await f.runtime.inspect() as any).outbound.some((item: any) => item.message.payload?.kind === "specialist_result_ready")).toBe(true);
  });

  it.each(["received", "applied"] as const)("reconstructs a missing Coordinator wake from a durable %s result after restart", async inboxStatus => {
    const f = await fixture({ runs: [run("run-1", "specifying")] });
    const request = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", "Assess the repository", ["architecture"]));
    await f.runtime.flushOutbound();
    const outbound = await f.outboundOf(request.message_id);
    const result = RoleMessageSchema.parse({ schema_version: 2, message_id: "orphaned-result", correlation_id: request.correlation_id,
      causation_id: request.message_id, run_id: "run-1", sender: { role: "architect", agent_id: outbound.handle!.target.agentId, pane_id: outbound.handle!.target.paneId },
      recipient: { role: "coordinator" }, type: "spec.draft", payload: { status: "blocked", summary: "Repository read access unavailable" },
      artifact_references: [], occurred_at: T0, idempotency_key: "orphaned-result" });
    await f.journal.exclusive(async (state: JournalState, save) => { state.inbox.push({ message: result, status: inboxStatus }); await save(); });

    const restarted = new AgenticWorkflowRuntime(f.runtime.ports, { journalDirectory: f.journal.directory, repositoryPath: f.journal.repository });
    await restarted.initialize();
    await restarted.recoverMissingCoordinatorWakeups();
    await restarted.recoverMissingCoordinatorWakeups();
    const recovered = await restarted.inspect() as any;
    expect(recovered.outbound.filter((item: any) => item.message.payload?.kind === "specialist_result_ready" &&
      item.message.payload?.sourceMessageId === result.message_id)).toHaveLength(1);
    expect(recovered.runs[0]).toMatchObject({ error: expect.stringContaining("Repository read access unavailable"),
      pendingAction: { kind: "coordinator_continuation", sourceMessageId: result.message_id } });
  });

  it("preflights required role capability before transport, durably blocks, then resumes the same intent once", async () => {
    const f = await fixture({ capabilityAllowed: false });
    await f.runtime.queueHerdr(message("preflight-1", { recipient: { role: "coordinator" } }));
    await f.runtime.flushOutbound();
    // A first failure may be transient: the unsent intent stays queued with backoff, without a blocker yet.
    expect(await f.outboundOf("preflight-1")).toMatchObject({ status: "queued", deliveryAttempts: 1, nextAttemptAt: expect.any(String) });
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord).status).toBe("implementing");
    for (let attempt = 0; attempt < 4; attempt++) { f.advance(MINUTE); await f.runtime.flushOutbound(); }
    expect(f.transport.sentRequests).toHaveLength(0);
    const blocked = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(blocked).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", state: "pending" } });
    const failedIntent = (await f.runtime.inspect() as any).outbound.find((item: any) => item.message.message_id === "preflight-1");
    expect(failedIntent.status).toBe("failed");
    f.setCapabilityAllowed(true);
    const actionId = blocked.pendingAction!.actionId;
    await f.runtime.resumeBlockedRun("run-1", actionId);
    await f.runtime.resumeBlockedRun("run-1", actionId);
    await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.filter(request => request.instruction.includes("preflight-1"))).toHaveLength(1);
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord).resumeReceipts).toHaveLength(1);
  });

  it("persists a schema-invalid native result rejection against its authenticated assignment without inventing a result", async () => {
    const f = await fixture();
    await f.runtime.queueHerdr(message("coordinator-assignment", { recipient: { role: "coordinator" } }));
    await f.runtime.flushOutbound();
    const before = f.transport.sentRequests.length;
    const report = () => f.runtime.reportRoleToolFailure(f.panes.bindings.find(pane => pane.role === "coordinator")!,
      { message: { message_id: "invalid-escalation", run_id: "run-1", type: "escalation.notice" } },
      "RoleMessageSchema rejected unknown type escalation.notice");
    // B2: the first two invalid sends are returned to the agent (synchronous tool error); the run keeps going.
    expect(await report()).toEqual({ attempt: 1, limit: 3, escalated: false });
    expect(await report()).toEqual({ attempt: 2, limit: 3, escalated: false });
    expect(await f.runtime.inspect("run-1")).toMatchObject({ status: "implementing" });
    expect(await f.notices("workflow_blocked")).toHaveLength(0);
    expect(await report()).toEqual({ attempt: 3, limit: 3, escalated: true });
    const persisted = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(persisted).toMatchObject({ status: "escalated", error: expect.stringContaining("Rejected invalid coordinator RoleMessage"),
      pendingAction: { kind: "resume_coordinator", recovery: "auto_resume", sourceMessageId: "invalid-escalation" } });
    expect(await f.notices("workflow_blocked")).toHaveLength(1);
    expect(f.transport.sentRequests).toHaveLength(before); // Invalid payload is never forwarded or treated as a result.
    const restarted = new AgenticWorkflowRuntime(f.runtime.ports, { journalDirectory: f.journal.directory, repositoryPath: f.journal.repository });
    expect(await restarted.inspect("run-1")).toMatchObject({ status: "escalated", pendingAction: { sourceMessageId: "invalid-escalation" } });
  });

  it("recovers a persisted blocker after Runtime restart without duplicate resume delivery", async () => {
    const f = await fixture();
    const outcome = RoleMessageSchema.parse({ schema_version: 2, message_id: "restart-blocked", correlation_id: "correlation", run_id: "run-1",
      sender: { role: "coordinator", agent_id: "coordinator-agent", pane_id: "pane-coordinator" }, recipient: { role: "conversation" },
      type: "task.status", payload: { status: "blocked", reason: "Capability repaired" }, artifact_references: [], occurred_at: T0, idempotency_key: "restart-blocked" });
    await f.runtime.observeCoordinatorOutcome(outcome);
    const before = await f.runtime.inspect("run-1") as unknown as RunRecord;
    const restarted = new AgenticWorkflowRuntime(f.runtime.ports, { journalDirectory: f.journal.directory, repositoryPath: f.journal.repository });
    await restarted.initialize();
    await restarted.resumeBlockedRun("run-1", before.pendingAction!.actionId);
    await restarted.resumeBlockedRun("run-1", before.pendingAction!.actionId);
    expect((await restarted.inspect() as any).outbound.filter((item: any) => item.message.payload?.kind === "resume_run")).toHaveLength(1);
  });

  it("makes a specialist's blocked task.status visible to the user, not only to the Coordinator", async () => {
    const f = await fixture();
    await f.runtime.receiveHerdr(RoleMessageSchema.parse({ schema_version: 2, message_id: "blocked-1", correlation_id: "correlation",
      run_id: "run-1", sender: { role: "developer", agent_id: "developer-agent", pane_id: "pane-developer" }, recipient: { role: "coordinator" },
      type: "task.status", payload: { status: "blocked", reason: "Missing API token" }, artifact_references: [], occurred_at: T0,
      idempotency_key: "blocked-1" }));
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord).error).toBe("Specialist developer blocked: Missing API token");
    const blocked = await f.notices("workflow_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.message.payload).toMatchObject({ reason: "Specialist developer blocked: Missing API token", options: expect.any(Array) });
  });

  it("records one run's failing step on that run once, while other messages still flush", async () => {
    // A run without a definition cannot be created in Core: its scheduling step throws.
    const f = await fixture({ runs: [run("run-1", "implementing")] });
    await f.runtime.queueHerdr(message("msg-other"));
    await expect(f.runtime.tick()).resolves.toBeDefined();
    await f.runtime.tick();
    expect((await f.runtime.inspect("run-1") as unknown as RunRecord).error).toMatch(/^Run step failed: .*Missing workflow definition/);
    expect(await f.notices("workflow_blocked")).toHaveLength(1);
    expect(f.transport.sentRequests.map(request => request.idempotency.key)).toEqual(["msg-other"]);
  });
});

describe("escalated verification retry and design approval", () => {
  it("resumes only the unfinished verification of an escalated run through the explicit retry", async () => {
    const escalated = run("run-1", "escalated", { error: "Verification delivery/storage requires reconciliation: Storage unavailable",
      workflowVerificationPending: true });
    const f = await fixture({ runs: [escalated] });
    await expect(f.runtime.retryVerification("run-1")).resolves.toMatchObject({ retried: true, runId: "run-1" });
    const after = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(after).toMatchObject({ status: "verifying", workflowVerificationPending: false });
    expect(after.error).toBeUndefined();
    await expect(f.runtime.retryVerification("run-1")).rejects.toThrow("No verification awaiting retry");
  });

  it("rolls back a failed autonomous design approval, blocks it for the user, and leaves the approval pending for a retry", async () => {
    const approval = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: "design-1", runId: "run-1", sessionId: "session-1",
      status: "pending", target: { type: "run" }, revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: T0,
      reason: "Specification acceptance", evidence: [], idempotencyKey: "design:run-1" });
    const pending = run("run-1", "awaiting_approval", { approval, approvalKind: "design" });
    const f = await fixture({ runs: [pending] });
    // With no workflow specification the autonomous acceptance fails before any dossier is approved.
    const internals = f.runtime as unknown as { transaction: Function; settleDesignApproval: Function };
    await expect(internals.transaction(async (state: JournalState, save: () => Promise<void>, core: unknown, outbox: unknown) =>
      internals.settleDesignApproval(state, save, core, outbox, state.runs[0], false))).rejects.toThrow();
    const after = await f.runtime.inspect("run-1") as unknown as RunRecord;
    expect(after).toMatchObject({ status: "awaiting_approval", approvalKind: "design" });
    expect(after.decision).toBeUndefined();
    expect(after.error).toMatch(/^Autonomous design approval failed: /);
    const blocked = await f.notices("workflow_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.message.payload).toMatchObject({ approvalId: "design-1", options: expect.any(Array) });
    expect(digest(after.approval)).toBe(digest(approval));
  });

  it("releases a writer-released task assignment cleanly even when its lease expired with a pending renewal", async () => {
    const f = await fixture();
    await f.registry.upsert({ agentId: "developer-agent", role: "developer", transport: "herdr", enabled: true,
      priority: 1, maxConcurrentTasks: 1, capabilities: ["implementation"], settings: {} });
    const leaseRes = await f.registry.acquireLease({ leaseId: "lease-dev-1", agentId: "developer-agent",
      runId: "run-1", taskId: "task-1", attemptId: "attempt-1", ttlMs: 1_000, requestedAt: T0, idempotencyKey: "acq-dev-1" });
    if (!leaseRes.ok) throw new Error(leaseRes.error.message);
    await f.journal.exclusive(async (state: JournalState, save: () => Promise<void>) => {
      state.runs[0]!.tasks.push({
        taskId: "task-1", spec: { specification, strategy: specification.testStrategy!, request: ApprovalRequestSchema.parse({
          schemaVersion: 2, approvalId: "approval-task-1", runId: "run-1", target: { type: "run" }, revision: 1, generation: 0,
          requestedBy: "coordinator", requestedAt: T0, reason: "Accept design", evidence: [], idempotencyKey: "approve-task-1" }) },
        worktrees: [], outboundIds: ["assign-dev-1"], writerReleased: true
      } as never);
      const assignMsg = message("assign-dev-1", {
        sender: { role: "coordinator" }, recipient: { role: "developer", agent_id: "developer-agent", pane_id: "pane-developer" },
        type: "task.assignment"
      });
      state.outbound.push({
        message: assignMsg, status: "accepted", selector: "binding-developer-removed", taskId: "task-1", attemptId: "attempt-1",
        capabilities: ["implementation"], lease: leaseRes.value,
        leaseRenewal: { leaseId: "lease-dev-1", fencingToken: leaseRes.value.fencingToken, expectedVersion: leaseRes.value.version,
          ttlMs: 300_000, requestedAt: T0, idempotencyKey: "renew-expired-dev-1" },
        request: { requestId: "req-dev-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-1", role: "developer",
          target: { transport: "herdr", agentId: "developer-agent", paneId: "pane-developer", workspaceId: "workspace-1", tabId: "tab-1" },
          instruction: JSON.stringify(assignMsg), workingDirectory: "/tmp", inputs: [], context: assignMsg, attempt: 1,
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 60_000, onTimeout: "block" },
          idempotency: { key: "assign-dev-1", scope: "agent-request", fingerprint: digest(assignMsg) }, createdAt: T0 },
        handle: { executionId: "exec-dev-1", requestId: "req-dev-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-1",
          idempotencyKey: "assign-dev-1", target: { transport: "herdr", agentId: "developer-agent", paneId: "pane-developer", workspaceId: "workspace-1", tabId: "tab-1" },
          correlation: { token: "corr-dev-1", provenance: "transport", verified: true }, acceptedAt: T0 }
      });
      await save();
    });
    f.advance(5 * MINUTE);
    // Core binding is covered elsewhere; this exercises only the outbox lease reconciliation.
    await f.journal.exclusive(async (state: JournalState, save: () => Promise<void>) =>
      new HerdrOutbox(f.ports, state, save).flush(async () => {}));
    const state = await f.runtime.inspect() as unknown as JournalState;
    const assigned = state.outbound.find(item => item.message.message_id === "assign-dev-1")!;
    expect(assigned.error).toBeUndefined();
    expect(assigned.status).toBe("released");
    expect(assigned.leaseRenewal).toBeUndefined();
    expect(assigned.leaseRelease).toBeUndefined();
    expect(assigned.error).toBeUndefined();
  });

  it("skips redundant Core checkpoint writes when the snapshot version has not changed", async () => {
    let currentVersion = 1;
    let createCalls = 0;
    let saveCalls = 0;
    const definition = {
      id: "wf-1",
      version: 1,
      name: "Workflow",
      failurePolicy: "fail-fast" as const,
      maxConcurrency: 1,
      tasks: [{ id: "task-1", name: "Task 1", role: "developer" as const, dependsOn: [], maxAttempts: 2 }]
    };
    const makeSnapshot = () => ({
      runId: "run-1",
      workflowId: "wf-1",
      workflowVersion: "1",
      status: "running" as const,
      tasks: [{ taskId: "task-1", status: "running" as const, attempt: 1, generation: 0, version: currentVersion }],
      createdAt: T0,
      updatedAt: T0,
      version: currentVersion,
      lastEventSequence: currentVersion
    });
    const ports = {
      engine: {
        getSnapshot: async () => ({ ok: true, value: makeSnapshot() }),
        createCheckpoint: async ({ checkpointId, expectedVersion }: { checkpointId: string; expectedVersion: number }) => {
          createCalls++;
          return { ok: true, value: { checkpointId, runId: "run-1", version: expectedVersion, eventSequence: expectedVersion } };
        }
      },
      runStore: {
        saveCheckpoint: async () => {
          saveCalls++;
          return { ok: true, value: undefined };
        }
      }
    } as unknown as AgenticRuntimePorts;
    const state = {
      version: 1 as const,
      repository: "/tmp/repo",
      runs: [run("run-1", "implementing", { definition, coreCreated: true })],
      outbound: [],
      inbox: [],
      pendingCore: [],
      pendingVerifications: []
    };
    const core = new CoreSession(ports, state, async () => {});
    await core.checkpoint("run-1");
    await core.checkpoint("run-1");
    expect(createCalls).toBe(1);
    expect(saveCalls).toBe(1);
    currentVersion = 2;
    await core.checkpoint("run-1");
    expect(createCalls).toBe(2);
    expect(saveCalls).toBe(2);
  });
});
