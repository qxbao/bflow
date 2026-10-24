import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  ArtifactReferenceSchema, ArtifactWriteOptionsSchema, IsoDateTimeSchema, JsonValueSchema,
  OperationResultSchema, QualityFindingSchema, type ArtifactReference, type ArtifactStore,
  type QualityFinding, type VerificationCycle, type VerificationResult
} from "@bflow/contracts";
import { digest, json, textField } from "./journal.js";

const execute = promisify(execFile);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const covers = (prefix: string, path: string) => prefix === path || path.startsWith(prefix + "/");
const safeRepoPath = (path: string) =>
  !isAbsolute(path) && !path.includes("\\") && !path.includes("\0") &&
  path.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".." && segment !== ".git" && segment !== ".bflow");
const normalizeOutcome = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

function recordMaybe(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export const AssignedReworkFindingSchema = z.object({
  findingId: z.string().trim().min(1).max(256),
  findingIndex: z.number().int().min(0),
  reworkGeneration: z.number().int().min(1),
  verificationId: z.string().trim().min(1),
  cycleNumber: z.number().int().min(1),
  code: z.string().trim().min(1).max(256),
  severity: QualityFindingSchema.shape.severity,
  message: z.string().trim().min(1).max(4000),
  location: z.string().trim().min(1).max(1024).optional(),
  filePath: z.string().trim().min(1).max(1024).optional(),
  line: z.number().int().min(1).optional(),
  artifactId: z.string().trim().min(1).max(256).optional(),
  checkId: z.string().trim().min(1).max(256).optional(),
  criterionId: z.string().trim().min(1).max(256).optional(),
  priorFindingId: z.string().trim().min(1).max(256).optional(),
  details: JsonValueSchema.optional()
}).strict();
export type AssignedReworkFinding = z.infer<typeof AssignedReworkFindingSchema>;

export const ReworkAssignmentContextSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  attempt: z.number().int().min(1),
  attemptId: z.string().trim().min(1),
  reworkGeneration: z.number().int().min(1),
  coreGeneration: z.number().int().min(0),
  cycleId: z.string().trim().min(1),
  failedVerificationId: z.string().trim().min(1),
  failedCycleNumber: z.number().int().min(1),
  failedRevision: z.string().regex(/^[a-f0-9]{40}$/i),
  remainingIterations: z.number().int().min(0),
  maxIterations: z.number().int().min(1),
  findings: z.array(AssignedReworkFindingSchema).min(1)
}).strict().superRefine((value, context) => {
  const ids = value.findings.map(item => item.findingId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Assigned rework findings must have distinct findingIds" });
  }
});
export type ReworkAssignmentContext = z.infer<typeof ReworkAssignmentContextSchema>;

export const ReworkSourceLocationSchema = z.object({
  path: z.string().trim().min(1).max(1024),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  symbol: z.string().trim().min(1).max(256).optional()
}).strict().superRefine((value, context) => {
  if (!safeRepoPath(value.path)) {
    context.addIssue({ code: "custom", message: `Unsafe or out-of-bounds repository path in sourceLocations: '${value.path}'` });
  }
  if (value.startLine !== undefined && value.endLine !== undefined && value.endLine < value.startLine) {
    context.addIssue({ code: "custom", message: `sourceLocations endLine (${value.endLine}) must be >= startLine (${value.startLine})` });
  }
});
export type ReworkSourceLocation = z.infer<typeof ReworkSourceLocationSchema>;

export const DiscriminatingCheckSchema = z.object({
  kind: z.string().trim().min(1).max(128).default("check_work"),
  command: z.string().trim().min(1).max(1024).optional(),
  target: z.string().trim().min(1).max(1024).optional(),
  beforeOutcome: z.string().trim().min(3).max(2000),
  afterOutcome: z.string().trim().min(3).max(2000),
  exitCode: z.number().int().optional()
}).strict().superRefine((value, context) => {
  if (!value.command && !value.target) {
    context.addIssue({ code: "custom", message: "discriminatingCheck requires command or target" });
  }
});
export type DiscriminatingCheck = z.infer<typeof DiscriminatingCheckSchema>;

export const FindingResolutionEvidenceInputSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  attemptId: z.string().trim().min(1).optional(),
  reworkGeneration: z.number().int().min(1),
  coreGeneration: z.number().int().min(0).optional(),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/i),
  summary: z.string().trim().min(3).max(4000),
  artifactRef: ArtifactReferenceSchema.optional()
}).strict();
export type FindingResolutionEvidenceInput = z.infer<typeof FindingResolutionEvidenceInputSchema>;

export const FindingResolutionEvidenceSchema = z.object({
  runId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  attemptId: z.string().trim().min(1),
  reworkGeneration: z.number().int().min(1),
  coreGeneration: z.number().int().min(0),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/i),
  summary: z.string().trim().min(3).max(4000),
  artifactRef: ArtifactReferenceSchema,
  providedArtifactRef: ArtifactReferenceSchema.optional()
}).strict();
export type FindingResolutionEvidence = z.infer<typeof FindingResolutionEvidenceSchema>;

export const ReworkFindingDispositionSchema = z.enum(["addressed", "disputed", "blocked"]);
export type ReworkFindingDisposition = z.infer<typeof ReworkFindingDispositionSchema>;

