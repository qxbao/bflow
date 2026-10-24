import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { ApprovalRequestSchema, DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema,
  type OperationResult, type PaneBinding, type RoleMessage } from "@bflow/contracts";
import { AgenticJournal, digest, type JournalState, type Outbound, type RunRecord } from "../../src/agentic/journal.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { parseUserDecisionToolInput } from "../../src/agentic/decision-routing.js";
import { renderConversationNotice } from "../../src/agentic/conversation-notice-render.js";
import type { AgenticRuntimePorts, PanePolicy } from "../../src/agentic/ports.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { draft } from "../../../specification/test/fixtures.js";

// W1 (B0/B1/B6/B8): blockers that used to wait for a human "tiếp tục" resume automatically, bounded by a persisted budget with backoff.

const T0 = "2026-10-21T10:00:00.000Z";
const SECOND = 1_000;
const VERIFICATION_REASON = "Verification delivery/storage requires reconciliation: Storage unavailable";
const cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });

class Panes implements PanePolicy {
  busy = new Set<string>();
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
  async getRoleBinding(selector: string): Promise<OperationResult<PaneBinding | null>> { return { ok: true, value: this.find(selector) ?? null }; }
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
    title: "Auto-resume test", objective: "Exercise automatic recovery", specificationId: specification.specId, sddLevel: specification.level,
    acceptanceCriteria: specification.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: T0, idempotencyKey: `intake-${runId}` });
}
function run(runId: string, status: RunRecord["status"], overrides: Partial<RunRecord> = {}): RunRecord {
  return { runId, delegation: delegation(runId), status, tasks: [], coreCreated: false, cancelled: false, maxIterations: 3, ...overrides };
}
function coordinatorWake(id: string): RoleMessage {
  return RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: "correlation", run_id: "run-1",
    sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status", payload: { headline: id },
    artifact_references: [], occurred_at: T0, idempotency_key: id });
}
function coordinatorBlocked(id: string, reason: string): RoleMessage {
  return RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: "correlation", run_id: "run-1",
    sender: { role: "coordinator", agent_id: "coordinator-agent", pane_id: "pane-coordinator" }, recipient: { role: "conversation" },
    type: "task.status", payload: { status: "blocked", reason }, artifact_references: [], occurred_at: T0, idempotency_key: id });
}

async function fixture(runs: RunRecord[] = [run("run-1", "specifying")]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-auto-resume-")));
  cleanup.push(root);
  let now = Date.parse(T0);
  const panes = new Panes(), transport = new FakeAgentTransport();
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock: () => new Date(now) });
  const ports = {
    clock: () => new Date(now), authenticateMessage: async () => true, authorizeHuman: async () => true,
    deliverToConversation: async () => undefined,
    transport, registry, panes, roleCapabilities: { coordinator: ["repository.read"], architect: ["architecture", "repository.read"], developer: [], conversation: [] },
    preflightRoleCapabilities: async () => undefined,
    engine: {}, runStore: {}, artifactStore: {}, policies: {}, taskChecks: [], workflowChecks: []
  } as unknown as AgenticRuntimePorts;
  const journalDirectory = join(root, "journal"), repository = join(root, "repo");
  const journal = new AgenticJournal(journalDirectory, repository);
  await journal.exclusive(async (state: JournalState, save) => { state.runs.push(...runs); await save(); });
  const open = () => new AgenticWorkflowRuntime(ports, { journalDirectory, repositoryPath: repository });
  const f = {
    runtime: open(), panes, transport, journal,
    /** A Runtime process restart: a fresh instance over the same durable journal. */
    restart: () => { f.runtime = open(); return f.runtime; },
    advance: (ms: number) => { now += ms; },
    now: () => now,
    record: async (runId = "run-1") => await f.runtime.inspect(runId) as unknown as RunRecord,
    outbound: async () => (await f.runtime.inspect() as unknown as { outbound: Outbound[] }).outbound,
    resumeWakes: async () => (await f.outbound()).filter(out => (out.message.payload as { kind?: string }).kind === "resume_run"),
    exhaustedNotices: async () => (await f.outbound() as (Outbound & { message: { payload: { headline?: string } } })[]).filter(out => out.message.recipient.role === "conversation" &&
      /Automatic resume stopped after 3 attempts/.test(String((out.message.payload as { headline?: string }).headline))),
    coordinator: () => panes.bindings.find(pane => pane.role === "coordinator")!,
    /** Deliver a message to the Coordinator pane and report that its turn stopped without a workflow next action. */
    stopWithoutAction: async (message: RoleMessage) => {
      const find = async () => (await f.outbound()).find(out => out.message.message_id === message.message_id)!;
      // The previous Coordinator delivery releases its capacity on one pass; the next one is dispatched after it.
      for (let pass = 0; pass < 3 && (await find()).status === "queued"; pass++) await f.runtime.flushOutbound();
      const delivered = await find();
      expect(["accepted", "released"]).toContain(delivered.status);
      await f.runtime.coordinatorStopWithoutResponse(delivered.message, f.coordinator());
    },
    escalateVerification: async () => {
      // The private escalation site (B8) as tick()/recordVerificationFailure reach it after a verification delivery/storage failure.
      const runtime = f.runtime as unknown as { transaction: (action: (state: JournalState, save: () => Promise<void>, core: unknown, outbox: unknown) => Promise<void>) => Promise<void>;
        escalateForRetry: (state: JournalState, outbox: unknown, run: RunRecord, taskId: string, reason: string) => void };
      await runtime.transaction(async (state, save, _core, outbox) => {
        runtime.escalateForRetry(state, outbox, state.runs.find(item => item.runId === "run-1")!, "task-1", VERIFICATION_REASON); await save();
      });
    }
  };
  return f;
}

