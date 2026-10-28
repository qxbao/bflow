import { createHash } from "node:crypto";
import type { ArtifactReference, VerificationCycle, VerificationResult } from "@bflow/contracts";
import { redactString } from "../resilience/redaction.js";
import { digest, type RunRecord, type TaskRecord } from "../agentic/journal.js";
import { ARTIFACT_READ_LIMIT, type HandoverSnapshot, type HandoverSources } from "./sources.js";
import {
  HandoverDocumentSchema, type EvidenceIntegrity, type HandoverApproval, type HandoverCheck, type HandoverDocument,
  type HandoverEvidence, type HandoverMatrixRow, type HandoverPackaging, type HandoverReason, type HandoverVerdict
} from "./schema.js";

/** Runtime's integrated workflow-verification task id (see agentic/runtime.ts FINAL_TASK). */
const WORKFLOW_TASK = "workflow-verification";

/** Evidence kinds that may be copied into a package on request. Logs and raw agent output stay references only. */
export const PACKAGEABLE_KINDS: ReadonlySet<string> = new Set(["test-result", "report", "patch", "document"]);
export const EVIDENCE_FILE_LIMIT = 1024 * 1024;
export const EVIDENCE_TOTAL_LIMIT = 16 * 1024 * 1024;

export interface HandoverAttachment { readonly path: string; readonly bytes: Buffer }
export interface HandoverBuild { readonly document: HandoverDocument; readonly attachments: readonly HandoverAttachment[] }
export interface HandoverBuildOptions { readonly includeEvidence?: boolean | undefined }

type Scrub = (value: unknown, max?: number) => string;
function scrubber(paths: readonly string[]): { field: Scrub; body: (text: string) => string } {
  const sorted = [...new Set(paths.filter(path => path.length > 1))].sort((a, b) => b.length - a.length);
  const unpath = (text: string) => { for (const path of sorted) text = text.split(path).join("<repository>"); return text; };
  return {
    field: (value, max = 2000) => {
      const text = unpath(redactString(String(value ?? "")).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " "));
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    },
    // Packaged evidence keeps its line structure; the same redaction and path rules apply, without truncation.
    body: text => unpath(redactString(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " "))
  };
}
const utf8 = new TextDecoder("utf-8", { fatal: true });

const latest = (cycle: VerificationCycle | undefined): VerificationResult | undefined => cycle?.history.at(-1);
const sameEvidence = (a: readonly ArtifactReference[], b: readonly ArtifactReference[]) =>
  digest(a.map(ref => [ref.artifactId, ref.checksum]).sort()) === digest(b.map(ref => [ref.artifactId, ref.checksum]).sort());

/** Every gate of a result must name the same source revision as its change set; absent metadata leaves only the change set. */
function resultRevision(result: VerificationResult): { revision: string | null; consistent: boolean } {
  const revision = result.changeSet?.headCommitHash ?? null;
  const checks = Array.isArray(result.metadata?.checks) ? result.metadata.checks as unknown[] : [];
  const sources = checks.map(check => (check as { gate?: { metadata?: { verification?: { sourceRevision?: unknown } } } })?.gate?.metadata?.verification?.sourceRevision)
    .filter((value): value is string => typeof value === "string");
  return { revision, consistent: sources.every(source => source === revision) };
}

