import { z } from "zod";
import { requirementRevisionGuidance } from "./requirement-revision-guidance.js";

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
  /** Bounded blocker fields remain readable when the diagnostic summary is truncated. */
  blocked?: unknown;
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
  /** For updates and blocks: content that, shown together with the run id, also proves display after reformatting. */
  ackText?: string;
  /** A requirement-revision notice is not displayed until the user sees its next action too. */
  requiredActionText?: string;
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
const BLOCKED_KINDS = ["workflow_blocked", "run_stalled", "workflow_rejected", "delivery_failure", "delegation_rejected", "coordinator_no_response",
  "developer_no_response", "specialist_no_response", "verification_stuck"] as const;
/** Runtime's automatic-resume schedule; display only, never authority to resume. */
const AutomaticResumeSchema = z.object({ attempt: z.number().int().min(0), limit: z.number().int().min(0), notBefore: z.string().max(64) }).strict();
const BLOCKED_PAYLOAD = z.object({
  kind: z.enum(BLOCKED_KINDS),
  reason: z.string().min(1),
  options: z.array(z.string()).optional(),
  runId: z.string().min(1).optional()
}).passthrough();

/** Private receipt projection, additive for old notices; carries no decision/approval authority. */
export const BlockedNoticeSchema = z.object({
  kind: z.enum(BLOCKED_KINDS),
  reason: z.string().min(1).max(2000),
  runId: z.string().min(1).optional(),
  options: z.array(z.string().max(500)).max(10).optional(),
  requested_action: z.literal("authorized_requirement_revision").optional(),
  requiredSddLevel: z.literal("full").optional(),
  blockers: z.array(z.string().max(200)).max(2).optional(),
  automaticResume: AutomaticResumeSchema.optional()
}).strict();

