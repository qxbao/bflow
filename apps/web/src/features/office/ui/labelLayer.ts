import type { ProjectedLabel } from '../scene/renderer';

/**
 * World-anchored text labels drawn over the scene. Imperative on purpose: positions change every rendered frame and must not go through
 * React. Text is set with `textContent` only, the layer ignores pointer events and is hidden from assistive technology (the DOM mirror
 * holds the truth).
 */
export function createLabelLayer(parent: HTMLElement): { update(labels: ProjectedLabel[]): void; destroy(): void } {
  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.className = 'pointer-events-none absolute inset-0 overflow-hidden';
  parent.appendChild(layer);
  const nodes = new Map<string, { el: HTMLDivElement; x: number; y: number; seen: boolean }>();
  return {
    update(labels) {
      for (const n of nodes.values()) n.seen = false;
      for (const l of labels) {
        let n = nodes.get(l.id);
        if (!n) {
          const el = document.createElement('div');
          el.className = l.kind === 'zone'
            ? 'absolute left-0 top-0 whitespace-nowrap rounded-md border border-line bg-surface/70 px-2 py-0.5 font-data text-xs font-semibold tracking-wide text-accent uppercase'
            : 'absolute left-0 top-0 whitespace-nowrap rounded-md bg-surface/80 px-1.5 py-0.5 font-data text-[0.6875rem] leading-4 text-ink';
          el.dataset['kind'] = l.kind;
          layer.appendChild(el);
          n = { el, x: Number.NaN, y: Number.NaN, seen: true };
          nodes.set(l.id, n);
        }
        n.seen = true;
        if (n.el.textContent !== l.text) n.el.textContent = l.text;
        // Unchanged positions write nothing.
        const x = Math.round(l.x), y = Math.round(l.y);
        if (x !== n.x || y !== n.y) {
          n.x = x; n.y = y;
          n.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, ${l.kind === 'agent' ? '-100%' : '-50%'})`;
        }
      }
      for (const [id, n] of nodes) if (!n.seen) { n.el.remove(); nodes.delete(id); }
    },
    destroy() { layer.remove(); nodes.clear(); },
  };
}
