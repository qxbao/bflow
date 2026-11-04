import { z } from "zod";
import { ApprovalDecisionSchema, type ApprovalDecision, type ApprovalRequest, type OperationResult } from "@bflow/contracts";
import { digest } from "./journal.js";
import { isUserDecisionRequest, validateUserDecisionAnswer } from "./decision-routing.js";
import { prototypeApproval, prototypeDecisionRefusal, type PrototypeRecord } from "./prototype-review.js";
import type { HumanCliOwnerProvenance } from "./host-receipts.js";

/**
 * D-DIR-02: `bflow approve <#n>` typed by the user. Owner-token host method only: a Director credential is refused before
 * any method dispatch (R-B1-1), and no Director tool can reach this path.
 */
export const HUMAN_DECISION_CLI_METHOD = "human_decision_cli";
export const HUMAN_DECISION_CLI_MAX_CHOICE = 6;
export const HumanDecisionCliInputSchema = z.object({
  code: z.string().regex(/^#[1-9]\d*$/),
  outcome: z.enum(["approved", "rejected", "changes_requested", "answer"]),
  reason: z.string().trim().min(1).max(2000).optional(),
  choice: z.number().int().min(1).max(HUMAN_DECISION_CLI_MAX_CHOICE).optional(),
  tty: z.boolean(),
  pid: z.number().int().positive()
}).strict().superRefine((input, context) => {
  if (input.outcome === "answer" && input.choice === undefined)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "answer requires choice", path: ["choice"] });
  if (input.outcome !== "answer" && input.choice !== undefined)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "choice is only valid with answer", path: ["choice"] });
  if (input.outcome === "changes_requested" && input.reason === undefined)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "changes_requested requires reason", path: ["reason"] });
});
export type HumanDecisionCliInput = z.infer<typeof HumanDecisionCliInputSchema>;

export const HumanDecisionCliValueSchema = z.object({
  approvalId: z.string().min(1), runId: z.string().min(1), kind: z.enum(["approval", "user_decision"]), queued: z.literal(true),
  code: z.string().regex(/^#[1-9]\d*$/), outcome: HumanDecisionCliInputSchema.innerType().shape.outcome,
  runLabel: z.string().min(1).optional(), selectedOption: z.string().min(1).optional(), alreadyRecorded: z.boolean()
}).strict();
export type HumanDecisionCliValue = z.infer<typeof HumanDecisionCliValueSchema>;

export interface HumanDecisionCliDeps {
  readonly conversationSessionId: string;
  readonly now: () => string;
  readonly aliases: () => Promise<{ approvalShortIds: Record<string, string>; runShortIds: Record<string, string> }>;
  readonly pendingApprovals: (query: { sessionId: string }) => Promise<{ request: ApprovalRequest }[]>;
  /** Runtime state snapshot, used only to explain why a card is no longer pending. */
  readonly inspect: () => Promise<unknown>;
  /** The trusted human receipt already recorded for this approval, whatever its provenance. */
  readonly existingDecision: (approvalId: string) => Promise<ApprovalDecision | undefined>;
  readonly recordHuman: (decision: ApprovalDecision, provenance: HumanCliOwnerProvenance) => Promise<void>;
  readonly receiveOwnerDecision: (decision: ApprovalDecision, record: (decision: ApprovalDecision) => Promise<void>) =>
    Promise<OperationResult<{ queued: boolean }>>;
}

/** Lenient view of untyped Runtime state: a missing or non-object value reads as empty. */
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const failure = (code: "not_found" | "conflict" | "validation", message: string): OperationResult<never> =>
  code === "conflict" ? { ok: false, error: { code, retryable: true, message } } : { ok: false, error: { code, retryable: false, message } };

/** Stable per (card, approval, answer): the same command typed twice is the same decision. */
export function humanDecisionCliIdempotencyKey(code: string, approvalId: string, outcome: string, choice: number | undefined): string {
  return `cli-${digest([code, approvalId, outcome, choice ?? null])}`;
}

/** Why a known card is no longer pending, from Runtime's durable state; a generic reason when the approval is unknown. */
export function notPendingReason(state: unknown, approvalId: string): string {
  const runs = Array.isArray(record(state).runs) ? record(state).runs as unknown[] : [];
  for (const raw of runs) {
    const run = record(raw), userDecision = record(run.userDecisions)[approvalId];
    const owns = record(run.approval).approvalId === approvalId || userDecision !== undefined ||
      prototypeApproval(run.prototype as PrototypeRecord | undefined, approvalId) !== undefined;
    if (!owns) continue;
    if (run.cancelled === true || ["completed", "failed", "cancelled"].includes(String(run.status)))
      return `việc đã kết thúc (${run.cancelled === true ? "cancelled" : String(run.status)})`;
    if (userDecision !== undefined && record(userDecision).status !== "pending") return `câu hỏi đã ở trạng thái ${String(record(userDecision).status)}`;
    const prototype = prototypeDecisionRefusal(run.prototype as PrototypeRecord | undefined, approvalId);
    if (prototype) return prototype;
    if (record(run.decision).approvalId === approvalId) return "thẻ đã có quyết định";
    return "thẻ không còn chờ quyết định";
  }
  return "thẻ không còn chờ quyết định";
}

function buildDecision(input: HumanDecisionCliInput, request: ApprovalRequest, now: string):
  OperationResult<{ decision: ApprovalDecision; kind: "approval" | "user_decision"; selectedOption?: string }> {
  const userDecision = isUserDecisionRequest(request);
  const options = userDecision && Array.isArray(request.metadata.options)
    ? request.metadata.options.filter((value): value is string => typeof value === "string") : [];
  let decision: "approved" | "rejected" | "changes_requested", reason: string, selectedOption: string | undefined;
  if (userDecision) {
    if (input.outcome === "changes_requested")
      return failure("validation", `Thẻ ${input.code} là câu hỏi của agent: chỉ nhận duyệt, từ chối hoặc --choice <n>`);
    if (input.outcome === "answer") {
      selectedOption = options[input.choice! - 1];
      if (selectedOption === undefined)
        return failure("validation", options.length ? `Thẻ ${input.code} chỉ có ${options.length} phương án; chọn --choice từ 1 đến ${options.length}`
          : `Thẻ ${input.code} là câu hỏi mở, không có phương án để chọn; hãy trả lời trên Web`);
      decision = "approved"; reason = input.reason ?? selectedOption;
    } else if (input.outcome === "approved") {
      if (options.length) return failure("validation", `Thẻ ${input.code} là câu hỏi có lựa chọn; dùng --choice <n> (1..${options.length})`);
      if (!input.reason) return failure("validation", `Thẻ ${input.code} là câu hỏi mở cần câu trả lời bằng chữ; hãy trả lời trên Web`);
      decision = "approved"; reason = input.reason;
    } else { decision = "rejected"; reason = input.reason ?? "User rejected"; }
    if (request.metadata.testIntegrityException !== undefined && selectedOption === "Approve test-integrity exception" && !input.reason)
      return failure("validation", "Ngoại lệ test-integrity cần lý do rõ ràng của chủ dự án; hãy trả lời trên Web");
  } else {
    if (input.outcome === "answer") return failure("validation", `--choice chỉ dùng cho câu hỏi của agent; thẻ ${input.code} là thẻ phê duyệt`);
    decision = input.outcome;
    reason = input.reason ?? (decision === "approved" ? "User approved" : "User rejected");
  }
  const parsed = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId, runId: request.runId,
    ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}), target: request.target,
    revision: request.revision, generation: request.generation, decision, decidedBy: "human_operator", decidedAt: now, reason,
    feedbackArtifacts: [], idempotencyKey: humanDecisionCliIdempotencyKey(input.code, request.approvalId, input.outcome, input.choice),
    ...(selectedOption !== undefined ? { metadata: { selectedOption } } : {}) });
  if (userDecision) {
    try { validateUserDecisionAnswer(request, parsed, now); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(/expired/i.test(message) ? "conflict" : "validation", message);
    }
  }
  return { ok: true, value: { decision: parsed, kind: userDecision ? "user_decision" : "approval", ...(selectedOption !== undefined ? { selectedOption } : {}) } };
}

