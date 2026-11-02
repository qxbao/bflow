import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CLIPS, Choreographer, SEAT_OFFSET_Z, WALK_LIMITS, clipFor } from '../src/features/office/scene/actors';
import { GRID_H, GRID_W, cellCentre, routeBetween, seatCell } from '../src/features/office/scene/world';
import type { VisualCue } from '../src/features/office/model/timeline';
import type { OfficeModel, OfficePose } from '../src/features/office/model/types';

const model: OfficeModel = {
  tier: 'full', certainty: 'confirmed', statusText: '', pendingDecisions: 0, connection: 'connected', handoffs: [], tasks: [],
  agents: [
    { instanceId: 'a', label: 'A', role: 'coordinator', pose: 'sleeping', certainty: 'inferred', statusText: '', seat: 'coordination:coordinator' },
    { instanceId: 'b', label: 'B', role: 'developer', pose: 'sleeping', certainty: 'inferred', statusText: '', seat: 'developer:1' },
  ],
};
const walk = (id: string): VisualCue => ({ kind: 'walk', handoffId: id, actor: 'a', from: { kind: 'instance', instanceId: 'a' }, to: { kind: 'instance', instanceId: 'b' } });

interface Glb { nodes: { name: string }[]; materials: { name: string }[]; animations: { name: string; channels: { target: { node: number } }[] }[]; images?: unknown[]; textures?: unknown[] }
/** Reads the JSON chunk of a GLB: the models are the contract between the generator and the scene code. */
const readGlb = (file: string): Glb => {
  const buf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/office', file));
  expect(buf.toString('ascii', 0, 4)).toBe('glTF');
  expect(buf.readUInt32LE(8)).toBe(buf.length);
  const length = buf.readUInt32LE(12);
  return JSON.parse(buf.toString('utf8', 20, 20 + length)) as Glb;
};

describe('models', () => {
  test('character.glb has the rig nodes, the role-colour material and exactly the nine clips, and no embedded images', () => {
    const glb = readGlb('character.glb');
    const names = glb.nodes.map(n => n.name);
    for (const n of ['character', 'hips', 'torso', 'head', 'arm_l', 'arm_r', 'thigh_l', 'thigh_r', 'shin_l', 'shin_r', 'paper']) expect(names).toContain(n);
    expect(glb.materials.map(m => m.name)).toEqual(expect.arrayContaining(['outfit', 'skin', 'hair', 'tag']));
    expect(glb.animations.map(a => a.name).sort()).toEqual([...CLIPS].sort());
    expect(glb.images ?? []).toEqual([]);
    expect(glb.textures ?? []).toEqual([]);
    // Every clip drives the same nodes, so a cross-fade never leaves a stale pose.
    const driven = (a: Glb['animations'][number]): string => [...new Set(a.channels.map(c => glb.nodes[c.target.node]!.name))].sort().join();
    expect(new Set(glb.animations.map(driven)).size).toBe(1);
  });
  test('furniture.glb carries every node the scene instantiates and no images', () => {
    const glb = readGlb('furniture.glb');
    const names = glb.nodes.map(n => n.name);
    for (const n of ['floor_tile', 'wall', 'wall_led', 'spot', 'trim_bar', 'desk', 'chair', 'counter', 'board', 'server', 'cabinet', 'mailbox', 'settings', 'door', 'plant']) expect(names).toContain(n);
    expect(glb.images ?? []).toEqual([]);
  });
});

describe('poses', () => {
  test('every pose maps to a clip and none is a success animation', () => {
    const poses: OfficePose[] = ['disconnected', 'question', 'hand_raised', 'working', 'typing', 'preparing', 'sleeping', 'ghost'];
    for (const p of poses) expect(CLIPS).toContain(clipFor(p));
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
    expect(before.map(p => p.z)).toEqual(before.map((_, i) => cellCentre(seatCell(model.agents[i]!.seat!)!).z + SEAT_OFFSET_Z));
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
    expect(done.heading).toBe(Math.PI);
  });
  test('pause drops the backlog and walkers, and nothing replays', () => {
    const c = new Choreographer();
    c.apply(model, [walk('h1'), walk('h2')]);
    c.tick(50);
    c.pause();
    expect(c.views().every(v => !v.walking)).toBe(true);
    expect(c.tick(50).moving).toBe(false);
  });
  test('an actor that vanishes mid-walk drops its queued cues', () => {
    const c = new Choreographer(false);
    c.apply(model, [walk('h1'), walk('h2')]);
    c.tick(100);
    const without = { ...model, agents: model.agents.filter(a => a.instanceId !== 'a') };
    c.apply(without, []);
    expect(c.views().map(v => v.instanceId)).toEqual(['b']);
    expect(c.busy()).toBe(false); // trip and queued cues are gone (frames frozen, so nothing else keeps it busy)
    c.apply(model, []); // the actor returns: nothing replays
    expect(c.views().every(v => !v.walking)).toBe(true);
    expect(c.tick(100).moving).toBe(false);
  });
  test('apply reports the walk cues it took', () => {
    expect(new Choreographer().apply(model, [walk('h1')])).toEqual(['h1']);
  });
  test('under reduced motion nothing is busy at idle, and a cue wakes it', () => {
    const c = new Choreographer(false);
    c.apply(model, []);
    expect(c.busy()).toBe(false);
    expect(c.tick(1000)).toEqual({ moving: false, changed: false });
    c.apply(model, [walk('h1')]);
    expect(c.busy()).toBe(true);
  });
  test('a walker carries a document out and walks back empty-handed, facing its direction', () => {
    const c = new Choreographer();
    c.apply(model, [walk('h1')]);
    c.tick(16);
    c.tick(WALK_LIMITS.walkMs / 4);
    const out = c.views().find(v => v.instanceId === 'a')!;
    expect(out.carrying).toBe(true);
    expect(Number.isFinite(out.heading)).toBe(true);
    c.tick(WALK_LIMITS.walkMs / 2);
    expect(c.views().find(v => v.instanceId === 'a')!.carrying).toBe(false);
  });
  test('a pose change is immediate', () => {
    const c = new Choreographer();
    c.apply(model, []);
    c.apply({ ...model, agents: model.agents.map(a => ({ ...a, pose: 'hand_raised' })) }, []);
    expect(c.views().every(v => v.clip === 'raise_hand')).toBe(true);
  });
});
