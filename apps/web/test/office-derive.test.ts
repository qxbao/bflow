import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebWorkforceViewSchema, WebDecisionSchema, WebRunViewSchema, type WebAgentView, type WebAgentWork, type WebWorkforceView } from '@bflow/contracts/web';
import { deriveOffice } from '../src/features/office/model/derive';
import type { OfficeInput } from '../src/features/office/model/types';

const fixture = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), '../../packages/contracts/test/fixtures/local-web', name), 'utf8'));
const full: WebWorkforceView = WebWorkforceViewSchema.parse(fixture('workforce-full.json'));
const T0 = Date.parse(full.observedAt);
const session = { apiVersion: 1 as const, projectId: 'p', sessionId: 's', state: 'ready' as const, conversationStatus: 'active' as const, pendingIntakes: [], blockers: [], updatedAt: full.observedAt };
const decisionOf = (runId: string, status = 'pending') => WebDecisionSchema.parse({ decisionId: `d-${runId}`, runId, kind: 'approval', status, question: 'Q', options: [],
  expectedVersion: { revisionToken: 'v', approvalId: `d-${runId}`, target: { type: 'specification', specId: 'spec' }, revision: 1, generation: 0, evidenceDigest: 'a'.repeat(64) }, evidence: [] });
const run = WebRunViewSchema.parse({ apiVersion: 1, runId: 'fixture-run', sessionId: 's', revisionToken: 'v', title: 'Lọc sách', originRunId: 'fixture-run', currentRunId: 'fixture-run',
  sdlcStatus: 'implementing', coreStatus: 'running', transportSummary: { states: ['done'], observedAt: full.observedAt },
  tasks: [{ taskId: 'fixture-task-1', title: 'Thêm bộ lọc', status: 'running' }], blockers: [], decisions: [], clarifications: [], availableActions: [], updatedAt: full.observedAt });
const base = (over: Partial<OfficeInput> = {}): OfficeInput => ({ session, runs: [run], decisions: [], workforce: full, connection: 'connected', now: T0 + 1000, ...over });
const agent = (over: Partial<WebAgentView> & { work?: WebAgentWork[] }): WebAgentView => ({ ...full.agents[0]!, instanceId: 'a-x', ...over });
const one = (a: WebAgentView, over: Partial<OfficeInput> = {}) => {
  const model = deriveOffice(base({ workforce: { ...full, agents: [a] }, ...over }));
  expect(model.agents).toHaveLength(1); return model.agents[0]!;
};
const work = (over: Partial<WebAgentWork>): WebAgentWork => ({ messageId: 'm', kind: 'assignment', runId: 'fixture-run', delivery: 'accepted', ...over });
const t = (state: WebAgentView['transport']['state']) => ({ state, observedAt: full.observedAt });

