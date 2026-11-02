// Visual-only timeline. Cues are derived from model diffs and never flow back into the OfficeModel.
import type { OfficeHandoff, OfficeModel } from './types';

export type VisualEndpoint = { kind: 'instance'; instanceId: string } | { kind: 'zone'; role: string };

export type VisualCue =
  | { kind: 'walk'; handoffId: string; actor: string; from: VisualEndpoint; to: VisualEndpoint }
  | { kind: 'waiting'; handoffId: string; at: VisualEndpoint }
  | { kind: 'question'; handoffId: string; at: VisualEndpoint }
  | { kind: 'blocked'; handoffId: string; at: VisualEndpoint };

export interface VisualLimits {
  maxPerActor: number;
  /** Total walking time across the queue, in ms. */
  maxTravelMs: number;
  /** Duration charged for each walk cue, in ms. */
  walkMs: number;
}

const WALK = new Set<OfficeHandoff['state']>(['accepted', 'delivered', 'released', 'applied']);

const sender = (h: OfficeHandoff): VisualEndpoint =>
  h.fromInstanceId ? { kind: 'instance', instanceId: h.fromInstanceId } : { kind: 'zone', role: h.fromRole };
const receiver = (h: OfficeHandoff): VisualEndpoint =>
  h.toInstanceId ? { kind: 'instance', instanceId: h.toInstanceId } : { kind: 'zone', role: h.toRole };

function cueFor(h: OfficeHandoff): VisualCue | undefined {
  switch (h.state) {
    case 'accepted': case 'delivered': case 'released': case 'applied': {
      // A walk needs a character: with neither sender nor receiver instance there is nobody to animate, so no cue.
      const actor = h.fromInstanceId ?? h.toInstanceId;
      return actor ? { kind: 'walk', handoffId: h.handoffId, actor, from: sender(h), to: receiver(h) } : undefined;
    }
    case 'queued': case 'sending': return { kind: 'waiting', handoffId: h.handoffId, at: sender(h) };
    case 'unknown_delivery': return { kind: 'question', handoffId: h.handoffId, at: sender(h) };
    case 'rejected': case 'failed': return { kind: 'blocked', handoffId: h.handoffId, at: sender(h) };
    default: return undefined; // cancelled
  }
}

export type HandoffMark = 'waiting' | 'question' | 'blocked';

const markOf = (state: OfficeHandoff['state']): HandoffMark | undefined => {
  switch (state) {
    case 'queued': case 'sending': return 'waiting';
    case 'unknown_delivery': return 'question';
    case 'rejected': case 'failed': return 'blocked';
    default: return undefined; // walk states and cancelled carry no desk indicator
  }
};

/** Desk indicators from handoff state alone; the scene renders them on every apply (also after reload). */
export function handoffMarks(model: OfficeModel): { handoffId: string; at: VisualEndpoint; mark: HandoffMark }[] {
  const out: { handoffId: string; at: VisualEndpoint; mark: HandoffMark }[] = [];
  for (const h of model.handoffs) {
    const mark = markOf(h.state);
    if (mark) out.push({ handoffId: h.handoffId, at: sender(h), mark });
  }
  return out;
}

/**
 * Cues for what changed between two models. Undefined `prev` is the baseline (first read, reload or
 * reset): no cues. A walk fires only on a non-walk -> walk move (or a new handoff already walking) and
 * never for an id in `walked`, which the consumer owns. A non-walk cue fires when a handoff appears or
 * moves into a different indicator state.
 */
export function diffVisual(prev: OfficeModel | undefined, next: OfficeModel, walked?: ReadonlySet<string>): VisualCue[] {
  if (!prev) return [];
  const before = new Map(prev.handoffs.map(h => [h.handoffId, h.state]));
  const cues: VisualCue[] = [];
  for (const h of next.handoffs) {
    const was = before.get(h.handoffId);
    if (WALK.has(h.state)) {
      if (walked?.has(h.handoffId) || (was !== undefined && WALK.has(was))) continue;
    } else if (was !== undefined && markOf(was) === markOf(h.state)) continue;
    const cue = cueFor(h);
    if (cue) cues.push(cue);
  }
  return cues;
}

const actorKey = (c: VisualCue): string => {
  if (c.kind === 'walk') return c.actor;
  return c.at.kind === 'instance' ? c.at.instanceId : `zone:${c.at.role}`;
};

/** Appends cues (oldest first), keeps at most `maxPerActor` per actor and the total walk time within budget. */
export function enqueue(queue: readonly VisualCue[], cues: readonly VisualCue[], limits: VisualLimits): VisualCue[] {
  let out = [...queue, ...cues];
  const perActor = new Map<string, number>();
  for (const c of out) perActor.set(actorKey(c), (perActor.get(actorKey(c)) ?? 0) + 1);
  out = out.filter(c => {
    const k = actorKey(c);
    const left = perActor.get(k) ?? 0;
    if (left <= limits.maxPerActor) return true;
    perActor.set(k, left - 1); // drop the oldest of this actor
    return false;
  });
  let walks = out.filter(c => c.kind === 'walk').length;
  return out.filter(c => {
    if (c.kind === 'walk' && walks * limits.walkMs > limits.maxTravelMs) { walks--; return false; }
    return true;
  });
}

/** After a hidden tab only the latest model matters: discard every pending cue. */
export function dropBacklog(_queue: readonly VisualCue[]): VisualCue[] {
  return [];
}
