import type { WebAgentView, WebAgentWork } from '@bflow/contracts/web';
import { roleLabel } from './labels';
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

const ACTIVE_DELIVERY = new Set(['queued', 'sending', 'accepted', 'unknown_delivery']);

/** The verdict plus the work item that decided it (if any), so runId/taskId never describe a different item. */
function derivePose(a: WebAgentView, input: OfficeInput, observed: number, pendingRuns: ReadonlySet<string>, taskTitle: (w: WebAgentWork) => string): { verdict: Verdict; via?: WebAgentWork | undefined } {
  const stale = input.now - observed > STALE_MS;
  const { work } = a;
  // 1. Pane lost.
  if (a.transport.state === 'disconnected' || a.transport.state === 'cancelled') return { verdict: v('disconnected', 'confirmed', 'Mất kết nối pane') };
  // 2. Delivery uncertain: never claim the work arrived.
  const uncertain = work.find(w => w.delivery === 'unknown_delivery');
  if (uncertain) return { verdict: v('question', 'unknown', 'Chưa xác định việc đã tới'), via: uncertain };
  // 3. A pending human decision on a run where this agent still has non-terminal work.
  const asked = work.find(w => ACTIVE_DELIVERY.has(w.delivery) && pendingRuns.has(w.runId));
  if (asked) return { verdict: v('hand_raised', 'confirmed', 'Chờ bạn quyết định'), via: asked };
  // 4/5. Accepted work needs a lease still valid at snapshot time (never the browser clock); no lease is not confirmed.
  const held = work.find(w => w.delivery === 'accepted' && w.leaseExpiresAt !== undefined && Date.parse(w.leaseExpiresAt) > observed);
  if (held) {
    return { verdict: held.turnSeenAt !== undefined ? v('typing', 'inferred', 'Có dấu hiệu đang chạy') : v('working', 'confirmed', `Đang giữ việc: ${taskTitle(held)}`), via: held };
  }
  // 6. Not yet delivered.
  const waiting = work.find(w => w.delivery === 'queued' || w.delivery === 'sending');
  if (waiting) return { verdict: v('preparing', 'confirmed', 'Đang chờ giao'), via: waiting };
  // 7. No unresolved work. Conversation busy is read from the session, not from transport.
  const unresolved = work.find(w => w.delivery === 'accepted');
  const idle = a.transport.state === 'idle' || a.transport.state === 'done';
  if (!unresolved && !stale && idle) {
    const busy = a.role === 'conversation' && input.session.conversationStatus !== undefined && BUSY_CONVERSATION.has(input.session.conversationStatus);
    return { verdict: busy ? v('typing', 'inferred', 'Có dấu hiệu đang chạy') : v('sleeping', 'inferred', 'Rảnh') };
  }
  // 8. Everything else: expired or absent lease, unknown transport, stale snapshot.
  return { verdict: v('ghost', 'unknown', UNKNOWN), via: unresolved };
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
    const agents: OfficeAgent[] = PLACEHOLDER_ROLES.map(role => ({ instanceId: `placeholder-${role}`, label: roleLabel(role), role, ...v('ghost', 'unknown', UNKNOWN) }));
    return { ...common, tier: 'degraded', certainty: 'unknown', statusText: UNKNOWN, agents, handoffs: [] };
  }

  const pendingRuns = new Set(pending.map(d => d.runId));
  const titles = new Map(runs.flatMap(r => [[`${r.runId}\u0000`, r.title] as const, ...r.tasks.map(t => [`${r.runId}\u0000${t.taskId}`, t.title] as const)]));
  const taskTitle = (w: WebAgentWork) => titles.get(`${w.runId}\u0000${w.taskId ?? ''}`) ?? w.taskId ?? titles.get(`${w.runId}\u0000`) ?? w.runId;
  const names = labels(workforce.agents);
  const observed = Date.parse(workforce.observedAt);
  const agents: OfficeAgent[] = workforce.agents.map(a => {
    const { verdict, via } = derivePose(a, input, observed, pendingRuns, taskTitle);
    return { instanceId: a.instanceId, label: names.get(a.instanceId) ?? a.displayName, role: a.role, ...verdict,
      observedAt: a.transport.observedAt, ...(via ? { runId: via.runId } : {}), ...(via?.taskId ? { taskId: via.taskId } : {}) };
  });
  const handoffs: OfficeHandoff[] = [...workforce.handoffs]
    .sort((x, y) => DIRECTION_ORDER[x.direction] - DIRECTION_ORDER[y.direction] || x.ordinal - y.ordinal)
    .map(h => ({ handoffId: h.handoffId, ordinal: h.ordinal, direction: h.direction, state: h.state,
      ...(h.from.instanceId ? { fromInstanceId: h.from.instanceId } : {}), ...(h.to.instanceId ? { toInstanceId: h.to.instanceId } : {}),
      fromRole: h.from.role, toRole: h.to.role }));
  return { ...common, tier: 'full', certainty: 'confirmed', statusText: '', agents, handoffs, observedAt: workforce.observedAt };
}
