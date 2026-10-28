import { z } from "zod";
import { ArtifactChecksumSchema, IsoDateTimeSchema } from "@bflow/contracts";

/** Runtime-owned handover package format (HX-01). Strict and versioned; readers reject unknown versions. */
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{7,40}$/);
const text = z.string().max(4000);
const id = z.string().min(1).max(300);

export const HandoverStatusSchema = z.enum(["eligible", "partial", "draft"]);
export type HandoverStatus = z.infer<typeof HandoverStatusSchema>;
export const HandoverVerdictSchema = z.enum(["passed", "failed", "blocked", "inconclusive", "waived", "not_verified"]);
export type HandoverVerdict = z.infer<typeof HandoverVerdictSchema>;
export const EvidenceIntegritySchema = z.enum(["verified", "missing", "corrupt", "identity_mismatch", "unavailable"]);
export type EvidenceIntegrity = z.infer<typeof EvidenceIntegritySchema>;

export const HandoverReasonSchema = z.object({ code: z.string().regex(/^[a-z_]+$/), message: text }).strict();
export type HandoverReason = z.infer<typeof HandoverReasonSchema>;

/** Exporter format version: part of the content digest and the manifest, so a format change is never silently "reused". */
export const HANDOVER_EXPORTER_VERSION = 1;
export const HandoverEvidencePathSchema = z.string().regex(/^evidence\/[a-f0-9]{64}\.txt$/);
export const HandoverPackagingSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("packaged"), path: HandoverEvidencePathSchema, sha256, bytes: z.number().int().nonnegative(),
    redacted: z.boolean() }).strict(),
  z.object({ status: z.literal("not_packaged"),
    reason: z.enum(["not_requested", "kind_not_allowed", "not_verified", "too_large", "not_text", "total_limit"]) }).strict()
]);
export type HandoverPackaging = z.infer<typeof HandoverPackagingSchema>;

export const HandoverEvidenceSchema = z.object({
  artifactId: id, uri: z.string().regex(/^artifact:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/), kind: z.string().min(1).max(40),
  mediaType: z.string().min(1).max(200), taskId: id.optional(), checksum: ArtifactChecksumSchema,
  integrity: EvidenceIntegritySchema, packaging: HandoverPackagingSchema
}).strict();
export type HandoverEvidence = z.infer<typeof HandoverEvidenceSchema>;

export const HandoverCheckSchema = z.object({
  scope: z.enum(["task", "workflow"]), taskId: id, verificationId: id, cycleNumber: z.number().int().positive(),
  resultStatus: z.enum(["passed", "failed", "inconclusive", "blocked", "escalated"]), passed: z.boolean(),
  command: text.optional(), exitCode: z.number().int().optional(), summary: text,
  revision: commit.nullable(), revisionBinding: z.enum(["bound", "mismatch", "unbound"]), evidence: HandoverEvidenceSchema
}).strict();
export type HandoverCheck = z.infer<typeof HandoverCheckSchema>;

export const HandoverMatrixRowSchema = z.object({
  criterionId: id, required: z.boolean(), taskIds: z.array(id), integratedRevision: commit.nullable(),
  checks: z.array(HandoverCheckSchema), verdict: HandoverVerdictSchema, reasons: z.array(text)
}).strict();
export type HandoverMatrixRow = z.infer<typeof HandoverMatrixRowSchema>;

export const HandoverApprovalSchema = z.object({
  approvalId: id, kind: z.enum(["specification", "design", "task", "delivery", "user_decision"]), target: text,
  requestedAt: IsoDateTimeSchema, decision: z.enum(["approved", "rejected", "changes_requested", "pending", "answered", "expired", "cancelled"]),
  decidedBy: text.optional(), decidedAt: IsoDateTimeSchema.optional(),
  validity: z.enum(["valid", "stale", "superseded", "pending", "refused"]), reasons: z.array(text)
}).strict();
export type HandoverApproval = z.infer<typeof HandoverApprovalSchema>;

