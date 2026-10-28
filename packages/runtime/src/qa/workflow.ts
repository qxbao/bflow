import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, readlink, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  AgentResultSchema, AppendEventsRequestSchema, ApprovalDecisionSchema, ApprovalRequestSchema, ArtifactReferenceSchema,
  ArtifactWriteOptionsSchema, DomainEventSchema, ResolvedToolGrantSchema, SpecificationSchema, StoredRunSchema, VerificationResultSchema,
  WorkflowAdvanceResultSchema, type ApprovalDecision, type ArtifactReference, type ArtifactStore, type JsonValue, type OperationResult,
  type ResolvedToolGrant, type RunStore, type TestStrategy, type WorkflowAdvanceResult, type WorkflowDefinition, type WorkflowEngine,
  type WorkflowRunSnapshot
} from "@bflow/contracts";
import { TestStrategyResolver, assertEvidenceComplete, recordEvidence } from "@bflow/test-strategy";
import type { AppCheckBrowserLeases, AppCheckLease } from "../agentic/app-check-lease.js";
import {
  QaIntakeSchema, QaRoleOutputSchemas, forbiddenOutputKeys, qaDigest,
  type QaAction, type QaBrowserStep, type QaCase, type QaClassification, type QaFinding, type QaHttpStep, type QaIntake, type QaIntakeInput, type QaStep,
  type QaTaskKind, type QaTestDesignParsed
} from "./model.js";
import { QA_GATES, assertQaOnlyWorkflow, planQaWorkflow } from "./plan.js";
import { renderQaReport, type QaBug, type QaReport } from "./report.js";
import { QaSanitizer } from "./sanitize.js";
import { QaScopeDenied, QaUnresolvedVariable, actionOf, resolveTargetUrl, substitute } from "./scope.js";
import { QA_BROWSER_TOOL_ID, QA_HTTP_TOOL_ID, type QaBrowserTool, type QaHttpOutcome, type QaHttpTool } from "./tools.js";
import { verifyQaDesign, type QaDesignVerification } from "./verify.js";

/** One assignment to a standard role. Roles get context only: no write, command or network authority on the target. */
export interface QaAssignment {
  readonly runId: string;
  readonly taskId: QaTaskKind;
  readonly role: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly instruction: string;
  readonly intake: QaIntake;
  readonly permissions: { readonly read: readonly string[]; readonly write: "none"; readonly commands: "none"; readonly network: "none" };
  readonly context: {
    readonly design?: { readonly version: number; readonly digest: string; readonly content: QaTestDesignParsed };
    readonly execution?: QaExecutionSummary & { readonly digest: string };
    readonly findings: readonly { code: string; ids: readonly string[]; message: string }[];
  };
}

export type QaReconciliation =
  | { readonly status: "not_delivered" }
  | { readonly status: "completed"; readonly agentId: string; readonly output: unknown }
  | { readonly status: "unknown" };

/** Role transport port. The persistent host would deliver over Runtime → Herdr; tests use deterministic fixtures. */
export interface QaRolePort {
  dispatch(assignment: QaAssignment): Promise<{ readonly agentId: string; readonly output: unknown }>;
  reconcile?(executionId: string): Promise<QaReconciliation>;
}

/** Resolves credentials of an isolated test account; values are treated as secrets and never stored. */
export interface QaAccountPort { headers(accountId: string): Promise<Readonly<Record<string, string>>> }

export interface QaRuntimePorts {
  readonly engine: WorkflowEngine;
  readonly runStore: RunStore;
  readonly artifactStore: ArtifactStore;
  readonly roles: QaRolePort;
  /** Absolute repository root; the test workspace and protected product paths are relative to it. */
  readonly repositoryRoot: string;
  readonly journalPath: string;
  authorizeHuman(decision: ApprovalDecision): boolean | Promise<boolean>;
  now(): string;
  /** Wired tool adapters. A tool that is absent is a prerequisite gap for every case that needs it. */
  readonly tools: { readonly http?: QaHttpTool; readonly browser?: QaBrowserTool };
  /** Host-resolved session grants; each action needs a grant for the QA role, the tool and that operation. */
  readonly grants: readonly ResolvedToolGrant[];
  /** Host-local fenced lease over the target environment, held for the whole execution transaction. */
  readonly leases: AppCheckBrowserLeases;
  readonly leaseTtlMs?: number;
  readonly accounts?: QaAccountPort;
}

export type QaRunStatus = "running" | "awaiting_design_approval" | "blocked" | "needs_revision" | "reported" | "failed";
export type QaCaseStatus = "passed" | "assertion_failed" | "environment_failure" | "blocked" | "inconclusive";
export type QaBuildIdentity = { status: "identified"; value: string; source: string } | { status: "unknown"; limitation: string };
export interface QaStepFinding { code: string; message: string; expected?: string; actual?: string }
export interface QaStepRecord {
  phase: "test" | "reconcile" | "cleanup"; index: number; action: QaAction; request: string;
  requestHeaders?: Record<string, string>; requestBody?: string;
  response?: { status: number; headers: Record<string, string>; body: string };
  outcome: "ok" | "assertion_failed" | "timeout" | "uncertain" | "unavailable" | "denied" | "lease" | "unresolved_variable";
  findings: QaStepFinding[]; at: string;
}
export interface QaCaseOutcome {
  caseId: string; criterionIds: string[]; state: "running" | "done"; status: QaCaseStatus; code?: string;
  steps: QaStepRecord[]; findings: QaStepFinding[];
  cleanup: { status: "not_required" | "cleaned" | "failed" | "skipped"; detail?: string };
  evidenceArtifactId?: string; startedAt: string; completedAt?: string;
}
export interface QaMutationRecord {
  mutationId: string; caseId: string; phase: "test" | "cleanup"; stepIndex: number; request: string; requestDigest: string;
  leaseId: string; fencingToken: number; state: "intent" | "applied" | "rejected" | "not_delivered" | "uncertain"; status?: number;
  reconciliation?: "applied" | "not_applied" | "unknown"; recoveredAfterRestart?: boolean; at: string; settledAt?: string;
}
export interface QaExecutionSummary {
  readonly build: QaBuildIdentity;
  readonly readiness: { readonly ready: boolean; readonly reason?: string };
  readonly productUnchanged: boolean;
  readonly cases: readonly { caseId: string; criterionIds: string[]; status: QaCaseStatus; code?: string; findings: QaStepFinding[]; cleanup: string }[];
}

interface ExecutionState {
  startedAt: string; assets?: { path: string; sha256: string }; protectedBefore?: string; protectedAfter?: string; productUnchanged?: boolean;
  lease?: AppCheckLease; leases: { leaseId: string; resourceKey: string; fencingToken: number; acquiredAt: string; expiresAt: string; released: boolean }[];
  leaseInterruption?: string; readiness?: { ready: boolean; status?: number; reason?: string; at: string }; build?: QaBuildIdentity;
  cases: Record<string, QaCaseOutcome>; mutations: QaMutationRecord[];
  /** Captured variables per case, needed to clean up after a restart. Private: never part of status or evidence. */
  vars: Record<string, Record<string, string>>;
  digest?: string; artifact?: ArtifactReference; completedAt?: string;
}
interface ExecutionRecord {
  executionId: string; taskId: QaTaskKind; attemptId: string; attempt: number; generation: number;
  state: "bound" | "recorded"; agentId?: string; outputDigest?: string; startedAt: string;
  failure?: { code: string; message: string } | null; completedAt?: string;
}
interface DesignRecord { version: number; digest: string; artifact: ArtifactReference; authorAgentId: string; attemptId: string; content: QaTestDesignParsed }
interface AdjudicationRecord {
  agentId: string; attemptId: string; executionDigest: string; artifact: ArtifactReference;
  verdicts: { caseId: string; classification: QaClassification; rationale: string }[]; problems?: QaFinding[];
}
interface RunRecord {
  runId: string; intake: QaIntake; intakeDigest: string; definition: WorkflowDefinition; status: QaRunStatus; createdAt: string;
  strategy: TestStrategy; coreCreated: boolean; access?: { decidedBy: string; decidedAt: string };
  executions: ExecutionRecord[]; designs: DesignRecord[];
  designChecks: { designDigest: string; attemptId: string; result: QaDesignVerification; artifact: ArtifactReference }[];
  review?: { agentId: string; verdict: "approved" | "changes_requested"; designDigest: string; artifact: ArtifactReference;
    findings: { id: string; severity: "blocking" | "advisory"; caseIds: string[]; note: string }[] };
  approval?: { approvalId: string; designDigest: string; decision?: ApprovalDecision };
  execution?: ExecutionState; adjudications: AdjudicationRecord[]; classifications?: Record<string, QaClassification>;
  report?: QaReport & { artifact: ArtifactReference; files: { path: string; sha256: string }[] };
  denials: { executionId: string; taskId: string; reason: string; at: string }[];
  rejections: { executionId: string; taskId: string; code: string; message: string; at: string }[];
  blockers: string[];
}
interface Journal { schemaVersion: 1; runs: RunRecord[] }

/** A whole-run precondition that is not met yet (for example a busy lease): no side effect happened, drive again later. */
class QaBlocked extends Error { constructor(readonly code: string) { super(code); this.name = "QaBlocked"; } }
class LeaseInterrupted extends Error { constructor(readonly code: string) { super(code); this.name = "LeaseInterrupted"; } }

export const QA_EXECUTION_ROLE = "qa" as const;
const RUNTIME_TASKS = new Set<QaTaskKind>(["execution", "report"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const AGENT_ROLES = ["coordinator", "specifier", "architect", "reviewer", "developer", "tester", "qa", "security", "planner", "conversation", "runtime"];
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function pointer(value: unknown, path: string): { found: boolean; value?: unknown } {
  if (path === "") return { found: true, value };
  let current: unknown = value;
  for (const raw of path.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current) && /^\d+$/.test(key) && Number(key) < current.length) current = current[Number(key)];
    else if (current && typeof current === "object" && !Array.isArray(current) && Object.hasOwn(current, key)) current = (current as Record<string, unknown>)[key];
    else return { found: false };
  }
  return { found: true, value: current };
}
function alternativeMethods(strategy: TestStrategy): string[] {
  const policy = strategy.metadata?.conditionalTdd;
  const methods = policy && typeof policy === "object" && !Array.isArray(policy) ? policy.requiredVerificationMethods : undefined;
  return Array.isArray(methods) ? methods.filter((item): item is string => typeof item === "string") : [];
}

