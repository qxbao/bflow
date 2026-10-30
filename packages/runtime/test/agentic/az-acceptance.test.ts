import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentResultSchema, ApprovalDecisionSchema, RoleMessageSchema, VerificationResultSchema,
  type PaneBinding, type QualityGate, type QualityGateContext, type RoleMessage, type Specification } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { AdmissionRejectedError, AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { loadAgenticPolicies, type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { evaluateWatchdog } from "../../src/agentic/run-watchdog.js";
import { guardNativeShell } from "../../src/agentic/read-only-commands.js";
import { digest, type JournalState, type Outbound, type RunRecord } from "../../src/agentic/journal.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { HerdrOutbox } from "../../src/agentic/outbox.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

// A-Z acceptance for WORKFLOW-AZ-PLAN.md ("Nghiệm thu"): one delegation survives each recoverable fault once and reaches the
// delivery approval with no human "tiếp tục"; a recurring fault is bounded; human gates and uncertain deliveries never auto-resume.
// Runs on every platform (no describe.skipIf). The fixture mirrors helpers/agentic-integration-fixture.ts (real Core, SQLite RunStore, filesystem
// ArtifactStore, Git worktrees, P15-P18 policies) but verification uses its in-process independent gates plus injected
// verification evidence, the path the cross-platform "Runtime task activity log integration" cases use; it does not need the
// Linux behavioral sandbox. Backoff and watchdog windows elapse on an injected forward-only clock, never real sleeps.

const SECOND = 1_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" } }).trim();

class Panes implements PanePolicy {
  busy = new Set<string>();
  bindings: PaneBinding[] = ["conversation", "coordinator", "architect", "reviewer", "qa", "tester"].map(role => ({
    schemaVersion: 2, bindingId: `binding-${role}`, sessionId: "session-1", role: role as PaneBinding["role"],
    paneGroup: "coordination", agentId: role, workspaceId: "workspace-1", tabId: "tab-1", paneId: `pane-${role}`,
    provider: "test", agentKind: "test", cwd: "/tmp", isolationMode: "dedicated_pane", readOnlyWorkspace: true,
    session: { source: "test", kind: "id", value: `session-${role}` }, transportState: "idle", boundAt: new Date().toISOString() }));
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

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-az-")));
  const repository = join(root, "repo"); await mkdir(repository); git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test"); git(repository, "config", "user.email", "test@example.test");
  await writeFile(join(repository, "guide.md"), "initial\n");
  git(repository, "add", "."); git(repository, "commit", "-m", "baseline");
  // One fake clock for Runtime, Registry, policies and ArtifactStore: it starts at the real time (Core, SQLite and Git stamp
  // with it) and only moves forward, so backoff/watchdog windows elapse without real sleeps.
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "az", clock: () => clock().getTime() }));
  cleanups.push(async () => { store.close(); artifacts.close(); await rm(root, { recursive: true, force: true }); });
  const transport = new FakeAgentTransport(), panes = new Panes();
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock });
  const checks = [
    { id: "review", name: "review", evaluator: "review", required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" },
      configuration: { kind: "review", method: "manual_review", criterionIds: ["ac-1"], testNames: ["ac-1: The requested outcome is independently verifiable"], role: "reviewer", levels: [] } },
    { id: "regression", name: "regression", evaluator: "regression", required: true, timeout: { executionTimeoutMs: 3000, onTimeout: "block" },
      configuration: { kind: "deterministic", method: "integration_test", command: "test-regression", criterionIds: [], testNames: [], role: "tester", levels: ["integration"] } }
  ] as any;
  const gates: QualityGate[] = checks.map((check: any) => ({ id: check.id, evaluate: async (context: QualityGateContext) => {
    const config = context.definition.configuration as any, input = context.input as any;
    return { ok: true, value: { gateId: context.definition.id, runId: context.runId, taskId: context.taskId!, evaluationId: randomUUID(), status: "passed",
      findings: [], producedArtifacts: [], evaluatedAt: clock().toISOString(),
      metadata: { verification: { schemaVersion: 2, checkId: check.id, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
        sourceRevision: input.sourceRevision, specFingerprint: input.specFingerprint, scope: input.scope, independentExecution: true, isolated: true,
        executorId: "independent-test-host", role: config.role, method: config.method, ...(config.command ? { command: config.command, exitCode: 0 } : {}),
        testNames: config.testNames, criteria: config.criterionIds.map((criterionId: string) => ({ criterionId, passed: true, summary: "Host independently checked the criterion" })),
        summary: "Independent check" } } } };
  } }));
  let runtime: AgenticWorkflowRuntime;
  const policies = await loadAgenticPolicies({ repositoryPath: repository, artifactStore: artifacts, gates, clock,
    loadSpecification: id => runtime.loadSpecification(id), authorizeApprover: decision => ["coordinator", "human-1"].includes(decision.decidedBy) });
  const conversationInbox: RoleMessage[] = [];
  const ports: AgenticRuntimePorts = { engine: new DeterministicWorkflowEngine(), runStore: store, artifactStore: artifacts, registry, transport, panes, policies, clock,
    deliverToConversation: async (message: RoleMessage) => { conversationInbox.push(message); },
    roleCapabilities: { developer: ["implementation"], coordinator: ["coordination", "repository.read"], conversation: ["conversation"],
      architect: ["architecture", "repository.read"], reviewer: ["review", "repository.read"], qa: ["verification", "repository.read"], tester: ["testing", "repository.read"] },
    preflightRoleCapabilities: async () => undefined,
    taskChecks: checks, workflowChecks: checks,
    authenticateMessage: async () => true, authenticateResult: async () => true, authenticateEvidence: async () => true, authenticateGateResult: async () => true,
    authorizeHuman: async (decision: any) => decision.decidedBy === "human-1" };
  runtime = new AgenticWorkflowRuntime(ports, { journalDirectory: join(root, "journal"), repositoryPath: repository });
  const spec: Specification = draft("documentation");
  const time = clock().toISOString(); spec.createdAt = time; spec.updatedAt = time;
  spec.affectedPaths = ["guide.md"]; spec.traceabilityTaskIds = ["implement"];
  (spec.metadata!.sdd as any).traceability[0].taskIds = ["implement"];
  spec.metadata!.conditionalTdd = { policyVersion: 1, taskId: "implement", taskType: "documentation",
    changeImpact: { surfaces: ["documentation"], behaviorChanged: false, deterministic: false, regressionReproducible: false, securitySensitive: false, dataMigration: false, scope: "local" },
    infrastructure: { readiness: "ready", commands: [{ method: "integration_test", command: "test-regression", level: "integration" }] },
    testability: { level: "automated", rationale: "Independent repeatable behavioral checks are available" }, riskClassification: "low",
    conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] } };
  delete spec.testStrategy; delete spec.tddDecision;
  const def = workflow(["implement"]); def.maxConcurrency = 1;
  def.tasks.forEach(task => { (task as any).metadata = { ownedPaths: ["guide.md"] }; });
  const envelope = (type: string, payload: unknown, extra: any = {}) => RoleMessageSchema.parse({ schema_version: 2, message_id: randomUUID(), correlation_id: "correlation-1", run_id: "run-1",
    sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" }, recipient: { role: "coordinator" }, type, payload, artifact_references: [],
    occurred_at: clock().toISOString(), idempotency_key: randomUUID(), ...extra });
  const intake = envelope("delegation.request", { schemaVersion: 2, delegationId: "delegation-1", messageId: "intake-1", correlationId: "correlation-1", sessionId: "session-1", runId: "run-1",
    requestedBy: "conversation", targetRole: "coordinator", title: spec.title, objective: spec.summary, specificationId: spec.specId, sddLevel: spec.level,
    acceptanceCriteria: spec.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: time, idempotencyKey: "intake-1" }, { message_id: "intake-1", idempotency_key: "intake-1" });
  const state = async () => await runtime.inspect() as unknown as JournalState;
  const f = {
    root, repository, ports, panes, transport, conversationInbox, spec, def, envelope, intake, state,
    get runtime() { return runtime; },
    advance: (ms: number) => { offset += ms; },
    now: () => clock().getTime(),
    record: async () => await runtime.inspect("run-1") as unknown as RunRecord,
    ofKind: async (kind: string) => (await state()).outbound.filter(out => (out.message.payload as { kind?: string }).kind === kind),
    binding: (role: string) => panes.bindings.find(pane => pane.role === role)!,
    /** Flush until the given outbound has been handed to the transport (capacity of an earlier delivery frees on one pass). */
    deliveredById: async (messageId: string): Promise<Outbound> => {
      const find = async () => (await state()).outbound.find(out => out.message.message_id === messageId)!;
      for (let pass = 0; pass < 4 && ["queued", "sending"].includes((await find()).status); pass++) await runtime.flushOutbound();
      const out = await find();
      expect(["accepted", "released"], `${messageId}: ${out.status} ${out.error ?? ""}`).toContain(out.status);
      return out;
    },
    /** The host's inbound pump: apply, and on a deterministic failure report it after its bounded retries. */
    deliver: async (message: RoleMessage): Promise<unknown> => {
      try { return await runtime.receiveHerdr(message); }
      catch (error) {
        if (!(error instanceof AdmissionRejectedError)) await runtime.reportInboundFailure(message, `${String(error)} (dropped after 5 attempts)`);
        return error;
      }
    },
    /** One host watchdog pass with every role pane idle, `idleMs` after the last activity; the fake clock moves with it. */
    watchdog: async (idleMs = 181 * SECOND) => {
      const runs = await runtime.watchdogSnapshot("session-1");
      const at = Math.max(...runs.map(item => item.lastActivityAt)) + idleMs;
      if (at > f.now()) offset += at - f.now();
      const actions = evaluateWatchdog({ now: at, runs, notices: [],
        panes: panes.bindings.filter(pane => pane.role !== "conversation").map(pane => ({ role: pane.role, paneId: pane.paneId, status: "idle" })) });
      for (const action of actions) if (action.kind === "stalled") await runtime.reportRunStalled(action.runId, action.episodeKey);
      return actions;
    },
    async evidence(taskId: string) {
      const run = await runtime.inspect("run-1") as any; const task = run.tasks.find((t: any) => t.taskId === taskId); const strategy = task.spec.strategy;
      const startedAt = clock().toISOString(); const bytes = Buffer.from(`${taskId}-verification-${randomUUID()}`);
      const ref = unwrap(await artifacts.put({ options: { artifactId: randomUUID(), runId: "run-1", taskId, kind: "test-result", mediaType: "text/plain",
        expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length }, idempotencyKey: randomUUID() },
        content: (async function* () { yield bytes; })() }));
      const method = spec.acceptanceCriteria[0]!.verificationMethod;
      const result = VerificationResultSchema.parse({ schemaVersion: 2, verificationId: randomUUID(), runId: "run-1", taskId, cycleNumber: 1, attemptId: randomUUID(),
        status: "passed", independentExecution: true,
        evaluatedCriteria: [{ criterionId: "ac-1", passed: true, evidenceArtifactId: ref.artifactId, summary: "Observed target behavior" }],
        qualityGateResults: [], evidenceArtifacts: [ref], findings: [], verifiedBy: "tester", startedAt, completedAt: clock().toISOString(),
        metadata: { conditionalTdd: { phase: "verification", decisionId: strategy.tddDecision.decisionId, specId: strategy.specId,
          sourceRevision: "implementation-source", testRevision: "unchanged-tests", testNames: strategy.criterionMappings[0].testNames,
          observations: [{ method, criterionId: "ac-1", evidenceArtifactId: ref.artifactId, summary: "Independent observation" }] } } });
      await runtime.receiveHerdr(envelope("verification.result", result, { sender: { role: "tester" } }));
    },
    async submit(taskId = "implement") {
      const current = await state() as any;
      const outbound = [...current.outbound].reverse().find((out: any) => out.taskId === taskId && out.message.type === "task.assignment");
      const handle = outbound.handle; expect(handle).toBeDefined();
      await writeFile(join(handle.target.worktreePath, "guide.md"), "updated\n");
      git(handle.target.worktreePath, "add", "guide.md"); git(handle.target.worktreePath, "commit", "-m", "implement");
      const reworkContext = outbound.message.payload?.reworkContext as { reworkGeneration: number; findings: { findingId: string; code: string; message: string }[] } | undefined;
      const headRevision = git(handle.target.worktreePath, "rev-parse", "HEAD");
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
      const result = AgentResultSchema.parse({ requestId: handle.requestId, attemptId: handle.attemptId, runId: "run-1", taskId, executionId: handle.executionId, status: "succeeded",
        verification: { status: "verified", evidence: "Authenticated test-host result",
          correlation: unwrap(await ports.engine.getSnapshot("run-1"))!.tasks.find(task => task.taskId === taskId)!.bindingVerification?.receipt.correlation ?? handle.correlation },
        ...(findingResolutions ? { output: { findingResolutions } } : {}),
        artifactProposals: [], retryable: false, startedAt: handle.acceptedAt, completedAt: clock().toISOString() });
      await runtime.receiveHerdr(envelope("implementation.submitted", result, { causation_id: outbound.message.message_id,
        sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId } }));
    },
    approve: async () => {
      const run = await runtime.inspect("run-1") as any, request = run.approval;
      await runtime.receiveHerdr(envelope("approval.decision", ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId, runId: "run-1", sessionId: "session-1",
        target: request.target, revision: request.revision, generation: request.generation, decision: "approved", decidedBy: "human-1", decidedAt: clock().toISOString(),
        feedbackArtifacts: [], idempotencyKey: randomUUID() })));
    }
  };
  return f;
}

