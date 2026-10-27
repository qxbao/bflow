import {
  AcceptanceCriterionSchema,
  ApprovalDecisionSchema,
  CancellationRequestSchema,
  DelegationRequestSchema,
  RoleMessageSchema
} from "@bflow/contracts";

import {
  assertConversationRoleBoundaries,
  verifyUserApprovalProvenance
} from "./safety.js";

import type {
  AcceptanceCriterion,
  ApprovalDecision,
  ApprovalRequest,
  ArtifactReference,
  CancellationRequest,
  ContractError,
  DelegationRequest,
  ExtractedRequirementDraft,
  MessageProvenance,
  Metadata,
  OperationResult,
  RoleMessage,
  TddDecision,
  VerificationMethod
} from "./types.js";

/**
 * Infers how a criterion is verified from its wording. A spike is an investigation, so it is reviewed by hand;
 * otherwise the wording decides, and unit_test is the default for an implementation criterion.
 */
function inferVerificationMethod(description: string, kind: ExtractedRequirementDraft["kind"]): VerificationMethod {
  if (kind === "spike") return "manual_review";
  if (/(?<!\p{L})(?:e2e|end-to-end|giao diện|trình duyệt|browser|ui)(?!\p{L})/iu.test(description)) return "e2e_test";
  if (/(?<!\p{L})(?:tích hợp|integration|endpoint|api)(?!\p{L})/iu.test(description)) return "integration_test";
  if (/(?<!\p{L})(?:kiểu dữ liệu|typecheck|type check)(?!\p{L})/iu.test(description)) return "typecheck";
  if (/(?<!\p{L})(?:lint|eslint)(?!\p{L})/iu.test(description)) return "lint";
  if (/(?<!\p{L})(?:tài liệu|readme|document|báo cáo|report|review)(?!\p{L})/iu.test(description)) return "manual_review";
  return "unit_test";
}

/** A request about a token bucket or rate limiter, where "token" names a capacity unit rather than a credential. */
const TOKEN_BUCKET_CONTEXT = /token\s*[- ]?\s*bucket|rate\s*[- ]?\s*limit|giới hạn (?:tần suất|lưu lượng)/iu;

/**
 * Infers the criterion category from its wording; functional is the default. `context` is the request title and
 * objective: inside a token-bucket request a bare "token" or "tốc độ nạp" (refill rate) is functional, while explicit
 * security wording and credential tokens still classify as security.
 */
function inferCriterionCategory(description: string, context = ""): "functional" | "security" | "performance" | "regression" | "edge_case" {
  const bucketTokens = TOKEN_BUCKET_CONTEXT.test(`${context}\n${description}`);
  const security = bucketTokens
    ? /(?<!\p{L})(?:bảo mật|security|xác thực|auth|jwt|quyền|(?:bearer|access|refresh|api|session|csrf)\s*[- ]?\s*token|token\s+(?:xác thực|truy cập|đăng nhập))(?!\p{L})/iu
    : /(?<!\p{L})(?:bảo mật|security|xác thực|auth|jwt|(?<!(?:fencing|design|lexer|parser|cancel|cancellation)\s*[- ]\s*)token(?!\s*[- ]\s*bucket\b)|quyền)(?!\p{L})/iu;
  if (security.test(description)) return "security";
  if (/(?<!\p{L})(?:hiệu năng|performance|latency|throughput)(?!\p{L})/iu.test(description) ||
    (/(?<!\p{L})tốc độ(?!\p{L})/iu.test(description) && !(bucketTokens && /tốc độ\s+nạp/iu.test(description)))) return "performance";
  if (/(?<!\p{L})(?:hồi quy|regression|giữ nguyên)(?!\p{L})/iu.test(description)) return "regression";
  if (/(?<!\p{L})(?:biên|edge|null|rỗng)(?!\p{L})/iu.test(description)) return "edge_case";
  return "functional";
}

function formatZodError(error: { issues: readonly { path: readonly (string | number)[]; message: string }[] }): ContractError {
  const issueMessages = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return {
    code: "validation",
    retryable: false,
    message: `Validation failed: ${issueMessages}`
  };
}

/**
 * Pairs each acceptance criterion with the method the draft declared for it. The per-criterion
 * `acceptanceCriteria` form is authoritative; legacy `verificationMethods` must give either one method
 * for every criterion or exactly one per criterion, so a short list never leaves a criterion on an
 * unrequested method. A criterion without a declared method is inferred only when no method was declared.
 */
