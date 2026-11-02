import type { WebDecision, WebEvidenceReference, WebProjectSession, WebRunView } from '@bflow/contracts/web';
import { ApiClient } from '../../../api/client';
import { Evidence } from '../../../components/DecisionCard';
import { phases } from '../../../components/StatusBadge';
import { SessionActions } from '../../run-actions/session';

/** Distinct evidence of a run: decision evidence (handoff evidence is passed in by the caller). */
export function runEvidence(runId: string | undefined, decisions: readonly WebDecision[], extra: readonly WebEvidenceReference[]): WebEvidenceReference[] {
  const seen = new Map<string, WebEvidenceReference>();
  for (const d of decisions) if (runId === undefined || d.runId === runId) for (const e of d.evidence) seen.set(e.artifactId, e);
  for (const e of extra) if (runId === undefined || e.runId === runId) seen.set(e.artifactId, e);
  return [...seen.values()];
}

/** Cabinet: evidence of the selected run, through the existing Evidence component. */
export function CabinetInspector({ api, projectId, run, evidence }: { api: ApiClient; projectId: string; run: WebRunView | undefined; evidence: readonly WebEvidenceReference[] }) {
  return <section aria-label="Tủ tài liệu" className="min-w-0">
    <h2 className="mt-0">Tủ tài liệu</h2>
    <p className="text-sm text-muted">{run ? <>Công việc: {run.title} ({phases[run.sdlcStatus] ?? 'Chưa xác định'})</> : 'Chưa có công việc đang làm.'}</p>
    {evidence.length === 0 ? <p className="text-sm text-muted">Chưa có tài liệu kiểm chứng cho công việc này.</p> : evidence.map(e => <Evidence key={e.artifactId} api={api} projectId={projectId} evidence={e} />)}
  </section>;
}

/** Server: the session, with the same session actions Classic offers. */
export function ServerInspector({ api, projectId, session, fresh, refresh }: { api: ApiClient; projectId: string; session: WebProjectSession | undefined; fresh: boolean; refresh: () => void }) {
  return <section aria-label="Máy chủ phiên" className="min-w-0">
    <h2 className="mt-0">Máy chủ (phiên dự án)</h2>
    {session ? <SessionActions api={api} id={projectId} session={session} fresh={fresh} refresh={refresh} /> : <p className="text-sm text-muted">Chưa đọc được phiên.</p>}
  </section>;
}
