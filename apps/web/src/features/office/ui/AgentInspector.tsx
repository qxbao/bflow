import { Link } from 'react-router';
import type { WebActivityEntry, WebAgentView, WebEvidenceReference, WebHandoffView } from '@bflow/contracts/web';
import { ApiClient, ApiError } from '../../../api/client';
import { Evidence } from '../../../components/DecisionCard';
import { useRead } from '../../data';
import { AgentTranscript } from '../../agents';
import { roleLabel } from '../model/labels';
import type { Certainty, OfficeAgent } from '../model/types';

const CERTAINTY: Readonly<Record<Certainty, string>> = { confirmed: 'Đã xác nhận', inferred: 'Suy luận', unknown: 'Chưa xác định' };
const KIND: Readonly<Record<string, string>> = { assignment: 'Giao việc', delegation: 'Ủy quyền', verification: 'Kiểm chứng' };
const DELIVERY: Readonly<Record<string, string>> = {
  queued: 'Đang chờ giao', sending: 'Đang gửi', accepted: 'Đã tiếp nhận', released: 'Đã trả lại', unknown_delivery: 'Chưa rõ đã tới nơi', failed: 'Gửi thất bại', cancelled: 'Đã hủy',
};
const when = (iso: string): string => { const t = Date.parse(iso); return Number.isNaN(t) ? iso : new Date(t).toLocaleString('vi'); };
/** Distinct evidence of the handoffs an agent took part in, by artifact. */
export function handoffEvidence(handoffs: readonly WebHandoffView[], instanceId?: string, runId?: string): WebEvidenceReference[] {
  const seen = new Map<string, WebEvidenceReference>();
  for (const h of handoffs) {
    if (instanceId !== undefined && h.from.instanceId !== instanceId && h.to.instanceId !== instanceId) continue;
    if (runId !== undefined && h.runId !== runId) continue;
    for (const e of h.evidence) seen.set(e.artifactId, e);
  }
  return [...seen.values()];
}

/** The log names a role per line, not an instance, so every line of the run is shown with its role; nothing is attributed to this agent. */
function Activity({ api, projectId, runId, revision }: { api: ApiClient; projectId: string; runId: string; revision: number }) {
  const read = useRead(`office-activity:${projectId}:${runId}`, () => api.readRunActivity(projectId, runId), revision);
  const entries: WebActivityEntry[] = (read.data?.items ?? []).slice(-8);
  const unsupported = read.error instanceof ApiError && ['not_found', 'operation_not_allowed'].includes(read.error.code);
  return <section aria-label="Hoạt động gần đây" className="mt-3">
    <h3 className="m-0 text-sm">Hoạt động gần đây (chẩn đoán, có thể thiếu)</h3>
    <p className="my-1 text-xs text-muted">Nhật ký ghi theo từng vai trò trong toàn bộ công việc, không riêng nhân viên này.</p>
    {read.loading && !read.data && <p className="my-1 text-sm text-muted">Đang đọc hoạt động…</p>}
    {Boolean(read.error) && <p className="my-1 text-sm text-muted">{unsupported ? 'Máy chủ chưa cung cấp nhật ký hoạt động.' : 'Chưa tải được nhật ký hoạt động; điều này không đồng nghĩa nhân viên đang rảnh.'}</p>}
    {read.data && entries.length === 0 && <p className="my-1 text-sm text-muted">Chưa có hoạt động nào được ghi nhận cho phiên này.</p>}
    {entries.length > 0 && <ul className="my-1 list-none p-0 text-sm">{entries.map(e => <li key={e.entryId} className="border-t border-line py-1 first:border-t-0">
      <time dateTime={e.occurredAt} className="text-xs text-muted">{when(e.occurredAt)}</time>{' '}<span className="font-semibold">{roleLabel(e.role)}</span>: {e.action}{e.outcome ? `: ${e.outcome}` : ''}
    </li>)}</ul>}
  </section>;
}

/**
 * Read-only view of one agent for the overlay panel. Everything is plain text; navigation is by links to existing pages. Evidence is
 * the existing Evidence component. This component has no mutation control of its own.
 */
