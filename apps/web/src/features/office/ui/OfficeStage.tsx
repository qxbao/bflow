import { useEffect, useRef, useState, type ReactNode } from 'react';
import { diffVisual } from '../model/timeline';
import type { OfficeModel, OfficeTarget } from '../model/types';
// Type-only: erased at build, so Pixi stays behind the dynamic import below.
import type { OfficeRenderer } from '../scene/renderer';
import { AccessibleOffice } from './AccessibleOffice';

export type CreateRenderer = (host: HTMLElement, onSelect: (target: OfficeTarget) => void, signal: AbortSignal, onContextLost: () => void) => Promise<OfficeRenderer>;
const lazyRenderer: CreateRenderer = (host, onSelect, signal, onLost) => import('../scene/renderer').then(m => m.createOfficeRenderer(host, onSelect, signal, onLost));

const FAILED = 'Không dựng được cảnh đồ họa (WebGL không khả dụng). Danh sách dưới đây có đầy đủ thông tin.';
const LOST = 'Cảnh đồ họa bị mất ngữ cảnh hiển thị nên đã chuyển sang danh sách.';
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Hosts the Pixi scene plus its DOM mirror. The renderer module (and Pixi with it) is reached only through a dynamic import, so the
 * Classic bundle never references it. If creation rejects (no WebGL, blocked asset) or the context is lost later, the mirror becomes
 * the visible list and nothing else in the panel is touched. There is no retry loop.
 * `links` is extra navigation shown with the mirror until the scene objects navigate (V7.2).
 */
export function OfficeStage({ model, onSelect, links, createRenderer = lazyRenderer }: { model: OfficeModel; onSelect: (target: OfficeTarget) => void; links?: ReactNode; createRenderer?: CreateRenderer }) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<OfficeRenderer | undefined>(undefined);
  const latest = useRef({ model, onSelect, createRenderer });
  latest.current = { model, onSelect, createRenderer };
  const [notice, setNotice] = useState<string | undefined>(undefined);
  // The consumer owns the walked set (timeline contract): ids whose walk was handed to the renderer never walk again.
  const walked = useRef(new Set<string>());
  const previous = useRef<OfficeModel | undefined>(undefined);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dead = false;
    const abort = new AbortController();
    const visibility = (): void => renderer.current?.setPaused(document.hidden);
    const lose = (): void => {
      if (dead) return;
      const lostRenderer = renderer.current;
      renderer.current = undefined;
      // Notice first: a throwing destroy must still leave the visible list.
      setNotice(LOST);
      try { lostRenderer?.destroy(); } catch { /* the context is gone; nothing left to release */ }
    };
    latest.current.createRenderer(el, target => latest.current.onSelect(target), abort.signal, lose)
      .then(created => {
        if (dead) { created.destroy(); return; }
        renderer.current = created;
        created.apply(latest.current.model, []);
        visibility();
      })
      .catch(() => { if (!dead) setNotice(FAILED); });
    document.addEventListener('visibilitychange', visibility);
    return () => {
      dead = true;
      abort.abort();
      document.removeEventListener('visibilitychange', visibility);
      renderer.current?.destroy();
      renderer.current = undefined;
    };
  }, []);

  useEffect(() => {
    const cues = diffVisual(previous.current, model, walked.current);
    previous.current = model;
    // Reduced motion: no walking at all, so the scene never sees a walk cue and poses change instantly.
    const send = reducedMotion() ? cues.filter(c => c.kind !== 'walk') : cues;
    // Forget handoffs that left the model.
    const present = new Set(model.handoffs.map(h => h.handoffId));
    for (const id of walked.current) if (!present.has(id)) walked.current.delete(id);
    if (!renderer.current) return;
    // Only walks the renderer accepted count as walked; ones it dropped (hidden tab) stay eligible.
    for (const id of renderer.current.apply(model, send) ?? []) walked.current.add(id);
  }, [model]);

  const degraded = notice !== undefined;
  return <div className="relative">
    {!degraded && <div ref={host} tabIndex={0} aria-label="Cảnh văn phòng" className="relative h-[min(60vh,520px)] min-h-64 w-full overflow-hidden bg-[#2b2733]" />}
    <AccessibleOffice model={model} onSelect={target => latest.current.onSelect(target)} visible={degraded} notice={notice} extra={links} />
  </div>;
}