describe('§4.3 table rows', () => {
  test.each([
    ['disconnected', agent({ transport: t('disconnected') }), 'disconnected', 'confirmed', 'Mất kết nối pane'],
    ['cancelled', agent({ transport: t('cancelled') }), 'disconnected', 'confirmed', 'Mất kết nối pane'],
    ['unknown_delivery', agent({ transport: t('working'), work: [work({ delivery: 'unknown_delivery' })] }), 'question', 'unknown', 'Chưa xác định việc đã tới'],
    ['accepted + live lease', agent({ transport: t('working'), work: [work({ taskId: 'fixture-task-1', leaseExpiresAt: '2026-11-02T00:10:00.000Z' })] }), 'working', 'confirmed', 'Đang giữ việc: Thêm bộ lọc'],
    ['accepted + turnSeenAt', agent({ transport: t('working'), work: [work({ taskId: 'fixture-task-1', turnSeenAt: '2026-11-02T00:00:00.000Z' })] }), 'typing', 'inferred', 'Có dấu hiệu đang chạy'],
    ['queued', agent({ transport: t('idle'), work: [work({ delivery: 'queued' })] }), 'preparing', 'confirmed', 'Đang chờ giao'],
    ['sending', agent({ transport: t('idle'), work: [work({ delivery: 'sending' })] }), 'preparing', 'confirmed', 'Đang chờ giao'],
    ['idle no work', agent({ transport: t('idle') }), 'sleeping', 'inferred', 'Rảnh'],
    ['done no work', agent({ transport: t('done') }), 'sleeping', 'inferred', 'Rảnh'],
    ['transport unknown', agent({ transport: t('unknown') }), 'ghost', 'unknown', 'Chưa xác định'],
  ] as const)('%s', (_n, a, pose, certainty, label) => {
    const o = one(a as WebAgentView);
    expect([o.pose, o.certainty, o.statusText]).toEqual([pose, certainty, label]);
  });

  test('pending decision of the agent run raises hand; other run does not', () => {
    const a = agent({ transport: t('working'), work: [work({ taskId: 'fixture-task-1' })] });
    expect(one(a, { decisions: [decisionOf('fixture-run')] })).toMatchObject({ pose: 'hand_raised', certainty: 'confirmed', statusText: 'Chờ bạn quyết định' });
    expect(one(a, { decisions: [decisionOf('other')] }).pose).not.toBe('hand_raised');
    expect(one(a, { decisions: [decisionOf('fixture-run', 'approved')] }).pose).not.toBe('hand_raised');
  });

  test('precedence is top-down', () => {
    const w = [work({ delivery: 'unknown_delivery' }), work({ messageId: 'm2', taskId: 'fixture-task-1' })];
    const d = [decisionOf('fixture-run')];
    expect(one(agent({ transport: t('disconnected'), work: w }), { decisions: d }).pose).toBe('disconnected');
    expect(one(agent({ transport: t('working'), work: w }), { decisions: d }).pose).toBe('question');
    expect(one(agent({ transport: t('working'), work: [w[1]!] }), { decisions: d }).pose).toBe('hand_raised');
    expect(one(agent({ transport: t('working'), work: [w[1]!] })).pose).toBe('working');
    expect(one(agent({ transport: t('working'), work: [work({ delivery: 'queued', messageId: 'q' }), w[1]!] })).pose).toBe('working');
  });
});

test('unknown_delivery outranks accepted work', () => {
  const dev = full.agents[2]!; // accepted+lease and unknown_delivery
  expect(one(dev)).toMatchObject({ pose: 'question', certainty: 'unknown' });
});

test('done transport never produces a success pose', () => {
  const poses = ['done'].flatMap(s => [one(agent({ transport: t(s as 'done') })).pose, one(agent({ transport: t('done'), work: [work({ delivery: 'released' })] })).pose]);
  for (const p of poses) expect(['sleeping']).toContain(p);
  expect(deriveOffice(base()).tasks).toEqual([{ taskId: 'fixture-task-1', title: 'Thêm bộ lọc', status: 'running', runId: 'fixture-run' }]);
});

describe('time', () => {
  test('expired lease is compared to snapshot time, not browser clock', () => {
    const a = agent({ transport: t('working'), work: [work({ taskId: 'fixture-task-1', leaseExpiresAt: '2026-11-02T00:10:00.000Z' })] });
    // browser clock far past the lease, but within 30s of the snapshot would be impossible; use a snapshot-relative expiry.
    expect(one(a, { now: T0 + 29_000 }).pose).toBe('working');
    const expired = agent({ transport: t('working'), work: [work({ taskId: 'fixture-task-1', leaseExpiresAt: '2026-11-01T23:59:59.000Z' })] });
    const o = one(expired, { now: T0 });
    expect(o.pose).toBe('ghost'); expect(o.certainty).toBe('unknown');
  });
  test('stale snapshot older than 30s demotes idle to unknown', () => {
    const a = agent({ transport: t('idle') });
    expect(one(a, { now: T0 + 30_000 }).pose).toBe('sleeping');
    expect(one(a, { now: T0 + 30_001 })).toMatchObject({ pose: 'ghost', certainty: 'unknown', statusText: 'Chưa xác định' });
  });
});

