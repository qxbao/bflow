// Static office scene (V3.1). Reads an OfficeModel and draws it; emits selections and never writes anywhere else.
// `pixi.js/unsafe-eval` swaps code generation for polyfills, so the CSP stays free of 'unsafe-eval'. It must load first.
import 'pixi.js/unsafe-eval';
import { Application, Assets, Container, Sprite, TextureStyle, type Spritesheet, type Texture } from 'pixi.js';
import type { OfficeModel, OfficeObjectId, OfficeTarget } from '../model/types';
import type { VisualCue } from '../model/timeline';
import { cameraKey, clampCamera, fitCamera, panBy, zoomBy, type Camera } from './camera';
import { ATLAS_URL_PATH, DESK_CELLS, GRID_H, GRID_W, OBJECT_CELLS, PLANT_CELLS, ROLE_FRAME, TILE_H, TILE_W, WORLD, cellCentre, depth, isRug, seatCell, type Cell } from './layers';

export interface OfficeRenderer {
  apply(model: OfficeModel, cues: VisualCue[]): void;
  setPaused(paused: boolean): void;
  destroy(): void;
}

const BACKGROUND = 0x2b2733;
const DRAG_THRESHOLD = 4;
const WHEEL_GAP_MS = 120;
let assetsReady: Promise<void> | undefined;
/** Assets.init must run once, before any load, and must not use workers (they need a blob: worker-src the CSP forbids). */
const initAssets = (): Promise<void> => (assetsReady ??= Assets.init({ preferences: { preferWorkers: false } }));

const atlasUrl = (): string => `${import.meta.env.BASE_URL}${ATLAS_URL_PATH}`;
const alphaFor = (certainty: string, pose: string): number => (pose === 'ghost' ? 0.45 : certainty === 'confirmed' ? 1 : certainty === 'inferred' ? 0.85 : 0.55);

export async function createOfficeRenderer(host: HTMLElement, onSelect: (target: OfficeTarget) => void): Promise<OfficeRenderer> {
  await initAssets();
  TextureStyle.defaultOptions.scaleMode = 'nearest';
  const app = new Application();
  const size = (): { w: number; h: number } => ({ w: Math.max(1, host.clientWidth), h: Math.max(1, host.clientHeight) });
  const url = atlasUrl();
  let loaded = false;
  try {
    await app.init({
      preference: 'webgl', roundPixels: true, antialias: false, background: BACKGROUND,
      width: size().w, height: size().h, resolution: Math.max(1, Math.round(window.devicePixelRatio || 1)), autoDensity: true, autoStart: false,
    });
    const sheet = await Assets.load<Spritesheet>(url);
    loaded = true;
    return build(app, sheet, url, host, onSelect, size);
  } catch (error) {
    if (loaded) await Assets.unload(url).catch(() => undefined);
    try { app.destroy(true, { children: true, texture: true }); } catch { /* init may have failed before a renderer existed */ }
    throw error;
  }
}

function build(app: Application, sheet: Spritesheet, url: string, host: HTMLElement, onSelect: (target: OfficeTarget) => void, size: () => { w: number; h: number }): OfficeRenderer {
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
  let paused = false, dirty = true, destroyed = false, closed = false;
  let camera: Camera = fitCamera(size(), WORLD);
  const view = (): { w: number; h: number } => size();
  const place = (): void => { world.position.set(camera.x, camera.y); world.scale.set(camera.zoom); dirty = true; };
  place();

  const renderNow = (): void => {
    app.render();
    if (host.dataset.officeRenderer !== 'ready') host.dataset.officeRenderer = 'ready';
  };
  app.ticker.add(() => { if (dirty && !paused && !destroyed) { dirty = false; renderNow(); } });
  app.ticker.start();

  // --- camera input: user gestures only ---
  const move = (next: Camera): void => { if (next !== camera) { camera = next; place(); } };
  let drag: { id: number; x: number; y: number; moved: boolean } | undefined;
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };
  const onMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    drag.x = e.clientX; drag.y = e.clientY;
    move(panBy(camera, dx, dy, view(), WORLD));
  };
  const onUp = (e: PointerEvent): void => { if (drag && e.pointerId === drag.id) drag = undefined; };
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
  canvas.addEventListener('wheel', onWheel, { passive: false });
  host.addEventListener('keydown', onKey);
  // A resize only clamps the camera so the scene stays reachable; it never re-centres.
  const observer = new ResizeObserver(() => {
    if (destroyed) return;
    const v = view();
    app.renderer.resize(v.w, v.h);
    camera = clampCamera(camera, v, WORLD);
    place();
  });
  observer.observe(host);
  const onLost = (e: Event): void => { e.preventDefault(); };
  const onRestored = (): void => { dirty = true; };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  return {
    apply(model) {
      if (destroyed) return;
      const keep = new Set<string>();
      for (const agent of model.agents) {
        const cell = agent.seat ? seatCell(agent.seat) : undefined;
        if (!cell) continue;
        keep.add(agent.instanceId);
        let sprite = agents.get(agent.instanceId);
        if (!sprite) {
          sprite = new Sprite();
          sprite.anchor.set(0.5, 1);
          sprite.eventMode = 'static';
          sprite.cursor = 'pointer';
          const instanceId = agent.instanceId;
          sprite.on('pointertap', () => onSelect({ kind: 'agent', instanceId }));
          things.addChild(sprite);
          agents.set(agent.instanceId, sprite);
        }
        sprite.texture = tex(ROLE_FRAME(agent.role));
        at(sprite, cell, TILE_H / 2 - 2);
        sprite.zIndex = depth(cell, 'agent');
        sprite.alpha = alphaFor(agent.certainty, agent.pose);
      }
      for (const [id, sprite] of agents) if (!keep.has(id)) { sprite.destroy(); agents.delete(id); }
      // Closed session: the office is dark. The last saved data stays visible.
      world.tint = model.tier === 'closed' ? 0x6a6a80 : 0xffffff;
      dirty = true;
    },
    setPaused(next) {
      paused = next;
      if (!next) dirty = true;
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
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      host.removeEventListener('keydown', onKey);
      delete host.dataset.officeRenderer;
      app.destroy(true, { children: true, texture: true });
      // The destroyed textures must not be served from the asset cache to a later renderer.
      void Assets.unload(url).catch(() => undefined);
    },
  };
}
