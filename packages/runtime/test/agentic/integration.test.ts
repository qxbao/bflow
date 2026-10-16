import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentResultSchema, ApprovalDecisionSchema, RoleMessageSchema, VerificationResultSchema,
  type PaneBinding, type Specification, type QualityGate, type QualityGateContext } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { createSignedBindingReceipt } from "../../src/agentic/receipt-host.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { loadAgenticPolicies, type PanePolicy } from "../../src/agentic/ports.js";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" } }).trim();

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

async function fixture(options: { parallel?: boolean; tdd?: boolean; complex?: boolean; failReview?: boolean; conflict?: boolean; intake?: boolean; remoteReview?: boolean; humanApproval?: boolean } = {}) {
  const root = await mkdtemp("/tmp/bflow-p19-");
  const repository = join(root, "repo"); await mkdir(repository); git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test"); git(repository, "config", "user.email", "test@example.test");
  await writeFile(join(repository, "guide.md"), "initial\n");
  await writeFile(join(repository, "other.md"), "initial\n");
  git(repository, "add", "."); git(repository, "commit", "-m", "baseline");
  let store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "p19" }));
  cleanups.push(async () => { store.close(); artifacts.close(); await rm(root, { recursive: true, force: true }); });
  const transport = new FakeAgentTransport(); const panes = new Panes();
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const bindingReceiptKeys = { "native-test-host": publicKey };
  const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys });
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });
  let failReview = options.failReview ?? false;
  let reviewerExecutorId = "independent-test-host";
  const calls: QualityGateContext[] = [];
  const checks = [
    { id: "review", name: "review", evaluator: "review", required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" },
      configuration: { kind: "review", method: "manual_review", criterionIds: ["ac-1"], testNames: ["ac-1: The requested outcome is independently verifiable"], role: "reviewer", levels: [] } },
    { id: "regression", name: "regression", evaluator: "regression", required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" },
      configuration: { kind: "deterministic", method: "integration_test", command: "test-regression", criterionIds: options.tdd ? ["ac-1"] : [], testNames: options.tdd ? ["ac-1: The requested outcome is independently verifiable"] : [], role: "tester", levels: ["integration"] } }
  ] as any;
  if (options.complex) checks.push({ id: "static", name: "static", evaluator: "static", required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" },
    configuration: { kind: "deterministic", method: "static_analysis", command: "static-check", criterionIds: [], testNames: [], role: "tester", levels: [] } });
  const gates: QualityGate[] = checks.map((check: any) => ({ id: check.id, evaluate: async context => {
    calls.push(context); const config = context.definition.configuration as any; const input = context.input as any;
    const passed = !(failReview && config.role === "reviewer");
    return { ok: true, value: { gateId: context.definition.id, runId: context.runId, taskId: context.taskId!,
      evaluationId: randomUUID(), status: passed ? "passed" : "failed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString(),
      metadata: { verification: { schemaVersion: 2, checkId: check.id, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
        sourceRevision: input.sourceRevision, specFingerprint: input.specFingerprint, scope: input.scope,
        independentExecution: true, isolated: true, executorId: config.role === "reviewer" ? reviewerExecutorId : "independent-test-host", role: config.role, method: config.method,
        ...(config.command ? { command: config.command, exitCode: passed ? 0 : 1 } : {}), testNames: config.testNames,
        criteria: config.criterionIds.map((criterionId: string) => ({ criterionId, passed, summary: "Host independently checked the criterion" })), summary: "Independent check" } } } };
  } }));
  let runtime: AgenticWorkflowRuntime;
  const actualGates = options.remoteReview ? gates.map(gate => gate.id === "review" ? { id: gate.id,
    evaluate: (...args: Parameters<QualityGate["evaluate"]>) => runtime.herdrQualityGate(gate.id).evaluate(...args) } : gate) : gates;
  const policies = await loadAgenticPolicies({ repositoryPath: repository, artifactStore: artifacts, gates: actualGates,
    loadSpecification: id => runtime.loadSpecification(id), authorizeApprover: decision => ["coordinator", "human-1"].includes(decision.decidedBy) });
  const ports = { engine, runStore: store, artifactStore: artifacts, registry, transport, panes, policies,
    roleCapabilities: { developer: ["implementation"], coordinator: ["coordination"], conversation: ["conversation"], specifier: ["specification"], architect: ["architecture"], planner: ["planning"], reviewer: ["review"], qa: ["verification"], tester: ["testing"] },
    taskChecks: checks, workflowChecks: checks,
    authenticateMessage: async () => true, authenticateResult: async () => true, authenticateEvidence: async () => true,
    authenticateGateResult: async () => true, authorizeHuman: async (decision: any) => decision.decidedBy === "human-1",
    projectApprovalRequired: () => options.humanApproval === true };
  const runtimeOptions = { journalDirectory: join(root, "journal"), repositoryPath: repository };
  runtime = new AgenticWorkflowRuntime(ports, runtimeOptions);
  const spec: Specification = draft(options.complex ? "api" : "documentation");
  const time = new Date().toISOString(); spec.createdAt = time; spec.updatedAt = time;
  spec.affectedPaths = ["guide.md", ...(options.parallel ? ["other.md"] : [])];
  spec.traceabilityTaskIds = options.parallel ? ["implement", "other"] : ["implement"];
  if (options.complex) { (spec.metadata!.sdd as any).assessment.modules = ["one", "two"]; }
  const sdd = spec.metadata!.sdd as any; sdd.traceability[0].taskIds = spec.traceabilityTaskIds;
  spec.metadata!.conditionalTdd = { policyVersion: 1, taskId: "implement", taskType: options.tdd ? "domain_logic" : "documentation",
    changeImpact: { surfaces: [options.tdd ? "domain_logic" : "documentation"], behaviorChanged: !!options.tdd, deterministic: !!options.tdd,
      regressionReproducible: !!options.tdd, securitySensitive: false, dataMigration: false, scope: "local" },
    infrastructure: { readiness: "ready", commands: [{ method: "integration_test", command: "test-regression", level: "integration" }, ...(options.complex ? [{ method: "static_analysis", command: "static-check" }] : [])] },
    testability: { level: "automated", rationale: "Independent repeatable behavioral checks are available" }, riskClassification: "low",
    conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] } };
  if (options.tdd) spec.acceptanceCriteria[0]!.verificationMethod = "integration_test";
  if (options.complex) {
    const strategy = policies.strategy.resolve(spec);
    spec.testStrategy = strategy; spec.tddDecision = strategy.tddDecision;
  } else { delete spec.testStrategy; delete spec.tddDecision; }
  const def = workflow(spec.traceabilityTaskIds); def.maxConcurrency = options.parallel ? 2 : 1;
  def.tasks.forEach((task, index) => { (task as any).metadata = { ownedPaths: [index && !options.conflict ? "other.md" : "guide.md"] }; });
  const delegation = { schemaVersion: 2, delegationId: "delegation-1", messageId: "intake-1", correlationId: "correlation-1", sessionId: "session-1", runId: "run-1",
    requestedBy: "conversation", targetRole: "coordinator", title: spec.title, objective: spec.summary, specificationId: spec.specId, sddLevel: spec.level,
    acceptanceCriteria: spec.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: time, idempotencyKey: "intake-1" };
  const envelope = (type: string, payload: unknown, extra: any = {}) => RoleMessageSchema.parse({ schema_version: 2, message_id: randomUUID(), correlation_id: "correlation-1", run_id: "run-1",
    sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" }, recipient: { role: "coordinator" }, type, payload, artifact_references: [], idempotency_key: randomUUID(), ...extra });
  if (options.intake !== false) await runtime.receiveHerdr(envelope("delegation.request", delegation, { message_id: "intake-1", idempotency_key: "intake-1" }));
  const inspect = async () => await runtime.inspect("run-1") as any;
  const dossier = async () => { const value = await inspect(); return value.tasks[0].spec; };
  async function evidence(taskId: string, phase: "red" | "green" | "refactor" | "verification" = "verification") {
    const run = await inspect(); const task = run.tasks.find((t: any) => t.taskId === taskId); const strategy = task.spec.strategy;
    const startedAt = new Date().toISOString(); const bytes = Buffer.from(`${taskId}-${phase}-${randomUUID()}`);
    const ref = unwrap(await artifacts.put({ options: { artifactId: randomUUID(), runId: "run-1", taskId, kind: "test-result", mediaType: "text/plain",
      expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length }, idempotencyKey: randomUUID() }, content: (async function* () { yield bytes; })() }));
    const red = phase === "red"; const method = spec.acceptanceCriteria[0]!.verificationMethod;
    const sourceRevision = red ? "base-source" : "implementation-source";
    const result = VerificationResultSchema.parse({ schemaVersion: 2, verificationId: randomUUID(), runId: "run-1", taskId,
      cycleNumber: 1, attemptId: randomUUID(), status: red ? "failed" : "passed", independentExecution: true,
      evaluatedCriteria: [{ criterionId: "ac-1", passed: !red, evidenceArtifactId: ref.artifactId, summary: "Observed target behavior", ...(method === "integration_test" ? { command: "test-regression", exitCode: red ? 1 : 0 } : {}) }],
      qualityGateResults: [], evidenceArtifacts: [ref], findings: [], verifiedBy: "tester", startedAt, completedAt: new Date().toISOString(),
      metadata: { conditionalTdd: { phase, decisionId: strategy.tddDecision.decisionId, specId: strategy.specId,
        sourceRevision, testRevision: "unchanged-tests", testNames: strategy.criterionMappings[0].testNames,
        ...(red ? { failureKind: "target_behavior" } : {}), observations: [{ method, criterionId: "ac-1", evidenceArtifactId: ref.artifactId,
          summary: "Independent observation", ...(method === "integration_test" ? { command: "test-regression", exitCode: red ? 1 : 0 } : {}) }] } } });
    await runtime.receiveHerdr(envelope("verification.result", result, { sender: { role: "tester" } }));
  }
  async function submit(taskId = "implement", content = "updated\n") {
    const state = await runtime.inspect() as any;
    const outbound = [...state.outbound].reverse().find((out: any) => out.taskId === taskId && out.message.type === "task.assignment");
    const handle = outbound.handle; expect(handle).toBeDefined();
    const path = handle.target.worktreePath; const file = taskId === "other" && !options.conflict ? "other.md" : "guide.md";
    await writeFile(join(path, file), content); git(path, "add", file); git(path, "commit", "-m", "implement");
    const result = AgentResultSchema.parse({ requestId: handle.requestId, attemptId: handle.attemptId, runId: "run-1", taskId,
      executionId: handle.executionId, status: "succeeded", verification: { status: "verified", evidence: "Authenticated test-host result", correlation:
        unwrap(await ports.engine.getSnapshot("run-1"))!.tasks.find(task => task.taskId === taskId)!.bindingVerification?.receipt.correlation ?? handle.correlation },
      artifactProposals: [], retryable: false, startedAt: handle.acceptedAt, completedAt: new Date().toISOString() });
    await runtime.receiveHerdr(envelope("implementation.submitted", result, { causation_id: outbound.message.message_id,
      sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId } }));
  }
  async function approve(decision = "approved") {
    const run = await inspect(); const request = run.approval;
    await runtime.receiveHerdr(envelope("approval.decision", ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId,
      runId: "run-1", sessionId: "session-1", target: request.target, revision: request.revision, generation: request.generation,
      decision, ...(decision !== "approved" ? { reason: "User refused" } : {}), decidedBy: "human-1", decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: randomUUID() })));
  }
  return { root, repository, runtime, ports, privateKey, publicKey, runtimeOptions, panes, transport, spec, def, envelope, inspect, dossier, evidence, submit, approve,
    calls, localReview: (context: QualityGateContext) => gates.find(gate => gate.id === "review")!.evaluate(context), setFailReview: (value: boolean) => { failReview = value; },
    setReviewerExecutor: (value: string) => { reviewerExecutorId = value; },
    reopenStorage: () => { store.close(); store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") })); ports.runStore = store; },
    restart: () => { runtime = new AgenticWorkflowRuntime({ ...ports, engine: new DeterministicWorkflowEngine({ bindingReceiptKeys }) }, runtimeOptions); return runtime; } };
}