describe('tiers', () => {
  test('degraded tier marks every agent unknown', () => {
    const m = deriveOffice(base({ workforce: undefined, decisions: [decisionOf('fixture-run')] }));
    expect(m.tier).toBe('degraded');
    expect(m.agents.length).toBeGreaterThan(0);
    for (const a of m.agents) expect([a.pose, a.certainty, a.statusText]).toEqual(['ghost', 'unknown', 'Chưa xác định']);
    expect(new Set(m.agents.map(a => a.instanceId)).size).toBe(m.agents.length);
    expect(m.tasks).toHaveLength(1); expect(m.pendingDecisions).toBe(1); expect(m.handoffs).toEqual([]);
  });
  test('stopped session yields closed office with retained tasks', () => {
    for (const state of ['stopped', 'unavailable', 'starting', 'stopping'] as const) {
      const m = deriveOffice(base({ session: { ...session, state } }));
      expect(m.tier).toBe('closed'); expect(m.agents).toEqual([]);
      expect(m.statusText).toBe('Phiên đang dừng'); expect(m.certainty).toBe('confirmed');
      expect(m.tasks).toHaveLength(1);
    }
  });
  test('full tier carries handoffs, counts, observedAt and connection', () => {
    const m = deriveOffice(base({ connection: 'reconnecting', decisions: [decisionOf('fixture-run'), decisionOf('x', 'approved')] }));
    expect(m.tier).toBe('full'); expect(m.connection).toBe('reconnecting'); expect(m.observedAt).toBe(full.observedAt);
    expect(m.pendingDecisions).toBe(1);
    expect(m.handoffs.map(h => h.handoffId)).toEqual(['handoff-out-0', 'handoff-out-1', 'handoff-in-0']);
    expect(m.handoffs[1]).toEqual({ handoffId: 'handoff-out-1', ordinal: 1, direction: 'outbound', state: 'accepted', fromInstanceId: 'agent-2222222222222222', toInstanceId: 'agent-3333333333333333', fromRole: 'coordinator', toRole: 'developer' });
    expect(m.handoffs[2]).not.toHaveProperty('toInstanceId');
  });
  test('handoffs are ordered by (direction, ordinal), not array order', () => {
    const shuffled = { ...full, handoffs: [...full.handoffs].reverse() };
    expect(deriveOffice(base({ workforce: shuffled })).handoffs.map(h => h.handoffId)).toEqual(['handoff-out-0', 'handoff-out-1', 'handoff-in-0']);
  });
  test('empty workforce fixture is full tier with no agents; sos draws no actor', () => {
    const empty = WebWorkforceViewSchema.parse(fixture('workforce-empty.json'));
    expect(deriveOffice(base({ workforce: empty, now: Date.parse(empty.observedAt) })).agents).toEqual([]);
  });
});

describe('identity and labels', () => {
  test('keys on instanceId, developers numbered by boundAt, custom profile uses displayName', () => {
    const d1 = agent({ instanceId: 'dev-b', role: 'developer', displayName: 'Dev', permanent: false, boundAt: '2026-11-01T23:50:00.000Z', transport: t('idle') });
    const d2 = agent({ instanceId: 'dev-a', role: 'developer', displayName: 'Dev', permanent: false, boundAt: '2026-11-01T23:40:00.000Z', transport: t('idle') });
    const p = agent({ instanceId: 'prof', role: 'developer', profileId: 'fe', displayName: 'Frontend developer', permanent: false, transport: t('idle') });
    const m = deriveOffice(base({ workforce: { ...full, agents: [d1, d2, p] } }));
    const by = Object.fromEntries(m.agents.map(a => [a.instanceId, a.label]));
    expect(by['dev-a']).toBe('Developer #1'); expect(by['dev-b']).toBe('Developer #2'); expect(by.prof).toBe('Frontend developer');
  });
  test('failover instance is a separate actor', () => {
    const a = agent({ instanceId: 'i1', role: 'coordinator', transport: t('idle') }), b = agent({ instanceId: 'i2', role: 'coordinator', transport: t('idle') });
    expect(deriveOffice(base({ workforce: { ...full, agents: [a, b] } })).agents.map(x => x.instanceId)).toEqual(['i1', 'i2']);
  });
  test('conversation busy comes from session conversationStatus, labelled inferred', () => {
    const c = agent({ role: 'conversation', transport: t('idle') });
    expect(one(c, { session: { ...session, conversationStatus: 'delegated_to_coordinator' } })).toMatchObject({ pose: 'typing', certainty: 'inferred' });
    expect(one(c, { session: { ...session, conversationStatus: 'active' } }).pose).toBe('sleeping');
  });
  test('runId and taskId are carried from the first live work', () => {
    const o = one(agent({ transport: t('working'), work: [work({ taskId: 'fixture-task-1' })] }));
    expect(o).toMatchObject({ runId: 'fixture-run', taskId: 'fixture-task-1' });
  });
});
