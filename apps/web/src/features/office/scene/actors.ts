// Actor choreography (§5.2, §5.7). A plain state machine: no three.js, no clock, no randomness, so jsdom can test it.
// Poses come only from the OfficeModel; the only motion is a walk cue for a handoff that has a receipt. No wandering,
// and no success animation: a finished turn has no clip of its own.
import { dropBacklog, enqueue, type VisualCue, type VisualEndpoint, type VisualLimits } from '../model/timeline';
import type { OfficeAgent, OfficeModel, OfficePose } from '../model/types';
import { OBJECT_CELLS, cellCentre, routeBetween, seatCell, type Cell, type Vec2 } from './world';

export type Clip = 'sleep' | 'idle' | 'type' | 'type_fast' | 'walk' | 'carry' | 'raise_hand' | 'blocked' | 'ghost';
/** Clip names of character.glb (office-actors.test compares them with the file). */
export const CLIPS: readonly Clip[] = ['sleep', 'idle', 'type', 'type_fast', 'walk', 'carry', 'raise_hand', 'blocked', 'ghost'];
/** A seated character sits this far (world units) south of its desk, facing north (its back to the camera, like the audience in the reference); the offset fades out while it walks. */
export const SEAT_OFFSET_Z = 0.6;
/** Heading of a seated character: facing -z, towards its monitor. */
export const SEATED_HEADING = Math.PI;

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
  /** Direction the character faces, radians about the y axis (0 faces +z, towards the camera; a seated character faces -z). */
  heading: number;
  walking: boolean;
  /** True while the walk carries a document (outbound leg). */
  carrying: boolean;
}

interface Trip { cells: Cell[]; elapsed: number }
interface Actor { instanceId: string; role: string; certainty: OfficeAgent['certainty']; pose: OfficePose; home: Cell; trip?: Trip; key: string }

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const SEATED_AT = (c: Cell): Vec2 => { const p = cellCentre(c); return { x: p.x, z: p.z + SEAT_OFFSET_Z }; };

export class Choreographer {
  private readonly actors = new Map<string, Actor>();
  private queue: VisualCue[] = [];
  private readonly animateClips: boolean;
  /** `animateClips` false (reduced motion) leaves every clip frozen on its first pose, so nothing is busy at idle. */
  constructor(animateClips = true) { this.animateClips = animateClips; }

  /** Poses and seats always follow the model at once. Only walk cues are queued, and only when the caller allows motion. */
  apply(model: OfficeModel, cues: readonly VisualCue[]): string[] {
    const seen = new Set<string>();
    for (const agent of model.agents) {
      const home = agent.seat ? seatCell(agent.seat) : undefined;
      if (!home) continue;
      seen.add(agent.instanceId);
      const old = this.actors.get(agent.instanceId);
      const actor: Actor = old ?? { instanceId: agent.instanceId, role: agent.role, certainty: agent.certainty, pose: agent.pose, home, key: '' };
      actor.role = agent.role; actor.certainty = agent.certainty; actor.pose = agent.pose; actor.home = home;
      this.actors.set(agent.instanceId, actor);
    }
    for (const id of this.actors.keys()) if (!seen.has(id)) this.actors.delete(id);
    // A cue for an actor that left the model can never play: purge it so it cannot start later or hold budget.
    this.queue = this.queue.filter(c => c.kind !== 'walk' || this.actors.has(c.actor));
    const walks = cues.filter(c => c.kind === 'walk');
    if (walks.length > 0) this.queue = enqueue(this.queue, walks, WALK_LIMITS);
    return walks.map(c => c.handoffId);
  }

  /** True while a later tick can still change what is shown (a trip, a queued cue, or looping clips). Otherwise only the next apply can. */
  busy(): boolean {
    if (this.queue.length > 0 || (this.animateClips && this.actors.size > 0)) return true;
    for (const actor of this.actors.values()) if (actor.trip) return true;
    return false;
  }

  /** Hidden tab: discard every pending walk and put walkers back; on return only the latest pose is shown, with no replay. */
  pause(): void {
    this.queue = dropBacklog(this.queue);
    for (const actor of this.actors.values()) delete actor.trip;
  }

  /** Cell of a handoff endpoint: the instance's seat, the first seat of the role, or the Conversation counter / server for non-agent zones. */
  cellFor(endpoint: VisualEndpoint): Cell | undefined {
    if (endpoint.kind === 'instance') return this.actors.get(endpoint.instanceId)?.home;
    for (const actor of this.actors.values()) if (actor.role === endpoint.role) return actor.home;
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
    const out = cell ? routeBetween(actor.home, cell) : [];
    if (out.length < 2) return;
    actor.trip = { cells: [...out, ...[...out].reverse().slice(1)], elapsed: 0 };
  }

  /** Advances time. `moving` asks for the 30 fps budget; `changed` says some actor looks different from last tick. */
  tick(dtMs: number): { moving: boolean; changed: boolean } {
    if (!this.busy()) return { moving: false, changed: false };
    let moving = false;
    for (const actor of this.actors.values()) {
      if (!actor.trip) this.start(actor);
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
    const base = { instanceId: actor.instanceId, role: actor.role, certainty: actor.certainty, pose: actor.pose };
    const trip = actor.trip;
    if (!trip) return { ...base, clip: clipFor(actor.pose), point: SEATED_AT(actor.home), heading: SEATED_HEADING, walking: false, carrying: false };
    const steps = trip.cells.length - 1;
    const p = Math.min(1, trip.elapsed / WALK_LIMITS.walkMs) * steps;
    const i = Math.min(steps - 1, Math.floor(p));
    const a = cellCentre(trip.cells[i] as Cell), b = cellCentre(trip.cells[i + 1] as Cell), f = p - i;
    // The seat offset fades over the first and last step, so the character stands up and sits down instead of jumping.
    const seat = i === 0 ? 1 - f : i === steps - 1 ? f : 0;
    const out = trip.elapsed < WALK_LIMITS.walkMs / 2;
    return {
      ...base, clip: out ? 'carry' : 'walk', walking: true, carrying: out,
      point: { x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f) + SEAT_OFFSET_Z * seat },
      heading: Math.atan2(b.x - a.x, b.z - a.z),
    };
  }

  private keyOf(actor: Actor): string {
    const v = this.viewOf(actor);
    return `${v.clip}:${Math.round(v.point.x * 20)}:${Math.round(v.point.z * 20)}:${v.certainty}`;
  }

  views(): ActorView[] { return [...this.actors.values()].map(a => this.viewOf(a)); }
}
