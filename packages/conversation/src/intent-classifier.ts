import type {
  ConversationContextSnapshot,
  ExtractedApprovalInput,
  ExtractedCancellationInput,
  ExtractedRequirementDraft,
  IntentClassificationResult,
  OperationResult,
  SddPolicyLevel,
  UserTurnInput,
  WorkflowRequestContext,
  WorkflowRequestKind
} from "./types.js";
import { isExpiredUserDecision, isUserDecisionRequest, resolveUserDecisionReply } from "./user-decision.js";

const ZERO_WIDTH_STRIP_REGEX = /[\u200B-\u200D\uFEFF\u00AD]/g;

function sanitizeInputText(raw: string): string {
  return raw.replace(ZERO_WIDTH_STRIP_REGEX, "").trim();
}

function normalizeForMatching(text: string): string {
  return sanitizeInputText(text)
    .toLowerCase()
    .normalize("NFC");
}

function extractExplicitId(text: string, prefix: string): string | undefined {
  const regex = new RegExp(`\\b(${prefix}[a-zA-Z0-9_-]+)\\b`, "i");
  const match = regex.exec(text);
  return match ? match[1] : undefined;
}

function extractFilePaths(text: string): readonly string[] {
  const pathRegex = /\b(?:packages\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*|src\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*|apps\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*|[a-zA-Z0-9_.-]+\.(?:ts|js|json|md|yaml|yml))\b/g;
  const matches = text.match(pathRegex);
  if (!matches || matches.length === 0) {
    return [];
  }
  const unique = Array.from(new Set(matches.map((m) => m.trim())));
  return unique;
}

function detectCancellation(
  input: UserTurnInput,
  context: ConversationContextSnapshot
): { matched: boolean; result?: IntentClassificationResult } {
  const rawContent = input.content ?? "";
  const norm = normalizeForMatching(rawContent);

  // Guard: If it is an approval rejection, do NOT classify as cancellation
  const isApprovalReject =
    /(?<!\p{L})(?:từ chối phê duyệt|từ chối approval|không duyệt|bác bỏ phê duyệt|reject approval|reject apr-)(?!\p{L})/iu.test(
      norm
    );
  if (isApprovalReject) {
    return { matched: false };
  }

  const cancelRegex =
    /(?<!\p{L})(?:cancel|cancel workflow|stop run|stop workflow|abort|abort workflow|terminate run|kill workflow|hủy|hủy bỏ|hủy yêu cầu|hủy workflow|hủy run|dừng workflow|dừng chạy|ngừng chạy|dừng task|ngừng workflow)(?!\p{L})/iu;

  if (cancelRegex.test(norm)) {
    const explicitRunId =
      input.runId ?? extractExplicitId(rawContent, "run-") ?? context.session.activeRunId;
    const explicitTaskId = extractExplicitId(rawContent, "task-");

    const reason = rawContent.trim();
    const cancellationInput: ExtractedCancellationInput = {
      ...(explicitRunId !== undefined ? { runId: explicitRunId } : {}),
      ...(explicitTaskId !== undefined ? { taskId: explicitTaskId } : {}),
      reason
    };

    const targetCorrelationId =
      explicitRunId !== undefined
        ? context.runIdToCorrelationId[explicitRunId] ?? context.session.metadata?.correlationId?.toString()
        : undefined;

    return {
      matched: true,
      result: {
        intent: "cancellation_request",
        confidence: 0.95,
        rationale: "User explicitly requested cancellation or abort of active run/task.",
        clarifyingQuestions: [],
        cancellationInput,
        ...(targetCorrelationId !== undefined ? { targetCorrelationId } : {}),
        ...(explicitRunId !== undefined ? { targetRunId: explicitRunId } : {})
      }
    };
  }

  return { matched: false };
}

