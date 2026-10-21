import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema,
  type OperationResult, type PaneBinding, type RoleMessage } from "@bflow/contracts";
import { AgenticJournal, type JournalState, type Outbound, type RunRecord } from "../../src/agentic/journal.js";
import { AdmissionRejectedError, AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { describeValidationError } from "../../src/agentic/role-message-feedback.js";
import { evaluateWatchdog } from "../../src/agentic/run-watchdog.js";
import type { AgenticRuntimePorts, PanePolicy } from "../../src/agentic/ports.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { draft } from "../../../specification/test/fixtures.js";

// W2 (B2/B5): an invalid RoleMessage goes back to its sender to fix, and a silent holder is reminded once, before either
// involves the Coordinator through the bounded `auto_resume` mechanism. Neither ever waits for a human "tiếp tục".

const T0 = "2026-10-21T10:00:00.000Z";
const SECOND = 1_000;
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
    title: "Schema and stall recovery", objective: "Exercise automatic recovery", specificationId: specification.specId, sddLevel: specification.level,
    acceptanceCriteria: specification.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: T0, idempotencyKey: `intake-${runId}` });
}
function run(runId: string, status: RunRecord["status"], overrides: Partial<RunRecord> = {}): RunRecord {
  return { runId, delegation: delegation(runId), status, tasks: [], coreCreated: false, cancelled: false, maxIterations: 3, ...overrides };
}
const ARCHITECT = { role: "architect" as const, agent_id: "architect-agent", pane_id: "pane-architect" };
function fromArchitect(id: string, causation: string, type: RoleMessage["type"], payload: unknown, at = T0): RoleMessage {
  return RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: "correlation", causation_id: causation, run_id: "run-1",
    sender: ARCHITECT, recipient: { role: "coordinator" }, type, payload, artifact_references: [], occurred_at: at, idempotency_key: id });
}

async function fixture(runs: RunRecord[] = [run("run-1", "specifying")]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-schema-stall-")));
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
    runtime: open(), panes, transport,
    restart: () => { f.runtime = open(); return f.runtime; },
    advance: (ms: number) => { now += ms; },
    now: () => now,
    record: async () => await f.runtime.inspect("run-1") as unknown as RunRecord,
    state: async () => await f.runtime.inspect() as unknown as JournalState,
    ofKind: async (kind: string) => (await f.state()).outbound.filter(out => (out.message.payload as { kind?: string }).kind === kind),
    notices: async (kind: string) => (await f.state()).outbound.filter(out => out.message.recipient.role === "conversation" &&
      (out.message.payload as { kind?: string }).kind === kind),
    sentTo: (role: string) => transport.sentRequests.filter(request => request.role === role),
    binding: (role: string) => panes.bindings.find(pane => pane.role === role)!,
    /** Coordinator asks the architect; the request is dispatched and, the pane being idle again, its transport lease released. */
    askArchitect: async (): Promise<Outbound> => {
      const request = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]));
      await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
      const out = (await f.state()).outbound.find(item => item.message.message_id === request.message_id)!;
      expect(["accepted", "released"]).toContain(out.status);
      return out;
    },
    /** The host's inbound pump: apply, and on a deterministic failure report it after its bounded retries. */
    deliver: async (message: RoleMessage): Promise<unknown> => {
      try { return await f.runtime.receiveHerdr(message); }
      catch (error) {
        if (!(error instanceof AdmissionRejectedError)) await f.runtime.reportInboundFailure(message, `${String(error)} (dropped after 5 attempts)`);
        return error;
      }
    },
    /** One host watchdog pass with every role pane idle, `idleMs` after the last activity. */
    watchdog: async (idleMs = 181 * SECOND) => {
      const runs = await f.runtime.watchdogSnapshot("session-1");
      const actions = evaluateWatchdog({ now: Math.max(...runs.map(item => item.lastActivityAt)) + idleMs, runs, notices: [],
        panes: panes.bindings.filter(pane => pane.role !== "conversation").map(pane => ({ role: pane.role, paneId: pane.paneId, status: "idle" })) });
      for (const action of actions) if (action.kind === "stalled") await f.runtime.reportRunStalled(action.runId, action.episodeKey);
      return actions;
    }
  };
  return f;
}
const invalidResult = (id: string, causation: string) => fromArchitect(id, causation, "verification.result", { status: "passed" });

