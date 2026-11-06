import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { App } from '../src/app';
import { ApiClient } from '../src/api/client';
import { writeMode } from '../src/features/office/mode';
import { installApi, run, session } from './fixtures';

configure({ asyncUtilTimeout: 5000 });
// The real stage is kept; only its control handle is replaced by spies so the order of setInset and focusZone can be observed.
const calls: string[] = [];
const insets: Array<{ right: number; bottom: number; left: number }> = [];
vi.mock('../src/features/office/ui/OfficeStage', async importOriginal => {
  const original = await importOriginal<typeof import('../src/features/office/ui/OfficeStage')>();
  return {
    ...original,
    OfficeStage: (props: Parameters<typeof original.OfficeStage>[0]) => {
      const { control } = props;
      const element = original.OfficeStage(props);
      useEffect(() => {
        if (control) control.current = {
          focusZone: zone => { calls.push(`focus:${zone}`); },
          setInset: inset => { calls.push('inset'); insets.push(inset); },
          openList: () => undefined,
        };
      });
      return element;
    },
  };
});

beforeEach(() => { calls.length = 0; insets.length = 0; vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_k: string, cb: () => unknown) => cb() } }); localStorage.clear(); sessionStorage.clear(); writeMode('visual'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
let where = '';
function Probe() { const l = useLocation(); where = l.pathname; return null; }

test('Toàn cảnh eases the camera only after a route panel has closed, without reserving the panel twice', async () => {
  const list = { apiVersion: 1, items: [run] };
  installApi({ '/api/v1/projects/p/session': { ...session, state: 'ready', sessionId: 'host-session' }, '/api/v1/projects/p/runs/run': run, '/api/v1/projects/p/runs?limit=25&search=&phase=': list });
  render(<MemoryRouter initialEntries={['/projects/p/runs']}><App api={new ApiClient()} /><Probe /></MemoryRouter>);
  const main = (): HTMLElement => document.getElementById('main')!;
  await waitFor(() => expect(main().classList.contains('hidden')).toBe(false));
  await screen.findByRole('region', { name: 'Bản văn bản của văn phòng' });
  const openInset = (): number => insets.at(-1)?.right ?? -1;
  await waitFor(() => expect(openInset()).toBeGreaterThan(0));
  const openRight = openInset();
  expect(openRight).toBeGreaterThan(0);
  calls.length = 0;
  fireEvent.click(within(screen.getByRole('group', { name: 'Góc nhìn camera' })).getByRole('button', { name: 'Toàn cảnh' }));
  await waitFor(() => expect(calls).toContain('focus:overview'));
  expect(where).toBe('/projects/p');
  expect(main().classList.contains('hidden')).toBe(true);
  const focusAt = calls.indexOf('focus:overview');
  expect(focusAt).toBeGreaterThan(0);
  expect(calls[focusAt - 1]).toBe('inset');
  // Closing the app window clears its right-side scene reservation; only the desktop icon rail remains.
  const closed = insets[insets.length - 1]!;
  expect(closed.right).toBe(0);
  expect(closed.left).toBe(176);
  expect(calls.filter(c => c === 'focus:overview')).toHaveLength(1);
});

test('Toàn cảnh with no panel open focuses at once', async () => {
  installApi({ '/api/v1/projects/p/session': { ...session, state: 'ready', sessionId: 'host-session' } });
  render(<MemoryRouter initialEntries={['/projects/p']}><App api={new ApiClient()} /></MemoryRouter>);
  await screen.findByRole('region', { name: 'Bản văn bản của văn phòng' });
  await waitFor(() => expect(calls).toContain('inset'));
  calls.length = 0;
  fireEvent.click(within(screen.getByRole('group', { name: 'Góc nhìn camera' })).getByRole('button', { name: 'Toàn cảnh' }));
  expect(calls.slice(-2)).toEqual(['inset', 'focus:overview']);
});
