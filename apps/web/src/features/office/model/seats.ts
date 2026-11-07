// Pure seat assignment. No React, three.js, fetch or clock; the result is plain data and inputs are never mutated.
import { seatCell } from '../scene/world';
import type { OfficeAgent, OfficeModel, OfficeRole, SeatMap } from './types';

export type SeatableAgent = OfficeAgent & { allocation?: 'active' | 'released' | 'stopped_retained' | undefined };

/** Developer pool: 20 seats, filled in order (the 3D Developer zone adds a row of six desks per sixth agent). */
export const DEVELOPER_SEATS: readonly string[] = Array.from({ length: 20 }, (_, i) => `developer:${i + 1}`);

/** The Director desk (a UI entity, not an agent): the existing executive desk of the control room, i.e. the Conversation base cell. */
export const DIRECTOR_SEAT = 'control:director';
/** The fixed seat the Director desk occupies; a stray conversation instance in a Director layout takes a spare seat instead. */
const DIRECTOR_CELL_SEAT = 'conversation:conversation';

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
  if (seatCell(seat) === undefined) return false;
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
 * so it is never merged with the instance it replaces. Active allocations take priority over stopped_retained
 * or released allocations for primary seats. Any instance beyond the available 3D seats is counted in `overflow`.
 *
 * @param previous The map returned by the last call (or an empty map). Never mutated.
 * @param agents The currently visible instances, in the order new instances should take free seats.
 */
export function assignSeats(previous: SeatMap, agents: readonly SeatableAgent[], options: { director?: boolean; activeIds?: ReadonlySet<string> | undefined } = {}): SeatMap {
  const roleOf = new Map(agents.map(a => [a.instanceId, a.role] as const));
  const isActive = (id: string, a?: SeatableAgent): boolean => {
    if (options.activeIds !== undefined) return options.activeIds.has(id);
    return a?.allocation !== 'stopped_retained' && a?.allocation !== 'released';
  };
  const agentById = new Map(agents.map(a => [a.instanceId, a] as const));
  // The Director desk holds the executive desk first, so no agent is ever drawn on top of it.
  const claimed = new Set<string>(options.director ? [DIRECTOR_CELL_SEAT] : []);
  const seatOf = new Map<string, string>();

  const retainSeats = (wantActive: boolean): void => {
    for (const entry of previous.entries) {
      const role = roleOf.get(entry.instanceId);
      if (role === undefined || isActive(entry.instanceId, agentById.get(entry.instanceId)) !== wantActive) continue;
      if (seatOf.has(entry.instanceId) || claimed.has(entry.seat) || !fits(role, entry.seat)) continue;
      claimed.add(entry.seat);
      seatOf.set(entry.instanceId, entry.seat);
    }
  };

  const assignNewSeats = (wantActive: boolean): void => {
    for (const agent of agents) {
      if (seatOf.has(agent.instanceId) || isActive(agent.instanceId, agent) !== wantActive) continue;
      const seat = agent.role === 'developer' ? freeDeveloperSeat(claimed) : freeFixedSeat(agent.role, claimed);
      if (seat === undefined) continue;
      claimed.add(seat);
      seatOf.set(agent.instanceId, seat);
    }
  };

  // Active allocations keep and claim primary seats before retained/released instances.
  retainSeats(true);
  assignNewSeats(true);
  retainSeats(false);
  assignNewSeats(false);

  const entries: SeatMap['entries'] = [];
  let overflow = 0;
  for (const agent of agents) {
    const seat = seatOf.get(agent.instanceId);
    if (seat !== undefined) entries.push({ instanceId: agent.instanceId, seat });
    else overflow += 1;
  }
  return { entries, overflow };
}

function freeDeveloperSeat(claimed: ReadonlySet<string>): string | undefined {
  return DEVELOPER_SEATS.find(seat => !claimed.has(seat));
}

function freeFixedSeat(role: Exclude<OfficeRole, 'developer'>, claimed: ReadonlySet<string>): string | undefined {
  const base = fixedBase(role);
  let k = 1;
  while (claimed.has(fixedSeat(base, k))) k += 1;
  const seat = fixedSeat(base, k);
  return seatCell(seat) !== undefined ? seat : undefined;
}

/** Returns the model with `seat` filled from a fresh assignment, and the map to pass as `previous` next time. Inputs are not mutated. */
export function applySeats(previous: SeatMap, model: OfficeModel, activeIds?: ReadonlySet<string>): { model: OfficeModel; seats: SeatMap } {
  const seats = assignSeats(previous, model.agents, { director: model.director !== undefined, activeIds });
  const seatOf = new Map(seats.entries.map(e => [e.instanceId, e.seat] as const));
  const agents = model.agents.map(a => { const seat = seatOf.get(a.instanceId); return seat === undefined ? a : { ...a, seat }; });
  return { seats, model: { ...model, agents, ...(model.director ? { director: { ...model.director, seat: DIRECTOR_SEAT } } : {}) } };
}
