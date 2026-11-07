// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createOfficeRenderer } from '../src/features/office/scene/renderer';
import type { OfficeModel } from '../src/features/office/model/types';
const f = vi.hoisted(() => ({ gl: undefined as any, release: vi.fn(), setZoneTitles: vi.fn(), warm: undefined as Promise<void> | undefined, resize: undefined as (() => void) | undefined }));
vi.mock('three', async () => {
  const real = await vi.importActual<typeof import('three')>('three');
  return { ...real, WebGLRenderer: class {
    domElement = document.createElement('canvas'); shadowMap = {}; dispose = vi.fn(); forceContextLoss = vi.fn();
    render = vi.fn(); setPixelRatio = vi.fn(); setSize = vi.fn();
    getContext = () => ({ getExtension: () => null });
    compileAsync = vi.fn(() => f.warm ?? Promise.resolve());
    constructor() { f.gl = this; }
  } };
});
// A running session draws the staff of every unoccupied desk, so the character model must be clonable.
vi.mock('../src/features/office/scene/assets', () => ({ acquireModels: async () => { const { Group } = await import('three'); return { models: { furniture: {}, character: { scene: new Group(), animations: [] } }, release: f.release }; } }));
vi.mock('../src/features/office/scene/stage', async importOriginal => {
  const { Group } = await import('three');
  const real = await importOriginal<typeof import('../src/features/office/scene/stage')>();
  return { ...real, BACKGROUND: '#000000', setShadowCasting: vi.fn(), Stage: class {
    setZoneTitles = f.setZoneTitles; group = new Group(); objects = []; lights = { key: {}, hemi: {}, accents: [] }; layout = vi.fn(); dispose = vi.fn();
  } };
});
beforeEach(() => {
  vi.useFakeTimers(); f.release.mockClear(); f.setZoneTitles.mockClear(); f.warm = undefined;
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { f.resize = callback; } observe() {} disconnect() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const host = () => document.createElement('div');
const settleBuild = async () => { for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(1); };
const model: OfficeModel = { tier: 'full', certainty: 'confirmed', statusText: '', pendingDecisions: 0, connection: 'connected', agents: [], tasks: [], handoffs: [] };

test('does not render or announce ready until warm and the initial model have arrived, including resize', async () => {
  let resolve!: () => void; f.warm = new Promise(r => { resolve = r; });
  const el = host(), pending = createOfficeRenderer(el, vi.fn()); await settleBuild();
  expect(f.setZoneTitles).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({id:'conversation',text:'Điều hành'}),expect.objectContaining({id:'coordination',text:'Chuyên môn'})]));
  f.resize?.(); await vi.advanceTimersByTimeAsync(50);
  expect(f.gl.render).not.toHaveBeenCalled(); expect(el.dataset.officeRenderer).toBeUndefined();
  resolve(); const renderer = await pending;
  await vi.advanceTimersByTimeAsync(50); expect(f.gl.render).not.toHaveBeenCalled();
  renderer.apply(model, []); await vi.advanceTimersByTimeAsync(50);
  expect(f.gl.render).toHaveBeenCalled(); expect(el.dataset.officeRenderer).toBe('ready');
  renderer.destroy(); expect(f.release).toHaveBeenCalledTimes(1);
});

test.each(['abort', 'context-loss', 'timeout'] as const)('releases a renderer whose shader warm never settles: %s', async kind => {
  f.warm = new Promise(() => {}); const abort = new AbortController(), el = host();
  const pending = createOfficeRenderer(el, vi.fn(), abort.signal);
  const rejected = expect(pending).rejects.toThrow(); await settleBuild();
  if (kind === 'abort') abort.abort();
  else if (kind === 'context-loss') el.querySelector('canvas')!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  else await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  expect(f.release).toHaveBeenCalledTimes(1); expect(f.gl.dispose).toHaveBeenCalledTimes(1);
  expect(el.querySelector('canvas')).toBeNull(); expect(el.dataset.officeRenderer).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

test('highlight and setInset refocus selectedTarget even when non-immersive', async () => {
  const el = host(), renderer = await (async () => { const p = createOfficeRenderer(el, vi.fn()); await settleBuild(); return p; })();
  renderer.apply(model, []);
  await vi.advanceTimersByTimeAsync(50);
  renderer.highlight?.({ kind: 'object', object: 'board' });
  expect(el.dataset.officeSelected).toBe('true');
  renderer.setInset?.({ left: 0, right: 480, bottom: 112 });
  expect(el.dataset.officeState).toBe('moving');
  renderer.destroy();
});
