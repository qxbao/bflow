import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { copyIsolatedNodeDependencies } from "../helpers/isolated-node-dependencies.js";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResultSchema, ApprovalDecisionSchema, RoleMessageSchema, VerificationResultSchema,
  type AgentRequest, type PaneBinding, type Specification, type QualityGate, type QualityGateContext } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { createSignedBindingReceipt } from "../../src/agentic/receipt-host.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { loadAgenticPolicies, type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { DEFAULT_HOST_CHECKS, HostBehavioralFailure, HostVerification } from "../../src/agentic/host-verification.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { parseBehavioralCommands, type BehavioralCommand, type RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { TestRunnerSource } from "../../src/agentic/task-commands.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { digest } from "../../src/agentic/journal.js";
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

async function fixture(options: { dynamicGate?: boolean; parallel?: boolean; tdd?: boolean; complex?: boolean; failReview?: boolean; conflict?: boolean; intake?: boolean; remoteReview?: boolean; humanApproval?: boolean; behavioral?: BehavioralCommand; runners?: TestRunnerSource } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-p19-")));
  const repository = join(root, "repo"); await mkdir(repository); git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test"); git(repository, "config", "user.email", "test@example.test");
  await writeFile(join(repository, "guide.md"), "initial\n");
  await writeFile(join(repository, "other.md"), "initial\n");
  if (options.behavioral) {
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src/double.cjs"), "module.exports=x=>x+1;\n");
  }
  git(repository, "add", "."); git(repository, "commit", "-m", "baseline");
  let store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "p19" }));
  cleanups.push(async () => { store.close(); artifacts.close(); await rm(root, { recursive: true, force: true }); });
  const transport = new FakeAgentTransport(); const panes = new Panes();
  if (options.behavioral) transport.customSendHandler = request => {
    const nativeProofRequired = JSON.parse(request.instruction).type === "task.assignment";
    const handle = { executionId: randomUUID(), requestId: request.requestId, attemptId: request.attemptId, runId: request.runId,
      taskId: request.taskId, idempotencyKey: request.idempotency.key, target: request.target,
      correlation: { token: request.requestId, provenance: nativeProofRequired ? "orchestrator" as const : "transport" as const, verified: !nativeProofRequired }, acceptedAt: new Date().toISOString() };
    return { ok: true, value: { status: "accepted", requestId: request.requestId, attemptId: request.attemptId, runId: request.runId,
      taskId: request.taskId, observedAt: handle.acceptedAt, handle } };
  };
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
  const receipts = new HostReceiptJournal(join(root, "host-receipts"), repository, "session-1");
  const verification = new HostVerification(() => runtime, () => artifacts, receipts, options.runners ?? (options.behavioral ? [options.behavioral] : []));
  if (options.behavioral) checks.splice(0, checks.length, ...DEFAULT_HOST_CHECKS, ...verification.behavioralChecks());
  const actualGates = options.behavioral ? [
    ...DEFAULT_HOST_CHECKS.filter(check => (check.configuration as any).kind === "review").map(check => ({ id: check.id,
      evaluate: (...args: Parameters<QualityGate["evaluate"]>) => runtime.herdrQualityGate(check.id).evaluate(...args) })),
    verification.deterministicGate(), ...verification.behavioralGates().map(gate => ({ id: gate.id, evaluate: async (context: QualityGateContext) => {
      calls.push(context); return gate.evaluate(context);
    } }))
  ] : options.remoteReview ? gates.map(gate => gate.id === "review" ? { id: gate.id,
    evaluate: (...args: Parameters<QualityGate["evaluate"]>) => runtime.herdrQualityGate(gate.id).evaluate(...args) } : gate) : gates;
  let dynamicReady = false;
  const policies = await loadAgenticPolicies({ repositoryPath: repository, artifactStore: artifacts,
    gates: options.dynamicGate ? actualGates.filter(gate => gate.id !== "regression") : actualGates,
    ...(options.dynamicGate ? { dynamicGates: () => dynamicReady ? actualGates.filter(gate => gate.id === "regression") : [] } : {}),
    loadSpecification: id => runtime.loadSpecification(id), authorizeApprover: decision => ["coordinator", "human-1"].includes(decision.decidedBy) });
  // Conversation-bound messages are delivered through the trusted inbox, never through transport or the input box.
  const conversationInbox: RoleMessage[] = [];
  let conversationReentry: ((message: RoleMessage) => Promise<unknown>) | undefined;
  const ports: AgenticRuntimePorts = { engine, runStore: store, artifactStore: artifacts, registry, transport, panes, policies,
    deliverToConversation: async (message: RoleMessage) => { conversationInbox.push(message); await conversationReentry?.(message); },
    roleCapabilities: { developer: ["implementation"], coordinator: ["coordination", "repository.read"], conversation: ["conversation"], specifier: ["specification", "repository.read"], architect: ["architecture", "repository.read"], planner: ["planning", "repository.read"], reviewer: ["review", "repository.read"], qa: ["verification", "repository.read", ...(options.behavioral ? ["testing"] : [])], tester: ["testing", "repository.read"] },
    taskChecks: checks, workflowChecks: checks,
    authenticateMessage: async () => true, authenticateResult: async () => true, authenticateEvidence: async (result: any) => options.behavioral ? verification.authenticateEvidence(result) : true,
    authenticateGateResult: async (result: any) => options.behavioral ? verification.authenticateGate(result) : true,
    authorizeHuman: async (decision: any) => options.behavioral ? receipts.authenticateHuman(decision) : decision.decidedBy === "human-1",
    projectApprovalRequired: () => options.humanApproval === true };
  const runtimeOptions = { journalDirectory: join(root, "journal"), repositoryPath: repository };
  runtime = new AgenticWorkflowRuntime(ports, runtimeOptions);
  const spec: Specification = draft(options.complex ? "api" : options.behavioral ? "bugfix" : "documentation");
  const time = new Date().toISOString(); spec.createdAt = time; spec.updatedAt = time;
  spec.affectedPaths = options.behavioral ? ["src", "test", ...(options.runners ? ["test/double.test.cjs"] : [])] : ["guide.md", ...(options.parallel ? ["other.md"] : [])];
  spec.traceabilityTaskIds = options.parallel ? ["implement", "other"] : ["implement"];
  if (options.complex) { (spec.metadata!.sdd as any).assessment.modules = ["one", "two"]; }
  const sdd = spec.metadata!.sdd as any; sdd.traceability[0].taskIds = spec.traceabilityTaskIds;
  spec.metadata!.conditionalTdd = { policyVersion: 1, taskId: "implement", taskType: options.tdd || options.behavioral ? "domain_logic" : "documentation",
    changeImpact: { surfaces: [options.tdd || options.behavioral ? "domain_logic" : "documentation"], behaviorChanged: !!(options.tdd || options.behavioral), deterministic: !!(options.tdd || options.behavioral),
      regressionReproducible: !!(options.tdd || options.behavioral), securitySensitive: false, dataMigration: false, scope: "local" },
    infrastructure: { readiness: "ready", commands: [{ method: "integration_test", command: options.behavioral?.command ?? "test-regression", level: "integration" }, ...(options.complex ? [{ method: "static_analysis", command: "static-check" }] : [])] },
    testability: { level: "automated", rationale: "Independent repeatable behavioral checks are available" }, riskClassification: "low",
    conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] } };
  if (options.tdd || options.behavioral) spec.acceptanceCriteria[0]!.verificationMethod = "integration_test";
  if (options.complex) {
    const strategy = policies.strategy.resolve(spec);
    spec.testStrategy = strategy; spec.tddDecision = strategy.tddDecision;
  } else { delete spec.testStrategy; delete spec.tddDecision; }
  const def = workflow(spec.traceabilityTaskIds); def.maxConcurrency = options.parallel ? 2 : 1;
  def.tasks.forEach((task, index) => { (task as any).metadata = { ownedPaths: options.behavioral ? ["src", "test"] : [index && !options.conflict ? "other.md" : "guide.md"] }; });
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
  async function submit(taskId = "implement", content: string | null = "updated\n") {
    const state = await runtime.inspect() as any;
    const outbound = [...state.outbound].reverse().find((out: any) => out.taskId === taskId && out.message.type === "task.assignment");
    const handle = outbound.handle; expect(handle).toBeDefined();
    const path = handle.target.worktreePath; const file = taskId === "other" && !options.conflict ? "other.md" : "guide.md";
    if (content !== null) { await writeFile(join(path, file), content); git(path, "add", file); git(path, "commit", "-m", "implement"); }
    const result = AgentResultSchema.parse({ requestId: handle.requestId, attemptId: handle.attemptId, runId: "run-1", taskId,
      executionId: handle.executionId, status: "succeeded", verification: { status: "verified", evidence: "Authenticated test-host result", correlation:
        unwrap(await ports.engine.getSnapshot("run-1"))!.tasks.find(task => task.taskId === taskId)!.bindingVerification?.receipt.correlation ?? handle.correlation },
      artifactProposals: [], retryable: false, startedAt: handle.acceptedAt, completedAt: new Date().toISOString() });
    await runtime.receiveHerdr(envelope("implementation.submitted", result, { causation_id: outbound.message.message_id,
      sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId } }));
  }
  async function approve(decision = "approved") {
    const run = await inspect(); const request = run.approval;
    const approved = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId,
      runId: "run-1", sessionId: "session-1", target: request.target, revision: request.revision, generation: request.generation,
      decision, ...(decision !== "approved" ? { reason: "User refused" } : {}), decidedBy: "human-1", decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: randomUUID() });
    if (options.behavioral) {
      const binding = panes.bindings.find(pane => pane.role === "conversation")!;
      const chat = await createAgenticConversationHost({ runtime, manifest: unwrap(await panes.getManifest()), contextDirectory: join(root, "phase-conversation"),
        onHumanDecision: async actual => receipts.recordHuman(actual, { origin: "UserPromptSubmit", binding, nativeSessionId: binding.session!.value,
          conversationSessionId: "session-1", userId: "human-1", messageId: "real-phase-test-approval", promptDigest: createHash("sha256").update(decision).digest("hex") }) });
      const requestOut = (await runtime.inspect() as any).outbound.find((out: any) => out.message.type === "approval.request" && out.message.payload.approvalId === request.approvalId);
      await chat.receiveHerdr(requestOut.message);
      const response = await chat.handleUserTurn({ sessionId: "session-1", messageId: "real-phase-test-approval", content: decision === "approved" ? "approve" : "reject",
        provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: binding.paneId, channel: "herdr_attach" } });
      expect(response.ok).toBe(true);
      const decisionOut = (await runtime.inspect() as any).outbound.find((out: any) => out.message.type === "approval.decision" && out.message.payload.approvalId === request.approvalId);
      expect(await receipts.authenticateHuman(decisionOut.message.payload)).toBe(true);
      await runtime.flushOutbound();
      expect((await runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === decisionOut.message.message_id).status).toBe("accepted");
      await runtime.receiveHerdr(decisionOut.message); return;
    }
    await runtime.receiveHerdr(envelope("approval.decision", approved));
  }
  return { enableDynamicGate: () => { dynamicReady = true; }, root, repository, get runtime() { return runtime; }, ports, privateKey, publicKey, runtimeOptions, panes, transport, conversationInbox,
    reenterOnConversationDelivery(action: (message: RoleMessage) => Promise<unknown>) { conversationReentry = action; }, spec, def, envelope, inspect, dossier, evidence, submit, approve, verification, receipts,
    calls, localReview: (context: QualityGateContext) => gates.find(gate => gate.id === "review")!.evaluate(context), setFailReview: (value: boolean) => { failReview = value; },
    setReviewerExecutor: (value: string) => { reviewerExecutorId = value; },
    reopenStorage: () => { store.close(); store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") })); ports.runStore = store; },
    restart: () => { runtime = new AgenticWorkflowRuntime({ ...ports, engine: new DeterministicWorkflowEngine({ bindingReceiptKeys }) }, runtimeOptions); return runtime; } };
}