function detectApproval(
  rawContent: string,
  context: ConversationContextSnapshot
): { matched: boolean; result?: IntentClassificationResult } {
  const norm = normalizeForMatching(rawContent);

  // Specialist user decisions are answered through detectUserDecision; they must never become the
  // implicit target of a design/task approval ("approve" without an id).
  const isUserDecisionId = (id: string): boolean => {
    const request = context.pendingApprovals[id];
    return request !== undefined && isUserDecisionRequest(request);
  };
  const pendingApprovalKeys = Object.keys(context.pendingApprovals).filter((id) => !isUserDecisionId(id));
  const activeApprovalIds = (context.session.activeApprovalIds ?? []).filter((id) => !isUserDecisionId(id));
  const hasPendingApprovals =
    pendingApprovalKeys.length > 0 ||
    activeApprovalIds.length > 0 ||
    context.session.status === "awaiting_user_approval";

  const explicitApprovalMention =
    /(?<!\p{L})(?:apr-[a-zA-Z0-9_-]+|phê duyệt|chấp thuận|approval|approve|reject|từ chối|đồng ý)(?!\p{L})/iu.test(norm);

  if (!hasPendingApprovals && !explicitApprovalMention) {
    return { matched: false };
  }

  const approveRegex =
    /(?<!\p{L})(?:approve|approved|lgtm|đồng ý|duyệt|chấp thuận|chấp nhận|ok duyệt|đồng ý duyệt|xác nhận duyệt)(?!\p{L})/iu;
  const rejectRegex =
    /(?<!\p{L})(?:reject|rejected|decline|từ chối|không đồng ý|không duyệt|bác bỏ|bỏ qua không duyệt)(?!\p{L})/iu;
  const changeRequestRegex =
    /(?<!\p{L})(?:request changes|changes requested|changes_requested|cần sửa|yêu cầu chỉnh sửa|sửa lại|chỉnh sửa lại|sửa thêm|cần thay đổi)(?!\p{L})/iu;

  let decision: "approved" | "rejected" | "changes_requested" | undefined;

  if (changeRequestRegex.test(norm)) {
    decision = "changes_requested";
  } else if (rejectRegex.test(norm)) {
    decision = "rejected";
  } else if (approveRegex.test(norm)) {
    decision = "approved";
  }

  if (!decision) {
    return { matched: false };
  }

  const explicitId =
    extractExplicitId(rawContent, "apr-") ??
    pendingApprovalKeys[0] ??
    activeApprovalIds[0];

  let reason: string | undefined;
  if (decision !== "approved") {
    // Contract requires reason when decision !== "approved"
    reason = rawContent.trim();
  }

  const approvalInput: ExtractedApprovalInput = {
    ...(explicitId !== undefined ? { approvalId: explicitId } : {}),
    decision,
    ...(reason !== undefined ? { reason } : {})
  };

  const pendingReq = explicitId ? context.pendingApprovals[explicitId] : undefined;
  const targetRunId = pendingReq?.runId ?? context.session.activeRunId;
  const targetCorrelationId = targetRunId ? context.runIdToCorrelationId[targetRunId] : undefined;

  return {
    matched: true,
    result: {
      intent: "approval_response",
      confidence: 0.96,
      rationale: `User provided approval response with decision "${decision}".`,
      clarifyingQuestions: [],
      approvalInput,
      ...(targetCorrelationId !== undefined ? { targetCorrelationId } : {}),
      ...(targetRunId !== undefined ? { targetRunId } : {})
    }
  };
}

/**
 * Routes a reply to a pending specialist user decision. Options are matched strictly; an unknown
 * reply is answered with a re-ask (conversation_only, no state change) and never defaults.
 */
