import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ACTIVITY_CLIP, BARTENDER_ID, BAR_STAY, CLIPS, Choreographer, SEAT_OFFSET_Z, STAY, WALK_LIMITS, clipFor, seatRole } from '../src/features/office/scene/actors';
import { BAR_POINTS, GRID_H, GRID_W, LOUNGE_SPOTS, OBJECT_CELLS, cellCentre, deskPlan, routeBetween, seatCell } from '../src/features/office/scene/world';
import type { VisualCue } from '../src/features/office/model/timeline';
import type { OfficeModel, OfficePose } from '../src/features/office/model/types';

const model: OfficeModel = {
  tier: 'full', certainty: 'confirmed', statusText: '', pendingDecisions: 0, connection: 'connected', handoffs: [], tasks: [],
  agents: [
    { instanceId: 'a', label: 'A', role: 'coordinator', pose: 'working', certainty: 'confirmed', statusText: '', seat: 'coordination:coordinator' },
    { instanceId: 'b', label: 'B', role: 'developer', pose: 'working', certainty: 'confirmed', statusText: '', seat: 'developer:1' },
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
  test('character.glb has the rig nodes, the role-colour material and exactly the twelve clips, and no embedded images', () => {
    const glb = readGlb('character.glb');
    const names = glb.nodes.map(n => n.name);
    for (const n of ['character', 'hips', 'torso', 'head', 'arm_l', 'arm_r', 'thigh_l', 'thigh_r', 'shin_l', 'shin_r', 'paper', 'hoodie', 'suit']) expect(names).toContain(n);
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
    for (const n of ['floor_tile', 'wall', 'wall_led', 'spot', 'trim_bar', 'desk', 'chair', 'chair_black', 'stool_red', 'counter', 'exec_chair', 'board', 'server', 'cabinet', 'mailbox', 'settings', 'door', 'plant']) expect(names).toContain(n);
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
    const route = routeBetween(seatCell('coordination:coordinator')!, seatCell('developer:1')!, deskPlan(['coordination:coordinator', 'developer:1']).desks);
    expect(route.length).toBeGreaterThan(2);
    for (let i = 1; i < route.length; i++) expect(Math.abs(route[i]!.gx - route[i - 1]!.gx) + Math.abs(route[i]!.gy - route[i - 1]!.gy)).toBe(1);
    for (const c of route) { expect(c.gx).toBeGreaterThanOrEqual(0); expect(c.gx).toBeLessThan(GRID_W); expect(c.gy).toBeLessThan(GRID_H); }
  });
});

