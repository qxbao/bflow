// Pure layout of the static office (§5.1): grid, isometric projection, seat cells, object cells and draw order.
// No Pixi here, so the layout is unit-testable and the renderer stays a thin drawing layer.
import { findPath } from '../model/path';
import type { OfficeObjectId } from '../model/types';

export const GRID_W = 28;
export const GRID_H = 20;
export const TILE_W = 32;
export const TILE_H = 16;
/** Height of the tallest wall/furniture sprite above its tile, used for world bounds. */
const HEADROOM = 56;

export interface Point { x: number; y: number }
export interface Cell { gx: number; gy: number }

/** Screen position (world pixels, origin at the grid's top corner) of a tile's centre. */
export function cellCentre(c: Cell): Point {
  return { x: (c.gx - c.gy) * (TILE_W / 2) + GRID_H * (TILE_W / 2), y: (c.gx + c.gy) * (TILE_H / 2) + HEADROOM + TILE_H / 2 };
}

/** World size in pixels. */
export const WORLD: { w: number; h: number } = {
  w: (GRID_W + GRID_H) * (TILE_W / 2),
  h: (GRID_W + GRID_H) * (TILE_H / 2) + HEADROOM + TILE_H / 2,
};

const FIXED_BASES: Readonly<Record<string, Cell>> = {
  'conversation:conversation': { gx: 4, gy: 10 },
  'coordination:coordinator': { gx: 9, gy: 2 },
  'coordination:planner': { gx: 9, gy: 4 },
  'coordination:architect': { gx: 12, gy: 2 },
  'coordination:specifier': { gx: 12, gy: 4 },
  'verification:reviewer': { gx: 17, gy: 2 },
  'verification:qa': { gx: 19, gy: 2 },
  'verification:tester': { gx: 21, gy: 2 },
  'verification:security': { gx: 23, gy: 2 },
};

/** Cell of a seat id from `assignSeats` (`developer:3`, `annex:5`, `verification:reviewer:2`), or undefined when unknown. */
export function seatCell(seat: string): Cell | undefined {
  const base = FIXED_BASES[seat];
  if (base) return base;
  const [zone, name, k] = seat.split(':');
  if (zone === 'developer' || zone === 'annex') {
    const n = Number(name);
    if (!Number.isInteger(n) || n < 1 || k !== undefined) return undefined;
    const i = n - 1;
    if (zone === 'developer') return i < 6 ? { gx: 17 + (i % 3) * 2, gy: 8 + Math.floor(i / 3) * 2 } : undefined;
    return i < 12 ? { gx: 23 + (i % 3) * 2, gy: 7 + Math.floor(i / 3) * 2 } : undefined;
  }
  const origin = FIXED_BASES[`${zone}:${name}`];
  const extra = Number(k);
  if (!origin || !Number.isInteger(extra) || extra < 2) return undefined;
  // Further instances of a fixed role queue down the room, three per column.
  const n = extra - 1;
  const cell = { gx: origin.gx + Math.floor(n / 3), gy: origin.gy + (n % 3) };
  return cell.gx < GRID_W && cell.gy < GRID_H ? cell : undefined;
}

/** Interactive objects (§5.3) and where they stand. */
export const OBJECT_CELLS: Readonly<Record<OfficeObjectId, Cell>> = {
  counter: { gx: 3, gy: 8 },
  board: { gx: 9, gy: 8 },
  mailbox: { gx: 3, gy: 17 },
  cabinet: { gx: 9, gy: 17 },
  server: { gx: 15, gy: 17 },
  settings: { gx: 21, gy: 17 },
  door: { gx: 0, gy: 10 },
};

/** Every desk of the layout: one per fixed-role seat and per Developer/annex seat, whether or not an agent sits there. */
export const DESK_CELLS: readonly Cell[] = [
  ...Object.values(FIXED_BASES),
  ...Array.from({ length: 6 }, (_, i) => seatCell(`developer:${i + 1}`) as Cell),
  ...Array.from({ length: 12 }, (_, i) => seatCell(`annex:${i + 1}`) as Cell),
];

/** Non-interactive decoration. */
export const PLANT_CELLS: readonly Cell[] = [{ gx: 7, gy: 7 }, { gx: 14, gy: 6 }, { gx: 26, gy: 5 }, { gx: 1, gy: 15 }, { gx: 26, gy: 17 }];

/** Rooms painted with a different floor, following §5.1. */
export function isRug(c: Cell): boolean {
  const inside = (x0: number, y0: number, x1: number, y1: number): boolean => c.gx >= x0 && c.gx <= x1 && c.gy >= y0 && c.gy <= y1;
  return inside(8, 1, 13, 5) || inside(16, 1, 25, 4) || inside(16, 7, 22, 11);
}

/** Draw order within one layer: lower on screen is in front. Characters sit one step in front of the furniture on their cell. */
export function depth(c: Cell, layer: 'object' | 'agent'): number {
  return (c.gx + c.gy) * 10 + (layer === 'agent' ? 5 : 0);
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

export const ATLAS_URL_PATH = 'office/atlas.json';
export const ROLE_FRAME = (role: string): string => `agent_${role}`;
export const BUBBLE_FRAME = { waiting: 'bubble_waiting', question: 'bubble_question', blocked: 'bubble_blocked' } as const;