function detectUserDecision(
  rawContent: string,
  context: ConversationContextSnapshot
): { matched: boolean; result?: IntentClassificationResult } {
  const userDecisions = Object.values(context.pendingApprovals).filter((request) => isUserDecisionRequest(request));
  if (userDecisions.length === 0) return { matched: false };
  // Expired requests do not count. When all of them have expired, keep them so the gateway refuses the reply with its expiry error.
  const now = Date.now();
  const live = userDecisions.filter((request) => !isExpiredUserDecision(request, now));
  const pending = live.length > 0 ? live : userDecisions;
  const designApprovalPending = Object.values(context.pendingApprovals).some((request) => !isUserDecisionRequest(request));

  const explicitId = extractExplicitId(rawContent, "apr-");
  if (explicitId !== undefined && !pending.some((request) => request.approvalId === explicitId)) {
    // The reply names a non-user approval (design/task); leave it to the approval path.
    return { matched: false };
  }

  const target = pending.length === 1 ? pending[0] : pending.find((request) => request.approvalId === explicitId);
  if (!target) {
    // A design/task approval is also waiting and the reply names no request: it belongs to that approval path.
    if (designApprovalPending) return { matched: false };
    return {
      matched: true,
      result: {
        intent: "conversation_only",
        confidence: 0.9,
        rationale: "Several user decisions are pending; the reply does not identify one.",
        clarifyingQuestions: [],
        directReply: "Hiện có nhiều câu hỏi quyết định đang chờ bạn. Vui lòng nêu rõ mã yêu cầu (apr-...) kèm lựa chọn."
      }
    };
  }

  const targetCorrelationId = context.runIdToCorrelationId[target.runId];
  const common = {
    confidence: 0.96,
    clarifyingQuestions: [] as string[],
    targetRunId: target.runId,
    ...(targetCorrelationId !== undefined ? { targetCorrelationId } : {})
  };
  // A targeted reply ("apr-... 2") answers the named request; strip the id before mapping the answer.
  const answerText = explicitId !== undefined
    ? rawContent.replace(explicitId, "").replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    : rawContent;
  const resolution = resolveUserDecisionReply(target, answerText);
  // While a design/task approval is also pending, only an explicit id or an exact option claims the reply.
  // Anything else (reject words, free text, ambiguous numbers) is left to the approval path.
  const matchesOption = resolution.kind === "answer" && resolution.selectedOption !== undefined;
  if (designApprovalPending && explicitId === undefined && !matchesOption) {
    return { matched: false };
  }
  if (resolution.kind === "ambiguous") {
    return {
      matched: true,
      result: {
        ...common,
        intent: "conversation_only",
        rationale: "User decision reply is ambiguous; re-asking without changing approval state.",
        directReply: resolution.message
      }
    };
  }
  if (resolution.kind === "reject") {
    return {
      matched: true,
      result: {
        ...common,
        intent: "approval_response",
        rationale: "User rejected a specialist decision request.",
        approvalInput: { approvalId: target.approvalId, decision: "rejected", reason: resolution.reason }
      }
    };
  }
  return {
    matched: true,
    result: {
      ...common,
      intent: "approval_response",
      rationale: "User answered a specialist decision request.",
      approvalInput: {
        approvalId: target.approvalId,
        decision: "approved",
        reason: resolution.reason ?? resolution.selectedOption ?? "User answered",
        ...(resolution.selectedOption !== undefined ? { selectedOption: resolution.selectedOption } : {})
      }
    }
  };
}

function detectStatusQuery(
  rawContent: string,
  context: ConversationContextSnapshot
): { matched: boolean; result?: IntentClassificationResult } {
  const norm = normalizeForMatching(rawContent);

  const statusRegex =
    /(?<!\p{L})(?:status|tiến độ|trạng thái|đang làm gì|tới đâu rồi|tiến trình|công việc thế nào|báo cáo tiến độ|tình hình sao rồi|progress|progress update|how is the workflow going|what is the status|what are you doing|current state)(?!\p{L})/iu;

  if (statusRegex.test(norm)) {
    const explicitRunId = extractExplicitId(rawContent, "run-") ?? context.session.activeRunId;
    const explicitCorrelationId =
      extractExplicitId(rawContent, "corr-") ??
      (explicitRunId ? context.runIdToCorrelationId[explicitRunId] : undefined);

    return {
      matched: true,
      result: {
        intent: "status_query",
        confidence: 0.94,
        rationale: "User queried the current status, progress, or blockers of the workflow.",
        clarifyingQuestions: [],
        ...(explicitCorrelationId !== undefined ? { targetCorrelationId: explicitCorrelationId } : {}),
        ...(explicitRunId !== undefined ? { targetRunId: explicitRunId } : {})
      }
    };
  }

  return { matched: false };
}

