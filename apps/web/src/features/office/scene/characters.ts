// Three.js characters: clones of character.glb with per-role colours, one AnimationMixer each, plus the small 3D desk marks.
// Positions, poses and clips come from the Choreographer; this file only draws them. No text anywhere in the scene.
import {
  AnimationAction, AnimationClip, AnimationMixer, BoxGeometry, Color, CylinderGeometry, Group, LoopRepeat, Material, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Object3D, SphereGeometry, TorusGeometry,
} from 'three';
import type { HandoffMark } from '../model/timeline';
import type { ActorView, Clip } from './actors';

/** Pastel hoodie colour per role (the name is always shown as text in the mirror and inspector, never only by colour). */
export const ROLE_COLORS: Readonly<Record<string, string>> = {
  conversation: '#f2d479', coordinator: '#b4a7e0', planner: '#8fd3b6', architect: '#8ec1ea', specifier: '#f3b08c',
  reviewer: '#b9d98a', qa: '#eba0bf', tester: '#7fcfd0', security: '#ee8f86', developer: '#9bb8f0',
};
/** Roles dressed in a suit and tie (the `suit` child of the torso replaces the `hoodie`), with the suit cloth colour. */
const SUITS: Readonly<Record<string, string>> = { conversation: '#2c3a55' };
/** Roles in a sleeveless top (the `tank` child of the torso and the `bare_<k>` arms replace the `hoodie` and `sleeve_<k>`). */
const TANKS: ReadonlySet<string> = new Set(['developer']);
/** Roles in shorts (the bare `calf_<k>` replace the `pants_<k>` trouser legs): the Developer zone wears a tank top and shorts only. */
const SHORTS: ReadonlySet<string> = new Set(['developer']);
/** Roles in a white business shirt (the `dress_shirt` child of the torso over a white outfit, with the long `sleeve_<k>`): the Director Team and the bartender. */
const DRESS_SHIRTS: ReadonlySet<string> = new Set(['planner', 'architect', 'specifier', 'coordinator', 'bartender']);
/** Roles with the black `vest` (a child of the torso) over the white business shirt: the bartender. */
const VESTS: ReadonlySet<string> = new Set(['bartender']);
const SHIRT_WHITE = '#f4f3ee';
/**
 * Roles in the team T-shirt (the `tshirt` child of the torso, the `bare_<k>` arms and the short `tsleeve_<k>` sleeves replace the `hoodie` and
 * `sleeve_<k>`), with the shirt colour: the black Bflow shirt with the yellow logo of the Reviewer / QA reference look.
 */
