import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import {
  AgentResultSchema, AppendEventsRequestSchema, ApprovalDecisionSchema, ApprovalRequestSchema, ArtifactReferenceSchema,
  ArtifactWriteOptionsSchema, DomainEventSchema, SpecificationSchema, StoredRunSchema, VerificationResultSchema,
  WorkflowAdvanceResultSchema, type ApprovalDecision, type ArtifactReference, type ArtifactStore, type OperationResult,
  type RunStore, type TestStrategy, type WorkflowAdvanceResult, type WorkflowDefinition, type WorkflowEngine,
  type WorkflowRunSnapshot
} from "@bflow/contracts";
import { TestStrategyResolver, assertEvidenceComplete, recordEvidence } from "@bflow/test-strategy";
import {
  AnalysisIntakeSchema, RoleOutputSchemas, SurveyObservationSchema, analysisDigest, forbiddenOutputKeys,
  type AnalysisDocument, type AnalysisIntake, type AnalysisIntakeInput, type AnalysisTaskKind, type SurveyObservation
} from "./model.js";
import { resolveAnalysisPack, type AnalysisPackPin, type AnalysisPackPolicy } from "./pack.js";
import { ANALYSIS_GATES, assertAnalysisOnlyWorkflow, planAnalysisWorkflow } from "./plan.js";
import { renderAnalysisDocument, renderVerificationSummary } from "./render.js";
import { verifyAnalysisDocument, type AnalysisVerification } from "./verify.js";

/** One assignment delivered to a standard role; it carries read context only, never write/command authority. */
export interface AnalysisAssignment {
  readonly runId: string;
  readonly taskId: AnalysisTaskKind;
  readonly role: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly instruction: string;
  readonly intake: AnalysisIntake;
  readonly outputSections: readonly string[];
  readonly permissions: { readonly read: readonly string[]; readonly write: "none"; readonly commands: "none" };
  readonly context: {
    readonly observations: readonly SurveyObservation[];
    readonly questions: readonly { id: string; question: string; blocking: boolean }[];
    readonly decisions: Readonly<Record<string, { answer: string }>>;
    readonly document?: { readonly version: number; readonly digest: string; readonly content: AnalysisDocument };
    readonly findings: readonly { code: string; ids: readonly string[]; message: string }[];
  };
}

export type AnalysisReconciliation =
  | { readonly status: "not_delivered" }
  | { readonly status: "completed"; readonly agentId: string; readonly output: unknown }
  | { readonly status: "unknown" };

/** Role transport port. The persistent host would deliver over Runtime → Herdr; tests use deterministic fixtures. */
export interface AnalysisRolePort {
  dispatch(assignment: AnalysisAssignment): Promise<{ readonly agentId: string; readonly output: unknown }>;
  /** Outcome of an execution whose result was not journaled before a restart; absent means unknown. */
  reconcile?(executionId: string): Promise<AnalysisReconciliation>;
}

export interface AnalysisRuntimePorts {
  readonly engine: WorkflowEngine;
  readonly runStore: RunStore;
  readonly artifactStore: ArtifactStore;
  readonly roles: AnalysisRolePort;
  /** Absolute repository (or documentation worktree) root: survey reads and handoff writes stay inside it. */
  readonly repositoryRoot: string;
  /** Private, absolute journal file of the analysis extension. */
  readonly journalPath: string;
  /** Authenticates a human decision; agent roles and the Coordinator can never satisfy it. */
  authorizeHuman(decision: ApprovalDecision): boolean | Promise<boolean>;
  now(): string;
}

export type AnalysisRunStatus = "running" | "awaiting_business_decision" | "awaiting_document_approval" | "blocked" |
  "needs_revision" | "published" | "superseded" | "failed";

interface ExecutionRecord {
  executionId: string; taskId: AnalysisTaskKind; attemptId: string; attempt: number; generation: number;
  state: "bound" | "recorded"; agentId?: string; outputDigest?: string; startedAt: string;
  /** Set with state "recorded": the processed outcome that Core must receive (re-submitted idempotently after a restart). */
  failure?: { code: string; message: string } | null; completedAt?: string;
}
interface DocumentRecord { version: number; digest: string; artifact: ArtifactReference; authorAgentId: string; attemptId: string; content: AnalysisDocument }
interface RunRecord {
  runId: string; intake: AnalysisIntake; intakeDigest: string; policy: AnalysisPackPolicy; definition: WorkflowDefinition;
  status: AnalysisRunStatus; createdAt: string; strategy: TestStrategy; coreCreated: boolean;
  executions: ExecutionRecord[]; observations: SurveyObservation[];
  questions: { id: string; question: string; blocking: boolean }[];
  decisions: Record<string, { answer: string; decidedBy: string; decidedAt: string }>;
  documents: DocumentRecord[];
  verifications: { documentDigest: string; attemptId: string; at: string; status: AnalysisVerification["status"]; artifact: ArtifactReference; result: AnalysisVerification }[];
  review?: { agentId: string; verdict: "approved" | "changes_requested"; documentDigest: string; artifact: ArtifactReference;
    findings: { id: string; severity: "blocking" | "advisory"; statementIds: string[]; note: string }[] };
  approvals: { elicitation?: { approvalId: string; decision?: ApprovalDecision["decision"] }; document?: { approvalId: string; documentDigest: string; decision?: ApprovalDecision } };
  denials: { executionId: string; taskId: string; reason: string; at: string }[];
  /** Rejected (non-permission) outputs, kept for diagnosis of failed attempts. */
  rejections: { executionId: string; taskId: string; code: string; message: string; at: string }[];
  handoff?: { artifact: ArtifactReference; files: { path: string; sha256: string }[]; digest: string };
  blockers: string[];
  supersededBy?: string;
}
interface Journal { schemaVersion: 1; runs: RunRecord[] }

export class AnalysisPermissionDenied extends Error {
  constructor(message: string) { super(message); this.name = "AnalysisPermissionDenied"; }
}

function alternativeMethods(strategy: TestStrategy): string[] {
  const policy = strategy.metadata?.conditionalTdd;
  const methods = policy && typeof policy === "object" && !Array.isArray(policy) ? policy.requiredVerificationMethods : undefined;
  return Array.isArray(methods) ? methods.filter((item): item is string => typeof item === "string") : [];
}
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function relativeSafe(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/"));
  if (!path || isAbsolute(path) || normalized.startsWith("../") || normalized === ".." || normalized === "." || /\0/.test(path))
    throw new AnalysisPermissionDenied(`Path must be a normalized repository-relative path: ${path}`);
  return normalized.replace(/\/$/, "");
}

