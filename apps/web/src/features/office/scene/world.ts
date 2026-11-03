// Pure layout of the 3D office (§5.1, reference layout 2026-11-02). No three.js here, so the layout is unit-testable and
// the renderer stays a drawing layer. One grid cell is one world unit; cell (gx, gy) has its centre at x = gx + 0.5, z = gy + 0.5.
// Rooms (north is the far wall, the camera looks from the south):
//   back row  : Conversation | Coordination (Planner, Coordinator, Architect, Specifier) | Task Board (hero wall screen above its own zone, at the right)
//   front row : Developer zone (20 seats, rows appear as agents arrive)       | Verification (Reviewer, QA, Tester, Security)
import { findPath } from '../model/path';
import type { OfficeFocusZone, OfficeObjectId } from '../model/types';

export const GRID_W = 28;
export const GRID_H = 19;
/** Wall height; also bounds the camera target so the scene never leaves the view. */
export const WALL_H = 3;

export interface Point { x: number; y: number }
export interface Cell { gx: number; gy: number }
export interface Vec2 { x: number; z: number }

/** World position (x, z) of a tile's centre. */
export function cellCentre(c: Cell): Vec2 { return { x: c.gx + 0.5, z: c.gy + 0.5 }; }
export const WORLD: { w: number; d: number } = { w: GRID_W, d: GRID_H };

/** Developer pool: 20 seats in rows of seven (three rows, the last one partly used), filled row by row. */
export const DEVELOPER_COLUMNS = [3, 5, 7, 9, 11, 13, 15] as const;
export const DEVELOPER_ROWS = [10, 13, 16] as const;
export const DEVELOPER_SEAT_COUNT = 20;

const FIXED_BASES: Readonly<Record<string, Cell>> = {
  'conversation:conversation': { gx: 4, gy: 3 },
  'coordination:planner': { gx: 10, gy: 3 },
  'coordination:coordinator': { gx: 12, gy: 3 },
  'coordination:architect': { gx: 14, gy: 3 },
  'coordination:specifier': { gx: 16, gy: 3 },
  'verification:reviewer': { gx: 21, gy: 10 },
  'verification:qa': { gx: 24, gy: 10 },
  'verification:tester': { gx: 21, gy: 13 },
  'verification:security': { gx: 24, gy: 13 },
};
/** Spare seats of each fixed role, for its second, third ... instance (`zone:role:2` takes the first spare). More instances than spares are not drawn. */
const SPARES: Readonly<Record<string, readonly Cell[]>> = {
  'conversation:conversation': [{ gx: 2, gy: 3 }, { gx: 6, gy: 3 }],
  'coordination:planner': [{ gx: 10, gy: 6 }], 'coordination:coordinator': [{ gx: 12, gy: 6 }], 'coordination:architect': [{ gx: 14, gy: 6 }], 'coordination:specifier': [{ gx: 16, gy: 6 }],
  'verification:reviewer': [{ gx: 26, gy: 10 }], 'verification:qa': [{ gx: 26, gy: 13 }], 'verification:tester': [{ gx: 21, gy: 16 }], 'verification:security': [{ gx: 24, gy: 16 }],
};

/** Cell of a seat id from `assignSeats` (`developer:3`, `verification:reviewer:2`), or undefined when unknown or beyond the spare seats. */
export function seatCell(seat: string): Cell | undefined {
  const base = FIXED_BASES[seat];
  if (base) return base;
  const [zone, name, k] = seat.split(':');
  if (zone === 'developer') {
    const n = Number(name);
    if (!Number.isInteger(n) || n < 1 || n > DEVELOPER_SEAT_COUNT || k !== undefined) return undefined;
    const i = n - 1, cols = DEVELOPER_COLUMNS.length;
    return { gx: DEVELOPER_COLUMNS[i % cols] as number, gy: DEVELOPER_ROWS[Math.floor(i / cols)] as number };
  }
  const extra = Number(k);
  if (!Number.isInteger(extra) || extra < 2) return undefined;
  return SPARES[`${zone}:${name}`]?.[extra - 2];
}

/** Interactive objects (§5.3). `board` is the hero wall screen above the Task Board zone; `counter` is the Conversation reception desk. The mailbox and cabinet stand against walls. */
export const OBJECT_CELLS: Readonly<Record<OfficeObjectId, Cell>> = {
  counter: { gx: 4, gy: 3 },
  board: { gx: 23, gy: 0 },
  mailbox: { gx: 0, gy: 5 },
  cabinet: { gx: 7, gy: 0 },
  server: { gx: 17, gy: 0 },
  settings: { gx: 19, gy: 9 },
  door: { gx: 0, gy: 7 },
};
/** World x of the centre of the Task Board zone, where the board hangs. */
export const BOARD_X = 23.5;

