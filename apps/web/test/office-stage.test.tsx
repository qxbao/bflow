import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { OfficeStage, type CreateRenderer } from '../src/features/office/ui/OfficeStage';
import type { OfficeRenderer } from '../src/features/office/scene/renderer';
import type { OfficeHandoff, OfficeModel, OfficeTarget } from '../src/features/office/model/types';
import type { VisualCue } from '../src/features/office/model/timeline';

const handoff = (state: OfficeHandoff['state']): OfficeHandoff => ({ handoffId: 'h1', ordinal: 1, direction: 'outbound', state, fromInstanceId: 'a', toInstanceId: 'b', fromRole: 'coordinator', toRole: 'developer' });
const model = (over: Partial<OfficeModel> = {}): OfficeModel => ({
  tier: 'full', certainty: 'confirmed', statusText: '', pendingDecisions: 0, connection: 'connected', handoffs: [], tasks: [{ taskId: 't1', title: 'Thêm bộ lọc', status: 'running', runId: 'r1' }],
  agents: [
    { instanceId: 'a', label: 'Điều phối', role: 'coordinator', pose: 'working', certainty: 'confirmed', statusText: 'Đang giữ việc: Thêm bộ lọc', seat: 'coordination:coordinator', runId: 'r1', taskId: 't1' },
    { instanceId: 'b', label: 'Developer #1', role: 'developer', pose: 'sleeping', certainty: 'inferred', statusText: 'Rảnh', seat: 'developer:1' },
  ], ...over,
});

interface Fake extends OfficeRenderer { apply: ReturnType<typeof vi.fn>; setPaused: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }
let fakes: Fake[];
let lost: (() => void) | undefined;
const factory: CreateRenderer = async (_host, _select, _signal, onLost) => {
  const fake = newFake();
  fakes.push(fake); lost = onLost;
  return fake;
};
/** Mirrors the real renderer contract: a paused renderer drops walk cues and returns only what it accepted. */
const newFake = (): Fake => {
  let paused = false;
  const fake: Fake = {
    apply: vi.fn((_m: OfficeModel, cues: VisualCue[]) => (paused ? [] : cues.filter(c => c.kind === 'walk').map(c => c.handoffId))),
    setPaused: vi.fn((p: boolean) => { paused = p; }), destroy: vi.fn(),
  };
  return fake;
};
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const noop = (_t: OfficeTarget): void => undefined;
const lastCues = (f: Fake): VisualCue[] => f.apply.mock.calls.at(-1)?.[1] as VisualCue[];
const reduce = (on: boolean): void => { vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })); };

beforeEach(() => { fakes = []; lost = undefined; reduce(false); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });

