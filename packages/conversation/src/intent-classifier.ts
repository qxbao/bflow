import type {
  ConversationContextSnapshot,
  ExtractedApprovalInput,
  ExtractedRequirementDraft,
  IntentClassificationResult,
  OperationResult,
  SddPolicyLevel,
  UserTurnInput,
  WorkflowRequestContext,
  WorkflowRequestKind
} from "./types.js";
import { newestClarification } from "./clarification-lifecycle.js";
import { isExpiredUserDecision, isUserDecisionRequest, resolveUserDecisionReply } from "./user-decision.js";

const ZERO_WIDTH_STRIP_REGEX = /[\u200B-\u200D\uFEFF\u00AD]/g;

function sanitizeInputText(raw: string): string {
  return raw.replace(ZERO_WIDTH_STRIP_REGEX, "").replace(/<\/?pasted_content\b[^>]*>/gi, "").trim();
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
  const pathRegex = /(?<![\w/])(?:(?:packages|src|apps|tests|test|scripts|lib|components|skills|agents|docs)\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*|[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml))\b/g;
  // A path in an exclusion, example or prohibited default is not affirmative scope.
  const scopedText = text.split(/\n+|;\s*|(?<=[.!?])\s+/u).map(clause =>
    clause.split(/(?<!\p{L})(?:không mặc định|không(?: được)? (?:sửa|thay đổi|dùng)|đừng (?:sửa|dùng)|ngoại trừ|out of scope|do not (?:edit|change|use)|never (?:default|use)|not (?:default|in)|ví dụ|for example)(?!\p{L})/iu)[0] ?? ""
  ).join("\n");
  const matches = scopedText.match(pathRegex);
  if (!matches || matches.length === 0) {
    return [];
  }
  const unique = Array.from(new Set(matches.map((m) => m.trim())));
  return unique;
}