export const ReworkFindingResolutionInputSchema = z.object({
  findingId: z.string().trim().min(1).max(256),
  disposition: ReworkFindingDispositionSchema,
  rootCause: z.string().trim().min(10).max(4000),
  hypothesisConfirmed: z.boolean().optional(),
  sourceLocations: z.array(ReworkSourceLocationSchema).min(1).max(32),
  repairSummary: z.string().trim().min(10).max(4000),
  disputeReason: z.string().trim().min(5).max(4000).optional(),
  blockerReason: z.string().trim().min(5).max(4000).optional(),
  reproductionSteps: z.string().trim().min(5).max(4000).optional(),
  discriminatingCheck: DiscriminatingCheckSchema,
  evidence: FindingResolutionEvidenceInputSchema
}).strict();
export type ReworkFindingResolutionInput = z.infer<typeof ReworkFindingResolutionInputSchema>;

export const ReworkFindingResolutionSchema = z.object({
  findingId: z.string().trim().min(1).max(256),
  findingCode: z.string().trim().min(1).max(256),
  findingIndex: z.number().int().min(0),
  reworkGeneration: z.number().int().min(1),
  disposition: ReworkFindingDispositionSchema,
  rootCause: z.string().trim().min(10).max(4000),
  hypothesisConfirmed: z.boolean(),
  sourceLocations: z.array(ReworkSourceLocationSchema).min(1).max(32),
  repairSummary: z.string().trim().min(10).max(4000),
  disputeReason: z.string().trim().min(5).max(4000).optional(),
  blockerReason: z.string().trim().min(5).max(4000).optional(),
  reproductionSteps: z.string().trim().min(5).max(4000).optional(),
  discriminatingCheck: DiscriminatingCheckSchema,
  evidence: FindingResolutionEvidenceSchema
}).strict();
export type ReworkFindingResolution = z.infer<typeof ReworkFindingResolutionSchema>;

export const ReworkFindingVerdictSchema = z.object({
  findingId: z.string().trim().min(1).max(256),
  verdict: z.enum(["confirmed", "rejected"]),
  summary: z.string().trim().min(3).max(2000),
  filePath: z.string().trim().min(1).max(1024).optional(),
  line: z.number().int().min(1).optional()
}).strict();
export type ReworkFindingVerdict = z.infer<typeof ReworkFindingVerdictSchema>;

export const ReworkFindingOutcomeSchema = z.object({
  findingId: z.string().trim().min(1).max(256),
  disposition: ReworkFindingDispositionSchema,
  status: z.enum([
    "pending_independent_verification",
    "verified_closed",
    "rejected_by_verification",
    "escalated_blocked",
    "unverified"
  ]),
  verdictSummary: z.string().trim().min(1).max(2000).optional()
}).strict();

export const ReworkVerificationOutcomeSchema = z.object({
  status: z.enum([
    "pending_independent_verification",
    "verified_closed",
    "rework_required",
    "exhausted_failed",
    "escalated_blocked"
  ]),
  verificationId: z.string().trim().min(1).optional(),
  cycleNumber: z.number().int().min(1).optional(),
  verifiedBy: z.string().trim().min(1).optional(),
  verifiedAt: IsoDateTimeSchema.optional(),
  remainingFindingCount: z.number().int().min(0).optional(),
  reason: z.string().trim().min(1).max(2000).optional(),
  closedFindingIds: z.array(z.string().trim().min(1)).default([]),
  openFindingIds: z.array(z.string().trim().min(1)).default([]),
  findingVerdicts: z.array(ReworkFindingVerdictSchema).default([]),
  findingOutcomes: z.array(ReworkFindingOutcomeSchema).min(1)
}).strict();
export type ReworkVerificationOutcome = z.infer<typeof ReworkVerificationOutcomeSchema>;

export const ReworkResolutionDossierSchema = z.object({
  schemaVersion: z.literal(1),
  dossierId: z.string().trim().min(1).max(256),
  runId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  attempt: z.number().int().min(1),
  attemptId: z.string().trim().min(1),
  reworkGeneration: z.number().int().min(1),
  coreGeneration: z.number().int().min(0),
  cycleId: z.string().trim().min(1),
  failedVerificationId: z.string().trim().min(1),
  failedCycleNumber: z.number().int().min(1),
  failedRevision: z.string().regex(/^[a-f0-9]{40}$/i),
  submittedRevision: z.string().regex(/^[a-f0-9]{40}$/i),
  submissionStatus: z.enum(["succeeded", "blocked"]),
  submittedByAgentId: z.string().trim().min(1),
  submittedAt: IsoDateTimeSchema,
  reworkContext: ReworkAssignmentContextSchema,
  findingResolutions: z.array(ReworkFindingResolutionSchema).min(1),
  artifactRef: ArtifactReferenceSchema,
  verificationOutcome: ReworkVerificationOutcomeSchema
}).strict().superRefine((value, context) => {
  const expectedIds = value.reworkContext.findings.map(item => item.findingId);
  const actualIds = value.findingResolutions.map(item => item.findingId);
  if (digest([...expectedIds].sort()) !== digest([...actualIds].sort())) {
    context.addIssue({ code: "custom", message: "Dossier findingResolutions do not match reworkContext findings 1-to-1" });
  }
});
export type ReworkResolutionDossier = z.infer<typeof ReworkResolutionDossierSchema>;

/**
 * Extracts actionable error findings from the last failed verification iteration in a rework cycle
 * and assigns each finding a deterministic, unique `findingId` incorporating its position (`findingIndex`),
 * so distinct findings with the same `code` are never merged.
 */
