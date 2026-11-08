import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { WebAgentTranscript, WebAgentView } from '@bflow/contracts/web';
import { ApiClient, ApiError } from '../../api/client';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { useRead } from '../data';
import { roleLabel } from '../office/model/labels';

const POLL_MS = 5000;
const TRANSPORT: Readonly<Record<string, string>> = {
  starting: 'Đang khởi động', accepted: 'Đã nhận lệnh', idle: 'Rảnh', working: 'Đang chạy', blocked: 'Đang chờ', done: 'Đã dừng lượt', unknown: 'Chưa rõ', disconnected: 'Mất kết nối', cancelled: 'Đã hủy',
};
const unsupportedError = (e: unknown): boolean => e instanceof ApiError && ['not_found', 'operation_not_allowed'].includes(e.code);

/** Terminal text of one agent, re-read every 5 s while mounted and visible. Plain text only: it is never parsed as markup. */
export function AgentTranscript({ api, projectId, instanceId, className = 'h-72' }: { api: ApiClient; projectId: string; instanceId: string; className?: string }) {
  const [data, setData] = useState<WebAgentTranscript>(), [error, setError] = useState<unknown>(), [loaded, setLoaded] = useState(false);
  const log = useRef<HTMLDivElement>(null), pinned = useRef(true);
  useEffect(() => {
    let active = true, running = false;
    setData(undefined); setError(undefined); setLoaded(false); pinned.current = true;
    const read = (): void => {
      if (!active || running) return;
      running = true;
      void api.readAgentTranscript(projectId, instanceId).then(value => { if (active) { setData(value); setError(undefined); } }, e => { if (active) setError(e); })
        .finally(() => { running = false; if (active) setLoaded(true); });
    };
    const tick = (): void => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') read(); };
    read();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [api, projectId, instanceId]);
  // Follows new text only while the reader is at the bottom.
  useLayoutEffect(() => { const e = log.current; if (e && pinned.current) e.scrollTop = e.scrollHeight; }, [data?.text]);
  const unsupported = unsupportedError(error) && !data;
  const hasText = data ? data.text.trim() !== '' : false;
  return <section aria-label="Nội dung gần đây của nhân viên" className="agent-transcript-panel min-w-0">
    <p className="my-1 text-xs text-muted">Bản chụp màn hình terminal của nhân viên, đã che thông tin nhạy cảm. Có thể thiếu và không phải bằng chứng hoàn thành công việc.</p>
    {unsupported ? <p className="my-1 text-sm text-muted">Máy chủ chưa cung cấp nội dung của nhân viên này.</p> : <>
      {Boolean(error) && <p role="status" className="my-1 text-sm text-warning">Chưa đọc được nội dung. Điều này không cho biết nhân viên đang rảnh.</p>}
      {data?.truncated && <p className="my-1 text-xs text-muted">Chỉ hiện phần cuối của nội dung; phần đầu đã bị cắt.</p>}
      {data && data.text.trim() === '' && <p className="my-1 text-sm text-muted">Nhân viên chưa có nội dung nào.</p>}
      {!data && !loaded && <p className="my-1 text-sm text-muted">Đang đọc nội dung…</p>}
      {hasText && <div className="agent-terminal-frame">
        <div aria-hidden="true" className="agent-terminal-bar"><span className="agent-terminal-dots"><i/><i/><i/></span><span className="agent-terminal-title">TERMINAL SNAPSHOT · READ-ONLY</span></div>
        <div ref={log} role="log" aria-label="Nội dung terminal" tabIndex={0} onScroll={event => { const e = event.currentTarget; pinned.current = e.scrollHeight - e.scrollTop - e.clientHeight < 40; }}
          className={`agent-terminal-log ${className} overflow-y-auto rounded border border-line bg-canvas p-2 font-data text-xs whitespace-pre-wrap text-ink [overflow-wrap:anywhere]`}>{data?.text}</div>
      </div>}
      {data && <p className="my-1 text-xs text-muted">Quan sát lúc <time dateTime={data.observedAt}>{new Date(data.observedAt).toLocaleString('vi')}</time></p>}
    </>}
  </section>;
}

const openWork = (a: WebAgentView): number => a.work.length;
const formatAgentName = (name: string): string => name === 'Qa' ? 'QA' : name;
/** Every agent of the session with the terminal text of the selected one. Works inside the Classic page and the 3D overlay panel. */
export function AgentsPage({ api, id, revision }: { api: ApiClient; id: string; revision: number }) {
  const [reload, setReload] = useState(0), [params, setParams] = useSearchParams();
  const result = useRead(`agents:${id}`, () => api.readWorkforce(id), revision + reload);
  const agents = result.data?.agents ?? [];
  const wanted = params.get('agent');
  const selected = agents.find(a => a.instanceId === wanted) ?? agents.find(a => openWork(a) > 0) ?? agents[0];
  const unsupported = unsupportedError(result.error);
  return <section aria-label="Nhân viên" className="min-w-0">
    <h2 className="agents-page-heading mt-0">Nhân viên</h2>
    <LoadingState loading={result.loading} initial={!result.data} label="Đang tải danh sách nhân viên…" />
    {Boolean(result.error) && (unsupported && !result.data ? <EmptyState title="Chưa có dữ liệu nhân viên"><p>Máy chủ chưa cung cấp danh sách nhân viên. Có thể phiên chưa chạy.</p></EmptyState> : <ErrorState stale={Boolean(result.data)} error={result.error} retry={() => setReload(n => n + 1)} />)}
    {result.data && agents.length === 0 && <EmptyState title="Chưa có nhân viên nào"><p>Phiên chưa có nhân viên nào được theo dõi.</p></EmptyState>}
    {selected && <div className="content-grid grid min-w-0 gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <ul aria-label="Danh sách nhân viên" className="agent-roster-list m-0 list-none p-0">{agents.map(a => <li key={a.instanceId} className="border-t border-line first:border-t-0">
        <button type="button" aria-pressed={a.instanceId === selected.instanceId} onClick={() => setParams({ agent: a.instanceId }, { replace: true })} className="agent-roster-item w-full rounded-none border-transparent px-2 py-1.5 text-left aria-pressed:bg-faint">
          <span className="flex items-center justify-between gap-1.5 font-semibold [overflow-wrap:anywhere]"><span>{formatAgentName(a.displayName)}</span><span aria-hidden="true" className={`agent-status-dot agent-status-dot--${a.transport.state}`} /></span>
          <span className="block text-xs text-muted">{roleLabel(a.role)} · {TRANSPORT[a.transport.state] ?? 'Chưa rõ'} · {openWork(a)} việc đang giữ</span>
        </button>
      </li>)}</ul>
      <div className="agent-detail-card min-w-0"><h3 className="mt-0">{formatAgentName(selected.displayName)}</h3><AgentTranscript key={selected.instanceId} api={api} projectId={id} instanceId={selected.instanceId} className="h-[min(28rem,60dvh)]" /></div>
    </div>}
  </section>;
}
