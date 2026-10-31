import { Link, NavLink, useLocation, useParams } from 'react-router';
import { ApiClient } from '../../api/client';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Pagination } from '../../components/Pagination';
import { phases } from '../../components/StatusBadge';
import { useRead } from '../data';
import { useCursorPagination } from '../pagination';
import { ago } from '../runs';
import { ChatHistory } from './index';

const finished=(status:string)=>['completed','failed','cancelled'].includes(status);
/** One conversation per run: the list picks the run, the thread shows only that run. */
export function ChatPage({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) {
  const {runId}=useParams(),location=useLocation(),base=`/projects/${encodeURIComponent(id)}/chat`;
  const pagination=useCursorPagination(JSON.stringify(['chat',id])),cursor=pagination.cursor;
  const runs=useRead(`chat-runs:${id}:${cursor??''}`,()=>api.runs(id,undefined,undefined,cursor),revision);
  const items=[...(runs.data?.items??[])].sort((a,b)=>Number(finished(a.sdlcStatus))-Number(finished(b.sdlcStatus))||b.updatedAt.localeCompare(a.updatedAt));
  return <><h1 className={runId?'sr-only':'lg:sr-only'}>Trò chuyện</h1>
    <div className="grid min-w-0 border border-line bg-surface lg:grid-cols-[280px_minmax(0,1fr)]">
      <nav aria-label="Trò chuyện theo công việc" className={`${runId?'hidden lg:block':'block'} min-w-0 border-line lg:h-[calc(100dvh-15rem)] lg:min-h-[26rem] lg:overflow-y-auto lg:border-r`}>
        <LoadingState loading={runs.loading} initial={!runs.data} label="Đang tải công việc…"/>
        {Boolean(runs.error) && <ErrorState stale={Boolean(runs.data)} error={runs.error} retry={refresh}/>}
        {runs.data && !items.length && <p className="p-4 text-sm text-muted">Chưa có công việc để trò chuyện.</p>}
        {items.map(run=><NavLink key={run.runId} to={{pathname:`${base}/${encodeURIComponent(run.runId)}`,search:location.search}} className="block min-w-0 border-b border-l-2 border-line border-l-transparent px-3 py-3 text-ink no-underline hover:bg-faint hover:no-underline aria-[current=page]:border-l-accent aria-[current=page]:bg-faint">
          <span className="block truncate font-data text-sm font-semibold">{run.title}</span>
          <span className="block truncate font-data text-xs text-muted">{phases[run.sdlcStatus]??run.sdlcStatus} · {ago(run.updatedAt)}</span>
        </NavLink>)}
        {runs.data && <div className="px-3"><Pagination label="Phân trang danh sách trò chuyện" page={pagination.page} first={pagination.first} previous={pagination.previous} next={runs.data.nextCursor?()=>pagination.next(runs.data!.nextCursor!):undefined} busy={runs.loading || Boolean(runs.error)}/></div>}
      </nav>
      <div className={`${runId?'block':'hidden lg:block'} min-w-0`}>
        {runId?<><Link className="block border-b border-line px-4 py-2 font-data text-sm lg:hidden" to={{pathname:base,search:location.search}}>← Danh sách trò chuyện</Link><Thread key={runId} api={api} id={id} runId={runId} revision={revision} refresh={refresh}/></>:<div className="p-6"><EmptyState title="Chọn một công việc"><p>Mỗi công việc có một cuộc trò chuyện riêng với Conversation.</p></EmptyState></div>}
      </div>
    </div>
  </>;
}
function Thread({api,id,runId,revision,refresh}:{api:ApiClient;id:string;runId:string;revision:number;refresh:()=>void}) {
  const run=useRead(`chat-run:${id}:${runId}`,()=>api.run(id,runId),revision);
  return <><LoadingState loading={run.loading} initial={!run.data} label="Đang tải cuộc trò chuyện…"/>{Boolean(run.error) && <div className="p-4"><ErrorState stale={Boolean(run.data)} error={run.error} retry={refresh}/></div>}{run.data && <ChatHistory api={api} projectId={id} sessionId={run.data.sessionId} runId={run.data.runId} revision={revision} title={run.data.title}/>}</>;
}
