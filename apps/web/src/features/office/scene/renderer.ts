// Office scene (stylized 3D). Reads an OfficeModel and draws it; emits selections and never writes anywhere else.
// Plain three.js, no React: scene state changes per frame outside React. Loaded only through the dynamic import in ui/OfficeStage.
import {
  ACESFilmicToneMapping, BoxGeometry, Color, EdgesGeometry, FogExp2, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, PCFShadowMap, PerspectiveCamera, Plane, Raycaster, SRGBColorSpace, Scene, Vector2, Vector3, WebGLRenderer, type Material, type Object3D,
} from 'three';
import { acquireModels, type ModelLease } from './assets';
import type { OfficeFocusZone, OfficeModel, OfficeObjectId, OfficeTarget } from '../model/types';
import { handoffMarks, type HandoffMark, type VisualCue } from '../model/timeline';
import { agentTag, directorTag, poseLabel, queueText } from '../model/labels';
import { Choreographer, SEAT_OFFSET_Z, SEATED_HEADING, directorPose } from './actors';
import { LabelPlacer } from './labelPlacement';
import { AGENT_ZOOM, CameraIntent, CameraMove, FOV, NO_INSET, withInset, type Inset, type WorldBox, cameraKey, cameraPose, clampCamera, focusOn, homeCamera, HOME_ZOOM, panByPixels, pinchFactor, wheelFactor, zoomBy, type Camera } from './camera';
import { Character, MarkKit } from './characters';
import { FpsGovernor, initialTier, settingsFor, type QualitySettings } from './quality';
import { BACKGROUND, HEMI_HIGH, HEMI_LOW, Stage, setShadowCasting } from './stage';
import { FOCUS_POINTS, OBJECT_CELLS, OFFICE_ASSET_PATHS, QUEUE_BOARD, WORLD, cellCentre, contentBox, deskCentre, deskPlan, seatCell, zoneTitles, type Vec2 } from './world';

export interface OfficeRenderer {
  /** Returns the handoff ids of the walk cues it accepted; cues dropped (paused, destroyed) are not returned, so the caller may offer them again. */
  apply(model: OfficeModel, cues: VisualCue[]): string[];
  setPaused(paused: boolean): void;
  /** DOM label anchors in host pixels for the current frame: one tag per character (zone titles are signs in the scene). Text only; the caller draws them. */
  projectLabels?(): ProjectedLabel[];
  /** Screen pixels the HUD or panel covers: labels hide inside it and selections centre in what is left. Setting it never moves the camera. */
  setInset?(inset: Inset): void;
  /** Latest terminal text per agent instance, drawn in the message box over a working character. Stored and drawn on the next frame; wakes the scene. */
  setExcerpts?(excerpts: ReadonlyMap<string, string>): void;
  /** Receives `projectLabels()` after every rendered frame (the same array, reused). */
  setLabelSink?(sink: ((labels: ProjectedLabel[]) => void) | undefined): void;
  /** Eases the camera to a target the user selected (also called for selections made in the DOM mirror). */
  focus?(target: OfficeTarget): void;
  /** Eases the camera to a HUD preset: the whole office or one room. */
  focusZone?(zone: OfficeFocusZone): void;
  highlight?(target?: OfficeTarget): void;
  preview?(target?: OfficeTarget): void;
  setInteracting?(active: boolean): void;
  cameraControl?(action: 'left' | 'right' | 'up' | 'down' | 'zoom-in' | 'zoom-out'): void;
  destroy(): void;
}

/** Text the DOM draws over the canvas. `agent` is the name tag (also the Director desk and queue board tags), `bubble` the message box over a working character, `sleep` the rising z letters over a sleeping one's head; all anchored bottom-centre. */
export interface ProjectedLabel { id: string; kind: 'agent' | 'bubble' | 'sleep'; text: string; x: number; y: number }

const DRAG_THRESHOLD = 4;
const BUBBLE_W = 224, BUBBLE_H = 72;
/** World height the sleep z letters start from: just over a seated character's head (the name tag hangs at 2.15). */
const SLEEP_Y = 1.3;
const EXPOSURE_OPEN = 1, EXPOSURE_CLOSED = 0.6;
const MOVING_MS = 1000 / 30;
const IDLE_MS = 1000 / 8;
const alphaFor = (certainty: string, pose: string): number => (pose === 'ghost' ? 0.45 : certainty === 'confirmed' ? 1 : certainty === 'inferred' ? 0.88 : 0.6);
const assetUrl = (path: string): string => `${import.meta.env.BASE_URL}${path}`;

/**
 * `signal` lets the caller cancel a creation that is no longer wanted; a cancelled creation rejects without touching the page or the shared models.
 * `onContextLost` fires once if the WebGL context is lost after creation. The renderer does not retry: the caller shows its fallback and destroys it.
 */
