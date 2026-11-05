// Pure layout of the 3D office (§5.1, reference layout 2026-11-02). No three.js here, so the layout is unit-testable and
// the renderer stays a drawing layer. One grid cell is one world unit; cell (gx, gy) has its centre at x = gx + 0.5, z = gy + 0.5.
// Rooms (north is the far wall, the camera looks from the south):
//   back row  : Conversation | Coordination (Planner, Coordinator, Architect, Specifier) | Task Board (hero wall screen above its own zone, at the right)
//   front row : Developer zone (20 seats in north-south rows, rows appear as agents arrive) | an empty spare room | Verification (Reviewer, QA, Tester,
//               Security, print corner) above a second empty spare room
// Every room is laid out mirror-symmetric about its own centre line, and every door sits in the middle of its wall.
import { findPath } from '../model/path';
import { DIRECTOR_SEAT } from '../model/seats';
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
/**
 * Half-cell x shift of the desks, seats and wall objects of a room whose centre line falls between two cells: the Director Team room is eight cells
 * wide (x 10..17, centre line x 14), so its pieces stand half a cell west of their cell centre and straddle two cells (both block a route).
 */
export function roomShift(c: Cell): number { return c.gy < 8 && c.gx >= 10 && c.gx <= 17 ? -0.5 : 0; }
/** World position of a desk, seat or object on a cell: the cell centre plus the room's half-cell shift. */
export function deskCentre(c: Cell): Vec2 { const p = cellCentre(c); return { x: p.x + roomShift(c), z: p.z }; }
export const WORLD: { w: number; d: number } = { w: GRID_W, d: GRID_H };

/**
 * Developer pool: 20 seats in four north-south lines of desks with a one-cell aisle between neighbouring lines, mirror-symmetric about the centre of
 * the Developer zone (x 4.5), in the left half of the front row (the right half is the empty spare room). Seats fill across (five rows of four),
 * centre lines first, so a partly used row stays balanced.
 */
export const DEVELOPER_COLUMNS = [3, 5, 1, 7] as const;
export const DEVELOPER_ROWS = [10, 12, 14, 16, 18] as const;
export const DEVELOPER_SEAT_COUNT = 20;

const FIXED_BASES: Readonly<Record<string, Cell>> = {
  'conversation:conversation': { gx: 4, gy: 3 },
  // Director Team: three desks mirror-symmetric about the room's centre line (x 14, see roomShift); the legacy Coordinator sits front-centre.
  'coordination:planner': { gx: 11, gy: 3 },
  'coordination:architect': { gx: 14, gy: 3 },
  'coordination:specifier': { gx: 17, gy: 3 },
  'coordination:coordinator': { gx: 14, gy: 6 },
  // QA / Reviewer: two rows of desks mirror-symmetric about the room's centre line (x 23.5).
  'verification:reviewer': { gx: 21, gy: 10 },
  'verification:qa': { gx: 25, gy: 10 },
  'verification:tester': { gx: 21, gy: 12 },
  'verification:security': { gx: 25, gy: 12 },
};
/**
 * Spare seats of each fixed role, for its second, third ... instance (`zone:role:2` takes the first spare), on the room's centre line or mirrored
 * about it. More instances than spares are not drawn.
 */
const SPARES: Readonly<Record<string, readonly Cell[]>> = {
  'conversation:conversation': [{ gx: 2, gy: 3 }, { gx: 6, gy: 3 }],
  'coordination:planner': [{ gx: 11, gy: 6 }], 'coordination:specifier': [{ gx: 17, gy: 6 }], 'coordination:architect': [], 'coordination:coordinator': [],
  'verification:reviewer': [{ gx: 23, gy: 10 }], 'verification:qa': [{ gx: 23, gy: 12 }], 'verification:tester': [], 'verification:security': [],
};

