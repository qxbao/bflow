import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RoleMessageSchema, type PaneBinding, type QualityGate, type Specification } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { AgenticWorkflowRuntime, CANCEL_STOP_OBSERVATION_LIMIT } from "../../src/agentic/runtime.js";
import { digest } from "../../src/agentic/journal.js";
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
    roleCapabilities: { developer: ["implementation"], coordinator: ["coordination"], conversation: ["conversation"], specifier: ["specification"], architect: ["architecture"], planner: ["planning"], reviewer: ["review"], qa: ["verification"], tester: ["testing"] },
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
