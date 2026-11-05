import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { diffVisual } from '../model/timeline';
import type { OfficeFocusZone, OfficeModel, OfficeTarget } from '../model/types';
// Type-only: erased at build, so three.js stays behind the dynamic import below.
import type { OfficeRenderer } from '../scene/renderer';
import { AccessibleOffice } from './AccessibleOffice';
import { createLabelLayer } from './labelLayer';

export type CreateRenderer = (host: HTMLElement, onSelect: (target: OfficeTarget) => void, signal: AbortSignal, onContextLost: () => void, options?: { immersive?: boolean; onDeselect?: () => void }) => Promise<OfficeRenderer>;
const lazyRenderer: CreateRenderer = (host, onSelect, signal, onLost, options) => import('../scene/renderer').then(m => m.createOfficeRenderer(host, onSelect, signal, onLost, options));

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
export type CameraControl = 'left' | 'right' | 'up' | 'down' | 'zoom-in' | 'zoom-out';
export interface StageControl { focusZone(zone: OfficeFocusZone): void; /** Pixels the HUD or panel covers; hides labels in it and centres selections in the rest. Never moves the camera. */ setInset(inset: { right: number; bottom: number; left: number }): void; highlight?(target?: OfficeTarget): void; preview?(target?: OfficeTarget): void; setInteracting?(active: boolean): void; camera?(action: CameraControl): void; /** Moves focus into the agent list (the DOM mirror), which shows itself while focused. */ openList(): void }