describe("P19 integrated Agentic SDLC", () => {
  it("conversation-only creates no workflow", async () => {
    const f = await fixture();
    const before = await f.runtime.inspect() as any;
    await f.runtime.receiveHerdr(f.envelope("conversation.intake", { content: "hello" }, { run_id: undefined }));
    expect((await f.runtime.inspect() as any).runs).toHaveLength(before.runs.length);
    expect(unwrap(await f.ports.runStore.get("run-1"))).toBeNull();
  });
  it("runs a small workflow without Architect through real policies/Git/storage and delivery approval", async () => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    expect((await f.inspect()).status).toBe("implementing");
    await f.runtime.tick(); await f.evidence("implement"); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
    const run = await f.inspect();
    expect(run.tasks[0].cycle.status).toBe("passed");
    expect(run.workflowCycle?.status).toBe("passed"); expect(run.status).toBe("awaiting_approval");
    await f.approve(); expect((await f.inspect()).status).toBe("completed");
    expect(f.transport.sentRequests.some(request => request.role === "architect")).toBe(false);
    expect(f.calls.some(ctx => (ctx.input as any).scope === "workflow")).toBe(true);
    expect(git(f.repository, "branch", "--show-current")).toBe("main");
  });
  it("complex work requires Design Approval and can be rejected before dispatch", async () => {
    const f = await fixture({ complex: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    expect((await f.inspect()).status).toBe("awaiting_approval");
    await f.runtime.tick(); expect(f.transport.sentRequests.some(request => request.role === "developer")).toBe(false);
    await f.approve("rejected"); expect((await f.inspect()).status).toBe("failed");
  });
  it("dispatches two independent Developers with different leased panes/worktrees", async () => {
    const f = await fixture({ parallel: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const requests = f.transport.sentRequests.filter(req => req.role === "developer");
    expect(requests).toHaveLength(2); expect(new Set(requests.map(req => req.target.worktreePath)).size).toBe(2);
    expect(new Set(requests.map(req => req.target.paneId)).size).toBe(2);
  });
  it("required TDD blocks implementation authorization until independent Red and rejects missing Green/Refactor", async () => {
    const f = await fixture({ tdd: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    expect((await f.dossier()).strategy.tddDecision.mode).toBe("required");
    await expect(f.runtime.authorizeImplementation("run-1", "implement")).rejects.toThrow("Red evidence");
    await f.evidence("implement", "red"); expect(await f.runtime.authorizeImplementation("run-1", "implement")).toMatchObject({ authorized: true });
    await f.evidence("implement", "green"); await f.evidence("implement", "refactor");
    await f.submit(); await f.runtime.tick(); expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
  });
  it("Reviewer repair uses a fresh bounded Core attempt and verified Git change", async () => {
    const f = await fixture({ failReview: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit(); await f.runtime.tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("rework_required");
    expect((await f.inspect()).error).toBeUndefined();
    f.setFailReview(false); await f.runtime.tick(); await f.submit("implement", "repaired\n"); await f.runtime.tick();
    expect((await f.inspect()).error).toBeUndefined();
    expect((await f.inspect()).tasks[0].cycle.history.map((r: any) => r.status)).toEqual(["failed", "passed"]);
  });
  it("rejects a repair Developer as Reviewer even when the original plan predates that identity", async () => {
    const f = await fixture({ failReview: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit(); await f.runtime.tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("rework_required");
    f.setFailReview(false); await f.runtime.tick();
    const state = await f.runtime.inspect() as any;
    const repaired = [...state.outbound].reverse().find((out: any) => out.message.type === "task.assignment");
    f.setReviewerExecutor(repaired.handle.target.agentId);
    await f.submit("implement", "repaired\n"); await f.runtime.tick();
    const run = await f.inspect();
    expect(run.status).toBe("escalated");
    expect(run.tasks[0].cycle.status).toBe("rework_required");
    expect(run.error).toContain("implementer");
  });
  it("escalates at verification limit and never sends another Developer assignment", async () => {
    const f = await fixture({ failReview: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def, 1); await f.runtime.tick();
    await f.evidence("implement"); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
    expect((await f.inspect()).status).toBe("escalated");
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
  });
  it("busy Conversation does not block Developer dispatch; progress survives restart", async () => {
    const f = await fixture(); f.panes.busy.add("conversation"); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    expect(f.transport.sentRequests.filter(req => req.role === "conversation")).toHaveLength(0);
    expect(f.transport.sentRequests.some(req => req.role === "developer")).toBe(true);
    f.panes.busy.delete("conversation"); const restarted = f.restart(); await restarted.tick();
    expect(f.transport.sentRequests.some(req => req.role === "conversation")).toBe(true);
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
  });
  it("unknown_delivery remains durable across restart and never automatically resends", async () => {
    const f = await fixture(); f.transport.customSendHandler = req => ({ ok: false, error: { code: "timeout", retryable: true, message: "lost ACK" } });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick(); const count = f.transport.sentRequests.length;
    await f.restart().tick(); expect(f.transport.sentRequests).toHaveLength(count);
    expect((await f.runtime.inspect() as any).outbound.some((out: any) => out.status === "unknown_delivery")).toBe(true);
  });
  it("restores an exact trusted Gateway approval after reopen without resending uncertain delivery", async () => {
    const f = await fixture({ humanApproval: true });
    const receiptDirectory = join(f.root, "host-receipts");
    let receipts = new HostReceiptJournal(receiptDirectory, f.repository, "session-1");
    f.ports.authorizeHuman = decision => receipts.authenticateHuman(decision);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const manifest = unwrap(await f.panes.getManifest()), binding = f.panes.bindings.find(pane => pane.role === "conversation")!;
    const contextDirectory = join(f.root, "conversation");
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest, contextDirectory,
      onHumanDecision: decision => receipts.recordHuman(decision, { origin: "UserPromptSubmit", binding, nativeSessionId: binding.session!.value,
        conversationSessionId: "session-1", userId: "human-1", messageId: "physical-user-turn", promptDigest: createHash("sha256").update("approve").digest("hex") }) });
    const approval = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "approval.request").message;
    await chat.receiveHerdr({ ...approval, sender: { role: "coordinator", agent_id: "coordinator" }, recipient: { role: "conversation" } });
    const response = await chat.handleUserTurn({ sessionId: "session-1", messageId: "physical-user-turn", content: "approve",
      provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: binding.paneId, channel: "herdr_attach" } }) as any;
    expect(response.ok).toBe(true); expect(response.value.approvalDecision).toBeDefined();
    const decision = response.value.approvalDecision;
    f.transport.customSendHandler = () => ({ ok: false, error: { code: "timeout", retryable: true, message: "lost ACK" } });
    await f.runtime.flushOutbound();
    const count = f.transport.sentRequests.length;
    const original = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "approval.decision");
    expect(original.status).toBe("unknown_delivery");
    receipts = new HostReceiptJournal(receiptDirectory, f.repository, "session-1");
    f.reopenStorage(); const restarted = f.restart();
    const recovered = await receipts.humanDecisions(); expect(recovered).toEqual([decision]);
    await createAgenticConversationHost({ runtime: restarted, manifest, contextDirectory, recoveredHumanDecisions: recovered });
    await restarted.flushOutbound();
    expect(f.transport.sentRequests).toHaveLength(count);
    const pending = (await restarted.inspect() as any).outbound.filter((out: any) => out.message.type === "approval.decision");
    expect(pending).toHaveLength(1); expect(pending[0]).toEqual(original);
    await expect(restarted.receiveHerdr(f.envelope("approval.decision", { ...decision, revision: decision.revision + 1 }))).rejects.toThrow("mismatched");
    await expect(restarted.receiveHerdr(f.envelope("approval.decision", { ...decision, reason: "model replaced user feedback" }))).rejects.toThrow("not authenticated");
    await restarted.receiveHerdr(original.message);
    expect((await restarted.inspect("run-1") as any).status).toBe("implementing");
  });
  it("recovers a trusted approval when the host dies before outbox and Gateway context writes", async () => {
    const f = await fixture({ humanApproval: true });
    let receipts = new HostReceiptJournal(join(f.root, "host-receipts"), f.repository, "session-1");
    f.ports.authorizeHuman = decision => receipts.authenticateHuman(decision);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const manifest = unwrap(await f.panes.getManifest()), binding = f.panes.bindings.find(pane => pane.role === "conversation")!;
    const contextDirectory = join(f.root, "conversation");
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest, contextDirectory, onHumanDecision: async decision => {
      await receipts.recordHuman(decision, { origin: "UserPromptSubmit", binding, nativeSessionId: binding.session!.value,
        conversationSessionId: "session-1", userId: "human-1", messageId: "user-before-crash", promptDigest: createHash("sha256").update("approve").digest("hex") });
      throw new Error("Simulated crash after receipt fsync");
    } });
    const approval = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "approval.request").message;
    await chat.receiveHerdr({ ...approval, sender: { role: "coordinator", agent_id: "coordinator" }, recipient: { role: "conversation" } });
    await expect(chat.handleUserTurn({ sessionId: "session-1", messageId: "user-before-crash", content: "approve",
      provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: binding.paneId, channel: "herdr_attach" } })).rejects.toThrow("Simulated crash");
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "approval.decision")).toHaveLength(0);
    receipts = new HostReceiptJournal(join(f.root, "host-receipts"), f.repository, "session-1");
    f.reopenStorage(); const restarted = f.restart();
    const decisions = await receipts.humanDecisions(); expect(decisions).toHaveLength(1);
    await createAgenticConversationHost({ runtime: restarted, manifest, contextDirectory, recoveredHumanDecisions: decisions });
    const module = await import("../../../conversation/dist/index.js");
    const context = unwrap(await new module.FileConversationContextStore(contextDirectory).load("session-1"))!;
    expect(context.approvalDecisions[decisions[0]!.approvalId]).toEqual(decisions[0]);
    expect(context.pendingApprovals[decisions[0]!.approvalId]).toBeUndefined();
    expect(context.session.activeApprovalIds).toHaveLength(0);
    const pending = (await restarted.inspect() as any).outbound.filter((out: any) => out.message.type === "approval.decision");
    expect(pending).toHaveLength(1); expect(pending[0].message.payload).toEqual(decisions[0]);
    await restarted.receiveHerdr(pending[0].message);
    expect((await restarted.inspect("run-1") as any).status).toBe("implementing");
  });
  it("cancellation stops dispatch and preserves uncertain stop/worktree state", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const before = f.transport.sentRequests.filter(req => req.role === "developer").length;
    await f.runtime.cancel("run-1", "User cancelled"); await f.runtime.tick();
    expect((await f.inspect()).cancelled).toBe(true); expect(f.transport.cancelledHandles).toHaveLength(1);
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(before);
    expect((await f.ports.engine.getSnapshot("run-1") as any).value.status).toBe("cancelling");
  });
  it("preserves an actual conflicting integration worktree and escalates through Herdr", async () => {
    const f = await fixture({ parallel: true, conflict: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.evidence("other");
    await f.submit("implement", "first branch\n"); await f.submit("other", "second branch\n");
    await f.runtime.tick(); await f.runtime.tick();
    const run = await f.inspect(); expect(run.status).toBe("escalated");
    expect((await f.ports.policies.git.getIntegration(run.integrationKey)).status).toBe("conflict");
    expect(run.workflowCycle).toBeUndefined();
    expect((await f.runtime.inspect() as any).outbound.some((out: any) => out.message.type === "task.status" && out.message.payload.reason === "merge_conflict")).toBe(true);
  });
  it("P14 dialogue and busy inbound queue are composed with a durable outbound Herdr handoff", async () => {
    const f = await fixture({ intake: false });
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest: unwrap(await f.panes.getManifest()), contextDirectory: join(f.root, "conversation") });
    expect((await chat.handleUserTurn({ sessionId: "session-1", content: "Hello!", provenance: { origin: "user", authenticatedUser: true } }) as any).ok).toBe(true);
    expect((await f.runtime.inspect() as any).runs).toHaveLength(0);
    expect((await f.runtime.inspect() as any).outbound).toHaveLength(0);
    const response = await chat.handleUserTurn({ sessionId: "session-1", content: "Triển khai tính năng xác thực JWT HS256 trong packages/auth với thời hạn token 15 phút và unit test", provenance: { origin: "user", authenticatedUser: true } }) as any;
    expect(response.ok).toBe(true); expect(response.value.recognizedIntent).toBe("workflow_request");
    expect(f.transport.sentRequests).toHaveLength(0); // persisted enqueue is not a remote acknowledgement
    await f.runtime.flushOutbound();
    const handoff = JSON.parse(f.transport.sentRequests.find(request => request.role === "coordinator")!.instruction);
    await f.runtime.receiveHerdr(handoff);
    expect((await f.runtime.inspect() as any).runs).toHaveLength(1);
    await chat.setBusy(true);
    const progress = f.envelope("conversation.progress", { sdlcStatus: "planning", headline: "Plan ready" }, {
      sender: { role: "coordinator" }, recipient: { role: "conversation" }, run_id: handoff.run_id, correlation_id: handoff.correlation_id });
    const received = await chat.receiveHerdr(progress) as any;
    expect(received.ok).toBe(true); expect(received.value.queuedBecauseBusy).toBe(true);
    await chat.setBusy(false);
  });
  it("routes Reviewer requests through AgentTransport without locking out inbound processing", async () => {
    const f = await fixture({ remoteReview: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    const tools = new CoordinatorTools(f.runtime);
    expect(await tools.invoke("tick", {}, { role: "coordinator" })).toMatchObject({ scheduled: true });
    const ticking = tools.drain();
    ticking.catch(() => undefined);
    let request: any;
    try {
      await expect.poll(async () => {
        request = f.transport.sentRequests.find(req => JSON.parse(req.instruction).type === "verification.requested");
        if (!request) return false;
        const state = await f.runtime.inspect() as any;
        return state.outbound.some((out: any) => out.request?.requestId === request.requestId && out.status === "accepted");
      }, { timeout: 2500, interval: 20 }).toBe(true);
    } catch (error) { await ticking; throw error; }
    const message = JSON.parse(request.instruction);
    const result = unwrap(await f.localReview(message.payload));
    await f.runtime.receiveHerdr(f.envelope("review.verdict", result, { sender: { role: "reviewer", agent_id: request.target.agentId, pane_id: request.target.paneId }, causation_id: message.message_id }));
    await ticking; expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
  });
  it("reconciliation permits resend only after a proven not_delivered result", async () => {
    const f = await fixture(); f.panes.busy.add("conversation");
    f.transport.customSendHandler = () => ({ ok: false, error: { code: "timeout", retryable: true, message: "uncertain" } });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const state = await f.runtime.inspect() as any; const out = state.outbound.find((item: any) => item.status === "unknown_delivery");
    f.transport.customReconcileHandler = request => ({ ok: true, value: { status: "not_delivered", requestId: request.requestId, retrySafe: true, observedAt: new Date().toISOString() } });
    await f.runtime.reconcileDelivery(out.message.message_id); f.transport.customSendHandler = undefined;
    await f.runtime.tick(); expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(2);
    expect((await f.inspect()).tasks[0].outboundIds).toHaveLength(1);
    const sent = f.transport.sentRequests.filter(req => req.role === "developer"); expect(sent[1]).toEqual(sent[0]);
  });
  it("project-required task approval blocks dependent dispatch and supports human rejection", async () => {
    const f = await fixture({ parallel: true }); f.def.tasks[0]!.requiresApproval = true;
    f.def.dependencies = [{ taskId: "other", dependsOnTaskId: "implement", condition: "succeeded" }] as any;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit(); await f.runtime.tick();
    expect((await f.inspect()).approvalKind).toBe("task");
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
    await f.approve("rejected"); await f.runtime.tick();
    expect((await f.inspect()).status).toBe("failed");
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
  });
  it("preserves each parallel task approval across restart before workflow delivery", async () => {
    const f = await fixture({ parallel: true });
    f.def.tasks.forEach(task => { task.requiresApproval = true; });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.evidence("other"); await f.submit(); await f.submit("other", "second file\n");
    await f.runtime.tick();
    expect((await f.inspect()).approval.target).toEqual({ type: "task", taskId: "implement" });
    await f.restart().tick();
    expect((await f.inspect()).approval.target).toEqual({ type: "task", taskId: "implement" });
    await f.approve(); await f.runtime.tick();
    expect((await f.inspect()).status).toBe("awaiting_approval");
    expect((await f.inspect()).approval.target).toEqual({ type: "task", taskId: "other" });
    await f.approve(); await f.runtime.tick();
    expect((await f.inspect()).approvalKind).toBe("delivery");
    await f.approve(); expect((await f.inspect()).status).toBe("completed");
  });
  it("does not revive human rejection with a parallel verification outcome", async () => {
    const f = await fixture({ parallel: true });
    f.def.tasks[0]!.requiresApproval = true;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.evidence("other"); await f.submit(); await f.submit("other", "second file\n");
    await f.runtime.tick(); expect((await f.inspect()).status).toBe("awaiting_approval");
    await f.approve("rejected"); await f.restart().tick();
    expect((await f.inspect()).status).toBe("failed");
    expect((await f.inspect()).integrationKey).toBeUndefined();
  });
  it("retains human rejection when a concurrent verifier throws after the decision", async () => {
    const f = await fixture({ parallel: true }); f.def.tasks[0]!.requiresApproval = true;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.evidence("other"); await f.submit(); await f.submit("other", "second file\n");
    const verify = f.ports.policies.verification.verify.bind(f.ports.policies.verification);
    let entered!: () => void, rejectVerification!: (error: Error) => void;
    const checkingOther = new Promise<void>(resolve => { entered = resolve; });
    const deferred = new Promise<never>((_resolve, reject) => { rejectVerification = reject; });
    vi.spyOn(f.ports.policies.verification, "verify").mockImplementation(async (...args) => {
      if (args[0].taskId === "other") { entered(); return deferred; }
      return verify(...args);
    });
    const ticking = f.runtime.tick(); await checkingOther;
    expect((await f.inspect()).approval.target).toEqual({ type: "task", taskId: "implement" });
    await f.approve("rejected");
    rejectVerification(new Error("Injected concurrent verification storage failure")); await ticking;
    expect((await f.inspect()).status).toBe("failed");
    expect((await f.inspect()).error).toBe("User refused");
    await f.restart().tick();
    expect((await f.inspect()).status).toBe("failed");
    expect((await f.inspect()).error).toBe("User refused");
    expect((await f.inspect()).integrationKey).toBeUndefined();
  });
  it("rejects forged results and conflicting inbox messages before advancing task state", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await expect(f.runtime.receiveHerdr(f.envelope("implementation.submitted", { status: "succeeded" }, { sender: { role: "developer" } }))).rejects.toThrow();
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!.status).toBe("running");
    const message = f.envelope("task.status", { headline: "Working" });
    await f.runtime.receiveHerdr(message);
    await expect(f.runtime.receiveHerdr({ ...message, payload: { headline: "Different task" } })).rejects.toThrow("Conflicting inbound");
  });

  it("not_applicable requires alternative evidence and cannot pass by skipping tests", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick(); await f.submit();
    await f.runtime.tick(); expect((await f.inspect()).tasks[0].spec.strategy.tddDecision.mode).toBe("not_applicable");
    expect((await f.inspect()).tasks[0].cycle).toBeUndefined(); expect(f.calls).toHaveLength(0);
    await f.evidence("implement"); await f.runtime.tick(); expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
  });
  it("parallel branches integrate and are independently verified on the exact merged revision", async () => {
    const f = await fixture({ parallel: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.evidence("other"); await f.submit(); await f.submit("other", "second file\n");
    await f.runtime.tick(); await f.runtime.tick(); const run = await f.inspect();
    expect(run.workflowCycle.status).toBe("passed"); expect(run.workflowChange.filesChanged).toHaveLength(2);
    expect(run.workflowCycle.history[0].metadata.integrationCommitHash).toBe(run.workflowChange.headCommitHash);
  });
  it("refuses the actual Adapter-style unverified orchestrator handle as task success", async () => {
    const f = await fixture();
    f.transport.customSendHandler = request => {
      const handle = { executionId: randomUUID(), requestId: request.requestId, attemptId: request.attemptId,
        runId: request.runId, taskId: request.taskId, idempotencyKey: request.idempotency.key, target: request.target,
        correlation: { token: request.requestId, provenance: "orchestrator" as const, verified: false }, acceptedAt: new Date().toISOString() };
      return { ok: true, value: { status: "accepted", requestId: request.requestId, attemptId: request.attemptId,
        runId: request.runId, taskId: request.taskId, observedAt: handle.acceptedAt, handle } };
    };
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await expect(f.submit()).rejects.toThrow("verified remote correlation");
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!.status).toBe("running");
    expect((await f.inspect()).tasks[0].cycle).toBeUndefined();
  });
  it("replays a durable verification outcome after SQLite append failure without rerunning checks", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    const append = f.ports.runStore.appendEvents.bind(f.ports.runStore); let failOnce = true;
    const spy = vi.spyOn(f.ports.runStore, "appendEvents").mockImplementation(async request => {
      if (failOnce && request.events.some(event => event.type === "quality_gate.evaluated")) {
        failOnce = false; return { ok: false, error: { code: "corruption", retryable: false, message: "Injected SQLite write failure" } };
      }
      return append(request);
    });
    await f.runtime.tick(); expect((await f.inspect()).status).toBe("escalated");
    const taskChecks = f.calls.filter(ctx => (ctx.input as any).scope === "task").length;
    await f.restart().tick(); spy.mockRestore();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
    expect(f.calls.filter(ctx => (ctx.input as any).scope === "task")).toHaveLength(taskChecks);
  });

  it("a verified failed attempt waits for writer reconciliation before bounded retry dispatch", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const state = await f.runtime.inspect() as any;
    const out = state.outbound.find((item: any) => item.message.type === "task.assignment"); const handle = out.handle;
    const failed = AgentResultSchema.parse({ requestId: handle.requestId, attemptId: handle.attemptId, runId: "run-1", taskId: "implement",
      executionId: handle.executionId, status: "failed", verification: { status: "verified", evidence: "Trusted failing execution", correlation: handle.correlation },
      artifactProposals: [], retryable: true, error: { code: "temporary_execution_error", message: "Retryable task execution failure", retryable: true },
      startedAt: handle.acceptedAt, completedAt: new Date().toISOString() });
    await f.runtime.receiveHerdr(f.envelope("implementation.submitted", failed, { causation_id: out.message.message_id,
      sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId } }));
    f.panes.busy.add("developer"); await f.runtime.tick();
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
    f.panes.busy.delete("developer"); await f.runtime.tick();
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(2);
  });

  it("accepts signed native binding proof while retaining the raw handle across SQLite/checkpoint recovery", async () => {
    const f = await fixture();
    f.transport.customSendHandler = request => ({ ok: true, value: { status: "accepted", requestId: request.requestId,
      attemptId: request.attemptId, runId: request.runId, taskId: request.taskId, observedAt: new Date().toISOString(),
      handle: { executionId: randomUUID(), requestId: request.requestId, attemptId: request.attemptId, runId: request.runId,
        taskId: request.taskId, idempotencyKey: request.idempotency.key, target: request.target,
        correlation: { token: request.requestId, provenance: "orchestrator", verified: false }, acceptedAt: new Date().toISOString() } } });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const state = await f.runtime.inspect() as any; const out = state.outbound.find((item: any) => item.message.type === "task.assignment");
    const handle = out.handle;
    const receipt = createSignedBindingReceipt({ issuerId: "native-test-host", receiptId: randomUUID(), handle,
      correlation: { token: out.message.message_id, provenance: "transport", verified: true }, observedAt: new Date().toISOString(), privateKey: f.privateKey });
    const message = f.envelope("execution.receipt", receipt, { causation_id: out.message.message_id,
      sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId } });
    await f.runtime.receiveHerdr(message); await f.runtime.receiveHerdr(message);
    let current = unwrap(await f.ports.engine.getSnapshot("run-1"))!;
    expect(current.tasks[0]!.agentExecution!.correlation.verified).toBe(false);
    expect(current.tasks[0]!.bindingVerification!.receipt.correlation.verified).toBe(true);
    const projected = unwrap(await f.ports.runStore.get("run-1"))!.snapshot.tasks[0]!;
    expect(projected.bindingVerification).toEqual(current.tasks[0]!.bindingVerification);
    expect(projected.version).toBe(current.tasks[0]!.version);
    const checkpoint = unwrap(await f.ports.engine.createCheckpoint({ runId: "run-1", expectedVersion: current.version,
      checkpointId: "signed-binding-checkpoint", createdAt: new Date().toISOString() }));
    expect(checkpoint.codec.version).toBe(2);
    expect(unwrap(await f.ports.runStore.saveCheckpoint(checkpoint, current.version))).toBeUndefined();
    const restarted = new DeterministicWorkflowEngine({ definitions: [(await f.inspect()).definition], bindingReceiptKeys: { "native-test-host": f.publicKey } });
    expect(unwrap(await restarted.recover({ runId: "run-1", checkpoint, events: [], expectedVersion: current.version })).snapshot.tasks[0]!.bindingVerification).toBeDefined();
    const untrusted = new DeterministicWorkflowEngine({ definitions: [(await f.inspect()).definition] });
    expect(await untrusted.recover({ runId: "run-1", checkpoint, events: [], expectedVersion: current.version })).toMatchObject({ ok: false });
    await f.evidence("implement"); await f.submit(); await f.runtime.tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
  });

  it.each(["signature", "issuer", "identity", "cancelled"])("refuses %s binding receipts without promoting the handle", async failure => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const state = await f.runtime.inspect() as any; const out = state.outbound.find((item: any) => item.message.type === "task.assignment");
    const receipt = createSignedBindingReceipt({ issuerId: failure === "issuer" ? "untrusted" : "native-test-host", receiptId: randomUUID(),
      handle: failure === "identity" ? { ...out.handle, executionId: "another-execution" } : out.handle,
      correlation: { token: out.message.message_id, provenance: "transport", verified: true }, observedAt: new Date().toISOString(), privateKey: f.privateKey });
    if (failure === "signature") receipt.signature.value = Buffer.alloc(64, 1).toString("base64");
    if (failure === "cancelled") await f.runtime.cancel("run-1", "Cancel before proof");
    await expect(f.runtime.receiveHerdr(f.envelope("execution.receipt", receipt, { causation_id: out.message.message_id,
      sender: { role: "developer", agent_id: out.handle.target.agentId, pane_id: out.handle.target.paneId } }))).rejects.toThrow();
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!.bindingVerification).toBeUndefined();
  });

});

