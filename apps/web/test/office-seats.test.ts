import { describe, expect, test } from 'vitest';
import { assignSeats } from '../src/features/office/model/seats';
import type { OfficeAgent, OfficeRole, SeatMap } from '../src/features/office/model/types';

const agent = (instanceId: string, role: OfficeRole = 'developer', label = `${role} ${instanceId}`): OfficeAgent => ({
  instanceId, label, role, pose: 'sleeping', certainty: 'inferred', statusText: 'Rảnh',
});
const devs = (n: number, prefix = 'dev'): OfficeAgent[] => Array.from({ length: n }, (_, i) => agent(`${prefix}-${i + 1}`));
const seatOf = (map: SeatMap, instanceId: string): string | undefined => map.entries.find(e => e.instanceId === instanceId)?.seat;

describe('assignSeats', () => {
  test('seat is stable while instance lives', () => {
    const first = assignSeats({ entries: [], overflow: 0 }, [agent('a'), agent('b'), agent('c')]);
    const seatA = seatOf(first, 'a');
    const seatB = seatOf(first, 'b');
    expect(seatA).toBeDefined();
    expect(seatB).toBeDefined();
    expect(seatA).not.toBe(seatB);

    // Reordered input, a new instance joins, and a peer leaves: surviving instances keep their seats.
    const second = assignSeats(first, [agent('c'), agent('d'), agent('a')]);
    expect(seatOf(second, 'a')).toBe(seatA);
    expect(seatOf(second, 'c')).toBe(seatOf(first, 'c'));
    expect(seatOf(second, 'b')).toBeUndefined();
    expect(seatOf(second, 'd')).toBeDefined();
    expect(seatOf(second, 'd')).not.toBe(seatA);

    // The seat released by b is reused by the new instance d (the lowest free seat).
    expect(seatOf(second, 'd')).toBe(seatOf(first, 'b'));

    // Surviving instances still keep their seats after a further change.
    const third = assignSeats(second, [agent('a'), agent('c'), agent('d'), agent('e')]);
    expect(seatOf(third, 'a')).toBe(seatA);
    expect(seatOf(third, 'c')).toBe(seatOf(first, 'c'));
    expect(seatOf(third, 'd')).toBe(seatOf(second, 'd'));
    expect(seatOf(third, 'e')).not.toBe(seatOf(third, 'd'));
  });

  test('failover replaces instance without merging identity', () => {
    const before = assignSeats({ entries: [], overflow: 0 }, [agent('dev-old', 'developer', 'Developer #1')]);
    const oldSeat = seatOf(before, 'dev-old');

    // Old instance gone, new instance of the same role appears: it is a new occupant with its own entry.
    const after = assignSeats(before, [agent('dev-new', 'developer', 'Developer #1')]);
    expect(seatOf(after, 'dev-old')).toBeUndefined();
    expect(seatOf(after, 'dev-new')).toBe(oldSeat);
    expect(after.entries.map(e => e.instanceId)).toEqual(['dev-new']);

    // While both instances are visible at once, they never share a seat.
    const overlap = assignSeats(before, [agent('dev-old'), agent('dev-new')]);
    expect(seatOf(overlap, 'dev-old')).toBe(oldSeat);
    expect(seatOf(overlap, 'dev-new')).toBeDefined();
    expect(seatOf(overlap, 'dev-new')).not.toBe(oldSeat);
  });

  test('overflow beyond capacity reports count', () => {
    // 6 main + 12 annex = 18 Developer seats; main seats fill before annex.
    const twenty = assignSeats({ entries: [], overflow: 0 }, devs(20));
    expect(twenty.entries).toHaveLength(18);
    expect(twenty.overflow).toBe(2);
    const seats = twenty.entries.map(e => e.seat);
    expect(new Set(seats).size).toBe(18);
    expect(seats.filter(s => s.startsWith('developer:'))).toHaveLength(6);
    expect(seats.filter(s => s.startsWith('annex:'))).toHaveLength(12);
    expect(seatOf(twenty, 'dev-19')).toBeUndefined();

    // Exactly 18 Developers: no overflow.
    expect(assignSeats({ entries: [], overflow: 0 }, devs(18)).overflow).toBe(0);

    // A seated Developer leaves: the unseated one takes the freed seat and the overflow drops.
    const after = assignSeats(twenty, devs(20).filter(a => a.instanceId !== 'dev-1'));
    expect(after.overflow).toBe(1);
    expect(seatOf(after, 'dev-1')).toBeUndefined();
    expect(seatOf(after, 'dev-19')).toBeDefined();
  });

  test('fixed roles take numbered seats in their zone and do not count as overflow', () => {
    const map = assignSeats({ entries: [], overflow: 0 }, [
      agent('coord', 'coordinator'),
      agent('rev-1', 'reviewer'),
      agent('rev-2', 'reviewer'),
      agent('conv', 'conversation'),
      ...devs(19),
    ]);
    expect(seatOf(map, 'coord')).toBe('coordination:coordinator');
    expect(seatOf(map, 'rev-1')).toBe('verification:reviewer');
    expect(seatOf(map, 'rev-2')).toBe('verification:reviewer:2');
    expect(seatOf(map, 'conv')).toBe('conversation:conversation');
    expect(map.overflow).toBe(1);
  });

  test('custom profile keeps base role sprite and own label', () => {
    // A custom specialist profile is a developer-role instance with its own displayName.
    const custom: OfficeAgent = agent('custom-1', 'developer', 'Kiểm thử bảo mật');
    const before = structuredClone(custom);
    const map = assignSeats({ entries: [], overflow: 0 }, [custom]);
    expect(seatOf(map, 'custom-1')).toMatch(/^(developer|annex):\d+$/);
    // Seat assignment does not alter the agent: sprite role and label stay as they were.
    expect(custom).toEqual(before);
    expect(custom.role).toBe('developer');
    expect(custom.label).toBe('Kiểm thử bảo mật');
  });

  test('is pure: never mutates previous or agents', () => {
    const previous = assignSeats({ entries: [], overflow: 0 }, [agent('a'), agent('b')]);
    const snapshot = structuredClone(previous);
    const agents = [agent('b'), agent('c')];
    const agentsSnapshot = structuredClone(agents);
    const next = assignSeats(previous, agents);
    expect(previous).toEqual(snapshot);
    expect(agents).toEqual(agentsSnapshot);
    expect(next).not.toBe(previous);
    // Plain serialisable data.
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });
});