// Commands are recognized outside quotations/examples, never by a keyword buried in data.
function commandText(text: string): string {
  return text.replace(/```[\s\S]*?```|`[^`]*`|"[^"\n]*"|'[^'\n]*'|“[^”]*”|‘[^’]*’/g, match => " ".repeat(match.length));
}

function requestBody(text: string): string {
  return normalizeForMatching(commandText(text)).replace(/^(?:(?:hãy|vui lòng|làm ơn|please|tôi muốn|tôi cần|giúp tôi|bạn hãy|can you|could you|khẩn cấp|ưu tiên cao|khi nào rảnh)\s+)+/u, "");
}

/** Keep investigation-only sections as separate task details, not mutation scope. */
function separateInvestigations(text: string): { changeText: string; investigations: readonly { objective: string; affectedPaths: readonly string[]; codeChangesAuthorized: false }[] } {
  const changeLines: string[] = [];
  const investigationSections: string[] = [];
  let section: string[] | undefined;
  for (const line of text.split(/\n/u)) {
    const heading = line.replace(/^\s*(?:#{1,6}\s*|(?:\d+[.)]|[-*•])\s*)?/, "");
    const isInvestigation = /^(?:spike|khảo sát|điều tra|investigate|research)(?!\p{L})/iu.test(heading);
    const nextTask = /^\s*(?:#{1,6}\s*|\d+[.)]\s*)/.test(line) && !isInvestigation;
    if (section && nextTask) {
      investigationSections.push(section.join("\n"));
      section = undefined;
    }
    if (isInvestigation) {
      if (section) investigationSections.push(section.join("\n"));
      section = [heading];
    } else if (section) section.push(line);
    else changeLines.push(line);
  }
  if (section) investigationSections.push(section.join("\n"));
  return { changeText: changeLines.join("\n"), investigations: investigationSections.map(objective => ({ objective, affectedPaths: extractFilePaths(objective), codeChangesAuthorized: false })) };
}

function hasChangeAuthority(text: string): boolean {
  const changeText = separateInvestigations(text).changeText;
  // Negative acceptance examples and scoped exclusions do not revoke the top-level request.
  const authorityLines = changeText.split(/\n/u).filter(line => !/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).join("\n");
  const authorityText = commandText(authorityLines).replace(
    /(?<!\p{L})(?:(?:chưa|không|đừng)\s+(?:sửa|viết|triển khai|thay đổi)|(?:do not|don't)\s+(?:edit|change|implement))\s+(?=(?:(?:packages|src|apps|tests|test|scripts|lib|components|skills|agents|docs)\/))/giu,
    ""
  );
  return /^(?:bugfix|triển khai|viết|sửa|tạo|xây dựng|thêm|cập nhật|xóa|tối ưu|tái cấu trúc|build|implement|refactor|fix|add|update|remove|delete|change requirement|thay đổi yêu cầu)(?!\p{L})/iu.test(requestBody(changeText)) &&
    !/(?:chưa|không|đừng)\s+(?:sửa|viết|triển khai|thay đổi)|(?:do not|don't)\s+(?:edit|change|implement)/iu.test(authorityText);
}

function clarification(question: string): IntentClassificationResult {
  return { intent: "clarify", confidence: 0.9, rationale: "Explicit scope or target is needed before side effects.", clarifyingQuestions: [question] };
}

function detectCancellation(
  input: UserTurnInput,
  context: ConversationContextSnapshot
): { matched: boolean; result?: IntentClassificationResult } {
  const raw = sanitizeInputText(input.content);
  // Split at command boundaries only. Keep acceptance lists and quoted punctuation intact.
  const masked = commandText(raw);
  const boundary = /[;\n]+|[.!?]\s+|\s+(?:và|rồi|sau đó|and|then)\s+(?=(?:hãy\s+)?(?:sửa|triển khai|thêm|tạo|fix|implement|add|hủy|cancel|stop|abort)\b)/giu;
  const spans: string[] = [];
  let start = 0;
  for (const match of masked.matchAll(boundary)) {
    spans.push(raw.slice(start, match.index).trim());
    start = match.index + match[0].length;
  }
  spans.push(raw.slice(start).trim());
  const cancelCommand = /^(?:cancel|stop|abort|terminate|kill|hủy(?: bỏ)?|dừng|ngừng)(?!\p{L})/iu;
  const cancelIndex = spans.findIndex(part => cancelCommand.test(requestBody(part)));
  if (cancelIndex < 0 || /(?:ví dụ|example|e\.g\.)\s*(?:như sau)?\s*:/iu.test(masked.slice(0, masked.indexOf(spans[cancelIndex]!)))) return { matched: false };
  const command = spans[cancelIndex]!;
  const ids = [...new Set(command.match(/\brun-[a-zA-Z0-9_-]+\b/g) ?? [])];
  const workflows = Object.values(context.workflows).filter(w => !["completed", "failed", "cancelled"].includes(w.sdlcStatus));
  let runId: string | undefined;
  if (ids.length === 1) runId = ids[0];
  else if (ids.length > 1) return { matched: true, result: clarification("Vui lòng xác nhận từng runId cần hủy; chưa hủy run nào.") };
  else {
    const description = requestBody(command).replace(cancelCommand, "").replace(/(?<!\p{L})(?:đang chạy|hiện tại|workflow|run|task|yêu cầu|chạy|the|active|current)(?!\p{L})/giu, " ").trim();
    if (!description) runId = input.runId ?? context.session.activeRunId;
    else {
      const old = /^(?:cũ|trước|trước đó|old|previous)$/iu.test(description);
      const candidates = old ? workflows.filter(w => w.runId !== context.session.activeRunId) :
        workflows.filter(w => normalizeForMatching(w.title).includes(description));
      if (candidates.length === 1) runId = candidates[0]!.runId;
    }
  }
  const target = workflows.find(w => w.runId === runId);
  if (!target) return { matched: true, result: clarification("Bạn muốn hủy workflow nào? Vui lòng cung cấp runId chính xác; chưa hủy run nào.") };
  if (cancelIndex > 0) {
    const preceding = spans.slice(0, cancelIndex).filter(Boolean).join("; ");
    if (!hasChangeAuthority(preceding)) return { matched: true, result: clarification("Vui lòng nêu rõ yêu cầu cần xử lý trước khi hủy workflow.") };
    const primary = classifyWorkflowOrClarify(preceding);
    if (primary.intent !== "workflow_request") return { matched: true, result: primary };
    return { matched: true, result: { ...primary, followUpContents: [spans.slice(cancelIndex).join("; ")] } };
  }
  const remaining = spans.slice(1).filter(Boolean).join("; ");
  return { matched: true, result: {
    intent: "cancellation_request", confidence: 0.95, rationale: "An explicit cancellation command resolved to one known workflow.", clarifyingQuestions: [],
    cancellationInput: { runId: target.runId, reason: command, ...(extractExplicitId(command, "task-") ? { taskId: extractExplicitId(command, "task-")! } : {}) },
    targetRunId: target.runId, targetCorrelationId: target.correlationId,
    ...(remaining ? { followUpContents: [remaining] } : {})
  } };
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

  // An id-less reply names an approval only when exactly one is pending; with several it stays
  // unnamed so the Gateway asks which one instead of deciding the first.
  const pendingIds = [...new Set([...pendingApprovalKeys, ...activeApprovalIds])];
  const explicitId =
    extractExplicitId(rawContent, "apr-") ??
    (pendingIds.length === 1 ? pendingIds[0] : undefined);

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

function optionLabelsOf(request: { readonly metadata?: unknown }): readonly string[] | undefined {
  const options = (request.metadata as Record<string, unknown> | undefined)?.["options"];
  if (!Array.isArray(options)) return undefined;
  return options.filter((option): option is string => typeof option === "string");
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

  // A plain status question is routed to the status report (which re-renders the pending decision in
  // full), not treated as an answer or re-asked. An exact option label still counts as the answer.
  const answerCandidate = explicitId !== undefined
    ? rawContent.replace(explicitId, "").replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    : rawContent;
  const matchesExactOption = pending.some((request) =>
    (optionLabelsOf(request) ?? []).some((option) => normalizeForMatching(option) === normalizeForMatching(answerCandidate)));
  if (!matchesExactOption && isClearStatusQuestion(answerCandidate)) {
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
  const resolution = resolveUserDecisionReply(target, answerCandidate);
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

const STATUS_KEYWORD_REGEX =
  /(?<!\p{L})(?:status|tiến độ|trạng thái|đang làm gì|tới đâu rồi|tiến trình|công việc thế nào|báo cáo tiến độ|tình hình sao rồi|progress|progress update|how is the workflow going|what is the status|what are you doing|current state)(?!\p{L})/iu;

/**
 * True for a plain status question ("trạng thái", "tiến độ thế nào?", "cho tôi xem tiến độ").
 * Such a reply is a question, never an answer to a pending decision, even when a decision is open.
 */
function isClearStatusQuestion(text: string): boolean {
  const norm = normalizeForMatching(text);
  if (!STATUS_KEYWORD_REGEX.test(norm)) return false;
  if (hasChangeAuthority(text)) return false;
  const words = norm.split(/\s+/).filter((word) => word.length > 0).length;
  return norm.endsWith("?") ||
    words <= 4 ||
    /^(?:cho (?:tôi|mình|em|anh|chị)|xem|báo cáo|kiểm tra|cập nhật|tóm tắt)(?!\p{L})/iu.test(norm) ||
    /(?:thế nào|ra sao|sao rồi|tới đâu|đến đâu|như thế nào|bao nhiêu|hiện tại|bây giờ)(?!\p{L})/iu.test(norm);
}

function detectStatusQuery(
  rawContent: string,
  context: ConversationContextSnapshot
): { matched: boolean; result?: IntentClassificationResult } {
  const norm = normalizeForMatching(rawContent);

  if (STATUS_KEYWORD_REGEX.test(norm)) {
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
  const rawContent = sanitizeInputText(input.content ?? "");
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
    const explicitRunId = extractExplicitId(rawContent, "run-") ?? input.runId;
    const explicitCorrId = extractExplicitId(rawContent, "corr-") ?? input.correlationId;

    let activeWf: WorkflowRequestContext | undefined;

    if (explicitRunId) {
      activeWf = activeWorkflows.find((w) => w.runId === explicitRunId);
    }
    if (explicitRunId && !activeWf) {
      return { matched: true, result: clarification("Không tìm thấy runId được chỉ định. Vui lòng xác nhận mục tiêu.") };
    }
    if (!activeWf && explicitCorrId) {
      activeWf = activeWorkflows.find((w) => w.correlationId === explicitCorrId);
    }

    if ((explicitRunId || explicitCorrId) && !activeWf) return { matched: true, result: clarification("Không tìm thấy workflow được chỉ định. Vui lòng xác nhận runId.") };

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
    const affectedPaths = paths.length > 0 ? paths : extractFilePaths(activeWf.objective);
    if (affectedPaths.length === 0) return { matched: true, result: clarification("Vui lòng xác định đường dẫn bị ảnh hưởng của yêu cầu thay đổi.") };

    const draft: ExtractedRequirementDraft = {
      title: `Cập nhật yêu cầu: ${rawContent.slice(0, 50).trim()}`,
      objective: rawContent.trim(),
      kind: activeWf.kind,
      sddLevel: /\bfull\b/iu.test(norm) ? "full" : activeWf.sddLevel,
      priority: activeWf.priority,
      scopeDefined: true,
      isLargeTask: false,
      affectedPaths,
      acceptanceCriteriaDescriptions: rawContent.split(/;\s*|\n+/).map(line => line.replace(/^[-*•]\s+/, "").trim()).filter(Boolean),
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
  input: UserTurnInput,
  context: ConversationContextSnapshot
): IntentClassificationResult | undefined {
  const content = sanitizeInputText(input.content);
  // Without a correlation id the reply can only answer the newest open clarification, never an older one.
  const pending = input.correlationId ? context.pendingClarifications[input.correlationId] : newestClarification(context.pendingClarifications);
  if (!pending) return undefined;
  if (!hasChangeAuthority(pending.originalRequestText)) return undefined;
  // A fresh imperative is a new request. Only a correlated reply or explicit scope answer
  // continues the old request; choices without a defined option mapping confer no authority.
  if (hasChangeAuthority(content)) return undefined;
  const paths = extractFilePaths(content);
  const isScopeAnswer = /^(?:phạm vi|scope|module|package|trong|tại|in |within )/iu.test(content);
  if ((!isScopeAnswer && input.correlationId !== pending.correlationId) || paths.length === 0 || content.length < 20) {
    return { ...clarification("Vui lòng nêu phạm vi và kết quả mong muốn, hoặc gửi một yêu cầu mới đầy đủ."), requirementDraft: pending.draft, targetCorrelationId: pending.correlationId };
  }
  const combined = `${sanitizeInputText(pending.originalRequestText)}\n${content}`;
  const result = classifyWorkflowOrClarify(combined);
  if (!result.requirementDraft) return { ...result, targetCorrelationId: pending.correlationId };
  return { ...result, requirementDraft: { ...result.requirementDraft, title: pending.draft.title,
    sddLevel: pending.draft.sddLevel === "full" ? "full" : result.requirementDraft.sddLevel,
    targetCorrelationId: pending.correlationId }, targetCorrelationId: pending.correlationId };
}

function classifyWorkflowOrClarify(
  rawContent: string
): IntentClassificationResult {
  const norm = normalizeForMatching(rawContent);

  const { changeText, investigations } = separateInvestigations(rawContent);
  const extractedPaths = extractFilePaths(changeText.trim() ? changeText : rawContent);
  if (extractedPaths.length === 0) {
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
  if (/(?<!\p{L})(?:sửa lỗi|bugfix|fix|bug|error|issue|vấn đề|sửa)(?!\p{L})/iu.test(norm)) {
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

  const affectedPaths = extractedPaths;

  // Preserve individual supplied cases. A single prose request remains one criterion;
  // never manufacture a generic test/typecheck criterion as a substitute for user intent.
  const cases = changeText.split(/\n+/).map(line => line.trim()).filter(line => /^(?:[-*•]|\d+[.)])\s+/.test(line))
    .map(line => line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim());
  const criteria = cases.length > 0 ? cases : changeText.split(/;\s*|\n+/).map(line => line.trim()).filter(Boolean);

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
    isRequirementChange: false,
    ...(investigations.length > 0 ? { investigationTasks: investigations } : {})
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

  // Preserve exact specialist options and user-decision authority before generic language routing.
  if (!/^(?:cancel|stop|abort|hủy|dừng|ngừng)(?!\p{L})/iu.test(requestBody(content))) {
    const userDecisionCheck = detectUserDecision(content, context);
    if (userDecisionCheck.matched && userDecisionCheck.result) {
      return { ok: true, value: userDecisionCheck.result };
    }
  }

  // Informational/drafting language cannot authorize a mutation even when it quotes commands.
  const body = requestBody(content);
  const drafting = /^(?:soạn|draft|compose|prepare|viết(?: sẵn)?)\s+(?:(?:sẵn|a|the|một)\s+)?(?:prompt|câu lệnh|tin nhắn|message)/iu.test(body);
  const investigating = /^(?:spike|khảo sát|điều tra|phân tích|investigate|research|thử nghiệm|benchmark)(?!\p{L})/iu.test(body);
  const informational = /^(?:giải thích|explain|bạn có những|bạn có các|what|which|how|why|liệt kê|list|show me)(?!\p{L})/iu.test(body);
  if (drafting || investigating || (informational && !detectStatusQuery(content, context).matched)) {
    const draft = investigating ? classifyWorkflowOrClarify(content).requirementDraft : undefined;
    return { ok: true, value: { intent: "conversation_only", confidence: 0.95, rationale: "Conversation or investigation request carries no implementation authority.", clarifyingQuestions: [],
      directReply: investigating ? `Ghi nhận yêu cầu khảo sát: ${content}. Chưa có yêu cầu triển khai mã nguồn.` : `Yêu cầu hội thoại/khái niệm: ${content}`,
      ...(draft ? { requirementDraft: { ...draft, kind: "spike" } } : {}) } };
  }

  // 1. Cancellation request
  const cancellationCheck = detectCancellation({ ...input, content }, context);
  if (cancellationCheck.matched && cancellationCheck.result) {
    return { ok: true, value: cancellationCheck.result };
  }

  // 2. Approval response
  const approvalCheck = hasChangeAuthority(content) ? { matched: false } : detectApproval(content, context);
  if (approvalCheck.matched && approvalCheck.result) {
    return { ok: true, value: approvalCheck.result };
  }

  // 3. Status query
  const statusCheck = hasChangeAuthority(content) ? { matched: false } : detectStatusQuery(content, context);
  if (statusCheck.matched && statusCheck.result) {
    return { ok: true, value: statusCheck.result };
  }

  // 4. Conversation only (greetings, identity, conceptual info)
  const conversationCheck = detectConversationOnly(content);
  if (conversationCheck.matched && conversationCheck.result) {
    return { ok: true, value: conversationCheck.result };
  }

  // 5. Case A: Resolving pending clarification
  const pendingClarificationResult = resolvePendingClarification({ ...input, content }, context);
  if (pendingClarificationResult) {
    return { ok: true, value: pendingClarificationResult };
  }

  // 6. Case B: Mid-workflow requirement change
  const activeChangeCheck = hasChangeAuthority(content) ? detectActiveRequirementChange({ ...input, content }, context) : { matched: false };
  if (activeChangeCheck.matched && activeChangeCheck.result) {
    return { ok: true, value: activeChangeCheck.result };
  }

  if (!hasChangeAuthority(content) && Object.keys(context.pendingApprovals).length > 0) return { ok: true, value: clarification("Vui lòng nêu quyết định phê duyệt hoặc lựa chọn chính xác.") };

  if (!hasChangeAuthority(content)) return { ok: true, value: {
    intent: "conversation_only", confidence: 0.8, rationale: "No affirmative implementation request detected.", clarifyingQuestions: [],
    directReply: "Vui lòng nêu yêu cầu hoặc lựa chọn đầy đủ; tôi chưa khởi tạo workflow mới."
  } };

  // 7. Case C: New workflow request or ambiguous clarify
  const workflowOrClarify = classifyWorkflowOrClarify(content);
  return { ok: true, value: workflowOrClarify };
}

/**
 * The physical-user hook may commit governance replies, never ordinary intent.
 * Incidental approval words in a new request are not human approval evidence.
 */
export function classifyTrustedApprovalReply(
  input: UserTurnInput,
  context: ConversationContextSnapshot
): OperationResult<IntentClassificationResult> | undefined {
  if (Object.keys(context.pendingApprovals).length === 0) return undefined;
  const classified = classifyUserIntent(input, context);
  if (!classified.ok || classified.value.intent !== "approval_response") return undefined;
  const approval = classified.value.approvalInput;
  if (approval?.selectedOption !== undefined) {
    // A numeric prefix plus prose can change requirements, rather than answer this question.
    // Leave its meaning to Chat; the hook may consume only a complete selector or an exact offered label.
    if (!approval.approvalId) return undefined;
    const request = context.pendingApprovals[approval.approvalId];
    const answer = normalizeForMatching(approval.reason ?? "");
    const exactNumber = /^(?:(?:chọn|lựa chọn|option|choose)\s*)?\d{1,2}\s*[.)]?$/iu.test(answer);
    const exactLabel = request && (optionLabelsOf(request) ?? []).some(label =>
      normalizeForMatching(label).replace(/[.!?]+$/u, "") === answer.replace(/[.!?]+$/u, ""));
    return exactNumber || exactLabel ? classified : undefined;
  }
  const content = normalizeForMatching(input.content);
  const namedId = extractExplicitId(sanitizeInputText(input.content), "apr-");
  const namedRequest = namedId ? context.pendingApprovals[namedId] : undefined;
  // Never let an unrecognized id fall back to a different pending approval.
  if (namedId && !namedRequest) return undefined;
  const normalizedId = namedId?.toLowerCase();
  const namesPendingRequest = normalizedId !== undefined && content.startsWith(normalizedId);
  const endsWithPendingRequest = normalizedId !== undefined && content.endsWith(normalizedId);
  const reply = (namesPendingRequest ? content.slice(normalizedId!.length) :
    endsWithPendingRequest ? content.slice(0, -normalizedId!.length) : content).replace(/^[\s:,-]+|[\s:,.!?-]+$/gu, "");

  // A keyword prefix is not approval evidence: “đồng ý rằng ...” and “cần sửa lỗi ...”
  // may be ordinary discussion or a new request. Bare replies must be complete commands.
  const completeDecision = /^(?:(?:tôi|i)\s+)?(?:approve(?:d)?|lgtm|phê duyệt|đồng ý(?: duyệt)?|duyệt|chấp thuận|chấp nhận|ok duyệt|xác nhận duyệt|reject(?:ed)?|decline|từ chối|không đồng ý|không duyệt|bác bỏ|request changes|changes requested|changes_requested|cần sửa|yêu cầu chỉnh sửa|chỉnh sửa lại|cần thay đổi)$/iu.test(reply);
  const targetedReason = (namesPendingRequest || endsWithPendingRequest) &&
    /^(?:(?:tôi|i)\s+)?(?:reject(?:ed)?|decline|từ chối|không đồng ý|không duyệt|bác bỏ|request changes|changes requested|changes_requested|cần sửa|yêu cầu chỉnh sửa|chỉnh sửa lại|cần thay đổi)(?!\p{L})/iu.test(reply);
  const targetedSpecialistAnswer = namesPendingRequest && namedRequest !== undefined && isUserDecisionRequest(namedRequest);
  const pendingDesigns = Object.values(context.pendingApprovals).filter(request => !isUserDecisionRequest(request));
  const unambiguousTarget = namedRequest !== undefined || pendingDesigns.length === 1 || Object.keys(context.pendingApprovals).length === 1;
  return (completeDecision || targetedReason || targetedSpecialistAnswer) && unambiguousTarget ? classified : undefined;
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
