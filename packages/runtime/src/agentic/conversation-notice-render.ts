import { z } from "zod";

/**
 * Pure rendering of durable Conversation notices into the Vietnamese text the user must see.
 * Notice text is data: it is rendered for display and identification only, never used as authority.
 */

/** Bounded structured fields of a user decision request, stored beside the notice summary so truncation cannot hide the question. */
export const UserDecisionNoticeSchema = z.object({
  approvalId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200).optional(),
  requestedByRole: z.string().min(1).max(64).optional(),
  question: z.string().min(1).max(2000),
  options: z.array(z.string().min(1).max(500)).max(10).optional(),
  expiresAt: z.string().min(1).max(64).optional()
}).strict();
export type UserDecisionNotice = z.infer<typeof UserDecisionNoticeSchema>;

/** Bounded structured fields of a non-decision approval (design, task, gate, ...), so truncation cannot hide what is approved. */
export const ApprovalNoticeSchema = z.object({
  approvalId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200).optional(),
  target: z.string().min(1).max(300),
  reason: z.string().min(1).max(2000),
  requestedBy: z.string().min(1).max(200),
  expiresAt: z.string().min(1).max(64).optional(),
  evidence: z.array(z.object({ kind: z.string().min(1).max(64), uri: z.string().min(1).max(300) }).strict()).max(10),
  evidenceCount: z.number().int().nonnegative()
}).strict();
export type ApprovalNotice = z.infer<typeof ApprovalNoticeSchema>;

/** Structural input: a stored ConversationNotice, or a partial notice from a host reply. Never throws. */
export interface NoticeLike {
  messageId: string;
  type?: string | undefined;
  senderRole?: string | undefined;
  runId?: string | undefined;
  summary?: string | undefined;
  truncated?: boolean | undefined;
  /** Preferred over the summary when present and valid. Receipts written before this field existed simply lack it. */
  userDecision?: unknown;
  /** Structured fields of a non-decision approval, when stored. */
  approval?: unknown;
}

export type RenderedNoticeKind = "user_decision" | "approval" | "blocked" | "update";

export interface RenderedNotice {
  messageId: string;
  kind: RenderedNoticeKind;
  runId?: string;
  approvalId?: string;
  requestedByRole?: string | undefined;
  question?: string | undefined;
  options?: { number: number; text: string }[];
  expiresAt?: string;
  /** Identity the displayed-acknowledgement check looks for in the Conversation transcript. */
  ackToken?: string;
  headline: string;
  reply?: string;
  display: string;
}

const APPROVAL_PAYLOAD = z.object({
  approvalId: z.string().min(1),
  runId: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
  // Design and task approvals carry no kind; only user decisions are marked.
  metadata: z.object({
    kind: z.string().optional(),
    question: z.string().min(1).optional(),
    requestedByRole: z.string().min(1).optional(),
    options: z.array(z.string()).optional()
  }).passthrough().optional()
}).passthrough();

/** Kinds that name a run which cannot progress without the user. Runtime-authored failures carry `blockageReason` instead of `reason`. */
const BLOCKED_KINDS = ["workflow_blocked", "run_stalled", "workflow_rejected", "delivery_failure", "coordinator_no_response",
  "developer_no_response", "specialist_no_response", "verification_stuck"] as const;
const BLOCKED_PAYLOAD = z.object({
  kind: z.enum(BLOCKED_KINDS),
  reason: z.string().min(1),
  options: z.array(z.string()).optional(),
  runId: z.string().min(1).optional()
}).passthrough();

const BLOCKED_LABEL: Record<(typeof BLOCKED_KINDS)[number], string> = {
  workflow_blocked: "workflow bị chặn",
  run_stalled: "run bị treo",
  workflow_rejected: "workflow bị từ chối",
  delivery_failure: "gửi tin nhắn thất bại",
  coordinator_no_response: "Coordinator không phản hồi",
  developer_no_response: "Developer không phản hồi",
  specialist_no_response: "vai trò chuyên môn không phản hồi",
  verification_stuck: "xác minh bị kẹt"
};

/**
 * Structured decision fields for an approval.request payload, clipped to the receipt bounds.
 * Undefined for anything that is not a user decision. The approval id is never clipped: a clipped id is a different id.
 */
