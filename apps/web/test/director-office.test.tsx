import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ParkedIssueSchema, WebWorkforceViewSchema, type ParkedIssue, type WebWorkforceView } from '@bflow/contracts/web';
import { App } from '../src/app';
import { ApiClient } from '../src/api/client';
import { writeMode } from '../src/features/office/mode';
import { DIRECTOR_PLACEHOLDER_ROLES, PLACEHOLDER_ROLES, deriveOffice } from '../src/features/office/model/derive';
import { DIRECTOR_SEAT, applySeats, assignSeats } from '../src/features/office/model/seats';
import { directorTag } from '../src/features/office/model/labels';
import type { OfficeDirectorInput, OfficeInput, OfficeModel, OfficeTarget } from '../src/features/office/model/types';
import { Choreographer, directorPose } from '../src/features/office/scene/actors';
import { OBJECT_CELLS, QUEUE_BOARD, deskPlan, seatCell, zoneTitles } from '../src/features/office/scene/world';
import { AccessibleOffice } from '../src/features/office/ui/AccessibleOffice';
import { directorTime } from '../src/features/director/status';
import { OfficeHud, type OfficeHudProps } from '../src/features/office/ui/OfficeHud';
import { OfficeStage, type CreateRenderer } from '../src/features/office/ui/OfficeStage';
import type { OfficeRenderer } from '../src/features/office/scene/renderer';
import { directorServer, locks, readySession, view } from './director-fixtures';
import { projects, run } from './fixtures';

configure({ asyncUtilTimeout: 5000 });
const fixture = (name: string) => JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/contracts/test/fixtures/local-web', name), 'utf8'));
const full: WebWorkforceView = WebWorkforceViewSchema.parse(fixture('workforce-full.json'));
const T0 = Date.parse(full.observedAt);
const session = { apiVersion: 1 as const, projectId: 'p', sessionId: 's', state: 'ready' as const, pendingIntakes: [], blockers: [], updatedAt: full.observedAt };
const t1 = '2026-11-04T01:00:00.000Z';
const issue = (patch: Partial<ParkedIssue> = {}): ParkedIssue => ParkedIssueSchema.parse({ schemaVersion: 1, issueId: 'iss-1', runId: 'run', taskKey: 'task', kind: 'verification_exhausted', status: 'open',
  summary: 'Kiểm chứng không đạt sau 3 lượt', attempts: 2, evidence: [], createdAt: t1, updatedAt: t1, ...patch });
const director = (over: Partial<OfficeDirectorInput> = {}): OfficeDirectorInput => ({ layout: 'director', directorLayout: true, presence: 'active', provider: 'claude', heartbeatAt: t1, issues: [], ...over });
const input = (over: Partial<OfficeInput> = {}): OfficeInput => ({ session, runs: [], decisions: [], workforce: full, connection: 'connected', now: T0 + 1000, ...over });
/** The degraded tier: no workforce view. */
const degraded = (over: Partial<OfficeInput> = {}): OfficeInput => { const { workforce: _none, ...rest } = input(over); return rest; };
const empty: OfficeModel = { tier: 'full', certainty: 'confirmed', statusText: '', agents: [], tasks: [], pendingDecisions: 0, handoffs: [], connection: 'connected' };

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.stubGlobal('crypto', webcrypto); Object.defineProperty(navigator, 'locks', { configurable: true, value: locks }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });

