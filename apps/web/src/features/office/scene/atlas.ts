// Shared, refcounted atlas. Assets state is global to the page, so overlapping renderers must not each unload it:
// the last owner to release unloads, and a load never starts while a previous unload is still running.
import { Assets, type Spritesheet } from 'pixi.js';

let initPromise: Promise<void> | undefined;
/** Assets.init must run once, before any load, and must not use workers (they need a blob: worker-src the CSP forbids). A rejection is not cached. */
export function initAssets(): Promise<void> {
  initPromise ??= Assets.init({ preferences: { preferWorkers: false } }).catch(error => { initPromise = undefined; throw error; });
  return initPromise;
}

interface Entry { url: string; refs: number; sheet: Promise<Spritesheet> }
let entry: Entry | undefined;
let teardown: Promise<void> = Promise.resolve();

export interface AtlasLease { sheet: Spritesheet; release(): void }

export async function acquireAtlas(url: string): Promise<AtlasLease> {
  await initAssets();
  if (!entry || entry.url !== url) {
    const sheet = teardown.then(() => Assets.load<Spritesheet>(url));
    const created: Entry = { url, refs: 0, sheet };
    entry = created;
    // A failed load must not stay cached for the next owner.
    sheet.catch(() => { if (entry === created) entry = undefined; });
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
    teardown = mine.sheet.then(() => Assets.unload(mine.url), () => undefined).catch(() => undefined);
  };
  try {
    return { sheet: await mine.sheet, release };
  } catch (error) {
    release();
    throw error;
  }
}