export async function createOfficeRenderer(host: HTMLElement, onSelect: (target: OfficeTarget) => void, signal?: AbortSignal, onContextLost?: () => void, options: { immersive?: boolean; onDeselect?: () => void } = {}): Promise<OfficeRenderer> {
  const cancelled = (): Error => new DOMException('office renderer creation cancelled', 'AbortError');
  if (signal?.aborted) throw cancelled();
  const lease = await acquireModels({ character: assetUrl(OFFICE_ASSET_PATHS.character), furniture: assetUrl(OFFICE_ASSET_PATHS.furniture) }, signal);
  let gl: WebGLRenderer | undefined;
  let built: ReturnType<typeof build> | undefined;
  try {
    if (signal?.aborted) throw cancelled();
    gl = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // Each stage below runs in its own task, so input is not starved while the scene comes up.
    await yieldToEventLoop();
    if (signal?.aborted) throw cancelled();
    built = build(gl, lease, host, onSelect, onContextLost, options.immersive === true, options.onDeselect);
    await yieldToEventLoop();
    if (signal?.aborted) throw cancelled();
    await warmBeforeUse(built.warm, gl.domElement, signal);
    if (signal?.aborted) throw cancelled();
    return built.renderer;
  } catch (error) {
    if (built) built.renderer.destroy();
    else {
      if (gl) { gl.dispose(); gl.forceContextLoss(); }
      lease.release();
    }
    throw error;
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** A driver can stall shader compilation after context loss. Release ownership without waiting for it. */
function warmBeforeUse(warm: () => Promise<void>, canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      canvas.removeEventListener('webglcontextlost', onLost);
      if (error) reject(error); else resolve();
    };
    const onAbort = (): void => finish(new DOMException('office renderer creation cancelled', 'AbortError'));
    const onLost = (): void => finish(new Error('office context lost during shader warm'));
    const timer = setTimeout(() => finish(new Error('office shader warm timed out')), 15000);
    signal?.addEventListener('abort', onAbort, { once: true });
    canvas.addEventListener('webglcontextlost', onLost, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    // Handle late resolution/rejection too; neither can start a destroyed scene or become unhandled.
    Promise.resolve().then(warm).then(() => finish(), error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

function build(gl: WebGLRenderer, lease: ModelLease, host: HTMLElement, rawSelect: (target: OfficeTarget) => void, onContextLost: (() => void) | undefined, immersive: boolean, onDeselect?: () => void): { renderer: OfficeRenderer; warm(): Promise<void> } {
  const size = (): { w: number; h: number } => ({ w: Math.max(1, host.clientWidth), h: Math.max(1, host.clientHeight) });
  const reduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // A tap that ends a drag or a pinch is not a selection.
  let suppressTap = false;
  const canvas = gl.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.touchAction = 'none';
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  host.appendChild(canvas);

  // ---- renderer, quality ----
  gl.outputColorSpace = SRGBColorSpace;
  gl.toneMapping = ACESFilmicToneMapping;
  gl.toneMappingExposure = EXPOSURE_OPEN;
  gl.shadowMap.type = PCFShadowMap;
  let quality: QualitySettings = settingsFor(initialTier(rendererName(gl)), window.devicePixelRatio);
  const governor = new FpsGovernor();

  // ---- scene ----
  const scene = new Scene();
  scene.background = new Color(BACKGROUND);
  scene.fog = new FogExp2(BACKGROUND, 0.004);
  const stage = new Stage(lease.models.furniture.scene as unknown as Group, () => { dirty = true; wake(); });
  stage.setZoneTitles(zoneTitles(undefined));
  scene.add(stage.group);
  const kit = new MarkKit();
  const proxyGeometry = new BoxGeometry(1, 1, 1);
  const proxyMaterial = new MeshBasicMaterial({ visible: false });
  const picks: Object3D[] = [];
  for (const o of stage.objects) {
    const s = o.size, m = new Mesh(proxyGeometry, proxyMaterial);
    m.scale.set(s.w, s.h, Math.max(s.d, 0.6));
    m.position.set(o.position.x, s.h / 2, o.id === 'board' ? 0.2 : o.position.z);
    m.userData['object'] = o.id;
    stage.group.add(m); picks.push(m);
  }
  // The queue board (Director layout only): a pick volume over the existing whiteboard, no new mesh. Picks are ignored without a Director desk.
  {
    const s = QUEUE_BOARD.size, m = new Mesh(proxyGeometry, proxyMaterial);
    m.scale.set(s.w, 1.4, s.d); m.position.set(QUEUE_BOARD.at.x, 1.4, QUEUE_BOARD.at.z);
    m.userData['queue'] = true;
    stage.group.add(m); picks.push(m);
  }
  const applyQuality = (next: QualitySettings): void => {
    quality = next;
    gl.shadowMap.enabled = next.shadows;
    setShadowCasting(stage.lights.key, next.shadows);
    for (const l of stage.lights.accents) l.visible = next.accentLights;
    // The low tier has no spot pools, so its fill is lifted to keep the room readable.
    stage.lights.hemi.intensity = next.tier === 'low' ? HEMI_LOW : HEMI_HIGH;
    gl.setPixelRatio(next.pixelRatio);
    const v = size();
    gl.setSize(v.w, v.h, false);
    // The shader defines changed (shadow maps, light count): materials must recompile once.
    scene.traverse(o => { if (o instanceof Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) (m as Material).needsUpdate = true; });
    dirty = true;
  };

  // ---- camera ----
  const cam = new PerspectiveCamera(FOV, 1, 0.1, 200);
  let box: WorldBox = WORLD, inset: Inset = NO_INSET;
  const intent = new CameraIntent();
  let state: Camera = homeCamera(box);
  let move: CameraMove | undefined;
  // Recompute an explicit selection after the scene changes size; manual pan/zoom releases it.
  let refit: (() => Camera) | undefined;
  const aim = (): void => {
    const v = size(), p = cameraPose(state, v, box);
    cam.aspect = v.w / v.h;
    cam.position.set(...p.position);
    cam.lookAt(...p.target);
    cam.updateProjectionMatrix();
  };
  const userMove = (next: Camera): void => { refit = undefined; move = undefined; intent.touch(); if (immersive) host.dataset.officeState = 'moving'; if (next !== state) { state = next; aim(); dirty = true; wake(); } };

  // ---- actors and marks ----
  const choreo = new Choreographer(!reduced());
  const characters = new Map<string, Character>();
  const marks = new Map<string, Group>();
  // The Director desk figure: a scene object of its own, never an agent, keyed and picked apart from `characters`.
  let director: Character | undefined;
  let directorPoint: Vec2 | undefined;
  let warmed = false;
  let paused = false, dirty = true, destroyed = false, closed = false, raf = 0, timer = 0, lastRender = 0, ready = false, lastModel: OfficeModel | undefined;

  const syncActors = (): void => {
    const keep = new Set<string>();
    const animate = !reduced();
    // Staff of unoccupied desks and the bartender are drawn like agents but carry no pick data and are never picked or labelled.
    const bartender = choreo.bartenderView();
    for (const view of [...choreo.views(), ...choreo.ambientViews(), ...(bartender ? [bartender] : [])]) {
      keep.add(view.instanceId);
      let c = characters.get(view.instanceId);
      if (!c) {
        c = new Character(lease.models.character.scene, lease.models.character.animations, view.instanceId, view.role, proxyGeometry, proxyMaterial, view.ambient ? {} : { instanceId: view.instanceId });
        characters.set(view.instanceId, c);
        scene.add(c.root);
        if (!view.ambient) picks.push(c.proxy);
      }
      c.set(view, view.ambient ? 1 : alphaFor(view.certainty, view.pose), animate);
    }
    for (const [id, c] of characters) if (!keep.has(id)) { const at = picks.indexOf(c.proxy); if (at >= 0) picks.splice(at, 1); c.dispose(); characters.delete(id); }
  };
  /** Presence alone decides the figure (host heartbeat, never Herdr done): absent is an empty desk, unknown a ghost. */
  const syncDirector = (model: OfficeModel): void => {
    const d = model.director, cell = d?.seat ? seatCell(d.seat) : undefined, look = d ? directorPose(d.presence) : undefined;
    directorPoint = cell ? { x: cellCentre(cell).x, z: cellCentre(cell).z + SEAT_OFFSET_Z } : undefined;
    if (!d || !directorPoint || !look?.visible) {
      if (director) { picks.splice(picks.indexOf(director.proxy), 1); director.dispose(); director = undefined; }
      return;
    }
    if (!director) {
      director = new Character(lease.models.character.scene, lease.models.character.animations, 'director-desk', 'conversation', proxyGeometry, proxyMaterial, { director: true });
      scene.add(director.root); picks.push(director.proxy);
    }
    director.set({ instanceId: 'director-desk', role: 'conversation', certainty: d.certainty, pose: d.presence === 'unknown' ? 'ghost' : 'preparing', clip: look.clip, point: directorPoint, heading: SEATED_HEADING, walking: false, carrying: false, ambient: false, lounging: false, lift: 0 }, look.alpha, !reduced());
  };
  // Desk indicators come from handoff state alone, so they are redrawn on every apply (a first snapshot carries no cues).
  const syncMarks = (model: OfficeModel): void => {
    const keep = new Set<string>(), stacked = new Map<string, number>();
    for (const mark of handoffMarks(model)) {
      const cell = choreo.cellFor(mark.at);
      if (!cell) continue;
      keep.add(`${mark.handoffId}:${mark.mark}`);
      const id = `${mark.handoffId}:${mark.mark}`;
      let g = marks.get(id);
      if (!g) { g = kit.build(mark.mark as HandoffMark); marks.set(id, g); scene.add(g); }
      const slot = `${cell.gx},${cell.gy}`, n = stacked.get(slot) ?? 0;
      stacked.set(slot, n + 1);
      const p = deskCentre(cell);
      g.position.set(p.x - 0.5 + n * 0.55, 2.45, p.z - 0.62);
    }
    for (const [id, g] of marks) if (!keep.has(id)) { g.removeFromParent(); marks.delete(id); }
  };

  // ---- labels ----
  // Pooled: the label list, its objects, the overlap rectangles and the tag strings are reused, so a frame allocates nothing per label.
  let sink: ((labels: ProjectedLabel[]) => void) | undefined;
  const probe = new Vector3();
  const pool: ProjectedLabel[] = [], out: ProjectedLabel[] = [];
  const placer = new LabelPlacer();
  // Message boxes found in the first pass; placed in a second one, after every name tag.
  const boxTag: Array<{ bubbleId: string }> = [], boxX: number[] = [], boxY: number[] = [], boxText: string[] = [];
  let boxCount = 0;
  const tags = new Map<string, { label: string; pose: string; text: string; id: string; bubbleId: string; sleepId: string }>();
  let excerpts: ReadonlyMap<string, string> = new Map();
  let agentsById = new Map<string, OfficeModel['agents'][number]>();
  let directorText = '', boardText = '';
  let signLayout: OfficeModel['layout'] = 'unknown';
  const pt = { x: 0, y: 0 };
  /** Projects to host pixels; false when behind the camera or outside the safe area (the HUD and panel inset). */
  const project = (x: number, y: number, z: number, w: number, h: number): boolean => {
    probe.set(x, y, z).project(cam);
    if (probe.z > 1) return false;
    pt.x = (probe.x * 0.5 + 0.5) * w; pt.y = (-probe.y * 0.5 + 0.5) * h;
    return pt.x >= inset.left && pt.x <= w - inset.right && pt.y >= 0 && pt.y <= h - inset.bottom;
  };
  const slot = (n: number, id: string, kind: ProjectedLabel['kind'], text: string): void => {
    const l = pool[n] ?? (pool[n] = { id: '', kind, text: '', x: 0, y: 0 });
    l.id = id; l.kind = kind; l.text = text; l.x = pt.x; l.y = pt.y;
    out[n] = l;
  };
  const projectLabels = (): ProjectedLabel[] => {
    const v = size();
    let n = 0;
    boxCount = 0;
    placer.begin();
    const far = state.zoom < 1.8;
    // Reserve the whole label rectangle, not only its anchor, beside HUD controls.
    const fits = (x: number, y: number, width: number, height: number): boolean =>
      x - width / 2 >= inset.left && x + width / 2 <= v.w - inset.right && y - height >= 0 && y <= v.h - inset.bottom;
    const tagFits = (text: string): boolean => fits(pt.x, pt.y, text.length * 6.8 + 12, 22);
    for (const view of choreo.views()) {
      const a = agentsById.get(view.instanceId);
      if (!a || !project(view.point.x, 2.15, view.point.z, v.w, v.h)) continue;
      let tag = tags.get(a.instanceId);
      if (!tag || tag.label !== a.label || tag.pose !== a.pose) { tag = { label: a.label, pose: a.pose, text: agentTag(a.label, a.pose), id: `agent:${a.instanceId}`, bubbleId: `bubble:${a.instanceId}`, sleepId: `sleep:${a.instanceId}` }; tags.set(a.instanceId, tag); }
      const tagX = pt.x, tagY = pt.y;
      if (tagFits(tag.text) && placer.tag(tagX, tagY, tag.text.length * 6.8 + 12, 18, far)) slot(n++, tag.id, 'agent', tag.text);
      const extra = poseLabel(a.pose);
      if (extra === 'bubble') { boxTag[boxCount] = tag; boxX[boxCount] = tagX; boxY[boxCount] = tagY - 22; boxText[boxCount] = excerpts.get(a.instanceId) ?? a.statusText; boxCount++; }
      // The z letters rise from just over the (slumped) head, below the name tag, so they read as belonging to the sleeper. An idle agent away in the
      // Creative Space is not asleep, so it has none.
      else if (extra === 'sleep' && !view.lounging && project(view.point.x, SLEEP_Y, view.point.z, v.w, v.h)) slot(n++, tag.sleepId, 'sleep', 'Zzz');
    }
    // The Director desk tag (also over an empty desk) and the queue board count, Director layout only.
    const desk = lastModel?.director;
    if (desk && directorPoint && project(directorPoint.x, 2.15, directorPoint.z, v.w, v.h) && tagFits(directorText) && placer.tag(pt.x, pt.y, directorText.length * 6.8 + 12, 18, far)) slot(n++, 'director', 'agent', directorText);
    if (desk && project(QUEUE_BOARD.at.x, 2.6, QUEUE_BOARD.at.z, v.w, v.h) && tagFits(boardText) && placer.tag(pt.x, pt.y, boardText.length * 6.8 + 12, 18, far)) slot(n++, 'queue', 'agent', boardText);
    // Message boxes go above their name tag; far out, one that would overlap any tag or an earlier box is hidden.
    for (let i = 0; i < boxCount; i++) {
      if (!fits(boxX[i] as number, boxY[i] as number, BUBBLE_W, BUBBLE_H) || !placer.bubble(boxX[i] as number, boxY[i] as number, BUBBLE_W, BUBBLE_H, far)) continue;
      pt.x = boxX[i] as number; pt.y = boxY[i] as number;
      slot(n++, (boxTag[i] as { bubbleId: string }).bubbleId, 'bubble', boxText[i] as string);
    }
    out.length = n;
    return out;
  };

  // ---- loop: display-rate frames only while something moves; 8 fps timer while clips idle; nothing at all when still or hidden ----
  const render = (): void => {
    gl.render(scene, cam);
    if (!ready) { ready = true; host.dataset.officeRenderer = 'ready'; }
  };
  let moving = false, activeGesture = false;
  const stopTimers = (): void => { if (raf) cancelAnimationFrame(raf); raf = 0; if (timer) clearTimeout(timer); timer = 0; };
  /** `fast` wants the next display frame; otherwise the idle interval is used. Nothing is scheduled when `fast` is undefined. */
  const schedule = (fast: boolean | undefined): void => {
    if (fast === undefined || !warmed || !lastModel || paused || destroyed) return;
    if (fast) {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (!raf) raf = requestAnimationFrame(frame);
    } else if (!raf && !timer) {
      timer = window.setTimeout(() => { timer = 0; frame(performance.now()); }, IDLE_MS);
    }
  };
  const frame = (now: number): void => {
    raf = 0;
    if (paused || destroyed) return;
    const gap = now - lastRender;
    // Display frames above 30 fps are skipped while something moves.
    if (lastRender !== 0 && !dirty && moving && gap < MOVING_MS - 3) { schedule(true); return; }
    const dt = lastRender === 0 ? 16 : Math.min(gap, 100);
    lastRender = now;
    if (move) {
      const step = move.at(now, reduced());
      state = step.camera;
      if (step.done) { move = undefined; host.dataset.officeState = host.dataset.officeInteracting === 'true' ? 'interacting' : host.dataset.officeSelected === 'true' ? 'selected' : 'overview'; }
      aim();
    }
    const tick = choreo.tick(dt);
    moving = tick.moving || move !== undefined;
    if (tick.changed || tick.moving) syncActors();
    if (!reduced()) { for (const c of characters.values()) c.update(dt / 1000); director?.update(dt / 1000); }
    dirty = false;
    render();
    sink?.(projectLabels());
    if (!move && !activeGesture && host.dataset.officeState === 'moving') host.dataset.officeState = host.dataset.officeInteracting === 'true' ? 'interacting' : host.dataset.officeSelected === 'true' ? 'selected' : 'overview';
    if (quality.tier === 'high' && governor.frame(now, moving)) applyQuality(settingsFor('low', window.devicePixelRatio));
    if (moving || dirty) schedule(true);
    else if (choreo.busy() || (director && !reduced())) schedule(false);
    else lastRender = 0; // asleep: no timer, no frame until the next apply, gesture or resize
  };
  const wake = (): void => schedule(true);

  // ---- picking ----
  const ray = new Raycaster(), ndc = new Vector2();
  const pick = (clientX: number, clientY: number): OfficeTarget | undefined => {
    const box = canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return undefined;
    ndc.set(((clientX - box.left) / box.width) * 2 - 1, -(((clientY - box.top) / box.height) * 2 - 1));
    ray.setFromCamera(ndc, cam);
    // The queue board volume only counts in a Director layout; otherwise it is skipped, never blocking what is behind it.
    const hit = ray.intersectObjects(picks, false).find(h => !(h.object.userData['queue'] && !lastModel?.director));
    const data = hit?.object.userData as { instanceId?: string; object?: OfficeObjectId; director?: boolean; queue?: boolean } | undefined;
    if (data?.director) return { kind: 'director' };
    if (data?.queue) return { kind: 'queue' };
    if (data?.instanceId) return { kind: 'agent', instanceId: data.instanceId };
    if (data?.object) return { kind: 'object', object: data.object };
    return undefined;
  };
  const targetFor = (object: Object3D): OfficeTarget | undefined => {
    const data = object.userData as { instanceId?: string; object?: OfficeObjectId; director?: boolean; queue?: boolean };
    if (data.director) return { kind: 'director' };
    if (data.queue) return lastModel?.director ? { kind: 'queue' } : undefined;
    if (data.instanceId) return { kind: 'agent', instanceId: data.instanceId };
    if (data.object) return { kind: 'object', object: data.object };
    return undefined;
  };
  const outlineGeometry = new EdgesGeometry(proxyGeometry);
  const outlineMaterial = new LineBasicMaterial({ color: '#ffe36a', depthTest: false, transparent: true, opacity: 0.98 });
  let outline: LineSegments | undefined;
  let outlineTarget: OfficeTarget | undefined, selectedTarget: OfficeTarget | undefined, hoveredTarget: OfficeTarget | undefined;
  const sameTarget = (a?: OfficeTarget, b?: OfficeTarget): boolean => {
    if (lastModel?.director && ((a?.kind === 'director' && b?.kind === 'object' && b.object === 'counter') || (b?.kind === 'director' && a?.kind === 'object' && a.object === 'counter'))) return true;
    return a?.kind === b?.kind && (a?.kind === 'agent' ? a.instanceId === (b as typeof a)?.instanceId : a?.kind === 'object' ? a.object === (b as typeof a)?.object : true);
  };
  const paintHighlight = (target?: OfficeTarget): void => {
    outline?.removeFromParent(); outline = undefined; outlineTarget = target;
    if (target) {
      const proxy = picks.find(item => sameTarget(targetFor(item), target));
      if (proxy instanceof Mesh) {
        outline = new LineSegments(outlineGeometry, outlineMaterial);
        outline.position.copy(proxy.position); outline.rotation.copy(proxy.rotation); outline.scale.copy(proxy.scale).multiplyScalar(1.025);
        outline.renderOrder = 1000; proxy.parent?.add(outline);
      }
    }
    dirty = true; wake();
  };
  const highlight = (target?: OfficeTarget): void => { if (!immersive) return; selectedTarget = target; host.dataset.officeSelected = String(Boolean(target)); paintHighlight(hoveredTarget ?? selectedTarget); };
  const preview = (target?: OfficeTarget): void => { if (!immersive) return; hoveredTarget = target; paintHighlight(hoveredTarget ?? selectedTarget); };
  const setInteracting = (active: boolean): void => { if (!immersive) return; host.dataset.officeInteracting = String(active); host.dataset.officeState = active ? 'interacting' : selectedTarget ? 'selected' : 'overview'; };
  const positionOf = (target: OfficeTarget): Vec2 | undefined => {
    if (target.kind === 'agent') return choreo.views().find(v => v.instanceId === target.instanceId)?.point;
    if (target.kind === 'director') return directorPoint ?? cellCentre(OBJECT_CELLS.counter);
    if (target.kind === 'queue') return QUEUE_BOARD.at;
    const o = stage.objects.find(s => s.id === target.object);
    return o ? o.position : cellCentre(OBJECT_CELLS[target.object]);
  };
  /** The box with the reach an active inset needs; user gestures clamp against it. */
  const reach = (): WorldBox => (inset === NO_INSET ? box : withInset(box, size(), inset));
  const insetArg = (): { view: { w: number; h: number }; inset: Inset } | undefined => (inset === NO_INSET ? undefined : { view: size(), inset });
  const easeTo = (to: Camera): void => { intent.touch(); move = new CameraMove(state, to, performance.now(), reduced()); host.dataset.officeState = 'moving'; wake(); };
  const focus = (target: OfficeTarget): void => {
    const p = positionOf(target);
    if (!p || destroyed) return;
    highlight(target);
    const zoom = target.kind === 'agent' || target.kind === 'director' ? AGENT_ZOOM : target.kind === 'queue' ? 1.9 : target.object === 'board' ? 1.6 : undefined;
    refit = () => focusOn(positionOf(target) ?? p, box, zoom, insetArg());
    easeTo(refit());
  };
  const focusZone = (zone: OfficeFocusZone): void => {
    if (destroyed) return;
    highlight(undefined);
    refit = () => zone === 'overview' ? focusOn({ x: box.cx ?? box.w / 2, z: box.cz ?? box.d / 2 }, box, HOME_ZOOM, insetArg()) : focusOn(FOCUS_POINTS[zone].at, box, FOCUS_POINTS[zone].zoom, insetArg());
    easeTo(refit());
  };
  // The consumer hears the selection first so it can set the inset (the panel about to open) before the camera moves.
  const select = (target: OfficeTarget): void => { if (!suppressTap) { highlight(target); if (immersive) host.dataset.officeState = 'selected'; rawSelect(target); focus(target); } };

  // ---- camera input: user gestures only ----
  let drag: { id: number; x: number; y: number; sx: number; sy: number; moved: boolean } | undefined;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  const spread = (): number => { const [a, b] = [...pointers.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  const resetPointers = (): void => { pointers.clear(); drag = undefined; pinchDist = 0; activeGesture = false; if (immersive && hoveredTarget) { hoveredTarget = undefined; paintHighlight(selectedTarget); } if (immersive && host.dataset.officeState === 'moving' && !move) host.dataset.officeState = host.dataset.officeInteracting === 'true' ? 'interacting' : host.dataset.officeSelected === 'true' ? 'selected' : 'overview'; };
  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'mouse') resetPointers();
    if (pointers.size === 0) suppressTap = false;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { drag = undefined; pinchDist = spread(); suppressTap = true; activeGesture = true; if (immersive) host.dataset.officeState = 'moving'; }
    else if (pointers.size === 1) drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
  };
  let hoverAt = 0;
  const onMove = (e: PointerEvent): void => {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse' && e.timeStamp - hoverAt > 60) {
        hoverAt = e.timeStamp;
        const target = e.target === canvas ? pick(e.clientX, e.clientY) : undefined;
        if (e.target === canvas) canvas.style.cursor = target ? 'pointer' : 'default';
        hoveredTarget = target;
        if (immersive && target && !sameTarget(target, outlineTarget)) paintHighlight(target);
        else if (immersive && !target && outlineTarget && !sameTarget(outlineTarget, selectedTarget)) paintHighlight(selectedTarget);
      }
      return;
    }
    if (e.pointerType === 'mouse' && e.buttons === 0) { resetPointers(); return; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const dist = spread(), factor = pinchFactor(pinchDist, dist);
      if (factor !== 1) { userMove(zoomBy(state, factor, reach())); pinchDist = dist; }
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < DRAG_THRESHOLD) return;
    drag.moved = true; suppressTap = true; activeGesture = true; if (immersive) host.dataset.officeState = 'moving';
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    userMove(panByPixels(state, dx, dy, size(), reach()));
  };
  const onUp = (e: PointerEvent): void => {
    const tap = drag && e.pointerId === drag.id && !drag.moved && !suppressTap && e.target === canvas && e.type === 'pointerup';
    const at = { x: e.clientX, y: e.clientY };
    pointers.delete(e.pointerId);
    if (drag && e.pointerId === drag.id) drag = undefined;
    pinchDist = 0;
    if (pointers.size < 2) activeGesture = false;
    if (tap) {
      const target = pick(at.x, at.y);
      if (target) select(target);
      else if (immersive) {
        highlight(undefined);
        const rect = canvas.getBoundingClientRect();
        ndc.set(((at.x - rect.left) / rect.width) * 2 - 1, -(((at.y - rect.top) / rect.height) * 2 - 1));
        ray.setFromCamera(ndc, cam);
        const point = ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3());
        if (point) easeTo(focusOn({ x: point.x, z: point.z }, reach(), state.zoom, insetArg()));
      }
    } else if (immersive && !activeGesture) host.dataset.officeState = host.dataset.officeInteracting === 'true' ? 'interacting' : host.dataset.officeSelected === 'true' ? 'selected' : 'overview';
  };
  const onWheel = (e: WheelEvent): void => { e.preventDefault(); if (e.deltaY !== 0) userMove(zoomBy(state, wheelFactor(e.deltaY), reach())); };
  const onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    if (immersive && e.key === 'Escape' && !e.defaultPrevented && !e.isComposing && (selectedTarget || host.dataset.officeInteracting === 'true')) { hoveredTarget = undefined; highlight(undefined); setInteracting(false); onDeselect?.(); host.dataset.officeState = 'overview'; return; }
    const action = cameraKey(e.key);
    if (!action) return;
    e.preventDefault();
    if (action.kind === 'pan') userMove(panByPixels(state, action.dx, action.dy, size(), reach()));
    else if (action.kind === 'zoom') userMove(zoomBy(state, action.factor, reach()));
    else userMove(homeCamera(box));
  };
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('blur', resetPointers);
  document.addEventListener('visibilitychange', resetPointers);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  host.dataset.officeState = 'overview'; host.dataset.officeSelected = 'false'; host.dataset.officeInteracting = 'false';
  host.addEventListener('keydown', onKey);
  // A selected object stays centred in the resized scene. Cancel an obsolete in-flight target.
  const observer = new ResizeObserver(() => {
    if (destroyed || host.clientWidth === 0 || host.clientHeight === 0) return;
    const v = size();
    gl.setSize(v.w, v.h, false);
    move = undefined;
    state = refit ? refit() : clampCamera(state, reach());
    aim(); dirty = true; wake();
  });
  observer.observe(host);
  const onLost = (e: Event): void => { e.preventDefault(); if (!destroyed) onContextLost?.(); };
  const onRestored = (): void => { dirty = true; wake(); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  applyQuality(quality);
  aim();

  const renderer: OfficeRenderer = {
    apply(model, cues) {
      if (destroyed) return [];
      lastModel = model;
      agentsById = new Map(model.agents.map(a => [a.instanceId, a] as const));
      for (const id of tags.keys()) if (!agentsById.has(id)) tags.delete(id);
      // Hidden tab: cues are dropped, only the latest pose matters.
      const accepted = choreo.apply(model, paused ? [] : cues);
      const plan = deskPlan(model.agents.flatMap(a => (a.seat ? [a.seat] : [])));
      stage.layout(plan);
      // The default view frames what is drawn; once the user moves the camera it only keeps the target inside the new bounds.
      const next = contentBox(plan.desks);
      if (next.w !== box.w || next.d !== box.d || next.cx !== box.cx || next.cz !== box.cz) {
        box = next; move = undefined;
        state = intent.reframe(state, box);
        aim();
      }
      syncActors();
      syncDirector(model);
      const missingAgent = selectedTarget;
      if (missingAgent?.kind === 'agent' && !model.agents.some(agent => agent.instanceId === missingAgent.instanceId)) highlight(undefined);
      syncMarks(model);
      // Keep the first frame neutral until the topology read confirms its layout.
      const layout = model.layout ?? (model.director ? 'director' : 'legacy_v2');
      if (layout !== signLayout) { signLayout = layout; stage.setZoneTitles(zoneTitles(layout === 'unknown' ? undefined : layout === 'director')); }
      directorText = model.director ? directorTag(model.director.presence) : '';
      boardText = model.director ? `Sự cố: ${queueText(model.queue)}` : '';
      // Closed session: the office is dimmed but furniture stays visible. The last saved data stays visible.
      const off = model.tier === 'closed';
      gl.toneMappingExposure = off ? EXPOSURE_CLOSED : EXPOSURE_OPEN;
      dirty = true;
      wake();
      return accepted;
    },
    projectLabels,
    setExcerpts(next) { excerpts = next; dirty = true; wake(); },
    highlight,
    preview,
    setInteracting,
    cameraControl(action) {
      if (!immersive) return;
      const step = 64;
      if (action === 'zoom-in') userMove(zoomBy(state, 1.2, reach()));
      else if (action === 'zoom-out') userMove(zoomBy(state, 1 / 1.2, reach()));
      else userMove(panByPixels(state, action === 'left' ? step : action === 'right' ? -step : 0, action === 'up' ? step : action === 'down' ? -step : 0, size(), reach()));
    },
    setInset(next) { inset = next.right === 0 && next.bottom === 0 && next.left === 0 ? NO_INSET : next; dirty = true; wake(); },
    setLabelSink(next) { sink = next; if (next && ready) next(projectLabels()); },
    setPaused(next) {
      if (next === paused) return;
      paused = next;
      if (next) { choreo.pause(); stopTimers(); lastRender = 0; governor.reset(); return; }
      // Back from hidden: jump to the latest pose, no replay.
      syncActors();
      if (lastModel) syncMarks(lastModel);
      dirty = true;
      schedule(true);
    },
    focus,
    focusZone,
    destroy() {
      if (closed) return;
      closed = true;
      destroyed = true;
      stopTimers();
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
      for (const c of characters.values()) c.dispose();
      characters.clear();
      director?.dispose(); director = undefined;
      for (const g of marks.values()) g.removeFromParent();
      marks.clear();
      kit.dispose();
      outlineGeometry.dispose(); outlineMaterial.dispose();
      stage.dispose();
      proxyGeometry.dispose();
      proxyMaterial.dispose();
      // Geometries and materials of the models are shared through the lease; the last owner disposes them.
      gl.dispose();
      gl.forceContextLoss();
      canvas.remove();
      lease.release();
    },
  };
  return { renderer, warm: async () => { await gl.compileAsync(scene, cam); warmed = true; } };
}

function rendererName(gl: WebGLRenderer): string | undefined {
  const ctx = gl.getContext();
  const info = ctx.getExtension('WEBGL_debug_renderer_info');
  return info ? String(ctx.getParameter(info.UNMASKED_RENDERER_WEBGL)) : undefined;
}
