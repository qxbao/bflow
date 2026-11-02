import { beforeEach, describe, expect, test, vi } from 'vitest';

// Pixi's Assets is mocked: the module under test is only the refcount/ordering logic.
const calls: string[] = [];
let failInit = 0;
vi.mock('pixi.js', () => ({
  Assets: {
    init: vi.fn(async () => { calls.push('init'); if (failInit-- > 0) throw new Error('init'); }),
    setPreferences: vi.fn((p: { preferWorkers: boolean }) => { calls.push(`prefs:${p.preferWorkers}`); }),
    load: vi.fn(async (url: string) => { calls.push(`load:${url}`); return { url }; }),
    unload: vi.fn(async (url: string) => { await Promise.resolve(); calls.push(`unload:${url}`); }),
  },
}));

beforeEach(() => { calls.length = 0; failInit = 0; vi.resetModules(); });

describe('atlas lease', () => {
  test('shares one load and unloads only when the last owner releases', async () => {
    const { acquireAtlas } = await import('../src/features/office/scene/atlas');
    const [a, b] = await Promise.all([acquireAtlas('/x.json'), acquireAtlas('/x.json')]);
    expect(a.sheet).toBe(b.sheet);
    expect(calls.filter(c => c.startsWith('load:'))).toHaveLength(1);
    a.release(); a.release(); // double release counts once
    await Promise.resolve();
    expect(calls.some(c => c.startsWith('unload:'))).toBe(false);
    b.release();
    await vi.waitFor(() => expect(calls).toContain('unload:/x.json'));
  });
  test('a new owner waits for a pending unload before loading', async () => {
    const { acquireAtlas } = await import('../src/features/office/scene/atlas');
    const first = await acquireAtlas('/x.json');
    first.release();
    const second = await acquireAtlas('/x.json');
    expect(calls.indexOf('unload:/x.json')).toBeGreaterThan(-1);
    expect(calls.indexOf('unload:/x.json')).toBeLessThan(calls.lastIndexOf('load:/x.json'));
    second.release();
  });
  test('a rejected init is retried and always applies preferWorkers:false', async () => {
    const { initAssets } = await import('../src/features/office/scene/atlas');
    failInit = 1;
    await expect(initAssets()).rejects.toThrow();
    expect(calls).toContain('prefs:false');
    calls.length = 0;
    await initAssets();
    expect(calls).toEqual(['init', 'prefs:false']);
  });
});
