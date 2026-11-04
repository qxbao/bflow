import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  AgentResultSchema, AppendEventsRequestSchema, PaneBindingSchema, RoleMessageSchema, SessionManifestV3Schema, StoredRunSchema, QualityGateResultSchema, VerificationResultSchema, WorkflowDefinitionSchema,
  type AgentExecutionHandle, type AgentMessage, type AgentReconciliationRequest, type AgentReconciliationResult, type AgentRequest,
  type AgentSubmissionReceipt, type AgentTransport, type AgentTransportCapabilities, type AgentTransportObservation, type ApprovalDecision,
  type CancellationRequest, type CancellationResult, type OperationResult, type PaneBinding, type QualityGate, type QualityGateContext, type QualityGateResult,
  type RoleMessage, type SessionManifest, type Specification
} from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { buildDelegationRequest } from "@bflow/conversation";
import { classifyChange, PolicyDetailsSchema } from "@bflow/specification";
import {
  AgenticWorkflowRuntime, CoordinatorTools, DirectorEndpoint, HostReceiptJournal, createAgenticConversationHost, loadAgenticPolicies,
  directorCoordinatorPort, recordConversationNotice, startDirectorWork,
  type AgenticConversationHost, type AgenticRuntimePorts, type DirectorRuntimePort, type DirectorStartWorkDeps, type PanePolicy
} from "@bflow/runtime";

/**
 * Director session (ADR 0009, slice B2a) composed from public package exports exactly as the host wires it, without Herdr:
 * manifest v3 (no Conversation/Coordinator pane, running progress pane), the real DirectorEndpoint (DirectorTools + DirectorStore
 * with a real token), Runtime outbound for the logical Coordinator routed to the Director mailbox, Conversation notices mirrored
 * into the mailbox for the user audience, and the pane-less structured Conversation gateway. Specialists and the transport are fakes.
 */

