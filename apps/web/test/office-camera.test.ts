import { describe, expect, test } from 'vitest';
import { CameraMove, FOCUS_MS, HOME_ZOOM, homeCamera, FOCUS_ZOOM, KEY_ZOOM, MAX_ZOOM, MIN_ZOOM, cameraKey, cameraPose, clampCamera, easeCamera, fitCamera, fitDistance, focusOn, panByPixels, pinchFactor, wheelFactor, zoomBy } from '../src/features/office/scene/camera';
import { ZONE_TITLES, contentBox, BOARD_X, DEVELOPER_SEAT_COUNT, FOCUS_POINTS, GRID_H, GRID_W, OBJECT_CELLS, PLANT_CELLS, TABLE_CELLS, WORLD, cellCentre, deskPlan, developerRowsFor, routeBetween, seatCell, zoneAt, zones } from '../src/features/office/scene/world';
import { DEVELOPER_SEATS, applySeats } from '../src/features/office/model/seats';
import type { OfficeModel } from '../src/features/office/model/types';

const view = { w: 1600, h: 900 };

describe('camera', () => {
  test('fit centres the office at the widest zoom and fits both axes for any aspect', () => {
    const cam = fitCamera(WORLD);
    expect(cam).toEqual({ x: GRID_W / 2, z: GRID_H / 2, zoom: MIN_ZOOM });
    const home = homeCamera(WORLD);
    expect(home.zoom).toBe(HOME_ZOOM);
    expect(home.zoom).toBeGreaterThanOrEqual(MIN_ZOOM); // the default view frames the drawn content (see contentBox), not the whole grid
    for (const v of [{ w: 1600, h: 900 }, { w: 390, h: 700 }, { w: 900, h: 900 }]) {
      const pose = cameraPose(cam, v, WORLD);
      expect(pose.position[1]).toBeGreaterThan(0);
      expect(pose.position[2]).toBeGreaterThan(pose.target[2]);
      expect(fitDistance(v, WORLD)).toBeGreaterThan(0);
    }
    // A narrower view needs a farther camera.
    expect(fitDistance({ w: 390, h: 700 }, WORLD)).toBeGreaterThan(fitDistance(view, WORLD));
  });
  test('zoom is continuous, bounded and never moves the target at the widest zoom', () => {
    let cam = fitCamera(WORLD);
    cam = zoomBy(cam, 1.37, WORLD);
    expect(cam.zoom).toBeCloseTo(1.37, 6);
    for (let i = 0; i < 20; i++) cam = zoomBy(cam, KEY_ZOOM, WORLD);
    expect(cam.zoom).toBe(MAX_ZOOM);
    for (let i = 0; i < 40; i++) cam = zoomBy(cam, 1 / KEY_ZOOM, WORLD);
    expect(cam.zoom).toBe(MIN_ZOOM);
    expect({ x: cam.x, z: cam.z }).toEqual({ x: GRID_W / 2, z: GRID_H / 2 });
    expect(clampCamera({ x: 0, z: 0, zoom: Number.NaN }, WORLD).zoom).toBe(MIN_ZOOM);
    expect(zoomBy(cam, -1, WORLD)).toBe(cam);
  });
  test('pan keeps the target inside the office plus a small slack, and moves the scene with the pointer', () => {
    const zoomed = { x: 14, z: 10, zoom: 3 };
    const right = panByPixels(zoomed, 100, 0, view, WORLD);
    expect(right.x).toBeLessThan(zoomed.x); // dragging right shows what is to the left
    const far = panByPixels(zoomed, -1e6, 1e6, view, WORLD);
    expect(far.x).toBeLessThanOrEqual(GRID_W + 2);
    expect(far.z).toBeGreaterThanOrEqual(-2);
    // Nothing to pan at the widest zoom.
    expect(panByPixels(fitCamera(WORLD), 500, 500, view, WORLD)).toEqual(fitCamera(WORLD));
  });
  test('keys follow section 5.4 and ignore everything else', () => {
    expect(cameraKey('ArrowLeft')).toMatchObject({ kind: 'pan', dy: 0 });
    expect(cameraKey('+')).toEqual({ kind: 'zoom', factor: KEY_ZOOM });
    expect(cameraKey('-')).toEqual({ kind: 'zoom', factor: 1 / KEY_ZOOM });
    expect(cameraKey('0')).toEqual({ kind: 'fit' });
    expect(cameraKey('Enter')).toBeUndefined();
  });
  test('wheel and pinch give smooth bounded factors', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
    expect(wheelFactor(-1e9)).toBeCloseTo(wheelFactor(-240), 9);
    expect(pinchFactor(100, 150)).toBeCloseTo(1.5);
    expect(pinchFactor(100, 5000)).toBe(2);
    expect(pinchFactor(0, 100)).toBe(1);
    expect(pinchFactor(100, 0)).toBe(1);
  });
});