export function resolveDraftCriteria(
  draft: ExtractedRequirementDraft,
  fallbackDescriptions: readonly string[] = []
): OperationResult<readonly { readonly description: string; readonly verificationMethod?: VerificationMethod | undefined }[]> {
  const invalid = (message: string) => ({ ok: false as const, error: { code: "validation" as const, retryable: false as const, message } });
  const methods = draft.verificationMethods ?? [];
  if (draft.acceptanceCriteria !== undefined) {
    if (draft.acceptanceCriteriaDescriptions.length > 0 || methods.length > 0) {
      return invalid("Use either acceptanceCriteria[] or acceptanceCriteriaDescriptions with verificationMethods, not both");
    }
    return { ok: true, value: draft.acceptanceCriteria };
  }
  const descriptions = draft.acceptanceCriteriaDescriptions.length > 0 ? draft.acceptanceCriteriaDescriptions : fallbackDescriptions;
  if (methods.length > 1 && methods.length !== descriptions.length) {
    return invalid(`verificationMethods has ${methods.length} entries for ${descriptions.length} acceptance criteria; ` +
      "declare one method for all criteria, one per criterion, or use acceptanceCriteria[].verificationMethod");
  }
  return { ok: true, value: descriptions.map((description, idx) =>
    ({ description, verificationMethod: methods.length === 1 ? methods[0] : methods[idx] })) };
}

function generateRandomSuffix(): string {
  return Math.random().toString(36).substring(2, 9);
}

/**
 * Builds and validates a DelegationRequest from the Conversation Agent to the Coordinator Agent.
 */
export function buildDelegationRequest(params: {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly messageId: string;
  readonly runId?: string | undefined;
  readonly specificationId?: string | undefined;
  readonly draft: ExtractedRequirementDraft;
  readonly inputArtifacts?: readonly ArtifactReference[] | undefined;
  readonly tddDecision?: TddDecision | undefined;
  readonly requestedAt: string;
  readonly idempotencyKey?: string | undefined;
  readonly previousDelegationId?: string | undefined;
  readonly revision?: number | undefined;
}): OperationResult<DelegationRequest> {
  // 1. Enforce Conversation Role Boundary: must delegate exclusively to coordinator
  const boundaryCheck = assertConversationRoleBoundaries({ targetRole: "coordinator" });
  if (!boundaryCheck.ok) {
    return boundaryCheck;
  }

  // 2. Build structured AcceptanceCriterion list
  const resolvedCriteria = resolveDraftCriteria(params.draft, [
    `Triển khai yêu cầu: ${params.draft.title}`,
    "Đảm bảo kiểm thử và typecheck vượt qua 100%"
  ]);
  if (!resolvedCriteria.ok) {
    return resolvedCriteria;
  }
  const rawCriteria = resolvedCriteria.value;

  const acceptanceCriteria: AcceptanceCriterion[] = [];
  for (let idx = 0; idx < rawCriteria.length; idx++) {
    const desc = rawCriteria[idx]?.description ?? `Tiêu chí nghiệm thu ${idx + 1}`;
    const description = desc.trim().length > 0 ? desc.trim() : `Tiêu chí nghiệm thu ${idx + 1}`;
    const criterionRaw = {
      id: `ac-${idx + 1}`,
      description,
      category: inferCriterionCategory(description, `${params.draft.title}\n${params.draft.objective}`),
      verificationMethod: rawCriteria[idx]?.verificationMethod ?? inferVerificationMethod(description, params.draft.kind),
      required: true,
      status: "pending" as const,
      evidenceArtifactIds: []
    };

    const parsedCriterion = AcceptanceCriterionSchema.safeParse(criterionRaw);
    if (!parsedCriterion.success) {
      return { ok: false, error: formatZodError(parsedCriterion.error) };
    }
    acceptanceCriteria.push(parsedCriterion.data);
  }

  const delegationId =
    params.previousDelegationId ??
    `del-${params.correlationId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32)}-${generateRandomSuffix()}`;

  const specificationId =
    params.specificationId ??
    `spec-${params.correlationId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32)}`;

  const idempotencyKey =
    params.idempotencyKey ??
    `idemp-del-${params.correlationId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32)}-${generateRandomSuffix()}`;

  const metadata: Metadata = {
    revision: params.revision ?? 1,
    isRequirementChange: params.draft.isRequirementChange,
    workflowKind: params.draft.kind,
    codeChangesAuthorized: params.draft.codeChangesAuthorized ?? params.draft.kind !== "spike",
    ...(params.draft.investigationTasks ? { investigationTasks: params.draft.investigationTasks.map(task => ({ objective: task.objective, affectedPaths: [...task.affectedPaths], codeChangesAuthorized: false })) } : {}),
    ...(params.draft.affectedPaths.length > 0
      ? { affectedPaths: [...params.draft.affectedPaths] }
      : {})
  };

  const rawDelegation = {
    schemaVersion: 2 as const,
    delegationId,
    messageId: params.messageId,
    correlationId: params.correlationId,
    sessionId: params.sessionId,
    ...(params.runId !== undefined ? { runId: params.runId } : {}),
    requestedBy: "conversation" as const,
    targetRole: "coordinator" as const,
    title: params.draft.title.trim().length > 0 ? params.draft.title.trim() : "Yêu cầu từ người dùng",
    objective: params.draft.objective.trim().length > 0 ? params.draft.objective.trim() : params.draft.title,
    specificationId,
    sddLevel: params.draft.sddLevel,
    acceptanceCriteria,
    ...(params.tddDecision !== undefined ? { tddDecision: params.tddDecision } : {}),
    inputArtifacts: params.inputArtifacts ? [...params.inputArtifacts] : [],
    priority: params.draft.priority,
    requestedAt: params.requestedAt,
    idempotencyKey,
    metadata
  };

  const parsed = DelegationRequestSchema.safeParse(rawDelegation);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }

  return { ok: true, value: parsed.data };
}

