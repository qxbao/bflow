// Actor animation (§5.2, §5.7). A plain state machine: no Pixi, no clock, no randomness, so jsdom can test it.
// Poses come only from the OfficeModel; the only motion is a walk cue for a handoff that has a receipt. No wandering,
// and no success animation: a finished turn has no clip of its own.
import { dropBacklog, enqueue, type VisualCue, type VisualEndpoint, type VisualLimits } from '../model/timeline';
import type { OfficeAgent, OfficeModel, OfficePose } from '../model/types';
import { OBJECT_CELLS, cellCentre, routeBetween, seatCell, type Cell, type Point } from './layers';

export type Clip = 'sleep' | 'idle' | 'type' | 'type_fast' | 'walk' | 'carry' | 'raise_hand' | 'blocked' | 'ghost';
/** Frames per clip. Must equal the clips of scripts/generate-office-atlas.mjs (office-actors.test compares them with the atlas). */
export const CLIP_FRAMES: Readonly<Record<Clip, number>> = { sleep: 2, idle: 2, type: 2, type_fast: 2, walk: 4, carry: 4, raise_hand: 2, blocked: 2, ghost: 2 };
/** Clip frame rate, inside the 6-8 fps of §5.2. */
export const CLIP_FPS = 7;
export const frameName = (role: string, clip: Clip, index: number): string => `agent_${role}_${clip}_${index}`;

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
  frame: number;
  /** World position of the cell centre the actor is on. */
  point: Point;
  /** Nearest cell, for draw order. */
  cell: Cell;
  walking: boolean;
}

interface Trip { cells: Cell[]; elapsed: number }
interface Actor { instanceId: string; role: string; certainty: OfficeAgent['certainty']; pose: OfficePose; home: Cell; trip?: Trip; key: string }

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export class Choreographer {
  private readonly actors = new Map<string, Actor>();
  private queue: VisualCue[] = [];
  private time = 0;
  private readonly animateFrames: boolean;
  constructor(animateFrames = true) { this.animateFrames = animateFrames; }

  /** Poses and seats always follow the model at once. Only walk cues are queued, and only when the caller allows motion. */
  apply(model: OfficeModel, cues: readonly VisualCue[]): void {
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
    const walks = cues.filter(c => c.kind === 'walk');
    if (walks.length > 0) this.queue = enqueue(this.queue, walks, WALK_LIMITS);
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
    this.time += dtMs;
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

  private frameOf(clip: Clip): number {
    return this.animateFrames ? Math.floor((this.time * CLIP_FPS) / 1000) % CLIP_FRAMES[clip] : 0;
  }

  private viewOf(actor: Actor): ActorView {
    const base = { instanceId: actor.instanceId, role: actor.role, certainty: actor.certainty, pose: actor.pose };
    const trip = actor.trip;
    if (!trip) {
      const clip = clipFor(actor.pose);
      return { ...base, clip, frame: this.frameOf(clip), point: cellCentre(actor.home), cell: actor.home, walking: false };
    }
    const steps = trip.cells.length - 1;
    const p = Math.min(1, trip.elapsed / WALK_LIMITS.walkMs) * steps;
    const i = Math.min(steps - 1, Math.floor(p));
    const a = cellCentre(trip.cells[i] as Cell), b = cellCentre(trip.cells[i + 1] as Cell), f = p - i;
    const out = trip.elapsed < WALK_LIMITS.walkMs / 2;
    const clip: Clip = out ? 'carry' : 'walk';
    return { ...base, clip, frame: this.frameOf(clip), point: { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) }, cell: trip.cells[f < 0.5 ? i : i + 1] as Cell, walking: true };
  }

  private keyOf(actor: Actor): string {
    const v = this.viewOf(actor);
    return `${v.clip}:${v.frame}:${Math.round(v.point.x)}:${Math.round(v.point.y)}:${v.certainty}`;
  }

  views(): ActorView[] { return [...this.actors.values()].map(a => this.viewOf(a)); }
}
