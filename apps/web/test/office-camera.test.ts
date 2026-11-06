import { describe, expect, test } from 'vitest';
import { AGENT_ZOOM, CameraIntent, NO_INSET, withInset, CameraMove, FOCUS_MS, HOME_ZOOM, homeCamera, FOCUS_ZOOM, KEY_ZOOM, MAX_ZOOM, MIN_ZOOM, cameraKey, cameraPose, clampCamera, easeCamera, fitCamera, fitDistance, focusOn, panByPixels, pinchFactor, wheelFactor, zoomBy } from '../src/features/office/scene/camera';
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
    // With few agents the default view frames the drawn content (see contentBox): never wider than the whole world, and less deep. The developer
    // lines span the full width, so the gain is in depth only.
    const view = { w: 1600, h: 900 }, box = contentBox(deskPlan([]).desks), few = homeCamera(box);
    expect(box.d).toBeLessThan(WORLD.d);
    expect(fitDistance(view, box) / few.zoom).toBeLessThanOrEqual(fitDistance(view, WORLD) / fit_zoom(cam));
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
  test('reduced motion enabled during a move finishes immediately', () => {
    const to = focusOn({ x: 20, z: 4 }, WORLD), move = new CameraMove(fitCamera(WORLD), to, 100, false);
    expect(move.at(200, true)).toEqual({ camera: to, done: true });
  });
});

const fit_zoom = (c: { zoom: number }): number => c.zoom;

describe('camera intent and inset', () => {
  const box = contentBox(deskPlan([]).desks);
  test('re-homes only before the first interaction; selection and HUD focus count as interaction', () => {
    const intent = new CameraIntent();
    const moved = { x: 5, z: 4, zoom: 2 };
    expect(intent.reframe(moved, box)).toEqual(homeCamera(box));
    intent.touch(); // a selection or a HUD preset calls this
    expect(intent.interacted).toBe(true);
    expect(intent.reframe(moved, box)).toEqual(clampCamera(moved, box));
    expect(intent.reframe(moved, box)).not.toEqual(homeCamera(box));
  });
  const view = { w: 1440, h: 900 }, inset = { right: 800, bottom: 60, left: 0 };
  test('agent zoom is about 1.6 to 1.8', () => {
    expect(AGENT_ZOOM).toBeGreaterThanOrEqual(1.6);
    expect(AGENT_ZOOM).toBeLessThanOrEqual(1.8);
  });
  test('with an inset the camera looks right of and above the target so the target sits in the visible area', () => {
    const at = { x: 12, z: box.cz }; // away from the clamp edges, so only the inset moves the camera
    const plain = focusOn(at, box, AGENT_ZOOM), shifted = focusOn(at, box, AGENT_ZOOM, { view, inset });
    // Panel at the right: the camera moves right, so the target appears left of the screen centre, i.e. in the visible part.
    expect(shifted.x).toBeGreaterThan(plain.x);
    // Bottom block: the target appears higher, so the camera looks lower on the floor (larger z).
    expect(shifted.z).toBeGreaterThan(plain.z);
    expect(shifted.zoom).toBe(plain.zoom);
    // No inset keeps the old behaviour exactly.
    expect(focusOn(at, box, AGENT_ZOOM, { view, inset: NO_INSET }).x).toBeCloseTo(plain.x, 6);
  });
  test('the clamp is relaxed while an inset is active, so an edge target is still centred in the visible area', () => {
    const edge = { x: box.cx + box.w / 2 - 1, z: box.cz };
    const strict = clampCamera({ x: edge.x + 6, z: edge.z, zoom: AGENT_ZOOM }, box);
    const relaxed = focusOn(edge, box, AGENT_ZOOM, { view, inset });
    expect(relaxed.x).toBeGreaterThan(strict.x);
    expect(withInset(box, view, inset).slackX).toBeGreaterThan(0);
    expect(withInset(box, view, NO_INSET).slackX).toBe(0);
  });
});