const phaseTestName = "ac-1: The requested outcome is independently verifiable";
/** Runtime-detected profile without owner configuration; detection itself is stubbed, execution is real. */
async function automaticRunners(): Promise<TestRunnerSource> {
  const profile: RunnerProfile = { id: "auto-integration", command: "auto:integration", executable: process.execPath,
    args: ["--test", "--test-reporter=tap"], method: "integration_test", levels: ["integration", "regression"], reporter: "node_tap",
    timeoutMs: 10_000, checkoutDependencyRoots: [], dependencySource: process.cwd(), definitionBlobs: {}, source: "detected" };
  const runners = new TestRunnerSource([], process.cwd(), async () => ({ status: "detected", profiles: [profile], notes: [] }));
  await runners.refresh();
  return runners;
}
async function connectedPhaseFixture(reporter: "node_tap" | "vitest_json", maxIterations = 3, automatic = false) {
  const testPath = "test/double.test.cjs", sourcePath = "src/double.cjs";
  const dependencies = await realpath(await mkdtemp(join(tmpdir(), "bflow-integration-deps-")));
  cleanups.push(() => rm(dependencies, { recursive: true, force: true }));
  const sourceDependencies = await realpath("node_modules"), staged = join(dependencies, "node_modules");
  if (reporter === "vitest_json") await copyIsolatedNodeDependencies(sourceDependencies, staged);
  const vitest = join(staged, relative(sourceDependencies, createRequire(import.meta.url).resolve("vitest/vitest.mjs")));
  const command = parseBehavioralCommands([{ id: "real-regression", command: "owner:double-regression", executable: process.execPath,
    args: reporter === "node_tap" ? ["--test", "--test-reporter=tap", testPath] : [vitest, "run", "--globals", "--reporter=json", "--no-cache", "--maxWorkers=1", "--minWorkers=1", testPath],
    ...(reporter === "vitest_json" ? { reporter, dependencyRoots: [staged] } : {}), method: "integration_test", levels: ["integration", "regression"],
    testPaths: [testPath], testNames: [phaseTestName], timeoutMs: 10_000 }])[0]!;
  const runners = automatic ? await automaticRunners() : undefined;
  const f = await fixture({ behavioral: automatic ? { ...command, command: "auto:integration" } : command, runners });
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def, maxIterations); await f.runtime.tick();
  const original = (await f.runtime.inspect() as any).outbound.find((item: any) => item.message.type === "task.assignment");
  expect(original.status).toBe("accepted");
  const developer = f.panes.bindings.find(binding => binding.paneId === original.handle.target.paneId)!;
  const qa = f.panes.bindings.find(binding => binding.role === "qa")!;
  const development = new HostDevelopment(() => f.runtime, runners ?? [command]);
  const testSource = reporter === "node_tap" ? `const {test}=require('node:test'); const assert=require('node:assert/strict'); const double=require('../src/double.cjs'); test(${JSON.stringify(phaseTestName)},()=>assert.equal(double(2),4));\n` :
    `const double=require('../src/double.cjs'); it(${JSON.stringify(phaseTestName)},()=>expect(double(2)).toBe(4));\n`;
  const receipt = createSignedBindingReceipt({ issuerId: "native-test-host", receiptId: randomUUID(), handle: original.handle,
    correlation: { token: original.message.message_id, provenance: "transport", verified: true }, observedAt: new Date().toISOString(), privateKey: f.privateKey });
  await f.runtime.receiveHerdr(f.envelope("execution.receipt", receipt, { causation_id: original.message.message_id,
    sender: { role: "developer", agent_id: developer.agentId, pane_id: developer.paneId } }));
  const bound = unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!;
  expect(bound.agentExecution!.correlation.verified).toBe(false);
  expect(bound.bindingVerification!.receipt.signature.algorithm).toBe("ed25519");
  expect(bound.bindingVerification!.receipt.correlation.verified).toBe(true);
  const currentHead = () => git(developer.worktreePath!, "rev-parse", "HEAD");
  const edit = (path: string) => development.authorizeFileEdit(developer, { tool_name: "Write", tool_input: { file_path: join(developer.worktreePath!, path) } });
  const commit = (message: string) => development.commit(developer, { runId: "run-1", taskId: "implement", expectedHead: currentHead(), message });
  async function addTests() {
    await edit(testPath); await mkdir(join(developer.worktreePath!, "test"));
    await writeFile(join(developer.worktreePath!, testPath), testSource); await commit("Red: specify doubled output");
  }
  async function request(phase: string) {
    const head = currentHead();
    const queued = await f.runtime.requestPhaseVerification(developer, "run-1", "implement", phase, head) as any;
    await f.runtime.flushOutbound();
    const pending = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === queued.messageId);
    expect(pending.status).toBe("accepted"); expect(pending.handle.target.paneId).toBe(qa.paneId);
    expect(pending.lease.leaseId).not.toBe(original.lease.leaseId);
    return { pending, head };
  }
  async function measure(phase: string) {
    const { pending, head } = await request(phase);
    const completed = await f.verification.behavioralEvidence(qa, { runId: "run-1", taskId: "implement", phase });
    expect((completed.result.metadata!.conditionalTdd as any).sourceRevision).toBe(head);
    await f.runtime.receiveHerdr(f.envelope("verification.result", completed.result, { causation_id: pending.message.message_id,
      sender: { role: "qa", agent_id: qa.agentId, pane_id: qa.paneId }, artifact_references: completed.result.evidenceArtifacts }));
    await f.runtime.flushOutbound();
    const state = await f.runtime.inspect() as any;
    const notice = state.outbound.find((out: any) => out.message.type === "task.status" && out.message.payload.kind === "policy_phase_outcome" && out.message.payload.phase === phase && out.message.payload.status === "passed");
    const parent = state.outbound.find((out: any) => out.message.message_id === original.message.message_id);
    expect(notice.status).toBe("accepted"); expect(notice.parentAssignmentId).toBe(parent.message.message_id);
    expect(notice.lease).toEqual(parent.lease); expect(notice.handle.target).toEqual(parent.handle.target);
    expect(parent.status).toBe("accepted");
    expect(state.outbound.find((out: any) => out.message.message_id === pending.message.message_id).status).toBe("released");
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!.agentExecution).toEqual(original.handle);
    return completed.result;
  }
  /** Reply through Runtime to real Reviewer/QA gate requests while tick awaits them outside its lock. */
  async function tickWithReviews() {
    let done = false;
    const ticking = f.runtime.tick().finally(() => { done = true; }); void ticking.catch(() => undefined);
    let cursor = 0; const deadline = Date.now() + 60_000;
    while (!done) {
      if (Date.now() > deadline) {
        const snapshot = await f.runtime.inspect() as any;
        const pending = snapshot.outbound.filter((out: any) => out.message.type === "verification.requested").map((out: any) => ({ id: out.message.message_id, status: out.status, error: out.error, gate: out.message.payload.definition?.id }));
        await f.runtime.cancel("run-1", "Stop timed-out test verification"); await ticking.catch(() => undefined);
        throw new Error(`Connected verification did not finish: ${JSON.stringify(pending)}`);
      }
      while (cursor < f.transport.sentRequests.length) {
        const delivered = f.transport.sentRequests[cursor++]!, message = JSON.parse(delivered.instruction);
        if (message.type !== "verification.requested" || !message.payload.definition) continue;
        const out = { message };
        const binding = f.panes.bindings.find(pane => pane.paneId === delivered.target.paneId)!;
        const observed = await f.verification.inspectReview(binding, { messageId: out.message.message_id }) as any;
        expect(observed.observation.revision).toBe(out.message.payload.input.sourceRevision);
        expect(observed.observation.diff).toContain("double.cjs");
        const completed = await f.verification.completeReview(binding, { reviewId: observed.reviewId, summary: "Reviewed the exact committed implementation and immutable acceptance test", criteria: observed.context.definition.configuration.criterionIds.map((criterionId: string) => ({ criterionId, passed: true, summary: "The observed committed diff doubles the input and retains the spec-derived acceptance test" })) });
        await f.runtime.receiveHerdr(f.envelope("review.verdict", completed.result, { causation_id: out.message.message_id,
          sender: { role: binding.role, agent_id: binding.agentId, pane_id: binding.paneId }, artifact_references: [completed.artifact] }));
      }
      if (!done) await new Promise(resolve => setTimeout(resolve, 5));
    }
    await ticking;
  }
  return { ...f, command, developer, qa, development, original, testPath, sourcePath, testSource, currentHead, edit, commit, addTests, request, measure, tickWithReviews };
}