/** Cell of a seat id from `assignSeats` (`developer:3`, `verification:reviewer:2`), or undefined when unknown or beyond the spare seats. */
export function seatCell(seat: string): Cell | undefined {
  // The Director desk is the existing executive desk of the control room (the Conversation counter).
  if (seat === DIRECTOR_SEAT) return OBJECT_CELLS.counter;
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

/** Interactive objects (§5.3). `board` is the hero wall screen above the Task Board zone; `counter` is the Conversation executive desk; `server` is the centrepiece of the Coordination back wall. The mailbox and cabinet stand against walls (the cabinet on the west wall, so the Conversation bookcases fill the back wall). */
export const OBJECT_CELLS: Readonly<Record<OfficeObjectId, Cell>> = {
  counter: { gx: 4, gy: 3 },
  board: { gx: 23, gy: 0 },
  mailbox: { gx: 0, gy: 5 },
  cabinet: { gx: 0, gy: 3 },
  server: { gx: 14, gy: 0 },
  settings: { gx: 19, gy: 9 },
  door: { gx: 0, gy: 7 },
};
/** World x of the centre of the Task Board zone, where the board hangs. */
export const BOARD_X = 23.5;

/**
 * Desks that are always drawn, with or without a session: the Director Team (Planner, Architect, Specifier) and the Reviewer and QA desks. Other
 * fixed-role desks, the legacy Coordinator's included, appear with their agent (the Conversation seat is the executive desk).
 */
const BASE_DESKS: readonly Cell[] = (['coordination:planner', 'coordination:architect', 'coordination:specifier', 'verification:reviewer', 'verification:qa'] as const).map(k => FIXED_BASES[k] as Cell);

/** Non-interactive decoration that blocks a cell. */
export const PLANT_CELLS: readonly Cell[] = [{ gx: 10, gy: 7 }, { gx: 17, gy: 7 }, { gx: 10, gy: 17 }, { gx: 17, gy: 17 }];
/** The long meeting table of the Task Board zone, five cells wide, centred under the board; its chairs are decor around it. */
export const TABLE_CELLS: readonly Cell[] = [21, 22, 23, 24, 25].map(gx => ({ gx, gy: 4 }));

/**
 * Partition walls (low, 1.3 high) on the corridor cells: they divide the back row from the front row and the rooms from each other. Each run is a
 * straight stretch of wall cells on the cell centre line; `a`/`b` say how its start/end meets something: a number is the extension (world units) up to
 * the wall or the crossing partition, undefined is a free end that gets a post. Doorways are the one-cell gaps between runs.
 */
interface PartitionRun { axis: 'h' | 'v'; line: number; from: number; to: number; a?: number; b?: number }
const NORTH_WALL = 0.93, CROSSING = 0.42;
const PARTITION_RUNS: readonly PartitionRun[] = [
  // Back row / front row, wall to wall, with a door in the middle of each back room.
  // The Director Team room is eight cells wide, so its door is a double one (two cells) to sit in the middle of the wall.
  { axis: 'h', line: 8, from: 0, to: 3, a: 0 }, { axis: 'h', line: 8, from: 5, to: 12 }, { axis: 'h', line: 8, from: 15, to: 22 }, { axis: 'h', line: 8, from: 24, to: 27, b: 0 },
  // Back row: Conversation | Coordination | Task Board, a door in the middle of each wall. The Conversation wall continues the Developer one (x 9).
  { axis: 'v', line: 9, from: 1, to: 3, a: NORTH_WALL }, { axis: 'v', line: 9, from: 5, to: 7, b: CROSSING },
  { axis: 'v', line: 18, from: 1, to: 3, a: NORTH_WALL }, { axis: 'v', line: 18, from: 5, to: 7, b: CROSSING },
  // Front row: Developer | spare room (door in the middle of the Developer wall) | QA / Reviewer and the spare room below it (a door in the middle
  // of each of their west walls).
  { axis: 'v', line: 9, from: 9, to: 12, a: CROSSING }, { axis: 'v', line: 9, from: 14, to: 18, b: 0 },
  { axis: 'v', line: 18, from: 9, to: 10, a: CROSSING }, { axis: 'v', line: 18, from: 12, to: 15 }, { axis: 'v', line: 18, from: 17, to: 18, b: 0 },
  // Splits the front-right room: QA / Reviewer above, a second spare room below, with a door in the middle.
  { axis: 'h', line: 14, from: 19, to: 22, a: CROSSING }, { axis: 'h', line: 14, from: 24, to: 27, b: 0 },
];
const runCells = (r: PartitionRun): Cell[] => Array.from({ length: r.to - r.from + 1 }, (_, i) => (r.axis === 'h' ? { gx: r.from + i, gy: r.line } : { gx: r.line, gy: r.from + i }));
/** Cells a partition stands on: nothing walks through them. */
export const PARTITION_CELLS: readonly Cell[] = PARTITION_RUNS.flatMap(runCells);
/** The one-cell gaps in the partitions (the rooms' doors). */
export const DOORWAY_CELLS: readonly Cell[] = [
  { gx: 4, gy: 8 }, { gx: 13, gy: 8 }, { gx: 14, gy: 8 }, { gx: 23, gy: 8 }, { gx: 9, gy: 4 }, { gx: 18, gy: 4 }, { gx: 9, gy: 13 }, { gx: 18, gy: 11 }, { gx: 18, gy: 16 }, { gx: 23, gy: 14 },
];
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
  bookcase_lux_w: { w: 2.9, d: 0.45 }, bookcase_lux_e: { w: 2.9, d: 0.45 }, statue: { w: 1.0, d: 0.5 }, sofa_lux: { w: 2.4, d: 0.95 }, tea_table: { w: 1.0, d: 0.6 }, rug_lux: { w: 3.4, d: 2.6 },
  meeting_chair: { w: 0.55, d: 0.55 }, globe: { w: 0.5, d: 0.5 }, painting: { w: 1.0, d: 0.05 }, floor_lamp: { w: 0.38, d: 0.38 }, printer: { w: 0.8, d: 0.5 }, paper_cabinet: { w: 0.8, d: 0.45 }, plant_tall: { w: 0.6, d: 0.6 }, plant_small: { w: 0.2, d: 0.2 }, pendant_lamp: { w: 0.7, d: 0.7 },
  whiteboard: { w: 2, d: 0.08 }, window: { w: 2.1, d: 0.16 }, wall_art: { w: 0.9, d: 0.03 },
};
export type DecorWall = 'north' | 'west' | 'east';
/**
 * Furniture and decoration. `mount`: `floor` (default) stands on the floor and blocks the cells it covers; `rug` lies under other pieces, `table` sits on a
 * table, `wall` hangs flush on `wall`, `ceiling` hangs 2.9 high; `off` shifts any piece (x, z) from its cell centre. A floor piece with `wall` stands flush against that wall;
 * `north` on a partition cell (gy > 0) means the south face of that partition.
 */
