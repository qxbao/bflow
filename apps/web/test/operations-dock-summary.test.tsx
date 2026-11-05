import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WebOperationSchema } from '@bflow/contracts/web';
import { ApiClient } from '../src/api/client';
import { Operations, useOperationsDockSummary } from '../src/features/operations';

beforeEach(() => { localStorage.clear(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_k: string, cb: () => unknown) => cb() } }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ID = '00000000-0000-4000-8000-000000000001';
const seed = (): void => localStorage.setItem('bflow:web:operations:p:unpaired:create', JSON.stringify({ slot: 'create', scope: 'unpaired', commandId: ID, fingerprint: 'a'.repeat(64), kind: 'create_request' }));
const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const op = (state: string, updatedAt = new Date().toISOString()) => WebOperationSchema.parse({
  apiVersion: 1, operationId: ID, projectId: 'p', owner: 'host_interaction', operationKind: 'create_request', state, updatedAt,
  ...(state === 'failed' || state === 'reconciliation_required' ? { error: { apiVersion: 1, code: 'unavailable', message: 'x', retryable: true, correlationId: 'c' } } : {}),
});
let seen: { count: number; attention: boolean } | undefined;
function Probe() { seen = useOperationsDockSummary(); return null; }
const mount = () => render(<MemoryRouter><Operations api={new ApiClient()} id="p" refresh={() => {}} dock="external"><Probe /></Operations></MemoryRouter>);
const respond = (operation: unknown | undefined) => vi.stubGlobal('fetch', vi.fn(async () => { if (operation === undefined) throw new TypeError('offline'); return new Response(JSON.stringify(operation)); }));

beforeEach(() => { seen = undefined; });

test('nothing tracked: no count, no attention', async () => {
  respond(op('accepted')); mount();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(seen).toEqual({ count: 0, attention: false });
});
test('a fresh accepted operation is counted without attention', async () => {
  seed(); respond(op('accepted')); mount();
  await waitFor(() => expect(seen?.count).toBe(1));
  expect(seen?.attention).toBe(false);
});
test.each(['reconciliation_required', 'failed'])('a recent %s operation needs attention', async state => {
  seed(); respond(op(state)); mount();
  await waitFor(() => expect(seen).toEqual({ count: 1, attention: true }));
});
test('an operation whose result is uncertain needs attention', async () => {
  seed(); respond(undefined); mount();
  await waitFor(() => expect(seen).toEqual({ count: 1, attention: true }));
});
test('a failed operation already in History (older than ten minutes) no longer needs attention', async () => {
  seed(); respond(op('failed', minutesAgo(11))); mount();
  await waitFor(() => expect(seen?.count).toBe(1));
  expect(seen?.attention).toBe(false);
});
test('the error banner needs attention even with nothing tracked', async () => {
  localStorage.setItem('bflow:web:operations:p:unpaired:create', '{broken');
  respond(op('accepted')); mount();
  await waitFor(() => expect(seen?.attention).toBe(true));
});


test('compact chat receipts keep uncertain-result warnings visible and recovery available on demand', async () => {
  seed(); respond(op('reconciliation_required'));
  render(<MemoryRouter><Operations api={new ApiClient()} id="p" refresh={()=>{}} dock="compact"><Probe/></Operations></MemoryRouter>);
  const warning=await screen.findByText(/Có thao tác cần kiểm tra/);
  expect(warning.closest('details')).toBeNull();
  expect(warning.textContent).toContain('Không tự gửi lại');
  const receipts=screen.getByRole('region',{name:'Theo dõi thao tác'}).closest('details')!;
  expect(receipts.open).toBe(false);
  fireEvent.click(screen.getByText('Thao tác đã gửi (1)',{selector:'summary'}));
  expect(receipts.open).toBe(true);
  expect(screen.getByRole('region',{name:'Theo dõi thao tác'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Đọc lại thao tác'})).toBeTruthy();
});
