import { z } from "zod";
import {
  ApprovalDecisionSchema, ApprovalRequestSchema, ApprovalStatusSchema, ArtifactReferenceSchema, IsoDateTimeSchema,
  type ApprovalDecision, type ApprovalRequest, type WorkflowDefinition
} from "@bflow/contracts";
import { digest } from "./journal.js";
import { isSensitiveKey } from "../resilience/redaction.js";

/**
 * Optional prototype review branch, held as private Runtime state on the run (never a public contract and never a second
 * workflow engine). A prototype is a lightweight accepted scope plus artifacts stored only in ArtifactStore under the
 * logical `prototype/` namespace; nothing is written to the repository, deployed or connected to real data. Its approval
 * is a separate gate: it never satisfies design approval or delivery acceptance and never proves product criteria.
 */
export const PROTOTYPE_TASK = "prototype";
export const PROTOTYPE_ROOT = "prototype";
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_SCOPES = 20;
const MAX_VERSIONS = 50;

const text = (max: number) => z.string().trim().min(1).max(max);
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const LogicalPath = z.string().min(1).max(256).refine(path => path === PROTOTYPE_ROOT || path.startsWith(`${PROTOTYPE_ROOT}/`),
  `Prototype paths must stay inside the logical ${PROTOTYPE_ROOT}/ area`).refine(path => !path.includes("\\") && !path.endsWith("/") &&
  path.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".."), "Prototype paths must be normalized relative paths");
const within = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export const PrototypeScopeSchema = z.object({
  purpose: text(2000),
  flows: z.array(z.object({ id: Id, description: text(1000) }).strict()).min(1).max(20),
  allowedPaths: z.array(LogicalPath).min(1).max(20),
  artifacts: z.array(text(200)).min(1).max(20),
  /** Prototype-only review criteria. They are never product acceptance criteria. */
  criteria: z.array(z.object({ id: Id, description: text(1000), flowIds: z.array(Id).min(1).max(20) }).strict()).min(1).max(30),
  disposition: z.enum(["throwaway", "evolvable"]),
  environment: z.literal("mock"),
  dataPolicy: z.enum(["synthetic", "anonymized_fixture"]),
  maxRevisions: z.number().int().min(1).max(10).default(3)
}).strict().superRefine((scope, context) => {
  const flows = new Set(scope.flows.map(flow => flow.id));
  if (flows.size !== scope.flows.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate prototype flow id", path: ["flows"] });
  if (new Set(scope.criteria.map(item => item.id)).size !== scope.criteria.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate prototype criterion id", path: ["criteria"] });
  for (const [index, criterion] of scope.criteria.entries()) for (const flowId of criterion.flowIds) if (!flows.has(flowId))
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Criterion ${criterion.id} names unknown flow ${flowId}`, path: ["criteria", index, "flowIds"] });
  for (const flow of scope.flows) if (!scope.criteria.some(criterion => criterion.flowIds.includes(flow.id)))
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Flow ${flow.id} has no review criterion`, path: ["criteria"] });
});
export type PrototypeScope = z.infer<typeof PrototypeScopeSchema>;

export const PrototypeSubmissionSchema = z.object({
  scopeVersion: z.number().int().positive(),
  summary: text(2000),
  files: z.array(z.object({
    path: LogicalPath,
    mediaType: z.enum(["text/html", "text/css", "text/javascript", "text/markdown", "text/plain", "application/json", "image/svg+xml"]),
    content: z.string().min(1).max(MAX_FILE_BYTES),
    flowIds: z.array(Id).min(1).max(20)
  }).strict()).min(1).max(50)
}).strict();
export type PrototypeSubmission = z.infer<typeof PrototypeSubmissionSchema>;

