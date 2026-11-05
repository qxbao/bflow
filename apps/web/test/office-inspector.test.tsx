import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WebAgentViewSchema, WebHandoffViewSchema, WebProjectSessionSchema } from '@bflow/contracts/web';
import { App } from '../src/app';
import { ApiClient } from '../src/api/client';
import { writeMode } from '../src/features/office/mode';
import { AgentInspector, AgentList, handoffEvidence } from '../src/features/office/ui/AgentInspector';
import { CabinetInspector } from '../src/features/office/ui/ObjectInspector';
import type { OfficeAgent } from '../src/features/office/model/types';
import { installApi, now, run, session } from './fixtures';

const view = WebAgentViewSchema.parse({ instanceId: 'dev-1', role: 'developer', displayName: 'Dev <b>một</b>', permanent: false, provider: 'claude', model: 'opus-x', allocation: 'active', transport: { state: 'idle', observedAt: now }, boundAt: now,
  work: [{ messageId: 'm1', kind: 'assignment', runId: 'run', taskId: 'task', delivery: 'accepted' }] });
const agent: OfficeAgent = { instanceId: 'dev-1', label: 'Developer #1', role: 'developer', pose: 'working', certainty: 'inferred', statusText: 'Có dấu hiệu đang chạy', observedAt: '2026-11-02T00:00:00.000Z', runId: 'run', taskId: 'task' };
const evidenceRef = { artifactId: 'artifact-1', runId: 'run', kind: 'test-result', mediaType: 'text/plain', checksum: { algorithm: 'sha256', value: 'a'.repeat(64) } };
const handoff = WebHandoffViewSchema.parse({ handoffId: 'h1', ordinal: 0, runId: 'run', messageType: 'assignment', direction: 'outbound', from: { role: 'coordinator', instanceId: 'c1' }, to: { role: 'developer', instanceId: 'dev-1' }, state: 'accepted', evidence: [evidenceRef] });
const entry = (action: string, outcome: string) => ({ entryId: '6f1f1d7e-3b1a-4c53-9a58-0d2f5d6a7b01', occurredAt: now, kind: 'handoff', role: 'developer', action, runId: 'run', outcome });
const ready = WebProjectSessionSchema.parse({ ...session, state: 'ready', sessionId: 'host-session' });

function mount(activity: unknown, handoffs = [handoff]) {
  installApi({ '/api/v1/projects/p/runs/run/activity': activity });
  return render(<MemoryRouter><AgentInspector api={new ApiClient()} projectId="p" agent={agent} view={view} handoffs={handoffs} revision={0} titleOf={(_r, t) => (t === 'task' ? 'Thêm bộ lọc sách' : 'x')} /></MemoryRouter>);
}
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_k: string, cb: () => unknown) => cb() } }); localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

test('shows certainty and observed time as text', async () => {
  mount({ apiVersion: 1, items: [] });
  expect(screen.getByRole('heading', { name: 'Developer #1' })).toBeTruthy();
  const certainty = screen.getByText('Mức tin cậy').nextElementSibling!;
  expect(certainty.textContent).toBe('Suy luận');
  const observed = screen.getByText('Quan sát lúc').nextElementSibling!.querySelector('time')!;
  expect(observed.getAttribute('datetime')).toBe(agent.observedAt);
  expect(observed.textContent).toMatch(/\d/);
  for (const text of ['Lập trình viên', 'claude', 'opus-x', 'Thêm bộ lọc sách']) expect(screen.getAllByText(new RegExp(text)).length).toBeGreaterThan(0);
  await screen.findByText(/Chưa có hoạt động nào/);
});

test('activity text renders as text node only', async () => {
  const { container } = mount({ apiVersion: 1, items: [entry('<img src=x onerror=alert(1)>', '<b>xong</b>')] });
  expect(await screen.findByText(/<img src=x onerror=alert\(1\)>: <b>xong<\/b>/)).toBeTruthy();
  expect(container.querySelector('img, b')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Hoạt động gần đây (chẩn đoán, có thể thiếu)' })).toBeTruthy();
  // The display name is text too.
  expect(screen.getByText('Dev <b>một</b>')).toBeTruthy();
  expect(container.querySelector('b')).toBeNull();
});

test('evidence uses existing Evidence component', async () => {
  const { container } = mount({ apiVersion: 1, items: [] });
  const sections = container.querySelectorAll('section.evidence');
  expect(sections).toHaveLength(1);
  expect(within(sections[0] as HTMLElement).getByRole('button', { name: 'Đọc nội dung an toàn' })).toBeTruthy();
  expect(handoffEvidence([handoff, handoff], 'dev-1').map(e => e.artifactId)).toEqual(['artifact-1']);
  expect(handoffEvidence([handoff], 'nobody')).toEqual([]);
  await screen.findByText(/Chưa có hoạt động nào/);
});

test('inspector offers navigation, never a mutation button of its own', async () => {
  const { container } = mount({ apiVersion: 1, items: [] });
  await screen.findByText(/Chưa có hoạt động nào/);
  expect(screen.getByRole('link', { name: /Xem công việc/ }).getAttribute('href')).toBe('/projects/p/runs/run');
  expect(screen.getByRole('link', { name: /Mở trò chuyện/ }).getAttribute('href')).toBe('/projects/p/chat/run');
  // The only buttons are the reused read-only Evidence controls.
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) expect(b.closest('section.evidence'), b.textContent ?? '').not.toBeNull();
  expect(container.querySelector('form, input, textarea, select')).toBeNull();
});

