import type { ProjectedLabel } from '../scene/renderer';

const CLASSES: Record<ProjectedLabel['kind'], string> = {
  agent: 'absolute left-0 top-0 whitespace-nowrap rounded-md border border-line bg-surface/95 px-1.5 py-0.5 font-data text-[0.6875rem] leading-4 text-ink shadow-sm',
  bubble: 'office-bubble absolute left-0 top-0',
  sleep: 'office-zzz absolute left-0 top-0',
};

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
          el.className = CLASSES[l.kind];
          el.dataset['kind'] = l.kind;
          // Sleep is drawn as three small z letters that drift up and fade out, one after another; the label text is not shown.
          if (l.kind === 'sleep') for (let i = 0; i < 3; i++) { const z = document.createElement('span'); z.textContent = 'z'; el.appendChild(z); }
          layer.appendChild(el);
          n = { el, x: Number.NaN, y: Number.NaN, seen: true };
          nodes.set(l.id, n);
        }
        n.seen = true;
        if (l.kind !== 'sleep' && n.el.textContent !== l.text) n.el.textContent = l.text;
        // Unchanged positions write nothing.
        const x = Math.round(l.x), y = Math.round(l.y);
        if (x !== n.x || y !== n.y) {
          n.x = x; n.y = y;
          n.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
        }
      }
      for (const [id, n] of nodes) if (!n.seen) { n.el.remove(); nodes.delete(id); }
    },
    destroy() { layer.remove(); nodes.clear(); },
  };
}
