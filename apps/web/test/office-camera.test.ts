import { describe, expect, test } from 'vitest';
import { CameraMove, FOCUS_MS, FOCUS_ZOOM, KEY_ZOOM, MAX_ZOOM, MIN_ZOOM, cameraKey, cameraPose, clampCamera, easeCamera, fitCamera, fitDistance, focusOn, panByPixels, pinchFactor, wheelFactor, zoomBy } from '../src/features/office/scene/camera';
import { DESK_CELLS, GRID_H, GRID_W, OBJECT_CELLS, PLANT_CELLS, WORLD, cellCentre, developerRowsFor, seatCell, zoneAt, zones } from '../src/features/office/scene/world';
import { DEVELOPER_SEATS, applySeats } from '../src/features/office/model/seats';
import type { OfficeModel } from '../src/features/office/model/types';

const view = { w: 1600, h: 900 };

describe('camera', () => {
  test('fit centres the office at the widest zoom and fits both axes for any aspect', () => {
    const cam = fitCamera(WORLD);
    expect(cam).toEqual({ x: GRID_W / 2, z: GRID_H / 2, zoom: MIN_ZOOM });
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
      'verification:reviewer', 'verification:qa', 'verification:tester', 'verification:security', 'verification:reviewer:2', 'verification:reviewer:3', 'verification:reviewer:4'];
    const keys = seats.map(seat => {
      const c = seatCell(seat);
      expect(c, seat).toBeDefined();
      expect(c!.gx >= 0 && c!.gx < GRID_W && c!.gy >= 0 && c!.gy < GRID_H, seat).toBe(true);
      return `${c!.gx},${c!.gy}`;
    });
    expect(new Set(keys).size).toBe(keys.length);
    expect(seatCell('developer:21')).toBeUndefined();
    expect(seatCell('annex:1')).toBeUndefined();
    expect(seatCell('nonsense')).toBeUndefined();
  });
  test('20 developer seats, rows of five, and the zone grows with the count', () => {
    expect(DEVELOPER_SEATS).toHaveLength(20);
    expect(developerRowsFor(0)).toBe(1);
    expect(developerRowsFor(5)).toBe(1);
    expect(developerRowsFor(6)).toBe(2);
    expect(developerRowsFor(20)).toBe(4);
    expect(developerRowsFor(99)).toBe(4);
    const area = (rows: number): number => { const z = zones(rows).find(q => q.id === 'developer')!; return (z.x1 - z.x0) * (z.y1 - z.y0); };
    expect(area(2)).toBeGreaterThan(area(1));
    for (let n = 1; n <= 20; n++) { const c = seatCell(`developer:${n}`)!; expect(zoneAt(c, developerRowsFor(n)), `developer:${n}`).toBe('developer'); }
  });
  test('rooms follow the reference layout: back row above the front row, QA/Reviewer at the right', () => {
    const z = (id: string) => zones(4).find(q => q.id === id)!;
    expect(z('conversation').x1).toBeLessThan(z('coordination').x0);
    expect(z('coordination').x1).toBeLessThan(z('taskboard').x0);
    expect(z('developer').y0).toBeGreaterThan(z('coordination').y1);
    expect(z('verification').x0).toBeGreaterThan(z('developer').x1);
    for (const seat of ['coordination:coordinator', 'coordination:planner', 'coordination:architect', 'coordination:specifier']) expect(zoneAt(seatCell(seat)!)).toBe('coordination');
    for (const seat of ['verification:reviewer', 'verification:qa', 'verification:tester', 'verification:security']) expect(zoneAt(seatCell(seat)!)).toBe('verification');
    expect(zoneAt(seatCell('conversation:conversation')!)).toBe('conversation');
    expect(zoneAt({ gx: OBJECT_CELLS.board.gx, gy: 1 })).toBe('taskboard');
  });
  test('objects, desks and plants do not collide and stay inside the world', () => {
    const cells = [...Object.values(OBJECT_CELLS).filter(c => c !== OBJECT_CELLS.counter), ...DESK_CELLS, ...PLANT_CELLS].map(c => `${c.gx},${c.gy}`);
    expect(new Set(cells).size).toBe(cells.length);
    expect(OBJECT_CELLS.counter).toEqual(seatCell('conversation:conversation'));
    for (const c of [...Object.values(OBJECT_CELLS), ...DESK_CELLS, ...PLANT_CELLS]) {
      const p = cellCentre(c);
      expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(WORLD.w); expect(p.z).toBeGreaterThan(0); expect(p.z).toBeLessThan(WORLD.d);
    }
  });
  test('applySeats fills seats without mutating the model', () => {
    const model = { tier: 'degraded', certainty: 'unknown', statusText: '', agents: [{ instanceId: 'a', label: 'a', role: 'developer', pose: 'sleeping', certainty: 'unknown', statusText: '' }], tasks: [], pendingDecisions: 0, handoffs: [], connection: 'connected' } as OfficeModel;
    const out = applySeats({ entries: [], overflow: 0 }, model);
    expect(out.model.agents[0]!.seat).toBe('developer:1');
    expect(model.agents[0]!.seat).toBeUndefined();
  });
});
