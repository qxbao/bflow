import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DirectorMessageSchema, OperationResultSchema, type ContractError, type DirectorMessage, type OperationResult } from '@bflow/contracts';
import { WebHttpContracts, WebDirectorViewSchema, WebDirectorTranscriptPageSchema, WebIssueQueueViewSchema, WebDirectorLaunchOptionsSchema,
  WebOperationResultSchema, type WebChatSend, type WebDirectorView, type WebDirectorTranscriptPage, type WebIssueQueueView,
  type WebDirectorLaunchOptions, type WebOperationResult, type WebProject } from '@bflow/contracts/web';
import { canonicalWebJson, type WebAuthenticatedContext } from '@bflow/contracts/web-host';
import { HttpError, contractError, observeWithinDeadline } from './errors.js';

/**
 * D-CD-01 Director Web port (optional in LocalWebServices). The owner composition implements it; this package only routes,
 * re-authenticates and validates exported DTOs. A backend without it answers operation_not_allowed.
 * `launch` runs the effect for an operation whose intent Local Server has already persisted; it receives no argv, cwd or env.
 */
export type DirectorLaunchOutcome = Extract<WebOperationResult, { kind: 'director_launch' }>;
export interface LocalWebDirectorServices {
  readView(projectId: string, context: WebAuthenticatedContext): Promise<OperationResult<WebDirectorView>>;
  messages(projectId: string, cursor: string | undefined, context: WebAuthenticatedContext): Promise<OperationResult<WebDirectorTranscriptPage>>;
  send(input: WebChatSend, context: WebAuthenticatedContext): Promise<OperationResult<DirectorMessage>>;
  issues(projectId: string, cursor: string | undefined, context: WebAuthenticatedContext): Promise<OperationResult<WebIssueQueueView>>;
  launchOptions(projectId: string, context: WebAuthenticatedContext): Promise<OperationResult<WebDirectorLaunchOptions>>;
  launch(projectId: string, request: { provider: DirectorLaunchOutcome['provider']; profileName?:string; replaceActive: boolean }, context: WebAuthenticatedContext): Promise<OperationResult<DirectorLaunchOutcome>>;
}
export const DIRECTOR_PORT_METHODS = ['readView', 'messages', 'send', 'issues', 'launchOptions', 'launch'] as const;

const ViewResult = OperationResultSchema(WebDirectorViewSchema);
const TranscriptResult = OperationResultSchema(WebDirectorTranscriptPageSchema);
const MessageResult = OperationResultSchema(DirectorMessageSchema);
const IssuesResult = OperationResultSchema(WebIssueQueueViewSchema);
const OptionsResult = OperationResultSchema(WebDirectorLaunchOptionsSchema);
const LaunchOutcomeSchema = WebOperationResultSchema.refine((outcome): outcome is DirectorLaunchOutcome => outcome.kind === 'director_launch', 'expected a director_launch result');
export const DirectorLaunchOutcomeResultSchema = OperationResultSchema(LaunchOutcomeSchema);

/** Fingerprint of a launch intent: provider, replaceActive and the canonical project. Never the plan or environment. */
export function directorLaunchFingerprint(input: { projectId: string; provider: string; profileName?:string; replaceActive: boolean; canonicalPath: string }): string {
  return createHash('sha256').update(canonicalWebJson({ kind: 'director_launch', ...input })).digest('hex');
}