describe("bounded automatic resume", () => {
  it.each([
    "No SDD conflict remains between lightweight and full; blocked only by a transient timeout.",
    "The SDD conflict between lightweight and full was resolved; blocked only by a transient timeout."
  ])("does not turn a resolved SDD diagnostic into a new human requirement gate: %s", async reason => {
    const f = await fixture();
    await f.runtime.observeCoordinatorOutcome(coordinatorBlocked("blocked-resolved", reason));
    expect((await f.record()).pendingAction?.recovery).toBe("auto_resume");
    f.advance(31 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
  });

  it.each([true, false])("explains the SDD conflict on the first notice and waits for a revision across restart (structured action: %s)", async structured => {
    const f = await fixture();
    const message = coordinatorBlocked("blocked-sdd", "Accepted lightweight SDD conflicts with P15: this new feature requires full SDD.");
    message.payload = { status: "blocked", summary: "Accepted lightweight SDD conflicts with P15: this new feature requires full SDD.",
      blockers: ["Need authorized revision of SDD level; resume is not approval to override accepted requirements."],
      ...(structured ? { requested_action: "authorized_requirement_revision", next_role: "conversation" } : {}) };
    await f.runtime.observeCoordinatorOutcome(message);
    const blocked = await f.record();
    expect(blocked).toMatchObject({ status: "escalated", pendingAction: { recovery: "manual", state: "pending" } });
    const notification = (await f.outbound()).find(out => out.message.causation_id === message.message_id)!;
    expect(notification.message.payload).not.toHaveProperty("automaticResume");
    const rendered = renderConversationNotice({ messageId: notification.message.message_id, runId: "run-1",
      type: notification.message.type, summary: JSON.stringify(notification.message.payload) });
    expect(rendered.display).toContain("bản mô tả ngắn gọn");
    expect(rendered.display).toContain("bản đặc tả đầy đủ");
    expect(rendered.display).toContain("đổi yêu cầu việc #1 sang bản đặc tả đầy đủ");
    expect(rendered.display).toContain("giữ nguyên phạm vi");
    expect(rendered.display).toContain("không sửa yêu cầu");
    expect(rendered.display).not.toContain("Khắc phục capability");
    expect(rendered.reply).not.toContain('"tiếp tục việc #1" sau khi xử lý xong');
    f.restart(); f.advance(10 * 60 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await f.resumeWakes()).toEqual([]);
    expect((await f.record()).delegation).toEqual(blocked.delegation);
    expect((await f.record()).decision).toBeUndefined();
  });

  it("preserves the specific non-SDD revision blocker without inventing a full SDD requirement", async () => {
    const f = await fixture();
    const message = coordinatorBlocked("blocked-scope", "Two accepted scope constraints conflict; choose which requirement to retain.");
    message.payload = { status: "blocked", summary: "Two accepted scope constraints conflict; choose which requirement to retain.",
      blockers: ["Offline-only conflicts with mandatory live API calls"], requested_action: "authorized_requirement_revision", next_role: "conversation" };
    await f.runtime.observeCoordinatorOutcome(message);
    expect((await f.record()).pendingAction?.recovery).toBe("manual");
    const notification = (await f.outbound()).find(out => out.message.causation_id === message.message_id)!;
    const rendered = renderConversationNotice({ messageId: notification.message.message_id, runId: "run-1",
      type: notification.message.type, summary: JSON.stringify(notification.message.payload) });
    expect(rendered.display).toContain("Offline-only conflicts with mandatory live API calls");
    expect(rendered.display).toContain("yêu cầu");
    expect(rendered.display).not.toContain("full SDD");
    expect(rendered.display).not.toContain("Khắc phục capability");
    f.advance(10 * 60 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
  });

  it("delivers an explicit resume separately when an automatic wake is already queued, retaining both identities across restart", async () => {
    const actionId = `next-${digest(["run-1", "blocked-source"])}`;
    const f = await fixture([run("run-1", "escalated", { pendingAction: {
      actionId, kind: "resume_coordinator", owner: "coordinator", reason: "Waiting for repaired host",
      sourceMessageId: "blocked-source", createdAt: T0, state: "pending", previousStatus: "implementing", recovery: "auto_resume"
    } })]);
    f.advance(31 * SECOND);
    const automatic = await f.runtime.resumeBlockedRun("run-1", actionId, { automatic: true }) as { messageId: string };
    f.restart();
    const manual = await f.runtime.resumeBlockedRun("run-1", actionId) as { messageId: string };
    expect(manual.messageId).not.toBe(automatic.messageId);
    const wakes = await f.resumeWakes();
    expect(wakes).toHaveLength(2);
    expect(wakes.find(out => out.message.message_id === automatic.messageId)!.message.payload).toMatchObject({ automatic: true });
    expect(wakes.find(out => out.message.message_id === manual.messageId)!.message.payload).toMatchObject({ automatic: false });
    expect(await f.record()).toMatchObject({ status: "implementing", pendingAction: { manualResumeAttempts: 1, resumeAttempts: 0 } });
    f.restart();
    expect(await f.runtime.resumeBlockedRun("run-1", actionId)).toMatchObject({ messageId: manual.messageId });
    expect(await f.resumeWakes()).toHaveLength(2);
    expect((await f.record()).pendingAction?.manualResumeAttempts).toBe(1);
  });

  it("creates a fresh recovery wake when the resumed Coordinator STOPs without proposing again", async () => {
    const f = await fixture();
    const initial = coordinatorWake("rejection-initial");
    await f.runtime.queueHerdr(initial); await f.runtime.flushOutbound();
    await f.runtime.recordWorkflowRejected("run-1", { code: "unsupported_verification", reason: "Split the overbudget task", options: ["Split task"] });
    await f.stopWithoutAction(initial);
    const firstAction = (await f.record()).pendingAction!.actionId;
    const first = await f.runtime.resumeBlockedRun("run-1", firstAction) as { messageId: string };
    const wake = (await f.resumeWakes()).find(out => out.message.message_id === first.messageId)!.message;
    await f.stopWithoutAction(wake);
    const second = await f.record();
    expect(second.pendingAction!.actionId).not.toBe(firstAction);
    expect(second.pendingAction).toMatchObject({ recovery: "manual", manualResumeAttempts: 1 });
    await f.runtime.coordinatorStopWithoutResponse(wake, f.coordinator());
    expect((await f.record()).pendingAction).toEqual(second.pendingAction);
    f.restart();
    const resumed = await f.runtime.resumeBlockedRun("run-1", second.pendingAction!.actionId) as { messageId: string };
    expect(resumed.messageId).not.toBe(first.messageId);
    expect((await f.runtime.resumeBlockedRun("run-1", second.pendingAction!.actionId) as { messageId: string }).messageId).toBe(resumed.messageId);
    expect(await f.resumeWakes()).toHaveLength(2);
    expect((await f.record()).pendingAction?.manualResumeAttempts).toBe(2);
  });

  it("persists proposal rejection across real Coordinator STOP/restart, uses fresh notices per episode, and preserves resume limits", async () => {
    const f = await fixture();
    const rejection = { code: "unsupported_verification" as const, reason: "Task unit needs owned test files; correct its mapping before continuing", options: ["Correct owned test files"] };
    let message = coordinatorWake("proposal-wake");
    await f.runtime.queueHerdr(message);
    for (let episode = 0; episode < 4; episode++) {
      for (let pass = 0; pass < 3; pass++) await f.runtime.flushOutbound();
      expect(["accepted", "released"]).toContain((await f.outbound()).find(out => out.message.message_id === message.message_id)?.status);
      await f.runtime.recordWorkflowRejected("run-1", rejection);
      const proof = (await f.record()).lastWorkflowRejection!;
      await f.runtime.recordWorkflowRejected("run-1", rejection);
      expect((await f.record()).lastWorkflowRejection).toEqual(proof);
      const notices = (await f.outbound()).filter(out => (out.message.payload as any).kind === "workflow_rejected");
      expect(notices).toHaveLength(episode + 1);
      expect(notices.at(-1)!.message.payload).toMatchObject({ actionId: proof.actionId });
      await f.stopWithoutAction(message);
      f.restart(); f.advance(240 * SECOND);
      const blocked = await f.record();
      expect(blocked.pendingAction).toMatchObject({ recovery: "manual", previousStatus: "specifying" });
      expect(blocked.pendingAction?.manualResumeAttempts ?? 0).toBe(episode);
      expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
      if (episode === 3) {
        await expect(f.runtime.resumeBlockedRun("run-1", blocked.pendingAction!.actionId)).rejects.toThrow("Explicit resume budget is exhausted");
        break;
      }
      const first = await f.runtime.resumeBlockedRun("run-1", blocked.pendingAction!.actionId) as { messageId: string };
      const replay = await f.runtime.resumeBlockedRun("run-1", blocked.pendingAction!.actionId) as { messageId: string };
      expect(replay.messageId).toBe(first.messageId);
      expect((await f.resumeWakes()).filter(out => out.message.message_id === first.messageId)).toHaveLength(1);
      message = (await f.resumeWakes()).find(out => out.message.message_id === first.messageId)!.message;
    }
  });

  it.each([
    ["code", "unrecognized"], ["episodeNumber", -1], ["actionId", "next-for-another-run"],
    ["rejectedAt", "yesterday"], ["rejectionFingerprint", "bad"], ["previousStatus", "completed"], ["extra", true]
  ])("rejects malformed durable proposal proof field %s at journal ingress", async (field, value) => {
    const f = await fixture();
    await f.runtime.recordWorkflowRejected("run-1", { code: "missing_test_mapping", reason: "Missing owned test files", options: [] });
    await expect(f.journal.exclusive(async (state, save) => {
      (state.runs[0]!.lastWorkflowRejection as unknown as Record<string, unknown>)[field as string] = value;
      await save();
    })).rejects.toThrow();
    f.restart();
    expect((await f.record()).lastWorkflowRejection?.code).toBe("missing_test_mapping");
  });

  it.each(["native", "sending", "unknown_delivery", "approval", "decision", "cancelled", "unrelated_blocker"] as const)(
    "does not replace a %s fence with proposal recovery state", async fence => {
      const f = await fixture();
      if (["sending", "unknown_delivery"].includes(fence)) {
        await f.runtime.queueHerdr(coordinatorWake("uncertain-proposal"));
        await f.runtime.flushOutbound();
      }
      if (fence === "decision") await f.runtime.requestUserDecision(f.coordinator(), "coordinator", parseUserDecisionToolInput({
        runId: "run-1", taskId: "planning", question: "Choose backend", options: ["SQLite", "Postgres"], expiresInMinutes: 60
      }));
      await f.journal.exclusive(async (state, save) => {
        const current = state.runs[0]!;
        if (fence === "native") current.nativeDeliveries = [{ operationId: "native-uncertain", message: coordinatorWake("native-proposal") }];
        if (["sending", "unknown_delivery"].includes(fence)) state.outbound.find(out => out.message.message_id === "uncertain-proposal")!.status = fence as "sending" | "unknown_delivery";
        if (fence === "approval") {
          current.status = "awaiting_approval";
          current.approval = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: "pending-design", runId: "run-1", sessionId: "session-1",
            status: "pending", target: { type: "run" }, revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: T0,
            reason: "Human design approval", evidence: [], idempotencyKey: "pending-design" });
        }
        if (fence === "cancelled") current.cancelled = true;
        if (fence === "unrelated_blocker") {
          current.status = "escalated";
          current.pendingAction = { actionId: `next-${digest(["run-1", "existing-blocker"])}`, sourceMessageId: "existing-blocker",
            kind: "resume_coordinator", owner: "coordinator", reason: "Existing capability blocker", createdAt: T0,
            state: "pending", previousStatus: "specifying", recovery: "manual" };
        }
        await save();
      });
      const before = await f.runtime.inspect();
      await f.runtime.recordWorkflowRejected("run-1", { code: "missing_test_mapping", reason: "No mapped test", options: ["Correct mapping"] });
      expect(await f.runtime.inspect()).toEqual(before);
    });

  it.each(["native", "sending", "unknown_delivery"] as const)("keeps verification retries blocked by %s uncertainty under both automatic and explicit retry", async kind => {
    const f = await fixture();
    await f.escalateVerification();
    const intent = coordinatorWake("uncertain-result");
    if (kind === "native") await f.runtime.recordNativeDeliveryIntent(intent, "native-operation");
    else {
      await f.runtime.queueHerdr(intent);
      for (let pass = 0; pass < 3; pass++) await f.runtime.flushOutbound();
      await f.journal.exclusive(async (state, save) => {
        const out = state.outbound.find(out => out.message.message_id === intent.message_id)!;
        expect(out.request).toBeDefined();
        out.status = kind;
        await save();
      });
    }
    f.advance(30 * SECOND);
    const before = await f.record();
    const sent = f.transport.sentRequests.length;
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    await expect(f.runtime.retryVerification("run-1")).rejects.toThrow(/Unknown delivery/);
    await expect(f.runtime.retryVerification("run-1", { automatic: true, actionId: before.pendingAction!.actionId })).rejects.toThrow(/Unknown delivery/);
    expect(await f.record()).toEqual(before);
    expect(f.transport.sentRequests).toHaveLength(sent);
  });

  it("B6: resumes a non-capability Coordinator blocker after its backoff through the idempotent resume_run wake", async () => {
    const f = await fixture();
    await f.runtime.observeCoordinatorOutcome(coordinatorBlocked("blocked-1", "Waiting for the architect analysis to settle"));
    const blocked = await f.record();
    expect(blocked).toMatchObject({ status: "escalated", pendingAction: { recovery: "auto_resume", resumeAttempts: 0, state: "pending", previousStatus: "specifying" } });
    const notice = (await f.outbound()).find(out => out.message.message_id === `coordinator-blocked-${digest(["run-1", "blocked-1"])}`)!;
    expect(notice.message.payload).toMatchObject({ actionId: blocked.pendingAction!.actionId, automaticResume: { attempt: 1, limit: 3 } });

    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 }); // backoff not elapsed
    f.advance(29 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    f.advance(1 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 }); // idempotent: the action is queued
    const resumed = await f.record();
    expect(resumed).toMatchObject({ status: "specifying", pendingAction: { state: "queued", resumeAttempts: 1, lastResumedAt: "2026-10-21T10:00:30.000Z" } });
    expect(resumed.error).toBeUndefined();
    const wakes = await f.resumeWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.message).toMatchObject({ message_id: `resume-${digest(["run-1", blocked.pendingAction!.actionId])}`, recipient: { role: "coordinator" },
      payload: { kind: "resume_run", actionId: blocked.pendingAction!.actionId, automatic: true, attempt: 1, limit: 3 } });
    // An explicit request is distinct from an automatic wake; its own retry is idempotent.
    const explicit = await f.runtime.resumeBlockedRun("run-1", blocked.pendingAction!.actionId);
    expect(await f.resumeWakes()).toHaveLength(2);
    expect(await f.runtime.resumeBlockedRun("run-1", blocked.pendingAction!.actionId)).toEqual(explicit);
    expect(await f.resumeWakes()).toHaveLength(2);
  });

  it("does not auto-resume static runner/proposal blockers, marks recovery as manual, and preserves the blocker for user action", async () => {
    const f = await fixture();
    await f.runtime.observeCoordinatorOutcome(coordinatorBlocked("blocked-runner", "runner_setup_required: Selected test identities cannot be bound"));
    const blocked = await f.record();
    expect(blocked).toMatchObject({
      status: "escalated",
      pendingAction: { recovery: "manual", state: "pending", previousStatus: "specifying" }
    });
    const notice = (await f.outbound()).find(out => out.message.message_id === `coordinator-blocked-${digest(["run-1", "blocked-runner"])}`)!;
    expect(notice.message.payload).toMatchObject({ actionId: blocked.pendingAction!.actionId });
    expect((notice.message.payload as any).automaticResume).toBeUndefined();

    f.advance(120 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    const stillBlocked = await f.record();
    expect(stillBlocked.status).toBe("escalated");
    expect(stillBlocked.pendingAction?.state).toBe("pending");
  });

  it("B1: resumes no-next-action stops with growing backoff, stops after 3 attempts with one notice, and keeps the budget across restart", async () => {
    const f = await fixture();
    await f.runtime.queueHerdr(coordinatorWake("wake-1"));
    await f.stopWithoutAction(coordinatorWake("wake-1"));
    expect(await f.record()).toMatchObject({ status: "escalated", pendingAction: { recovery: "auto_resume", resumeAttempts: 0, state: "pending" } });
    const backoffs = [30, 60, 120];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 1) f.restart(); // a restart keeps the spent budget and backoff anchor
      f.advance((backoffs[attempt]! - 1) * SECOND);
      expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
      f.advance(SECOND);
      expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
      expect(await f.record()).toMatchObject({ status: "specifying", pendingAction: { state: "queued", resumeAttempts: attempt + 1 } });
      const wake = (await f.resumeWakes()).at(-1)!;
      expect(await f.resumeWakes()).toHaveLength(attempt + 1);
      // The resumed Coordinator turn ends without a next action again: a new episode inheriting the spent budget.
      await f.stopWithoutAction(wake.message);
      expect(await f.record()).toMatchObject({ status: "escalated", pendingAction: { recovery: "auto_resume", resumeAttempts: attempt + 1, state: "pending" } });
    }
    f.restart();
    f.advance(10 * 60 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    f.restart();
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    const exhausted = await f.record();
    expect(exhausted).toMatchObject({ status: "escalated", pendingAction: { recovery: "manual", resumeAttempts: 3, state: "pending" } });
    expect(await f.exhaustedNotices()).toHaveLength(1);
    expect(await f.resumeWakes()).toHaveLength(3);
    expect(String((await f.exhaustedNotices())[0]!.message.payload.headline)).toContain("Type `tiếp tục run-1` to resume it (3 of 3 user resumes left)");
  });

  it("lets the user resume after the automatic budget is spent, re-arms automatic resume, bounds user resumes, and keeps both counters across restart", async () => {
    const f = await fixture();
    const exhaustAutomatic = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        f.advance(120 * SECOND);
        expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 }); // automatic resume runs (again)
        await f.stopWithoutAction((await f.resumeWakes()).at(-1)!.message);
      }
      f.advance(120 * SECOND);
      expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
      return f.record();
    };
    await f.runtime.queueHerdr(coordinatorWake("wake-1"));
    await f.stopWithoutAction(coordinatorWake("wake-1"));
    let exhausted = await exhaustAutomatic();
    expect(exhausted.pendingAction).toMatchObject({ recovery: "manual", resumeAttempts: 3 });
    expect(exhausted.pendingAction!.manualResumeAttempts).toBeUndefined();
    for (let round = 1; round <= 3; round++) {
      f.restart(); // both counters are durable
      expect((await f.record()).pendingAction).toMatchObject({ recovery: "manual", resumeAttempts: 3, ...(round > 1 ? { manualResumeAttempts: round - 1 } : {}) });
      await expect(f.runtime.resumeBlockedRun("run-1", exhausted.pendingAction!.actionId)).resolves.toMatchObject({ queued: true });
      expect(await f.record()).toMatchObject({ status: "specifying",
        pendingAction: { state: "queued", recovery: "auto_resume", resumeAttempts: 0, manualResumeAttempts: round, lastResumedAt: new Date(f.now()).toISOString() } });
      await f.stopWithoutAction((await f.resumeWakes()).at(-1)!.message);
      expect(await f.record()).toMatchObject({ status: "escalated", pendingAction: { recovery: "auto_resume", resumeAttempts: 0, manualResumeAttempts: round, state: "pending" } });
      exhausted = await exhaustAutomatic();
      expect(exhausted.pendingAction).toMatchObject({ recovery: "manual", resumeAttempts: 3, manualResumeAttempts: round });
      const notices = await f.exhaustedNotices();
      expect(notices).toHaveLength(round + 1); // one per spent automatic budget
      expect(String(notices.at(-1)!.message.payload.headline)).toContain(round < 3 ? `(${3 - round} of 3 user resumes left)` : "All 3 user resumes are used");
    }
    f.restart();
    await expect(f.runtime.resumeBlockedRun("run-1", exhausted.pendingAction!.actionId)).rejects.toThrow(/Explicit resume budget is exhausted/);
    expect(await f.record()).toMatchObject({ status: "escalated", pendingAction: { state: "pending", recovery: "manual", resumeAttempts: 3, manualResumeAttempts: 3 } });
    expect(await f.resumeWakes()).toHaveLength(3 + 3 * 4);
  }, 60_000);

  it("B8: re-runs the existing retry_verification automatically with backoff, bounded to 3 retries", async () => {
    const f = await fixture([run("run-1", "verifying")]);
    await f.escalateVerification();
    const escalated = await f.record();
    expect(escalated).toMatchObject({ status: "escalated", error: VERIFICATION_REASON,
      pendingAction: { recovery: "auto_resume", resumeAttempts: 0, state: "pending", previousStatus: "verifying" } });
    const stuck = (await f.outbound()).filter(out => (out.message.payload as { kind?: string }).kind === "verification_stuck");
    expect(stuck.find(out => out.message.recipient.role === "conversation")!.message.payload).toMatchObject({ automaticResume: { attempt: 1, limit: 3 } });
    expect(String((stuck.find(out => out.message.recipient.role === "coordinator")!.message.payload as { next?: string }).next)).toMatch(/retries it automatically/);
    const backoffs = [30, 60, 120];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 2) f.restart();
      f.advance((backoffs[attempt]! - 1) * SECOND);
      expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
      f.advance(SECOND);
      f.panes.busy.add("coordinator"); // verification retry needs no Coordinator turn
      expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
      f.panes.busy.delete("coordinator");
      const retried = await f.record();
      expect(retried).toMatchObject({ status: "verifying", pendingAction: { state: "queued", resumeAttempts: attempt + 1 } });
      expect(retried.error).toBeUndefined();
      await f.escalateVerification(); // the same environment failure recurs
      expect(await f.record()).toMatchObject({ status: "escalated", pendingAction: { recovery: "auto_resume", resumeAttempts: attempt + 1, state: "pending" } });
    }
    f.advance(10 * 60 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await f.record()).toMatchObject({ status: "escalated", error: VERIFICATION_REASON, pendingAction: { recovery: "manual", resumeAttempts: 3 } });
    expect(await f.exhaustedNotices()).toHaveLength(1);
    await expect(f.runtime.retryVerification("run-1")).rejects.toThrow(/exhausted/);
    expect(await f.resumeWakes()).toEqual([]); // never woke the Coordinator
  });

  it("never resumes automatically past a pending approval, a pending user decision, a cancellation or an unknown delivery", async () => {
    const approval = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: "design-1", runId: "run-1", sessionId: "session-1",
      status: "pending", target: { type: "run" }, revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: T0,
      reason: "Specification acceptance", evidence: [], idempotencyKey: "design:run-1" });
    const block = (f: Awaited<ReturnType<typeof fixture>>, patch: (run: RunRecord, state: JournalState) => void) =>
      f.journal.exclusive(async (state: JournalState, save) => {
        const current = state.runs[0]!, sourceMessageId = "blocked-source";
        current.status = "escalated"; current.error = "Coordinator blocked: transient";
        current.pendingAction = { actionId: `next-${digest(["run-1", sourceMessageId])}`, kind: "resume_coordinator", owner: "coordinator",
          reason: current.error, sourceMessageId, createdAt: T0, state: "pending", previousStatus: "specifying", resumeAttempts: 0, recovery: "auto_resume" };
        patch(current, state); await save();
      });
    const expectWaiting = async (f: Awaited<ReturnType<typeof fixture>>, sentBefore = 0) => {
      f.advance(10 * 60 * SECOND);
      expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
      expect(await f.record()).toMatchObject({ status: "escalated", pendingAction: { recovery: "auto_resume", resumeAttempts: 0, state: "pending" } });
      expect(await f.resumeWakes()).toEqual([]);
      await f.runtime.flushOutbound();
      expect(f.transport.sentRequests).toHaveLength(sentBefore); // nothing sent or resent
    };

    const pendingApproval = await fixture();
    await block(pendingApproval, current => { current.approval = approval; current.approvalKind = "design"; });
    await expectWaiting(pendingApproval);
    expect((await pendingApproval.record()).decision).toBeUndefined(); // never answered automatically

    const pendingDecision = await fixture();
    await pendingDecision.runtime.requestUserDecision(pendingDecision.coordinator(), "coordinator", parseUserDecisionToolInput({ runId: "run-1",
      taskId: "planning", question: "Which storage backend?", options: ["SQLite", "Postgres"], expiresInMinutes: 60 }));
    await block(pendingDecision, () => undefined);
    await expectWaiting(pendingDecision);
    expect(Object.values((await pendingDecision.record()).userDecisions ?? {}).map(item => item.status)).toEqual(["pending"]);

    const cancelled = await fixture();
    await block(cancelled, current => { current.cancelled = true; });
    cancelled.advance(10 * 60 * SECOND);
    expect(await cancelled.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await cancelled.resumeWakes()).toEqual([]);

    const uncertain = await fixture();
    await uncertain.runtime.queueHerdr(coordinatorWake("uncertain-wake"));
    await uncertain.runtime.flushOutbound(); // a dispatch intent exists; its acknowledgement is then lost
    const sent = uncertain.transport.sentRequests.length;
    await block(uncertain, (_run, state) => { state.outbound.find(out => out.message.message_id === "uncertain-wake")!.status = "unknown_delivery"; });
    await expectWaiting(uncertain, sent);
    expect((await uncertain.outbound()).find(out => out.message.message_id === "uncertain-wake")!.status).toBe("unknown_delivery"); // never resent
  });

  it("does not resume while the Coordinator pane is busy and does not spend budget doing so", async () => {
    const f = await fixture();
    await f.runtime.observeCoordinatorOutcome(coordinatorBlocked("blocked-busy", "Transient planning blocker"));
    f.panes.busy.add("coordinator");
    f.advance(60 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await f.record()).toMatchObject({ pendingAction: { resumeAttempts: 0, state: "pending" } });
    f.panes.busy.delete("coordinator");
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
  });

  it("enqueues distinct resume_run wakes across recurring reportRunStalled episodes that share one actionId", async () => {
    const f = await fixture([run("run-1", "intake")]);
    const backoffs = [30, 60, 120];
    for (let attempt = 0; attempt < 3; attempt++) {
      await f.runtime.reportRunStalled("run-1", `episode-${attempt}`);
      const stalled = await f.record();
      expect(stalled).toMatchObject({ status: "escalated", pendingAction: { recovery: "auto_resume", resumeAttempts: attempt, state: "pending" } });
      f.advance(backoffs[attempt]! * SECOND);
      expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
      const wakes = await f.resumeWakes();
      expect(wakes).toHaveLength(attempt + 1);
      expect(wakes.at(-1)!.status).toBe("queued");
      for (let pass = 0; pass < 3 && (await f.resumeWakes()).at(-1)!.status === "queued"; pass++) {
        await f.runtime.flushOutbound();
      }
      expect(["accepted", "released"]).toContain((await f.resumeWakes()).at(-1)!.status);
      const runtime = f.runtime as unknown as { transaction: (action: (state: JournalState, save: () => Promise<void>, core: unknown, outbox: { release: (out: Outbound) => Promise<void> }) => Promise<void>) => Promise<void> };
      await runtime.transaction(async (state, save, _core, outbox) => {
        const lastWake = state.outbound.filter(out => (out.message.payload as { kind?: string }).kind === "resume_run").at(-1)!;
        await outbox.release(lastWake);
        await save();
      });
    }
  });

  it("authorizes Agy Coordinator approval.decision turns and recovers delivered approval.decision outbox items missing from inbox", async () => {
    const approval = ApprovalRequestSchema.parse({
      schemaVersion: 2, approvalId: "approval-1", runId: "run-1", sessionId: "session-1",
      status: "pending", target: { type: "run" }, revision: 1, generation: 1, requestedBy: "coordinator", requestedAt: T0,
      reason: "Approve spec", evidence: [], idempotencyKey: "approval-1"
    });
    const f = await fixture([run("run-1", "awaiting_approval", { approval, approvalKind: "design" })]);
    const coordinatorBinding = PaneBindingSchema.parse({
      ...f.coordinator(),
      provider: "agy",
      agentKind: "agy",
      session: { source: "herdr:antigravity_cli", kind: "id", value: "session-coordinator" }
    });
    f.panes.bindings = f.panes.bindings.map(binding => binding.role === "coordinator" ? coordinatorBinding : binding);

    const decisionMessage = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "approval-msg-1",
      correlation_id: "correlation",
      causation_id: "approval-1",
      run_id: "run-1",
      sender: { role: "conversation" },
      recipient: { role: "coordinator" },
      type: "approval.decision",
      payload: {
        schemaVersion: 2,
        approvalId: "approval-1",
        runId: "run-1",
        sessionId: "session-1",
        target: approval.target,
        revision: 1,
        generation: 1,
        decision: "rejected",
        decidedBy: "user",
        decidedAt: T0,
        reason: "Need another approach",
        feedbackArtifacts: [],
        idempotencyKey: "decision-1"
      },
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "approval-msg-1"
    });
    await f.runtime.queueHerdr(decisionMessage);
    await f.runtime.flushOutbound();
    const out = (await f.outbound()).find(item => item.message.message_id === "approval-msg-1")!;
    expect(out.status).toBe("accepted");

    await expect(f.runtime.authorizeAgyProviderTurn(out.message, coordinatorBinding)).resolves.toBeUndefined();

    // Simulate a previous turn where PreInvocation aborted before inbox write and Stop released the lease.
    await f.journal.exclusive(async (state, save) => {
      state.outbound.find(item => item.message.message_id === "approval-msg-1")!.status = "released";
      await save();
    });
    expect(await f.runtime.recoverMissingCoordinatorWakeups()).toEqual({ recovered: 1 });
    expect(await f.record()).toMatchObject({ status: "failed", decision: { approvalId: "approval-1", decision: "rejected" } });
  });
});
