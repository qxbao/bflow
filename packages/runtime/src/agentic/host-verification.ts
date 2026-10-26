import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ArtifactReferenceSchema, ArtifactWriteOptionsSchema, QualityFindingSchema, QualityGateContextSchema, QualityGateDefinitionSchema,
  PaneBindingSchema, QualityGateResultSchema, SpecificationSchema, TestStrategySchema, VerificationResultSchema,
  WorkflowDefinitionSchema,
  type ArtifactStore, type JsonValue, type PaneBinding, type QualityGate, type QualityGateResult, type Specification, type TestStrategy, type VerificationResult
} from "@bflow/contracts";
import { digest, json, record, strings, textField } from "./journal.js";
import { ReworkFindingVerdictSchema, ReworkResolutionDossierSchema, reworkVerificationBinding, parseRequiredFindingVerdicts, hasReworkAssignment, type ReworkResolutionDossier } from "./rework-causality.js";
import { unwrap } from "./outbox.js";
import { behavioralChecks, bindRegressionProfile, verificationGit, measureBehavior, measureRegression, parseBehavioralCommands, testFilePattern,
  type BehavioralCommand, type BoundBehavioralCommand, type RegressionFailure, type RegressionMeasurement, type RtkOutputIntegration, type RunnerProfile } from "./behavioral-runner.js";
