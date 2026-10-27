import { once } from "node:events";
import { createHash } from "node:crypto";
import { DeveloperProcessScopes } from "../../src/agentic/developer-process-scope.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRequestSchema, RoleMessageSchema, type PaneBinding, type QualityGate, type Specification } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { AgenticWorkflowRuntime, CANCEL_STOP_OBSERVATION_LIMIT } from "../../src/agentic/runtime.js";
import { AgenticJournal, digest } from "../../src/agentic/journal.js";
import { loadAgenticPolicies, type PanePolicy } from "../../src/agentic/ports.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" } }).trim();

/** Developer panes are allocated on demand; `busy` only controls the Developer pane's readiness for prompt. */
class Panes implements PanePolicy {
  busy = new Set<string>();
  releases: { taskId: string; closePane: boolean; removeWorktree: boolean }[] = [];
  bindings: PaneBinding[] = ["conversation", "coordinator", "specifier", "architect", "planner", "reviewer", "qa", "tester"].map(role => ({
    schemaVersion: 2, bindingId: `binding-${role}`, sessionId: "session-1", role: role as PaneBinding["role"],
    paneGroup: "coordination", agentId: role, workspaceId: "workspace-1", tabId: "tab-1", paneId: `pane-${role}`,
    provider: "test", agentKind: "test", cwd: "/tmp", isolationMode: "dedicated_pane", readOnlyWorkspace: true,
    session: { source: "test", kind: "id", value: `session-${role}` },
    transportState: "idle", boundAt: new Date().toISOString()
  }));
  async getManifest() { return { ok: true as const, value: { schemaVersion: 2 as const, sessionId: "session-1", projectName: "Test", workspaceRoot: "/tmp", herdrWorkspaceId: "workspace-1", herdrTabId: "tab-1", status: "up" as const,
    conversationSessionId: "session-1", activeRunIds: [], panes: this.bindings, attachTarget: { role: "conversation" as const, paneId: "pane-conversation" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }; }
  async getRoleBinding(selector: string) { return { ok: true as const, value: this.bindings.find(p => [p.role, p.bindingId, p.paneId, p.agentId].includes(selector)) ?? null }; }
  async inspectRoleHealth(selector: string) { const p = unwrap(await this.getRoleBinding(selector)); if (!p) throw new Error("No pane"); return { ok: true as const, value: { readyForPrompt: !this.busy.has(p.role), occupantMatches: true, paneId: p.paneId, agentId: p.agentId } }; }
  async allocateDeveloper(request: { taskId: string; worktreePath: string; agentName: string; runId?: string }) {
    const old = this.bindings.find(p => p.agentId === request.agentName); if (old) return { ok: true as const, value: old };
    const p = { ...this.bindings[0]!, bindingId: request.agentName, role: "developer" as const, agentId: request.agentName,
      paneId: `pane-${request.agentName}`, cwd: request.worktreePath, worktreePath: request.worktreePath, readOnlyWorkspace: false,
      metadata: { taskId: request.taskId, ...(request.runId ? { runId: request.runId } : {}) } };
    this.bindings.push(p); return { ok: true as const, value: p };
  }
  async releaseDeveloper(request: { taskId: string; closePane: boolean; removeWorktree: boolean }) {
    const binding = this.bindings.find(p => p.metadata?.taskId === request.taskId);
    if (binding && git(binding.cwd, "status", "--porcelain")) return { ok: false as const,
      error: { code: "conflict" as const, retryable: false, message: "Worktree contains uncommitted changes" } };
    this.releases.push(request);
    if (binding) binding.metadata = { ...binding.metadata, allocationStatus: "released" };
    return { ok: true as const, value: undefined };
  }
}

/**
 * Real journal, engine, registry, git policy and worktrees. A single documentation task is dispatched to a Developer, so the
 * run has an accepted, leased, Core-bound execution to cancel. Quality gates are never reached: no scenario submits work.
 */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-cancel-reconcile-")));
  const repository = join(root, "repo"); await mkdir(repository); git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test"); git(repository, "config", "user.email", "test@example.test");
  await writeFile(join(repository, "guide.md"), "initial\n");
  git(repository, "add", "."); git(repository, "commit", "-m", "baseline");
  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "cancel-reconcile" }));
  cleanups.push(async () => { store.close(); artifacts.close(); await rm(root, { recursive: true, force: true }); });
  const transport = new FakeAgentTransport(); const panes = new Panes();
  const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys: {} });
  let timeOffset = 0;
  const clock = () => new Date(Date.now() + timeOffset);
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock });
  const checks = ["review", "regression"].map(id => ({ id, name: id, evaluator: id, required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" }, configuration: {} })) as any;
  const gates: QualityGate[] = checks.map((check: { id: string }) => ({ id: check.id, evaluate: async () => { throw new Error("Quality gates are not evaluated by cancellation scenarios"); } }));
  const conversationInbox: unknown[] = [];
  const ports = { engine, runStore: store, artifactStore: artifacts, registry, transport, panes, clock, policies: undefined as unknown as Awaited<ReturnType<typeof loadAgenticPolicies>>,
    deliverToConversation: async (message: unknown) => { conversationInbox.push(message); },
    roleCapabilities: { developer: ["implementation"], coordinator: ["coordination", "repository.read"], conversation: ["conversation"], specifier: ["specification", "repository.read"], architect: ["architecture", "repository.read"], planner: ["planning", "repository.read"], reviewer: ["review", "repository.read"], qa: ["verification", "repository.read"], tester: ["testing", "repository.read"] },
    taskChecks: checks, workflowChecks: checks,
    authenticateMessage: async () => true, authenticateResult: async () => true, authenticateEvidence: async () => true, authenticateGateResult: async () => true,
    authorizeHuman: async (decision: { decidedBy: string }) => decision.decidedBy === "human-1" };
  ports.policies = await loadAgenticPolicies({ repositoryPath: repository, artifactStore: artifacts, gates,
    loadSpecification: id => runtime.loadSpecification(id), authorizeApprover: decision => ["coordinator", "human-1"].includes(decision.decidedBy) });
  const runtime: AgenticWorkflowRuntime = new AgenticWorkflowRuntime(ports, { journalDirectory: join(root, "journal"), repositoryPath: repository });

  const time = new Date().toISOString();
  const spec: Specification = draft("documentation");
  spec.createdAt = time; spec.updatedAt = time;
  spec.affectedPaths = ["guide.md"];
  spec.traceabilityTaskIds = ["implement"];
  (spec.metadata!.sdd as any).traceability[0].taskIds = spec.traceabilityTaskIds;
  spec.metadata!.conditionalTdd = { policyVersion: 1, taskId: "implement", taskType: "documentation",
    changeImpact: { surfaces: ["documentation"], behaviorChanged: false, deterministic: false, regressionReproducible: false, securitySensitive: false, dataMigration: false, scope: "local" },
    infrastructure: { readiness: "ready", commands: [{ method: "integration_test", command: "test-regression", level: "integration" }] },
    testability: { level: "automated", rationale: "Independent repeatable behavioral checks are available" }, riskClassification: "low",
    conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] } };
  delete spec.testStrategy; delete spec.tddDecision;
  const def = workflow(spec.traceabilityTaskIds); def.maxConcurrency = 1;
  def.tasks.forEach(task => { (task as any).metadata = { ownedPaths: ["guide.md"] }; });
  const delegation = { schemaVersion: 2, delegationId: "delegation-1", messageId: "intake-1", correlationId: "correlation-1", sessionId: "session-1", runId: "run-1",
    requestedBy: "conversation", targetRole: "coordinator", title: spec.title, objective: spec.summary, specificationId: spec.specId, sddLevel: spec.level,
    acceptanceCriteria: spec.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: time, idempotencyKey: "intake-1" };
  await runtime.receiveHerdr(RoleMessageSchema.parse({ schema_version: 2, message_id: "intake-1", correlation_id: "correlation-1", run_id: "run-1",
    sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" }, recipient: { role: "coordinator" },
    type: "delegation.request", payload: delegation, artifact_references: [], occurred_at: time, idempotency_key: "intake-1" }));

  /** Starts the run and dispatches its single Developer assignment, which is accepted and leased. */
  async function dispatch() {
    await runtime.proposeWorkflow("run-1", spec, def); await runtime.tick();
    const developer = (await runtime.inspect() as any).outbound.find((out: any) => out.message.type === "task.assignment");
    expect(developer.status).toBe("accepted");
    return developer;
  }
  return { root, repository, runtime, ports, transport, panes, dispatch, spec, definition: def, advance: (ms: number) => { timeOffset += ms; },
    state: async () => await runtime.inspect() as any,
    /** Conversation notices of the run that carry the cancellation headline, interim or final. */
    cancelHeadlines: async () => ((await runtime.inspect() as any).outbound as any[])
      .filter(out => out.message.recipient.role === "conversation" && String(out.message.payload.headline ?? "").startsWith("Run cancelled"))
      .map(out => String(out.message.payload.headline)) };
}

