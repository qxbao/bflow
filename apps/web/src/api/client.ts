import { WebHttpContracts as contracts, WebApiErrorSchema, WEB_LIMITS, type WebSessionSummary } from '@bflow/contracts/web';

type Parser<T> = { parse(input: unknown): T };
export class ConfigurationError extends Error {}
export class ApiError extends Error {
  constructor(readonly code: string) { super(code); }
}
const messages: Record<string, string> = {
  session_required: 'Phiên trình duyệt đã hết hạn. Mở lại Bflow Web từ máy này để ghép nối.',
  forbidden: 'Không thể xác thực truy cập. Mở lại Bflow Web để ghép nối.',
  not_found: 'Không tìm thấy dữ liệu. Hãy kiểm tra dự án và liên kết đã mở.',
  stale_version: 'Dữ liệu đã thay đổi. Tải lại trang để xem phiên bản hiện tại.',
  invalid_response: 'Dữ liệu trả về không hợp lệ. Hãy tải lại hoặc kiểm tra phiên dự án.',
  invalid_request: 'Thông tin chưa hợp lệ. Kiểm tra đường dẫn Git tuyệt đối trên máy này.',
  operation_conflict: 'Dự án còn thao tác chưa được xác nhận. Kiểm tra trạng thái thao tác trước khi hủy đăng ký.',
  operation_not_allowed: 'Trạng thái hiện tại chưa cho phép thao tác này. Tải lại để xem thao tác hợp lệ; nếu vẫn bị từ chối, khởi động lại Bflow Web bằng phiên bản mới.',
  unavailable: 'Chưa kết nối được dịch vụ. Kiểm tra phiên dự án rồi thử tải lại.',
};
export function explain(error: unknown): string { return error instanceof ConfigurationError ? error.message : error instanceof ApiError ? messages[error.code] ?? messages.unavailable! : messages.unavailable!; }
/** Capture and erase secrets before rendering, requests, or asynchronous work. */
export function consumeBootstrap(): string | undefined {
  const fragment = location.hash.slice(1);
  if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
  return new URLSearchParams(fragment).get('bootstrap') ?? undefined;
}
export const projectPath = (id: string) => `/api/v1/projects/${encodeURIComponent(id)}`;
export class ApiClient {
  private csrf: string | undefined;
  private session: WebSessionSummary | undefined;
  async request<T>(path: string, schema: Parser<T>, method = 'GET', body?: unknown, timeoutMs = 10000): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && this.csrf) headers['X-Bflow-CSRF'] = this.csrf;
    let response: Response;
    try {
      response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ApiError('unavailable');
    }
    if (!response.ok) {
      if (response.status === 401) { this.csrf = undefined; this.session = undefined; }
      const raw = await response.json().catch(() => undefined);
      const error = WebApiErrorSchema.safeParse(raw);
      throw new ApiError(error.success ? error.data.code : response.status === 401 ? 'session_required' : 'invalid_response');
    }
    try { return schema.parse(response.status === 204 ? undefined : await response.json()); } catch { throw new ApiError('invalid_response'); }
  }
  async authenticate(secret?: string) {
    const value = secret
      ? await this.request('/api/v1/session/bootstrap', contracts.bootstrap.response, 'POST', contracts.bootstrap.body.parse({apiVersion:1,secret}))
      : await this.request('/api/v1/session', contracts.session.response);
    this.csrf = value.csrfToken; this.session = value; return value;
  }
  get expiresAt() { return this.session?.expiresAt; }
  projects() { return this.request('/api/v1/projects', contracts.projects.response); }
  register(path: string) { return this.request('/api/v1/projects', contracts.registerProject.response, 'POST', contracts.registerProject.body.parse({apiVersion:1,path})); }
  unregister(id: string) { return this.request(projectPath(id), contracts.unregisterProject.response, 'DELETE', contracts.unregisterProject.body.parse({apiVersion:1,confirmed:true})); }
  configuration(id: string) { return this.request(`${projectPath(id)}/configuration`, contracts.configuration.response); }
  async saveConfiguration(id: string, input: unknown) { const result = await this.request(`${projectPath(id)}/configuration`, contracts.saveConfiguration.response, 'PUT', contracts.saveConfiguration.body.parse(input)); if(!result.ok)throw new ConfigurationError(result.error.message);return result.value; }
  initialize(id: string, input: unknown) { return this.request(`${projectPath(id)}/initializations`, contracts.initializeProject.response, 'POST', contracts.initializeProject.body.parse(input)); }
  initialization(id: string, operationId: string) { return this.request(`${projectPath(id)}/initializations/${encodeURIComponent(operationId)}`, contracts.initialization.response); }
  sessionView(id: string) { return this.request(`${projectPath(id)}/session`, contracts.projectSession.response); }
  preview(id: string) { return this.request(`${projectPath(id)}/preview`, contracts.preview.response, 'GET', undefined, 20000); }
  runs(id: string, search = '', phase = '', cursor?: string) {
    const query = new URLSearchParams({limit:'25'});
    if (search.trim()) query.set('search',search.trim()); if (phase) query.set('sdlcStatus',phase); if(cursor) query.set('cursor',cursor);
    return this.request(`${projectPath(id)}/runs?${query}`, contracts.runs.response);
  }
  async run(id: string, runId: string) {
    const value = await this.request(`${projectPath(id)}/runs/${encodeURIComponent(runId)}`, contracts.run.response);
    if (value.runId !== runId) throw new ApiError('invalid_response');
    return value;
  }
  decisions(id: string) { return this.request(`${projectPath(id)}/decisions`, contracts.decisions.response); }
  inspect(id: string) { return this.request(`${projectPath(id)}/session/inspect`, contracts.inspectSession.response, 'POST', contracts.inspectSession.body.parse({apiVersion:1}), 50000); }
  async artifact(id: string, artifactId: string): Promise<string> {
    const response = await fetch(`${projectPath(id)}/artifacts/${encodeURIComponent(artifactId)}`, {credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new ApiError(response.status === 401 ? 'session_required' : 'unavailable');
    if (!response.headers.get('Content-Disposition')?.startsWith('inline') || !response.headers.get('Content-Type')?.startsWith('text/plain')) {
      await response.body?.cancel(); throw new ApiError('attachment');
    }
    const reader = response.body?.getReader(); if (!reader) throw new ApiError('invalid_response');
    let count=0; const decoder=new TextDecoder(); let text='';
    try { while(true) { const chunk=await reader.read(); if(chunk.done) break; count+=chunk.value.byteLength;
      if(count>WEB_LIMITS.previewBytes) throw new ApiError('payload_too_large'); text+=decoder.decode(chunk.value,{stream:true}); }
      return text+decoder.decode();
    } finally { await reader.cancel(); }
  }
}
