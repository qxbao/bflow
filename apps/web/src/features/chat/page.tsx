import { useEffect, useRef } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { ApiClient, ApiError } from '../../api/client';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { Pagination } from '../../components/Pagination';
import { phases } from '../../components/StatusBadge';
import { useRead } from '../data';
import { useCursorPagination } from '../pagination';
import { ago } from '../runs';
import { ChatHistory } from './index';
import { useOptionalDirector } from '../director/status';
import { DirectorChat } from '../director/chat';

/** A draft handed over by the 3D chat bar. It only prefills the composer; nothing is sent from here. */
function handedDraft(state:unknown):string{const draft=(state as {draft?:unknown}|null)?.draft;return typeof draft==='string'?draft.slice(0,4000):'';}
const finished=(status:string)=>['completed','completed_with_parked','failed','cancelled'].includes(status);
/** One conversation per run: the list picks the run, the thread shows only that run. */
export function ChatPage({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) {
  const {runId}=useParams(),location=useLocation(),base=`/projects/${encodeURIComponent(id)}/chat`,draft=handedDraft(location.state);
  // A confirmed Director layout selects the project-scoped Director chat; per-run Conversation threads remain as read-only history.
  const director=Boolean(useOptionalDirector()?.directorLayout);
  const pagination=useCursorPagination(JSON.stringify(['chat',id])),cursor=pagination.cursor;
  const runs=useRead(`chat-runs:${id}:${cursor??''}`,()=>api.runs(id,undefined,undefined,cursor),revision);
  const items=[...(runs.data?.items??[])].sort((a,b)=>Number(finished(a.sdlcStatus))-Number(finished(b.sdlcStatus))||b.updatedAt.localeCompare(a.updatedAt));
  return <><h1 className={runId?'sr-only':'lg:sr-only'}>Trò chuyện</h1>
    <div className="grid min-w-0 border border-line bg-surface lg:grid-cols-[280px_minmax(0,1fr)]">
      <nav data-component="ChatPage" aria-label={director?'Lịch sử Conversation theo công việc (chỉ đọc)':'Trò chuyện theo công việc'} className={`${runId?'hidden lg:block':'block'} min-w-0 border-line lg:h-[calc(100dvh-15rem)] lg:min-h-[26rem] lg:overflow-y-auto lg:border-r`}>
        {director && <div className="border-b border-line px-3 py-2"><NavLink end to={{pathname:base,search:location.search}} className="block font-data text-sm font-semibold">Trò chuyện với Director</NavLink><p className="m-0 mt-1 font-data text-xs text-muted">Lịch sử Conversation cũ bên dưới chỉ để đọc.</p></div>}
        <LoadingState loading={runs.loading} initial={!runs.data} label="Đang tải công việc…"/>
        {Boolean(runs.error) && <ErrorState stale={Boolean(runs.data)} error={runs.error} retry={()=>{if(cursor && runs.error instanceof ApiError && runs.error.code==='stale_version')pagination.first?.();refresh();}}/>}
        {runs.data && !items.length && <p className="p-4 text-sm text-muted">Chưa có công việc để trò chuyện.</p>}
        {items.map(run=><NavLink key={run.runId} to={{pathname:`${base}/${encodeURIComponent(run.runId)}`,search:location.search}} {...(draft?{state:{draft}}:{})} className="block min-w-0 border-b border-l-2 border-line border-l-transparent px-3 py-3 text-ink no-underline hover:bg-faint hover:no-underline aria-[current=page]:border-l-accent aria-[current=page]:bg-faint">
          <span className="block truncate font-data text-sm font-semibold">{run.title}</span>
          <span className="block truncate font-data text-xs text-muted">{phases[run.sdlcStatus]??run.sdlcStatus} · {ago(run.updatedAt)}</span>
        </NavLink>)}
        {runs.data && <div className="px-3"><Pagination label="Phân trang danh sách trò chuyện" page={pagination.page} first={pagination.first} previous={pagination.previous} next={runs.data.nextCursor?()=>pagination.next(runs.data!.nextCursor!):undefined} busy={runs.loading || Boolean(runs.error)}/></div>}
      </nav>
      <div className={`${runId||director?'block':'hidden lg:block'} min-w-0`}>
        {runId?<><Link className="block border-b border-line px-4 py-2 font-data text-sm lg:hidden" to={{pathname:base,search:location.search}}>← Danh sách trò chuyện</Link><Thread key={runId} api={api} id={id} runId={runId} revision={revision} refresh={refresh} draft={draft} readOnly={director}/></>:director?<DirectorChat {...(draft?{initialDraft:draft}:{})}/>:<div className="p-6"><EmptyState title="Chọn một công việc"><p>Mỗi công việc có một cuộc trò chuyện riêng với Conversation.</p>{draft&&<p className="whitespace-pre-wrap border-l-3 border-line pl-3 text-sm">Bản nháp chưa gửi: {draft}</p>}</EmptyState></div>}
      </div>
    </div>
  </>;
}
function Thread({api,id,runId,revision,refresh,draft,readOnly}:{api:ApiClient;id:string;runId:string;revision:number;refresh:()=>void;draft:string;readOnly:boolean}) {
  const navigate=useNavigate(),location=useLocation(),wasCurrent=useRef(false);
  const run=useRead(`chat-run:${id}:${runId}`,()=>api.run(id,runId),revision);
  useEffect(()=>{
    const current=run.data;if(!current || current.runId!==runId)return;
    if(current.currentRunId===runId)wasCurrent.current=true;
    else if(wasCurrent.current){wasCurrent.current=false;navigate({pathname:`/projects/${encodeURIComponent(id)}/chat/${encodeURIComponent(current.currentRunId)}`,search:location.search});}
  },[id,location.search,navigate,run.data,runId]);
  return <><LoadingState loading={run.loading} initial={!run.data} label="Đang tải cuộc trò chuyện…"/>{Boolean(run.error) && <div className="p-4"><ErrorState stale={Boolean(run.data)} error={run.error} retry={refresh}/></div>}{run.data && <>{run.data.currentRunId!==runId && <div className="border-b border-line border-l-3 border-l-warning bg-canvas px-4 py-2 font-data text-xs text-warning">Công việc này đã được tiếp nối ở phiên bản mới. <Link to={{pathname:`/projects/${encodeURIComponent(id)}/chat/${encodeURIComponent(run.data.currentRunId)}`,search:location.search}}>Mở trò chuyện hiện hành →</Link></div>}<ChatHistory api={api} projectId={id} sessionId={run.data.sessionId} runId={run.data.runId} revision={revision} title={run.data.title} readOnly={readOnly} {...(draft&&!readOnly?{initialDraft:draft}:{})}/></>}</>;
}