describe('pure model: OfficeDirector is a separate entity', () => {
  test('a Director layout adds one director entity and no fake agent, pane or instanceId', () => {
    const legacy = deriveOffice(input());
    const m = deriveOffice(input({ director: director() }));
    expect(m.agents).toEqual(legacy.agents);
    expect(m.director).toEqual({ label: 'Director', presence: 'active', certainty: 'confirmed', statusText: 'Đang hoạt động', provider: 'claude', heartbeatAt: t1 });
    expect(JSON.stringify(m.agents)).not.toContain('director');
    expect(m.director).not.toHaveProperty('instanceId');
  });

  test('unknown presence is a read failure, never confirmed absent', () => {
    const unknown = deriveOffice(input({ director: director({ presence: 'unknown', provider: undefined, heartbeatAt: undefined, issues: undefined }) })).director;
    const absent = deriveOffice(input({ director: director({ presence: 'absent', provider: undefined, heartbeatAt: undefined }) })).director;
    expect(unknown).toMatchObject({ presence: 'unknown', certainty: 'unknown', statusText: 'Chưa xác định' });
    expect(absent).toMatchObject({ presence: 'absent', certainty: 'confirmed', statusText: 'Chưa có mặt' });
    expect(unknown?.statusText).not.toBe(absent?.statusText);
  });

  test('presence follows the host heartbeat projection only: a Herdr done transport never makes the Director active or finished', () => {
    const done = { ...full, agents: full.agents.map(a => ({ ...a, transport: { state: 'done' as const, observedAt: full.observedAt } })) };
    for (const presence of ['absent', 'unknown'] as const) {
      const d = deriveOffice(input({ workforce: done, director: director({ presence }) })).director!;
      expect(d.presence).toBe(presence);
      expect(d.statusText).not.toMatch(/xong|hoàn thành|rảnh/i);
    }
  });

  test('the queue summary counts open and retrying issues of a fresh view and says unknown otherwise', () => {
    const issues = [issue(), issue({ issueId: 'b', status: 'retrying' }), issue({ issueId: 'c', status: 'resolved' }), issue({ issueId: 'd', status: 'dismissed' })];
    expect(deriveOffice(input({ director: director({ issues }) })).queue).toEqual({ availability: 'ready', open: 1, retrying: 1, truncated: false });
    expect(deriveOffice(input({ director: director({ presence: 'unknown', issues: undefined }) })).queue).toEqual({ availability: 'unknown', open: 0, retrying: 0, truncated: false });
    expect(deriveOffice(input({ director: director({ layout: 'unknown', directorLayout: true, presence: 'unknown', issues: undefined }) })).queue?.availability).toBe('unknown');
  });

  test('legacy v2 and unsupported backends keep the old office: no Director, conversation and coordinator placeholders stay', () => {
    for (const d of [director({ layout: 'legacy_v2', directorLayout: false }), director({ layout: 'unsupported', directorLayout: false }), undefined]) {
      const m = deriveOffice(degraded(d ? { director: d } : {}));
      expect(m.director).toBeUndefined();
      expect(m.queue).toBeUndefined();
      expect(m.agents.map(a => a.role)).toEqual([...PLACEHOLDER_ROLES]);
    }
  });

  test('V3 degraded placeholders drop conversation and coordinator; the Director desk replaces them', () => {
    const m = deriveOffice(degraded({ director: director() }));
    expect(m.agents.map(a => a.role)).toEqual([...DIRECTOR_PLACEHOLDER_ROLES]);
    expect(DIRECTOR_PLACEHOLDER_ROLES).not.toContain('conversation');
    expect(DIRECTOR_PLACEHOLDER_ROLES).not.toContain('coordinator');
    expect(m.director?.presence).toBe('active');
  });

  test('a closed session keeps the Director projection for labels without claiming presence of its own', () => {
    const m = deriveOffice(input({ session: { ...session, state: 'stopped' }, director: director({ presence: 'unknown', issues: undefined }) }));
    expect(m.tier).toBe('closed');
    expect(m.director?.certainty).toBe('unknown');
  });
});

