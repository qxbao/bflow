import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CLIP_FRAMES, Choreographer, WALK_LIMITS, clipFor, frameName, type Clip } from '../src/features/office/scene/actors';
import { GRID_H, GRID_W, routeBetween, seatCell } from '../src/features/office/scene/layers';
import type { VisualCue } from '../src/features/office/model/timeline';
import type { OfficeModel, OfficePose } from '../src/features/office/model/types';

const atlas = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/office/atlas.json'), 'utf8')) as { frames: Record<string, { frame: { w: number; h: number } }> };
const model: OfficeModel = {
  tier: 'full', certainty: 'confirmed', statusText: '', pendingDecisions: 0, connection: 'connected', handoffs: [], tasks: [],
  agents: [
    { instanceId: 'a', label: 'A', role: 'coordinator', pose: 'sleeping', certainty: 'inferred', statusText: '', seat: 'coordination:coordinator' },
    { instanceId: 'b', label: 'B', role: 'developer', pose: 'sleeping', certainty: 'inferred', statusText: '', seat: 'developer:1' },
  ],
};
const walk = (id: string): VisualCue => ({ kind: 'walk', handoffId: id, actor: 'a', from: { kind: 'instance', instanceId: 'a' }, to: { kind: 'instance', instanceId: 'b' } });

describe('clips and atlas', () => {
  test('every clip frame of every role exists at 32x48 in the atlas', () => {
    const roles = ['conversation', 'coordinator', 'planner', 'architect', 'specifier', 'reviewer', 'qa', 'tester', 'security', 'developer'];
    for (const role of roles) for (const [clip, n] of Object.entries(CLIP_FRAMES) as [Clip, number][]) for (let i = 0; i < n; i++) {
      expect(atlas.frames[frameName(role, clip, i)]?.frame, frameName(role, clip, i)).toMatchObject({ w: 32, h: 48 });
    }
    expect(Object.keys(atlas.frames)).toEqual(expect.arrayContaining(['bubble_waiting', 'bubble_question', 'bubble_blocked']));
  });
  test('every pose maps to a clip and none is a success animation', () => {
    const poses: OfficePose[] = ['disconnected', 'question', 'hand_raised', 'working', 'typing', 'preparing', 'sleeping', 'ghost'];
    for (const p of poses) expect(Object.keys(CLIP_FRAMES)).toContain(clipFor(p));
    expect(clipFor('sleeping')).toBe('sleep');
    expect(clipFor('typing')).toBe('type_fast');
  });
});

describe('routes', () => {
  test('route between seats is 4-connected, walkable and bounded', () => {
    const route = routeBetween(seatCell('coordination:coordinator')!, seatCell('developer:1')!);
    expect(route.length).toBeGreaterThan(2);
    for (let i = 1; i < route.length; i++) expect(Math.abs(route[i]!.gx - route[i - 1]!.gx) + Math.abs(route[i]!.gy - route[i - 1]!.gy)).toBe(1);
    for (const c of route) { expect(c.gx).toBeGreaterThanOrEqual(0); expect(c.gx).toBeLessThan(GRID_W); expect(c.gy).toBeLessThan(GRID_H); }
  });
});

describe('Choreographer', () => {
  test('actors stay put without cues: no wandering', () => {
    const c = new Choreographer();
    c.apply(model, []);
    const before = c.views().map(v => v.point);
    for (let i = 0; i < 100; i++) expect(c.tick(100).moving).toBe(false);
    expect(c.views().map(v => v.point)).toEqual(before);
  });
  test('a walk cue moves the sender and returns it home within the budget', () => {
    const c = new Choreographer();
    c.apply(model, [walk('h1')]);
    const home = c.views().find(v => v.instanceId === 'a')!.point;
    expect(c.tick(16).moving).toBe(true);
    c.tick(WALK_LIMITS.walkMs / 4);
    const mid = c.views().find(v => v.instanceId === 'a')!;
    expect(mid.walking).toBe(true);
    expect(mid.clip).toBe('carry');
    expect(mid.point).not.toEqual(home);
    c.tick(WALK_LIMITS.walkMs);
    const done = c.views().find(v => v.instanceId === 'a')!;
    expect(done.walking).toBe(false);
    expect(done.point).toEqual(home);
    expect(done.clip).toBe('sleep');
  });
  test('pause drops the backlog and walkers, and nothing replays', () => {
    const c = new Choreographer();
    c.apply(model, [walk('h1'), walk('h2')]);
    c.tick(50);
    c.pause();
    expect(c.views().every(v => !v.walking)).toBe(true);
    expect(c.tick(50).moving).toBe(false);
  });
  test('reduced frames stay on frame 0', () => {
    const c = new Choreographer(false);
    c.apply(model, []);
    c.tick(1000);
    expect(c.views().every(v => v.frame === 0)).toBe(true);
  });
  test('a pose change is immediate', () => {
    const c = new Choreographer();
    c.apply(model, []);
    c.apply({ ...model, agents: model.agents.map(a => ({ ...a, pose: 'hand_raised' })) }, []);
    expect(c.views().every(v => v.clip === 'raise_hand')).toBe(true);
  });
});