function detectConversationOnly(
  rawContent: string
): { matched: boolean; result?: IntentClassificationResult } {
  const norm = normalizeForMatching(rawContent);

  // Greetings
  const greetingRegex =
    /^(?:xin chào|chào bạn|chào buổi sáng|chào|hello|hi|hey|alo|good morning|good afternoon|good evening)\b[!\s\p{L}\p{N}_?,.]*$/iu;
  if (greetingRegex.test(norm)) {
    return {
      matched: true,
      result: {
        intent: "conversation_only",
        confidence: 0.95,
        rationale: "User initiated a friendly greeting.",
        clarifyingQuestions: [],
        directReply:
          "Xin chào! Tôi là Conversation Agent (chat) của Bflow. Tôi có thể hỗ trợ bạn tiếp nhận yêu cầu, phân tích phạm vi, theo dõi tiến độ và xử lý phê duyệt. Bạn cần hỗ trợ công việc gì hôm nay?"
      }
    };
  }

  // Capability or identity questions
  const capabilityRegex =
    /(?<!\p{L})(?:bạn là ai|who are you|bạn có thể làm gì|what can you do|cách hoạt động|how do you work|hướng dẫn sử dụng|help me|giúp tôi hiểu bflow)(?!\p{L})/iu;
  if (capabilityRegex.test(norm)) {
    return {
      matched: true,
      result: {
        intent: "conversation_only",
        confidence: 0.92,
        rationale: "User asked about agent identity or capabilities.",
        clarifyingQuestions: [],
        directReply:
          "Tôi là Conversation Agent (chat) - cổng giao tiếp duy nhất giữa bạn và hệ thống đa tác nhân Bflow trong Herdr. Tôi tiếp nhận yêu cầu, làm rõ phạm vi khi cần, chuyển giao cho Coordinator lên kế hoạch (DAG) và theo dõi tiến độ, phê duyệt giúp bạn."
      }
    };
  }

  // Pure informational / conceptual questions not asking for code changes
  const isCodeAction =
    /(?<!\p{L})(?:triển khai|viết|sửa|tạo|build|implement|code|refactor|fix|add|tạo mới|cập nhật|xóa)(?!\p{L})/iu.test(
      norm
    );

  const informationalRegex =
    /(?<!\p{L})(?:giải thích|explain|sự khác nhau giữa|khác biệt giữa|what is the difference between|what is|jwt là gì|kiến trúc của bflow là gì)(?!\p{L})/iu;

  if (informationalRegex.test(norm) && !isCodeAction) {
    return {
      matched: true,
      result: {
        intent: "conversation_only",
        confidence: 0.88,
        rationale: "User asked an informational conceptual question without requesting repository mutations.",
        clarifyingQuestions: [],
        directReply: `Đối với câu hỏi "${rawContent.trim()}": Đây là câu hỏi mang tính chất giải thích/khái niệm. Nếu bạn muốn bắt đầu một tác vụ thực tế trong dự án (ví dụ triển khai hoặc chỉnh sửa code), hãy cho tôi biết phạm vi cụ thể nhé!`
      }
    };
  }

  return { matched: false };
}

