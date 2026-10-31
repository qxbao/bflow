import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ArtifactProposalSchema, ArtifactReferenceSchema, ArtifactWriteOptionsSchema, GitChangeSetSchema,
  OperationResultSchema, QualityGateContextSchema, QualityGateResultSchema,
  RoleMessageSchema, SpecificationSchema, VerificationCycleSchema, VerificationResultSchema,
  type ArtifactProposal, type ArtifactReference, type ArtifactStore, type GitChangeSet, type JsonValue, type QualityFinding,
  type QualityGate, type QualityGateResult, type RoleMessage, type Specification,
  type VerificationCycle, type VerificationResult
} from "@bflow/contracts";
import {
  CheckConfigurationSchema, ObservationSchema, covers, createVerificationPlan, digest,
  safePath, type CheckConfiguration, type Observation, type VerificationPlan
} from "./model.js";

export interface VerificationPorts {
  readonly artifactStore: ArtifactStore;
  readonly gates: readonly QualityGate[];
  /** Authoritative specification lookup, called before AND after all checks. */
  readonly loadSpecification: (specId: string) => Promise<Specification>;
  readonly clock?: () => string;
  /** Materialized proposal bytes from the trusted host runner; never an arbitrary agent path. */
  readonly readProposal?: (proposal: ArtifactProposal) => AsyncIterable<Uint8Array>;
}
const RepairSchema = z.object({
  taskId: z.string().min(1), role: z.literal("developer"), changeSetId: z.string().min(1), summary: z.string().trim().min(1)
}).strict();
const IntegrationSchema = z.object({ headCommitHash: z.string().regex(/^[a-f0-9]{7,40}$/i),
  integratedTaskIds: z.array(z.string().trim().min(1)).min(1) }).strict().superRefine((value, context) => {
    if (new Set(value.integratedTaskIds).size !== value.integratedTaskIds.length)
      context.addIssue({ code: "custom", message: "Integrated task IDs must be unique" });
  });
const OptionsSchema = z.object({
  integration: IntegrationSchema.optional(),
  repair: RepairSchema.optional()
}).strict();
const ReceiptSchema = z.object({
  gate: QualityGateResultSchema, observation: ObservationSchema,
  evidence: ArtifactReferenceSchema, outputArtifacts: z.array(ArtifactReferenceSchema).default([]), reused: z.boolean(), reason: z.string()
}).strict();
type CheckReceipt = z.infer<typeof ReceiptSchema>;
/** Gate error with the runner's optional, already-bounded diagnostics preserved for audit. */
class GateFailure extends Error {
  constructor(message: string, readonly details?: JsonValue) { super(message); }
}
class VerificationUnavailable extends GateFailure {}
class GateRejection extends GateFailure {}
/** Bounded one-line summary of error findings, so escalations name the failing check instead of a fixed category. */
function findingSummary(findings: readonly QualityFinding[]): string {
  const errors = findings.filter(finding => finding.severity === "error");
  if (!errors.length) return "";
  const parts = errors.slice(0, 3).map(finding => {
    const message = finding.message.replace(/\s+/g, " ");
    return `${finding.code}: ${message.length > 240 ? `${message.slice(0, 237)}...` : message}`;
  });
  return `: ${parts.join("; ")}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ""}`;
}

/** Stateless between submissions: Runtime persists the returned contract cycle.
 * Every call performs at most one verification iteration; never dispatches repairs. */