const PrototypeFileSchema = z.object({ path: LogicalPath, mediaType: z.string().min(1), flowIds: z.array(Id).min(1), artifact: ArtifactReferenceSchema }).strict();
const PrototypeVersionSchema = z.object({
  version: z.number().int().positive(), scopeVersion: z.number().int().positive(), scopeDigest: Hex64,
  manifest: ArtifactReferenceSchema, manifestDigest: Hex64, files: z.array(PrototypeFileSchema).min(1),
  flowDigests: z.record(Hex64), summary: text(2000), submittedAt: IsoDateTimeSchema
}).strict();
const PrototypeApprovalSchema = z.object({
  request: ApprovalRequestSchema, version: z.number().int().positive(), scopeVersion: z.number().int().positive(), scopeDigest: Hex64,
  manifestDigest: Hex64, reviewFlows: z.array(Id), carriedFlows: z.array(Id), status: ApprovalStatusSchema,
  decision: ApprovalDecisionSchema.optional(), closedReason: text(500).optional()
}).strict();
const FlowApprovalSchema = z.object({
  flowDigest: Hex64, approvalId: z.string().min(1), version: z.number().int().positive(), decidedBy: z.string().min(1), decidedAt: IsoDateTimeSchema
}).strict();
const PrototypeAcceptanceSchema = z.object({
  approvalId: z.string().min(1), version: z.number().int().positive(), manifestDigest: Hex64, scopeVersion: z.number().int().positive(), scopeDigest: Hex64,
  approvedFlows: z.array(Id).min(1), disposition: z.enum(["throwaway", "evolvable"]), retentionAuthorized: z.boolean(),
  decidedBy: z.string().min(1), decidedAt: IsoDateTimeSchema, provesAcceptanceCriteria: z.literal(false)
}).strict();
export const PrototypeStatusSchema = z.enum(["awaiting_artifact", "awaiting_review", "revision_requested", "accepted", "rejected", "cancelled", "superseded", "escalated"]);
export const PrototypeRecordSchema = z.object({
  schemaVersion: z.literal(1),
  status: PrototypeStatusSchema,
  requirementRevision: z.number().int().positive(),
  scopes: z.array(z.object({ version: z.number().int().positive(), digest: Hex64, scope: PrototypeScopeSchema, acceptedAt: IsoDateTimeSchema }).strict()).min(1).max(MAX_SCOPES),
  versions: z.array(PrototypeVersionSchema).max(MAX_VERSIONS),
  approvals: z.array(PrototypeApprovalSchema).max(MAX_VERSIONS),
  approvedFlows: z.record(FlowApprovalSchema),
  feedback: z.array(z.object({
    approvalId: z.string().min(1), version: z.number().int().positive(), kind: z.enum(["prototype_revision", "specification_revision_proposal"]),
    reason: text(2000), decidedBy: z.string().min(1), decidedAt: IsoDateTimeSchema, artifacts: z.array(ArtifactReferenceSchema)
  }).strict()).max(50),
  revisionsRequested: z.number().int().nonnegative(),
  acceptance: PrototypeAcceptanceSchema.optional()
}).strict();
export type PrototypeRecord = z.infer<typeof PrototypeRecordSchema>;
export type PrototypeApproval = PrototypeRecord["approvals"][number];
export type PrototypeVersion = PrototypeRecord["versions"][number];

const CLOSED: readonly PrototypeRecord["status"][] = ["rejected", "cancelled", "escalated"];

export function currentScope(record: PrototypeRecord): PrototypeRecord["scopes"][number] { return record.scopes.at(-1)!; }
export function prototypeApproval(record: PrototypeRecord | undefined, approvalId: string): PrototypeApproval | undefined {
  return record?.approvals.find(entry => entry.request.approvalId === approvalId);
}
export function pendingPrototypeApprovals(record: PrototypeRecord | undefined): ApprovalRequest[] {
  return (record?.approvals ?? []).filter(entry => entry.status === "pending").map(entry => entry.request);
}
/** Why a decision for a known prototype approval can no longer be applied; undefined while it is pending or unknown. */
export function prototypeDecisionRefusal(record: PrototypeRecord | undefined, approvalId: string): string | undefined {
  const entry = prototypeApproval(record, approvalId);
  if (!entry || entry.status === "pending") return undefined;
  return `Prototype approval ${approvalId} is ${entry.status}${entry.closedReason ? `: ${entry.closedReason}` : ""}; it is no longer pending`;
}

function close(record: PrototypeRecord, status: "superseded" | "cancelled", reason: string): PrototypeApproval[] {
  const closed = record.approvals.filter(entry => entry.status === "pending");
  for (const entry of closed) {
    entry.status = status; entry.closedReason = reason;
    entry.request = ApprovalRequestSchema.parse({ ...entry.request, status });
  }
  return closed;
}

/**
 * Accepts the first scope or a scope revision. An identical scope is an idempotent retry. A revision supersedes every pending
 * approval and every flow approval: a decision on the previous scope never carries to the revised one.
 */