describe("B2: invalid RoleMessages go back to their sender", () => {
  it("formats schema issues as field paths with their messages", () => {
    const parsed = RoleMessageSchema.safeParse({ schema_version: 2, message_id: "m", correlation_id: "c", sender: { role: "architect" },
      recipient: { role: "coordinator" }, type: "escalation.notice", payload: {}, artifact_references: [] });
    expect(parsed.success).toBe(false);
    const text = describeValidationError(parsed.error);
    expect(text).toMatch(/^type: /);
    expect(describeValidationError(String(parsed.error))).toBe(text); // the same issues recovered from the error text
    expect(describeValidationError(new Error("x".repeat(5_000))).length).toBeLessThanOrEqual(1500);
  });

  it("returns one invalid result to the architect, then applies its corrected resend without escalating the run", async () => {
    const f = await fixture();
    const request = await f.askArchitect();
    const invalid = invalidResult("bad-1", request.message.message_id);
    expect(String(await f.deliver(invalid))).toMatch(/verificationId|invalid_type|Required/);
    let current = await f.record();
    expect(current.status).toBe("specifying");
    expect(current.pendingAction).toBeUndefined();
    const feedback = await f.ofKind("role_message_rejected");
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.message).toMatchObject({ sender: { role: "runtime" }, recipient: { role: "architect", pane_id: "pane-architect" },
      causation_id: "bad-1", payload: { attempt: 1, limit: 3, rejectedType: "verification.result", errors: expect.stringMatching(/^[\w.]+: /) } });
    expect(await f.notices("delivery_failure")).toEqual([]);
    expect(await f.notices("workflow_blocked")).toEqual([]);
    // The refusal is durable and final for that envelope: a redelivery is answered by the same refusal, never re-counted.
    expect((await f.state()).inbox.find(item => item.message.message_id === "bad-1")?.status).toBe("rejected");
    expect(await f.deliver(invalid)).toBeInstanceOf(AdmissionRejectedError);
    expect(await f.ofKind("role_message_rejected")).toHaveLength(1);
    await f.runtime.flushOutbound();
    expect(f.sentTo("architect")).toHaveLength(2); // the request, then the validation error through Herdr

    await f.deliver(fromArchitect("good-1", request.message.message_id, "spec.draft", { status: "completed", summary: "Impact analysis" }));
    current = await f.record();
    expect(current.status).toBe("specifying");
    expect(current.pendingAction).toBeUndefined();
    expect((await f.ofKind("specialist_result_ready")).map(out => out.message.causation_id)).toEqual(["good-1"]);
    expect(await f.notices("delivery_failure")).toEqual([]);
  });

  it("counts a synchronous send_role_message failure without escalating, so the agent can resend in the same turn", async () => {
    const f = await fixture();
    const request = await f.askArchitect();
    const parsed = RoleMessageSchema.safeParse({ message_id: "tool-bad", run_id: "run-1", type: "escalation.notice" });
    expect(await f.runtime.reportRoleToolFailure(f.binding("architect"), { message: { message_id: "tool-bad", run_id: "run-1",
      causation_id: request.message.message_id, type: "escalation.notice" } }, describeValidationError(parsed.error)))
      .toEqual({ attempt: 1, limit: 3, escalated: false });
    expect(await f.record()).toMatchObject({ status: "specifying" });
    expect(await f.notices("workflow_blocked")).toEqual([]);
    expect(await f.ofKind("role_message_rejected")).toEqual([]); // the tool error itself is the feedback: no extra Herdr prompt
    await f.deliver(fromArchitect("good-2", request.message.message_id, "spec.draft", { status: "completed", summary: "Impact analysis" }));
    expect((await f.record()).pendingAction).toBeUndefined();
    expect(await f.ofKind("specialist_result_ready")).toHaveLength(1);
  });

  it("hands the third invalid message for one assignment to the Coordinator as a bounded auto_resume, keeping the count across restart", async () => {
    const f = await fixture();
    const request = await f.askArchitect();
    await f.deliver(invalidResult("bad-1", request.message.message_id));
    await f.deliver(invalidResult("bad-2", request.message.message_id));
    expect(await f.record()).toMatchObject({ status: "specifying", invalidMessages: [{ count: 2, messageIds: ["bad-1", "bad-2"] }] });
    expect((await f.ofKind("role_message_rejected")).map(out => (out.message.payload as { attempt: number }).attempt)).toEqual([1, 2]);
    f.restart(); // the count is durable
    await f.runtime.recoverMissingCoordinatorWakeups(); // replaying the refused envelopes neither re-counts nor re-answers them
    expect(await f.record()).toMatchObject({ status: "specifying", invalidMessages: [{ count: 2 }] });
    await f.deliver(invalidResult("bad-3", request.message.message_id));
    const escalated = await f.record();
    expect(escalated).toMatchObject({ status: "escalated", error: expect.stringContaining("invalid 3 times"),
      pendingAction: { kind: "resume_coordinator", recovery: "auto_resume", resumeAttempts: 0, state: "pending", sourceMessageId: "bad-3", previousStatus: "specifying" } });
    expect(await f.ofKind("role_message_rejected")).toHaveLength(2);
    expect(await f.notices("delivery_failure")).toHaveLength(1);

    f.advance(30 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
    expect(await f.record()).toMatchObject({ status: "specifying", pendingAction: { state: "queued", resumeAttempts: 1 } });
    expect(await f.ofKind("resume_run")).toHaveLength(1);
  });

  it("escalates synchronous tool failures only on the third attempt for one assignment, also across restart", async () => {
    const f = await fixture();
    await f.askArchitect();
    const report = () => f.runtime.reportRoleToolFailure(f.binding("architect"), { message: { message_id: "same-id", run_id: "run-1", type: "nope" } }, "type: Invalid enum value");
    expect((await report())!.attempt).toBe(1);
    f.restart();
    expect((await report())!.attempt).toBe(2);
    expect(await f.record()).toMatchObject({ status: "specifying" });
    expect(await report()).toEqual({ attempt: 3, limit: 3, escalated: true });
    expect(await f.record()).toMatchObject({ status: "escalated", pendingAction: { recovery: "auto_resume", sourceMessageId: "same-id" } });
    const blocked = await f.notices("workflow_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.message.payload).toMatchObject({ automaticResume: { attempt: 1, limit: 3 } });
  });

  it("keeps transport failures on the existing delivery-failure path", async () => {
    const f = await fixture();
    const request = await f.askArchitect();
    await f.runtime.reportInboundFailure(fromArchitect("lost-1", request.message.message_id, "spec.draft", { status: "completed" }),
      "Error: acknowledgement not observed (uncertain)");
    expect(await f.ofKind("role_message_rejected")).toEqual([]);
    expect(await f.notices("delivery_failure")).toHaveLength(1);
    expect((await f.record()).invalidMessages).toBeUndefined();
  });
});

describe("B5: a silent holder is reminded once before the Coordinator is resumed", () => {
  it("reminds the holder exactly once, then applies its late result without escalating", async () => {
    const f = await fixture();
    const request = await f.askArchitect();
    const [stall] = await f.watchdog();
    expect(stall).toMatchObject({ kind: "stalled", holders: ["architect"] });
    await f.runtime.reportRunStalled("run-1", (stall as { episodeKey: string }).episodeKey); // the host may repeat an action
    const reminders = await f.ofKind("result_reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.message).toMatchObject({ sender: { role: "runtime" }, recipient: { role: "architect", pane_id: "pane-architect" },
      causation_id: request.message.message_id, payload: { sourceMessageId: request.message.message_id, next: expect.stringContaining("blocked") } });
    expect(await f.record()).toMatchObject({ status: "specifying" });
    expect((await f.record()).pendingAction).toBeUndefined();
    expect(await f.notices("run_stalled")).toEqual([]);
    await f.runtime.flushOutbound();
    expect(f.sentTo("architect")).toHaveLength(2); // the request, then the reminder through Herdr

    await f.deliver(fromArchitect("late-result", request.message.message_id, "spec.draft", { status: "completed", summary: "Impact analysis" }));
    expect((await f.record()).pendingAction).toBeUndefined();
    expect(await f.record()).toMatchObject({ status: "specifying" });
    expect(await f.ofKind("specialist_result_ready")).toHaveLength(1);
    expect((await f.runtime.watchdogSnapshot("session-1"))[0]!.acceptedRoles).toEqual([]);
    expect(await f.ofKind("result_reminder")).toHaveLength(1);
  });

  it("resumes the Coordinator automatically when the reminded holder stays silent, and keeps the reminder across restart", async () => {
    const f = await fixture();
    const request = await f.askArchitect();
    await f.watchdog();
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    f.restart(); // the reminder is durable: the next episode does not remind again
    const [stall] = await f.watchdog();
    expect(stall).toMatchObject({ kind: "stalled", holders: ["architect"] });
    expect(await f.ofKind("result_reminder")).toHaveLength(1);
    const escalated = await f.record();
    expect(escalated).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", recovery: "auto_resume",
      resumeAttempts: 0, sourceMessageId: request.message.message_id, previousStatus: "specifying" } });
    const notices = await f.notices("run_stalled");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message.payload).toMatchObject({ role: "architect", automaticResume: { attempt: 1, limit: 3 },
      reason: expect.stringContaining("never task success") });
    expect(await f.watchdog()).toEqual([]); // an escalated run is no longer watched for stalls

    f.advance(30 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
    expect(await f.ofKind("resume_run")).toHaveLength(1);
  });

  it("resumes the Coordinator automatically when a stalled run has no holder at all", async () => {
    const f = await fixture();
    const [stall] = await f.watchdog();
    expect(stall).toMatchObject({ kind: "stalled" });
    expect(await f.ofKind("result_reminder")).toEqual([]);
    expect(await f.record()).toMatchObject({ status: "escalated", pendingAction: { recovery: "auto_resume", sourceMessageId: "intake-run-1" } });
    expect((await f.notices("run_stalled"))[0]!.message.payload).toMatchObject({ automaticResume: { attempt: 1 } });
    f.advance(30 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
  });

  it("never reminds a holder or resumes while a human gate is pending", async () => {
    const f = await fixture([run("run-1", "awaiting_approval")]);
    expect(await f.watchdog()).toEqual([]);
    await f.runtime.reportRunStalled("run-1", "run-1@forced");
    expect(await f.ofKind("result_reminder")).toEqual([]);
    expect(await f.record()).toMatchObject({ status: "awaiting_approval" });
  });
});