const TSHIRTS: Readonly<Record<string, string>> = { reviewer: '#1e1f24', qa: '#1e1f24' };
/** Roles wearing the round black `glasses` (a child of the head). */
const GLASSES: ReadonlySet<string> = new Set(['reviewer']);
/** Hair style per role (a `hair_*` child of the head); everyone else wears `hair_short`. `hair_long` comes with the `face_f` details. */
const HAIR_STYLES: Readonly<Record<string, string>> = { qa: 'hair_spiky', reviewer: 'hair_long' };
/** Hair colour per role, replacing the dark default of the `hair` material: the Reviewer's crimson and QA's jet black. */
const HAIR_COLORS: Readonly<Record<string, string>> = { reviewer: '#8a1538', qa: '#141417' };
/** Trousers and shoe colours per role (navy trousers, dark plum shoes in the reference look), replacing the `trousers` and `shoe` defaults. */
const TROUSERS: Readonly<Record<string, string>> = { reviewer: '#2a2f45', qa: '#2a2f45', bartender: '#1c1d22' };
const SHOES: Readonly<Record<string, string>> = { reviewer: '#2b2233', qa: '#2b2233' };
const HAIR_NAMES = ['hair_short', 'hair_spiky', 'hair_long'] as const;
const FADE = 0.18;
const hashOf = (id: string): number => { let h = 2166136261; for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };
const shortest = (from: number, to: number): number => { let d = (to - from) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

export class Character {
  readonly root = new Group();
  readonly proxy: Mesh;
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<Clip, AnimationAction>();
  private readonly mats: Material[] = [];
  private readonly paper: Object3D | undefined;
  private current: Clip | undefined;
  private alpha = 1;
  private readonly phase: number;

  /**
   * `instanceId` is the scene key (phase seed). `pick` is what the pick proxy reports: an agent's instance by default; the Director desk figure passes
   * `{ director: true }`, so it is never picked as (or mistaken for) an agent.
   */
  constructor(template: Object3D, private readonly clips: readonly AnimationClip[], readonly instanceId: string, role: string, proxyGeometry: BoxGeometry, proxyMaterial: MeshBasicMaterial, pick: Record<string, unknown> = { instanceId }) {
    const body = template.clone(true);
    const suit = SUITS[role], shirt = suit === undefined ? TSHIRTS[role] : undefined, dress = suit === undefined && shirt === undefined && DRESS_SHIRTS.has(role);
    const outfit = suit ?? shirt ?? (dress ? SHIRT_WHITE : undefined) ?? ROLE_COLORS[role] ?? ROLE_COLORS['developer'];
    const tank = suit === undefined && shirt === undefined && !dress && TANKS.has(role), style = HAIR_STYLES[role] ?? 'hair_short', hairColor = HAIR_COLORS[role];
    const show = (name: string, visible: boolean): void => { const o = body.getObjectByName(name); if (o) o.visible = visible; };
    show('hoodie', suit === undefined && shirt === undefined && !dress && !tank); show('dress_shirt', dress); show('suit', suit !== undefined); show('tank', tank); show('tshirt', shirt !== undefined); show('vest', dress && VESTS.has(role));
    for (const k of ['l', 'r']) { show(`sleeve_${k}`, !tank && shirt === undefined); show(`bare_${k}`, tank || shirt !== undefined); show(`tsleeve_${k}`, shirt !== undefined); show(`pants_${k}`, !SHORTS.has(role)); show(`calf_${k}`, SHORTS.has(role)); }
    for (const name of HAIR_NAMES) show(name, name === style);
    show('face_f', style === 'hair_long');
    show('glasses', GLASSES.has(role));
    // Own materials per character, so alpha and the role colour never leak to another one; the templates stay untouched.
    body.traverse(o => {
      if (!(o instanceof Mesh)) return;
      const m = (o.material as MeshStandardMaterial).clone();
      if (m.name === 'outfit') { m.color = new Color(outfit); m.emissive = m.color.clone(); m.emissiveIntensity = suit || shirt ? 0.12 : dress ? 0.05 : 0.22; }
      if (m.name === 'hair' && hairColor) m.color = new Color(hairColor);
      if (m.name === 'trousers' && TROUSERS[role]) m.color = new Color(TROUSERS[role]);
      if (m.name === 'shoe' && SHOES[role]) m.color = new Color(SHOES[role]);
      o.material = m; o.castShadow = true; o.receiveShadow = false;
      this.mats.push(m);
    });
    this.paper = body.getObjectByName('paper');
    if (this.paper) this.paper.visible = false;
    this.root.add(body);
    this.mixer = new AnimationMixer(body);
    this.phase = hashOf(instanceId);
    this.proxy = new Mesh(proxyGeometry, proxyMaterial);
    this.proxy.position.y = 0.85; this.proxy.scale.set(0.9, 1.7, 0.9);
    Object.assign(this.proxy.userData, pick);
    this.root.add(this.proxy);
  }

  /** Pose from a view. `animate` false (reduced motion) freezes the clip on its first frame. */
  set(view: ActorView, alpha: number, animate: boolean): void {
    this.root.position.set(view.point.x, view.lift, view.point.z);
    this.root.rotation.y += shortest(this.root.rotation.y, view.heading) * (view.walking ? 0.35 : 1);
    if (this.paper) this.paper.visible = view.carrying;
    if (alpha !== this.alpha) {
      this.alpha = alpha;
      // A translucent figure still writes depth: its own parts then hide each other (the skull stays under the hair) whatever order they draw in.
      for (const m of this.mats) { m.transparent = alpha < 1; m.opacity = alpha; m.needsUpdate = true; }
    }
    if (view.clip !== this.current) this.play(view.clip, animate);
  }

  private play(clip: Clip, animate: boolean): void {
    let next = this.actions.get(clip);
    if (!next) {
      const source = this.clips.find(c => c.name === clip);
      if (!source) return;
      next = this.mixer.clipAction(source);
      next.setLoop(LoopRepeat, Infinity);
      this.actions.set(clip, next);
    }
    const prev = this.current ? this.actions.get(this.current) : undefined;
    next.reset();
    next.time = this.phase * next.getClip().duration;
    next.play();
    if (prev && animate) next.crossFadeFrom(prev, FADE, false); else if (prev) prev.stop();
    this.current = clip;
    // A frozen character still needs its pose applied once.
    if (!animate) this.mixer.update(0);
  }

  update(dtSeconds: number): void { this.mixer.update(dtSeconds); }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    for (const m of this.mats) m.dispose();
    this.root.removeFromParent();
  }
}

