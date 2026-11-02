import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/app';
import { ApiClient } from '../src/api/client';
import { writeMode } from '../src/features/office/mode';
import { OfficeHud, agentCounts, chatAvailable, currentRun, type OfficeHudProps } from '../src/features/office/ui/OfficeHud';
import type { OfficeAgent, OfficeModel } from '../src/features/office/model/types';
import { WebProjectSessionSchema, type WebProjectSession } from '@bflow/contracts/web';
import { installApi, now, run, session } from './fixtures';

const ready: WebProjectSession = WebProjectSessionSchema.parse({ ...session, state: 'ready', sessionId: 'host-session' });
const agent = (instanceId: string, pose: OfficeAgent['pose'], role: OfficeAgent['role'] = 'developer'): OfficeAgent => ({ instanceId, label: instanceId, role, pose, certainty: 'confirmed', statusText: '' });
const model = (agents: OfficeAgent[], pendingDecisions = 0): OfficeModel => ({ tier: 'full', certainty: 'confirmed', statusText: '', agents, tasks: [], pendingDecisions, handoffs: [], connection: 'connected' });
function props(over: Partial<OfficeHudProps> = {}): OfficeHudProps {
  return {
    projectName: 'Vườn sách', projects: [{ projectId: 'p', displayName: 'Vườn sách' }, { projectId: 'q', displayName: 'Kho phim' }], projectId: 'p', onProject: vi.fn(), failed: false, authRequired: false, onDocuments: vi.fn(), session: ready, model: model([agent('a', 'working'), agent('b', 'typing'), agent('c', 'sleeping'), agent('d', 'hand_raised')], 2), runs: [run], connection: 'connected', stale: false, mode: 'visual', onMode: vi.fn(), panelOpen: false,
    overflow: 0, onOverview: vi.fn(), onNavigate: vi.fn(), onRefresh: vi.fn(), onFocusZone: vi.fn(), onAgentList: vi.fn(), onChatDraft: vi.fn(), dock: null, ...over,
  };
}
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_k: string, cb: () => unknown) => cb() } }); localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

test('status counts come from derived poses and never from Herdr done', () => {
  expect(agentCounts(model([agent('a', 'working'), agent('b', 'typing'), agent('c', 'sleeping'), agent('d', 'ghost'), agent('e', 'disconnected')]))).toEqual(['2 đang làm', '1 rảnh', '1 mất kết nối', '1 chưa rõ']);
  expect(agentCounts({ ...model([agent('a', 'ghost')]), tier: 'degraded' })).toEqual([]);
  expect(agentCounts(undefined)).toEqual([]);
});

test('the card shows the current run, the pill shows session, connection and counts, and stale data is labelled', () => {
  const { rerender } = render(<OfficeHud {...props()} />);
  expect(screen.getByRole('heading', { name: 'Bflow Office' })).toBeTruthy();
  expect(screen.getByText('Vườn sách')).toBeTruthy();
  const card = screen.getByRole('region', { name: 'Văn phòng Bflow' });
  expect(within(card).getByText('Đang làm')).toBeTruthy();
  expect(within(card).getByText('Tìm sách nhanh hơn')).toBeTruthy();
  expect(within(card).getByText(/Triển khai/)).toBeTruthy();
  const pill = screen.getByLabelText('Trạng thái văn phòng');
  expect(pill.textContent).toContain('Phiên sẵn sàng');
  expect(pill.textContent).toContain('Đã kết nối');
  expect(pill.textContent).toContain('2 đang làm · 1 đang chờ · 1 rảnh');
  expect(screen.queryByText('Dữ liệu cũ')).toBeNull();
  rerender(<OfficeHud {...props({ stale: true, connection: 'reconnecting', runs: [] })} />);
  expect(screen.getByText('Dữ liệu cũ')).toBeTruthy();
  expect(screen.getByText('Đang kết nối lại')).toBeTruthy();
  expect(screen.getByText('Chưa có công việc đang chạy')).toBeTruthy();
});

test('project switcher, failed and re-pair states, and the Tài liệu button', () => {
  const p = props({ model: { ...model([]), tier: 'degraded' }, failed: true, authRequired: true });
  render(<OfficeHud {...p} />);
  fireEvent.change(screen.getByLabelText('Chuyển dự án'), { target: { value: 'q' } });
  expect(p.onProject).toHaveBeenCalledWith('q');
  const pill = screen.getByLabelText('Trạng thái văn phòng');
  expect(pill.textContent).toContain('Không đọc được dữ liệu nhân viên');
  expect(pill.textContent).toContain('Cần ghép nối lại');
  expect(pill.textContent).not.toContain('Dữ liệu cũ');
  fireEvent.click(screen.getByRole('button', { name: 'Tài liệu' }));
  expect(p.onDocuments).toHaveBeenCalled();
  cleanup();
  render(<OfficeHud {...props({ model: { ...model([]), tier: 'degraded' } })} />);
  expect(screen.getByLabelText('Trạng thái văn phòng').textContent).toContain('Chưa có dữ liệu nhân viên');
});

