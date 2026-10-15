import { createHash } from "node:crypto";
import {
  ArtifactProposalSchema,
  ArtifactReferenceSchema,
  IdentifierSchema,
  type ArtifactProposal,
  type ArtifactReference,
  type ArtifactStore,
  type JsonValue,
  type OperationOptions,
  type OperationResult
} from "@ai-flow/contracts";
import { isMvpRole, type MvpRole } from "./roles.js";

export type ArtifactKind = ArtifactReference["kind"];

export interface ArtifactHandoffRule {
  readonly fromRole: MvpRole;
  readonly toRole: MvpRole;
  readonly allowedKinds: readonly ArtifactKind[];
  readonly defaultRequiredKinds: readonly ArtifactKind[];
}

export const ROLE_ARTIFACT_HANDOFF_RULES: readonly ArtifactHandoffRule[] = [
  {
    fromRole: "planner",
    toRole: "developer",
    allowedKinds: ["document", "agent-output", "report"],
    defaultRequiredKinds: ["document"]
  },
  {
    fromRole: "developer",
    toRole: "reviewer",
    allowedKinds: ["patch", "test-result", "report", "agent-output", "log"],
    defaultRequiredKinds: ["patch"]
  },
  {
    fromRole: "reviewer",
    toRole: "developer",
    allowedKinds: ["report", "document", "agent-output"],
    defaultRequiredKinds: ["report"]
  },
  {
    fromRole: "developer",
    toRole: "qa",
    allowedKinds: ["patch", "test-result", "log", "report", "agent-output"],
    defaultRequiredKinds: ["test-result"]
  },
  {
    fromRole: "reviewer",
    toRole: "qa",
    allowedKinds: ["report", "document", "patch", "test-result", "log", "agent-output"],
    defaultRequiredKinds: ["report"]
  }
];

export interface CreateArtifactHandoffRequest {
  readonly runId: string;
  readonly fromRole: MvpRole;
  readonly toRole: MvpRole;
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly artifacts: readonly unknown[];
  readonly requiredKinds?: readonly ArtifactKind[];
}

export interface RoleArtifactHandoff {
  readonly runId: string;
  readonly fromRole: MvpRole;
  readonly toRole: MvpRole;
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly references: readonly ArtifactReference[];
  readonly artifactIds: readonly string[];
  readonly artifactUris: readonly string[];
}

function failure<T>(message: string, details?: JsonValue): OperationResult<T> {
  return {
    ok: false,
    error: {
      code: "validation",
      retryable: false,
      message,
      ...(details !== undefined ? { details } : {})
    }
  };
}

function success<T>(value: T): OperationResult<T> {
  return { ok: true, value };
}