describe('focus', () => {
  test('focusOn frames the target at the selection zoom, clamped to the office', () => {
    const c = focusOn(cellCentre({ gx: 13, gy: 3 }), WORLD);
    expect(c.zoom).toBe(FOCUS_ZOOM);
    expect(c.x).toBeCloseTo(13.5, 5);
    const edge = focusOn({ x: -50, z: 500 }, WORLD);
    expect(edge.x).toBeGreaterThanOrEqual(-2);
    expect(edge.z).toBeLessThanOrEqual(GRID_H + 2);
  });
  test('the eased move starts and ends exactly, and moves monotonically', () => {
    const from = fitCamera(WORLD), to = focusOn({ x: 20, z: 4 }, WORLD);
    expect(easeCamera(from, to, 0)).toEqual(from);
    expect(easeCamera(from, to, 1).x).toBeCloseTo(to.x, 9);
    let last = from.x;
    for (let t = 0.1; t <= 1; t += 0.1) { const x = easeCamera(from, to, t).x; expect(x).toBeGreaterThanOrEqual(last); last = x; }
    const move = new CameraMove(from, to, 1000, false);
    expect(move.at(1000 + FOCUS_MS / 2).done).toBe(false);
    expect(move.at(1000 + FOCUS_MS).done).toBe(true);
  });
  test('reduced motion jumps at once', () => {
    const to = focusOn({ x: 20, z: 4 }, WORLD);
    expect(new CameraMove(fitCamera(WORLD), to, 0, true).at(0)).toEqual({ camera: to, done: true });
  });
});

