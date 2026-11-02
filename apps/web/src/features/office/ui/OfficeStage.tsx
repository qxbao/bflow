import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { diffVisual } from '../model/timeline';
import type { OfficeFocusZone, OfficeModel, OfficeTarget } from '../model/types';
// Type-only: erased at build, so three.js stays behind the dynamic import below.
import type { OfficeRenderer } from '../scene/renderer';
import { AccessibleOffice } from './AccessibleOffice';
import { createLabelLayer } from './labelLayer';

export type CreateRenderer = (host: HTMLElement, onSelect: (target: OfficeTarget) => void, signal: AbortSignal, onContextLost: () => void) => Promise<OfficeRenderer>;
const lazyRenderer: CreateRenderer = (host, onSelect, signal, onLost) => import('../scene/renderer').then(m => m.createOfficeRenderer(host, onSelect, signal, onLost));

const FAILED = 'Không dựng được cảnh đồ họa (WebGL không khả dụng). Danh sách dưới đây có đầy đủ thông tin.';
const LOST = 'Cảnh đồ họa bị mất ngữ cảnh hiển thị nên đã chuyển sang danh sách.';
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Hosts the 3D scene plus its DOM mirror. The renderer module (and three.js with it) is reached only through a dynamic import, so the
 * Classic bundle never references it. If creation rejects (no WebGL, blocked asset) or the context is lost later, the mirror becomes
 * the visible list and nothing else in the panel is touched. There is no retry loop.
 * `links` is extra navigation shown with the mirror until the scene objects navigate (V7.2).
 */
/** What the HUD may ask of the scene. Present only while the stage is mounted; a missing or failed renderer ignores the call. */
export interface StageControl { focusZone(zone: OfficeFocusZone): void; /** Pixels the HUD or panel covers; hides labels in it and centres selections in the rest. Never moves the camera. */ setInset(inset: { right: number; bottom: number; left: number }): void; /** Moves focus into the agent list (the DOM mirror), which shows itself while focused. */ openList(): void }

export function OfficeStage({ model, onSelect, links, control, createRenderer = lazyRenderer }: { model: OfficeModel; onSelect: (target: OfficeTarget) => void; links?: ReactNode; control?: MutableRefObject<StageControl | null>; createRenderer?: CreateRenderer }) {
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Remembered so a renderer created after the first inset still receives it.
  const inset = useRef<{ right: number; bottom: number; left: number } | undefined>(undefined);
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
    let dead = false, failed = false;
    let labelLayer: ReturnType<typeof createLabelLayer> | undefined;
    const abort = new AbortController();
    const visibility = (): void => renderer.current?.setPaused(document.hidden);
    const lose = (): void => {
      if (dead || failed) return;
      failed = true;
      abort.abort();
      const lostRenderer = renderer.current;
      renderer.current = undefined;
      labelLayer?.destroy();
      // Notice first: a throwing destroy must still leave the visible list.
      setNotice(LOST);
      try { lostRenderer?.destroy(); } catch { /* the context is gone; nothing left to release */ }
    };
    latest.current.createRenderer(el, target => latest.current.onSelect(target), abort.signal, lose)
      .then(created => {
        if (dead || failed) { created.destroy(); return; }
        renderer.current = created;
        labelLayer = createLabelLayer(el);
        if (inset.current) created.setInset?.(inset.current);
        created.setLabelSink?.(labels => labelLayer?.update(labels));
        created.apply(latest.current.model, []);
        visibility();
      })
      .catch(() => { if (!dead && !failed) setNotice(FAILED); });
    document.addEventListener('visibilitychange', visibility);
    return () => {
      dead = true;
      abort.abort();
      document.removeEventListener('visibilitychange', visibility);
      renderer.current?.setLabelSink?.(undefined);
      renderer.current?.destroy();
      renderer.current = undefined;
      labelLayer?.destroy();
    };
  }, []);

  useEffect(() => {
    if (!control) return;
    control.current = { focusZone: zone => renderer.current?.focusZone?.(zone), setInset: i => { inset.current = i; renderer.current?.setInset?.(i); }, openList: () => root.current?.querySelector<HTMLElement>('section[aria-label] button')?.focus() };
    return () => { control.current = null; };
  }, [control]);

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
  // Degraded: the visible list scrolls inside the full-screen stage, clear of the floating HUD.
  return <div ref={root} className={degraded ? 'relative h-full overflow-y-auto px-4 pt-32 pb-40 md:pr-24' : 'relative h-full'}>
    {!degraded && <div ref={host} tabIndex={0} aria-label="Cảnh văn phòng" className="relative h-full min-h-64 w-full overflow-hidden bg-[#dfe5e6]" />}
    <AccessibleOffice model={model} onSelect={target => { latest.current.onSelect(target); renderer.current?.focus?.(target); }} visible={degraded} notice={notice} extra={links} />
  </div>;
}
