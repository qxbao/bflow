import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import { AgentResultSchema, ApprovalDecisionSchema, RoleMessageSchema, VerificationResultSchema,
  type PaneBinding, type QualityGate, type QualityGateContext, type RoleMessage, type Specification } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { loadAgenticPolicies, type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { reworkVerificationBinding } from "../../src/agentic/rework-causality.js";
import type { JournalState, RunRecord } from "../../src/agentic/journal.js";
import { FakeAgentTransport } from "./fake-transport.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

/**
 * Whole-lifecycle fixture over the real Core engine, SQLite RunStore, filesystem ArtifactStore, Git worktrees and policies.
 * Agents are simulated by calling the same Runtime entry points the host calls; transport is the local fake (not live Herdr).
 */
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" } }).trim();

class Panes implements PanePolicy {
  busy = new Set<string>();
  bindings: PaneBinding[] = ["conversation", "coordinator", "specifier", "architect", "planner", "reviewer", "qa", "tester"].map(role => ({
    schemaVersion: 2, bindingId: `binding-${role}`, sessionId: "session-1", role: role as PaneBinding["role"],
    paneGroup: "coordination", agentId: role, workspaceId: "workspace-1", tabId: "tab-1", paneId: `pane-${role}`,
    provider: "test", agentKind: "test", cwd: "/tmp", isolationMode: "dedicated_pane", readOnlyWorkspace: true,
    session: { source: "test", kind: "id", value: `session-${role}` }, transportState: "idle", boundAt: new Date().toISOString()
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

/** A gate evaluation the test can hold open, to observe the run while Runtime owns verification outside the journal lock. */
export interface GateHold { reached: Promise<void>; release(): void }

export async function lifecycleFixture(cleanups: (() => Promise<void>)[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-lifecycle-")));
  const repository = join(root, "repo"); await mkdir(repository); git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test"); git(repository, "config", "user.email", "test@example.test");
  await writeFile(join(repository, "guide.md"), "initial\n");
  git(repository, "add", "."); git(repository, "commit", "-m", "baseline");
  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "lifecycle" }));
  cleanups.push(async () => { store.close(); artifacts.close(); await rm(root, { recursive: true, force: true }); });
  const transport = new FakeAgentTransport(), panes = new Panes();
  const bindingReceiptKeys = { "native-test-host": generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() };
  const holds = new Map<string, { reached: () => void; released: Promise<void> }>();
  let failingRole: string | undefined;
  const checks = [
    { id: "review", name: "review", evaluator: "review", required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" },
      configuration: { kind: "review", method: "manual_review", criterionIds: ["ac-1"], testNames: ["ac-1: The requested outcome is independently verifiable"], role: "reviewer", levels: [] } },
    { id: "regression", name: "regression", evaluator: "regression", required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" },
      configuration: { kind: "deterministic", method: "integration_test", command: "test-regression", criterionIds: [], testNames: [], role: "tester", levels: ["integration"] } }
  ] as any;
  const gates: QualityGate[] = checks.map((check: any) => ({ id: check.id, evaluate: async (context: QualityGateContext) => {
    const config = context.definition.configuration as any, input = context.input as any;
    const hold = holds.get(input.scope); if (hold) { holds.delete(input.scope); hold.reached(); await hold.released; }
    const passed = config.role !== failingRole;
    const run = config.kind === "review" && input.scope === "task"
      ? await runtime.inspect(context.runId) as unknown as RunRecord : undefined;
    const dossier = run?.tasks.find(task => task.taskId === context.taskId)?.reworkResolutions?.find(item => item.attemptId === context.attemptId);
    // This scripted independent reviewer must explicitly judge every repair, just like the real host fixture.
    const reworkEvidence = dossier ? { reworkVerification: reworkVerificationBinding(dossier),
      findingVerdicts: dossier.reworkContext.findings.map(finding => ({findingId:finding.findingId,
        verdict: passed ? "confirmed" : "rejected", summary:"Scripted independent review of the exact submitted repair"})) } : {};
    return { ok: true, value: { gateId: context.definition.id, runId: context.runId, taskId: context.taskId!,
      evaluationId: randomUUID(), status: passed ? "passed" : "failed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString(),
      metadata: { ...reworkEvidence, verification: { schemaVersion: 2, checkId: check.id, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
        sourceRevision: input.sourceRevision, specFingerprint: input.specFingerprint, scope: input.scope,
        independentExecution: true, isolated: true, executorId: "independent-test-host", role: config.role, method: config.method,
        ...(config.command ? { command: config.command, exitCode: passed ? 0 : 1 } : {}), testNames: config.testNames,
        criteria: config.criterionIds.map((criterionId: string) => ({ criterionId, passed, summary: "Host independently checked the criterion" })), summary: "Independent check" } } } };
  } }));
  let runtime: AgenticWorkflowRuntime;
  const policies = await loadAgenticPolicies({ repositoryPath: repository, artifactStore: artifacts, gates,
    loadSpecification: id => runtime.loadSpecification(id), authorizeApprover: decision => ["coordinator", "human-1"].includes(decision.decidedBy) });
  const conversationInbox: RoleMessage[] = [];
  let preflight: ((binding: PaneBinding, required: readonly string[]) => Promise<void>) | undefined;
  const ports = { engine: new DeterministicWorkflowEngine({ bindingReceiptKeys }), runStore: store, artifactStore: artifacts,
    registry: new FileAgentRegistry({ stateFile: join(root, "registry.json") }), transport, panes, policies,
    deliverToConversation: async (message: RoleMessage) => { conversationInbox.push(message); },
    preflightRoleCapabilities: async (binding: PaneBinding, required: readonly string[]) => { await preflight?.(binding, required); },
    roleCapabilities: { developer: ["implementation"], coordinator: ["coordination", "repository.read"], conversation: ["conversation"],
      specifier: ["specification", "repository.read"], architect: ["architecture", "repository.read"], planner: ["planning", "repository.read"],
      reviewer: ["review", "repository.read"], qa: ["verification", "repository.read"], tester: ["testing", "repository.read"] },
    taskChecks: checks, workflowChecks: checks,
    authenticateMessage: async () => true, authenticateResult: async () => true, authenticateEvidence: async () => true,
    authenticateGateResult: async () => true, authorizeHuman: async (decision: any) => decision.decidedBy === "human-1",
    projectApprovalRequired: () => false } as unknown as AgenticRuntimePorts;
  const runtimeOptions = { journalDirectory: join(root, "journal"), repositoryPath: repository };
  runtime = new AgenticWorkflowRuntime(ports, runtimeOptions);
  const spec: Specification = draft("documentation");
  const time = new Date().toISOString(); spec.createdAt = time; spec.updatedAt = time;
  spec.affectedPaths = ["guide.md"]; spec.traceabilityTaskIds = ["implement"];
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
  const envelope = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => RoleMessageSchema.parse({ schema_version: 2, message_id: randomUUID(),
    correlation_id: "correlation-1", run_id: "run-1", sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" },
    recipient: { role: "coordinator" }, type, payload, artifact_references: [], occurred_at: new Date().toISOString(), idempotency_key: randomUUID(), ...extra });
  const intakeMessage = envelope("delegation.request", delegation, { message_id: "intake-1", idempotency_key: "intake-1" });
  const binding = (role: string) => panes.bindings.find(pane => pane.role === role)!;
  const state = async () => await runtime.inspect() as unknown as JournalState;
  const run = async (runId = "run-1") => await runtime.inspect(runId) as unknown as RunRecord;
  /** Agent replies as the role's authenticated pane, correlated to the Runtime handoff it answers. */
  const reply = (role: string, request: { message_id: string }, type: string, payload: unknown) => envelope(type, payload, {
    causation_id: request.message_id, sender: { role, agent_id: role, pane_id: `pane-${role}` }, recipient: { role: "coordinator" } });

  async function evidence(taskId = "implement", runId = "run-1") {
    const current = await run(runId);
    const task = current.tasks.find(t => t.taskId === taskId) as any, strategy = task.spec.strategy;
    const startedAt = new Date().toISOString(), bytes = Buffer.from(`${taskId}-${randomUUID()}`);
    const ref = unwrap(await artifacts.put({ options: { artifactId: randomUUID(), runId, taskId, kind: "test-result", mediaType: "text/plain",
      expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length }, idempotencyKey: randomUUID() },
      content: (async function* () { yield bytes; })() }));
    const method = spec.acceptanceCriteria[0]!.verificationMethod;
    const result = VerificationResultSchema.parse({ schemaVersion: 2, verificationId: randomUUID(), runId, taskId, cycleNumber: 1, attemptId: randomUUID(),
      status: "passed", independentExecution: true,
      evaluatedCriteria: [{ criterionId: "ac-1", passed: true, evidenceArtifactId: ref.artifactId, summary: "Observed target behavior",
        ...(method === "integration_test" ? { command: "test-regression", exitCode: 0 } : {}) }],
      qualityGateResults: [], evidenceArtifacts: [ref], findings: [], verifiedBy: "tester", startedAt, completedAt: new Date().toISOString(),
      metadata: { conditionalTdd: { phase: "verification", decisionId: strategy.tddDecision.decisionId, specId: strategy.specId,
        sourceRevision: "implementation-source", testRevision: "unchanged-tests", testNames: strategy.criterionMappings[0].testNames,
        observations: [{ method, criterionId: "ac-1", evidenceArtifactId: ref.artifactId, summary: "Independent observation",
          ...(method === "integration_test" ? { command: "test-regression", exitCode: 0 } : {}) }] } } });
    await runtime.receiveHerdr(envelope("verification.result", result, { sender: { role: "tester" }, run_id: runId,
      correlation_id: current.delegation.correlationId }));
  }
  async function submit(taskId = "implement", content = "updated\n", runId = "run-1") {
    const outbound = [...(await state()).outbound].reverse().find(out => out.taskId === taskId && out.message.type === "task.assignment" && out.message.run_id === runId)!;
    const handle = outbound.handle!, path = handle.target.worktreePath!;
    await writeFile(join(path, "guide.md"), content); git(path, "add", "guide.md"); git(path, "commit", "-m", "implement");
    const reworkContext = outbound.message.payload?.reworkContext as { reworkGeneration: number; findings: { findingId: string; code: string; message: string }[] } | undefined;
    const headRevision = git(path, "rev-parse", "HEAD");
    const findingResolutions = reworkContext?.findings.map(finding => ({
      findingId: finding.findingId,
      disposition: "addressed",
      rootCause: `Root cause for ${finding.code}: ${finding.message}`,
      sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 1 }],
      repairSummary: `Updated guide.md to resolve ${finding.code} (${finding.findingId})`,
      discriminatingCheck: {
        kind: "quality_gate",
        target: finding.code,
        beforeOutcome: `Failed with ${finding.code}: ${finding.message}`,
        afterOutcome: `Resolved ${finding.code} in guide.md at ${headRevision}`
      },
      evidence: {
        sourceRevision: headRevision,
        reworkGeneration: reworkContext.reworkGeneration,
        summary: `Verified guide.md at revision ${headRevision} for generation ${reworkContext.reworkGeneration}`
      }
    }));
    const result = AgentResultSchema.parse({ requestId: handle.requestId, attemptId: handle.attemptId, runId, taskId, executionId: handle.executionId,
      status: "succeeded", verification: { status: "verified", evidence: "Authenticated test-host result", correlation:
        unwrap(await ports.engine.getSnapshot(runId))!.tasks.find(task => task.taskId === taskId)!.bindingVerification?.receipt.correlation ?? handle.correlation },
      ...(findingResolutions ? { output: { findingResolutions } } : {}),
      artifactProposals: [], retryable: false, startedAt: handle.acceptedAt, completedAt: new Date().toISOString() });
    await runtime.receiveHerdr(envelope("implementation.submitted", result, { causation_id: outbound.message.message_id, run_id: runId,
      correlation_id: outbound.message.correlation_id, sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId } }));
    return path;
  }
  async function approve(decision: "approved" | "changes_requested" | "rejected" = "approved", runId = "run-1") {
    const current = await run(runId), request = current.approval!;
    await runtime.receiveHerdr(envelope("approval.decision", ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId,
      runId, sessionId: "session-1", target: request.target, revision: request.revision, generation: request.generation,
      decision, ...(decision === "approved" ? {} : { reason: "User asked for changes" }), decidedBy: "human-1", decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: randomUUID() }),
      { run_id: runId, correlation_id: current.delegation.correlationId }));
  }
  /** The host's Coordinator Stop reconciliation for the newest Coordinator delivery, exactly as `settleCoordinatorStop` routes it. */
  async function coordinatorStop(message?: RoleMessage) {
    const delivered = message ?? [...(await state()).outbound].reverse().find(out => out.message.recipient.role === "coordinator" &&
      ["accepted", "released"].includes(out.status))!.message;
    if (delivered.type === "delegation.request") await runtime.coordinatorTurnStopped(delivered, binding("coordinator"));
    else await runtime.coordinatorStopWithoutResponse(delivered, binding("coordinator"));
  }
  return {
    root, repository, panes, transport, ports, spec, def, intakeMessage, conversationInbox, envelope, reply, binding, state, run,
    evidence, submit, approve, coordinatorStop,
    get runtime() { return runtime; },
    restart: () => { runtime = new AgenticWorkflowRuntime(ports, runtimeOptions); return runtime; },
    /** A new host process: in-memory engine and verification policy state are rebuilt; only durable stores survive. */
    async restartProcess() {
      (ports as { engine: unknown }).engine = new DeterministicWorkflowEngine({ bindingReceiptKeys });
      (ports as { policies: unknown }).policies = await loadAgenticPolicies({ repositoryPath: repository, artifactStore: artifacts, gates,
        loadSpecification: id => runtime.loadSpecification(id), authorizeApprover: decision => ["coordinator", "human-1"].includes(decision.decidedBy) });
      runtime = new AgenticWorkflowRuntime(ports, runtimeOptions); await runtime.initialize(); return runtime;
    },
    setPreflight(value: typeof preflight) { preflight = value; },
    /** Makes every independent check owned by this role fail until reset with undefined. */
    setFailingRole(role: string | undefined) { failingRole = role; },
    hold(scope: "task" | "workflow"): GateHold {
      let reached!: () => void, release!: () => void;
      const reachedPromise = new Promise<void>(accept => { reached = accept; });
      holds.set(scope, { reached, released: new Promise<void>(accept => { release = accept; }) });
      return { reached: reachedPromise, release };
    },
    sentTo: (role: string) => transport.sentRequests.filter(request => request.role === role).map(request => JSON.parse(request.instruction) as RoleMessage)
  };
}
export type LifecycleFixture = Awaited<ReturnType<typeof lifecycleFixture>>;