// Fixed, owner-authored Vietnamese guidance. Backend text never reaches the browser through these errors.
const MESSAGES = {
  hostDown: 'Host của phiên bflow chưa chạy hoặc không phản hồi. Bấm Bắt đầu phiên (hoặc chạy `bflow up` trong kho mã) rồi tải lại.',
  notDirector: 'Chat và hàng đợi Director chỉ dùng được khi phiên chạy bố cục Director. Phiên hiện tại là v2 hoặc chưa khởi động; dừng phiên rồi khởi động lại.',
  forbidden: 'Phiên hoặc lượt chạy không khớp phiên host hiện tại. Tải lại trang để lấy trạng thái mới.',
  staleMessage: 'Mã tin nhắn này đã dùng cho nội dung khác. Tải lại hội thoại rồi gửi tin mới.',
  unknownDelivery: 'Chưa xác nhận tin đã tới host. Tải lại hội thoại và tìm tin này trước khi gửi lại; không gửi tin trùng.',
  directory: 'Không truy cập được thư mục kho mã của dự án (đã bị xóa, đổi tên hoặc không còn là kho git). Kiểm tra lại rồi đăng ký lại dự án.',
  invalid: 'Yêu cầu Director không hợp lệ. Tải lại trang rồi thử lại.',
  noPort: 'Máy chủ web này chưa hỗ trợ Director. Cập nhật bflow rồi chạy lại `bflow web`.'
} as const;
export const LAUNCH_UNCERTAIN_MESSAGE = 'Không rõ cửa sổ terminal đã mở hay chưa. Kiểm tra màn hình; nếu chưa có cửa sổ Director, tự chạy lệnh trong mục Mở phiên Director. Bflow không tự thử lại.';
export const LAUNCH_INTERRUPTED_MESSAGE = 'Thao tác mở Director bị gián đoạn trước khi lưu kết quả. Kiểm tra màn hình xem cửa sổ đã mở chưa; Bflow không tự mở lại. Dùng mã thao tác mới nếu cần mở phiên.';
const LAUNCH_REFUSALS: Record<string, string> = {
  director_active: 'Director có thể đang chạy (đang hoạt động, đang chờ hoặc không đọc được trạng thái). Xác nhận mở phiên thay thế để mở thêm; phiên cũ không bị dừng.',
  provider_unavailable: 'Không tìm thấy CLI của nhà cung cấp đã chọn trên PATH. Cài đặt hoặc chọn nhà cung cấp khác rồi thử lại.',
  profile_unavailable: 'Profile ai-isolator đã chọn không còn sẵn sàng. Kiểm tra ai-isolator status rồi chọn lại profile; chưa có cửa sổ nào được mở.',
  skill_missing: 'Kho mã chưa có skill /bflow-start. Chạy `bflow init --update` trong kho mã rồi thử lại.',
  repository_invalid: 'Không đọc được thư mục kho mã hoặc đường dẫn không còn là đường dẫn chuẩn. Kiểm tra kho rồi đăng ký lại dự án.',
  launch_in_progress: 'Đang mở một phiên Director khác cho kho này. Đợi thao tác đó xong rồi thử lại.',
  launch_cancelled: 'Đã hủy trước khi mở terminal; không có cửa sổ nào được mở.',
  command_too_long: 'Đường dẫn kho quá dài để tạo lệnh mở phiên.',
  not_started: 'Chưa mở được Director vì kiểm tra trước khi mở thất bại; không có cửa sổ nào được mở. Thử lại sau.'
};
export function launchRefusalMessage(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(LAUNCH_REFUSALS, reason) ? LAUNCH_REFUSALS[reason]! : LAUNCH_REFUSALS.not_started!;
}

/** Maps a Runtime/adapter refusal by its `details.reason` (Runtime bridge convention) to an actionable public error. */
function directorFailure(error: ContractError, kind: 'read' | 'send'): HttpError {
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  const code = typeof reason === 'string' && ['forbidden', 'invalid_request', 'operation_not_allowed', 'stale_version', 'unavailable', 'reconciliation_required'].includes(reason)
    ? reason as HttpError['code'] : contractError(error).code;
  if (error.code === 'unknown_delivery') return new HttpError('reconciliation_required', undefined, kind === 'send' ? MESSAGES.unknownDelivery : MESSAGES.hostDown);
  const detail = code === 'unavailable' ? MESSAGES.hostDown : code === 'operation_not_allowed' ? MESSAGES.notDirector : code === 'forbidden' ? MESSAGES.forbidden
    : code === 'stale_version' ? (kind === 'send' ? MESSAGES.staleMessage : undefined) : code === 'invalid_request' ? MESSAGES.invalid : undefined;
  return new HttpError(code, undefined, detail);
}
function value<T>(result: OperationResult<T>, kind: 'read' | 'send' = 'read'): T {
  if (!result.ok) throw directorFailure(result.error, kind);
  return result.value;
}