function detectActiveRequirementChange(
  input: UserTurnInput,
  context: ConversationContextSnapshot
): { matched: boolean; result?: IntentClassificationResult } {
  const rawContent = input.content ?? "";
  const norm = normalizeForMatching(rawContent);

  // Check if there is an active workflow
  const activeWorkflows = Object.values(context.workflows).filter(
    (w) => w.sdlcStatus !== "completed" && w.sdlcStatus !== "failed" && w.sdlcStatus !== "cancelled"
  );

  if (activeWorkflows.length === 0) {
    return { matched: false };
  }

  const changeRequirementRegex =
    /(?<!\p{L})(?:thay đổi yêu cầu|đổi sang|cập nhật yêu cầu|thêm điều kiện vào tính năng đang chạy|thêm yêu cầu vào workflow|thay đổi scope|change requirement|update the active workflow|modify the requirement|thay vì|chuyển sang dùng)(?!\p{L})/iu;

  if (changeRequirementRegex.test(norm)) {
    // Resolve target active workflow in priority order:
    // 1. Explicit run-... or corr-... mentioned in input.content or input.runId / input.correlationId
    const explicitRunId = input.runId ?? extractExplicitId(rawContent, "run-");
    const explicitCorrId = input.correlationId ?? extractExplicitId(rawContent, "corr-");

    let activeWf: WorkflowRequestContext | undefined;

    if (explicitRunId) {
      activeWf = activeWorkflows.find((w) => w.runId === explicitRunId);
    }
    if (!activeWf && explicitCorrId) {
      activeWf = activeWorkflows.find((w) => w.correlationId === explicitCorrId);
    }

    // 2. Active workflow matching context.session.activeRunId
    if (!activeWf && context.session.activeRunId) {
      activeWf = activeWorkflows.find((w) => w.runId === context.session.activeRunId);
    }

    // 3. Most recently updated active workflow (activeWorkflows[activeWorkflows.length - 1])
    if (!activeWf) {
      activeWf = activeWorkflows[activeWorkflows.length - 1];
    }

    if (!activeWf) {
      return { matched: false };
    }

    const paths = extractFilePaths(rawContent);
    const affectedPaths = paths.length > 0 ? paths : ["packages/app"];

    const draft: ExtractedRequirementDraft = {
      title: `Cập nhật yêu cầu: ${rawContent.slice(0, 50).trim()}`,
      objective: rawContent.trim(),
      kind: activeWf.kind,
      sddLevel: activeWf.sddLevel,
      priority: activeWf.priority,
      scopeDefined: true,
      isLargeTask: false,
      affectedPaths,
      acceptanceCriteriaDescriptions: [
        `Yêu cầu cập nhật từ người dùng: ${rawContent.trim()}`,
        "Đảm bảo tương thích và vượt qua kiểm thử hiện tại"
      ],
      isRequirementChange: true,
      targetRunId: activeWf.runId,
      targetCorrelationId: activeWf.correlationId
    };

    return {
      matched: true,
      result: {
        intent: "workflow_request",
        confidence: 0.92,
        rationale: "User requested a mid-workflow requirement change on active workflow.",
        clarifyingQuestions: [],
        requirementDraft: draft,
        targetCorrelationId: activeWf.correlationId,
        targetRunId: activeWf.runId
      }
    };
  }

  return { matched: false };
}

function resolvePendingClarification(
  rawContent: string,
  context: ConversationContextSnapshot
): IntentClassificationResult | undefined {
  const pendingKeys = Object.keys(context.pendingClarifications);
  const isAwaiting =
    context.session.status === "awaiting_user_clarification" || pendingKeys.length > 0;

  if (!isAwaiting) {
    return undefined;
  }

  const pending =
    (context.session.metadata?.activeCorrelationId
      ? context.pendingClarifications[context.session.metadata.activeCorrelationId.toString()]
      : undefined) ?? Object.values(context.pendingClarifications)[0];

  if (!pending) {
    return undefined;
  }

  const norm = normalizeForMatching(rawContent);

  // If user says "tùy bạn", "idk", "chưa rõ", "sao cũng được", still ambiguous
  const stillAmbiguous =
    /^(?:tùy bạn|sao cũng được|idk|chưa rõ|không biết|whatever|tùy chọn|chưa xác định)$/i.test(
      norm
    );

  if (stillAmbiguous) {
    return {
      intent: "clarify",
      confidence: 0.85,
      rationale:
        "User responded without concrete scope details to pending clarification.",
      clarifyingQuestions: [
        "Vui lòng chỉ định rõ module hoặc thư mục mục tiêu cần thực hiện (ví dụ: packages/auth hoặc src/pricing.ts).",
        "Tiêu chí nghiệm thu cốt lõi bạn mong muốn là gì?"
      ],
      targetCorrelationId: pending.correlationId
    };
  }

  // User provided concrete details to answer clarification
  const combinedText = `${pending.originalRequestText} | Bổ sung: ${rawContent.trim()}`;
  const extractedPaths = extractFilePaths(rawContent);
  const affectedPaths =
    extractedPaths.length > 0
      ? extractedPaths
      : pending.draft.affectedPaths.length > 0
      ? pending.draft.affectedPaths
      : ["packages/app"];

  const draft: ExtractedRequirementDraft = {
    title: pending.draft.title,
    objective: combinedText,
    kind: pending.draft.kind,
    sddLevel: pending.draft.sddLevel,
    priority: pending.draft.priority,
    scopeDefined: true,
    isLargeTask: false,
    affectedPaths,
    acceptanceCriteriaDescriptions: [
      ...pending.draft.acceptanceCriteriaDescriptions,
      `Bổ sung chi tiết: ${rawContent.trim()}`
    ],
    isRequirementChange: false,
    targetCorrelationId: pending.correlationId
  };

  return {
    intent: "workflow_request",
    confidence: 0.9,
    rationale: "Clarification resolved with actionable user scope details.",
    clarifyingQuestions: [],
    requirementDraft: draft,
    targetCorrelationId: pending.correlationId
  };
}

