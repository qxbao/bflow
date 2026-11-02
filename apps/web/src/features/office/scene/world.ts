// Pure layout of the 3D office (§5.1, reference layout 2026-11-02). No three.js here, so the layout is unit-testable and
// the renderer stays a drawing layer. One grid cell is one world unit; cell (gx, gy) has its centre at x = gx + 0.5, z = gy + 0.5.
// Rooms (north is the far wall, the camera looks from the south):
//   back row  : Conversation | Coordination (Coordinator, Planner, Architect, Specifier) | Task Board
//   front row : Developer zone (20 seats, rows appear as agents arrive)       | Verification (Reviewer, QA, Tester, Security)
import { findPath } from '../model/path';
import type { OfficeObjectId } from '../model/types';

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

/** Developer pool: 20 seats, filled row by row. */
export const DEVELOPER_COLUMNS = [3, 6, 9, 12, 15] as const;
export const DEVELOPER_ROWS = [10, 12, 14, 16] as const;
export const DEVELOPER_SEAT_COUNT = DEVELOPER_COLUMNS.length * DEVELOPER_ROWS.length;

const FIXED_BASES: Readonly<Record<string, Cell>> = {
  'conversation:conversation': { gx: 4, gy: 3 },
  'coordination:planner': { gx: 11, gy: 3 },
  'coordination:coordinator': { gx: 13, gy: 3 },
  'coordination:architect': { gx: 15, gy: 3 },
  'coordination:specifier': { gx: 17, gy: 3 },
  'verification:reviewer': { gx: 22, gy: 10 },
  'verification:qa': { gx: 25, gy: 10 },
  'verification:tester': { gx: 22, gy: 15 },
  'verification:security': { gx: 25, gy: 15 },
};

/** Cell of a seat id from `assignSeats` (`developer:3`, `verification:reviewer:2`), or undefined when unknown. */
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
  const origin = FIXED_BASES[`${zone}:${name}`];
  const extra = Number(k);
  if (!origin || !Number.isInteger(extra) || extra < 2) return undefined;
  // Further instances of a fixed role queue down the room behind the first desk, one desk row (2 cells) apart.
  const cell = { gx: origin.gx, gy: origin.gy + 2 * (extra - 1) };
  return cell.gy < GRID_H - 1 ? cell : undefined;
}

/** Interactive objects (§5.3) and where they stand. The task board is a wall display; `counter` is the Conversation reception desk. */
export const OBJECT_CELLS: Readonly<Record<OfficeObjectId, Cell>> = {
  counter: { gx: 4, gy: 3 },
  board: { gx: 23, gy: 0 },
  mailbox: { gx: 7, gy: 2 },
  cabinet: { gx: 9, gy: 1 },
  server: { gx: 19, gy: 1 },
  settings: { gx: 8, gy: 7 },
  door: { gx: 0, gy: 7 },
};

/** Desks (the Conversation seat is the reception counter, not a desk). */
export const DESK_CELLS: readonly Cell[] = [
  ...Object.entries(FIXED_BASES).filter(([k]) => k !== 'conversation:conversation').map(([, c]) => c),
  ...Array.from({ length: DEVELOPER_SEAT_COUNT }, (_, i) => seatCell(`developer:${i + 1}`) as Cell),
];

/** Non-interactive decoration. */
export const PLANT_CELLS: readonly Cell[] = [{ gx: 1, gy: 1 }, { gx: 9, gy: 8 }, { gx: 20, gy: 8 }, { gx: 26, gy: 8 }, { gx: 1, gy: 17 }, { gx: 26, gy: 17 }];

export type ZoneId = 'conversation' | 'coordination' | 'taskboard' | 'developer' | 'verification' | 'lobby';
export interface Zone { id: ZoneId; x0: number; y0: number; x1: number; y1: number }
/** Cell rectangles, inclusive. The developer zone is cut to the rows in use by `developerRows`. */
export function zones(developerRows: number): Zone[] {
  const rows = Math.max(1, Math.min(DEVELOPER_ROWS.length, developerRows));
  return [
    { id: 'conversation', x0: 1, y0: 1, x1: 8, y1: 6 },
    { id: 'coordination', x0: 10, y0: 1, x1: 18, y1: 6 },
    { id: 'taskboard', x0: 20, y0: 1, x1: 26, y1: 6 },
    { id: 'developer', x0: 1, y0: 9, x1: 18, y1: 9 + rows * 2 },
    { id: 'verification', x0: 20, y0: 9, x1: 26, y1: 16 },
  ];
}
/** Rows of the Developer zone needed for `count` Developers (at least one, so the zone is always visible). */
export const developerRowsFor = (count: number): number => Math.max(1, Math.min(DEVELOPER_ROWS.length, Math.ceil(count / DEVELOPER_COLUMNS.length)));

export function zoneAt(c: Cell, developerRows: number = DEVELOPER_ROWS.length): ZoneId {
  for (const z of zones(developerRows)) if (c.gx >= z.x0 && c.gx <= z.x1 && c.gy >= z.y0 && c.gy <= z.y1) return z.id;
  return 'lobby';
}

/** Fixed walkable grid: every cell except desks, interactive objects and plants. Built once; never mutated. */
const BLOCKED: ReadonlySet<string> = new Set([...DESK_CELLS, ...Object.values(OBJECT_CELLS), ...PLANT_CELLS].map(c => `${c.gx},${c.gy}`));

/**
 * Shortest 4-directional route between two cells (both included), or [] when unreachable. A seat or object cell is blocked for
 * passers-by, but the two endpoints of a walk are opened for it: a character stands up from its desk and walks to the other desk.
 */
export function routeBetween(from: Cell, to: Cell): Cell[] {
  const open = new Set([`${from.gx},${from.gy}`, `${to.gx},${to.gy}`]);
  const grid = Array.from({ length: GRID_H }, (_, y) => Array.from({ length: GRID_W }, (_, x) => open.has(`${x},${y}`) || !BLOCKED.has(`${x},${y}`)));
  return findPath(grid, { x: from.gx, y: from.gy }, { x: to.gx, y: to.gy }).map(c => ({ gx: c.x, gy: c.y }));
}

export const OFFICE_ASSET_PATHS = { character: 'office/character.glb', furniture: 'office/furniture.glb' } as const;