// AgenticJournal persists changes under Linux flock; these integration cases exercise that boundary.
describe.skipIf((await probeBehavioralSandbox()).status !== "ready")("connected independent policy phases", () => {
  it("freezes Red test files bound by an automatic runner profile exactly like owner test files", async () => {
    const f = await connectedPhaseFixture("node_tap", 3, true);
    await f.addTests();
    expect((await f.measure("red")).status).toBe("failed");
    expect(await f.runtime.authorizeImplementation("run-1", "implement")).toMatchObject({ authorized: true });
    await expect(f.edit(f.testPath)).rejects.toThrow("frozen");
  });
  it.each(["node_tap", "vitest_json"] as const)("%s follows real Red/Green/Refactor through QA, borrowed notices, gates and human delivery", async reporter => {
    const f = await connectedPhaseFixture(reporter);
    expect((await f.dossier()).strategy.tddDecision.mode).toBe("required");
    await expect(f.edit(f.sourcePath)).rejects.toThrow("Red evidence");
    await expect(f.runtime.authorizeImplementation("run-1", "implement")).rejects.toThrow("Red evidence");
    await expect(f.edit("guide.md")).rejects.toThrow("outside the accepted task ownership");
    await f.addTests(); const redRevision = f.currentHead();
    const red = await f.measure("red"); expect(red.status).toBe("failed");
    expect(await f.runtime.authorizeImplementation("run-1", "implement")).toMatchObject({ authorized: true });
    await expect(f.edit(f.testPath)).rejects.toThrow("frozen");
    await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), "module.exports=x=>x*2;\n");
    await writeFile(join(f.developer.worktreePath!, f.testPath), f.testSource + "// mixed test change\n");
    await expect(f.commit("mixed source and frozen tests")).rejects.toThrow("frozen");
    expect(f.currentHead()).toBe(redRevision); expect(git(f.developer.worktreePath!, "diff", "--cached", "--name-only")).toBe("");
    await writeFile(join(f.developer.worktreePath!, f.testPath), f.testSource);
    const greenCommit = await f.commit("Green: double the input") as any;
    expect(greenCommit).toMatchObject({ committed: true });
    expect(git(f.developer.worktreePath!, "show", "--format=", "--name-only", greenCommit.head)).toBe(f.sourcePath);
    const feedback = await f.development.check(f.developer, { runId: "run-1", taskId: "implement" }) as any;
    expect(feedback.independentAcceptanceEvidence).toBe(false); expect(feedback.measurements[0].failed).toBe(0);
    expect((await f.dossier()).strategy.metadata.tddEvidence).toHaveLength(1);
    const green = await f.measure("green"); expect(green.status).toBe("passed");
    await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), "const double=x=>2*x; module.exports=double;\n"); await f.commit("Refactor: name the doubling operation");
    const refactor = await f.measure("refactor"); expect(refactor.status).toBe("passed");
    for (const receipt of [red, green, refactor]) {
      expect(await f.receipts.authenticateEvidence(receipt)).toBe(true);
      expect((receipt.metadata!.conditionalTdd as any).testRevision).toBe(redRevision);
      expect((receipt.metadata!.conditionalTdd as any).testNames).toEqual([phaseTestName]);
      expect(unwrap(await f.ports.artifactStore.resolve(receipt.evidenceArtifacts[0]!.artifactId))).toEqual(receipt.evidenceArtifacts[0]);
    }
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "task.assignment")).toHaveLength(1);
    const developerTurns = f.transport.sentRequests.filter(request => request.role === "developer");
    expect(developerTurns).toHaveLength(4); expect(new Set(developerTurns.map(request => request.target.paneId))).toEqual(new Set([f.developer.paneId]));
    await f.submit("implement", null); await f.tickWithReviews(); await f.tickWithReviews();
    const run = await f.inspect();
    expect(run.tasks[0].cycle.status).toBe("passed"); expect(run.workflowCycle.status).toBe("passed");
    expect(run.workflowCycle.history[0].metadata.integrationCommitHash).toBe(run.workflowChange.headCommitHash);
    expect(f.calls.map(context => (context.input as any).scope)).toEqual(["task", "workflow"]);
    expect((f.calls[0]!.input as any).sourceRevision).toBe(f.currentHead());
    expect((f.calls[1]!.input as any).sourceRevision).toBe(run.workflowChange.headCommitHash);
    expect(run.status).toBe("awaiting_approval"); expect(run.approvalKind).toBe("delivery");
    await f.approve(); expect((await f.inspect()).status).toBe("completed");
    expect(unwrap(await f.ports.runStore.get("run-1"))!.snapshot.status).toBe("succeeded");
    expect(git(f.repository, "branch", "--show-current")).toBe("main");
  }, 120_000);

  it("failed Green measurements reject the same revision and escalate at the configured bound", async () => {
    const f = await connectedPhaseFixture("node_tap", 2);
    await f.addTests(); await f.measure("red");
    for (let failureNumber = 1; failureNumber <= 2; failureNumber++) {
      await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), `module.exports=x=>x+${failureNumber + 2};\n`); await f.commit(`Incomplete repair ${failureNumber}`);
      const { pending, head } = await f.request("green");
      let failure: unknown;
      try { await f.verification.behavioralEvidence(f.qa, { runId: "run-1", taskId: "implement", phase: "green" }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(HostBehavioralFailure);
      const result = await f.runtime.recordPhaseFailure(f.qa, pending.message.message_id, String(failure), true, (failure as HostBehavioralFailure).evidence) as any;
      expect(result).toMatchObject({ maxIterations: 2 });
      expect((await f.dossier()).strategy.metadata.tddEvidence).toHaveLength(1);
      if (failureNumber === 1) {
        await expect(f.runtime.requestPhaseVerification(f.developer, "run-1", "implement", "green", head)).rejects.toThrow("already failed the phase");
        await f.runtime.flushOutbound();
        const notice = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.payload.kind === "policy_phase_outcome" && out.message.payload.phase === "green");
        expect(notice.status).toBe("accepted"); expect(notice.parentAssignmentId).toBe(f.original.message.message_id);
      } else expect(result.status).toBe("escalated");
    }
    expect((await f.inspect()).error).toContain("repair limit exhausted");
    await expect(f.edit(f.sourcePath)).rejects.toThrow();
    const before = f.transport.sentRequests.filter(request => ["developer", "qa"].includes(request.role)).length; await f.runtime.tick();
    expect(f.transport.sentRequests.filter(request => ["developer", "qa"].includes(request.role))).toHaveLength(before);
    const history = (await f.runtime.inspect() as any).outbound.filter((out: any) => out.error?.startsWith("policy_phase_failed:"));
    expect(history).toHaveLength(2); expect(history.every((out: any) => out.status === "released" && out.phaseFailureEvidence?.trust === "stored")).toBe(true);
  }, 120_000);
});