/** The single final notice's deterministic message id, as the outbox keys it. */
const finalNoticeId = `p19-${digest(["run-1", "cancel-reconciled"])}`;
const finalNotices = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.state()).outbound
  .filter((out: any) => out.message.message_id === finalNoticeId);

describe("cancellation reconciliation: a stop observed as idle releases the lease and reports full stop", () => {
  it("releases the lease after the stop is observed and emits one final notice that says the run is fully stopped", async () => {
    const f = await fixture();
    const developer = await f.dispatch();
    await f.runtime.cancel("run-1", "User cancelled");
    expect((await f.state()).outbound.find((out: any) => out.message.message_id === developer.message.message_id).cancelRequested).toBe(true);
    // Herdr idle: the pane has returned to its prompt. Herdr done is turn completion and would not count.
    f.transport.customWaitHandler = (handle) => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    await f.runtime.tick();
    const after = (await f.state()).outbound.find((out: any) => out.message.message_id === developer.message.message_id);
    expect(after.status).toBe("released");
    expect(after.lease).toBeDefined();
    const final = await finalNotices(f);
    expect(final).toHaveLength(1);
    expect(final[0].message.payload.headline).toMatch(/^Run cancelled: fully stopped, 1 lease\(s\) released/);
    expect((await f.state()).runs[0].cancelReconciled).toBe(true);
    expect((await f.ports.engine.getSnapshot("run-1") as any).value.status).toBe("cancelled");
  });

  it("retains the cancelled worktree on disk and names its path in the final notice", async () => {
    const f = await fixture();
    const developer = await f.dispatch();
    const worktree = developer.handle.target.worktreePath as string;
    await f.runtime.cancel("run-1", "User cancelled");
    f.transport.customWaitHandler = (handle) => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    await f.runtime.tick();
    const final = await finalNotices(f);
    expect(final[0].message.payload.headline).toContain("0 worktree(s) removed, 1 retained");
    expect(final[0].message.payload.headline).toContain(worktree);
    expect(git(f.repository, "worktree", "list", "--porcelain")).toContain(worktree);
  });
});

describe("cancellation reconciliation: an unconfirmed stop is bounded and reported for manual reconciliation", () => {
  it("stops observing after the bound, keeps the lease, and emits one final notice that lists the manual item", async () => {
    const f = await fixture();
    const developer = await f.dispatch();
    await f.runtime.cancel("run-1", "User cancelled");
    // Herdr done is turn completion, never stop proof; a timeout is not proof either.
    let observations = 0;
    f.transport.customWaitHandler = (handle) => { observations += 1; return { ok: true, value: { handle, state: "done", observedAt: new Date().toISOString(), correlationVerified: true } }; };
    for (let tick = 0; tick < CANCEL_STOP_OBSERVATION_LIMIT + 2; tick++) await f.runtime.tick();
    expect(observations).toBe(CANCEL_STOP_OBSERVATION_LIMIT);
    const held = (await f.state()).outbound.find((out: any) => out.message.message_id === developer.message.message_id);
    expect(held.status).toBe("accepted");
    expect(held.lease).toBeDefined();
    expect(held.cancelObservations).toBe(CANCEL_STOP_OBSERVATION_LIMIT);
    expect(f.transport.cancelledHandles).toHaveLength(1);
    const final = await finalNotices(f);
    expect(final).toHaveLength(1);
    expect(final[0].message.payload.headline).toMatch(/^Run cancelled: manual reconciliation required/);
    expect(final[0].message.payload.reason).toContain(held.handle.executionId);
    expect(final[0].message.payload.reason).toContain("Options:");
    expect((await f.ports.engine.getSnapshot("run-1") as any).value.status).toBe("cancelling");
    expect((await f.state()).runs[0].cancelReconciled).toBe(true);
  });

  it("does not remove a worktree while its execution is unconfirmed", async () => {
    const f = await fixture();
    const developer = await f.dispatch();
    const worktree = developer.handle.target.worktreePath as string;
    await f.runtime.cancel("run-1", "User cancelled");
    f.transport.customWaitHandler = (handle) => ({ ok: true, value: { handle, state: "working", observedAt: new Date().toISOString(), correlationVerified: true } });
    for (let tick = 0; tick < CANCEL_STOP_OBSERVATION_LIMIT; tick++) await f.runtime.tick();
    expect(git(f.repository, "worktree", "list", "--porcelain")).toContain(worktree);
    expect((await finalNotices(f))[0].message.payload.reason).toContain(`${worktree}`);
  });
});

describe("cancellation reconciliation: exactly one final notice per run", () => {
  it("never adds a second final notice on repeated ticks or a repeated cancel", async () => {
    const f = await fixture();
    await f.dispatch();
    await f.runtime.cancel("run-1", "User cancelled");
    f.transport.customWaitHandler = (handle) => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    await f.runtime.tick();
    const before = await f.cancelHeadlines();
    for (let tick = 0; tick < 3; tick++) await f.runtime.tick();
    await f.runtime.cancel("run-1", "User cancelled again");
    await f.runtime.tick();
    expect(await f.cancelHeadlines()).toEqual(before);
    expect((await finalNotices(f))).toHaveLength(1);
    expect((await f.cancelHeadlines()).filter(headline => headline.startsWith("Run cancelled: "))).toHaveLength(1);
  });

  it("keeps the interim notice headline honest: reconciliation is in progress, not required", async () => {
    const f = await fixture();
    await f.dispatch();
    await f.runtime.cancel("run-1", "User cancelled");
    const headlines = await f.cancelHeadlines();
    expect(headlines).toEqual(["Run cancelled; stop confirmation and worktree reconciliation are in progress"]);
  });
});