/** Small no-text desk indicators: waiting (three dots in a bubble), question (a "?" made of geometry), blocked (a no-entry disc). */
export class MarkKit {
  private readonly geo = {
    bubble: new BoxGeometry(0.5, 0.26, 0.05), dot: new SphereGeometry(0.035, 8, 6), disc: new CylinderGeometry(0.17, 0.17, 0.05, 16), bar: new BoxGeometry(0.22, 0.06, 0.03),
    hook: new TorusGeometry(0.06, 0.02, 6, 14, Math.PI * 1.5), stem: new BoxGeometry(0.04, 0.05, 0.04), point: new SphereGeometry(0.03, 8, 6),
  };
  private readonly mat = {
    cream: new MeshStandardMaterial({ color: '#f3ead0', roughness: 0.6, emissive: '#3a3425' }), dark: new MeshStandardMaterial({ color: '#2a2e35', roughness: 0.6 }),
    amber: new MeshStandardMaterial({ color: '#ffb347', roughness: 0.5, emissive: '#ffb347', emissiveIntensity: 0.6 }), red: new MeshStandardMaterial({ color: '#d9534f', roughness: 0.5, emissive: '#d9534f', emissiveIntensity: 0.5 }),
    white: new MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 }),
  };
  build(mark: HandoffMark): Group {
    const g = new Group(), { geo, mat } = this;
    const add = (geometry: Mesh['geometry'], material: Material, x = 0, y = 0, z = 0): Mesh => { const m = new Mesh(geometry, material); m.position.set(x, y, z); g.add(m); return m; };
    if (mark === 'waiting') {
      add(geo.bubble, mat.cream);
      for (const x of [-0.12, 0, 0.12]) add(geo.dot, mat.amber, x, 0, 0.04);
    } else if (mark === 'question') {
      add(geo.disc, mat.amber).rotation.x = Math.PI / 2;
      add(geo.hook, mat.dark, 0, 0.04, 0.03).rotation.z = -Math.PI * 0.25;
      add(geo.stem, mat.dark, 0.0, -0.045, 0.03); add(geo.point, mat.dark, 0, -0.1, 0.03);
    } else {
      add(geo.disc, mat.red).rotation.x = Math.PI / 2;
      add(geo.bar, mat.white, 0, 0, 0.03);
    }
    g.rotation.x = -0.35;
    return g;
  }
  dispose(): void { for (const x of Object.values(this.geo)) x.dispose(); for (const x of Object.values(this.mat)) x.dispose(); }
}