/**
 * Resolves `#n` from the host's notice aliases, builds the decision for the exact pending request (revision, generation,
 * target, session) and admits it through the same Conversation decision path the Web uses. The trusted human receipt
 * (`cli_owner`) is written only after the admission checks pass and before the decision is queued.
 */
export async function handleHumanDecisionCli(params: unknown, deps: HumanDecisionCliDeps): Promise<OperationResult<HumanDecisionCliValue>> {
  const input = HumanDecisionCliInputSchema.parse(params);
  const aliases = await deps.aliases();
  const approvalId = aliases.approvalShortIds[input.code];
  if (approvalId === undefined) return failure("not_found", `Không tìm thấy thẻ ${input.code} đang chờ`);
  const key = humanDecisionCliIdempotencyKey(input.code, approvalId, input.outcome, input.choice);
  const runLabel = (runId: string) => Object.entries(aliases.runShortIds).find(([, id]) => id === runId)?.[0];
  const finish = (decision: ApprovalDecision, kind: "approval" | "user_decision", alreadyRecorded: boolean): HumanDecisionCliValue => {
    const label = runLabel(decision.runId), selected = decision.metadata?.selectedOption;
    return HumanDecisionCliValueSchema.parse({ approvalId, runId: decision.runId, kind, queued: true, code: input.code, outcome: input.outcome,
      ...(label ? { runLabel: label } : {}), ...(typeof selected === "string" ? { selectedOption: selected } : {}), alreadyRecorded });
  };
  const existing = await deps.existingDecision(approvalId);
  if (existing) {
    if (existing.idempotencyKey !== key) return failure("conflict", `Thẻ ${input.code} đã có quyết định khác`);
    // Identical retry: re-admit the recorded decision (no second receipt, no second outbound).
    const replay = await deps.receiveOwnerDecision(existing, async () => undefined);
    if (!replay.ok) return replay;
    const run = record((record(await deps.inspect()).runs as unknown[] | undefined)?.find(item => record(item).runId === existing.runId));
    return { ok: true, value: finish(existing, record(run.userDecisions)[approvalId] !== undefined ? "user_decision" : "approval", true) };
  }
  const pending = (await deps.pendingApprovals({ sessionId: deps.conversationSessionId })).find(item => item.request.approvalId === approvalId);
  if (!pending) return failure("conflict", `Thẻ ${input.code}: ${notPendingReason(await deps.inspect(), approvalId)}`);
  const now = deps.now();
  const built = buildDecision(input, pending.request, now);
  if (!built.ok) return built;
  const provenance: HumanCliOwnerProvenance = { kind: "cli_owner", pid: input.pid, tty: input.tty, at: now };
  const admitted = await deps.receiveOwnerDecision(built.value.decision, decision => deps.recordHuman(decision, provenance));
  if (!admitted.ok) return { ok: false, error: { ...admitted.error, message: `Thẻ ${input.code}: ${admitted.error.message}` } };
  return { ok: true, value: finish(built.value.decision, built.value.kind, false) };
}