describe('seats and world: one Director desk in the control room', () => {
  test('the Director takes the dedicated seat at the existing executive desk; a stray conversation instance moves to a spare seat', () => {
    expect(seatCell(DIRECTOR_SEAT)).toEqual(OBJECT_CELLS.counter);
    const m = deriveOffice(input({ director: director() }));
    const seated = applySeats({ entries: [], overflow: 0 }, m).model;
    expect(seated.director?.seat).toBe(DIRECTOR_SEAT);
    expect(seated.agents.some(a => a.seat === DIRECTOR_SEAT)).toBe(false);
    const conv = { instanceId: 'c1', label: 'C', role: 'conversation' as const, pose: 'sleeping' as const, certainty: 'inferred' as const, statusText: '' };
    expect(assignSeats({ entries: [{ instanceId: 'c1', seat: 'conversation:conversation' }], overflow: 0 }, [conv], { director: true }).entries).toEqual([{ instanceId: 'c1', seat: 'conversation:conversation:2' }]);
    expect(assignSeats({ entries: [], overflow: 0 }, [conv]).entries).toEqual([{ instanceId: 'c1', seat: 'conversation:conversation' }]);
  });

  test('the Director desk adds no new desk geometry, and the queue board reuses the existing whiteboard', () => {
    expect(deskPlan([DIRECTOR_SEAT])).toEqual(deskPlan([]));
    expect(QUEUE_BOARD.node).toBe('whiteboard');
    expect(zoneTitles(false).find(z => z.id === 'conversation')?.text).toBe('Conversation');
    expect(zoneTitles(true).find(z => z.id === 'conversation')?.text).toBe('Director');
    // A confirmed Director layout has no Coordinator room sign; legacy v2 keeps it.
    expect(zoneTitles(true).find(z => z.id === 'coordination')?.text).toBe('Director Team');
    expect(zoneTitles(true).some(z => /coordinator/i.test(z.text))).toBe(false);
    expect(zoneTitles(false).find(z => z.id === 'coordination')?.text).toBe('Coordinator');
  });

  test('logical handoffs to the coordinator or conversation end at the Director desk visually, with no new wire role', () => {
    const choreo = new Choreographer(false);
    choreo.apply(empty, []);
    expect(choreo.cellFor({ kind: 'zone', role: 'coordinator' })).toEqual(OBJECT_CELLS.server);
    choreo.apply({ ...empty, director: { label: 'Director', presence: 'active', certainty: 'confirmed', statusText: '', seat: DIRECTOR_SEAT } }, []);
    expect(choreo.cellFor({ kind: 'zone', role: 'coordinator' })).toEqual(OBJECT_CELLS.counter);
    expect(choreo.cellFor({ kind: 'zone', role: 'conversation' })).toEqual(OBJECT_CELLS.counter);
    expect(choreo.cellFor({ kind: 'zone', role: 'qa' })).toEqual(OBJECT_CELLS.server);
  });

  test('the Director figure: absent is an empty desk, unknown a translucent ghost, never a success clip', () => {
    expect(directorPose('absent')).toEqual({ visible: false, clip: 'idle', alpha: 1 });
    expect(directorPose('unknown')).toEqual({ visible: true, clip: 'ghost', alpha: 0.45 });
    expect(directorPose('active')).toEqual({ visible: true, clip: 'type', alpha: 1 });
    expect(directorPose('waiting')).toEqual({ visible: true, clip: 'idle', alpha: 1 });
    expect(directorTag('unknown')).toBe('Director · Chưa rõ');
    expect(directorTag('absent')).toBe('Director · Vắng mặt');
  });
});

const dmodel = (over: Partial<NonNullable<OfficeModel['director']>> = {}, queue: OfficeModel['queue'] = { availability: 'ready', open: 0, retrying: 0, truncated: false }): OfficeModel =>
  ({ ...empty, director: { label: 'Director', presence: 'active', certainty: 'confirmed', statusText: 'Đang hoạt động', seat: DIRECTOR_SEAT, ...over }, queue });