export function OfficeStage({ model, onSelect, links, control, excerpts: excerptMap, immersive = false, createRenderer = lazyRenderer }: { model: OfficeModel; /** Latest terminal text per agent for the message boxes; kept for a renderer created later. */ excerpts?: ReadonlyMap<string, string>; immersive?: boolean; onSelect: (target: OfficeTarget) => void; links?: ReactNode; control?: MutableRefObject<StageControl | null>; createRenderer?: CreateRenderer }) {
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Remembered so a renderer created after the first inset still receives it.
  const inset = useRef<{ right: number; bottom: number; left: number } | undefined>(undefined);
  const excerpts = useRef<ReadonlyMap<string, string> | undefined>(excerptMap);
  excerpts.current = excerptMap;
  const renderer = useRef<OfficeRenderer | undefined>(undefined);
  const interacting = useRef(false);
  const selected = useRef<OfficeTarget | undefined>(undefined);
  const preview = useRef<OfficeTarget | undefined>(undefined);
  const latest = useRef({ model, onSelect, createRenderer, immersive });
  latest.current = { model, onSelect, createRenderer, immersive };
  const connector = useRef<SVGSVGElement | null>(null), connectorLine = useRef<SVGLineElement | null>(null), connectorDot = useRef<SVGCircleElement | null>(null);
  const directorPoint = useRef<{ x: number; y: number } | undefined>(undefined), drawConnector = useRef<() => void>(() => {});
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
    const updateConnector = (): void => {
      const svg = connector.current, line = connectorLine.current, dot = connectorDot.current, point = directorPoint.current;
      const panel = document.querySelector<HTMLElement>('.director-dialogue');
      if (!svg || !line || !dot || !point || !panel || window.innerWidth < 768 || getComputedStyle(panel).display === 'none') { if (svg) svg.style.display = 'none'; return; }
      const rect = el.getBoundingClientRect(), box = panel.getBoundingClientRect(), x1 = point.x + rect.left, y1 = point.y + rect.top, x2 = box.left, y2 = Math.max(box.top + 44, Math.min(box.bottom - 44, y1));
      line.setAttribute('x1', String(x1)); line.setAttribute('y1', String(y1)); line.setAttribute('x2', String(x2)); line.setAttribute('y2', String(y2));
      dot.setAttribute('cx', String(x1)); dot.setAttribute('cy', String(y1)); svg.style.display = '';
    };
    drawConnector.current = updateConnector;
    const dialogueChange = (): void => updateConnector();
    const lose = (): void => {
      if (dead || failed) return;
      failed = true;
      abort.abort();
      const lostRenderer = renderer.current;
      renderer.current = undefined;
      labelLayer?.destroy();
      directorPoint.current = undefined; connector.current?.remove(); connector.current = null; connectorLine.current = null; connectorDot.current = null; updateConnector();
      // Notice first: a throwing destroy must still leave the visible list.
      setNotice(LOST);
      try { lostRenderer?.destroy(); } catch { /* the context is gone; nothing left to release */ }
    };
    latest.current.createRenderer(el, target => { selected.current = target; latest.current.onSelect(target); }, abort.signal, lose, { immersive: latest.current.immersive, onDeselect: () => { selected.current = undefined; } })
      .then(created => {
        if (dead || failed) { created.destroy(); return; }
        renderer.current = created;
        labelLayer = createLabelLayer(el);
        if (latest.current.immersive) {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('width', '100vw'); svg.setAttribute('height', '100vh');
          svg.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:49;pointer-events:none;overflow:visible;display:none';
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'), dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          line.setAttribute('stroke', 'var(--color-accent)'); line.setAttribute('stroke-width', '2'); line.setAttribute('stroke-dasharray', '5 5'); line.setAttribute('opacity', '.7');
          dot.setAttribute('r', '5'); dot.setAttribute('fill', 'var(--color-accent)'); svg.append(line, dot); document.body.appendChild(svg);
          connector.current = svg; connectorLine.current = line; connectorDot.current = dot;
        }
        if (inset.current) created.setInset?.(inset.current);
        if (excerpts.current) created.setExcerpts?.(excerpts.current);
        created.setLabelSink?.(labels => {
          labelLayer?.update(labels);
          const director = labels.find(label => label.id === 'director');
          directorPoint.current = director ? { x: director.x, y: director.y } : undefined;
          if (director && document.querySelector('.director-dialogue')) updateConnector(); else connector.current?.style.setProperty('display', 'none');
        });
        created.apply(latest.current.model, []);
        if (selected.current) { created.highlight?.(selected.current); created.focus?.(selected.current); }
        else if (preview.current) created.preview?.(preview.current);
        created.setInteracting?.(interacting.current);
        visibility();
      })
      .catch(() => { if (!dead && !failed) setNotice(FAILED); });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', dialogueChange);
    window.addEventListener('bflow:director-dialogue-state', dialogueChange);
    return () => {
      dead = true;
      abort.abort();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', dialogueChange);
      window.removeEventListener('bflow:director-dialogue-state', dialogueChange);
      renderer.current?.setLabelSink?.(undefined);
      directorPoint.current = undefined; connector.current?.remove(); connector.current = null; connectorLine.current = null; connectorDot.current = null; drawConnector.current = () => {};
      renderer.current?.destroy();
      renderer.current = undefined;
      labelLayer?.destroy();
    };
  }, []);

  useEffect(() => { if (excerptMap) renderer.current?.setExcerpts?.(excerptMap); }, [excerptMap]);

  useEffect(() => {
    if (!control) return;
    control.current = { focusZone: zone => renderer.current?.focusZone?.(zone), setInset: i => { inset.current = i; renderer.current?.setInset?.(i); }, highlight: target => { selected.current = target; renderer.current?.highlight?.(target); }, preview: target => { preview.current = target; renderer.current?.preview?.(target); }, setInteracting: active => { interacting.current = active; renderer.current?.setInteracting?.(active); if (active) drawConnector.current(); else if (connector.current) connector.current.style.display = 'none'; }, camera: action => renderer.current?.cameraControl?.(action), openList: () => root.current?.querySelector<HTMLElement>('section[aria-label] button')?.focus() };
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
    <AccessibleOffice model={model} onSelect={target => { selected.current = target; latest.current.onSelect(target); renderer.current?.highlight?.(target); renderer.current?.focus?.(target); }} onTargetFocus={target => { preview.current = target; renderer.current?.preview?.(target); }} onTargetBlur={() => { preview.current = undefined; renderer.current?.preview?.(undefined); }} onTargetEscape={() => { preview.current = undefined; selected.current = undefined; renderer.current?.preview?.(undefined); renderer.current?.highlight?.(undefined); renderer.current?.setInteracting?.(false); }} visible={degraded} notice={notice} extra={links} />
  </div>;
}
