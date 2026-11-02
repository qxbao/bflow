import { useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../../api/client';

export const EXCERPT_POLL_MS = 4_000;
/** After a failed read the last map is kept this long, then cleared. */
export const EXCERPT_KEEP_MS = 30_000;
const UNSUPPORTED_CODES = new Set(['operation_not_allowed', 'not_found']);
const EMPTY: ReadonlyMap<string, string> = new Map();
const same = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean => a.size === b.size && [...b].every(([k, v]) => a.get(k) === v);

/**
 * Latest terminal text per agent instance for the scene's message boxes. Polls every 4 s while enabled and the tab is visible, never with
 * two reads in flight. A backend without the read (`operation_not_allowed`/`not_found`) stops polling for this mount. A failed read keeps the
 * last map for 30 s and then clears it. The returned Map is replaced only when its contents change.
 */
export function useAgentExcerpts({ api, id, enabled }: { api: ApiClient; id: string; enabled: boolean }): ReadonlyMap<string, string> {
  const [held, setHeld] = useState<{ id: string; map: ReadonlyMap<string, string> }>({ id, map: EMPTY });
  const current = useRef<ReadonlyMap<string, string>>(EMPTY);
  useEffect(() => {
    // A map never outlives its project or its enabled state.
    if (current.current.size > 0) { current.current = EMPTY; setHeld({ id, map: EMPTY }); }
    if (!enabled) return;
    let dead = false, stopped = false, busy = false, lastOk = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    const put = (next: ReadonlyMap<string, string>): void => { if (!dead && !same(current.current, next)) { current.current = next; setHeld({ id, map: next }); } };
    const read = (): void => {
      if (dead || stopped || busy || document.hidden) return;
      busy = true;
      api.readWorkforceExcerpts(id).then(view => {
        if (dead) return;
        lastOk = Date.now();
        put(new Map(view.items.map(item => [item.instanceId, item.text] as const)));
      }, (error: unknown) => {
        if (dead) return;
        if (error instanceof ApiError && UNSUPPORTED_CODES.has(error.code)) { stopped = true; put(EMPTY); stop(); return; }
        if (Date.now() - lastOk >= EXCERPT_KEEP_MS) put(EMPTY);
      }).finally(() => { busy = false; });
    };
    const start = (): void => { if (timer === undefined) timer = setInterval(read, EXCERPT_POLL_MS); };
    const stop = (): void => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
    const onVisibility = (): void => { if (document.hidden) stop(); else if (!stopped) { read(); start(); } };
    if (!document.hidden) { read(); start(); }
    document.addEventListener('visibilitychange', onVisibility);
    return () => { dead = true; stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [api, id, enabled]);
  // The first render after an id change must not show the old project's text.
  return enabled && held.id === id ? held.map : EMPTY;
}
