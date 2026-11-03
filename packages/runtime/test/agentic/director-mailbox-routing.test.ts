import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { ApprovalDecisionSchema, DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema, SessionManifestV3Schema,
  type OperationResult, type PaneBinding, type RoleMessage } from "@bflow/contracts";
import { AgenticJournal, digest, parseAgenticJournalState, type JournalState, type Outbound, type RunRecord } from "../../src/agentic/journal.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import type { AgenticRuntimePorts, PanePolicy } from "../../src/agentic/ports.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { cleanups, fixture, FakeDirectorPort } from "../helpers/agentic-integration-fixture.js";
import { draft } from "../../../specification/test/fixtures.js";

// B2a Task 3 (R-B2-5, R-B2-12): in a Director session every Coordinator-bound outbound is an in-process Director mailbox write.

const T0 = "2026-11-03T10:00:00.000Z";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Director layout: specialist panes only, manifest v3 with the progress pane as attach target. */
class DirectorPanes implements PanePolicy {
  bindings: PaneBinding[] = ["planner", "architect"].map(role => PaneBindingSchema.parse({
    schemaVersion: 2, bindingId: `binding-${role}`, sessionId: "session-1", role, paneGroup: "coordination", agentId: `${role}-agent`,
    workspaceId: "workspace-1", tabId: "tab-1", paneId: `pane-${role}`, provider: "test", agentKind: "test", cwd: "/tmp",
    isolationMode: "dedicated_pane", readOnlyWorkspace: true, session: { source: "test", kind: "id", value: `session-${role}` },
    transportState: "idle", boundAt: T0 }));
  bindingReads: string[] = [];
  async getManifest() {
    return { ok: true as const, value: SessionManifestV3Schema.parse({ schemaVersion: 3, sessionId: "session-1", projectName: "Test", workspaceRoot: "/tmp",
      herdrWorkspaceId: "workspace-1", herdrTabId: "tab-1", status: "up", conversationSessionId: "session-1", activeRunIds: [], panes: this.bindings,
      progressPane: { tabId: "tab-progress", paneId: "pane-progress", command: ["bflow", "progress", "--follow"], phase: "running", restarts: [] },
      attachTarget: { role: "progress", tabId: "tab-progress", paneId: "pane-progress" }, createdAt: T0, updatedAt: T0 }) };
  }
  private find(selector: string) { return this.bindings.find(pane => [pane.role, pane.bindingId, pane.paneId, pane.agentId].includes(selector)); }
  async getRoleBinding(selector: string): Promise<OperationResult<PaneBinding | null>> { this.bindingReads.push(selector); return { ok: true, value: this.find(selector) ?? null }; }
  async inspectRoleHealth(selector: string) {
    const pane = this.find(selector);
    if (!pane) return { ok: false, error: { code: "not_found", message: "No pane", retryable: false } } as never;
    return { ok: true as const, value: { readyForPrompt: true, occupantMatches: true, paneId: pane.paneId, agentId: pane.agentId } };
  }
  async allocateDeveloper(): Promise<never> { throw new Error("not used by these tests"); }
  async releaseDeveloper() { return { ok: true as const, value: undefined }; }
}