describe("Runtime task activity log integration", () => {
  it("records committed admission, assignment and status transitions without tick polling noise", async () => {
    const f = await fixture();
    const activityPath = join(f.root, "task-activity.jsonl");
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    const read = async () => (await readFile(activityPath, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const initial = await read();
    expect(initial.some(item => item.kind === "admission" && item.runId === "run-1")).toBe(true);
    expect(initial.some(item => item.kind === "assignment" && item.action === "task.assignment" && item.taskId === "implement")).toBe(true);
    const count = initial.length;
    await f.runtime.tick();
    const afterDeliveryReconcile = await read();
    expect(afterDeliveryReconcile.length).toBeLessThanOrEqual(count + 2);
    await f.runtime.tick();
    const afterQuietTick = await read();
    expect(afterQuietTick.map((item: any) => item.action).slice(afterDeliveryReconcile.length)).toEqual([]);
    const dispatched = (await f.runtime.inspect() as any).outbound.find((item: any) => item.message.type === "task.assignment");
    expect(dispatched.status).toBe("accepted");
  });

  it("provides native tool diagnostic assignment context without acquiring Runtime.inspect", async () => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const assigned = (await f.runtime.inspect() as any).outbound.find((item: any) => item.message.type === "task.assignment");
    const developer = f.panes.bindings.find(binding => binding.paneId === assigned.handle.target.paneId)!;
    const inspect = vi.spyOn(f.runtime, "inspect");
    expect(f.runtime.taskLogAssignmentContext(developer)).toMatchObject({ runId: "run-1", taskId: "implement", attemptId: assigned.attemptId });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("records accepted task specifications and newly accepted conditional TDD evidence phases", async () => {
    const f = await fixture({ tdd: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const read = async () => (await readFile(join(f.root, "task-activity.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    expect(await read()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "specification", action: "task_specification_accepted", runId: "run-1", taskId: "implement", outcome: expect.stringContaining("required") })
    ]));
    await f.runtime.tick();
    await f.evidence("implement", "red"); await f.evidence("implement", "green"); await f.evidence("implement", "refactor");
    const entries = await read();
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tdd", action: "tdd_evidence_accepted:red", runId: "run-1", taskId: "implement" }),
      expect.objectContaining({ kind: "tdd", action: "tdd_evidence_accepted:green", runId: "run-1", taskId: "implement" }),
      expect.objectContaining({ kind: "tdd", action: "tdd_evidence_accepted:refactor", runId: "run-1", taskId: "implement" })
    ]));
    expect(JSON.stringify(entries.filter((item: any) => item.kind === "tdd"))).not.toContain("verificationId");
    expect(JSON.stringify(entries.filter((item: any) => item.kind === "tdd"))).not.toContain("evidenceArtifacts");
  });
});

describe.skipIf(process.platform !== "linux")("P19 integrated Agentic SDLC", () => {
  it("loads a runner added after composition and ignores unselected language profiles when freezing a task plan", async () => {
    const f = await fixture({ tdd: true, dynamicGate: true });
    f.ports.behavioralChecks = () => [{ ...f.ports.taskChecks.find(check => check.id === "regression")!, id: "unselected-polyglot",
      metadata: { bindAcceptedCriteria: true, bindMethodTestNames: true },
      configuration: { kind: "deterministic", method: "integration_test", command: "auto:integration:go", criterionIds: [], testNames: [], role: "quality_gate", levels: ["integration"] } }];
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement", "red"); await f.evidence("implement", "green"); await f.evidence("implement", "refactor");
    f.enableDynamicGate(); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
    const run = await f.inspect(); expect(run.tasks[0].cycle.status).toBe("passed");
    expect(run.tasks[0].verificationPlan.checks.some((check: any) => check.id === "unselected-polyglot")).toBe(false);
    expect(f.calls.some(context => context.definition.id === "regression")).toBe(true);
  });

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
    expect(f.transport.sentRequests.some(req => req.role === "conversation")).toBe(false);
    expect(f.transport.sentRequests.some(req => req.role === "developer")).toBe(true);
    expect(f.conversationInbox.length).toBeGreaterThan(0);
    const delivered = f.conversationInbox.length;
    f.panes.busy.delete("conversation"); const restarted = f.restart(); await restarted.tick();
    expect(f.conversationInbox).toHaveLength(delivered);
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
  });
  it("delivers to Conversation outside the journal lock, so a Gateway that re-enters Runtime cannot deadlock", async () => {
    const f = await fixture();
    // A busy Gateway drains a queued user turn whose handoff enqueues back into Runtime during delivery.
    f.reenterOnConversationDelivery(() => f.runtime.inspect());
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([f.runtime.tick(), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Conversation delivery deadlocked")), 10_000); })])
      .finally(() => clearTimeout(timer));
    expect(f.conversationInbox.length).toBeGreaterThan(0);
    const outbound = ((await f.runtime.inspect()) as any).outbound.filter((out: any) => out.message.recipient.role === "conversation");
    expect(outbound.length).toBeGreaterThan(0);
    expect(outbound.every((out: any) => out.status === "delivered")).toBe(true);
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
  it("replays a committed trusted approval for the same hook message instead of reapplying or routing it to Chat", async () => {
    const f = await fixture({ humanApproval: true });
    const receipts = new HostReceiptJournal(join(f.root, "host-receipts"), f.repository, "session-1");
    f.ports.authorizeHuman = decision => receipts.authenticateHuman(decision);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const manifest = unwrap(await f.panes.getManifest()), binding = f.panes.bindings.find(pane => pane.role === "conversation")!;
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest, contextDirectory: join(f.root, "conversation"),
      onHumanDecision: decision => receipts.recordHuman(decision, { origin: "UserPromptSubmit", binding, nativeSessionId: binding.session!.value,
        conversationSessionId: "session-1", userId: "human-1", messageId: "user-approve", promptDigest: createHash("sha256").update("approve").digest("hex") }) });
    const approval = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "approval.request").message;
    await chat.receiveHerdr({ ...approval, sender: { role: "coordinator", agent_id: "coordinator" }, recipient: { role: "conversation" } });
    const input = { sessionId: "session-1", messageId: "user-approve", content: "approve",
      provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: binding.paneId, channel: "herdr_attach" } };
    const first = await chat.handleTrustedApproval(input) as any;
    expect(first).toMatchObject({ ok: true, value: { recognizedIntent: "approval_response", queuedBecauseBusy: false } });
    const decisions = () => f.runtime.inspect().then((state: any) => state.outbound.filter((out: any) => out.message.type === "approval.decision"));
    const before = await decisions();
    expect(await chat.handleTrustedApproval(input)).toMatchObject({ ok: true, value: { recognizedIntent: "approval_response",
      correlationId: first.value.correlationId, userMessage: { messageId: "user-approve" }, agentReply: first.value.agentReply } });
    expect(await decisions()).toEqual(before);
    await expect(chat.handleTrustedApproval({ ...input, content: "reject" })).rejects.toThrow("conflicts");
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
    // Observe the transport event instead of racing real Git/fsync work against
    // a 2.5-second polling budget. Runtime inspection then queues behind receipt
    // persistence and must return while the background tick awaits the verdict.
    let delivered!: (request: AgentRequest) => void;
    const delivery = new Promise<AgentRequest>(resolve => { delivered = resolve; });
    const send = f.transport.send.bind(f.transport);
    vi.spyOn(f.transport, "send").mockImplementation(async (request, options) => {
      const receipt = await send(request, options);
      if (JSON.parse(request.instruction).type === "verification.requested") delivered(request);
      return receipt;
    });
    const tools = new CoordinatorTools(f.runtime);
    expect(await tools.invoke("tick", {}, { role: "coordinator" })).toMatchObject({ scheduled: true });
    const ticking = tools.drain();
    ticking.catch(() => undefined);
    try {
      const request = await Promise.race([delivery, ticking.then(() => {
        throw new Error("Runtime tick completed before delivering the Reviewer request");
      })]);
      const state = await f.runtime.inspect() as any;
      expect(state.outbound.some((out: any) => out.request?.requestId === request.requestId && out.status === "accepted")).toBe(true);
      expect(await tools.invoke("tick_status", {}, { role: "coordinator" })).toMatchObject({ running: true });
      const message = JSON.parse(request.instruction);
      const result = unwrap(await f.localReview(message.payload));
      await f.runtime.receiveHerdr(f.envelope("review.verdict", result, { sender: { role: "reviewer", agent_id: request.target.agentId, pane_id: request.target.paneId }, causation_id: message.message_id }));
      await ticking; expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
    } catch (error) { await ticking; throw error; }
  });
  it("re-requests a Reviewer check after a late verdict instead of reusing evidence that predates the retry", async () => {
    const f = await fixture({ remoteReview: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const definition = (f.ports as any).taskChecks.find((check: any) => check.id === "review");
    const context = { runId: "run-1", taskId: "implement", attemptId: "attempt-review-retry", artifacts: [], input: { scope: "task" },
      definition: { ...definition, timeout: { ...definition.timeout, executionTimeoutMs: 20_000 } } };
    const gate = f.runtime.herdrQualityGate("review");
    const requests = async () => ((await f.runtime.inspect()) as any).outbound.filter((out: any) => out.message.type === "verification.requested");
    const verdict = (request: any) => f.envelope("review.verdict", { gateId: "review", runId: "run-1", taskId: "implement", evaluationId: randomUUID(),
      status: "passed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString() },
      { sender: { role: "reviewer", agent_id: request.handle.target.agentId, pane_id: request.handle.target.paneId }, causation_id: request.message.message_id });
    // First evaluation gives up (timeout/abort) while the Reviewer is still working; its verdict lands afterwards.
    const first = new AbortController();
    const abandoned = gate.evaluate(context as any, { signal: first.signal });
    await expect.poll(async () => (await requests()).filter((out: any) => out.handle).length, { timeout: 10_000 }).toBe(1);
    first.abort(); await expect(abandoned).rejects.toThrow(/aborted/);
    const [late] = await requests();
    await f.runtime.receiveHerdr(verdict(late));
    // The retry cannot reuse that verdict (it predates the new execution window), so it asks again under a new deterministic key.
    const retried = gate.evaluate(context as any);
    await expect.poll(async () => (await requests()).filter((out: any) => out.handle).length, { timeout: 10_000 }).toBe(2);
    const fresh = (await requests()).find((out: any) => out.message.message_id !== late.message.message_id);
    await f.runtime.receiveHerdr(verdict(fresh));
    await expect(retried).resolves.toMatchObject({ ok: true, value: { gateId: "review", status: "passed" } });
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
  describe("parallel task approval recovery", () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => {
      f = await fixture({ parallel: true });
      f.def.tasks.forEach(task => { task.requiresApproval = true; });
      await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
      await f.evidence("implement"); await f.evidence("other"); await f.submit(); await f.submit("other", "second file\n");
      await f.runtime.tick();
    });
    it("preserves each parallel task approval across restart before workflow delivery", async () => {
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
  });
  it("defers an authenticated native binding while paused and verifies it once after resume without task success", async () => {
    const f = await fixture();
    f.ports.preflightRoleCapabilities = async (binding, required) => {
      expect(unwrap(await f.panes.getRoleBinding(binding.role))?.bindingId).toBe(binding.bindingId);
      for (const capability of required) expect(f.ports.roleCapabilities[binding.role]).toContain(capability);
    };
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const source = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "task.assignment");
    const handle = source.handle;
    const receipt = createSignedBindingReceipt({ receiptId: "paused-binding", issuerId: "native-test-host", handle,
      observedAt: new Date().toISOString(), privateKey: f.privateKey,
      correlation: handle.correlation }); // The fixture transport already verified this exact token; never re-correlate it.
    const signed = f.envelope("execution.receipt", receipt, { message_id: "paused-binding-envelope", idempotency_key: "paused-binding-key",
      causation_id: source.message.message_id, sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId } });
    const placeholder = RoleMessageSchema.parse({ ...signed, payload: { ...receipt, signature: { algorithm: "ed25519", value: Buffer.alloc(64).toString("base64") } } });
    const binding = f.panes.bindings.find(pane => pane.paneId === handle.target.paneId)!;
    await f.runtime.reportRoleToolFailure(binding, { ...signed, artifact_references: undefined }, "artifact_references: Required");
    const actionId = (await f.inspect()).pendingAction.actionId;
    await f.runtime.recordNativeDeliveryIntent(placeholder, "paused-binding-operation");
    expect(await f.runtime.receiveHerdr(signed)).toMatchObject({ received: true, deferred: true });
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!.bindingVerification).toBeUndefined();
    expect((await f.inspect()).status).toBe("escalated");
    await f.runtime.reportUncertainNativeDelivery(placeholder, "paused-binding-operation", "Stale native ACK observation");
    expect((await f.inspect()).nativeDeliveries).toEqual([]);
    await f.runtime.resumeBlockedRun("run-1", actionId);
    await f.runtime.recoverMissingCoordinatorWakeups(); await f.runtime.recoverMissingCoordinatorWakeups();
    const task = unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!;
    expect(task.status).toBe("running"); expect(task.bindingVerification?.receipt.receiptId).toBe("paused-binding");
    expect((await f.inspect()).tasks[0].result).toBeUndefined();
    expect(f.transport.sentRequests.filter(request => request.role === "developer")).toHaveLength(1);
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
  it("restores transport authentication only for the exact persisted implementation receipt", async () => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    const message = (await f.runtime.inspect() as any).inbox.find((item: any) => item.message.type === "implementation.submitted").message;
    const journal = (f.runtime as any).journal;
    await journal.exclusive(async (state: any, save: any) => {
      state.inbox.find((item: any) => item.message.message_id === message.message_id).status = "received";
      await save();
    });
    const { authenticateNativeHerdrMessage } = await import("../../src/agentic/herdr-ingress.js");
    f.ports.authenticateResult = async (_result: any, _handle: any, input: RoleMessage) => authenticateNativeHerdrMessage(input);
    expect(await authenticateNativeHerdrMessage(message)).toBe(false);
    await f.restart().recoverMissingCoordinatorWakeups();
    expect((await f.runtime.inspect() as any).inbox.find((item: any) => item.message.message_id === message.message_id).status).toBe("applied");
    expect(await authenticateNativeHerdrMessage(message)).toBe(false);
  });

  it("never escalates Runtime-owned workflow verification on a Coordinator Stop or its startup replay", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    const verify = f.ports.policies.verification.verify.bind(f.ports.policies.verification);
    let entered!: () => void, release!: () => void;
    const inWorkflowVerification = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.ports.policies.verification, "verify").mockImplementation(async (...args) => {
      if (args[0].taskId === "workflow-verification") { entered(); await gate; }
      return verify(...args);
    });
    const ticking = (async () => { for (let i = 0; i < 4 && !(await f.inspect()).workflowCycle?.status?.match(/passed/); i++) await f.runtime.tick(); })();
    await inWorkflowVerification;
    expect(await f.inspect()).toMatchObject({ status: "verifying", workflowVerificationPending: true });
    const message = f.envelope("delegation.request", (await f.inspect()).delegation, { message_id: "turn-during-verification", idempotency_key: "turn-during-verification" });
    await f.runtime.queueHerdr(message); await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(p => p.role === "coordinator")!;
    await f.runtime.coordinatorTurnStopped(message, binding);
    await f.runtime.coordinatorTurnStopped(message, binding); // host startup replays every durable Stop receipt
    expect((await f.inspect()).status).toBe("verifying");
    expect((await f.inspect()).pendingAction).toBeUndefined();
    expect((await f.runtime.watchdogSnapshot("session-1"))[0]).toMatchObject({ runtimeWork: true });
    await f.runtime.reportRunStalled("run-1", "run-1@long-check"); // a check suite longer than the stall window is not a stall
    expect((await f.inspect()).status).toBe("verifying");
    release(); await ticking;
    expect((await f.inspect()).workflowCycle.status).toBe("passed");
    await f.runtime.coordinatorTurnStopped(message, binding); // stale replay after the Runtime-owned phase
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.payload.kind === "coordinator_no_response")).toEqual([]);
    expect((await f.inspect()).status).not.toBe("escalated");
  });
  it("retains a verification outcome that finishes while the run is paused and applies it once after resume", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    (f.ports as any).preflightRoleCapabilities = async () => undefined;
    const journal = (f.runtime as any).journal;
    const actionId = `next-${digest(["run-1", "pause-source"])}`;
    const verify = f.ports.policies.verification.verify.bind(f.ports.policies.verification);
    let calls = 0;
    vi.spyOn(f.ports.policies.verification, "verify").mockImplementation(async (...args) => {
      if (args[0].taskId === "implement") {
        calls++;
        // Another role's capability blocker pauses the run while Runtime is still verifying.
        await journal.exclusive(async (state: any, save: any) => {
          const run = state.runs.find((item: any) => item.runId === "run-1");
          run.status = "escalated"; run.error = "Coordinator blocked: capability";
          run.pendingAction = { actionId, kind: "resume_coordinator", owner: "coordinator", reason: "capability", sourceMessageId: "pause-source",
            createdAt: new Date().toISOString(), state: "pending", previousStatus: "verifying", resumeAttempts: 0, recovery: "manual" };
          await save();
        });
      }
      return verify(...args);
    });
    await f.runtime.tick(); await f.runtime.tick();
    const pending = async () => journal.exclusive(async (state: any) => state.pendingVerifications.length);
    expect(await f.inspect()).toMatchObject({ status: "escalated", tasks: [expect.objectContaining({ verificationPending: true })] });
    expect((await f.inspect()).tasks[0].cycle.status).not.toBe("passed");
    expect(await pending()).toBe(1);
    await expect(f.submit("implement", null)).rejects.toThrow(new RegExp(`paused awaiting resume of action ${actionId}; retry this same call after the run resumes`));
    await f.runtime.resumeBlockedRun("run-1", actionId);
    await f.runtime.tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
    expect(await pending()).toBe(0);
    expect(calls).toBe(1);
  });
  it("reruns a verification that failed while the run was paused once it is resumed", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    (f.ports as any).preflightRoleCapabilities = async () => undefined;
    const journal = (f.runtime as any).journal, actionId = `next-${digest(["run-1", "pause-source"])}`;
    const verify = f.ports.policies.verification.verify.bind(f.ports.policies.verification);
    let fail = true;
    vi.spyOn(f.ports.policies.verification, "verify").mockImplementation(async (...args) => {
      if (fail && args[0].taskId === "implement") {
        fail = false;
        await journal.exclusive(async (state: any, save: any) => {
          const run = state.runs.find((item: any) => item.runId === "run-1");
          run.status = "escalated";
          run.pendingAction = { actionId, kind: "resume_coordinator", owner: "coordinator", reason: "capability", sourceMessageId: "pause-source",
            createdAt: new Date().toISOString(), state: "pending", previousStatus: "verifying", resumeAttempts: 0, recovery: "manual" };
          await save();
        });
        throw new Error("Injected verifier interruption");
      }
      return verify(...args);
    });
    await f.runtime.tick();
    expect((await f.inspect()).tasks[0].verificationPending).toBe(false);
    await f.runtime.resumeBlockedRun("run-1", actionId);
    await f.runtime.tick(); await f.runtime.tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
  });

  it("recovers a verifier job lost after pending persistence and before invocation", async () => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick(); await f.evidence("implement"); await f.submit();
    const journal = (f.runtime as any).journal;
    const exclusive = journal.exclusive.bind(journal);
    let interrupted = false;
    const spy = vi.spyOn(journal, "exclusive").mockImplementation(async (action: any) => {
      const value = await exclusive(action);
      if (!interrupted && Array.isArray(value) && value.some(item => item?.runId === "run-1" && item.plan && item.cycle)) {
        interrupted = true;
        throw new Error("Injected crash before verifier invocation");
      }
      return value;
    });
    await expect(f.runtime.tick()).rejects.toThrow("Injected crash before verifier invocation");
    spy.mockRestore();
    expect((await f.inspect()).tasks[0].verificationPending).toBe(true);
    const priorCalls = f.calls.length;
    await f.restart().tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
    expect(f.calls.length).toBeGreaterThan(priorCalls);
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "task.assignment")).toHaveLength(1);
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

