import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { ApprovalRequestSchema, DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema,
  type OperationResult, type PaneBinding, type RoleMessage } from "@bflow/contracts";
import { AgenticJournal, digest, type JournalState, type Outbound, type RunRecord } from "../../src/agentic/journal.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { evaluateWatchdog } from "../../src/agentic/run-watchdog.js";
import type { AgenticRuntimePorts, PanePolicy } from "../../src/agentic/ports.js";
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
  bindings: PaneBinding[] = ["conversation", "coordinator", "developer"].map(role => PaneBindingSchema.parse({
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

async function fixture(options: { deliveryFails?: boolean; runs?: RunRecord[] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-stuck-states-")));
  cleanup.push(root);
  let now = Date.parse(T0);
  const panes = new Panes(), transport = new FakeAgentTransport();
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });
  const delivered: RoleMessage[] = [];
  const conversation = { attempts: 0, failing: options.deliveryFails ?? false };
  const ports = {
    clock: () => new Date(now), authenticateMessage: async () => true, authorizeHuman: async () => true,
    deliverToConversation: async (value: RoleMessage) => {
      conversation.attempts++;
      if (conversation.failing) throw new Error("Gateway unavailable");
      delivered.push(value);
    },
    transport, registry, panes, roleCapabilities: { coordinator: [], developer: [], conversation: [] },
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
    runtime, panes, transport, registry, delivered, conversation, journal, outboundOf, notices,
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
    await f.runtime.queueHerdr(message("assign-dev", { recipient: { role: "developer" } }));
    await f.runtime.flushOutbound();
    expect((await f.outboundOf("assign-dev")).status).toBe("accepted");
    f.panes.busy.add("developer"); // the Developer is working on it: still accepted, not released
    await f.runtime.flushOutbound();
    expect((await f.outboundOf("assign-dev")).status).toBe("accepted");

    f.setNow(Date.parse(T0) + 4 * MINUTE);
    const [facts] = await f.runtime.watchdogSnapshot("session-1");
    expect(facts).toMatchObject({ activeHandoff: false, acceptedRoles: ["developer"] });
    const idle = [{ role: "coordinator", status: "idle" }, { role: "developer", status: "idle" }];
    expect(evaluateWatchdog({ now: f.now(), runs: [facts!], notices: [], panes: idle })).toEqual([
      expect.objectContaining({ kind: "stalled", runId: "run-1", holders: ["developer"] })]);
    expect(evaluateWatchdog({ now: f.now(), runs: [facts!], notices: [],
      panes: [{ role: "coordinator", status: "idle" }, { role: "developer", status: "working" }] })).toEqual([]);

    await f.runtime.reportRunStalled("run-1", `run-1@${Date.parse(T0)}`);
    const reports = await f.notices("developer_no_response");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message.payload).toMatchObject({ role: "developer", paneId: "pane-developer", options: expect.any(Array) });
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
});

describe("specialist blockers and run-step isolation", () => {
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
});
