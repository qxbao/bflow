import { describe, expect, test } from 'vitest';
import { DECOR, DECOR_CELLS, DECOR_SIZE, DEVELOPER_SEAT_COUNT, DOORWAY_CELLS, GRID_H, GRID_W, OBJECT_CELLS, PARTITION_CELLS, PLANT_CELLS, TABLE_CELLS, ZONE_SIGNS, ZONE_TITLES, decorFootprint, decorPlacement, deskPlan, partitionPieces, routeBetween, seatCell, zoneAt, type Cell } from '../src/features/office/scene/world';

const key = (c: Cell): string => `${c.gx},${c.gy}`;
const ALL_SEATS = [
  ...Array.from({ length: DEVELOPER_SEAT_COUNT }, (_, i) => `developer:${i + 1}`),
  'conversation:conversation', 'conversation:conversation:2', 'conversation:conversation:3',
  ...['coordination:planner', 'coordination:coordinator', 'coordination:architect', 'coordination:specifier', 'verification:reviewer', 'verification:qa', 'verification:tester', 'verification:security'].flatMap(s => [s, `${s}:2`]),
];
const seatCells = ALL_SEATS.map(s => seatCell(s) as Cell);
/** Plan rectangle of a desk with its chair (the chair stands on the -z side). */
const deskRect = (c: Cell) => ({ x0: c.gx + 0.5 - 0.75, x1: c.gx + 0.5 + 0.75, z0: c.gy - 0.41, z1: c.gy + 0.87 });
const cellRect = (c: Cell) => ({ x0: c.gx, x1: c.gx + 1, z0: c.gy, z1: c.gy + 1 });
type Rect = { x0: number; x1: number; z0: number; z1: number };
const overlap = (a: Rect, b: Rect): boolean => a.x0 < b.x1 - 1e-6 && a.x1 > b.x0 + 1e-6 && a.z0 < b.z1 - 1e-6 && a.z1 > b.z0 + 1e-6;
const floorItems = DECOR.filter(d => d.mount === undefined || d.mount === 'floor');
const approach = (c: Cell): Cell[] => (PARTITION_CELLS.some(p => p.gx === c.gx - 1 && p.gy === c.gy) || PARTITION_CELLS.some(p => p.gx === c.gx + 1 && p.gy === c.gy)
  ? [{ gx: c.gx, gy: c.gy - 1 }, { gx: c.gx, gy: c.gy + 1 }] : [{ gx: c.gx - 1, gy: c.gy }, { gx: c.gx + 1, gy: c.gy }]);

describe('partitions', () => {
  test('wall cells and doorways follow the plan and never coincide', () => {
    const walls = new Set(PARTITION_CELLS.map(key));
    expect(walls.size).toBe(PARTITION_CELLS.length);
    for (const gx of [1, 2, 3, 5, 12, 14, 22, 24, 27]) expect(walls.has(`${gx},8`), `${gx},8`).toBe(true);
    for (const gy of [1, 4, 6, 7]) for (const gx of [8, 18]) expect(walls.has(`${gx},${gy}`), `${gx},${gy}`).toBe(true);
    for (const gy of [9, 11, 13, 18]) expect(walls.has(`18,${gy}`)).toBe(true);
    expect(DOORWAY_CELLS.map(key).sort()).toEqual(['13,8', '18,12', '18,5', '23,8', '4,8', '8,5'].sort());
    for (const d of DOORWAY_CELLS) expect(walls.has(key(d)), `doorway ${key(d)} is open`).toBe(false);
    for (const c of PARTITION_CELLS) { expect(c.gx).toBeGreaterThanOrEqual(0); expect(c.gx).toBeLessThan(GRID_W); expect(c.gy).toBeLessThan(GRID_H); }
  });
  test('every wall cell has a drawn segment and every segment lies on wall cells', () => {
    const { segments, posts } = partitionPieces();
    expect(segments).toHaveLength(PARTITION_CELLS.length);
    for (const g of segments) expect(PARTITION_CELLS.some(c => Math.abs(c.gx + 0.5 - g.x) <= 0.5 + g.len && Math.abs(c.gy + 0.5 - g.z) <= 0.5 + g.len)).toBe(true);
    expect(posts.length).toBeGreaterThanOrEqual(DOORWAY_CELLS.length * 2);
  });
  test('seats, desks and decor stay clear of the walls', () => {
    const walls = new Set(PARTITION_CELLS.map(key));
    for (const c of [...seatCells, ...Object.values(OBJECT_CELLS).filter(o => o.gy !== 0 && o.gx !== 0), ...PLANT_CELLS, ...TABLE_CELLS]) expect(walls.has(key(c)), key(c)).toBe(false);
  });
});

