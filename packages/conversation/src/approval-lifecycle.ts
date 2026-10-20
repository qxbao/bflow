import { sanitizeReasonForUser } from "./safety.js";
import type { ClosedApproval } from "./types.js";

/** `conversation.progress` payload kind Runtime sends when a requirement revision supersedes approvals. */
export const APPROVAL_SUPERSEDED_KIND = "approval_superseded";

/** Run statuses after which no human decision can change the run, so its approvals are closed. */
const TERMINAL_RUN_STATUSES: readonly string[] = ["completed", "failed", "cancelled"];

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Returns the approval ids and reason of a Runtime notice that a requirement revision superseded them.
 * Any other payload yields undefined, so the notice can never close an approval by accident.
 */
export function supersededApprovals(
  messageType: string,
  payload: unknown
): { readonly approvalIds: readonly string[]; readonly reason: string } | undefined {
  if (messageType !== "conversation.progress") return undefined;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (record.kind !== APPROVAL_SUPERSEDED_KIND || !Array.isArray(record.approvalIds)) return undefined;
  const approvalIds = record.approvalIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  if (approvalIds.length === 0) return undefined;
  const reason = typeof record.reason === "string" && record.reason.trim().length > 0 ? record.reason : "Yêu cầu đã được cập nhật";
  return { approvalIds, reason: sanitizeReasonForUser(reason, 300) };
}

/** User-facing refusal for a decision on an approval that was closed; nothing is applied. */
export function closedApprovalNotice(closed: ClosedApproval): string {
  const cause = closed.status === "superseded"
    ? "đã bị thay thế bởi một bản cập nhật yêu cầu"
    : `đã đóng vì run ${closed.runId} đã kết thúc`;
  return [
    `Phê duyệt ${closed.approvalId} không còn hiệu lực (${cause}).`,
    `Lý do: ${sanitizeReasonForUser(closed.reason, 200)}`,
    "Phản hồi của bạn chưa được ghi nhận và không có quyết định nào được áp dụng. Hỏi \"trạng thái\" để xem các phê duyệt đang chờ."
  ].join("\n");
}
