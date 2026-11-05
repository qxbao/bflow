import { Link } from 'react-router';
import { ApiClient } from '../../../../api/client';
import { ErrorState } from '../../../../components/ErrorState';
import { EmptyState } from '../../../../components/EmptyState';
import { LoadingState } from '../../../../components/LoadingState';
import { StatusBadge } from '../../../../components/StatusBadge';
import { waitingOn } from '../../../runs';
import { useRead } from '../../../data';
import { useCursorPagination } from '../../../pagination';
import { Pagination } from '../../../../components/Pagination';

export function TaskBoard({ api, id, revision, refresh }: { api: ApiClient; id: string; revision: number; refresh: () => void }) {
  const pagination = useCursorPagination(`immersive-runs:${id}`);
  const result = useRead(`immersive-runs:${id}:${pagination.cursor ?? ''}`, () => api.runs(id, '', '', pagination.cursor), revision);
  const base = `/projects/${encodeURIComponent(id)}`;
  return <section className="mx-auto w-full max-w-4xl px-1 sm:px-4" data-component="TaskBoard">
    <div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">Bảng công việc</div>
    <h1 className="mt-1">Việc đang diễn ra</h1>
    <p className="max-w-2xl text-muted">Tiến độ và bước tiếp theo được lấy từ trạng thái công việc hiện tại.</p>
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