export function userDecisionNoticeFields(payload: unknown): UserDecisionNotice | undefined {
  const parsed = APPROVAL_PAYLOAD.safeParse(payload);
  const metadata = parsed.success ? parsed.data.metadata : undefined;
  if (!parsed.success || metadata?.kind !== "user_decision" || metadata.question === undefined) return undefined;
  const fields = UserDecisionNoticeSchema.safeParse({
    approvalId: parsed.data.approvalId,
    ...(parsed.data.runId === undefined ? {} : { runId: parsed.data.runId }),
    ...(metadata.requestedByRole === undefined ? {} : { requestedByRole: metadata.requestedByRole.slice(0, 64) }),
    question: metadata.question.slice(0, 2000),
    ...(metadata.options === undefined ? {} : { options: metadata.options.filter(option => option.length > 0).slice(0, 10).map(option => option.slice(0, 500)) }),
    ...(parsed.data.expiresAt === undefined ? {} : { expiresAt: parsed.data.expiresAt.slice(0, 64) })
  });
  return fields.success ? fields.data : undefined;
}

/** Notices a user must see verbatim: a missed decision or block is a lost user action. */
export function isUserFacingNotice(notice: RenderedNotice): boolean {
  return notice.kind === "user_decision" || notice.kind === "approval" || notice.kind === "blocked";
}

/** Display priority: user decisions, then blocks, then everything else. */
export function noticePriority(notice: RenderedNotice): number {
  return notice.kind === "user_decision" ? 0 : notice.kind === "blocked" ? 1 : 2;
}

function parseSummary(notice: NoticeLike): unknown {
  if (notice.summary === undefined || notice.truncated === true) return undefined;
  try { return JSON.parse(notice.summary) as unknown; } catch { return undefined; }
}

function capitalise(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }

/** Structured fields of a non-decision approval.request payload, clipped to the receipt bounds. Undefined for user decisions. */
export function approvalNoticeFields(payload: unknown): ApprovalNotice | undefined {
  const parsed = APPROVAL_PAYLOAD.safeParse(payload);
  if (!parsed.success || parsed.data.metadata?.kind === "user_decision") return undefined;
  const raw = parsed.data as Record<string, unknown>;
  const target = raw.target && typeof raw.target === "object" && !Array.isArray(raw.target) ? raw.target as Record<string, unknown> : {};
  const targetLabel = [String(target.type ?? "run"), ...Object.entries(target).filter(([key]) => key !== "type").map(([, value]) => String(value))].join(" ");
  const evidence = Array.isArray(raw.evidence) ? raw.evidence as unknown[] : [];
  const references = evidence.flatMap(item => {
    const value = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
    return typeof value?.kind === "string" && typeof value.uri === "string" ? [{ kind: value.kind.slice(0, 64), uri: value.uri.slice(0, 300) }] : [];
  });
  const fields = ApprovalNoticeSchema.safeParse({
    approvalId: parsed.data.approvalId,
    ...(parsed.data.runId === undefined ? {} : { runId: parsed.data.runId }),
    target: targetLabel.slice(0, 300),
    reason: typeof raw.reason === "string" && raw.reason ? raw.reason.slice(0, 2000) : "Không có lý do được ghi",
    requestedBy: typeof raw.requestedBy === "string" && raw.requestedBy ? raw.requestedBy.slice(0, 200) : "runtime",
    ...(parsed.data.expiresAt === undefined ? {} : { expiresAt: parsed.data.expiresAt.slice(0, 64) }),
    evidence: references.slice(0, 10), evidenceCount: references.length
  });
  return fields.success ? fields.data : undefined;
}

function updateNotice(notice: NoticeLike): RenderedNotice {
  const type = notice.type ?? "notice", sender = notice.senderRole ?? "runtime";
  const truncated = notice.truncated === true;
  // A Runtime progress message says why it matters in blockageReason (or headline); show that instead of only the type.
  const payload = type === "conversation.progress" ? parseSummary(notice) : undefined;
  const text = payload && typeof payload === "object" && !Array.isArray(payload)
    ? [(payload as Record<string, unknown>).blockageReason, (payload as Record<string, unknown>).headline].find(value => typeof value === "string" && value.length > 0) as string | undefined
    : undefined;
  const headline = `ℹ️ Cập nhật từ ${sender} (${type})${notice.runId ? ` · run ${notice.runId}` : ""}${text ? `: ${text}` : ""}`;
  const note = truncated ? " — nội dung bị cắt ngắn, không hiển thị đầy đủ" : "";
  return { messageId: notice.messageId, kind: "update", ...(notice.runId ? { runId: notice.runId } : {}), headline,
    display: `${headline}${note}` };
}