test('Classic | 3D switch, right rail with the decision badge, and refresh', () => {
  const p = props();
  render(<OfficeHud {...p} />);
  const group = screen.getByRole('group', { name: 'Chế độ hiển thị' });
  expect(within(group).getByRole('button', { name: '3D' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(within(group).getByRole('button', { name: 'Classic' }));
  expect(p.onMode).toHaveBeenCalledWith('classic');
  fireEvent.click(within(group).getByRole('button', { name: '3D' }));
  expect(p.onMode).toHaveBeenCalledTimes(1);
  const rail = within(screen.getByRole('navigation', { name: 'Lối tắt' }));
  expect(rail.getAllByRole('button').map(b => b.textContent?.replace(/Đang chờ: /, ''))).toEqual(['Tổng quan', 'Công việc', 'Quyết định2', 'Trò chuyện', 'Tài liệu', 'Cài đặt', 'Tải lại dữ liệu']);
  fireEvent.click(rail.getByRole('button', { name: /Quyết định/ }));
  expect(p.onNavigate).toHaveBeenCalledWith('review');
  fireEvent.click(rail.getByRole('button', { name: 'Tổng quan' }));
  expect(p.onOverview).toHaveBeenCalled();
  fireEvent.click(rail.getByRole('button', { name: 'Tải lại dữ liệu' }));
  expect(p.onRefresh).toHaveBeenCalled();
});

test('camera buttons ask the scene for their zone and the overflow chip opens the agent list', () => {
  const p = props({ overflow: 3 });
  render(<OfficeHud {...p} />);
  const cams = within(screen.getByRole('group', { name: 'Góc nhìn camera' }));
  for (const [name, zone] of [['Toàn cảnh', 'overview'], ['Conversation', 'conversation'], ['Coordinator', 'coordinator'], ['Developer', 'developer'], ['QA', 'qa']] as const) {
    fireEvent.click(cams.getByRole('button', { name }));
    expect(p.onFocusZone).toHaveBeenLastCalledWith(zone);
  }
  fireEvent.click(cams.getByRole('button', { name: /Còn 3 lập trình viên/ }));
  expect(p.onAgentList).toHaveBeenCalled();
  cleanup();
  render(<OfficeHud {...props()} />);
  expect(screen.queryByRole('button', { name: /Còn \d+ lập trình viên/ })).toBeNull();
});

test('chat bar hands the draft over once, trimmed, and is disabled when chat is unavailable', () => {
  const p = props();
  const { rerender } = render(<OfficeHud {...p} />);
  const input = screen.getByLabelText('Trò chuyện với Bflow') as HTMLInputElement;
  expect(input.placeholder).toBe('Trò chuyện với Bflow...');
  const send = screen.getByRole('button', { name: /Mở trò chuyện/ }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.change(input, { target: { value: '  Thêm ô tìm kiếm  ' } });
  expect(send.disabled).toBe(false);
  fireEvent.submit(input.closest('form')!);
  expect(p.onChatDraft).toHaveBeenCalledTimes(1);
  expect(p.onChatDraft).toHaveBeenCalledWith('Thêm ô tìm kiếm');
  expect(input.value).toBe('');
  rerender(<OfficeHud {...props({ session: { ...ready, blockers: [{ code: 'chat_adapter_unavailable', message: 'x' }] } })} />);
  expect((screen.getByLabelText('Trò chuyện với Bflow') as HTMLInputElement).disabled).toBe(true);
  expect(chatAvailable({ ...ready, state: 'stopped' } as never)).toBe(false);
  expect(chatAvailable(undefined)).toBe(false);
});

test('on a phone with the panel open only the operations dock stays in the HUD', () => {
  render(<OfficeHud {...props({ panelOpen: true, dock: <section aria-label="Theo dõi thao tác">dock</section> })} />);
  expect(screen.getByRole('region', { name: 'Theo dõi thao tác' })).toBeTruthy();
  expect(screen.getByRole('navigation', { name: 'Lối tắt' }).className).toContain('max-md:hidden');
  expect(screen.getByLabelText('Trò chuyện với Bflow').closest('form')!.parentElement!.className).toContain('max-md:hidden');
});

test('currentRun skips finished runs and prefers the latest update', () => {
  const r = (runId: string, sdlcStatus: string, updatedAt: string) => ({ ...run, runId, sdlcStatus, updatedAt }) as typeof run;
  expect(currentRun([r('a', 'completed', '2026-11-02T00:00:09Z'), r('b', 'planning', '2026-11-01T00:00:00Z'), r('c', 'implementing', '2026-11-02T00:00:00Z')])?.runId).toBe('c');
  expect(currentRun([r('a', 'failed', now)])).toBeUndefined();
});

test('3D chat bar opens /chat with the draft, prefills the composer and sends nothing', async () => {
  writeMode('visual');
  const { fetcher } = installApi({ '/api/v1/projects/p/session': ready, '/api/v1/projects/p/sessions/host-session/messages': { apiVersion: 1, items: [] } });
  render(<MemoryRouter initialEntries={['/projects/p']}><App api={new ApiClient()} /></MemoryRouter>);
  const input = await screen.findByLabelText('Trò chuyện với Bflow');
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(input, { target: { value: 'Thêm ô tìm kiếm <b>nhanh</b>' } });
  fireEvent.submit(input.closest('form')!);
  expect(await screen.findByText(/Bản nháp chưa gửi: Thêm ô tìm kiếm <b>nhanh<\/b>/)).toBeTruthy();
  expect(document.getElementById('main')!.querySelector('b')).toBeNull();
  const main = within(document.getElementById('main')!);
  fireEvent.click(await main.findByRole('link', { name: /Tìm sách nhanh hơn/ }));
  await waitFor(() => expect(document.getElementById('chat-draft')).not.toBeNull());
  expect((document.getElementById('chat-draft') as HTMLTextAreaElement).value).toBe('Thêm ô tìm kiếm <b>nhanh</b>');
  expect((fetcher.mock.calls as unknown[][]).some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
});
