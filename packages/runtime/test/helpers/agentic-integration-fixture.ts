import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { copyIsolatedNodeDependencies } from "./isolated-node-dependencies.js";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { AgentResultSchema, ApprovalDecisionSchema, RoleMessageSchema, VerificationResultSchema, type PaneBinding, type Specification, type QualityGate, type QualityGateContext } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { createSignedBindingReceipt } from "../../src/agentic/receipt-host.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { loadAgenticPolicies, type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { DEFAULT_HOST_CHECKS, HostVerification } from "../../src/agentic/host-verification.js";
import { parseBehavioralCommands, type BehavioralCommand, type RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { TestRunnerSource } from "../../src/agentic/task-commands.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { digest } from "../../src/agentic/journal.js";
import type { RunRecord } from "../../src/agentic/journal.js";
import { reworkVerificationBinding } from "../../src/agentic/rework-causality.js";
import { FakeAgentTransport } from "./fake-transport.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

export const cleanups: (() => Promise<void>)[] = [];
export const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" } }).trim();

export class Panes implements PanePolicy {
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

export async function fixture(options: { dynamicGate?: boolean; parallel?: boolean; tdd?: boolean; complex?: boolean; failReview?: boolean; conflict?: boolean; intake?: boolean; remoteReview?: boolean; humanApproval?: boolean; behavioral?: BehavioralCommand; runners?: TestRunnerSource; highRisk?: boolean; readiness?: "ready" | "partial" } = {}) {
  if (options.highRisk) options = { ...options, complex: true };
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
  const integrityCalls: QualityGateContext[] = [];
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
    const run = config.kind === "review" && input.scope === "task"
      ? await runtime.inspect(context.runId) as unknown as RunRecord : undefined;
    const dossier = run?.tasks.find(task => task.taskId === context.taskId)?.reworkResolutions?.find(item => item.attemptId === context.attemptId);
    const reworkEvidence = dossier ? { reworkVerification: reworkVerificationBinding(dossier),
      findingVerdicts: dossier.reworkContext.findings.map(finding => ({findingId:finding.findingId,
        verdict: passed ? "confirmed" : "rejected", summary:"Scripted independent review of the exact submitted repair"})) } : {};
    return { ok: true, value: { gateId: context.definition.id, runId: context.runId, taskId: context.taskId!,
      evaluationId: randomUUID(), status: passed ? "passed" : "failed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString(),
      metadata: { ...reworkEvidence, verification: { schemaVersion: 2, checkId: check.id, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
        sourceRevision: input.sourceRevision, specFingerprint: input.specFingerprint, scope: input.scope,
        independentExecution: true, isolated: true, executorId: config.role === "reviewer" ? reviewerExecutorId : "independent-test-host", role: config.role, method: config.method,
        ...(config.command ? { command: config.command, exitCode: passed ? 0 : 1 } : {}), testNames: config.testNames,
        criteria: config.criterionIds.map((criterionId: string) => ({ criterionId, passed, summary: "Host independently checked the criterion" })), summary: "Independent check" } } } };
  } }));
  let runtime: AgenticWorkflowRuntime;
  const receipts = new HostReceiptJournal(join(root, "host-receipts"), repository, "session-1");
  const verification = new HostVerification(() => runtime, () => artifacts, receipts, options.runners ?? (options.behavioral ? [options.behavioral] : []), undefined, undefined, [], { suites: [] }, DEFAULT_HOST_CHECKS);
  if (options.behavioral) checks.splice(0, checks.length, ...DEFAULT_HOST_CHECKS, ...(options.highRisk ? [] : verification.behavioralChecks()));
  const actualGates = options.behavioral ? [
    ...DEFAULT_HOST_CHECKS.filter(check => (check.configuration as any).kind === "review").map(check => ({ id: check.id,
      evaluate: (...args: Parameters<QualityGate["evaluate"]>) => runtime.herdrQualityGate(check.id).evaluate(...args) })),
    verification.deterministicGate(), { id: "host-test-integrity", evaluate: async (context: QualityGateContext) => {
      integrityCalls.push(context); return verification.testIntegrityGate().evaluate(context);
    } }, ...verification.behavioralGates().map(gate => ({ id: gate.id, evaluate: async (context: QualityGateContext) => {
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
    ...(options.highRisk ? {
      validateTaskCommands: (specification, strategy, paths) => verification.assertTaskSupported(specification, strategy, paths),
      behavioralChecks: (specification, strategy, originalRevision) => verification.behavioralChecks(specification, strategy, originalRevision)
    } satisfies Partial<AgenticRuntimePorts> : {}),
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
  if (options.highRisk) {
    spec.riskLevel = "high";
    spec.testStrategy!.criterionMappings = [{ criterionId: "ac-1", testNames: [phaseTestName] }];
    (spec.metadata!.sdd as any).assessment.risk = "high";
    const assessment = spec.metadata!.conditionalTdd as any;
    assessment.riskClassification = "high"; assessment.changeImpact.securitySensitive = true;
    assessment.infrastructure = { readiness: options.readiness ?? "ready", commands: [
      { method: "integration_test", command: options.behavioral!.command, level: "integration" }, { method: "static_analysis", command: "auto:static" }
    ] };
  }
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
    const reworkContext = outbound.message.payload?.reworkContext as { reworkGeneration: number; findings: { findingId: string; code: string; message: string }[] } | undefined;
    const headRevision = git(path, "rev-parse", "HEAD");
    const findingResolutions = reworkContext?.findings.map(finding => ({
      findingId: finding.findingId,
      disposition: "addressed",
      rootCause: `Root cause for ${finding.code}: ${finding.message}`,
      sourceLocations: [{ path: file, startLine: 1, endLine: 1 }],
      repairSummary: `Updated ${file} to resolve ${finding.code} (${finding.findingId})`,
      discriminatingCheck: {
        kind: "quality_gate",
        target: finding.code,
        beforeOutcome: `Failed with ${finding.code}: ${finding.message}`,
        afterOutcome: `Resolved ${finding.code} in ${file} at ${headRevision}`
      },
      evidence: {
        sourceRevision: headRevision,
        reworkGeneration: reworkContext.reworkGeneration,
        summary: `Verified ${file} at revision ${headRevision} for generation ${reworkContext.reworkGeneration}`
      }
    }));
    const result = AgentResultSchema.parse({ requestId: handle.requestId, attemptId: handle.attemptId, runId: "run-1", taskId,
      executionId: handle.executionId, status: "succeeded", verification: { status: "verified", evidence: "Authenticated test-host result", correlation:
        unwrap(await ports.engine.getSnapshot("run-1"))!.tasks.find(task => task.taskId === taskId)!.bindingVerification?.receipt.correlation ?? handle.correlation },
      ...(findingResolutions ? { output: { findingResolutions } } : {}),
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
    calls, integrityCalls, localReview: (context: QualityGateContext) => gates.find(gate => gate.id === "review")!.evaluate(context), setFailReview: (value: boolean) => { failReview = value; },
    setReviewerExecutor: (value: string) => { reviewerExecutorId = value; },
    reopenStorage: () => { store.close(); store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") })); ports.runStore = store; },
    restart: () => { runtime = new AgenticWorkflowRuntime({ ...ports, engine: new DeterministicWorkflowEngine({ bindingReceiptKeys }) }, runtimeOptions); return runtime; } };
}

export const phaseTestName = "ac-1: The requested outcome is independently verifiable";
/** Runtime-detected profile without owner configuration; detection itself is stubbed, execution is real. */
export async function automaticRunners(): Promise<TestRunnerSource> {
  const profile: RunnerProfile = { id: "auto-integration", command: "auto:integration", executable: process.execPath,
    args: ["--test", "--test-reporter=tap"], method: "integration_test", levels: ["integration", "regression"], reporter: "node_tap",
    timeoutMs: 10_000, checkoutDependencyRoots: [], dependencySource: process.cwd(), definitionBlobs: {}, source: "detected" };
  const runners = new TestRunnerSource([], process.cwd(), async () => ({ status: "detected", profiles: [profile], notes: [] }));
  await runners.refresh();
  return runners;
}
export async function connectedPhaseFixture(reporter: "node_tap" | "vitest_json", maxIterations = 3, automatic = false, policy: { highRisk?: boolean; readiness?: "ready" | "partial" } = {}) {
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
  const f = await fixture({ behavioral: automatic ? { ...command, command: "auto:integration" } : command, runners, ...policy });
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def, maxIterations);
  if (policy.highRisk) await f.approve();
  await f.runtime.tick();
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
    const args = { runId: "run-1", taskId: "implement", phase };
    const manual = phase !== "red" && ((await f.dossier()).strategy.metadata.conditionalTdd.requiredVerificationMethods as string[]).includes("manual_review");
    const observed = manual ? await f.verification.inspectAlternative(qa, args) as any : undefined;
    const completed = await f.verification.behavioralEvidence(qa, { ...args, ...(observed ? { review: { observationId: observed.observationId,
      criteria: observed.dossier.specification.acceptanceCriteria.map((criterion: any) => ({ criterionId: criterion.id, passed: true, summary: "QA independently reviewed this exact committed change" })) } } : {}) });
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
  async function tickWithReviews(confirmProvenIntegrity = false) {
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
        const integrity = observed.context.input.hostTestIntegrityObservation?.report;
        const testIntegrityVerdicts = binding.role === "reviewer" && integrity ? integrity.findings.map((finding: any) => {
          const revision = finding.side === "base" ? integrity.baseRevision : integrity.candidateRevision;
          const excerpt = git(developer.worktreePath!, "show", `${revision}:${finding.path}`).split(/\r?\n/)[finding.line - 1]!.trim();
          if (finding.ruleId === "TI_SHADOWED_TEST_API" && reporter === "node_tap") {
            // This specific CJS fixture imports Node's strict assertion module; the committed fixed oracle is checked here.
            expect(finding.path).toBe(testPath); expect(excerpt).toBe(testSource.trim());
            expect(excerpt).toContain("const assert=require('node:assert/strict')"); expect(excerpt).toContain("assert.equal(double(2),4)");
            return { findingId: finding.id, verdict: "equivalent", reason: "The committed CJS binding imports node:assert/strict and still checks double(2) equals 4; this parser coverage gap does not weaken that fixed oracle.",
              evidence: [{ revision, path: finding.path, line: finding.line, excerpt }] };
          }
          if (confirmProvenIntegrity && finding.ruleId === "TI_LITERAL_TAUTOLOGY" && finding.classification === "proven_violation") {
            expect(excerpt).toContain("expect(1).toBe(1)");
            return { findingId: finding.id, verdict: "confirmed_violation", reason: "Both operands are literal 1, so this added assertion cannot detect any incorrect product output; no owner exception was requested.",
              evidence: [{ revision, path: finding.path, line: finding.line, excerpt }] };
          }
          throw new Error(`Unexpected test-integrity finding requires independent fixture analysis: ${JSON.stringify(finding)}`);
        }) : undefined;
        const completed = await f.verification.completeReview(binding, { reviewId: observed.reviewId,
          ...(observed.reworkResolution ? {findingVerdicts: observed.reworkResolution.reworkContext.findings.map((finding: {findingId:string}) => ({
            findingId:finding.findingId,verdict:"confirmed",summary:"Independently checked the exact repaired source and immutable acceptance test"}))} : {}),
          summary: "Reviewed the exact committed implementation and immutable acceptance test",
          ...(testIntegrityVerdicts ? { testIntegrityVerdicts } : {}),
          criteria: observed.context.definition.configuration.criterionIds.map((criterionId: string) => ({ criterionId, passed: true, summary: "The observed committed diff doubles the input and retains the spec-derived acceptance test" })) });
        await f.runtime.receiveHerdr(f.envelope("review.verdict", completed.result, { causation_id: out.message.message_id,
          sender: { role: binding.role, agent_id: binding.agentId, pane_id: binding.paneId }, artifact_references: [completed.artifact] }));
      }
      if (!done) await new Promise(resolve => setTimeout(resolve, 5));
    }
    await ticking;
  }
  return { ...f, command, developer, qa, development, original, testPath, sourcePath, testSource, currentHead, edit, commit, addTests, request, measure, tickWithReviews };
}