/**
 * Analysis-only (BA) workflow extension. It reuses the deterministic Core engine for DAG/state/approval/gate legality,
 * RunStore for authoritative events, ArtifactStore for trusted documents and the Conditional TDD resolver for the
 * not_applicable decision with alternative verification. It never creates implementation, Git integration, install or
 * deploy work, and roles receive no write/command authority: only Runtime publishes the approved handoff.
 */
export class AnalysisWorkflowRuntime {
  private journal: Journal = { schemaVersion: 1, runs: [] };
  private readonly createdInEngine = new Set<string>();
  private constructor(private readonly ports: AnalysisRuntimePorts) {}

  static async open(ports: AnalysisRuntimePorts): Promise<AnalysisWorkflowRuntime> {
    if (!isAbsolute(ports.repositoryRoot) || !isAbsolute(ports.journalPath)) throw new Error("Analysis runtime paths must be absolute");
    const runtime = new AnalysisWorkflowRuntime(ports);
    try {
      const parsed = JSON.parse(await readFile(ports.journalPath, "utf8")) as Journal;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.runs)) throw new Error("Unsupported analysis journal version");
      runtime.journal = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return runtime;
  }

  /** Read-only public view of one run. */
  status(runId: string) {
    const run = this.run(runId);
    return structuredClone({ runId: run.runId, status: run.status, revision: run.intake.revision, pack: run.policy.pack,
      tdd: { mode: run.strategy.tddDecision.mode, alternativeVerification: alternativeMethods(run.strategy) },
      blockers: run.blockers, questions: run.questions, decisions: run.decisions, denials: run.denials, rejections: run.rejections,
      documents: run.documents.map(item => ({ version: item.version, digest: item.digest, artifactId: item.artifact.artifactId })),
      verification: run.verifications.at(-1) ? { status: run.verifications.at(-1)!.status, findings: run.verifications.at(-1)!.result.findings } : undefined,
      review: run.review ? { verdict: run.review.verdict, documentDigest: run.review.documentDigest, findings: run.review.findings } : undefined,
      approvals: run.approvals, handoff: run.handoff, supersededBy: run.supersededBy, definition: run.definition });
  }

  /**
   * Intake + pack → Coordinator plan. A Coordinator-proposed definition is validated against analysis-only policy;
   * without one the default DAG is planned. Nothing is dispatched until {@link drive}.
   */
  async start(input: { runId: string; intake: AnalysisIntakeInput; pack: unknown; packPin: AnalysisPackPin; definition?: unknown; maxIterations?: number }) {
    if (this.journal.runs.some(item => item.runId === input.runId)) throw new Error(`Analysis run ${input.runId} already exists`);
    const intake = AnalysisIntakeSchema.parse(input.intake);
    const documentRoot = relativeSafe(intake.documentRoot);
    for (const path of intake.surveyPaths.map(relativeSafe))
      if (path === documentRoot || path.startsWith(`${documentRoot}/`) || documentRoot.startsWith(`${path}/`))
        throw new AnalysisPermissionDenied("The document root cannot overlap the read-only survey paths");
    const policy = resolveAnalysisPack(input.pack, input.packPin);
    const definition = input.definition === undefined ? planAnalysisWorkflow(intake, policy, input.maxIterations)
      : assertAnalysisOnlyWorkflow(input.definition, intake, policy, input.maxIterations);
    const createdAt = this.ports.now();
    const run: RunRecord = { runId: input.runId, intake, intakeDigest: analysisDigest(intake), policy, definition, status: "running",
      createdAt, strategy: this.resolveStrategy(input.runId, intake, createdAt), coreCreated: false, executions: [], observations: [],
      questions: intake.requiredDecisions.map(item => ({ id: item.id, question: item.question, blocking: item.blocking })),
      decisions: { ...intake.answeredDecisions }, documents: [], verifications: [], approvals: {}, denials: [], rejections: [], blockers: [] };
    this.journal.runs.push(run);
    await this.save();
    await this.createCore(run);
    return this.status(run.runId);
  }

  /** Conditional TDD: analysis documents have no executable behavior, so TDD is not_applicable with alternative verification. */
  private resolveStrategy(runId: string, intake: AnalysisIntake, at: string): TestStrategy {
    const strategy = new TestStrategyResolver().resolve(this.analysisSpecification(runId, intake, at));
    if (strategy.tddDecision.mode !== "not_applicable") throw new Error("Analysis-only work must resolve TDD as not_applicable");
    return strategy;
  }
  private analysisSpecification(runId: string, intake: AnalysisIntake, at: string) {
    return SpecificationSchema.parse({ schemaVersion: 2, specId: `analysis-${intake.requestId}-r${intake.revision}`, runId, sessionId: intake.sessionId,
      level: "lightweight", title: intake.title, summary: "Analysis-only handoff; no product implementation", problemStatement: intake.userStatements[0]!.text,
      scope: { inScope: intake.deliverables.map(item => `analysis ${item}`), outOfScope: ["product implementation, deployment and installation"] },
      acceptanceCriteria: intake.acceptanceCriteria.map(item => ({ id: item.id, description: item.description, category: "functional",
        verificationMethod: "manual_review", required: item.required, status: "pending", evidenceArtifactIds: [] })),
      affectedPaths: this.handoffPaths(intake), status: "draft", createdBy: "coordinator", createdAt: at, updatedAt: at,
      metadata: { conditionalTdd: { policyVersion: 1, taskId: "analysis", taskType: "documentation",
        changeImpact: { surfaces: ["documentation"], behaviorChanged: false, deterministic: false, regressionReproducible: false,
          securitySensitive: false, dataMigration: false, scope: "local" },
        infrastructure: { readiness: "absent", commands: [] },
        testability: { level: "none", rationale: "An analysis document has no executable behavior; it is verified by checks and independent review." },
        riskClassification: "low", conventions: { tdd: "contextual", requiredMethods: ["manual_review"], suggestedLevels: [] } } } });
  }
  private handoffPaths(intake: AnalysisIntake): string[] {
    const base = `${relativeSafe(intake.documentRoot)}/${intake.requestId}/r${intake.revision}`;
    return [`${base}/analysis.md`, `${base}/handoff.md`];
  }

  /** Runs every step that needs no human input; returns at a human gate, a blocker or completion. */
  async drive(runId: string) {
    const run = this.run(runId);
    if (run.status === "superseded") throw new Error(`Analysis run ${runId} was superseded by ${run.supersededBy}`);
    await this.restoreCore(run);
    for (let guard = 0; guard < 200; guard++) {
      let snapshot = await this.snapshot(runId);
      if (TERMINAL.has(snapshot.status)) return this.finish(run, snapshot);
      for (const task of snapshot.tasks.filter(item => item.status === "retrying"))
        snapshot = await this.mutate(runId, version => this.ports.engine.transitionTask({ runId, taskId: task.taskId, from: "retrying", to: "ready",
          intent: "normal", generationFrom: task.generation, generationTo: task.generation, expectedVersion: version, idempotencyKey: `analysis:ready:${task.taskId}:${task.attempt}`,
          occurredAt: this.ports.now(), reason: "bounded retry eligible" }));
      snapshot = await this.mutate(runId, version => this.ports.engine.advance({ runId, expectedVersion: version,
        idempotencyKey: `analysis:advance:${runId}:${version}`, occurredAt: this.ports.now() }));
      const active = snapshot.tasks.find(item => item.status === "running" || item.status === "waiting");
      if (active) { await this.execute(run, active); continue; }
      if (run.status !== "running") { await this.save(); return this.status(runId); }
      // A permanently failed or blocked task stops the run before any human is asked to decide for a doomed workflow.
      if (snapshot.tasks.some(item => item.status === "blocked" || item.status === "failed")) {
        if (run.status === "running") run.status = "blocked";
        await this.save();
        return this.status(runId);
      }
      if (await this.requestApprovals(run, snapshot)) return this.status(runId);
      return this.status(runId);
    }
    throw new Error("Analysis workflow made no bounded progress");
  }

  private async execute(run: RunRecord, task: WorkflowRunSnapshot["tasks"][number]): Promise<void> {
    const kind = task.taskId as AnalysisTaskKind;
    let existing = run.executions.find(item => item.attemptId === task.attemptId);
    if (!existing && task.agentExecution && task.agentExecution.attemptId === task.attemptId) {
      // Core persisted the binding but the journal write was lost: adopt Core's binding and reconcile it, never rebind.
      existing = { executionId: task.agentExecution.executionId, taskId: kind, attemptId: task.attemptId!, attempt: task.attempt,
        generation: task.generation, state: "bound", startedAt: task.agentExecution.acceptedAt };
      run.executions.push(existing);
      await this.save();
    }
    if (task.status === "waiting") {
      // Result recorded, gate evaluation interrupted: re-evaluate from journaled evidence (idempotent evaluation IDs).
      await this.evaluateGates(run, task, existing!);
      return;
    }
    if (existing?.state === "recorded") {
      // Already processed and journaled; only the Core result write was interrupted.
      await this.recordResult(run, existing);
      return;
    }
    let outcome: { agentId: string; output: unknown } | undefined;
    let execution = existing;
    if (execution) {
      // Bound before the restart, result never journaled: reconcile instead of resending.
      if (kind === "publication") outcome = { agentId: "runtime", output: undefined };
      else {
        const reconciliation = await this.ports.roles.reconcile?.(execution.executionId) ?? { status: "unknown" as const };
        if (reconciliation.status === "unknown") {
          run.status = "blocked";
          run.blockers = [...new Set([...run.blockers, `unknown_delivery:${execution.executionId}`])];
          await this.save();
          throw new Error(`Execution ${execution.executionId} has unknown delivery; reconcile before resending`);
        }
        if (reconciliation.status === "completed") outcome = { agentId: reconciliation.agentId, output: reconciliation.output };
        // Reconciliation settled the delivery: only its own blocker is cleared.
        run.blockers = run.blockers.filter(item => item !== `unknown_delivery:${execution!.executionId}`);
        if (run.status === "blocked" && !run.blockers.length) run.status = "running";
      }
    } else {
      execution = { executionId: `${run.runId}.${task.taskId}.g${task.generation}.a${task.attempt}`, taskId: kind,
        attemptId: task.attemptId!, attempt: task.attempt, generation: task.generation, state: "bound", startedAt: this.ports.now() };
      const handle = this.handle(run, execution);
      // Core binding is persisted before any delivery so a restart can only reconcile, never blindly resend.
      await this.mutate(run.runId, version => this.ports.engine.bindAgentExecution({ runId: run.runId, taskId: task.taskId, attempt: task.attempt,
        handle, expectedVersion: version, idempotencyKey: `analysis:bind:${execution!.executionId}`, occurredAt: execution!.startedAt }));
      run.executions.push(execution);
      await this.save();
    }
    if (outcome === undefined) {
      outcome = kind === "publication" ? { agentId: "runtime", output: undefined }
        : await this.ports.roles.dispatch(this.assignment(run, kind, execution));
    }
    await this.complete(run, execution, outcome);
  }

  private handle(run: RunRecord, execution: ExecutionRecord) {
    return { executionId: execution.executionId, requestId: `request-${execution.executionId}`, attemptId: execution.attemptId,
      runId: run.runId, taskId: execution.taskId, idempotencyKey: `analysis:dispatch:${execution.executionId}`,
      target: { transport: execution.taskId === "publication" ? "runtime-publication" : "analysis-role",
        agentId: this.roleOf(run, execution.taskId), paneId: execution.taskId },
      correlation: { token: sha256(`${run.runId}:${execution.executionId}`), provenance: "remote" as const, verified: true },
      acceptedAt: execution.startedAt };
  }
  private roleOf(run: RunRecord, taskId: string): string {
    return run.definition.tasks.find(item => item.id === taskId)!.role;
  }

  private assignment(run: RunRecord, kind: AnalysisTaskKind, execution: ExecutionRecord): AnalysisAssignment {
    const latest = run.documents.at(-1);
    const verification = run.verifications.at(-1);
    return structuredClone({ runId: run.runId, taskId: kind, role: this.roleOf(run, kind), executionId: execution.executionId,
      attemptId: execution.attemptId, instruction: run.definition.tasks.find(item => item.id === kind)!.instruction, intake: run.intake,
      outputSections: run.policy.outputSections, permissions: { read: run.intake.surveyPaths, write: "none" as const, commands: "none" as const },
      context: { observations: run.observations, questions: run.questions,
        decisions: Object.fromEntries(Object.entries(run.decisions).map(([id, value]) => [id, { answer: value.answer }])),
        ...(latest ? { document: { version: latest.version, digest: latest.digest, content: latest.content } } : {}),
        findings: [...run.intake.revisionFindings, ...(verification && verification.status !== "passed" ? verification.result.findings : []),
          ...(run.review?.verdict === "changes_requested" ? run.review.findings.map(item => ({ code: "review", ids: item.statementIds, message: item.note })) : [])]
          .map(item => ({ code: item.code, ids: [...item.ids], message: item.message })) } });
  }

  private async complete(run: RunRecord, execution: ExecutionRecord, outcome: { agentId: string; output: unknown }) {
    const kind = execution.taskId;
    let failure: { code: string; message: string } | undefined;
    try {
      const forbidden = forbiddenOutputKeys(outcome.output);
      if (forbidden.length) throw new AnalysisPermissionDenied(`Role output requested forbidden authority: ${forbidden.join(", ")}`);
      if (kind !== "publication" && outcome.agentId !== this.roleOf(run, kind) && !outcome.agentId.startsWith(`${this.roleOf(run, kind)}:`))
        throw new AnalysisPermissionDenied(`Output came from ${outcome.agentId}, not the assigned ${this.roleOf(run, kind)} role`);
      if (kind === "survey") await this.acceptSurvey(run, RoleOutputSchemas.survey.parse(outcome.output));
      else if (kind === "elicitation") this.acceptElicitation(run, RoleOutputSchemas.elicitation.parse(outcome.output));
      else if (kind === "specification") await this.acceptDocument(run, execution, outcome.agentId, RoleOutputSchemas.specification.parse(outcome.output).document);
      else if (kind === "review") await this.acceptReview(run, outcome.agentId, RoleOutputSchemas.review.parse(outcome.output));
      else await this.publish(run);
    } catch (error) {
      if (error instanceof AnalysisPermissionDenied) {
        run.denials.push({ executionId: execution.executionId, taskId: kind, reason: error.message, at: this.ports.now() });
        failure = { code: "permission_denied", message: error.message };
      } else if (kind !== "publication" && error instanceof Error && error.name === "ZodError") {
        failure = { code: "invalid_role_output", message: error.message.slice(0, 2000) };
      } else throw error;
    }
    if (failure && failure.code !== "permission_denied")
      run.rejections.push({ executionId: execution.executionId, taskId: kind, code: failure.code, message: failure.message, at: this.ports.now() });
    execution.state = "recorded";
    execution.agentId = outcome.agentId;
    execution.outputDigest = analysisDigest(outcome.output ?? null);
    execution.failure = failure ?? null;
    execution.completedAt = this.ports.now();
    await this.save();
    await this.recordResult(run, execution);
  }

  private async recordResult(run: RunRecord, execution: ExecutionRecord) {
    const kind = execution.taskId;
    const failure = execution.failure ?? undefined;
    const at = execution.completedAt ?? this.ports.now();
    const result = AgentResultSchema.parse({ requestId: `request-${execution.executionId}`, attemptId: execution.attemptId, runId: run.runId,
      taskId: kind, executionId: execution.executionId, status: failure ? "failed" : "succeeded",
      verification: { status: "verified", evidence: `analysis ${kind} output ${execution.outputDigest}`, correlation: this.handle(run, execution).correlation },
      artifactProposals: [], retryable: Boolean(failure), startedAt: execution.startedAt, completedAt: at,
      ...(failure ? { error: { code: failure.code, message: failure.message, retryable: true } } : {}) });
    const snapshot = await this.mutate(run.runId, version => this.ports.engine.recordAgentResult({ runId: run.runId, taskId: kind,
      expectedVersion: version, result, idempotencyKey: `analysis:result:${execution.executionId}`, occurredAt: at }));
    const current = snapshot.tasks.find(item => item.taskId === kind)!;
    if (!failure && current.status === "waiting") await this.evaluateGates(run, current, execution);
  }

  private async acceptSurvey(run: RunRecord, output: { observations: { path: string; note: string }[] }) {
    const roots = run.intake.surveyPaths.map(relativeSafe);
    const recorded: SurveyObservation[] = [];
    for (const observation of output.observations) {
      const path = relativeSafe(observation.path);
      if (!roots.some(root => path === root || path.startsWith(`${root}/`)))
        throw new AnalysisPermissionDenied(`Survey read outside the permitted paths was denied: ${path}`);
      const absolute = resolve(this.ports.repositoryRoot, path);
      await this.assertNoSymlink(absolute);
      const stats = await lstat(absolute);
      if (!stats.isFile() || stats.size > 1_048_576) throw new AnalysisPermissionDenied(`Survey source is not a bounded regular file: ${path}`);
      const bytes = await readFile(absolute);
      // Runtime records what was observed; role notes never become source evidence on their own.
      recorded.push(SurveyObservationSchema.parse({ path, sha256: sha256(bytes), bytes: bytes.length, note: observation.note }));
    }
    // All-or-nothing: a denied output leaves no partial observations behind.
    const paths = new Set(recorded.map(item => item.path));
    run.observations = [...run.observations.filter(item => !paths.has(item.path)), ...recorded];
  }

  private acceptElicitation(run: RunRecord, output: { questions: { id: string; question: string; blocking: boolean }[] }) {
    for (const question of output.questions)
      if (!run.questions.some(item => item.id === question.id)) run.questions.push(question);
  }

  private async acceptDocument(run: RunRecord, execution: ExecutionRecord, agentId: string, document: AnalysisDocument) {
    const digest = analysisDigest(document);
    if (run.documents.at(-1)?.digest === digest && run.documents.at(-1)?.attemptId === execution.attemptId) return;
    const version = (run.documents.at(-1)?.version ?? 0) + 1;
    const artifact = await this.putJson(run, "specification", `analysis-${run.runId}-document-v${version}`, "document", document);
    run.documents.push({ version, digest, artifact, authorAgentId: agentId, attemptId: execution.attemptId, content: document });
  }

  private async acceptReview(run: RunRecord, agentId: string, output: { verdict: "approved" | "changes_requested"; documentDigest: string;
    findings: { id: string; severity: "blocking" | "advisory"; statementIds: string[]; note: string }[] }) {
    const artifact = await this.putJson(run, "review", `analysis-${run.runId}-review-${output.documentDigest.slice(0, 16)}-${sha256(agentId).slice(0, 8)}`, "report", { agentId, ...output });
    run.review = { agentId, verdict: output.verdict, documentDigest: output.documentDigest, artifact, findings: output.findings };
  }

  /** Runtime-owned gates: deterministic analysis checks, independent review and publication integrity. */
  private async evaluateGates(run: RunRecord, task: WorkflowRunSnapshot["tasks"][number], execution: ExecutionRecord) {
    const binding = run.definition.tasks.find(item => item.id === task.taskId)!.qualityGates[0];
    if (!binding) return;
    const evaluationId = `analysis-${binding.gateId}-${execution.executionId}`;
    const at = this.ports.now();
    let status: "passed" | "failed" | "blocked";
    let findings: { code: string; message: string; ids: readonly string[]; severity: string }[] = [];
    let produced: ArtifactReference[] = [];
    if (binding.gateId === ANALYSIS_GATES.verification) {
      const latest = run.documents.at(-1)!;
      let recorded = run.verifications.find(item => item.attemptId === execution.attemptId && item.documentDigest === latest.digest);
      if (!recorded) {
        const checked = this.verify(run, latest.content);
        const stored = await this.putJson(run, "specification", `analysis-${run.runId}-verification-v${latest.version}-${execution.attemptId}`, "report",
          { documentDigest: latest.digest, ...checked });
        recorded = { documentDigest: latest.digest, attemptId: execution.attemptId, at, status: checked.status, artifact: stored, result: checked };
        run.verifications.push(recorded);
      }
      const { result, artifact } = recorded;
      status = result.status; findings = [...result.findings]; produced = [artifact];
      if (result.status === "blocked") {
        run.status = "needs_revision";
        run.blockers = result.findings.filter(item => item.severity === "blocking").map(item => `${item.code}:${item.ids.join(",")}`);
      }
    } else if (binding.gateId === ANALYSIS_GATES.review) {
      const latest = run.documents.at(-1)!;
      const author = latest.authorAgentId;
      const review = run.review!;
      const recheck = this.verify(run, latest.content);
      const problems: { code: string; message: string; ids: string[]; severity: string }[] = [];
      if (review.agentId === author) problems.push({ code: "review_not_independent", message: "The reviewer authored the document", ids: [review.agentId], severity: "error" });
      if (review.documentDigest !== latest.digest) problems.push({ code: "review_stale", message: "Review is not pinned to the current document digest", ids: [review.documentDigest], severity: "error" });
      if (review.verdict !== "approved" || review.findings.some(item => item.severity === "blocking"))
        problems.push({ code: "review_changes_requested", message: "Independent review requested changes", ids: review.findings.map(item => item.id), severity: "error" });
      if (recheck.status !== "passed") problems.push(...recheck.findings.filter(item => item.severity !== "warning").map(item => ({ ...item, ids: [...item.ids] })));
      status = problems.length ? "failed" : "passed"; findings = problems; produced = [review.artifact];
      if (problems.length) { run.status = "needs_revision"; run.blockers = problems.map(item => `${item.code}:${item.ids.join(",")}`); }
    } else {
      const handoff = run.handoff!;
      const problems: string[] = [];
      for (const file of handoff.files) {
        const bytes = await readFile(resolve(this.ports.repositoryRoot, file.path)).catch(() => undefined);
        if (!bytes || sha256(bytes) !== file.sha256) problems.push(`Published file changed or missing: ${file.path}`);
      }
      const approval = run.approvals.document;
      if (approval?.decision?.decision !== "approved" || approval.documentDigest !== run.documents.at(-1)!.digest)
        problems.push("Handoff is not bound to the approved document digest");
      status = problems.length ? "failed" : "passed"; produced = [handoff.artifact];
      findings = problems.map(message => ({ code: "publication_integrity", message, ids: [], severity: "error" }));
    }
    await this.mutate(run.runId, version => this.ports.engine.requestQualityGateEvaluation({ runId: run.runId, taskId: task.taskId, gateId: binding.gateId,
      evaluationId, attemptId: execution.attemptId, expectedVersion: version, idempotencyKey: `analysis:gate-request:${evaluationId}`, occurredAt: at }));
    await this.mutate(run.runId, version => this.ports.engine.recordQualityGateResult({ expectedVersion: version, idempotencyKey: `analysis:gate-result:${evaluationId}`,
      result: { runId: run.runId, taskId: task.taskId, gateId: binding.gateId, evaluationId, status,
        findings: findings.slice(0, 50).map(item => ({ code: item.code, severity: item.severity === "warning" ? "warning" as const : "error" as const,
          message: item.message.slice(0, 2000), details: { ids: [...item.ids] } })),
        // Trusted references are recorded as evidence IDs; gate output proposals stay empty because Runtime already stored them.
        producedArtifacts: [], evaluatedAt: at,
        metadata: { evidenceArtifactIds: produced.map(item => item.artifactId),
          ...(binding.gateId === ANALYSIS_GATES.verification && status === "failed" ? { independentVerification: true } : {}) } } }));
    await this.save();
  }

  private verify(run: RunRecord, document: AnalysisDocument) {
    return verifyAnalysisDocument(document, { intake: run.intake, outputSections: run.policy.outputSections, observations: run.observations,
      answeredDecisions: run.decisions, elicitedQuestions: run.questions });
  }

  /** Requests the human decision points owned by Core approvals; returns true while one is pending. */
  private async requestApprovals(run: RunRecord, snapshot: WorkflowRunSnapshot): Promise<boolean> {
    const elicitation = snapshot.tasks.find(item => item.taskId === "elicitation")!;
    if (elicitation.status === "succeeded" && run.approvals.elicitation?.decision !== "approved") {
      if (run.approvals.elicitation?.decision) return false;
      const approvalId = `analysis-decisions-${run.runId}-g${elicitation.generation}`;
      if (run.approvals.elicitation?.approvalId !== approvalId) {
        await this.mutate(run.runId, version => this.ports.engine.requestApproval({ expectedVersion: version, idempotencyKey: `analysis:approval:${approvalId}`,
          request: ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId, runId: run.runId, sessionId: run.intake.sessionId,
            target: { type: "task", taskId: "elicitation" }, revision: run.intake.revision, generation: elicitation.generation, requestedBy: "coordinator",
            requestedAt: this.ports.now(), reason: "Business decisions and analysis scope must be confirmed by the user", evidence: [],
            idempotencyKey: `analysis:approval:${approvalId}`, metadata: { approvalScope: "business_decisions",
              questions: run.questions.map(item => ({ ...item })) } }) }));
        run.approvals.elicitation = { approvalId };
      }
      run.status = "awaiting_business_decision";
      await this.save();
      return true;
    }
    const review = snapshot.tasks.find(item => item.taskId === "review")!;
    const latest = run.documents.at(-1);
    if (review.status === "succeeded" && latest && run.approvals.document?.decision?.decision !== "approved") {
      if (run.approvals.document?.decision) return false;
      const approvalId = `analysis-document-${run.runId}-v${latest.version}`;
      if (run.approvals.document?.approvalId !== approvalId) {
        const verification = run.verifications.at(-1)!;
        await this.mutate(run.runId, version => this.ports.engine.requestApproval({ expectedVersion: version, idempotencyKey: `analysis:approval:${approvalId}`,
          request: ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId, runId: run.runId, sessionId: run.intake.sessionId,
            target: { type: "task", taskId: "review" }, revision: latest.version, generation: review.generation, requestedBy: "coordinator",
            requestedAt: this.ports.now(), reason: "Approve the analysis document for handoff (document approval is not product acceptance)",
            evidence: [latest.artifact, verification.artifact, run.review!.artifact], idempotencyKey: `analysis:approval:${approvalId}`,
            metadata: { approvalScope: "analysis_document", documentDigest: latest.digest, productAcceptance: "not_established" } }) }));
        run.approvals.document = { approvalId, documentDigest: latest.digest };
      }
      run.status = "awaiting_document_approval";
      await this.save();
      return true;
    }
    return false;
  }

  /**
   * The user's business decisions. Approval requires an answer for every blocking question; a missing one keeps the
   * workflow blocked. `changes_requested` reopens nothing automatically: a new revision carries the feedback.
   */
  async decideBusinessQuestions(runId: string, input: { decision: "approved" | "changes_requested" | "rejected"; answers: Record<string, string>;
    decidedBy: string; reason?: string }) {
    const run = this.live(runId);
    await this.restoreCore(run);
    const approvalId = run.approvals.elicitation?.approvalId;
    if (!approvalId || run.approvals.elicitation!.decision || run.status !== "awaiting_business_decision") throw new Error("No business decision is pending");
    const snapshot = await this.snapshot(runId);
    const generation = snapshot.tasks.find(item => item.taskId === "elicitation")!.generation;
    const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId, runId, sessionId: run.intake.sessionId,
      target: { type: "task", taskId: "elicitation" }, revision: run.intake.revision, generation, decision: input.decision,
      decidedBy: input.decidedBy, decidedAt: this.ports.now(), ...(input.reason ? { reason: input.reason } : {}), feedbackArtifacts: [],
      idempotencyKey: `analysis:decision:${approvalId}`, metadata: { approvalScope: "business_decisions", answers: input.answers } });
    await this.authorize(decision);
    if (input.decision === "approved") {
      const missing = run.questions.filter(item => item.blocking && !input.answers[item.id]?.trim() && !run.decisions[item.id]);
      if (missing.length) throw new Error(`Required business decisions are missing: ${missing.map(item => item.id).join(", ")}`);
      const unknown = Object.keys(input.answers).filter(id => !run.questions.some(item => item.id === id));
      if (unknown.length) throw new Error(`Unknown business questions: ${unknown.join(", ")}`);
    }
    await this.mutate(runId, version => this.ports.engine.applyApproval({ expectedVersion: version, idempotencyKey: `analysis:decision:${approvalId}`, decision }));
    run.approvals.elicitation!.decision = input.decision;
    if (input.decision === "approved") {
      for (const [id, answer] of Object.entries(input.answers))
        if (answer.trim()) run.decisions[id] = { answer: answer.trim(), decidedBy: decision.decidedBy, decidedAt: decision.decidedAt };
      run.status = "running";
    } else {
      run.status = "needs_revision";
      run.blockers = [`business_decisions_${input.decision}`];
    }
    await this.save();
    return input.decision === "approved" ? this.drive(runId) : this.status(runId);
  }

  /** Human approval of the exact analysis document digest. It approves the document only, never the product. */
  async decideDocument(runId: string, input: { decision: "approved" | "changes_requested" | "rejected"; documentDigest: string; decidedBy: string; reason?: string }) {
    const run = this.live(runId);
    const pending = run.approvals.document;
    if (!pending || pending.decision || run.status !== "awaiting_document_approval") throw new Error("No document approval is pending");
    if (input.documentDigest !== pending.documentDigest) throw new Error("Approval must name the exact reviewed document digest");
    await this.restoreCore(run);
    const latest = run.documents.at(-1)!;
    const snapshot = await this.snapshot(runId);
    const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: pending.approvalId, runId, sessionId: run.intake.sessionId,
      target: { type: "task", taskId: "review" }, revision: latest.version, generation: snapshot.tasks.find(item => item.taskId === "review")!.generation,
      decision: input.decision, decidedBy: input.decidedBy, decidedAt: this.ports.now(), ...(input.reason ? { reason: input.reason } : {}),
      feedbackArtifacts: [], idempotencyKey: `analysis:decision:${pending.approvalId}`,
      metadata: { approvalScope: "analysis_document", documentDigest: pending.documentDigest, productAcceptance: "not_established" } });
    await this.authorize(decision);
    await this.mutate(runId, version => this.ports.engine.applyApproval({ expectedVersion: version, idempotencyKey: `analysis:decision:${pending.approvalId}`, decision }));
    pending.decision = decision;
    if (input.decision !== "approved") { run.status = "needs_revision"; run.blockers = [`document_${input.decision}`]; }
    else run.status = "running";
    await this.save();
    return input.decision === "approved" ? this.drive(runId) : this.status(runId);
  }

  private async authorize(decision: ApprovalDecision) {
    const agentRoles = ["coordinator", "specifier", "architect", "reviewer", "developer", "tester", "qa", "security", "planner", "conversation", "runtime"];
    if (agentRoles.includes(decision.decidedBy.split(":")[0]!) || !await this.ports.authorizeHuman(decision))
      throw new Error("Analysis decisions require an authenticated human decision");
  }

  /**
   * Document revision: a new run (revision n+1) supersedes the current one, carrying answered decisions and the reason.
   * The superseded run keeps its documents, approvals and handoff history; it can no longer progress.
   */
  async revise(runId: string, input: { runId: string; reason: string; answers?: Record<string, string>; decidedBy?: string;
    userStatements?: { id: string; text: string }[]; pack: unknown; packPin: AnalysisPackPin; definition?: unknown }) {
    const previous = this.live(runId, true);
    const answered = { ...previous.decisions };
    if (input.answers && Object.keys(input.answers).length) {
      if (!input.decidedBy) throw new Error("Answered decisions need the deciding user");
      const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: `analysis-revision-${input.runId}`, runId, target: { type: "run" },
        revision: previous.intake.revision, generation: 0, decision: "approved", decidedBy: input.decidedBy, decidedAt: this.ports.now(),
        feedbackArtifacts: [], idempotencyKey: `analysis:revision:${input.runId}`, metadata: { approvalScope: "business_decisions", answers: input.answers } });
      await this.authorize(decision);
      for (const [id, answer] of Object.entries(input.answers)) answered[id] = { answer, decidedBy: decision.decidedBy, decidedAt: decision.decidedAt };
    }
    const intake = { ...previous.intake, revision: previous.intake.revision + 1, supersedes: runId, revisionReason: input.reason,
      answeredDecisions: answered, userStatements: [...previous.intake.userStatements, ...(input.userStatements ?? [])],
      requiredDecisions: [...previous.intake.requiredDecisions, ...previous.questions.filter(item => !previous.intake.requiredDecisions.some(other => other.id === item.id))] };
    const carried = [...(previous.review?.verdict === "changes_requested" ? previous.review.findings.map(item => ({ code: "review", ids: item.statementIds, message: item.note })) : []),
      ...(previous.verifications.at(-1) && previous.verifications.at(-1)!.status !== "passed" ? previous.verifications.at(-1)!.result.findings.map(item => ({ code: item.code, ids: [...item.ids], message: item.message })) : []),
      ...(previous.approvals.document?.decision && previous.approvals.document.decision.decision !== "approved" && previous.approvals.document.decision.reason
        ? [{ code: "document_feedback", ids: [], message: previous.approvals.document.decision.reason }] : [])];
    const result = await this.start({ runId: input.runId, intake: { ...intake, revisionFindings: carried }, pack: input.pack, packPin: input.packPin,
      ...(input.definition !== undefined ? { definition: input.definition } : {}) });
    previous.status = "superseded";
    previous.supersededBy = input.runId;
    await this.save();
    return result;
  }

  /** Publication by Runtime: trusted artifact, document writes confined to the handoff directory, TDD alternative evidence. */
  private async publish(run: RunRecord) {
    const latest = run.documents.at(-1)!;
    const approval = run.approvals.document;
    if (approval?.decision?.decision !== "approved" || approval.documentDigest !== latest.digest)
      throw new AnalysisPermissionDenied("Publication requires the human approval of the current document digest");
    const verification = run.verifications.filter(item => item.documentDigest === latest.digest && item.status === "passed").at(-1);
    if (!verification) throw new AnalysisPermissionDenied("Publication requires a passed verification of the current document");
    const [analysisPath, handoffPath] = this.handoffPaths(run.intake) as [string, string];
    const analysisMarkdown = renderAnalysisDocument(latest.content, { version: latest.version, digest: latest.digest });
    // Alternative-verification evidence for the analysis TDD decision: one stored bundle naming the checks and the review.
    const startedAt = this.ports.now();
    const tddArtifact = await this.putJson(run, "analysis", `analysis-${run.runId}-tdd-evidence-v${latest.version}`, "report", {
      documentDigest: latest.digest, verification: { artifactId: verification.artifact.artifactId, checksum: verification.artifact.checksum, checks: verification.result.checks },
      review: { artifactId: run.review!.artifact.artifactId, checksum: run.review!.artifact.checksum, verdict: run.review!.verdict, agentId: run.review!.agentId } });
    const evidence = VerificationResultSchema.parse({ schemaVersion: 2, verificationId: `analysis-verification-${run.runId}-v${latest.version}`,
      runId: run.runId, taskId: "analysis", cycleNumber: 1, attemptId: verification.attemptId, status: "passed", independentExecution: true,
      evaluatedCriteria: run.intake.acceptanceCriteria.map(item => ({ criterionId: item.id, passed: true, evidenceArtifactId: tddArtifact.artifactId,
        summary: `Covered by ${latest.content.criteriaCoverage.find(entry => entry.criterionId === item.id)?.statementIds.join(", ") ?? "optional criterion"}; checks and independent review passed` })),
      qualityGateResults: [], evidenceArtifacts: [tddArtifact], findings: [], verifiedBy: "reviewer",
      startedAt, completedAt: this.ports.now(),
      metadata: { conditionalTdd: { phase: "verification", decisionId: run.strategy.tddDecision.decisionId, specId: run.strategy.specId,
        sourceRevision: latest.digest, testRevision: verification.result.checks.map(item => item.check).join(","),
        testNames: verification.result.checks.map(item => item.check),
        observations: run.intake.acceptanceCriteria.map(item => ({ method: "manual_review", criterionId: item.id,
          evidenceArtifactId: tddArtifact.artifactId, summary: "Deterministic analysis checks and independent reviewer verdict" })) } } });
    run.strategy = recordEvidence(run.strategy, evidence);
    assertEvidenceComplete(run.strategy);
    const manifest = {
      schemaVersion: 1, kind: "bflow.analysis-handoff", runId: run.runId, requestId: run.intake.requestId, revision: run.intake.revision,
      supersedes: run.intake.supersedes ?? null, pack: run.policy.pack, workflow: { id: run.definition.id, version: run.definition.version },
      intakeDigest: run.intakeDigest,
      document: { version: latest.version, digest: latest.digest, artifactId: latest.artifact.artifactId, checksum: latest.artifact.checksum },
      verification: { status: verification.status, artifactId: verification.artifact.artifactId, checks: verification.result.checks },
      review: { verdict: run.review!.verdict, documentDigest: run.review!.documentDigest, artifactId: run.review!.artifact.artifactId, independentOf: latest.authorAgentId },
      approval: { approvalId: approval.approvalId, decidedBy: approval.decision.decidedBy, decidedAt: approval.decision.decidedAt, scope: "analysis_document" },
      productAcceptance: "not_established",
      tdd: { mode: run.strategy.tddDecision.mode, alternativeVerification: alternativeMethods(run.strategy), evidenceId: evidence.verificationId },
      sources: {
        user: run.intake.userStatements.map(item => ({ ref: `intake:${item.id}`, text: item.text })),
        decisions: Object.entries(run.decisions).map(([id, value]) => ({ ref: `decision:${id}`, ...value })),
        observations: run.observations.map(item => ({ ref: `source:${item.path}#${item.sha256}`, path: item.path, sha256: item.sha256 }))
      },
      unresolvedQuestions: verification.result.unresolved,
      files: [analysisPath, handoffPath]
    };
    const handoffMarkdown = [`# Bàn giao phân tích: ${run.intake.title}`, "",
      `- Run \`${run.runId}\` · revision ${run.intake.revision}${run.intake.supersedes ? ` (thay thế \`${run.intake.supersedes}\`)` : ""}`,
      `- Pack \`${run.policy.pack.id}@${run.policy.pack.version}\` (\`${run.policy.pack.digest}\`)`,
      `- Tài liệu v${latest.version} · sha256 \`${latest.digest}\` · artifact \`${latest.artifact.artifactId}\``,
      `- Reviewer độc lập: ${run.review!.verdict} (ghim digest tài liệu)`,
      `- Phê duyệt tài liệu: \`${approval.approvalId}\` bởi ${approval.decision.decidedBy}`,
      "- **Phê duyệt tài liệu không phải nghiệm thu sản phẩm** (`productAcceptance: not_established`).",
      `- Conditional TDD: \`${run.strategy.tddDecision.mode}\`; alternative verification: ${alternativeMethods(run.strategy).join(", ")}`,
      "", "## Kiểm tra", "", ...renderVerificationSummary(verification.result), "",
      "## Câu hỏi còn mở", "", ...(verification.result.unresolved.length ? verification.result.unresolved.map(item => `- ${item.id}: ${item.question}`) : ["- Không có"]),
      "", "## Manifest", "", "```json", JSON.stringify(manifest, null, 2), "```", ""].join("\n");
    await this.writeDocument(run, analysisPath, analysisMarkdown);
    await this.writeDocument(run, handoffPath, handoffMarkdown);
    const artifact = await this.putJson(run, "publication", `analysis-${run.runId}-handoff-v${latest.version}`, "document", manifest);
    run.handoff = { artifact, digest: analysisDigest(manifest), files: [
      { path: analysisPath, sha256: sha256(analysisMarkdown) }, { path: handoffPath, sha256: sha256(handoffMarkdown) }] };
  }

  /** The only repository write: approved handoff Markdown inside `<documentRoot>/<requestId>/r<revision>/`, never overwritten. */
  private async writeDocument(run: RunRecord, path: string, content: string) {
    const allowed = this.handoffPaths(run.intake);
    if (!allowed.includes(path)) throw new AnalysisPermissionDenied(`Write outside the analysis handoff was denied: ${path}`);
    const absolute = resolve(this.ports.repositoryRoot, path);
    if (!within(this.ports.repositoryRoot, absolute)) throw new AnalysisPermissionDenied(`Write escapes the repository: ${path}`);
    // Check existing ancestors before mkdir: a symlinked parent would otherwise create directories outside the repository.
    await this.assertNoSymlink(dirname(absolute));
    await mkdir(dirname(absolute), { recursive: true });
    await this.assertNoSymlink(dirname(absolute));
    try {
      const handle = await open(absolute, "wx", 0o644);
      try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Idempotent republish after a restart; a different existing file is never overwritten.
      if (sha256(await readFile(absolute)) !== sha256(content)) throw new AnalysisPermissionDenied(`Refusing to overwrite existing handoff file: ${path}`);
    }
  }

  private async assertNoSymlink(absolute: string) {
    let current = absolute;
    while (within(this.ports.repositoryRoot, current) && current !== this.ports.repositoryRoot) {
      const stats = await lstat(current).catch(() => undefined);
      if (stats?.isSymbolicLink()) throw new AnalysisPermissionDenied(`Symlinked path refused: ${relative(this.ports.repositoryRoot, current).split(sep).join("/")}`);
      current = dirname(current);
    }
  }

  private async putJson(run: RunRecord, taskId: string, artifactId: string, kind: "document" | "report", value: unknown): Promise<ArtifactReference> {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    return ArtifactReferenceSchema.parse(unwrap(await this.ports.artifactStore.put({ options: ArtifactWriteOptionsSchema.parse({ artifactId, runId: run.runId,
      taskId, kind, mediaType: "application/json", expectedIntegrity: { checksum: { algorithm: "sha256", value: sha256(bytes) }, sizeBytes: bytes.length },
      idempotencyKey: artifactId }), content: (async function* () { yield bytes; })() })));
  }

  private finish(run: RunRecord, snapshot: WorkflowRunSnapshot) {
    if (run.status !== "superseded") run.status = snapshot.status === "succeeded" && run.handoff ? "published" : "failed";
    return this.save().then(() => this.status(run.runId));
  }

  // ---- Core composition: events are appended to RunStore and recovered by authoritative replay. ----
  private async createCore(run: RunRecord) {
    const at = run.createdAt;
    const created = WorkflowAdvanceResultSchema.parse(unwrap(await this.ports.engine.createRun({ runId: run.runId, definition: run.definition,
      createdAt: at, idempotencyKey: `analysis:create:${run.runId}` })));
    if (!unwrap(await this.ports.runStore.get(run.runId)))
      unwrap(await this.ports.runStore.create(StoredRunSchema.parse({ definition: run.definition, snapshot: { runId: run.runId, workflowId: run.definition.id,
        workflowVersion: run.definition.version, status: "queued", tasks: run.definition.tasks.map(item => ({ taskId: item.id, status: "pending", attempt: 0,
          generation: 0, version: 0 })), createdAt: at, updatedAt: at, version: 0, lastEventSequence: 0 } }), `analysis:store:${run.runId}`));
    await this.append(created, 0, 0);
    this.createdInEngine.add(run.runId);
    run.coreCreated = true;
    await this.save();
  }
  private async restoreCore(run: RunRecord) {
    if (this.createdInEngine.has(run.runId)) return;
    if (!run.coreCreated) { await this.createCore(run); return; }
    const stored = StoredRunSchema.parse(unwrap(await this.ports.runStore.get(run.runId)));
    if (!unwrap(await this.ports.engine.getSnapshot(run.runId)))
      unwrap(await this.ports.engine.createRun({ runId: run.runId, definition: run.definition, createdAt: run.createdAt, idempotencyKey: `analysis:create:${run.runId}` }));
    const events = [];
    let cursor: string | undefined;
    do {
      const page = unwrap(await this.ports.runStore.readEvents(run.runId, { limit: 100, ...(cursor ? { cursor } : {}) }));
      events.push(...page.items.map(item => DomainEventSchema.parse(item)));
      cursor = page.nextCursor;
    } while (cursor);
    unwrap(await this.ports.engine.recover({ runId: run.runId, events, expectedVersion: stored.snapshot.version }));
    this.createdInEngine.add(run.runId);
  }
  private async snapshot(runId: string): Promise<WorkflowRunSnapshot> {
    const value = unwrap(await this.ports.engine.getSnapshot(runId));
    if (!value) throw new Error("Core analysis run missing");
    return value;
  }
  private async mutate(runId: string, action: (version: number) => Promise<OperationResult<WorkflowAdvanceResult>>): Promise<WorkflowRunSnapshot> {
    const before = await this.snapshot(runId);
    const result = WorkflowAdvanceResultSchema.parse(unwrap(await action(before.version)));
    await this.append(result, before.version, before.lastEventSequence);
    return result.snapshot;
  }
  private async append(result: WorkflowAdvanceResult, expectedVersion: number, expectedLastSequence: number) {
    if (!result.emittedEvents.length) return;
    unwrap(await this.ports.runStore.appendEvents(AppendEventsRequestSchema.parse({ runId: result.snapshot.runId, expectedVersion, expectedLastSequence,
      events: result.emittedEvents, idempotencyKey: `analysis-events:${result.snapshot.runId}:${result.emittedEvents[0]!.eventId}` })));
  }

  private run(runId: string): RunRecord {
    const run = this.journal.runs.find(item => item.runId === runId);
    if (!run) throw new Error(`Unknown analysis run ${runId}`);
    return run;
  }
  private live(runId: string, allowTerminal = false): RunRecord {
    const run = this.run(runId);
    if (run.status === "superseded") throw new Error(`Analysis run ${runId} was superseded by ${run.supersededBy}`);
    if (!allowTerminal && (run.status === "published" || run.status === "failed")) throw new Error(`Analysis run ${runId} is ${run.status}`);
    return run;
  }
  private async save() {
    await mkdir(dirname(this.ports.journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.ports.journalPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.journal, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.ports.journalPath);
  }
}