/** Existing single-run contracts also carry each member of a host-owned cancellation batch. */
function cancellation(runId = "run-1", suffix = "1", sessionId = "session-1") {
  const at = new Date().toISOString();
  return RoleMessageSchema.parse({ schema_version: 2, message_id: `cancel-control-${suffix}`, correlation_id: `cancel-correlation-${suffix}`,
    run_id: runId, sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" },
    recipient: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" }, type: "delegation.request",
    payload: { schemaVersion: 2, delegationId: `cancel-delegation-${suffix}`, messageId: `cancel-control-${suffix}`,
      correlationId: `cancel-correlation-${suffix}`, sessionId, runId, requestedBy: "conversation", targetRole: "coordinator",
      title: "Cancel existing run", objective: "User requested cancellation", specificationId: "cancel-spec", sddLevel: "lightweight",
      acceptanceCriteria: [{ id: "ac-cancel", description: "Cancel", category: "functional", verificationMethod: "manual_review", required: true,
        status: "pending", evidenceArtifactIds: [] }], inputArtifacts: [], priority: "critical", requestedAt: at, idempotencyKey: `cancel-control-${suffix}`,
      metadata: { action: "cancel", targetRunId: runId, cancellationRequest: { schemaVersion: 1, cancellationId: `cancel-${suffix}`, runId,
        requestedBy: "conversation", requestedAt: at, expectedVersion: 1, reason: "User requested cancellation", idempotencyKey: `cancel-control-${suffix}` } } },
    artifact_references: [], occurred_at: at, idempotency_key: `cancel-control-${suffix}` });
}