export function acceptPrototypeScope(previous: PrototypeRecord | undefined, input: unknown, context: {
  now: string; requirementRevision: number; productCriterionIds: readonly string[];
}): { record: PrototypeRecord; changed: boolean; superseded: PrototypeApproval[] } {
  const scope = PrototypeScopeSchema.parse(input);
  const reused = scope.criteria.filter(criterion => context.productCriterionIds.includes(criterion.id)).map(criterion => criterion.id);
  if (reused.length) throw new Error(`Prototype criteria must not reuse product acceptance criteria (${reused.join(", ")}); prototype approval never proves them`);
  const scopeDigest = digest(scope);
  const fresh = !previous || previous.requirementRevision !== context.requirementRevision || previous.status === "superseded";
  if (!fresh && CLOSED.includes(previous!.status)) throw new Error(`Prototype review is ${previous!.status}; it cannot be reopened`);
  if (!fresh && currentScope(previous!).digest === scopeDigest) return { record: previous!, changed: false, superseded: [] };
  if (fresh) return { changed: true, superseded: [], record: PrototypeRecordSchema.parse({ schemaVersion: 1, status: "awaiting_artifact",
    requirementRevision: context.requirementRevision, scopes: [{ version: 1, digest: scopeDigest, scope, acceptedAt: context.now }],
    versions: [], approvals: [], approvedFlows: {}, feedback: [], revisionsRequested: 0 }) };
  const record = previous!, version = currentScope(record).version + 1;
  if (record.scopes.length >= MAX_SCOPES) throw new Error(`Prototype scope revision limit (${MAX_SCOPES}) reached; ask the user through Conversation how to proceed`);
  const superseded = close(record, "superseded", `Prototype scope revised to v${version}`);
  record.scopes.push({ version, digest: scopeDigest, scope, acceptedAt: context.now });
  record.approvedFlows = {}; delete record.acceptance; record.status = "awaiting_artifact";
  return { record: PrototypeRecordSchema.parse(record), changed: true, superseded };
}

const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|(?:[a-z0-9-]+\.)*(?:example|test|invalid|localhost)|(?:[a-z0-9-]+\.)*example\.(?:com|org|net))$/iu;
/**
 * Namespace and public DTD identifiers name a vocabulary and are removed before the host scan. A DOCTYPE with an internal subset
 * (entities that may be fetched) is kept and scanned.
 */
const IDENTIFIER_URIS = /\bxmlns(?::[\w.-]+)?\s*=\s*(?:"[^"]*"|'[^']*')|<!DOCTYPE\b[^>[]*>/giu;
/** Value shapes that are credentials wherever they appear. */
const SECRET_SHAPES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u, /\b(?:sk|rk)-[A-Za-z0-9_-]{12,}/u, /\bgh[pousr]_[A-Za-z0-9]{20,}/u, /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bglpat-[A-Za-z0-9_-]{20,}/u, /\bxox[abprs]-[A-Za-z0-9-]{10,}/u, /\bAIza[0-9A-Za-z_-]{20,}/u, /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u, /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"'<>]+:[^@\s/"'<>]+@/iu
];
/**
 * `key: value` / `key=value` (JSON, headers, query strings, attributes), and a standalone `Bearer value`. The value is a
 * lookahead so a quoted attribute value (`href="/api?api_key=…"`) is still scanned for the assignments it contains.
 */