const exhaustedNotice = /Automatic resume stopped after 3 attempts/;

describe("A-Z acceptance: a delegation reaches delivery approval without a human resume", () => {
  it("recovers from one schema error, one no-next-action stop, one silent specialist and a security request, and reaches the final approval", async () => {
    const f = await fixture();
    const resumes: { automatic: boolean }[] = [];
    const original = f.runtime.resumeBlockedRun.bind(f.runtime);
    f.runtime.resumeBlockedRun = async (runId, actionId, options = {}) => { resumes.push({ automatic: options.automatic === true }); return original(runId, actionId, options); };
    const recoveries: string[] = [];
    const observe = async () => {
      const run = await f.record();
      if (run.pendingAction?.recovery) recoveries.push(run.pendingAction.recovery);
      expect(run.pendingAction?.recovery, JSON.stringify(run.pendingAction)).not.toBe("manual");
      return run;
    };

    // Conversation hands the delegation to the Coordinator through Herdr; the host applies the same envelope as ingress.
    await f.runtime.queueHerdr(f.intake);
    await f.deliveredById("intake-1");
    await f.runtime.receiveHerdr(f.intake);
    await observe();

    // (b) The Coordinator turn ends without a workflow next action: bounded auto_resume, woken after the 30 s backoff.
    await f.runtime.coordinatorTurnStopped(f.intake, f.binding("coordinator"));
    expect(await observe()).toMatchObject({ status: "escalated", pendingAction: { recovery: "auto_resume", resumeAttempts: 0, state: "pending" } });
    f.advance(29 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    f.advance(1 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
    const [wake] = await f.ofKind("resume_run");
    expect(wake!.message.payload).toMatchObject({ automatic: true, attempt: 1, limit: 3 });
    await f.deliveredById(wake!.message.message_id);
    expect((await observe()).status).not.toBe("escalated");

    // (d) The resumed Coordinator asks for `security`; the session has no such pane, so the capable Reviewer acts for it.
    const security = await f.runtime.requestSpecialist("run-1", "security", "Threat-model the change", ["review"]) as any;
    expect(security).toMatchObject({ recipient: { role: "reviewer" }, fallback: { requestedRole: "security", actingRole: "reviewer" } });
    const securityOut = await f.deliveredById(security.message_id);
    expect(securityOut.handle!.target.paneId).toBe("pane-reviewer");
    await observe();

    // (e) The Reviewer (Codex exec_command, Claude Bash) reads the repository with rg/cat through the host's tool_guard check.
    for (const tool of ["exec_command", "Bash"]) {
      for (const command of ["rg -n initial guide.md", "cat guide.md", "rg -l initial . | head -5"]) {
        const input = tool === "exec_command" ? { cmd: command } : { command };
        expect(guardNativeShell("reviewer", tool, input), `${tool}: ${command}`).toEqual({ permitted: true });
        expect(guardNativeShell("architect", tool, input).permitted).toBe(true);
      }
      expect(guardNativeShell("reviewer", tool, tool === "exec_command" ? { cmd: "cat guide.md > out" } : { command: "cat guide.md > out" }).permitted).toBe(false);
    }

    // (a) The Reviewer first sends a schema-invalid result: it goes back to the Reviewer, the run is not escalated.
    const reviewer = { role: "reviewer" as const, agent_id: "reviewer", pane_id: "pane-reviewer" };
    const invalid = f.envelope("verification.result", { status: "passed" }, { message_id: "bad-review-1", idempotency_key: "bad-review-1", causation_id: security.message_id, sender: reviewer });
    expect(String(await f.deliver(invalid))).toMatch(/verificationId|invalid_type|Required/);
    const rejected = await f.ofKind("role_message_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.message).toMatchObject({ recipient: { role: "reviewer" }, payload: { attempt: 1, limit: 3 } });
    expect((await observe()).status).not.toBe("escalated");
    await f.runtime.flushOutbound();
    await f.deliver(f.envelope("spec.draft", { status: "completed", summary: "No security finding in the documentation change" },
      { message_id: "good-review-1", idempotency_key: "good-review-1", causation_id: security.message_id, sender: reviewer }));
    expect((await f.ofKind("specialist_result_ready")).map(out => out.message.causation_id)).toEqual(["good-review-1"]);
    expect((await observe()).status).not.toBe("escalated");

    // (c) The Architect stops without a result: the watchdog reminds it once, then its late result is applied.
    const analysis = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]) as any;
    await f.deliveredById(analysis.message_id);
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const stalls = await f.watchdog();
    expect(stalls).toEqual([expect.objectContaining({ kind: "stalled", holders: ["architect"] })]);
    const reminders = await f.ofKind("result_reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.message).toMatchObject({ recipient: { role: "architect" }, causation_id: analysis.message_id });
    expect((await observe()).status).not.toBe("escalated");
    await f.deliver(f.envelope("spec.draft", { status: "completed", summary: "Impact analysis" },
      { message_id: "late-architect", idempotency_key: "late-architect", causation_id: analysis.message_id, sender: { role: "architect", agent_id: "architect", pane_id: "pane-architect" } }));
    expect((await f.ofKind("specialist_result_ready")).map(out => out.message.causation_id)).toEqual(["good-review-1", "late-architect"]);
    expect((await observe()).status).not.toBe("escalated");

    // The Coordinator proposes the workflow; Runtime dispatches, independently verifies and integrates it up to delivery approval.
    await f.runtime.flushOutbound();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await observe();
    await f.runtime.tick(); await f.evidence("implement"); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
    const final = await observe();
    expect(final.tasks[0]!.cycle?.status).toBe("passed");
    expect(final.workflowCycle?.status).toBe("passed");
    expect(final).toMatchObject({ status: "awaiting_approval", approvalKind: "delivery", approval: { status: "pending" } });
    expect(final.error).toBeUndefined();

    // No human resume, never manual, no exhausted-budget notice.
    expect(resumes).toEqual([{ automatic: true }]);
    expect(recoveries).not.toContain("manual");
    expect((await f.state()).outbound.filter(out => exhaustedNotice.test(String((out.message.payload as { headline?: string }).headline)))).toEqual([]);
    await f.approve();
    expect((await f.record()).status).toBe("completed");
  }, 90_000);
});

/** Conversation hands the delegation to the Coordinator through Herdr and the host applies it as ingress. */
async function delegate(f: Awaited<ReturnType<typeof fixture>>) {
  await f.runtime.queueHerdr(f.intake);
  await f.deliveredById("intake-1");
  await f.runtime.receiveHerdr(f.intake);
}
const exhaustedNotices = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.state()).outbound.filter(out =>
  out.message.recipient.role === "conversation" && exhaustedNotice.test(String((out.message.payload as { headline?: string }).headline)));

describe("A-Z acceptance: an implementing run stays recoverable", () => {
  it("keeps the run scheduled when the Coordinator asks the user a question after Core exists", async () => {
    const f = await fixture(); await delegate(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    expect((await f.record()).status).toBe("implementing");
    await f.runtime.reportProgress("run-1", "Dispatch is blocked by uncommitted files", ["Commit them or ignore them?"]);
    expect((await f.record()).status).toBe("implementing");
    expect((await f.state()).outbound.some(out => out.message.type === "conversation.clarification")).toBe(true);
  }, 60_000);

  it.each([
    ["a retryable infrastructure failure", { code: "transport_unavailable" as const, retryable: true as const,
      message: "Error: EISDIR: illegal operation on a directory, read", details: { stage: "prepare_launch", errno: "EISDIR" } }, "auto_resume"],
    ["a deliberate refusal", { code: "validation" as const, retryable: false as const,
      message: "Error: Platform has no prepared generation; run bflow up again" }, "manual"]
  ])("pauses Developer allocation after %s with the matching recovery", async (_name, error, recovery) => {
    const f = await fixture(); await delegate(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    f.panes.allocateDeveloper = async () => ({ ok: false as const, error }) as never;
    await f.runtime.tick();
    expect(await f.record()).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", state: "pending", recovery } });
  }, 60_000);

  it("heals a transient infrastructure allocation failure with no user action once the backoff elapses", async () => {
    const f = await fixture(); await delegate(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const allocate = f.panes.allocateDeveloper.bind(f.panes);
    f.panes.allocateDeveloper = async () => ({ ok: false as const, error: { code: "transport_unavailable" as const, retryable: true as const,
      message: "Error: EISDIR: illegal operation on a directory, read", details: { stage: "prepare_launch", errno: "EISDIR" } } }) as never;
    await f.runtime.tick();
    expect((await f.record()).pendingAction).toMatchObject({ recovery: "auto_resume", state: "pending" });
    f.advance(5 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 }); // still inside the backoff window
    f.panes.allocateDeveloper = allocate; // the fault cleared
    f.advance(31 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
    await f.runtime.tick();
    expect((await f.record()).status).toBe("implementing");
    expect((await f.state()).outbound.some(out => out.message.type === "task.assignment" && out.message.recipient.role === "developer")).toBe(true);
  }, 90_000);

  it("stops healing a persistent allocation fault after the automatic budget and leaves the decision to the user", async () => {
    const f = await fixture(); await delegate(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    let attempts = 0;
    f.panes.allocateDeveloper = async () => { attempts += 1; return { ok: false as const, error: { code: "transport_unavailable" as const, retryable: true as const,
      message: "Error: EISDIR: illegal operation on a directory, read" } } as never; };
    await f.runtime.tick();
    for (let round = 0; round < 6; round++) { f.advance(130 * SECOND); await f.runtime.resumeRecoverableRuns(); await f.runtime.tick(); }
    const blocked = await f.record();
    expect(blocked).toMatchObject({ status: "escalated", pendingAction: { recovery: "manual", state: "pending" } });
    const afterBudget = attempts;
    f.advance(600 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    await f.runtime.tick();
    expect(attempts).toBe(afterBudget); // no further automatic attempts
    expect(afterBudget).toBeLessThanOrEqual(5);
  }, 120_000);

  it("records a resumable action when Developer allocation fails and retries it after an explicit resume", async () => {
    const f = await fixture(); await delegate(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const allocate = f.panes.allocateDeveloper.bind(f.panes);
    f.panes.allocateDeveloper = async () => ({ ok: false as const, error: { code: "validation" as const, retryable: false as const,
      message: "A Herdr socket port is required to create panes with launch env" } }) as never;
    await f.runtime.tick();
    const blocked = await f.record();
    expect(blocked).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", state: "pending", previousStatus: "implementing" } });
    f.panes.allocateDeveloper = allocate;
    await f.runtime.resumeBlockedRun("run-1", blocked.pendingAction!.actionId);
    expect((await f.record()).status).toBe("implementing");
    await f.runtime.tick();
    expect((await f.state()).outbound.some(out => out.message.type === "task.assignment" && out.message.recipient.role === "developer")).toBe(true);
    // Agent CLIs refuse writes under `.git`; the Developer worktree lives in ignored private state instead.
    const worktreePath = (await f.record()).tasks[0]!.worktrees[0]!.worktreePath;
    expect(worktreePath.startsWith(join(f.repository, ".bflow", "state", "worktrees") + "/")).toBe(true);
    expect(worktreePath).not.toContain("/.git/");
  }, 60_000);
});

describe("A-Z acceptance: an infrastructure measurement failure is resumable", () => {
  it.each([false, true])("retires a blocked verifier only with physical authority, preserving unknown measurement outcome and the original request (crash=%s)", async crash => {
    const f = await fixture();
    (f.ports.roleCapabilities.qa as string[]).push("testing");
    const spec = structuredClone(f.spec);
    spec.acceptanceCriteria[0]!.verificationMethod = "integration_test";
    const intake = f.envelope("delegation.request", { ...(f.intake.payload as object), acceptanceCriteria: spec.acceptanceCriteria },
      { message_id: "intake-1", idempotency_key: "intake-1" });
    await f.runtime.queueHerdr(intake); await f.deliveredById("intake-1"); await f.runtime.receiveHerdr(intake);
    await f.runtime.proposeWorkflow("run-1", spec, f.def, 1);
    await f.runtime.tick();
    const assignment = (await f.state()).outbound.find(out => out.message.type === "task.assignment")!;
    const developer = f.panes.bindings.find(pane => pane.agentId === assignment.handle!.target.agentId)!;
    developer.session = assignment.handle!.target.session;
    const head = git(developer.worktreePath!, "rev-parse", "HEAD");
    const phase = (await f.record()).tasks[0]!.spec.strategy.tddDecision.mode === "required" ? "red" : "verification";
    const queued = await f.runtime.requestPhaseVerification(developer, "run-1", "implement", phase, head) as { messageId: string };
    const request = await f.deliveredById(queued.messageId);
    const qa = f.panes.bindings.find(pane => pane.paneId === request.handle!.target.paneId)!;
    const blockedReply = f.envelope("task.status", { status: "blocked", summary: "Host reconciliation unavailable; no measurement performed" }, {
      causation_id: queued.messageId, sender: { role: "qa", agent_id: qa.agentId, pane_id: qa.paneId }
    });
    await f.runtime.receiveHerdr(blockedReply);
    const coordinator = f.binding("coordinator");
    await f.runtime.observeCoordinatorOutcome(f.envelope("task.status", { status: "blocked", summary: "Await explicit continuation after host repair" }, {
      recipient: { role: "conversation" }, causation_id: blockedReply.message_id, sender: { role: "coordinator", agent_id: coordinator.agentId, pane_id: coordinator.paneId }
    }));
    const blocked = await f.record();
    if (crash) await (f.runtime as any).journal.exclusive(async (state: JournalState, save: () => Promise<void>) => {
      await new HerdrOutbox(f.ports, state, save).release(state.outbound.find(out => out.message.message_id === queued.messageId)!);
    });
    qa.paneId = "replacement-qa"; qa.session = { source: "test", kind: "id", value: "replacement-qa-session" };
    f.advance(301 * SECOND);
    const authority = { operationId: queued.messageId, sessionId: "session-1", userMessageId: "physical-retirement", userId: "human-1" };
    expect(typeof f.runtime.retirePolicyPhase).toBe("function");
    await expect(f.runtime.retirePolicyPhase(authority)).rejects.toThrow(/physical human/);
    f.ports.authorizePolicyPhaseRetirement = async () => true;
    await expect(f.runtime.retirePolicyPhase({ ...authority, sessionId: "other" })).rejects.toThrow(/Cross-session/);
    f.ports.hasPolicyPhaseReceipt = async () => true;
    await expect(f.runtime.retirePolicyPhase(authority)).rejects.toThrow(/host evidence/);
    f.ports.hasPolicyPhaseReceipt = async () => false;
    const replacementPane = qa.paneId; qa.paneId = request.handle!.target.paneId;
    await expect(f.runtime.retirePolicyPhase(authority)).rejects.toThrow(/retired verifier/);
    qa.paneId = replacementPane;
    const replacementSession = qa.session; qa.session = request.handle!.target.session;
    await expect(f.runtime.retirePolicyPhase(authority)).rejects.toThrow(/retired verifier/);
    qa.session = replacementSession;
    if (crash) {
      const internals = f.runtime as any, recover = internals.recoverPolicyPhaseRetirements;
      internals.recoverPolicyPhaseRetirements = async () => { throw new Error("crash after retirement tombstone"); };
      await expect(f.runtime.retirePolicyPhase(authority)).rejects.toThrow("crash after retirement tombstone");
      internals.recoverPolicyPhaseRetirements = recover;
      const fresh = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });
      await fresh.retirePolicyPhase(authority);
    } else await f.runtime.retirePolicyPhase(authority);
    const retired = (await f.state()).outbound.find(out => out.message.message_id === queued.messageId)!;
    expect(retired.phaseRetirement).toMatchObject({ disposition: "retired_without_measurement_claim", blockedReplyId: blockedReply.message_id });
    expect(retired.phaseFailure).toBeUndefined();
    expect(JSON.parse(await readFile(join(f.root, "journal", "state.json"), "utf8")).version).toBe(3);
    expect(retired.status).toBe("cancelled");
    expect(retired.phaseFailureEvidence).toBeUndefined();
    expect((await f.record()).tasks[0]!.spec.strategy.metadata?.tddEvidence ?? []).toHaveLength(0);
    expect((await f.state()).outbound.filter(out => out.message.type === "task.assignment")).toHaveLength(1);
    await expect(f.runtime.requestPhaseVerification(developer, "run-1", "implement", phase, head)).rejects.toThrow(/paused/);
    const reopened = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });
    await expect(reopened.retirePolicyPhase(authority)).resolves.toMatchObject({ alreadyRetired: true });
    await reopened.resumeBlockedRun("run-1", blocked.pendingAction!.actionId);
    await expect(f.runtime.requestPhaseVerification(developer, "run-1", "implement", phase, head)).rejects.toThrow(/Conversation resume/);
    expect((await f.state()).outbound.some(out => (out.message.payload as any).kind === "policy_phase_outcome" && out.message.causation_id === assignment.message.message_id)).toBe(false);
    await reopened.resumeBlockedRun("run-1", blocked.pendingAction!.actionId, { conversationUserMessageId: "physical-resume" });
    const retryNotice = (await f.state()).outbound.find(out => (out.message.payload as any).kind === "policy_phase_outcome" && (out.message.payload as any).status === "retry")!;
    expect(retryNotice).toBeDefined();
    f.advance(301 * SECOND);
    await reopened.flushOutbound(); await reopened.flushOutbound();
    expect((await f.state()).outbound.filter(out => out.message.message_id === retryNotice.message.message_id)).toHaveLength(1);
    expect(["accepted", "released"]).toContain((await f.state()).outbound.find(out => out.message.message_id === retryNotice.message.message_id)!.status);
    const late = f.envelope("verification.result", {}, { causation_id: queued.messageId, sender: { role: "qa", agent_id: request.handle!.target.agentId, pane_id: request.handle!.target.paneId } });
    await expect(reopened.receiveHerdr(late)).rejects.toThrow(/Retired policy phase/);
    await reopened.recoverMissingCoordinatorWakeups();
    expect((await f.record()).tasks[0]!.spec.strategy.metadata?.tddEvidence ?? []).toHaveLength(0);
    const next = await f.runtime.requestPhaseVerification(developer, "run-1", "implement", phase, head) as { messageId: string };
    expect(next.messageId).not.toBe(queued.messageId);
    expect((await f.state()).outbound.find(out => out.message.message_id === queued.messageId)!.message).toEqual(request.message);
    if (crash) {
      await expect(reopened.receiveHerdr(f.envelope("task.status", { action: "cancel", reason: "Cancel after retired verifier" }))).resolves.toMatchObject({ accepted: true });
      expect((await f.record()).cancelled).toBe(true);
      expect(f.transport.cancelledHandles.some(handle => handle.requestId === assignment.handle!.requestId)).toBe(true);
      return;
    }
    const second = await f.deliveredById(next.messageId);
    await f.runtime.receiveHerdr(f.envelope("task.status", { status: "blocked", summary: "Second verifier cannot continue" }, {
      causation_id: next.messageId, sender: { role: "qa", agent_id: qa.agentId, pane_id: qa.paneId }
    }));
    qa.paneId = "third-qa-pane"; qa.session = { source: "test", kind: "id", value: "third-qa-session" };
    f.advance(301 * SECOND);
    await expect(reopened.retirePolicyPhase({ ...authority, operationId: next.messageId, userMessageId: "second-physical-retirement" })).rejects.toThrow(/bound exhausted/);
    expect((await f.state()).outbound.filter(out => out.phaseRetirement)).toHaveLength(1);
    expect((await f.state()).outbound.find(out => out.message.message_id === next.messageId)!.handle).toEqual(second.handle);
  }, 60_000);

  it.each([false, true])("records a resume action and re-measures the same revision only after an explicit resume (recovery crash=%s)", async recoveryCrash => {
    const f = await fixture();
    (f.ports.roleCapabilities.qa as string[]).push("testing");
    const spec = structuredClone(f.spec);
    spec.acceptanceCriteria[0]!.verificationMethod = "integration_test";
    const intake = f.envelope("delegation.request", { ...(f.intake.payload as object), acceptanceCriteria: spec.acceptanceCriteria },
      { message_id: "intake-1", idempotency_key: "intake-1" });
    await f.runtime.queueHerdr(intake); await f.deliveredById("intake-1"); await f.runtime.receiveHerdr(intake);
    await f.runtime.proposeWorkflow("run-1", spec, f.def);
    await f.runtime.tick();
    const assignment = (await f.state()).outbound.find(out => out.message.type === "task.assignment")!;
    const developer = f.panes.bindings.find(pane => pane.agentId === assignment.handle!.target.agentId)!;
    developer.session = assignment.handle!.target.session;
    const head = git(developer.worktreePath!, "rev-parse", "HEAD");
    const phase = (await f.record()).tasks[0]!.spec.strategy.tddDecision.mode === "required" ? "red" : "verification";
    const queued = await f.runtime.requestPhaseVerification(developer, "run-1", "implement", phase, head) as { messageId: string };
    const request = await f.deliveredById(queued.messageId);
    const qa = f.panes.bindings.find(pane => pane.paneId === request.handle!.target.paneId)!;
    const measurementFailure = await f.runtime.recordPhaseFailure(qa, queued.messageId, "Behavioral runner infrastructure failure (prepare): exit 2", false);
    expect(measurementFailure).toMatchObject({ phaseRecorded: false, implementationAuthorized: false,
      outcome: { requestId: queued.messageId, phase, sourceRevision: head, repairable: false, summary: expect.stringContaining("infrastructure failure") },
      next: expect.stringContaining("Runtime") });
    expect(await f.runtime.recordPhaseFailure(qa, queued.messageId, "Behavioral runner infrastructure failure (prepare): exit 2", false)).toMatchObject({
      alreadyRecorded: true, phaseRecorded: false, implementationAuthorized: false, outcome: (measurementFailure as any).outcome });
    const blocked = await f.record();
    expect(blocked).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", state: "pending", recovery: "manual" } });
    await expect(f.runtime.requestPhaseVerification(developer, "run-1", "implement", phase, head)).rejects.toThrow(/paused awaiting resume/);
    await f.runtime.resumeBlockedRun("run-1", blocked.pendingAction!.actionId);
    expect((await f.record()).status).toBe(blocked.pendingAction!.previousStatus);
    const retryNotice = (await f.state()).outbound.find(out => out.message.type === "task.status" &&
      out.message.run_id === "run-1" && (out.message.payload as Record<string, unknown>).kind === "policy_phase_outcome" &&
      (out.message.payload as Record<string, unknown>).status === "retry");
    expect(retryNotice).toBeDefined();
    expect(retryNotice?.parentAssignmentId).toBe(assignment.message.message_id);
    expect(retryNotice?.message.recipient.pane_id).toBe(developer.paneId);
    expect(retryNotice?.message.payload).toMatchObject({ phase, status: "retry" });
    expect((await f.state()).outbound.filter(out => out.message.type === "task.assignment")).toHaveLength(1);
    f.advance(301 * SECOND);
    if (recoveryCrash) {
      await expect((f.runtime as any).journal.exclusive(async (state: JournalState, save: () => Promise<void>) => {
        const parent = state.outbound.find(out => out.message.message_id === assignment.message.message_id)!;
        const notice = state.outbound.find(out => out.message.message_id === retryNotice!.message.message_id)!;
        notice.status = "cancelled"; notice.error = "Task notice parent lease is expired or mismatched";
        const outbox = new HerdrOutbox(f.ports, state, save);
        await outbox.recoverTaskLease(parent, state.outbound.find(out => out.message.message_id === queued.messageId)!);
        throw new Error("crash after replacement lease before notice requeue");
      })).rejects.toThrow("crash after replacement lease");
    }
    await f.runtime.flushOutbound();
    await f.runtime.flushOutbound();
    const sameNotice = (await f.state()).outbound.filter(out => out.message.message_id === retryNotice!.message.message_id);
    expect(sameNotice).toHaveLength(1);
    expect(["accepted", "released"]).toContain(sameNotice[0]!.status);
    expect((await f.state()).outbound.find(out => out.message.message_id === assignment.message.message_id)!.leaseHistory).toHaveLength(1);
    const again = await f.runtime.requestPhaseVerification(developer, "run-1", "implement", phase, head) as { messageId: string };
    expect(again.messageId).not.toBe(queued.messageId);
  }, 60_000);
});

describe("A-Z acceptance: the automatic budget is bounded", () => {
  it("stops after 3 automatic resumes of a recurring no-next-action stop with one Conversation notice; an explicit user resume still runs", async () => {
    const f = await fixture();
    await delegate(f);
    // Failure 1: the delegated turn ends without a next action.
    await f.runtime.coordinatorTurnStopped(f.intake, f.binding("coordinator"));
    let actionId = (await f.record()).pendingAction!.actionId;
    const backoffs = [30, 60, 120];
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance((backoffs[attempt]! - 1) * SECOND);
      expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
      f.advance(SECOND);
      expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 1 });
      expect(await f.record()).toMatchObject({ pendingAction: { actionId, state: "queued", recovery: "auto_resume", resumeAttempts: attempt + 1 } });
      const wake = (await f.ofKind("resume_run")).at(-1)!;
      expect(wake.message.payload).toMatchObject({ actionId, automatic: true, attempt: attempt + 1, limit: 3 });
      // Failures 2-4: every resumed turn ends without a next action again. Each stop is a new episode (keyed by the wake it
      // follows) that inherits the spent budget, so the recurrence cannot loop.
      await f.deliveredById(wake.message.message_id);
      await f.runtime.coordinatorStopWithoutResponse(wake.message, f.binding("coordinator"));
      const stopped = await f.record();
      expect(stopped).toMatchObject({ status: "escalated", pendingAction: { state: "pending", recovery: "auto_resume", resumeAttempts: attempt + 1 } });
      actionId = stopped.pendingAction!.actionId;
    }
    expect(await f.ofKind("resume_run")).toHaveLength(3);
    expect((await f.ofKind("coordinator_no_response")).length).toBe(4);
    f.advance(10 * 60 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await f.record()).toMatchObject({ status: "escalated", pendingAction: { actionId, recovery: "manual", resumeAttempts: 3, state: "pending" } });
    const notices = await exhaustedNotices(f);
    expect(notices).toHaveLength(1);
    expect(String((notices[0]!.message.payload as { headline?: string }).headline)).toContain("tiếp tục run-1");
    await f.runtime.flushOutbound();
    expect(f.conversationInbox.filter(message => exhaustedNotice.test(String((message.payload as { headline?: string }).headline)))).toHaveLength(1);

    // The user's explicit resume is still honoured and wakes the Coordinator once more.
    await expect(f.runtime.resumeBlockedRun("run-1", actionId)).resolves.toMatchObject({ queued: true, actionId });
    const resumed = await f.record();
    expect(resumed.status).not.toBe("escalated");
    expect(resumed.pendingAction).toMatchObject({ state: "queued", recovery: "auto_resume", resumeAttempts: 0, manualResumeAttempts: 1 });
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await exhaustedNotices(f)).toHaveLength(1);
  });
});

