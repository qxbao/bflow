import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/app';
import { ApiClient, ApiError } from '../src/api/client';
import { writeMode } from '../src/features/office/mode';
import { WORKFORCE_POLL_MS, useOfficeModel } from '../src/features/office/ui/useOfficeModel';
import { WebProjectSessionSchema, type WebProjectSession } from '@bflow/contracts/web';
import { decision, installApi, now, run, session } from './fixtures';

const ready: WebProjectSession = WebProjectSessionSchema.parse({ ...session, state: 'ready', sessionId: 'host-session' });
const agent = (instanceId: string, role: string, boundAt: string, extra: object = {}) => ({
  instanceId, role, displayName: instanceId, permanent: role !== 'developer', provider: 'claude', allocation: 'active',
  transport: { state: 'idle', observedAt: now }, boundAt, work: [], ...extra,
});
const workforce = (agents: object[]) => ({ apiVersion: 1, projectId: 'p', sessionId: 'host-session', revisionToken: 'w1', agents, handoffs: [], truncated: false, observedAt: now });

function fakeApi(read: () => Promise<unknown>) {
  const api = { runs: vi.fn(async () => ({ apiVersion: 1, items: [run] })), decisions: vi.fn(async () => ({ apiVersion: 1, items: [decision] })), readWorkforce: vi.fn(read) };
  return { api, client: api as unknown as ApiClient };
}
const hook = (client: ApiClient, revision = 0) => renderHook(({ revision: r }) => useOfficeModel({ api: client, id: 'p', session: ready, connection: 'connected', revision: r }), { initialProps: { revision } });

beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_k: string, cb: () => unknown) => cb() } }); localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

function app(path: string) { return render(<MemoryRouter initialEntries={[path]}><App api={new ApiClient()} /></MemoryRouter>); }
const calls = (fetcher: ReturnType<typeof installApi>['fetcher'], needle: string) => fetcher.mock.calls.filter(([path]) => String(path).includes(needle)).length;

test('visual mode reads workforce, classic mode does not', async () => {
  const classic = installApi({ '/api/v1/projects/p/session': ready });
  app('/projects/p');
  await screen.findByLabelText('Tên công việc');
  await new Promise(r => setTimeout(r, 30));
  expect(calls(classic.fetcher, '/workforce')).toBe(0);
  cleanup();
  writeMode('visual');
  const visual = installApi({ '/api/v1/projects/p/session': ready, '/api/v1/projects/p/workforce': workforce([agent('c1', 'conversation', now)]) });
  app('/projects/p');
  await waitFor(() => expect(calls(visual.fetcher, '/workforce')).toBe(1));
});

test('unsupported backend stops retrying until reload', async () => {
  const { api, client } = fakeApi(async () => { throw new ApiError('not_found'); });
  const view = hook(client);
  await waitFor(() => expect(view.result.current.unsupported).toBe(true));
  expect(view.result.current.model?.tier).toBe('degraded');
  view.rerender({ revision: 1 });
  view.rerender({ revision: 2 });
  await act(async () => { await Promise.resolve(); });
  expect(api.readWorkforce).toHaveBeenCalledTimes(1);
  // A remount on the same page load (mode toggled off and on) still does not retry; a new ApiClient (page reload) would.
  view.unmount();
  const again = hook(client);
  await waitFor(() => expect(again.result.current.model?.tier).toBe('degraded'));
  expect(api.readWorkforce).toHaveBeenCalledTimes(1);
});

test('operation_not_allowed yields degraded tier once', async () => {
  const { api, client } = fakeApi(async () => { throw new ApiError('operation_not_allowed'); });
  const view = hook(client);
  await waitFor(() => expect(view.result.current.unsupported).toBe(true));
  expect(view.result.current.model?.tier).toBe('degraded');
  expect(view.result.current.stale).toBe(false);
  view.rerender({ revision: 1 });
  await act(async () => { await Promise.resolve(); });
  expect(api.readWorkforce).toHaveBeenCalledTimes(1);
});

test('stale read keeps last model and labels it', async () => {
  let fail = false;
  const { api, client } = fakeApi(async () => { if (fail) throw new ApiError('unavailable'); return workforce([agent('c1', 'conversation', now)]); });
  const view = hook(client);
  await waitFor(() => expect(view.result.current.model?.tier).toBe('full'));
  expect(view.result.current.stale).toBe(false);
  const before = view.result.current.model;
  fail = true;
  view.rerender({ revision: 1 });
  await waitFor(() => expect(view.result.current.stale).toBe(true));
  expect(view.result.current.model).toEqual(before);
  expect(api.readWorkforce).toHaveBeenCalledTimes(2);
  // The next successful read clears the label.
  fail = false;
  view.rerender({ revision: 2 });
  await waitFor(() => expect(view.result.current.stale).toBe(false));
});

