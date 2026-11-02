// Office scene (V3.1 static, V3.2 animated). Reads an OfficeModel and draws it; emits selections and never writes anywhere else.
// `pixi.js/unsafe-eval` swaps code generation for polyfills, so the CSP stays free of 'unsafe-eval'. It must load first.
import 'pixi.js/unsafe-eval';
import { Application, Container, Sprite, TextureStyle, type Spritesheet, type Texture } from 'pixi.js';
import { acquireAtlas } from './atlas';
import type { OfficeModel, OfficeObjectId, OfficeTarget } from '../model/types';
import { handoffMarks, type VisualCue } from '../model/timeline';
import { Choreographer, frameName } from './actors';
import { cameraKey, clampCamera, fitCamera, panBy, pinchStep, zoomBy, type Camera } from './camera';
import { ATLAS_URL_PATH, BUBBLE_FRAME, DESK_CELLS, GRID_H, GRID_W, OBJECT_CELLS, PLANT_CELLS, TILE_H, TILE_W, WORLD, cellCentre, depth, isRug, type Cell, type Point } from './layers';

export interface OfficeRenderer {
  apply(model: OfficeModel, cues: VisualCue[]): void;
  setPaused(paused: boolean): void;
  destroy(): void;
}

const BACKGROUND = 0x2b2733;
const DRAG_THRESHOLD = 4;
const WHEEL_GAP_MS = 120;
const atlasUrl = (): string => `${import.meta.env.BASE_URL}${ATLAS_URL_PATH}`;
const alphaFor = (certainty: string, pose: string): number => (pose === 'ghost' ? 0.45 : certainty === 'confirmed' ? 1 : certainty === 'inferred' ? 0.85 : 0.55);

/**
 * `signal` lets the caller cancel a creation that is no longer wanted; a cancelled creation rejects without touching the page or the shared atlas.
 * `onContextLost` fires once if the WebGL context is lost after creation. The renderer does not retry: the caller shows its fallback and destroys it.
 */
export async function createOfficeRenderer(host: HTMLElement, onSelect: (target: OfficeTarget) => void, signal?: AbortSignal, onContextLost?: () => void): Promise<OfficeRenderer> {
  const cancelled = (): Error => new DOMException('office renderer creation cancelled', 'AbortError');
  if (signal?.aborted) throw cancelled();
  const lease = await acquireAtlas(atlasUrl());
  const app = new Application();
  try {
    if (signal?.aborted) throw cancelled();
    TextureStyle.defaultOptions.scaleMode = 'nearest';
    await app.init({
      preference: 'webgl', roundPixels: true, antialias: false, background: BACKGROUND,
      width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight), resolution: Math.max(1, Math.round(window.devicePixelRatio || 1)), autoDensity: true, autoStart: false,
    });
    if (signal?.aborted) throw cancelled();
    return build(app, lease.sheet, lease.release, host, onSelect, onContextLost);
  } catch (error) {
    // The atlas textures belong to the shared lease, never to this app.
    try { app.destroy(true, { children: true }); } catch { /* init may have failed before a renderer existed */ }
    lease.release();
    throw error;
  }
}

