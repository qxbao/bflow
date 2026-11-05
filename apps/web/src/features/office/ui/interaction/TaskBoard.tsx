import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiClient } from '../../../../api/client';
import { ErrorState } from '../../../../components/ErrorState';
import { EmptyState } from '../../../../components/EmptyState';
import { LoadingState } from '../../../../components/LoadingState';
import { StatusBadge } from '../../../../components/StatusBadge';
import { waitingOn } from '../../../runs';
import { useRead } from '../../../data';
import { useCursorPagination } from '../../../pagination';
import { Pagination } from '../../../../components/Pagination';
import { FieldLabel } from '../../../../components/FieldHelp';
import { phases } from '../../../../components/StatusBadge';

export function TaskBoard({ api, id, revision, refresh }: { api: ApiClient; id: string; revision: number; refresh: () => void }) {
  const [query,setQuery]=useSearchParams(),[search,setSearch]=useState(query.get('search')??'');
  const term=query.get('search')??'',phase=query.get('phase')??'';
  const pagination = useCursorPagination(`immersive-runs:${id}:${term}:${phase}`);
  const result = useRead(`immersive-runs:${id}:${term}:${phase}:${pagination.cursor ?? ''}`, () => api.runs(id, term, phase, pagination.cursor), revision);
  useEffect(()=>setSearch(term),[term]);
  function submit(event:FormEvent){event.preventDefault();setQuery({...(search.trim()?{search:search.trim()}:{}),...(phase?{phase}:{})});}
  const base = `/projects/${encodeURIComponent(id)}`;
  return <section className="mx-auto w-full max-w-4xl px-1 sm:px-4" data-component="TaskBoard">
    <div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">Bảng công việc</div>
    <h1 className="mt-1">Việc đang diễn ra</h1>
    <p className="max-w-2xl text-muted">Tiến độ và bước tiếp theo được lấy từ trạng thái công việc hiện tại.</p>
    <form className="my-4 flex flex-wrap items-end gap-3 [&>div]:min-w-0 [&>div]:basis-48 [&>div]:grow" onSubmit={submit}><div><FieldLabel htmlFor="task-search" label="Tìm công việc" help="Tìm theo tiêu đề công việc trong danh sách của phiên này."/><input id="task-search" type="search" maxLength={200} placeholder="Tên công việc" value={search} onChange={event=>setSearch(event.target.value)}/></div><div><FieldLabel htmlFor="task-phase" label="Giai đoạn" help="Lọc theo giai đoạn SDLC hiện tại."/><select id="task-phase" value={phase} onChange={event=>setQuery({...(term?{search:term}:{}),...(event.target.value?{phase:event.target.value}:{})})}><option value="">Tất cả giai đoạn</option>{Object.entries(phases).filter(([key])=>['intake','clarifying','specifying','planning','tdd_deciding','implementing','verifying','reviewing','awaiting_approval','completed','completed_with_parked','escalated','failed','cancelled'].includes(key)).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></div><button className="min-w-24">Tìm kiếm</button></form>
    <LoadingState loading={result.loading} initial={!result.data} label="Đang tải công việc…" />
    {Boolean(result.error) && <ErrorState stale={Boolean(result.data)} error={result.error} retry={refresh} />}
    {result.data && (result.data.items.length ? <div className="grid gap-3 sm:grid-cols-2">
      {result.data.items.map(run => {
        const completed = run.tasks.filter(task => task.status === 'succeeded').length;
        const next = waitingOn(run);
        return <Link key={run.runId} className="block min-h-40 border border-line bg-surface p-4 no-underline shadow-sm hover:border-accent hover:no-underline focus-visible:outline-2 focus-visible:outline-accent" to={`${base}/runs/${encodeURIComponent(run.runId)}`}>
          <div className="flex items-start justify-between gap-3"><h2 className="m-0 text-lg">{run.title}</h2><StatusBadge value={run.sdlcStatus} /></div>
          <p className="my-3 text-sm">{run.tasks.length ? `${completed}/${run.tasks.length} nhiệm vụ hoàn thành` : 'Đang chuẩn bị danh sách nhiệm vụ'}</p>
          <p className="mb-0 border-t border-line pt-3 text-sm"><strong>{next.title}:</strong> {next.detail}</p>
        </Link>;
      })}
    </div> : <EmptyState title="Chưa có công việc"><p>Công việc sẽ xuất hiện ở đây sau khi được tiếp nhận.</p></EmptyState>)}
    {result.data && <Pagination label="Phân trang công việc" page={pagination.page} first={pagination.first} previous={pagination.previous} next={result.data.nextCursor ? () => pagination.next(result.data!.nextCursor!) : undefined} busy={result.loading || Boolean(result.error)} summary={`${result.data.items.length} công việc trong trang này`} />}
  </section>;
}
