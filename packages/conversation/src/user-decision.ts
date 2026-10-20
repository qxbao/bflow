import { wrapUntrustedRepositoryContent } from "./safety.js";

/**
 * Specialist user-decision support (P30 T8).
 *
 * A specialist role asks for a human decision through Runtime, which forwards an `approval.request`
 * whose metadata carries `kind: "user_decision"`. This module renders that request for the user and
 * maps the user's reply onto the existing human-approval path. It deliberately does not import
 * from @bflow/runtime and never selects a default option.
 */

export const USER_DECISION_KIND = "user_decision";
/** `conversation.progress` payload kind sent by Runtime when a user decision expires (matches Runtime's constant). */
export const USER_DECISION_EXPIRED_KIND = "user_decision_expired";

const REJECT_WORDS = ["reject", "decline", "từ chối", "không đồng ý", "không duyệt", "bác bỏ"] as const;

export type UserDecisionReplyResolution =
  | { readonly kind: "answer"; readonly selectedOption?: string; readonly reason?: string }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "ambiguous"; readonly message: string };

/** True when the approval payload or request carries the user-decision metadata marker. */
export function isUserDecisionRequest(request: { readonly metadata?: unknown } | Record<string, unknown>): boolean {
  const metadata = (request as { metadata?: unknown }).metadata;
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).kind === USER_DECISION_KIND;
}

/** True when the request has an expiry that has passed at `nowMs`. Requests without expiry never expire here. */
export function isExpiredUserDecision(request: { readonly expiresAt?: string | undefined }, nowMs: number): boolean {
  return request.expiresAt !== undefined && nowMs >= Date.parse(request.expiresAt);
}

/**
 * Returns the approvalId when a Runtime `conversation.progress` payload announces an expired user decision.
 * Ignores every other payload, so it can never remove a design/task approval.
 */
export function userDecisionExpiredApprovalId(messageType: string, payload: unknown): string | undefined {
  if (messageType !== "conversation.progress") return undefined;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (record.kind !== USER_DECISION_EXPIRED_KIND) return undefined;
  return typeof record.approvalId === "string" && record.approvalId.trim().length > 0 ? record.approvalId : undefined;
}

