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
  cabinet: { gx: 8, gy: 0 },
  server: { gx: 18, gy: 0 },
  settings: { gx: 19, gy: 8 },
  door: { gx: 0, gy: 7 },
};
/** World x of the centre of the Task Board zone, where the board hangs. */
export const BOARD_X = 23.5;

/** Fixed desks that are always drawn: one per fixed role except Conversation (its seat is the reception counter). */
const BASE_DESKS: readonly Cell[] = Object.entries(FIXED_BASES).filter(([k]) => k !== 'conversation:conversation').map(([, c]) => c);

/** Non-interactive decoration that blocks a cell. */
export const PLANT_CELLS: readonly Cell[] = [{ gx: 1, gy: 1 }, { gx: 9, gy: 7 }, { gx: 18, gy: 7 }, { gx: 27, gy: 8 }, { gx: 1, gy: 17 }, { gx: 27, gy: 17 }];
/** The standing meeting table of the Task Board zone, two cells wide. */
export const TABLE_CELLS: readonly Cell[] = [{ gx: 23, gy: 4 }, { gx: 24, gy: 4 }];

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

/** Cells other than desks that nothing may cross: interactive objects, plants and the meeting table. */
const FIXED_BLOCKS: readonly Cell[] = [...Object.values(OBJECT_CELLS), ...PLANT_CELLS, ...TABLE_CELLS];

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

/** Camera presets of the HUD (bottom-left buttons). `overview` is the home view; the rest frame one room. */
export const FOCUS_POINTS: Readonly<Record<Exclude<OfficeFocusZone, 'overview'>, { at: Vec2; zoom: number }>> = {
  conversation: { at: { x: 4.5, z: 4 }, zoom: 2.3 },
  coordinator: { at: { x: 13.5, z: 4 }, zoom: 2.3 },
  developer: { at: { x: 9.5, z: 12.5 }, zoom: 1.7 },
  qa: { at: { x: 23.5, z: 12.5 }, zoom: 1.9 },
};