function build(app: Application, sheet: Spritesheet, release: () => void, host: HTMLElement, rawSelect: (target: OfficeTarget) => void, onContextLost?: () => void): OfficeRenderer {
  const size = (): { w: number; h: number } => ({ w: Math.max(1, host.clientWidth), h: Math.max(1, host.clientHeight) });
  // A tap that ends a drag or a pinch is not a selection.
  let suppressTap = false;
  const onSelect = (target: OfficeTarget): void => { if (!suppressTap) rawSelect(target); };
  const canvas = app.canvas;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.imageRendering = 'pixelated';
  canvas.style.touchAction = 'none';
  canvas.style.display = 'block';
  host.appendChild(canvas);
  app.ticker.maxFPS = 30;

  const tex = (name: string): Texture => {
    const texture = sheet.textures[name] ?? sheet.textures['agent_developer'];
    if (!texture) throw new Error(`office atlas has no frame ${name}`);
    return texture;
  };
  const world = new Container();
  const floor = new Container();
  const things = new Container();
  things.sortableChildren = true;
  world.addChild(floor, things);
  app.stage.addChild(world);

  const at = (sprite: Sprite, cell: Cell, dy: number): Sprite => { const p = cellCentre(cell); sprite.position.set(p.x, p.y + dy); return sprite; };
  for (let gy = 0; gy < GRID_H; gy++) for (let gx = 0; gx < GRID_W; gx++) {
    const cell = { gx, gy };
    const s = new Sprite(tex(isRug(cell) ? 'floor_rug' : (gx + gy) % 2 === 0 ? 'floor_a' : 'floor_b'));
    const p = cellCentre(cell);
    s.position.set(p.x - TILE_W / 2, p.y - TILE_H / 2);
    floor.addChild(s);
  }
  for (let gy = 0; gy < GRID_H; gy++) { const w = new Sprite(tex('wall_nw')); const p = cellCentre({ gx: 0, gy }); w.position.set(p.x - TILE_W / 2, p.y - 40); floor.addChild(w); }
  for (let gx = 0; gx < GRID_W; gx++) { const w = new Sprite(tex('wall_ne')); const p = cellCentre({ gx, gy: 0 }); w.position.set(p.x, p.y - 40); floor.addChild(w); }
  floor.cacheAsTexture?.(true);

  const prop = (name: string, cell: Cell): Sprite => {
    const s = at(new Sprite(tex(name)), cell, TILE_H / 2);
    s.anchor.set(0.5, 1);
    s.zIndex = depth(cell, 'object');
    things.addChild(s);
    return s;
  };
  for (const cell of DESK_CELLS) prop('desk', cell);
  for (const cell of PLANT_CELLS) prop('plant', cell);
  for (const [object, cell] of Object.entries(OBJECT_CELLS) as [OfficeObjectId, Cell][]) {
    const s = prop(object, cell);
    s.eventMode = 'static';
    s.cursor = 'pointer';
    s.on('pointertap', () => onSelect({ kind: 'object', object }));
  }

  const agents = new Map<string, Sprite>();
  const bubbles = new Map<string, Sprite>();
  // Reduced motion also freezes the clip frames; the caller separately never sends walk cues.
  const choreo = new Choreographer(!(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches));
  let paused = false, dirty = true, destroyed = false, closed = false;
  // The first fit waits for a real size (a host laid out later reports 0x0) and happens once; after that only user gestures move the camera.
  const sized = (): boolean => host.clientWidth > 0 && host.clientHeight > 0;
  let fitted = sized();
  let camera: Camera = fitted ? fitCamera(size(), WORLD) : { zoom: 1, x: 0, y: 0 };
  const view = (): { w: number; h: number } => size();
  const place = (): void => { world.position.set(camera.x, camera.y); world.scale.set(camera.zoom); dirty = true; };
  place();

  const renderNow = (): void => {
    app.render();
    if (host.dataset.officeRenderer !== 'ready') host.dataset.officeRenderer = 'ready';
  };
  // Actors: one sprite per view, textured by clip frame. Run on every change of a view, never on a timer of its own.
  const syncActors = (): void => {
    const keep = new Set<string>();
    for (const view of choreo.views()) {
      keep.add(view.instanceId);
      let sprite = agents.get(view.instanceId);
      if (!sprite) {
        sprite = new Sprite();
        sprite.anchor.set(0.5, 1);
        sprite.eventMode = 'static';
        sprite.cursor = 'pointer';
        const instanceId = view.instanceId;
        sprite.on('pointertap', () => onSelect({ kind: 'agent', instanceId }));
        things.addChild(sprite);
        agents.set(view.instanceId, sprite);
      }
      sprite.texture = tex(frameName(view.role, view.clip, view.frame));
      sprite.position.set(view.point.x, view.point.y + TILE_H / 2 - 2);
      sprite.zIndex = depth(view.cell, 'agent');
      sprite.alpha = alphaFor(view.certainty, view.pose);
    }
    for (const [id, sprite] of agents) if (!keep.has(id)) { sprite.destroy(); agents.delete(id); }
  };
  // Desk indicators come from handoff state alone, so they are drawn on every apply (a first snapshot carries no cues).
  const syncBubbles = (model: OfficeModel): void => {
    const keep = new Set<string>();
    const stacked = new Map<string, number>();
    for (const mark of handoffMarks(model)) {
      const cell = choreo.cellFor(mark.at);
      if (!cell) continue;
      keep.add(mark.handoffId);
      let sprite = bubbles.get(mark.handoffId);
      if (!sprite) { sprite = new Sprite(); sprite.anchor.set(0.5, 1); things.addChild(sprite); bubbles.set(mark.handoffId, sprite); }
      const slot = `${cell.gx},${cell.gy}`, n = stacked.get(slot) ?? 0;
      stacked.set(slot, n + 1);
      const p = cellCentre(cell);
      sprite.texture = tex(BUBBLE_FRAME[mark.mark]);
      sprite.position.set(p.x + n * 9, p.y + TILE_H / 2 - 2 - 46);
      sprite.zIndex = depth(cell, 'agent') + 2;
    }
    for (const [id, sprite] of bubbles) if (!keep.has(id)) { sprite.destroy(); bubbles.delete(id); }
  };
  // 30 fps while someone walks, 8 otherwise (§5.6); a frame is drawn only when something changed.
  app.ticker.add(ticker => {
    if (paused || destroyed) return;
    const { moving, changed } = choreo.tick(ticker.deltaMS);
    app.ticker.maxFPS = moving ? 30 : 8;
    if (changed) { syncActors(); dirty = true; }
    if (dirty) { dirty = false; renderNow(); }
  });
  app.ticker.start();

  // --- camera input: user gestures only ---
  const move = (next: Camera): void => { if (next !== camera) { camera = next; place(); } };
  let drag: { id: number; x: number; y: number; moved: boolean } | undefined;
  const pointers = new Map<number, Point>();
  let pinchDist = 0;
  const spread = (): number => { const [a, b] = [...pointers.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'mouse') resetPointers();
    if (pointers.size === 0) suppressTap = false;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { drag = undefined; pinchDist = spread(); suppressTap = true; }
    else if (pointers.size === 1) drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };
  const onMove = (e: PointerEvent): void => {
    if (!pointers.has(e.pointerId)) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) { resetPointers(); return; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const dist = spread(), step = pinchStep(pinchDist, dist);
      if (step !== 0) {
        const [a, b] = [...pointers.values()] as [Point, Point];
        const box = canvas.getBoundingClientRect();
        move(zoomBy(camera, step, { x: (a.x + b.x) / 2 - box.left, y: (a.y + b.y) / 2 - box.top }, view(), WORLD));
        pinchDist = dist;
      }
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    suppressTap = true;
    drag.x = e.clientX; drag.y = e.clientY;
    move(panBy(camera, dx, dy, view(), WORLD));
  };
  // A pointerup can be lost (window blur, tab switch, OS gesture); stale entries would turn the next touch into a pinch.
  const resetPointers = (): void => { pointers.clear(); drag = undefined; pinchDist = 0; };
  const onUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (drag && e.pointerId === drag.id) drag = undefined;
    pinchDist = 0;
  };
  let lastWheel = 0;
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (e.timeStamp - lastWheel < WHEEL_GAP_MS || e.deltaY === 0) return;
    lastWheel = e.timeStamp;
    const box = canvas.getBoundingClientRect();
    move(zoomBy(camera, e.deltaY < 0 ? 1 : -1, { x: e.clientX - box.left, y: e.clientY - box.top }, view(), WORLD));
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    const action = cameraKey(e.key);
    if (!action) return;
    e.preventDefault();
    const v = view();
    if (action.kind === 'pan') move(panBy(camera, action.dx, action.dy, v, WORLD));
    else if (action.kind === 'zoom') move(zoomBy(camera, action.step, { x: v.w / 2, y: v.h / 2 }, v, WORLD));
    else move(fitCamera(v, WORLD));
  };
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('blur', resetPointers);
  document.addEventListener('visibilitychange', resetPointers);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  host.addEventListener('keydown', onKey);
  // A resize only clamps the camera so the scene stays reachable; it never re-centres.
  const observer = new ResizeObserver(() => {
    if (destroyed) return;
    if (!sized()) return;
    const v = view();
    app.renderer.resize(v.w, v.h);
    camera = fitted ? clampCamera(camera, v, WORLD) : fitCamera(v, WORLD);
    fitted = true;
    place();
  });
  observer.observe(host);
  const onLost = (e: Event): void => { e.preventDefault(); if (!destroyed) onContextLost?.(); };
  const onRestored = (): void => { dirty = true; };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  return {
    apply(model, cues) {
      if (destroyed) return;
      // Hidden tab: cues are dropped, only the latest pose matters.
      choreo.apply(model, paused ? [] : cues);
      syncActors();
      syncBubbles(model);
      // Closed session: the office is dark. The last saved data stays visible.
      world.tint = model.tier === 'closed' ? 0x6a6a80 : 0xffffff;
      dirty = true;
    },
    setPaused(next) {
      if (next === paused) return;
      paused = next;
      if (next) { choreo.pause(); app.ticker.stop(); return; }
      // Back from hidden: jump to the latest pose, no replay.
      syncActors();
      dirty = true;
      app.ticker.start();
    },
    destroy() {
      if (closed) return;
      closed = true;
      destroyed = true;
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', resetPointers);
      document.removeEventListener('visibilitychange', resetPointers);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      host.removeEventListener('keydown', onKey);
      delete host.dataset.officeRenderer;
      // Atlas textures are shared through the refcounted lease; only this app's own objects are destroyed.
      app.destroy(true, { children: true });
      release();
    },
  };
}
