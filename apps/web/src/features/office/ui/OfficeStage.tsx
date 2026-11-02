import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { OfficeModel, OfficeTarget } from '../model/types';
// Type-only: erased at build, so Pixi stays behind the dynamic import below.
import type { OfficeRenderer } from '../scene/renderer';

/**
 * Hosts the Pixi scene. The renderer module (and Pixi with it) is reached only through a dynamic import, so the Classic
 * bundle never references it. If creation rejects (no WebGL, blocked asset), `fallback` is shown instead and nothing else breaks.
 */
export function OfficeStage({ model, onSelect, fallback }: { model: OfficeModel; onSelect: (target: OfficeTarget) => void; fallback: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<OfficeRenderer | undefined>(undefined);
  const latest = useRef({ model, onSelect });
  latest.current = { model, onSelect };
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dead = false;
    const abort = new AbortController();
    const visibility = (): void => renderer.current?.setPaused(document.hidden);
    void import('../scene/renderer')
      .then(m => m.createOfficeRenderer(el, target => latest.current.onSelect(target), abort.signal))
      .then(created => {
        if (dead) { created.destroy(); return; }
        renderer.current = created;
        created.apply(latest.current.model, []);
        visibility();
      })
      .catch(() => { if (!dead) setFailed(true); });
    document.addEventListener('visibilitychange', visibility);
    return () => {
      dead = true;
      abort.abort();
      document.removeEventListener('visibilitychange', visibility);
      renderer.current?.destroy();
      renderer.current = undefined;
    };
  }, []);

  useEffect(() => { renderer.current?.apply(model, []); }, [model]);

  if (failed) return <>{fallback}</>;
  return <div ref={host} tabIndex={0} aria-label="Cảnh văn phòng" className="relative h-[min(60vh,520px)] min-h-64 w-full overflow-hidden bg-[#2b2733]" />;
}