/** Desks that are always drawn: the Coordinator and QA zone anchors. Other fixed-role desks appear with their agent (the Conversation seat is the reception counter). */
const BASE_DESKS: readonly Cell[] = (['coordination:coordinator', 'verification:qa'] as const).map(k => FIXED_BASES[k] as Cell);

/** Non-interactive decoration that blocks a cell. */
export const PLANT_CELLS: readonly Cell[] = [{ gx: 1, gy: 1 }, { gx: 9, gy: 7 }, { gx: 17, gy: 7 }, { gx: 27, gy: 9 }, { gx: 1, gy: 17 }, { gx: 27, gy: 17 }];
/** The standing meeting table of the Task Board zone, two cells wide. */
export const TABLE_CELLS: readonly Cell[] = [{ gx: 23, gy: 4 }, { gx: 24, gy: 4 }];

/**
 * Partition walls (low, 1.3 high) on the corridor cells: they divide the back row from the front row and the rooms from each other. Each run is a
 * straight stretch of wall cells on the cell centre line; `a`/`b` say how its start/end meets something: a number is the extension (world units) up to
 * the wall or the crossing partition, undefined is a free end that gets a post. Doorways are the one-cell gaps between runs.
 */
interface PartitionRun { axis: 'h' | 'v'; line: number; from: number; to: number; a?: number; b?: number }
const NORTH_WALL = 0.93, CROSSING = 0.42;
const PARTITION_RUNS: readonly PartitionRun[] = [
  { axis: 'h', line: 8, from: 1, to: 3 }, { axis: 'h', line: 8, from: 5, to: 12 }, { axis: 'h', line: 8, from: 14, to: 22 }, { axis: 'h', line: 8, from: 24, to: 27, b: 0 },
  { axis: 'v', line: 8, from: 1, to: 4, a: NORTH_WALL }, { axis: 'v', line: 8, from: 6, to: 7, b: CROSSING },
  { axis: 'v', line: 18, from: 1, to: 4, a: NORTH_WALL }, { axis: 'v', line: 18, from: 6, to: 7, b: CROSSING },
  { axis: 'v', line: 18, from: 9, to: 11, a: CROSSING }, { axis: 'v', line: 18, from: 13, to: 18, b: 0 },
];
const runCells = (r: PartitionRun): Cell[] => Array.from({ length: r.to - r.from + 1 }, (_, i) => (r.axis === 'h' ? { gx: r.from + i, gy: r.line } : { gx: r.line, gy: r.from + i }));
/** Cells a partition stands on: nothing walks through them. */
export const PARTITION_CELLS: readonly Cell[] = PARTITION_RUNS.flatMap(runCells);
/** The one-cell gaps in the partitions (the rooms' doors). */
export const DOORWAY_CELLS: readonly Cell[] = [{ gx: 4, gy: 8 }, { gx: 13, gy: 8 }, { gx: 23, gy: 8 }, { gx: 8, gy: 5 }, { gx: 18, gy: 5 }, { gx: 18, gy: 12 }];
export interface PartitionSegment { x: number; z: number; ry: number; len: number }
/** Wall segments (one per cell, the end ones lengthened to meet the wall or crossing partition) and the end posts, in world units. */
export function partitionPieces(): { segments: PartitionSegment[]; posts: Vec2[] } {
  const segments: PartitionSegment[] = [], posts: Vec2[] = [];
  for (const r of PARTITION_RUNS) {
    const h = r.axis === 'h', ry = h ? 0 : Math.PI / 2, n = r.to - r.from + 1;
    for (let i = 0; i < n; i++) {
      const ext0 = i === 0 ? (r.a ?? 0) : 0, ext1 = i === n - 1 ? (r.b ?? 0) : 0, along = r.from + i + 0.5 + (ext1 - ext0) / 2;
      segments.push({ x: h ? along : r.line + 0.5, z: h ? r.line + 0.5 : along, ry, len: 1 + ext0 + ext1 });
    }
    if (r.a === undefined) posts.push(h ? { x: r.from, z: r.line + 0.5 } : { x: r.line + 0.5, z: r.from });
    if (r.b === undefined) posts.push(h ? { x: r.to + 1, z: r.line + 0.5 } : { x: r.line + 0.5, z: r.to + 1 });
  }
  return { segments, posts };
}