test('activity lists every line of the run with its role and says it is not per agent', async () => {
  mount({ apiVersion: 1, items: [entry('đã giao', 'ok'), { ...entry('đã nhận', 'ok'), entryId: '6f1f1d7e-3b1a-4c53-9a58-0d2f5d6a7b02', role: 'coordinator' }] });
  expect(await screen.findByText(/Điều phối viên/)).toBeTruthy();
  expect(screen.getAllByText(/Lập trình viên/).length).toBeGreaterThan(0);
  expect(screen.getByText(/không riêng nhân viên này/)).toBeTruthy();
});

test('activity that cannot be read is said so and never read as idle', async () => {
  installApi({});
  render(<MemoryRouter><AgentInspector api={new ApiClient()} projectId="p" agent={agent} view={view} handoffs={[]} revision={0} titleOf={() => 'x'} /></MemoryRouter>);
  expect(await screen.findByText(/Máy chủ chưa cung cấp nhật ký hoạt động/)).toBeTruthy();
});

test('the unseated list picks an agent and the cabinet lists evidence of the run', () => {
  const onPick = vi.fn();
  const { unmount } = render(<AgentList title="Chưa hiện" agents={[agent]} onPick={onPick} />);
  fireEvent.click(screen.getByRole('button', { name: /Developer #1/ }));
  expect(onPick).toHaveBeenCalledWith('dev-1');
  unmount();
  installApi({});
  const { container } = render(<CabinetInspector api={new ApiClient()} projectId="p" run={run} evidence={[evidenceRef as never]} />);
  expect(container.querySelectorAll('section.evidence')).toHaveLength(1);
  expect(screen.getByText(/Tìm sách nhanh hơn/)).toBeTruthy();
});

test('selecting in the mirror opens the agent inspector in the panel, and objects navigate', async () => {
  writeMode('visual');
  const wf = { apiVersion: 1, projectId: 'p', sessionId: 'host-session', revisionToken: 'w1', agents: [view, { ...view, instanceId: 'conv', role: 'conversation', displayName: 'Conversation', work: [] }], handoffs: [handoff], truncated: false, observedAt: now };
  installApi({ '/api/v1/projects/p/session': ready, '/api/v1/projects/p/workforce': wf, '/api/v1/projects/p/runs/run/activity': { apiVersion: 1, items: [] } });
  render(<MemoryRouter initialEntries={['/projects/p']}><App api={new ApiClient()} /></MemoryRouter>);
  const mirror = await screen.findByRole('region', { name: 'Bản văn bản của văn phòng' });
  const row = await within(mirror).findByRole('button', { name: /Developer #1/ });
  fireEvent.click(row);
  const main = document.getElementById('main')!;
  expect(await within(main).findByRole('heading', { name: 'Developer #1' })).toBeTruthy();
  expect(main.classList.contains('hidden')).toBe(false);
  fireEvent.click(within(mirror).getByRole('button', { name: /Tủ tài liệu/ }));
  expect(await within(main).findByRole('heading', { name: 'Tủ tài liệu' })).toBeTruthy();
  expect(within(main).queryByRole('heading', { name: 'Developer #1' })).toBeNull();
  fireEvent.click(within(mirror).getByRole('button', { name: /Máy chủ/ }));
  expect(await within(main).findByRole('heading', { name: /Máy chủ \(phiên dự án\)/ })).toBeTruthy();
  fireEvent.click(within(mirror).getByRole('button', { name: /Bảng nhiệm vụ/ }));
  await waitFor(() => expect(within(main).queryByRole('heading', { name: /Máy chủ/ })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Đóng bảng' }));
  await waitFor(() => expect(main.classList.contains('hidden')).toBe(true));
});

test('a refused session opens re-pairing in the panel instead of stale data', async () => {
  writeMode('visual');
  const fetcher = installApi({ '/api/v1/projects/p/session': ready }).fetcher;
  const base = fetcher.getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/workforce') ? new Response(JSON.stringify({ apiVersion: 1, code: 'session_required', message: 'x', retryable: false, correlationId: 't' }), { status: 401 }) : (base as (p: string) => Promise<Response>)(path)));
  render(<MemoryRouter initialEntries={['/projects/p']}><App api={new ApiClient()} /></MemoryRouter>);
  await screen.findByText('Cần ghép nối lại');
  const main = document.getElementById('main')!;
  expect(await within(main).findByLabelText(/Liên kết mở Bflow Web/)).toBeTruthy();
  expect(screen.getByLabelText('Trạng thái văn phòng').textContent).toContain('Cần ghép nối lại');
  // Toàn cảnh closes panels but the re-pair view cannot be dismissed.
  fireEvent.click(screen.getByRole('button', { name: 'Toàn cảnh' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(within(main).getByLabelText(/Liên kết mở Bflow Web/)).toBeTruthy();
  expect(main.classList.contains('hidden')).toBe(false);
});

test('the skip link targets the HUD in 3D', async () => {
  writeMode('visual');
  installApi({ '/api/v1/projects/p/session': ready });
  render(<MemoryRouter initialEntries={['/projects/p']}><App api={new ApiClient()} /></MemoryRouter>);
  await screen.findByRole('region', { name: 'Thanh điều khiển' });
  const skip = screen.getByRole('link', { name: 'Bỏ qua điều hướng' });
  expect(skip.getAttribute('href')).toBe('#office-hud');
  expect(document.getElementById('office-hud')?.getAttribute('tabindex')).toBe('-1');
});

test('an agent that vanishes after the model loaded closes its inspector and returns focus to the HUD', async () => {
  writeMode('visual');
  const wf = (agents: unknown[]) => ({ apiVersion: 1, projectId: 'p', sessionId: 'host-session', revisionToken: 'w1', agents, handoffs: [], truncated: false, observedAt: now });
  const conv = { ...view, instanceId: 'conv', role: 'conversation', displayName: 'Conversation', work: [] };
  let body = wf([view, conv]);
  const { fetcher } = installApi({ '/api/v1/projects/p/session': ready, '/api/v1/projects/p/runs/run/activity': { apiVersion: 1, items: [] } });
  const base = fetcher.getMockImplementation()! as (p: string) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/workforce') ? Response.json(body) : base(path)));
  render(<MemoryRouter initialEntries={['/projects/p']}><App api={new ApiClient()} /></MemoryRouter>);
  const mirror = await screen.findByRole('region', { name: 'Bản văn bản của văn phòng' });
  fireEvent.click(await within(mirror).findByRole('button', { name: /Developer #1/ }));
  const main = () => document.getElementById('main')!;
  expect(await within(main()).findByRole('heading', { name: 'Developer #1' })).toBeTruthy();
  body = wf([conv]);
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Lối tắt' })).getByRole('button', { name: 'Tải lại dữ liệu' }));
  await waitFor(() => expect(main().classList.contains('hidden')).toBe(true));
  expect(within(main()).queryByRole('heading', { name: 'Developer #1' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(document.getElementById('office-hud')));
});

test('the re-pair view does not close on Esc or by button', async () => {
  writeMode('visual');
  const fetcher = installApi({ '/api/v1/projects/p/session': ready }).fetcher;
  const base = fetcher.getMockImplementation()! as (p: string) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/workforce') ? new Response(JSON.stringify({ apiVersion: 1, code: 'session_required', message: 'x', retryable: false, correlationId: 't' }), { status: 401 }) : base(path)));
  render(<MemoryRouter initialEntries={['/projects/p']}><App api={new ApiClient()} /></MemoryRouter>);
  await screen.findByText('Cần ghép nối lại');
  const main = document.getElementById('main')!;
  await within(main).findByLabelText(/Liên kết mở Bflow Web/);
  fireEvent.keyDown(main, { key: 'Escape' });
  expect(main.classList.contains('hidden')).toBe(false);
  expect((screen.getByRole('button', { name: 'Đóng bảng' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(main).getByLabelText(/Liên kết mở Bflow Web/)).toBeTruthy();
});

test('shows the agent terminal text and a link to all staff', async () => {
  installApi({ '/api/v1/projects/p/runs/run/activity': { apiVersion: 1, items: [] }, '/api/v1/projects/p/agents/dev-1/transcript': { apiVersion: 1, projectId: 'p', sessionId: 's', instanceId: 'dev-1', source: 'terminal_snapshot', text: '<b>dòng</b> cuối', truncated: false, observedAt: now } });
  render(<MemoryRouter><AgentInspector api={new ApiClient()} projectId="p" agent={agent} view={view} handoffs={[]} revision={0} titleOf={() => 'x'} /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Nội dung gần đây' })).toBeTruthy();
  expect((await screen.findByRole('log')).textContent).toBe('<b>dòng</b> cuối');
  expect(screen.getByRole('link', { name: 'Xem tất cả nhân viên →' }).getAttribute('href')).toBe('/projects/p/agents?agent=dev-1');
});