const specification = draft("api");
function delegation(runId: string, requestedBy: "director" | "conversation") {
  return DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: `delegation-${runId}`, messageId: `intake-${runId}`,
    correlationId: "correlation", sessionId: "session-1", runId, requestedBy, targetRole: "coordinator",
    title: "Director mailbox test", objective: "Route Coordinator-bound work to the Director mailbox", specificationId: specification.specId,
    sddLevel: specification.level, acceptanceCriteria: specification.acceptanceCriteria, inputArtifacts: [], priority: "normal",
    requestedAt: T0, idempotencyKey: requestedBy === "director" ? `director:intake-${runId}` : `intake-${runId}` });
}
function run(runId: string, status: RunRecord["status"], requestedBy: "director" | "conversation" = "director", overrides: Partial<RunRecord> = {}): RunRecord {
  return { runId, delegation: delegation(runId, requestedBy), status, tasks: [], coreCreated: false, cancelled: false, maxIterations: 3, ...overrides };
}
function toCoordinator(id: string, sender: "runtime" | "conversation", type: RoleMessage["type"], payload: unknown, runId = "run-1"): RoleMessage {
  return RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: "correlation", run_id: runId, sender: { role: sender },
    recipient: { role: "coordinator" }, type, payload, artifact_references: [], occurred_at: T0, idempotency_key: id });
}
const autoResume = (runId: string) => ({ actionId: `next-${digest([runId, "blocked-source"])}`, kind: "resume_coordinator" as const, owner: "coordinator" as const,
  reason: "Transient blocker", sourceMessageId: "blocked-source", createdAt: T0, state: "pending" as const, previousStatus: "planning" as const,
  recovery: "auto_resume" as const });

/** Seeded-journal Runtime with a controllable clock; `director: false` reopens the same journal as a v2 host. */
async function light(runs: RunRecord[] = [run("run-1", "planning")]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-director-mailbox-")));
  roots.push(root);
  let now = Date.parse(T0);
  const panes = new DirectorPanes(), transport = new FakeAgentTransport(), director = new FakeDirectorPort();
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock: () => new Date(now) });
  const base = {
    clock: () => new Date(now), authenticateMessage: async () => true, authorizeHuman: async () => true,
    deliverToConversation: async () => undefined, transport, registry, panes,
    roleCapabilities: { planner: ["planning", "repository.read"], architect: ["architecture", "repository.read"] },
    engine: {}, runStore: {}, artifactStore: {}, policies: {}, taskChecks: [], workflowChecks: []
  };
  const journalDirectory = join(root, "journal"), repository = join(root, "repo");
  const journal = new AgenticJournal(journalDirectory, repository);
  await journal.exclusive(async (state: JournalState, save) => { state.runs.push(...runs); await save(); });
  const open = (withDirector = true) => new AgenticWorkflowRuntime(
    (withDirector ? { ...base, director } : base) as unknown as AgenticRuntimePorts, { journalDirectory, repositoryPath: repository });
  const f = {
    root, runtime: open(), panes, transport, director, journal, journalDirectory,
    restart: (withDirector = true) => { f.runtime = open(withDirector); return f.runtime; },
    advance: (ms: number) => { now += ms; },
    state: async () => await f.runtime.inspect() as unknown as JournalState,
    outbound: async (id: string) => (await f.state()).outbound.find(out => out.message.message_id === id),
    record: async (runId = "run-1") => await f.runtime.inspect(runId) as unknown as RunRecord,
    /** Enqueue through Runtime's own outbox, exactly as an internal wake/notice site does. */
    enqueue: async (message: RoleMessage) => {
      const runtime = f.runtime as unknown as { transaction: (action: (state: JournalState, save: () => Promise<void>, core: unknown,
        outbox: { enqueue(message: RoleMessage, selector?: string): Outbound }) => Promise<void>) => Promise<void> };
      await runtime.transaction(async (_state, save, _core, outbox) => { outbox.enqueue(message, "coordinator"); await save(); });
    }
  };
  return f;
}

