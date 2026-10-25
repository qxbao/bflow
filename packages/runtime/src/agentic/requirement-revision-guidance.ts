import { z } from "zod";
import { redactString } from "../resilience/redaction.js";

// RoleMessage validates the envelope. These optional task.status details also need
// validation before they become user instructions. Invalid detail is never authority.
const Details = z.object({
  requested_action: z.string().optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
  summary: z.string().optional().catch(undefined),
  blockageReason: z.string().optional().catch(undefined),
  // A bounded display hint retained by Runtime/receipts after their reason is clipped.
  requiredSddLevel: z.literal("full").optional().catch(undefined),
  blockers: z.array(z.string()).optional().catch(undefined)
});

// A clause is about the SDD level only when it names the spec/SDD itself, so "Git merge conflict" or "full rebuild" never match.
const SDD_SUBJECT = /\b(?:sdd|spec(?:ification)?s?)\b|đặc tả/iu;

/** Narrow fallback for old notices that recorded the SDD conflict only in prose; the conflict clause itself must name SDD and a level. */
function sddConflict(text: string): boolean {
  return text.split(/[.;\n]/u).some(clause => SDD_SUBJECT.test(clause) && /\b(?:lightweight|full)\b/i.test(clause) &&
    /conflict|mismatch|contradict|violat|xung đột|mâu thuẫn/i.test(clause) &&
    !/(?:\b(?:no|without)\s+(?:sdd[- ]*)?(?:conflict|mismatch)|(?:conflict|mismatch)[^\n]{0,160}\b(?:resolved|cleared|fixed)\b|không(?: còn| có)*\s+(?:xung đột|mâu thuẫn)|(?:xung đột|mâu thuẫn)[^\n]{0,160}đã(?: được)? giải quyết)/iu.test(clause));
}

/** Match affirmative requirements in either word order, never the noun "requirement" or "requires lightweight, not full"; only in an SDD/spec clause. */
function requiresFull(text: string): boolean {
  const beforeFull = /\b(?:require[sd]?|requiring|need(?:s|ed)?|must use)\s+(?:(?:use|using|a|the|level)\s+){0,2}[`'"]?full\b|(?:bắt buộc|cần|phải)\s+(?:(?:phải|dùng|sử dụng|áp dụng|mức)\s+){0,2}[`'"]?full\b/giu;
  const afterFull = /\bfull(?:\s+sdd)?\s+(?:(?:is|remains)\s+(?:required|mandatory)|(?:là\s+)?bắt buộc)/giu;
  return text.split(/[.;\n]/u).filter(clause => SDD_SUBJECT.test(clause)).some(clause => [...clause.matchAll(beforeFull), ...clause.matchAll(afterFull)].some(match =>
    !/(?:\b(?:not|no|never|neither|doesn't|don't)|không|chưa|chẳng)(?:\s+\p{L}+){0,3}\s+$/iu.test(clause.slice(0, match.index))));
}

/** Display guidance and conservative pause classification; never revises or approves a requirement. */
export function requirementRevisionGuidance(payload: unknown, runId?: string, workLabel?: string) {
  const parsed = Details.safeParse(payload);
  if (!parsed.success) return undefined;
  const detail = parsed.data;
  const blockers = (detail.blockers ?? []).slice(0, 2).map(value => redactString(value).slice(0, 200));
  const text = [detail.reason, detail.summary, detail.blockageReason,
    ...(detail.blockers ?? []).slice(0, 10).map(value => value.slice(0, 2000))].filter(Boolean).join("\n");
  const sdd = sddConflict(text);
  if (detail.requested_action !== "authorized_requirement_revision" && !sdd) return undefined;
  // Only suggest full when the reported blocker explicitly says full is required.
  // Other scope/SDD conflicts need the user's actual revision, not an invented fix.
  const needsFull = detail.requiredSddLevel === "full" || sdd && requiresFull(text);
  const target = workLabel ?? (runId ? `run ${runId}` : "việc hiện tại");
  const suggestedReply = needsFull ? `đổi yêu cầu ${target} sang bản đặc tả đầy đủ, giữ nguyên phạm vi và tiêu chí nghiệm thu` : undefined;
  return {
    requested_action: "authorized_requirement_revision" as const,
    ...(needsFull ? { requiredSddLevel: "full" as const } : {}),
    blockers,
    options: needsFull
      ? ["Đổi sang bản đặc tả đầy đủ để giữ nguyên phạm vi (đề xuất)", "Sửa hoặc thu hẹp phạm vi để Trưởng nhóm kỹ thuật đánh giá lại", "Hủy việc này"]
      : ["Nêu rõ yêu cầu cần sửa để giải quyết xung đột", "Hủy việc này"],
    nextSteps: [
      ...(needsFull ? ["Dự án yêu cầu bản đặc tả đầy đủ cho tính năng này, thay vì bản mô tả ngắn gọn hiện tại."] : []),
      "Bạn cần xác nhận nội dung sửa yêu cầu qua cuộc trò chuyện. Chỉ gửi lệnh tiếp tục không sửa yêu cầu và không giải quyết xung đột.",
      ...(blockers.length ? [`Chi tiết cần giải quyết: ${blockers.join("; ")}`] : []),
      "Sau khi bạn trả lời, hệ thống sẽ gửi bản sửa cho đúng công việc; Trưởng nhóm kỹ thuật xác nhận, đánh giá lại rồi mới tiếp tục. Các bước chờ bạn duyệt vẫn giữ nguyên."
    ],
    ...(suggestedReply ? { suggestedReply } : {})
  };
}
