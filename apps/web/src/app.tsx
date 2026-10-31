import { LoadingState } from './components/LoadingState';
import { useCallback, useEffect, useState } from 'react';
import { Link, Route, Routes, useParams } from 'react-router';
import type { WebEvent, WebProject } from '@bflow/contracts/web';
import { ApiClient, ApiError, consumeBootstrap } from './api/client';
import { subscribeEvents, type Connection } from './api/events';
import { AppShell } from './components/AppShell';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ErrorState } from './components/ErrorState';
import { EmptyState } from './components/EmptyState';
import { StatusBadge } from './components/StatusBadge';
import { Projects } from './features/projects';
import { Runs, RunView } from './features/runs';
import { ChatPage } from './features/chat/page';
import { Review } from './features/review';
import { Settings } from './features/settings';
import { useRead } from './features/data';
import { Blockers } from './components/Blockers';
import { decisionQuestionLabel } from './components/DecisionCard';
import { ReadProblems } from './components/ReadProblems';
import { SessionActions } from './features/run-actions/session';
import { Operations } from './features/operations';
import { RequestForm } from './features/requests';
import { ClarificationForm } from './features/clarifications';

export function App({api,bootstrap}:{api:ApiClient;bootstrap?:string|undefined}) {
  const [ready,setReady]=useState(false),[error,setError]=useState<unknown>(),[attempt,setAttempt]=useState(0),[revision,setRevision]=useState(0);
  const refresh=useCallback(()=>setRevision(value=>value+1),[]);
  useEffect(()=>{let active=true;void api.authenticate(attempt===0?bootstrap:undefined).then(()=>{if(active){setReady(true);setError(undefined);}},e=>{if(active)setError(e);});return()=>{active=false;};},[api,bootstrap,attempt]);
  useEffect(()=>{if(!ready || !api.expiresAt)return;const timer=setTimeout(()=>{setReady(false);setError(new ApiError('session_required'));},Math.max(0,Date.parse(api.expiresAt)-Date.now()));return()=>clearTimeout(timer);},[api,ready,attempt]);
  // A pairing link opened on an already loaded document changes only the fragment; the secret is still consumed before any render.
  useEffect(()=>{const pair=()=>{if(!location.hash.includes('bootstrap='))return;const secret=consumeBootstrap();if(!secret)return;setReady(false);setError(undefined);void api.authenticate(secret).then(()=>{setReady(true);setError(undefined);},e=>setError(e));};window.addEventListener('hashchange',pair);return()=>window.removeEventListener('hashchange',pair);},[api]);
  return <Routes><Route path="*" element={!ready?<AppShell projects={[]}>{error?<ErrorState error={error} retry={()=>setAttempt(value=>value+1)}/>:<LoadingState loading initial label="Đang ghép nối trình duyệt…"/>}</AppShell>:<Workspace api={api} revision={revision} refresh={refresh}/>}/></Routes>;
}
function Workspace({api,revision,refresh}:{api:ApiClient;revision:number;refresh:()=>void}) {
  const result=useRead('projects',()=>api.projects(),revision);
  const projects=result.data?.items??[];
  return <Routes><Route path="/" element={<AppShell projects={projects}><LoadingState loading={result.loading} initial={!result.data} label="Đang tải dự án…"/>{Boolean(result.error) && <ErrorState stale={Boolean(result.data)} error={result.error} retry={refresh}/>}{result.data && <Projects api={api} projects={projects} refresh={refresh}/>}</AppShell>}/><Route path="/projects/:projectId/*" element={<Project api={api} projects={projects} projectsLoading={result.loading} projectsError={result.error} revision={revision} refresh={refresh}/>}/><Route path="*" element={<AppShell projects={projects}><EmptyState title="Không tìm thấy trang"><Link to="/">Về quản lý dự án</Link></EmptyState></AppShell>}/></Routes>;
}
function Project({api,projects,projectsLoading,projectsError,revision,refresh}:{api:ApiClient;projects:WebProject[];projectsLoading:boolean;projectsError:unknown;revision:number;refresh:()=>void}) {
  const {projectId=''}=useParams(); const project=projects.find(project=>project.projectId===projectId);
  return <AppShell projects={projects} projectId={projectId}>{project?<ProjectContent key={projectId} api={api} project={project} revision={revision} refresh={refresh}/>:projectsError?<ErrorState error={projectsError} retry={refresh}/>:projectsLoading?<LoadingState loading initial label="Đang tải dự án…"/>:<EmptyState title="Dự án chưa được đăng ký"><Link to="/">Mở quản lý dự án</Link></EmptyState>}</AppShell>;
}
function ProjectContent({api,project,revision,refresh}:{api:ApiClient;project:WebProject;revision:number;refresh:()=>void}) {
  const id=project.projectId;
  const [connection,setConnection]=useState<Connection>('connecting'),[events,setEvents]=useState<WebEvent[]>([]);
  useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const update=(event:WebEvent)=>{setEvents(old=>[event,...old].slice(0,25));if(timer===undefined)timer=setTimeout(()=>{timer=undefined;refresh();},150);};
    const close=subscribeEvents(id,update,setConnection);
    const online=()=>refresh();
    window.addEventListener('online',online);
    return()=>{close();clearTimeout(timer);window.removeEventListener('online',online);};
  },[id,refresh]);
  useEffect(()=>{if(connection==='connected')return;const poll=setInterval(refresh,15000);return()=>clearInterval(poll);},[connection,refresh]);
  return <Operations api={api} id={id} refresh={refresh}><div className="mb-4 flex min-h-11 flex-wrap items-center justify-between gap-3 border-b border-line pb-2.5 font-data text-sm"><div className="flex flex-wrap items-center gap-3"><span className="font-semibold text-ink">{project.displayName}</span><ConnectionBanner state={connection}/></div><button className="min-w-28" onClick={refresh}>Tải lại dữ liệu</button></div><Routes><Route index element={<Overview api={api} project={project} revision={revision} refresh={refresh} events={events}/>}/><Route path="runs" element={<Runs api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="runs/:runId" element={<RunRoute api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="chat" element={<ChatPage api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="chat/:runId" element={<ChatPage api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="review" element={<Review api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="settings" element={<Settings api={api} project={project} refresh={refresh}/>}/><Route path="*" element={<EmptyState title="Không tìm thấy trang"><Link to={`/projects/${encodeURIComponent(id)}`}>Về tổng quan dự án</Link></EmptyState>}/></Routes></Operations>;
}
function RunRoute({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) { const {runId=''}=useParams();return <RunView key={runId} api={api} id={id} runId={runId} revision={revision} refresh={refresh}/>; }
function Overview({api,project,revision,refresh,events}:{api:ApiClient;project:WebProject;revision:number;refresh:()=>void;events:WebEvent[]}) {
  const id=project.projectId;
  const runs=useRead(`overview-runs:${id}`,()=>api.runs(id),revision),decisions=useRead(`overview-decisions:${id}`,()=>api.decisions(id),revision);
  const session=useRead(`session:${id}`,()=>api.sessionView(id),revision),preview=useRead(`preview:${id}`,()=>api.preview(id),revision);
  useEffect(()=>{if(!session.data || !['starting','stopping'].includes(session.data.state))return;const poll=setInterval(refresh,2500);return()=>clearInterval(poll);},[session.data?.state,refresh]);
  const pendingDecisions=(decisions.data?.items??[]).filter(decision=>decision.status==='pending');
  return <><div className="mb-3 flex flex-wrap items-baseline justify-between gap-2"><div><div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">Dự án / Tổng quan</div><h1 className="mt-1 mb-1">Tổng quan <em>dự án.</em></h1><p className="m-0 max-w-2xl text-sm text-muted">Theo dõi tiến độ thực tế, trả lời làm rõ và phê duyệt kết quả ngay tại một nơi.</p></div></div>
    <ReadProblems retry={refresh} problems={[{label:'phiên dự án',result:session},{label:'công việc',result:runs},{label:'quyết định',result:decisions},{label:'thông tin chuẩn bị',result:preview}].filter(item=>Boolean(item.result.error)).map(item=>({label:item.label,error:item.result.error,stale:Boolean(item.result.data)}))}/><LoadingState loading={session.loading} initial={!session.data} label="Đang đọc phiên dự án…"/>
    {session.data && <section className="panel my-3 min-w-0 border border-line bg-surface p-3.5 sm:p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><h2 className="m-0 text-base">Phiên dự án</h2><StatusBadge prefix="Phiên" value={session.data.state}/>{session.data.conversationStatus && <StatusBadge prefix="Hội thoại" value={session.data.conversationStatus}/>}</div><Link className="font-data text-xs font-semibold" to={`/projects/${encodeURIComponent(id)}/settings`}>Kiểm tra điều kiện dự án →</Link></div>
      {session.data.state!=='ready' && <div className="my-2.5 border-l-3 border-accent bg-canvas px-3 py-2 text-sm"><p className="m-0 font-data font-semibold text-ink">3 bước để bắt đầu làm việc:</p><ol className="my-1.5 pl-5 text-sm text-muted"><li><Link to={`/projects/${encodeURIComponent(id)}/settings`}>Mở Cài đặt dự án →</Link> để khởi tạo cấu hình, chọn model và commit cấu hình.</li><li>Quay lại đây và bấm <strong>Khởi động phiên</strong>.</li><li>Điền biểu mẫu <strong>Tạo công việc</strong> bên dưới để giao việc.</li></ol></div>}
      <SessionActions api={api} id={id} session={session.data} fresh={!session.loading && !session.error}/><Blockers items={session.data.blockers}/>
      {session.data.pendingIntakes.map(intake=><article className="panel mt-3 min-w-0 border border-line bg-canvas p-3.5 sm:p-4" key={intake.intakeId}><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="m-0">{intake.title}</h3><div className="flex items-center gap-2"><StatusBadge value={intake.status}/>{intake.runId && <Link className="text-sm" to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(intake.runId)}`}>Mở công việc →</Link>}</div></div>{intake.clarifications.map(question=><ClarificationForm key={question.questionId+question.expectedVersion.revisionToken} api={api} id={id} intakeId={intake.intakeId} question={question} enabled={!session.loading && !session.error && session.data?.state==='ready' && intake.status==='clarifying'}/>)}</article>)}
    </section>}

    <div className="my-4 grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(260px,2fr)]">
    <section className="m-0 border border-line bg-surface p-3.5 sm:p-4"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="m-0 text-base">Công việc gần đây</h2><Link className="text-sm" to={`/projects/${encodeURIComponent(id)}/runs`}>Xem tất cả công việc →</Link></div><LoadingState loading={runs.loading} initial={!runs.data} label="Đang đọc công việc…"/>{runs.data && <><p className="my-1.5 text-xs text-muted">{runs.data.items.length} công việc gần đây{runs.data.nextCursor?' · Còn trang tiếp theo':''}.</p>{runs.data.items.length?[...runs.data.items].sort((a,b)=>Number(['completed','failed','cancelled'].includes(a.sdlcStatus))-Number(['completed','failed','cancelled'].includes(b.sdlcStatus))||b.updatedAt.localeCompare(a.updatedAt)).slice(0,5).map(run=><article className="grid min-w-0 grid-cols-1 items-center gap-2 border-t border-line py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-3" key={run.runId}><Link className="font-medium" to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.runId)}`}>{run.title}</Link><StatusBadge value={run.sdlcStatus}/></article>):<p className="my-2 text-sm text-muted">Chưa có công việc trong phiên này.</p>}</>}</section>
    <section className={`m-0 border bg-surface p-3.5 sm:p-4 ${pendingDecisions.length?'border-accent border-l-3':'border-line'}`}><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="m-0 text-base">Đang chờ xem xét</h2><Link className="text-sm" to={`/projects/${encodeURIComponent(id)}/review`}>Mở hộp xem xét →</Link></div><LoadingState loading={decisions.loading} initial={!decisions.data} label="Đang đọc quyết định…"/>{decisions.data && <><p className="my-1.5 text-xs text-muted">{pendingDecisions.length} quyết định đang chờ bạn duyệt.</p>{pendingDecisions.slice(0,3).map(decision=><p key={decision.decisionId} className="my-0 border-t border-line py-2.5 text-sm"><Link className="font-medium" to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(decision.runId)}`}>{decisionQuestionLabel(decision.question)}</Link></p>)}</>}</section>
    </div>
    {session.data && <RequestForm key={session.data.sessionId??'stopped'} api={api} id={id} sessionId={session.data.sessionId??'stopped'} enabled={session.data.state==='ready' && !session.loading && !session.error}/>}

    <div className="my-3 grid gap-x-6 lg:grid-cols-2">
      <details className="my-1"><summary>Thông tin chuẩn bị</summary><LoadingState loading={preview.loading} initial={!preview.data} label="Đang tải…"/>{preview.data && <><p className="text-sm">{preview.data.available?'Đã đọc được cấu hình dự kiến. Cấu hình không tự cấp quyền thực thi khi chưa khởi động phiên.':'Chưa có thông tin cấu hình dự kiến.'}</p><Blockers items={preview.data.blockers}/></>}</details>
      <details className="my-1"><summary>Hoạt động gần đây ({events.length})</summary><p className="text-xs text-muted">Cập nhật trực tiếp nhận trong lần mở trang này.</p>{events.length?<ol className="space-y-1.5 text-xs tabular-nums">{events.slice(0,10).map((event,index)=><li key={`${event.cursor}:${index}`}><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString('vi')}</time> · {event.type==='reset'?'Đã đồng bộ lại dữ liệu hiện hành':event.type==='notice'?'Có thông báo mới trong công việc':'Dữ liệu dự án vừa cập nhật'}</li>)}</ol>:<p className="text-sm text-muted">Chưa nhận cập nhật mới trong lần mở trang này.</p>}</details>
    </div>
  </>;
}
