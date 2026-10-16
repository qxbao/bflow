import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ApprovalDecisionSchema, ApprovalRequestSchema, ArtifactReferenceSchema,
  IdentifierSchema, IsoDateTimeSchema, OperationResultSchema, WorkflowDefinitionSchema,
  type ApprovalDecision, type ArtifactReference, type ArtifactStore, type Specification
} from "@bflow/contracts";
import { classifyChange } from "./classification.js";
import { canonicalJson, contentBytes, digest } from "./content.js";
import { parseSpecification, policyDetails } from "./schema.js";
import { detectSpecChanges, validateTraceability } from "./traceability.js";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const RequestOptionsSchema = z.object({
  approvalId: IdentifierSchema,
  requestedBy: IdentifierSchema,
  expiresAt: IsoDateTimeSchema.optional()
}).strict();

export interface SpecificationEngineOptions {
  readonly artifactStore: ArtifactStore;
  /** Trusted Runtime authorization, never a flag or identity supplied by an agent. */
  readonly authorizeApprover: (decision: ApprovalDecision, humanRequired: boolean) => boolean | Promise<boolean>;
  readonly clock?: () => Date;
}

/** Stateless policy service: Runtime persists current version and authoritative approval lifecycle. */
export class SpecificationEngine {
  private readonly store: ArtifactStore;
  private readonly authorize: SpecificationEngineOptions["authorizeApprover"];
  private readonly clock: () => Date;

  constructor(options: SpecificationEngineOptions) {
    this.store = options.artifactStore;
    this.authorize = options.authorizeApprover;
    this.clock = options.clock ?? (() => new Date());
  }

  createDraft(input: unknown): Specification {
    const spec = parseSpecification(input);
    this.assertDraft(spec);
    if (spec.version !== 1) throw new Error("New specifications start at version 1");
    return spec;
  }

  async revise(previousInput: unknown, proposedInput: unknown, reasonInput: unknown) {
    const previous = parseSpecification(previousInput);
    const proposed = parseSpecification(proposedInput);
    if (previous.artifactRef) await this.verifyArtifact(previous);
    this.assertDraft(proposed);
    const reason = z.string().trim().min(1).parse(reasonInput);
    if (previous.specId !== proposed.specId || previous.runId !== proposed.runId || previous.sessionId !== proposed.sessionId || previous.createdAt !== proposed.createdAt) {
      throw new Error("A revision must preserve specification identity, run, session and creation time");
    }
    if (proposed.version !== previous.version! + 1) throw new Error("Revision must increment version exactly once");
    if (Date.parse(proposed.updatedAt) < Date.parse(previous.updatedAt)) throw new Error("Revision time cannot move backwards");
    const next = parseSpecification({ ...proposed, metadata: { ...proposed.metadata,
      sdd: { ...policyDetails(proposed), revisionReason: reason } } });
    const impact = detectSpecChanges(previous, next);
    if (!impact.requiresReapproval) throw new Error("Revision must change requirements or acceptance criteria");
    return { specification: next, impact };
  }

  async submitForReview(input: unknown): Promise<Specification> {
    const spec = parseSpecification(input);
    this.assertDraft(spec);
    this.assertClear(spec);
    if (!spec.runId) throw new Error("A run ID is required to persist a specification artifact");
    const bytes = contentBytes(spec);
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Specification exceeds document size limit");
    const checksum = digest(bytes);
    const result = OperationResultSchema(ArtifactReferenceSchema).parse(await this.store.put({
      options: {
        artifactId: `spec-${checksum}`,
        runId: spec.runId,
        kind: "document",
        mediaType: "application/json",
        expectedIntegrity: { checksum: { algorithm: "sha256", value: checksum }, sizeBytes: bytes.length },
        idempotencyKey: `specification:${checksum}`
      },
      content: (async function* () { yield bytes; })()
    }));
    if (!result.ok) throw new Error(`ArtifactStore put failed: ${result.error.code}`);
    const reference = result.value;
    if (reference.runId !== spec.runId || reference.kind !== "document" || reference.mediaType !== "application/json" ||
        reference.checksum.algorithm !== "sha256" || reference.checksum.value !== checksum || reference.sizeBytes !== bytes.length) {
      throw new Error("ArtifactStore returned a mismatched document reference");
    }
    return parseSpecification({ ...spec, status: "review_pending", artifactRef: reference });
  }

  async requestApproval(input: unknown, optionsInput: unknown) {
    const spec = parseSpecification(input);
    const options = RequestOptionsSchema.parse(optionsInput);
    if (spec.status !== "review_pending") throw new Error("Specification must be pending review");
    this.assertClear(spec);
    await this.verifyArtifact(spec);
    const now = this.now();
    if (options.expiresAt && Date.parse(options.expiresAt) <= Date.parse(now)) throw new Error("Approval expiry must be in the future");
    return ApprovalRequestSchema.parse({
      schemaVersion: 2, approvalId: options.approvalId, runId: spec.runId, sessionId: spec.sessionId,
      status: "pending", ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      target: { type: "specification", specId: spec.specId }, revision: spec.version, generation: 0,
      requestedBy: options.requestedBy, requestedAt: now,
      reason: classifyChange(policyDetails(spec).assessment, spec.affectedPaths).humanApprovalRequired
        ? "Human design approval required before implementation" : "Specification acceptance required before implementation",
      evidence: [spec.artifactRef], idempotencyKey: `spec-approval:${options.approvalId}:${digest(contentBytes(spec))}`,
      metadata: { specificationDigest: digest(contentBytes(spec)) }
    });
  }

