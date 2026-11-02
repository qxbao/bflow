// Pure camera maths for the high perspective view. The camera never moves by itself: every function here is called from a user
// gesture, a user-driven resize or a user selection (`focusOn`). The state is the floor point the camera looks at plus a continuous zoom.
import type { Vec2 } from './world';

/** The floor rectangle the camera frames: size, plus the centre when it is not the middle of the grid (content framing). */
export interface WorldBox { w: number; d: number; cx?: number; cz?: number }
const midX = (w: WorldBox): number => w.cx ?? w.w / 2;
const midZ = (w: WorldBox): number => w.cz ?? w.d / 2;
export interface Camera { x: number; z: number; zoom: number }
export interface Size { w: number; h: number }
export interface Pose { position: [number, number, number]; target: [number, number, number] }

/** 1 shows the whole office; larger values come closer. Continuous, no integer steps. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4.5;
/** Vertical field of view and the angle of the view above the floor, in degrees. */
export const FOV = 38;
export const PITCH = 40;
export const KEY_PAN = 36;
export const KEY_ZOOM = 1.25;
/** Duration of the eased move to a selected target; reduced motion jumps instead. */
export const FOCUS_MS = 480;
export const FOCUS_ZOOM = 2.4;
/** Extra floor (world units) the camera target may leave the office by, so the walls stay reachable. */
const SLACK = 1.5;
/** Height of the point the camera looks at (a character's chest), so closer zooms frame the people. */
const AIM_Y = 0.9;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const rad = (deg: number): number => (deg * Math.PI) / 180;
const tanHalf = Math.tan(rad(FOV / 2));
const sinPitch = Math.sin(rad(PITCH));
const cosPitch = Math.cos(rad(PITCH));

/** Camera distance at zoom 1: the whole floor plus the back wall fits horizontally and vertically. */
export function fitDistance(view: Size, world: WorldBox): number {
  const aspect = Math.max(0.2, view.w / Math.max(1, view.h));
  const byWidth = (world.w / 2) / (tanHalf * aspect);
  const byDepth = (world.d / 2 + 1.5) * sinPitch / tanHalf;
  return Math.max(byWidth, byDepth) * 1.06;
}

/** Keeps the zoom in bounds and the target inside the office (with slack). At zoom 1 the office is centred. */
export function clampCamera(cam: Camera, world: WorldBox): Camera {
  const zoom = clamp(Number.isFinite(cam.zoom) ? cam.zoom : 1, MIN_ZOOM, MAX_ZOOM);
  const reach = 1 - 1 / zoom;
  const rx = (world.w / 2) * reach + SLACK * reach, rz = (world.d / 2) * reach + SLACK * reach;
  return { zoom, x: clamp(cam.x, midX(world) - rx, midX(world) + rx), z: clamp(cam.z, midZ(world) - rz, midZ(world) + rz) };
}

/** The whole office in view. */
export const fitCamera = (world: WorldBox): Camera => ({ x: midX(world), z: midZ(world), zoom: MIN_ZOOM });
/** The default view: closer than the whole office (the edges of the room may be cropped), looking at the middle of the floor. Initial state and the 0 key. */
export const HOME_ZOOM = 1;
export const homeCamera = (world: WorldBox): Camera => clampCamera({ x: midX(world), z: midZ(world), zoom: HOME_ZOOM }, world);

/** Where the three.js camera stands and looks for a state. */
export function cameraPose(cam: Camera, view: Size, world: WorldBox): Pose {
  const dist = fitDistance(view, world) / cam.zoom;
  return { position: [cam.x, AIM_Y + dist * sinPitch, cam.z + dist * cosPitch], target: [cam.x, AIM_Y, cam.z] };
}

/** Floor units per screen pixel at the target, for the horizontal (x) and depth (z) axis. */
function groundPerPixel(cam: Camera, view: Size, world: WorldBox): { x: number; z: number } {
  const dist = fitDistance(view, world) / cam.zoom;
  const unit = (2 * dist * tanHalf) / Math.max(1, view.h);
  return { x: unit, z: unit / sinPitch };
}

/** Drag by screen pixels: the scene follows the pointer. */
export function panByPixels(cam: Camera, dx: number, dy: number, view: Size, world: WorldBox): Camera {
  const g = groundPerPixel(cam, view, world);
  return clampCamera({ ...cam, x: cam.x - dx * g.x, z: cam.z - dy * g.z }, world);
}

/** Multiplies the zoom (>1 comes closer) about the current target. */
export function zoomBy(cam: Camera, factor: number, world: WorldBox): Camera {
  if (!(factor > 0)) return cam;
  return clampCamera({ ...cam, zoom: cam.zoom * factor }, world);
}

/** Wheel notches become a smooth factor; one 100-unit notch is about 1.16x. */
export const wheelFactor = (deltaY: number): number => Math.exp(clamp(-deltaY, -240, 240) * 0.0015);

/** The state that frames `target` for a selection. */
export function focusOn(target: Vec2, world: WorldBox, zoom = FOCUS_ZOOM): Camera {
  return clampCamera({ x: target.x, z: target.z, zoom }, world);
}

export type CameraKey = { kind: 'pan'; dx: number; dy: number } | { kind: 'zoom'; factor: number } | { kind: 'fit' };

/** §5.4 keyboard: arrows pan, + / - zoom, 0 fits. Anything else is not ours. */
export function cameraKey(key: string): CameraKey | undefined {
  switch (key) {
    case 'ArrowLeft': return { kind: 'pan', dx: KEY_PAN, dy: 0 };
    case 'ArrowRight': return { kind: 'pan', dx: -KEY_PAN, dy: 0 };
    case 'ArrowUp': return { kind: 'pan', dx: 0, dy: KEY_PAN };
    case 'ArrowDown': return { kind: 'pan', dx: 0, dy: -KEY_PAN };
    case '+': case '=': return { kind: 'zoom', factor: KEY_ZOOM };
    case '-': case '_': return { kind: 'zoom', factor: 1 / KEY_ZOOM };
    case '0': return { kind: 'fit' };
    default: return undefined;
  }
}

/** Two-pointer zoom: the factor is the ratio of the finger spread now to the spread last time; 1 when either is unusable. */
export function pinchFactor(lastDist: number, dist: number): number {
  return lastDist > 0 && dist > 0 ? clamp(dist / lastDist, 0.5, 2) : 1;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Eased state between two cameras: smoothstep on the position, geometric on the zoom. */
export function easeCamera(from: Camera, to: Camera, t: number): Camera {
  const k = smooth(clamp(t, 0, 1));
  return { x: from.x + (to.x - from.x) * k, z: from.z + (to.z - from.z) * k, zoom: from.zoom * Math.pow(to.zoom / from.zoom, k) };
}

/** A running eased move. `reduced` makes it instant. Cancelled by any user gesture. */
export class CameraMove {
  private startAt = 0;
  constructor(readonly from: Camera, readonly to: Camera, now: number, private readonly reduced: boolean) { this.startAt = now; }
  at(now: number): { camera: Camera; done: boolean } {
    if (this.reduced) return { camera: this.to, done: true };
    const t = (now - this.startAt) / FOCUS_MS;
    return { camera: easeCamera(this.from, this.to, t), done: t >= 1 };
  }
}
