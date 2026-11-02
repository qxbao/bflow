// Pure camera maths. The camera never moves by itself: every function here is called from a user gesture or a user-driven resize.
export interface Camera { zoom: number; x: number; y: number }
export interface Size { w: number; h: number }
export interface Point { x: number; y: number }

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** At least this many screen pixels of the world stay inside the view, so the scene can never be dragged out of sight. */
export const KEEP_VISIBLE = 96;
export const KEY_STEP = 32;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const axis = (pos: number, world: number, view: number, zoom: number): number => {
  const size = world * zoom;
  const keep = Math.min(KEEP_VISIBLE, size, view);
  return clamp(Math.round(pos), keep - size, view - keep);
};

/** Keeps the world partly in view. Positions are whole pixels (roundPixels). */
export function clampCamera(cam: Camera, view: Size, world: Size): Camera {
  const zoom = clamp(Math.round(cam.zoom), MIN_ZOOM, MAX_ZOOM);
  return { zoom, x: axis(cam.x, world.w, view.w, zoom), y: axis(cam.y, world.h, view.h, zoom) };
}

/** Largest integer zoom that shows the whole world, centred. Used once at creation and by the "0" key. */
export function fitCamera(view: Size, world: Size): Camera {
  const zoom = clamp(Math.floor(Math.min(view.w / world.w, view.h / world.h)), MIN_ZOOM, MAX_ZOOM);
  return clampCamera({ zoom, x: (view.w - world.w * zoom) / 2, y: (view.h - world.h * zoom) / 2 }, view, world);
}

export function panBy(cam: Camera, dx: number, dy: number, view: Size, world: Size): Camera {
  return clampCamera({ ...cam, x: cam.x + dx, y: cam.y + dy }, view, world);
}

/** Integer zoom step that keeps the world point under `anchor` (view pixels) fixed. */
export function zoomBy(cam: Camera, step: 1 | -1, anchor: Point, view: Size, world: Size): Camera {
  const zoom = clamp(cam.zoom + step, MIN_ZOOM, MAX_ZOOM);
  if (zoom === cam.zoom) return cam;
  const wx = (anchor.x - cam.x) / cam.zoom, wy = (anchor.y - cam.y) / cam.zoom;
  return clampCamera({ zoom, x: anchor.x - wx * zoom, y: anchor.y - wy * zoom }, view, world);
}

export type CameraKey = { kind: 'pan'; dx: number; dy: number } | { kind: 'zoom'; step: 1 | -1 } | { kind: 'fit' };

/** §5.4 keyboard: arrows pan, + / - zoom, 0 fits. Anything else is not ours. */
export function cameraKey(key: string): CameraKey | undefined {
  switch (key) {
    case 'ArrowLeft': return { kind: 'pan', dx: KEY_STEP, dy: 0 };
    case 'ArrowRight': return { kind: 'pan', dx: -KEY_STEP, dy: 0 };
    case 'ArrowUp': return { kind: 'pan', dx: 0, dy: KEY_STEP };
    case 'ArrowDown': return { kind: 'pan', dx: 0, dy: -KEY_STEP };
    case '+': case '=': return { kind: 'zoom', step: 1 };
    case '-': case '_': return { kind: 'zoom', step: -1 };
    case '0': return { kind: 'fit' };
    default: return undefined;
  }
}
