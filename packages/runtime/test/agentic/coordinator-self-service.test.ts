import { chmod, mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalDecisionSchema, RoleMessageSchema, type PaneBinding, type QualityGate, type Specification } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { AgenticWorkflowRuntime, CANCEL_STOP_OBSERVATION_LIMIT } from "../../src/agentic/runtime.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { createExecutionResolutionReader, readExecutionRepositorySnapshot } from "../../src/agentic/execution-binding.js";
import { runRepositorySetup, RepositorySetupInputSchema } from "../../src/agentic/repository-setup.js";
import { detectTestRunners } from "../../src/agentic/runner-detection.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
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
  closes: { taskId: string; paneId: string }[] = [];
  async closeCancelledDeveloper(request: { taskId: string; paneId: string }) {
    this.closes.push(request);
    this.bindings = this.bindings.filter(pane => pane.paneId !== request.paneId);
    return { ok: true as const, value: undefined };
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
async function fixture(options: { humanApproval?: boolean; watch?: boolean } = {}) {
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
    authorizeHuman: async (decision: { decidedBy: string }) => decision.decidedBy === "human-1",
    projectApprovalRequired: () => options.humanApproval === true } as any;
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

const tools = (f: Fixture) => new CoordinatorTools(f.runtime);
const setup = (f: Fixture, input: Record<string, unknown>) => tools(f).invoke("repository_setup", { runId: "run-1", ...input }, { role: "coordinator" }) as Promise<any>;
const run = async (f: Fixture, runId = "run-1") => (await f.state()).runs.find((item: any) => item.runId === runId);
const conversationNotices = async (f: Fixture) => (await f.state()).outbound.filter((out: any) => out.message.recipient.role === "conversation");
const coordinatorWakes = async (f: Fixture, kind: string) => (await f.state()).outbound.filter((out: any) => out.message.recipient.role === "coordinator" && out.message.payload.kind === kind);
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The host's real reader: repository plus one owner-configured input. */
async function watch(f: Fixture) {
  const configPath = join(f.root, "owner-config.json");
  await writeFile(configPath, JSON.stringify({ model: "configured" }));
  const repository = await readExecutionRepositorySnapshot(f.repository);
  f.ports.readExecutionResolution = await createExecutionResolutionReader({ schemaVersion: 3, repositoryRoot: f.repository,
    files: [{ component: "owner-config", path: configPath, format: "json" }],
    plan: { schemaVersion: 3, resolverVersion: "1", policyVersion: "1", repository, mode: "intake" } });
  return configPath;
}
const commitOnMain = (f: Fixture, message = "moved") => { git(f.repository, "commit", "--allow-empty", "-m", message); return git(f.repository, "rev-parse", "HEAD"); };
/** A second Conversation handoff for another run, queued the way production queues it. */
function newRunHandoff(f: Fixture, runId: string) {
  const time = new Date().toISOString();
  const delegation = { schemaVersion: 2, delegationId: `delegation-${runId}`, messageId: `intake-${runId}`, correlationId: `correlation-${runId}`, sessionId: "session-1", runId,
    requestedBy: "conversation", targetRole: "coordinator", title: f.spec.title, objective: f.spec.summary, specificationId: `${f.spec.specId}-${runId}`, sddLevel: f.spec.level,
    acceptanceCriteria: f.spec.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: time, idempotencyKey: `intake-${runId}` };
  return RoleMessageSchema.parse({ schema_version: 2, message_id: `intake-${runId}`, correlation_id: `correlation-${runId}`, run_id: runId,
    sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" }, recipient: { role: "coordinator" },
    type: "delegation.request", payload: delegation, artifact_references: [], occurred_at: time, idempotency_key: `intake-${runId}` });
}
const fromConversation = (type: string, payload: unknown, id: string) => RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: "correlation-1", run_id: "run-1",
  sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" }, recipient: { role: "coordinator" }, type, payload,
  artifact_references: [], occurred_at: new Date().toISOString(), idempotency_key: id });
const decision = (approval: any, decidedBy: string, extra: Record<string, unknown> = {}) => ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: approval.approvalId, runId: "run-1", sessionId: "session-1",
  target: approval.target, revision: approval.revision, generation: approval.generation, decision: "approved", decidedBy, decidedAt: new Date().toISOString(),
  feedbackArtifacts: [], idempotencyKey: `decision-${approval.approvalId}-${decidedBy}`, ...extra });