/**
 * QA-only workflow extension: test an existing system without changing it. Core owns DAG/state/approval/gate legality,
 * RunStore the authoritative events, ArtifactStore the trusted evidence. Roles design, review and adjudicate; only
 * Runtime touches the target, through granted tools under a fenced environment lease, and only Runtime writes the test
 * workspace. Nothing in the workflow creates, requests or authorizes a product change.
 */
export class QaWorkflowRuntime {
  private journal: Journal = { schemaVersion: 1, runs: [] };
  private readonly createdInEngine = new Set<string>();
  private readonly sanitizers = new Map<string, QaSanitizer>();
  private constructor(private readonly ports: QaRuntimePorts) {}

  static async open(ports: QaRuntimePorts): Promise<QaWorkflowRuntime> {
    if (!isAbsolute(ports.repositoryRoot) || !isAbsolute(ports.journalPath)) throw new Error("QA runtime paths must be absolute");
    const runtime = new QaWorkflowRuntime(ports);
    try {
      const parsed = JSON.parse(await readFile(ports.journalPath, "utf8")) as Journal;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.runs)) throw new Error("Unsupported QA journal version");
      runtime.journal = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return runtime;
  }

  /** Read-only public view of one run; captured variables and credentials are never included. */
  status(runId: string) {
    const run = this.run(runId);
    const exec = run.execution;
    const latest = run.designs.at(-1);
    return structuredClone({ runId: run.runId, status: run.status, revision: run.intake.revision, blockers: run.blockers,
      denials: run.denials, rejections: run.rejections, definition: run.definition,
      tdd: { mode: run.strategy.tddDecision.mode, alternativeVerification: alternativeMethods(run.strategy) },
      design: latest ? { version: latest.version, digest: latest.digest, artifactId: latest.artifact.artifactId } : undefined,
      designCheck: run.designChecks.at(-1) ? { status: run.designChecks.at(-1)!.result.status, findings: run.designChecks.at(-1)!.result.findings } : undefined,
      review: run.review ? { verdict: run.review.verdict, designDigest: run.review.designDigest, findings: run.review.findings } : undefined,
      approval: run.approval ? { approvalId: run.approval.approvalId, designDigest: run.approval.designDigest, decision: run.approval.decision?.decision } : undefined,
      execution: exec ? { build: exec.build, readiness: exec.readiness, productUnchanged: exec.productUnchanged, leases: exec.leases,
        leaseInterruption: exec.leaseInterruption, cases: exec.cases, mutations: exec.mutations, digest: exec.digest, assets: exec.assets } : undefined,
      classifications: run.classifications ?? {}, verdict: run.report?.verdict,
      report: run.report ? { verdict: run.report.verdict, files: run.report.files, bugs: run.report.bugs, testDefects: run.report.testDefects,
        residualData: run.report.residualData, uncertainMutations: run.report.uncertainMutations, limitations: run.report.limitations,
        artifactId: run.report.artifact.artifactId } : undefined });
  }

  /**
   * Intake → Coordinator plan. A non-fixture target needs an authenticated human access grant before anything is planned.
   * A Coordinator-proposed definition is validated against QA-only policy; nothing touches the target until approval.
   */
  async start(input: { runId: string; intake: QaIntakeInput; definition?: unknown; maxIterations?: number; access?: { decidedBy: string } }) {
    if (this.journal.runs.some(item => item.runId === input.runId)) throw new Error(`QA run ${input.runId} already exists`);
    const intake = QaIntakeSchema.parse(input.intake);
    const createdAt = this.ports.now();
    let access: RunRecord["access"];
    if (intake.target.kind !== "fixture") {
      if (!input.access) throw new QaScopeDenied("target_access_not_authorized", `Target ${intake.target.environmentId} is not a fixture; an authenticated human access grant is required`);
      const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: `qa-access-${input.runId}`, runId: input.runId, target: { type: "run" },
        revision: intake.revision, generation: 0, decision: "approved", decidedBy: input.access.decidedBy, decidedAt: createdAt, feedbackArtifacts: [],
        idempotencyKey: `qa:access:${input.runId}`, metadata: { approvalScope: "qa_target_access", environmentId: intake.target.environmentId,
          origins: intake.target.origins, allowedActions: intake.allowedActions } });
      await this.authorize(decision);
      access = { decidedBy: decision.decidedBy, decidedAt: decision.decidedAt };
    }
    const definition = input.definition === undefined ? planQaWorkflow(intake, input.maxIterations) : assertQaOnlyWorkflow(input.definition, intake, input.maxIterations);
    const run: RunRecord = { runId: input.runId, intake, intakeDigest: qaDigest(intake), definition, status: "running", createdAt,
      strategy: this.resolveStrategy(input.runId, intake, createdAt), coreCreated: false, ...(access ? { access } : {}), executions: [], designs: [],
      designChecks: [], adjudications: [], denials: [], rejections: [], blockers: [] };
    this.journal.runs.push(run);
    await this.save();
    await this.createCore(run);
    return this.status(run.runId);
  }

  /**
   * Conditional TDD for QA-only work: only test assets are written and the deployed product is the target, so no Red
   * phase exists (not_applicable); independent review and adjudication are the mandatory alternative verification.
   */
  private resolveStrategy(runId: string, intake: QaIntake, at: string): TestStrategy {
    const spec = SpecificationSchema.parse({ schemaVersion: 2, specId: `qa-${intake.requestId}-r${intake.revision}`, runId, sessionId: intake.sessionId,
      level: "lightweight", title: intake.title, summary: "QA-only testing of an existing system; no product change", problemStatement: intake.userStatements[0]!.text,
      scope: { inScope: intake.criteria.map(item => `test ${item.id}`), outOfScope: ["product source, deployment and configuration changes", "fixing found bugs"] },
      acceptanceCriteria: intake.criteria.map(item => ({ id: item.id, description: `${item.description} (tested by reviewed cases and adjudicated)`, category: "functional",
        verificationMethod: "manual_review", required: item.required, status: "pending", evidenceArtifactIds: [] })),
      affectedPaths: [this.paths(intake).cases], status: "draft", createdBy: "coordinator", createdAt: at, updatedAt: at,
      metadata: { conditionalTdd: { policyVersion: 1, taskId: "qa", taskType: "integration",
        changeImpact: { surfaces: ["integration"], behaviorChanged: false, deterministic: false, regressionReproducible: false,
          securitySensitive: false, dataMigration: false, scope: "local" },
        infrastructure: { readiness: "absent", commands: [] },
        testability: { level: "partial", rationale: "Test assets exercise the deployed system; the product itself is not changed by this workflow." },
        riskClassification: "low", conventions: { tdd: "contextual", requiredMethods: ["manual_review"], suggestedLevels: ["e2e"] } } } });
    const strategy = new TestStrategyResolver().resolve(spec);
    if (strategy.tddDecision.mode !== "not_applicable") throw new Error("QA-only work must resolve TDD as not_applicable");
    return strategy;
  }
  private paths(intake: QaIntake) {
    const base = `${intake.workspace.assetRoot.replace(/\/$/, "")}/${intake.requestId}/r${intake.revision}`;
    return { cases: `${base}/tests/cases.json`, report: `${base}/report.md` };
  }

  /** Runs every step that needs no human input; returns at the design approval, a blocker or completion. */
  async drive(runId: string) {
    const run = this.live(runId);
    // A whole-run precondition (busy lease) is re-evaluated on every drive; nothing happened while it was blocked.
    if (run.status === "blocked" && run.blockers.length && run.blockers.every(item => item.startsWith("lease_busy:"))) {
      run.blockers = []; run.status = "running";
    }
    await this.restoreCore(run);
    for (let guard = 0; guard < 200; guard++) {
      let snapshot = await this.snapshot(runId);
      if (TERMINAL.has(snapshot.status)) return this.finish(run, snapshot);
      for (const task of snapshot.tasks.filter(item => item.status === "retrying"))
        snapshot = await this.mutate(runId, version => this.ports.engine.transitionTask({ runId, taskId: task.taskId, from: "retrying", to: "ready",
          intent: "normal", generationFrom: task.generation, generationTo: task.generation, expectedVersion: version, idempotencyKey: `qa:ready:${task.taskId}:${task.attempt}`,
          occurredAt: this.ports.now(), reason: "bounded retry eligible" }));
      snapshot = await this.mutate(runId, version => this.ports.engine.advance({ runId, expectedVersion: version,
        idempotencyKey: `qa:advance:${runId}:${version}`, occurredAt: this.ports.now() }));
      const active = snapshot.tasks.find(item => item.status === "running" || item.status === "waiting");
      if (active) {
        if (await this.execute(run, active) === "blocked") return this.status(runId);
        continue;
      }
      if (run.status !== "running") { await this.save(); return this.status(runId); }
      if (snapshot.tasks.some(item => item.status === "blocked" || item.status === "failed")) {
        run.status = "blocked";
        await this.save();
        return this.status(runId);
      }
      await this.requestApproval(run, snapshot);
      return this.status(runId);
    }
    throw new Error("QA workflow made no bounded progress");
  }

  private async execute(run: RunRecord, task: WorkflowRunSnapshot["tasks"][number]): Promise<"blocked" | void> {
    const kind = task.taskId as QaTaskKind;
    let existing = run.executions.find(item => item.attemptId === task.attemptId);
    if (!existing && task.agentExecution && task.agentExecution.attemptId === task.attemptId) {
      // Core persisted the binding but the journal write was lost: adopt Core's binding and reconcile it, never rebind.
      existing = { executionId: task.agentExecution.executionId, taskId: kind, attemptId: task.attemptId!, attempt: task.attempt,
        generation: task.generation, state: "bound", startedAt: task.agentExecution.acceptedAt };
      run.executions.push(existing);
      await this.save();
    }
    if (task.status === "waiting") { await this.evaluateGates(run, task, existing!); return; }
    if (existing?.state === "recorded") { await this.recordResult(run, existing); return; }
    let outcome: { agentId: string; output: unknown } | undefined;
    let execution = existing;
    if (execution) {
      if (!RUNTIME_TASKS.has(kind)) {
        // Bound before a restart, result never journaled: reconcile instead of resending.
        const reconciliation = await this.ports.roles.reconcile?.(execution.executionId) ?? { status: "unknown" as const };
        if (reconciliation.status === "unknown") {
          run.status = "blocked";
          run.blockers = [...new Set([...run.blockers, `unknown_delivery:${execution.executionId}`])];
          await this.save();
          throw new Error(`Execution ${execution.executionId} has unknown delivery; reconcile before resending`);
        }
        if (reconciliation.status === "completed") outcome = { agentId: reconciliation.agentId, output: reconciliation.output };
        run.blockers = run.blockers.filter(item => item !== `unknown_delivery:${execution!.executionId}`);
        if (run.status === "blocked" && !run.blockers.length) run.status = "running";
      }
    } else {
      execution = { executionId: `${run.runId}.${task.taskId}.g${task.generation}.a${task.attempt}`, taskId: kind,
        attemptId: task.attemptId!, attempt: task.attempt, generation: task.generation, state: "bound", startedAt: this.ports.now() };
      const handle = this.handle(run, execution);
      await this.mutate(run.runId, version => this.ports.engine.bindAgentExecution({ runId: run.runId, taskId: task.taskId, attempt: task.attempt,
        handle, expectedVersion: version, idempotencyKey: `qa:bind:${execution!.executionId}`, occurredAt: execution!.startedAt }));
      run.executions.push(execution);
      await this.save();
    }
    if (outcome === undefined && !RUNTIME_TASKS.has(kind)) outcome = await this.ports.roles.dispatch(this.assignment(run, kind, execution));
    try {
      await this.complete(run, execution, outcome ?? { agentId: "runtime", output: undefined });
    } catch (error) {
      if (!(error instanceof QaBlocked)) throw error;
      run.status = "blocked";
      run.blockers = [error.code];
      await this.save();
      return "blocked";
    }
  }

  private handle(run: RunRecord, execution: ExecutionRecord) {
    return { executionId: execution.executionId, requestId: `request-${execution.executionId}`, attemptId: execution.attemptId,
      runId: run.runId, taskId: execution.taskId, idempotencyKey: `qa:dispatch:${execution.executionId}`,
      target: { transport: RUNTIME_TASKS.has(execution.taskId) ? "runtime-qa" : "qa-role", agentId: this.roleOf(run, execution.taskId), paneId: execution.taskId },
      correlation: { token: sha256(`${run.runId}:${execution.executionId}`), provenance: "remote" as const, verified: true },
      acceptedAt: execution.startedAt };
  }
  private roleOf(run: RunRecord, taskId: string): string {
    return run.definition.tasks.find(item => item.id === taskId)!.role;
  }

  private assignment(run: RunRecord, kind: QaTaskKind, execution: ExecutionRecord): QaAssignment {
    const latest = run.designs.at(-1);
    const check = run.designChecks.at(-1);
    const adjudication = run.adjudications.at(-1);
    const findings = [
      ...(kind === "design" && check && check.result.status !== "passed" ? check.result.findings : []),
      ...(kind === "adjudication" && adjudication?.problems ? adjudication.problems : [])
    ].map(item => ({ code: item.code, ids: [...item.ids], message: item.message }));
    return structuredClone({ runId: run.runId, taskId: kind, role: this.roleOf(run, kind), executionId: execution.executionId,
      attemptId: execution.attemptId, instruction: run.definition.tasks.find(item => item.id === kind)!.instruction, intake: run.intake,
      permissions: { read: [] as string[], write: "none" as const, commands: "none" as const, network: "none" as const },
      context: { ...(latest && kind !== "design" ? { design: { version: latest.version, digest: latest.digest, content: latest.content } } : {}),
        ...(kind === "adjudication" && run.execution?.digest ? { execution: { ...this.summary(run), digest: run.execution.digest } } : {}),
        findings } });
  }

  private async complete(run: RunRecord, execution: ExecutionRecord, outcome: { agentId: string; output: unknown }) {
    const kind = execution.taskId;
    let failure: { code: string; message: string } | undefined;
    try {
      const forbidden = forbiddenOutputKeys(outcome.output);
      if (forbidden.length) throw new QaScopeDenied("forbidden_authority", `Role output requested forbidden authority: ${forbidden.join(", ")}`);
      if (!RUNTIME_TASKS.has(kind) && outcome.agentId !== this.roleOf(run, kind) && !outcome.agentId.startsWith(`${this.roleOf(run, kind)}:`))
        throw new QaScopeDenied("wrong_role", `Output came from ${outcome.agentId}, not the assigned ${this.roleOf(run, kind)} role`);
      if (kind === "design") await this.acceptDesign(run, execution, outcome.agentId, QaRoleOutputSchemas.design.parse(outcome.output).design);
      else if (kind === "design-review") await this.acceptReview(run, outcome.agentId, QaRoleOutputSchemas["design-review"].parse(outcome.output));
      else if (kind === "adjudication") await this.acceptAdjudication(run, execution, outcome.agentId, QaRoleOutputSchemas.adjudication.parse(outcome.output));
      else if (kind === "execution") await this.runExecution(run);
      else await this.publishReport(run);
    } catch (error) {
      if (error instanceof QaScopeDenied) {
        run.denials.push({ executionId: execution.executionId, taskId: kind, reason: error.message, at: this.ports.now() });
        failure = { code: "permission_denied", message: error.message };
      } else if (!RUNTIME_TASKS.has(kind) && error instanceof Error && error.name === "ZodError") {
        failure = { code: "invalid_role_output", message: error.message.slice(0, 2000) };
      } else throw error;
    }
    if (failure && failure.code !== "permission_denied")
      run.rejections.push({ executionId: execution.executionId, taskId: kind, code: failure.code, message: failure.message, at: this.ports.now() });
    execution.state = "recorded";
    execution.agentId = outcome.agentId;
    execution.outputDigest = qaDigest(outcome.output ?? null);
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
      verification: { status: "verified", evidence: `qa ${kind} output ${execution.outputDigest}`, correlation: this.handle(run, execution).correlation },
      artifactProposals: [], retryable: Boolean(failure), startedAt: execution.startedAt, completedAt: at,
      ...(failure ? { error: { code: failure.code, message: failure.message, retryable: true } } : {}) });
    const snapshot = await this.mutate(run.runId, version => this.ports.engine.recordAgentResult({ runId: run.runId, taskId: kind,
      expectedVersion: version, result, idempotencyKey: `qa:result:${execution.executionId}`, occurredAt: at }));
    const current = snapshot.tasks.find(item => item.taskId === kind)!;
    if (!failure && current.status === "waiting") await this.evaluateGates(run, current, execution);
  }

  private async acceptDesign(run: RunRecord, execution: ExecutionRecord, agentId: string, design: QaTestDesignParsed) {
    const digest = qaDigest(design);
    if (run.designs.at(-1)?.digest === digest && run.designs.at(-1)?.attemptId === execution.attemptId) return;
    const version = (run.designs.at(-1)?.version ?? 0) + 1;
    const artifact = await this.putJson(run, "design", `qa-${run.runId}-design-v${version}`, "document", design);
    run.designs.push({ version, digest, artifact, authorAgentId: agentId, attemptId: execution.attemptId, content: design });
  }

  private async acceptReview(run: RunRecord, agentId: string, output: { verdict: "approved" | "changes_requested"; designDigest: string;
    findings: { id: string; severity: "blocking" | "advisory"; caseIds: string[]; note: string }[] }) {
    const artifact = await this.putJson(run, "design-review", `qa-${run.runId}-review-${output.designDigest.slice(0, 16)}-${sha256(agentId).slice(0, 8)}`, "report", { agentId, ...output });
    run.review = { agentId, verdict: output.verdict, designDigest: output.designDigest, artifact, findings: output.findings };
  }

  private async acceptAdjudication(run: RunRecord, execution: ExecutionRecord, agentId: string,
    output: { executionDigest: string; verdicts: { caseId: string; classification: QaClassification; rationale: string }[] }) {
    if (run.adjudications.at(-1)?.attemptId === execution.attemptId) return;
    const artifact = await this.putJson(run, "adjudication", `qa-${run.runId}-adjudication-${execution.attemptId}`, "report", { agentId, ...output });
    run.adjudications.push({ agentId, attemptId: execution.attemptId, executionDigest: output.executionDigest, artifact, verdicts: output.verdicts });
  }

  /** Runtime-owned gates; agents never define or evaluate them. */
  private async evaluateGates(run: RunRecord, task: WorkflowRunSnapshot["tasks"][number], execution: ExecutionRecord) {
    const binding = run.definition.tasks.find(item => item.id === task.taskId)!.qualityGates[0];
    if (!binding) return;
    const evaluationId = `qa-${binding.gateId}-${execution.executionId}`;
    const at = this.ports.now();
    let problems: QaFinding[] = [];
    let produced: ArtifactReference[] = [];
    if (binding.gateId === QA_GATES.design) {
      const latest = run.designs.at(-1)!;
      let recorded = run.designChecks.find(item => item.attemptId === execution.attemptId && item.designDigest === latest.digest);
      if (!recorded) {
        const result = verifyQaDesign(latest.content, run.intake);
        const artifact = await this.putJson(run, "design", `qa-${run.runId}-design-check-v${latest.version}-${execution.attemptId}`, "report", { designDigest: latest.digest, ...result });
        recorded = { designDigest: latest.digest, attemptId: execution.attemptId, result, artifact };
        run.designChecks.push(recorded);
      }
      problems = recorded.result.findings.filter(item => item.severity === "error");
      produced = [recorded.artifact];
    } else if (binding.gateId === QA_GATES.review) {
      const latest = run.designs.at(-1)!;
      const review = run.review!;
      if (review.agentId === latest.authorAgentId) problems.push({ code: "review_not_independent", severity: "error", ids: [review.agentId], message: "The reviewer authored the test design" });
      if (review.designDigest !== latest.digest) problems.push({ code: "review_stale", severity: "error", ids: [review.designDigest], message: "Review is not pinned to the current design digest" });
      if (review.verdict !== "approved" || review.findings.some(item => item.severity === "blocking"))
        problems.push({ code: "review_changes_requested", severity: "error", ids: review.findings.map(item => item.id), message: "Independent review requested changes" });
      problems.push(...verifyQaDesign(latest.content, run.intake).findings.filter(item => item.severity === "error"));
      produced = [review.artifact];
      if (problems.length) { run.status = "needs_revision"; run.blockers = problems.map(item => `${item.code}:${item.ids.join(",")}`); }
    } else if (binding.gateId === QA_GATES.execution) {
      problems = await this.executionIntegrity(run);
      produced = run.execution?.artifact ? [run.execution.artifact] : [];
    } else if (binding.gateId === QA_GATES.adjudication) {
      const latest = run.adjudications.at(-1)!;
      latest.problems = this.adjudicationProblems(run, latest);
      problems = latest.problems;
      produced = [latest.artifact];
      if (!problems.length) run.classifications = Object.fromEntries(latest.verdicts.map(item => [item.caseId, item.classification]));
    } else {
      const report = run.report!;
      for (const file of report.files) {
        const bytes = await readFile(resolve(this.ports.repositoryRoot, file.path)).catch(() => undefined);
        if (!bytes || sha256(bytes) !== file.sha256) problems.push({ code: "report_integrity", severity: "error", ids: [file.path], message: `Report file changed or missing: ${file.path}` });
      }
      produced = [report.artifact];
    }
    const status = problems.length ? "failed" : "passed";
    await this.mutate(run.runId, version => this.ports.engine.requestQualityGateEvaluation({ runId: run.runId, taskId: task.taskId, gateId: binding.gateId,
      evaluationId, attemptId: execution.attemptId, expectedVersion: version, idempotencyKey: `qa:gate-request:${evaluationId}`, occurredAt: at }));
    await this.mutate(run.runId, version => this.ports.engine.recordQualityGateResult({ expectedVersion: version, idempotencyKey: `qa:gate-result:${evaluationId}`,
      result: { runId: run.runId, taskId: task.taskId, gateId: binding.gateId, evaluationId, status,
        findings: problems.slice(0, 50).map(item => ({ code: item.code, severity: "error" as const, message: item.message.slice(0, 2000), details: { ids: [...item.ids] } })),
        producedArtifacts: [], evaluatedAt: at,
        metadata: { evidenceArtifactIds: produced.map(item => item.artifactId),
          ...(status === "failed" && (binding.gateId === QA_GATES.design || binding.gateId === QA_GATES.adjudication) ? { independentVerification: true } : {}) } } }));
    await this.save();
  }

  /** Adjudication may only choose product_failure or test_defect for assertion failures; Runtime-observed outcomes are fixed. */
  private adjudicationProblems(run: RunRecord, adjudication: AdjudicationRecord): QaFinding[] {
    const exec = run.execution!;
    const problems: QaFinding[] = [];
    const add = (code: QaFinding["code"], ids: string[], message: string) => problems.push({ code, severity: "error", ids, message });
    if (adjudication.agentId === run.designs.at(-1)!.authorAgentId) add("adjudication_not_independent", [adjudication.agentId], "The test designer cannot adjudicate its own results");
    if (adjudication.executionDigest !== exec.digest) add("adjudication_stale", [adjudication.executionDigest], "Adjudication is not pinned to the current execution digest");
    for (const outcome of Object.values(exec.cases)) {
      const verdicts = adjudication.verdicts.filter(item => item.caseId === outcome.caseId);
      if (verdicts.length !== 1) { add("verdict_missing", [outcome.caseId], `Case ${outcome.caseId} needs exactly one verdict`); continue; }
      const chosen = verdicts[0]!.classification;
      if (outcome.status === "assertion_failed" ? chosen !== "product_failure" && chosen !== "test_defect" : chosen !== outcome.status)
        add("classification_override", [outcome.caseId], outcome.status === "assertion_failed"
          ? `Case ${outcome.caseId} failed an assertion: classify it as product_failure or test_defect`
          : `Case ${outcome.caseId} was observed as ${outcome.status}${outcome.code ? ` (${outcome.code})` : ""}; adjudication cannot change it to ${chosen}`);
    }
    for (const verdict of adjudication.verdicts)
      if (!exec.cases[verdict.caseId]) add("verdict_unknown_case", [verdict.caseId], `Verdict for unknown case ${verdict.caseId}`);
    return problems;
  }

  private async executionIntegrity(run: RunRecord): Promise<QaFinding[]> {
    const exec = run.execution;
    const problems: QaFinding[] = [];
    const add = (ids: string[], message: string, code: QaFinding["code"] = "execution_integrity") => problems.push({ code, severity: "error", ids, message });
    if (!exec?.completedAt || !exec.digest) return [{ code: "execution_integrity", severity: "error", ids: [], message: "Execution did not complete" }];
    const design = this.approvedDesign(run);
    for (const testCase of design.cases)
      if (exec.cases[testCase.id]?.state !== "done") add([testCase.id], `Case ${testCase.id} has no recorded outcome`);
    for (const mutation of exec.mutations.filter(item => item.state === "intent")) add([mutation.mutationId], "Mutation intent was never settled or marked uncertain");
    if (!exec.productUnchanged) add(run.intake.protectedPaths, "Protected product paths changed during the QA run", "product_changed");
    const assets = exec.assets && await readFile(resolve(this.ports.repositoryRoot, exec.assets.path)).catch(() => undefined);
    if (!assets || sha256(assets) !== exec.assets!.sha256) add([exec.assets?.path ?? "assets"], "Executed test assets changed or are missing");
    return problems;
  }

  /** Human approval of the exact reviewed design digest; it authorizes the listed side effects on the approved target only. */
  private async requestApproval(run: RunRecord, snapshot: WorkflowRunSnapshot): Promise<void> {
    const review = snapshot.tasks.find(item => item.taskId === "design-review")!;
    const latest = run.designs.at(-1);
    if (review.status !== "succeeded" || !latest || run.approval?.decision) return;
    const approvalId = `qa-design-${run.runId}-v${latest.version}`;
    if (run.approval?.approvalId !== approvalId) {
      const check = run.designChecks.filter(item => item.designDigest === latest.digest).at(-1)!;
      await this.mutate(run.runId, version => this.ports.engine.requestApproval({ expectedVersion: version, idempotencyKey: `qa:approval:${approvalId}`,
        request: ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId, runId: run.runId, sessionId: run.intake.sessionId,
          target: { type: "task", taskId: "design-review" }, revision: latest.version, generation: review.generation, requestedBy: "coordinator",
          requestedAt: this.ports.now(), reason: "Approve the reviewed test design before Runtime executes it against the target",
          evidence: [latest.artifact, check.artifact, run.review!.artifact], idempotencyKey: `qa:approval:${approvalId}`,
          metadata: { approvalScope: "qa_test_design", designDigest: latest.digest, environmentId: run.intake.target.environmentId,
            origins: run.intake.target.origins, mutatingCases: latest.content.cases.filter(item => item.sideEffect === "mutating").map(item => item.id),
            productChange: "not_authorized" } }) }));
      run.approval = { approvalId, designDigest: latest.digest };
    }
    run.status = "awaiting_design_approval";
    await this.save();
  }

  async decideDesign(runId: string, input: { decision: "approved" | "changes_requested" | "rejected"; designDigest: string; decidedBy: string; reason?: string }) {
    const run = this.live(runId);
    const pending = run.approval;
    if (!pending || pending.decision || run.status !== "awaiting_design_approval") throw new Error("No test design approval is pending");
    if (input.designDigest !== pending.designDigest) throw new Error("Approval must name the exact reviewed design digest");
    await this.restoreCore(run);
    const snapshot = await this.snapshot(runId);
    const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: pending.approvalId, runId, sessionId: run.intake.sessionId,
      target: { type: "task", taskId: "design-review" }, revision: run.designs.at(-1)!.version,
      generation: snapshot.tasks.find(item => item.taskId === "design-review")!.generation, decision: input.decision, decidedBy: input.decidedBy,
      decidedAt: this.ports.now(), ...(input.reason ? { reason: input.reason } : {}), feedbackArtifacts: [], idempotencyKey: `qa:decision:${pending.approvalId}`,
      metadata: { approvalScope: "qa_test_design", designDigest: pending.designDigest, productChange: "not_authorized" } });
    await this.authorize(decision);
    await this.mutate(runId, version => this.ports.engine.applyApproval({ expectedVersion: version, idempotencyKey: `qa:decision:${pending.approvalId}`, decision }));
    pending.decision = decision;
    if (input.decision !== "approved") { run.status = "needs_revision"; run.blockers = [`design_${input.decision}`]; }
    else run.status = "running";
    await this.save();
    return input.decision === "approved" ? this.drive(runId) : this.status(runId);
  }

  private async authorize(decision: ApprovalDecision) {
    if (AGENT_ROLES.includes(decision.decidedBy.split(":")[0]!) || !await this.ports.authorizeHuman(decision))
      throw new Error("QA decisions require an authenticated human decision");
  }

  private approvedDesign(run: RunRecord): QaTestDesignParsed {
    const latest = run.designs.at(-1);
    const approval = run.approval;
    if (!latest || approval?.decision?.decision !== "approved" || approval.designDigest !== latest.digest)
      throw new QaScopeDenied("design_not_approved", "Execution requires the human approval of the current design digest");
    return latest.content;
  }

  // ---- Execution: Runtime acts on the target through granted tools under one fenced lease. ----

  private sanitizer(run: RunRecord): QaSanitizer {
    let sanitizer = this.sanitizers.get(run.runId);
    if (!sanitizer) { sanitizer = new QaSanitizer(run.intake); this.sanitizers.set(run.runId, sanitizer); }
    return sanitizer;
  }

  private async runExecution(run: RunRecord) {
    const design = this.approvedDesign(run);
    const exec = run.execution ??= { startedAt: this.ports.now(), leases: [], cases: {}, mutations: [], vars: {} };
    if (exec.completedAt) return;
    // Test assets are the approved design itself, written only inside the granted workspace before any target access.
    if (!exec.assets) {
      const path = this.paths(run.intake).cases;
      const content = `${JSON.stringify({ schemaVersion: 1, kind: "bflow.qa-test-assets", runId: run.runId, requestId: run.intake.requestId,
        designDigest: run.approval!.designDigest, approvalId: run.approval!.approvalId, environmentId: run.intake.target.environmentId, design }, null, 2)}\n`;
      await this.writeWorkspaceFile(run, path, content);
      exec.assets = { path, sha256: sha256(content) };
    }
    exec.protectedBefore ??= await this.protectedDigest(run);
    // Crash recovery: an intent without a settled outcome may have reached the target. It is never replayed.
    for (const mutation of exec.mutations.filter(item => item.state === "intent")) { mutation.state = "uncertain"; mutation.recoveredAfterRestart = true; }
    await this.save();
    await this.ensureLease(run, exec);
    if (!exec.readiness) {
      await this.probeTarget(run, exec);
      await this.save();
    }
    for (const testCase of design.cases) {
      if (exec.cases[testCase.id]?.state === "done") continue;
      await this.runCase(run, exec, testCase);
      await this.save();
      await this.renewLease(exec);
    }
    if (exec.lease && !exec.leaseInterruption) {
      await this.ports.leases.release(exec.lease);
      exec.leases.find(item => item.leaseId === exec.lease!.leaseId)!.released = true;
    }
    exec.protectedAfter = await this.protectedDigest(run);
    exec.productUnchanged = exec.protectedAfter === exec.protectedBefore;
    const summary = this.summary(run);
    exec.digest = qaDigest(summary);
    exec.artifact = await this.putJson(run, "execution", `qa-${run.runId}-execution`, "test-result", { digest: exec.digest, ...summary,
      mutations: exec.mutations, leases: exec.leases, assets: exec.assets }, true);
    exec.completedAt = this.ports.now();
    await this.save();
  }

  private summary(run: RunRecord): QaExecutionSummary {
    const exec = run.execution!;
    return { build: exec.build!, readiness: { ready: exec.readiness?.ready ?? false, ...(exec.readiness?.reason ? { reason: exec.readiness.reason } : {}) },
      productUnchanged: exec.productUnchanged ?? false,
      cases: Object.values(exec.cases).map(item => ({ caseId: item.caseId, criterionIds: item.criterionIds, status: item.status,
        ...(item.code ? { code: item.code } : {}), findings: item.findings, cleanup: item.cleanup.status })) };
  }

  private async ensureLease(run: RunRecord, exec: ExecutionState) {
    if (exec.leaseInterruption) return;
    if (exec.lease) {
      const current = await this.ports.leases.assertCurrent(exec.lease);
      if (current.ok) return;
      // A lease lost or expired during the transaction is not silently reacquired: remaining actions are blocked.
      exec.leaseInterruption = current.code;
      return;
    }
    const resourceKey = `qa-target-${run.intake.target.environmentId}`;
    const acquired = await this.ports.leases.acquire(resourceKey, `qa:${run.runId}`, this.ports.leaseTtlMs ?? 60_000);
    if (!acquired.ok) throw new QaBlocked(`lease_busy:${resourceKey}:${acquired.holder}:${acquired.expiresAt}`);
    exec.lease = acquired.lease;
    exec.leases.push({ leaseId: acquired.lease.leaseId, resourceKey, fencingToken: acquired.lease.fencingToken,
      acquiredAt: acquired.lease.acquiredAt, expiresAt: acquired.lease.expiresAt, released: false });
    await this.save();
  }
  private async renewLease(exec: ExecutionState) {
    if (!exec.lease || exec.leaseInterruption) return;
    const renewed = await this.ports.leases.renew(exec.lease, this.ports.leaseTtlMs ?? 60_000);
    if (!renewed.ok) { exec.leaseInterruption = renewed.code; return; }
    exec.lease = renewed.lease;
    exec.leases.find(item => item.leaseId === renewed.lease.leaseId)!.expiresAt = renewed.lease.expiresAt;
  }
  /** Fence check immediately before each side effect or read of the target. */
  private async fence(exec: ExecutionState): Promise<AppCheckLease> {
    if (exec.leaseInterruption) throw new LeaseInterrupted(exec.leaseInterruption);
    const current = exec.lease ? await this.ports.leases.assertCurrent(exec.lease) : { ok: false as const, code: "lease_lost" as const };
    if (!current.ok) { exec.leaseInterruption = current.code; throw new LeaseInterrupted(current.code); }
    return current.lease;
  }

  private grantFor(run: RunRecord, toolId: string, action: QaAction): boolean {
    return this.ports.grants.some(raw => {
      const grant = ResolvedToolGrantSchema.safeParse(raw);
      return grant.success && grant.data.role === QA_EXECUTION_ROLE && grant.data.toolId === toolId && grant.data.operations.includes(action) &&
        grant.data.scope.kind === "session" && grant.data.scope.sessionId === run.intake.sessionId && grant.data.scope.workspaceRoot === this.ports.repositoryRoot;
    });
  }
  private prerequisiteGap(run: RunRecord, steps: readonly QaStep[], account?: string): string | undefined {
    for (const step of steps) {
      const toolId = step.kind === "http" ? QA_HTTP_TOOL_ID : QA_BROWSER_TOOL_ID;
      const tool = step.kind === "http" ? this.ports.tools.http : this.ports.tools.browser;
      if (!tool) return `tool_not_wired:${toolId}`;
      const action = actionOf(step);
      if (!run.intake.allowedActions.includes(action)) return `action_not_allowed:${action}`;
      if (!this.grantFor(run, toolId, action)) return `grant_unavailable:${toolId}:${action}`;
    }
    if (account !== undefined && !this.ports.accounts) return `account_unavailable:${account}`;
    return undefined;
  }

  /** Readiness of the target and its deployed build identity. An unobservable build is a stated limitation, never a guess. */
  private async probeTarget(run: RunRecord, exec: ExecutionState) {
    const at = this.ports.now();
    const unknown = (why: string): QaBuildIdentity => ({ status: "unknown", limitation: `${why}; results are not attributed to any source revision` });
    const readStep: QaHttpStep = { kind: "http", method: "GET", url: run.intake.target.readinessPath };
    const gap = this.prerequisiteGap(run, [readStep]);
    if (gap) {
      exec.readiness = { ready: false, reason: `prerequisite_gap:${gap}`, at };
      exec.build = unknown("The target could not be probed");
      return;
    }
    const ready = await this.request(run, exec, new URL(run.intake.target.readinessPath, run.intake.target.origins[0]), "GET", {}, undefined, 5_000).catch(error => {
      if (error instanceof LeaseInterrupted) return undefined;
      throw error;
    });
    if (!ready || ready.kind !== "response" || ready.status < 200 || ready.status >= 300) {
      exec.readiness = { ready: false, at, reason: !ready ? `lease:${exec.leaseInterruption}` : ready.kind === "response" ? `status ${ready.status}` : ready.kind,
        ...(ready?.kind === "response" ? { status: ready.status } : {}) };
      exec.build = unknown("The target was not ready, so its build identity could not be observed");
      return;
    }
    exec.readiness = { ready: true, status: ready.status, at };
    const config = run.intake.target.buildIdentity;
    if (!config || !config.path && !config.header) { exec.build = unknown("No build identity source was declared for the target"); return; }
    let value: unknown;
    let source = "";
    if (config.header) { value = ready.headers[config.header.toLowerCase()]; source = `header:${config.header}`; }
    if ((value === undefined || value === "") && config.path) {
      source = `endpoint:${config.path}${config.pointer !== undefined ? `#${config.pointer}` : ""}`;
      const response = await this.request(run, exec, new URL(config.path, run.intake.target.origins[0]), "GET", {}, undefined, 5_000).catch(() => undefined);
      if (response?.kind === "response" && response.status >= 200 && response.status < 300) {
        if (config.pointer === undefined) value = response.body.trim();
        else { try { value = pointer(JSON.parse(response.body), config.pointer).value; } catch { value = undefined; } }
      }
    }
    exec.build = (typeof value === "string" || typeof value === "number") && String(value).length > 0 && String(value).length <= 128
      ? { status: "identified", value: this.sanitizer(run).text(String(value)), source }
      : unknown(`The build identity source ${source} returned no identity`);
  }

  /** One HTTP exchange through the granted tool, fence-checked; never follows redirects by itself. */
  private async request(run: RunRecord, exec: ExecutionState, url: URL, method: string, headers: Record<string, string>, body: string | undefined,
    timeoutMs: number): Promise<QaHttpOutcome> {
    await this.fence(exec);
    if (!run.intake.target.origins.includes(url.origin)) throw new QaScopeDenied("origin_not_approved", `Origin ${url.origin} is not approved`);
    return this.ports.tools.http!.request({ method, url: url.toString(), headers, ...(body !== undefined ? { body } : {}), timeoutMs });
  }

  private async runCase(run: RunRecord, exec: ExecutionState, testCase: QaCase) {
    const sanitizer = this.sanitizer(run);
    const prior = exec.cases[testCase.id];
    const outcome: QaCaseOutcome = prior ?? { caseId: testCase.id, criterionIds: [...testCase.criterionIds], state: "running", status: "inconclusive",
      steps: [], findings: [], cleanup: { status: "not_required" }, startedAt: this.ports.now() };
    exec.cases[testCase.id] = outcome;
    const vars = exec.vars[testCase.id] ??= { fixturePrefix: run.intake.dataPolicy.fixturePrefix };
    const testMutations = () => exec.mutations.filter(item => item.caseId === testCase.id && item.phase === "test");
    const finish = async (status: QaCaseStatus, code?: string) => {
      outcome.status = status;
      if (code) outcome.code = code; else delete outcome.code;
      await this.cleanup(run, exec, testCase, outcome, vars);
      outcome.completedAt = this.ports.now();
      // Scrub after cleanup: secrets learned from later responses are removed from earlier steps and findings too.
      outcome.steps = sanitizer.scrub(outcome.steps);
      outcome.cleanup = sanitizer.scrub(outcome.cleanup);
      outcome.findings = outcome.steps.filter(item => item.phase === "test").flatMap(item => item.findings);
      const evidence = sanitizer.scrub({ caseId: testCase.id, title: testCase.title, criterionIds: testCase.criterionIds, expected: testCase.expected,
        status: outcome.status, code: outcome.code ?? null, steps: outcome.steps, cleanup: outcome.cleanup,
        mutations: exec.mutations.filter(item => item.caseId === testCase.id), build: exec.build, environmentId: run.intake.target.environmentId });
      outcome.evidenceArtifactId = (await this.putJson(run, "execution", `qa-${run.runId}-case-${testCase.id}`, "test-result", evidence, true)).artifactId;
      outcome.state = "done";
    };
    if (prior) {
      // Resumed after a host failure. Without a mutation the case restarts (reads are safe to repeat); after any mutation
      // it is never re-run: uncertain intents are reconciled and the case is inconclusive.
      if (testMutations().length) {
        await this.reconcileCase(run, exec, testCase, outcome, vars, await this.credentials(run, testCase).catch(() => ({})));
        return finish("inconclusive", testMutations().some(item => item.state === "uncertain") ? "mutation_uncertain" : "interrupted_after_mutation");
      }
      outcome.steps = [];
    }
    const gap = this.prerequisiteGap(run, [...testCase.steps, ...testCase.cleanup, ...(testCase.reconcile ? [testCase.reconcile] : [])], testCase.account);
    if (gap) return finish("blocked", `prerequisite_gap:${gap}`);
    if (exec.leaseInterruption) return finish("blocked", exec.leaseInterruption);
    // A readiness probe that could not run (no wired tool or grant) is a prerequisite gap, not evidence that the app is down.
    if (!exec.readiness?.ready) return exec.readiness?.reason?.startsWith("prerequisite_gap:")
      ? finish("blocked", exec.readiness.reason) : finish("environment_failure", "app_unavailable");
    const headers = await this.credentials(run, testCase);
    for (const [index, step] of testCase.steps.entries()) {
      const record = await this.performStep(run, exec, testCase, "test", index, step, vars, headers);
      outcome.steps.push(record);
      await this.save();
      if (record.outcome === "ok") continue;
      if (record.outcome === "assertion_failed" || record.outcome === "unresolved_variable") return finish("assertion_failed");
      if (record.outcome === "denied") return finish("blocked", record.findings[0]?.code ?? "scope_denied");
      if (record.outcome === "lease") return finish(testMutations().some(item => item.state !== "not_delivered") ? "inconclusive" : "blocked", exec.leaseInterruption);
      if (record.outcome === "unavailable") return finish("environment_failure", "app_unavailable");
      if (record.outcome === "uncertain") {
        await this.reconcileCase(run, exec, testCase, outcome, vars, headers);
        return finish("inconclusive", "mutation_uncertain");
      }
      return finish("inconclusive", "read_timeout");
    }
    return finish("passed");
  }

  private async credentials(run: RunRecord, testCase: QaCase): Promise<Record<string, string>> {
    if (testCase.account === undefined) return {};
    const headers = { ...await this.ports.accounts!.headers(testCase.account) };
    for (const value of Object.values(headers)) this.sanitizer(run).addSecret(value);
    return headers;
  }

  /** Read-only probe that settles uncertain mutations of a case. It never resends the mutation itself. */
  private async reconcileCase(run: RunRecord, exec: ExecutionState, testCase: QaCase, outcome: QaCaseOutcome, vars: Record<string, string>, headers: Record<string, string>) {
    const pending = exec.mutations.filter(item => item.caseId === testCase.id && item.phase === "test" && item.state === "uncertain" && !item.reconciliation);
    if (!pending.length) return;
    let result: QaMutationRecord["reconciliation"] = "unknown";
    if (testCase.reconcile && !exec.leaseInterruption) {
      const record = await this.performStep(run, exec, testCase, "reconcile", 0, testCase.reconcile, vars, headers);
      outcome.steps.push(record);
      if (record.outcome === "ok") result = "applied";
      else if (record.outcome === "assertion_failed" && record.findings.every(item => item.code === "capture_missing")) result = "not_applied";
    }
    for (const mutation of pending) mutation.reconciliation = result;
    await this.save();
  }

  /**
   * Cleanup of data a case created. It runs under the same lease; a failure or an unresolvable uncertainty is kept as
   * residual data in the report. Cleanup never erases the record of an uncertain mutation.
   */
  private async cleanup(run: RunRecord, exec: ExecutionState, testCase: QaCase, outcome: QaCaseOutcome, vars: Record<string, string>) {
    const mutations = exec.mutations.filter(item => item.caseId === testCase.id && item.phase === "test");
    const created = mutations.some(item => item.state === "applied" || item.state === "rejected" && (item.status ?? 0) >= 500 ||
      item.state === "uncertain" && item.reconciliation !== "not_applied");
    if (!created) { outcome.cleanup = { status: "not_required" }; return; }
    if (!testCase.cleanup.length) { outcome.cleanup = { status: "skipped", detail: "The intake did not require cleanup; created data remains" }; return; }
    if (exec.leaseInterruption) { outcome.cleanup = { status: "failed", detail: `Cleanup could not run: ${exec.leaseInterruption}` }; return; }
    const headers = await this.credentials(run, testCase).catch(() => ({}));
    for (const [index, step] of testCase.cleanup.entries()) {
      const record = await this.performStep(run, exec, testCase, "cleanup", index, step, vars, headers);
      outcome.steps.push(record);
      await this.save();
      if (record.outcome !== "ok") {
        outcome.cleanup = { status: "failed", detail: `Cleanup step ${index + 1} ${record.request}: ${record.findings.map(item => item.message).join("; ") || record.outcome}` };
        return;
      }
    }
    outcome.cleanup = { status: "cleaned" };
  }

  private async performStep(run: RunRecord, exec: ExecutionState, testCase: QaCase, phase: QaStepRecord["phase"], index: number, step: QaStep,
    vars: Record<string, string>, credentialHeaders: Record<string, string>): Promise<QaStepRecord> {
    const sanitizer = this.sanitizer(run);
    const action = actionOf(step);
    const base = { phase, index, action, at: this.ports.now() };
    const deny = (code: string, message: string, request: string): QaStepRecord => {
      run.denials.push({ executionId: `${run.runId}.execution`, taskId: `execution:${testCase.id}`, reason: message, at: this.ports.now() });
      return { ...base, request, outcome: "denied", findings: [{ code, message }] };
    };
    if (!run.intake.allowedActions.includes(action)) return deny("action_not_allowed", `${action} is not an allowed action`, step.kind);
    if (step.kind === "browser") return this.performBrowserStep(run, exec, testCase, base, step, vars);
    let url: URL; let body: string | undefined; let headers: Record<string, string>;
    try {
      url = resolveTargetUrl(step.url, run.intake, vars);
      body = step.body === undefined ? undefined : JSON.stringify(substitute(step.body, vars));
      headers = { ...substitute(step.headers ?? {}, vars), ...credentialHeaders, ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    } catch (error) {
      if (error instanceof QaUnresolvedVariable)
        return { ...base, request: `${step.method} ${sanitizer.text(step.url)}`, outcome: "unresolved_variable",
          findings: [{ code: "unresolved_variable", message: `\${${error.variable}} was never captured`, expected: `captured \${${error.variable}}`, actual: "not captured" }] };
      if (error instanceof QaScopeDenied) return deny(error.code, error.message, `${step.method} ${sanitizer.text(step.url)}`);
      throw error;
    }
    let method: string = step.method;
    const mutating = action === "http_mutate";
    for (let redirects = 0; ; redirects++) {
      const request = `${method} ${sanitizer.text(url.toString())}`;
      const recordBase = { ...base, request, requestHeaders: sanitizer.headersOf(headers), ...(body !== undefined ? { requestBody: sanitizer.body(body) } : {}) };
      let lease: AppCheckLease;
      try { lease = await this.fence(exec); }
      catch (error) {
        if (error instanceof LeaseInterrupted) return { ...recordBase, outcome: "lease", findings: [{ code: error.code, message: `Environment lease ${error.code}; no further actions` }] };
        throw error;
      }
      let mutation: QaMutationRecord | undefined;
      if (mutating) {
        // The intent is durable before the request: after a crash it can only be reconciled, never replayed.
        mutation = { mutationId: `${run.runId}.${testCase.id}.${phase}.${index}.${redirects}`, caseId: testCase.id, phase: phase === "cleanup" ? "cleanup" : "test",
          stepIndex: index, request, requestDigest: sha256(`${method}\n${url}\n${body ?? ""}`), leaseId: lease.leaseId, fencingToken: lease.fencingToken,
          state: "intent", at: this.ports.now() };
        exec.mutations.push(mutation);
        await this.save();
      }
      const response = await this.ports.tools.http!.request({ method, url: url.toString(), headers, ...(body !== undefined ? { body } : {}), timeoutMs: step.timeoutMs ?? 10_000 });
      if (mutation) {
        mutation.state = response.kind === "response" ? response.status < 400 ? "applied" : "rejected"
          : response.kind === "unavailable" ? "not_delivered" : "uncertain";
        if (response.kind === "response") mutation.status = response.status;
        mutation.settledAt = this.ports.now();
        await this.save();
      }
      if (response.kind === "timeout" || response.kind === "interrupted")
        return { ...recordBase, outcome: mutating ? "uncertain" : "timeout", findings: [{ code: response.kind, message: mutating
          ? "No response after the mutation was sent; the outcome is uncertain and it will not be replayed" : `Read ${response.kind}` }] };
      if (response.kind === "unavailable") return { ...recordBase, outcome: "unavailable", findings: [{ code: "app_unavailable", message: response.message }] };
      const responseRecord = { status: response.status, headers: sanitizer.headersOf(response.headers), body: sanitizer.body(response.body) };
      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && location && !mutating) {
        const next = new URL(location, url);
        if (!run.intake.target.origins.includes(next.origin))
          return { ...deny("origin_redirect_denied", `Redirect from ${url.origin} to ${next.origin} was denied: approval does not extend to other origins`, request), response: responseRecord };
        if (redirects >= 3) return { ...recordBase, response: responseRecord, outcome: "assertion_failed", findings: [{ code: "too_many_redirects", message: "More than 3 redirects" }] };
        url = next; method = "GET"; body = undefined;
        continue;
      }
      const findings = this.assertResponse(step, response, vars, sanitizer);
      return { ...recordBase, response: responseRecord, outcome: findings.length ? "assertion_failed" : "ok", findings };
    }
  }

  private assertResponse(step: QaHttpStep, response: Extract<QaHttpOutcome, { kind: "response" }>, vars: Record<string, string>, sanitizer: QaSanitizer): QaStepFinding[] {
    const findings: QaStepFinding[] = [];
    const expect = step.expect ?? {};
    let json: unknown; let parsed = false;
    try { json = JSON.parse(response.body); parsed = true; } catch { /* not JSON */ }
    const show = (value: unknown) => value === undefined ? "missing" : sanitizer.text(JSON.stringify(sanitizer.json(value)));
    if (expect.status !== undefined && response.status !== expect.status)
      findings.push({ code: "status_mismatch", message: `expected status ${expect.status}, actual ${response.status}`, expected: `status ${expect.status}`, actual: `status ${response.status}` });
    for (const assertion of expect.json ?? []) {
      const found = parsed ? pointer(json, assertion.pointer) : { found: false };
      if (assertion.exists !== undefined) {
        if (found.found !== assertion.exists) findings.push({ code: "json_mismatch", message: `expected ${assertion.pointer} ${assertion.exists ? "to exist" : "to be absent"}`,
          expected: `${assertion.pointer} ${assertion.exists ? "exists" : "absent"}`, actual: found.found ? `${assertion.pointer} = ${show(found.value)}` : `${assertion.pointer} missing` });
        continue;
      }
      const expected = substitute(assertion.equals as JsonValue, vars);
      if (!found.found || qaDigest(found.value) !== qaDigest(expected))
        findings.push({ code: "json_mismatch", message: `expected ${assertion.pointer} equals ${show(expected)}, actual ${show(found.value)}`,
          expected: `${assertion.pointer} equals ${show(expected)}`, actual: `${assertion.pointer} = ${show(found.value)}` });
    }
    for (const text of expect.bodyContains ?? []) {
      const wanted = substitute(text, vars);
      if (!response.body.includes(wanted)) findings.push({ code: "body_missing", message: `expected body to contain ${sanitizer.text(wanted)}`, expected: `body contains ${sanitizer.text(wanted)}`, actual: "absent" });
    }
    for (const [name, path] of Object.entries(step.capture ?? {})) {
      const found = parsed ? pointer(json, path) : { found: false };
      if (found.found && (typeof found.value === "string" || typeof found.value === "number")) vars[name] = String(found.value);
      else findings.push({ code: "capture_missing", message: `capture ${name} at ${path} is missing`, expected: `${path} present`, actual: "missing" });
    }
    return findings;
  }

  private async performBrowserStep(run: RunRecord, exec: ExecutionState, testCase: QaCase, base: Pick<QaStepRecord, "phase" | "index" | "action" | "at">,
    step: Extract<QaStep, { kind: "browser" }>, vars: Record<string, string>): Promise<QaStepRecord> {
    const sanitizer = this.sanitizer(run);
    let request = `browser ${step.op}${step.url ? ` ${sanitizer.text(step.url)}` : ""}${step.selector ? ` ${step.selector}` : ""}`;
    const deny = (code: string, message: string): QaStepRecord => {
      run.denials.push({ executionId: `${run.runId}.execution`, taskId: `execution:${testCase.id}`, reason: message, at: this.ports.now() });
      return { ...base, request, outcome: "denied", findings: [{ code, message }] };
    };
    let resolved: QaBrowserStep;
    try {
      // Placeholders are substituted in every field; the URL is then pinned to an approved origin.
      resolved = { ...step, ...(step.url ? { url: resolveTargetUrl(step.url, run.intake, vars).toString() } : {}),
        ...(step.selector !== undefined ? { selector: substitute(step.selector, vars) } : {}), ...(step.text !== undefined ? { text: substitute(step.text, vars) } : {}),
        ...(step.value !== undefined ? { value: substitute(step.value, vars) } : {}) };
    } catch (error) {
      if (error instanceof QaUnresolvedVariable)
        return { ...base, request, outcome: "unresolved_variable", findings: [{ code: "unresolved_variable", message: `\${${error.variable}} was never captured`,
          expected: `captured \${${error.variable}}`, actual: "not captured" }] };
      if (error instanceof QaScopeDenied) return deny(error.code, error.message);
      throw error;
    }
    if (resolved.url) request = `browser ${step.op} ${sanitizer.text(resolved.url)}${resolved.selector ? ` ${resolved.selector}` : ""}`;
    let lease: AppCheckLease;
    try { lease = await this.fence(exec); }
    catch (error) {
      if (error instanceof LeaseInterrupted) return { ...base, request, outcome: "lease", findings: [{ code: error.code, message: `Environment lease ${error.code}; no further actions` }] };
      throw error;
    }
    let mutation: QaMutationRecord | undefined;
    if (base.action === "browser_interact") {
      // Same rule as HTTP mutations: the intent is durable before the interaction and is never replayed.
      mutation = { mutationId: `${run.runId}.${testCase.id}.${base.phase}.${base.index}.0`, caseId: testCase.id, phase: base.phase === "cleanup" ? "cleanup" : "test",
        stepIndex: base.index, request, requestDigest: sha256(JSON.stringify(resolved)), leaseId: lease.leaseId, fencingToken: lease.fencingToken,
        state: "intent", at: this.ports.now() };
      exec.mutations.push(mutation);
      await this.save();
    }
    const result = await this.ports.tools.browser!.perform(resolved, step.timeoutMs ?? 15_000);
    if (mutation) {
      mutation.state = result.kind === "done" ? "applied" : result.kind === "unavailable" ? "not_delivered" : "uncertain";
      mutation.settledAt = this.ports.now();
      await this.save();
    }
    if (result.kind === "timeout") return { ...base, request, outcome: mutation ? "uncertain" : "timeout", findings: [{ code: "timeout", message: mutation
      ? "No result after the browser interaction was sent; the outcome is uncertain and it will not be replayed" : "Browser action timed out" }] };
    if (result.kind === "unavailable") return { ...base, request, outcome: "unavailable", findings: [{ code: "app_unavailable", message: result.message }] };
    const landed = new URL(result.url).origin;
    if (!run.intake.target.origins.includes(landed))
      return deny("origin_redirect_denied", `Browser left the approved origins for ${landed}: approval does not extend to other origins`);
    return { ...base, request, outcome: result.passed ? "ok" : "assertion_failed",
      findings: result.passed ? [] : [{ code: "browser_assertion", message: sanitizer.text(Object.entries(result.observations).map(([key, value]) => `${key}: ${value}`).join("; ") || "assertion failed") }] };
  }


  // ---- Report ----

  private async publishReport(run: RunRecord) {
    const exec = run.execution!;
    const classifications = run.classifications;
    if (!classifications) throw new QaScopeDenied("adjudication_missing", "The report requires a passed adjudication");
    const design = this.approvedDesign(run);
    const adjudication = run.adjudications.at(-1)!;
    const values = Object.values(classifications);
    const verdict = values.includes("product_failure") ? "product_failures_found" : values.every(item => item === "passed") ? "passed"
      : values.includes("environment_failure") ? "environment_failure" : values.includes("blocked") ? "blocked"
        : values.includes("test_defect") ? "test_defects_found" : "inconclusive";
    const environment = { environmentId: run.intake.target.environmentId, origin: run.intake.target.origins[0]!, build: exec.build! };
    const bugs: QaBug[] = design.cases.filter(item => classifications[item.id] === "product_failure").map((testCase, index) => {
      const outcome = exec.cases[testCase.id]!;
      const failed = outcome.findings;
      return { bugId: `QA-BUG-${index + 1}`, caseId: testCase.id, criterionId: testCase.criterionIds[0]!, criterionIds: [...testCase.criterionIds],
        title: `${testCase.title}: ${run.intake.criteria.find(item => item.id === testCase.criterionIds[0])?.description ?? ""}`,
        expected: [testCase.expected, ...failed.flatMap(item => item.expected ? [item.expected] : [])].join("; "),
        actual: failed.map(item => item.actual ?? item.message).join("; "),
        reproduction: [...(testCase.account ? [`Dùng tài khoản fixture cô lập \`${testCase.account}\``] : []),
          ...outcome.steps.filter(item => item.phase === "test").map(item => `${item.request}${item.requestBody ? ` body ${item.requestBody}` : ""}`)],
        environment, evidenceArtifactIds: [outcome.evidenceArtifactId!, exec.artifact!.artifactId],
        rationale: adjudication.verdicts.find(item => item.caseId === testCase.id)!.rationale, fixAuthority: "none" as const };
    });
    const report: QaReport = {
      schemaVersion: 1, runId: run.runId, requestId: run.intake.requestId, revision: run.intake.revision, title: run.intake.title, verdict,
      scope: { environmentId: run.intake.target.environmentId, kind: run.intake.target.kind, origins: run.intake.target.origins,
        allowedActions: run.intake.allowedActions, protectedPaths: run.intake.protectedPaths, assetRoot: run.intake.workspace.assetRoot,
        access: run.access ?? null },
      environment, readiness: exec.readiness!, productUnchanged: exec.productUnchanged ?? false,
      design: { digest: run.approval!.designDigest, approvalId: run.approval!.approvalId, approvedBy: run.approval!.decision!.decidedBy,
        reviewer: run.review!.agentId, author: run.designs.at(-1)!.authorAgentId },
      adjudication: { agentId: adjudication.agentId, artifactId: adjudication.artifact.artifactId },
      cases: design.cases.map(item => ({ caseId: item.id, title: item.title, criterionIds: [...item.criterionIds], classification: classifications[item.id]!,
        code: exec.cases[item.id]!.code ?? null, cleanup: exec.cases[item.id]!.cleanup.status,
        rationale: adjudication.verdicts.find(verdict => verdict.caseId === item.id)!.rationale })),
      bugs,
      testDefects: design.cases.filter(item => classifications[item.id] === "test_defect").map(item => ({ caseId: item.id,
        rationale: adjudication.verdicts.find(verdict => verdict.caseId === item.id)!.rationale })),
      residualData: design.cases.filter(item => ["failed", "skipped"].includes(exec.cases[item.id]!.cleanup.status)).map(item => ({ caseId: item.id,
        detail: exec.cases[item.id]!.cleanup.detail ?? exec.cases[item.id]!.cleanup.status,
        mutations: exec.mutations.filter(mutation => mutation.caseId === item.id && mutation.phase === "test").map(mutation => mutation.request) })),
      uncertainMutations: exec.mutations.filter(item => item.state === "uncertain").map(item => ({ mutationId: item.mutationId, caseId: item.caseId,
        request: item.request, reconciliation: item.reconciliation ?? "unknown", recoveredAfterRestart: item.recoveredAfterRestart ?? false })),
      leases: exec.leases.map(item => ({ resourceKey: item.resourceKey, fencingToken: item.fencingToken, released: item.released })),
      limitations: [...(exec.build!.status === "unknown" ? [exec.build!.limitation] : []),
        ...(exec.leaseInterruption ? [`Environment lease ${exec.leaseInterruption} during execution; later actions were not run`] : [])],
      executionArtifactId: exec.artifact!.artifactId,
      tdd: { mode: run.strategy.tddDecision.mode, alternativeVerification: alternativeMethods(run.strategy) },
      productChange: "not_authorized"
    };
    const path = this.paths(run.intake).report;
    const markdown = renderQaReport(report);
    await this.writeWorkspaceFile(run, path, markdown);
    const artifact = await this.putJson(run, "report", `qa-${run.runId}-report`, "report", report, true);
    await this.recordTddEvidence(run, report, artifact);
    run.report = { ...report, artifact, files: [{ path, sha256: sha256(markdown) }] };
  }

  /** Alternative verification for the not_applicable TDD decision: independent design review plus independent adjudication. */
  private async recordTddEvidence(run: RunRecord, report: QaReport, reportArtifact: ArtifactReference) {
    const at = run.execution!.completedAt!;
    const latestCheck = run.designChecks.filter(item => item.designDigest === report.design.digest).at(-1)!;
    // One bundle owned by the QA task naming the checks, the independent review, the adjudication and the report.
    const artifact = await this.putJson(run, "qa", `qa-${run.runId}-tdd-evidence`, "report", { designDigest: report.design.digest,
      designCheck: { artifactId: latestCheck.artifact.artifactId, checks: latestCheck.result.checks },
      review: { artifactId: run.review!.artifact.artifactId, agentId: run.review!.agentId, verdict: run.review!.verdict },
      adjudication: report.adjudication, execution: report.executionArtifactId, report: reportArtifact.artifactId }, true);
    const evidence = VerificationResultSchema.parse({ schemaVersion: 2, verificationId: `qa-verification-${run.runId}`, runId: run.runId, taskId: "qa",
      cycleNumber: 1, attemptId: run.adjudications.at(-1)!.attemptId, status: "passed", independentExecution: true,
      evaluatedCriteria: run.intake.criteria.map(item => ({ criterionId: item.id, passed: true, evidenceArtifactId: artifact.artifactId,
        summary: `QA work verified (reviewed design, executed, adjudicated); product outcome: ${report.cases.filter(entry => entry.criterionIds.includes(item.id)).map(entry => `${entry.caseId}=${entry.classification}`).join(", ") || "not tested"}` })),
      qualityGateResults: [], evidenceArtifacts: [artifact], findings: [], verifiedBy: "reviewer", startedAt: run.execution!.startedAt, completedAt: at,
      metadata: { conditionalTdd: { phase: "verification", decisionId: run.strategy.tddDecision.decisionId, specId: run.strategy.specId,
        sourceRevision: report.environment.build.status === "identified" ? `build:${report.environment.build.value}` : "build:unknown",
        testRevision: report.design.digest, testNames: report.cases.map(item => item.caseId),
        observations: run.intake.criteria.map(item => ({ method: "manual_review", criterionId: item.id, evidenceArtifactId: artifact.artifactId,
          summary: "Independent design review and independent result adjudication" })) } } });
    run.strategy = recordEvidence(run.strategy, evidence);
    assertEvidenceComplete(run.strategy);
  }

  /** The only repository writes: test assets and the report inside `<assetRoot>/<requestId>/r<revision>/`, never overwritten. */
  private async writeWorkspaceFile(run: RunRecord, path: string, content: string) {
    const allowed = Object.values(this.paths(run.intake));
    if (!allowed.includes(path)) throw new QaScopeDenied("write_out_of_scope", `Write outside the QA workspace was denied: ${path}`);
    const absolute = resolve(this.ports.repositoryRoot, path);
    if (!within(this.ports.repositoryRoot, absolute)) throw new QaScopeDenied("write_out_of_scope", `Write escapes the repository: ${path}`);
    for (const protectedPath of run.intake.protectedPaths)
      if (within(resolve(this.ports.repositoryRoot, protectedPath), absolute)) throw new QaScopeDenied("write_out_of_scope", `Write into protected product path denied: ${path}`);
    await this.assertNoSymlink(dirname(absolute));
    await mkdir(dirname(absolute), { recursive: true });
    await this.assertNoSymlink(dirname(absolute));
    try {
      const handle = await open(absolute, "wx", 0o644);
      try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (sha256(await readFile(absolute)) !== sha256(content)) throw new QaScopeDenied("write_out_of_scope", `Refusing to overwrite existing workspace file: ${path}`);
    }
  }
  private async assertNoSymlink(absolute: string) {
    let current = absolute;
    while (within(this.ports.repositoryRoot, current) && current !== this.ports.repositoryRoot) {
      const stats = await lstat(current).catch(() => undefined);
      if (stats?.isSymbolicLink()) throw new QaScopeDenied("write_out_of_scope", `Symlinked path refused: ${relative(this.ports.repositoryRoot, current).split(sep).join("/")}`);
      current = dirname(current);
    }
  }

  /** Content digest of the protected product paths, taken before and after execution. */
  private async protectedDigest(run: RunRecord): Promise<string> {
    const entries: [string, string][] = [];
    const walk = async (absolute: string) => {
      if (entries.length > 50_000) throw new Error("Protected product paths are too large to fingerprint");
      const rel = relative(this.ports.repositoryRoot, absolute).split(sep).join("/");
      const stats = await lstat(absolute).catch(() => undefined);
      if (!stats) entries.push([rel, "missing"]);
      else if (stats.isSymbolicLink()) entries.push([rel, `link:${await readlink(absolute)}`]);
      else if (stats.isDirectory()) for (const name of (await readdir(absolute)).sort()) await walk(resolve(absolute, name));
      else if (stats.isFile()) entries.push([rel, sha256(await readFile(absolute))]);
      else entries.push([rel, "special"]);
    };
    for (const path of run.intake.protectedPaths) await walk(resolve(this.ports.repositoryRoot, path));
    return qaDigest(entries);
  }

  private async putJson(run: RunRecord, taskId: string, artifactId: string, kind: "document" | "report" | "test-result", value: unknown, contentAddressed = false): Promise<ArtifactReference> {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    const id = contentAddressed ? `${artifactId}-${sha256(bytes).slice(0, 12)}` : artifactId;
    return ArtifactReferenceSchema.parse(unwrap(await this.ports.artifactStore.put({ options: ArtifactWriteOptionsSchema.parse({ artifactId: id, runId: run.runId,
      taskId, kind, mediaType: "application/json", expectedIntegrity: { checksum: { algorithm: "sha256", value: sha256(bytes) }, sizeBytes: bytes.length },
      idempotencyKey: id }), content: (async function* () { yield bytes; })() })));
  }

  private finish(run: RunRecord, snapshot: WorkflowRunSnapshot) {
    run.status = snapshot.status === "succeeded" && run.report ? "reported" : "failed";
    return this.save().then(() => this.status(run.runId));
  }

  // ---- Core composition: events are appended to RunStore and recovered by authoritative replay. ----
  private async createCore(run: RunRecord) {
    const at = run.createdAt;
    const created = WorkflowAdvanceResultSchema.parse(unwrap(await this.ports.engine.createRun({ runId: run.runId, definition: run.definition,
      createdAt: at, idempotencyKey: `qa:create:${run.runId}` })));
    if (!unwrap(await this.ports.runStore.get(run.runId)))
      unwrap(await this.ports.runStore.create(StoredRunSchema.parse({ definition: run.definition, snapshot: { runId: run.runId, workflowId: run.definition.id,
        workflowVersion: run.definition.version, status: "queued", tasks: run.definition.tasks.map(item => ({ taskId: item.id, status: "pending", attempt: 0,
          generation: 0, version: 0 })), createdAt: at, updatedAt: at, version: 0, lastEventSequence: 0 } }), `qa:store:${run.runId}`));
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
      unwrap(await this.ports.engine.createRun({ runId: run.runId, definition: run.definition, createdAt: run.createdAt, idempotencyKey: `qa:create:${run.runId}` }));
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
    if (!value) throw new Error("Core QA run missing");
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
      events: result.emittedEvents, idempotencyKey: `qa-events:${result.snapshot.runId}:${result.emittedEvents[0]!.eventId}` })));
  }

  private run(runId: string): RunRecord {
    const run = this.journal.runs.find(item => item.runId === runId);
    if (!run) throw new Error(`Unknown QA run ${runId}`);
    return run;
  }
  private live(runId: string): RunRecord {
    const run = this.run(runId);
    if (run.status === "reported" || run.status === "failed") throw new Error(`QA run ${runId} is ${run.status}`);
    return run;
  }
  private async save() {
    await mkdir(dirname(this.ports.journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.ports.journalPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.journal, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.ports.journalPath);
  }
}