// This recovery path acquires AgenticJournal.exclusive, which uses Linux flock.
it.skipIf(process.platform !== "linux")("recovers the exact failed phase after a crash following lease release without duplicating repair notices", async () => {
  const f = await fixture({ tdd: true });
  f.ports.roleCapabilities.qa = ["verification", "testing", "repository.read"];
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


describe("Coordinator no-response host observations", () => {
  async function delivered(intake = false) {
    const f = await fixture({ intake });
    const message = f.envelope("delegation.request", { schemaVersion: 2, delegationId: "delegation-1", messageId: "intake-1", correlationId: "correlation-1",
      sessionId: "session-1", runId: "run-1", requestedBy: "conversation", targetRole: "coordinator", title: "Plan change", objective: "Plan change",
      sddLevel: "lightweight", specificationId: f.spec.specId, acceptanceCriteria: f.spec.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: new Date().toISOString(), idempotencyKey: "intake-1" },
      { message_id: "intake-1", idempotency_key: "intake-1" });
    await f.runtime.queueHerdr(message); await f.runtime.flushOutbound();
    return { ...f, message, binding: f.panes.bindings.find(p => p.role === "coordinator")! };
  }
  it("reports a legacy delivery whose journal has neither intake nor native ingress", async () => {
    const f = await delivered();
    await (f.runtime as any).journal.exclusive(async (state: any, save: any) => { state.runs = []; await save(); });
    await f.runtime.coordinatorTurnStopped(f.message, f.binding);
    const state = await f.runtime.inspect() as any;
    expect(state.runs).toEqual([]); expect(state.inbox).toEqual([]);
    const feedback = state.outbound.find((out: any) => out.message.type === "conversation.progress");
    expect(feedback.message).toMatchObject({ correlation_id: "correlation-1", causation_id: "intake-1", run_id: "run-1", recipient: { role: "conversation" },
      payload: { kind: "coordinator_no_response", headline: "Coordinator turn ended without a structured response", blockageReason: expect.stringContaining("no durable ingress") } });
    expect(feedback.message.payload).not.toHaveProperty("verified");
    await f.restart().coordinatorTurnStopped(f.message, f.binding);
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "conversation.progress")).toHaveLength(1);
    await f.runtime.flushOutbound();
    expect(f.conversationInbox.some(message => (message.payload as any).kind === "coordinator_no_response")).toBe(true);
    expect(f.transport.sentRequests.some(call => call.role === "conversation")).toBe(false);
  });
  it("rejects untrusted envelopes and foreign pane/native sessions", async () => {
    const f = await delivered();
    for (const message of [{ ...f.message, payload: { forged: true } }, { ...f.message, message_id: "forged" }])
      await expect(f.runtime.coordinatorTurnStopped(message, f.binding)).rejects.toThrow("exact Runtime outbox");
    for (const binding of [{ ...f.binding, paneId: "other" }, { ...f.binding, session: { ...f.binding.session!, value: "other" } }])
      await expect(f.runtime.coordinatorTurnStopped(f.message, binding)).rejects.toThrow("exact Runtime outbox");
  });
  it("escalates an unanswered intake with an actionable next step after automatic delegation acceptance", async () => {
    const f = await delivered(); await f.runtime.receiveHerdr(f.message);
    await f.runtime.coordinatorTurnStopped(f.message, f.binding);
    expect((await f.runtime.inspect("run-1") as any)).toMatchObject({ status: "escalated", coreCreated: false, pendingAction: { kind: "resume_coordinator", owner: "coordinator" } });
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.payload.kind === "coordinator_no_response")).toHaveLength(1);
  });
  it("does not treat queued progress as a business next action when the Coordinator stops", async () => {
    const f = await delivered(); await f.runtime.receiveHerdr(f.message);
    const reporting = f.runtime.reportProgress("run-1", "Planning the objective");
    await f.runtime.coordinatorTurnStopped(f.message, f.binding); await reporting;
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.payload.kind === "coordinator_no_response")).toHaveLength(1);
  });
});