export function createRoleArtifactHandoff(
  request: CreateArtifactHandoffRequest
): OperationResult<RoleArtifactHandoff> {
  const runIdRes = IdentifierSchema.safeParse(request.runId);
  if (!runIdRes.success) {
    return failure(`Invalid runId in artifact handoff: ${runIdRes.error.message}`);
  }

  const fromTaskRes = IdentifierSchema.safeParse(request.fromTaskId);
  if (!fromTaskRes.success) {
    return failure(`Invalid fromTaskId in artifact handoff: ${fromTaskRes.error.message}`);
  }

  const toTaskRes = IdentifierSchema.safeParse(request.toTaskId);
  if (!toTaskRes.success) {
    return failure(`Invalid toTaskId in artifact handoff: ${toTaskRes.error.message}`);
  }

  if (fromTaskRes.data === toTaskRes.data) {
    return failure("fromTaskId and toTaskId cannot be the same in artifact handoff");
  }

  if (!isMvpRole(request.fromRole)) {
    return failure(`Invalid fromRole '${String(request.fromRole)}' in artifact handoff`);
  }

  if (!isMvpRole(request.toRole)) {
    return failure(`Invalid toRole '${String(request.toRole)}' in artifact handoff`);
  }

  const rule = ROLE_ARTIFACT_HANDOFF_RULES.find(
    (r) => r.fromRole === request.fromRole && r.toRole === request.toRole
  );
  if (!rule) {
    return failure(`Disallowed role artifact handoff: ${request.fromRole} -> ${request.toRole}`);
  }

  if (!Array.isArray(request.artifacts) || request.artifacts.length === 0) {
    return failure("Handoff requires at least one artifact");
  }

  if (request.requiredKinds !== undefined) {
    if (!Array.isArray(request.requiredKinds) || request.requiredKinds.length === 0) {
      return failure("requiredKinds must be a non-empty array of artifact kinds if provided");
    }
    for (const kind of request.requiredKinds) {
      if (!rule.allowedKinds.includes(kind)) {
        return failure(
          `Artifact kind '${kind}' in requiredKinds is not allowed for handoff ${request.fromRole} -> ${request.toRole}. Allowed kinds: ${rule.allowedKinds.join(", ")}`
        );
      }
    }
  }

  const requiredKinds = request.requiredKinds !== undefined
    ? [...new Set([...rule.defaultRequiredKinds, ...request.requiredKinds])]
    : rule.defaultRequiredKinds;

  const references: ArtifactReference[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < request.artifacts.length; i++) {
    const item = request.artifacts[i];
    if (typeof item === "object" && item !== null) {
      const rec = item as Record<string, unknown>;
      if ("proposalId" in rec || rec.trust !== "stored") {
        return failure(
          `Untrusted ArtifactProposal cannot be passed between roles without ArtifactStore ingestion: received ${
            "proposalId" in rec ? `proposal '${String(rec.proposalId)}'` : "unstored artifact"
          }`
        );
      }
    } else {
      return failure(`Artifact in handoff[${i}] must be an ArtifactReference object`);
    }

    const refParse = ArtifactReferenceSchema.safeParse(item);
    if (!refParse.success) {
      return failure(`Invalid artifact reference at index ${i}: ${refParse.error.message}`);
    }

    const ref = refParse.data;
    if (ref.runId !== runIdRes.data) {
      return failure(
        `Artifact runId '${ref.runId}' does not match handoff runId '${runIdRes.data}'`
      );
    }

    if (seenIds.has(ref.artifactId)) {
      return failure(`Duplicate artifactId in handoff: '${ref.artifactId}'`);
    }
    seenIds.add(ref.artifactId);

    if (!rule.allowedKinds.includes(ref.kind)) {
      return failure(
        `Artifact kind '${ref.kind}' is not allowed for handoff ${request.fromRole} -> ${request.toRole}. Allowed kinds: ${rule.allowedKinds.join(", ")}`
      );
    }

    references.push(ref);
  }

  for (const requiredKind of requiredKinds) {
    if (!references.some((r) => r.kind === requiredKind)) {
      return failure(
        `Required artifact kind '${requiredKind}' missing from handoff ${request.fromRole} -> ${request.toRole}`
      );
    }
  }

  return success({
    runId: runIdRes.data,
    fromRole: request.fromRole,
    toRole: request.toRole,
    fromTaskId: fromTaskRes.data,
    toTaskId: toTaskRes.data,
    references,
    artifactIds: references.map((r) => r.artifactId),
    artifactUris: references.map((r) => r.uri)
  });
}

interface PrevalidatedProposal {
  readonly proposal: ArtifactProposal;
  readonly bytes: Uint8Array;
}