describe('OfficeStage lifecycle', () => {
  test('context loss falls back without unmounting drafts', async () => {
    function Panel() { const [v, set] = useState(''); return <div><textarea aria-label="Nháp" value={v} onChange={e => set(e.target.value)} /><OfficeStage model={model()} onSelect={noop} createRenderer={factory} /></div>; }
    render(<Panel />);
    await settle();
    const draft = screen.getByLabelText('Nháp') as HTMLTextAreaElement;
    await userEvent.type(draft, 'giữ nguyên');
    expect(screen.getByLabelText('Cảnh văn phòng')).toBeTruthy();
    act(() => lost!());
    expect(fakes[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Cảnh văn phòng')).toBeNull();
    expect(screen.getByLabelText('Nháp')).toBe(draft);
    expect(draft.value).toBe('giữ nguyên');
    expect(screen.getAllByText(/mất ngữ cảnh/).length).toBeGreaterThan(0);
    expect(fakes).toHaveLength(1); // no retry loop
  });

  test('missing WebGL shows full HTML list and notice', async () => {
    render(<OfficeStage model={model()} onSelect={noop} createRenderer={async () => { throw new Error('no webgl'); }} />);
    await settle();
    expect(screen.getAllByText(/WebGL không khả dụng/).length).toBeGreaterThan(0);
    const mirror = screen.getByRole('region', { name: 'Bản văn bản của văn phòng' });
    expect(mirror.className).not.toMatch(/sr-only/);
    expect(mirror.textContent).toContain('Điều phối');
    expect(mirror.textContent).toContain('Đang giữ việc: Thêm bộ lọc');
    expect(mirror.textContent).toContain('Suy luận');
    expect(screen.queryByLabelText('Cảnh văn phòng')).toBeNull();
  });

  test('unmount destroys renderer exactly once', async () => {
    const view = render(<OfficeStage model={model()} onSelect={noop} createRenderer={factory} />);
    await settle();
    view.unmount();
    expect(fakes[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  test('unmount before creation settles destroys the late renderer once', async () => {
    let resolve!: (r: OfficeRenderer) => void;
    const late: CreateRenderer = () => new Promise<OfficeRenderer>(r => { resolve = r; });
    const view = render(<OfficeStage model={model()} onSelect={noop} createRenderer={late} />);
    view.unmount();
    const fake = newFake();
    await act(async () => { resolve(fake); await Promise.resolve(); });
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(fake.apply).not.toHaveBeenCalled();
  });

  test('hidden tab pauses renderer', async () => {
    render(<OfficeStage model={model()} onSelect={noop} createRenderer={factory} />);
    await settle();
    const fake = fakes[0]!;
    fake.setPaused.mockClear();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fake.setPaused).toHaveBeenLastCalledWith(true);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fake.setPaused).toHaveBeenLastCalledWith(false);
  });
});

describe('OfficeStage cues', () => {
  const at = (state: OfficeHandoff['state']): ReactElement => <OfficeStage model={model({ handoffs: [handoff(state)] })} onSelect={noop} createRenderer={factory} />;
  test('a walk dropped while the tab is hidden stays eligible', async () => {
    const view = render(at('queued'));
    await settle();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    view.rerender(at('accepted')); // dropped by the paused renderer
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    view.rerender(at('queued'));
    view.rerender(at('accepted'));
    expect(lastCues(fakes[0]!).map(c => c.kind)).toEqual(['walk']);
  });

  test('a walk seen before the renderer is ready stays eligible', async () => {
    let resolve!: (r: OfficeRenderer) => void;
    const late: CreateRenderer = () => new Promise<OfficeRenderer>(r => { resolve = r; });
    const el = (s: OfficeHandoff['state']): ReactElement => <OfficeStage model={model({ handoffs: [handoff(s)] })} onSelect={noop} createRenderer={late} />;
    const view = render(el('queued'));
    view.rerender(el('accepted'));
    const fake = newFake();
    await act(async () => { resolve(fake); await Promise.resolve(); });
    view.rerender(el('queued'));
    view.rerender(el('accepted'));
    expect(lastCues(fake).map(c => c.kind)).toEqual(['walk']);
  });

  test('a throwing destroy on context loss still shows the notice', async () => {
    render(<OfficeStage model={model()} onSelect={noop} createRenderer={factory} />);
    await settle();
    fakes[0]!.destroy.mockImplementation(() => { throw new Error('gone'); });
    act(() => lost!());
    expect(screen.getAllByText(/mất ngữ cảnh/).length).toBeGreaterThan(0);
  });

  test('first model gives no cues and a receipt later gives one walk', async () => {
    const view = render(<OfficeStage model={model({ handoffs: [handoff('queued')] })} onSelect={noop} createRenderer={factory} />);
    await settle();
    expect(lastCues(fakes[0]!)).toEqual([]);
    view.rerender(<OfficeStage model={model({ handoffs: [handoff('accepted')] })} onSelect={noop} createRenderer={factory} />);
    expect(lastCues(fakes[0]!).map(c => c.kind)).toEqual(['walk']);
    // The same walk is never replayed from a later model.
    view.rerender(<OfficeStage model={model({ handoffs: [handoff('delivered')] })} onSelect={noop} createRenderer={factory} />);
    expect(lastCues(fakes[0]!)).toEqual([]);
  });

  test('reduced motion suppresses walk cues', async () => {
    reduce(true);
    const view = render(<OfficeStage model={model({ handoffs: [handoff('queued')] })} onSelect={noop} createRenderer={factory} />);
    await settle();
    view.rerender(<OfficeStage model={model({ handoffs: [handoff('accepted')] })} onSelect={noop} createRenderer={factory} />);
    expect(lastCues(fakes[0]!).filter(c => c.kind === 'walk')).toEqual([]);
    // Non-walk indicators still pass through.
    view.rerender(<OfficeStage model={model({ handoffs: [handoff('rejected')] })} onSelect={noop} createRenderer={factory} />);
    expect(lastCues(fakes[0]!).map(c => c.kind)).toEqual(['blocked']);
  });
});

describe('AccessibleOffice mirror', () => {
  test('stays reachable while the canvas is healthy and objects are real buttons', async () => {
    const picked: OfficeTarget[] = [];
    render(<OfficeStage model={model({ pendingDecisions: 2 })} onSelect={t => picked.push(t)} createRenderer={factory} />);
    await settle();
    expect(screen.getByRole('region', { name: 'Bản văn bản của văn phòng' }).className).toMatch(/sr-only/);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(9); // 2 agents + 7 objects
    await userEvent.click(screen.getByRole('button', { name: /Hộp thư.*2 đang chờ/ }));
    await userEvent.click(screen.getByRole('button', { name: /Developer #1/ }));
    expect(picked).toEqual([{ kind: 'object', object: 'mailbox' }, { kind: 'agent', instanceId: 'b' }]);
  });

  test('live region announces new decisions and errors once per 5 s window', async () => {
    vi.useFakeTimers();
    const at = (n: number, connection: OfficeModel['connection'] = 'connected'): ReactElement => <OfficeStage model={model({ pendingDecisions: n, connection })} onSelect={noop} createRenderer={factory} />;
    const view = render(at(0));
    const live = screen.getByRole('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe(''); // baseline says nothing
    view.rerender(at(1));
    expect(live.textContent).toBe('Có 1 quyết định đang chờ bạn');
    view.rerender(at(2, 'offline'));
    expect(live.textContent).toBe('Có 1 quyết định đang chờ bạn'); // coalesced
    act(() => { vi.advanceTimersByTime(5000); });
    expect(live.textContent).toBe('Có 2 quyết định đang chờ bạn. Mất kết nối tới máy chủ, đang hiển thị dữ liệu cũ');
  });
});

describe('OfficeStage control', () => {
  test('exposes focusZone to the HUD only while the renderer exists, and openList focuses the agent list', async () => {
    const control: { current: import('../src/features/office/ui/OfficeStage').StageControl | null } = { current: null };
    const factoryWithZone: CreateRenderer = async () => { const fake = newFake(); (fake as { focusZone?: unknown }).focusZone = vi.fn(); fakes.push(fake); return fake; };
    const view = render(<OfficeStage model={model()} onSelect={noop} control={control} createRenderer={factoryWithZone} />);
    await settle();
    control.current!.focusZone('qa');
    expect((fakes[0] as unknown as { focusZone: ReturnType<typeof vi.fn> }).focusZone).toHaveBeenCalledWith('qa');
    control.current!.openList();
    expect(document.activeElement?.tagName).toBe('BUTTON');
    expect(document.activeElement?.closest('section')?.getAttribute('aria-label')).toBe('Bản văn bản của văn phòng');
    view.unmount();
    expect(control.current).toBeNull();
  });
  test('a renderer without focusZone ignores the call', async () => {
    const control: { current: import('../src/features/office/ui/OfficeStage').StageControl | null } = { current: null };
    render(<OfficeStage model={model()} onSelect={noop} control={control} createRenderer={factory} />);
    await settle();
    expect(() => control.current!.focusZone('developer')).not.toThrow();
  });
});
