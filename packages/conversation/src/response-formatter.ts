import { ConversationMessageSchema } from "@bflow/contracts";
import { isUserDecisionRequest, renderUserDecisionPrompt } from "./user-decision.js";

import type {
  ConversationContextSnapshot,
  ConversationMessage,
  ContractError,
  OperationResult,
  ProgressSnapshot,
  RoleMessage,
  SdlcWorkStatus,
  WorkflowRequestContext
} from "./types.js";

function formatZodError(error: { issues: readonly { path: readonly (string | number)[]; message: string }[] }): ContractError {
  const issueMessages = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return {
    code: "validation",
    retryable: false,
    message: `ConversationMessage validation failed: ${issueMessages}`
  };
}

function generateRandomSuffix(): string {
  return Math.random().toString(36).substring(2, 9);
}

function getPayloadRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

function safeString(val: unknown): string | undefined {
  if (typeof val === "string" && val.trim().length > 0) {
    return val.trim();
  }
  return undefined;
}

function safeNumber(val: unknown): number | undefined {
  if (typeof val === "number" && !Number.isNaN(val)) {
    return val;
  }
  return undefined;
}

/**
 * Computes a canonical fingerprint of the substantive fields of a Coordinator RoleMessage,
 * ignoring timestamps and non-substantive counters.
 */
export function computeProgressFingerprint(message: RoleMessage): string {
  const p = getPayloadRecord(message.payload);

  const type = message.type;
  const runId = message.run_id ?? "";
  const taskId = safeString(p.taskId) ?? safeString(p.task_id) ?? "";
  const state = safeString(p.state) ?? safeString(p.taskState) ?? safeString(p.status) ?? "";
  const sdlcStatus = safeString(p.sdlcStatus) ?? safeString(p.sdlc_status) ?? "";
  const stage = safeString(p.stage) ?? safeString(p.phase) ?? "";
  const milestone = safeString(p.milestone) ?? safeString(p.milestoneName) ?? "";
  const headline = safeString(p.headline) ?? safeString(p.title) ?? safeString(p.summary) ?? "";
  const blockageReason = safeString(p.blockageReason) ?? safeString(p.blockage_reason) ?? "";
  const failureSummary = safeString(p.failureSummary) ?? safeString(p.error) ?? safeString(p.failure_reason) ?? "";
  const escalated = p.escalated === true ? "escalated" : "";

  return `[${type}][${runId}][${taskId}][${state}][${sdlcStatus}][${stage}][${milestone}][${headline}][${blockageReason}][${failureSummary}][${escalated}]`;
}

/**
 * Determines whether an incoming Coordinator RoleMessage represents a substantive state update
 * or merely a duplicate/redundant heartbeat.
 */
export function isSubstantiveCoordinatorUpdate(
  message: RoleMessage,
  previousProgress?: ProgressSnapshot | undefined
): boolean {
  // 1. High-value milestone / decision events are always substantive
  const highValueTypes: readonly string[] = [
    "delegation.accepted",
    "spec.draft",
    "spec.approved",
    "approval.request",
    "verification.escalation",
    "verification.result",
    "review.verdict"
  ];

  if (highValueTypes.includes(message.type)) {
    return true;
  }

  // 2. If no previous progress exists, it is substantive
  if (!previousProgress) {
    return true;
  }

  const currentFp = computeProgressFingerprint(message);
  if (currentFp === previousProgress.fingerprint) {
    return false;
  }

  const p = getPayloadRecord(message.payload);
  const currentState = safeString(p.state) ?? safeString(p.taskState);
  const currentSdlc = safeString(p.sdlcStatus);
  const currentBlockage = safeString(p.blockageReason);
  const currentFailure = safeString(p.failureSummary) ?? safeString(p.error);

  // If state, sdlcStatus, blockage or failure changed, it's substantive
  if (currentState !== undefined && currentState !== previousProgress.taskState) {
    return true;
  }
  if (currentSdlc !== undefined && currentSdlc !== previousProgress.sdlcStatus) {
    return true;
  }
  if (currentBlockage !== previousProgress.blockageReason) {
    return true;
  }
  if (currentFailure !== previousProgress.failureSummary) {
    return true;
  }

  return true;
}

