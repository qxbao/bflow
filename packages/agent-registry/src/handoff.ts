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

  if (request.fromTaskId === request.toTaskId) {
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
    if (ref.runId !== request.runId) {
      return failure(
        `Artifact runId '${ref.runId}' does not match handoff runId '${request.runId}'`
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

  const requiredKinds = request.requiredKinds ?? rule.defaultRequiredKinds;
  for (const requiredKind of requiredKinds) {
    if (!references.some((r) => r.kind === requiredKind)) {
      return failure(
        `Required artifact kind '${requiredKind}' missing from handoff ${request.fromRole} -> ${request.toRole}`
      );
    }
  }

  return success({
    runId: request.runId,
    fromRole: request.fromRole,
    toRole: request.toRole,
    fromTaskId: request.fromTaskId,
    toTaskId: request.toTaskId,
    references,
    artifactIds: references.map((r) => r.artifactId),
    artifactUris: references.map((r) => r.uri)
  });
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
  const references: ArtifactReference[] = [];

  for (const proposal of proposals) {
    const parseRes = ArtifactProposalSchema.safeParse(proposal);
    if (!parseRes.success) {
      return failure(`Invalid artifact proposal: ${parseRes.error.message}`);
    }

    const rawContent = contentByProposalId[proposal.proposalId];
    if (rawContent === undefined) {
      return failure(`Missing content for artifact proposal '${proposal.proposalId}'`);
    }

    let bytes: Uint8Array;
    if (typeof rawContent === "string") {
      bytes = new TextEncoder().encode(rawContent);
    } else if (rawContent instanceof Uint8Array) {
      bytes = rawContent;
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
      return putRes;
    }

    references.push(putRes.value);
  }

  return success(references);
}