export const HandoverDocumentSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal("bflow.handover"),
  snapshot: z.object({ runId: id, snapshotId: sha256, journalVersion: z.number().int().positive() }).strict(),
  eligibility: z.object({ status: HandoverStatusSchema, reasons: z.array(HandoverReasonSchema) }).strict(),
  run: z.object({ status: z.string().min(1), title: text, baseRevision: z.string().nullable(), integratedRevision: commit.nullable(),
    cancelled: z.boolean(), supersededBy: id.nullable(), error: text.nullable() }).strict(),
  specification: z.object({ specId: id, version: z.number().int().positive(), level: z.string().min(1), status: z.string().min(1),
    title: text, summary: text, approval: z.enum(["approved", "not_approved"]), artifact: HandoverEvidenceSchema.nullable(),
    binding: z.enum(["bound", "mismatch", "unverified"]) }).strict().nullable(),
  criteria: z.array(z.object({ id, description: text, category: z.string().min(1), verificationMethod: z.string().min(1),
    required: z.boolean(), waiver: text.nullable() }).strict()),
  tasks: z.array(z.object({ taskId: id, title: text, criteria: z.array(id),
    outcome: z.enum(["passed", "failed", "blocked", "inconclusive", "in_progress", "not_started"]), cycleStatus: z.string().nullable(),
    iterations: z.number().int().nonnegative(), revision: commit.nullable(),
    integration: z.enum(["integrated", "not_integrated"]) }).strict()),
  matrix: z.array(HandoverMatrixRowSchema),
  findings: z.array(z.object({ scope: z.enum(["task", "workflow"]), taskId: id, verificationId: id, code: text,
    severity: z.enum(["info", "warning", "error"]), message: text, open: z.boolean() }).strict()),
  exceptions: z.array(z.object({ kind: z.enum(["criterion_waiver", "test_integrity_exception", "fast_path"]), subject: text,
    reason: text, valid: z.boolean() }).strict()),
  approvals: z.array(HandoverApprovalSchema),
  instructions: z.object({
    run: z.object({ status: z.enum(["available", "missing"]), expectedSource: text,
      commands: z.array(z.object({ command: text, source: text }).strict()) }).strict(),
    rollback: z.object({ status: z.enum(["available", "missing"]), expectedSource: text, text: text.nullable() }).strict()
  }).strict(),
  unverified: z.array(z.object({ criterionId: id.optional(), subject: text, reason: text }).strict()),
  evidence: z.array(HandoverEvidenceSchema)
}).strict();
export type HandoverDocument = z.infer<typeof HandoverDocumentSchema>;

export const HANDOVER_CONTENT_FILES = ["handover.json", "handover.md", "index.html"] as const;
export const HandoverFormatSchema = z.enum(["html", "md"]);
export type HandoverFormat = z.infer<typeof HandoverFormatSchema>;

export const HandoverManifestSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal("bflow.handover.manifest"),
  status: HandoverStatusSchema,
  snapshot: z.object({ runId: id, snapshotId: sha256, integratedRevision: commit.nullable() }).strict(),
  contentDigest: sha256,
  files: z.array(z.object({ path: z.union([z.enum(HANDOVER_CONTENT_FILES), HandoverEvidencePathSchema]), sha256, bytes: z.number().int().nonnegative(),
    mediaType: z.string().min(1) }).strict()).min(1),
  sources: z.array(z.object({ kind: z.enum(["journal_run", "journal_file", "artifact"]), locator: z.string().min(1).max(500),
    digest: z.string().min(1).max(200) }).strict()),
  exporter: z.object({ name: z.literal("bflow-handover"), version: z.literal(HANDOVER_EXPORTER_VERSION) }).strict(),
  exportedAt: IsoDateTimeSchema
}).strict();
export type HandoverManifest = z.infer<typeof HandoverManifestSchema>;

export const HandoverInspectionSchema = z.object({
  runId: id, snapshotId: sha256, runStatus: z.string().min(1), integratedRevision: commit.nullable(),
  status: HandoverStatusSchema, reasons: z.array(HandoverReasonSchema)
}).strict();
export type HandoverInspection = z.infer<typeof HandoverInspectionSchema>;

export const HandoverExportResultSchema = z.object({
  outcome: z.enum(["published", "reused", "replaced"]), status: HandoverStatusSchema, runId: id, snapshotId: sha256,
  integratedRevision: commit.nullable(), contentDigest: sha256, files: z.array(z.string().min(1)), reasons: z.array(HandoverReasonSchema)
}).strict();
export type HandoverExportResult = z.infer<typeof HandoverExportResultSchema>;

export const HandoverVerificationSchema = z.object({
  valid: z.boolean(), status: HandoverStatusSchema.nullable(), runId: id.nullable(), snapshotId: sha256.nullable(),
  problems: z.array(text)
}).strict();
export type HandoverVerification = z.infer<typeof HandoverVerificationSchema>;