export interface DecorItem { node: string; cell: Cell; ry?: number; mount?: 'floor' | 'rug' | 'table' | 'wall' | 'ceiling'; wall?: DecorWall; off?: [number, number] }
const deco = (node: string, gx: number, gy: number, more: Partial<DecorItem> = {}): DecorItem => ({ node, cell: { gx, gy }, ...more });
export const DECOR: readonly DecorItem[] = [
  // Conversation, the chairman's office, mirror-symmetric about the desk's centre line (x 4.5): two wall-wide bookcases with the statue console
  // between them, a tall plant in each back corner, and in front of the desk two long sofas facing each other across a tea table on a rug, with a
  // reading lamp and a globe at their ends. A painting hangs on the west wall.
  deco('bookcase_lux_w', 2, 0, { wall: 'north' }), deco('statue', 4, 0, { wall: 'north' }), deco('bookcase_lux_e', 6, 0, { wall: 'north' }),
  deco('plant_tall', 1, 1), deco('plant_tall', 7, 1),
  deco('rug_lux', 4, 5, { mount: 'rug' }), deco('sofa_lux', 2, 5, { ry: Math.PI / 2 }), deco('tea_table', 4, 5, { ry: Math.PI / 2 }), deco('sofa_lux', 6, 5, { ry: -Math.PI / 2 }),
  deco('floor_lamp', 2, 7), deco('globe', 6, 7), deco('painting', 0, 1, { mount: 'wall', wall: 'west' }),
  // Coordination: mirror-symmetric about its centre line (x 14): the server in the middle of the back wall, a window either side, a bookshelf in
  // each back corner and a plant in each front corner (PLANT_CELLS).
  deco('bookshelf', 10, 0, { wall: 'north', off: [-0.4, 0] }), deco('window', 12, 0, { mount: 'wall', wall: 'north', off: [-0.5, 0] }),
  deco('window', 16, 0, { mount: 'wall', wall: 'north', off: [-0.5, 0] }), deco('bookshelf', 17, 0, { wall: 'north', off: [0.4, 0] }),
  // Task Board: twelve chairs round the long meeting table (five a side, one at each end). No ceiling lamps anywhere, so the view stays clear.
  deco('plant_tall', 19, 1), deco('plant_tall', 27, 1),
  ...TABLE_CELLS.flatMap(c => [deco('meeting_chair', c.gx, 3), deco('meeting_chair', c.gx, 5, { ry: Math.PI })]),
  deco('meeting_chair', 20, 4, { ry: Math.PI / 2 }), deco('meeting_chair', 26, 4, { ry: -Math.PI / 2 }),
  // Developer: a water cooler either side of the door from the Director room, against the north partition.
  deco('water_cooler', 3, 8, { wall: 'north' }), deco('water_cooler', 5, 8, { wall: 'north' }), deco('wall_art', 0, 13, { mount: 'wall', wall: 'west' }),
  // Verification: the print corner on the middle of the east wall, a printer and a paper cabinet either side under the whiteboard. The spare room
  // below stays empty.
  deco('printer', 27, 10, { wall: 'east' }), deco('whiteboard', 27, 11, { mount: 'wall', wall: 'east' }), deco('paper_cabinet', 27, 12, { wall: 'east' }),
];
const WALL_FACE = 0.07, PARTITION_FACE = 0.1, PENDANT_Y = 2.9, TABLE_Y = 0.41;
const WALL_RY: Readonly<Record<DecorWall, number>> = { north: 0, west: Math.PI / 2, east: -Math.PI / 2 };
/** World placement of a decor item: position (y is 0 for the floor) and rotation about y. */
export function decorPlacement(d: DecorItem): { x: number; y: number; z: number; ry: number } {
  const c = cellCentre(d.cell), size = DECOR_SIZE[d.node] ?? { w: 0.5, d: 0.5 };
  let { x, z } = c, ry = d.ry ?? 0, y = 0;
  if (d.wall) {
    ry = WALL_RY[d.wall];
    const inset = WALL_FACE + (d.mount === 'wall' ? 0 : size.d / 2);
    if (d.wall === 'north') z = d.cell.gy > 0 ? d.cell.gy + 0.5 + PARTITION_FACE + inset - WALL_FACE : inset; else if (d.wall === 'west') x = inset; else x = GRID_W - inset;
  }
  x += d.off?.[0] ?? 0; z += d.off?.[1] ?? 0;
  if (d.mount === 'table') y = TABLE_Y;
  if (d.mount === 'ceiling') y = PENDANT_Y;
  return { x, y, z, ry };
}
/**
 * The queue board of a Director layout: the existing whiteboard on the Verification east wall, made pickable. No new mesh or asset; it is not an
 * OBJECT_CELLS entry, so it never blocks a path. `size` is the pick volume (thin along x, the board's width along z).
 */
