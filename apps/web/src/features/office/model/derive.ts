import type { WebAgentView, WebAgentWork } from '@bflow/contracts/web';
import type { Certainty, OfficeAgent, OfficeHandoff, OfficeInput, OfficeModel, OfficePose, OfficeRole } from './types';

export const STALE_MS = 30_000;
/** Fixed placeholders for the degraded tier: the permanent roles of the topology. */
export const PLACEHOLDER_ROLES: readonly OfficeRole[] = ['conversation', 'coordinator', 'planner', 'architect', 'specifier', 'reviewer', 'qa'];
const BUSY_CONVERSATION = new Set(['delegated_to_coordinator', 'reporting_progress']);
const UNKNOWN = 'Chưa xác định';

type Verdict = Pick<OfficeAgent, 'pose' | 'certainty' | 'statusText'>;
const v = (pose: OfficePose, certainty: Certainty, statusText: string): Verdict => ({ pose, certainty, statusText });

/** Developers are numbered by boundAt for display only; custom profiles keep their displayName. */
function labels(agents: readonly WebAgentView[]): Map<string, string> {
  const out = new Map<string, string>();
  const plain = agents.filter(a => a.role === 'developer' && !a.profileId).sort((a, b) => a.boundAt.localeCompare(b.boundAt) || a.instanceId.localeCompare(b.instanceId));
  plain.forEach((a, i) => out.set(a.instanceId, `Developer #${i + 1}`));
  for (const a of agents) if (!out.has(a.instanceId)) out.set(a.instanceId, a.displayName);
  return out;
}

function derivePose(a: WebAgentView, input: OfficeInput, pendingRuns: ReadonlySet<string>, taskTitle: (w: WebAgentWork) => string): Verdict {
  const observed = Date.parse(input.workforce!.observedAt);
  const stale = input.now - observed > STALE_MS;
  const { work } = a;
  // 1. Pane lost.
  if (a.transport.state === 'disconnected' || a.transport.state === 'cancelled') return v('disconnected', 'confirmed', 'Mất kết nối pane');
  // 2. Delivery uncertain: never claim the work arrived.
  if (work.some(w => w.delivery === 'unknown_delivery')) return v('question', 'unknown', 'Chưa xác định việc đã tới');
  // 3. A pending human decision on a run this agent works on.
  if (work.some(w => pendingRuns.has(w.runId))) return v('hand_raised', 'confirmed', 'Chờ bạn quyết định');
  // 4/5. Accepted work. Lease expiry is judged against the snapshot time, never the browser clock.
  const held = work.find(w => w.delivery === 'accepted' && (w.leaseExpiresAt === undefined || Date.parse(w.leaseExpiresAt) > observed));
  if (held) {
    return held.turnSeenAt !== undefined ? v('typing', 'inferred', 'Có dấu hiệu đang chạy') : v('working', 'confirmed', `Đang giữ việc: ${taskTitle(held)}`);
  }
  // 6. Not yet delivered.
  if (work.some(w => w.delivery === 'queued' || w.delivery === 'sending')) return v('preparing', 'confirmed', 'Đang chờ giao');
  // 7. No active work. Conversation busy is read from the session, not from transport.
  const hasUnresolved = work.some(w => w.delivery === 'accepted');
  if (!hasUnresolved && !stale && a.role === 'conversation' && input.session.conversationStatus && BUSY_CONVERSATION.has(input.session.conversationStatus)
    && (a.transport.state === 'idle' || a.transport.state === 'done')) return v('typing', 'inferred', 'Có dấu hiệu đang chạy');
  if (!hasUnresolved && !stale && (a.transport.state === 'idle' || a.transport.state === 'done')) return v('sleeping', 'inferred', 'Rảnh');
  // 8. Everything else, including expired leases, unknown transport and stale snapshots.
  return v('ghost', 'unknown', UNKNOWN);
}

const DIRECTION_ORDER = { outbound: 0, inbound: 1 } as const;

export function deriveOffice(input: OfficeInput): OfficeModel {
  const { session, runs, decisions, workforce, connection } = input;
  const tasks = runs.flatMap(r => r.tasks.map(t => ({ ...t, runId: r.runId })));
  const pending = decisions.filter(d => d.status === 'pending');
  const common = { tasks, pendingDecisions: pending.length, connection };

  if (session.state !== 'ready') {
    return { ...common, tier: 'closed', certainty: 'confirmed', statusText: 'Phiên đang dừng', agents: [], handoffs: [] };
  }
  if (!workforce) {
    const agents: OfficeAgent[] = PLACEHOLDER_ROLES.map(role => ({ instanceId: `placeholder-${role}`, label: role, role, ...v('ghost', 'unknown', UNKNOWN) }));
    return { ...common, tier: 'degraded', certainty: 'unknown', statusText: UNKNOWN, agents, handoffs: [] };
  }

  const pendingRuns = new Set(pending.map(d => d.runId));
  const titles = new Map(runs.flatMap(r => [[`${r.runId}\u0000`, r.title] as const, ...r.tasks.map(t => [`${r.runId}\u0000${t.taskId}`, t.title] as const)]));
  const taskTitle = (w: WebAgentWork) => titles.get(`${w.runId}\u0000${w.taskId ?? ''}`) ?? w.taskId ?? titles.get(`${w.runId}\u0000`) ?? w.runId;
  const names = labels(workforce.agents);
  const agents: OfficeAgent[] = workforce.agents.map(a => {
    const live = a.work.find(w => w.delivery === 'accepted' || w.delivery === 'queued' || w.delivery === 'sending') ?? a.work[0];
    return { instanceId: a.instanceId, label: names.get(a.instanceId)!, role: a.role, ...derivePose(a, input, pendingRuns, taskTitle),
      observedAt: a.transport.observedAt, ...(live ? { runId: live.runId } : {}), ...(live?.taskId ? { taskId: live.taskId } : {}) };
  });
  const handoffs: OfficeHandoff[] = [...workforce.handoffs]
    .sort((x, y) => DIRECTION_ORDER[x.direction] - DIRECTION_ORDER[y.direction] || x.ordinal - y.ordinal)
    .map(h => ({ handoffId: h.handoffId, ordinal: h.ordinal, direction: h.direction, state: h.state,
      ...(h.from.instanceId ? { fromInstanceId: h.from.instanceId } : {}), ...(h.to.instanceId ? { toInstanceId: h.to.instanceId } : {}),
      fromRole: h.from.role, toRole: h.to.role }));
  return { ...common, tier: 'full', certainty: 'confirmed', statusText: '', agents, handoffs, observedAt: workforce.observedAt };
}