describe("Director mailbox routing", () => {
  it("routes a specialist result wake to the Director mailbox, never to Herdr, and delivers it once", async () => {
    const f = await fixture({ director: true });
    const request = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "planner", "Plan the change", ["planning"]));
    await f.runtime.flushOutbound();
    const dispatched = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === request.message_id);
    expect(dispatched.status).toBe("accepted");
    expect(dispatched.delivery).toBeUndefined(); // a specialist handoff still goes through Herdr
    await f.runtime.receiveHerdr(f.envelope("task.status", { status: "completed", summary: "Plan ready" }, { message_id: "planner-reply",
      idempotency_key: "planner-reply", causation_id: request.message_id, sender: { role: "planner", agent_id: "planner", pane_id: "pane-planner" } }));
    const wakeId = `p19-wake-${digest(["run-1", "planner-reply"])}`;
    const queued = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === wakeId);
    expect(queued).toMatchObject({ delivery: "director_mailbox", capabilities: [], status: "queued",
      message: { sender: { role: "runtime" }, recipient: { role: "coordinator" }, payload: { kind: "specialist_result_ready", fromRole: "planner" } } });
    const sentBefore = f.transport.sentRequests.length;
    await f.runtime.flushOutbound();
    const delivered = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === wakeId);
    expect(delivered).toMatchObject({ status: "delivered" });
    expect(delivered.request).toBeUndefined(); expect(delivered.handle).toBeUndefined(); expect(delivered.lease).toBeUndefined();
    expect(f.director!.delivered.map(message => message.message_id)).toEqual([wakeId]);
    expect(f.transport.sentRequests.length).toBe(sentBefore);
    expect(f.transport.sentRequests.some(sent => (sent.context as { message_id?: string } | undefined)?.message_id === wakeId)).toBe(false);
    const calls = f.director!.deliverCalls;
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    expect(f.director!.deliverCalls).toBe(calls);
    const persisted = JSON.parse(await readFile(join(f.runtimeOptions.journalDirectory, "state.json"), "utf8"));
    expect(persisted.version).toBe(8);
  }, 60000);

  it("retries a failing mailbox write with backoff and fails it after the bound, never as unknown_delivery", async () => {
    const f = await light();
    f.director.fail = new Error("mailbox disk full");
    await f.enqueue(toCoordinator("wake-1", "runtime", "task.status", { kind: "specialist_result_ready" }));
    const statuses: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      await f.runtime.flushOutbound();
      const out = (await f.outbound("wake-1"))!;
      statuses.push(out.status);
      expect(out.deliveryAttempts).toBe(attempt);
      if (attempt < 5) {
        expect(out.nextAttemptAt).toBe(new Date(Date.parse(T0) + 0 + Math.min(60_000, 1_000 * 2 ** (attempt - 1)) + (attempt - 1) * 61_000).toISOString());
        // Inside the backoff window nothing is attempted.
        const calls = f.director.deliverCalls; await f.runtime.flushOutbound(); expect(f.director.deliverCalls).toBe(calls);
      }
      f.advance(61_000);
    }
    expect(statuses).toEqual(["queued", "queued", "queued", "queued", "failed"]);
    const failed = (await f.outbound("wake-1"))!;
    expect(failed.error).toContain("mailbox disk full");
    expect(f.director.deliverCalls).toBe(5);
    f.director.fail = undefined; await f.runtime.flushOutbound();
    expect((await f.outbound("wake-1"))!.status).toBe("failed");
    expect(f.transport.sentRequests).toEqual([]);
  });

  it("fails a mailbox item reopened by a host without a Director port instead of falling back to Herdr", async () => {
    const f = await light();
    await f.enqueue(toCoordinator("wake-v2", "runtime", "task.status", { kind: "specialist_result_ready" }));
    f.restart(false);
    await f.runtime.flushOutbound();
    expect(await f.outbound("wake-v2")).toMatchObject({ status: "failed", error: "Director mailbox unavailable in this session", delivery: "director_mailbox" });
    expect(f.director.deliverCalls).toBe(0);
    expect(f.transport.sentRequests).toEqual([]);
  });

  it("applies a human approval after its mailbox delivery and leaves awaiting_approval", async () => {
    const f = await fixture({ director: true, humanApproval: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const waiting = await f.inspect();
    expect(waiting.status).toBe("awaiting_approval");
    const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: waiting.approval.approvalId, runId: "run-1", sessionId: "session-1",
      target: waiting.approval.target, revision: waiting.approval.revision, generation: waiting.approval.generation, decision: "approved",
      decidedBy: "human-1", decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: randomUUID() });
    // The pane-less interaction gateway envelope (Task 6): no Conversation or Coordinator pane ids.
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: randomUUID(), correlation_id: "correlation-1", run_id: "run-1",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "approval.decision", payload: decision,
      artifact_references: [], occurred_at: decision.decidedAt, idempotency_key: decision.idempotencyKey });
    await f.runtime.queueHerdr(message);
    const sentBefore = f.transport.sentRequests.length;
    await f.runtime.flushOutbound();
    const state = await f.runtime.inspect() as any;
    expect(state.outbound.find((out: any) => out.message.message_id === message.message_id)).toMatchObject({ status: "delivered", delivery: "director_mailbox" });
    expect(state.inbox.find((item: any) => item.message.message_id === message.message_id)?.status).toBe("applied");
    const after = await f.inspect();
    expect(after.status).not.toBe("awaiting_approval");
    expect(after.decision).toMatchObject({ approvalId: decision.approvalId, decision: "approved" });
    expect(f.director!.delivered.map(item => item.message_id)).toContain(message.message_id);
    expect(f.transport.sentRequests.slice(sentBefore).some(sent => sent.role === "coordinator")).toBe(false);
  }, 60000);

  it("does not apply an unauthenticated human approval and surfaces an inbound failure", async () => {
    const f = await fixture({ director: true, humanApproval: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const waiting = await f.inspect();
    const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: waiting.approval.approvalId, runId: "run-1", sessionId: "session-1",
      target: waiting.approval.target, revision: waiting.approval.revision, generation: waiting.approval.generation, decision: "approved",
      decidedBy: "not-a-human", decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: randomUUID() });
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: randomUUID(), correlation_id: "correlation-1", run_id: "run-1",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "approval.decision", payload: decision,
      artifact_references: [], occurred_at: decision.decidedAt, idempotency_key: decision.idempotencyKey });
    await f.runtime.queueHerdr(message);
    await f.runtime.flushOutbound();
    const after = await f.inspect();
    expect(after.status).toBe("awaiting_approval");
    expect(after.decision).toBeUndefined();
    expect(after.ingressDiagnostics).toEqual([expect.objectContaining({ messageId: message.message_id, reason: expect.stringContaining("Human approval is not authenticated") })]);
    expect((await f.runtime.inspect() as any).inbox.some((item: any) => item.message.message_id === message.message_id)).toBe(false);
  }, 60000);

  it("recovers a delivered but unapplied mailbox approval after restart", async () => {
    const f = await fixture({ director: true, humanApproval: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const waiting = await f.inspect();
    const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: waiting.approval.approvalId, runId: "run-1", sessionId: "session-1",
      target: waiting.approval.target, revision: waiting.approval.revision, generation: waiting.approval.generation, decision: "approved",
      decidedBy: "human-1", decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: randomUUID() });
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: randomUUID(), correlation_id: "correlation-1", run_id: "run-1",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "approval.decision", payload: decision,
      artifact_references: [], occurred_at: decision.decidedAt, idempotency_key: decision.idempotencyKey });
    await f.runtime.queueHerdr(message);
    // The host stops between the durable `delivered` write and the application.
    vi.spyOn(f.runtime as unknown as { applyDeliveredMailboxMessage: () => Promise<void> }, "applyDeliveredMailboxMessage").mockResolvedValue(undefined);
    await f.runtime.flushOutbound();
    expect((await f.inspect()).status).toBe("awaiting_approval");
    await f.restart().recoverMissingCoordinatorWakeups();
    expect((await f.inspect()).decision).toMatchObject({ approvalId: decision.approvalId });
  }, 60000);

  it("consumes a pane-less cancellation control locally; the mailbox never receives it", async () => {
    const f = await fixture({ director: true });
    const at = new Date().toISOString();
    const failures = vi.spyOn(f.runtime, "reportInboundFailure");
    const cancel = RoleMessageSchema.parse({ schema_version: 2, message_id: "cancel-control-1", correlation_id: "cancel-correlation-1", run_id: "run-1",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request",
      payload: { schemaVersion: 2, delegationId: "cancel-delegation-1", messageId: "cancel-control-1", correlationId: "cancel-correlation-1", sessionId: "session-1",
        runId: "run-1", requestedBy: "conversation", targetRole: "coordinator", title: "Cancel existing run", objective: "User requested cancellation",
        specificationId: "cancel-spec", sddLevel: "lightweight", acceptanceCriteria: [{ id: "ac-cancel", description: "Cancel", category: "functional",
          verificationMethod: "manual_review", required: true, status: "pending", evidenceArtifactIds: [] }], inputArtifacts: [], priority: "critical",
        requestedAt: at, idempotencyKey: "cancel-control-1", metadata: { action: "cancel", targetRunId: "run-1", cancellationRequest: { schemaVersion: 1,
          cancellationId: "cancel-1", runId: "run-1", requestedBy: "conversation", requestedAt: at, expectedVersion: 1, reason: "User requested cancellation",
          idempotencyKey: "cancel-control-1" } } },
      artifact_references: [], occurred_at: at, idempotency_key: "cancel-control-1" });
    await f.runtime.queueHerdr(cancel);
    await f.runtime.flushOutbound();
    expect((await f.inspect()).cancelled).toBe(true);
    expect((await f.runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === "cancel-control-1"))
      .toMatchObject({ status: "delivered", delivery: "director_mailbox" });
    expect(f.director!.delivered.some(item => item.message_id === "cancel-control-1")).toBe(false);
    expect(failures).not.toHaveBeenCalled();
  }, 60000);

  /**
   * R-B2-5 cost clause: every Coordinator-bound type Runtime or the interaction gateway can enqueue, with its behaviour after
   * mailbox delivery. Runtime notices are informational; a human approval is applied; anything else from Conversation is
   * reported as an inbound failure. No row may be silently ignored.
   */
  it.each([
    // Runtime → Coordinator wakes (wakeCoordinator, resume, stall, failover, verification, plan drift, git integration requests).
    ...["specialist_result_ready", "conversation_context_ready", "resume_run", "user_resume_requested", "prototype_specification_revision_proposed",
      "changes_requested", "unmeasured_policy_phase", "verification_stuck", "workflow_blocked", "execution_plan_drift", "specialist_no_response",
      "developer_no_response", "delivery_failure", "user_decision_answer"].map(kind => ({ name: `runtime task.status ${kind}`, sender: "runtime" as const,
      type: "task.status" as const, payload: { kind }, expected: "informational" as const })),
    { name: "runtime verification.requested (P18 integration request)", sender: "runtime" as const, type: "verification.requested" as const,
      payload: { verificationScope: "workflow" }, expected: "informational" as const },
    // Interaction gateway (Conversation sender) → Coordinator.
    { name: "conversation approval.decision", sender: "conversation" as const, type: "approval.decision" as const, payload: "decision", expected: "applied" as const },
    { name: "conversation delegation.request handoff", sender: "conversation" as const, type: "delegation.request" as const, payload: "handoff", expected: "failure" as const },
    { name: "conversation task.status context", sender: "conversation" as const, type: "task.status" as const, payload: { note: "context" }, expected: "failure" as const },
    { name: "conversation conversation.clarification", sender: "conversation" as const, type: "conversation.clarification" as const, payload: { answer: "a" }, expected: "failure" as const }
  ])("classifies $name after mailbox delivery as $expected", async row => {
    const f = await light();
    const apply = vi.spyOn(f.runtime as unknown as { applyAuthenticatedHerdrMessage: () => Promise<unknown> }, "applyAuthenticatedHerdrMessage").mockResolvedValue({});
    const failures = vi.spyOn(f.runtime, "reportInboundFailure").mockResolvedValue(undefined);
    const payload = row.payload === "decision"
      ? { schemaVersion: 2, approvalId: "approval-1", runId: "run-1", sessionId: "session-1", target: { type: "run" }, revision: 1, generation: 1,
          decision: "approved", decidedBy: "human-1", decidedAt: T0, feedbackArtifacts: [], idempotencyKey: "decision-1" }
      : row.payload === "handoff" ? delegation("run-1", "conversation") : row.payload;
    const id = `row-${digest(row.name)}`;
    await f.enqueue(toCoordinator(id, row.sender, row.type, payload));
    await f.runtime.flushOutbound();
    expect(await f.outbound(id)).toMatchObject({ status: "delivered", delivery: "director_mailbox" });
    expect(f.director.delivered.map(item => item.message_id)).toEqual([id]);
    if (row.expected === "informational") { expect(apply).not.toHaveBeenCalled(); expect(failures).not.toHaveBeenCalled(); }
    if (row.expected === "applied") { expect(apply).toHaveBeenCalledTimes(1); expect(failures).not.toHaveBeenCalled(); }
    if (row.expected === "failure") {
      expect(apply).not.toHaveBeenCalled();
      expect(failures).toHaveBeenCalledWith(expect.objectContaining({ message_id: id }), "Unsupported Conversation→Coordinator message in Director session");
    }
    expect(f.transport.sentRequests).toEqual([]);
  });
});

