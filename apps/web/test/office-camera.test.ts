import { describe, expect, test } from 'vitest';
import { KEEP_VISIBLE, PINCH_RATIO, cameraKey, clampCamera, fitCamera, panBy, pinchStep, zoomBy } from '../src/features/office/scene/camera';
import { DESK_CELLS, GRID_H, GRID_W, OBJECT_CELLS, WORLD, cellCentre, seatCell } from '../src/features/office/scene/layers';
import { DEVELOPER_SEATS, applySeats } from '../src/features/office/model/seats';
import type { OfficeModel } from '../src/features/office/model/types';

const view = { w: 1600, h: 900 };

describe('camera', () => {
  test('fit picks the largest integer zoom and centres', () => {
    const cam = fitCamera(view, WORLD);
    expect(Number.isInteger(cam.zoom)).toBe(true);
    expect(cam.zoom).toBe(Math.min(4, Math.floor(Math.min(view.w / WORLD.w, view.h / WORLD.h))));
    expect(Number.isInteger(cam.x) && Number.isInteger(cam.y)).toBe(true);
    expect(fitCamera({ w: 10, h: 10 }, WORLD).zoom).toBe(1);
  });
  test('zoom is integer stepped, bounded, and keeps the anchor point fixed', () => {
    let cam = { zoom: 1, x: 100, y: 50 };
    const anchor = { x: 400, y: 300 };
    const before = { x: (anchor.x - cam.x) / cam.zoom, y: (anchor.y - cam.y) / cam.zoom };
    cam = zoomBy(cam, 1, anchor, view, WORLD);
    expect(cam.zoom).toBe(2);
    expect(Math.abs((anchor.x - cam.x) / cam.zoom - before.x)).toBeLessThan(1);
    for (let i = 0; i < 10; i++) cam = zoomBy(cam, 1, anchor, view, WORLD);
    expect(cam.zoom).toBe(4);
    for (let i = 0; i < 10; i++) cam = zoomBy(cam, -1, anchor, view, WORLD);
    expect(cam.zoom).toBe(1);
  });
  test('pan keeps part of the world visible', () => {
    const cam = panBy({ zoom: 2, x: 0, y: 0 }, -1e6, 1e6, view, WORLD);
    expect(cam.x).toBeLessThanOrEqual(view.w - KEEP_VISIBLE);
    expect(cam.x + WORLD.w * 2).toBeGreaterThanOrEqual(KEEP_VISIBLE);
    expect(cam.y).toBeLessThanOrEqual(view.h - KEEP_VISIBLE);
    expect(clampCamera({ zoom: 9, x: 0, y: 0 }, view, WORLD).zoom).toBe(4);
  });
  test('keys follow section 5.4 and ignore everything else', () => {
    expect(cameraKey('ArrowLeft')).toEqual({ kind: 'pan', dx: 32, dy: 0 });
    expect(cameraKey('+')).toEqual({ kind: 'zoom', step: 1 });
    expect(cameraKey('-')).toEqual({ kind: 'zoom', step: -1 });
    expect(cameraKey('0')).toEqual({ kind: 'fit' });
    expect(cameraKey('Enter')).toBeUndefined();
  });
});

describe('pinch', () => {
  test('spreading or closing the fingers gives one integer step past the ratio, otherwise nothing', () => {
    expect(pinchStep(100, 100 * PINCH_RATIO)).toBe(1);
    expect(pinchStep(100, 100 / PINCH_RATIO)).toBe(-1);
    expect(pinchStep(100, 120)).toBe(0);
    expect(pinchStep(100, 85)).toBe(0);
    expect(pinchStep(0, 100)).toBe(0);
    expect(pinchStep(100, 0)).toBe(0);
  });
  test('repeated steps compose with zoomBy into bounded integer zoom', () => {
    let cam = { zoom: 1, x: 0, y: 0 };
    for (let i = 0; i < 6; i++) cam = zoomBy(cam, pinchStep(100, 200) as 1, { x: 800, y: 450 }, view, WORLD);
    expect(cam.zoom).toBe(4);
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
    expect(seatCell('developer:7')).toBeUndefined();
    expect(seatCell('nonsense')).toBeUndefined();
  });
  test('objects and desks do not collide and everything projects inside the world', () => {
    const cells = [...Object.values(OBJECT_CELLS), ...DESK_CELLS].map(c => `${c.gx},${c.gy}`);
    expect(new Set(cells).size).toBe(cells.length);
    for (const c of [{ gx: 0, gy: 0 }, { gx: GRID_W - 1, gy: GRID_H - 1 }, { gx: GRID_W - 1, gy: 0 }, { gx: 0, gy: GRID_H - 1 }]) {
      const p = cellCentre(c);
      expect(p.x - 16).toBeGreaterThanOrEqual(0);
      expect(p.x + 16).toBeLessThanOrEqual(WORLD.w);
      expect(p.y + 8).toBeLessThanOrEqual(WORLD.h);
    }
  });
  test('applySeats fills seats without mutating the model', () => {
    const model = { tier: 'degraded', certainty: 'unknown', statusText: '', agents: [{ instanceId: 'a', label: 'a', role: 'developer', pose: 'sleeping', certainty: 'unknown', statusText: '' }], tasks: [], pendingDecisions: 0, handoffs: [], connection: 'connected' } as OfficeModel;
    const out = applySeats({ entries: [], overflow: 0 }, model);
    expect(out.model.agents[0]!.seat).toBe('developer:1');
    expect(model.agents[0]!.seat).toBeUndefined();
  });
});