describe("Coordinator Stop delivery to Conversation", () => {
  it("presents host blockage to the real Conversation Gateway without completing a workflow", async () => {
    const f = await fixture({ intake: false }), contextDirectory = join(f.root, "stopped-conversation");
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest: unwrap(await f.panes.getManifest()), contextDirectory });
    const turn = await chat.handleUserTurn({ sessionId: "session-1", content: "Triển khai tính năng xác thực JWT HS256 trong packages/auth với thời hạn token 15 phút và unit test", provenance: { origin: "user", authenticatedUser: true } }) as any;
    expect(turn.value.recognizedIntent).toBe("workflow_request");
    await f.runtime.flushOutbound();
    const delegation = JSON.parse(f.transport.sentRequests.find(request => request.role === "coordinator")!.instruction);
    await f.runtime.coordinatorTurnStopped(delegation, f.panes.bindings.find(p => p.role === "coordinator")!);
    await f.runtime.flushOutbound();
    const notice = f.conversationInbox.find(message => (message.payload as any).kind === "coordinator_no_response")!;
    expect((await chat.receiveHerdr(notice) as any).ok).toBe(true);
    const module = await import("../../../conversation/dist/index.js");
    const context = unwrap(await new module.FileConversationContextStore(contextDirectory).load("session-1"))!;
    expect(Object.values(context.workflows)[0]).toMatchObject({ completedVerified: false, blockedReason: expect.stringContaining("no durable ingress") });
    expect(context.session.status).toBe("reporting_progress");
    expect((await f.runtime.inspect() as any).runs).toEqual([expect.objectContaining({ status: "escalated", coreCreated: false })]);
  });
  it("does not let progress from an earlier delegation hide an unanswered later turn", async () => {
    const f = await fixture(); await f.runtime.reportProgress("run-1", "Previous turn progress");
    const message = f.envelope("delegation.request", (await f.inspect()).delegation, { message_id: "later-turn", idempotency_key: "later-turn" });
    await f.runtime.queueHerdr(message); await f.runtime.flushOutbound();
    await f.runtime.coordinatorTurnStopped(message, f.panes.bindings.find(p => p.role === "coordinator")!);
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.payload.kind === "coordinator_no_response")).toHaveLength(1);
  });
  it("preserves pending user decisions at Stop", async () => {
    const f = await fixture();
    const message = f.envelope("delegation.request", (await f.inspect()).delegation, { message_id: "intake-1", idempotency_key: "intake-1" });
    await f.runtime.queueHerdr(message); await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(p => p.role === "coordinator")!;
    await f.runtime.requestUserDecision(binding, "coordinator", { runId: "run-1", taskId: "planning", question: "Which design?", options: ["A", "B"] });
    const before = await f.inspect(); await f.runtime.coordinatorTurnStopped(message, binding);
    expect(await f.inspect()).toEqual(before);
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.payload.kind === "coordinator_no_response")).toEqual([]);
  });
});

