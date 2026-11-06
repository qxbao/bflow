// Actor choreography (§5.2, §5.7). A plain state machine: no three.js, no clock, no randomness, so jsdom can test it.
// Poses come only from the OfficeModel. Motion is a walk cue for a handoff that has a receipt, or the walk between a desk and the Creative Space when
// an agent starts or stops being idle. No wandering, and no success animation: a finished turn has no clip of its own.
// Every drawn desk has one figure: its agent, or an anonymous staff member (ambient decoration, never an agent, never picked or labelled). Whoever
// is not working (an idle agent, every staff member) spends the time at a leisure spot of the Creative Space, then the pool.
import { dropBacklog, enqueue, type VisualCue, type VisualEndpoint, type VisualLimits } from '../model/timeline';
import type { OfficeAgent, OfficeDirectorPresence, OfficeModel, OfficePose } from '../model/types';
import { LOUNGE_SPOTS, OBJECT_CELLS, cellCentre, deskCentre, deskPlan, roomShift, routeBetween, seatCell, type Cell, type LoungeActivity, type Vec2 } from './world';

export type Clip = 'sleep' | 'idle' | 'type' | 'type_fast' | 'walk' | 'carry' | 'raise_hand' | 'blocked' | 'ghost' | 'stand' | 'play' | 'swim';
/** Clip names of character.glb (office-actors.test compares them with the file). */
export const CLIPS: readonly Clip[] = ['sleep', 'idle', 'type', 'type_fast', 'walk', 'carry', 'raise_hand', 'blocked', 'ghost', 'stand', 'play', 'swim'];
/** Clip of each leisure activity; a figure perched on a bar stool uses the seated idle clip. */
export const ACTIVITY_CLIP: Readonly<Record<LoungeActivity, Clip>> = { stand: 'stand', play: 'play', perch: 'idle', swim: 'swim' };
/** Pace of the walk between a desk and a leisure spot, and its bounds. */
export const COMMUTE = { msPerCell: 260, minMs: 800, maxMs: 5000 } as const;
/** An agent with nothing to do: it leaves its desk for the Creative Space. Uncertain or lost agents stay at the desk, where their state shows. */
export const isIdle = (pose: OfficePose): boolean => pose === 'sleeping';
/** Role drawn for a staff member of a desk: the role of the seat (`developer:3`, `coordination:planner`, `verification:qa:2`). */
export const seatRole = (seat: string): string => (seat.startsWith('developer:') ? 'developer' : (seat.split(':')[1] ?? 'developer'));
/** A seated character sits this far (world units) north of its desk, facing the camera side; the offset fades out while it walks. */
export const SEAT_OFFSET_Z = -0.62;
/** Heading of a seated character: facing +z, so its face is visible over the low laptop or monitor. */
export const SEATED_HEADING = 0;

/** One clip per pose. A pose with no distinct clip (question, preparing) stands still and shows its desk bubble instead. */
export function clipFor(pose: OfficePose): Clip {
  switch (pose) {
    case 'sleeping': return 'sleep';
    case 'working': return 'type';
    case 'typing': return 'type_fast';
    case 'hand_raised': return 'raise_hand';
    case 'disconnected': return 'blocked';
    case 'ghost': return 'ghost';
    default: return 'idle'; // question, preparing
  }
}

/**
 * The Director figure at its desk, from presence alone (host heartbeat, never Herdr done). Absent is an empty desk; unknown (a failed read) is a
 * translucent ghost, so the two never look alike. There is no success clip.
 */
export function directorPose(presence: OfficeDirectorPresence): { visible: boolean; clip: Clip; alpha: number } {
  switch (presence) {
    case 'active': return { visible: true, clip: 'type', alpha: 1 };
    case 'waiting': return { visible: true, clip: 'idle', alpha: 1 };
    case 'unknown': return { visible: true, clip: 'ghost', alpha: 0.45 };
    default: return { visible: false, clip: 'idle', alpha: 1 };
  }
}
/** Logical roles whose work the Director owns in a Director layout: a handoff endpoint naming them (with no instance) ends at the Director desk. */
const DIRECTOR_ROLES = new Set(['conversation', 'coordinator']);

/** Each cue is an out-and-back trip of `walkMs`; with two per actor and 2500 ms in total this is the §4.5 budget. */
export const WALK_LIMITS: VisualLimits = { maxPerActor: 2, maxTravelMs: 2500, walkMs: 1250 };