describe("trusted cancellation control bypasses work dispatch waits", () => {
  it("recovers a queued cancellation after restart despite unknown native delivery and a new busy Coordinator binding", async () => {
    const f = await fixture();
    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    const message = cancellation();
    await journal.exclusive(async (state, save) => {
      state.outbound.push({ message, status: "queued", selector: "coordinator", taskId: "legacy-cancel", attemptId: "legacy-cancel", capabilities: [] });
      state.runs[0]!.nativeDeliveries = [{ operationId: "unknown-mutation", message: RoleMessageSchema.parse({ schema_version: 2,
        message_id: "native-unknown", correlation_id: "correlation-1", run_id: "run-1", sender: { role: "coordinator" },
        recipient: { role: "specifier" }, type: "task.status", payload: { action: "unknown" }, artifact_references: [], idempotency_key: "native-unknown" }) }];
      state.outbound.find(out => out.message.message_id === message.message_id)!.error = "Unknown native delivery must be reconciled before another work dispatch";
      await save();
    });
    f.panes.bindings.find(p => p.role === "coordinator")!.session = { source: "test", kind: "id", value: "new-generation" };
    f.panes.busy.add("coordinator");
    const restarted = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });
    await restarted.tick();
    const state = await restarted.inspect() as any;
    expect(state.runs[0]).toMatchObject({ cancelled: true, status: "cancelled" });
    expect(state.runs[0].nativeDeliveries).toHaveLength(1);
    expect(state.outbound.find((out: any) => out.message.message_id === message.message_id)).toMatchObject({ status: "delivered" });
    expect(state.inbox.some((item: any) => item.message.message_id === message.message_id)).toBe(false);
    expect(f.transport.sentRequests.some(request => request.context && (request.context as any).message_id === message.message_id)).toBe(false);
    const final = state.outbound.find((out: any) => out.message.message_id === finalNoticeId);
    expect(final.message.payload.headline).toContain("manual reconciliation required");
    expect(final.message.payload.reason).toContain("unknown-mutation");
    await restarted.queueHerdr(message); await restarted.tick();
    expect((await restarted.inspect() as any).outbound.filter((out: any) => out.message.message_id === finalNoticeId)).toHaveLength(1);
  });

  it.each(["completed", "failed"])("safely ignores cancellation of an already %s run", async status => {
    const f = await fixture(); const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async (state, save) => { state.runs[0]!.status = status as "completed" | "failed"; await save(); });
    const message = cancellation(); await f.runtime.queueHerdr(message); await f.runtime.flushOutbound();
    expect((await f.state()).runs[0]).toMatchObject({ status, cancelled: false });
    expect((await f.state()).outbound.find((out: any) => out.message.message_id === message.message_id).status).toBe("delivered");
    expect(f.transport.cancelledHandles).toHaveLength(0);
  });

  it("rejects foreign-session cancellation at enqueue and isolates a foreign control recovered from an older journal", async () => {
    const f = await fixture(); const foreign = cancellation("run-1", "foreign", "other-session");
    await expect(f.runtime.queueHerdr(foreign)).rejects.toThrow("Foreign cancellation");
    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async (state, save) => {
      state.outbound.push({ message: foreign, status: "queued", selector: "coordinator", taskId: "foreign", attemptId: "foreign", capabilities: [] });
      await save();
    });
    await f.runtime.flushOutbound();
    const state = await f.state();
    expect(state.runs[0].cancelled).toBe(false);
    expect(state.outbound.find((out: any) => out.message.message_id === foreign.message_id)).toMatchObject({ status: "failed", error: expect.stringContaining("Foreign cancellation") });
    expect(f.transport.sentRequests.some(request => (request.context as any)?.message_id === foreign.message_id)).toBe(false);
  });

  it("closes pending user decisions before reconciliation and refuses late approvals without resuming a specialist", async () => {
    const f = await fixture(); const developer = await f.dispatch();
    const binding = f.panes.bindings.find(p => p.role === "developer")!;
    const receipt = await f.runtime.requestUserDecision(binding, "developer", { runId: "run-1", taskId: "implement", question: "Continue?", options: ["Yes", "No"] }) as any;
    const request = (await f.state()).runs[0].userDecisions[receipt.approvalId].request;
    const late = RoleMessageSchema.parse({ schema_version: 2, message_id: "late-answer", correlation_id: "correlation-1", run_id: "run-1",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "approval.decision", payload: { schemaVersion: 2,
        approvalId: request.approvalId, runId: request.runId, sessionId: request.sessionId, target: request.target, revision: request.revision,
        generation: request.generation, decision: "approved", decidedBy: "human-1", decidedAt: new Date().toISOString(), feedbackArtifacts: [],
        idempotencyKey: "late-answer", metadata: { selectedOption: "Yes" } }, artifact_references: [], idempotency_key: "late-answer" });
    await f.runtime.queueHerdr(late);
    await f.runtime.queueHerdr(cancellation());
    expect((await f.state()).runs[0].userDecisions[receipt.approvalId].status).toBe("cancelled");
    f.panes.busy.add("coordinator"); await f.runtime.flushOutbound();
    const state = await f.state();
    expect(state.runs[0].userDecisions[receipt.approvalId].status).toBe("cancelled");
    expect(await f.runtime.pendingApprovals({ sessionId: "session-1" })).toEqual([]);
    expect(state.outbound.find((out: any) => out.message.message_id === "late-answer").status).toBe("cancelled");
    expect(state.outbound.filter((out: any) => out.message.type === "approval.request" && out.status === "queued")).toHaveLength(0);
    await expect(f.runtime.queueHerdr({ ...late, message_id: "new-late-answer", idempotency_key: "new-late-answer" })).rejects.toThrow("approval is no longer actionable");
    await expect(f.runtime.receiveHerdr(late)).rejects.toThrow("Run is cancelled");
    expect(f.transport.cancelledHandles).toHaveLength(1);
    expect(f.transport.cancelledHandles[0].executionId).toBe(developer.handle.executionId);
    expect(state.outbound.some((out: any) => out.message.payload.kind === "user_decision_answer")).toBe(false);
  });

  it("processes later run cancellations when one member fails, preserving the partial failure and uncertain interrupt receipt", async () => {
    const f = await fixture(); await f.dispatch();
    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async (state, save) => {
      const original = state.runs[0]!;
      state.runs.push({ ...structuredClone(original), runId: "run-2", coreCreated: false, tasks: [], status: "intake",
        delegation: { ...original.delegation, runId: "run-2", correlationId: "correlation-2", messageId: "intake-2", delegationId: "delegation-2", idempotencyKey: "intake-2" } });
      await save();
    });
    f.ports.policies.git.cancelTask = async () => { throw new Error("Injected worktree cancellation failure"); };
    await f.runtime.queueHerdr(cancellation()); await f.runtime.queueHerdr(cancellation("run-2", "2"));
    await f.runtime.tick();
    const state = await f.state();
    expect(state.runs.map((run: any) => [run.runId, run.cancelled])).toEqual([["run-1", true], ["run-2", true]]);
    expect(state.outbound.find((out: any) => out.message.message_id === "cancel-control-1")).toMatchObject({ status: "failed", error: expect.stringContaining("Injected worktree") });
    expect(state.outbound.find((out: any) => out.message.message_id === "cancel-control-2").status).toBe("delivered");
    expect(f.transport.cancelledHandles).toHaveLength(1);
    for (let tick = 0; tick < CANCEL_STOP_OBSERVATION_LIMIT + 1; tick++) await f.runtime.tick();
    const notices = await finalNotices(f);
    expect(notices[0].message.payload.headline).toContain("manual reconciliation required");
    expect(notices[0].message.payload.reason).toContain("Injected worktree");
    expect(f.transport.cancelledHandles).toHaveLength(1);
    f.ports.policies.git.cancelTask = async () => undefined;
    await f.runtime.queueHerdr(cancellation("run-1", "retry"));
    const recovered = await f.state();
    expect(recovered.outbound.find((out: any) => out.message.message_id === "cancel-control-1").status).toBe("delivered");
    expect(recovered.outbound.some((out: any) => out.message.payload.headline === "Cancellation cleanup retry completed")).toBe(true);
    expect(f.transport.cancelledHandles).toHaveLength(1);
  });


  it("cancels while a Reviewer gate is awaiting its result, without waiting for the scheduler tick", async () => {
    const f = await fixture();
    const gate = f.runtime.herdrQualityGate("review");
    const waiting = gate.evaluate({ runId: "run-1", taskId: "review-task", attemptId: "review-attempt", artifacts: [], input: {},
      definition: { id: "review", name: "review", evaluator: "review", required: true, configuration: { role: "reviewer" },
        timeout: { executionTimeoutMs: 20_000, onTimeout: "block" } } });
    const failed = expect(waiting).rejects.toThrow("Run cancellation requested");
    await expect.poll(async () => (await f.state()).outbound.some((out: any) => out.message.type === "verification.requested" && out.status === "accepted"), { timeout: 10_000 }).toBe(true);
    await f.runtime.queueHerdr(cancellation());
    await failed;
    expect((await f.state()).runs[0].cancelled).toBe(true);
    expect(f.transport.cancelledHandles).toHaveLength(1);
  });

  it("fences old queued intake and Coordinator wakes even when cancellation was already reconciled", async () => {
    const f = await fixture(); const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    const initial = (await f.state()).inbox.find((item: any) => item.message.message_id === "intake-1").message;
    await journal.exclusive(async (state, save) => {
      state.runs[0]!.cancelled = true; state.runs[0]!.status = "cancelled"; state.runs[0]!.cancelReconciled = true;
      state.outbound.push({ message: initial, status: "queued", selector: "coordinator", taskId: "old-intake", attemptId: "old-intake", capabilities: [] });
      state.outbound.push({ message: RoleMessageSchema.parse({ ...initial, message_id: "old-wake", idempotency_key: "old-wake", type: "task.status",
        sender: { role: "runtime" }, payload: { kind: "specialist_result_ready" } }), status: "queued", selector: "coordinator", taskId: "old-wake", attemptId: "old-wake", capabilities: [] });
      await save();
    });
    await f.runtime.flushOutbound();
    const state = await f.state();
    expect(state.outbound.find((out: any) => out.message.message_id === "intake-1").status).toBe("cancelled");
    expect(state.outbound.find((out: any) => out.message.message_id === "old-wake").status).toBe("cancelled");
    expect(f.transport.sentRequests).toHaveLength(0);
  });


  it("consumes a proven queued old request after binding restart but retains uncertain cancellation delivery", async () => {
    const f = await fixture(); const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    const queued = cancellation("run-1", "pinned"), uncertain = cancellation("run-1", "uncertain");
    const request = (message: typeof queued) => AgentRequestSchema.parse({ requestId: `request-${message.message_id}`, attemptId: `attempt-${message.message_id}`,
      runId: "run-1", taskId: `message-${message.message_id}`, role: "coordinator", target: { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator",
        workspaceId: "workspace-1", tabId: "tab-1", session: { source: "test", kind: "id", value: "old-generation" } },
      instruction: JSON.stringify(message), workingDirectory: "/tmp", inputs: [], context: message, attempt: 1,
      retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false }, timeout: { executionTimeoutMs: 300_000, onTimeout: "block" },
      idempotency: { key: message.idempotency_key, scope: "agent-request", fingerprint: digest(message) }, createdAt: message.occurred_at });
    await journal.exclusive(async (state, save) => {
      for (const [message, status] of [[queued, "queued"], [uncertain, "unknown_delivery"]] as const)
        state.outbound.push({ message, status, selector: "coordinator", taskId: `message-${message.message_id}`, attemptId: `attempt-${message.message_id}`,
          capabilities: [], request: request(message) });
      await save();
    });
    f.panes.bindings.find(p => p.role === "coordinator")!.session = { source: "test", kind: "id", value: "new-generation" };
    f.panes.busy.add("coordinator");
    await f.runtime.flushOutbound();
    const state = await f.state();
    expect(state.runs[0].cancelled).toBe(true);
    expect(state.outbound.find((out: any) => out.message.message_id === queued.message_id)).toMatchObject({ status: "delivered", request: request(queued) });
    expect(state.outbound.find((out: any) => out.message.message_id === uncertain.message_id)).toMatchObject({ status: "unknown_delivery", request: request(uncertain) });
    expect(f.transport.sentRequests).toHaveLength(0);
    expect(f.transport.reconciledRequests).toHaveLength(0);
    await f.runtime.tick();
    const final = (await finalNotices(f))[0];
    expect(final.message.payload.headline).toContain("manual reconciliation required");
    expect(final.message.payload.reason).toContain(uncertain.message_id);
  });


  it("keeps reconciling later cancellations when one run's retained integration cannot be read", async () => {
    const f = await fixture(); const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async (state, save) => {
      const original = state.runs[0]!;
      state.runs.push({ ...structuredClone(original), runId: "run-2", delegation: { ...original.delegation, runId: "run-2",
        correlationId: "correlation-2", messageId: "intake-2", delegationId: "delegation-2", idempotencyKey: "intake-2" } });
      original.integrationKey = "missing-integration";
      await save();
    });
    f.ports.policies.git.cancelIntegration = async () => { throw new Error("Integration cleanup unavailable"); };
    f.ports.policies.git.getIntegration = async () => { throw new Error("Integration record unavailable"); };
    await f.runtime.queueHerdr(cancellation()); await f.runtime.queueHerdr(cancellation("run-2", "2"));
    await f.runtime.tick();
    const state = await f.state();
    expect(state.runs[0]).toMatchObject({ cancelled: true, status: "cancelled" });
    expect(state.runs[0].cancelReconciled).not.toBe(true);
    expect(state.runs[1]).toMatchObject({ cancelled: true, status: "cancelled", cancelReconciled: true });
    expect(state.outbound.some((out: any) => out.message.payload.reason?.includes("Integration record unavailable"))).toBe(true);
  });


  it("releases a persisted safely queued Coordinator lease so another run can acquire the role", async () => {
    const f = await fixture(); const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    unwrap(await f.ports.registry.upsert({ agentId: "coordinator", role: "coordinator", transport: "herdr", enabled: true,
      priority: 0, maxConcurrentTasks: 1, capabilities: ["coordination", "repository.read"], settings: {} }));
    const lease = unwrap(await f.ports.registry.acquireLease({ leaseId: "queued-coordinator-lease", agentId: "coordinator", runId: "run-1",
      taskId: "old-intake", attemptId: "old-intake", ttlMs: 300_000, requestedAt: new Date().toISOString(), idempotencyKey: "acquire-queued" }));
    const initial = (await f.state()).inbox.find((item: any) => item.message.message_id === "intake-1").message;
    await journal.exclusive(async (state, save) => {
      state.outbound.push({ message: initial, status: "queued", selector: "coordinator", taskId: "old-intake", attemptId: "old-intake", capabilities: [], lease });
      await save();
    });
    const unavailable = await f.ports.registry.acquireLease({ leaseId: "next-coordinator-before", agentId: "coordinator", runId: "run-2",
      taskId: "next-intake", attemptId: "next-intake", ttlMs: 300_000, requestedAt: new Date().toISOString(), idempotencyKey: "acquire-next-before" });
    expect(unavailable.ok).toBe(false);
    await f.runtime.queueHerdr(cancellation());
    const old = (await f.state()).outbound.find((out: any) => out.message.message_id === "intake-1");
    expect(old.status).toBe("released");
    expect(old.leaseRelease).toBeUndefined();
    const next = await f.ports.registry.acquireLease({ leaseId: "next-coordinator-after", agentId: "coordinator", runId: "run-2",
      taskId: "next-intake", attemptId: "next-intake", ttlMs: 300_000, requestedAt: new Date().toISOString(), idempotencyKey: "acquire-next-after" });
    expect(next.ok).toBe(true);
    expect(f.transport.sentRequests).toHaveLength(0);
  });

  it("retains an authenticated legacy cleanup failure across restart and never claims fully stopped", async () => {
    const f = await fixture(); const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async (state, save) => { state.runs[0]!.integrationKey = "retained-integration"; await save(); });
    let calls = 0;
    f.ports.policies.git.cancelIntegration = async () => { calls++; throw new Error("Injected legacy cleanup failure"); };
    f.ports.policies.git.getIntegration = async () => ({ worktreePath: "/tmp/retained-integration" }) as any;
    const message = cancellation("run-1", "legacy");
    await expect(f.runtime.receiveHerdr(message)).rejects.toThrow("Injected legacy cleanup failure");
    let state = await f.state();
    expect(state.runs[0]).toMatchObject({ cancelled: true, status: "cancelled" });
    expect(state.inbox.find((entry: any) => entry.message.message_id === message.message_id)).toMatchObject({ status: "received",
      reason: expect.stringContaining("Injected legacy cleanup failure"), message });
    const restarted = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });
    await restarted.tick();
    expect(calls).toBe(2);
    state = await restarted.inspect() as any;
    expect(state.inbox.find((entry: any) => entry.message.message_id === message.message_id).status).toBe("received");
    const final = state.outbound.find((out: any) => out.message.message_id === finalNoticeId);
    expect(final.message.payload.headline).toContain("manual reconciliation required");
    expect(final.message.payload.reason).toContain("Injected legacy cleanup failure");
    expect(f.transport.sentRequests).toHaveLength(0);
    expect(f.transport.cancelledHandles).toHaveLength(0);
    expect(state.outbound.some((out: any) => out.message.message_id === message.message_id)).toBe(false);
  });


  it.each(["done", "uncorrelated_idle"])("retains a cancelled specialist lease when pane health is ready but stop observation is %s", async observation => {
    const f = await fixture();
    const waiting = f.runtime.herdrQualityGate("review").evaluate({ runId: "run-1", taskId: "review-task", attemptId: "review-attempt", artifacts: [], input: {},
      definition: { id: "review", name: "review", evaluator: "review", required: true, configuration: { role: "reviewer" },
        timeout: { executionTimeoutMs: 20_000, onTimeout: "block" } } });
    const failed = expect(waiting).rejects.toThrow("Run cancellation requested");
    await expect.poll(async () => (await f.state()).outbound.some((out: any) => out.message.type === "verification.requested" && out.status === "accepted"), { timeout: 10_000 }).toBe(true);
    const before = (await f.state()).outbound.find((out: any) => out.message.type === "verification.requested");
    await f.runtime.queueHerdr(cancellation()); await failed;
    // The same pane now reports idle for a replacement native session. This is not stop proof for the old execution.
    f.panes.bindings.find(p => p.role === "reviewer")!.session = { source: "test", kind: "id", value: "replacement-reviewer" };
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: observation === "done" ? "done" : "idle",
      correlationVerified: observation === "done", observedAt: new Date().toISOString() } });
    await f.runtime.tick();
    let state = await f.state();
    expect(state.outbound.find((out: any) => out.message.message_id === before.message.message_id)).toMatchObject({ status: "accepted", handle: before.handle });
    for (let tick = 1; tick < CANCEL_STOP_OBSERVATION_LIMIT; tick++) await f.runtime.tick();
    state = await f.state();
    expect(state.outbound.find((out: any) => out.message.message_id === before.message.message_id)).toMatchObject({ status: "accepted", cancelObservations: CANCEL_STOP_OBSERVATION_LIMIT });
    expect((await finalNotices(f))[0].message.payload.headline).toContain("manual reconciliation required");
    expect(f.transport.cancelledHandles).toHaveLength(1);
  });

});