describe("A-Z acceptance: human gates and uncertain deliveries are never resumed automatically", () => {
  const quiet = async (f: Awaited<ReturnType<typeof fixture>>) => {
    f.advance(10 * 60 * SECOND);
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(await f.ofKind("resume_run")).toEqual([]);
  };

  it("does not resume or stall-escalate while a user decision is pending", async () => {
    const f = await fixture();
    await delegate(f);
    await f.runtime.requestUserDecision(f.binding("coordinator"), "coordinator", { runId: "run-1", taskId: "planning", question: "Which storage backend?", options: ["SQLite", "Postgres"] });
    const before = await f.record();
    await f.runtime.coordinatorTurnStopped(f.intake, f.binding("coordinator")); // waiting on the user is a legitimate stop
    // The watchdog may only re-surface the pending question to Conversation; it never treats the wait as a stall.
    expect((await f.watchdog()).filter(action => action.kind !== "reconcile_notice")).toEqual([]);
    await quiet(f);
    const after = await f.record();
    expect(after.status).toBe(before.status); expect(after.pendingAction).toBeUndefined();
    expect(Object.values(after.userDecisions ?? {}).map(item => item.status)).toEqual(["pending"]);
  });

  it("does not resume past a pending delivery approval, even with a recoverable blocker recorded beside it", async () => {
    const f = await fixture();
    await delegate(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick(); await f.evidence("implement"); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
    expect(await f.record()).toMatchObject({ status: "awaiting_approval", approvalKind: "delivery" });
    expect(await f.watchdog()).toEqual([]);
    await f.runtime.reportRunStalled("run-1", "run-1@forced");
    await quiet(f);
    expect(await f.record()).toMatchObject({ status: "awaiting_approval" });
    // A blocker recorded while the approval is open still waits for the human decision.
    await (f.runtime as any).journal.exclusive(async (state: JournalState, save: () => Promise<void>) => {
      const run = state.runs[0]!;
      run.status = "escalated"; run.error = "Coordinator blocked: transient";
      run.pendingAction = { actionId: `next-${digest(["run-1", "intake-1"])}`, kind: "resume_coordinator", owner: "coordinator", reason: run.error, sourceMessageId: "intake-1",
        createdAt: new Date(f.now()).toISOString(), state: "pending", previousStatus: "awaiting_approval", resumeAttempts: 0, recovery: "auto_resume" };
      await save();
    });
    await quiet(f);
    const run = await f.record();
    expect(run).toMatchObject({ status: "escalated", pendingAction: { state: "pending", resumeAttempts: 0, recovery: "auto_resume" } });
    expect(run.approval).toMatchObject({ status: "pending" });
    expect(run.decision?.approvalId).not.toBe(run.approval!.approvalId); // never answered automatically
  }, 90_000);

  it("never resends an unknown_delivery and keeps the run waiting for reconciliation", async () => {
    const f = await fixture();
    await delegate(f);
    f.transport.customSendHandler = () => ({ ok: false, error: { code: "timeout", retryable: true, message: "lost ACK" } } as never);
    const request = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]) as any;
    await f.runtime.flushOutbound();
    const uncertain = async () => (await f.state()).outbound.find(out => out.message.message_id === request.message_id)!;
    expect((await uncertain()).status).toBe("unknown_delivery");
    const sent = () => f.transport.sentRequests.filter(item => item.role === "architect").length;
    const sentBefore = sent();
    expect(sentBefore).toBe(1);
    delete f.transport.customSendHandler;
    // The uncertain handoff is a durable reconcile-only wait; a Coordinator stop does not turn it into an automatic resume.
    const waiting = { kind: "resume_coordinator", recovery: "reconcile_delivery", state: "pending" };
    expect((await f.record()).pendingAction).toMatchObject(waiting);
    await f.runtime.coordinatorTurnStopped(f.intake, f.binding("coordinator"));
    expect((await f.record()).pendingAction).toMatchObject(waiting);
    await f.watchdog();
    await quiet(f);
    await f.runtime.flushOutbound(); await f.runtime.tick(); await f.runtime.flushOutbound();
    expect(await f.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    expect(sent()).toBe(sentBefore);
    expect((await uncertain()).status).toBe("unknown_delivery");
    const after = await f.record();
    expect(after.pendingAction).toMatchObject(waiting);
    expect(after.pendingAction!.resumeAttempts ?? 0).toBe(0); // no automatic attempt was spent
    // Not even an explicit resume resends it: only a reconciliation that proves not_delivered may.
    await expect(f.runtime.resumeBlockedRun("run-1", (await f.record()).pendingAction!.actionId)).rejects.toThrow();
    await f.runtime.flushOutbound();
    expect(sent()).toBe(sentBefore);
    expect((await uncertain()).status).toBe("unknown_delivery");
  });
});