export function buildReworkAssignmentContext(input: {
  runId: string;
  taskId: string;
  cycle: VerificationCycle;
  lastChangeSetHead?: string | undefined;
  attempt: number;
  attemptId: string;
  coreGeneration: number;
}): ReworkAssignmentContext {
  const { runId, taskId, cycle, lastChangeSetHead, attempt, attemptId, coreGeneration } = input;
  const lastResult = cycle.history.at(-1);
  if (!lastResult || cycle.status !== "rework_required") {
    throw new Error(`Task ${taskId} is not in rework_required state with a prior failed verification result`);
  }
  const reworkGeneration = cycle.history.length;
  const failedRevision = lastResult.changeSet?.headCommitHash ?? lastChangeSetHead;
  if (!failedRevision || !/^[a-f0-9]{40}$/i.test(failedRevision)) {
    throw new Error(`Rework assignment for ${taskId} lacks a valid 40-char failedRevision`);
  }
  const gatesWithExplicitErrorFindings = new Set(
    lastResult.qualityGateResults
      .filter(gate => gate.findings.some(finding => finding.severity === "error"))
      .map(gate => gate.gateId)
  );
  const errorFindings = lastResult.findings.filter(finding => finding.severity === "error");
  const filteredFindings = errorFindings.filter(finding => {
    if (finding.code !== "check_failed") return true;
    const details = recordMaybe(finding.details);
    const checkId = typeof details?.checkId === "string" ? details.checkId : undefined;
    return checkId === undefined || !gatesWithExplicitErrorFindings.has(checkId);
  });
  const selectedFindings: QualityFinding[] = filteredFindings.length > 0
    ? filteredFindings
    : errorFindings.length > 0
      ? errorFindings
      : [{
          code: "check_failed",
          severity: "error",
          message: `Verification ${lastResult.verificationId} failed on iteration ${lastResult.cycleNumber}; inspect failed criteria and repair root cause.`
        }];

  const assignedFindings: AssignedReworkFinding[] = selectedFindings.map((finding, findingIndex) => {
    const details = recordMaybe(finding.details);
    const original = recordMaybe(details?.original);
    const checkId = typeof details?.checkId === "string" ? details.checkId : typeof original?.checkId === "string" ? original.checkId : undefined;
    const criterionId = typeof details?.criterionId === "string" ? details.criterionId : typeof original?.criterionId === "string" ? original.criterionId : undefined;
    const priorFindingId = typeof details?.priorFindingId === "string" ? details.priorFindingId : typeof original?.priorFindingId === "string" ? original.priorFindingId : undefined;
    const filePath = typeof details?.filePath === "string"
      ? details.filePath
      : typeof original?.filePath === "string"
        ? original.filePath
        : finding.location?.split(":")[0];
    const parsedLineFromLocation = finding.location?.includes(":") ? Number.parseInt(finding.location.split(":")[1] ?? "", 10) : Number.NaN;
    const line = typeof details?.line === "number"
      ? details.line
      : typeof original?.line === "number"
        ? original.line
        : Number.isInteger(parsedLineFromLocation) && parsedLineFromLocation > 0
          ? parsedLineFromLocation
          : undefined;
    const location = finding.location ?? (filePath ? (line !== undefined ? `${filePath}:${line}` : filePath) : undefined);
    const findingId = `finding-${reworkGeneration}-${findingIndex + 1}-${digest([
      runId,
      taskId,
      lastResult.verificationId,
      findingIndex,
      finding.code,
      finding.message,
      location ?? null,
      filePath ?? null,
      line ?? null,
      checkId ?? null,
      criterionId ?? null,
      priorFindingId ?? null
    ]).slice(0, 16)}`;
    return AssignedReworkFindingSchema.parse({
      findingId,
      findingIndex,
      reworkGeneration,
      verificationId: lastResult.verificationId,
      cycleNumber: lastResult.cycleNumber,
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      ...(location !== undefined ? { location } : {}),
      ...(filePath !== undefined ? { filePath } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(finding.artifactId !== undefined ? { artifactId: finding.artifactId } : {}),
      ...(checkId !== undefined ? { checkId } : {}),
      ...(criterionId !== undefined ? { criterionId } : {}),
      ...(priorFindingId !== undefined ? { priorFindingId } : {}),
      ...(finding.details !== undefined ? { details: finding.details } : {})
    });
  });

  return ReworkAssignmentContextSchema.parse({
    schemaVersion: 1,
    runId,
    taskId,
    attempt,
    attemptId,
    reworkGeneration,
    coreGeneration,
    cycleId: cycle.cycleId,
    failedVerificationId: lastResult.verificationId,
    failedCycleNumber: lastResult.cycleNumber,
    failedRevision,
    remainingIterations: Math.max(0, cycle.maxIterations - cycle.currentIteration),
    maxIterations: cycle.maxIterations,
    findings: assignedFindings
  });
}

/**
 * Formats assigned rework findings as standard `QualityFinding[]` with embedded `findingId` and `reworkGeneration`
 * in `details` for backward-compatible `task.assignment.payload.findings` consumers.
 */
export function toAssignedQualityFindings(context: ReworkAssignmentContext): QualityFinding[] {
  return context.findings.map(item => {
    const location = item.location ?? (item.filePath !== undefined ? (item.line !== undefined ? `${item.filePath}:${item.line}` : item.filePath) : undefined);
    return QualityFindingSchema.parse({
      code: item.code,
      severity: item.severity,
      message: item.message,
      ...(location !== undefined ? { location } : {}),
      ...(item.artifactId !== undefined ? { artifactId: item.artifactId } : {}),
      details: json({
        ...(recordMaybe(item.details) ?? (item.details !== undefined ? { original: item.details } : {})),
        findingId: item.findingId,
        findingIndex: item.findingIndex,
        reworkGeneration: item.reworkGeneration,
        verificationId: item.verificationId,
        cycleNumber: item.cycleNumber,
        ...(item.filePath !== undefined ? { filePath: item.filePath } : {}),
        ...(item.line !== undefined ? { line: item.line } : {}),
        ...(item.checkId !== undefined ? { checkId: item.checkId } : {}),
        ...(item.criterionId !== undefined ? { criterionId: item.criterionId } : {}),
        ...(item.priorFindingId !== undefined ? { priorFindingId: item.priorFindingId } : {})
      })
    });
  });
}

async function gitInWorktree(cwd: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !key.startsWith("NODE_")));
  return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd, env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
}