// An explicit operator observation must recover historical cancelReconciled=true reports without re-dispatching work.
describe("explicit cancellation recovery", () => {
  async function exhausted() {
    const f = await fixture(); const developer = await f.dispatch();
    await f.runtime.cancel("run-1", "User cancelled");
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "done", observedAt: new Date().toISOString(), correlationVerified: false } });
    for (let n = 0; n < CANCEL_STOP_OBSERVATION_LIMIT; n++) await f.runtime.tick();
    expect((await f.state()).runs[0].cancelReconciled).toBe(true);
    return { ...f, developer };
  }
  it("reobserves an exhausted cancellation, releases its writer, and preserves the worktree without sending or interrupting again", async () => {
    const f = await exhausted(); const sent = f.transport.sentRequests.length;
    f.transport.customWaitHandler = (handle, options) => {
      expect(options?.until).not.toContain("cancelled");
      return { ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } };
    };
    const report = await (f.runtime as any).reconcileCancellation("run-1");
    expect(report).toMatchObject({ runId: "run-1", fullyStopped: true, blockers: [] });
    expect(f.panes.releases).toEqual([{ taskId: "run-1-implement", closePane: false, removeWorktree: false }]);
    expect(git(f.repository, "worktree", "list", "--porcelain")).toContain(f.developer.handle.target.worktreePath);
    expect((await f.ports.engine.getSnapshot("run-1") as any).value.status).toBe("cancelled");
    expect(f.transport.sentRequests).toHaveLength(sent);
    expect(f.transport.cancelledHandles).toHaveLength(1);
    const after = (await f.state()).outbound.find((o: any) => o.message.message_id === f.developer.message.message_id);
    expect(after.cancellationStopProof).toBeDefined();
    expect(after.status).toBe("released");
    const restarted = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });
    expect(await (restarted as any).reconcileCancellation("run-1")).toMatchObject({ fullyStopped: true });
    expect(f.panes.releases).toHaveLength(1);
  });
  it("does not release on uncorrelated idle or on a different execution and does not reset the automatic observation budget", async () => {
    const f = await exhausted();
    for (const foreign of [false, true]) {
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle: foreign ? { ...handle, executionId: "foreign-execution" } : handle,
        state: "idle", observedAt: new Date().toISOString(), correlationVerified: foreign } });
      expect(await (f.runtime as any).reconcileCancellation("run-1")).toMatchObject({ fullyStopped: false });
    }
    expect(f.panes.releases).toHaveLength(0);
    const after = (await f.state()).outbound.find((o: any) => o.message.message_id === f.developer.message.message_id);
    expect(after).toMatchObject({ status: "accepted", cancelObservations: CANCEL_STOP_OBSERVATION_LIMIT });
    expect(after.cancellationStopProof).toBeUndefined();
  });
  it("retains dirty work and reports writer cleanup as blocked even after a proven stop", async () => {
    const f = await exhausted();
    await writeFile(join(f.developer.handle.target.worktreePath, "guide.md"), "unhanded documentation\n");
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    const report = await (f.runtime as any).reconcileCancellation("run-1");
    expect(report.fullyStopped).toBe(false);
    expect(report.blockers.join(" ")).toContain("uncommitted");
    expect(f.panes.releases).toHaveLength(0);
    expect(git(f.developer.handle.target.worktreePath, "diff")).toContain("unhanded documentation");
    expect((await f.ports.engine.getSnapshot("run-1") as any).value.status).toBe("cancelling");
  });
  it("settles an expired grant without claiming a Registry release receipt", async () => {
    const f = await exhausted(); f.advance(360_000);
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    expect(await f.runtime.reconcileCancellation("run-1")).toMatchObject({ fullyStopped: true });
    const after = (await f.state()).outbound.find((o: any) => o.message.message_id === f.developer.message.message_id);
    expect(after).toMatchObject({ status: "released", cancellationLeaseDisposition: "expired" });
    const registry = JSON.parse(await readFile(join(f.root, "registry.json"), "utf8"));
    expect(registry.receipts[`release:${after.lease.leaseId}:${after.lease.version}`]).toBeUndefined();
    const reports = (await f.state()).outbound.filter((o: any) => String(o.message.payload.headline).includes("fully stopped"));
    expect(reports.at(-1).message.payload.headline).toContain("0 lease(s) released, 1 lease(s) expired without a release receipt");
  });
  it("does not reinterpret stale Registry state as an expired or released grant", async () => {
    const f = await exhausted(); f.advance(360_000);
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    f.ports.registry.releaseLease = async () => ({ ok: false, error: { code: "conflict", retryable: false, message: "Stale fencing token or lease version" } });
    const report = await f.runtime.reconcileCancellation("run-1");
    expect(report.fullyStopped).toBe(false);
    expect(report.blockers.join(" ")).toContain("Stale fencing token");
    const out = (await f.state()).outbound.find((o: any) => o.message.message_id === f.developer.message.message_id);
    expect(out.status).toBe("accepted"); expect(out.cancellationLeaseDisposition).toBeUndefined();
  });
  it("persists stop proof before failed writer cleanup and retries after restart without a second interrupt", async () => {
    const f = await exhausted(); const release = f.panes.releaseDeveloper.bind(f.panes);
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    f.panes.releaseDeveloper = async () => ({ ok: false, error: { code: "conflict", retryable: false, message: "temporary cleanup failure" } });
    expect(await f.runtime.reconcileCancellation("run-1")).toMatchObject({ fullyStopped: false });
    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async state => {
      expect(state.version).toBe(6);
      const pending = state.outbound.find(o => o.message.message_id === f.developer.message.message_id)!;
      expect(pending.cancellationStopProof?.handle).toEqual(pending.handle);
    });
    f.panes.releaseDeveloper = release;
    const restarted = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });
    expect(await restarted.reconcileCancellation("run-1")).toMatchObject({ fullyStopped: true });
    expect(f.transport.cancelledHandles).toHaveLength(1);
  });
  it("refuses malformed stop observations and a replacement Developer binding", async () => {
    const f = await exhausted();
    for (const change of [{ correlationVerified: "yes" }, { observedAt: "2000-01-01T00:00:00Z" }]) {
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true, ...change } } as any);
      expect(await f.runtime.reconcileCancellation("run-1")).toMatchObject({ fullyStopped: false });
      const out = (await f.state()).outbound.find((o: any) => o.message.message_id === f.developer.message.message_id);
      expect(out.cancellationStopProof).toBeUndefined();
    }
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    f.panes.bindings.find(p => p.role === "developer")!.session = { source: "test", kind: "id", value: "replacement" };
    expect((await f.runtime.reconcileCancellation("run-1")).blockers.join(" ")).toContain("binding was replaced");
    expect(f.panes.releases).toHaveLength(0);
  });
  it("rejects a v6 stop receipt in a downgraded journal and refuses a receipt for another handle", async () => {
    const f = await exhausted();
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    await f.runtime.reconcileCancellation("run-1");
    const path = join(f.root, "journal/state.json"), raw = JSON.parse(await readFile(path, "utf8"));
    raw.version = 5; await writeFile(path, JSON.stringify(raw));
    await expect(new AgenticJournal(join(f.root, "journal"), f.repository).exclusive(async () => {})).rejects.toThrow("Invalid cancellation stop proof");
    raw.version = 6;
    raw.outbound.find((out: any) => out.message.message_id === f.developer.message.message_id).cancellationStopProof.handle.executionId = "foreign";
    await writeFile(path, JSON.stringify(raw));
    await expect(new AgenticJournal(join(f.root, "journal"), f.repository).exclusive(async () => {})).rejects.toThrow("Invalid cancellation stop proof");
  });
  it("retains the Developer allocation while a native mutation still has unknown delivery", async () => {
    const f = await exhausted();
    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async (state, save) => {
      state.runs[0]!.nativeDeliveries = [{ operationId: "pending-native-wake", message: RoleMessageSchema.parse({ schema_version: 2,
        message_id: "pending-wake", correlation_id: "correlation-1", run_id: "run-1", sender: { role: "coordinator" },
        recipient: { role: "developer", pane_id: f.developer.handle.target.paneId }, type: "task.status", payload: { action: "pending" },
        artifact_references: [], idempotency_key: "pending-wake" }) }]; await save();
    });
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    expect(await f.runtime.reconcileCancellation("run-1")).toMatchObject({ fullyStopped: false });
    expect(f.panes.releases).toHaveLength(0);
    expect((await f.state()).outbound.find((o: any) => o.message.message_id === f.developer.message.message_id).status).toBe("accepted");
  });
  it("does not alter another escalated run or its exhausted resume budget", async () => {
    const f = await exhausted();
    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async (state, save) => {
      state.runs.push({ runId: "run-2", delegation: { ...state.runs[0]!.delegation, runId: "run-2" }, status: "escalated", tasks: [],
        coreCreated: false, cancelled: false, maxIterations: 3, error: "predecessor writer still active",
        pendingAction: { actionId: `next-${digest(["run-2", "old-blocker"])}`, kind: "resume_coordinator", owner: "coordinator",
          reason: "predecessor writer still active", sourceMessageId: "old-blocker", createdAt: f.ports.clock().toISOString(),
          state: "pending", previousStatus: "intake", resumeAttempts: 3, manualResumeAttempts: 0, recovery: "manual" } }); await save();
    });
    const before = (await f.state()).runs[1];
    await f.runtime.reconcileCancellation("run-1");
    expect((await f.state()).runs[1]).toEqual(before);
  });
  it("recovers a crash after saving cancellation intent but before requesting Core cancellation", async () => {
    const f = await fixture(); await f.dispatch();
    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async (state, save) => {
      state.runs[0]!.cancelled = true; state.runs[0]!.status = "cancelled"; state.runs[0]!.cancelReconciled = true; await save();
    });
    expect((await f.ports.engine.getSnapshot("run-1") as any).value.status).toBe("running");
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    const restarted = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });
    expect(await restarted.reconcileCancellation("run-1")).toMatchObject({ fullyStopped: true });
    expect((await f.ports.engine.getSnapshot("run-1") as any).value.status).toBe("cancelled");
    expect(f.transport.cancelledHandles).toHaveLength(0);
  });
  it("rejects reconciliation of a live run", async () => {
    const f = await fixture(); await f.dispatch();
    await expect((f.runtime as any).reconcileCancellation("run-1")).rejects.toThrow(/cancelled/i);
    expect(f.transport.cancelledHandles).toHaveLength(0); expect(f.panes.releases).toHaveLength(0);
  });
});