const coordinatorBinding = (f: Fixture) => f.panes.bindings.find(pane => pane.role === "coordinator")!;
const askUser = (f: Fixture) => f.runtime.requestUserDecision(coordinatorBinding(f), "coordinator", { runId: "run-1", taskId: "implement", question: "A or B?", options: ["A", "B"] });

/** A fake npm on PATH: records its argv and does what the real command would do to the repository, with no network. */
async function fakeNpm(root: string): Promise<string> {
  const bin = join(root, "fake-bin"); await mkdir(bin);
  const log = join(root, "npm-calls.log");
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$1" = init ]; then echo '{"name":"x","version":"1.0.0"}' > package.json; fi\nif [ "$1" = install ]; then echo '{"name":"x","version":"1.0.0","devDependencies":{"vitest":"2.0.0"}}' > package.json; echo '{}' > package-lock.json; mkdir -p node_modules/vitest; fi\n`);
  await chmod(join(bin, "npm"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  cleanups.push(async () => { vi.unstubAllEnvs(); });
  return log;
}

describe("acceptance 1: Coordinator sets up an empty repository itself and proposes", () => {
  it("runs the allowlisted setup on an unborn repository through to a commit", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-setup-empty-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, "repo"); await mkdir(repository); git(repository, "init", "-b", "main");
    const log = await fakeNpm(root);
    const step = (input: unknown) => runRepositorySetup(repository, RepositorySetupInputSchema.parse(input), "run-1");
    expect(await step({ operation: "git_log" })).toMatchObject({ output: "" });
    await step({ operation: "npm_init" });
    await step({ operation: "npm_install_dev", packages: ["vitest@2.0.0"] });
    await step({ operation: "gitignore_add", patterns: ["dist/"] });
    await step({ operation: "create_directories", paths: ["src/lib", "test"] });
    await step({ operation: "git_add", paths: ["package.json", "package-lock.json", ".gitignore", "src/lib/.gitkeep", "test/.gitkeep"] });
    const committed = await step({ operation: "git_commit", message: "chore: set up test runner" }) as any;
    expect(committed.head).toBe(git(repository, "rev-parse", "HEAD"));
    expect(git(repository, "log", "-1", "--format=%B")).toContain("Bflow-Run: run-1");
    expect(await readFile(join(repository, ".gitignore"), "utf8")).toBe("node_modules/\ndist/\n");
    expect(git(repository, "status", "--porcelain")).toBe("");
    expect(await readFile(log, "utf8")).toContain("--ignore-scripts");
  });
  it("sets up, commits and proposes in one run with no user command, on the new HEAD, with every change logged", async () => {
    const f = await fixture(); await watch(f); await fakeNpm(f.root);
    await setup(f, { operation: "npm_init" });
    await setup(f, { operation: "npm_install_dev", packages: ["vitest"] });
    await setup(f, { operation: "create_directories", paths: ["test"] });
    await setup(f, { operation: "git_add", paths: ["package.json", "package-lock.json", ".gitignore", "test/.gitkeep"] });
    const { head } = await setup(f, { operation: "git_commit", message: "chore: setup" });
    await f.dispatch();
    const current = await run(f);
    expect(current.baseRevision).toBe(head);
    expect(current.executionPlanDrift).toBeUndefined();
    expect(current.repositorySetupLog.map((item: any) => [item.operation, item.status])).toEqual([["npm_init", "completed"], ["npm_install_dev", "completed"],
      ["create_directories", "completed"], ["git_add", "completed"], ["git_commit", "completed"]]);
    expect(current.repositorySetupLog.at(-1).head).toBe(head);
  });
  it("records a failed operation against the run and surfaces the error", async () => {
    const f = await fixture();
    await expect(setup(f, { operation: "git_commit", message: "nothing staged" })).rejects.toThrow("Nothing is staged");
    expect((await run(f)).repositorySetupLog).toMatchObject([{ operation: "git_commit", status: "failed", error: expect.stringContaining("Nothing is staged") }]);
  });
  it("withdraws a pending proposal, re-proposes on the new HEAD, and the user is told which card replaced which", async () => {
    const f = await fixture({ humanApproval: true }); await watch(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    const first = await run(f);
    await tools(f).invoke("withdraw_workflow_proposal", { runId: "run-1", reason: "setup first" }, { role: "coordinator" });
    const head = commitOnMain(f, "setup");
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    const second = await run(f);
    expect(second.baseRevision).toBe(head);
    expect(second.status).toBe("awaiting_approval");
    expect(second.approval.approvalId).not.toBe(first.approval.approvalId);
    const replaced = (await conversationNotices(f)).find((out: any) => out.message.payload.kind === "approval_replaced");
    expect(replaced.message.payload).toMatchObject({ approvalIds: [first.approval.approvalId], replacedByApprovalId: second.approval.approvalId });
    const old = fromConversation("approval.decision", decision(first.approval, "human-1"), "late-answer");
    await expect(f.runtime.receiveHerdr(old)).rejects.toThrow(second.approval.approvalId);
  });
});

describe("repository_setup stays allowlisted", () => {
  it.each([
    [{ operation: "git_add", paths: [".git/hooks/pre-commit"] }, "not permitted"],
    [{ operation: "git_add", paths: [".bflow/config.yml"] }, "not permitted"],
    [{ operation: "git_add", paths: [".env"] }, "not permitted"],
    [{ operation: "git_add", paths: ["."] }, "not permitted"],
    [{ operation: "git_add", paths: ["../outside"] }, "not permitted"],
    [{ operation: "create_directories", paths: ["/tmp/outside"] }, "not permitted"],
    [{ operation: "create_directories", paths: [".git/x"] }, "not permitted"]
  ])("refuses %j", async (input, message) => {
    const f = await fixture();
    await expect(setup(f, input)).rejects.toThrow(message);
  });
  it.each([
    [{ operation: "npm_install_dev", packages: ["https://evil.test/x.tgz"] }],
    [{ operation: "npm_install_dev", packages: ["../local"] }],
    [{ operation: "npm_install_dev", packages: ["--global"] }],
    [{ operation: "npm_install_dev", packages: ["git+ssh://x"] }],
    [{ operation: "gitignore_add", patterns: ["*"] }],
    [{ operation: "gitignore_add", patterns: ["a\nb"] }],
    [{ operation: "rm_rf", paths: ["src"] }],
    [{ operation: "git_status", command: "rm -rf /" }]
  ])("rejects %j at validation with nothing logged", async input => {
    const f = await fixture();
    await expect(setup(f, input)).rejects.toThrow();
    expect((await run(f)).repositorySetupLog).toBeUndefined();
  });
  it("runs no repository hook on commit and does not follow a symlinked directory", async () => {
    const f = await fixture();
    const marker = join(f.root, "hook-ran");
    await writeFile(join(f.repository, ".git/hooks/pre-commit"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await writeFile(join(f.repository, "new.txt"), "x");
    await setup(f, { operation: "git_add", paths: ["new.txt"] });
    await setup(f, { operation: "git_commit", message: "no hooks" });
    await expect(stat(marker)).rejects.toThrow();
    await symlink(f.root, join(f.repository, "link"));
    await expect(setup(f, { operation: "create_directories", paths: ["link/escaped"] })).rejects.toThrow("symlink");
  });
  it("is refused once Developer work has started, and while another run has Developer work", async () => {
    const f = await fixture(); await f.dispatch();
    await expect(setup(f, { operation: "gitignore_add", patterns: ["x/"] })).rejects.toThrow("before implementation starts");
    await f.runtime.receiveHerdr(newRunHandoff(f, "run-2"));
    await expect(tools(f).invoke("repository_setup", { runId: "run-2", operation: "gitignore_add", patterns: ["x/"] }, { role: "coordinator" })).rejects.toThrow("active run run-1");
    expect(await setup(f, { operation: "git_status" })).toMatchObject({ operation: "git_status" });
  });
  it("is refused for every other role", async () => {
    const f = await fixture();
    for (const role of ["developer", "conversation", "reviewer"] as const)
      await expect(tools(f).invoke("repository_setup", { runId: "run-1", operation: "git_status" }, { role })).rejects.toThrow("Only Coordinator");
  });
});

describe("A / acceptance 2: a commit on main during an accepted run", () => {
  it("wakes Coordinator, which re-resolves to the new HEAD with the approval unchanged, and the run continues", async () => {
    const f = await fixture(); await watch(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    const before = await run(f);
    const head = commitOnMain(f);
    await f.runtime.tick();
    const blocked = await run(f);
    expect(blocked).toMatchObject({ status: "escalated", pendingAction: { recovery: "plan_drift_reconcile" } });
    expect(await coordinatorWakes(f, "execution_plan_drift")).toHaveLength(1);
    expect((await tools(f).invoke("reresolve_execution_plan", { runId: "run-1" }, { role: "coordinator" }))).toMatchObject({ rebound: true, unblocked: true, revision: head, status: "implementing" });
    await f.runtime.tick();
    const after = await run(f);
    expect(after).toMatchObject({ status: "implementing", baseRevision: head });
    expect(after.pendingAction).toBeUndefined();
    expect(after.executionPlan.snapshot.accepted.approvalIds).toEqual(before.executionPlan.snapshot.accepted.approvalIds);
    const assignment = (await f.state()).outbound.find((out: any) => out.message.type === "task.assignment");
    expect(assignment.status).toBe("accepted");
    expect(git(assignment.handle.target.worktreePath, "merge-base", "--is-ancestor", head, "HEAD")).toBe("");
  });
  it("makes resume_run actually re-resolve instead of repeating the same drift", async () => {
    const f = await fixture(); await watch(f);
    f.ports.preflightRoleCapabilities = async () => undefined;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    const head = commitOnMain(f); await f.runtime.tick();
    const { pendingAction } = await run(f);
    await f.runtime.resumeBlockedRun("run-1", pendingAction.actionId);
    await f.runtime.tick();
    const after = await run(f);
    expect(after.baseRevision).toBe(head);
    expect(after.status).not.toBe("escalated");
    expect((await f.state()).outbound.find((out: any) => out.message.type === "task.assignment").status).toBe("accepted");
  });
  it("keeps every non-repository input blocked: a changed config cannot be re-resolved by Coordinator or by resume", async () => {
    const f = await fixture(); const configPath = await watch(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    await writeFile(configPath, JSON.stringify({ model: "other" }));
    await f.runtime.tick();
    await expect(f.runtime.reresolveExecutionPlan("run-1")).rejects.toThrow();
    const { pendingAction, status } = await run(f);
    expect(status).toBe("escalated");
    await expect(f.runtime.resumeBlockedRun("run-1", pendingAction.actionId)).rejects.toThrow();
    expect((await run(f)).status).toBe("escalated");
    expect((await f.state()).outbound.some((out: any) => out.message.type === "task.assignment")).toBe(false);
  });
  it("refuses to move the base onto a rewritten or switched branch", async () => {
    const f = await fixture(); await watch(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    const base = (await run(f)).baseRevision;
    git(f.repository, "checkout", "--orphan", "other"); git(f.repository, "commit", "-m", "unrelated");
    await expect(f.runtime.reresolveExecutionPlan("run-1")).rejects.toThrow("does not descend");
    expect((await run(f)).baseRevision).toBe(base);
  });
  it("keeps the base of a run whose Developer work has started, but still clears the drift", async () => {
    const f = await fixture(); await watch(f);
    await f.dispatch();
    const base = (await run(f)).baseRevision;
    commitOnMain(f);
    await expect(f.runtime.reresolveExecutionPlan("run-1")).resolves.toMatchObject({ rebound: true, revision: base });
    expect((await run(f)).baseRevision).toBe(base);
    await f.runtime.tick();
    expect((await run(f)).status).not.toBe("escalated");
  });
});

describe("B: a new run is not blocked by repository drift or by a cancelling run", () => {
  it("delivers a new delegation after a commit on main, with no other run present", async () => {
    const f = await fixture(); await watch(f);
    commitOnMain(f);
    await f.runtime.queueHerdr(newRunHandoff(f, "run-2"));
    await f.runtime.tick();
    const out = (await f.state()).outbound.find((item: any) => item.message.message_id === "intake-run-2");
    expect(out.status).toBe("accepted");
    expect(out.error ?? "").not.toContain("ExecutionPlanDriftError");
  });
  it("delivers a new delegation while an older run is stuck cancelling", async () => {
    const f = await fixture(); await watch(f);
    await f.dispatch();
    await f.runtime.cancel("run-1", "stop");
    commitOnMain(f);
    await f.runtime.queueHerdr(newRunHandoff(f, "run-2"));
    await f.runtime.tick();
    expect((await f.state()).outbound.find((item: any) => item.message.message_id === "intake-run-2").status).toBe("accepted");
  });
  it("still blocks every dispatch when a host input changes", async () => {
    const f = await fixture(); const configPath = await watch(f);
    await writeFile(configPath, JSON.stringify({ model: "other" }));
    await f.runtime.queueHerdr(newRunHandoff(f, "run-2"));
    await f.runtime.tick();
    const out = (await f.state()).outbound.find((item: any) => item.message.message_id === "intake-run-2");
    expect(out.status).toBe("queued");
    expect(out.error).toContain("ExecutionPlanDriftError");
  });
  it("binds a design approval made after the repository moved, instead of refusing it", async () => {
    const f = await fixture({ humanApproval: true }); await watch(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    const { approval } = await run(f);
    await writeFile(join(f.repository, "untracked-note.md"), "local\n");
    await f.runtime.receiveHerdr(fromConversation("approval.decision", decision(approval, "human-1"), "human-approves"));
    expect((await run(f)).executionPlan).toBeDefined();
  });
});

describe("C / acceptance 3: cancelling a run with an idle Developer", () => {
  const idle = (f: Fixture, state = "idle") => { f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state, observedAt: new Date().toISOString(), correlationVerified: false } }); };
  it.each(["idle", "done"])("closes the %s pane after the observation budget and reaches a terminal state, keeping the worktree", async state => {
    const f = await fixture(); const developer = await f.dispatch();
    await f.runtime.cancel("run-1", "stop"); idle(f, state);
    for (let n = 0; n <= CANCEL_STOP_OBSERVATION_LIMIT + 1; n++) await f.runtime.tick();
    expect(f.panes.closes).toEqual([{ taskId: "run-1-implement", paneId: developer.handle.target.paneId }]);
    expect((await f.ports.engine.getSnapshot("run-1")).value.status).toBe("cancelled");
    const after = (await f.state()).outbound.find((o: any) => o.message.message_id === developer.message.message_id);
    expect(after).toMatchObject({ status: "released", cancellationStopProof: { source: "pane_closed" } });
    expect((await run(f)).status).toBe("cancelled");
    expect(git(f.repository, "worktree", "list", "--porcelain")).toContain(developer.handle.target.worktreePath);
    expect((await f.cancelHeadlines()).at(-1)).toContain("fully stopped");
  });
  it("closes the pane at once on an explicit reconcile, and that survives a restart", async () => {
    const f = await fixture(); await f.dispatch();
    await f.runtime.cancel("run-1", "stop"); await f.runtime.tick(); idle(f);
    const report = await tools(f).invoke("reconcile_cancellation", { runId: "run-1" }, { role: "coordinator" });
    expect(report).toMatchObject({ fullyStopped: true, blockers: [] });
    expect(f.panes.closes).toHaveLength(1);
    const restarted = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });
    expect(await restarted.reconcileCancellation("run-1")).toMatchObject({ fullyStopped: true });
    expect(f.panes.closes).toHaveLength(1);
  });
  it("finishes with a dirty worktree and leaves the uncommitted work on disk", async () => {
    const f = await fixture(); const developer = await f.dispatch();
    await f.runtime.cancel("run-1", "stop"); await f.runtime.tick(); idle(f);
    const dirty = join(developer.handle.target.worktreePath, "guide.md");
    await writeFile(dirty, "uncommitted work\n");
    expect(await f.runtime.reconcileCancellation("run-1")).toMatchObject({ fullyStopped: true });
    expect(await readFile(dirty, "utf8")).toBe("uncommitted work\n");
  });
  it("lets a new run start after the old run finished cancelling", async () => {
    const f = await fixture(); await f.dispatch();
    await f.runtime.cancel("run-1", "stop"); await f.runtime.tick(); idle(f);
    await f.runtime.reconcileCancellation("run-1");
    await f.runtime.queueHerdr(newRunHandoff(f, "run-2")); await f.runtime.tick();
    expect((await f.state()).outbound.find((item: any) => item.message.message_id === "intake-run-2").status).toBe("accepted");
  });
  it("never closes a pane that is still working, and says how to get out", async () => {
    const f = await fixture(); await f.dispatch();
    await f.runtime.cancel("run-1", "stop"); await f.runtime.tick(); idle(f, "working");
    const report = await f.runtime.reconcileCancellation("run-1");
    expect(report.fullyStopped).toBe(false);
    expect(f.panes.closes).toHaveLength(0);
    expect(report.blockers.join(";")).toContain("wait until it is idle");
    expect((await conversationNotices(f)).map((out: any) => String(out.message.payload.reason)).join(";")).toContain("--reconcile");
  });
  it("never closes a pane another binding took over", async () => {
    const f = await fixture(); const developer = await f.dispatch();
    await f.runtime.cancel("run-1", "stop"); await f.runtime.tick(); idle(f);
    const pane = f.panes.bindings.find(item => item.paneId === developer.handle.target.paneId)!;
    pane.agentId = "replacement";
    expect((await f.runtime.reconcileCancellation("run-1")).fullyStopped).toBe(false);
    expect(f.panes.closes).toHaveLength(0);
  });
  it("never closes a shared specialist pane and keeps reporting that execution as outstanding", async () => {
    const f = await fixture();
    await f.runtime.requestSpecialist("run-1", "architect", "Review", ["architecture"]);
    await f.runtime.tick();
    await f.runtime.cancel("run-1", "stop"); await f.runtime.tick(); idle(f);
    expect(await f.runtime.reconcileCancellation("run-1")).toMatchObject({ fullyStopped: false });
    expect(f.panes.closes).toHaveLength(0);
    expect((await f.state()).outbound.find((o: any) => o.message.recipient.role === "architect").cancellationStopProof).toBeUndefined();
  });
});

describe("D / acceptance 4: a question stays open while its run is merely paused", () => {
  const escalate = async (f: Fixture) => {
    await watch(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    commitOnMain(f);
    await f.runtime.tick();
    expect((await run(f)).status).toBe("escalated");
  };
  it("keeps a pending card open across the drift escalation and later ticks", async () => {
    const f = await fixture();
    await escalate(f);
    await askUser(f);
    for (let n = 0; n < 3; n++) await f.runtime.tick();
    const [entry] = Object.values((await run(f)).userDecisions) as any[];
    expect(entry.status).toBe("pending");
    expect((await conversationNotices(f)).some((out: any) => out.message.payload.kind === "user_decision_expired")).toBe(false);
  });
  it("accepts the answer while the run is escalated and resumes only the asker", async () => {
    const f = await fixture();
    await escalate(f);
    await askUser(f);
    const [entry] = Object.values((await run(f)).userDecisions) as any[];
    await f.runtime.receiveHerdr(fromConversation("approval.decision", decision(entry.request, "human-1", { metadata: { selectedOption: "A" } }), "answer-1"));
    const current = await run(f);
    expect((Object.values(current.userDecisions)[0] as any).status).toBe("answered");
    expect(current.status).toBe("escalated");
    expect(await coordinatorWakes(f, "user_decision_answer")).toHaveLength(1);
  });
  it("still closes the card when the run really ends", async () => {
    const f = await fixture();
    await askUser(f);
    await f.runtime.cancel("run-1", "stop"); await f.runtime.tick();
    expect((Object.values((await run(f)).userDecisions)[0] as any).status).toBe("cancelled");
  });
  it("names both cards when a requirement revision replaces one, and refuses the old one", async () => {
    const f = await fixture();
    await askUser(f);
    const [oldId] = Object.keys((await run(f)).userDecisions);
    const revised = (await f.state()).runs[0].delegation;
    const time = new Date().toISOString();
    await f.runtime.receiveHerdr(RoleMessageSchema.parse({ schema_version: 2, message_id: "change-2", correlation_id: "correlation-1", run_id: "run-1",
      sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" }, recipient: { role: "coordinator" }, type: "delegation.request",
      payload: { ...revised, delegationId: "delegation-change-2", messageId: "change-2", idempotencyKey: "change-2", requestedAt: time, metadata: { revision: 2, isRequirementChange: true } },
      artifact_references: [], occurred_at: time, idempotency_key: "change-2" }));
    await f.runtime.requestUserDecision(coordinatorBinding(f), "coordinator", { runId: "run-1", taskId: "implement", question: "C or D?", options: ["C", "D"] });
    const newId = Object.keys((await run(f)).userDecisions).find(id => id !== oldId)!;
    const notice = (await conversationNotices(f)).find((out: any) => out.message.payload.kind === "approval_replaced");
    expect(notice.message.payload).toMatchObject({ approvalIds: [oldId], replacedByApprovalId: newId });
  });
});

describe("E: resume matches what the blocked notice tells the user", () => {
  const userTurn = "user-turn-1";
  it("wakes Coordinator for a clarifying run instead of refusing", async () => {
    const f = await fixture();
    await f.runtime.reportProgress("run-1", "Need detail", ["Which file?"]);
    expect((await run(f)).status).toBe("clarifying");
    await expect(f.runtime.resumeIdleRun("run-1", userTurn)).resolves.toMatchObject({ queued: true });
    expect(await coordinatorWakes(f, "user_resume_requested")).toHaveLength(1);
    await f.runtime.resumeIdleRun("run-1", userTurn);
    expect(await coordinatorWakes(f, "user_resume_requested")).toHaveLength(1);
  });
  it("retries the waiting handoff for an intake run", async () => {
    const f = await fixture();
    await f.runtime.queueHerdr(newRunHandoff(f, "run-2"));
    expect((await run(f, "run-2")).status).toBe("intake");
    await expect(f.runtime.resumeIdleRun("run-2", userTurn)).resolves.toMatchObject({ queued: true, retried: ["intake-run-2"] });
    await f.runtime.tick();
    expect((await f.state()).outbound.find((item: any) => item.message.message_id === "intake-run-2").status).toBe("accepted");
  });
  it("sends the user to the open card rather than treating resume as an answer", async () => {
    const f = await fixture({ humanApproval: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    await expect(f.runtime.resumeIdleRun("run-1", userTurn)).rejects.toThrow("answer that card");
    expect((await run(f)).decision).toBeUndefined();
  });
  it("is bounded per run and refuses an ended run", async () => {
    const f = await fixture();
    let refused: unknown;
    for (let n = 0; n < 10 && !refused; n++) {
      await f.runtime.resumeIdleRun("run-1", `turn-${n}`).catch(error => { refused = error; });
      await f.runtime.tick();
      // Each wake must be delivered and answered before the next user turn counts against the budget.
      for (const out of (await coordinatorWakes(f, "user_resume_requested"))) expect(out.status).not.toBe("failed");
    }
    expect(String(refused)).toContain("budget");
    await f.runtime.cancel("run-1", "stop");
    await expect(f.runtime.resumeIdleRun("run-1", "late")).rejects.toThrow("cannot be resumed");
  });
});

describe("F: an answer sent to Coordinator wakes it", () => {
  const clarification = fromConversation("conversation.clarification", { answer: "use file a" }, "clar-1");
  it("wakes Coordinator with the answer, once", async () => {
    const f = await fixture();
    await expect(f.runtime.receiveHerdr(clarification)).resolves.toMatchObject({ accepted: true });
    await expect(f.runtime.receiveHerdr(clarification)).resolves.toMatchObject({ duplicate: true });
    const wakes = await coordinatorWakes(f, "conversation_context_ready");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].message.payload).toMatchObject({ messageType: "conversation.clarification", result: { answer: "use file a" } });
  });
  it("creates no workflow for run-less dialogue and does not reopen an ended run", async () => {
    const f = await fixture();
    const runless = RoleMessageSchema.parse({ ...clarification, run_id: undefined, message_id: "clar-2", idempotency_key: "clar-2" });
    await expect(f.runtime.receiveHerdr(runless)).resolves.toMatchObject({ workflowCreated: false });
    await f.runtime.cancel("run-1", "stop");
    await expect(f.runtime.receiveHerdr(RoleMessageSchema.parse({ ...clarification, message_id: "clar-3", idempotency_key: "clar-3" }))).resolves.toMatchObject({ workflowCreated: false });
    expect(await coordinatorWakes(f, "conversation_context_ready")).toHaveLength(0);
  });
});

describe("acceptance 5: Coordinator cannot approve anything", () => {
  it("refuses a Coordinator-sent approval, a Conversation envelope decided by Coordinator, and any approve tool", async () => {
    const f = await fixture({ humanApproval: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    const { approval } = await run(f);
    const fromCoordinator = RoleMessageSchema.parse({ ...fromConversation("approval.decision", decision(approval, "human-1"), "self-1"), sender: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" }, recipient: { role: "runtime" } });
    await expect(f.runtime.receiveHerdr(fromCoordinator)).rejects.toThrow();
    await expect(f.runtime.receiveHerdr(fromConversation("approval.decision", decision(approval, "coordinator"), "self-2"))).rejects.toThrow(/not authenticated/i);
    for (const name of ["approve", "approve_design", "record_approval", "answer_user_decision"])
      await expect(tools(f).invoke(name, { runId: "run-1", approvalId: approval.approvalId }, { role: "coordinator" })).rejects.toThrow("Unknown Coordinator tool");
    const current = await run(f);
    expect(current.status).toBe("awaiting_approval");
    expect(current.decision).toBeUndefined();
    expect((await f.state()).outbound.some((out: any) => out.message.type === "task.assignment")).toBe(false);
  });
  it("cannot get past the human gate through setup, withdraw, re-propose or re-resolve", async () => {
    const f = await fixture({ humanApproval: true }); await watch(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    await tools(f).invoke("reresolve_execution_plan", { runId: "run-1" }, { role: "coordinator" });
    await tools(f).invoke("withdraw_workflow_proposal", { runId: "run-1", reason: "setup" }, { role: "coordinator" });
    await setup(f, { operation: "gitignore_add", patterns: ["dist/"] });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    await f.runtime.tick();
    const current = await run(f);
    expect(current).toMatchObject({ status: "awaiting_approval", approvalKind: "design" });
    expect(current.decision).toBeUndefined();
    expect(current.executionPlan).toBeUndefined();
    expect((await f.state()).outbound.some((out: any) => out.message.type === "task.assignment")).toBe(false);
  });
  it("cannot answer its own user decision", async () => {
    const f = await fixture();
    await askUser(f);
    const [entry] = Object.values((await run(f)).userDecisions) as any[];
    await expect(f.runtime.receiveHerdr(fromConversation("approval.decision", decision(entry.request, "coordinator", { metadata: { selectedOption: "A" } }), "self-3"))).rejects.toThrow(/not authenticated/i);
    expect((Object.values((await run(f)).userDecisions)[0] as any).status).toBe("pending");
  });
  it("cannot withdraw an accepted design", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    await expect(f.runtime.withdrawWorkflowProposal("run-1", "again")).rejects.toThrow("still awaiting its approval");
  });
});

describe("G: Developer worktrees have no node_modules, and Runtime measures anyway", () => {
  it("resolves checks against the repository's dependencies, so a worktree without node_modules is measurable", async () => {
    const f = await fixture();
    await writeFile(join(f.repository, ".gitignore"), "node_modules/\n");
    await writeFile(join(f.repository, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", devDependencies: { vitest: "2.1.9" } }));
    await mkdir(join(f.repository, "node_modules/vitest"), { recursive: true });
    await writeFile(join(f.repository, "node_modules/vitest/package.json"), JSON.stringify({ name: "vitest", version: "2.1.9" }));
    await writeFile(join(f.repository, "node_modules/vitest/vitest.mjs"), "");
    const detection = await detectTestRunners(f.repository, { nodeExecutable: process.execPath });
    if (detection.status !== "detected") throw new Error(JSON.stringify(detection));
    git(f.repository, "add", ".gitignore", "package.json"); git(f.repository, "commit", "-m", "runner");
    const developer = await f.dispatch();
    await expect(stat(join(developer.handle.target.worktreePath, "node_modules"))).rejects.toThrow();
    for (const profile of detection.profiles.filter(item => item.reporter === "vitest_json"))
      expect(profile).toMatchObject({ dependencySource: f.repository, checkoutDependencyRoots: ["node_modules"] });
  });
  it("tells the Developer not to treat a failing native vitest as a blocker", async () => {
    const prompt = await readFile(new URL("../../../../agents/developer/system-prompt.md", import.meta.url), "utf8");
    expect(prompt).toContain("A task worktree has no `node_modules`");
    expect(prompt).toContain("`check_work`");
  });
});

describe("card replacement notice as the user reads it", () => {
  it("names the old and new cards by their #n aliases", async () => {
    const f = await fixture({ humanApproval: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    await f.runtime.withdrawWorkflowProposal("run-1", "setup first");
    await f.runtime.proposeWorkflow("run-1", f.spec, f.definition);
    const receipts = new HostReceiptJournal(join(f.root, "host-receipts"), f.repository, "session-1");
    for (const out of await conversationNotices(f)) await receipts.appendConversationNotice(out.message);
    const aliases = Object.keys((await receipts.noticeAliases()).approvalShortIds);
    expect(aliases).toHaveLength(2);
    const notices = await (receipts as any).allConversationNotices();
    const notice = notices.find((item: any) => String(item.summary ?? "").includes("approval_replaced"));
    expect(notice.summary).toContain(`Thẻ ${aliases[0]} đã được thay bằng thẻ ${aliases[1]}`);
  });
});