/** Plan size (w along the item's local x, d along z) of floor decor, in world units; used for blocking and overlap checks. */
export const DECOR_SIZE: Readonly<Record<string, { w: number; d: number }>> = {
  sofa: { w: 2, d: 0.9 }, armchair: { w: 0.9, d: 0.85 }, coffee_table: { w: 0.9, d: 0.5 }, rug: { w: 3, d: 2 }, bookshelf: { w: 1, d: 0.35 }, water_cooler: { w: 0.36, d: 0.36 },
  floor_lamp: { w: 0.38, d: 0.38 }, printer: { w: 0.8, d: 0.5 }, plant_tall: { w: 0.6, d: 0.6 }, plant_small: { w: 0.2, d: 0.2 }, pendant_lamp: { w: 0.7, d: 0.7 },
  whiteboard: { w: 2, d: 0.08 }, window: { w: 2.1, d: 0.16 }, wall_art: { w: 0.9, d: 0.03 },
};
export type DecorWall = 'north' | 'west' | 'east';
/**
 * Furniture and decoration. `mount`: `floor` (default) stands on the floor and blocks the cells it covers; `rug` lies under other pieces, `table` sits on a
 * table (`off` shifts it on the top), `wall` hangs flush on `wall`, `ceiling` hangs 2.9 high. A floor piece with `wall` stands flush against that wall.
 */
export interface DecorItem { node: string; cell: Cell; ry?: number; mount?: 'floor' | 'rug' | 'table' | 'wall' | 'ceiling'; wall?: DecorWall; off?: [number, number] }
const deco = (node: string, gx: number, gy: number, more: Partial<DecorItem> = {}): DecorItem => ({ node, cell: { gx, gy }, ...more });
export const DECOR: readonly DecorItem[] = [
  // Conversation: a lounge at the south of the room.
  deco('rug', 3, 6, { mount: 'rug' }), deco('sofa', 2, 6), deco('coffee_table', 4, 6), deco('plant_small', 4, 6, { mount: 'table', off: [0.05, -0.13] }), deco('armchair', 6, 6), deco('floor_lamp', 7, 7),
  deco('bookshelf', 2, 0, { wall: 'north' }), deco('window', 4, 0, { mount: 'wall', wall: 'north' }), deco('pendant_lamp', 6, 5, { mount: 'ceiling' }),
  // Coordination
  deco('whiteboard', 10, 0, { mount: 'wall', wall: 'north' }), deco('window', 13, 0, { mount: 'wall', wall: 'north' }), deco('plant_tall', 9, 1), deco('bookshelf', 16, 0, { wall: 'north' }), deco('pendant_lamp', 15, 5, { mount: 'ceiling' }),
  // Task Board
  deco('plant_tall', 19, 1), deco('plant_tall', 27, 1), deco('armchair', 20, 6), deco('armchair', 26, 6),
  // Developer
  deco('plant_tall', 1, 9), deco('plant_tall', 17, 9), deco('water_cooler', 1, 12), deco('printer', 17, 14, { ry: -Math.PI / 2 }), deco('wall_art', 0, 13, { mount: 'wall', wall: 'west' }), deco('pendant_lamp', 11, 11, { mount: 'ceiling' }),
  // Verification
  deco('plant_tall', 19, 17), deco('coffee_table', 26, 16), deco('plant_small', 26, 16, { mount: 'table', off: [0.05, -0.13] }), deco('wall_art', 27, 12, { mount: 'wall', wall: 'east' }), deco('pendant_lamp', 23, 11, { mount: 'ceiling' }),
];
const WALL_FACE = 0.07, PENDANT_Y = 2.9, TABLE_Y = 0.41;
const WALL_RY: Readonly<Record<DecorWall, number>> = { north: 0, west: Math.PI / 2, east: -Math.PI / 2 };
/** World placement of a decor item: position (y is 0 for the floor) and rotation about y. */
export function decorPlacement(d: DecorItem): { x: number; y: number; z: number; ry: number } {
  const c = cellCentre(d.cell), size = DECOR_SIZE[d.node] ?? { w: 0.5, d: 0.5 };
  let { x, z } = c, ry = d.ry ?? 0, y = 0;
  if (d.wall) {
    ry = WALL_RY[d.wall];
    const inset = WALL_FACE + (d.mount === 'wall' ? 0 : size.d / 2);
    if (d.wall === 'north') z = inset; else if (d.wall === 'west') x = inset; else x = GRID_W - inset;
  }
  if (d.mount === 'table') { y = TABLE_Y; x += d.off?.[0] ?? 0; z += d.off?.[1] ?? 0; }
  if (d.mount === 'ceiling') y = PENDANT_Y;
  return { x, y, z, ry };
}
/** Plan rectangle a floor item covers (rotation by quarter turns only). */
export function decorFootprint(d: DecorItem): { x0: number; x1: number; z0: number; z1: number } {
  const p = decorPlacement(d), size = DECOR_SIZE[d.node] ?? { w: 0.5, d: 0.5 };
  const turned = Math.abs(Math.sin(p.ry)) > 0.5, hw = (turned ? size.d : size.w) / 2, hd = (turned ? size.w : size.d) / 2;
  return { x0: p.x - hw, x1: p.x + hw, z0: p.z - hd, z1: p.z + hd };
}
const stands = (d: DecorItem): boolean => d.mount === undefined || d.mount === 'floor';
/** Cells covered (by more than 0.3 each way) by floor decor. They block like objects. */
export const DECOR_CELLS: readonly Cell[] = DECOR.filter(stands).flatMap(d => {
  const f = decorFootprint(d), out: Cell[] = [];
  for (let gy = Math.floor(f.z0); gy <= Math.floor(f.z1); gy++) for (let gx = Math.floor(f.x0); gx <= Math.floor(f.x1); gx++) {
    if (Math.min(f.x1, gx + 1) - Math.max(f.x0, gx) > 0.3 && Math.min(f.z1, gy + 1) - Math.max(f.z0, gy) > 0.3) out.push({ gx, gy });
  }
  return out;
});