it("recovers the exact failed phase after a crash following lease release without duplicating repair notices", async () => {
  const f = await fixture({ tdd: true });
  f.ports.roleCapabilities.qa = ["verification", "testing"];
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
  const state = await f.runtime.inspect() as any;
  const assignment = state.outbound.find((out: any) => out.message.type === "task.assignment");
  const binding = f.panes.bindings.find(item => item.paneId === assignment.handle.target.paneId)!;
  const revision = git(assignment.handle.target.worktreePath, "rev-parse", "HEAD");
  const queued = await f.runtime.requestPhaseVerification(binding, "run-1", "implement", "red", revision) as any;
  await f.runtime.flushOutbound();
  const request = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === queued.messageId);
  const qa = f.panes.bindings.find(item => item.paneId === request.handle.target.paneId)!;
  const journal = (f.runtime as any).journal, exclusive = journal.exclusive.bind(journal);
  const spy = vi.spyOn(journal, "exclusive").mockImplementation((action: any) => exclusive(async (current: any, save: any) => action(current, async () => {
    await save();
    if (current.outbound.find((out: any) => out.message.message_id === queued.messageId)?.status === "released")
      throw new Error("crash after released checkpoint");
  })));
  await expect(f.runtime.recordPhaseFailure(qa, queued.messageId, "Actual assertion failure", true)).rejects.toThrow("crash after released checkpoint");
  spy.mockRestore();
  const reopened = f.restart(), restored = await reopened.inspect() as any;
  const failed = restored.outbound.find((out: any) => out.message.message_id === queued.messageId);
  expect(failed).toMatchObject({ status: "released", error: "policy_phase_failed:Actual assertion failure", phaseFailure: { applied: true } });
  expect(restored.outbound.filter((out: any) => out.parentAssignmentId === assignment.message.message_id)).toHaveLength(1);
  expect(await reopened.recordPhaseFailure(qa, queued.messageId, "Actual assertion failure", true)).toMatchObject({ alreadyRecorded: true });
  await expect(reopened.requestPhaseVerification(binding, "run-1", "implement", "red", revision)).rejects.toThrow("already failed");
  const again = await reopened.inspect() as any;
  expect(again.outbound.filter((out: any) => out.parentAssignmentId === assignment.message.message_id)).toHaveLength(1);
  await expect(reopened.recordPhaseFailure(qa, queued.messageId, "Different result", true)).rejects.toThrow("Conflicting");
});
