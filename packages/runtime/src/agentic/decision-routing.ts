import { createHash } from "node:crypto";
import {
  AgentRoleSchema,
  ApprovalRequestSchema,
  IdentifierSchema,
  RoleMessageSchema,
  type AgentRole,
  type ApprovalDecision,
  type ApprovalRequest,
  type RoleMessage
} from "@bflow/contracts";

/**
 * Specialist user-decision routing (P30 T8).
 *
 * Pure and deterministic: no I/O, no clocks other than the injected `now`.
 * Specialist roles ask for a human decision by calling `request_user_decision`
 * through Runtime. Runtime records a user-decision ApprovalRequest and forwards it as an
 * `approval.request` RoleMessage to Conversation, which is the only role that talks to the user.
 * The answer returns through the existing human-approval path (`approval.decision`).
 */

export const USER_DECISION_TOOL = "request_user_decision";
export const USER_DECISION_METADATA_KIND = "user_decision";
/** `conversation.progress` payload kind telling Conversation that a user decision expired (Runtime-owned). */
export const USER_DECISION_EXPIRED_KIND = "user_decision_expired";

const MAX_OPTIONS = 6;
const MAX_EXPIRES_MINUTES = 1440;
const ALLOWED_INPUT_KEYS = ["runId", "taskId", "question", "options", "context", "expiresInMinutes"] as const;

export interface UserDecisionToolInput {
  readonly runId: string;
  readonly taskId: string;
  readonly question: string;
  readonly options?: readonly string[];
  readonly context?: string;
  readonly expiresInMinutes?: number;
}

export type RoleParticipant = RoleMessage["sender"];

export interface UserDecisionRequestParams {
  readonly input: UserDecisionToolInput;
  readonly role: AgentRole;
  readonly sessionId: string;
  readonly revision: number;
  readonly generation: number;
  /** ISO-8601 timestamp supplied by the caller (Runtime clock). */
  readonly now: string;
}

export interface UserDecisionAnswer {
  readonly outcome: ApprovalDecision["decision"];
  readonly selectedOption?: string;
  readonly reason?: string;
}

export type DirectInteractionGuard =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly reason: string };

function boundedString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new Error(`${field} must be ${min}..${max} characters`);
  return trimmed;
}

/**
 * Parses raw tool input at the ingress boundary. Strict: unknown keys and out-of-bound values
 * are rejected. Throws an Error describing the first violation.
 */