const WHITEBOARD = DECOR.find(d => d.node === 'whiteboard') as DecorItem;
export const QUEUE_BOARD: { node: 'whiteboard'; cell: Cell; at: Vec2; size: { w: number; h: number; d: number } } = {
  node: 'whiteboard', cell: WHITEBOARD.cell, at: { x: decorPlacement(WHITEBOARD).x - 0.3, z: decorPlacement(WHITEBOARD).z }, size: { w: 0.6, h: 2.2, d: 2.0 },
};

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

/** Developer rows that are always furnished, with or without a session. */
export const MIN_DEVELOPER_ROWS = 4;
export interface DeskPlan {
  /** Developer rows drawn: every row holding an occupied seat plus the next free row, at least MIN_DEVELOPER_ROWS. */
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
    if (c && seat !== 'conversation:conversation' && seat !== DIRECTOR_SEAT && !have.has(`${c.gx},${c.gy}`)) { have.add(`${c.gx},${c.gy}`); desks.push(c); }
  }
  const developerRows = Math.min(DEVELOPER_ROWS.length, Math.max(MIN_DEVELOPER_ROWS, Math.ceil(Math.min(maxDev, DEVELOPER_SEAT_COUNT) / cols) + 1));
  for (let n = 1; n <= Math.min(DEVELOPER_SEAT_COUNT, developerRows * cols); n++) desks.push(seatCell(`developer:${n}`) as Cell);
  return { developerRows, desks };
}

