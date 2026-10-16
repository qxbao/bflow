import { createHash } from "node:crypto";
import {
  ArtifactProposalSchema,
  RoleMessageSchema
} from "@bflow/contracts";
import type {
  ArtifactProposal,
  ArtifactReference,
  RoleMessage,
  Specification
} from "@bflow/contracts";
import {
  parseContractOrP15Specification,
  SpecApprovedPayloadSchema,
  SpecDraftPayloadSchema
} from "./schema.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Lifecycle fields are external; the immutable artifact represents reviewed requirements. */
export function contentBytes(spec: Specification): Buffer {
  const { status: _status, approvedBy: _approvedBy, artifactRef: _artifactRef, updatedAt: _updatedAt, ...content } = spec;
  return Buffer.from(canonicalJson(content), "utf8");
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createSpecificationArtifactProposal(
  specInput: unknown,
  options: {
    proposalId: string;
    format?: "json" | "markdown";
    logicalName?: string;
    renderedMarkdown?: string;
  }
): { proposal: ArtifactProposal; bytes: Buffer; checksum: string } {
  const spec = parseContractOrP15Specification(specInput);

  if (!spec.runId) {
    throw new Error("A run ID is required to create a specification artifact proposal");
  }

  const format = options.format ?? "json";
  let bytes: Buffer;
  let mediaType: string;
  let defaultLogicalName: string;

  if (format === "markdown") {
    const md = options.renderedMarkdown ?? "";
    if (!md.trim()) {
      throw new Error("renderedMarkdown must not be empty when format is markdown");
    }
    bytes = Buffer.from(md, "utf8");
    mediaType = "text/markdown";
    defaultLogicalName = `${spec.specId}-v${spec.version ?? 1}.md`;
  } else {
    bytes = contentBytes(spec);
    mediaType = "application/json";
    defaultLogicalName = `${spec.specId}-v${spec.version ?? 1}.json`;
  }

  const checksum = digest(bytes);
  const logicalName = options.logicalName ?? defaultLogicalName;

  const proposal = ArtifactProposalSchema.parse({
    proposalId: options.proposalId,
    runId: spec.runId,
    kind: "document",
    logicalName,
    mediaType,
    expectedIntegrity: {
      checksum: { algorithm: "sha256", value: checksum },
      sizeBytes: bytes.length
    }
  });

  return { proposal, bytes, checksum };
}

export function buildSpecRoleMessage(options: {
  messageId: string;
  correlationId: string;
  causationId?: string;
  runId: string;
  senderRole: "specifier" | "architect" | "planner" | "coordinator";
  senderAgentId?: string;
  senderPaneId?: string;
  recipientRole?: "coordinator" | "conversation" | "runtime";
  type: "spec.draft" | "spec.approved";
  spec: unknown;
  artifactReferences?: readonly ArtifactReference[];
  occurredAt?: string;
  idempotencyKey?: string;
  notes?: string;
}): RoleMessage {
  const spec = parseContractOrP15Specification(options.spec);

  if (spec.runId !== undefined && spec.runId !== options.runId) {
    throw new Error("Specification runId must match RoleMessage runId");
  }

  if (options.type === "spec.approved") {
    if (options.senderRole !== "coordinator") {
      throw new Error("Only coordinator may emit spec.approved RoleMessage");
    }
    if (spec.status !== "approved" || !spec.approvedBy || !spec.artifactRef) {
      throw new Error("spec.approved message requires an approved specification with approvedBy and artifactRef");
    }
  } else if (options.type === "spec.draft") {
    if (spec.status !== "draft" && spec.status !== "review_pending") {
      throw new Error("spec.draft message requires a draft or review_pending specification");
    }
  }

  const recipientRole =
    options.recipientRole ??
    (options.senderRole === "coordinator" ? "conversation" : "coordinator");

  let payload: Record<string, unknown>;
  if (options.type === "spec.draft") {
    payload = SpecDraftPayloadSchema.parse({
      specId: spec.specId,
      specLevel: spec.level,
      title: spec.title,
      authorRole: options.senderRole,
      summary: spec.summary,
      affectedPaths: spec.affectedPaths
    });
  } else {
    const approvedPayload: Record<string, unknown> = {
      specId: spec.specId,
      approvedBy: spec.approvedBy,
      approvedAt: options.occurredAt ?? spec.updatedAt
    };
    if (options.notes !== undefined && options.notes.trim().length > 0) {
      approvedPayload.notes = options.notes.trim();
    }
    payload = SpecApprovedPayloadSchema.parse(approvedPayload);
  }

  const sender: {
    role: typeof options.senderRole;
    agent_id?: string;
    pane_id?: string;
  } = {
    role: options.senderRole
  };
  if (options.senderAgentId !== undefined) {
    sender.agent_id = options.senderAgentId;
  }
  if (options.senderPaneId !== undefined) {
    sender.pane_id = options.senderPaneId;
  }

  const recipient: {
    role: "coordinator" | "conversation" | "runtime";
  } = {
    role: recipientRole
  };

  let artifactReferences: ArtifactReference[];
  if (options.artifactReferences && options.artifactReferences.length > 0) {
    artifactReferences = [...options.artifactReferences];
  } else if (options.type === "spec.approved") {
    artifactReferences = [spec.artifactRef!];
  } else if (spec.artifactRef && spec.artifactRef.runId === options.runId) {
    artifactReferences = [spec.artifactRef];
  } else {
    artifactReferences = [];
  }

  const rawMessage: Record<string, unknown> = {
    schema_version: 2,
    message_id: options.messageId,
    correlation_id: options.correlationId,
    run_id: options.runId,
    sender,
    recipient,
    type: options.type,
    payload,
    artifact_references: artifactReferences
  };

  if (options.causationId !== undefined) {
    rawMessage.causation_id = options.causationId;
  }
  if (options.occurredAt !== undefined) {
    rawMessage.occurred_at = options.occurredAt;
  }
  if (options.idempotencyKey !== undefined) {
    rawMessage.idempotency_key = options.idempotencyKey;
  }

  return RoleMessageSchema.parse(rawMessage);
}