const unwrap = <T>(result: OperationResult<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
  cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test" } }).trim();

/** Records every Herdr submission; accepts it with a transport-verified correlation. Never a business result. */
export class RecordingTransport implements AgentTransport {
  readonly sentRequests: AgentRequest[] = [];
  async initialize(): Promise<OperationResult<AgentTransportCapabilities>> {
    return { ok: true, value: { transportName: "e17-recording-transport", protocolVersion: "1.0", supportsStreaming: true, supportsCancellation: true,
      supportsResume: true, supportsSubmissionCorrelation: true } };
  }
  private handle(request: { requestId: string; attemptId: string; runId: string; taskId: string; target: AgentRequest["target"] }, key: string): AgentExecutionHandle {
    return { executionId: `exec-${randomUUID()}`, requestId: request.requestId, attemptId: request.attemptId, runId: request.runId, taskId: request.taskId,
      idempotencyKey: key, target: request.target, correlation: { token: request.requestId, provenance: "transport", verified: true },
      acceptedAt: new Date().toISOString() };
  }
  async send(request: AgentRequest): Promise<OperationResult<AgentSubmissionReceipt>> {
    this.sentRequests.push(request);
    const handle = this.handle(request, request.idempotency.key);
    return { ok: true, value: { status: "accepted", requestId: request.requestId, attemptId: request.attemptId, runId: request.runId,
      taskId: request.taskId, observedAt: handle.acceptedAt, handle } };
  }
  async reconcile(request: AgentReconciliationRequest): Promise<OperationResult<AgentReconciliationResult>> {
    return { ok: true, value: { status: "bound", handle: this.handle(request, request.idempotencyKey) } };
  }
  async cancel(handle: AgentExecutionHandle, request: CancellationRequest): Promise<OperationResult<CancellationResult>> {
    return { ok: true, value: { schemaVersion: 1, status: "accepted", cancellationId: request.cancellationId, executionId: handle.executionId, observedAt: new Date().toISOString() } };
  }
  async wait(handle: AgentExecutionHandle): Promise<OperationResult<AgentTransportObservation>> {
    return { ok: true, value: { handle, state: "done", observedAt: new Date().toISOString(), correlationVerified: true } };
  }
  async *read(): AsyncIterable<OperationResult<AgentMessage>> {}
  /** The RoleMessage envelope each submission carried. */
  messages(): RoleMessage[] { return this.sentRequests.map(request => RoleMessageSchema.parse(JSON.parse(request.instruction))); }
}

const SPECIALISTS = ["specifier", "architect", "planner", "reviewer", "qa", "tester"] as const;

/** Director layout: specialist panes only; the attach target is the running, non-LLM progress pane. */
export class DirectorPanes implements PanePolicy {
  readonly at = new Date().toISOString();
  bindings: PaneBinding[] = SPECIALISTS.map(role => PaneBindingSchema.parse({ schemaVersion: 2, bindingId: `binding-${role}`, sessionId: "session-1", role,
    paneGroup: "coordination", agentId: role, workspaceId: "workspace-1", tabId: "tab-1", paneId: `pane-${role}`, provider: "test", agentKind: "test",
    cwd: "/tmp", isolationMode: "dedicated_pane", readOnlyWorkspace: true, session: { source: "test", kind: "id", value: `session-${role}` },
    transportState: "idle", boundAt: this.at }));
  manifest(): SessionManifest {
    return SessionManifestV3Schema.parse({ schemaVersion: 3, sessionId: "session-1", projectName: "E17", workspaceRoot: "/tmp", herdrWorkspaceId: "workspace-1",
      herdrTabId: "tab-1", status: "up", conversationSessionId: "session-1", activeRunIds: [], panes: this.bindings,
      progressPane: { tabId: "tab-progress", paneId: "pane-progress", command: ["bflow", "progress", "--follow"], phase: "running", restarts: [], launchedAt: this.at },
      attachTarget: { role: "progress", tabId: "tab-progress", paneId: "pane-progress" }, createdAt: this.at, updatedAt: this.at });
  }
  async getManifest() { return { ok: true as const, value: this.manifest() }; }
  private find(selector: string) { return this.bindings.find(pane => [pane.role, pane.bindingId, pane.paneId, pane.agentId].includes(selector)); }
  async getRoleBinding(selector: string) { return { ok: true as const, value: this.find(selector) ?? null }; }
  async inspectRoleHealth(selector: string) {
    const pane = this.find(selector); if (!pane) throw new Error(`No pane for ${selector}`);
    return { ok: true as const, value: { readyForPrompt: true, occupantMatches: true, paneExists: true, paneId: pane.paneId, agentId: pane.agentId } };
  }
  async allocateDeveloper(request: { taskId: string; worktreePath: string; agentName: string }) {
    const old = this.bindings.find(pane => pane.agentId === request.agentName); if (old) return { ok: true as const, value: old };
    const pane = PaneBindingSchema.parse({ ...this.bindings[0]!, bindingId: request.agentName, role: "developer", agentId: request.agentName,
      paneId: `pane-${request.agentName}`, cwd: request.worktreePath, worktreePath: request.worktreePath, readOnlyWorkspace: false });
    this.bindings.push(pane); return { ok: true as const, value: pane };
  }
  async releaseDeveloper() { return { ok: true as const, value: undefined }; }
}

const CRITERION = "The requested outcome is independently verifiable";
/** Lightweight documentation change for the delegated `runId`/`specId`: the Director's planning output (shape of the shipped specification example). */
export function documentationSpecification(runId: string, specId: string): Specification {
  const assessment = { kind: "documentation", behaviorChange: false, modules: ["example"], securityImpact: false, publicApiImpact: false,
    dataSchemaImpact: false, architectureImpact: false, migrationRequired: false, risk: "low", unresolvedQuestions: [] };
  const affectedPaths = ["guide.md"];
  const classification = classifyChange(assessment, affectedPaths);
  const details = PolicyDetailsSchema.parse({ policyVersion: 1, assessment, functionalRequirements: [], technicalConstraints: [], apiDataContracts: [],
    risksAndTradeoffs: [], traceability: [{ criterionId: "ac-1", taskIds: ["implement"] }] });
  const at = new Date().toISOString();
  return { schemaVersion: 2, specId, runId, sessionId: "session-1", level: classification.level, complexity: classification.complexity,
    riskLevel: classification.riskLevel, version: 1, title: "Example documentation change", summary: "Deliver an explicit, verifiable outcome",
    problemStatement: "The current guide does not meet the requested outcome", scope: { inScope: ["The guide"], outOfScope: ["Unrelated modules"] },
    acceptanceCriteria: [{ id: "ac-1", description: CRITERION, category: "functional", verificationMethod: "manual_review", required: true, status: "pending",
      evidenceArtifactIds: [] }],
    affectedPaths, traceabilityTaskIds: ["implement"], status: "draft", createdBy: "analyst", createdAt: at, updatedAt: at,
    metadata: { sdd: details, conditionalTdd: { policyVersion: 1, taskId: "implement", taskType: "documentation",
      changeImpact: { surfaces: ["documentation"], behaviorChanged: false, deterministic: false, regressionReproducible: false, securitySensitive: false,
        dataMigration: false, scope: "local" },
      infrastructure: { readiness: "ready", commands: [{ method: "integration_test", command: "test-regression", level: "integration" }] },
      testability: { level: "automated", rationale: "Independent repeatable behavioral checks are available" }, riskClassification: "low",
      conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] } } } } as Specification;
}
export function singleTaskWorkflow() {
  return { schemaVersion: "1", id: "flow", name: "Example", version: "1.0.0",
    tasks: [{ id: "implement", title: "implement", role: "developer", instruction: "Implement linked criteria", acceptanceCriteria: ["ac-1"],
      retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
      timeout: { executionTimeoutMs: 60000, heartbeatTimeoutMs: 10000, onTimeout: "block" }, requiresApproval: false, qualityGates: [],
      metadata: { ownedPaths: ["guide.md"] } }],
    dependencies: [], qualityGates: [], maxConcurrency: 1, failurePolicy: "block",
    recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" } };
}

const CHECKS = [
  { id: "review", name: "review", evaluator: "review", required: true, timeout: { executionTimeoutMs: 30_000, onTimeout: "block" },
    configuration: { kind: "review", method: "manual_review", criterionIds: ["ac-1"], testNames: [`ac-1: ${CRITERION}`], role: "reviewer", levels: [] } },
  { id: "regression", name: "regression", evaluator: "regression", required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" },
    configuration: { kind: "deterministic", method: "integration_test", command: "test-regression", criterionIds: [], testNames: [], role: "tester",
      levels: ["integration"] } }
];

/** Scripted independent check outcome; the Reviewer fake sends the `review` one back as its verdict. */
function scriptedCheck(context: QualityGateContext): QualityGateResult {
  const config = context.definition.configuration as { role: string; method: string; command?: string; criterionIds: string[]; testNames: string[] };
  const input = context.input as { sourceRevision?: string; specFingerprint?: string; scope?: string };
  // JSON round trip drops absent optional inputs; the exported schema validates the verdict at this fake's boundary.
  return QualityGateResultSchema.parse(JSON.parse(JSON.stringify({ gateId: context.definition.id, runId: context.runId, taskId: context.taskId!,
    evaluationId: randomUUID(), status: "passed",
    findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString(),
    metadata: { verification: { schemaVersion: 2, checkId: context.definition.id, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
      sourceRevision: input.sourceRevision, specFingerprint: input.specFingerprint, scope: input.scope, independentExecution: true, isolated: true,
      executorId: "independent-test-host", role: config.role, method: config.method, ...(config.command ? { command: config.command, exitCode: 0 } : {}),
      testNames: config.testNames, criteria: config.criterionIds.map(criterionId => ({ criterionId, passed: true, summary: "Host independently checked the criterion" })),
      summary: "Independent check" } } })));
}

export interface DirectorSessionOptions {
  humanApproval?: boolean;
  /** Fake human authentication for structured decisions; receives the exact Runtime-bound ApprovalDecision. */
  authorizeHuman?: (decision: ApprovalDecision) => Promise<boolean>;
  /**
   * Seeds the private journal (e.g. a real v7 journal) before Runtime opens it; `repository` is rewritten to this session's repository.
   * A journal file carries no SQLite RunStore, so each Core-created run gets the same initial authoritative record Runtime writes when
   * it creates the Core run (core-session.ts: initial stored run plus the engine's creation events), from the run's own persisted definition.
   */
  journal?: { runs?: { runId: string; coreCreated?: boolean; definition?: unknown; delegation: { requestedAt: string } }[] } & Record<string, unknown>;
  /**
   * E18 restart: reopen the durable state (repository, RunStore, artifacts, Registry, journal, Director store, host receipts) of an
   * earlier session's `root` instead of creating a new one. The caller closes the earlier session first (`close()`, not `cleanup()`).
   */
  root?: string;
  /** E18 restart: keep the same actual manifest/pane catalog across the reopen. */
  panes?: DirectorPanes;
  /** Host composition: give the endpoint the read-only Runtime run document so issue retries check the current park episode. */
  inspectRun?: boolean;
}

export async function createDirectorSession(options: DirectorSessionOptions = {}) {
  const root = options.root ?? await realpath(await mkdtemp(join(tmpdir(), "bflow-e17-")));
  const repository = join(root, "repo");
  if (options.root === undefined) {
    await mkdir(repository);
    git(repository, "init", "-b", "main"); git(repository, "config", "user.name", "Test"); git(repository, "config", "user.email", "test@example.test");
    await writeFile(join(repository, "guide.md"), "initial\n"); git(repository, "add", "."); git(repository, "commit", "-m", "baseline");
  }
  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "e17" }));
  for (const run of options.journal?.runs ?? []) {
    if (!run.coreCreated) continue;
    const definition = WorkflowDefinitionSchema.parse(run.definition), at = run.delegation.requestedAt;
    unwrap(await store.create(StoredRunSchema.parse({ definition, snapshot: { runId: run.runId, workflowId: definition.id, workflowVersion: definition.version,
      status: "queued", tasks: definition.tasks.map(task => ({ taskId: task.id, status: "pending", attempt: 0, generation: 0, version: 0 })),
      createdAt: at, updatedAt: at, version: 0, lastEventSequence: 0 } }), `p19-store:${run.runId}`));
    const created = unwrap(await new DeterministicWorkflowEngine({ bindingReceiptKeys: {} }).createRun({ runId: run.runId, definition, createdAt: at,
      idempotencyKey: `p19-create:${run.runId}` }));
    unwrap(await store.appendEvents(AppendEventsRequestSchema.parse({ runId: run.runId, expectedVersion: 0, expectedLastSequence: 0,
      events: created.emittedEvents, idempotencyKey: `p19-events:${run.runId}:${created.emittedEvents[0]!.eventId}` })));
  }
  const transport = new RecordingTransport(), panes = options.panes ?? new DirectorPanes();
  const journalDirectory = join(root, "journal");
  if (options.journal) {
    await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(journalDirectory, "state.json"), JSON.stringify({ ...options.journal, repository }), { mode: 0o600 });
  }
  let clockOffsetMs = 0;
  let runtime!: AgenticWorkflowRuntime;
  const tools = () => new CoordinatorTools(runtime);
  const gates: QualityGate[] = [
    { id: "review", evaluate: (...args: Parameters<QualityGate["evaluate"]>) => runtime.herdrQualityGate("review").evaluate(...args) },
    { id: "regression", evaluate: async context => ({ ok: true, value: scriptedCheck(context) }) }
  ];
  // Production approver (workspace.ts): a human-required specification decision is accepted only when it copies an approved bundle.
  const approvedBundles = new Map<string, ApprovalDecision>();
  const humanDecisions: ApprovalDecision[] = [];
  const policies = await loadAgenticPolicies({ repositoryPath: repository, artifactStore: artifacts, gates,
    loadSpecification: id => runtime.loadSpecification(id),
    authorizeApprover: (decision, humanRequired) => {
      if (!humanRequired && decision.decidedBy === "coordinator") return true;
      const bundleId = decision.metadata?.approvedBundleId;
      const source = typeof bundleId === "string" ? approvedBundles.get(bundleId) : undefined;
      return source?.decision === "approved" && source.runId === decision.runId && source.sessionId === decision.sessionId &&
        source.decidedBy === decision.decidedBy && source.decidedAt === decision.decidedAt;
    } });
  const startWork: DirectorStartWorkDeps = { manifest: () => panes.manifest(), build: buildDelegationRequest as unknown as DirectorStartWorkDeps["build"],
    admitDirectorWork: request => runtime.admitDirectorWork(request), log: async () => undefined };
  const endpoint = new DirectorEndpoint({ directory: join(root, "director"), repositoryRoot: repository, feed: { read: () => ({ items: [] }) },
    inspect: () => runtime.inspect(), pollMs: 20, ...(options.inspectRun ? { inspectRun: (runId: string) => runtime.inspect(runId) } : {}),
    work: { start: async input => startDirectorWork(startWork, input) },
    // The host's own Director Coordinator port: it supplies the Director principal (R-B2-12) for every Director-token call.
    coordinator: directorCoordinatorPort({ invoke: (name, parameters, principal) => tools().invoke(name, parameters, principal),
      planningReference: async () => { throw new Error("planning_reference is not used by this scenario"); }, log: async () => undefined }) });
  const receipts = new HostReceiptJournal(join(root, "host-receipts"), repository, "session-1");
  let chat: AgenticConversationHost | undefined;
  /** Mailbox port: the real endpoint; `absent` presence blocks automatic resume. */
  const director: DirectorRuntimePort & { deliveries: RoleMessage[] } = { deliveries: [],
    async deliver(message) { this.deliveries.push(message); await endpoint.deliverRuntimeMessage(message); },
    present: async () => (await endpoint.presence()) !== "absent",
    upsertIssue: async input => { await endpoint.upsertIssue(input); } };
  const ports: AgenticRuntimePorts = { engine: new DeterministicWorkflowEngine({ bindingReceiptKeys: {} }), runStore: store, artifactStore: artifacts,
    registry: new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock: () => new Date(Date.now() + clockOffsetMs) }), transport, panes, policies,
    clock: () => new Date(Date.now() + clockOffsetMs),
    // Host composition (workspace.ts + host.ts onConversationNotice): the pane-less gateway learns of the notice, the host writes its
    // receipt (which assigns the #n code) and, in a Director session, mirrors it into the mailbox for the user audience.
    deliverToConversation: async message => {
      if (!chat) throw new Error("Conversation host is not ready");
      await chat.receiveRuntime(message);
      await recordConversationNotice({ appendNotice: notice => receipts.appendConversationNoticeReceipt(notice),
        mirror: (notice, rendered) => endpoint.mirrorUserNotice(notice, rendered), log: async () => undefined }, message);
    },
    roleCapabilities: { developer: ["implementation"], specifier: ["specification", "repository.read"], architect: ["architecture", "repository.read"],
      planner: ["planning", "repository.read"], reviewer: ["review", "repository.read"], qa: ["verification", "repository.read"], tester: ["testing", "repository.read"] },
    taskChecks: CHECKS as AgenticRuntimePorts["taskChecks"], workflowChecks: CHECKS as AgenticRuntimePorts["workflowChecks"],
    authenticateMessage: async () => true, authenticateResult: async () => true, authenticateEvidence: async () => true, authenticateGateResult: async () => true,
    authorizeHuman: async decision => {
      const authorized = options.authorizeHuman ? await options.authorizeHuman(decision) : false;
      if (authorized) approvedBundles.set(decision.approvalId, decision);
      return authorized;
    },
    projectApprovalRequired: () => options.humanApproval === true, director };
  runtime = new AgenticWorkflowRuntime(ports, { journalDirectory, repositoryPath: repository });
  chat = await createAgenticConversationHost({ runtime, manifest: panes.manifest(), contextDirectory: join(root, "director-conversation"),
    noticeAliases: () => receipts.noticeAliases() });
  chat.configureStructuredInteraction({ authorize: async () => true, now: () => new Date().toISOString(),
    // The Web host records the human decision before Runtime authenticates it (host.ts structured approval).
    approval: async decision => { humanDecisions.push(decision); },
    resume: async command => ({ ok: true, value: { kind: "interaction", runId: command.runId, currentRunId: command.runId } }) });

  const inspect = async (runId: string) => await runtime.inspect(runId) as any;
  const state = async () => await runtime.inspect() as any;
  /** Developer fake: commits in its worktree and submits a correlated AgentResult for the current assignment. */
  async function submit(runId: string, taskId = "implement", filename = "guide.md") {
    const outbound = [...(await state()).outbound].reverse().find((out: any) => out.taskId === taskId && out.message.type === "task.assignment" && out.message.run_id === runId);
    if (!outbound?.handle) throw new Error("No accepted Developer assignment");
    const handle = outbound.handle as AgentExecutionHandle; const path = handle.target.worktreePath!;
    await writeFile(join(path, filename), "updated\n"); git(path, "add", filename); git(path, "commit", "-m", "implement");
    const snapshot = unwrap(await ports.engine.getSnapshot(runId))!;
    const correlation = snapshot.tasks.find(task => task.taskId === taskId)!.bindingVerification?.receipt.correlation ?? handle.correlation;
    const result = AgentResultSchema.parse({ requestId: handle.requestId, attemptId: handle.attemptId, runId, taskId, executionId: handle.executionId,
      status: "succeeded", verification: { status: "verified", evidence: "Authenticated test-host result", correlation }, artifactProposals: [],
      retryable: false, startedAt: handle.acceptedAt, completedAt: new Date().toISOString() });
    await runtime.receiveHerdr(envelope(runId, "implementation.submitted", result, { causation_id: outbound.message.message_id,
      sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId } }));
  }
  /** Tester fake: the independent alternative-verification evidence the not_applicable TDD decision requires for `taskId`. */
  async function evidence(runId: string, taskId = "implement") {
    const task = (await inspect(runId)).tasks.find((item: any) => item.taskId === taskId); const strategy = task.spec.strategy;
    const startedAt = new Date().toISOString(), bytes = Buffer.from(`${taskId}-verification-${randomUUID()}`);
    const ref = unwrap(await artifacts.put({ options: { artifactId: randomUUID(), runId, taskId, kind: "test-result", mediaType: "text/plain",
      expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length },
      idempotencyKey: randomUUID() }, content: (async function* () { yield bytes; })() }));
    const result = VerificationResultSchema.parse({ schemaVersion: 2, verificationId: randomUUID(), runId, taskId, cycleNumber: 1, attemptId: randomUUID(),
      status: "passed", independentExecution: true,
      evaluatedCriteria: [{ criterionId: "ac-1", passed: true, evidenceArtifactId: ref.artifactId, summary: "Observed target behavior" }],
      qualityGateResults: [], evidenceArtifacts: [ref], findings: [], verifiedBy: "tester", startedAt, completedAt: new Date().toISOString(),
      metadata: { conditionalTdd: { phase: "verification", decisionId: strategy.tddDecision.decisionId, specId: strategy.specId,
        sourceRevision: "implementation-source", testRevision: "unchanged-tests", testNames: strategy.criterionMappings[0].testNames,
        observations: [{ method: "manual_review", criterionId: "ac-1", evidenceArtifactId: ref.artifactId, summary: "Independent observation" }] } } });
    await runtime.receiveHerdr(envelope(runId, "verification.result", result, { sender: { role: "tester" } }));
  }
  /** Reviewer fake: replies to a Director `request_specialist` handoff it received over the transport. */
  async function reviewerReplies(runId: string, requestMessageId: string, payload: Record<string, unknown>) {
    const request = transport.sentRequests.find(item => JSON.parse(item.instruction).message_id === requestMessageId);
    if (!request || request.role !== "reviewer") throw new Error("The Reviewer never received the Director's request");
    await runtime.receiveHerdr(envelope(runId, "task.status", payload, { causation_id: requestMessageId,
      sender: { role: "reviewer", agent_id: request.target.agentId, pane_id: request.target.paneId } }));
  }
  function envelope(runId: string, type: string, payload: unknown, extra: Record<string, unknown>) {
    return RoleMessageSchema.parse({ schema_version: 2, message_id: randomUUID(), correlation_id: correlationOf(runId), run_id: runId,
      recipient: { role: "coordinator" }, type, payload, artifact_references: [], idempotency_key: randomUUID(), ...extra });
  }
  const correlations = new Map<string, string>();
  const correlationOf = (runId: string) => { const id = correlations.get(runId); if (!id) throw new Error(`Unknown run ${runId}`); return id; };
  /**
   * Runs a Runtime tick while the Reviewer fake answers each `verification.requested` it receives over the transport with an
   * independent verdict for exactly that request.
   */
  async function tickWithReviewer(): Promise<number> {
    let done = false, cursor = transport.sentRequests.length, answered = 0;
    const ticking = runtime.tick().finally(() => { done = true; }); void ticking.catch(() => undefined);
    const deadline = Date.now() + 45_000;
    while (!done) {
      if (Date.now() > deadline) throw new Error("Runtime tick did not finish while the Reviewer fake was answering");
      while (cursor < transport.sentRequests.length) {
        const request = transport.sentRequests[cursor++]!; const message = JSON.parse(request.instruction);
        if (message.type !== "verification.requested" || request.role !== "reviewer" || !message.payload.definition) continue;
        await runtime.receiveHerdr(envelope(message.run_id, "review.verdict", scriptedCheck(message.payload), { causation_id: message.message_id,
          sender: { role: "reviewer", agent_id: request.target.agentId, pane_id: request.target.paneId } }));
        answered++;
      }
      if (!done) await new Promise(resolve => setTimeout(resolve, 5));
    }
    await ticking;
    return answered;
  }
  return {
    root, repository, journalDirectory, store, artifacts, transport, panes, ports, endpoint, receipts, director, humanDecisions,
    get runtime() { return runtime; }, get chat() { return chat!; },
    tools, inspect, state, submit, evidence, tickWithReviewer, reviewerReplies,
    trackRun(runId: string, correlationId: string) { correlations.set(runId, correlationId); },
    advanceClock(ms: number) { clockOffsetMs += ms; },
    /** Closes the durable stores without deleting them (E18 restart); `cleanup()` closes and deletes. */
    close() { store.close(); artifacts.close(); },
    async cleanup() { store.close(); artifacts.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  };
}
export type DirectorSession = Awaited<ReturnType<typeof createDirectorSession>>;