describe('layout', () => {
  test('every seat the assignment can produce has a cell inside the grid, and no two seats share one', () => {
    const seats = [...DEVELOPER_SEATS, 'conversation:conversation', 'coordination:coordinator', 'coordination:planner', 'coordination:architect', 'coordination:specifier',
      'verification:reviewer', 'verification:qa', 'verification:tester', 'verification:security', 'verification:reviewer:2', 'verification:qa:2',
      'conversation:conversation:2', 'conversation:conversation:3', 'coordination:planner:2', 'coordination:specifier:2'];
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
    expect(seatCell('verification:tester:2')).toBeUndefined();
    expect(seatCell('coordination:architect:2')).toBeUndefined();
    expect(seatCell('conversation:conversation:4')).toBeUndefined();
    expect(seatCell('annex:1')).toBeUndefined();
    expect(seatCell('nonsense')).toBeUndefined();
  });
  test('20 developer seats, rows of four, and the zone grows with the count (occupied rows plus the next free one)', () => {
    expect(DEVELOPER_SEATS).toHaveLength(20);
    // Four rows are always furnished (with or without a session); a fifth appears once the fourth is in use.
    expect(developerRowsFor(0)).toBe(4);
    expect(developerRowsFor(1)).toBe(4);
    expect(developerRowsFor(12)).toBe(4);
    expect(developerRowsFor(13)).toBe(5);
    expect(developerRowsFor(20)).toBe(5);
    expect(developerRowsFor(99)).toBe(5);
    expect(DEVELOPER_SEAT_COUNT).toBe(20);
    const area = (rows: number): number => { const z = zones(rows).find(q => q.id === 'developer')!; return (z.x1 - z.x0) * (z.y1 - z.y0); };
    expect(area(5)).toBeGreaterThan(area(4));
    for (let n = 1; n <= 20; n++) { const c = seatCell(`developer:${n}`)!; expect(zoneAt(c, developerRowsFor(n)), `developer:${n}`).toBe('developer'); }
    // Few developers: the zone and its desks stay small, so the office does not look empty or sprawling.
    expect(deskPlan(['developer:1', 'developer:2', 'developer:3']).desks.filter(c => c.gy >= 10 && c.gx <= 8)).toHaveLength(16);
    expect(deskPlan([]).desks.filter(c => c.gy >= 10 && c.gx <= 8)).toHaveLength(16);
    expect(deskPlan(['developer:13']).desks.filter(c => c.gy >= 10 && c.gx <= 8)).toHaveLength(20);
  });
  test('developer desks stand in four evenly spaced north-south lines in the west half; the east half is the Creative Space', () => {
    const cells = DEVELOPER_SEATS.map(s => seatCell(s)!), cols = [...new Set(cells.map(c => c.gx))].sort((a, b) => a - b);
    expect(cols).toEqual([1, 3, 5, 7]);
    for (const gx of cols) expect(cols).toContain(8 - gx);
    // The first seats of a row are the two centre lines.
    expect([1, 2].map(n => seatCell(`developer:${n}`)!.gx).sort()).toEqual([3, 5]);
    for (const c of cells) expect(zoneAt(c)).toBe('developer');
    for (let gy = 9; gy <= 18; gy++) for (let gx = 10; gx <= 17; gx++) expect(zoneAt({ gx, gy })).toBe('creative');
    expect(deskPlan(DEVELOPER_SEATS).desks.some(c => c.gy >= 9 && c.gx >= 9 && c.gx <= 17)).toBe(false);
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
    expect(OBJECT_CELLS.cabinet.gx).toBe(0);
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
  test('the Director Team, Reviewer and QA desks are drawn with or without a session; the Coordinator desk and spares appear with their agent', () => {
    const keys = (seats: string[]) => deskPlan(seats).desks.filter(c => c.gy < 9 || c.gx >= 19).map(c => `${c.gx},${c.gy}`);
    const at = (seat: string) => { const c = seatCell(seat)!; return `${c.gx},${c.gy}`; };
    const always = ['coordination:planner', 'coordination:architect', 'coordination:specifier', 'verification:reviewer', 'verification:qa'].map(at);
    expect(keys([]).sort()).toEqual([...always].sort());
    expect(keys(['coordination:planner', 'coordination:architect', 'coordination:specifier', 'verification:reviewer', 'verification:qa']).sort()).toEqual([...always].sort());
    expect(keys([])).not.toContain(at('coordination:coordinator'));
    expect(keys(['coordination:coordinator'])).toContain(at('coordination:coordinator'));
    expect(keys(['verification:tester'])).toContain(at('verification:tester'));
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
    expect(ZONE_TITLES.map(z => z.text)).toEqual(['Conversation', 'Coordinator', 'Task Board', 'Developer Zone', 'QA / Reviewer', 'Creative Space', 'Swimming Pool']);
  });
  test('objects, desks and plants do not collide and stay inside the world', () => {
    const everyDesk = deskPlan([...Array.from({ length: 20 }, (_, i) => `developer:${i + 1}`), 'verification:reviewer:2', 'verification:qa:2', 'coordination:planner:2', 'coordination:specifier:2', 'conversation:conversation:2', 'conversation:conversation:3']).desks;
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
      'verification:reviewer', 'verification:qa', 'verification:tester', 'verification:security', 'verification:reviewer:2', 'verification:qa:2'];
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
    const a = seatCell('developer:3')!, b = seatCell('developer:2')!, between = seatCell('developer:1')!; // same row, desk between them
    const around = routeBetween(a, b, plan.desks);
    expect(around.length).toBeGreaterThan(0);
    expect(around.some(c => c.gx === between.gx && c.gy === between.gy)).toBe(false);
  });
  test('unused developer rows have no desks and do not block a path', () => {
    const plan = deskPlan(['developer:1']);
    expect(plan.developerRows).toBe(4);
    const fifth = plan.desks.filter(c => c.gy === 18 && c.gx <= 8);
    expect(fifth).toHaveLength(0);
    const straight = routeBetween({ gx: 1, gy: 18 }, { gx: 7, gy: 18 }, plan.desks);
    expect(straight).toHaveLength(7); // a straight line through where the desks would be
    // With a full office the same trip must go around the desks.
    expect(routeBetween({ gx: 1, gy: 18 }, { gx: 7, gy: 18 }, deskPlan(DEVELOPER_SEATS).desks).length).toBeGreaterThan(7);
  });
  test('applySeats fills seats without mutating the model', () => {
    const model = { tier: 'degraded', certainty: 'unknown', statusText: '', agents: [{ instanceId: 'a', label: 'a', role: 'developer', pose: 'sleeping', certainty: 'unknown', statusText: '' }], tasks: [], pendingDecisions: 0, handoffs: [], connection: 'connected' } as OfficeModel;
    const out = applySeats({ entries: [], overflow: 0 }, model);
    expect(out.model.agents[0]!.seat).toBe('developer:1');
    expect(model.agents[0]!.seat).toBeUndefined();
  });
});