export class VerificationEngine {
  private readonly active = new Set<string>();
  private readonly gates = new Map<string, QualityGate>();
  private readonly now: () => string;
  constructor(private readonly ports: VerificationPorts) {
    this.now = ports.clock ?? (() => new Date().toISOString());
    for (const gate of ports.gates) {
      if (this.gates.has(gate.id)) throw new Error(`Duplicate gate: ${gate.id}`);
      this.gates.set(gate.id, gate);
    }
  }
  start(planInput: VerificationPlan, cycleId: string): VerificationCycle {
    const plan = this.plan(planInput);
    const at = this.now();
    return VerificationCycleSchema.parse({
      schemaVersion: 2, cycleId, runId: plan.runId, taskId: plan.taskId,
      specId: plan.specification.specId, verificationScope: plan.scope,
      currentIteration: 1, maxIterations: plan.maxIterations, status: "in_progress",
      tddDecision: plan.strategy.tddDecision, history: [], startedAt: at, updatedAt: at,
      metadata: { planId: plan.planId }
    });
  }
  private plan(input: VerificationPlan): VerificationPlan {
    const { planId, specFingerprint, ...value } = input;
    const plan = createVerificationPlan(value);
    if (planId !== plan.planId || specFingerprint !== plan.specFingerprint) throw new Error("Verification plan was modified");
    return plan;
  }
  private async read(reference: ArtifactReference): Promise<Buffer> {
    const ref = ArtifactReferenceSchema.parse(reference);
    const resolved = OperationResultSchema(ArtifactReferenceSchema.nullable()).parse(await this.ports.artifactStore.resolve(ref.artifactId));
    if (!resolved.ok || !resolved.value || digest(resolved.value) !== digest(ref)) throw new Error("Evidence not resolved by ArtifactStore");
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const item of this.ports.artifactStore.get(ref)) {
      const chunk = OperationResultSchema(z.instanceof(Uint8Array)).parse(item);
      if (!chunk.ok) throw new Error("Evidence unavailable");
      const owned = Buffer.from(chunk.value);
      length += owned.length;
      if (length > 16 * 1024 * 1024) throw new Error("Verification evidence exceeds 16 MiB read limit");
      chunks.push(owned);
    }
    const data = Buffer.concat(chunks);
    if (createHash(ref.checksum.algorithm).update(data).digest("hex").toLowerCase() !== ref.checksum.value.toLowerCase() ||
        (ref.sizeBytes !== undefined && ref.sizeBytes !== data.length)) throw new Error("Evidence integrity mismatch");
    return data;
  }
  private async store(plan: VerificationPlan, key: string, body: unknown, kind: "log" | "report" | "test-result" = "report"): Promise<ArtifactReference> {
    const bytes = Buffer.from(JSON.stringify(body));
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const artifactId = `verification-${digest({ key, checksum })}`;
    const options = ArtifactWriteOptionsSchema.parse({
      artifactId, runId: plan.runId, taskId: plan.taskId, kind, mediaType: "application/json",
      expectedIntegrity: { checksum: { algorithm: "sha256", value: checksum }, sizeBytes: bytes.length },
      idempotencyKey: artifactId
    });
    const result = OperationResultSchema(ArtifactReferenceSchema).parse(await this.ports.artifactStore.put({
      options, content: (async function* () { yield bytes; })()
    }));
    if (!result.ok) throw new Error(`Cannot persist verification audit: ${result.error.message}`);
    const ref = result.value;
    if (ref.artifactId !== artifactId || ref.runId !== plan.runId || ref.taskId !== plan.taskId ||
        ref.kind !== kind || ref.checksum.algorithm !== "sha256" || ref.checksum.value !== checksum)
      throw new Error("ArtifactStore returned mismatched audit reference");
    await this.read(ref);
    return ref;
  }
  private async ingest(plan: VerificationPlan, proposals: ArtifactProposal[]): Promise<ArtifactReference[]> {
    const artifacts: ArtifactReference[] = [];
    for (const value of proposals) {
      const proposal = ArtifactProposalSchema.parse(value);
      if (proposal.runId !== plan.runId || proposal.taskId !== plan.taskId || !this.ports.readProposal)
        throw new Error("Gate proposals need run/task-correlated materialized evidence bytes");
      const artifactId = `verification-output-${digest(proposal)}`;
      const options = ArtifactWriteOptionsSchema.parse({ artifactId, runId: plan.runId, taskId: plan.taskId,
        kind: proposal.kind, mediaType: proposal.mediaType, expectedIntegrity: proposal.expectedIntegrity,
        idempotencyKey: artifactId });
      const result = OperationResultSchema(ArtifactReferenceSchema).parse(await this.ports.artifactStore.put({
        options, content: this.ports.readProposal(proposal)
      }));
      if (!result.ok) throw new Error(`Proposal ingestion failed: ${result.error.message}`);
      const reference = result.value;
      if (reference.artifactId !== artifactId || reference.runId !== plan.runId || reference.taskId !== plan.taskId ||
          reference.kind !== proposal.kind || digest(reference.checksum) !== digest(proposal.expectedIntegrity.checksum))
        throw new Error("ArtifactStore returned mismatched proposal reference");
      await this.read(reference);
      artifacts.push(reference);
    }
    return artifacts;
  }
  private finding(plan: VerificationPlan, code: string, message: string, role = "developer", extra: Record<string, JsonValue> = {}): QualityFinding {
    return { code, severity: "error", message, details: { taskId: plan.taskId, responsibleRole: role, requiresNewTaskIfOutsideScope: true, ...extra } };
  }
  private async current(plan: VerificationPlan): Promise<boolean> {
    const spec = SpecificationSchema.parse(await this.ports.loadSpecification(plan.specification.specId));
    return digest(spec) === plan.specFingerprint && spec.status === "approved";
  }
  private validateObservation(plan: VerificationPlan, change: GitChangeSet, config: CheckConfiguration, gate: QualityGateResult): Observation {
    const obs = ObservationSchema.parse(gate.metadata?.verification);
    if (obs.checkId !== gate.gateId || obs.runId !== plan.runId || obs.taskId !== plan.taskId ||
        obs.attemptId !== change.attemptId || obs.sourceRevision !== change.headCommitHash ||
        obs.specFingerprint !== plan.specFingerprint || obs.scope !== plan.scope || obs.method !== config.method ||
        obs.role !== config.role || plan.implementerIds.includes(obs.executorId)) throw new Error("Uncorrelated or non-independent observation");
    const ids = obs.criteria.map(c => c.criterionId);
    if (new Set(ids).size !== ids.length || digest([...ids].sort()) !== digest([...config.criterionIds].sort()) ||
        config.testNames.some(name => !obs.testNames.includes(name))) throw new Error("Missing or conflicting criterion/test evidence");
    if (config.kind === "deterministic" && (obs.command !== config.command || obs.exitCode === undefined))
      throw new Error("Automated evidence requires exact command and integer exit code");
    if (config.measuresCoverage && plan.strategy.coverageThresholdPercent !== undefined && obs.coveragePercent === undefined)
      throw new Error("Aggregate coverage measurement is missing");
    return obs;
  }
  private checkPassed(plan: VerificationPlan, config: CheckConfiguration, receipt: CheckReceipt, criterionId?: string): boolean {
    const relevantCriteria = criterionId
      ? receipt.observation.criteria.filter(c => c.criterionId === criterionId)
      : receipt.observation.criteria.filter(c => {
          const specCrit = plan.specification.acceptanceCriteria.find(ac => ac.id === c.criterionId);
          return !specCrit || (specCrit.required !== false && specCrit.status !== "waived");
        });
    return receipt.gate.status === "passed" && relevantCriteria.every(c => c.passed) &&
      (receipt.observation.exitCode === undefined ? config.kind === "review" : receipt.observation.exitCode === 0) &&
      !receipt.gate.findings.some(f => f.severity === "error") &&
      (!config.measuresCoverage || plan.strategy.coverageThresholdPercent === undefined ||
        (receipt.observation.coveragePercent ?? -1) >= plan.strategy.coverageThresholdPercent);
  }
  private async evaluate(plan: VerificationPlan, change: GitChangeSet, definition: VerificationPlan["checks"][number], integration?: z.infer<typeof IntegrationSchema>): Promise<QualityGateResult> {
    const gate = this.gates.get(definition.id);
    if (!gate) throw new VerificationUnavailable(`Missing runner for ${definition.id}`);
    const context = QualityGateContextSchema.parse({
      runId: plan.runId, taskId: plan.taskId, attemptId: change.attemptId, definition,
      artifacts: [change.patchArtifact, plan.specification.artifactRef!],
      input: { specId: plan.specification.specId, specFingerprint: plan.specFingerprint,
        sourceRevision: change.headCommitHash, baseRevision: change.baseCommitHash,
        sourceWorktreePath: change.worktreePath, branchName: change.branchName,
        scope: plan.scope, changeSetId: change.changeSetId,
        implementerIds: plan.implementerIds, ...(integration ? { integration } : {}) }
    });
    const dispatchedAt = this.now();
    const controller = new AbortController();
    // Timer overflow must never turn a long configured timeout into 1 ms.
    const remaining = definition.timeout.deadline ? Date.parse(definition.timeout.deadline) - Date.parse(this.now()) : Infinity;
    const ms = Math.min(definition.timeout.executionTimeoutMs, 2_147_483_647, remaining);
    if (ms <= 0) throw new VerificationUnavailable("Verification check deadline expired before dispatch");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = Promise.resolve().then(() => gate.evaluate(context, { signal: controller.signal, timeoutMs: ms }))
        .catch(error => { throw new VerificationUnavailable(String(error)); });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new VerificationUnavailable("Verification runner timed out; remote stop is unproven")); }, ms);
      });
      const response = OperationResultSchema(QualityGateResultSchema).parse(await Promise.race([operation, timeout]));
      if (!response.ok) {
        if (response.error.code === "validation") throw new GateRejection(response.error.message, response.error.details);
        throw new VerificationUnavailable(response.error.message, response.error.details);
      }
      const result = response.value;
      if (Date.parse(result.evaluatedAt) < Date.parse(dispatchedAt) || Date.parse(result.evaluatedAt) > Date.parse(this.now()))
        throw new Error("Gate evidence was evaluated outside the current execution window");
      if (result.gateId !== definition.id || result.runId !== plan.runId || result.taskId !== plan.taskId)
        throw new Error("Gate result correlation mismatch");
      return result;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async verify(planInput: VerificationPlan, cycleInput: unknown, changeInput: unknown, optionsInput: unknown = {}): Promise<{ result: VerificationResult; cycle: VerificationCycle; messages: RoleMessage[] }> {
    const plan = this.plan(planInput);
    const cycle = VerificationCycleSchema.parse(cycleInput);
    const change = GitChangeSetSchema.parse(changeInput);
    const options = OptionsSchema.parse(optionsInput);
    if (cycle.runId !== plan.runId || cycle.taskId !== plan.taskId || cycle.specId !== plan.specification.specId ||
        cycle.verificationScope !== plan.scope || cycle.maxIterations !== plan.maxIterations ||
        cycle.metadata?.planId !== plan.planId || digest(cycle.tddDecision) !== digest(plan.strategy.tddDecision))
      throw new Error("Cycle does not match frozen plan");
    if (change.runId !== plan.runId || change.taskId !== plan.taskId) throw new Error("ChangeSet run/task mismatch");
    if (!["in_progress", "rework_required"].includes(cycle.status)) throw new Error("Cycle is terminal; human/new-cycle decision required");
    if (this.active.has(cycle.cycleId)) throw new Error("Verification already active for cycle");
    this.active.add(cycle.cycleId);
    try { return await this.perform(plan, cycle, change, options); }
    finally { this.active.delete(cycle.cycleId); }
  }
  private async perform(plan: VerificationPlan, cycle: VerificationCycle, change: GitChangeSet, options: z.infer<typeof OptionsSchema>): Promise<{ result: VerificationResult; cycle: VerificationCycle; messages: RoleMessage[] }> {
    const startedAt = this.now();
    const previous = cycle.history.at(-1);
    let iteration = 1;
    if (previous) {
      const receipt = ArtifactReferenceSchema.parse(cycle.metadata?.verificationReceipt);
      const persisted = JSON.parse((await this.read(receipt)).toString("utf8")) as unknown;
      const snapshot = z.object({ result: VerificationResultSchema, cycle: VerificationCycleSchema }).strict().parse(persisted);
      const { verificationReceipt: _receipt, ...metadata } = cycle.metadata ?? {};
      if (digest({ ...cycle, metadata }) !== digest(snapshot.cycle) || digest(previous) !== digest(snapshot.result))
        throw new Error("Cycle differs from persisted verification receipt");
      if (cycle.history.length !== cycle.currentIteration || previous.cycleNumber !== cycle.currentIteration ||
          previous.status !== "failed" || cycle.status !== "rework_required") throw new Error("Invalid cycle history");
      if (!options.repair || options.repair.taskId !== plan.taskId || options.repair.changeSetId !== change.changeSetId)
        throw new Error("Rework needs a correlated repair record");
      if (cycle.history.some(result => change.attemptId === result.attemptId ||
          change.changeSetId === result.changeSet?.changeSetId || change.headCommitHash === result.changeSet?.headCommitHash))
        throw new Error("Rework needs a new attempt and Git change not used anywhere in this cycle");
      iteration = cycle.currentIteration + 1;
    } else if (cycle.currentIteration !== 1 || cycle.status !== "in_progress") throw new Error("Invalid initial cycle");
    if (iteration > cycle.maxIterations) throw new Error("Verification iteration limit reached");
    const key = `${cycle.cycleId}:${iteration}:${change.attemptId}`;
    // Durable intent precedes any runner side effect, including rework provenance.
    const intent = await this.store(plan, `${key}:intent`, { plan, cycleId: cycle.cycleId, iteration, change, options, startedAt }, "log");
    const findings: QualityFinding[] = [];
    const receipts: CheckReceipt[] = [];
    const failedChecks: { checkId: string; code: string; message: string; diagnostics?: JsonValue }[] = [];
    const gateResults: QualityGateResult[] = [];
    let conflict = false, blocked = false, inconclusive = false, failed = false;
    try {
      if (!(await this.current(plan))) { conflict = true; findings.push(this.finding(plan, "spec_changed", "Specification changed; obtain a new approved plan", "architect")); }
      const artifactSpec = JSON.parse((await this.read(plan.specification.artifactRef!)).toString("utf8")) as unknown;
      // P15 stores requirements without approval lifecycle fields; reconstruct the exported schema at ingress.
      const { artifactRef: _specRef, status: _status, approvedBy: _approvedBy, updatedAt: _updatedAt, ...specBody } = plan.specification;
      const parsedBody = z.record(z.unknown()).parse(artifactSpec);
      const { artifactRef: _storedRef, status: _storedStatus, approvedBy: _storedApproval, updatedAt: _storedTime, ...storedBody } = parsedBody;
      SpecificationSchema.parse({ ...storedBody, status: plan.specification.status, approvedBy: plan.specification.approvedBy,
        updatedAt: plan.specification.updatedAt, artifactRef: plan.specification.artifactRef });
      if (digest(specBody) !== digest(storedBody)) { conflict = true; findings.push(this.finding(plan, "spec_artifact_mismatch", "Stored specification does not match approved content", "architect")); }
      await this.read(change.patchArtifact);
      if (change.patchArtifact.taskId !== plan.taskId || change.dirtyWorkingTree) {
        blocked = true; findings.push(this.finding(plan, "unverified_git_snapshot", "Need a clean, task-correlated immutable Git patch", "coordinator"));
      }
      const paths = change.filesChanged.flatMap(f => f.previousPath ? [f.path, f.previousPath] : [f.path]);
      if (paths.some(path => !safePath(path) || !plan.specification.affectedPaths.some(prefix => covers(prefix, path)))) {
        conflict = true; findings.push(this.finding(plan, "out_of_scope", "Change outside accepted scope; create a new task and obtain approval", "coordinator"));
      }
      if (plan.scope === "workflow" && (!options.integration || options.integration.headCommitHash !== change.headCommitHash ||
          plan.specification.traceabilityTaskIds?.some(id => !options.integration!.integratedTaskIds.includes(id)))) {
        blocked = true; findings.push(this.finding(plan, "integration_required", "Workflow verification requires the integrated Git revision and every specification-traced task", "coordinator"));
      }
    } catch (error) {
      blocked = true; findings.push(this.finding(plan, "evidence_unavailable", String(error), "qa"));
    }
    if (!conflict && !blocked) {
      for (const definition of plan.checks) {
        const config = CheckConfigurationSchema.parse(definition.configuration);
        try {
          let receipt: CheckReceipt | undefined;
          // Reuse requires a complete trusted impact declaration AND a contiguous diff.
          if (plan.scope === "task" && previous?.changeSet?.headCommitHash === change.baseCommitHash && config.dependsOnPaths) {
            const changed = change.filesChanged.flatMap(f => f.previousPath ? [f.path, f.previousPath] : [f.path]);
            if (!changed.some(path => config.dependsOnPaths!.some(prefix => covers(prefix, path)))) {
              const prior = z.array(ReceiptSchema).parse(previous.metadata?.checks).find(r => r.gate.gateId === definition.id);
              if (prior && this.checkPassed(plan, config, prior)) {
                for (const artifact of prior.outputArtifacts) await this.read(artifact);
                const verified = JSON.parse((await this.read(prior.evidence)).toString("utf8")) as unknown;
                const stored = z.object({ gate: QualityGateResultSchema, observation: ObservationSchema }).strict().parse(verified);
                if (digest(stored) !== digest({ gate: prior.gate, observation: prior.observation })) throw new Error("Prior check receipt mismatch");
                receipt = { ...prior, reused: true, reason: "No changed/renamed file intersects exhaustive check dependencies; contiguous Git diff and frozen specification" };
              }
            }
          }
          if (!receipt) {
            const gate = await this.evaluate(plan, change, definition, options.integration);
            // Store raw gate output before validating its observation, including malformed evidence.
            await this.store(plan, `${key}:${definition.id}:raw`, gate, "log");
            const observation = this.validateObservation(plan, change, config, gate);
            const outputArtifacts = await this.ingest(plan, gate.producedArtifacts);
            const evidence = await this.store(plan, `${key}:${definition.id}`, { gate, observation }, config.kind === "review" ? "report" : "test-result");
            receipt = { gate, observation, evidence, outputArtifacts, reused: false,
              reason: plan.scope === "workflow" ? "Post-integration verification always executes afresh" : "New, failed or potentially impacted check; no safe reuse established" };
          }
          if (config.measuresCoverage && plan.strategy.coverageThresholdPercent !== undefined &&
              (receipt.observation.coveragePercent ?? -1) < plan.strategy.coverageThresholdPercent) {
            failed = true;
            findings.push(this.finding(plan, "coverage_below_threshold", `${definition.id}: coverage is below accepted strategy threshold`));
          }
          receipts.push(receipt);
          gateResults.push(receipt.gate);
          findings.push(...receipt.gate.findings.map(f => ({ ...f, details: { original: f.details ?? null, taskId: plan.taskId, responsibleRole: "developer", requiresNewTaskIfOutsideScope: true } })));
          if (receipt.gate.status === "blocked" || receipt.gate.status === "error") {
            blocked = true;
            findings.push(this.finding(plan, "environment_blocked", `${definition.id}: ${receipt.gate.error?.message ?? "Independent check blocked"}`, "coordinator"));
          }
          const failedCriteria = receipt.observation.criteria.filter(c => !c.passed);
          const hasFailedRequiredCriterion = failedCriteria.some(c => {
            const specCrit = plan.specification.acceptanceCriteria.find(ac => ac.id === c.criterionId);
            return !specCrit || (specCrit.required !== false && specCrit.status !== "waived");
          });
          const checkItselfFailed = receipt.gate.status === "failed" ||
            (receipt.observation.exitCode !== undefined && receipt.observation.exitCode !== 0) ||
            receipt.gate.findings.some(f => f.severity === "error");

          if (checkItselfFailed || hasFailedRequiredCriterion) {
            failed = true;
          }
          if (checkItselfFailed || failedCriteria.length > 0) {
            const targets = failedCriteria.length ? failedCriteria : [{ criterionId: undefined, summary: receipt.observation.summary }];
            let emittedErrorForCheck = false;
            for (const target of targets) {
              const specCrit = target.criterionId ? plan.specification.acceptanceCriteria.find(ac => ac.id === target.criterionId) : undefined;
              const isOptional = Boolean(specCrit && (specCrit.required === false || specCrit.status === "waived"));
              if (!isOptional) emittedErrorForCheck = true;
              findings.push({
                ...this.finding(plan, "check_failed", `${definition.id}: ${target.summary}`),
                severity: isOptional ? "warning" : "error",
                artifactId: receipt.evidence.artifactId,
                details: { taskId: plan.taskId, responsibleRole: "developer", checkId: definition.id,
                  ...(target.criterionId ? { criterionId: target.criterionId } : {}), requiresNewTaskIfOutsideScope: true }
              });
            }
            if (checkItselfFailed && !emittedErrorForCheck) {
              findings.push({
                ...this.finding(plan, "check_failed", `${definition.id}: ${receipt.observation.summary}`),
                severity: "error",
                artifactId: receipt.evidence.artifactId,
                details: { taskId: plan.taskId, responsibleRole: "developer", checkId: definition.id, requiresNewTaskIfOutsideScope: true }
              });
            }
          }
        } catch (error) {
          if (error instanceof VerificationUnavailable) blocked = true; else inconclusive = true;
          const code = error instanceof VerificationUnavailable ? "runner_unavailable" : "invalid_or_missing_evidence";
          const diagnostics = error instanceof GateFailure ? error.details : undefined;
          findings.push(this.finding(plan, code, `${definition.id}: ${String(error)}`, config.kind === "review" ? config.role : "qa",
            diagnostics === undefined ? {} : { runnerDiagnostics: diagnostics }));
          failedChecks.push({ checkId: definition.id, code, message: String(error), ...(diagnostics === undefined ? {} : { diagnostics }) });
        }
      }
      try {
        if (!(await this.current(plan))) { conflict = true; findings.push(this.finding(plan, "spec_changed", "Specification changed during verification; existing results cannot accept it", "architect")); }
      } catch (error) { blocked = true; findings.push(this.finding(plan, "spec_unavailable", String(error), "coordinator")); }
    }
    if (failed && !findings.some(f => f.severity === "error")) findings.push(this.finding(plan, "check_failed", "Independent test/review failed; fix the assigned task"));
    const status: VerificationResult["status"] = conflict ? "escalated" : blocked ? "blocked" : inconclusive ? "inconclusive" : failed ? "failed" : "passed";
    const completedAt = this.now();
    const audit = await this.store(plan, `${key}:audit`, {
      intent, changeSet: change, iteration, status, findings, checks: receipts, failedChecks, options,
      ...(options.integration ? {
        integrationCommitHash: options.integration.headCommitHash,
        integratedTaskIds: options.integration.integratedTaskIds
      } : {})
    }, "report");
    const evaluatedCriteria = plan.specification.acceptanceCriteria.map(criterion => {
      const isWaived = criterion.status === "waived";
      const isWaivedByIdenticalTree = plan.reviewWaiver?.kind === "identical_integrated_tree" && criterion.verificationMethod === "manual_review";
      const relevant = receipts.filter(r => r.observation.criteria.some(c => c.criterionId === criterion.id));
      const primary = relevant.find(r => r.observation.method === criterion.verificationMethod);
      const observation = primary?.observation.criteria.find(c => c.criterionId === criterion.id);
      const expectedChecks = plan.checks.filter(check => CheckConfigurationSchema.parse(check.configuration).criterionIds.includes(criterion.id));
      const missing = expectedChecks.filter(check => !relevant.some(r => r.gate.gateId === check.id));

      if ((isWaived || isWaivedByIdenticalTree) && expectedChecks.length === 0) {
        return {
          criterionId: criterion.id,
          passed: isWaived ? true : (!conflict && !blocked && !inconclusive && !failed),
          evidenceArtifactId: audit.artifactId,
          summary: isWaived
            ? (criterion.waiverReason ? `Waived: ${criterion.waiverReason}` : "Criterion waived")
            : `Satisfied by verified task tree (${plan.reviewWaiver?.kind === "identical_integrated_tree" ? plan.reviewWaiver.taskVerificationIds.join(", ") : ""})`
        };
      }

      const isOptional = criterion.required === false;
      const passed = Boolean(primary && missing.length === 0 && relevant.every(receipt => {
        const definition = expectedChecks.find(check => check.id === receipt.gate.gateId)!;
        return this.checkPassed(plan, CheckConfigurationSchema.parse(definition.configuration), receipt, criterion.id);
      }));
      return { criterionId: criterion.id, passed: !conflict && !blocked && !inconclusive && (isWaived || passed || (!failed && isOptional)),
        ...(primary?.observation.command !== undefined ? { command: primary.observation.command } : {}),
        ...(primary?.observation.exitCode !== undefined ? { exitCode: primary.observation.exitCode } : {}),
        evidenceArtifactId: primary?.evidence.artifactId ?? audit.artifactId,
        summary: isWaived ? (criterion.waiverReason ? `Waived: ${criterion.waiverReason}` : "Criterion waived") :
          (!passed && isOptional) ? (observation?.summary ? `Optional criterion not satisfied: ${observation.summary}` : "Optional criterion not satisfied") :
          missing.length ? `Missing valid evidence from ${missing.map(check => check.id).join(", ")}; see verification audit` :
          observation?.summary ?? "No valid independent evidence; see verification audit" };
    });
    const evidenceArtifacts = [intent, audit, change.patchArtifact, ...receipts.flatMap(r => [r.evidence, ...r.outputArtifacts])]
      .filter((ref, index, all) => all.findIndex(r => r.artifactId === ref.artifactId) === index);
    const result = VerificationResultSchema.parse({
      schemaVersion: 2, verificationId: `verify-${digest(key)}`, runId: plan.runId, taskId: plan.taskId,
      cycleNumber: iteration, attemptId: change.attemptId, status, verificationScope: plan.scope,
      independentExecution: true, evaluatedCriteria, qualityGateResults: gateResults, evidenceArtifacts,
      findings, changeSet: change, verifiedBy: "quality_gate", startedAt, completedAt,
      metadata: {
        planId: plan.planId,
        specFingerprint: plan.specFingerprint,
        checks: receipts,
        ...(options.repair ? { repair: options.repair } : {}),
        ...(options.integration ? {
          integrationCommitHash: options.integration.headCommitHash,
          integratedTaskIds: options.integration.integratedTaskIds
        } : {})
      }
    });
    // Missing evidence and infrastructure issues stop immediately; only known code failures receive rework.
    const escalate = status !== "passed" && (status !== "failed" || iteration >= cycle.maxIterations);
    const { verificationReceipt: _priorReceipt, ...cleanMetadata } = cycle.metadata ?? {};
    const next = VerificationCycleSchema.parse({ ...cycle, currentIteration: iteration, updatedAt: completedAt,
      status: status === "passed" ? "passed" : escalate ? "escalated" : "rework_required",
      history: [...cycle.history, result],
      ...(escalate ? { escalation: { escalatedAt: completedAt, reason: (conflict ? "Specification/scope conflict" :
        status === "inconclusive" ? "Missing or invalid objective evidence" : status === "blocked" ? "Verification environment blocked; reconcile before retry" :
        "Verification iteration limit exhausted") + (status === "blocked" || status === "inconclusive" ? findingSummary(findings) : ""), target: "human_operator", evidenceArtifacts } } : {}),
      metadata: { ...cleanMetadata, planId: plan.planId }
    });
    const persisted = await this.store(plan, `${key}:result`, { result, cycle: next });
    const returned = VerificationCycleSchema.parse({ ...next, metadata: { ...next.metadata, verificationReceipt: persisted } });
    const messages = [RoleMessageSchema.parse({
      schema_version: 2, message_id: result.verificationId, correlation_id: cycle.cycleId,
      run_id: plan.runId, sender: { role: "qa" }, recipient: { role: "coordinator" },
      type: "verification.result", payload: result, artifact_references: evidenceArtifacts, occurred_at: completedAt
    })];
    if (next.escalation) messages.push(RoleMessageSchema.parse({
      schema_version: 2, message_id: `escalate-${digest(key)}`, correlation_id: cycle.cycleId,
      causation_id: result.verificationId, run_id: plan.runId,
      sender: { role: "qa" }, recipient: { role: "coordinator" }, type: "verification.escalation",
      payload: next.escalation, artifact_references: evidenceArtifacts, occurred_at: completedAt
    }));
    return { result, cycle: returned, messages };
  }
}
