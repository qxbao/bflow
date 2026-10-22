import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
  async allocateDeveloper(request: { taskId: string; worktreePath: string; agentName: string }) {
    const old = this.bindings.find(p => p.agentId === request.agentName); if (old) return { ok: true as const, value: old };
    const p = { ...this.bindings[0]!, bindingId: request.agentName, role: "developer" as const, agentId: request.agentName,
      paneId: `pane-${request.agentName}`, cwd: request.worktreePath, worktreePath: request.worktreePath, readOnlyWorkspace: false };
    this.bindings.push(p); return { ok: true as const, value: p };
  }
  async releaseDeveloper() { return { ok: true as const, value: undefined }; }
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
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });
  const checks = ["review", "regression"].map(id => ({ id, name: id, evaluator: id, required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" }, configuration: {} })) as any;
  const gates: QualityGate[] = checks.map((check: { id: string }) => ({ id: check.id, evaluate: async () => { throw new Error("Quality gates are not evaluated by cancellation scenarios"); } }));
  const conversationInbox: unknown[] = [];
  const ports = { engine, runStore: store, artifactStore: artifacts, registry, transport, panes, policies: undefined as unknown as Awaited<ReturnType<typeof loadAgenticPolicies>>,
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
  return { root, repository, runtime, ports, transport, panes, dispatch,
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