const BLOCKED_LABEL: Record<(typeof BLOCKED_KINDS)[number], string> = {
  workflow_blocked: "workflow bị chặn",
  run_stalled: "run bị treo",
  workflow_rejected: "workflow bị từ chối",
  delivery_failure: "gửi tin nhắn thất bại",
  delegation_rejected: "yêu cầu cập nhật bị từ chối",
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
  const payload = ["conversation.progress", "delegation.accepted"].includes(type) ? parseSummary(notice) : undefined;
  const text = payload && typeof payload === "object" && !Array.isArray(payload)
    ? [(payload as Record<string, unknown>).blockageReason, (payload as Record<string, unknown>).headline].find(value => typeof value === "string" && value.length > 0) as string | undefined
    : undefined;
  // Bind display to this exact notice and its content: repeated/stale headlines must not acknowledge a different update.
  const ackToken = notice.runId && text ? `[${notice.messageId}] ${text}` : undefined;
  const headline = `ℹ️ Cập nhật từ ${sender} (${type})${notice.runId ? ` · run ${notice.runId}` : ""}${text ? `: ${ackToken ?? text}` : ""}`;
  const note = truncated ? " — nội dung bị cắt ngắn, không hiển thị đầy đủ" : "";
  // Substantive progress needs display recovery too. Its text is an acknowledgement token, never approval authority.
  return { messageId: notice.messageId, kind: "update", ...(notice.runId ? { runId: notice.runId } : {}), headline,
    ...(ackToken && text ? { ackToken, ackText: text } : {}),
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
    // The Conversation parser accepts exactly these: a bare number only while this is the sole pending approval.
    `Trả lời: "${fields.approvalId}: 1" (duyệt) / "${fields.approvalId}: 2 <lý do>" (từ chối), hoặc "${fields.approvalId}: approve" / "${fields.approvalId}: reject <lý do>"; ` +
      `chỉ khi đây là phê duyệt duy nhất đang chờ mới được gõ "1" hoặc "2 <lý do>" không kèm mã`];
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
  const revision = requirementRevisionGuidance(payload, runId);
  const automatic = revision ? undefined : AutomaticResumeSchema.safeParse((payload as { automaticResume?: unknown }).automaticResume).data;
  const options = (revision?.options ?? payload.options ?? []).map((text, index) => ({ number: index + 1, text }));
  const headline = `⚠️ [${notice.messageId}] ${capitalise(BLOCKED_LABEL[payload.kind])}${runId ? ` (run ${runId})` : ""}: ${payload.reason}`;
  // Options describe possible actions; they are not numbered decisions. Revisions go through Conversation's intent handling.
  const reply = revision ? (revision.suggestedReply ? `Trả lời: "${revision.suggestedReply}".` :
    `Trả lời bằng nội dung yêu cầu cần sửa cho ${runId ? `run ${runId}` : "run hiện tại"}.`) +
    (runId ? ` Hoặc "hủy ${runId}" để hủy run.` : "") :
    automatic && runId ? `Runtime sẽ tự tiếp tục run ${runId} (lần ${automatic.attempt}/${automatic.limit}); bạn chưa cần trả lời. Trả lời "hủy ${runId}" để hủy run.` :
    runId ? `Trả lời "tiếp tục ${runId}" sau khi khắc phục, hoặc "hủy ${runId}" để hủy run.` : "Hãy cho Conversation biết cách xử lý";
  // The reason's prose before any structured detail: agents often reformat the JSON detail but keep this sentence.
  const lead = payload.reason.split(/[\n[{]/u)[0]!.trim();
  return { messageId: notice.messageId, kind: "blocked", ...(runId ? { runId } : {}), ackToken: notice.messageId,
    ...(revision ? { requiredActionText: revision.suggestedReply ?? "nội dung yêu cầu cần sửa" } : {}),
    ...(lead.length >= 20 ? { ackText: lead } : {}), headline, reply,
    options, display: [headline, ...(revision?.nextSteps ?? []), ...options.map(option => `- ${option.text}`), reply].join("\n") };
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

/** Keep actionable blocker content independently of the general diagnostic summary cap. */
export function blockedNoticeFields(payload: unknown): z.infer<typeof BlockedNoticeSchema> | undefined {
  const value = blockedPayload(payload);
  if (!value) return undefined;
  const revision = requirementRevisionGuidance(value, value.runId);
  const automatic = AutomaticResumeSchema.safeParse((value as { automaticResume?: unknown }).automaticResume);
  const parsed = BlockedNoticeSchema.safeParse({
    kind: value.kind, reason: value.reason.slice(0, 2000),
    ...(value.runId ? { runId: value.runId } : {}), ...(automatic.success ? { automaticResume: automatic.data } : {}),
    ...(value.options ? { options: value.options.slice(0, 10).map(option => option.slice(0, 500)) } : {}),
    ...(revision ? { requested_action: revision.requested_action, blockers: revision.blockers,
      ...(revision.requiredSddLevel ? { requiredSddLevel: revision.requiredSddLevel } : {}) } : {})
  });
  return parsed.success ? parsed.data : undefined;
}

/** Renders one notice. Anything unparseable or truncated degrades to a generic update that says so. */
export function renderConversationNotice(notice: NoticeLike): RenderedNotice {
  const structured = notice.userDecision === undefined ? undefined : UserDecisionNoticeSchema.safeParse(notice.userDecision);
  if (structured?.success) return decisionNotice(notice, structured.data);
  const approvalFields = notice.approval === undefined ? undefined : ApprovalNoticeSchema.safeParse(notice.approval);
  if (approvalFields?.success) return approvalContent(notice, approvalFields.data);
  const blockedFields = notice.blocked === undefined ? undefined : BlockedNoticeSchema.safeParse(notice.blocked);
  if (blockedFields?.success) return blockedNotice(notice, blockedFields.data);
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
  // Reserve the action before clipping the diagnostic headline; otherwise a long reason consumes the whole notification.
  const reply = (notice.reply ?? "").slice(0, max);
  const head = notice.headline.slice(0, Math.max(0, max - reply.length - (reply ? 1 : 0)));
  const room = max - head.length - reply.length - 2;
  const question = (notice.question ?? "").slice(0, Math.max(0, room));
  return [head, question, reply].filter(Boolean).join("\n").slice(0, max);
}

/** The MUST SHOW block placed first in hook output. Empty when there is nothing to show. */
export function mustShowSection(notices: readonly NoticeLike[]): string {
  const rendered = notices.map(renderConversationNotice).sort((a, b) => noticePriority(a) - noticePriority(b));
  if (!rendered.length) return "";
  return "MUST SHOW TO USER VERBATIM:\n" + rendered.map(notice => notice.display).join("\n\n") +
    "\n\n(Copy the lines above into your reply unchanged, including every [id] marker and run id; display is checked by them.)\n\n";
}

/** Markdown emphasis/code markers and whitespace runs removed, so bolding or wrapping a line does not hide it. */
function plain(text: string): string {
  return text.replace(/[*_`]/gu, "").replace(/\s+/gu, " ").trim();
}

/**
 * Whether the final Conversation text shows this notice. Decisions and approvals must name their approval id. Updates and
 * blocks are also shown by their unique message id, or by their run id together with their exact text: a stale or other-run
 * headline never acknowledges a different notice. Advisory only: display never grants approval authority.
 */
export function noticeDisplayed(notice: RenderedNotice, shown: string): boolean {
  if (notice.ackToken === undefined) return false;
  if (notice.requiredActionText !== undefined && !plain(shown).toLowerCase().includes(plain(notice.requiredActionText).toLowerCase())) return false;
  if (shown.includes(notice.ackToken)) return true;
  if (notice.kind !== "update" && notice.kind !== "blocked") return false;
  if (shown.includes(notice.messageId)) return true;
  return notice.runId !== undefined && notice.ackText !== undefined && shown.includes(notice.runId) && plain(shown).includes(plain(notice.ackText));
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
    const source = (entry as { source?: unknown }).source;
    const type = (entry as { type?: unknown }).type;
    if (source === "USER_EXPLICIT" && type === "USER_INPUT") break;
    if (source === "MODEL" && type === "PLANNER_RESPONSE") {
      const agyContent = (entry as { content?: unknown }).content;
      if (typeof agyContent === "string" && agyContent.length > 0) reversed.push(agyContent);
      continue;
    }
    const content = ((entry as { message?: { content?: unknown } }).message)?.content;
    if (type === "user") { if (isGenuineUserPrompt(content)) break; continue; }
    if (type !== "assistant") continue;
    const texts = assistantTexts(content);
    for (let position = texts.length - 1; position >= 0; position--) reversed.push(texts[position]!);
  }
  return reversed.reverse().join("\n");
}