function decisionNotice(notice: NoticeLike, fields: UserDecisionNotice): RenderedNotice {
  const runPart = fields.runId ? ` (run ${fields.runId})` : "";
  const role = fields.requestedByRole ? capitalise(fields.requestedByRole) : "Một vai trò";
  const options = (fields.options ?? []).map((text, index) => ({ number: index + 1, text }));
  const headline = `🔔 [${fields.approvalId}] ${role} cần bạn quyết định${runPart}:`;
  const reply = `Trả lời: ${fields.approvalId}: ${options.length ? "<số lựa chọn>" : "<nội dung trả lời>"}`;
  const hanLine = `Hạn: ${fields.expiresAt ?? "Không có hạn — đang chờ bạn trả lời"}`;
  const lines = [headline, fields.question, ...options.map(option => `${option.number}. ${option.text}`), hanLine, reply];
  return { messageId: notice.messageId, kind: "user_decision", approvalId: fields.approvalId, ackToken: fields.approvalId,
    ...(fields.runId ? { runId: fields.runId } : {}), requestedByRole: fields.requestedByRole, question: fields.question,
    options, ...(fields.expiresAt ? { expiresAt: fields.expiresAt } : {}), headline, reply, display: lines.join("\n") };
}

/** Full content of a design/task/gate approval: what is approved, why, by whom, on what evidence, and the numbered choices. */
function approvalContent(notice: NoticeLike, fields: ApprovalNotice): RenderedNotice {
  const runPart = fields.runId ? ` (run ${fields.runId})` : "";
  const options = [`${fields.approvalId}: approve`, `${fields.approvalId}: reject <lý do>`].map((text, index) => ({ number: index + 1, text }));
  const headline = `🔔 [${fields.approvalId}] Yêu cầu phê duyệt${runPart}:`;
  const evidence = fields.evidence.map(item => `${item.kind} ${item.uri}`).join("; ");
  const evidenceLine = `Bằng chứng: ${fields.evidenceCount ? `${fields.evidenceCount} artifact${evidence ? ` — ${evidence}` : ""}` : "không có"}`;
  const lines = [headline, `Đối tượng: ${fields.target}`, `Lý do: ${fields.reason}`, `Người yêu cầu: ${fields.requestedBy}`, evidenceLine,
    `Hạn: ${fields.expiresAt ?? "Không có hạn — đang chờ bạn trả lời"}`, ...options.map(option => `${option.number}. ${option.text}`),
    `Trả lời: <số lựa chọn> hoặc "${fields.approvalId}: approve" / "${fields.approvalId}: reject <lý do>"`];
  return { messageId: notice.messageId, kind: "approval", approvalId: fields.approvalId, ackToken: fields.approvalId,
    ...(fields.runId ? { runId: fields.runId } : {}), headline, reply: lines[lines.length - 1]!, options, ...(fields.expiresAt ? { expiresAt: fields.expiresAt } : {}),
    display: lines.join("\n") };
}

function approvalNotice(notice: NoticeLike, payload: z.infer<typeof APPROVAL_PAYLOAD>): RenderedNotice | undefined {
  const metadata = payload.metadata;
  if (metadata?.kind === "user_decision" && metadata.question !== undefined) {
    return decisionNotice(notice, { approvalId: payload.approvalId, ...(payload.runId ? { runId: payload.runId } : {}),
      ...(metadata.requestedByRole ? { requestedByRole: metadata.requestedByRole } : {}), question: metadata.question,
      ...(metadata.options ? { options: metadata.options } : {}), ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}) });
  }
  const fields = approvalNoticeFields(payload);
  return fields === undefined ? undefined : approvalContent(notice, fields);
}

