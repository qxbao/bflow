import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { WebDecision, WebRunView } from '@bflow/contracts/web';
import { ApiClient } from '../../../../api/client';
import { ErrorState } from '../../../../components/ErrorState';
import { EmptyState } from '../../../../components/EmptyState';
import { LoadingState } from '../../../../components/LoadingState';
import { DecisionReview } from '../../../decisions';
import { useRead } from '../../../data';
import { useDecisionDrafts, decisionDraftKey } from './decision-drafts';

export function DecisionInbox({ api, id, revision, refresh }: { api: ApiClient; id: string; revision: number; refresh: () => void }) {
  const result = useRead(`immersive-decisions:${id}`, () => api.decisions(id), revision);
  const [query, setQuery] = useSearchParams();
  const selectedId = query.get('decision') ?? '';
  const selectedRunId = query.get('run') ?? '';
  const pending = result.data?.items.filter(item => item.status === 'pending') ?? [];
  const selected = result.data?.items.find(item => item.decisionId === selectedId && item.runId === selectedRunId);
  const [run, setRun] = useState<WebRunView>();
  const [runError, setRunError] = useState<unknown>();
  const [runLoading, setRunLoading] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const { drafts, setDraft } = useDecisionDrafts();
  const key = selected ? decisionDraftKey(selected.runId, selected.decisionId) : '';

  useEffect(() => {
    if (!selected) { setRun(undefined); setRunError(undefined); return; }
    let active = true;
    setRunLoading(true); setRunError(undefined);
    void api.run(id, selected.runId).then(value => { if (active) setRun(value); }, error => { if (active) setRunError(error); }).finally(() => { if (active) setRunLoading(false); });
    return () => { active = false; };
  }, [api, id, selected?.decisionId, selected?.runId, revision]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (selected && !element.open) element.showModal();
    if (!selected && element.open) element.close();
  }, [selected]);

  function select(decision: WebDecision, element: HTMLElement) {
    opener.current = element;
    const next = new URLSearchParams(query); next.set('decision', decision.decisionId); next.set('run', decision.runId); setQuery(next);
  }
  function close() {
    const next = new URLSearchParams(query); next.delete('decision'); next.delete('run'); setQuery(next);
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus();
      else document.querySelector<HTMLElement>('[data-component="DecisionInbox"] h1')?.focus();
    });
  }

  return <section className="mx-auto w-full max-w-4xl px-1 sm:px-4" data-component="DecisionInbox">
    <div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">Hộp quyết định</div>
    <h1 tabIndex={-1} className="mt-1">Cần bạn quyết định <span className="ml-2 inline-flex min-w-8 items-center justify-center rounded-full bg-brand px-2 py-1 text-sm text-on-brand" aria-label={`${pending.length} yêu cầu đang chờ`}>{pending.length}</span></h1>
    <p className="max-w-2xl text-muted">Mở từng yêu cầu để đọc tài liệu và phiên bản trước khi chọn quyết định.</p>
    <LoadingState loading={result.loading} initial={!result.data} label="Đang tải yêu cầu…" />
    {Boolean(result.error) && <ErrorState stale={Boolean(result.data)} error={result.error} retry={refresh} />}
    {result.data && (pending.length ? <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">{pending.map(item => <li key={`${item.runId}:${item.decisionId}`}><button className="h-full min-h-28 w-full border border-line bg-surface p-4 text-left hover:border-accent" onClick={event => select(item, event.currentTarget)}><strong className="block text-base">{item.question}</strong><span className="mt-2 block text-sm text-muted">{item.kind === 'approval' ? 'Yêu cầu phê duyệt' : 'Cần chọn phương án'} · Phiên bản {item.expectedVersion.revision}</span><span className="mt-3 block text-sm">Đọc tài liệu và quyết định →</span></button></li>)}</ul> : <EmptyState title="Không có quyết định đang chờ"><p>Các yêu cầu cần bạn trả lời sẽ xuất hiện tại đây.</p></EmptyState>)}
    {result.data?.nextCursor && <p className="mt-4 text-sm text-muted">Danh sách hiển thị {result.data.items.length} yêu cầu được tải từ dịch vụ. API hiện chưa cung cấp thao tác đọc trang tiếp theo.</p>}
    <dialog ref={dialog} aria-labelledby="decision-inbox-title" className="m-auto max-h-[92dvh] w-[min(900px,calc(100vw-24px))] overflow-y-auto border border-line bg-surface p-0 shadow-2xl backdrop:bg-ink/60" onCancel={event => { event.preventDefault(); close(); }}>
      {selected && <div className="p-4 sm:p-7"><div className="flex items-start justify-between gap-4"><div><p className="m-0 font-data text-xs uppercase tracking-widest text-muted">Đang xem xét · Phiên bản {selected.expectedVersion.revision}</p><h2 id="decision-inbox-title" className="mt-1">{selected.question}</h2></div><button type="button" className="min-h-11" onClick={close}>Quay lại hộp thư</button></div>
        {runLoading && <LoadingState loading initial label="Đang xác nhận quyền quyết định…" />}
        {Boolean(runError) && <ErrorState error={runError} retry={refresh} />}
        {run && <DecisionReview key={key} api={api} id={id} decision={selected} actions={run.runId === selected.runId ? run.availableActions : []} fresh={!result.loading && !result.error && !runLoading && !runError && run.runId === selected.runId && run.currentRunId === selected.runId} refresh={refresh} draft={drafts[key]} onDraftChange={draft => setDraft(key, draft)} />}
        <Link className="mt-4 inline-block" to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(selected.runId)}`}>Mở công việc liên quan →</Link>
      </div>}
    </dialog>
  </section>;
}