describe("human fencing of a stale diagnostic without claiming delivery", () => {
  async function fencedFixture() {
    const f = await fixture(); await delegate(f);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    f.binding("coordinator").session = { source: "herdr:codex", kind: "id", value: "current-coordinator" };
    f.ports.authorizeNativeDiagnosticFence = async authority => authority.userId === "human-1" && authority.sessionId === "session-1";
    const message = f.envelope("task.status", { status: "blocked", summary: "Retired Coordinator diagnostic" }, {
      message_id: "old-native-diagnostic", idempotency_key: "old-native-diagnostic", recipient: { role: "conversation" },
      sender: { role: "coordinator", agent_id: "coordinator", pane_id: "retired-coordinator" }
    });
    await f.runtime.recordNativeDeliveryIntent(message, "old-diagnostic");
    const authority = { operationId: "old-diagnostic", sessionId: "session-1", userMessageId: "trusted-user-fence", userId: "human-1" };
    return { ...f, message, authority };
  }

  it("preserves the unknown intent, rejects late arrival across restart, and grants no business success", async () => {
    const f = await fencedFixture();
    const before = await f.record();
    const result = await f.runtime.fenceNativeDiagnostic(f.authority) as any;
    expect(result).toMatchObject({ disposition: "fenced_without_delivery_claim", delivery: "unknown_delivery", resendAllowed: false });
    let run = await f.record();
    expect(run.nativeDeliveries).toHaveLength(0);
    expect(run.nativeDiagnosticFences?.[0]?.message).toEqual(f.message);
    expect(run.status).toBe(before.status);
    expect(run.decision).toEqual(before.decision);
    expect(run.tasks[0]!.spec.strategy).toEqual(before.tasks[0]!.spec.strategy);
    await expect(f.runtime.observeCoordinatorOutcome(f.message)).rejects.toThrow(/fenced/);
    expect((await f.record()).status).toBe(before.status);
    const reopened = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });
    await reopened.initialize();
    await reopened.recordNativeDeliveryIntent(f.message, f.authority.operationId);
    run = await reopened.inspect("run-1") as unknown as RunRecord;
    expect(run.nativeDeliveries).toHaveLength(0);
    expect(run.nativeDiagnosticFences).toHaveLength(1);
    await expect(reopened.observeCoordinatorOutcome(f.message)).rejects.toThrow(/fenced/);
    const path = join(f.root, "journal/state.json");
    const encoded = JSON.parse(await readFile(path, "utf8"));
    expect(encoded.version).toBe(2);
    encoded.version = 1;
    await writeFile(path, JSON.stringify(encoded));
    await expect(reopened.inspect("run-1")).rejects.toThrow("require private journal v2");
  }, 60000);

  it("fences a blocked report from a retired specialist pane only, never from a live pane or a Developer", async () => {
    const f = await fencedFixture();
    const qa = f.binding("qa");
    const blocked = (id: string, patch: Record<string, unknown>) => RoleMessageSchema.parse({ ...f.message, ...patch, message_id: id, idempotency_key: id });
    const stale = blocked("qa-stale", { recipient: { role: "coordinator" }, sender: { role: "qa", agent_id: qa.agentId, pane_id: "retired-qa" } });
    await f.runtime.recordNativeDeliveryIntent(stale, "qa-stale");
    await expect(f.runtime.fenceNativeDiagnostic({ ...f.authority, operationId: "qa-stale" })).resolves.toMatchObject({ disposition: "fenced_without_delivery_claim", resendAllowed: false });
    expect((await f.record()).nativeDiagnosticFences?.map(item => item.message.message_id)).toEqual(["qa-stale"]);
    const reopened = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });
    await reopened.initialize();
    await reopened.recordNativeDeliveryIntent(stale, "qa-stale");
    const restored = await reopened.inspect("run-1") as unknown as RunRecord;
    expect((restored.nativeDeliveries ?? []).map(item => item.operationId)).toEqual(["old-diagnostic"]);
    expect(restored.nativeDiagnosticFences).toHaveLength(1);
    for (const [id, patch] of [
      ["qa-live", { recipient: { role: "coordinator" }, sender: { role: "qa", agent_id: qa.agentId, pane_id: qa.paneId } }],
      ["dev-to-coordinator", { recipient: { role: "coordinator" }, sender: { role: "developer", agent_id: "dev-1", pane_id: "retired-dev" } }]
    ] as const) {
      await f.runtime.recordNativeDeliveryIntent(blocked(id, patch), id).catch(() => undefined);
      await expect(f.runtime.fenceNativeDiagnostic({ ...f.authority, operationId: id })).rejects.toThrow();
    }
  }, 60000);

  it("refuses missing human authority, cross-session input, live-sender diagnostics and conclusive payloads", async () => {
    const f = await fencedFixture();
    f.ports.authorizeNativeDiagnosticFence = async () => false;
    await expect(f.runtime.fenceNativeDiagnostic(f.authority)).rejects.toThrow(/human/);
    f.ports.authorizeNativeDiagnosticFence = async () => true;
    await expect(f.runtime.fenceNativeDiagnostic({ ...f.authority, sessionId: "another-session" })).rejects.toThrow(/session/);
    for (const [id, patch] of [
      ["live-source", { sender: { role: "coordinator", agent_id: "coordinator", pane_id: f.binding("coordinator").paneId } }],
      ["completed", { payload: { status: "completed", summary: "Claimed completion" } }],
      ["assignment", { type: "task.assignment", recipient: { role: "developer" } }],
      ["approval", { type: "approval.decision" }]
    ] as const) {
      const message = RoleMessageSchema.parse({ ...f.message, ...patch, message_id: id, idempotency_key: id });
      await f.runtime.recordNativeDeliveryIntent(message, id);
      await expect(f.runtime.fenceNativeDiagnostic({ ...f.authority, operationId: id })).rejects.toThrow();
    }
    expect((await f.record()).nativeDiagnosticFences ?? []).toHaveLength(0);
  }, 60000);
});