function blockedNotice(notice: NoticeLike, payload: z.infer<typeof BLOCKED_PAYLOAD>): RenderedNotice {
  const runId = payload.runId ?? notice.runId;
  const options = (payload.options ?? []).map((text, index) => ({ number: index + 1, text }));
  const headline = `⚠️ [${notice.messageId}] ${capitalise(BLOCKED_LABEL[payload.kind])}${runId ? ` (run ${runId})` : ""}: ${payload.reason}`;
  const reply = options.length ? "Trả lời: <số lựa chọn>, hoặc nêu rõ cách xử lý" : "Hãy cho Conversation biết cách xử lý";
  return { messageId: notice.messageId, kind: "blocked", ...(runId ? { runId } : {}), ackToken: notice.messageId, headline, reply,
    options, display: [headline, ...options.map(option => `${option.number}. ${option.text}`), reply].join("\n") };
}

/** Blocked payload with its reason: Runtime-authored failures use blockageReason (or headline) instead of reason. */
function blockedPayload(raw: unknown): z.infer<typeof BLOCKED_PAYLOAD> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.kind !== "string" || !(BLOCKED_KINDS as readonly string[]).includes(value.kind)) return undefined;
  const reason = [value.reason, value.blockageReason, value.headline].find(item => typeof item === "string" && item.length > 0);
  const parsed = BLOCKED_PAYLOAD.safeParse({ ...value, reason });
  return parsed.success ? parsed.data : undefined;
}

/** Renders one notice. Anything unparseable or truncated degrades to a generic update that says so. */
export function renderConversationNotice(notice: NoticeLike): RenderedNotice {
  const structured = notice.userDecision === undefined ? undefined : UserDecisionNoticeSchema.safeParse(notice.userDecision);
  if (structured?.success) return decisionNotice(notice, structured.data);
  const approvalFields = notice.approval === undefined ? undefined : ApprovalNoticeSchema.safeParse(notice.approval);
  if (approvalFields?.success) return approvalContent(notice, approvalFields.data);
  if (notice.type === "approval.request") {
    const approval = APPROVAL_PAYLOAD.safeParse(parseSummary(notice));
    const rendered = approval.success ? approvalNotice(notice, approval.data) : undefined;
    if (rendered) return rendered;
  }
  const blocked = blockedPayload(parseSummary(notice));
  if (blocked) return blockedNotice(notice, blocked);
  return updateNotice(notice);
}

/** Notification text: the whole display when it fits, otherwise headline, clipped question and the reply line. */
export function notificationBody(notice: RenderedNotice, max = 400): string {
  if (notice.display.length <= max) return notice.display;
  const reply = notice.reply ?? "";
  const head = notice.headline;
  const room = max - head.length - reply.length - 4;
  const question = (notice.question ?? "").slice(0, Math.max(0, room));
  return [head, ...(question ? [question] : []), ...(reply ? [reply] : [])].join("\n").slice(0, max);
}

/** The MUST SHOW block placed first in hook output. Empty when there is nothing to show. */
export function mustShowSection(notices: readonly NoticeLike[]): string {
  const rendered = notices.map(renderConversationNotice).sort((a, b) => noticePriority(a) - noticePriority(b));
  if (!rendered.length) return "";
  return "MUST SHOW TO USER VERBATIM:\n" + rendered.map(notice => notice.display).join("\n\n") + "\n\n";
}

/** A genuine user prompt: a string, or a user entry with a text block. Tool results are user-role entries without text. */
function isGenuineUserPrompt(content: unknown): boolean {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some(block => typeof block === "object" && block !== null &&
    (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string");
}

/** Text blocks of one assistant entry, in order. Never mutates the parsed content. */
function assistantTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap(block => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []);
}

/**
 * Assistant text of the final assistant turn in a Claude JSONL transcript tail: everything after the last genuine user prompt.
 * Tool-result entries (user role, no text) and malformed lines, such as a partial first line of a tail read, are skipped.
 */
export function lastAssistantText(jsonl: string): string {
  const lines = jsonl.split("\n"), reversed: string[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry !== "object" || entry === null) continue;
    const type = (entry as { type?: unknown }).type;
    const content = ((entry as { message?: { content?: unknown } }).message)?.content;
    if (type === "user") { if (isGenuineUserPrompt(content)) break; continue; }
    if (type !== "assistant") continue;
    const texts = assistantTexts(content);
    for (let position = texts.length - 1; position >= 0; position--) reversed.push(texts[position]!);
  }
  return reversed.reverse().join("\n");
}
