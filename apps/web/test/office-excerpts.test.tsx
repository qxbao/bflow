import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type ApiClient } from '../src/api/client';
import { EXCERPT_KEEP_MS, EXCERPT_POLL_MS, useAgentExcerpts } from '../src/features/office/ui/useAgentExcerpts';
import { poseLabel } from '../src/features/office/model/labels';

const view = (...items: [string, string][]) => ({ apiVersion: 1, projectId: 'p', sessionId: 's', items: items.map(([instanceId, text]) => ({ instanceId, text, observedAt: 'x' })), observedAt: 'x' });
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const client = (read: () => Promise<unknown>) => ({ readWorkforceExcerpts: vi.fn(read) }) as unknown as ApiClient & { readWorkforceExcerpts: ReturnType<typeof vi.fn> };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useAgentExcerpts', () => {
  test('reads at once, then every 4 s, and exposes a map by instance', async () => {
    const api = client(async () => view(['a', 'hello']));
    const { result } = renderHook(() => useAgentExcerpts({ api, id: 'p', enabled: true }));
    await flush();
    expect(result.current.get('a')).toBe('hello');
    await flush(EXCERPT_POLL_MS);
    expect(api.readWorkforceExcerpts).toHaveBeenCalledTimes(2);
  });

  test('does nothing while disabled', async () => {
    const api = client(async () => view());
    renderHook(() => useAgentExcerpts({ api, id: 'p', enabled: false }));
    await flush(EXCERPT_POLL_MS * 3);
    expect(api.readWorkforceExcerpts).not.toHaveBeenCalled();
  });

  test('never overlaps reads', async () => {
    let release!: () => void;
    const api = client(() => new Promise(r => { release = () => r(view(['a', 'x'])); }));
    renderHook(() => useAgentExcerpts({ api, id: 'p', enabled: true }));
    await flush(EXCERPT_POLL_MS * 3);
    expect(api.readWorkforceExcerpts).toHaveBeenCalledTimes(1);
    release();
    await flush();
    await flush(EXCERPT_POLL_MS);
    expect(api.readWorkforceExcerpts).toHaveBeenCalledTimes(2);
  });

  test.each(['operation_not_allowed', 'not_found'])('%s stops polling for this mount', async code => {
    const api = client(async () => { throw new ApiError(code); });
    renderHook(() => useAgentExcerpts({ api, id: 'p', enabled: true }));
    await flush(EXCERPT_POLL_MS * 4);
    expect(api.readWorkforceExcerpts).toHaveBeenCalledTimes(1);
  });

  test('a failed read keeps the last map for 30 s and then clears it', async () => {
    let fail = false;
    const api = client(async () => { if (fail) throw new ApiError('unavailable'); return view(['a', 'kept']); });
    const { result } = renderHook(() => useAgentExcerpts({ api, id: 'p', enabled: true }));
    await flush();
    fail = true;
    await flush(EXCERPT_POLL_MS * 2);
    expect(result.current.get('a')).toBe('kept');
    await flush(EXCERPT_KEEP_MS);
    expect(result.current.size).toBe(0);
  });

  test('the map is replaced only when contents change', async () => {
    let text = 'one';
    const api = client(async () => view(['a', text]));
    const { result } = renderHook(() => useAgentExcerpts({ api, id: 'p', enabled: true }));
    await flush();
    const first = result.current;
    await flush(EXCERPT_POLL_MS);
    expect(result.current).toBe(first);
    text = 'two';
    await flush(EXCERPT_POLL_MS);
    expect(result.current).not.toBe(first);
    expect(result.current.get('a')).toBe('two');
  });
});

describe('poseLabel', () => {
  test('working poses get a message box, sleeping a Zzz, the rest nothing', () => {
    expect(['working', 'typing', 'preparing'].map(poseLabel)).toEqual(['bubble', 'bubble', 'bubble']);
    expect(poseLabel('sleeping')).toBe('sleep');
    expect(['hand_raised', 'question', 'disconnected', 'ghost'].map(poseLabel)).toEqual([undefined, undefined, undefined, undefined]);
  });
});