describe("Specialist reply wake-up and failure visibility", () => {
  const specialistReply = (f: Awaited<ReturnType<typeof fixture>>, request: any, extra: Record<string, unknown> = {}) =>
    f.envelope("spec.draft", { status: "completed", summary: "Impact analysis" }, { causation_id: request.message_id,
      sender: { role: "architect", agent_id: "architect", pane_id: "pane-architect" }, recipient: { role: "coordinator" }, ...extra });
  async function delegated() {
    const f = await fixture();
    const queued = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]) as any;
    await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.some(request => request.role === "architect")).toBe(true);
    return { f, queued };
  }
  const sentTo = (f: Awaited<ReturnType<typeof fixture>>, role: string) => f.transport.sentRequests.filter(request => request.role === role).map(request => JSON.parse(request.instruction));

  it("wakes the Coordinator through Herdr once the Architect reply is applied (run no longer stalls in specifying)", async () => {
    const { f, queued } = await delegated();
    expect(sentTo(f, "coordinator")).toEqual([]);
    const reply = specialistReply(f, queued);
    await f.runtime.receiveHerdr(reply);
    expect((await f.inspect()).status).toBe("specifying");
    await f.runtime.flushOutbound();
    const notices = sentTo(f, "coordinator");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "task.status", sender: { role: "runtime" }, recipient: { role: "coordinator" }, causation_id: expect.any(String),
      payload: { kind: "specialist_result_ready", fromRole: "architect", messageType: "spec.draft", result: { summary: "Impact analysis" } } });
    await f.runtime.receiveHerdr(reply); // duplicate ingress never duplicates the wake-up
    await f.runtime.flushOutbound();
    expect(sentTo(f, "coordinator")).toHaveLength(1);
  });

  it("keeps the wake-up queued while the Coordinator is busy instead of dropping it", async () => {
    const { f, queued } = await delegated();
    f.panes.busy.add("coordinator");
    await f.runtime.receiveHerdr(specialistReply(f, queued)); await f.runtime.flushOutbound();
    expect(sentTo(f, "coordinator")).toEqual([]);
    f.panes.busy.delete("coordinator"); await f.runtime.flushOutbound();
    expect(sentTo(f, "coordinator")).toHaveLength(1);
  });

  it("reports a rejected inbound specialist message to Conversation with a concrete reason", async () => {
    const { f, queued } = await delegated();
    const reply = specialistReply(f, queued);
    await f.runtime.reportInboundFailure(reply, "Transport sender binding unavailable");
    await f.runtime.reportInboundFailure(reply, "Transport sender binding unavailable"); // idempotent
    await f.runtime.flushOutbound();
    const notices = f.conversationInbox.filter(message => (message.payload as any).kind === "delivery_failure").map(message => message as any);
    expect(notices).toHaveLength(1);
    expect(notices[0].payload.blockageReason).toContain("Transport sender binding unavailable");
    expect(notices[0].payload.blockageReason).toContain("architect");
    expect(notices[0].run_id).toBe("run-1");
  });

  it("surfaces a stuck outbound delivery (no recipient pane) to Conversation instead of staying silent", async () => {
    const { f } = await delegated();
    f.panes.bindings.splice(f.panes.bindings.findIndex(p => p.role === "planner"), 1);
    const out = f.envelope("task.status", { kind: "probe" }, { sender: { role: "runtime" }, recipient: { role: "planner" } });
    await f.runtime.queueHerdr(out); await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const notices = f.conversationInbox.filter(message => (message.payload as any).kind === "delivery_failure").map(message => message as any);
    expect(notices).toHaveLength(1);
    expect(notices[0].payload.blockageReason).toContain("Recipient pane unavailable");
  });
});