import { RtkRequiredToolUnavailable } from "./behavioral-runner.js";
import { AUTOMATIC_STATIC_COMMANDS, TestRunnerSource, automaticChecks, isAutomaticStaticCommand, regressionChecks, resolveTaskCommands, type AutomaticRunner } from "./task-commands.js";
import { unconfiguredImpactIndex, type ImpactIndex } from "./impact-index.js";
import { selectRegressionTests } from "./regression-selection.js";
import { pinRunnerDefinitions } from "./runner-provenance.js";
import type { RegressionScope } from "./host-controller.js";
import { WorkflowProposalRejected, type WorkflowRejectionCode } from "./workflow-rejection.js";
import { NodeTapTestCodeFailure } from "./node-tap.js";
import type { AgenticWorkflowRuntime } from "./runtime.js";
import { exceedsAgyInlineReply } from "./agy-assignment-admission.js";
const execFileAsync = promisify(execFile);
function originalReviewContext(context: unknown) {
  const parsed = QualityGateContextSchema.parse(context);
  const { hostQaBehavioralObservation: _measurement, hostReworkVerification: _rework, ...input } = record(parsed.input);
  return { ...parsed, input };
}
function staticGateId(command: string): string {
  return `host-static-${command.replace(/[^a-z0-9_-]/gi, "-")}`;
}
function staticAnalysisCheckDefinition(command: string) {
  return QualityGateDefinitionSchema.parse({
    id: staticGateId(command),
    name: `Host syntax check of changed JavaScript/JSON files (${command})`,
    evaluator: "host-static-analysis",
    required: true,
    timeout: { executionTimeoutMs: 30_000, onTimeout: "block" },
    configuration: { kind: "deterministic", method: "static_analysis", command, criterionIds: [], testNames: [], role: "quality_gate", levels: [] }
  });
}
export function boundQaReviewCommands(commands: readonly BoundBehavioralCommand[], budgetMs: number): BoundBehavioralCommand[] {
  const available = budgetMs - commands.length * 90_000;
  if (commands.length && available < commands.length * 2) throw new Error("QA workflow aggregate measurement budget exceeds the remaining gate deadline; split checks before retry");
  const each = Math.floor(available / Math.max(1, commands.length));
  return commands.map(command => {
    const adapter = command.adapter;
    const preparation = adapter?.bind(command, "/tmp/bflow-qa-budget").prepare ?? adapter?.prepare ?? command.prepare;
    const prepareMs = preparation ? Math.min(preparation.timeoutMs, Math.floor(each / 2)) : 0;
    return { ...command, timeoutMs: Math.min(command.timeoutMs, each - prepareMs),
      ...(command.prepare ? { prepare: { ...command.prepare, timeoutMs: prepareMs } } : {}),
      ...(adapter ? { adapter: { ...adapter,
        ...(adapter.prepare ? { prepare: { ...adapter.prepare, timeoutMs: prepareMs } } : {}),
        bind: (profile, root) => { const invocation = adapter.bind(profile, root); return { ...invocation,
          ...(invocation.prepare ? { prepare: { ...invocation.prepare, timeoutMs: prepareMs } } : {}) }; }
      } } : {}) };
  });
}
const whitespaceCommand = "git diff --check";
/** Default checks support documentation only. Behavioral checks require owner configuration. */
export const DEFAULT_HOST_CHECKS = [
  ...["reviewer", "qa"].map(role => QualityGateDefinitionSchema.parse({ id: `host-${role}`, name: `Independent ${role}`, evaluator: "native-herdr-review", required: true,
    timeout: { executionTimeoutMs: 300_000, onTimeout: "block" }, metadata: { bindAcceptedCriteria: true },
    configuration: { kind: "review", method: "manual_review", criterionIds: [], testNames: [], role, levels: [] } })),
  QualityGateDefinitionSchema.parse({ id: "host-git-integrity", name: "Integrated Git diff integrity", evaluator: "host-git-diff", required: true,
    timeout: { executionTimeoutMs: 30_000, onTimeout: "block" },
    configuration: { kind: "deterministic", method: "integration_test", command: whitespaceCommand, criterionIds: [], testNames: [], role: "quality_gate", levels: ["integration"] } })
];
export interface HostVerificationReceipts {
  recordGate(result: QualityGateResult): Promise<unknown>;
  recordEvidence(result: VerificationResult): Promise<unknown>;
  getEvidence(verificationId: string): Promise<VerificationResult | undefined>;
  getGate(evaluationId: string): Promise<QualityGateResult | undefined>;
  authenticateGate(result: QualityGateResult): Promise<boolean>;
  authenticateEvidence(result: VerificationResult): Promise<boolean>;
  putObservation(kind: "review" | "alternative", id: string, value: { binding: PaneBinding; observation: JsonValue; context?: unknown; runId?: string; taskId?: string; sourceMessageId?: string }): Promise<unknown>;
  getObservation(kind: "review" | "alternative", id: string): Promise<{ binding: PaneBinding; observation: JsonValue; context?: unknown; runId?: string; taskId?: string; sourceMessageId?: string } | undefined>;
}
/** A completed, valid measurement that requires a bounded Developer repair. */
export class HostBehavioralFailure extends Error {
  constructor(message: string, readonly evidence: import("@bflow/contracts").ArtifactReference,
    readonly rtkOutputs: readonly JsonValue[] = []) { super(message); }
}
export class HostVerification {
  private readonly gateReceipts = new Map<string, string>();
  private readonly gateRecords = new Map<string, QualityGateResult>();
  private readonly evidenceReceipts = new Map<string, string>();
  private readonly evidenceRecords = new Map<string, VerificationResult>();
  readonly runners: TestRunnerSource;
  constructor(private readonly runtime: () => AgenticWorkflowRuntime, private readonly store: () => ArtifactStore,
    private readonly receipts?: HostVerificationReceipts, runners: TestRunnerSource | readonly BehavioralCommand[] = [],
    private readonly rtk?: RtkOutputIntegration,
    private readonly regression: { scope: RegressionScope; index: ImpactIndex } = { scope: "mapped_only", index: unconfiguredImpactIndex }) {
    this.runners = runners instanceof TestRunnerSource ? runners : new TestRunnerSource(parseBehavioralCommands(runners));
  }
  /** Ownership of a task from its run definition; undefined for workflow-level checks. */
  private ownedPathsOf(run: Record<string, unknown>, taskId?: string): string[] | undefined {
    if (taskId === undefined || run.definition === null || typeof run.definition !== "object") return undefined;
    const definitionTasks = (run.definition as Record<string, unknown>).tasks;
    const tasks = Array.isArray(definitionTasks) ? definitionTasks.filter(item => item !== null && typeof item === "object").map(record) : [];
    const task = tasks.find(item => item.id === taskId);
    return task ? strings(record(task.metadata).ownedPaths) : undefined;
  }
  /** Fresh dossier and ownership for a run's task (or the workflow when taskId is absent), read outside the journal lock. */
  private async dossierFor(runId: string, taskId?: string) {
    if (taskId === "workflow-verification") taskId = undefined;
    const run = record(await this.runtime().inspect(runId));
    const tasks = Array.isArray(run.tasks) ? run.tasks.map(record) : [];
    const task = taskId === undefined ? undefined : tasks.find(item => item.taskId === taskId);
    if (taskId !== undefined && !task) throw new Error("Unknown task");
    const dossier = record(task ? task.spec : run.workflowSpec);
    return { run, specification: SpecificationSchema.parse(dossier.specification), strategy: TestStrategySchema.parse(dossier.strategy), ownedPaths: this.ownedPathsOf(run, taskId), originalRevision: task && Array.isArray(task.worktrees) ? textField(record(task.worktrees.at(-1)).baseCommitHash) : textField(run.baseRevision) };
  }
  private resolve(input: { specification: Specification; strategy: TestStrategy; ownedPaths?: readonly string[] | undefined; originalRevision?: string }): BoundBehavioralCommand[] {
    return resolveTaskCommands({ owner: this.runners.owner, profiles: this.runners.profilesForRevision(input.originalRevision), ...input }).map(command => input.originalRevision && command.checkoutDependencyRoots !== undefined ? { ...command, originalRevision: input.originalRevision } : command);
  }
  async authenticateGate(result: QualityGateResult): Promise<boolean> { return this.receipts ? this.receipts.authenticateGate(result) : this.gateReceipts.get(result.evaluationId) === digest(result); }
  async authenticateEvidence(result: VerificationResult): Promise<boolean> { return this.receipts ? this.receipts.authenticateEvidence(result) : this.evidenceReceipts.get(result.verificationId) === digest(result); }
  private async trustGate(result: QualityGateResult) { await this.receipts?.recordGate(result); this.gateReceipts.set(result.evaluationId, digest(result)); this.gateRecords.set(result.evaluationId, result); }
  private async trustEvidence(result: VerificationResult) { await this.receipts?.recordEvidence(result); this.evidenceReceipts.set(result.verificationId, digest(result)); this.evidenceRecords.set(result.verificationId, result); }
  private bindingIdentity(binding: PaneBinding) { const { transportState: _transportState, lastHeartbeatAt: _lastHeartbeatAt, ...identity } = binding; return identity; }
  private async git(cwd: string, args: string[]): Promise<string> {
    return verificationGit(cwd, args);
  }
  private async capture(cwd: string, base: string, revision: string) {
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Verification needs pinned Git revisions");
    if ((await this.git(cwd, ["rev-parse", "HEAD"])).trim() !== revision || await this.git(cwd, ["status", "--porcelain=v1", "-z"])) throw new Error("Verification worktree is dirty or revision changed");
    const diff = await this.git(cwd, ["diff", "--no-ext-diff", "--no-textconv", base, revision, "--"]);
    let exitCode = 0, output = "";
    try { output = await this.git(cwd, ["diff", "--check", base, revision, "--"]); }
    catch (error) { const failure = error as { code?: unknown; stdout?: string; stderr?: string }; if (typeof failure.code !== "number") throw error;
      exitCode = failure.code; output = (failure.stdout ?? "") + (failure.stderr ?? ""); }
    if ((await this.git(cwd, ["rev-parse", "HEAD"])).trim() !== revision || await this.git(cwd, ["status", "--porcelain=v1", "-z"])) throw new Error("Verification revision changed during capture");
    return { cwd, base, revision, command: whitespaceCommand, exitCode, output, diff };
  }
  /**
   * `auto:static` is only a syntax check: `git diff --check`, `node --check` for changed JavaScript and JSON parsing.
   * A changed file it cannot analyze fails the check instead of passing unexamined; such repositories need an owner-configured analyzer.
   */
  private async captureStaticAnalysis(cwd: string, base: string, revision: string, command: string) {
    const baseCapture = await this.capture(cwd, base, revision);
    if (baseCapture.exitCode !== 0) return { ...baseCapture, command };
    const changed = (await this.git(cwd, ["diff", "--name-only", "--diff-filter=ACMR", base, revision, "--"]))
      .split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0 && !/\.(md|txt|rst)$/i.test(line));
    const unsupported = changed.filter(file => !/\.([cm]?js|json)$/i.test(file));
    if (unsupported.length) return { ...baseCapture, command, exitCode: 1,
      output: `${command} cannot analyze ${unsupported.join(", ")}; configure an owner static_analysis runner for these files` };
    const checked: string[] = [];
    for (const file of changed) {
      try {
        if (/\.json$/i.test(file)) JSON.parse(await readFile(join(cwd, file), "utf8"));
        else await execFileAsync(process.execPath, ["--check", file], { cwd, timeout: 15_000 });
        checked.push(file);
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        const exitCode = typeof failure.code === "number" ? failure.code : 1;
        const output = ((failure.stdout ?? "") + (failure.stderr ?? "")).trim() || `Syntax check failed for ${file}: ${String(error)}`;
        return { ...baseCapture, command, exitCode, output };
      }
    }
    return { ...baseCapture, command, output: checked.length ? `Syntax check passed for ${checked.join(", ")}` : "No changed code files to check" };
  }
  private parseCapture(input: unknown) {
    const value = record(input);
    if (typeof value.output !== "string" || typeof value.diff !== "string" || !Number.isInteger(value.exitCode) || value.command !== whitespaceCommand) throw new Error("Invalid stored host observation");
    return { cwd: textField(value.cwd), base: textField(value.base), revision: textField(value.revision), command: whitespaceCommand,
      exitCode: Number(value.exitCode), output: value.output, diff: value.diff };
  }
  private async artifact(runId: string, taskId: string, body: unknown) {
    const bytes = Buffer.from(JSON.stringify(body)); const id = `host-observation-${randomUUID()}`;
    return ArtifactReferenceSchema.parse(unwrap(await this.store().put({ options: ArtifactWriteOptionsSchema.parse({ artifactId: id, runId, taskId, kind: "test-result", mediaType: "application/json",
      expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length }, idempotencyKey: id }),
      content: (async function* () { yield bytes; })() })));
  }
  deterministicGate(): QualityGate {
    return { id: "host-git-integrity", evaluate: async raw => {
      try {
        const context = QualityGateContextSchema.parse(raw), input = record(context.input), config = record(context.definition.configuration);
        const observed = await this.capture(textField(input.sourceWorktreePath), textField(input.baseRevision), textField(input.sourceRevision));
        const result = QualityGateResultSchema.parse({ gateId: context.definition.id, runId: context.runId, taskId: context.taskId,
          evaluationId: randomUUID(), status: observed.exitCode === 0 ? "passed" : "failed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString(),
          metadata: { verification: { schemaVersion: 2, checkId: context.definition.id, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
            sourceRevision: observed.revision, specFingerprint: input.specFingerprint, scope: input.scope, independentExecution: true, isolated: true,
            executorId: "bflow-host-git-check", role: "quality_gate", method: config.method, command: whitespaceCommand, exitCode: observed.exitCode,
            testNames: [], criteria: [], summary: observed.output || "Exact committed diff passed git diff --check" },
            hostExecution: json(observed) } });
        return { ok: true, value: result };
      } catch (error) { return { ok: false, error: { code: "validation", retryable: false, message: String(error) } }; }
    } };
  }
  private policyDeterministicGate(id: string, expectedCommand: string): QualityGate {
    return { id, evaluate: async raw => {
      try {
        const context = QualityGateContextSchema.parse(raw), input = record(context.input), config = record(context.definition.configuration);
        if (context.definition.id !== id || config.command !== expectedCommand) throw new Error("Policy deterministic check does not match host configuration");
        const observed = await this.captureStaticAnalysis(textField(input.sourceWorktreePath), textField(input.baseRevision), textField(input.sourceRevision), expectedCommand);
        const result = QualityGateResultSchema.parse({ gateId: context.definition.id, runId: context.runId, taskId: context.taskId,
          evaluationId: randomUUID(), status: observed.exitCode === 0 ? "passed" : "failed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString(),
          metadata: { verification: { schemaVersion: 2, checkId: context.definition.id, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
            sourceRevision: observed.revision, specFingerprint: input.specFingerprint, scope: input.scope, independentExecution: true, isolated: true,
            executorId: "bflow-host-git-check", role: "quality_gate", method: config.method, command: expectedCommand, exitCode: observed.exitCode,
            testNames: [], criteria: [], summary: observed.output },
            hostExecution: json(observed) } });
        await this.trustGate(result);
        return { ok: true, value: result };
      } catch (error) { return { ok: false, error: { code: "validation", retryable: false, message: String(error) } }; }
    } };
  }
  /** Owner-configured checks always; automatic checks only when no owner file exists (static definitions, bound at plan time). */
  behavioralChecks(specification?: Specification, strategy?: TestStrategy, originalRevision?: string) {
    const owner = behavioralChecks(this.runners.owner);
    if (!this.runners.automatic) return owner;
    const profiles = this.runners.profilesForRevision(originalRevision);
    const regression = this.regression.scope !== "mapped_only"
      ? regressionChecks(specification && strategy ? profiles : this.runners.availableProfiles)
      : [];
    if (!specification || !strategy) return [...owner, ...automaticChecks(this.runners.availableProfiles), ...regression];
    const commands = resolveTaskCommands({ owner: [], profiles, specification, strategy });
    const boundChecks = automaticChecks(commands).map(check => {
      const command = commands.find(item => `host-behavioral-${item.id}` === check.id)!;
      return { ...check, metadata: { ...check.metadata, boundRunnerIdentities: true },
        configuration: json({ ...record(check.configuration), testNames: command.testNames }) };
    });
    const policyChecks = strategy.targetCommands.filter(isAutomaticStaticCommand).map(staticAnalysisCheckDefinition);
    return [...owner, ...boundChecks, ...policyChecks, ...regression];
  }
  /** Methods with a runner: owner-configured, or Runtime-detected. Fixed per owner configuration; detection may refresh. */
  configuredMethods(): string[] { return [...new Set([...this.runners.owner.map(command => command.method), ...this.runners.profiles.map(profile => profile.method)])]; }
  /**
   * Fail closed at proposal ingress. Owner mode keeps the explicit owner checks. Automatic mode fails with structured
   * rejections: `no_test_runner_detected` is reported to the user; the other codes are Coordinator-fixable and silent.
   */
  assertSupported(input: unknown, strategyInput?: unknown, definitionInput?: unknown) {
    const spec = SpecificationSchema.parse(input);
    if (definitionInput !== undefined) WorkflowDefinitionSchema.parse(definitionInput);
    const active = spec.acceptanceCriteria.filter(criterion => criterion.required !== false && criterion.status !== "waived");
    const automated = active.filter(criterion => criterion.verificationMethod !== "manual_review");
    if (!automated.length) {
      if (spec.affectedPaths.some(path => !/\.(md|txt|rst)$/i.test(path))) throw new Error("Behavioral development requires configured independent behavioral acceptance checks");
      return;
    }
    if (active.some(criterion => criterion.verificationMethod === "manual_review")) throw new Error("Mixed manual and behavioral TDD criteria require separate tasks with complete independent evidence");
    if (this.runners.automatic) {
      this.assertDetectedSupported(spec, automated, strategyInput);
      return;
    }
    if (strategyInput !== undefined) this.assertPolicyMethods(TestStrategySchema.parse(strategyInput), spec);
    for (const criterion of automated) if (!this.runners.owner.some(command => command.method === criterion.verificationMethod)) throw new Error(`No owner-configured behavioral runner for ${criterion.verificationMethod}`);
    if (strategyInput !== undefined) {
      const strategy = TestStrategySchema.parse(strategyInput);
      for (const criterion of automated) {
        const mapping = strategy.criterionMappings.find(mapping => mapping.criterionId === criterion.id);
        if (!mapping?.testNames.length || !this.runners.owner.some(command => strategy.targetCommands.includes(command.command) && command.method === criterion.verificationMethod && mapping.testNames.every(name => command.testNames.includes(name)))) throw new Error(`No complete owner-configured test mapping for ${criterion.id}`);
      }
      for (const command of strategy.targetCommands) if (!this.runners.owner.some(config => config.command === command)) throw new Error(`No owner-configured argv for ${command}`);
      if (strategy.coverageThresholdPercent !== undefined) throw new Error("Configured behavioral reporters do not measure aggregate coverage");
    }
  }
  assertTaskSupported(taskSpec: Specification, strategy: TestStrategy, ownedPaths: readonly string[]) {
    this.assertSupported(taskSpec, strategy);
    const automated = taskSpec.acceptanceCriteria.filter(c => c.required !== false && c.status !== "waived" && c.verificationMethod !== "manual_review");
    if (!automated.length) return;
    const profiles = this.runners.automatic ? (this.runners.current?.status === "detected" ? this.runners.current.profiles : []) : [];
    let commands: BoundBehavioralCommand[];
    try {
      commands = resolveTaskCommands({
        owner: this.runners.automatic ? [] : this.runners.owner,
        profiles,
        strategy,
        specification: taskSpec,
        ownedPaths: [...ownedPaths]
      });
    } catch (error) {
      if (error instanceof WorkflowProposalRejected) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("runner_identity_unselectable") || message.includes("missing_test_mapping")) {
        throw new WorkflowProposalRejected({
          code: "missing_test_mapping",
          reason: `Selected test identities cannot be bound to the detected runner: ${message}`,
          options: []
        });
      }
      throw new WorkflowProposalRejected({
        code: "unsupported_verification",
        reason: `Selected test identities cannot be bound exactly to the detected runner: ${message}`,
        options: []
      });
    }

    for (const criterion of automated) {
      const mapping = strategy.criterionMappings.find(m => m.criterionId === criterion.id);
      if (!mapping || !mapping.testNames.length) {
        throw new WorkflowProposalRejected({
          code: "missing_test_mapping",
          reason: `Criterion ${criterion.id} (${criterion.verificationMethod}) has no mapped test names in test strategy`,
          options: []
        });
      }
      const bound = commands.some(cmd => {
        if (cmd.method !== criterion.verificationMethod) return false;
        return mapping.testNames.every(name => cmd.testNames.includes(name));
      });
      if (!bound) {
        throw new WorkflowProposalRejected({
          code: "missing_test_mapping",
          reason: `Criterion ${criterion.id} (${criterion.verificationMethod}) test identities cannot be bound to any runner command within task owned paths; check test files and owned paths`,
          options: []
        });
      }
    }
    if (!commands.length) {
      throw new WorkflowProposalRejected({
        code: "missing_test_mapping",
        reason: `Task has automated criteria (${automated.map(c => c.id).join(", ")}) but no behavioral runner command could be bound to its owned test files`,
        options: []
      });
    }
  }
  private assertPolicyMethods(strategy: TestStrategy, specification: Specification) {
    const policy = strategy.metadata?.conditionalTdd;
    if (policy === undefined) return;
    const policyRecord = record(policy);
    const infraCommands = Array.isArray(record(record(policyRecord.assessment).infrastructure).commands)
      ? (record(record(policyRecord.assessment).infrastructure).commands as unknown[]).map(record)
      : [];
    const required = strings(policyRecord.requiredVerificationMethods);
    const configured = this.configuredMethods();
    const criterionMethods = new Set(specification.acceptanceCriteria
      .filter(criterion => criterion.required !== false && criterion.status !== "waived").map(criterion => criterion.verificationMethod));
    const hasRunnerFor = (method: string): boolean => {
      if (this.runners.automatic && method === "static_analysis") {
        return infraCommands.some(cmd => cmd.method === "static_analysis" && isAutomaticStaticCommand(textField(cmd.command)));
      }
      if (!configured.includes(method)) return false;
      // Detected runners only execute test identities mapped from accepted criteria; a method without such a criterion has no evidence.
      return !this.runners.automatic || infraCommands.some(cmd => cmd.method === method) && criterionMethods.has(method as never);
    };
    // Behavioral evidence never records a manual review observation, so a manual_review policy could only stall after implementation.
    const missing = required.filter(method => method === "manual_review" || !hasRunnerFor(method));
    if (missing.length) throw new WorkflowProposalRejected({ code: "unsupported_method",
      reason: `Test strategy policy requires independent ${missing.join(", ")} checks with configured runners before design approval. Preserve the assessed policy and accepted criteria; provision the missing checks before proposing executable work. In automatic mode, static_analysis uses {"method":"static_analysis","command":"auto:static"} in metadata.conditionalTdd.infrastructure.commands (a syntax check of changed JavaScript/JSON files only), and each behavioral method needs an accepted criterion with that verificationMethod mapped to committed tests.` +
        (missing.includes("manual_review") ? " Behavioral verification cannot record manual_review evidence: split the manually reviewed change into a separate documentation task, or escalate the policy to the user." : ""),
      methods: missing, options: [] });
  }
  private assertDetectedSupported(spec: Specification, automated: Specification["acceptanceCriteria"], strategyInput: unknown) {
    const detection = this.runners.current;
    if (detection?.status !== "detected") {
      const reason = detection?.status === "unsupported" ? detection.reason : "Test runner detection has not run yet";
      throw new WorkflowProposalRejected({ code: detection?.status === "unsupported" && detection.agentFixable ? "runner_setup_required" : "no_test_runner_detected", reason, options: [
        "Coordinator tự thiết lập runner phù hợp qua một task có review rồi đề xuất lại workflow", "Hủy run"] });
    }
    const reject = (code: WorkflowRejectionCode, reason: string): never => { throw new WorkflowProposalRejected({ code, reason, options: [] }); };
    const profiles = detection.profiles, labels = [...profiles.map(profile => profile.command), ...AUTOMATIC_STATIC_COMMANDS].join(", ");
    const testPaths = spec.affectedPaths.filter(path => testFilePattern.test(path));
    const ids = automated.map(criterion => criterion.id).join(", ");
    if (!testPaths.length) reject("missing_test_paths", `Automated acceptance criteria (${ids}) need their committed test files listed in specification.affectedPaths. Add the exact test file paths (for example packages/x/test/feature.test.ts) to affectedPaths and propose again.`);
    const strategy = strategyInput === undefined ? undefined : TestStrategySchema.parse(strategyInput);
    if (strategy) this.assertPolicyMethods(strategy, spec);
    for (const criterion of automated) {
      const candidates = profiles.filter(item => item.method === criterion.verificationMethod);
      const profile = candidates.find(item => strategy?.targetCommands.includes(item.command)) ?? candidates[0];
      if (!profile) reject("unsupported_method", `Criterion ${criterion.id} uses ${criterion.verificationMethod}, which has no detected runner (detected: ${labels || "none"}). Coordinator must add a reviewed runner setup task without changing verificationMethod.`);
      if (!strategy) continue;
      const mapping = strategy.criterionMappings.find(item => item.criterionId === criterion.id);
      if (!mapping?.testNames.length) reject("missing_test_mapping", `Criterion ${criterion.id} has no criterionMappings entry with test names. Set criterionMappings to [{"criterionId":"${criterion.id}","testNames":[...]}] using the exact names the runner reports (vitest: describe titles plus the test title joined by one space; node --test: the test title).`);
      if (!strategy.targetCommands.includes(profile!.command)) reject("unknown_test_command", `Criterion ${criterion.id} needs ${profile!.command} among the strategy targetCommands. Add {"method":"${profile!.method}","command":"${profile!.command}","level":"${profile!.levels[0]}"} to the specification infrastructure.commands and propose again.`);
    }
    if (strategy) {
      for (const command of strategy.targetCommands) if (!isAutomaticStaticCommand(command) && !profiles.some(profile => profile.command === command)) reject("unknown_test_command", `targetCommands contains '${command}', which is not a detected runner label (${labels}). Use only detected labels, or remove the command, and propose again.`);
      if (strategy.coverageThresholdPercent !== undefined) throw new Error("Configured behavioral reporters do not measure aggregate coverage");
      try { resolveTaskCommands({ owner: [], profiles, strategy, specification: spec }); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("runner_identity_unselectable")) {
          reject("missing_test_mapping", `Selected test identities cannot be bound to the detected runner: ${message}`);
        }
        reject("unsupported_verification", `Selected test identities cannot be bound exactly to the detected runner: ${message}`);
      }
    }
  }
  /** Gate for one owner command, bound to the owner configuration (unchanged behaviour). */
  private ownerGate(command: BehavioralCommand): QualityGate {
    return this.gate(`host-behavioral-${command.id}`, async () => command);
  }
  /** Gate for one automatic runner: the test identities come from this task's accepted specification and ownership. */
  private automaticGate(runner: AutomaticRunner): QualityGate {
    return this.gate(`host-behavioral-${runner.id}`, async context => {
      const dossier = await this.dossierFor(context.runId, context.taskId);
      const bound = this.resolve(dossier).find(command => command.command === runner.command);
      if (!bound) throw new Error(`${runner.command} has no test identities for this task: check criterion mappings, affectedPaths test files and ownership`);
      return bound;
    });
  }
  behavioralGates(): QualityGate[] {
    return [...this.runners.owner.map(command => this.ownerGate(command)),
      ...(this.runners.automatic ? [
        ...this.runners.availableProfiles.map(runner => this.automaticGate(runner)),
        ...(this.regression.scope !== "mapped_only"
          ? this.runners.availableProfiles.filter(profile => !profile.adapter).map(profile => this.regressionGate(profile))
          : []),
        ...AUTOMATIC_STATIC_COMMANDS.map(command => this.policyDeterministicGate(staticGateId(command), command))
      ] : [])];
  }
  private async resolveRegressionBase(runId: string, taskId: string | undefined, fallbackBase?: unknown): Promise<string> {
    try {
      const dossier = await this.dossierFor(runId, taskId);
      return dossier.originalRevision;
    } catch {
      const effectiveTaskId = taskId === "workflow-verification" ? undefined : taskId;
      try {
        const inspected = record(await this.runtime().inspect(runId));
        const runObj = inspected.run !== null && typeof inspected.run === "object" ? record(inspected.run) : inspected;
        if (effectiveTaskId !== undefined && Array.isArray(runObj.tasks)) {
          const task = runObj.tasks
            .filter(item => item !== null && typeof item === "object")
            .map(record)
            .find(item => item.taskId === effectiveTaskId);
          if (task && Array.isArray(task.worktrees) && task.worktrees.length > 0) {
            const baseCommit = record(task.worktrees.at(-1)).baseCommitHash;
            if (typeof baseCommit === "string" && baseCommit.trim().length > 0) return baseCommit.trim();
          }
        }
        if (typeof runObj.baseRevision === "string" && runObj.baseRevision.trim().length > 0) {
          return runObj.baseRevision.trim();
        }
      } catch {
        // Fall through to input.baseRevision
      }
      return textField(fallbackBase);
    }
  }
  private regressionGate(profile: RunnerProfile): QualityGate {
    const id = `host-regression-${profile.id}`;
    return {
      id,
      evaluate: async raw => {
        try {
          const context = QualityGateContextSchema.parse(raw);
          const config = record(context.definition.configuration);
          const meta = record(context.definition.metadata ?? {});
          const input = record(context.input);
          const selectionMode = meta.selection ?? config.selection;
          if (
            context.definition.id !== id ||
            config.command !== profile.command ||
            config.method !== profile.method ||
            (selectionMode !== undefined && selectionMode !== "regression")
          ) {
            throw new Error("Regression check does not match host runner profile");
          }

          const cwd = textField(input.sourceWorktreePath);
          const head = textField(input.sourceRevision);
          const base = await this.resolveRegressionBase(context.runId, context.taskId, input.baseRevision);
          const repositoryRoot = this.runners.repositoryRoot ?? profile.dependencySource ?? cwd;

          const selection = await selectRegressionTests({
            worktreePath: cwd,
            repositoryRoot,
            base,
            head,
            profile,
            scope: this.regression.scope === "mapped_only" ? "affected" : this.regression.scope,
            index: this.regression.index,
            git: (dir, args) => this.git(dir, args)
          });
          const evaluatedAt = new Date().toISOString();

          const buildRegressionMeta = (
            counts: { testsRun: number; passed: number; failed: number; skipped: number },
            failures: { testPath: string; testName: string; classification: "regression_failure" | "pre_existing" }[]
          ) =>
            json({
              scope: selection.scope,
              selectedTestPaths: [...selection.testPaths],
              testPaths: [...selection.testPaths],
              changedFiles: [...selection.changedFiles],
              changedFilesTruncated: selection.changedFilesTruncated,
              truncated: selection.changedFilesTruncated,
              widening: selection.widening.map(w => ({
                path: w.path,
                scope: w.tier,
                tier: w.tier,
                reason: w.reason,
                ...(w.packageRoot ? { packageRoot: w.packageRoot } : {})
              })),
              index: "commit" in selection.index ? { ...selection.index, probedAt: evaluatedAt } : selection.index,
              base: selection.base,
              baseRevision: selection.base,
              head: selection.head,
              headRevision: selection.head,
              failures,
              preExistingFailures: failures
                .filter(f => f.classification === "pre_existing")
                .map(({ testPath, testName }) => ({ testPath, testName })),
              testsRun: counts.testsRun,
              passed: counts.passed,
              failed: counts.failed,
              skipped: counts.skipped
            });

          const finishResult = async (params: {
            status: "passed" | "failed" | "blocked";
            findings: ReturnType<typeof QualityFindingSchema.parse>[];
            exitCode: number;
            summary: string;
            regressionMeta: JsonValue;
            hostExecution?: JsonValue;
          }) => {
            const result = QualityGateResultSchema.parse({
              gateId: context.definition.id,
              runId: context.runId,
              taskId: context.taskId,
              evaluationId: randomUUID(),
              status: params.status,
              findings: params.findings,
              producedArtifacts: [],
              evaluatedAt,
              metadata: {
                verification: {
                  schemaVersion: 2,
                  checkId: context.definition.id,
                  runId: context.runId,
                  taskId: context.taskId,
                  attemptId: context.attemptId,
                  sourceRevision: head,
                  specFingerprint: input.specFingerprint,
                  scope: input.scope,
                  independentExecution: true,
                  isolated: true,
                  executorId: "bflow-host-regression-check",
                  role: "quality_gate",
                  method: profile.method,
                  command: profile.command,
                  exitCode: params.status === "passed" ? 0 : params.exitCode,
                  testNames: [],
                  criteria: [],
                  summary: params.summary
                },
                regression: params.regressionMeta,
                ...(params.hostExecution !== undefined ? { hostExecution: params.hostExecution } : {})
              }
            });
            await this.trustGate(result);
            return { ok: true as const, value: result };
          };

          if (selection.scope === "none" || selection.testPaths.length === 0) {
            const findings =
              selection.scope === "none"
                ? [
                    QualityFindingSchema.parse({
                      severity: "info",
                      code: "docs_only",
                      message: "Only documentation files changed; no regression tests selected"
                    })
                  ]
                : [];
            const summary =
              selection.scope === "none"
                ? "Only documentation files changed; no regression tests selected"
                : `No regression tests selected (scope: ${selection.scope})`;
            return await finishResult({
              status: "passed",
              findings,
              exitCode: 0,
              summary,
              regressionMeta: buildRegressionMeta({ testsRun: 0, passed: 0, failed: 0, skipped: 0 }, [])
            });
          }

          const budgetMs = Math.min(540_000, profile.timeoutMs * 3);
          const bindAtCurrentCheckout = async (testPaths: string[]) => {
            const pinned = await pinRunnerDefinitions(cwd, {
              status: "detected",
              profiles: [profile],
              notes: []
            });
            const activeProfile = pinned.status === "detected" ? pinned.profiles[0]! : profile;
            return bindRegressionProfile(activeProfile, testPaths, budgetMs);
          };

          const handleInfraFailure = async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            const isBudgetExceeded = message.startsWith("regression_budget_exceeded:");
            const code = isBudgetExceeded ? "regression_budget_exceeded" : "regression_infrastructure";
            const findingMessage = isBudgetExceeded
              ? `Regression suite exceeded budget (${budgetMs}ms); split the task or configure verification.regressionScope: "mapped_only" (${message})`
              : `Regression runner infrastructure error: ${message}`;
            return await finishResult({
              status: "blocked",
              findings: [
                QualityFindingSchema.parse({
                  severity: "error",
                  code,
                  message: findingMessage
                })
              ],
              exitCode: 1,
              summary: findingMessage,
              regressionMeta: buildRegressionMeta({ testsRun: 0, passed: 0, failed: 0, skipped: 0 }, [])
            });
          };

          let headMeasured: RegressionMeasurement;
          try {
            const headCommand = await bindAtCurrentCheckout([...selection.testPaths]);
            headMeasured = await measureRegression(headCommand, cwd, head);
          } catch (error) {
            return await handleInfraFailure(error);
          }

          const headObs = headMeasured.observation;
          if (headObs.failures.length === 0) {
            const summary = `${headObs.passed}/${headObs.tests} regression tests passed at ${head} (scope: ${selection.scope})`;
            return await finishResult({
              status: "passed",
              findings: [],
              exitCode: 0,
              summary,
              regressionMeta: buildRegressionMeta(
                { testsRun: headObs.tests, passed: headObs.passed, failed: headObs.failed, skipped: headObs.skipped },
                []
              ),
              hostExecution: json(headMeasured)
            });
          }

          const failingTestPaths = [...new Set(headObs.failures.map(f => f.testPath))];
          const baseTestPaths: string[] = [];
          for (const testPath of failingTestPaths) {
            if (!testFilePattern.test(testPath)) continue;
            try {
              await this.git(cwd, ["cat-file", "-e", `${base}:${testPath}`]);
              baseTestPaths.push(testPath);
            } catch {
              // Did not exist at base; cannot be pre_existing
            }
          }

          let baseFailures: RegressionFailure[] = [];
          if (baseTestPaths.length > 0) {
            const symbolicBranch = (
              await this.git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")
            ).trim();
            try {
              await this.git(cwd, ["checkout", "--detach", "--force", base]);
              const baseCommand = await bindAtCurrentCheckout(baseTestPaths);
              const baseMeasured = await measureRegression(baseCommand, cwd, base);
              baseFailures = baseMeasured.observation.failures;
            } catch (error) {
              return await handleInfraFailure(error);
            } finally {
              if (symbolicBranch) {
                await this.git(cwd, ["checkout", "--force", symbolicBranch]).catch(async () => {
                  await this.git(cwd, ["checkout", "--detach", "--force", head]);
                });
              } else {
                await this.git(cwd, ["checkout", "--detach", "--force", head]);
              }
            }
          }

          const baseFailureKeys = new Set(baseFailures.map(f => `${f.testPath}\0${f.testName}`));
          const classifiedFailures = headObs.failures.map(f => ({
            testPath: f.testPath,
            testName: f.testName,
            classification: (baseFailureKeys.has(`${f.testPath}\0${f.testName}`)
              ? "pre_existing"
              : "regression_failure") as "regression_failure" | "pre_existing"
          }));

          const findings = classifiedFailures.map(f =>
            f.classification === "regression_failure"
              ? QualityFindingSchema.parse({
                  severity: "error",
                  code: "regression_failure",
                  message: `Regression test failed at head (${head}) but passed at base (${base}): ${f.testPath} :: ${f.testName}`,
                  location: f.testPath,
                  details: { testName: f.testName, testPath: f.testPath, base, head }
                })
              : QualityFindingSchema.parse({
                  severity: "warning",
                  code: "pre_existing_failure",
                  message: `Pre-existing test failure also present at base (${base}): ${f.testPath} :: ${f.testName}`,
                  location: f.testPath,
                  details: { testName: f.testName, testPath: f.testPath, base, head }
                })
          );

          const regressionFailures = classifiedFailures.filter(f => f.classification === "regression_failure");
          const status = regressionFailures.length > 0 ? "failed" : "passed";
          const summary =
            regressionFailures.length > 0
              ? `${regressionFailures.length} regression failure(s) detected across ${headObs.tests} tests at ${head}`
              : `${headObs.passed}/${headObs.tests} regression tests passed (${classifiedFailures.length} pre-existing failure(s) ignored) at ${head}`;

          return await finishResult({
            status,
            findings,
            exitCode: status === "passed" ? 0 : headMeasured.outcome.exitCode || 1,
            summary,
            regressionMeta: buildRegressionMeta(
              { testsRun: headObs.tests, passed: headObs.passed, failed: headObs.failed, skipped: headObs.skipped },
              classifiedFailures
            ),
            hostExecution: json(headMeasured)
          });
        } catch (error) {
          return { ok: false, error: { code: "validation", retryable: false, message: String(error) } };
        }
      }
    };
  }
  private gate(id: string, resolveCommand: (context: { runId: string; taskId?: string | undefined }) => Promise<BoundBehavioralCommand>): QualityGate {
    return { id, evaluate: async raw => {
      try {
        const context = QualityGateContextSchema.parse(raw), config = record(context.definition.configuration), input = record(context.input);
        if (context.definition.id !== id) throw new Error("Behavioral check does not match owner configuration");
        const command = await resolveCommand(context);
        if (config.command !== command.command || config.method !== command.method ||
            !Array.isArray(config.testNames) || config.testNames.some(name => !command.testNames.includes(String(name)))) throw new Error("Behavioral check does not match owner configuration");
        const measured = await measureBehavior(command, textField(input.sourceWorktreePath), textField(input.sourceRevision));
        const result = QualityGateResultSchema.parse({ gateId: context.definition.id, runId: context.runId, taskId: context.taskId, evaluationId: randomUUID(),
          status: measured.failed ? "failed" : "passed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString(),
          metadata: { verification: { schemaVersion: 2, checkId: context.definition.id, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
            sourceRevision: measured.sourceRevision, specFingerprint: input.specFingerprint, scope: input.scope, independentExecution: true, isolated: true,
            executorId: "bflow-host-behavioral-check", role: "quality_gate", method: command.method, command: command.command, exitCode: measured.outcome.exitCode,
            testNames: measured.testNames, criteria: (config.criterionIds as string[]).map(criterionId => ({ criterionId, passed: measured.failed === 0, summary: `${measured.passed}/${measured.tests} observed tests passed` })),
            summary: `${measured.passed}/${measured.tests} observed tests passed at ${measured.sourceRevision}` }, hostExecution: json(measured) } });
        await this.trustGate(result);
        return { ok: true, value: result };
      } catch (error) { return { ok: false, error: { code: "validation", retryable: false, message: String(error) } }; }
    } };
  }
  /** Execute an independent phase; no test command, revision or verdict is accepted from the agent. */
  async behavioralEvidence(binding: PaneBinding, input: unknown) {
    if (!["tester", "qa"].includes(binding.role)) throw new Error("Independent Tester or QA required");
    const args = record(input), runId = textField(args.runId), taskId = textField(args.taskId), phase = textField(args.phase);
    if (Object.keys(args).some(key => !["runId", "taskId", "phase"].includes(key))) throw new Error("Behavioral tools accept only runId, taskId and phase; measurements are host owned");
    const run = record(await this.runtime().inspect(runId)), task = (run.tasks as Record<string, unknown>[]).find(task => task.taskId === taskId);
    if (!task) throw new Error("Unknown task");
    const dossier = record(task.spec), spec = SpecificationSchema.parse(dossier.specification), strategy = TestStrategySchema.parse(dossier.strategy);
    if (!this.runners.automatic) this.assertSupported(spec, strategy);
    if (spec.status !== "approved" || strategy.tddDecision.runId !== runId || strategy.tddDecision.taskId !== taskId) throw new Error("Behavioral measurement requires an accepted matching task specification");
    const prior = Array.isArray(strategy.metadata?.tddEvidence) ? strategy.metadata.tddEvidence.map(value => VerificationResultSchema.parse(value)) : [];
    for (const receipt of prior) if (!await this.authenticateEvidence(receipt)) throw new Error("Prior behavioral phase lacks a trusted host receipt");
    const expected = strategy.tddDecision.mode === "required" ? ["red", "green", "refactor"][prior.length] : prior.length === 0 ? "verification" : undefined;
    const state = record(await this.runtime().inspect());
    const assignment = [...state.outbound as Record<string, unknown>[]].reverse().find(item => item.taskId === taskId && record(item.message).run_id === runId && record(item.message).type === "task.assignment" && item.handle);
    if (!assignment) throw new Error("Implementation assignment unavailable");
    const target = record(record(assignment.handle).target);
    if (target.agentId === binding.agentId || target.paneId === binding.paneId) throw new Error("Implementer cannot verify its own change");
    const cwd = textField(target.worktreePath), revision = (await this.git(cwd, ["rev-parse", "HEAD"])).trim(), startedAt = new Date().toISOString();
    const criteria = spec.acceptanceCriteria.filter(criterion => criterion.required !== false && criterion.status !== "waived");
    const commands = this.resolve({ specification: spec, strategy, ownedPaths: this.ownedPathsOf(run, taskId), originalRevision: Array.isArray(task.worktrees) && task.worktrees.length ? textField(record(task.worktrees.at(-1)).baseCommitHash) : textField(run.baseRevision) });
    if (!commands.length || criteria.some(criterion => criterion.verificationMethod === "manual_review")) throw new Error("This strategy requires independent alternative evidence");
    const verificationId = `host-behavioral-${digest([runId, taskId, strategy.tddDecision.decisionId, phase, revision, commands])}`;
    const replay = this.receipts ? await this.receipts.getEvidence(verificationId) : this.evidenceRecords.get(verificationId);
    if (replay) {
      const parsed = VerificationResultSchema.parse(replay);
      if (digest(this.bindingIdentity(PaneBindingSchema.parse(parsed.metadata?.hostVerifierBinding))) !== digest(this.bindingIdentity(binding)) || !await this.authenticateEvidence(parsed)) throw new Error("Behavioral phase receipt belongs to another verifier binding");
      await this.capture(cwd, textField(run.baseRevision), revision);
      return { result: parsed, assignment: assignment.message };
    }
    if (phase !== expected) throw new Error(`Expected ${expected ?? "no further"} behavioral phase`);
    const measured = [];
    for (const command of commands) {
      try {
        const rtk = await this.rtk?.resolve({ role: binding.role, runId, taskId,
          ...(typeof assignment.attemptId === "string" ? { attemptId: assignment.attemptId } : {}),
          commandId: command.id, revision });
        measured.push(await measureBehavior(command, cwd, revision, rtk ? { rtk } : {}));
      }
      catch (error) {
        if (!(error instanceof NodeTapTestCodeFailure) && !(error instanceof RtkRequiredToolUnavailable && error.originalOutcome)) throw error;
        const observation = await this.capture(cwd, textField(run.baseRevision), revision);
        const originalOutcome = error instanceof NodeTapTestCodeFailure ? error.outcome : error.originalOutcome!;
        const evidence = await this.artifact(runId, taskId, { phase, observation, verifiedBy: binding.agentId, accepted: false,
          measurementFailure: { protocol: error instanceof NodeTapTestCodeFailure ? "node_tap" : "rtk_required", summary: error.message,
            outcome: originalOutcome, ...(error instanceof NodeTapTestCodeFailure && error.rtk ? { rtk: error.rtk } : {}),
            ...(error instanceof RtkRequiredToolUnavailable ? { rawOutput: error.rawOutput ?? "", reasonCode: error.reasonCode } : {}) } });
        if (error instanceof NodeTapTestCodeFailure && (error.rtk?.status === "compressed" || error.rtk?.status === "passthrough") && error.rtk.invocationId) await this.rtk?.consume(error.rtk.invocationId, evidence);
        throw new HostBehavioralFailure(error.message, evidence, error instanceof NodeTapTestCodeFailure && (error.rtk?.status === "compressed" || error.rtk?.status === "passthrough") && error.rtk.compressedOutput
          ? [json({ commandId: command.id, exitCode: error.outcome.exitCode, compressedOutput: error.rtk.compressedOutput })] : []);
      }
    }
    const observation = await this.capture(cwd, textField(run.baseRevision), revision);
    if (observation.exitCode !== 0) throw new Error("Committed diff integrity check failed");
    const red = prior[0], redDetails = red ? record(red.metadata?.conditionalTdd) : undefined;
    if (red) {
      const redMeasurements = red.metadata?.hostBehavioralMeasurements;
      if (!Array.isArray(redMeasurements) || digest(redMeasurements.map(value => { const item = record(value); return { commandId: item.commandId, testNames: item.testNames, testBlobs: item.testBlobs }; })) !==
        digest(measured.map(item => ({ commandId: item.commandId, testNames: item.testNames, testBlobs: item.testBlobs })))) throw new Error("Green/Refactor must preserve the exact committed Red test files and observed identities");
      if (redDetails?.sourceRevision === revision) throw new Error("Green/Refactor require the implementation revision after Red");
    }
    if (phase === "red" ? !measured.some(item => item.targetFailure) : measured.some(item => item.failed)) {
      const evidence = await this.artifact(runId, taskId, { phase, observation, measurements: measured, verifiedBy: binding.agentId, accepted: false });
      for (const item of measured) if ((item.rtk?.status === "compressed" || item.rtk?.status === "passthrough") && item.rtk.invocationId) await this.rtk?.consume(item.rtk.invocationId, evidence);
      throw new HostBehavioralFailure(phase === "red" ? "Red requires an independently observed assertion failure" : "Behavioral acceptance failed; request repairs",
        evidence, measured.flatMap(item => (item.rtk?.status === "compressed" || item.rtk?.status === "passthrough") && item.rtk.compressedOutput
          ? [json({ commandId: item.commandId, exitCode: item.outcome.exitCode, compressedOutput: item.rtk.compressedOutput })] : []));
    }
    if (phase === "red") {
      const targetNames = new Set(strategy.criterionMappings.filter(mapping => criteria.some(criterion => criterion.id === mapping.criterionId)).flatMap(mapping => mapping.testNames));
      if (measured.some(item => item.testResults.some(test => !test.passed && !targetNames.has(test.name)))) throw new Error("Red failure belongs to an unrelated test rather than an accepted target criterion");
    }
    // Static target commands are measured here; every other target command must come from a measured runner above.
    const staticAnalyses = [];
    if (phase !== "red") for (const command of strategy.targetCommands.filter(isAutomaticStaticCommand)) {
      const analysis = await this.captureStaticAnalysis(cwd, textField(run.baseRevision), revision, command);
      staticAnalyses.push({ command, exitCode: analysis.exitCode, output: analysis.output });
    }
    if (staticAnalyses.some(item => item.exitCode !== 0)) {
      const evidence = await this.artifact(runId, taskId, { phase, observation, measurements: measured, staticAnalyses, verifiedBy: binding.agentId, accepted: false });
      for (const item of measured) if ((item.rtk?.status === "compressed" || item.rtk?.status === "passthrough") && item.rtk.invocationId) await this.rtk?.consume(item.rtk.invocationId, evidence);
      throw new HostBehavioralFailure(`Static analysis failed: ${staticAnalyses.filter(item => item.exitCode !== 0).map(item => `${item.command}: ${item.output}`).join("; ")}`, evidence, []);
    }
    const artifact = await this.artifact(runId, taskId, { phase, observation, measurements: measured, ...(staticAnalyses.length ? { staticAnalyses } : {}), verifiedBy: binding.agentId });
    for (const item of measured) if ((item.rtk?.status === "compressed" || item.rtk?.status === "passthrough") && item.rtk.invocationId) await this.rtk?.consume(item.rtk.invocationId, artifact);
    const observations: Array<{ method: string; criterionId: string; evidenceArtifactId: string; command?: string; exitCode?: number; summary: string }> = measured.flatMap(item => criteria.filter(criterion => criterion.verificationMethod === item.method &&
      strategy.criterionMappings.find(mapping => mapping.criterionId === criterion.id)?.testNames.every(name => item.testNames.includes(name)))
      .map(criterion => ({ method: item.method, criterionId: criterion.id, evidenceArtifactId: artifact.artifactId, command: item.command, exitCode: item.outcome.exitCode!, summary: `${item.passed}/${item.tests} observed tests passed` })));
    // Commands without a primary criterion still produce evidence for the strategy's required methods/commands.
    for (const item of measured) if (!observations.some(observation => observation.command === item.command)) observations.push({ method: item.method, criterionId: criteria[0]!.id,
      evidenceArtifactId: artifact.artifactId, command: item.command, exitCode: item.outcome.exitCode!, summary: `${item.passed}/${item.tests} observed tests passed` });
    for (const item of staticAnalyses) observations.push({ method: "static_analysis", criterionId: criteria[0]!.id, evidenceArtifactId: artifact.artifactId,
      command: item.command, exitCode: item.exitCode, summary: item.output });
    const result = VerificationResultSchema.parse({ schemaVersion: 2, verificationId, runId, taskId, cycleNumber: prior[0]?.cycleNumber ?? 1, attemptId: randomUUID(),
      status: phase === "red" ? "failed" : "passed", independentExecution: true, evaluatedCriteria: criteria.map(criterion => {
        const matching = observations.find(observation => observation.criterionId === criterion.id && observation.method === criterion.verificationMethod && observation.command !== undefined && observation.exitCode !== undefined);
        if (!matching) throw new Error(`No measured evidence for ${criterion.id}`);
        return { criterionId: criterion.id, passed: matching.exitCode === 0, evidenceArtifactId: artifact.artifactId, command: matching.command, exitCode: matching.exitCode, summary: matching.summary };
      }), qualityGateResults: [], evidenceArtifacts: [artifact], findings: [], verifiedBy: binding.role, startedAt, completedAt: new Date().toISOString(),
      metadata: { conditionalTdd: { phase, decisionId: strategy.tddDecision.decisionId, specId: strategy.specId, sourceRevision: revision, testRevision: redDetails?.testRevision ?? revision,
        testNames: [...new Set(measured.flatMap(item => item.testNames))], ...(phase === "red" ? { failureKind: "target_behavior" } : {}), observations }, hostBehavioralMeasurements: json(measured), hostVerifierBinding: json(binding) } });
    // Apply the same P16 validator before minting a host receipt; the Runtime will apply it again at ingress.
    this.runtime().ports.policies.recordEvidence(strategy, result);
    await this.trustEvidence(result);
    return { result, assignment: assignment.message, rtkOutputs: measured.flatMap(item => (item.rtk?.status === "compressed" || item.rtk?.status === "passthrough") && item.rtk.compressedOutput
      ? [json({ commandId: item.commandId, exitCode: item.outcome.exitCode, compressedOutput: item.rtk.compressedOutput })] : []) };
  }
  private judgments(input: unknown, ids: string[]) {
    if (!Array.isArray(input)) throw new Error("Independent criterion judgments are required");
    const values = input.map(value => { const item = record(value); if (typeof item.passed !== "boolean") throw new Error("Criterion verdict must be boolean");
      return { criterionId: textField(item.criterionId), passed: item.passed, summary: textField(item.summary) }; });
    if (new Set(values.map(value => value.criterionId)).size !== values.length || digest(values.map(value => value.criterionId).sort()) !== digest([...ids].sort())) throw new Error("Review must cover exactly the assigned criteria");
    return values;
  }
  private reworkDossierFor(state: Record<string, unknown>, runId: string, taskId?: string, attemptId?: string): ReworkResolutionDossier | undefined {
    if (!taskId || !attemptId || !Array.isArray(state.runs)) return undefined;
    const run = state.runs.map(record).find(item => item.runId === runId);
    const task = Array.isArray(run?.tasks) ? run!.tasks.map(record).find(item => item.taskId === taskId) : undefined;
    const dossiers = Array.isArray(task?.reworkResolutions) ? task.reworkResolutions.map(item => ReworkResolutionDossierSchema.parse(item)) : [];
    const dossier = dossiers.find(item => item.attemptId === attemptId);
    if (task && record(task.result).attemptId !== attemptId) {
      throw new Error("Stale rework review attempt or generation");
    }
    if (!dossier && (hasReworkAssignment(Array.isArray(state.outbound) ? state.outbound : [], runId, taskId, attemptId) ||
        task?.cycle && Array.isArray(record(task.cycle).history) &&
        (record(task.cycle).history as unknown[]).some(r => record(r).status === "failed"))) {
      throw new Error("Missing rework dossier; historical state cannot supply independent finding evidence");
    }
    return dossier;
  }
  /** Capture objective revision/diff before the model evaluates it; the returned ID pins later judgment. */
  private readonly reviews = new Map<string, { binding: PaneBinding; sourceMessageId: string; context: unknown; observation: Awaited<ReturnType<HostVerification["capture"]>> }>();
  async inspectReview(binding: PaneBinding, input: unknown) {
    if (!["reviewer", "qa", "tester"].includes(binding.role)) throw new Error("Independent verification role required");
    const args = record(input), state = record(await this.runtime().inspect());
    const out = (state.outbound as Record<string, unknown>[]).find(item => item.handle && record(record(item.handle).target).paneId === binding.paneId && record(record(item.handle).target).agentId === binding.agentId &&
      digest(record(record(item.handle).target).session) === digest(binding.session) && ["accepted", "released"].includes(String(item.status)) &&
      record(item.message).message_id === args.messageId && record(item.message).type === "verification.requested");
    if (!out) throw new Error("No verification request assigned to this pane");
    if (out.reviewReplacement) throw new Error("Replaced workflow review cannot create another observation");
    let context = QualityGateContextSchema.parse(record(out.message).payload);
    const details = record(context.input), config = record(context.definition.configuration);
    if (config.kind !== "review" || config.role !== binding.role) throw new Error("Review role mismatch");
    const observation = await this.capture(textField(details.sourceWorktreePath), textField(details.baseRevision), textField(details.sourceRevision));
    let qaBehavioralObservation: JsonValue | undefined;
    if (binding.role === "qa" && details.scope === "workflow") {
      const dossier = await this.dossierFor(context.runId, context.taskId);
      const age = out.message && typeof record(out.message).occurred_at === "string" ? Math.max(0, Date.now() - Date.parse(textField(record(out.message).occurred_at))) : 0;
      const commands = boundQaReviewCommands(this.resolve(dossier), Math.min(540_000, context.definition.timeout.executionTimeoutMs - age - 30_000));
      if (commands.length) {
        const measurements = [];
        for (const command of commands) {
          const rtk = await this.rtk?.resolve({ role: binding.role, runId: context.runId, ...(context.taskId ? { taskId: context.taskId } : {}),
            ...(typeof out.attemptId === "string" ? { attemptId: out.attemptId } : {}),
            commandId: command.id, revision: observation.revision });
          measurements.push(await measureBehavior(command, observation.cwd, observation.revision, rtk ? { rtk } : {}));
        }
        const after = await this.capture(observation.cwd, observation.base, observation.revision);
        if (digest(after) !== digest(observation)) throw new Error("QA source changed during independent measurement");
        const artifact = await this.artifact(context.runId, context.taskId!, { scope: "workflow", sourceRevision: observation.revision, measurements, verifiedBy: binding.agentId });
        for (const item of measurements) if ((item.rtk?.status === "compressed" || item.rtk?.status === "passthrough") && item.rtk.invocationId) await this.rtk?.consume(item.rtk.invocationId, artifact);
        qaBehavioralObservation = json({ sourceRevision: observation.revision, passed: measurements.every(item => item.failed === 0 && item.outcome.exitCode === 0),
          evidenceArtifact: artifact, measurements: measurements.map(item => ({ command: item.command, method: item.method, testNames: item.testNames,
            tests: item.tests, passed: item.passed, failed: item.failed, exitCode: item.outcome.exitCode,
            ...(item.rtk ? { rtk: item.rtk } : {}) })) });
        context = QualityGateContextSchema.parse({ ...context, input: { ...details, hostQaBehavioralObservation: qaBehavioralObservation } });
      }
    }
    const reworkResolution = this.reworkDossierFor(state, context.runId, context.taskId, context.attemptId);
    if (reworkResolution) {
      if (reworkResolution.submittedRevision !== observation.revision) throw new Error("Rework dossier revision mismatch");
      context = QualityGateContextSchema.parse({ ...context, input: { ...record(context.input), hostReworkVerification: reworkVerificationBinding(reworkResolution) } });
    }
    const sourceMessageId = textField(args.messageId);
    const existingReviewId = [...this.reviews.entries()].find(([, rev]) =>
      rev.sourceMessageId === sourceMessageId &&
      digest(this.bindingIdentity(rev.binding)) === digest(this.bindingIdentity(binding)) &&
      digest(rev.context) === digest(context) &&
      digest(rev.observation) === digest(observation)
    )?.[0];
    const reviewId = existingReviewId ?? randomUUID();
    await this.receipts?.putObservation("review", reviewId, { binding, sourceMessageId, context, observation: json(observation) });
    this.reviews.set(reviewId, { binding, sourceMessageId, context, observation });
    const fullReply = { reviewId, ...(qaBehavioralObservation ? { qaBehavioralObservation } : {}), ...(reworkResolution ? { reworkResolution } : {}), context, observation };
    const isAgy = binding.provider === "agy" || binding.agentKind === "agy";
    const hasDiffPagination = typeof args.diffOffset === "number" || typeof args.diffLimit === "number";
    if (!hasDiffPagination && (!isAgy || !exceedsAgyInlineReply(fullReply))) {
      return json(fullReply);
    }
    const rawDiff = observation.diff;
    const diffOffset = typeof args.diffOffset === "number" && Number.isInteger(args.diffOffset) && args.diffOffset >= 0
      ? Math.min(args.diffOffset, rawDiff.length)
      : 0;
    let maxChars = typeof args.diffLimit === "number" && Number.isInteger(args.diffLimit) && args.diffLimit > 0
      ? Math.min(args.diffLimit, rawDiff.length - diffOffset)
      : Math.min(4500, rawDiff.length - diffOffset);
    const buildBounded = (chars: number, compactDossier = false) => {
      const endOffset = diffOffset + chars;
      const boundedRework = compactDossier && reworkResolution
        ? {
            dossierId: reworkResolution.dossierId,
            attempt: reworkResolution.attempt,
            attemptId: reworkResolution.attemptId,
            reworkGeneration: reworkResolution.reworkGeneration,
            failedVerificationId: reworkResolution.failedVerificationId,
            failedRevision: reworkResolution.failedRevision,
            submittedRevision: reworkResolution.submittedRevision,
            submissionStatus: reworkResolution.submissionStatus,
            reworkContext: {
              findings: reworkResolution.reworkContext.findings.map(f => ({
                findingId: f.findingId,
                code: f.code,
                severity: f.severity,
                message: f.message.slice(0, 160),
                ...(f.location ? { location: f.location } : {}),
                ...(f.criterionId ? { criterionId: f.criterionId } : {})
              }))
            },
            findingResolutions: reworkResolution.findingResolutions.map(r => ({
              findingId: r.findingId,
              findingCode: r.findingCode,
              disposition: r.disposition,
              rootCause: r.rootCause.slice(0, 180),
              hypothesisConfirmed: r.hypothesisConfirmed,
              sourceLocations: r.sourceLocations,
              repairSummary: r.repairSummary.slice(0, 180),
              discriminatingCheck: {
                kind: r.discriminatingCheck.kind,
                ...(r.discriminatingCheck.target ? { target: r.discriminatingCheck.target.slice(0, 120) } : {}),
                beforeOutcome: r.discriminatingCheck.beforeOutcome.slice(0, 140),
                afterOutcome: r.discriminatingCheck.afterOutcome.slice(0, 140)
              },
              evidence: {
                sourceRevision: r.evidence.sourceRevision,
                summary: r.evidence.summary.slice(0, 140),
                artifactId: r.evidence.artifactRef.artifactId
              }
            })),
            verificationOutcome: {
              status: reworkResolution.verificationOutcome.status,
              openFindingIds: reworkResolution.verificationOutcome.openFindingIds,
              closedFindingIds: reworkResolution.verificationOutcome.closedFindingIds
            }
          }
        : reworkResolution;
      const boundedContext = compactDossier
        ? { ...context, artifacts: context.artifacts.map(a => ({ artifactId: a.artifactId, kind: a.kind })) }
        : context;
      return {
        reviewId,
        ...(qaBehavioralObservation ? { qaBehavioralObservation } : {}),
        ...(boundedRework ? { reworkResolution: boundedRework } : {}),
        context: boundedContext,
        observation: {
          ...observation,
          diff: rawDiff.slice(diffOffset, endOffset),
          diffOffset,
          diffTotalChars: rawDiff.length,
          diffTruncated: endOffset < rawDiff.length,
          nextDiffOffset: endOffset < rawDiff.length ? endOffset : null
        }
      };
    };
    let bounded = buildBounded(maxChars, false);
    const shouldCompactDossier = isAgy && exceedsAgyInlineReply(bounded) && Boolean(reworkResolution);
    if (shouldCompactDossier) bounded = buildBounded(maxChars, true);
    while (isAgy && maxChars > 512 && exceedsAgyInlineReply(bounded)) {
      maxChars = Math.max(512, Math.floor(maxChars * 0.75));
      bounded = buildBounded(maxChars, shouldCompactDossier);
    }
    return json(bounded);
  }
  async completeReview(binding: PaneBinding, input: unknown) {
    const args = record(input), id = textField(args.reviewId), stored = await this.receipts?.getObservation("review", id);
    const pending = stored ? { binding: stored.binding, sourceMessageId: stored.sourceMessageId, context: stored.context, observation: this.parseCapture(stored.observation) } : this.reviews.get(id);
    if (!pending || digest(this.bindingIdentity(pending.binding)) !== digest(this.bindingIdentity(binding))) {
      // Guidance never selects an observation or submits a judgment on the caller's behalf.
      const state = record(await this.runtime().inspect());
      const assigned = (state.outbound as Record<string, unknown>[]).find(out => !out.reviewReplacement && out.handle &&
        ["accepted", "released"].includes(String(out.status)) && record(out.message).type === "verification.requested" &&
        record(out.message).message_id === args.messageId && record(record(out.handle).target).paneId === binding.paneId &&
        record(record(out.handle).target).agentId === binding.agentId && digest(record(record(out.handle).target).session) === digest(binding.session));
      const candidates = assigned ? [...this.reviews].filter(([, review]) => review.sourceMessageId === args.messageId &&
        digest(this.bindingIdentity(review.binding)) === digest(this.bindingIdentity(binding)) &&
        digest(originalReviewContext(review.context)) === digest(originalReviewContext(record(assigned.message).payload)))
        .slice(-3).map(([reviewId]) => reviewId) : [];
      throw new Error("Review observation belongs to another pane or is missing" + (candidates.length
        ? `; this pane's observation IDs for the exact assigned message: ${candidates.join(", ")}. Retry complete_review with the chosen reviewId and independent judgments.`
        : "; use inspect_review for the assigned messageId before submitting independent judgments."));
    }
    if (args.messageId !== undefined && pending.sourceMessageId !== undefined && args.messageId !== pending.sourceMessageId)
      throw new Error("Review observation belongs to another verification request");
    const context = QualityGateContextSchema.parse(pending.context), configuration = record(context.definition.configuration), details = record(context.input);
    const state = record(await this.runtime().inspect());
    if ((state.outbound as Record<string, unknown>[]).some(out => out.reviewReplacement && out.handle &&
        record(record(out.handle).target).paneId === pending.binding.paneId && digest(record(record(out.handle).target).session) === digest(pending.binding.session) && digest(originalReviewContext(record(out.message).payload)) === digest(originalReviewContext(context))))
      throw new Error("Replaced workflow review cannot complete a stored observation");
    if (configuration.kind !== "review" || configuration.role !== binding.role) throw new Error("Review role mismatch");
    const criteria = this.judgments(args.criteria, configuration.criterionIds as string[]);
    const reworkResolution = this.reworkDossierFor(state, context.runId, context.taskId, context.attemptId);
    const pinnedRework = details.hostReworkVerification;
    if (reworkResolution || pinnedRework !== undefined) {
      if (!reworkResolution || binding.agentId === reworkResolution.submittedByAgentId ||
          reworkResolution.submittedRevision !== pending.observation.revision ||
          digest(pinnedRework) !== digest(reworkVerificationBinding(reworkResolution))) {
        throw new Error("Missing or stale rework observation binding");
      }
    }
    const findingVerdicts = reworkResolution ? parseRequiredFindingVerdicts(reworkResolution, args.findingVerdicts) : args.findingVerdicts === undefined ? [] : (() => {
      if (!Array.isArray(args.findingVerdicts)) throw new Error("findingVerdicts must be an array");
      const parsed = args.findingVerdicts.map(item => ReworkFindingVerdictSchema.parse(item));
      if (new Set(parsed.map(item => item.findingId)).size !== parsed.length) throw new Error("Duplicate findingId in findingVerdicts");
      if (parsed.length > 0) throw new Error("findingVerdicts cannot be submitted for an initial non-rework review");
      return parsed;
    })();
    const explicitFindings = args.findings === undefined ? [] : (() => {
      if (!Array.isArray(args.findings)) throw new Error("findings must be an array");
      return args.findings.map(value => {
        const item = record(value);
        const locObj = item.location !== null && typeof item.location === "object" && !Array.isArray(item.location)
          ? (item.location as Record<string, unknown>) : undefined;
        const filePath = typeof item.filePath === "string" && item.filePath.trim()
          ? item.filePath.trim()
          : typeof locObj?.path === "string" && locObj.path.trim()
            ? locObj.path.trim()
            : undefined;
        const line = typeof item.line === "number"
          ? item.line
          : typeof locObj?.line === "number"
            ? locObj.line
            : undefined;
        const location = typeof item.location === "string" && item.location.trim()
          ? item.location.trim()
          : filePath !== undefined
            ? (line !== undefined ? `${filePath}:${line}` : filePath)
            : undefined;
        return QualityFindingSchema.parse({
          code: textField(item.code),
          severity: item.severity === undefined ? "error" : textField(item.severity),
          message: textField(item.message),
          ...(location !== undefined ? { location } : {}),
          ...(typeof item.artifactId === "string" && item.artifactId.trim() ? { artifactId: item.artifactId.trim() } : {}),
          details: json({
            ...(item.details !== null && typeof item.details === "object" && !Array.isArray(item.details) ? item.details : {}),
            ...(filePath !== undefined ? { filePath } : {}),
            ...(line !== undefined ? { line } : {}),
            ...(typeof item.criterionId === "string" && item.criterionId.trim() ? { criterionId: item.criterionId.trim() } : {}),
            ...(typeof item.priorFindingId === "string" && item.priorFindingId.trim() ? { priorFindingId: item.priorFindingId.trim() } : {})
          })
        });
      });
    })();
    const verdictFindings = findingVerdicts.filter(item => item.verdict === "rejected").map(item => {
      const orig = reworkResolution!.reworkContext.findings.find(f => f.findingId === item.findingId)!;
      const res = reworkResolution!.findingResolutions.find(r => r.findingId === item.findingId);
      const filePath = item.filePath ?? orig.filePath;
      const line = item.line ?? orig.line;
      const location = filePath !== undefined ? (line !== undefined ? `${filePath}:${line}` : filePath) : orig.location;
      return QualityFindingSchema.parse({
        code: orig.code,
        severity: "error",
        message: item.summary,
        ...(location !== undefined ? { location } : {}),
        details: json({
          priorFindingId: orig.findingId,
          reworkVerdict: "rejected",
          rejectedDisposition: res?.disposition ?? null,
          ...(filePath !== undefined ? { filePath } : {}),
          ...(line !== undefined ? { line } : {}),
          ...(orig.criterionId ? { criterionId: orig.criterionId } : {}),
          ...(orig.checkId ? { checkId: orig.checkId } : {})
        })
      });
    });
    const allFindings = [...verdictFindings, ...explicitFindings];
    const evaluationId = `host-review-${digest([id, this.bindingIdentity(binding), context])}`;
    const submission = digest({
      criteria,
      summary: textField(args.summary),
      ...(findingVerdicts.length ? { findingVerdicts } : {}),
      ...(explicitFindings.length ? { findings: explicitFindings } : {})
    });
    const replay = this.receipts ? await this.receipts.getGate(evaluationId) : this.gateRecords.get(evaluationId);
    if (replay) {
      if (replay.metadata?.hostReviewSubmission !== submission || !await this.authenticateGate(replay)) throw new Error("Conflicting completion for an immutable review observation");
      return { result: replay, artifact: ArtifactReferenceSchema.parse(replay.metadata?.evidence) };
    }
    const observed = await this.capture(pending.observation.cwd, pending.observation.base, pending.observation.revision);
    if (digest(observed) !== digest(pending.observation)) throw new Error("Review source changed");
    const qaBehavioralObservation = details.hostQaBehavioralObservation;
    if (binding.role === "qa" && details.scope === "workflow" && qaBehavioralObservation === undefined && this.resolve(await this.dossierFor(context.runId, context.taskId)).length)
      throw new Error("Workflow QA needs a new inspect_review observation with owner-run measurements; no old diff-only observation is upgraded into test evidence");
    const qaPassed = qaBehavioralObservation === undefined || record(qaBehavioralObservation).passed === true;
    const reworkRejected = findingVerdicts.some(item => item.verdict === "rejected") || allFindings.some(item => item.severity === "error");
    const evidence = await this.artifact(context.runId, context.taskId!, {
      observation: observed,
      criteria,
      reviewedBy: binding.agentId,
      ...(qaBehavioralObservation === undefined ? {} : { qaBehavioralObservation }),
      ...(findingVerdicts.length ? { findingVerdicts } : {}),
      ...(allFindings.length ? { findings: allFindings } : {})
    });
    const result = QualityGateResultSchema.parse({ gateId: context.definition.id, runId: context.runId, taskId: context.taskId, evaluationId,
      status: criteria.every(criterion => criterion.passed) && observed.exitCode === 0 && qaPassed && !reworkRejected ? "passed" : "failed",
      findings: allFindings, producedArtifacts: [], evaluatedAt: new Date().toISOString(),
      metadata: {
        ...(qaBehavioralObservation === undefined ? {} : { hostQaBehavioralObservation: qaBehavioralObservation }),
        ...(findingVerdicts.length ? { findingVerdicts: json(findingVerdicts), reworkVerification: pinnedRework } : {}),
        verification: { schemaVersion: 2, checkId: context.definition.id, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
          sourceRevision: observed.revision, specFingerprint: details.specFingerprint, scope: details.scope, independentExecution: true, isolated: true, executorId: binding.agentId,
          role: binding.role, method: "manual_review", testNames: configuration.testNames, criteria, summary: textField(args.summary) },
        evidence: json(evidence),
        hostReviewSubmission: submission
      } });
    await this.trustGate(result);
    return { result, artifact: evidence };
  }
  /** Alternative evidence is supported only for accepted manual-review documentation criteria. */
  private readonly alternatives = new Map<string, { binding: PaneBinding; runId: string; taskId: string; observation: Awaited<ReturnType<HostVerification["capture"]>> }>();
  async inspectAlternative(binding: PaneBinding, input: unknown) {
    if (!["tester", "qa"].includes(binding.role)) throw new Error("Independent Tester or QA required");
    const args = record(input), runId = textField(args.runId), taskId = textField(args.taskId), state = record(await this.runtime().inspect());
    const run = record(await this.runtime().inspect(runId));
    const assignment = [...state.outbound as Record<string, unknown>[]].reverse().find(item => item.taskId === taskId && record(item.message).run_id === runId && record(item.message).type === "task.assignment" && item.handle);
    if (!assignment) throw new Error("Implementation assignment unavailable");
    const target = record(record(assignment.handle).target); if (target.agentId === binding.agentId) throw new Error("Implementer cannot verify its own change");
    const cwd = textField(target.worktreePath), revision = (await this.git(cwd, ["rev-parse", "HEAD"])).trim();
    const observation = await this.capture(cwd, textField(run.baseRevision), revision), observationId = randomUUID();
    await this.receipts?.putObservation("alternative", observationId, { binding, runId, taskId, observation: json(observation) });
    this.alternatives.set(observationId, { binding, runId, taskId, observation });
    const task = (run.tasks as Record<string, unknown>[]).find(item => item.taskId === taskId); if (!task) throw new Error("Unknown task");
    return json({ observationId, observation, dossier: task.spec });
  }
  async alternativeEvidence(binding: PaneBinding, input: unknown) {
    if (!["tester", "qa"].includes(binding.role)) throw new Error("Independent Tester or QA required");
    const args = record(input), runId = textField(args.runId), taskId = textField(args.taskId);
    const run = record(await this.runtime().inspect(runId));
    const task = (run.tasks as Record<string, unknown>[]).find(item => item.taskId === taskId); if (!task) throw new Error("Unknown task");
    const dossier = record(task.spec), specification = SpecificationSchema.parse(dossier.specification), strategy = TestStrategySchema.parse(dossier.strategy);
    if (strategy.tddDecision.mode === "required" || strategy.targetCommands.length || specification.acceptanceCriteria.some(criterion => criterion.verificationMethod !== "manual_review")) throw new Error("Configured behavioral measurement runner required for this strategy");
    const state = record(await this.runtime().inspect());
    const assignment = [...state.outbound as Record<string, unknown>[]].reverse().find(item => item.taskId === taskId && record(item.message).run_id === runId && record(item.message).type === "task.assignment" && item.handle);
    if (!assignment) throw new Error("Implementation assignment unavailable");
    const target = record(record(assignment.handle).target);
    if (target.agentId === binding.agentId) throw new Error("Implementer cannot verify its own change");
    const cwd = textField(target.worktreePath), revision = (await this.git(cwd, ["rev-parse", "HEAD"])).trim();
    const observationId = textField(args.observationId), stored = await this.receipts?.getObservation("alternative", observationId);
    const pending = stored ? { binding: stored.binding, runId: stored.runId, taskId: stored.taskId, observation: this.parseCapture(stored.observation) } : this.alternatives.get(observationId);
    if (!pending || digest(this.bindingIdentity(pending.binding)) !== digest(this.bindingIdentity(binding)) || pending.runId !== runId || pending.taskId !== taskId) throw new Error("Inspect the assigned alternative evidence before submitting a judgment");
    const startedAt = new Date().toISOString(), observed = await this.capture(cwd, textField(run.baseRevision), revision);
    if (digest(observed) !== digest(pending.observation)) throw new Error("Alternative evidence source changed after inspection");
    const criteria = this.judgments(args.criteria, specification.acceptanceCriteria.filter(criterion => criterion.required !== false && criterion.status !== "waived").map(criterion => criterion.id));
    if (!criteria.every(criterion => criterion.passed) || observed.exitCode !== 0) throw new Error("Alternative acceptance evidence failed; request repairs instead");
    const verificationId = `host-alternative-${digest([observationId, runId, taskId, this.bindingIdentity(binding)])}`, submission = digest(criteria);
    const replay = this.receipts ? await this.receipts.getEvidence(verificationId) : this.evidenceRecords.get(verificationId);
    if (replay) {
      if (replay.metadata?.hostAlternativeSubmission !== submission || !await this.authenticateEvidence(replay)) throw new Error("Conflicting completion for an immutable alternative observation");
      return { result: replay, assignment: assignment.message };
    }
    const artifact = await this.artifact(runId, taskId, { observation: observed, criteria, verifiedBy: binding.agentId });
    const result = VerificationResultSchema.parse({ schemaVersion: 2, verificationId, runId, taskId, cycleNumber: 1, attemptId: randomUUID(), status: "passed", independentExecution: true,
      evaluatedCriteria: criteria.map(criterion => ({ ...criterion, evidenceArtifactId: artifact.artifactId })), qualityGateResults: [], evidenceArtifacts: [artifact], findings: [],
      verifiedBy: binding.role, startedAt, completedAt: new Date().toISOString(), metadata: { conditionalTdd: { phase: "verification", decisionId: strategy.tddDecision.decisionId, specId: strategy.specId,
        sourceRevision: revision, testRevision: revision, testNames: strategy.criterionMappings.flatMap(mapping => mapping.testNames),
        observations: criteria.map(criterion => ({ method: "manual_review", criterionId: criterion.criterionId, evidenceArtifactId: artifact.artifactId, summary: criterion.summary })) }, hostAlternativeSubmission: submission } });
    await this.trustEvidence(result);
    return { result, assignment: assignment.message };
  }
}
