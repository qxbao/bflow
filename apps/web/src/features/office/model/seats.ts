// Pure seat assignment. No React, Pixi, fetch or clock; the result is plain data and inputs are never mutated.
import type { OfficeAgent, OfficeRole, SeatMap } from './types';

/** Developer pool: 6 main seats, then 12 annex seats. Main seats fill first. */
export const DEVELOPER_SEATS: readonly string[] = [
  ...Array.from({ length: 6 }, (_, i) => `developer:${i + 1}`),
  ...Array.from({ length: 12 }, (_, i) => `annex:${i + 1}`),
];

/** Zone of each fixed (non-Developer) role, following the §5.1 rooms. */
const FIXED_ZONE: Readonly<Record<Exclude<OfficeRole, 'developer'>, string>> = {
  conversation: 'conversation',
  coordinator: 'coordination', planner: 'coordination', architect: 'coordination', specifier: 'coordination',
  reviewer: 'verification', qa: 'verification', tester: 'verification', security: 'verification',
};

const fixedBase = (role: Exclude<OfficeRole, 'developer'>): string => `${FIXED_ZONE[role]}:${role}`;
/** The k-th instance of a fixed role: `zone:role`, then `zone:role:2`, `zone:role:3`, ... */
const fixedSeat = (base: string, k: number): string => (k === 1 ? base : `${base}:${k}`);

/** Whether a previously assigned seat is still valid for this role. Guards against a stale or foreign seat. */
function fits(role: OfficeRole, seat: string): boolean {
  if (role === 'developer') return DEVELOPER_SEATS.includes(seat);
  const base = fixedBase(role);
  if (seat === base) return true;
  if (!seat.startsWith(`${base}:`)) return false;
  const k = Number(seat.slice(base.length + 1));
  return Number.isInteger(k) && k >= 2 && fixedSeat(base, k) === seat;
}

/**
 * Stable seat assignment keyed by instanceId only. A surviving instance keeps its seat; a seat is released
 * when its instance disappears and is then reusable by a later new instance. Failover is a new instance,
 * so it is never merged with the instance it replaces. Developers beyond the 18 Developer seats are counted
 * in `overflow`.
 *
 * @param previous The map returned by the last call (or an empty map). Never mutated.
 * @param agents The currently visible instances, in the order new instances should take free seats.
 */
export function assignSeats(previous: SeatMap, agents: readonly OfficeAgent[]): SeatMap {
  const roleOf = new Map(agents.map(a => [a.instanceId, a.role] as const));
  const claimed = new Set<string>();
  const seatOf = new Map<string, string>();

  // Keep the seat of every instance that is still visible and whose seat still fits its role.
  for (const entry of previous.entries) {
    const role = roleOf.get(entry.instanceId);
    if (role === undefined || seatOf.has(entry.instanceId) || claimed.has(entry.seat) || !fits(role, entry.seat)) continue;
    claimed.add(entry.seat);
    seatOf.set(entry.instanceId, entry.seat);
  }

  // New instances take the lowest free seat of their pool.
  for (const agent of agents) {
    if (seatOf.has(agent.instanceId)) continue;
    const seat = agent.role === 'developer' ? freeDeveloperSeat(claimed) : freeFixedSeat(agent.role, claimed);
    if (seat === undefined) continue;
    claimed.add(seat);
    seatOf.set(agent.instanceId, seat);
  }

  const entries: SeatMap['entries'] = [];
  let overflow = 0;
  for (const agent of agents) {
    const seat = seatOf.get(agent.instanceId);
    if (seat !== undefined) entries.push({ instanceId: agent.instanceId, seat });
    else if (agent.role === 'developer') overflow += 1;
  }
  return { entries, overflow };
}

function freeDeveloperSeat(claimed: ReadonlySet<string>): string | undefined {
  return DEVELOPER_SEATS.find(seat => !claimed.has(seat));
}

function freeFixedSeat(role: Exclude<OfficeRole, 'developer'>, claimed: ReadonlySet<string>): string {
  const base = fixedBase(role);
  let k = 1;
  while (claimed.has(fixedSeat(base, k))) k += 1;
  return fixedSeat(base, k);
}