/**
 * Translates technical Coordinator RoleMessage payloads into clear, human-readable user messages.
 */
export function formatCoordinatorMessageForUser(params: {
  readonly sessionId: string;
  readonly turnSequence: number;
  readonly roleMessage: RoleMessage;
  readonly workflow?: WorkflowRequestContext | undefined;
  readonly createdAt: string;
}): OperationResult<{
  readonly message: ConversationMessage;
  readonly snapshot?: ProgressSnapshot;
  readonly substantive: boolean;
  readonly isBlocked: boolean;
  readonly isFailed: boolean;
  readonly isCompleted: boolean;
}> {
  const p = getPayloadRecord(params.roleMessage.payload);
  const type = params.roleMessage.type;
  const runId = params.roleMessage.run_id;

  const substantive = isSubstantiveCoordinatorUpdate(
    params.roleMessage,
    params.workflow?.lastProgress
  );

  const taskId = safeString(p.taskId) ?? safeString(p.task_id);
  const rawState = safeString(p.state) ?? safeString(p.taskState);
  const sdlcStatus = safeString(p.sdlcStatus) as SdlcWorkStatus | undefined;
  const progressPct = safeNumber(p.progressPercentage) ?? safeNumber(p.progress);
  const headline = safeString(p.headline) ?? safeString(p.summary) ?? safeString(p.title) ?? "Cập nhật từ Coordinator";
  const blockageReason = safeString(p.blockageReason) ?? safeString(p.blockage_reason);
  const failureSummary = safeString(p.failureSummary) ?? safeString(p.error) ?? safeString(p.failure_reason);
  const isEscalated = type === "verification.escalation" || p.escalated === true;

  let taskState: "starting" | "running" | "blocked" | "completed" | "failed" | undefined;
  if (rawState === "starting" || rawState === "running" || rawState === "blocked" || rawState === "completed" || rawState === "failed") {
    taskState = rawState;
  }

  let isBlocked = false;
  let isFailed = false;
  let isCompleted = false;

  let messageIntent: ConversationMessage["intent"] = "progress_update";
  let formattedContent = "";

  // 1. Approval request (specialist user decisions are rendered as questions)
  if (type === "approval.request" && isUserDecisionRequest(p)) {
    messageIntent = "approval_prompt";
    formattedContent = renderUserDecisionPrompt(p);
  }
  else if (type === "approval.request") {
    messageIntent = "approval_prompt";
    const approvalId = safeString(p.approvalId) ?? "apr-unknown";
    const reason = safeString(p.reason) ?? "Yêu cầu phê duyệt từ hệ thống";
    const requestedBy = safeString(p.requestedBy) ?? "Coordinator";
    const targetObj = getPayloadRecord(p.target);
    const targetType = safeString(targetObj.type) ?? "Tác vụ hệ thống";

    formattedContent = [
      `🔔 **YÊU CẦU PHÊ DUYỆT (Approval Required) [${approvalId}]**`,
      `- **Đối tượng:** ${targetType}`,
      `- **Lý do:** ${reason}`,
      `- **Người yêu cầu:** ${requestedBy}`,
      "",
      "👉 Bạn có thể phản hồi bằng một trong các cú pháp sau:",
      "- `approve` hoặc `đồng ý`: Chấp thuận cho quy trình tiếp tục.",
      "- `reject <lý do>` hoặc `từ chối <lý do>`: Bác bỏ yêu cầu.",
      "- `request changes <nội dung>` hoặc `cần sửa <nội dung>`: Yêu cầu chỉnh sửa lại."
    ].join("\n");
  }
  // 2. Verification escalation
  else if (type === "verification.escalation" || isEscalated) {
    isBlocked = true;
    isFailed = true;
    messageIntent = "error_report";
    const exhaustedIters = safeNumber(p.exhaustedIterations) ?? safeNumber(p.cycleCount) ?? 3;
    const unresolved = safeString(p.unresolvedCriteria) ?? failureSummary ?? "Tiêu chí nghiệm thu chưa thỏa mãn";

    formattedContent = [
      "⚠️ **[ESCALATED] Vòng lặp kiểm thử đã leo thang cần can thiệp**",
      taskId ? `- **Tác vụ:** ${taskId}` : undefined,
      `- **Trạng thái:** Đã chạy tối đa ${exhaustedIters} vòng lặp kiểm thử nhưng không vượt qua.`,
      `- **Chi tiết lỗi / tiêu chí chưa đạt:** ${unresolved}`,
      "",
      "👉 Bạn có thể:",
      "- Phê duyệt miễn giảm tiêu chí (waiver).",
      "- Điều chỉnh lại phạm vi yêu cầu.",
      "- Yêu cầu hủy hoặc dừng quy trình bằng lệnh `cancel`."
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  // 3. Blocked status
  else if (taskState === "blocked" || blockageReason !== undefined) {
    isBlocked = true;
    messageIntent = "progress_update";
    const reason = blockageReason ?? "Đang chờ điều kiện tiên quyết hoặc phê duyệt từ người dùng.";

    formattedContent = [
      "🛑 **[BLOCKED] Nhiệm vụ đang bị chặn (Blocked)**",
      taskId ? `- **Tác vụ:** ${taskId}` : undefined,
      `- **Lý do chặn:** ${reason}`,
      "",
      "Hệ thống đang tạm dừng tác vụ này cho đến khi lý do chặn được tháo gỡ hoặc bạn cung cấp hướng dẫn tiếp theo."
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  // 4. Failed status
  else if (taskState === "failed" || failureSummary !== undefined) {
    isFailed = true;
    messageIntent = "error_report";
    const reason = failureSummary ?? "Gặp lỗi trong quá trình thực thi.";

    formattedContent = [
      "❌ **[FAILED] Tác vụ gặp lỗi không thể tiếp tục**",
      taskId ? `- **Tác vụ:** ${taskId}` : undefined,
      `- **Lý do lỗi:** ${reason}`,
      "",
      "Bạn có thể yêu cầu thử lại hoặc điều chỉnh yêu cầu."
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  // 5. Explicitly verified workflow completion
  else if (
    (type === "conversation.progress" || type === "task.status") &&
    (p.status === "completed" || p.state === "completed" || taskState === "completed" || sdlcStatus === "completed") &&
    p.verified === true
  ) {
    isCompleted = true;
    messageIntent = "final_summary";

    formattedContent = [
      "🎉 **HOÀN THÀNH QUY TRÌNH (Workflow Completed & Verified)**",
      runId ? `- **Mã quy trình (Run ID):** ${runId}` : undefined,
      "- **Tiến độ:** 100% hoàn thành và đã được kiểm thử, xác minh độc lập thành công.",
      `- **Kết quả:** ${headline}`,
      "",
      "Mọi thay đổi đã được kiểm tra nghiêm ngặt theo đúng đặc tả và tiêu chuẩn chất lượng."
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  // 6. Delegation accepted
  else if (type === "delegation.accepted") {
    messageIntent = "delegation_handoff";
    formattedContent = [
      "📋 **Coordinator đã tiếp nhận yêu cầu**",
      runId ? `- **Run ID:** ${runId}` : undefined,
      "- **Kế hoạch:** Coordinator đang phân tích yêu cầu, xác định cấp độ SDD/TDD và lập DAG tác vụ.",
      "- **Trạng thái:** Đang tiến hành."
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  // 7. Spec draft
  else if (type === "spec.draft") {
    messageIntent = "spec_draft_review";
    const specTitle = safeString(p.title) ?? "Bản thảo đặc tả";
    const sddLevel = safeString(p.level) ?? "standard";
    const summary = safeString(p.summary) ?? headline;

    formattedContent = [
      `📝 **Bản thảo đặc tả kỹ thuật: ${specTitle}**`,
      `- **Cấp độ SDD:** ${sddLevel}`,
      `- **Tóm tắt:** ${summary}`,
      "",
      "Đặc tả đang được chuẩn bị để phê duyệt trước khi lập trình."
    ].join("\n");
  }
  // 8. Spec approved
  else if (type === "spec.approved") {
    messageIntent = "progress_update";
    formattedContent = [
      "✅ **Đặc tả kỹ thuật đã được phê duyệt**",
      "- Quy trình chuyển sang giai đoạn lập kế hoạch kiểm thử và thực thi (TDD/Implementation)."
    ].join("\n");
  }
  // 9. Verification result
  else if (type === "verification.result") {
    messageIntent = "progress_update";
    const verdict = safeString(p.verdict) ?? safeString(p.status) ?? "hoàn tất";
    formattedContent = [
      `🧪 **Kết quả xác minh (Verification Result): ${verdict}**`,
      `- **Chi tiết:** ${headline}`
    ].join("\n");
  }
  // 10. Review verdict
  else if (type === "review.verdict") {
    messageIntent = "progress_update";
    const verdict = safeString(p.verdict) ?? "đạt";
    formattedContent = [
      `🧐 **Kết quả đánh giá mã nguồn (Review Verdict): ${verdict}**`,
      `- **Nhận xét:** ${headline}`
    ].join("\n");
  }
  // 11. General progress update
  else {
    messageIntent = "progress_update";
    formattedContent = [
      `⚙️ **Tiến độ thực hiện: ${headline}**`,
      taskId ? `- **Tác vụ hiện tại:** ${taskId}` : undefined,
      sdlcStatus ? `- **Giai đoạn SDLC:** ${sdlcStatus}` : undefined,
      progressPct !== undefined ? `- **Hoàn thành:** ${progressPct}%` : undefined
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  const fingerprint = computeProgressFingerprint(params.roleMessage);

  const snapshot: ProgressSnapshot = {
    ...(taskId !== undefined ? { taskId } : {}),
    ...(sdlcStatus !== undefined ? { sdlcStatus } : {}),
    ...(taskState !== undefined ? { taskState } : {}),
    ...(progressPct !== undefined ? { progressPercentage: progressPct } : {}),
    headline,
    ...(blockageReason !== undefined ? { blockageReason } : {}),
    ...(failureSummary !== undefined ? { failureSummary } : {}),
    ...(isEscalated ? { escalated: true } : {}),
    updatedAt: params.createdAt,
    fingerprint
  };

  const messageId = `msg-conv-${params.turnSequence}-${generateRandomSuffix()}`;

  const rawMessage = {
    schemaVersion: 2 as const,
    messageId,
    sessionId: params.sessionId,
    correlationId: params.roleMessage.correlation_id,
    ...(runId !== undefined ? { runId } : {}),
    turnSequence: params.turnSequence,
    sender: "conversation" as const,
    recipient: "user" as const,
    intent: messageIntent,
    content: formattedContent,
    artifactReferences: params.roleMessage.artifact_references ? [...params.roleMessage.artifact_references] : [],
    createdAt: params.createdAt
  };

  const parsed = ConversationMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }

  return {
    ok: true,
    value: {
      message: parsed.data,
      snapshot,
      substantive,
      isBlocked,
      isFailed,
      isCompleted
    }
  };
}

/**
 * Formats a comprehensive, human-readable status summary of workflows in the conversation session.
 */
export function formatStatusSummaryForUser(
  context: ConversationContextSnapshot,
  targetCorrelationId?: string | undefined
): string {
  const lines: string[] = [];

  // Target specific workflow if correlationId is provided
  if (targetCorrelationId) {
    const wf = context.workflows[targetCorrelationId];
    if (!wf) {
      return `Không tìm thấy thông tin tiến độ cho mã tương quan: ${targetCorrelationId}`;
    }

    lines.push(`📊 **BÁO CÁO TIẾN ĐỘ QUY TRÌNH [${wf.runId}]**`);
    lines.push(`- **Yêu cầu:** ${wf.title}`);
    lines.push(`- **Giai đoạn SDLC:** ${wf.sdlcStatus}`);
    lines.push(`- **Cấp độ SDD:** ${wf.sddLevel} | **Ưu tiên:** ${wf.priority}`);

    if (wf.lastProgress) {
      lines.push(`- **Cập nhật gần nhất:** ${wf.lastProgress.headline}`);
      if (wf.lastProgress.taskState) {
        lines.push(`- **Trạng thái tác vụ:** ${wf.lastProgress.taskState}`);
      }
      if (wf.lastProgress.progressPercentage !== undefined) {
        lines.push(`- **Tiến độ:** ${wf.lastProgress.progressPercentage}%`);
      }
    }

    if (wf.blockedReason) {
      lines.push(`- 🛑 **Đang bị chặn:** ${wf.blockedReason}`);
    }
    if (wf.failureReason) {
      lines.push(`- ❌ **Lỗi:** ${wf.failureReason}`);
    }
    if (wf.completedVerified) {
      lines.push("- ✅ **Quy trình đã hoàn thành và được kiểm thử xác minh độc lập.**");
    }

    if (wf.activeApprovalIds.length > 0) {
      lines.push(`- 🔔 **Phê duyệt đang chờ xử lý:** ${wf.activeApprovalIds.join(", ")}`);
    }

    return lines.join("\n");
  }

  // Session-wide status summary
  lines.push("📊 **TỔNG HỢP TRẠNG THÁI HỆ THỐNG BFLOW**");
  lines.push(`- **Trạng thái phiên làm việc:** ${context.session.status}`);

  const workflows = Object.values(context.workflows);
  if (workflows.length === 0) {
    lines.push("- **Quy trình công việc:** Hiện chưa có quy trình nào đang chạy.");
  } else {
    lines.push(`\n**Các quy trình công việc (${workflows.length}):**`);
    for (const wf of workflows) {
      const stateBadge = wf.completedVerified
        ? "✅ [Hoàn thành]"
        : wf.blockedReason
        ? "🛑 [Bị chặn]"
        : wf.failureReason
        ? "❌ [Thất bại]"
        : "⚙️ [Đang chạy]";

      lines.push(
        `  ${stateBadge} **${wf.title}** (Run: \`${wf.runId}\` | Giai đoạn: \`${wf.sdlcStatus}\`)`
      );
      if (wf.lastProgress?.headline) {
        lines.push(`    ↳ ${wf.lastProgress.headline}`);
      }
      if (wf.blockedReason) {
        lines.push(`    ↳ 🛑 Lý do chặn: ${wf.blockedReason}`);
      }
    }
  }

  const pendingApprovals = Object.values(context.pendingApprovals);
  if (pendingApprovals.length > 0) {
    lines.push(`\n🔔 **Phê duyệt đang chờ bạn xử lý (${pendingApprovals.length}):**`);
    for (const apr of pendingApprovals) {
      lines.push(`  - **\`${apr.approvalId}\`**: ${apr.reason} (gửi bởi ${apr.requestedBy})`);
    }
    lines.push("  👉 Gõ `approve` để duyệt hoặc `reject <lý do>` để từ chối.");
  }

  const pendingClarifications = Object.values(context.pendingClarifications);
  if (pendingClarifications.length > 0) {
    lines.push(`\n❓ **Yêu cầu cần làm rõ (${pendingClarifications.length}):**`);
    for (const clr of pendingClarifications) {
      lines.push(`  - "${clr.originalRequestText}"`);
      for (const q of clr.unresolvedQuestions) {
        lines.push(`    • ${q}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * ResponseFormatter class providing message and status formatting capabilities.
 */
export class ResponseFormatter {
  public computeProgressFingerprint(message: RoleMessage): string {
    return computeProgressFingerprint(message);
  }

  public isSubstantiveCoordinatorUpdate(message: RoleMessage, previousProgress?: ProgressSnapshot): boolean {
    return isSubstantiveCoordinatorUpdate(message, previousProgress);
  }

  public formatCoordinatorMessageForUser(params: Parameters<typeof formatCoordinatorMessageForUser>[0]): ReturnType<typeof formatCoordinatorMessageForUser> {
    return formatCoordinatorMessageForUser(params);
  }

  public formatStatusSummaryForUser(context: ConversationContextSnapshot, targetCorrelationId?: string): string {
    return formatStatusSummaryForUser(context, targetCorrelationId);
  }

  public static computeProgressFingerprint(message: RoleMessage): string {
    return computeProgressFingerprint(message);
  }

  public static isSubstantiveCoordinatorUpdate(message: RoleMessage, previousProgress?: ProgressSnapshot): boolean {
    return isSubstantiveCoordinatorUpdate(message, previousProgress);
  }

  public static formatCoordinatorMessageForUser(params: Parameters<typeof formatCoordinatorMessageForUser>[0]): ReturnType<typeof formatCoordinatorMessageForUser> {
    return formatCoordinatorMessageForUser(params);
  }

  public static formatStatusSummaryForUser(context: ConversationContextSnapshot, targetCorrelationId?: string): string {
    return formatStatusSummaryForUser(context, targetCorrelationId);
  }
}
