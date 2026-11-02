import { beforeEach, describe, expect, test, vi } from 'vitest';

// A fake loader: the cache logic (refcount, abort, dispose on the last release, no cached failure) is what is under test.
const { disposed, FakeMesh } = vi.hoisted(() => ({ disposed: [] as string[], FakeMesh: class { geometry: unknown; material: unknown; } }));
let parseGate: Promise<void> = Promise.resolve();
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    async parseAsync(buffer: ArrayBuffer): Promise<unknown> {
      await parseGate;
      const name = new TextDecoder().decode(buffer);
      const mesh = new FakeMesh();
      mesh.geometry = { dispose: () => disposed.push(`geo:${name}`) };
      mesh.material = { dispose: () => disposed.push(`mat:${name}`) };
      return { scene: { traverse: (fn: (o: unknown) => void) => fn(mesh) }, animations: [] };
    }
  },
}));
vi.mock('three', () => ({ Mesh: FakeMesh, BufferGeometry: class { }, Material: class { } }));

const urls = { character: '/c.glb', furniture: '/f.glb' };
let fetches = 0;
beforeEach(() => {
  disposed.length = 0; fetches = 0; parseGate = Promise.resolve();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
    fetches++;
    if (url.includes('bad')) return { ok: false, status: 404 };
    return { ok: true, arrayBuffer: async () => { if (init?.signal?.aborted) throw new DOMException('x', 'AbortError'); return new TextEncoder().encode(url).buffer; } };
  }));
});

describe('model cache', () => {
  test('overlapping owners share one load and the last release disposes once', async () => {
    const { acquireModels } = await import('../src/features/office/scene/assets');
    const [a, b] = await Promise.all([acquireModels(urls), acquireModels(urls)]);
    expect(fetches).toBe(2); // one per file, not per owner
    expect(a.models).toBe(b.models);
    a.release(); a.release();
    expect(disposed).toEqual([]);
    b.release();
    expect(disposed.filter(d => d.startsWith('geo:')).sort()).toEqual(['geo:/c.glb', 'geo:/f.glb']);
    expect(disposed.filter(d => d.startsWith('mat:'))).toHaveLength(2);
  });
  test('a cancelled creation rejects with AbortError and leaves no owner behind', async () => {
    const { acquireModels } = await import('../src/features/office/scene/assets');
    let open!: () => void;
    parseGate = new Promise<void>(r => { open = r; });
    const abort = new AbortController();
    const pending = acquireModels({ character: '/c2.glb', furniture: '/f2.glb' }, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    open();
    // A later owner starts a fresh load and succeeds.
    const again = await acquireModels({ character: '/c2.glb', furniture: '/f2.glb' });
    again.release();
  });
  test('a failed load is not cached', async () => {
    const { acquireModels } = await import('../src/features/office/scene/assets');
    await expect(acquireModels({ character: '/bad.glb', furniture: '/f3.glb' })).rejects.toThrow('404');
    await expect(acquireModels({ character: '/bad.glb', furniture: '/f3.glb' })).rejects.toThrow('404');
    expect(fetches).toBeGreaterThanOrEqual(4);
  });
});