/** User-facing notice that a specialist question is closed and will not be accepted any more. */
export function renderUserDecisionExpiredNotice(approvalId: string): string {
  return [
    `⌛ **CÂU HỎI QUYẾT ĐỊNH ĐÃ HẾT HẠN [${approvalId}]**`,
    "Câu hỏi này không còn nhận trả lời. Tác tử đã được thông báo và sẽ không tiếp tục theo lựa chọn nào của câu hỏi này."
  ].join("\n");
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionsOf(request: { readonly metadata?: unknown }): readonly string[] | undefined {
  const metadata = (request as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const options = (metadata as Record<string, unknown>).options;
  if (!Array.isArray(options)) return undefined;
  const strings = options.filter((option): option is string => typeof option === "string");
  return strings.length > 0 ? strings : undefined;
}

function normalize(text: string): string {
  return text.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/u, "");
}

/** Matches a reject word as the whole reply or as its leading word(s), e.g. "từ chối vì chưa rõ". */
function isRejectWord(normalized: string): boolean {
  return REJECT_WORDS.some((word) => normalized === word || normalized.startsWith(`${word} `));
}

/**
 * Renders a specialist user-decision request as a user-facing question. The wording is distinct
 * from design/task approvals and names the asking role, the question, numbered options and expiry.
 */
export function renderUserDecisionPrompt(payload: Record<string, unknown>): string {
  const metadata = (typeof payload.metadata === "object" && payload.metadata !== null ? payload.metadata : {}) as Record<string, unknown>;
  const approvalId = stringOf(payload.approvalId) ?? "apr-unknown";
  const asker = stringOf(payload.requestedBy) ?? "specialist";
  const target = typeof payload.target === "object" && payload.target !== null ? payload.target as Record<string, unknown> : {};
  const taskId = stringOf(target.taskId);
  const question = stringOf(metadata.question) ?? stringOf(payload.reason) ?? "(không có nội dung câu hỏi)";
  const context = stringOf(metadata.context);
  const expiresAt = stringOf(payload.expiresAt);
  const options = optionsOf({ metadata });

  const lines = [
    `🙋 **CẦN QUYẾT ĐỊNH CỦA BẠN [${approvalId}]**`,
    `- **Tác tử yêu cầu:** ${asker}`,
    ...(taskId ? [`- **Tác vụ:** ${taskId}`] : []),
    `- **Câu hỏi:** ${question}`,
    ...(context ? [`- **Ngữ cảnh:** ${wrapUntrustedRepositoryContent(context)}`] : []),
    `- **Hết hạn:** ${expiresAt ? formatDeadline(expiresAt) : NO_DEADLINE_TEXT}`,
    ""
  ];
  if (options) {
    lines.push("Các lựa chọn:");
    options.forEach((option, index) => lines.push(`${index + 1}. ${option}`));
    lines.push(
      "",
      `👉 Cú pháp trả lời: \`${approvalId}: <số>\` (ví dụ \`${approvalId}: 1\`) hoặc \`${approvalId}: <nội dung lựa chọn>\`.`,
      `Nếu chỉ có một câu hỏi đang chờ, có thể chỉ trả lời \`<số>\`. Để từ chối: \`${approvalId}: từ chối <lý do>\`.`
    );
  } else {
    lines.push(
      `👉 Trả lời trực tiếp bằng nội dung quyết định của bạn, theo cú pháp \`${approvalId}: <nội dung quyết định>\`. Để từ chối: \`${approvalId}: từ chối <lý do>\`.`
    );
  }
  return lines.join("\n");
}

/** Deadline text shown when a user decision carries no expiry. */
export const NO_DEADLINE_TEXT = "Không có hạn — đang chờ bạn trả lời";

/** Human-readable deadline (UTC ISO) for a user-facing prompt. Unparseable values are shown verbatim. */
export function formatDeadline(expiresAt: string): string {
  const millis = Date.parse(expiresAt);
  return Number.isNaN(millis) ? expiresAt : new Date(millis).toISOString();
}

/**
 * Renders one pending approval for a user-facing status report. User decisions get the full question
 * rendering; design/task approvals keep their one-line form.
 */
export function renderPendingApprovalForStatus(request: {
  readonly approvalId: string; readonly reason: string; readonly requestedBy: string; readonly metadata?: unknown;
  readonly expiresAt?: string | undefined; readonly target?: unknown;
}, indent = "  "): string[] {
  if (!isUserDecisionRequest(request)) {
    return [`${indent}- **\`${request.approvalId}\`**: ${request.reason} (gửi bởi ${request.requestedBy})`];
  }
  return renderUserDecisionPrompt({ ...request }).split("\n").map((line) => (line === "" ? "" : `${indent}${line}`));
}

/**
 * Maps a free-text reply onto the pending user decision. Unknown or ambiguous replies return
 * `ambiguous` with a re-ask message; no default option is ever chosen.
 */
export function resolveUserDecisionReply(
  request: { readonly metadata?: unknown },
  content: string
): UserDecisionReplyResolution {
  const trimmed = content.trim();
  const normalized = normalize(trimmed);
  const options = optionsOf(request);

  if (!options) {
    if (normalized.length === 0) return ambiguousReply(options);
    if (isRejectWord(normalized)) return { kind: "reject", reason: trimmed };
    return { kind: "answer", reason: trimmed };
  }

  const numbered = /^(?:(?:chọn|lựa chọn|option|choose)\s*)?(\d{1,2})\s*[.)]?$/u.exec(normalized);
  if (numbered) {
    const index = Number(numbered[1]);
    const selected = index >= 1 && index <= options.length ? options[index - 1] : undefined;
    return selected !== undefined ? { kind: "answer", selectedOption: selected, reason: trimmed } : ambiguousReply(options);
  }

  const matches = options.filter((option) => normalize(option) === normalized);
  if (matches.length === 1) return { kind: "answer", selectedOption: matches[0]!, reason: trimmed };
  if (isRejectWord(normalized)) return { kind: "reject", reason: trimmed };
  return ambiguousReply(options);
}

function ambiguousReply(options: readonly string[] | undefined): UserDecisionReplyResolution {
  const choices = options ? `\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}` : "";
  return {
    kind: "ambiguous",
    message: `Tôi chưa xác định được lựa chọn của bạn. Vui lòng trả lời bằng số hoặc đúng nội dung một lựa chọn.${choices}`
  };
}