export function parseUserDecisionToolInput(raw: unknown): UserDecisionToolInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("User decision input must be an object");
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(ALLOWED_INPUT_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown user decision input key: ${key}`);
  }
  const runId = IdentifierSchema.parse(record.runId);
  const taskId = IdentifierSchema.parse(record.taskId);
  const question = boundedString(record.question, "question", 1, 2000);
  let options: string[] | undefined;
  if (record.options !== undefined) {
    if (!Array.isArray(record.options)) throw new Error("options must be an array");
    if (record.options.length < 2 || record.options.length > MAX_OPTIONS) throw new Error(`options must contain 2..${MAX_OPTIONS} entries`);
    options = record.options.map((option, index) => boundedString(option, `options[${index}]`, 1, 200));
    if (new Set(options.map(option => option.toLowerCase())).size !== options.length) throw new Error("options must be unique");
  }
  let context: string | undefined;
  if (record.context !== undefined) {
    if (typeof record.context !== "string" || record.context.length > 4000) throw new Error("context must be at most 4000 characters");
    context = record.context;
  }
  let expiresInMinutes: number | undefined;
  if (record.expiresInMinutes !== undefined) {
    const minutes = record.expiresInMinutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_EXPIRES_MINUTES) {
      throw new Error(`expiresInMinutes must be an integer 1..${MAX_EXPIRES_MINUTES}`);
    }
    expiresInMinutes = minutes;
  }
  return {
    runId, taskId, question,
    ...(options !== undefined ? { options } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(expiresInMinutes !== undefined ? { expiresInMinutes } : {})
  };
}

function digestParts(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Builds the Runtime-owned user-decision ApprovalRequest (schemaVersion 2). */
export function buildUserDecisionRequest(params: UserDecisionRequestParams): ApprovalRequest {
  if (params.role === "conversation") {
    throw new Error("Conversation asks the user directly; request_user_decision is for specialist roles");
  }
  const role = AgentRoleSchema.safeParse(params.role);
  if (!role.success) throw new Error(`Unknown agent role for user decision: ${String(params.role)}`);

  const input = parseUserDecisionToolInput(params.input);
  const options = input.options ?? [];
  const hash = digestParts([input.runId, input.taskId, role.data, input.question, options, params.revision, params.generation]);
  const requestedAtMs = Date.parse(params.now);
  if (!Number.isFinite(requestedAtMs)) throw new Error("now must be an ISO-8601 timestamp");
  const expiresAt = input.expiresInMinutes === undefined
    ? undefined
    : new Date(requestedAtMs + input.expiresInMinutes * 60_000).toISOString();

  const metadata: Record<string, unknown> = {
    kind: USER_DECISION_METADATA_KIND,
    question: input.question,
    requestedByRole: role.data,
    ...(input.options !== undefined ? { options: input.options } : {}),
    ...(input.context !== undefined ? { context: input.context } : {})
  };

  return ApprovalRequestSchema.parse({
    schemaVersion: 2,
    approvalId: `apr-user-decision-${hash.slice(0, 40)}`,
    runId: input.runId,
    sessionId: params.sessionId,
    status: "pending",
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    target: { type: "task", taskId: input.taskId },
    revision: params.revision,
    generation: params.generation,
    requestedBy: role.data,
    requestedAt: params.now,
    reason: input.question,
    evidence: [],
    idempotencyKey: `user-decision:${hash}`,
    metadata
  });
}

/** Type guard on the user-decision metadata marker. */
export function isUserDecisionRequest(request: { readonly metadata?: unknown }): request is ApprovalRequest & {
  readonly metadata: Record<string, unknown>;
} {
  const metadata = request.metadata;
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).kind === USER_DECISION_METADATA_KIND;
}

function optionsOf(request: ApprovalRequest): readonly string[] | undefined {
  const options = request.metadata?.options;
  if (!Array.isArray(options)) return undefined;
  return options.filter((option): option is string => typeof option === "string");
}

function sameTarget(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validates a human answer against the exact user-decision request. Throws on any mismatch,
 * expiry, out-of-band option or invalid timestamp. Never selects a default option.
 */
export function validateUserDecisionAnswer(
  request: ApprovalRequest,
  decision: ApprovalDecision,
  now: string
): UserDecisionAnswer {
  if (!isUserDecisionRequest(request)) throw new Error("Not a user-decision request");
  if (decision.approvalId !== request.approvalId) throw new Error("Decision approvalId does not match request");
  if (decision.runId !== request.runId) throw new Error("Decision runId does not match request");
  if (decision.sessionId !== request.sessionId) throw new Error("Decision sessionId does not match request");
  if (!sameTarget(decision.target, request.target)) throw new Error("Decision target does not match request");
  if (decision.revision !== request.revision) throw new Error("Decision revision does not match request");
  if (decision.generation !== request.generation) throw new Error("Decision generation does not match request");

  const decidedAt = Date.parse(decision.decidedAt);
  const requestedAt = Date.parse(request.requestedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(current)) throw new Error("now must be an ISO-8601 timestamp");
  if (decidedAt < requestedAt) throw new Error("Decision predates the user-decision request");
  if (decidedAt > current) throw new Error("Decision is dated in the future");
  if (request.expiresAt !== undefined && current >= Date.parse(request.expiresAt)) {
    throw new Error("User decision request has expired");
  }

  const options = optionsOf(request);
  const selectedRaw = decision.metadata?.selectedOption;
  if (selectedRaw !== undefined && typeof selectedRaw !== "string") throw new Error("selectedOption must be a string");
  const selectedOption = selectedRaw;

  if (options !== undefined) {
    if (decision.decision === "approved" && (selectedOption === undefined || !options.includes(selectedOption))) {
      throw new Error("Approved user decision must select one of the offered options");
    }
    if (selectedOption !== undefined && !options.includes(selectedOption)) {
      throw new Error("selectedOption is not one of the offered options");
    }
  }

  return {
    outcome: decision.decision,
    ...(selectedOption !== undefined ? { selectedOption } : {}),
    ...(decision.reason !== undefined ? { reason: decision.reason } : {})
  };
}

/** Builds the runtime-to-Conversation RoleMessage that Runtime queues through Herdr. */
export function buildDecisionRequestMessage(params: {
  readonly request: ApprovalRequest;
  readonly correlationId: string;
  readonly sender: RoleParticipant;
  readonly conversation: RoleParticipant;
}): RoleMessage {
  const { request } = params;
  if (!isUserDecisionRequest(request)) throw new Error("Only user-decision requests are routed by this module");
  // Contract rule: specialist roles cannot address Conversation directly; Runtime relays the request.
  if (params.sender.role !== "runtime") throw new Error("Decision requests reach Conversation from runtime, not from the specialist role");
  if (params.conversation.role !== "conversation") throw new Error("Recipient must be the Conversation role");
  return RoleMessageSchema.parse({
    schema_version: 2,
    message_id: `decision-${request.approvalId}`,
    correlation_id: params.correlationId,
    run_id: request.runId,
    sender: params.sender,
    recipient: params.conversation,
    type: "approval.request",
    payload: JSON.parse(JSON.stringify(request)) as unknown,
    artifact_references: [],
    occurred_at: request.requestedAt,
    idempotency_key: request.idempotencyKey
  });
}

/** Denies native direct user interaction for every role except Conversation. */
export function guardDirectUserInteraction(role: AgentRole, toolName: string): DirectInteractionGuard {
  if (role === "conversation") return { permitted: true };
  if (toolName === "AskUserQuestion" || /elicit/i.test(toolName)) {
    return {
      permitted: false,
      reason: `Direct user interaction (${toolName}) is disabled for the ${role} role. ` +
        `Call mcp__bflow__${USER_DECISION_TOOL} instead, then end your turn and wait for Runtime to resume.`
    };
  }
  return { permitted: true };
}
