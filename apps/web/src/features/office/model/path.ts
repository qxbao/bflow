// Pure 4-directional A* on a fixed walkable grid. No dynamic collision avoidance: characters may cross.
export interface Cell { x: number; y: number }
/** `grid[y][x]` is true when the cell is walkable. */
export type Grid = readonly (readonly boolean[])[];

const DIRS: readonly Cell[] = [{ x: 0, y: -1 }, { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];

/** Shortest path including both endpoints, or [] when either end is blocked/outside or unreachable. */
export function findPath(grid: Grid, from: Cell, to: Cell): Cell[] {
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;
  const ok = (c: Cell): boolean => c.x >= 0 && c.y >= 0 && c.x < w && c.y < h && grid[c.y][c.x] === true;
  if (!ok(from) || !ok(to)) return [];
  const key = (c: Cell): number => c.y * w + c.x;
  const dist = (c: Cell): number => Math.abs(c.x - to.x) + Math.abs(c.y - to.y);
  const g = new Map<number, number>([[key(from), 0]]);
  const parent = new Map<number, Cell>();
  const closed = new Set<number>();
  const open: { c: Cell; f: number; n: number }[] = [{ c: from, f: dist(from), n: 0 }];
  let seq = 1;
  while (open.length > 0) {
    // Tie-break on lower f, then lower h, then insertion order: deterministic for equal input.
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i];
      const b = open[best];
      if (a.f < b.f || (a.f === b.f && (dist(a.c) < dist(b.c) || (dist(a.c) === dist(b.c) && a.n < b.n)))) best = i;
    }
    const { c } = open.splice(best, 1)[0];
    const ck = key(c);
    if (closed.has(ck)) continue;
    closed.add(ck);
    if (c.x === to.x && c.y === to.y) {
      const path: Cell[] = [c];
      for (let p = parent.get(ck); p; p = parent.get(key(p))) path.unshift(p);
      return path;
    }
    for (const d of DIRS) {
      const nb = { x: c.x + d.x, y: c.y + d.y };
      if (!ok(nb) || closed.has(key(nb))) continue;
      const ng = (g.get(ck) ?? 0) + 1;
      if (ng >= (g.get(key(nb)) ?? Infinity)) continue;
      g.set(key(nb), ng);
      parent.set(key(nb), c);
      open.push({ c: nb, f: ng + dist(nb), n: seq++ });
    }
  }
  return [];
}
