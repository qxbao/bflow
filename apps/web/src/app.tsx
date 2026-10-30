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
import { Review } from './features/review';
import { Settings } from './features/settings';
import { useRead } from './features/data';
import { Blockers } from './components/Blockers';
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
    const offline=()=>setConnection('offline'),online=()=>{setConnection('reconnecting');refresh();};
    window.addEventListener('offline',offline);window.addEventListener('online',online);
    return()=>{close();clearTimeout(timer);window.removeEventListener('offline',offline);window.removeEventListener('online',online);};
  },[id,refresh]);
  useEffect(()=>{if(connection==='connected')return;const poll=setInterval(refresh,15000);return()=>clearInterval(poll);},[connection,refresh]);
  return <Operations api={api} id={id} refresh={refresh}><ConnectionBanner state={connection}/><div className="my-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3 font-data text-sm"><span>{project.displayName}</span><button onClick={refresh}>Tải lại dữ liệu</button></div><Routes><Route index element={<Overview api={api} project={project} revision={revision} refresh={refresh} events={events}/>}/><Route path="runs" element={<Runs api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="runs/:runId" element={<RunRoute api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="review" element={<Review api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="settings" element={<Settings api={api} project={project} refresh={refresh}/>}/><Route path="*" element={<EmptyState title="Không tìm thấy trang"><Link to={`/projects/${encodeURIComponent(id)}`}>Về tổng quan dự án</Link></EmptyState>}/></Routes></Operations>;
}
function RunRoute({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) { const {runId=''}=useParams();return <RunView key={runId} api={api} id={id} runId={runId} revision={revision} refresh={refresh}/>; }
function Overview({api,project,revision,refresh,events}:{api:ApiClient;project:WebProject;revision:number;refresh:()=>void;events:WebEvent[]}) {
  const id=project.projectId;
  const runs=useRead(`overview-runs:${id}`,()=>api.runs(id),revision),decisions=useRead(`overview-decisions:${id}`,()=>api.decisions(id),revision);
  const session=useRead(`session:${id}`,()=>api.sessionView(id),revision),preview=useRead(`preview:${id}`,()=>api.preview(id),revision);
  return <><div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">Dự án / Tổng quan</div><h1>Tổng quan <em>dự án.</em></h1><p className="mb-5 max-w-2xl text-base text-muted">Theo dõi tiến độ thực tế. Đọc thiết kế và kết quả trước khi quyết định.</p>
    <ReadProblems retry={refresh} problems={[{label:'phiên dự án',result:session},{label:'công việc',result:runs},{label:'quyết định',result:decisions},{label:'thông tin chuẩn bị',result:preview}].filter(item=>Boolean(item.result.error)).map(item=>({label:item.label,error:item.result.error,stale:Boolean(item.result.data)}))}/><LoadingState loading={session.loading} initial={!session.data} label="Đang đọc phiên dự án…"/>
    {session.data && <section className="panel min-w-0 border border-line bg-surface p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="m-0">Phiên dự án</h2><div className="flex flex-wrap gap-1"><StatusBadge prefix="Phiên" value={session.data.state}/>{session.data.conversationStatus && <StatusBadge prefix="Hội thoại" value={session.data.conversationStatus}/>}</div></div>
      {session.data.state!=='ready' && <p>Phiên dự án chưa sẵn sàng. Mở Cài đặt dự án để khởi tạo GitNexus, chọn model và lưu/commit cấu hình; sau đó khởi động phiên ngay tại đây.</p>}<p><Link to={`/projects/${encodeURIComponent(id)}/settings`}>Kiểm tra điều kiện dự án →</Link></p>
      <SessionActions api={api} id={id} session={session.data} fresh={!session.loading && !session.error}/><Blockers items={session.data.blockers}/>
      {session.data.pendingIntakes.map(intake=><article className="panel min-w-0 border border-line bg-surface p-4 sm:p-5" key={intake.intakeId}><h3>{intake.title}</h3><StatusBadge value={intake.status}/>{intake.runId && <Link to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(intake.runId)}`}>Mở công việc →</Link>}{intake.clarifications.map(question=><ClarificationForm key={question.questionId+question.expectedVersion.revisionToken} api={api} id={id} intakeId={intake.intakeId} question={question} enabled={!session.loading && !session.error && session.data?.state==='ready' && intake.status==='clarifying'}/>)}</article>)}
    </section>}

    <div className="grid min-w-0 gap-x-6 xl:grid-cols-[minmax(0,3fr)_minmax(240px,2fr)]">
    <section><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="m-0">Công việc gần đây</h2><Link className="text-sm" to={`/projects/${encodeURIComponent(id)}/runs`}>Xem tất cả công việc →</Link></div><LoadingState loading={runs.loading} initial={!runs.data} label="Đang đọc công việc…"/>{runs.data && <><p className="text-sm text-muted">{runs.data.items.length} công việc trong trang gần đây{runs.data.nextCursor?' · Còn trang tiếp theo':''}.</p>{runs.data.items.length?[...runs.data.items].sort((a,b)=>Number(['completed','failed','cancelled'].includes(a.sdlcStatus))-Number(['completed','failed','cancelled'].includes(b.sdlcStatus))||b.updatedAt.localeCompare(a.updatedAt)).slice(0,5).map(run=><article className="grid min-w-0 grid-cols-1 items-start gap-2 border-t border-line py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4 [&_h2]:m-0 [&_h2]:text-lg [&_p]:my-1" key={run.runId}><Link to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.runId)}`}>{run.title}</Link><StatusBadge value={run.sdlcStatus}/></article>):<p>Chưa có công việc trong phiên này.</p>}</>}</section>
    <section><h2>Đang chờ xem xét</h2><LoadingState loading={decisions.loading} initial={!decisions.data} label="Đang đọc quyết định…"/>{decisions.data && <><p className="text-sm text-muted">{decisions.data.items.filter(decision=>decision.status==='pending').length} quyết định đang chờ trong bản đọc hiện tại.</p>{decisions.data.items.filter(decision=>decision.status==='pending').slice(0,3).map(decision=><p key={decision.decisionId} className="border-t border-line pt-3 text-sm"><Link to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(decision.runId)}`}>{decision.question}</Link></p>)}<Link className="text-sm" to={`/projects/${encodeURIComponent(id)}/review`}>Mở hộp xem xét →</Link></>}</section>
    </div>
    {session.data && <RequestForm key={session.data.sessionId??'stopped'} api={api} id={id} sessionId={session.data.sessionId??'stopped'} enabled={session.data.state==='ready' && !session.loading && !session.error}/>}

    <details><summary>Thông tin chuẩn bị</summary><LoadingState loading={preview.loading} initial={!preview.data} label="Đang tải…"/>{preview.data && <><p>{preview.data.available?'Đã đọc được cấu hình dự kiến. Cấu hình không cấp quyền thực thi hoặc chứng minh phiên đã sẵn sàng.':'Chưa có thông tin cấu hình dự kiến.'}</p><Blockers items={preview.data.blockers}/></>}</details>
    <details><summary>Hoạt động gần đây</summary><p className="text-sm text-muted">Cập nhật nhận trong lần mở trang này; không phải toàn bộ lịch sử thực thi.</p>{events.length?<ol className="space-y-2 text-sm tabular-nums">{events.map((event,index)=><li key={`${event.cursor}:${index}`}><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString('vi')}</time> · {event.type==='reset'?'Đã yêu cầu đọc lại dữ liệu hiện hành':event.type==='notice'?'Có cập nhật cần kiểm tra trong công việc':'Dữ liệu dự án đã được cập nhật'}</li>)}</ol>:<p>Chưa nhận cập nhật trong lần mở trang này.</p>}</details>
  </>;
}
