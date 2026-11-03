import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ApiClient } from '../src/api/client';
import { Operations, OperationsDock } from '../src/features/operations';

beforeEach(() => { localStorage.clear(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_k: string, cb: () => unknown) => cb() } }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// A corrupted recovery record makes the dock show its error banner without any network.
const corrupt = () => localStorage.setItem('bflow:web:operations:p:unpaired:create', '{broken');
const mount = (dock?: 'inline' | 'external', extra?: boolean) => render(<MemoryRouter><Operations api={new ApiClient()} id="p" refresh={() => {}} {...(dock ? { dock } : {})}><p>child</p>{extra && <OperationsDock />}</Operations></MemoryRouter>);

test('inline dock renders exactly as before', async () => {
  corrupt();
  const view = mount();
  expect(screen.getByText('child')).toBeTruthy();
  const inline = view.container.innerHTML;
  cleanup(); corrupt();
  expect(mount('inline').container.innerHTML).toBe(inline);
});

test('external dock renders only through OperationsDock', async () => {
  corrupt();
  mount('inline');
  await waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
  cleanup(); corrupt();
  const hidden = mount('external');
  expect(screen.getByText('child')).toBeTruthy();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(hidden.container.querySelector('[role="alert"]')).toBeNull();
  cleanup(); corrupt();
  mount('external', true);
  await waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
});

test('OperationsDock outside Operations is rejected', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => render(<OperationsDock />)).toThrow('Operations boundary required');
});