test('agents are seated in boundAt order whatever order the host lists them', async () => {
  const { client } = fakeApi(async () => workforce([agent('dev-late', 'developer', '2026-11-02T00:00:09.000Z'), agent('dev-early', 'developer', '2026-11-01T00:00:00.000Z')]));
  const view = hook(client);
  await waitFor(() => expect(view.result.current.model?.tier).toBe('full'));
  const seat = (id: string) => view.result.current.model!.agents.find(a => a.instanceId === id)?.seat;
  expect(seat('dev-early')).toBe('developer:1');
  expect(seat('dev-late')).toBe('developer:2');
  expect(view.result.current.overflow).toBe(0);
});

test('workforce is re-read every 15 s while visible and not while hidden', async () => {
  const { api, client } = fakeApi(async () => workforce([agent('c1', 'conversation', now)]));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  hook(client);
  await waitFor(() => expect(api.readWorkforce).toHaveBeenCalledTimes(1));
  await act(async () => { await vi.advanceTimersByTimeAsync(WORKFORCE_POLL_MS); });
  await waitFor(() => expect(api.readWorkforce).toHaveBeenCalledTimes(2));
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(WORKFORCE_POLL_MS * 2); });
  expect(api.readWorkforce).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

test('ApiClient reads workforce and run activity through the contract parsers', async () => {
  const body = workforce([agent('c1', 'conversation', now)]);
  const entry = { entryId: '6f1f1d7e-3b1a-4c53-9a58-0d2f5d6a7b01', occurredAt: now, kind: 'handoff', role: 'coordinator', action: 'accepted_delegation', runId: 'run' };
  const { fetcher } = installApi({ '/api/v1/projects/p/workforce': body, '/api/v1/projects/p/runs/run/activity': { apiVersion: 1, items: [entry] } });
  const client = new ApiClient();
  expect((await client.readWorkforce('p')).agents).toHaveLength(1);
  expect((await client.readRunActivity('p', 'run')).items[0]?.action).toBe('accepted_delegation');
  expect((fetcher.mock.calls as unknown[][]).every(([, init]) => (init as RequestInit).method === 'GET')).toBe(true);
  // A malformed projection is an invalid response, never a model.
  installApi({ '/api/v1/projects/p/workforce': { ...body, agents: [{ ...(body.agents[0] as object), paneId: 'secret' }] } });
  await expect(new ApiClient().readWorkforce('p')).rejects.toMatchObject({ code: 'invalid_response' });
});

test('401 is reported as authRequired, not as plain stale', async () => {
  let fail = false;
  const { client } = fakeApi(async () => { if (fail) throw new ApiError('session_required'); return workforce([agent('c1', 'conversation', now)]); });
  const view = hook(client);
  await waitFor(() => expect(view.result.current.model?.tier).toBe('full'));
  fail = true;
  view.rerender({ revision: 1 });
  await waitFor(() => expect(view.result.current.authRequired).toBe(true));
  expect(view.result.current.stale).toBe(false);
  expect(view.result.current.error).toBeInstanceOf(ApiError);
  expect(view.result.current.model?.tier).toBe('full');
});

test('a first failed read exposes the error and is not "unsupported"', async () => {
  const { client } = fakeApi(async () => { throw new ApiError('unavailable'); });
  const view = hook(client);
  await waitFor(() => expect(view.result.current.error).toBeInstanceOf(ApiError));
  expect(view.result.current.unsupported).toBe(false);
  expect(view.result.current.authRequired).toBe(false);
  expect(view.result.current.model?.tier).toBe('degraded');
});

test('becoming visible re-reads once at once and the timer stops while hidden', async () => {
  const { api, client } = fakeApi(async () => workforce([agent('c1', 'conversation', now)]));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  hook(client);
  await waitFor(() => expect(api.readWorkforce).toHaveBeenCalledTimes(1));
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(WORKFORCE_POLL_MS * 3); });
  expect(api.readWorkforce).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(api.readWorkforce).toHaveBeenCalledTimes(2));
  await act(async () => { await vi.advanceTimersByTimeAsync(WORKFORCE_POLL_MS); });
  await waitFor(() => expect(api.readWorkforce).toHaveBeenCalledTimes(3));
});
