// Shared, refcounted GLB cache. Overlapping renderers (fast mode toggles) share one load; the last owner to release disposes the
// geometries and materials. A load whose owners all left is aborted, and a failed load is never cached for the next owner.
import { BufferGeometry, Material, Mesh, type Object3D } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface OfficeModels { character: GLTF; furniture: GLTF }
export interface ModelUrls { character: string; furniture: string }
export interface ModelLease { models: OfficeModels; release(): void }

interface Entry { key: string; refs: number; abort: AbortController; models: Promise<OfficeModels>; settled?: OfficeModels }
let entry: Entry | undefined;

async function fetchGlb(loader: GLTFLoader, url: string, signal: AbortSignal): Promise<GLTF> {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`office model ${url} failed with ${response.status}`);
  return loader.parseAsync(await response.arrayBuffer(), '');
}

/** Frees GPU resources held by the templates. Clones share them, so this runs only when no owner is left. */
export function disposeModels(models: OfficeModels): void {
  for (const gltf of [models.character, models.furniture]) {
    gltf.scene.traverse((object: Object3D) => {
      if (!(object instanceof Mesh)) return;
      (object.geometry as BufferGeometry).dispose();
      for (const m of Array.isArray(object.material) ? object.material : [object.material]) (m as Material).dispose();
    });
  }
}

export async function acquireModels(urls: ModelUrls, signal?: AbortSignal): Promise<ModelLease> {
  const key = `${urls.character}|${urls.furniture}`;
  if (!entry || entry.key !== key) {
    const abort = new AbortController();
    const loader = new GLTFLoader();
    const created: Entry = {
      key, refs: 0, abort,
      models: Promise.all([fetchGlb(loader, urls.character, abort.signal), fetchGlb(loader, urls.furniture, abort.signal)]).then(([character, furniture]) => ({ character, furniture })),
    };
    entry = created;
    created.models.then(m => { created.settled = m; if (created.refs === 0) disposeModels(m); }, () => { if (entry === created) entry = undefined; });
  }
  const mine = entry;
  mine.refs += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    mine.refs -= 1;
    if (mine.refs > 0) return;
    if (entry === mine) entry = undefined;
    // Not loaded yet: stop the fetch; the settle handler above disposes whatever still arrives.
    if (mine.settled) disposeModels(mine.settled); else mine.abort.abort();
  };
  let stop: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    stop = (): void => { release(); reject(new DOMException('office renderer creation cancelled', 'AbortError')); };
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  });
  try {
    // An abort wins the race, so a cancelled creation never waits for a slow load.
    const models = await Promise.race([mine.models, cancelled]);
    return { models, release };
  } catch (error) {
    release();
    throw error;
  } finally {
    // Once acquisition has settled, only release() drops the lease; a later abort of the same signal must not.
    if (stop) signal?.removeEventListener('abort', stop);
  }
}
