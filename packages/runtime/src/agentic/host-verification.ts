import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  ArtifactReferenceSchema, ArtifactWriteOptionsSchema, QualityGateContextSchema, QualityGateDefinitionSchema,
  QualityGateResultSchema, SpecificationSchema, TestStrategySchema, VerificationResultSchema,
  type ArtifactStore, type PaneBinding, type QualityGate, type QualityGateResult, type VerificationResult
} from "@bflow/contracts";
import { digest, json, record, textField } from "./journal.js";
import { unwrap } from "./outbox.js";
import type { AgenticWorkflowRuntime } from "./runtime.js";
const execute = promisify(execFile);
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
export class HostVerification {
  private readonly gateReceipts = new Map<string, string>();
  private readonly evidenceReceipts = new Map<string, string>();
  constructor(private readonly runtime: () => AgenticWorkflowRuntime, private readonly store: () => ArtifactStore) {}
  authenticateGate(result: QualityGateResult): boolean { return this.gateReceipts.get(result.evaluationId) === digest(result); }
  authenticateEvidence(result: VerificationResult): boolean { return this.evidenceReceipts.get(result.verificationId) === digest(result); }
  private async git(cwd: string, args: string[]): Promise<string> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
    return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "diff.external=", ...args], { cwd, env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
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
  private judgments(input: unknown, ids: string[]) {
    if (!Array.isArray(input)) throw new Error("Independent criterion judgments are required");
    const values = input.map(value => { const item = record(value); if (typeof item.passed !== "boolean") throw new Error("Criterion verdict must be boolean");
      return { criterionId: textField(item.criterionId), passed: item.passed, summary: textField(item.summary) }; });
    if (new Set(values.map(value => value.criterionId)).size !== values.length || digest(values.map(value => value.criterionId).sort()) !== digest([...ids].sort())) throw new Error("Review must cover exactly the assigned criteria");
    return values;
  }
  /** Capture objective revision/diff before the model evaluates it; the returned ID pins later judgment. */
  private readonly reviews = new Map<string, { bindingId: string; context: unknown; observation: Awaited<ReturnType<HostVerification["capture"]>> }>();
  async inspectReview(binding: PaneBinding, input: unknown) {
    if (!["reviewer", "qa", "tester"].includes(binding.role)) throw new Error("Independent verification role required");
    const args = record(input), state = record(await this.runtime().inspect());
    const out = (state.outbound as Record<string, unknown>[]).find(item => item.handle && record(record(item.handle).target).paneId === binding.paneId &&
      record(item.message).message_id === args.messageId && record(item.message).type === "verification.requested");
    if (!out) throw new Error("No verification request assigned to this pane");
    const context = QualityGateContextSchema.parse(record(out.message).payload), details = record(context.input);
    const observation = await this.capture(textField(details.sourceWorktreePath), textField(details.baseRevision), textField(details.sourceRevision));
    const reviewId = randomUUID(); this.reviews.set(reviewId, { bindingId: binding.bindingId, context, observation });
    return json({ reviewId, context, observation });
  }
  async completeReview(binding: PaneBinding, input: unknown) {
    const args = record(input), id = textField(args.reviewId), pending = this.reviews.get(id);
    if (!pending || pending.bindingId !== binding.bindingId) throw new Error("Review observation belongs to another pane or is missing");
    const context = QualityGateContextSchema.parse(pending.context), configuration = record(context.definition.configuration), details = record(context.input);
    if (configuration.kind !== "review" || configuration.role !== binding.role) throw new Error("Review role mismatch");
    const criteria = this.judgments(args.criteria, configuration.criterionIds as string[]);
    const observed = await this.capture(pending.observation.cwd, pending.observation.base, pending.observation.revision);
    if (digest(observed) !== digest(pending.observation)) throw new Error("Review source changed");
    const evidence = await this.artifact(context.runId, context.taskId!, { observation: observed, criteria, reviewedBy: binding.agentId });
    const result = QualityGateResultSchema.parse({ gateId: context.definition.id, runId: context.runId, taskId: context.taskId, evaluationId: randomUUID(),
      status: criteria.every(criterion => criterion.passed) && observed.exitCode === 0 ? "passed" : "failed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString(),
      metadata: { verification: { schemaVersion: 2, checkId: context.definition.id, runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
        sourceRevision: observed.revision, specFingerprint: details.specFingerprint, scope: details.scope, independentExecution: true, isolated: true, executorId: binding.agentId,
        role: binding.role, method: "manual_review", testNames: configuration.testNames, criteria, summary: textField(args.summary) }, evidence: json(evidence) } });
    this.gateReceipts.set(result.evaluationId, digest(result));
    return { result, artifact: evidence };
  }
  /** Alternative evidence is supported only for accepted manual-review documentation criteria. */
  private readonly alternatives = new Map<string, { bindingId: string; runId: string; taskId: string; observation: Awaited<ReturnType<HostVerification["capture"]>> }>();
  async inspectAlternative(binding: PaneBinding, input: unknown) {
    if (!["tester", "qa"].includes(binding.role)) throw new Error("Independent Tester or QA required");
    const args = record(input), runId = textField(args.runId), taskId = textField(args.taskId), state = record(await this.runtime().inspect());
    const run = record(await this.runtime().inspect(runId));
    const assignment = [...state.outbound as Record<string, unknown>[]].reverse().find(item => item.taskId === taskId && record(item.message).run_id === runId && record(item.message).type === "task.assignment" && item.handle);
    if (!assignment) throw new Error("Implementation assignment unavailable");
    const target = record(record(assignment.handle).target); if (target.agentId === binding.agentId) throw new Error("Implementer cannot verify its own change");
    const cwd = textField(target.worktreePath), revision = (await this.git(cwd, ["rev-parse", "HEAD"])).trim();
    const observation = await this.capture(cwd, textField(run.baseRevision), revision), observationId = randomUUID();
    this.alternatives.set(observationId, { bindingId: binding.bindingId, runId, taskId, observation });
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
    const pending = this.alternatives.get(textField(args.observationId));
    if (!pending || pending.bindingId !== binding.bindingId || pending.runId !== runId || pending.taskId !== taskId) throw new Error("Inspect the assigned alternative evidence before submitting a judgment");
    const startedAt = new Date().toISOString(), observed = await this.capture(cwd, textField(run.baseRevision), revision);
    if (digest(observed) !== digest(pending.observation)) throw new Error("Alternative evidence source changed after inspection");
    const criteria = this.judgments(args.criteria, specification.acceptanceCriteria.filter(criterion => criterion.required !== false && criterion.status !== "waived").map(criterion => criterion.id));
    if (!criteria.every(criterion => criterion.passed) || observed.exitCode !== 0) throw new Error("Alternative acceptance evidence failed; request repairs instead");
    const artifact = await this.artifact(runId, taskId, { observation: observed, criteria, verifiedBy: binding.agentId });
    const result = VerificationResultSchema.parse({ schemaVersion: 2, verificationId: randomUUID(), runId, taskId, cycleNumber: 1, attemptId: randomUUID(), status: "passed", independentExecution: true,
      evaluatedCriteria: criteria.map(criterion => ({ ...criterion, evidenceArtifactId: artifact.artifactId })), qualityGateResults: [], evidenceArtifacts: [artifact], findings: [],
      verifiedBy: binding.role, startedAt, completedAt: new Date().toISOString(), metadata: { conditionalTdd: { phase: "verification", decisionId: strategy.tddDecision.decisionId, specId: strategy.specId,
        sourceRevision: revision, testRevision: revision, testNames: strategy.criterionMappings.flatMap(mapping => mapping.testNames),
        observations: criteria.map(criterion => ({ method: "manual_review", criterionId: criterion.criterionId, evidenceArtifactId: artifact.artifactId, summary: criterion.summary })) } } });
    this.evidenceReceipts.set(result.verificationId, digest(result));
    return { result, assignment: assignment.message };
  }
}
