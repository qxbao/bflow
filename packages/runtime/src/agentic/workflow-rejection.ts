import { z } from "zod";
import { redactString } from "../resilience/redaction.js";

/**
 * Structured reasons a Coordinator's workflow proposal is refused before any state changes.
 * The options are informational text for the user. Nothing here is applied automatically.
 */
export const WorkflowRejectionCodeSchema = z.enum(["missing_behavioral_runner", "unsupported_verification", "policy_violation",
  "no_test_runner_detected", "runner_setup_required", "verification_sandbox_unavailable", "missing_test_paths", "missing_test_mapping", "unknown_test_command", "unsupported_method",
  "invalid_specification"]);
export type WorkflowRejectionCode = z.infer<typeof WorkflowRejectionCodeSchema>;

/**
 * Coordinator-fixable refusals: the structured error is the instruction for the Coordinator, so Conversation gets no notice.
 * Only the remaining classes (including `no_test_runner_detected`) are reported to the user.
 */
export const AGENT_FIXABLE_REJECTIONS: readonly WorkflowRejectionCode[] = ["runner_setup_required", "missing_test_paths", "missing_test_mapping", "unknown_test_command", "unsupported_method",
  "invalid_specification"];

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

/** Pre-checks of a proposal, in order: specification and definition schemas (with strategy resolution), project policy, verification support. */
export type WorkflowProposalPhase = "specification" | "policy" | "verification";

/** One line per issue with its full path, instead of the raw issue JSON whose empty path names no field. */
function errorText(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`).join("; ");
  return error instanceof Error ? error.message : String(error);
}

/** Classifies a refused proposal. `phase` says which pre-check failed. */
export function describeWorkflowRejection(input: {
  error: unknown; phase: WorkflowProposalPhase; specification: unknown; configuredMethods: readonly string[];
}): WorkflowRejection {
  const original = redactString(errorText(input.error));
  // A malformed specification is the Coordinator's to correct: the reason names each invalid field.
  if (input.phase === "specification") return { code: "invalid_specification",
    reason: `Specification or workflow definition is not schema-valid; correct these fields and propose again: ${original}`,
    options: ["Coordinator sửa các trường đặc tả được nêu rồi gửi lại", "Hủy run này"] };
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
export function guardWorkflowProposal(input: { phase: WorkflowProposalPhase; specification: unknown; configuredMethods: readonly string[];
  check: () => void }): void {
  try { input.check(); }
  catch (error) {
    if (error instanceof WorkflowProposalRejected) throw error;
    throw new WorkflowProposalRejected(describeWorkflowRejection({ error, phase: input.phase, specification: input.specification,
      configuredMethods: input.configuredMethods }));
  }
}
