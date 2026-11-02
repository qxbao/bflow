import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { WebAgentViewSchema, WebDecisionSchema } from '@bflow/contracts/web';
import { App } from '../src/app';
import { ApiClient } from '../src/api/client';
import { MODE_KEY, writeMode } from '../src/features/office/mode';
import { OfficeStage, type CreateRenderer } from '../src/features/office/ui/OfficeStage';
import type { OfficeHandoff, OfficeModel } from '../src/features/office/model/types';
import type { VisualCue } from '../src/features/office/model/timeline';
import { decision, installApi, now, projects, run, session } from './fixtures';

// V8.1: the first 34 rows of the §6 parity matrix. Each case enters through the 3D entry point that exists today (HUD rail, HUD bar,
// HUD project select, or a button of the DOM mirror, which is the stable surface) and asserts the Classic component renders. No canvas pixel is clicked.
// Deep links render several nested reads; the default 1 s is tight under a loaded machine.
configure({ asyncUtilTimeout: 5000 });
const ready = { ...session, state: 'ready', sessionId: 'host-session' };
const version = { revisionToken: 'v1' };
const cancel = { kind: 'cancel', actionId: 'cancel', enabled: true, expectedVersion: version };
const resume = { kind: 'resume', actionId: 'resume', enabled: true, expectedVersion: version };
const revise = { kind: 'revise_request', actionId: 'revise', enabled: true, expectedVersion: version };
const decide = { kind: 'answer_decision', actionId: 'decide', enabled: true, expectedVersion: decision.expectedVersion };
const cfg = { apiVersion: 1, projectId: 'p', revision: 'a'.repeat(64), yaml: 'projectName: Sample\nenvironment: {}\n', values: { projectName: 'Sample', environment: { roles: [{ role: 'conversation', cli: 'claude', required: true }], verification: { maxIterations: 3, regressionScope: 'affected' }, permissions: { trustedWorkspace: true } } } };
const evidenceRef = { artifactId: 'artifact-1', runId: 'run', kind: 'test-result', mediaType: 'text/plain', checksum: { algorithm: 'sha256', value: 'a'.repeat(64) } };
const projectFixture = projects[0]!;
const RUN = '/api/v1/projects/p/runs/run';

beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_k: string, cb: () => unknown) => cb() } }); localStorage.clear(); sessionStorage.clear(); writeMode('visual'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

let where = '';
function Probe() {
  const location = useLocation(), navigate = useNavigate();
  where = location.pathname + location.search;
  return <button type="button" onClick={() => navigate(-1)}>probe-back</button>;
}
type Api = ReturnType<typeof installApi>;
/** Mounts the app with 3D remembered and returns once the 3D surfaces exist: HUD rail, DOM mirror and, off the index path, the open panel. */
async function mount(path = '/projects/p', overrides: Record<string, unknown> = {}): Promise<Api> {
  const api = installApi({ '/api/v1/projects/p/session': ready, ...overrides });
  render(<MemoryRouter initialEntries={[path]}><App api={new ApiClient()} /><Probe /></MemoryRouter>);
  await screen.findByRole('navigation', { name: 'Lối tắt' });
  await screen.findByRole('region', { name: 'Bản văn bản của văn phòng' });
  if (path !== '/projects/p') await waitFor(() => expect(panelOpen()).toBe(true));
  return api;
}
const main = (): HTMLElement => document.getElementById('main')!;
const panelOpen = (): boolean => !main().classList.contains('hidden');
const rail = async (name: string | RegExp): Promise<void> => { fireEvent.click(within(await screen.findByRole('navigation', { name: 'Lối tắt' })).getByRole('button', { name })); };
const mirror = async (name: string | RegExp): Promise<void> => { fireEvent.click(within(await screen.findByRole('region', { name: 'Bản văn bản của văn phòng' })).getByRole('button', { name })); };
/** The panel node is replaced when pairing finishes, so queries are re-bound to the live node on every attempt. */
const inMain = (): ReturnType<typeof within> => new Proxy({}, {
  get: (_t, key: string) => (...args: unknown[]) => {
    const query = (): unknown => (within(main()) as unknown as Record<string, (...a: unknown[]) => unknown>)[key.startsWith('find') ? `get${key.slice(4)}` : key]!(...args);
    return key.startsWith('find') ? waitFor(query as () => unknown) : query();
  },
}) as ReturnType<typeof within>;
const posts = (api: Api): unknown[] => api.fetcher.mock.calls.filter(c => (c as unknown as [string, RequestInit?])[1]?.method === 'POST');
const runWith = (over: Record<string, unknown>) => ({ ...run, ...over });

interface Row { row: number; name: string; note?: string; /** The row leaves the scene on purpose (pairing, project list, another project). */ leavesScene?: boolean; go: () => Promise<void> }
/** The component identity: the stable `data-component` attribute of a reused Classic component, found in the panel. */
const marked = (name: string, root: ParentNode = main()): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(`[data-component="${name}"]`)];
const insideOf = (el: HTMLElement, name: string): boolean => el.closest(`[data-component="${name}"]`) !== null;
/** Opens a run the 3D way: the rail "Công việc" list, then the run link. The list endpoints serve the same run as the run read. */
async function openRunViaRail(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Api> {
  const r = runWith(over), list = { apiVersion: 1, items: [r] };
  const api = await mount('/projects/p', { [RUN]: r, '/api/v1/projects/p/runs?limit=25': list, '/api/v1/projects/p/runs?limit=25&search=&phase=': list, ...extra });
  await rail('Công việc');
  fireEvent.click(await inMain().findByRole('link', { name: r.title }));
  await waitFor(() => expect(where).toBe('/projects/p/runs/run'));
  await waitFor(() => expect(marked('RunView').length).toBe(1));
  return api;
}
const rows: Row[] = [
  { row: 1, leavesScene: true, name: 'pairing / expired session shows ErrorState before any scene, even with 3D remembered', go: async () => {
    expect(localStorage.getItem(MODE_KEY)).toBe('visual');
    const refuse = () => new Response(JSON.stringify({ apiVersion: 1, code: 'session_required', message: 'x', retryable: false, correlationId: 'c' }), { status: 401 });
    vi.stubGlobal('fetch', vi.fn(async () => refuse()));
    render(<MemoryRouter initialEntries={['/projects/p']}><App api={new ApiClient()} /></MemoryRouter>);
    expect(await screen.findByLabelText('Mã hoặc đường dẫn ghép nối (#bootstrap=...)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ghép nối lại' })).toBeTruthy();
    expect(marked('ErrorState', document.body)).toHaveLength(1);
    // Nothing of the scene is left behind: no HUD, rail, mirror, stage or canvas.
    expect(screen.queryByRole('region', { name: 'Văn phòng Bflow' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Lối tắt' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Bản văn bản của văn phòng' })).toBeNull();
    expect(screen.queryByLabelText('Cảnh văn phòng')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
  } },
  { row: 2, leavesScene: true, name: 'project list and search: the door object opens Projects', note: 'Entry: mirror "Cửa ra vào" or HUD select "Quản lý dự án…"; the door is a mirror/scene object, not a floating-HUD control', go: async () => {
    await mount();
    await mirror(/Cửa ra vào/);
    expect(await screen.findByRole('heading', { name: /Dự án/ })).toBeTruthy();
    expect(where).toBe('/');
    expect(document.querySelector('[data-component="Projects"]')).not.toBeNull();
    expect(screen.getByLabelText('Tìm dự án')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Vườn sách/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Kho phim/ })).toBeTruthy();
  } },
  { row: 3, leavesScene: true, name: 'register project: the Projects form through the HUD select', go: async () => {
    await mount();
    fireEvent.change(await screen.findByLabelText('Chuyển dự án'), { target: { value: '' } });
    expect(await screen.findByLabelText('Đường dẫn Git tuyệt đối')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Đăng ký dự án' })).toBeTruthy();
    expect(document.querySelector('[data-component="Projects"]')).not.toBeNull();
    expect(where).toBe('/');
  } },
  { row: 4, leavesScene: true, name: 'switch project: the HUD select (the same one AppShell keeps)', go: async () => {
    await mount();
    fireEvent.change(await screen.findByLabelText('Chuyển dự án'), { target: { value: 'q' } });
    await waitFor(() => expect(where).toBe('/projects/q'));
  } },
  { row: 5, name: 'unregister: Settings via the rail', go: async () => {
    await mount('/projects/p', { '/api/v1/projects/p/configuration': cfg });
    await rail('Cài đặt');
    expect(await inMain().findByRole('button', { name: 'Hủy đăng ký dự án' })).toBeTruthy();
    expect(marked('Settings')).toHaveLength(1);
    expect(where).toBe('/projects/p/settings');
  } },
  { row: 6, name: 'init, GitNexus and commit config: Settings via the settings object', go: async () => {
    await mount('/projects/p', { '/api/v1/projects/p/configuration': cfg });
    await mirror(/Bảng cài đặt/);
    expect(await inMain().findByRole('button', { name: 'Khởi tạo / sửa GitNexus' })).toBeTruthy();
    expect(marked('Settings')).toHaveLength(1);
    expect(inMain().getByText(/Khởi tạo \/ sửa GitNexus & Commit cấu hình/)).toBeTruthy();
  } },
  { row: 7, name: 'configuration form, YAML and bulk role bar', go: async () => {
    await mount('/projects/p', { '/api/v1/projects/p/configuration': cfg });
    await rail('Cài đặt');
    expect(await inMain().findByLabelText('Model (conversation)')).toBeTruthy();
    expect(marked('Settings')).toHaveLength(1);
    expect(inMain().getByRole('button', { name: 'Lưu cấu hình' })).toBeTruthy();
    expect(inMain().getByRole('button', { name: 'Áp dụng cho tất cả vai trò' })).toBeTruthy();
    expect(inMain().getByRole('button', { name: 'YAML đầy đủ' })).toBeTruthy();
  } },
  { row: 8, name: 'readiness check', go: async () => {
    const api = await mount('/projects/p', { '/api/v1/projects/p/configuration': cfg, '/api/v1/projects/p/inspection': { apiVersion: 1, projectId: 'p', ready: true, checks: [{ id: 'git', state: 'passed', message: 'Kho Git hợp lệ' }], observedAt: now } });
    await rail('Cài đặt');
    fireEvent.click(await inMain().findByRole('button', { name: 'Kiểm tra điều kiện sẵn sàng' }));
    await waitFor(() => expect(api.fetcher.mock.calls.some(c => String(c[0]).includes('/inspect'))).toBe(true));
  } },
  { row: 9, name: 'start / stop / recovery stop: SessionActions in the server inspector', note: 'Entry: mirror "Máy chủ" opens the server inspector, which reuses SessionActions', go: async () => {
    await mount();
    await mirror(/Máy chủ/);
    expect(await screen.findByRole('heading', { name: /Máy chủ \(phiên dự án\)/ })).toBeTruthy();
    expect(within(main()).getByRole('button', { name: 'Dừng phiên' })).toBeTruthy();
    expect(marked('SessionActions')).toHaveLength(1);
    expect(panelOpen()).toBe(true);
  } },
  { row: 10, name: 'preparation preview: the Overview panel', go: async () => {
    await mount('/projects/p', { '/api/v1/projects/p/preview': { apiVersion: 1, projectId: 'p', available: true, summary: 'ok', blockers: [], observedAt: now } });
    await rail('Tổng quan');
    const summary = await inMain().findByText('Thông tin chuẩn bị');
    fireEvent.click(summary);
    expect(await inMain().findByText(/Đã đọc được cấu hình dự kiến/)).toBeTruthy();
    expect(marked('Overview')).toHaveLength(1);
  } },
  { row: 11, name: 'create request: RequestForm in the Overview panel', note: 'The plan names a "Giao việc" desk button; the counter object opens chat, so the form is reached by the rail "Tổng quan"', go: async () => {
    await mount();
    await rail('Tổng quan');
    expect(await inMain().findByLabelText('Tên công việc')).toBeTruthy();
    expect(inMain().getByRole('button', { name: 'Tạo công việc' })).toBeTruthy();
    const form = marked('RequestForm');
    expect(form).toHaveLength(1);
    expect(insideOf(form[0]!, 'RunView')).toBe(false);
    expect(marked('Overview')).toHaveLength(1);
  } },
  { row: 12, name: 'intake clarification: rail badge, then ClarificationForm in the Overview panel', note: 'The Tổng quan rail button carries the question count', go: async () => {
    const intake = { intakeId: 'intake', sessionId: 'host-session', correlationId: 'corr', title: 'Tìm sách nhanh', status: 'clarifying', clarifications: [{ questionId: 'scope', question: 'Cần tìm theo trường nào?', options: ['Tên sách'], expectedVersion: version }], updatedAt: now };
    await mount('/projects/p', { '/api/v1/projects/p/session': { ...ready, pendingIntakes: [intake] } });
    const overview = await within(await screen.findByRole('navigation', { name: 'Lối tắt' })).findByRole('button', { name: /^Tổng quan/ });
    await waitFor(() => expect(overview.textContent).toContain('Câu hỏi chờ trả lời: 1'));
    fireEvent.click(overview);
    expect(await inMain().findByText('Cần tìm theo trường nào?')).toBeTruthy();
    const form = marked('ClarificationForm');
    expect(form).toHaveLength(1);
    expect(insideOf(form[0]!, 'Overview')).toBe(true);
    expect(insideOf(form[0]!, 'RunView')).toBe(false);
    expect(within(form[0]!).getByRole('button', { name: 'Gửi câu trả lời' })).toBeTruthy();
  } },
  { row: 13, name: 'run list, search, filter: Runs via the task board', go: async () => {
    await mount('/projects/p', { '/api/v1/projects/p/runs?limit=25&search=&phase=': { apiVersion: 1, items: [run] } });
    await mirror(/Bảng nhiệm vụ/);
    expect(await inMain().findByRole('heading', { name: 'Công việc' })).toBeTruthy();
    expect(marked('Runs')).toHaveLength(1);
    expect(inMain().getByLabelText('Tìm công việc')).toBeTruthy();
    expect(inMain().getByRole('button', { name: 'Tìm kiếm' })).toBeTruthy();
    expect(where).toBe('/projects/p/runs');
  } },
  { row: 14, name: 'run detail from the rail list link', go: async () => {
    await openRunViaRail();
    expect(await inMain().findByRole('heading', { level: 1, name: 'Tìm sách nhanh hơn' })).toBeTruthy();
    expect(inMain().getByText('Chi tiết công việc')).toBeTruthy();
    expect(where).toBe('/projects/p/runs/run');
  } },
  { row: 15, name: 'current step uses the shared waitingOn in RunView', note: 'AgentInspector does not render waitingOn; only RunView does', go: async () => {
    await openRunViaRail();
    const step = await inMain().findByLabelText('Bước hiện tại');
    expect(step.querySelector('h2')?.textContent?.length).toBeGreaterThan(0);
    expect(marked('RunView')).toHaveLength(1);
  } },
  { row: 16, name: 'blockers: the HUD counts them and RunView renders the Blockers component', note: 'The HUD pill shows "n điểm cần lưu ý" from the session and the current run', go: async () => {
    const blocked = { blockers: [{ code: 'capability_repair_pending', message: 'x' }] };
    await openRunViaRail(blocked);
    await waitFor(() => expect(screen.getByLabelText('Trạng thái văn phòng').textContent).toContain('1 điểm cần lưu ý'));
    expect(await inMain().findByRole('heading', { name: 'Điểm cần bạn lưu ý' })).toBeTruthy();
    const items = marked('Blockers');
    expect(items).toHaveLength(1);
    expect(insideOf(items[0]!, 'RunView')).toBe(true);
    expect(items[0]!.textContent).toMatch(/Kết nối công cụ nội bộ của một vai trò chưa sẵn sàng/);
  } },
  { row: 17, name: 'run clarification form in RunView', go: async () => {
    await openRunViaRail({ clarifications: [{ questionId: 'q', question: 'Phạm vi làm rõ?', options: ['Giữ phạm vi'], expectedVersion: { revisionToken: 'qv' } }] });
    expect(await inMain().findByText('Phạm vi làm rõ?')).toBeTruthy();
    const form = marked('ClarificationForm');
    expect(form).toHaveLength(1);
    expect(insideOf(form[0]!, 'RunView')).toBe(true);
    expect(insideOf(form[0]!, 'Overview')).toBe(false);
    expect(within(form[0]!).getByRole('button', { name: 'Gửi câu trả lời' })).toBeTruthy();
  } },
  { row: 18, name: 'review, approve, reject, request changes: the mailbox', go: async () => {
    await mount('/projects/p', { [RUN]: runWith({ availableActions: [decide] }) });
    await mirror(/Hộp thư/);
    expect(await inMain().findByRole('heading', { name: 'Cần bạn quyết định' })).toBeTruthy();
    expect(marked('Review')).toHaveLength(1);
    await waitFor(() => expect((inMain().getByRole('button', { name: 'Xem xét gói' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(inMain().getByRole('button', { name: 'Xem xét gói' }));
    for (const name of ['Duyệt gói', 'Từ chối', 'Yêu cầu sửa']) expect(await inMain().findByRole('button', { name })).toBeTruthy();
    expect(marked('DecisionReview')).toHaveLength(1);
    expect(where).toBe('/projects/p/review');
  } },
  { row: 19, name: 'user decision with options: DecisionReview from the rail', go: async () => {
    const d = WebDecisionSchema.parse({ ...decision, kind: 'user_decision', options: ['Phương án A', 'Phương án B'] });
    await mount('/projects/p', { '/api/v1/projects/p/decisions': { apiVersion: 1, items: [d] }, [RUN]: runWith({ decisions: [d], availableActions: [decide] }) });
    await rail(/^Quyết định/);
    await waitFor(() => expect((inMain().getByRole('button', { name: 'Xem xét gói' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(inMain().getByRole('button', { name: 'Xem xét gói' }));
    expect(await inMain().findByRole('option', { name: 'Phương án A' })).toBeTruthy();
    expect(inMain().getByRole('option', { name: 'Phương án B' })).toBeTruthy();
    expect(marked('DecisionReview')).toHaveLength(1);
  } },
  { row: 20, name: 'an effective approval is listed under "Đã có hiệu lực" in RunView', go: async () => {
    const approved = WebDecisionSchema.parse({ ...decision, status: 'approved' });
    await openRunViaRail({ decisions: [approved] });
    expect(await inMain().findByRole('heading', { name: 'Đã có hiệu lực' })).toBeTruthy();
    expect(inMain().getByText(approved.question.slice(0, 12), { exact: false })).toBeTruthy();
    expect(marked('RunView')).toHaveLength(1);
    // Nothing is left to decide: the review component is not rendered.
    expect(marked('DecisionReview')).toHaveLength(0);
  } },
  { row: 21, name: 'evidence: the document cabinet uses the same inert Evidence component', note: 'Entry: HUD rail "Tài liệu" (cabinet inspector)', go: async () => {
    const d = WebDecisionSchema.parse({ ...decision, evidence: [evidenceRef] });
    await mount('/projects/p', { '/api/v1/projects/p/decisions': { apiVersion: 1, items: [d] } });
    await rail('Tài liệu');
    const cabinet = await screen.findByLabelText('Tủ tài liệu');
    expect(cabinet.querySelectorAll('section.evidence')).toHaveLength(1);
    expect(marked('Evidence', cabinet)).toHaveLength(1);
    expect(within(cabinet).getByRole('button', { name: 'Đọc nội dung an toàn' })).toBeTruthy();
  } },
  { row: 22, name: 'revise request: RequestForm from RunActions in RunView', go: async () => {
    await openRunViaRail({ availableActions: [revise] });
    fireEvent.click(await inMain().findByRole('button', { name: 'Chỉnh yêu cầu' }));
    expect(await inMain().findByRole('button', { name: 'Gửi chỉnh sửa' })).toBeTruthy();
    const form = marked('RequestForm');
    expect(form).toHaveLength(1);
    expect(insideOf(form[0]!, 'RunView')).toBe(true);
    expect(marked('RunActions')).toHaveLength(1);
  } },
  { row: 23, name: 'resume follows availableActions', go: async () => {
    await openRunViaRail({ availableActions: [{ ...resume, enabled: false, disabledReason: 'approval_required' }] });
    const disabled = await inMain().findByRole('button', { name: 'Tiếp tục' });
    expect((disabled as HTMLButtonElement).disabled).toBe(true);
    expect(marked('RunActions')).toHaveLength(1);
    cleanup();
    await openRunViaRail({ availableActions: [resume] });
    await waitFor(async () => expect(((await inMain().findByRole('button', { name: 'Tiếp tục' })) as HTMLButtonElement).disabled).toBe(false));
  } },
  { row: 24, name: 'cancel needs confirmation and a reason', go: async () => {
    const api = await openRunViaRail({ availableActions: [cancel] });
    fireEvent.click(await inMain().findByRole('button', { name: 'Hủy công việc' }));
    expect(await inMain().findByLabelText('Lý do hủy')).toBeTruthy();
    expect(marked('RunActions')).toHaveLength(1);
    fireEvent.click(inMain().getByRole('button', { name: 'Gửi yêu cầu hủy' }));
    expect((await inMain().findByRole('alert')).textContent).toContain('lý do');
    expect(posts(api)).toHaveLength(0);
  } },
  { row: 25, name: 'operations dock renders in the HUD, not the panel', go: async () => {
    localStorage.setItem('bflow:web:operations:p:unpaired:create', '{broken');
    await mount();
    const bar = await screen.findByRole('region', { name: 'Thanh điều khiển' });
    await waitFor(() => expect(within(bar).getAllByRole('alert').length).toBeGreaterThan(0));
    expect(main().querySelector('[role="alert"]')).toBeNull();
  } },
  { row: 26, name: 'a corrupt recovery code can be cleared from the dock', go: async () => {
    localStorage.setItem('bflow:web:operations:p:unpaired:create', '{broken');
    await mount();
    const bar = await screen.findByRole('region', { name: 'Thanh điều khiển' });
    fireEvent.click(await within(bar).findByRole('button', { name: 'Xóa mã phục hồi bị hỏng' }));
    await waitFor(() => expect(localStorage.getItem('bflow:web:operations:p:unpaired:create')).toBeNull());
  } },
  { row: 27, name: 'chat: the counter object and the HUD chat bar open ChatPage', go: async () => {
    const api = await mount();
    await mirror(/Quầy Conversation/);
    expect(await screen.findByLabelText('Trò chuyện theo công việc')).toBeTruthy();
    expect(marked('ChatPage')).toHaveLength(1);
    expect(where).toBe('/projects/p/chat');
    fireEvent.click(screen.getByRole('button', { name: 'probe-back' }));
    await waitFor(() => expect(where).toBe('/projects/p'));
    // The HUD bar hands over a draft and sends nothing.
    const bar = screen.getByLabelText('Trò chuyện với Bflow') as HTMLInputElement;
    await waitFor(() => expect(bar.disabled).toBe(false));
    fireEvent.change(bar, { target: { value: 'Xin chào' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mở trò chuyện với nội dung này' }));
    await waitFor(() => expect(where).toBe('/projects/p/chat'));
    expect(marked('ChatPage')).toHaveLength(1);
    expect(posts(api)).toHaveLength(0);
  } },
  { row: 28, name: 'chat unavailable: the HUD bar is disabled and ChatPage says so', go: async () => {
    await mount('/projects/p', { '/api/v1/projects/p/session': { ...ready, blockers: [{ code: 'chat_adapter_unavailable', message: 'Chat adapter unavailable' }] } });
    const bar = await screen.findByLabelText('Trò chuyện với Bflow') as HTMLInputElement;
    await waitFor(() => expect(bar.disabled).toBe(true));
    expect(bar.placeholder).toBe('Chưa trò chuyện được lúc này');
    await rail('Trò chuyện');
    fireEvent.click(await inMain().findByRole('link', { name: /Tìm sách nhanh hơn/ }));
    expect(await inMain().findByText(/Trò chuyện qua web chưa sẵn sàng/)).toBeTruthy();
    expect(marked('ChatPage')).toHaveLength(1);
  } },
  { row: 29, name: 'connection state is shown in the HUD pill', note: 'The HUD pill uses the ConnectionBanner wording (shared connectionText)', go: async () => {
    const api = await mount();
    const pill = await screen.findByLabelText('Trạng thái văn phòng');
    await waitFor(() => expect(api.handlers.has('open')).toBe(true));
    api.handlers.get('open')!(new Event('open'));
    await waitFor(() => expect(pill.textContent).toContain('Trực tiếp: đã kết nối'));
    api.handlers.get('error')!(new Event('error'));
    await waitFor(() => expect(pill.textContent).toContain('Trình duyệt: đang kết nối lại'));
  } },
  { row: 30, name: 'reload data: the rail button re-reads', go: async () => {
    const api = await mount();
    await screen.findByRole('navigation', { name: 'Lối tắt' });
    await waitFor(() => expect(api.fetcher.mock.calls.some(c => String(c[0]).includes('/runs?limit=25'))).toBe(true));
    const count = (): number => api.fetcher.mock.calls.filter(c => String(c[0]).includes('/session') && String(c[0]).includes('/projects/p/')).length;
    const before = count();
    await rail('Tải lại dữ liệu');
    await waitFor(() => expect(count()).toBeGreaterThan(before));
  } },
  { row: 31, name: 'read problems in the panel (ReadProblems) with a retry', go: async () => {
    await mount('/projects/p', { '/api/v1/projects/p/runs?limit=25': undefined });
    await rail('Tổng quan');
    expect((await inMain().findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(marked('ReadProblems')).toHaveLength(1);
    expect(inMain().getAllByText('Chưa tải được dữ liệu').length).toBeGreaterThan(0);
    expect(inMain().getByRole('button', { name: 'Thử tải lại' })).toBeTruthy();
  } },
  { row: 32, name: 'recent activity is a disclosure in Overview', go: async () => {
    const api = await mount();
    await rail('Tổng quan');
    expect(await inMain().findByText(/Hoạt động gần đây \(0\)/)).toBeTruthy();
    await waitFor(() => expect(api.handlers.has('invalidate')).toBe(true));
    api.handlers.get('invalidate')!({ type: 'invalidate', lastEventId: '', data: JSON.stringify({ apiVersion: 1, cursor: 'e:1', projectId: 'p', type: 'invalidate', resourceIds: [], occurredAt: now }) } as unknown as Event);
    expect(await inMain().findByText(/Hoạt động gần đây \(1\)/)).toBeTruthy();
  } },
  { row: 33, name: 'technical details and diagnostics in RunView', go: async () => {
    await openRunViaRail();
    expect(await inMain().findByText('Chi tiết kỹ thuật & chẩn đoán thực thi')).toBeTruthy();
    expect(marked('RunView')).toHaveLength(1);
  } },
  { row: 34, name: 'deep link and Back/Forward keep the URL as the single source of truth (the one dedicated deep-link row)', go: async () => {
    await mount('/projects/p/runs/run');
    expect(await inMain().findByRole('heading', { level: 1, name: 'Tìm sách nhanh hơn' })).toBeTruthy();
    expect(panelOpen()).toBe(true);
    await rail('Cài đặt');
    await waitFor(() => expect(where).toBe('/projects/p/settings'));
    fireEvent.click(screen.getByRole('button', { name: 'probe-back' }));
    await waitFor(() => expect(where).toBe('/projects/p/runs/run'));
    expect(await inMain().findByRole('heading', { level: 1, name: 'Tìm sách nhanh hơn' })).toBeTruthy();
  } },
];

test('the table covers exactly rows 1 to 34 once', () => { expect(rows.map(r => r.row)).toEqual(Array.from({ length: 34 }, (_, i) => i + 1)); });
test.each(rows.map(r => [r.row, r.name, r] as const))('parity row %i: %s', async (_row, _name, r) => {
  await r.go();
  // Every row that stays in the project proves 3D is what rendered it: the HUD rail and the DOM mirror are there, with the scene host (or its fallback list).
  if (!r.leavesScene) {
    expect(screen.getByRole('navigation', { name: 'Lối tắt' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Bản văn bản của văn phòng' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Văn phòng Bflow' })).toBeTruthy();
    expect(localStorage.getItem(MODE_KEY)).toBe('visual');
  }
}, 20000);

// §8.3 "unknown_delivery": the scene never walks for an uncertain delivery; it asks a question and the mirror says "chưa xác định".
test('unknown_delivery reaches the renderer as a question cue and never as a walk', async () => {
  const handoff = (state: OfficeHandoff['state']): OfficeHandoff => ({ handoffId: 'h1', ordinal: 1, direction: 'outbound', state, fromInstanceId: 'a', toInstanceId: 'b', fromRole: 'coordinator', toRole: 'developer' });
  const model = (state: OfficeHandoff['state']): OfficeModel => ({ tier: 'full', certainty: 'confirmed', statusText: '', pendingDecisions: 0, connection: 'connected', tasks: [], handoffs: [handoff(state)],
    agents: [{ instanceId: 'a', label: 'Điều phối', role: 'coordinator', pose: 'question', certainty: 'unknown', statusText: 'Chưa xác định việc đã tới', seat: 'coordination:coordinator' }, { instanceId: 'b', label: 'Developer #1', role: 'developer', pose: 'sleeping', certainty: 'inferred', statusText: 'Rảnh', seat: 'developer:1' }] });
  const apply = vi.fn((_m: OfficeModel, cues: VisualCue[]) => cues.filter(c => c.kind === 'walk').map(c => c.handoffId));
  const create: CreateRenderer = async () => ({ apply, setPaused: vi.fn(), destroy: vi.fn() });
  const view = render(<OfficeStage model={model('sending')} onSelect={() => undefined} createRenderer={create} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  view.rerender(<OfficeStage model={model('unknown_delivery')} onSelect={() => undefined} createRenderer={create} />);
  const cues = apply.mock.calls.at(-1)![1];
  expect(cues.map(c => c.kind)).toEqual(['question']);
  expect(cues.some(c => c.kind === 'walk')).toBe(false);
  expect(screen.getByRole('button', { name: /Chưa xác định việc đã tới\. Mức tin cậy: Chưa xác định/ })).toBeTruthy();
});

// Hostile text from the backend (project name, run title, agent name) is only ever text: in the HUD, the mirror and the inspector.
test('hostile displayName and run title stay inert text in the HUD, the mirror and the inspector', async () => {
  const hostile = '<img src=x onerror=alert(1)>', script = '<script>alert(2)</script><b>x</b>';
  const r = runWith({ title: script });
  const agent = WebAgentViewSchema.parse({ instanceId: 'dev-1', role: 'developer', displayName: hostile, permanent: false, provider: 'claude', allocation: 'active', transport: { state: 'idle', observedAt: now }, boundAt: now,
    work: [{ messageId: 'm1', kind: 'assignment', runId: 'run', taskId: 'task', delivery: 'accepted' }] });
  const workforce = { apiVersion: 1, projectId: 'p', sessionId: 'host-session', revisionToken: 'w1', truncated: false, observedAt: now, agents: [agent], handoffs: [] };
  const list = { apiVersion: 1, items: [r] };
  await mount('/projects/p', { '/api/v1/projects': { apiVersion: 1, items: [{ ...projectFixture, displayName: hostile }] }, '/api/v1/projects/p/workforce': workforce, [RUN]: r, '/api/v1/projects/p/runs?limit=25': list, '/api/v1/projects/p/runs/run/activity': { apiVersion: 1, items: [] } });
  // HUD: the card shows the run title and the select shows the project name, both literally.
  const card = await screen.findByRole('region', { name: 'Văn phòng Bflow' });
  await waitFor(() => expect(within(card).getByText(script)).toBeTruthy());
  expect(within(card).getByRole('option', { name: hostile })).toBeTruthy();
  // Mirror and inspector: the agent entry and its inspector heading name are text too.
  const mirrorRegion = screen.getByRole('region', { name: 'Bản văn bản của văn phòng' });
  const entry = await within(mirrorRegion).findByRole('button', { name: /\(Lập trình viên\)/ });
  fireEvent.click(entry);
  expect(await within(main()).findByText(hostile)).toBeTruthy();
  expect(document.body.querySelector('img[src="x"], script, b, [onerror]')).toBeNull();
});