export interface DeskPlan {
  /** Developer rows drawn: every row holding an occupied seat plus the next free row, at least one. */
  developerRows: number;
  /** Cells of every desk that is drawn, and therefore blocks passers-by. */
  desks: Cell[];
}
/** Which desks exist for the occupied seats. Unused developer rows have no desks and do not block paths. */
export function deskPlan(occupiedSeats: readonly string[]): DeskPlan {
  const cols = DEVELOPER_COLUMNS.length;
  let maxDev = 0;
  const desks: Cell[] = [...BASE_DESKS];
  const have = new Set(desks.map(c => `${c.gx},${c.gy}`));
  for (const seat of occupiedSeats) {
    if (seat.startsWith('developer:')) { maxDev = Math.max(maxDev, Number(seat.slice(10)) || 0); continue; }
    const c = seatCell(seat);
    if (c && seat !== 'conversation:conversation' && !have.has(`${c.gx},${c.gy}`)) { have.add(`${c.gx},${c.gy}`); desks.push(c); }
  }
  const developerRows = Math.min(DEVELOPER_ROWS.length, Math.ceil(Math.min(maxDev, DEVELOPER_SEAT_COUNT) / cols) + 1);
  for (let n = 1; n <= Math.min(DEVELOPER_SEAT_COUNT, developerRows * cols); n++) desks.push(seatCell(`developer:${n}`) as Cell);
  return { developerRows, desks };
}

export type ZoneId = 'conversation' | 'coordination' | 'taskboard' | 'developer' | 'verification' | 'lobby';
export interface Zone { id: ZoneId; x0: number; y0: number; x1: number; y1: number }
/** Cell rectangles, inclusive. The developer zone is cut to the rows drawn. */
export function zones(developerRows: number): Zone[] {
  const rows = Math.max(1, Math.min(DEVELOPER_ROWS.length, developerRows));
  return [
    { id: 'conversation', x0: 1, y0: 1, x1: 7, y1: 7 },
    { id: 'coordination', x0: 9, y0: 1, x1: 17, y1: 7 },
    { id: 'taskboard', x0: 19, y0: 1, x1: 27, y1: 7 },
    { id: 'developer', x0: 1, y0: 9, x1: 17, y1: 10 + rows * 3 - 2 },
    { id: 'verification', x0: 19, y0: 9, x1: 27, y1: 17 },
  ];
}
/** Rows of the Developer zone needed for `count` Developers (the occupied rows plus the next free one). */
export const developerRowsFor = (count: number): number => deskPlan(count > 0 ? [`developer:${Math.min(count, DEVELOPER_SEAT_COUNT)}`] : []).developerRows;