const ASSIGNMENT = /([A-Za-z][\w-]*)["']?\s*[:=]\s*(?=(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`|((?:(?:Bearer|Basic)\s+)?[^\s"'`<>,;&()]+)))/gu;
const AUTH_SCHEME = /\bBearer\s+([^\s"'`<>,;&()]+)/gu;
/** Masks and template slots stand in for a credential. After an auth scheme only these count as mock values. */
const MASK = /^(?:|[*•xX]{3,}|\.{3}|…|<[^<>]*>|\{\{[^{}]*\}\}|\$\{[^{}]*\})$/u;
/** A plain word or phrase without digits (a label or status such as `Pending`, `Đang chờ`, `form.password`). */
const PLAIN = /^[\p{L}_$][\p{L}_$. -]{0,63}$/u;
const isMockValue = (raw: string) => {
  const value = raw.trim(), credential = value.replace(/^(?:Bearer|Basic)\s+/u, "");
  return MASK.test(credential) || credential === value && PLAIN.test(value);
};

/**
 * Prototype-specific credential check. The log redactor is deliberately broad (`Authorization: Pending` is redacted) and
 * misses query keys inside quoted attributes, so it is not reused here. This scan rejects known secret shapes anywhere and
 * any non-mock value of a sensitive key; it is a heuristic, not proof that data is synthetic.
 */
export function credentialLike(content: string): string | undefined {
  for (const shape of SECRET_SHAPES) { const match = shape.exec(content); if (match) return match[0].slice(0, 12); }
  for (const match of content.matchAll(ASSIGNMENT)) {
    const value = match[2] ?? match[3] ?? match[4] ?? match[5]!;
    if (isSensitiveKey(match[1]!) && !isMockValue(value)) return match[1];
  }
  for (const match of content.matchAll(AUTH_SCHEME)) if (!MASK.test(match[1]!)) return "Bearer";
  return undefined;
}

/**
 * Content checks before anything is stored: paths stay inside the accepted area, each file demonstrates declared flows,
 * every flow is demonstrated, and the mock neither embeds credentials nor targets a real external endpoint.
 */
export function validatePrototypeContent(scope: PrototypeScope, submission: PrototypeSubmission): void {
  const flows = new Set(scope.flows.map(flow => flow.id));
  if (new Set(submission.files.map(file => file.path)).size !== submission.files.length) throw new Error("Duplicate prototype file path");
  let total = 0;
  for (const file of submission.files) {
    if (!scope.allowedPaths.some(prefix => within(file.path, prefix))) throw new Error(`Prototype file ${file.path} is outside the accepted prototype area`);
    for (const flowId of file.flowIds) if (!flows.has(flowId)) throw new Error(`Prototype file ${file.path} names unknown flow ${flowId}`);
    total += Buffer.byteLength(file.content);
    const credential = credentialLike(file.content);
    if (credential !== undefined) throw new Error(`Prototype file ${file.path} contains credential-like content (${credential}); prototypes use synthetic data only`);
    for (const match of file.content.replace(IDENTIFIER_URIS, "").matchAll(/\b(?:https?|wss?):\/\/(\[[^\]\s]*\]|[^/\s"'`<>:?#[]+)/giu))
      if (!LOCAL_HOST.test(match[1]!)) throw new Error(`Prototype file ${file.path} targets external endpoint ${match[1]}; prototypes must use mocks`);
  }
  if (total > MAX_TOTAL_BYTES) throw new Error("Prototype artifact exceeds the 1 MiB review bound");
  const missing = scope.flows.filter(flow => !submission.files.some(file => file.flowIds.includes(flow.id))).map(flow => flow.id);
  if (missing.length) throw new Error(`Prototype artifact does not demonstrate flow(s) ${missing.join(", ")}`);
}

/** Canonical manifest of what a reviewer sees; the summary is commentary and does not change the artifact identity. */
export function prototypeManifest(runId: string, scope: PrototypeRecord["scopes"][number], files: { path: string; mediaType: string; flowIds: string[]; sha256: string }[]) {
  const entries = [...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ ...file, flowIds: [...file.flowIds].sort() }));
  const flowDigests = Object.fromEntries(scope.scope.flows.map(flow => [flow.id,
    digest(entries.filter(file => file.flowIds.includes(flow.id)).map(file => [file.path, file.mediaType, file.sha256]))]));
  const body = { schemaVersion: 1, kind: "bflow.prototype-manifest", runId, scopeVersion: scope.version, scopeDigest: scope.digest, files: entries };
  return { body, manifestDigest: digest(body), flowDigests };
}

/** Which prior flow approvals still apply to a new artifact: only flows whose exact content digest is unchanged. */
export function assessPriorApproval(record: PrototypeRecord, flowDigests: Record<string, string>): { carriedFlows: string[]; reviewFlows: string[] } {
  const flows = currentScope(record).scope.flows.map(flow => flow.id);
  const carriedFlows = flows.filter(flow => record.approvedFlows[flow]?.flowDigest === flowDigests[flow]);
  return { carriedFlows, reviewFlows: flows.filter(flow => !carriedFlows.includes(flow)) };
}

/** Records a new artifact version, supersedes any pending review and withdraws an acceptance that no longer matches. */
export function admitPrototypeVersion(record: PrototypeRecord, input: { runId: string; sessionId?: string | undefined; now: string;
  version: Omit<PrototypeVersion, "version" | "scopeVersion" | "scopeDigest" | "submittedAt">; }): { approval: PrototypeApproval; superseded: PrototypeApproval[] } {
  if (record.versions.length >= MAX_VERSIONS) throw new Error(`Prototype version limit (${MAX_VERSIONS}) reached; ask the user through Conversation how to proceed`);
  const scope = currentScope(record), version = (record.versions.at(-1)?.version ?? 0) + 1;
  const entry: PrototypeVersion = { ...input.version, version, scopeVersion: scope.version, scopeDigest: scope.digest, submittedAt: input.now };
  const { carriedFlows, reviewFlows } = assessPriorApproval(record, entry.flowDigests);
  const superseded = close(record, "superseded", `Prototype artifact v${version} replaced the version under review`);
  for (const flow of reviewFlows) delete record.approvedFlows[flow];
  delete record.acceptance;
  const disposition = scope.scope.disposition;
  const reason = `Duyệt prototype v${version} (chỉ duyệt bản mẫu, KHÔNG phải duyệt thiết kế chi tiết hay nghiệm thu sản phẩm). ` +
    `Mục đích: ${scope.scope.purpose}. Luồng cần xem: ${reviewFlows.join(", ")}` + (carriedFlows.length ? `; luồng giữ nguyên duyệt cũ: ${carriedFlows.join(", ")}` : "") +
    `. Loại: ${disposition === "throwaway" ? "dùng xong bỏ (không giữ code)" : "được phép phát triển tiếp; duyệt bản này cho phép giữ code prototype, và code giữ lại vẫn phải qua verification chính thức"}.`;
  const request = ApprovalRequestSchema.parse({ schemaVersion: 2,
    approvalId: `prototype-${digest([input.runId, record.requirementRevision, scope.digest, version, entry.manifestDigest]).slice(0, 32)}`,
    runId: input.runId, ...(input.sessionId ? { sessionId: input.sessionId } : {}), status: "pending",
    target: { type: "task", taskId: PROTOTYPE_TASK }, revision: version, generation: scope.version,
    requestedBy: "coordinator", requestedAt: input.now, reason: reason.slice(0, 4000),
    evidence: [entry.manifest, ...entry.files.map(file => file.artifact)], idempotencyKey: `prototype-approval:${input.runId}:r${record.requirementRevision}:v${version}`,
    metadata: { kind: "prototype_review", prototypeVersion: version, scopeVersion: scope.version, scopeDigest: scope.digest, manifestDigest: entry.manifestDigest,
      reviewFlows, carriedFlows, criteria: scope.scope.criteria.map(criterion => criterion.id), disposition,
      approves: "prototype_only", provesAcceptanceCriteria: false } });
  const approval: PrototypeApproval = { request, version, scopeVersion: scope.version, scopeDigest: scope.digest, manifestDigest: entry.manifestDigest,
    reviewFlows, carriedFlows, status: "pending" };
  record.versions.push(entry); record.approvals.push(approval); record.status = "awaiting_review";
  PrototypeRecordSchema.parse(record);
  return { approval, superseded };
}

/** Exact binding of a human decision to its pending prototype request. */
export function assertPrototypeDecision(entry: PrototypeApproval, decision: ApprovalDecision, now: string): void {
  const request = entry.request;
  if (entry.status !== "pending" || decision.approvalId !== request.approvalId || decision.runId !== request.runId || decision.sessionId !== request.sessionId ||
      decision.revision !== request.revision || decision.generation !== request.generation || digest(decision.target) !== digest(request.target) ||
      Date.parse(decision.decidedAt) < Date.parse(request.requestedAt) || Date.parse(decision.decidedAt) > Date.parse(now) ||
      request.expiresAt !== undefined && Date.parse(now) >= Date.parse(request.expiresAt))
    throw new Error("Stale or mismatched prototype approval decision");
  if (decision.decidedBy === "coordinator" || decision.decidedBy === "runtime") throw new Error("Prototype review requires a human decision");
}

/** Applies an authenticated, verified decision to the record. Returns the business outcome for the run. */
export function settlePrototypeDecision(record: PrototypeRecord, entry: PrototypeApproval, decision: ApprovalDecision):
  "accepted" | "revision_requested" | "rejected" | "escalated" {
  entry.decision = decision;
  entry.status = decision.decision;
  entry.request = ApprovalRequestSchema.parse({ ...entry.request, status: decision.decision });
  const scope = currentScope(record), version = record.versions.find(item => item.version === entry.version)!;
  if (decision.decision === "approved") {
    for (const flow of scope.scope.flows) record.approvedFlows[flow.id] = { flowDigest: version.flowDigests[flow.id]!, approvalId: decision.approvalId,
      version: entry.version, decidedBy: decision.decidedBy, decidedAt: decision.decidedAt };
    record.acceptance = { approvalId: decision.approvalId, version: entry.version, manifestDigest: entry.manifestDigest, scopeVersion: scope.version,
      scopeDigest: scope.digest, approvedFlows: scope.scope.flows.map(flow => flow.id), disposition: scope.scope.disposition,
      retentionAuthorized: scope.scope.disposition === "evolvable", decidedBy: decision.decidedBy, decidedAt: decision.decidedAt, provesAcceptanceCriteria: false };
    record.status = "accepted";
  } else if (decision.decision === "rejected") record.status = "rejected";
  else {
    record.revisionsRequested += 1;
    // Feedback never edits accepted requirements. Only an explicit marker classifies it as a specification revision proposal,
    // which the Coordinator must turn into a scope revision or a requirement change through Conversation.
    const kind = decision.metadata?.feedbackKind === "specification_revision" ? "specification_revision_proposal" : "prototype_revision";
    record.feedback.push({ approvalId: decision.approvalId, version: entry.version, kind, reason: decision.reason!.slice(0, 2000),
      decidedBy: decision.decidedBy, decidedAt: decision.decidedAt, artifacts: decision.feedbackArtifacts });
    record.status = record.revisionsRequested > scope.scope.maxRevisions ? "escalated" : "revision_requested";
  }
  PrototypeRecordSchema.parse(record);
  return record.status === "accepted" ? "accepted" : record.status === "rejected" ? "rejected" : record.status === "escalated" ? "escalated" : "revision_requested";
}

/** Requirement revisions and cancellation close the branch; returned approvals are no longer answerable. */
export function closePrototype(record: PrototypeRecord, status: "superseded" | "cancelled", reason: string): PrototypeApproval[] {
  const closed = close(record, status, reason);
  if (status === "superseded" || !["accepted", "rejected", "escalated"].includes(record.status)) record.status = status;
  if (status === "superseded") { record.approvedFlows = {}; delete record.acceptance; }
  return closed;
}

/**
 * Formal design input from an accepted prototype. Throws while the branch is open. Tasks may retain prototype code only for
 * an approved evolvable prototype; the retained code is then implemented and verified like any other task output.
 */
export function prototypeDesignInput(record: PrototypeRecord | undefined, definition: WorkflowDefinition) {
  // A prototype superseded by a requirement revision answered the old requirement: it neither blocks nor feeds the new design.
  if (!record || record.status === "superseded") {
    if (definition.tasks.some(task => task.metadata?.retainsPrototype === true)) throw new Error("metadata.retainsPrototype needs an accepted evolvable prototype");
    return undefined;
  }
  const acceptance = record.acceptance;
  if (record.status !== "accepted" || !acceptance) throw new Error(`The prototype must be accepted before the formal design (prototype is ${record.status})`);
  const latest = record.versions.at(-1)!, scope = currentScope(record);
  if (latest.manifestDigest !== acceptance.manifestDigest || latest.version !== acceptance.version || scope.digest !== acceptance.scopeDigest)
    throw new Error("Prototype acceptance does not match the current prototype artifact or scope");
  const retainedByTasks = definition.tasks.filter(task => task.metadata?.retainsPrototype === true).map(task => task.id);
  if (retainedByTasks.length && acceptance.disposition === "throwaway")
    throw new Error(`Prototype v${acceptance.version} is throwaway; tasks ${retainedByTasks.join(", ")} must re-implement from the formal specification instead of retaining its code`);
  if (retainedByTasks.length && !acceptance.retentionAuthorized) throw new Error("Retaining prototype code needs an approved evolvable prototype");
  return { approvalId: acceptance.approvalId, version: acceptance.version, manifestDigest: acceptance.manifestDigest, scopeVersion: acceptance.scopeVersion,
    disposition: acceptance.disposition, retainedByTasks, manifest: latest.manifest, inputOnly: true as const };
}

/** Compact view returned to the Coordinator. */
export function prototypeView(record: PrototypeRecord) {
  const scope = currentScope(record), pending = record.approvals.find(entry => entry.status === "pending");
  return { status: record.status, scopeVersion: scope.version, disposition: scope.scope.disposition, latestVersion: record.versions.at(-1)?.version ?? null,
    pendingApprovalId: pending?.request.approvalId ?? null, reviewFlows: pending?.reviewFlows ?? [], carriedFlows: pending?.carriedFlows ?? [],
    revisionsRequested: record.revisionsRequested, maxRevisions: scope.scope.maxRevisions, feedback: record.feedback.slice(-3),
    acceptance: record.acceptance ?? null };
}