describe('layout', () => {
  test('every seat the assignment can produce has a cell inside the grid, and no two seats share one', () => {
    const seats = [...DEVELOPER_SEATS, 'conversation:conversation', 'coordination:coordinator', 'coordination:planner', 'coordination:architect', 'coordination:specifier',
      'verification:reviewer', 'verification:qa', 'verification:tester', 'verification:security', 'verification:reviewer:2', 'verification:qa:2', 'verification:tester:2', 'verification:security:2',
      'conversation:conversation:2', 'conversation:conversation:3', 'coordination:coordinator:2', 'coordination:planner:2', 'coordination:architect:2', 'coordination:specifier:2'];
    const keys = seats.map(seat => {
      const c = seatCell(seat);
      expect(c, seat).toBeDefined();
      expect(c!.gx >= 0 && c!.gx < GRID_W && c!.gy >= 0 && c!.gy < GRID_H, seat).toBe(true);
      return `${c!.gx},${c!.gy}`;
    });
    expect(new Set(keys).size).toBe(keys.length);
    expect(seatCell('developer:21')).toBeUndefined();
    // Beyond the spare seats of a role there is no cell (the instance is not drawn).
    expect(seatCell('verification:reviewer:3')).toBeUndefined();
    expect(seatCell('conversation:conversation:4')).toBeUndefined();
    expect(seatCell('annex:1')).toBeUndefined();
    expect(seatCell('nonsense')).toBeUndefined();
  });
  test('20 developer seats, rows of seven, and the zone grows with the count (occupied rows plus the next free one)', () => {
    expect(DEVELOPER_SEATS).toHaveLength(20);
    expect(developerRowsFor(0)).toBe(1);
    expect(developerRowsFor(1)).toBe(2);
    expect(developerRowsFor(7)).toBe(2);
    expect(developerRowsFor(8)).toBe(3);
    expect(developerRowsFor(20)).toBe(3);
    expect(developerRowsFor(99)).toBe(3);
    expect(DEVELOPER_SEAT_COUNT).toBe(20);
    const area = (rows: number): number => { const z = zones(rows).find(q => q.id === 'developer')!; return (z.x1 - z.x0) * (z.y1 - z.y0); };
    expect(area(2)).toBeGreaterThan(area(1));
    for (let n = 1; n <= 20; n++) { const c = seatCell(`developer:${n}`)!; expect(zoneAt(c, developerRowsFor(n)), `developer:${n}`).toBe('developer'); }
    // Few developers: the zone and its desks stay small, so the office does not look empty or sprawling.
    expect(deskPlan(['developer:1', 'developer:2', 'developer:3']).desks.filter(c => c.gy >= 10 && c.gx < 17)).toHaveLength(14);
    expect(deskPlan([]).desks.filter(c => c.gy >= 10 && c.gx < 17)).toHaveLength(7);
  });
  test('rooms follow the reference layout: back row above the front row, QA/Reviewer at the right', () => {
    const z = (id: string) => zones(4).find(q => q.id === id)!;
    // Back row: Conversation, Coordination, Task Board (the board hangs above its own zone, at the right).
    expect(z('conversation').x1).toBeLessThan(z('coordination').x0);
    expect(z('coordination').x1).toBeLessThan(z('taskboard').x0);
    expect(z('developer').y0).toBeGreaterThan(z('coordination').y1);
    expect(zoneAt({ gx: Math.round(BOARD_X - 0.5), gy: 1 })).toBe('taskboard');
    expect(z('verification').x0).toBeGreaterThan(z('developer').x1);
    for (const seat of ['coordination:coordinator', 'coordination:planner', 'coordination:architect', 'coordination:specifier']) expect(zoneAt(seatCell(seat)!)).toBe('coordination');
    for (const seat of ['verification:reviewer', 'verification:qa', 'verification:tester', 'verification:security']) expect(zoneAt(seatCell(seat)!)).toBe('verification');
    expect(zoneAt(seatCell('conversation:conversation')!)).toBe('conversation');
    expect(zoneAt({ gx: OBJECT_CELLS.board.gx, gy: 1 })).toBe('taskboard');
  });
  test('the mailbox and cabinet stand against walls, away from the board', () => {
    expect(OBJECT_CELLS.mailbox.gx).toBe(0);
    expect(OBJECT_CELLS.cabinet.gy).toBe(0);
    expect(OBJECT_CELLS.server.gy).toBe(0);
    // The board (8.4 wide) spans the Task Board zone; no wall object stands in front of it.
    const board = { x0: BOARD_X - 4.2, x1: BOARD_X + 4.2 };
    for (const o of [OBJECT_CELLS.cabinet, OBJECT_CELLS.server]) expect(o.gx + 0.5 < board.x0 || o.gx + 0.5 > board.x1, `${o.gx}`).toBe(true);
  });
  test('HUD camera presets point inside the world and at the right room', () => {
    for (const [zone, f] of Object.entries(FOCUS_POINTS)) {
      expect(f.at.x > 0 && f.at.x < WORLD.w && f.at.z > 0 && f.at.z < WORLD.d, zone).toBe(true);
      expect(f.zoom).toBeGreaterThan(1);
    }
    expect(zoneAt({ gx: Math.floor(FOCUS_POINTS.conversation.at.x), gy: Math.floor(FOCUS_POINTS.conversation.at.z) })).toBe('conversation');
    expect(zoneAt({ gx: Math.floor(FOCUS_POINTS.coordinator.at.x), gy: Math.floor(FOCUS_POINTS.coordinator.at.z) })).toBe('coordination');
    expect(zoneAt({ gx: Math.floor(FOCUS_POINTS.developer.at.x), gy: Math.floor(FOCUS_POINTS.developer.at.z) })).toBe('developer');
    expect(zoneAt({ gx: Math.floor(FOCUS_POINTS.qa.at.x), gy: Math.floor(FOCUS_POINTS.qa.at.z) })).toBe('verification');
  });
  test('only Coordinator and QA anchor desks are drawn without agents; others appear with their agent', () => {
    const keys = (seats: string[]) => deskPlan(seats).desks.filter(c => c.gy < 9 || c.gx >= 19).map(c => `${c.gx},${c.gy}`);
    expect(keys([]).sort()).toEqual([`${seatCell('coordination:coordinator')!.gx},3`, `${seatCell('verification:qa')!.gx},10`].sort());
    expect(keys(['coordination:planner'])).toContain(`${seatCell('coordination:planner')!.gx},3`);
  });
  test('content framing follows the drawn desks, so few agents leave no empty foreground, and the camera clamps to it', () => {
    const few = contentBox(deskPlan([]).desks), many = contentBox(deskPlan(DEVELOPER_SEATS).desks);
    expect(few.d).toBeLessThan(many.d);
    expect(few.cz).toBeLessThan(many.cz);
    expect(few.cz + few.d / 2).toBeLessThanOrEqual(GRID_H);
    // The home camera sits on the content centre and stays inside it.
    expect(homeCamera(few)).toMatchObject({ x: few.cx, z: few.cz });
    const far = clampCamera({ x: 0, z: 99, zoom: 2 }, few);
    expect(far.z).toBeLessThanOrEqual(few.cz + (few.d / 2 + 1.5));
    expect(ZONE_TITLES.map(z => z.text)).toEqual(['Conversation', 'Coordinator', 'Task Board', 'Developer Zone', 'QA / Reviewer']);
  });
  test('objects, desks and plants do not collide and stay inside the world', () => {
    const everyDesk = deskPlan([...Array.from({ length: 20 }, (_, i) => `developer:${i + 1}`), 'verification:reviewer:2', 'verification:qa:2', 'verification:tester:2', 'verification:security:2', 'coordination:coordinator:2', 'coordination:planner:2', 'coordination:architect:2', 'coordination:specifier:2', 'conversation:conversation:2', 'conversation:conversation:3']).desks;
    const cells = [...Object.values(OBJECT_CELLS).filter(c => c !== OBJECT_CELLS.counter), ...everyDesk, ...PLANT_CELLS, ...TABLE_CELLS].map(c => `${c.gx},${c.gy}`);
    expect(new Set(cells).size).toBe(cells.length);
    expect(OBJECT_CELLS.counter).toEqual(seatCell('conversation:conversation'));
    for (const c of [...Object.values(OBJECT_CELLS), ...everyDesk, ...PLANT_CELLS]) {
      const p = cellCentre(c);
      expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(WORLD.w); expect(p.z).toBeGreaterThan(0); expect(p.z).toBeLessThan(WORLD.d);
    }
  });
  test('every occupied seat has a drawn desk (or the counter) and can reach the rest of the office', () => {
    const occupied = [...DEVELOPER_SEATS, 'conversation:conversation', 'conversation:conversation:2', 'conversation:conversation:3', 'coordination:planner', 'coordination:coordinator', 'coordination:architect', 'coordination:specifier', 'coordination:planner:2',
      'verification:reviewer', 'verification:qa', 'verification:tester', 'verification:security', 'verification:reviewer:2', 'verification:qa:2', 'verification:tester:2', 'verification:security:2'];
    const plan = deskPlan(occupied);
    const drawn = new Set(plan.desks.map(c => `${c.gx},${c.gy}`));
    const counter = OBJECT_CELLS.counter;
    for (const seat of occupied) {
      const c = seatCell(seat)!;
      expect(c, seat).toBeDefined();
      if (seat !== 'conversation:conversation') expect(drawn.has(`${c.gx},${c.gy}`), `${seat} has a desk`).toBe(true);
      expect(routeBetween(c, counter, plan.desks).length, `${seat} is reachable`).toBeGreaterThanOrEqual(1);
    }
    // A drawn desk blocks passers-by (they walk around it); the endpoints stay open.
    const a = seatCell('developer:1')!, b = seatCell('developer:3')!; // same row, desk between them
    const around = routeBetween(a, b, plan.desks);
    expect(around.some(c => c.gx === 5 && c.gy === 10)).toBe(false);
  });
  test('unused developer rows have no desks and do not block a path', () => {
    const plan = deskPlan(['developer:1']);
    expect(plan.developerRows).toBe(2);
    const third = plan.desks.filter(c => c.gy === 16 && c.gx < 17);
    expect(third).toHaveLength(0);
    const straight = routeBetween({ gx: 3, gy: 16 }, { gx: 15, gy: 16 }, plan.desks);
    expect(straight).toHaveLength(13); // a straight line through where the desks would be
    // With a full office the same trip must go around the desks.
    expect(routeBetween({ gx: 3, gy: 16 }, { gx: 15, gy: 16 }, deskPlan(DEVELOPER_SEATS).desks).length).toBeGreaterThan(13);
  });
  test('applySeats fills seats without mutating the model', () => {
    const model = { tier: 'degraded', certainty: 'unknown', statusText: '', agents: [{ instanceId: 'a', label: 'a', role: 'developer', pose: 'sleeping', certainty: 'unknown', statusText: '' }], tasks: [], pendingDecisions: 0, handoffs: [], connection: 'connected' } as OfficeModel;
    const out = applySeats({ entries: [], overflow: 0 }, model);
    expect(out.model.agents[0]!.seat).toBe('developer:1');
    expect(model.agents[0]!.seat).toBeUndefined();
  });
});