/**
 * Builds and validates an ApprovalDecision, strictly verifying user provenance.
 */
export function buildApprovalDecision(params: {
  readonly approvalRequest: ApprovalRequest;
  readonly decision: "approved" | "rejected" | "changes_requested";
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason?: string | undefined;
  readonly provenance: MessageProvenance | undefined;
  readonly repositoryContext?: string | undefined;
  readonly userContent?: string | undefined;
  readonly feedbackArtifacts?: readonly ArtifactReference[] | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}): OperationResult<ApprovalDecision> {
  // 1. Verify user approval provenance (rejection if provenance is not authenticated user)
  const provCheck = verifyUserApprovalProvenance(
    params.provenance,
    params.repositoryContext,
    params.userContent
  );
  if (!provCheck.ok) {
    return provCheck;
  }

  // 2. Enforce reason requirement for non-approved decisions
  if (params.decision !== "approved") {
    if (!params.reason || params.reason.trim().length === 0) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: "Approval rejection or change request requires an explicit non-empty reason."
        }
      };
    }
  }

  const idempotencyKey =
    params.idempotencyKey ??
    `idemp-dec-${params.approvalRequest.approvalId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32)}-${generateRandomSuffix()}`;

  const mergedMetadata: Record<string, unknown> = {
    ...(params.approvalRequest.metadata ?? {}),
    ...(params.metadata ?? {})
  };

  const rawDecision = {
    schemaVersion: (params.approvalRequest.schemaVersion ?? 2) as 1 | 2,
    approvalId: params.approvalRequest.approvalId,
    runId: params.approvalRequest.runId,
    ...(params.approvalRequest.sessionId !== undefined ? { sessionId: params.approvalRequest.sessionId } : {}),
    target: params.approvalRequest.target,
    revision: params.approvalRequest.revision,
    generation: params.approvalRequest.generation,
    decision: params.decision,
    decidedBy: params.decidedBy,
    decidedAt: params.decidedAt,
    ...(params.reason !== undefined && params.reason.trim().length > 0 ? { reason: params.reason.trim() } : {}),
    feedbackArtifacts: params.feedbackArtifacts ? [...params.feedbackArtifacts] : [],
    idempotencyKey,
    ...(Object.keys(mergedMetadata).length > 0 ? { metadata: mergedMetadata } : {})
  };

  const parsed = ApprovalDecisionSchema.safeParse(rawDecision);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }

  return { ok: true, value: parsed.data };
}

/**
 * Builds and validates a CancellationRequest for a workflow run or task.
 */