function classifyWorkflowOrClarify(
  rawContent: string
): IntentClassificationResult {
  const norm = normalizeForMatching(rawContent);

  // Large unscoped task indicators
  const veryVaguePatterns = [
    /^(?:thêm tính năng mới|thêm tính năng|sửa lỗi|sửa bug|fix bug|tối ưu hệ thống|làm lại toàn bộ hệ thống|xây dựng hệ thống|refactor toàn bộ project|refactor project|build authentication|cải thiện hiệu năng)$/i,
    /^(?:tạo app|viết ứng dụng|làm website|làm website bán hàng|build full app)$/i
  ];

  const hasVeryVague = veryVaguePatterns.some((pattern) => pattern.test(norm));
  const broadSystemKeywords =
    /(?<!\p{L})(?:toàn bộ|entire system|all modules|hệ thống lớn|kiến trúc mới|toàn bộ project|hệ thống thanh toán)(?!\p{L})/iu.test(
      norm
    );

  const extractedPaths = extractFilePaths(rawContent);
  const hasConcretePaths = extractedPaths.length > 0;
  const isShortWithoutScope = norm.length < 35 && !hasConcretePaths;

  if (hasVeryVague || (broadSystemKeywords && !hasConcretePaths) || (isShortWithoutScope && !norm.includes("tại") && !norm.includes("trong"))) {
    // Large unscoped task -> Ask only for critical information
    return {
      intent: "clarify",
      confidence: 0.91,
      rationale:
        "Large or critically ambiguous request detected. Enforcing prompt rule: 'Không tự ý triển khai tác vụ lớn nếu chưa xác định phạm vi'.",
      clarifyingQuestions: [
        "Phạm vi cụ thể (module, package hoặc các file mục tiêu) mà bạn muốn áp dụng là gì?",
        "Tiêu chí nghiệm thu cốt lõi (acceptance criteria) cần đạt được sau khi hoàn thành là gì?"
      ]
    };
  }

  // Actionable workflow request: extract kind
  let kind: WorkflowRequestKind = "feature";
  if (/(?<!\p{L})(?:sửa lỗi|fix|bug|error|issue|vấn đề|sửa)(?!\p{L})/iu.test(norm)) {
    kind = "bugfix";
  } else if (/(?<!\p{L})(?:refactor|tái cấu trúc|cleanup|tối ưu cấu trúc)(?!\p{L})/iu.test(norm)) {
    kind = "refactor";
  } else if (/(?<!\p{L})(?:spike|thử nghiệm|prototype|khảo sát|benchmark)(?!\p{L})/iu.test(norm)) {
    kind = "spike";
  }

  // SDD Policy level
  let sddLevel: SddPolicyLevel = "lightweight";
  if (
    kind === "feature" ||
    /(?<!\p{L})(?:jwt|auth|security|bảo mật|kiến trúc|database|migration|toàn diện|full)(?!\p{L})/iu.test(norm) ||
    extractedPaths.length > 1
  ) {
    sddLevel = "full";
  }

  // Priority
  let priority: "low" | "normal" | "high" | "critical" = "normal";
  if (/(?<!\p{L})(?:critical|khẩn cấp|urgent|ngay lập tức|blocker|lỗ hổng bảo mật)(?!\p{L})/iu.test(norm)) {
    priority = "critical";
  } else if (/(?<!\p{L})(?:high|ưu tiên cao|quan trọng)(?!\p{L})/iu.test(norm)) {
    priority = "high";
  } else if (/(?<!\p{L})(?:low|ưu tiên thấp|không vội|khi nào rảnh)(?!\p{L})/iu.test(norm)) {
    priority = "low";
  }

  const affectedPaths = extractedPaths.length > 0 ? extractedPaths : ["packages/app"];

  const criteria: string[] = [
    `Triển khai đúng mục tiêu: ${rawContent.trim()}`,
    "Đảm bảo typecheck và các bài test liên quan pass 100%"
  ];

  if (kind === "bugfix") {
    criteria.push("Không gây regression cho các trường hợp biên hiện tại");
  } else if (kind === "feature") {
    criteria.push("Cung cấp đầy đủ unit/integration tests bao phủ logic mới");
  }

  const titlePrefix =
    kind === "bugfix"
      ? "Sửa lỗi: "
      : kind === "refactor"
      ? "Tái cấu trúc: "
      : kind === "spike"
      ? "Thử nghiệm: "
      : "Tính năng: ";

  const draft: ExtractedRequirementDraft = {
    title: `${titlePrefix}${rawContent.slice(0, 60).trim()}`,
    objective: rawContent.trim(),
    kind,
    sddLevel,
    priority,
    scopeDefined: true,
    isLargeTask: false,
    affectedPaths,
    acceptanceCriteriaDescriptions: criteria,
    isRequirementChange: false
  };

  return {
    intent: "workflow_request",
    confidence: 0.92,
    rationale: `Actionable user request classified as "${kind}" with SDD level "${sddLevel}".`,
    clarifyingQuestions: [],
    requirementDraft: draft
  };
}