export async function ingestRoleArtifactProposals(
  store: ArtifactStore,
  proposals: readonly ArtifactProposal[],
  contentByProposalId: Readonly<Record<string, Uint8Array | string>>,
  options?: {
    readonly idempotencyKeyPrefix?: string;
    readonly operationOptions?: OperationOptions;
  }
): Promise<OperationResult<readonly ArtifactReference[]>> {
  if (!store || typeof store.put !== "function") {
    return failure(
      "ArtifactStore is required to ingest artifact proposals into trusted stored ArtifactReferences"
    );
  }

  if (!Array.isArray(proposals) || proposals.length === 0) {
    return failure("Proposals must be a non-empty array");
  }

  const prevalidated: PrevalidatedProposal[] = [];
  const seenProposalIds = new Set<string>();
  let batchRunId: string | undefined;

  for (let i = 0; i < proposals.length; i++) {
    const rawProposal = proposals[i];
    const parseRes = ArtifactProposalSchema.safeParse(rawProposal);
    if (!parseRes.success) {
      return failure(`Invalid artifact proposal at index ${i}: ${parseRes.error.message}`);
    }
    const proposal = parseRes.data;

    if (seenProposalIds.has(proposal.proposalId)) {
      return failure(`Duplicate proposalId in batch: '${proposal.proposalId}'`);
    }
    seenProposalIds.add(proposal.proposalId);

    if (batchRunId === undefined) {
      batchRunId = proposal.runId;
    } else if (proposal.runId !== batchRunId) {
      return failure(
        `Inconsistent runId in artifact proposals batch: expected '${batchRunId}', got '${proposal.runId}'`
      );
    }

    const rawContent = contentByProposalId[proposal.proposalId];
    if (rawContent === undefined) {
      return failure(`Missing content for artifact proposal '${proposal.proposalId}'`);
    }

    let bytes: Uint8Array;
    if (typeof rawContent === "string") {
      bytes = new TextEncoder().encode(rawContent);
    } else if (rawContent instanceof Uint8Array) {
      bytes = new Uint8Array(rawContent);
    } else {
      return failure(`Invalid content type for proposal '${proposal.proposalId}'`);
    }

    if (
      proposal.expectedIntegrity.sizeBytes !== undefined &&
      bytes.byteLength !== proposal.expectedIntegrity.sizeBytes
    ) {
      return failure(
        `Size mismatch for proposal '${proposal.proposalId}': expected ${proposal.expectedIntegrity.sizeBytes}, got ${bytes.byteLength}`
      );
    }

    const algo = proposal.expectedIntegrity.checksum.algorithm;
    const computedHash = createHash(algo).update(bytes).digest("hex");
    if (computedHash.toLowerCase() !== proposal.expectedIntegrity.checksum.value.toLowerCase()) {
      return failure(
        `Checksum mismatch for proposal '${proposal.proposalId}': expected ${proposal.expectedIntegrity.checksum.value}, computed ${computedHash}`
      );
    }

    prevalidated.push({ proposal, bytes });
  }

  const writtenReferences: ArtifactReference[] = [];

  for (const item of prevalidated) {
    const { proposal, bytes } = item;
    const idempotencyKey = `${options?.idempotencyKeyPrefix ?? "ingest"}:${proposal.proposalId}`;
    const write = {
      options: {
        artifactId: proposal.proposalId,
        runId: proposal.runId,
        ...(proposal.taskId !== undefined ? { taskId: proposal.taskId } : {}),
        kind: proposal.kind,
        mediaType: proposal.mediaType,
        expectedIntegrity: proposal.expectedIntegrity,
        idempotencyKey,
        ...(proposal.metadata !== undefined ? { metadata: proposal.metadata } : {})
      },
      content: (async function* () {
        yield bytes;
      })()
    };

    const putRes = await store.put(write, options?.operationOptions);
    if (!putRes.ok) {
      for (const written of writtenReferences) {
        try {
          await store.delete(written.artifactId, options?.operationOptions);
        } catch {
          // ignore best-effort deletion failure
        }
      }
      return putRes;
    }

    const refParse = ArtifactReferenceSchema.safeParse(putRes.value);
    if (
      !refParse.success ||
      refParse.data.trust !== "stored" ||
      refParse.data.artifactId !== proposal.proposalId ||
      refParse.data.runId !== proposal.runId ||
      refParse.data.kind !== proposal.kind
    ) {
      for (const written of [...writtenReferences, { artifactId: proposal.proposalId }]) {
        try {
          await store.delete(written.artifactId, options?.operationOptions);
        } catch {
          // ignore best-effort deletion failure
        }
      }
      const detail = !refParse.success
        ? refParse.error.message
        : `mismatched reference metadata for '${proposal.proposalId}'`;
      return failure(`ArtifactStore returned an invalid or untrusted ArtifactReference: ${detail}`);
    }

    writtenReferences.push(refParse.data);
  }

  return success(writtenReferences);
}