/** Real process scopes + the existing real Engine/Registry/stores; only the Herdr transport/pane UI remain fake. */
async function futureScopeFixture() {
  const f = await fixture(), bin = join(f.root, "provider-bin"); await mkdir(bin);
  const code = `#!${process.execPath}\nconsole.log('scoped-provider-ready');setInterval(()=>{},1000);\n`;
  const provider = join(bin, "codex"); await writeFile(provider, code, { mode: 0o700 });
  const manager = new DeveloperProcessScopes({ directory: join(f.root, "process-scopes") });
  const allocate = f.panes.allocateDeveloper.bind(f.panes);
  f.panes.allocateDeveloper = async request => {
    const material = await manager.prepare({ runId: request.runId!, taskId: request.taskId, executable: provider,
      executableDigest: createHash("sha256").update(code).digest("hex"), configFiles: [],
      material: { provider: "codex", argv: [], env: { PATH: bin + ":" + process.env.PATH }, launchId: "future-launch", launchFingerprint: "a".repeat(64) } });
    const allocated = await allocate(request);
    allocated.value.metadata = { ...allocated.value.metadata, launchId: material.launchId, launchFingerprint: material.launchFingerprint, processScopeId: material.env.BFLOW_PROCESS_SCOPE_ID };
    const child = spawn(join(material.env.PATH!.split(":")[0]!, "codex"), [], { cwd: request.worktreePath,
      env: { ...process.env, ...material.env }, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Scoped provider exited during fixture startup"); })]);
    return allocated;
  };
  const extra: Partial<import("../../src/agentic/ports.js").AgenticRuntimePorts> = {
    pinDeveloperDispatch: (request, binding) => manager.pinDispatch(request, binding),
    bindDeveloperExecutionScope: (handle, binding) => manager.bindExecution(handle, binding),
    stopDeveloperExecutionScope: (handle, binding) => manager.stop(handle, binding),
    stopUnboundDeveloperScope: binding => manager.stopUnbound(binding)
  };
  Object.assign(f.ports, extra);
  f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: false } });
  return { ...f, manager };
}