export type ZoneId = 'conversation' | 'coordination' | 'taskboard' | 'developer' | 'spare' | 'verification' | 'lobby';
export interface Zone { id: ZoneId; x0: number; y0: number; x1: number; y1: number }
/** Cell rectangles, inclusive. The developer zone is cut to the rows drawn. */
export function zones(developerRows: number): Zone[] {
  const rows = Math.max(1, Math.min(DEVELOPER_ROWS.length, developerRows));
  return [
    { id: 'conversation', x0: 0, y0: 1, x1: 8, y1: 7 },
    { id: 'coordination', x0: 10, y0: 1, x1: 17, y1: 7 },
    { id: 'taskboard', x0: 19, y0: 1, x1: 27, y1: 7 },
    { id: 'developer', x0: 0, y0: 9, x1: 8, y1: Math.min(GRID_H - 1, 9 + rows * 2) },
    { id: 'spare', x0: 10, y0: 9, x1: 17, y1: 18 },
    { id: 'verification', x0: 19, y0: 9, x1: 27, y1: 13 },
    { id: 'spare', x0: 19, y0: 15, x1: 27, y1: 18 },
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
  // A half-cell shifted desk (or object) also covers the cell west of its own.
  const spread = (c: Cell): Cell[] => (roomShift(c) < 0 ? [c, { gx: c.gx - 1, gy: c.gy }] : [c]);
  const blocked = new Set([...desks, ...FIXED_BLOCKS].flatMap(spread).map(c => `${c.gx},${c.gy}`));
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
/**
 * Zone titles for a layout: in a Director layout the control room (the old Conversation room) is titled Director and the coordination
 * room, whose specialists now work for the Director (there is no Coordinator), is the Director Team; legacy v2 keeps its titles.
 */
export const DIRECTOR_ZONE_TITLES: Readonly<Partial<Record<ZoneId, string>>> = { conversation: 'Director', coordination: 'Director Team' };
export function zoneTitles(director: boolean | undefined): { id: ZoneId; text: string }[] {
  return ZONE_TITLES.map(t => { const text = director === undefined ? ({ conversation: 'Điều hành', coordination: 'Chuyên môn' } as Partial<Record<ZoneId, string>>)[t.id] : director ? DIRECTOR_ZONE_TITLES[t.id] : undefined; return text ? { ...t, text } : t; });
}
export interface ZoneSign { id: ZoneId; text: string; x: number; y: number; z: number; w: number; h: number }
/** Signs face +z (south, towards the camera). Back rooms: on the north wall above head height; the board: on its top frame; front rooms: a lintel over the room's door, resting on the partition either side (clear of the water coolers below). */
const SIGN_AT: Readonly<Record<string, { x: number; y: number; z: number }>> = {
  conversation: { x: 4.5, y: 3.05, z: 0.14 }, coordination: { x: 14, y: 3.05, z: 0.14 }, taskboard: { x: BOARD_X, y: 3.4, z: 0.32 },
  developer: { x: 4.5, y: 1.6, z: 8.62 }, verification: { x: 23.5, y: 1.6, z: 8.62 },
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
  const z0 = 0, z1 = Math.min(GRID_H, Math.max(...cells.map(c => c.gy)) + 2);
  return { w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

/** Camera presets of the HUD (bottom-left buttons). `overview` is the home view; the rest frame one room. */
export const FOCUS_POINTS: Readonly<Record<Exclude<OfficeFocusZone, 'overview'>, { at: Vec2; zoom: number }>> = {
  conversation: { at: { x: 4.5, z: 4 }, zoom: 2.3 },
  coordinator: { at: { x: 14, z: 4 }, zoom: 2.3 },
  developer: { at: { x: 4.5, z: 14 }, zoom: 2.0 },
  qa: { at: { x: 23.5, z: 11.5 }, zoom: 2.2 },
};