describe("Runtime Stop and uncertain delivery notices", () => {
  it("specialistTurnStopped tells Conversation and wakes the Coordinator once while the assignment is unanswered", async () => {
    const f = await fixture();
    await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]);
    await f.runtime.flushOutbound();
    const architect = f.panes.bindings.find(p => p.role === "architect")!;
    await f.runtime.specialistTurnStopped(architect, "architect");
    await f.runtime.specialistTurnStopped(architect, "architect");
    await f.runtime.flushOutbound();
    expect(f.conversationInbox.filter(message => (message.payload as any).kind === "specialist_no_response")).toHaveLength(1);
    const wakes = f.transport.sentRequests.filter(request => request.role === "coordinator").map(request => JSON.parse(request.instruction));
    expect(wakes.filter(wake => wake.payload?.kind === "specialist_no_response")).toEqual([expect.objectContaining({
      type: "task.status", sender: { role: "runtime" }, payload: expect.objectContaining({ fromRole: "architect", reason: expect.stringContaining("architect") }) })]);
  });
  it("does not report a specialist that already answered its assignment", async () => {
    const f = await fixture();
    const queued = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]) as any;
    await f.runtime.flushOutbound();
    await f.runtime.receiveHerdr(f.envelope("spec.draft", { status: "completed", summary: "Impact analysis" }, { causation_id: queued.message_id,
      sender: { role: "architect", agent_id: "architect", pane_id: "pane-architect" }, recipient: { role: "coordinator" } }));
    await f.runtime.specialistTurnStopped(f.panes.bindings.find(p => p.role === "architect")!, "architect");
    await f.runtime.flushOutbound();
    expect(f.conversationInbox.filter(message => (message.payload as any).kind === "specialist_no_response")).toEqual([]);
  });
  it("does not report a specialist that stopped while waiting on a user decision it requested", async () => {
    const f = await fixture();
    await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]);
    await f.runtime.flushOutbound();
    const architect = f.panes.bindings.find(p => p.role === "architect")!;
    await f.runtime.requestUserDecision(architect, "architect", { runId: "run-1", taskId: "planning", question: "Which design?", options: ["A", "B"] });
    await f.runtime.specialistTurnStopped(architect, "architect");
    await f.runtime.flushOutbound();
    expect(f.conversationInbox.filter(message => (message.payload as any).kind === "specialist_no_response")).toEqual([]);
  });
  it("coordinatorStopWithoutResponse carries the reason and numbered options to Conversation", async () => {
    const f = await fixture();
    const message = f.envelope("delegation.request", { schemaVersion: 2, delegationId: "delegation-1", messageId: "intake-1", correlationId: "correlation-1",
      sessionId: "session-1", runId: "run-1", requestedBy: "conversation", targetRole: "coordinator", title: "Plan change", objective: "Plan change",
      sddLevel: "lightweight", specificationId: f.spec.specId, acceptanceCriteria: f.spec.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: new Date().toISOString(), idempotencyKey: "intake-2",
      metadata: { isRequirementChange: true, revision: 2 } }, { message_id: "intake-2", idempotency_key: "intake-2" });
    await f.runtime.queueHerdr(message); await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(p => p.role === "coordinator")!;
    await f.runtime.coordinatorStopWithoutResponse(message, binding, "Coordinator pane could not be matched: occupant changed");
    await f.runtime.flushOutbound();
    expect(f.conversationInbox.find(item => (item.payload as any).kind === "coordinator_no_response")?.payload).toMatchObject({
      reason: "Coordinator pane could not be matched: occupant changed", blockageReason: "Coordinator pane could not be matched: occupant changed",
      options: ["Khắc phục blocker rồi yêu cầu Coordinator tiếp tục run", "Hủy run"] });
  });
  it("reportUncertainNativeDelivery surfaces a delivery_failure with the operation id once, and never resends", async () => {
    const f = await fixture();
    await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]);
    await f.runtime.flushOutbound();
    const request = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "delegation.request").message;
    const sentBefore = f.transport.sentRequests.length;
    await f.runtime.reportUncertainNativeDelivery(request, "op-42", "Native delivery acknowledgement is uncertain");
    await f.runtime.reportUncertainNativeDelivery(request, "op-42", "Native delivery acknowledgement is uncertain");
    await f.runtime.flushOutbound();
    const failures = f.conversationInbox.filter(item => (item.payload as any).kind === "delivery_failure");
    expect(failures).toHaveLength(1);
    expect((failures[0]!.payload as any).blockageReason).toContain("op-42");
    expect(f.transport.sentRequests.slice(sentBefore).filter(request => request.role === "architect")).toEqual([]);
  });
});