describe("Director-mode liveness and resume", () => {
  it("does not treat a queued or delivered mailbox wake as a role holder or active handoff", async () => {
    const f = await light();
    f.director.fail = new Error("not yet");
    await f.enqueue(toCoordinator("wake-holder", "runtime", "task.status", { kind: "specialist_result_ready" }));
    await f.runtime.flushOutbound();
    expect((await f.outbound("wake-holder"))!.status).toBe("queued");
    let [facts] = await f.runtime.watchdogSnapshot("session-1");
    expect(facts).toMatchObject({ activeHandoff: false, acceptedRoles: [] });
    f.director.fail = undefined; f.advance(61_000); await f.runtime.flushOutbound();
    expect((await f.outbound("wake-holder"))!.status).toBe("delivered");
    [facts] = await f.runtime.watchdogSnapshot("session-1");
    expect(facts).toMatchObject({ activeHandoff: false, acceptedRoles: [], acceptedPanes: [] });
    await f.runtime.reportRunStalled("run-1", "episode-1");
    const stalled = await f.record();
    expect(stalled).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", recovery: "auto_resume", sourceMessageId: "intake-run-1" } });
    expect((await f.state()).outbound.some(out => (out.message.payload as { kind?: string }).kind === "result_reminder")).toBe(false);
    expect(f.panes.bindingReads).not.toContain("coordinator");
  });

  it("resumes a Director run only while the Director is present, through the mailbox", async () => {
    const f = await light([run("run-1", "escalated", "director", { pendingAction: autoResume("run-1") })]);
    f.advance(31_000);
    f.director.presence = false;
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(f.director.presentCalls).toBe(1);
    expect((await f.record()).status).toBe("escalated");
    f.director.presence = true;
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
    const wake = (await f.state()).outbound.find(out => (out.message.payload as { kind?: string }).kind === "resume_run")!;
    expect(wake).toMatchObject({ delivery: "director_mailbox", capabilities: [], message: { recipient: { role: "coordinator" } } });
    await f.runtime.flushOutbound();
    expect(f.director.delivered.map(item => item.message_id)).toEqual([wake.message.message_id]);
    expect((await f.record()).status).toBe("planning");
    expect(f.panes.bindingReads).not.toContain("coordinator");
  });

  it("never auto-resumes a legacy v2 run in a Director session", async () => {
    const f = await light([run("run-1", "escalated", "conversation", { pendingAction: autoResume("run-1") })]);
    f.advance(31_000);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(f.director.presentCalls).toBe(0);
    expect((await f.record()).status).toBe("escalated");
    expect((await f.state()).outbound).toEqual([]);
  });
});