export interface ActorView {
  instanceId: string;
  role: string;
  certainty: OfficeAgent['certainty'];
  pose: OfficePose;
  clip: Clip;
  /** World floor position (x, z) of the character. */
  point: Vec2;
  /** Direction the character faces, radians about the y axis (0 faces +z, towards the camera). */
  heading: number;
  walking: boolean;
  /** True while the walk carries a document (outbound leg). */
  carrying: boolean;
  /** A staff member of an unoccupied desk: decoration, not an agent. */
  ambient: boolean;
  /** At (or on the way to) a leisure spot rather than at the desk. */
  lounging: boolean;
  /** Height of the feet above the floor: up on a bar stool, down in the pool. */
  lift: number;
}

interface Trip { cells: Cell[]; elapsed: number }
/** A one-way walk along world points (desk to leisure spot or back). */
interface Commute { points: Vec2[]; elapsed: number; duration: number }
interface Actor { instanceId: string; role: string; certainty: OfficeAgent['certainty']; pose: OfficePose; home: Cell; ambient: boolean; spot?: number; trip?: Trip; commute?: Commute; key: string }

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const SEATED_AT = (c: Cell): Vec2 => { const p = deskCentre(c); return { x: p.x, z: p.z + SEAT_OFFSET_Z }; };

export class Choreographer {
  private readonly actors = new Map<string, Actor>();
  private queue: VisualCue[] = [];
  /** Desks drawn for the current model; only these block a walk. */
  private desks: readonly Cell[] = deskPlan([]).desks;
  private readonly animateClips: boolean;
  /** Cell of the Director desk while the model has one. */
  private directorDesk: Cell | undefined;
  /** `animateClips` false (reduced motion) leaves every clip frozen on its first pose, so nothing is busy at idle. */
  constructor(animateClips = true) { this.animateClips = animateClips; }

  /** Poses and seats always follow the model at once. Only walk cues are queued, and only when the caller allows motion. */
  apply(model: OfficeModel, cues: readonly VisualCue[]): string[] {
    const seen = new Set<string>(), fresh = new Set<string>(), lounge: string[] = [], occupied = new Set<string>();
    this.directorDesk = model.director?.seat ? seatCell(model.director.seat) : undefined;
    const plan = deskPlan(model.agents.flatMap(a => (a.seat ? [a.seat] : [])));
    this.desks = plan.desks;
    const upsert = (id: string, role: string, certainty: OfficeAgent['certainty'], pose: OfficePose, home: Cell, ambient: boolean): void => {
      seen.add(id);
      const old = this.actors.get(id);
      if (!old) fresh.add(id);
      const actor: Actor = old ?? { instanceId: id, role, certainty, pose, home, ambient, key: '' };
      actor.role = role; actor.certainty = certainty; actor.pose = pose; actor.home = home; actor.ambient = ambient;
      this.actors.set(id, actor);
    };
    for (const agent of model.agents) {
      const home = agent.seat ? seatCell(agent.seat) : undefined;
      if (!home || !agent.seat) continue;
      occupied.add(agent.seat);
      upsert(agent.instanceId, agent.role, agent.certainty, agent.pose, home, false);
      if (isIdle(agent.pose)) lounge.push(agent.instanceId);
    }
    // A running (or degraded) session has a full staff: every desk without an agent gets an anonymous staff member, who is not working.
    if (model.tier !== 'closed') plan.seats.forEach((seat, i) => {
      if (occupied.has(seat)) return;
      const id = `staff:${seat}`;
      upsert(id, seatRole(seat), 'confirmed', 'sleeping', plan.desks[i] as Cell, true);
      lounge.push(id);
    });
    for (const id of this.actors.keys()) if (!seen.has(id)) this.actors.delete(id);
    this.placeLoungers(lounge, fresh);
    // A cue for an actor that left the model, or that is away from its desk, can never play: purge it so it cannot start later or hold budget.
    this.queue = this.queue.filter(c => c.kind !== 'walk' || (this.actors.has(c.actor) && this.actors.get(c.actor)?.spot === undefined));
    const walks = cues.filter(c => c.kind === 'walk');
    const playable = walks.filter(c => this.actors.get(c.actor)?.spot === undefined);
    if (playable.length > 0) this.queue = enqueue(this.queue, playable, WALK_LIMITS);
    return walks.map(c => c.handoffId);
  }