export const DIRECTOR_ROUTES = new Set(['director', 'directorMessages', 'sendDirectorMessage', 'directorIssues', 'directorLaunchOptions', 'launchDirector']);

export interface DirectorRouteContext {
  name: string; projectId: string; input: unknown; query: unknown; req: IncomingMessage; res: ServerResponse;
  authentication: WebAuthenticatedContext;
  director: LocalWebDirectorServices | undefined;
  /** Re-authenticates cookie/CSRF (Origin was checked at ingress) and revalidates the registered project. */
  authorize(): void;
  requireProject(): Promise<WebProject>;
  /** Global critical section and per-key interaction queue of the route module. */
  critical<T>(fn: () => Promise<T>): Promise<T>;
  queue<T>(key: string, fn: () => Promise<T>): Promise<T>;
  launch(project: WebProject, request: { operationId: string; provider: DirectorLaunchOutcome['provider']; profileName?:string; replaceActive: boolean }, port: LocalWebDirectorServices): Promise<unknown>;
  respond(value: unknown, status?: number): void;
}

/** Six D-CD-01 routes. Every response is parsed with its exported contract before it is sent. */
export async function directorRoute(ctx: DirectorRouteContext): Promise<void> {
  const { name, projectId: id, res } = ctx;
  let project: WebProject;
  try { project = await ctx.requireProject(); }
  catch (error) { if (error instanceof HttpError && error.code === 'unavailable') throw new HttpError('unavailable', undefined, MESSAGES.directory); throw error; }
  const port = ctx.director;
  if (!port) throw new HttpError('operation_not_allowed', undefined, MESSAGES.noPort);
  if (name === 'director') {
    res.setTimeout(25000);
    const view = value(ViewResult.parse(await observeWithinDeadline(() => port.readView(id, ctx.authentication), 15000)));
    if (view.projectId !== id) throw new HttpError('unavailable');
    ctx.respond(view); return;
  }
  if (name === 'directorMessages' || name === 'directorIssues') {
    res.setTimeout(40000);
    const page = name === 'directorMessages'
      ? value(TranscriptResult.parse(await observeWithinDeadline(() => port.messages(id, WebHttpContracts.directorMessages.query.parse(ctx.query).cursor, ctx.authentication), 35000)))
      : value(IssuesResult.parse(await observeWithinDeadline(() => port.issues(id, WebHttpContracts.directorIssues.query.parse(ctx.query).cursor, ctx.authentication), 35000)));
    ctx.respond(page); return;
  }
  if (name === 'sendDirectorMessage') {
    res.setTimeout(40000);
    const body = WebHttpContracts.sendDirectorMessage.body.parse(ctx.input);
    if (body.projectId !== id) throw new HttpError('forbidden');
    const result = MessageResult.parse(await ctx.queue(canonicalWebJson([id, 'director-message']), async () => {
      // Recheck after queueing and immediately before the effect: an expired cookie or CSRF never reaches the host.
      await ctx.critical(async () => { await ctx.requireProject(); ctx.authorize(); });
      return observeWithinDeadline(() => port.send(body, ctx.authentication), 35000);
    }));
    const message = value(result, 'send');
    if (message.messageId !== body.messageId) throw new HttpError('unavailable');
    ctx.respond(message, 202); return;
  }
  if (name === 'directorLaunchOptions') {
    res.setTimeout(30000);
    const options = value(OptionsResult.parse(await observeWithinDeadline(() => port.launchOptions(id, ctx.authentication), 20000)));
    if (options.projectId !== id) throw new HttpError('unavailable');
    ctx.respond(options); return;
  }
  if (name === 'launchDirector') {
    res.setTimeout(45000);
    const body = WebHttpContracts.launchDirector.body.parse(ctx.input);
    ctx.respond(await ctx.launch(project, { operationId: body.operationId, provider: body.provider, ...(body.profileName!==undefined?{profileName:body.profileName}:{}), replaceActive: body.replaceActive }, port), 202); return;
  }
  throw new HttpError('operation_not_allowed');
}
