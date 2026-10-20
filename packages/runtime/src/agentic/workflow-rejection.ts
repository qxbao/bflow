import { z } from "zod";
import { redactString } from "../resilience/redaction.js";

/**
 * Structured reasons a Coordinator's workflow proposal is refused before any state changes.
 * The options are informational text for the user. Nothing here is applied automatically.
 */
export type WorkflowRejectionCode = "missing_behavioral_runner" | "unsupported_verification" | "policy_violation" |
  "no_test_runner_detected" | "missing_test_paths" | "missing_test_mapping" | "unknown_test_command" | "unsupported_method";

/**
 * Coordinator-fixable refusals: the structured error is the instruction for the Coordinator, so Conversation gets no notice.
 * Only the remaining classes (including `no_test_runner_detected`) are reported to the user.
 */
export const AGENT_FIXABLE_REJECTIONS: readonly WorkflowRejectionCode[] = ["missing_test_paths", "missing_test_mapping", "unknown_test_command", "unsupported_method"];

/** Whether Runtime should tell Conversation (and through it the user) about this refusal. */
export function reportsToUser(rejection: WorkflowRejection): boolean {
  return !AGENT_FIXABLE_REJECTIONS.includes(rejection.code);
}

export interface WorkflowRejection {
  code: WorkflowRejectionCode;
  reason: string;
  methods?: string[];
  criteria?: string[];
  options: string[];
}

const CriterionSchema = z.object({
  id: z.string(),
  verificationMethod: z.string().optional(),
  required: z.boolean().optional(),
  status: z.string().optional()
}).passthrough();

/** Thrown by the proposal guard. The message is the structured rejection JSON, so the Coordinator receives the same data. */
export class WorkflowProposalRejected extends Error {
  constructor(readonly rejection: WorkflowRejection) {
    super(JSON.stringify(rejection));
    this.name = "WorkflowProposalRejected";
  }
}

/** Classifies a refused proposal. `phase` says which pre-check failed: project policy, or verification support. */
export function describeWorkflowRejection(input: {
  error: unknown; phase: "policy" | "verification"; specification: unknown; configuredMethods: readonly string[];
}): WorkflowRejection {
  const original = redactString(input.error instanceof Error ? input.error.message : String(input.error));
  if (input.phase === "policy") return { code: "policy_violation", reason: `Đặc tả không đúng chính sách dự án: ${original}`,
    options: ["Coordinator sửa đặc tả theo chính sách dự án rồi gửi lại", "Hủy run này"] };
  const specification = typeof input.specification === "object" && input.specification !== null ? input.specification as Record<string, unknown> : {};
  const criteria = z.array(CriterionSchema).catch([]).parse(specification.acceptanceCriteria);
  const automated = criteria.filter(item => item.required !== false && item.status !== "waived" &&
    item.verificationMethod !== undefined && item.verificationMethod !== "manual_review");
  const missing = automated.filter(item => !input.configuredMethods.includes(item.verificationMethod!));
  if (missing.length) {
    const methods = [...new Set(missing.map(item => item.verificationMethod!))], ids = missing.map(item => item.id);
    return {
      code: "missing_behavioral_runner",
      reason: `Chưa có runner kiểm thử hành vi do chủ dự án cấu hình cho phương pháp ${methods.join(", ")} (tiêu chí ${ids.join(", ")}).`,
      methods, criteria: ids,
      options: [
        "Coordinator đề xuất lại đặc tả dùng phương pháp đã có runner (unit_test → auto:unit, integration_test → auto:integration).",
        `Người dùng phê duyệt một đặc tả đã sửa, chuyển tiêu chí ${ids.join(", ")} sang manual_review. Coordinator không tự đổi tiêu chí.`,
        "Hủy run này."
      ]
    };
  }
  return { code: "unsupported_verification", reason: `Đặc tả không được hỗ trợ bởi cấu hình kiểm thử hiện tại: ${original}`,
    options: ["Coordinator sửa đặc tả hoặc phương pháp kiểm thử rồi gửi lại", "Người dùng phê duyệt đặc tả đã sửa", "Hủy run này"] };
}

/**
 * Runs one pre-check of a workflow proposal. Any failure becomes a WorkflowProposalRejected carrying the structured reason.
 * The check must not mutate the specification it inspects.
 */
export function guardWorkflowProposal(input: { phase: "policy" | "verification"; specification: unknown; configuredMethods: readonly string[];
  check: () => void }): void {
  try { input.check(); }
  catch (error) {
    if (error instanceof WorkflowProposalRejected) throw error;
    throw new WorkflowProposalRejected(describeWorkflowRejection({ error, phase: input.phase, specification: input.specification,
      configuredMethods: input.configuredMethods }));
  }
}