describe('Choreographer', () => {
  test('working agents stay put without cues: no wandering (only the bartender and idle figures move about)', () => {
    const c = new Choreographer();
    c.apply(model, []);
    const before = c.views().map(v => v.point);
    expect(before.map(p => p.z)).toEqual(before.map((_, i) => cellCentre(seatCell(model.agents[i]!.seat!)!).z + SEAT_OFFSET_Z));
    for (let i = 0; i < 100; i++) { c.tick(100); expect(c.views().some(v => v.walking)).toBe(false); }
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
    expect(done.clip).toBe('type');
    expect(done.heading).toBe(0);
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

describe('full staff and the Creative Space', () => {
  const idle = (m: OfficeModel, id: string): OfficeModel => ({ ...m, agents: m.agents.map(a => (a.instanceId === id ? { ...a, pose: 'sleeping' } : a)) });
  const at = (c: Choreographer, id: string) => [...c.views(), ...c.ambientViews()].find(v => v.instanceId === id)!;
  /** A small deterministic random source (mulberry32). */
  const seeded = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  test('every drawn desk has one figure: its agent or an anonymous staff member, who is never an agent view', () => {
    const c = new Choreographer();
    c.apply(model, []);
    const plan = deskPlan(model.agents.map(a => a.seat!));
    expect(c.views().map(v => v.instanceId)).toEqual(['a', 'b']);
    const staff = c.ambientViews();
    expect(staff.map(v => v.instanceId).sort()).toEqual(plan.seats.filter(s => !model.agents.some(a => a.seat === s)).map(s => `staff:${s}`).sort());
    expect(staff.every(v => v.ambient && v.lounging)).toBe(true);
    expect(staff.find(v => v.instanceId === 'staff:verification:qa')!.role).toBe('qa');
    expect(seatRole('developer:7')).toBe('developer');
    expect(seatRole('coordination:planner:2')).toBe('planner');
  });
  test('without a running session there is no staff and no bartender', () => {
    const c = new Choreographer();
    c.apply({ ...model, tier: 'closed', agents: [] }, []);
    expect(c.ambientViews()).toHaveLength(0);
    expect(c.bartenderView()).toBeUndefined();
  });
  test('a bartender always works behind the bar, facing the patrons, and walks between its service points', () => {
    const c = new Choreographer(true, seeded(5));
    c.apply(model, []);
    const first = c.bartenderView()!;
    expect(first).toMatchObject({ instanceId: BARTENDER_ID, role: 'bartender', ambient: true, walking: false, heading: Math.PI });
    expect(BAR_POINTS).toContainEqual(first.point);
    expect(['play', 'stand']).toContain(first.clip);
    expect(c.tick(BAR_STAY.maxMs).moving).toBe(true);
    expect(c.bartenderView()!.walking).toBe(true);
    for (let i = 0; i < 400 && c.bartenderView()!.walking; i++) c.tick(50);
    const next = c.bartenderView()!;
    expect(BAR_POINTS).toContainEqual(next.point);
    expect(next.point).not.toEqual(first.point);
    // Under reduced motion it stays at its first service point.
    const still = new Choreographer(false, seeded(5));
    still.apply(model, []);
    const placed = still.bartenderView()!.point;
    still.tick(BAR_STAY.maxMs * 3);
    expect(still.bartenderView()!.point).toEqual(placed);
    expect(still.busy()).toBe(false);
  });
  test('staff take random, distinct leisure spots, each with its activity; the pool is among them', () => {
    const c = new Choreographer(true, seeded(7));
    c.apply({ ...model, agents: [] }, []);
    const staff = c.ambientViews(), n = deskPlan([]).desks.length;
    expect(staff).toHaveLength(n);
    expect(new Set(staff.map(v => `${v.point.x},${v.point.z}`)).size).toBe(n);
    for (const v of staff) {
      const s = LOUNGE_SPOTS.find(q => q.x === v.point.x && q.z === v.point.z);
      expect(s, `${v.point.x},${v.point.z}`).toBeDefined();
      expect(v.clip).toBe(ACTIVITY_CLIP[s!.activity]);
      expect(v.heading).toBe(s!.heading);
      expect(v.lift).toBe(s!.lift);
    }
    // The last free spot is taken whatever the random source says, and a source that always picks the end of the list sends figures swimming.
    const pool = new Choreographer(true, () => 0.999999);
    pool.apply({ ...model, agents: [] }, []);
    expect(pool.ambientViews().some(v => v.clip === 'swim')).toBe(true);
  });
  test('after its stay a lounging figure walks on to another free spot; under reduced motion it stays put', () => {
    const c = new Choreographer(true, seeded(3));
    c.apply(idle(model, 'b'), []);
    for (let i = 0; i < 400 && c.tick(50).moving; i++);
    const first = at(c, 'b').point;
    c.tick(STAY.maxMs);
    expect(at(c, 'b').walking).toBe(true);
    for (let i = 0; i < 400 && at(c, 'b').walking; i++) c.tick(50);
    const next = at(c, 'b').point;
    expect(next).not.toEqual(first);
    expect(LOUNGE_SPOTS.some(s => s.x === next.x && s.z === next.z)).toBe(true);
    const spots = [...c.views(), ...c.ambientViews()].filter(v => !v.walking).map(v => `${v.point.x},${v.point.z}`);
    expect(new Set(spots).size).toBe(spots.length);
    const still = new Choreographer(false, seeded(3));
    still.apply(idle(model, 'b'), []);
    const placed = at(still, 'b').point;
    still.tick(STAY.maxMs * 2);
    expect(at(still, 'b').point).toEqual(placed);
  });
  test('an idle agent walks to a leisure spot and back to its desk when it gets work; spots of the others stay put', () => {
    const c = new Choreographer(true, seeded(1));
    c.apply(model, []);
    const staffBefore = new Map(c.ambientViews().map(v => [v.instanceId, v.point]));
    const desk = at(c, 'b').point;
    c.apply(idle(model, 'b'), []);
    expect(at(c, 'b').walking).toBe(true);
    expect(c.tick(16).moving).toBe(true);
    for (let i = 0; i < 400 && c.tick(50).moving; i++);
    const away = at(c, 'b');
    expect(away.walking).toBe(false);
    expect(away.lounging).toBe(true);
    expect(LOUNGE_SPOTS.some(s => s.x === away.point.x && s.z === away.point.z)).toBe(true);
    for (const v of c.ambientViews()) expect(v.point).toEqual(staffBefore.get(v.instanceId));
    c.apply(model, []);
    for (let i = 0; i < 400 && c.tick(50).moving; i++);
    expect(at(c, 'b').point).toEqual(desk);
    expect(at(c, 'b').clip).toBe('type');
  });
  test('a figure that appears idle is placed at once; under reduced motion nothing walks', () => {
    const c = new Choreographer(false);
    c.apply(idle(model, 'b'), []);
    expect(at(c, 'b').lounging).toBe(true);
    expect(at(c, 'b').walking).toBe(false);
    c.apply(model, []);
    expect(at(c, 'b').walking).toBe(false);
    expect(at(c, 'b').lounging).toBe(false);
  });
  test('a staff member takes no handoff endpoint, and an idle agent drops its walk cues', () => {
    const c = new Choreographer();
    c.apply({ ...model, agents: [model.agents[0]!] }, []);
    // No developer or QA agent: the endpoint falls back to the server, never to a staff member's desk.
    expect(c.cellFor({ kind: 'role', role: 'developer' })).toEqual(OBJECT_CELLS.server);
    expect(c.cellFor({ kind: 'role', role: 'qa' })).toEqual(OBJECT_CELLS.server);
    const lazy = new Choreographer(false);
    lazy.apply(idle(model, 'a'), [walk('h1')]);
    expect(lazy.busy()).toBe(false);
  });
  test('with every desk drawn and every agent idle, everyone gets a leisure spot', () => {
    const seats = [...Array.from({ length: 20 }, (_, i) => `developer:${i + 1}`), 'coordination:planner', 'coordination:architect', 'coordination:specifier', 'coordination:coordinator',
      'verification:reviewer', 'verification:qa', 'verification:tester', 'verification:security', 'coordination:planner:2', 'coordination:specifier:2', 'verification:reviewer:2', 'verification:qa:2'];
    expect(deskPlan(seats).desks.length).toBeLessThanOrEqual(LOUNGE_SPOTS.length);
    const agents = seats.slice(0, 20).map((seat, i) => ({ instanceId: `x${i}`, label: '', role: seatRole(seat) as OfficeModel['agents'][number]['role'], pose: 'sleeping' as const, certainty: 'confirmed' as const, statusText: '', seat }));
    const c = new Choreographer(false);
    c.apply({ ...model, agents: [...agents, ...seats.slice(20).map((seat, i) => ({ ...agents[0]!, instanceId: `y${i}`, role: seatRole(seat) as OfficeModel['agents'][number]['role'], seat }))] }, []);
    expect(c.views().every(v => v.lounging)).toBe(true);
    expect(c.views()).toHaveLength(seats.length);
    expect(c.ambientViews()).toHaveLength(0);
  });

});