describe('decor', () => {
  test('stays inside the grid and uses known sizes', () => {
    for (const d of DECOR) {
      const p = decorPlacement(d);
      expect(d.cell.gx >= 0 && d.cell.gx < GRID_W && d.cell.gy >= 0 && d.cell.gy < GRID_H, `${d.node} ${key(d.cell)}`).toBe(true);
      expect(p.x > 0 && p.x < GRID_W && p.z > 0 && p.z < GRID_H, `${d.node} placed`).toBe(true);
      expect(DECOR_SIZE[d.node], d.node).toBeDefined();
    }
  });
  test('floor pieces do not overlap each other, any possible desk with its chair, an object, plant, table, wall or doorway (with its approach)', () => {
    const fixed: { name: string; r: Rect }[] = [
      ...ALL_SEATS.map((s, i) => ({ name: s, r: deskRect(seatCells[i] as Cell) })),
      ...Object.entries(OBJECT_CELLS).map(([id, c]) => ({ name: id, r: cellRect(c) })),
      ...[...PLANT_CELLS, ...TABLE_CELLS].map(c => ({ name: `fixed ${key(c)}`, r: cellRect(c) })),
      ...PARTITION_CELLS.map(c => ({ name: `wall ${key(c)}`, r: cellRect(c) })),
      ...DOORWAY_CELLS.flatMap(d => [d, ...approach(d)].map(c => ({ name: `doorway ${key(d)}`, r: cellRect(c) }))),
    ];
    floorItems.forEach((d, i) => {
      const f = decorFootprint(d);
      for (const o of fixed) expect(overlap(f, o.r), `${d.node} at ${key(d.cell)} overlaps ${o.name}`).toBe(false);
      floorItems.forEach((e, j) => { if (j > i) expect(overlap(f, decorFootprint(e)), `${d.node} ${key(d.cell)} overlaps ${e.node} ${key(e.cell)}`).toBe(false); });
    });
  });
  test('wall pieces keep to their wall, off objects, other wall pieces and tall furniture', () => {
    const north = DECOR.filter(d => d.wall === 'north'), tall = north.filter(d => d.mount !== 'wall');
    const span = (d: (typeof DECOR)[number]) => { const f = decorFootprint(d); return [f.x0, f.x1] as const; };
    north.forEach((d, i) => {
      const [a0, a1] = span(d);
      north.forEach((e, j) => { if (j <= i) return; const [b0, b1] = span(e); expect(a0 < b1 - 1e-6 && a1 > b0 + 1e-6, `${d.node} ${key(d.cell)} / ${e.node} ${key(e.cell)}`).toBe(false); });
      for (const o of [OBJECT_CELLS.cabinet, OBJECT_CELLS.server, OBJECT_CELLS.board]) if (d.mount === 'wall' && o !== OBJECT_CELLS.board) expect(a0 < o.gx + 1 - 0.2 && a1 > o.gx + 0.2, `${d.node} / object ${key(o)}`).toBe(false);
    });
    expect(tall.length).toBeGreaterThan(0);
    const west = DECOR.filter(d => d.wall === 'west'), east = DECOR.filter(d => d.wall === 'east');
    for (const d of west) { expect(decorPlacement(d).x).toBeCloseTo(0.07); expect(d.cell.gy === OBJECT_CELLS.door.gy || d.cell.gy === OBJECT_CELLS.mailbox.gy).toBe(false); }
    for (const d of east) expect(decorPlacement(d).x).toBeCloseTo(GRID_W - 0.07);
  });
  test('floor decor blocks its cells; wall, ceiling, rug and table pieces do not', () => {
    const blocked = new Set(DECOR_CELLS.map(key));
    for (const d of floorItems) expect(blocked.has(key(d.cell)), `${d.node} ${key(d.cell)}`).toBe(true);
    for (const gy of [5, 6, 7]) expect(blocked.has(`1,${gy}`) && blocked.has(`3,${gy}`), `sofas at row ${gy}`).toBe(true); // the long sofas face each other
    expect(blocked.has('2,6')).toBe(true); // the tea table between them
    for (const gx of [1, 2, 3, 4, 5, 6, 7]) expect(blocked.has(`${gx},0`), `back wall ${gx}`).toBe(true); // bookcases and statue span the back wall
    const lamp = DECOR.find(d => d.node === 'pendant_lamp')!;
    expect(decorPlacement(lamp).y).toBeGreaterThan(2.5);
  });
});