export function AgentInspector({ api, projectId, agent, view, handoffs, revision, titleOf }: {
  api: ApiClient; projectId: string; agent: OfficeAgent; view: WebAgentView | undefined; handoffs: readonly WebHandoffView[]; revision: number; titleOf: (runId: string, taskId?: string) => string;
}) {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const runId = agent.runId ?? view?.work[0]?.runId;
  const evidence = handoffEvidence(handoffs, agent.instanceId);
  const runIds = [...new Set([...(runId ? [runId] : []), ...(view?.work.map(w => w.runId) ?? [])])].slice(0, 3);
  return <section aria-label={`Nhân viên ${agent.label}`} className="min-w-0">
    <h2 className="mt-0">{agent.label}</h2>
    <dl className="my-2">
      <dt>Vai trò</dt><dd>{roleLabel(agent.role)}</dd>
      {view && <><dt>Tên hiển thị</dt><dd>{view.displayName === 'Qa' ? 'QA' : view.displayName}</dd><dt>Nhà cung cấp</dt><dd>{view.provider}</dd><dt>Mô hình</dt><dd>{view.model ?? 'Không công bố'}</dd></>}
      <dt>Trạng thái</dt><dd>{agent.statusText}</dd>
      <dt>Mức tin cậy</dt><dd>{CERTAINTY[agent.certainty]}</dd>
      <dt>Quan sát lúc</dt><dd>{agent.observedAt ? <time dateTime={agent.observedAt}>{when(agent.observedAt)}</time> : 'Chưa có quan sát'}</dd>
    </dl>
    <h3 className="m-0 text-sm">Việc đang giữ</h3>
    {!view || view.work.length === 0 ? <p className="my-1 text-sm text-muted">Không có việc đang giữ.</p> : <ul className="my-1 list-none p-0 text-sm">{view.work.map(w => <li key={w.messageId} className="border-t border-line py-1 first:border-t-0">
      {KIND[w.kind] ?? w.kind}: {titleOf(w.runId, w.taskId)} ({DELIVERY[w.delivery] ?? w.delivery})
    </li>)}</ul>}
    {runIds.map(r => <Activity key={r} api={api} projectId={projectId} runId={r} revision={revision} />)}
    <section aria-label="Nội dung gần đây" className="mt-3">
      <h3 className="m-0 text-sm">Nội dung gần đây</h3>
      <AgentTranscript key={agent.instanceId} api={api} projectId={projectId} instanceId={agent.instanceId} className="h-56" />
      <p className="my-1 text-sm"><Link to={`${base}/agents?agent=${encodeURIComponent(agent.instanceId)}`}>Xem tất cả nhân viên →</Link></p>
    </section>
    <section aria-label="Tài liệu kiểm chứng" className="mt-3">
      <h3 className="m-0 text-sm">Tài liệu kiểm chứng</h3>
      {evidence.length === 0 ? <p className="my-1 text-sm text-muted">Chưa có tài liệu đính kèm.</p> : evidence.map(e => <Evidence key={e.artifactId} api={api} projectId={projectId} evidence={e} />)}
    </section>
    {runId && <p className="mt-3 mb-0 flex flex-wrap gap-x-4 text-sm"><Link to={`${base}/runs/${encodeURIComponent(runId)}`}>Xem công việc →</Link><Link to={`${base}/chat/${encodeURIComponent(runId)}`}>Mở trò chuyện →</Link></p>}
  </section>;
}

/** Agents as a list (the "+n" chip: Developers no seat could hold). Each row opens that agent's inspector. */
export function AgentList({ title, agents, onPick, note }: { title: string; agents: readonly OfficeAgent[]; onPick: (instanceId: string) => void; note?: string }) {
  return <section aria-label={title} className="min-w-0">
    <h2 className="mt-0">{title}</h2>
    {note && <p className="text-sm text-muted">{note}</p>}
    {agents.length === 0 ? <p className="text-sm text-muted">Không có nhân viên nào trong danh sách này.</p> : <ul className="my-2 list-none p-0">{agents.map(a => <li key={a.instanceId} className="border-t border-line py-1.5 first:border-t-0">
      <button type="button" className="w-full text-left" onClick={() => onPick(a.instanceId)}><span className="font-semibold">{a.label}</span> ({roleLabel(a.role)}): {a.statusText}. Mức tin cậy: {CERTAINTY[a.certainty]}.</button>
    </li>)}</ul>}
  </section>;
}