export function buildCancellationRequest(params: {
  readonly cancellationId?: string | undefined;
  readonly runId: string;
  readonly taskId?: string | undefined;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly expectedVersion: number;
  readonly reason?: string | undefined;
  readonly executionId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}): OperationResult<CancellationRequest> {
  const cancellationId = params.cancellationId ?? `canc-${params.runId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}-${generateRandomSuffix()}`;
  const idempotencyKey =
    params.idempotencyKey ??
    `idemp-canc-${params.runId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}-${generateRandomSuffix()}`;

  const rawCancellation = {
    schemaVersion: 1 as const,
    cancellationId,
    runId: params.runId,
    ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
    requestedBy: params.requestedBy,
    requestedAt: params.requestedAt,
    expectedVersion: params.expectedVersion,
    ...(params.executionId !== undefined ? { executionId: params.executionId } : {}),
    ...(params.reason !== undefined && params.reason.trim().length > 0 ? { reason: params.reason.trim() } : {}),
    idempotencyKey
  };

  const parsed = CancellationRequestSchema.safeParse(rawCancellation);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }

  return { ok: true, value: parsed.data };
}

/**
 * Builds and validates a standard RoleMessage envelope from the Conversation Agent to the Coordinator Agent.
 */
export function buildCoordinatorRoleMessage(params: {
  readonly messageId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly runId: string;
  readonly conversationAgentId: string;
  readonly conversationPaneId: string;
  readonly coordinatorAgentId?: string | undefined;
  readonly coordinatorPaneId?: string | undefined;
  readonly type: "delegation.request" | "approval.decision";
  readonly payload: Record<string, unknown>;
  readonly artifactReferences?: readonly ArtifactReference[] | undefined;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly metadata?: Metadata | undefined;
}): OperationResult<RoleMessage> {
  const rawMessage = {
    schema_version: 2 as const,
    message_id: params.messageId,
    correlation_id: params.correlationId,
    ...(params.causationId !== undefined ? { causation_id: params.causationId } : {}),
    run_id: params.runId,
    sender: {
      role: "conversation" as const,
      agent_id: params.conversationAgentId,
      pane_id: params.conversationPaneId
    },
    recipient: {
      role: "coordinator" as const,
      ...(params.coordinatorAgentId !== undefined ? { agent_id: params.coordinatorAgentId } : {}),
      ...(params.coordinatorPaneId !== undefined ? { pane_id: params.coordinatorPaneId } : {})
    },
    type: params.type,
    payload: params.payload,
    artifact_references: params.artifactReferences ? [...params.artifactReferences] : [],
    occurred_at: params.occurredAt,
    idempotency_key: params.idempotencyKey,
    ...(params.metadata !== undefined ? { metadata: params.metadata } : {})
  };

  const parsed = RoleMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }

  return { ok: true, value: parsed.data };
}

/**
 * DelegationBuilder class providing methods for constructing validated delegation contracts.
 */
export class DelegationBuilder {
  public buildDelegationRequest(params: Parameters<typeof buildDelegationRequest>[0]): OperationResult<DelegationRequest> {
    return buildDelegationRequest(params);
  }

  public buildApprovalDecision(params: Parameters<typeof buildApprovalDecision>[0]): OperationResult<ApprovalDecision> {
    return buildApprovalDecision(params);
  }

  public buildCancellationRequest(params: Parameters<typeof buildCancellationRequest>[0]): OperationResult<CancellationRequest> {
    return buildCancellationRequest(params);
  }

  public buildCoordinatorRoleMessage(params: Parameters<typeof buildCoordinatorRoleMessage>[0]): OperationResult<RoleMessage> {
    return buildCoordinatorRoleMessage(params);
  }

  public static buildDelegationRequest(params: Parameters<typeof buildDelegationRequest>[0]): OperationResult<DelegationRequest> {
    return buildDelegationRequest(params);
  }

  public static buildApprovalDecision(params: Parameters<typeof buildApprovalDecision>[0]): OperationResult<ApprovalDecision> {
    return buildApprovalDecision(params);
  }

  public static buildCancellationRequest(params: Parameters<typeof buildCancellationRequest>[0]): OperationResult<CancellationRequest> {
    return buildCancellationRequest(params);
  }

  public static buildCoordinatorRoleMessage(params: Parameters<typeof buildCoordinatorRoleMessage>[0]): OperationResult<RoleMessage> {
    return buildCoordinatorRoleMessage(params);
  }
}