  /**
   * Leisure spots are sticky: a figure keeps its spot while it stays idle, and a newly idle one takes the lowest free spot (fill order keeps the
   * rooms balanced). There are more spots than desks; should they ever run out, a staff member without a spot is not drawn and an agent without one
   * stays at its desk. Figures that change between desk and spot walk there unless they just appeared.
   */
  private placeLoungers(lounge: readonly string[], fresh: ReadonlySet<string>): void {
    const wanted = new Set(lounge), used = new Map<number, Actor>();
    for (const actor of this.actors.values()) {
      if (actor.spot === undefined) continue;
      if (wanted.has(actor.instanceId)) used.set(actor.spot, actor);
      else this.moveTo(actor, undefined, fresh.has(actor.instanceId));
    }
    for (const id of lounge) {
      const actor = this.actors.get(id);
      if (!actor || actor.spot !== undefined) continue;
      const free = LOUNGE_SPOTS.findIndex((_, i) => !used.has(i));
      if (free < 0) { if (actor.ambient) this.actors.delete(id); continue; }
      used.set(free, actor);
      this.moveTo(actor, free, fresh.has(id));
    }
  }

  /** Sends an actor to a leisure spot (or back to its desk with `undefined`), walking from where it is now unless it just appeared. */
  private moveTo(actor: Actor, spot: number | undefined, appear: boolean): void {
    const from = this.viewOf(actor).point;
    if (spot === undefined) delete actor.spot; else actor.spot = spot;
    delete actor.trip; delete actor.commute;
    if (appear || !this.animateClips) return;
    const to = this.restPoint(actor);
    const cells = routeBetween({ gx: Math.floor(from.x), gy: Math.floor(from.z) }, { gx: Math.floor(to.x), gy: Math.floor(to.z) }, this.desks);
    if (cells.length < 2) return;
    const duration = Math.min(COMMUTE.maxMs, Math.max(COMMUTE.minMs, cells.length * COMMUTE.msPerCell));
    actor.commute = { points: [from, ...cells.slice(1, -1).map(cellCentre), to], elapsed: 0, duration };
  }

  /** Where an actor stays when it is not walking: its leisure spot, or seated at its desk. */
  private restPoint(actor: Actor): Vec2 {
    const s = actor.spot === undefined ? undefined : LOUNGE_SPOTS[actor.spot];
    return s ? { x: s.x, z: s.z } : SEATED_AT(actor.home);
  }

  /** True while a later tick can still change what is shown (a trip, a queued cue, or looping clips). Otherwise only the next apply can. */
  busy(): boolean {
    if (this.queue.length > 0 || (this.animateClips && this.actors.size > 0)) return true;
    for (const actor of this.actors.values()) if (actor.trip || actor.commute) return true;
    return false;
  }

  /** Hidden tab: discard every pending walk and put walkers back; on return only the latest pose is shown, with no replay. */
  pause(): void {
    this.queue = dropBacklog(this.queue);
    for (const actor of this.actors.values()) { delete actor.trip; delete actor.commute; }
  }

  /**
   * Cell of a handoff endpoint: the instance's seat, the first seat of the role, or the Conversation counter / server for non-agent zones. In a
   * Director layout a Conversation or Coordinator zone endpoint ends at the Director desk (visual only; the wire role is unchanged).
   */
  cellFor(endpoint: VisualEndpoint): Cell | undefined {
    if (endpoint.kind === 'instance') return this.actors.get(endpoint.instanceId)?.home;
    for (const actor of this.actors.values()) if (!actor.ambient && actor.role === endpoint.role) return actor.home;
    if (this.directorDesk && DIRECTOR_ROLES.has(endpoint.role)) return this.directorDesk;
    return endpoint.role === 'conversation' ? OBJECT_CELLS.counter : OBJECT_CELLS.server;
  }

  private start(actor: Actor): void {
    const at = this.queue.findIndex(c => c.kind === 'walk' && c.actor === actor.instanceId);
    if (at < 0) return;
    const [cue] = this.queue.splice(at, 1);
    if (cue?.kind !== 'walk') return;
    // The walker goes to the other end of the handoff: the receiver when it is the sender, else the sender's zone.
    const target = cue.from.kind === 'instance' && cue.from.instanceId === actor.instanceId ? cue.to : cue.from;
    const cell = this.cellFor(target);
    const out = cell ? routeBetween(actor.home, cell, this.desks) : [];
    if (out.length < 2) return;
    actor.trip = { cells: [...out, ...[...out].reverse().slice(1)], elapsed: 0 };
  }

