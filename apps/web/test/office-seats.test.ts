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
    // 20 Developer seats, filled in order.
    const many = assignSeats({ entries: [], overflow: 0 }, devs(22));
    expect(many.entries).toHaveLength(20);
    expect(many.overflow).toBe(2);
    const seats = many.entries.map(e => e.seat);
    expect(new Set(seats).size).toBe(20);
    expect(seats.every(s => /^developer:\d+$/.test(s))).toBe(true);
    expect(seatOf(many, 'dev-21')).toBeUndefined();

    // Exactly 20 Developers: no overflow.
    expect(assignSeats({ entries: [], overflow: 0 }, devs(20)).overflow).toBe(0);

    // A seated Developer leaves: the unseated one takes the freed seat and the overflow drops.
    const after = assignSeats(many, devs(22).filter(a => a.instanceId !== 'dev-1'));
    expect(after.overflow).toBe(1);
    expect(seatOf(after, 'dev-1')).toBeUndefined();
    expect(seatOf(after, 'dev-21')).toBeDefined();
  });

  test('fixed roles take numbered seats in their zone and do not count as overflow until spare seats are exhausted', () => {
    const map = assignSeats({ entries: [], overflow: 0 }, [
      agent('coord', 'coordinator'),
      agent('rev-1', 'reviewer'),
      agent('rev-2', 'reviewer'),
      agent('conv', 'conversation'),
      ...devs(21),
    ]);
    expect(seatOf(map, 'coord')).toBe('coordination:coordinator');
    expect(seatOf(map, 'rev-1')).toBe('verification:reviewer');
    expect(seatOf(map, 'rev-2')).toBe('verification:reviewer:2');
    expect(seatOf(map, 'conv')).toBe('conversation:conversation');
    expect(map.overflow).toBe(1);

    // Fixed roles beyond their available 3D seats leave seat undefined and count in overflow instead of getting phantom seats.
    const specialists = assignSeats({ entries: [], overflow: 0 }, [
      agent('arch-1', 'architect'),
      agent('arch-2', 'architect'),
      agent('rev-1', 'reviewer'),
      agent('rev-2', 'reviewer'),
      agent('rev-3', 'reviewer'),
    ]);
    expect(seatOf(specialists, 'arch-1')).toBe('coordination:architect');
    expect(seatOf(specialists, 'arch-2')).toBeUndefined();
    expect(seatOf(specialists, 'rev-1')).toBe('verification:reviewer');
    expect(seatOf(specialists, 'rev-2')).toBe('verification:reviewer:2');
    expect(seatOf(specialists, 'rev-3')).toBeUndefined();
    expect(specialists.overflow).toBe(2);
  });

  test('active allocations take primary seats before stopped_retained or released allocations', () => {
    const initial = assignSeats({ entries: [], overflow: 0 }, [
      { ...agent('arch-old', 'architect'), allocation: 'stopped_retained' },
      { ...agent('arch-active', 'architect'), allocation: 'active' },
    ]);
    expect(seatOf(initial, 'arch-active')).toBe('coordination:architect');
    expect(seatOf(initial, 'arch-old')).toBeUndefined();
    expect(initial.overflow).toBe(1);

    // When a previously active occupant transitions to stopped_retained and a failover active instance arrives,
    // the active replacement gets the primary seat and the retained instance moves to the spare seat (or overflows if none exists).
    const before = assignSeats({ entries: [], overflow: 0 }, [{ ...agent('qa-1', 'qa'), allocation: 'active' }]);
    expect(seatOf(before, 'qa-1')).toBe('verification:qa');
    const after = assignSeats(before, [
      { ...agent('qa-1', 'qa'), allocation: 'stopped_retained' },
      { ...agent('qa-2', 'qa'), allocation: 'active' },
    ]);
    expect(seatOf(after, 'qa-2')).toBe('verification:qa');
    expect(seatOf(after, 'qa-1')).toBe('verification:qa:2');
  });

  test('custom profile keeps base role sprite and own label', () => {
    // A custom specialist profile is a developer-role instance with its own displayName.
    const custom: OfficeAgent = agent('custom-1', 'developer', 'Kiểm thử bảo mật');
    const before = structuredClone(custom);
    const map = assignSeats({ entries: [], overflow: 0 }, [custom]);
    expect(seatOf(map, 'custom-1')).toMatch(/^developer:\d+$/);
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

describe('Director desk seat (C/D Task 7)', () => {
  test('the director option reserves the executive desk; without it legacy seating is unchanged', () => {
    const conv = [agent('c1', 'conversation'), agent('c2', 'conversation')];
    expect(assignSeats({ entries: [], overflow: 0 }, conv).entries.map(e => e.seat)).toEqual(['conversation:conversation', 'conversation:conversation:2']);
    expect(assignSeats({ entries: [], overflow: 0 }, conv, { director: true }).entries.map(e => e.seat)).toEqual(['conversation:conversation:2', 'conversation:conversation:3']);
    expect(assignSeats({ entries: [], overflow: 0 }, devs(3), { director: true })).toEqual(assignSeats({ entries: [], overflow: 0 }, devs(3)));
  });
});