export function zoneAt(c: Cell, developerRows: number = DEVELOPER_ROWS.length): ZoneId {
  for (const z of zones(developerRows)) if (c.gx >= z.x0 && c.gx <= z.x1 && c.gy >= z.y0 && c.gy <= z.y1) return z.id;
  return 'lobby';
}

/** Cells other than desks that nothing may cross: interactive objects, plants, the meeting table, partitions and floor decor. */
const FIXED_BLOCKS: readonly Cell[] = [...Object.values(OBJECT_CELLS), ...PLANT_CELLS, ...TABLE_CELLS, ...PARTITION_CELLS, ...DECOR_CELLS];

/**
 * Shortest 4-directional route between two cells (both included), or [] when unreachable. Only the drawn `desks` block, plus objects, plants
 * and the table. The two endpoints of a walk are opened for it: a character stands up from its desk and walks to the other desk.
 */
export function routeBetween(from: Cell, to: Cell, desks: readonly Cell[]): Cell[] {
  const blocked = new Set([...desks, ...FIXED_BLOCKS].map(c => `${c.gx},${c.gy}`));
  const open = new Set([`${from.gx},${from.gy}`, `${to.gx},${to.gy}`]);
  const grid = Array.from({ length: GRID_H }, (_, y) => Array.from({ length: GRID_W }, (_, x) => open.has(`${x},${y}`) || !blocked.has(`${x},${y}`)));
  return findPath(grid, { x: from.gx, y: from.gy }, { x: to.gx, y: to.gy }).map(c => ({ gx: c.x, gy: c.y }));
}

export const OFFICE_ASSET_PATHS = { character: 'office/character.glb', furniture: 'office/furniture.glb' } as const;

/** Text of the zone signs (the single source; the signs below carry it, the DOM mirror holds the accessible truth). */
export const ZONE_TITLES: readonly { id: ZoneId; text: string }[] = [
  { id: 'conversation', text: 'Conversation' },
  { id: 'coordination', text: 'Coordinator' },
  { id: 'taskboard', text: 'Task Board' },
  { id: 'developer', text: 'Developer Zone' },
  { id: 'verification', text: 'QA / Reviewer' },
];
export interface ZoneSign { id: ZoneId; text: string; x: number; y: number; z: number; w: number; h: number }
/** Signs face +z (south, towards the camera). Back rooms: on the north wall above head height; the board: on its top frame; front rooms: on the partition facing south. */
const SIGN_AT: Readonly<Record<string, { x: number; y: number; z: number }>> = {
  conversation: { x: 4.5, y: 3.05, z: 0.14 }, coordination: { x: 13.5, y: 3.05, z: 0.14 }, taskboard: { x: BOARD_X, y: 3.4, z: 0.32 },
  developer: { x: 9.5, y: 1.15, z: 8.62 }, verification: { x: 21.6, y: 1.15, z: 8.62 },
};
export const SIGN_HEIGHT = 0.5;
export const ZONE_SIGNS: readonly ZoneSign[] = ZONE_TITLES.map(t => ({ ...t, ...(SIGN_AT[t.id] as { x: number; y: number; z: number }), w: Math.max(1.6, t.text.length * 0.17 + 0.5), h: SIGN_HEIGHT }));

/**
 * The floor rectangle the default camera frames: the drawn desks, the reception counter and the Task Board, with a margin, inside the grid.
 * Few agents therefore leave no large empty foreground.
 */
export function contentBox(desks: readonly Cell[]): { w: number; d: number; cx: number; cz: number } {
  const cells = [...desks, OBJECT_CELLS.counter, OBJECT_CELLS.board, { gx: 27, gy: 0 }];
  const x0 = Math.max(0, Math.min(...cells.map(c => c.gx)) - 2), x1 = Math.min(GRID_W, Math.max(...cells.map(c => c.gx)) + 3);
  const z0 = 0, z1 = Math.min(GRID_H, Math.max(...cells.map(c => c.gy)) + 3);
  return { w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

/** Camera presets of the HUD (bottom-left buttons). `overview` is the home view; the rest frame one room. */
export const FOCUS_POINTS: Readonly<Record<Exclude<OfficeFocusZone, 'overview'>, { at: Vec2; zoom: number }>> = {
  conversation: { at: { x: 4.5, z: 4 }, zoom: 2.3 },
  coordinator: { at: { x: 13.5, z: 4 }, zoom: 2.3 },
  developer: { at: { x: 9.5, z: 12.5 }, zoom: 1.7 },
  qa: { at: { x: 23.5, z: 12.5 }, zoom: 1.9 },
};