  /** Advances time. `moving` asks for the 30 fps budget; `changed` says some actor looks different from last tick. */
  tick(dtMs: number): { moving: boolean; changed: boolean } {
    if (!this.busy()) return { moving: false, changed: false };
    let moving = false;
    for (const actor of this.actors.values()) {
      if (actor.commute) {
        actor.commute.elapsed += dtMs;
        if (actor.commute.elapsed >= actor.commute.duration) delete actor.commute;
        else moving = true;
        continue;
      }
      if (!actor.trip && actor.spot === undefined) this.start(actor);
      if (actor.trip) {
        actor.trip.elapsed += dtMs;
        if (actor.trip.elapsed >= WALK_LIMITS.walkMs) delete actor.trip;
        else moving = true;
      }
    }
    let changed = false;
    for (const actor of this.actors.values()) {
      const key = this.keyOf(actor);
      if (key !== actor.key) { actor.key = key; changed = true; }
    }
    return { moving, changed };
  }

  private viewOf(actor: Actor): ActorView {
    const base = { instanceId: actor.instanceId, role: actor.role, certainty: actor.certainty, pose: actor.pose, ambient: actor.ambient, lounging: actor.spot !== undefined, lift: 0 };
    if (actor.commute) return { ...base, ...along(actor.commute), clip: 'walk', walking: true, carrying: false, lounging: true };
    const s = actor.spot === undefined ? undefined : LOUNGE_SPOTS[actor.spot];
    if (s) return { ...base, clip: ACTIVITY_CLIP[s.activity], point: { x: s.x, z: s.z }, heading: s.heading, walking: false, carrying: false, lift: s.lift };
    const trip = actor.trip;
    if (!trip) return { ...base, clip: clipFor(actor.pose), point: SEATED_AT(actor.home), heading: SEATED_HEADING, walking: false, carrying: false };
    const steps = trip.cells.length - 1;
    const p = Math.min(1, trip.elapsed / WALK_LIMITS.walkMs) * steps;
    const i = Math.min(steps - 1, Math.floor(p));
    const a = cellCentre(trip.cells[i] as Cell), b = cellCentre(trip.cells[i + 1] as Cell), f = p - i;
    // The seat offset (and a desk's half-cell room shift) fades over the first and last step, so the character stands up and sits down instead of jumping.
    const seat = i === 0 ? 1 - f : i === steps - 1 ? f : 0;
    const shift = (i === 0 ? roomShift(trip.cells[0] as Cell) * (1 - f) : 0) + (i === steps - 1 ? roomShift(trip.cells[steps] as Cell) * f : 0);
    const out = trip.elapsed < WALK_LIMITS.walkMs / 2;
    return {
      ...base, clip: out ? 'carry' : 'walk', walking: true, carrying: out,
      point: { x: lerp(a.x, b.x, f) + shift, z: lerp(a.z, b.z, f) + SEAT_OFFSET_Z * seat },
      heading: Math.atan2(b.x - a.x, b.z - a.z),
    };
  }

  private keyOf(actor: Actor): string {
    const v = this.viewOf(actor);
    return `${v.clip}:${Math.round(v.point.x * 20)}:${Math.round(v.point.z * 20)}:${v.certainty}`;
  }

  /** The agents' figures. */
  views(): ActorView[] { return [...this.actors.values()].filter(a => !a.ambient).map(a => this.viewOf(a)); }
  /** The staff of unoccupied desks: drawn, never picked or labelled. */
  ambientViews(): ActorView[] { return [...this.actors.values()].filter(a => a.ambient).map(a => this.viewOf(a)); }
}

/** Position and heading at the elapsed fraction of a commute, by distance along its points. */
function along(c: Commute): { point: Vec2; heading: number } {
  const seg = c.points.slice(1).map((b, i) => { const a = c.points[i] as Vec2; return { a, b, len: Math.hypot(b.x - a.x, b.z - a.z) }; });
  let rest = (Math.min(1, c.elapsed / c.duration)) * seg.reduce((n, g) => n + g.len, 0);
  for (const g of seg) {
    if (rest <= g.len || g === seg[seg.length - 1]) {
      const f = g.len > 0 ? Math.min(1, rest / g.len) : 1;
      return { point: { x: lerp(g.a.x, g.b.x, f), z: lerp(g.a.z, g.b.z, f) }, heading: Math.atan2(g.b.x - g.a.x, g.b.z - g.a.z) };
    }
    rest -= g.len;
  }
  return { point: c.points[c.points.length - 1] as Vec2, heading: SEATED_HEADING };
}