describe('signs', () => {
  test('one per zone, with the title text, inside the grid', () => {
    expect(ZONE_SIGNS.map(s => s.id).sort()).toEqual(['conversation', 'coordination', 'developer', 'taskboard', 'verification']);
    expect(ZONE_SIGNS.map(s => s.text)).toEqual(ZONE_TITLES.map(t => t.text));
    for (const s of ZONE_SIGNS) {
      expect(s.x - s.w / 2, s.id).toBeGreaterThan(0); expect(s.x + s.w / 2, s.id).toBeLessThan(GRID_W);
      expect(s.z).toBeGreaterThan(0); expect(s.z).toBeLessThan(GRID_H); expect(s.y).toBeGreaterThan(0.5);
    }
  });
  test('front-room signs hang on the partition clear of the doorways; back-room signs sit over their own room', () => {
    for (const id of ['developer', 'verification'] as const) {
      const s = ZONE_SIGNS.find(q => q.id === id)!;
      expect(s.z).toBeGreaterThan(8.58); expect(s.z).toBeLessThan(8.8);
      for (const d of DOORWAY_CELLS.filter(c => c.gy === 8)) expect(s.x + s.w / 2 <= d.gx || s.x - s.w / 2 >= d.gx + 1, `${id} vs doorway ${d.gx}`).toBe(true);
      expect(zoneAt({ gx: Math.floor(s.x), gy: 9 })).toBe(id);
    }
    for (const id of ['conversation', 'coordination'] as const) expect(zoneAt({ gx: Math.floor(ZONE_SIGNS.find(q => q.id === id)!.x), gy: 1 })).toBe(id);
  });
});

describe('reachability', () => {
  const everyDesk = deskPlan(ALL_SEATS).desks;
  test('with every seat occupied, every pair of seats has a route, and none crosses a wall or decor cell', () => {
    const banned = new Set([...PARTITION_CELLS, ...DECOR_CELLS].map(key));
    const ends = new Set(seatCells.map(key));
    for (let i = 0; i < seatCells.length; i++) for (let j = i + 1; j < seatCells.length; j++) {
      const route = routeBetween(seatCells[i] as Cell, seatCells[j] as Cell, everyDesk);
      expect(route.length, `${ALL_SEATS[i]} -> ${ALL_SEATS[j]}`).toBeGreaterThan(0);
      for (const c of route) expect(banned.has(key(c)) && !ends.has(key(c)), `${ALL_SEATS[i]} -> ${ALL_SEATS[j]} crosses ${key(c)}`).toBe(false);
    }
  });
  test('every object can be reached from the reception counter', () => {
    for (const [id, o] of Object.entries(OBJECT_CELLS)) expect(routeBetween(OBJECT_CELLS.counter, o, everyDesk).length, id).toBeGreaterThan(0);
  });
  test('every doorway cell is walkable and joins both of its sides', () => {
    for (const d of DOORWAY_CELLS) {
      const [a, b] = approach(d) as [Cell, Cell];
      expect(routeBetween(a, b, everyDesk).length, key(d)).toBeGreaterThan(0);
      expect(routeBetween(a, b, everyDesk).some(c => key(c) === key(d)), `${key(d)} is on the way`).toBe(true);
    }
  });
});