  async approve(input: unknown, requestInput: unknown, decisionInput: unknown): Promise<Specification> {
    const spec = parseSpecification(input);
    if (spec.status !== "review_pending") throw new Error("Only a reviewed specification can be approved");
    const request = ApprovalRequestSchema.parse(requestInput);
    if (request.expiresAt && Date.parse(request.expiresAt) <= Date.parse(this.now())) throw new Error("Approval request expired");
    const decision = await this.verifyApproval(spec, request, decisionInput);
    return parseSpecification({ ...spec, status: "approved", approvedBy: decision.decidedBy, updatedAt: decision.decidedAt });
  }

  async assertImplementationReady(input: unknown, requestInput: unknown, decisionInput: unknown, workflowInput: unknown): Promise<void> {
    const spec = parseSpecification(input);
    if (spec.status !== "approved") throw new Error("Implementation requires an approved specification");
    const workflow = WorkflowDefinitionSchema.parse(workflowInput);
    const decision = await this.verifyApproval(spec, requestInput, decisionInput);
    if (spec.approvedBy !== decision.decidedBy || spec.updatedAt !== decision.decidedAt) throw new Error("Approval identity or time was modified");
    validateTraceability(spec, workflow);
  }

  /** Detects edits to any reviewed content, including acceptance status/evidence and policy metadata. */
  async verifyArtifact(input: unknown): Promise<ArtifactReference> {
    const spec = parseSpecification(input);
    const reference = ArtifactReferenceSchema.parse(spec.artifactRef);
    if (reference.runId !== spec.runId || reference.kind !== "document" || reference.mediaType !== "application/json") {
      throw new Error("Specification artifact must be a JSON document in the same run");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const hash = createHash(reference.checksum.algorithm);
    for await (const item of this.store.get(reference)) {
      const chunk = OperationResultSchema(z.instanceof(Uint8Array)).parse(item);
      if (!chunk.ok) throw new Error(`ArtifactStore get failed: ${chunk.error.code}`);
      const owned = Buffer.from(chunk.value);
      size += owned.length;
      if (size > MAX_DOCUMENT_BYTES) throw new Error("Specification exceeds document size limit");
      hash.update(owned);
      chunks.push(owned);
    }
    if (hash.digest("hex") !== reference.checksum.value || (reference.sizeBytes !== undefined && size !== reference.sizeBytes)) {
      throw new Error("Specification artifact integrity check failed");
    }
    if (!Buffer.concat(chunks).equals(contentBytes(spec))) throw new Error("Reviewed specification was modified; create a new version");
    return reference;
  }

  private async verifyApproval(spec: Specification, requestInput: unknown, decisionInput: unknown) {
    this.assertClear(spec);
    const request = ApprovalRequestSchema.parse(requestInput);
    const decision = ApprovalDecisionSchema.parse(decisionInput);
    await this.verifyArtifact(spec);
    if (request.status !== "pending" || request.target.type !== "specification" || request.target.specId !== spec.specId ||
        request.runId !== spec.runId || request.sessionId !== spec.sessionId || request.revision !== spec.version || request.generation !== 0 ||
        request.metadata?.specificationDigest !== digest(contentBytes(spec)) ||
        request.evidence.length !== 1 || canonicalJson(request.evidence[0]) !== canonicalJson(spec.artifactRef)) {
      throw new Error("Approval request does not match the current specification version and artifact");
    }
    if (decision.decision !== "approved" || decision.approvalId !== request.approvalId || decision.runId !== request.runId ||
        decision.sessionId !== request.sessionId || decision.revision !== request.revision || decision.generation !== request.generation ||
        canonicalJson(decision.target) !== canonicalJson(request.target)) throw new Error("Decision does not approve this specification request");
    if (Date.parse(decision.decidedAt) < Date.parse(request.requestedAt) || Date.parse(decision.decidedAt) > Date.parse(this.now()) ||
        (request.expiresAt && Date.parse(decision.decidedAt) >= Date.parse(request.expiresAt))) throw new Error("Decision is outside its approval time window");
    const humanRequired = classifyChange(policyDetails(spec).assessment, spec.affectedPaths).humanApprovalRequired;
    if (!await this.authorize(decision, humanRequired)) throw new Error(humanRequired ? "Authenticated human approval required" : "Approver is not authorized");
    return decision;
  }

  private assertDraft(spec: Specification) {
    if (spec.status !== "draft" || spec.approvedBy || spec.artifactRef) throw new Error("Only an unapproved draft may be created or submitted");
    if (spec.acceptanceCriteria.some(criterion => criterion.status !== "pending" || criterion.evidenceArtifactIds.length || criterion.waiverReason)) {
      throw new Error("Draft criteria must be pending without verification evidence or waivers");
    }
  }

  private assertClear(spec: Specification) {
    if (Date.parse(spec.updatedAt) > Date.parse(this.now())) throw new Error("Specification timestamp is in the future");
    if (policyDetails(spec).assessment.unresolvedQuestions.length) throw new Error("Core requirements need clarification before review or implementation");
  }

  private now(): string { return IsoDateTimeSchema.parse(this.clock().toISOString()); }
}
