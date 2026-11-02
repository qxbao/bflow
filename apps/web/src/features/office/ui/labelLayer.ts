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
  const nodes = new Map<string, HTMLDivElement>();
  return {
    update(labels) {
      const keep = new Set<string>();
      for (const l of labels) {
        keep.add(l.id);
        let el = nodes.get(l.id);
        if (!el) {
          el = document.createElement('div');
          el.className = l.kind === 'zone'
            ? 'absolute left-0 top-0 whitespace-nowrap rounded-md border border-line bg-surface/70 px-2 py-0.5 font-data text-xs font-semibold tracking-wide text-accent uppercase'
            : 'absolute left-0 top-0 whitespace-nowrap rounded-md bg-surface/80 px-1.5 py-0.5 font-data text-[0.6875rem] leading-4 text-ink';
          layer.appendChild(el);
          nodes.set(l.id, el);
        }
        if (el.textContent !== l.text) el.textContent = l.text;
        el.style.transform = `translate(${Math.round(l.x)}px, ${Math.round(l.y)}px) translate(-50%, ${l.kind === 'agent' ? '-100%' : '-50%'})`;
      }
      for (const [id, el] of nodes) if (!keep.has(id)) { el.remove(); nodes.delete(id); }
    },
    destroy() { layer.remove(); nodes.clear(); },
  };
}