describe.skipIf(process.platform !== "linux")("future cancellations use namespace proof instead of Herdr lifecycle hints", () => {
  it.each([false, true])("automatically stops and releases its writer even when its lease expired=%s", async expired => {
    const f = await futureScopeFixture(); const developer = await f.dispatch();
    if (expired) f.advance(360_000);
    await f.runtime.cancel("run-1", "Cancel future scoped run"); await f.runtime.tick();
    const after = (await f.state()).outbound.find((out: any) => out.message.message_id === developer.message.message_id);
    expect(after).toMatchObject({ status: "released", cancellationStopProof: { source: "linux_pid_namespace" },
      cancellationLeaseDisposition: expired ? "expired" : "released" });
    expect(f.panes.releases).toEqual([{ taskId: "run-1-implement", closePane: false, removeWorktree: false }]);
    expect((await f.ports.engine.getSnapshot("run-1") as any).value.status).toBe("cancelled");
    expect(f.transport.cancelledHandles).toHaveLength(0);
  });
  it("stops the namespace while retaining allocation and lease for an uncertain native wake", async () => {
    const f = await futureScopeFixture(); const developer = await f.dispatch();
    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async (state, save) => {
      state.runs[0]!.nativeDeliveries = [{ operationId: "uncertain-wake", message: RoleMessageSchema.parse({ schema_version: 2,
        message_id: "uncertain-wake", correlation_id: "correlation-1", run_id: "run-1", sender: { role: "coordinator" },
        recipient: { role: "developer", pane_id: developer.handle.target.paneId }, type: "task.status", payload: { status: "working" },
        artifact_references: [], idempotency_key: "uncertain-wake" }) }]; await save();
    });
    await f.runtime.cancel("run-1", "Cancel despite lost ACK"); await f.runtime.tick();
    const out = (await f.state()).outbound.find((item: any) => item.message.message_id === developer.message.message_id);
    expect(out.cancellationStopProof.source).toBe("linux_pid_namespace");
    expect(out.status).toBe("accepted"); expect(f.panes.releases).toHaveLength(0);
    expect((await f.ports.engine.getSnapshot("run-1") as any).value.status).toBe("cancelling");
  });
  it("cleans up an allocated Developer that never acquired an execution handle", async () => {
    const f = await futureScopeFixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    await f.panes.allocateDeveloper({ runId: "run-1", taskId: "run-1-implement", worktreePath: f.repository, agentName: "unbound-dev" });
    await f.runtime.cancel("run-1", "Cancel before task dispatch"); await f.runtime.tick();
    const run = (await f.state()).runs[0];
    expect(run.cancelledAllocations).toEqual([expect.objectContaining({ released: true, proof: expect.objectContaining({ source: "linux_pid_namespace" }) })]);
    expect(f.panes.releases).toEqual([{ taskId: "run-1-implement", closePane: false, removeWorktree: false }]);
    expect((await f.state()).outbound.some((out: any) => out.message.type === "task.assignment" && out.handle)).toBe(false);
  });
});

