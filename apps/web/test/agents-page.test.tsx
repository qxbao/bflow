import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WebAgentViewSchema } from '@bflow/contracts/web';
import { ApiClient } from '../src/api/client';
import { AgentsPage, AgentTranscript } from '../src/features/agents';
import { installApi, now } from './fixtures';

const agent = (instanceId: string, role: string, work: unknown[] = []) => WebAgentViewSchema.parse({ instanceId, role, displayName: `Tên ${instanceId}`, permanent: false, provider: 'claude', allocation: 'active', transport: { state: 'idle', observedAt: now }, boundAt: now, work });
const work = [{ messageId: 'm1', kind: 'assignment', runId: 'run', delivery: 'accepted' }];
const workforce = { apiVersion: 1, projectId: 'p', sessionId: 's', revisionToken: 'w', truncated: false, observedAt: now, handoffs: [], agents: [agent('a-1', 'coordinator'), agent('dev-1', 'developer', work)] };
const transcript = (instanceId: string, text: string, truncated = false) => ({ apiVersion: 1, projectId: 'p', sessionId: 's', instanceId, source: 'terminal_snapshot', text, truncated, observedAt: now });
const T = (id: string) => `/api/v1/projects/p/agents/${id}/transcript`;
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_k: string, cb: () => unknown) => cb() } }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const page = (entry = '/projects/p/agents') => render(<MemoryRouter initialEntries={[entry]}><AgentsPage api={new ApiClient()} id="p" revision={0} /></MemoryRouter>);

test('lists agents and defaults to the first with open work; the query selects another', async () => {
  installApi({ '/api/v1/projects/p/workforce': workforce, [T('dev-1')]: transcript('dev-1', 'dev log'), [T('a-1')]: transcript('a-1', 'coord log') });
  page();
  expect(await screen.findByText('dev log')).toBeTruthy();
  expect(screen.getByText(/Điều phối viên · Rảnh · 0 việc đang giữ/)).toBeTruthy();
  expect(screen.getByText(/Lập trình viên · Rảnh · 1 việc đang giữ/)).toBeTruthy();
  cleanup();
  page('/projects/p/agents?agent=a-1');
  expect(await screen.findByText('coord log')).toBeTruthy();
});

test('transcript is inert text with a focusable log', async () => {
  const hostile = '<img src=x onerror=alert(1)> **bold**';
  installApi({ [T('dev-1')]: transcript('dev-1', hostile, true) });
  const { container } = render(<AgentTranscript api={new ApiClient()} projectId="p" instanceId="dev-1" />);
  const log = await screen.findByRole('log');
  expect(log.textContent).toBe(hostile);
  expect(log.tabIndex).toBe(0);
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText(/Chỉ hiện phần cuối/)).toBeTruthy();
  expect(screen.getByText(/đã che thông tin nhạy cảm/)).toBeTruthy();
});

test('polls every 5 s without overlapping and stops on unmount', async () => {
  vi.useFakeTimers();
  const { fetcher } = installApi({ [T('dev-1')]: transcript('dev-1', 'x') });
  const count = () => fetcher.mock.calls.filter(c => c[0] === T('dev-1')).length;
  const { unmount } = render(<AgentTranscript api={new ApiClient()} projectId="p" instanceId="dev-1" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(count()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(count()).toBe(2);
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(count()).toBe(2);
});

test('unsupported server and empty transcript have their own states', async () => {
  installApi({});
  render(<AgentTranscript api={new ApiClient()} projectId="p" instanceId="dev-1" />);
  expect(await screen.findByText('Máy chủ chưa cung cấp nội dung của nhân viên này.')).toBeTruthy();
  cleanup();
  installApi({ [T('dev-1')]: transcript('dev-1', '  ') });
  render(<AgentTranscript api={new ApiClient()} projectId="p" instanceId="dev-1" />);
  expect(await screen.findByText('Nhân viên chưa có nội dung nào.')).toBeTruthy();
});

test('a failed refresh keeps the last good text and says it cannot tell if the agent is idle', async () => {
  vi.useFakeTimers();
  const { fetcher } = installApi({ [T('dev-1')]: transcript('dev-1', 'last good') });
  render(<AgentTranscript api={new ApiClient()} projectId="p" instanceId="dev-1" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(screen.getByRole('log').textContent).toBe('last good');
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ apiVersion: 1, code: 'unavailable', message: 'x', retryable: true, correlationId: 'c' }), { status: 503 }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
  expect(screen.getByRole('log').textContent).toBe('last good');
  expect(screen.getByText('Chưa đọc được nội dung. Điều này không cho biết nhân viên đang rảnh.')).toBeTruthy();
});

test('page shows the unsupported-workforce state', async () => {
  installApi({});
  page();
  await waitFor(() => expect(screen.getByText('Chưa có dữ liệu nhân viên')).toBeTruthy());
});

test('switching agent never shows the previous agent text under the new heading', async () => {
  const { fetcher } = installApi({ '/api/v1/projects/p/workforce': workforce, [T('dev-1')]: transcript('dev-1', 'dev log') });
  page();
  expect(await screen.findByText('dev log')).toBeTruthy();
  const previous = screen.getByRole('region', { name: 'Nội dung gần đây của nhân viên' });
  // The next agent's transcript never answers: its pane must start empty instead of keeping 'dev log'.
  fetcher.mockImplementation(async (input: string) => input.includes('/workforce') ? new Response(JSON.stringify(workforce)) : new Promise<Response>(() => {}));
  fireEvent.click(screen.getByRole('button', { name: /Tên a-1/ }));
  expect(await screen.findByRole('heading', { level: 3, name: 'Tên a-1' })).toBeTruthy();
  expect(screen.queryByText('dev log')).toBeNull();
  // A keyed transcript is a fresh component, so no commit shows the previous agent's text under the new heading.
  expect(previous.isConnected).toBe(false);
});
