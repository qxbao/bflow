import { describe, expect, test } from 'vitest';
import { clampRect, defaultRect, sceneInset } from '../src/features/office/ui/windows/geometry';
import type { WindowKind } from '../src/features/office/ui/windows/GameWindow';
import { windowReducer, type WinState } from '../src/features/office/ui/windows/WindowManager';

const viewport = { width: 1440, height: 900 };
const open = (state: WinState[], kind: WindowKind, params?: { instanceId?: string }) => windowReducer(state, { type: 'open', kind, ...(params ? { params } : {}), viewport });

describe('game window state and geometry', () => {
  test('clamps windows to a reachable title bar and keeps minimum dimensions', () => {
    expect(clampRect({ x: 2000, y: -20, w: 100, h: 100 }, viewport)).toEqual({ x: 1392, y: 0, w: 320, h: 240 });
    expect(defaultRect('app', viewport).w).toBeGreaterThanOrEqual(420);
  });
  test('limits agents and visible windows while preserving repair', () => {
    let state: WinState[] = [];
    state = open(state, 'repair');
    for (let index = 1; index <= 4; index++) state = open(state, 'agent', { instanceId: `dev-${index}` });
    expect(state.filter(item => item.kind === 'agent')).toHaveLength(3);
    for (const kind of ['app', 'unseated', 'cabinet'] as const) state = open(state, kind);
    expect(state.filter(item => item.display !== 'minimized' && item.kind !== 'repair')).toHaveLength(4);
    state = windowReducer(state, { type: 'close', id: 'repair' });
    expect(state.some(item => item.kind === 'repair')).toBe(true);
    state = windowReducer(state, { type: 'closeAll', keep: ['repair'] });
    expect(state.map(item => item.kind)).toEqual(['repair']);
  });
  test('computes scene inset from visible windows and viewport', () => {
    const inset = sceneInset([{ rect: { x: 900, y: 20, w: 500, h: 700 }, display: 'normal' }, { rect: { x: 0, y: 0, w: 320, h: 200 }, display: 'minimized' }], viewport);
    expect(inset).toEqual({ left: 88, right: 540, bottom: 112 });
    expect(sceneInset([], { width: 390, height: 844 })).toEqual({ left: 0, right: 0, bottom: 112 });
  });
});