describe("cancellation allocation ownership", () => {
  it("does not select another run by a shared run-id prefix", async () => {
    const f = await fixture(); await f.dispatch();
    const foreign = await f.panes.allocateDeveloper({ runId: "run-1-next", taskId: "run-1-next-implement", worktreePath: f.repository, agentName: "foreign-dev" });
    let stoppedForeign = false;
    Object.assign(f.ports, { stopUnboundDeveloperScope: async () => { stoppedForeign = true; return undefined; } });
    await f.runtime.cancel("run-1", "Only cancel the selected run");
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    await f.runtime.tick();
    expect(stoppedForeign).toBe(false);
    expect(foreign.value.metadata?.allocationStatus).not.toBe("released");
    expect(f.panes.releases.map(request => request.taskId)).toEqual(["run-1-implement"]);
  });
});

describe("cancellation without a supervised process scope", () => {
  it("does not block Core cancellation on an undispatched legacy Developer allocation", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    await f.panes.allocateDeveloper({ runId: "run-1", taskId: "run-1-implement", worktreePath: f.repository, agentName: "legacy-dev" });
    let probed = 0;
    Object.assign(f.ports, { stopUnboundDeveloperScope: async () => { probed++; return undefined; } });
    await f.runtime.cancel("run-1", "Cancel before task dispatch"); await f.runtime.tick();
    expect(probed).toBeGreaterThan(0);
    const report = await f.runtime.reconcileCancellation("run-1");
    expect(report).toMatchObject({ fullyStopped: true, blockers: [] });
    expect(report.retainedWorktrees).toContain(f.repository);
    expect((await f.state()).runs[0].cancelledAllocations).toBeUndefined();
    expect(f.panes.releases).toHaveLength(0);
  });
  it("still sends the transport interrupt when the scoped stop fails", async () => {
    const f = await fixture(); const developer = await f.dispatch();
    Object.assign(f.ports, { stopDeveloperExecutionScope: async () => { throw new Error("scope record mode 0644"); } });
    await f.runtime.cancel("run-1", "Cancel with a broken scope"); await f.runtime.tick();
    expect(f.transport.cancelledHandles).toHaveLength(1);
    const out = (await f.state()).outbound.find((item: any) => item.message.message_id === developer.message.message_id);
    expect(out.cancelRequested).toBe(true);
    expect(out.error).toContain("scope record mode 0644");
  });
  it("releases a proven-stopped Developer although another role's delivery is still uncertain", async () => {
    const f = await fixture(); const developer = await f.dispatch();
    await f.runtime.cancel("run-1", "Cancel with a lost Coordinator ACK");
    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async (state, save) => {
      state.outbound.push({ message: RoleMessageSchema.parse({ schema_version: 2, message_id: "lost-coordinator-ack", correlation_id: "correlation-1",
        run_id: "run-1", sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "task.status", payload: { status: "working" },
        artifact_references: [], idempotency_key: "lost-coordinator-ack" }), status: "unknown_delivery", selector: "coordinator",
        taskId: "coordination", attemptId: "lost-coordinator-ack", capabilities: [],
        request: { ...developer.request, requestId: "lost-coordinator-ack", role: "coordinator", target: { ...developer.request.target, paneId: "coordinator-pane" } } });
      await save();
    });
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    const report = await f.runtime.reconcileCancellation("run-1");
    expect(f.panes.releases).toEqual([{ taskId: "run-1-implement", closePane: false, removeWorktree: false }]);
    expect((await f.state()).outbound.find((item: any) => item.message.message_id === developer.message.message_id).status).toBe("released");
    // The Coordinator delivery itself remains an honest blocker.
    expect(report.fullyStopped).toBe(false);
    expect(report.blockers.join(" ")).toContain("coordinator delivery is uncertain");
  });
});

describe("cancelled resolver cleanup", () => {
  it("settles the resolver's allocation even though it is not a normal Core task", async () => {
    const f = await fixture(); await f.dispatch();
    f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
    await f.runtime.cancel("run-1", "Cancel run"); await f.runtime.tick();
    const binding = unwrap(await f.panes.allocateDeveloper({ runId: "run-1", taskId: "run-1-conflict-task", worktreePath: f.repository, agentName: "resolver" }));
    const handle = { executionId: "resolver-execution", requestId: "resolver-request", attemptId: "resolver-attempt", runId: "run-1", taskId: "conflict-task",
      idempotencyKey: "resolver-message", acceptedAt: new Date().toISOString(), correlation: { token: "resolver-request", provenance: "transport" as const, verified: true },
      target: { transport: "herdr", agentId: binding.agentId, workspaceId: binding.workspaceId, tabId: binding.tabId, paneId: binding.paneId,
        worktreePath: binding.worktreePath!, session: binding.session! } };
    unwrap(await f.ports.registry.upsert({ agentId: binding.agentId, role: "developer", transport: "herdr", enabled: true,
      priority: 0, maxConcurrentTasks: 1, capabilities: ["implementation"], settings: {} }));
    const lease = unwrap(await f.ports.registry.acquireLease({ leaseId: "resolver-lease", agentId: binding.agentId, runId: "run-1", taskId: "conflict-task",
      attemptId: "resolver-attempt", ttlMs: 300000, requestedAt: new Date().toISOString(), idempotencyKey: "resolver-acquire" }));
    const resolverMessage = RoleMessageSchema.parse({ schema_version: 2, message_id: "resolver-message", correlation_id: "correlation-1", run_id: "run-1",
      sender: { role: "coordinator" }, recipient: { role: "developer", agent_id: binding.agentId, pane_id: binding.paneId }, type: "task.assignment",
      payload: { kind: "git_conflict_resolution" }, artifact_references: [], idempotency_key: "resolver-message" });
    const request = AgentRequestSchema.parse({ requestId: handle.requestId, attemptId: handle.attemptId, runId: handle.runId, taskId: handle.taskId,
      role: "developer", target: handle.target, instruction: JSON.stringify(resolverMessage), context: resolverMessage, workingDirectory: f.repository,
      inputs: [], attempt: 1, retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
      timeout: { executionTimeoutMs: 300000, onTimeout: "block" }, idempotency: { key: handle.idempotencyKey, scope: "agent-request", fingerprint: digest(resolverMessage) },
      createdAt: handle.acceptedAt, metadata: { leaseId: lease.leaseId, fencingToken: lease.fencingToken } });
    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    await journal.exclusive(async (state, save) => {
      state.runs[0]!.conflictResolution = { conflictId: "conflict-1", integrationKey: "integration-1", taskKey: "tree-1", conflictPaths: ["guide.md"],
        worktreePath: f.repository, branchName: "main", attempts: [{ taskId: "conflict-task", attemptId: "resolver-attempt", agentName: "resolver",
          messageId: "resolver-message", status: "assigned" }] };
      state.outbound.push({ message: resolverMessage, status: "accepted", selector: binding.agentId, taskId: "conflict-task",
        attemptId: "resolver-attempt", capabilities: ["implementation"], request, lease, handle, cancelRequested: true });
      await save();
    });
    expect(await f.runtime.reconcileCancellation("run-1")).toMatchObject({ fullyStopped: true });
    const run = (await f.state()).runs[0];
    expect(run.conflictResolution.attempts[0]).toMatchObject({ status: "failed", settled: true });
    expect(f.panes.releases.at(-1)).toEqual({ taskId: "run-1-conflict-task", closePane: false, removeWorktree: false });
  });
});