describe('AccessibleOffice parity', () => {
  test('the DOM mirror lists the Director and the queue board as keyboard buttons that emit their own targets', () => {
    const onSelect = vi.fn<(t: OfficeTarget) => void>();
    render(<AccessibleOffice model={dmodel({}, { availability: 'ready', open: 2, retrying: 1, truncated: false })} onSelect={onSelect} visible />);
    const region = screen.getByRole('region', { name: 'Bản văn bản của văn phòng' });
    const desk = within(region).getByRole('button', { name: /^Director: Đang hoạt động/ });
    const board = within(region).getByRole('button', { name: 'Bảng sự cố (2 đang mở, 1 đang thử lại)' });
    expect(desk.tagName).toBe('BUTTON'); expect(board.tagName).toBe('BUTTON');
    desk.focus(); expect(document.activeElement).toBe(desk);
    fireEvent.click(desk); fireEvent.click(board);
    expect(onSelect.mock.calls.map(c => c[0])).toEqual([{ kind: 'director' }, { kind: 'queue' }]);
    expect(within(region).getByRole('button', { name: 'Bàn Director (trò chuyện)' })).toBeTruthy();
    expect(within(region).queryByRole('button', { name: /Quầy Conversation/ })).toBeNull();
  });

  test('the Director heartbeat is shown as a formatted time like the Classic view, never a raw ISO timestamp', () => {
    render(<AccessibleOffice model={dmodel({ heartbeatAt: t1 })} onSelect={vi.fn()} visible />);
    const name = screen.getByRole('button', { name: /^Director:/ }).textContent ?? '';
    expect(name).toContain(`báo hoạt động lúc ${directorTime(t1)}`);
    expect(name).not.toContain(t1); expect(name).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('unknown queue and unknown presence are spelled out, never shown as empty or absent', () => {
    render(<AccessibleOffice model={dmodel({ presence: 'unknown', certainty: 'unknown', statusText: 'Chưa xác định' }, { availability: 'unknown', open: 0, retrying: 0, truncated: false })} onSelect={vi.fn()} visible />);
    expect(screen.getByRole('button', { name: /^Director: Chưa xác định\. Mức tin cậy: Chưa xác định/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bảng sự cố (chưa đọc được)' })).toBeTruthy();
  });

  test('a legacy model keeps the old mirror: no Director, no queue board, the Conversation counter', () => {
    render(<AccessibleOffice model={empty} onSelect={vi.fn()} visible />);
    expect(screen.queryByRole('button', { name: /^Director/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Bảng sự cố/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Quầy Conversation (trò chuyện)' })).toBeTruthy();
  });

  test('announcements: confirmed presence changes and new open issues; a read failure is not announced as absence', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<AccessibleOffice model={dmodel({ presence: 'absent', statusText: 'Chưa có mặt' })} onSelect={vi.fn()} visible />);
    const live = () => document.querySelector('[aria-live="polite"]')!.textContent;
    rerender(<AccessibleOffice model={dmodel()} onSelect={vi.fn()} visible />);
    expect(live()).toBe('Director đã có mặt');
    act(() => { vi.advanceTimersByTime(6000); });
    rerender(<AccessibleOffice model={dmodel({ presence: 'unknown', certainty: 'unknown', statusText: 'Chưa xác định' }, { availability: 'unknown', open: 0, retrying: 0, truncated: false })} onSelect={vi.fn()} visible />);
    act(() => { vi.advanceTimersByTime(6000); });
    expect(live()).toBe('Director đã có mặt');
    rerender(<AccessibleOffice model={dmodel({ presence: 'absent', statusText: 'Chưa có mặt' }, { availability: 'ready', open: 1, retrying: 0, truncated: false })} onSelect={vi.fn()} visible />);
    act(() => { vi.advanceTimersByTime(6000); });
    expect(live()).toBe('Director không còn báo hoạt động. Có 1 sự cố mới cần xử lý');
  });
});

describe('stage: Director focus and camera fallback', () => {
  const fake = () => {
    const r: OfficeRenderer & { focus: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn> } = { apply: vi.fn(() => []), setPaused: vi.fn(), destroy: vi.fn(), focus: vi.fn() } as never;
    return r;
  };
  test('selecting the Director or the queue in the mirror moves the camera there when the scene exists', async () => {
    const r = fake(), onSelect = vi.fn();
    const create: CreateRenderer = async () => r;
    render(<OfficeStage model={dmodel()} onSelect={onSelect} createRenderer={create} />);
    await waitFor(() => expect(r.apply).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^Director:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Bảng sự cố/ }));
    expect(r.focus.mock.calls.map(c => c[0])).toEqual([{ kind: 'director' }, { kind: 'queue' }]);
    expect(onSelect.mock.calls.map(c => c[0])).toEqual([{ kind: 'director' }, { kind: 'queue' }]);
  });
  test('without WebGL the visible list still carries the Director and the queue board', async () => {
    const create: CreateRenderer = async () => { throw new Error('no webgl'); };
    render(<OfficeStage model={dmodel()} onSelect={vi.fn()} createRenderer={create} />);
    await screen.findByText(/Không dựng được cảnh đồ họa/);
    expect(screen.getByRole('button', { name: /^Director:/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Bảng sự cố/ })).toBeTruthy();
  });
});

describe('HUD: Director chat gate and queue shortcut', () => {
  const base = (over: Partial<OfficeHudProps> = {}): OfficeHudProps => ({
    projectName: 'P', projects: [], projectId: 'p', onProject: vi.fn(), failed: false, authRequired: false, onDocuments: vi.fn(), session: readySession as never, model: dmodel(), runs: [], connection: 'connected', stale: false,
    mode: 'visual', onMode: vi.fn(), panelOpen: false, overflow: 0, onOverview: vi.fn(), onNavigate: vi.fn(), onRefresh: vi.fn(), onFocusZone: vi.fn(), onAgentList: vi.fn(), onChatDraft: vi.fn(), dock: null, dockSummary: { count: 0, attention: false }, ...over,
  });
  test('in a Director layout the chat bar follows the Director chat state, not the legacy chat_adapter_unavailable blocker', () => {
    const { rerender } = render(<OfficeHud {...base({ director: { canSend: true, presenceLabel: 'Director đang hoạt động' } })} />);
    expect((screen.getByLabelText('Trò chuyện với Bflow') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByLabelText('Trạng thái văn phòng').textContent).toContain('Director đang hoạt động');
    expect(screen.getByRole('button', { name: 'Director' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Trợ lý' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Điều phối' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Coordinator' })).toBeNull();
    expect((screen.getByLabelText('Trò chuyện với Bflow') as HTMLInputElement).placeholder).toBe('Trò chuyện với Director…');
    rerender(<OfficeHud {...base({ director: { canSend: false, presenceLabel: 'Chưa đọc được trạng thái Director' } })} />);
    expect((screen.getByLabelText('Trò chuyện với Bflow') as HTMLInputElement).disabled).toBe(true);
    rerender(<OfficeHud {...base({ model: empty })} />);
    expect((screen.getByLabelText('Trò chuyện với Bflow') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Trợ lý' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Điều phối' })).toBeTruthy();
  });
  test('the rail offers the queue with its open count only in a Director layout', () => {
    const onQueue = vi.fn();
    const { rerender } = render(<OfficeHud {...base({ director: { canSend: true, presenceLabel: 'x' }, model: dmodel({}, { availability: 'ready', open: 3, retrying: 0, truncated: false }), onQueue })} />);
    const button = within(screen.getByRole('navigation', { name: 'Lối tắt' })).getByRole('button', { name: /Sự cố/ });
    expect(button.textContent).toContain('Sự cố đang mở: 3');
    fireEvent.click(button);
    expect(onQueue).toHaveBeenCalledTimes(1);
    rerender(<OfficeHud {...base({ model: empty, onQueue })} />);
    expect(within(screen.getByRole('navigation', { name: 'Lối tắt' })).queryByRole('button', { name: /Sự cố/ })).toBeNull();
  });
});

describe('app: the queue board opens the shared Classic panel, read-only until the owner acts', () => {
  function mountApp(issues: ParkedIssue[]) {
    const v = view({ presence: 'active' });
    const responses: Record<string, unknown> = {
      '/api/v1/session': { apiVersion: 1, sessionId: 'browser', expiresAt: new Date(Date.now() + 3600000).toISOString(), csrfToken: 'csrf' },
      '/api/v1/projects': { apiVersion: 1, items: projects }, '/api/v1/projects/p/runs?limit=25': { apiVersion: 1, items: [run] }, '/api/v1/projects/p/runs/run': run,
      '/api/v1/projects/p/decisions': { apiVersion: 1, items: [] },
    };
    class Source { addEventListener() {} close = vi.fn(); }
    vi.stubGlobal('EventSource', Source);
    const withIssues = { ...v, snapshot: { ...v.snapshot, issues } };
    const server = directorServer({ view: () => withIssues, extra: path => {
      const url = new URL(path, 'http://local');
      if (url.pathname === '/api/v1/projects/p/director/issues') return { apiVersion: 1, items: issues };
      return responses[path];
    } });
    writeMode('visual');
    render(<MemoryRouter initialEntries={['/projects/p']}><App api={new ApiClient()} /></MemoryRouter>);
    return server;
  }
  test('Director desk and queue board in the mirror; the queue opens IssueQueuePanel; the HUD chat is enabled despite the legacy blocker', async () => {
    const server = mountApp([issue()]);
    const region = await screen.findByRole('region', { name: 'Bản văn bản của văn phòng' });
    await within(region).findByRole('button', { name: /^Director: Đang hoạt động/ });
    await waitFor(() => expect((screen.getByLabelText('Trò chuyện với Bflow') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(await within(region).findByRole('button', { name: 'Bảng sự cố (1 đang mở)' }));
    const main = document.getElementById('main')!;
    await waitFor(() => expect(main.querySelector('[data-component="IssueQueue"]')).not.toBeNull());
    await within(main).findByText('Kiểm chứng không đạt sau 3 lượt');
    expect(server.state.posts).toEqual([]);
    expect(server.fetcher.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toEqual([]);
  });
  test('the Director desk opens the Director inspector with presence text and a chat shortcut', async () => {
    mountApp([]);
    const region = await screen.findByRole('region', { name: 'Bản văn bản của văn phòng' });
    fireEvent.click(await within(region).findByRole('button', { name: /^Director: Đang hoạt động/ }));
    const main = document.getElementById('main')!;
    await within(main).findByRole('heading', { name: 'Bàn Director' });
    expect(within(main).getAllByText('Director đang hoạt động').length).toBeGreaterThan(0);
    fireEvent.click(within(main).getByRole('button', { name: 'Mở trò chuyện với Director' }));
    await waitFor(() => expect(main.querySelector('[data-component="DirectorChat"]')).not.toBeNull());
  });
});

test('unconfirmed initial topology uses neutral signs and no old permanent-role placeholders',()=>{
 const m=deriveOffice(degraded({director:director({layout:'unknown',directorLayout:false,presence:'unknown',issues:undefined})}));
 expect(m).toMatchObject({layout:'unknown'});expect(m.director).toBeUndefined();
 expect(m.agents.some(a=>a.role==='conversation'||a.role==='coordinator')).toBe(false);
 expect(zoneTitles(undefined).some(z=>/conversation|coordinator/i.test(z.text))).toBe(false);
 expect(zoneTitles(true).find(z=>z.id==='conversation')?.text).toBe('Director');
 expect(zoneTitles(false).find(z=>z.id==='conversation')?.text).toBe('Conversation');
});
