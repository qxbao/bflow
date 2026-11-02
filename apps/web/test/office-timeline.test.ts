import { describe, expect, test } from 'vitest';
import { diffVisual, dropBacklog, enqueue, type VisualCue, type VisualLimits } from '../src/features/office/model/timeline';
import { findPath, type Grid } from '../src/features/office/model/path';
import type { OfficeHandoff, OfficeModel } from '../src/features/office/model/types';

const handoff = (handoffId: string, state: OfficeHandoff['state'], over: Partial<OfficeHandoff> = {}): OfficeHandoff => ({
  handoffId, ordinal: 1, direction: 'outbound', state, fromInstanceId: 'dev-1', toInstanceId: 'rev-1', fromRole: 'developer', toRole: 'reviewer', ...over,
});
const model = (handoffs: OfficeHandoff[]): OfficeModel => ({
  tier: 'full', certainty: 'confirmed', statusText: '', agents: [], tasks: [], pendingDecisions: 0, handoffs, connection: 'connected',
});
const limits: VisualLimits = { maxPerActor: 2, maxTravelMs: 2500, walkMs: 1000 };
const walk = (handoffId: string, instanceId = 'dev-1'): VisualCue => ({
  kind: 'walk', handoffId, actor: instanceId, from: { kind: 'instance', instanceId }, to: { kind: 'instance', instanceId: 'rev-1' },
});

describe('diffVisual', () => {
  test('first snapshot produces no cues', () => {
    expect(diffVisual(undefined, model([handoff('h1', 'accepted'), handoff('h2', 'queued')]))).toEqual([]);
  });

  test('reset produces no replay', () => {
    // The caller expresses a reset by passing undefined as the baseline again.
    const next = model([handoff('h1', 'delivered')]);
    expect(diffVisual(undefined, next)).toEqual([]);
    expect(diffVisual(next, next)).toEqual([]);
  });

  test('only confirmed handoff states produce walk cues', () => {
    const walking = ['accepted', 'delivered', 'released', 'applied'] as const;
    const idle = ['queued', 'sending', 'unknown_delivery', 'rejected', 'failed', 'cancelled'] as const;
    for (const s of walking) {
      const cues = diffVisual(model([]), model([handoff('h', s)]));
      expect(cues.map(c => c.kind), s).toEqual(['walk']);
    }
    const expected: Record<string, string[]> = {
      queued: ['waiting'], sending: ['waiting'], unknown_delivery: ['question'], rejected: ['blocked'], failed: ['blocked'], cancelled: [],
    };
    for (const s of idle) {
      const cues = diffVisual(model([]), model([handoff('h', s)]));
      expect(cues.map(c => c.kind), s).toEqual(expected[s]);
    }
  });

  test('walk cue carries actor and endpoints; role zone when no instance', () => {
    const [c] = diffVisual(model([]), model([handoff('h', 'accepted', { toInstanceId: undefined, toRole: 'conversation' })]));
    expect(c).toEqual({ kind: 'walk', handoffId: 'h', actor: 'dev-1', from: { kind: 'instance', instanceId: 'dev-1' }, to: { kind: 'zone', role: 'conversation' } });
  });

  test('same handoffId never cues twice', () => {
    const queued = model([handoff('h', 'queued')]);
    const accepted = model([handoff('h', 'accepted')]);
    const delivered = model([handoff('h', 'delivered')]);
    // queued -> accepted: exactly one walk.
    expect(diffVisual(queued, accepted).filter(c => c.kind === 'walk')).toHaveLength(1);
    // The repeat (same model again) and a walk -> walk progression cue nothing.
    expect(diffVisual(accepted, accepted)).toEqual([]);
    expect(diffVisual(accepted, delivered)).toEqual([]);
    // A handoff already present as non-walk does not re-cue its waiting bubble.
    expect(diffVisual(queued, model([handoff('h', 'sending')]))).toEqual([]);
  });
});

describe('enqueue', () => {
  test('queue keeps at most two cues per actor', () => {
    const q = enqueue([], [walk('a'), walk('b'), walk('c'), walk('x', 'dev-2')], { ...limits, maxTravelMs: 100000 });
    expect(q.filter(c => c.kind === 'walk' && c.actor === 'dev-1').map(c => c.handoffId)).toEqual(['b', 'c']);
    expect(q.map(c => c.handoffId)).toContain('x');
  });

  test('total travel is capped, dropping the oldest walks', () => {
    const q = enqueue([], [walk('a', 'd1'), walk('b', 'd2'), walk('c', 'd3')], limits);
    expect(q.map(c => c.handoffId)).toEqual(['b', 'c']);
  });

  test('is pure', () => {
    const base: VisualCue[] = [walk('a')];
    const out = enqueue(base, [walk('b')], limits);
    expect(base).toHaveLength(1);
    expect(out).not.toBe(base);
  });

  test('timeline drops backlog after hidden tab', () => {
    const latest = model([handoff('h3', 'delivered')]);
    const frozen = JSON.stringify(latest);
    const backlog = enqueue([], [walk('h1'), walk('h2', 'dev-2')], limits);
    expect(backlog.length).toBeGreaterThan(0);
    expect(dropBacklog(backlog)).toEqual([]);
    expect(backlog.length).toBeGreaterThan(0);
    // The latest model is untouched and applied as-is: nothing flows back from cues.
    expect(JSON.stringify(latest)).toBe(frozen);
  });
});

describe('findPath', () => {
  const open = (w: number, h: number): Grid => Array.from({ length: h }, () => Array<boolean>(w).fill(true));

  test('straight path includes both endpoints', () => {
    expect(findPath(open(4, 1), { x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
  });

  test('routes around walls, is 4-directional and deterministic', () => {
    const g = open(3, 3);
    g[1][1] = false;
    const p = findPath(g, { x: 0, y: 0 }, { x: 2, y: 2 });
    expect(p).toHaveLength(5);
    for (let i = 1; i < p.length; i++) expect(Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y)).toBe(1);
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 2 })).toEqual(p);
  });

  test('from equals to yields the single cell', () => {
    expect(findPath(open(2, 2), { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([{ x: 1, y: 1 }]);
  });

  test('unreachable target yields empty path', () => {
    const g = open(3, 1);
    g[0][1] = false;
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 })).toEqual([]);
    expect(findPath(open(2, 2), { x: 0, y: 0 }, { x: 5, y: 5 })).toEqual([]);
    const blocked = open(2, 2);
    blocked[1][1] = false;
    expect(findPath(blocked, { x: 0, y: 0 }, { x: 1, y: 1 })).toEqual([]);
  });
});