export async function buildHandover(snapshot: HandoverSnapshot, sources: HandoverSources, options: HandoverBuildOptions = {}): Promise<HandoverBuild> {
  const run = snapshot.run, runId = run.runId;
  const { field: scrub, body: scrubBody } = scrubber([snapshot.repository]);
  const spec = run.workflowSpec?.specification;
  const definitions = run.definition?.tasks ?? [];
  const integratedRevision = run.workflowChange?.headCommitHash ?? null;
  const workflowResult = latest(run.workflowCycle);
  const taskRecord = (taskId: string): TaskRecord | undefined => run.tasks.find(task => task.taskId === taskId);

  // Collect references once; conflicting checksums for one id are an identity failure, never a choice of one.
  const references = new Map<string, ArtifactReference>(), conflicting = new Set<string>();
  const collect = (reference: ArtifactReference | undefined) => {
    if (!reference) return;
    const known = references.get(reference.artifactId);
    if (known && digest(known) !== digest(reference)) conflicting.add(reference.artifactId);
    else references.set(reference.artifactId, reference);
  };
  collect(spec?.artifactRef);
  for (const task of run.tasks) { collect(task.changeSet?.patchArtifact); latest(task.cycle)?.evidenceArtifacts.forEach(collect); }
  collect(run.workflowChange?.patchArtifact);
  workflowResult?.evidenceArtifacts.forEach(collect);
  if (run.approvalKind === "delivery") run.approval?.evidence.forEach(collect);

  const taskIds = new Set([...definitions.map(task => task.id), ...run.tasks.map(task => task.taskId), WORKFLOW_TASK]);
  const integrity = new Map<string, EvidenceIntegrity>();
  const packaging = new Map<string, HandoverPackaging>(), attachments = new Map<string, Buffer>();
  let specificationBytes: Buffer | undefined, packagedBytes = 0;
  for (const [artifactId, reference] of [...references].sort(([a], [b]) => a.localeCompare(b))) {
    const packageable = options.includeEvidence === true && PACKAGEABLE_KINDS.has(reference.kind);
    if (conflicting.has(artifactId) || reference.runId !== runId || (reference.taskId !== undefined && !taskIds.has(reference.taskId))) {
      integrity.set(artifactId, "identity_mismatch");
      packaging.set(artifactId, { status: "not_packaged", reason: !options.includeEvidence ? "not_requested" : packageable ? "not_verified" : "kind_not_allowed" });
      continue;
    }
    const isSpecification = artifactId === spec?.artifactRef?.artifactId;
    const observed = await sources.readArtifact(reference, isSpecification ? ARTIFACT_READ_LIMIT : packageable ? EVIDENCE_FILE_LIMIT : 0);
    integrity.set(artifactId, observed.integrity);
    if (isSpecification) specificationBytes = observed.bytes;
    // Sorted artifact order makes the size budget, and so the package content, deterministic for one snapshot.
    packaging.set(artifactId, ((): HandoverPackaging => {
      if (!options.includeEvidence) return { status: "not_packaged", reason: "not_requested" };
      if (!packageable) return { status: "not_packaged", reason: "kind_not_allowed" };
      if (observed.integrity !== "verified") return { status: "not_packaged", reason: "not_verified" };
      if (!observed.bytes || observed.bytes.length > EVIDENCE_FILE_LIMIT) return { status: "not_packaged", reason: "too_large" };
      let original: string;
      try { original = utf8.decode(observed.bytes); } catch { return { status: "not_packaged", reason: "not_text" }; }
      if (original.includes("\u0000")) return { status: "not_packaged", reason: "not_text" };
      const text = scrubBody(original), bytes = Buffer.from(text, "utf8");
      if (packagedBytes + bytes.length > EVIDENCE_TOTAL_LIMIT) return { status: "not_packaged", reason: "total_limit" };
      const sha256 = createHash("sha256").update(bytes).digest("hex"), path = `evidence/${sha256}.txt`;
      if (!attachments.has(path)) { attachments.set(path, bytes); packagedBytes += bytes.length; }
      return { status: "packaged", path, sha256, bytes: bytes.length, redacted: text !== original };
    })());
  }
  const evidenceOf = (reference: ArtifactReference): HandoverEvidence => ({
    artifactId: reference.artifactId, uri: reference.uri, kind: reference.kind, mediaType: scrub(reference.mediaType, 200),
    ...(reference.taskId ? { taskId: reference.taskId } : {}), checksum: reference.checksum,
    integrity: integrity.get(reference.artifactId) ?? "unavailable",
    packaging: packaging.get(reference.artifactId) ?? { status: "not_packaged", reason: "not_requested" }
  });

  let specificationBinding: "bound" | "mismatch" | "unverified" = "unverified";
  if (spec?.artifactRef && integrity.get(spec.artifactRef.artifactId) === "verified" && specificationBytes) {
    try {
      const stored = JSON.parse(specificationBytes.toString("utf8")) as { specId?: unknown };
      const declared = run.workflowSpec!.request.metadata?.specificationDigest;
      specificationBinding = stored.specId === spec.specId && (declared === undefined || declared === spec.artifactRef.checksum.value) ? "bound" : "mismatch";
    } catch { specificationBinding = "mismatch"; }
  }

  // Approvals, with the binding rules the Runtime applies when it creates and accepts them.
  const superseded = new Set((run.supersededApprovals ?? []).map(item => item.approvalId));
  const approvals: HandoverApproval[] = [];
  if (run.workflowSpec) {
    const { request, decision } = run.workflowSpec, reasons: string[] = [];
    let validity: HandoverApproval["validity"] = !decision ? "pending" : decision.decision !== "approved" ? "refused" : "valid";
    if (decision && (decision.approvalId !== request.approvalId || decision.runId !== runId)) { validity = "stale"; reasons.push("Decision is bound to another request"); }
    if (spec?.status !== "approved") { if (validity === "valid") validity = "stale"; reasons.push(`Specification status is ${spec?.status}`); }
    if (superseded.has(request.approvalId)) { validity = "superseded"; reasons.push("Superseded by a requirement revision"); }
    approvals.push({ approvalId: request.approvalId, kind: "specification", target: `specification ${spec?.specId ?? "unknown"}`,
      requestedAt: request.requestedAt, decision: decision?.decision ?? "pending", ...(decision ? { decidedBy: scrub(decision.decidedBy, 200), decidedAt: decision.decidedAt } : {}),
      validity, reasons });
  }
  let deliveryValidity: HandoverApproval["validity"] | undefined;
  if (run.approval && (run.approvalKind === "delivery" || run.approvalKind === "task" || run.approvalKind === "design")) {
    // While a gate waits, `run.decision` may still hold the previous gate's decision. A completed delivery must carry its own.
    const request = run.approval, decision = run.decision?.approvalId === request.approvalId ||
      (run.approvalKind === "delivery" && run.status === "completed") ? run.decision : undefined;
    const reasons: string[] = [];
    let validity: HandoverApproval["validity"] = !decision ? "pending" : decision.decision !== "approved" ? "refused" : "valid";
    if (decision && (decision.approvalId !== request.approvalId || decision.runId !== runId || decision.revision !== request.revision ||
        decision.generation !== request.generation || digest(decision.target) !== digest(request.target))) { validity = "stale"; reasons.push("Decision is bound to another request"); }
    if (run.approvalKind === "delivery") {
      const final = workflowResult;
      if (!final || final.status !== "passed" || run.workflowCycle?.status !== "passed") { validity = validity === "pending" ? "pending" : "stale"; reasons.push("No passed final workflow verification"); }
      else if (request.approvalId !== `delivery-${digest([runId, final.verificationId])}` || request.idempotencyKey !== `delivery:${runId}:${final.verificationId}`) {
        if (validity !== "pending") validity = "stale"; reasons.push("Approval is not bound to the final workflow verification");
      } else if (!sameEvidence(request.evidence, final.evidenceArtifacts)) {
        if (validity !== "pending") validity = "stale"; reasons.push("Approval evidence differs from the final verification evidence");
      }
      if (final && resultRevision(final).revision !== integratedRevision) { if (validity !== "pending") validity = "stale"; reasons.push("Final verification is not bound to the integrated revision"); }
    }
    if (superseded.has(request.approvalId)) { validity = "superseded"; reasons.push("Superseded by a requirement revision"); }
    if (run.approvalKind === "delivery") deliveryValidity = validity;
    approvals.push({ approvalId: request.approvalId, kind: run.approvalKind, target: request.target.type === "task" ? `task ${request.target.taskId}` : request.target.type,
      requestedAt: request.requestedAt, decision: decision?.decision ?? "pending", ...(decision ? { decidedBy: scrub(decision.decidedBy, 200), decidedAt: decision.decidedAt } : {}),
      validity, reasons });
  }
  for (const [approvalId, entry] of Object.entries(run.userDecisions ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const validity: HandoverApproval["validity"] = superseded.has(approvalId) ? "superseded" : entry.status === "pending" ? "pending"
      : entry.status === "answered" && entry.decision ? "valid" : entry.status === "expired" ? "stale" : "refused";
    approvals.push({ approvalId, kind: "user_decision", target: `${entry.role} ${entry.taskId}`, requestedAt: entry.request.requestedAt,
      decision: entry.status, ...(entry.decision ? { decidedBy: scrub(entry.decision.decidedBy, 200), decidedAt: entry.decision.decidedAt } : {}),
      validity, reasons: [scrub(entry.request.reason, 500)] });
  }

  // Checks: only the latest result of each cycle is current; earlier results were superseded by rework.
  const checksFor = (criterionId: string, tracing: readonly string[]): HandoverCheck[] => {
    const checks: HandoverCheck[] = [];
    const add = (scope: "task" | "workflow", taskId: string, result: VerificationResult, expected: string | null) => {
      for (const evaluated of result.evaluatedCriteria.filter(item => item.criterionId === criterionId)) {
        const { revision, consistent } = resultRevision(result);
        const evidence = result.evidenceArtifacts.find(ref => ref.artifactId === evaluated.evidenceArtifactId)!;
        checks.push({ scope, taskId, verificationId: result.verificationId, cycleNumber: result.cycleNumber, resultStatus: result.status,
          passed: evaluated.passed, ...(evaluated.command ? { command: scrub(evaluated.command, 500) } : {}),
          ...(evaluated.exitCode !== undefined ? { exitCode: evaluated.exitCode } : {}), summary: scrub(evaluated.summary, 1000), revision,
          revisionBinding: !revision || !expected ? "unbound" : revision === expected && consistent ? "bound" : "mismatch", evidence: evidenceOf(evidence) });
      }
    };
    for (const taskId of tracing) {
      const task = taskRecord(taskId), result = latest(task?.cycle);
      if (result) add("task", taskId, result, task?.changeSet?.headCommitHash ?? null);
    }
    if (workflowResult) add("workflow", WORKFLOW_TASK, workflowResult, integratedRevision);
    return checks;
  };
  const blockedCycle = (cycle: VerificationCycle | undefined) => cycle?.status === "escalated" || ["blocked", "escalated"].includes(latest(cycle)?.status ?? "");

  const criteria = spec?.acceptanceCriteria ?? run.delegation.acceptanceCriteria;
  const specApproved = approvals.find(item => item.kind === "specification")?.validity === "valid";
  const matrix: HandoverMatrixRow[] = criteria.map(criterion => {
    const tracing = definitions.filter(task => task.acceptanceCriteria.includes(criterion.id)).map(task => task.id);
    const checks = checksFor(criterion.id, tracing), reasons: string[] = [];
    const bound = checks.filter(check => check.revisionBinding === "bound");
    let verdict: HandoverVerdict;
    if (bound.some(check => !check.passed)) { verdict = "failed"; reasons.push("A current check bound to its revision failed"); }
    else if (tracing.some(taskId => blockedCycle(taskRecord(taskId)?.cycle)) || (checks.some(check => check.scope === "workflow") && blockedCycle(run.workflowCycle))) {
      verdict = "blocked"; reasons.push("Verification is blocked or escalated");
    } else if (bound.some(check => check.scope === "workflow" && check.passed && check.resultStatus === "passed" && check.evidence.integrity === "verified")) verdict = "passed";
    else if (criterion.status === "waived" && specApproved) { verdict = "waived"; reasons.push(scrub(criterion.waiverReason, 500)); }
    else if (checks.length) {
      verdict = "inconclusive";
      if (checks.some(check => check.evidence.integrity !== "verified")) reasons.push("Evidence failed integrity verification");
      if (checks.some(check => check.revisionBinding !== "bound")) reasons.push("A check is not bound to its expected revision");
      if (!bound.some(check => check.scope === "workflow" && check.passed)) reasons.push("No passing check at the integrated revision");
    } else { verdict = "not_verified"; reasons.push("No verification evaluated this criterion"); }
    return { criterionId: criterion.id, required: criterion.required, taskIds: tracing, integratedRevision, checks, verdict, reasons };
  });

  const tasks: HandoverDocument["tasks"] = definitions.map(definition => {
    const task = taskRecord(definition.id), cycle = task?.cycle, result = latest(cycle);
    const terminal = ["failed", "cancelled", "escalated"].includes(run.status);
    const outcome = !task ? "not_started" : !cycle ? "in_progress" : cycle.status === "passed" ? "passed" : blockedCycle(cycle) ? "blocked"
      : cycle.status === "aborted" || (terminal && result?.status === "failed") ? "failed" : terminal ? "inconclusive" : "in_progress";
    return { taskId: definition.id, title: scrub(definition.title, 300), criteria: [...definition.acceptanceCriteria], outcome,
      cycleStatus: cycle?.status ?? null, iterations: cycle?.history.length ?? 0, revision: task?.changeSet?.headCommitHash ?? null,
      integration: run.workflowChange && task ? "integrated" : "not_integrated" };
  });

  const findings: HandoverDocument["findings"] = [];
  const addFindings = (scope: "task" | "workflow", taskId: string, result: VerificationResult | undefined) => {
    if (!result) return;
    const seen = new Set<string>();
    for (const finding of [...result.findings, ...result.qualityGateResults.flatMap(gate => gate.findings)]) {
      const key = digest([finding.code, finding.severity, finding.message]);
      if (seen.has(key)) continue; seen.add(key);
      findings.push({ scope, taskId, verificationId: result.verificationId, code: scrub(finding.code, 200), severity: finding.severity,
        message: scrub(finding.message, 1000), open: finding.severity !== "info" });
    }
  };
  for (const task of run.tasks) addFindings("task", task.taskId, latest(task.cycle));
  addFindings("workflow", WORKFLOW_TASK, workflowResult);

  const exceptions: HandoverDocument["exceptions"] = [];
  for (const criterion of criteria.filter(item => item.status === "waived"))
    exceptions.push({ kind: "criterion_waiver", subject: `criterion ${criterion.id}`, reason: scrub(criterion.waiverReason, 500), valid: specApproved });
  for (const [approvalId, entry] of Object.entries(run.userDecisions ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const binding = entry.request.metadata?.testIntegrityException as { findingId?: string } | undefined;
    if (!binding) continue;
    exceptions.push({ kind: "test_integrity_exception", subject: `${entry.taskId} ${scrub(binding.findingId ?? approvalId, 200)}`,
      reason: scrub(entry.request.reason, 500), valid: entry.status === "answered" && entry.decision?.decision === "approved" && !superseded.has(approvalId) });
  }
  // Only an active fast path waives a review gate; inactive or downgraded state waives nothing.
  if (run.fastPath?.status === "active") exceptions.push({ kind: "fast_path", subject: "fast path active",
    reason: scrub([...run.fastPath.reasons, ...run.fastPath.blockers, run.fastPath.downgrade?.reason ?? ""].filter(Boolean).join("; ") || "No recorded reason", 1000),
    valid: true });

  const commands: { command: string; source: string }[] = [];
  const addCommand = (command: unknown, source: string) => {
    if (typeof command !== "string" || !command.trim()) return;
    const safe = scrub(command, 500);
    if (!commands.some(item => item.command === safe)) commands.push({ command: safe, source });
  };
  for (const command of run.workflowSpec?.strategy.targetCommands ?? []) addCommand(command, "specification.testStrategy.targetCommands");
  for (const result of [workflowResult, ...run.tasks.map(task => latest(task.cycle))]) {
    if (!result) continue;
    for (const evaluated of result.evaluatedCriteria) addCommand(evaluated.command, `verification ${result.verificationId}`);
    const checks = Array.isArray(result.metadata?.checks) ? result.metadata.checks as unknown[] : [];
    for (const check of checks) addCommand((check as { gate?: { metadata?: { verification?: { command?: unknown } } } })?.gate?.metadata?.verification?.command,
      `verification ${result.verificationId}`);
  }

  const evidence = [...references.values()].sort((a, b) => a.artifactId.localeCompare(b.artifactId)).map(evidenceOf);
  const unverified: HandoverDocument["unverified"] = [];
  for (const row of matrix) if (!["passed", "waived"].includes(row.verdict))
    unverified.push({ criterionId: row.criterionId, subject: `criterion ${row.criterionId}`, reason: row.reasons.join("; ") || row.verdict });
  for (const item of evidence) if (item.integrity !== "verified") unverified.push({ subject: item.uri, reason: `Evidence integrity ${item.integrity}` });
  if (spec && specificationBinding !== "bound") unverified.push({ subject: `specification ${spec.specId}`, reason: `Specification artifact binding ${specificationBinding}` });
  for (const criterion of criteria.filter(item => item.verificationMethod === "manual_review"))
    unverified.push({ criterionId: criterion.id, subject: `criterion ${criterion.id}`, reason: "Verification method is manual_review; evidence records a review verdict, not an automated test" });

  const reasons: HandoverReason[] = [];
  const reason = (code: string, message: string) => reasons.push({ code, message });
  if (run.status !== "completed") reason("run_not_completed", `Run status is ${run.status}`);
  if (run.cancelled) reason("run_cancelled", "Run was cancelled");
  if (run.supersededBy) reason("run_superseded", `Run is superseded by ${run.supersededBy}`);
  if (!spec || !specApproved) reason("specification_not_approved", "No valid approved specification");
  if (spec && specificationBinding !== "bound") reason("specification_binding_unverified", "Specification artifact is not verified and bound");
  if (!integratedRevision) reason("integrated_revision_missing", "No integrated revision is recorded");
  if (run.workflowCycle?.status !== "passed" || workflowResult?.status !== "passed") reason("workflow_verification_not_passed", "Workflow verification has not passed");
  if (run.approvalKind !== "delivery" || !run.approval) reason("delivery_approval_missing", "No delivery approval is recorded");
  else if (deliveryValidity === "pending") reason("delivery_approval_pending", "Delivery approval has no decision yet");
  else if (deliveryValidity !== "valid") reason("delivery_approval_invalid", "Delivery approval is not a valid decision bound to the final verification");
  if (matrix.some(row => row.required && !["passed", "waived"].includes(row.verdict))) reason("required_criterion_not_passed", "A required criterion is not passed or validly waived");
  if (findings.some(item => item.open && item.severity === "error")) reason("open_error_findings", "Open error findings remain");
  if (evidence.some(item => item.integrity !== "verified")) reason("evidence_integrity_failed", "Referenced evidence failed integrity verification");
  const status = run.status !== "completed" ? "draft" : reasons.length ? "partial" : "eligible";

  const document = HandoverDocumentSchema.parse({
    schemaVersion: 1, format: "bflow.handover",
    snapshot: { runId, snapshotId: snapshot.snapshotId, journalVersion: snapshot.journalVersion },
    eligibility: { status, reasons },
    run: { status: run.status, title: scrub(run.delegation.title, 500), baseRevision: run.baseRevision ? scrub(run.baseRevision, 80) : null,
      integratedRevision, cancelled: run.cancelled, supersededBy: run.supersededBy ?? null, error: run.error ? scrub(run.error, 1000) : null },
    specification: spec ? { specId: spec.specId, version: spec.version ?? 1, level: spec.level, status: spec.status, title: scrub(spec.title, 500),
      summary: scrub(spec.summary, 2000), approval: specApproved ? "approved" : "not_approved",
      artifact: spec.artifactRef ? evidenceOf(spec.artifactRef) : null, binding: specificationBinding } : null,
    criteria: criteria.map(criterion => ({ id: criterion.id, description: scrub(criterion.description, 1000), category: criterion.category,
      verificationMethod: criterion.verificationMethod, required: criterion.required,
      waiver: criterion.status === "waived" ? scrub(criterion.waiverReason, 500) : null })),
    tasks, matrix, findings, exceptions, approvals,
    instructions: {
      run: { status: commands.length ? "available" : "missing", expectedSource: "accepted test strategy targetCommands or recorded verification commands", commands },
      rollback: spec?.rollbackPlan ? { status: "available", expectedSource: "specification.rollbackPlan", text: scrub(spec.rollbackPlan, 4000) }
        : { status: "missing", expectedSource: "specification.rollbackPlan", text: null }
    },
    unverified, evidence
  });
  return { document, attachments: [...attachments].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, bytes })) };
}

export type { RunRecord };