async function inspectWorktreeRevision(worktreePath: string, baseRevision: string): Promise<{ headCommitHash: string; dirty: boolean; changedPaths: string[] }> {
  const headCommitHash = (await gitInWorktree(worktreePath, ["rev-parse", "HEAD"])).trim();
  const statusOutput = (await gitInWorktree(worktreePath, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"])).trim();
  const dirty = statusOutput.length > 0;
  if (headCommitHash === baseRevision) return { headCommitHash, dirty, changedPaths: [] };
  const diffOutput = await gitInWorktree(worktreePath, ["diff", "--name-only", "-z", `${baseRevision}..${headCommitHash}`]);
  const changedPaths = diffOutput.split("\0").map(item => item.trim()).filter(Boolean);
  return { headCommitHash, dirty, changedPaths };
}

async function verifyAndReadArtifact(artifactStore: ArtifactStore, referenceInput: ArtifactReference, expectedRunId: string, expectedTaskId: string): Promise<Buffer> {
  const reference = ArtifactReferenceSchema.parse(referenceInput);
  if (reference.runId !== expectedRunId || (reference.taskId !== undefined && reference.taskId !== expectedTaskId)) {
    throw new Error(`Rework evidence artifact ${reference.artifactId} does not belong to run ${expectedRunId} / task ${expectedTaskId}`);
  }
  const resolved = OperationResultSchema(ArtifactReferenceSchema.nullable()).parse(await artifactStore.resolve(reference.artifactId));
  if (!resolved.ok || !resolved.value || digest(resolved.value) !== digest(reference)) {
    throw new Error(`Rework evidence artifact ${reference.artifactId} is not resolved in trusted ArtifactStore`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of artifactStore.get(reference)) {
    const parsed = OperationResultSchema(z.instanceof(Uint8Array)).parse(chunk);
    if (!parsed.ok) throw new Error(`Rework evidence artifact ${reference.artifactId} could not be read from ArtifactStore`);
    const bytes = Buffer.from(parsed.value);
    size += bytes.length;
    chunks.push(bytes);
  }
  const buffer = Buffer.concat(chunks);
  if (createHash(reference.checksum.algorithm).update(buffer).digest("hex").toLowerCase() !== reference.checksum.value.toLowerCase() ||
      (reference.sizeBytes !== undefined && reference.sizeBytes !== size)) {
    throw new Error(`Rework evidence artifact ${reference.artifactId} failed checksum or size verification`);
  }
  return buffer;
}

async function storeJsonArtifact(
  artifactStore: ArtifactStore,
  runId: string,
  taskId: string,
  prefix: string,
  keyMaterial: unknown,
  payload: unknown
): Promise<ArtifactReference> {
  const bytes = Buffer.from(JSON.stringify(payload));
  const checksum = sha256(bytes);
  const artifactId = `${prefix}-${digest([runId, taskId, keyMaterial, checksum]).slice(0, 36)}`;
  const stored = await artifactStore.put({
    options: ArtifactWriteOptionsSchema.parse({
      artifactId,
      runId,
      taskId,
      kind: "report",
      mediaType: "application/json",
      expectedIntegrity: { checksum: { algorithm: "sha256", value: checksum }, sizeBytes: bytes.length },
      idempotencyKey: artifactId
    }),
    content: (async function* () { yield bytes; })()
  });
  if (!stored.ok) {
    throw new Error(`ArtifactStore could not persist ${prefix} (${stored.error.code}: ${stored.error.message})`);
  }
  const reference = ArtifactReferenceSchema.parse(stored.value);
  await verifyAndReadArtifact(artifactStore, reference, runId, taskId);
  return reference;
}

export async function validateAndStoreReworkResolution(options: {
  reworkContext: ReworkAssignmentContext;
  findingResolutionsInput: unknown;
  worktreePath: string;
  ownedPaths: readonly string[];
  forbiddenPaths?: readonly string[] | undefined;
  submissionStatus: "succeeded" | "blocked";
  submittedByAgentId: string;
  submittedAt: string;
  artifactStore: ArtifactStore;
}): Promise<ReworkResolutionDossier> {
  const {
    reworkContext,
    findingResolutionsInput,
    worktreePath,
    ownedPaths,
    forbiddenPaths = [],
    submissionStatus,
    submittedByAgentId,
    submittedAt,
    artifactStore
  } = options;

  if (!Array.isArray(findingResolutionsInput) || findingResolutionsInput.length === 0) {
    throw new Error(
      `Rework submission for ${reworkContext.taskId} (reworkGeneration ${reworkContext.reworkGeneration}) is missing required root-cause findingResolutions covering all ${reworkContext.findings.length} assigned finding(s)`
    );
  }
  const parsedInputs = findingResolutionsInput.map((item, idx) => {
    const parsed = ReworkFindingResolutionInputSchema.safeParse(item);
    if (!parsed.success) {
      const detail = parsed.error.issues.map(issue => `${issue.path.join(".") || "findingResolution"}: ${issue.message}`).join("; ");
      throw new Error(`Invalid rework findingResolution at index ${idx}: ${detail}`);
    }
    return parsed.data;
  });

  const seenIds = new Set<string>();
  for (const item of parsedInputs) {
    if (seenIds.has(item.findingId)) {
      throw new Error(`Duplicate findingId '${item.findingId}' in findingResolutions; each assigned finding must have exactly one resolution record`);
    }
    seenIds.add(item.findingId);
  }
  const expectedById = new Map(reworkContext.findings.map(item => [item.findingId, item]));
  const missingIds = reworkContext.findings.filter(item => !seenIds.has(item.findingId)).map(item => `${item.findingId} (${item.code})`);
  if (missingIds.length > 0) {
    throw new Error(`Rework submission is missing root-cause explanation for assigned finding(s). Missing findingId(s): ${missingIds.join(", ")}`);
  }
  const unknownIds = parsedInputs.filter(item => !expectedById.has(item.findingId)).map(item => item.findingId);
  if (unknownIds.length > 0) {
    throw new Error(`Rework submission references unknown or stale findingId(s) not in reworkGeneration ${reworkContext.reworkGeneration}: ${unknownIds.join(", ")}`);
  }

  if (submissionStatus === "succeeded" && parsedInputs.some(item => item.disposition === "blocked")) {
    throw new Error("Rework finding with disposition 'blocked' cannot be submitted as 'succeeded'; submit with status 'blocked' or report a task.status blocker");
  }
  if (submissionStatus === "blocked" && !parsedInputs.some(item => item.disposition === "blocked" || item.disposition === "disputed")) {
    throw new Error("Blocked rework submission must include at least one finding with disposition 'blocked' or 'disputed'");
  }

  const worktreeState = await inspectWorktreeRevision(worktreePath, reworkContext.failedRevision);
  if (worktreeState.dirty) {
    throw new Error("Rework worktree has uncommitted changes; commit changes before submitting rework resolution");
  }

  const resolvedFindings: ReworkFindingResolution[] = [];
  for (const assigned of reworkContext.findings) {
    const input = parsedInputs.find(item => item.findingId === assigned.findingId)!;
    const ev = input.evidence;

    if (ev.runId !== undefined && ev.runId !== reworkContext.runId) {
      throw new Error(`Rework finding '${assigned.findingId}' evidence.runId (${ev.runId}) does not match run '${reworkContext.runId}'`);
    }
    if (ev.taskId !== undefined && ev.taskId !== reworkContext.taskId) {
      throw new Error(`Rework finding '${assigned.findingId}' evidence.taskId (${ev.taskId}) does not match task '${reworkContext.taskId}'`);
    }
    if (ev.attemptId !== undefined && ev.attemptId !== reworkContext.attemptId) {
      throw new Error(`Rework finding '${assigned.findingId}' evidence.attemptId (${ev.attemptId}) does not match current attemptId '${reworkContext.attemptId}'`);
    }
    if (ev.reworkGeneration !== reworkContext.reworkGeneration) {
      throw new Error(
        `Rework finding '${assigned.findingId}' evidence.reworkGeneration (${ev.reworkGeneration}) must match active reworkGeneration (${reworkContext.reworkGeneration})`
      );
    }
    if (ev.coreGeneration !== undefined && ev.coreGeneration !== reworkContext.coreGeneration) {
      throw new Error(
        `Rework finding '${assigned.findingId}' evidence.coreGeneration (${ev.coreGeneration}) must match current coreGeneration (${reworkContext.coreGeneration})`
      );
    }

    if (input.disposition === "disputed" && !input.disputeReason && !input.reproductionSteps) {
      throw new Error(
        `Rework finding '${assigned.findingId}' has disposition 'disputed'; disputeReason is required with reproduction evidence`
      );
    }

    if (input.disposition === "addressed") {
      if (worktreeState.headCommitHash === reworkContext.failedRevision) {
        throw new Error(
          `Rework finding '${assigned.findingId}' has disposition 'addressed' but worktree HEAD (${worktreeState.headCommitHash}) has no new commit after failedRevision (${reworkContext.failedRevision})`
        );
      }
      if (ev.sourceRevision.toLowerCase() !== worktreeState.headCommitHash.toLowerCase()) {
        throw new Error(
          `Rework finding '${assigned.findingId}' evidence.sourceRevision (${ev.sourceRevision}) must match the current worktree HEAD (${worktreeState.headCommitHash})`
        );
      }
      if (normalizeOutcome(input.discriminatingCheck.beforeOutcome) === normalizeOutcome(input.discriminatingCheck.afterOutcome)) {
        throw new Error(
          `Rework finding '${assigned.findingId}' discriminatingCheck must distinguish beforeOutcome from afterOutcome for an addressed finding`
        );
      }
      if (input.discriminatingCheck.exitCode !== undefined && input.discriminatingCheck.exitCode !== 0) {
        throw new Error(
          `Rework finding '${assigned.findingId}' has disposition 'addressed' but discriminatingCheck.exitCode is non-zero (${input.discriminatingCheck.exitCode})`
        );
      }
    } else {
      const validRevisions = new Set([worktreeState.headCommitHash.toLowerCase(), reworkContext.failedRevision.toLowerCase()]);
      if (!validRevisions.has(ev.sourceRevision.toLowerCase())) {
        throw new Error(
          `Rework finding '${assigned.findingId}' (${input.disposition}) evidence.sourceRevision (${ev.sourceRevision}) must match current HEAD (${worktreeState.headCommitHash}) or failedRevision (${reworkContext.failedRevision})`
        );
      }
    }

    // Validate sourceLocations against scope and worktree files
    for (const loc of input.sourceLocations) {
      if (forbiddenPaths.some(prefix => covers(prefix, loc.path))) {
        throw new Error(`Rework finding '${assigned.findingId}' sourceLocation '${loc.path}' is inside forbiddenPaths`);
      }
      if (input.disposition === "addressed" && ownedPaths.length > 0 && !ownedPaths.some(prefix => covers(prefix, loc.path))) {
        throw new Error(`Rework finding '${assigned.findingId}' sourceLocation '${loc.path}' is outside task ownedPaths (${ownedPaths.join(", ")})`);
      }
      const absolute = resolve(worktreePath, loc.path);
      try {
        const info = await stat(absolute);
        if (!info.isFile()) {
          throw new Error(`Rework finding '${assigned.findingId}' sourceLocation '${loc.path}' is not a regular file`);
        }
        if (loc.startLine !== undefined || loc.endLine !== undefined) {
          const content = await readFile(absolute, "utf8");
          const lineCount = Math.max(1, content.split(/\r?\n/).length);
          const maxLine = loc.endLine ?? loc.startLine ?? 1;
          if (maxLine > lineCount) {
            throw new Error(`Rework finding '${assigned.findingId}' sourceLocation '${loc.path}' line ${maxLine} exceeds file line count (${lineCount})`);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (input.disposition !== "addressed" || !worktreeState.changedPaths.includes(loc.path)) {
            throw new Error(`Rework finding '${assigned.findingId}' sourceLocation '${loc.path}' does not exist in worktree`);
          }
        } else {
          throw error;
        }
      }
    }
    if (input.disposition === "addressed" && !input.sourceLocations.some(loc => worktreeState.changedPaths.includes(loc.path))) {
      throw new Error(
        `Rework finding '${assigned.findingId}' has disposition 'addressed', but none of its sourceLocations (${input.sourceLocations.map(l => l.path).join(", ")}) were modified in commit ${worktreeState.headCommitHash} (changed: ${worktreeState.changedPaths.join(", ") || "none"})`
      );
    }

    let providedArtifactRef: ArtifactReference | undefined;
    if (ev.artifactRef !== undefined) {
      const bytes = await verifyAndReadArtifact(artifactStore, ev.artifactRef, reworkContext.runId, reworkContext.taskId);
      if (ev.artifactRef.mediaType === "application/json") {
        let parsedJson: unknown;
        try { parsedJson = JSON.parse(bytes.toString("utf8")); } catch { parsedJson = undefined; }
        const obj = recordMaybe(parsedJson);
        if (typeof obj?.sourceRevision === "string" && obj.sourceRevision.toLowerCase() !== ev.sourceRevision.toLowerCase()) {
          throw new Error(
            `Rework finding '${assigned.findingId}' evidence references a check_work artifact recorded at revision ${obj.sourceRevision}, which does not match claimed sourceRevision ${ev.sourceRevision}`
          );
        }
        if (typeof obj?.reworkGeneration === "number" && obj.reworkGeneration !== reworkContext.reworkGeneration) {
          throw new Error(
            `Rework finding '${assigned.findingId}' evidence artifact ${ev.artifactRef.artifactId} was recorded for reworkGeneration ${obj.reworkGeneration}, which does not match current reworkGeneration ${reworkContext.reworkGeneration}`
          );
        }
      }
      providedArtifactRef = ArtifactReferenceSchema.parse(ev.artifactRef);
    }

    const findingEvidenceArtifact = await storeJsonArtifact(
      artifactStore,
      reworkContext.runId,
      reworkContext.taskId,
      "rework-finding-evidence",
      [reworkContext.attemptId, reworkContext.reworkGeneration, assigned.findingId, ev.sourceRevision],
      {
        schemaVersion: 1,
        runId: reworkContext.runId,
        taskId: reworkContext.taskId,
        attemptId: reworkContext.attemptId,
        reworkGeneration: reworkContext.reworkGeneration,
        coreGeneration: reworkContext.coreGeneration,
        findingId: assigned.findingId,
        findingCode: assigned.code,
        findingIndex: assigned.findingIndex,
        disposition: input.disposition,
        rootCause: input.rootCause,
        sourceLocations: input.sourceLocations,
        repairSummary: input.repairSummary,
        ...(input.disputeReason !== undefined ? { disputeReason: input.disputeReason } : {}),
        ...(input.blockerReason !== undefined ? { blockerReason: input.blockerReason } : {}),
        ...(input.reproductionSteps !== undefined ? { reproductionSteps: input.reproductionSteps } : {}),
        discriminatingCheck: input.discriminatingCheck,
        sourceRevision: ev.sourceRevision,
        failedRevision: reworkContext.failedRevision,
        summary: ev.summary,
        ...(providedArtifactRef !== undefined ? { providedArtifactRef } : {}),
        recordedAt: submittedAt
      }
    );

    resolvedFindings.push(ReworkFindingResolutionSchema.parse({
      findingId: assigned.findingId,
      findingCode: assigned.code,
      findingIndex: assigned.findingIndex,
      reworkGeneration: reworkContext.reworkGeneration,
      disposition: input.disposition,
      rootCause: input.rootCause,
      hypothesisConfirmed: input.hypothesisConfirmed ?? (input.disposition === "addressed"),
      sourceLocations: input.sourceLocations,
      repairSummary: input.repairSummary,
      ...(input.disputeReason !== undefined ? { disputeReason: input.disputeReason } : {}),
      ...(input.blockerReason !== undefined ? { blockerReason: input.blockerReason } : {}),
      ...(input.reproductionSteps !== undefined ? { reproductionSteps: input.reproductionSteps } : {}),
      discriminatingCheck: input.discriminatingCheck,
      evidence: {
        runId: reworkContext.runId,
        taskId: reworkContext.taskId,
        attemptId: reworkContext.attemptId,
        reworkGeneration: reworkContext.reworkGeneration,
        coreGeneration: reworkContext.coreGeneration,
        sourceRevision: ev.sourceRevision,
        summary: ev.summary,
        artifactRef: findingEvidenceArtifact,
        ...(providedArtifactRef !== undefined ? { providedArtifactRef } : {})
      }
    }));
  }

  const dossierId = `rework-dossier-${digest([
    reworkContext.runId,
    reworkContext.taskId,
    reworkContext.attemptId,
    reworkContext.reworkGeneration,
    worktreeState.headCommitHash,
    resolvedFindings
  ]).slice(0, 36)}`;

  const verificationOutcome: ReworkVerificationOutcome = ReworkVerificationOutcomeSchema.parse({
    status: submissionStatus === "blocked" ? "escalated_blocked" : "pending_independent_verification",
    ...(submissionStatus === "blocked" ? { reason: "Developer reported rework finding(s) as blocked/disputed requiring escalation" } : {}),
    closedFindingIds: [],
    openFindingIds: resolvedFindings.map(item => item.findingId),
    findingVerdicts: [],
    findingOutcomes: resolvedFindings.map(item => ({
      findingId: item.findingId,
      disposition: item.disposition,
      status: submissionStatus === "blocked" ? "escalated_blocked" : "pending_independent_verification"
    }))
  });

  const dossierPayload = {
    schemaVersion: 1 as const,
    dossierId,
    runId: reworkContext.runId,
    taskId: reworkContext.taskId,
    attempt: reworkContext.attempt,
    attemptId: reworkContext.attemptId,
    reworkGeneration: reworkContext.reworkGeneration,
    coreGeneration: reworkContext.coreGeneration,
    cycleId: reworkContext.cycleId,
    failedVerificationId: reworkContext.failedVerificationId,
    failedCycleNumber: reworkContext.failedCycleNumber,
    failedRevision: reworkContext.failedRevision,
    submittedRevision: worktreeState.headCommitHash,
    submissionStatus,
    submittedByAgentId: textField(submittedByAgentId),
    submittedAt,
    reworkContext,
    findingResolutions: resolvedFindings,
    verificationOutcome
  };

  const dossierArtifact = await storeJsonArtifact(
    artifactStore,
    reworkContext.runId,
    reworkContext.taskId,
    "rework-dossier",
    [dossierId, submittedAt],
    dossierPayload
  );

  return ReworkResolutionDossierSchema.parse({
    ...dossierPayload,
    artifactRef: dossierArtifact
  });
}

/**
 * Verifies an already-constructed `ReworkResolutionDossier` at the Runtime ingress boundary,
 * checking identity/generation/revision bindings and verifying all `ArtifactReference`s in `ArtifactStore`.
 */
export async function verifyStoredReworkDossier(options: {
  dossierInput: unknown;
  reworkContext: ReworkAssignmentContext;
  worktreePath: string;
  ownedPaths: readonly string[];
  forbiddenPaths?: readonly string[] | undefined;
  expectedStatus: "succeeded" | "blocked";
  artifactStore: ArtifactStore;
}): Promise<ReworkResolutionDossier> {
  const { dossierInput, reworkContext, worktreePath, ownedPaths, forbiddenPaths = [], expectedStatus, artifactStore } = options;
  const dossier = ReworkResolutionDossierSchema.parse(dossierInput);
  if (dossier.runId !== reworkContext.runId ||
      dossier.taskId !== reworkContext.taskId ||
      dossier.attemptId !== reworkContext.attemptId ||
      dossier.reworkGeneration !== reworkContext.reworkGeneration ||
      dossier.coreGeneration !== reworkContext.coreGeneration ||
      dossier.failedVerificationId !== reworkContext.failedVerificationId ||
      dossier.failedRevision.toLowerCase() !== reworkContext.failedRevision.toLowerCase() ||
      dossier.submissionStatus !== expectedStatus ||
      digest(dossier.reworkContext) !== digest(reworkContext)) {
    throw new Error("Rework resolution dossier identity, generation, or reworkContext mismatch");
  }
  const worktreeState = await inspectWorktreeRevision(worktreePath, reworkContext.failedRevision);
  if (worktreeState.dirty || dossier.submittedRevision.toLowerCase() !== worktreeState.headCommitHash.toLowerCase()) {
    throw new Error(`Rework resolution dossier submittedRevision (${dossier.submittedRevision}) does not match clean worktree HEAD (${worktreeState.headCommitHash})`);
  }
  await verifyAndReadArtifact(artifactStore, dossier.artifactRef, reworkContext.runId, reworkContext.taskId);
  for (const resolution of dossier.findingResolutions) {
    await verifyAndReadArtifact(artifactStore, resolution.evidence.artifactRef, reworkContext.runId, reworkContext.taskId);
    if (resolution.evidence.providedArtifactRef) {
      await verifyAndReadArtifact(artifactStore, resolution.evidence.providedArtifactRef, reworkContext.runId, reworkContext.taskId);
    }
    if (resolution.disposition === "addressed") {
      if (worktreeState.headCommitHash === reworkContext.failedRevision ||
          resolution.evidence.sourceRevision.toLowerCase() !== worktreeState.headCommitHash.toLowerCase()) {
        throw new Error(`Rework finding '${resolution.findingId}' addressed evidence sourceRevision mismatch`);
      }
      if (ownedPaths.length > 0 && resolution.sourceLocations.some(loc => !ownedPaths.some(prefix => covers(prefix, loc.path)) || forbiddenPaths.some(prefix => covers(prefix, loc.path)))) {
        throw new Error(`Rework finding '${resolution.findingId}' sourceLocations violate task path ownership`);
      }
      if (!resolution.sourceLocations.some(loc => worktreeState.changedPaths.includes(loc.path))) {
        throw new Error(`Rework finding '${resolution.findingId}' sourceLocations do not intersect changed files in ${worktreeState.headCommitHash}`);
      }
    }
  }
  return dossier;
}

/**
 * Settles a rework dossier's `verificationOutcome` ONLY after independent verification completes.
 * Developer self-reported "addressed" never closes a finding on its own; only an independent passed cycle
 * transitions finding outcomes from `pending_independent_verification` to `verified_closed`.
 */
export function settleReworkVerificationOutcome(
  dossier: ReworkResolutionDossier,
  result: VerificationResult,
  cycle: VerificationCycle
): ReworkResolutionDossier {
  const verdictByFindingId = new Map<string, ReworkFindingVerdict>();
  for (const gate of result.qualityGateResults) {
    const verificationMeta = recordMaybe(gate.metadata?.verification);
    const rawVerdicts = gate.metadata?.findingVerdicts ?? verificationMeta?.findingVerdicts;
    if (Array.isArray(rawVerdicts)) {
      for (const item of rawVerdicts) {
        const parsed = ReworkFindingVerdictSchema.safeParse(item);
        if (parsed.success) verdictByFindingId.set(parsed.data.findingId, parsed.data);
      }
    }
  }
  const rejectedPriorIds = new Set<string>();
  for (const finding of result.findings.filter(item => item.severity === "error")) {
    const details = recordMaybe(finding.details);
    const original = recordMaybe(details?.original);
    const priorId = typeof details?.priorFindingId === "string"
      ? details.priorFindingId
      : typeof original?.priorFindingId === "string"
        ? original.priorFindingId
        : undefined;
    if (priorId) rejectedPriorIds.add(priorId);
  }

  if (result.status === "passed" && cycle.status === "passed") {
    return ReworkResolutionDossierSchema.parse({
      ...dossier,
      verificationOutcome: {
        status: "verified_closed",
        verificationId: result.verificationId,
        cycleNumber: result.cycleNumber,
        verifiedBy: result.verifiedBy,
        verifiedAt: result.completedAt,
        remainingFindingCount: 0,
        closedFindingIds: dossier.findingResolutions.map(item => item.findingId),
        openFindingIds: [],
        findingVerdicts: [...verdictByFindingId.values()],
        findingOutcomes: dossier.findingResolutions.map(item => ({
          findingId: item.findingId,
          disposition: item.disposition,
          status: "verified_closed",
          ...(verdictByFindingId.get(item.findingId)?.summary ? { verdictSummary: verdictByFindingId.get(item.findingId)!.summary } : {})
        }))
      }
    });
  }

  if (cycle.status === "rework_required") {
    const errorCount = result.findings.filter(item => item.severity === "error").length;
    const outcomes = dossier.findingResolutions.map(item => {
      const explicitVerdict = verdictByFindingId.get(item.findingId);
      const rejected = explicitVerdict?.verdict === "rejected" || rejectedPriorIds.has(item.findingId) || explicitVerdict === undefined;
      return {
        findingId: item.findingId,
        disposition: item.disposition,
        status: (rejected ? "rejected_by_verification" : "verified_closed") as "rejected_by_verification" | "verified_closed",
        ...(explicitVerdict?.summary ? { verdictSummary: explicitVerdict.summary } : {})
      };
    });
    return ReworkResolutionDossierSchema.parse({
      ...dossier,
      verificationOutcome: {
        status: "rework_required",
        verificationId: result.verificationId,
        cycleNumber: result.cycleNumber,
        verifiedBy: result.verifiedBy,
        verifiedAt: result.completedAt,
        remainingFindingCount: errorCount,
        reason: "Independent verification found remaining or unconvincing rework repairs",
        closedFindingIds: outcomes.filter(item => item.status === "verified_closed").map(item => item.findingId),
        openFindingIds: outcomes.filter(item => item.status !== "verified_closed").map(item => item.findingId),
        findingVerdicts: [...verdictByFindingId.values()],
        findingOutcomes: outcomes
      }
    });
  }

  const exhausted =
    cycle.status === "escalated" &&
    (result.status === "failed" ||
      cycle.currentIteration >= cycle.maxIterations ||
      /iteration limit|max_iterations/i.test(cycle.escalation?.reason ?? ""));
  return ReworkResolutionDossierSchema.parse({
    ...dossier,
    verificationOutcome: {
      status: exhausted ? "exhausted_failed" : "escalated_blocked",
      verificationId: result.verificationId,
      cycleNumber: result.cycleNumber,
      verifiedBy: result.verifiedBy,
      verifiedAt: result.completedAt,
      remainingFindingCount: result.findings.filter(item => item.severity === "error").length,
      reason: cycle.escalation?.reason ?? "Verification did not pass within bounded rework policy",
      closedFindingIds: [],
      openFindingIds: dossier.findingResolutions.map(item => item.findingId),
      findingVerdicts: [...verdictByFindingId.values()],
      findingOutcomes: dossier.findingResolutions.map(item => {
        const explicitVerdict = verdictByFindingId.get(item.findingId);
        return {
          findingId: item.findingId,
          disposition: item.disposition,
          status: explicitVerdict?.verdict === "rejected" || rejectedPriorIds.has(item.findingId) ? "rejected_by_verification" : "unverified",
          ...(explicitVerdict?.summary ? { verdictSummary: explicitVerdict.summary } : {})
        };
      })
    }
  });
}