describe("private journal v8", () => {
  const fixturePath = join(import.meta.dirname, "../fixtures/journal-v7-real.json");
  const repository = "/redacted/repo";
  it("still parses a real v7 journal and keeps it v7 when no Director field is written", async () => {
    const raw = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(raw.version).toBe(7);
    const parsed = parseAgenticJournalState(structuredClone(raw), repository);
    expect(parsed.runs[0]!.status).toBe("completed");
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-journal-v7-")));
    roots.push(root);
    await mkdir(join(root, "journal"), { recursive: true });
    await writeFile(join(root, "journal", "state.json"), JSON.stringify(raw));
    const journal = new AgenticJournal(join(root, "journal"), repository);
    await journal.exclusive(async (state, save) => { state.outbound[0]!.error = "touched"; await save(); });
    expect(JSON.parse(await readFile(join(root, "journal", "state.json"), "utf8")).version).toBe(7);
    await journal.exclusive(async (state, save) => {
      state.outbound.push({ message: toCoordinator("wake-v8", "runtime", "task.status", { kind: "specialist_result_ready" }, "run-1"),
        status: "queued", selector: "coordinator", taskId: "message-wake-v8", attemptId: "attempt-wake-v8", capabilities: [], delivery: "director_mailbox" });
      await save();
    });
    expect(JSON.parse(await readFile(join(root, "journal", "state.json"), "utf8")).version).toBe(8);
  });

  it("refuses Director fields in a journal below v8", async () => {
    const raw = JSON.parse(await readFile(fixturePath, "utf8"));
    const withDelivery = structuredClone(raw);
    withDelivery.outbound.push({ message: toCoordinator("wake-v7", "runtime", "task.status", { kind: "specialist_result_ready" }, "run-1"),
      status: "delivered", selector: "coordinator", taskId: "message-wake-v7", attemptId: "attempt-wake-v7", capabilities: [], delivery: "director_mailbox" });
    expect(() => parseAgenticJournalState(withDelivery, repository)).toThrow("Director journal fields require private journal v8");
    const withDirectorRun = structuredClone(raw);
    withDirectorRun.runs[0].delegation = { ...withDirectorRun.runs[0].delegation, requestedBy: "director" };
    expect(() => parseAgenticJournalState(withDirectorRun, repository)).toThrow("Director journal fields require private journal v8");
    expect(parseAgenticJournalState({ ...structuredClone(withDelivery), version: 8 }, repository).outbound.at(-1)!.delivery).toBe("director_mailbox");
    expect(parseAgenticJournalState({ ...structuredClone(withDirectorRun), version: 8 }, repository).runs[0]!.delegation.requestedBy).toBe("director");
  });

  it("refuses a Director mailbox tag on a non-Coordinator, parented or dispatched outbound", () => {
    const base = { version: 8, repository, runs: [run("run-1", "planning")], inbox: [], pendingCore: [], pendingVerifications: [] };
    const mailbox = (overrides: Partial<Outbound>, message = toCoordinator("wake-x", "runtime", "task.status", { kind: "specialist_result_ready" })) =>
      ({ ...base, outbound: [{ message, status: "queued", selector: "coordinator", taskId: "t", attemptId: "a", capabilities: [], delivery: "director_mailbox", ...overrides }] });
    expect(parseAgenticJournalState(mailbox({}), repository).outbound[0]!.delivery).toBe("director_mailbox");
    const toConversation = RoleMessageSchema.parse({ schema_version: 2, message_id: "n-1", correlation_id: "correlation", run_id: "run-1", sender: { role: "coordinator" },
      recipient: { role: "conversation" }, type: "conversation.progress", payload: {}, artifact_references: [], occurred_at: T0, idempotency_key: "n-1" });
    expect(() => parseAgenticJournalState(mailbox({}, toConversation), repository)).toThrow("Invalid Director mailbox outbound");
    expect(() => parseAgenticJournalState(mailbox({ capabilities: ["repository.read"] }), repository)).toThrow("Invalid Director mailbox outbound");
    expect(() => parseAgenticJournalState(mailbox({ status: "unknown_delivery" }), repository)).toThrow("Invalid Director mailbox outbound");
    expect(() => parseAgenticJournalState(mailbox({ parentAssignmentId: "parent" }), repository)).toThrow("Invalid Director mailbox outbound");
  });
});