/**
 * Classifies a user turn into one of the 6 recognized intents deterministically.
 */
export function classifyUserIntent(
  input: UserTurnInput,
  context: ConversationContextSnapshot
): OperationResult<IntentClassificationResult> {
  const content = sanitizeInputText(input.content ?? "");
  if (content.length === 0) {
    return {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: "UserTurnInput content cannot be empty"
      }
    };
  }

  // 1. Cancellation request
  const cancellationCheck = detectCancellation(input, context);
  if (cancellationCheck.matched && cancellationCheck.result) {
    return { ok: true, value: cancellationCheck.result };
  }

  // 2a. Specialist user decision (options are matched strictly; never defaults)
  const userDecisionCheck = detectUserDecision(content, context);
  if (userDecisionCheck.matched && userDecisionCheck.result) {
    return { ok: true, value: userDecisionCheck.result };
  }

  // 2. Approval response
  const approvalCheck = detectApproval(content, context);
  if (approvalCheck.matched && approvalCheck.result) {
    return { ok: true, value: approvalCheck.result };
  }

  // 3. Status query
  const statusCheck = detectStatusQuery(content, context);
  if (statusCheck.matched && statusCheck.result) {
    return { ok: true, value: statusCheck.result };
  }

  // 4. Conversation only (greetings, identity, conceptual info)
  const conversationCheck = detectConversationOnly(content);
  if (conversationCheck.matched && conversationCheck.result) {
    return { ok: true, value: conversationCheck.result };
  }

  // 5. Case A: Resolving pending clarification
  const pendingClarificationResult = resolvePendingClarification(content, context);
  if (pendingClarificationResult) {
    return { ok: true, value: pendingClarificationResult };
  }

  // 6. Case B: Mid-workflow requirement change
  const activeChangeCheck = detectActiveRequirementChange(input, context);
  if (activeChangeCheck.matched && activeChangeCheck.result) {
    return { ok: true, value: activeChangeCheck.result };
  }

  // 7. Case C: New workflow request or ambiguous clarify
  const workflowOrClarify = classifyWorkflowOrClarify(content);
  return { ok: true, value: workflowOrClarify };
}

/**
 * IntentClassifier engine class providing intent detection and delegation analysis.
 */
export class IntentClassifier {
  public classify(
    input: UserTurnInput,
    context: ConversationContextSnapshot
  ): OperationResult<IntentClassificationResult> {
    return classifyUserIntent(input, context);
  }

  public static classifyUserIntent(
    input: UserTurnInput,
    context: ConversationContextSnapshot
  ): OperationResult<IntentClassificationResult> {
    return classifyUserIntent(input, context);
  }
}
