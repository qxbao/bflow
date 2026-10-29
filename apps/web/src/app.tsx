import { useCallback, useEffect, useState } from 'react';
import { Link, Route, Routes, useParams } from 'react-router';
import type { WebEvent, WebProject } from '@bflow/contracts/web';
import { ApiClient, ApiError } from './api/client';
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
import { reason } from './components/reasons';
import { SessionActions } from './features/run-actions/session';
import { Operations } from './features/operations';
import { RequestForm } from './features/requests';
import { ClarificationForm } from './features/clarifications';

export function App({api,bootstrap}:{api:ApiClient;bootstrap?:string|undefined}) {
  const [ready,setReady]=useState(false),[error,setError]=useState<unknown>(),[attempt,setAttempt]=useState(0),[revision,setRevision]=useState(0);
  const refresh=useCallback(()=>setRevision(value=>value+1),[]);
  useEffect(()=>{let active=true;void api.authenticate(attempt===0?bootstrap:undefined).then(()=>{if(active){setReady(true);setError(undefined);}},e=>{if(active)setError(e);});return()=>{active=false;};},[api,bootstrap,attempt]);
  useEffect(()=>{if(!ready || !api.expiresAt)return;const timer=setTimeout(()=>{setReady(false);setError(new ApiError('session_required'));},Math.max(0,Date.parse(api.expiresAt)-Date.now()));return()=>clearTimeout(timer);},[api,ready,attempt]);
  return <Routes><Route path="*" element={!ready?<AppShell projects={[]}>{error?<ErrorState error={error} retry={()=>setAttempt(value=>value+1)}/>:<p role="status">Đang ghép nối trình duyệt…</p>}</AppShell>:<Workspace api={api} revision={revision} refresh={refresh}/>}/></Routes>;
}
function Workspace({api,revision,refresh}:{api:ApiClient;revision:number;refresh:()=>void}) {
  const result=useRead('projects',()=>api.projects(),revision);
  const projects=result.data?.items??[];
  return <Routes><Route path="/" element={<AppShell projects={projects}>{result.loading && <p role="status">Đang tải dự án…</p>}{Boolean(result.error) && <ErrorState stale={Boolean(result.data)} error={result.error} retry={refresh}/>}{result.data && <Projects api={api} projects={projects} refresh={refresh}/>}</AppShell>}/><Route path="/projects/:projectId/*" element={<Project api={api} projects={projects} projectsLoading={result.loading} projectsError={result.error} revision={revision} refresh={refresh}/>}/><Route path="*" element={<AppShell projects={projects}><EmptyState title="Không tìm thấy trang"><Link to="/">Về quản lý dự án</Link></EmptyState></AppShell>}/></Routes>;
}
function Project({api,projects,projectsLoading,projectsError,revision,refresh}:{api:ApiClient;projects:WebProject[];projectsLoading:boolean;projectsError:unknown;revision:number;refresh:()=>void}) {
  const {projectId=''}=useParams(); const project=projects.find(project=>project.projectId===projectId);
  return <AppShell projects={projects} projectId={projectId}>{project?<ProjectContent key={projectId} api={api} project={project} revision={revision} refresh={refresh}/>:projectsError?<ErrorState error={projectsError} retry={refresh}/>:projectsLoading?<p role="status">Đang tải dự án…</p>:<EmptyState title="Dự án chưa được đăng ký"><Link to="/">Mở quản lý dự án</Link></EmptyState>}</AppShell>;
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
  return <Operations api={api} id={id} refresh={refresh}><ConnectionBanner state={connection}/><div className="project-heading"><span>{project.displayName}</span><button onClick={refresh}>Tải lại dữ liệu</button></div><Routes><Route index element={<Overview api={api} project={project} revision={revision} refresh={refresh} events={events}/>}/><Route path="runs" element={<Runs api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="runs/:runId" element={<RunRoute api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="review" element={<Review api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="settings" element={<Settings api={api} project={project}/>}/><Route path="*" element={<EmptyState title="Không tìm thấy trang"><Link to={`/projects/${encodeURIComponent(id)}`}>Về tổng quan dự án</Link></EmptyState>}/></Routes></Operations>;
}
function RunRoute({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) { const {runId=''}=useParams();return <RunView key={runId} api={api} id={id} runId={runId} revision={revision} refresh={refresh}/>; }
function Overview({api,project,revision,refresh,events}:{api:ApiClient;project:WebProject;revision:number;refresh:()=>void;events:WebEvent[]}) {
  const id=project.projectId;
  const runs=useRead(`overview-runs:${id}`,()=>api.runs(id),revision),decisions=useRead(`overview-decisions:${id}`,()=>api.decisions(id),revision);
  const session=useRead(`session:${id}`,()=>api.sessionView(id),revision),preview=useRead(`preview:${id}`,()=>api.preview(id),revision);
  return <><div className="eyebrow">Dự án / Tổng quan</div><h1>Công việc, <em>rõ từng bước.</em></h1><p className="lead">Theo dõi tiến độ thực tế. Đọc thiết kế và kết quả trước khi quyết định.</p>
    {session.loading && <p role="status">Đang đọc phiên dự án…</p>}{Boolean(session.error) && <ErrorState stale={Boolean(session.data)} error={session.error} retry={refresh}/>}
    {session.data && <section className="panel"><h2>Phiên dự án</h2><StatusBadge prefix="Phiên" value={session.data.state}/>{session.data.conversationStatus && <StatusBadge prefix="Hội thoại" value={session.data.conversationStatus}/>}
      {session.data.state!=='ready' && <p>Phiên dự án chưa sẵn sàng. Kiểm tra điều kiện trên máy trước khi khởi động bằng Bflow.</p>}<p><Link to={`/projects/${encodeURIComponent(id)}/settings`}>Kiểm tra điều kiện dự án →</Link></p>
      <SessionActions api={api} id={id} session={session.data} fresh={!session.loading && !session.error}/>{session.data.blockers.map((blocker,index)=><p className="quote" key={index}>{reason(blocker.code)}</p>)}
      {session.data.pendingIntakes.map(intake=><article className="panel" key={intake.intakeId}><h3>{intake.title}</h3><StatusBadge value={intake.status}/>{intake.runId && <Link to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(intake.runId)}`}>Mở công việc →</Link>}{intake.clarifications.map(question=><ClarificationForm key={question.questionId+question.expectedVersion.revisionToken} api={api} id={id} intakeId={intake.intakeId} question={question} enabled={!session.loading && !session.error && session.data?.state==='ready' && intake.status==='clarifying'}/>)}</article>)}
    </section>}
    {session.data && <RequestForm key={session.data.sessionId??'stopped'} api={api} id={id} sessionId={session.data.sessionId??'stopped'} enabled={session.data.state==='ready' && !session.loading && !session.error}/>}
    <section><h2>Công việc gần đây</h2>{runs.loading && <p>Đang đọc công việc…</p>}{Boolean(runs.error) && <ErrorState stale={Boolean(runs.data)} error={runs.error} retry={refresh}/>} {runs.data && <><p className="muted">{runs.data.items.length} công việc trong trang gần đây{runs.data.nextCursor?' · Còn trang tiếp theo':''}.</p>{runs.data.items.length?runs.data.items.slice(0,5).map(run=><article className="run-row" key={run.runId}><Link to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.runId)}`}>{run.title}</Link><StatusBadge value={run.sdlcStatus}/></article>):<p>Chưa có công việc trong phiên này.</p>}</>}</section>
    <section><h2>Đang chờ xem xét</h2>{decisions.loading && <p>Đang đọc quyết định…</p>}{Boolean(decisions.error) && <ErrorState stale={Boolean(decisions.data)} error={decisions.error} retry={refresh}/>} {decisions.data && <p>{decisions.data.items.filter(decision=>decision.status==='pending').length} quyết định đang chờ trong bản đọc hiện tại.</p>}</section>
    <div className="card-grid"><Link className="project-card" to={`/projects/${encodeURIComponent(id)}/runs`}><h2>Công việc</h2><p>Giai đoạn, nhiệm vụ và điểm cần xử lý.</p><span>Mở danh sách →</span></Link><Link className="project-card" to={`/projects/${encodeURIComponent(id)}/review`}><h2>Cần bạn quyết định</h2><p>Gói thiết kế, kết quả và tài liệu kiểm chứng.</p><span>Mở hộp xem xét →</span></Link></div>
    <section><h2>Thông tin chuẩn bị</h2>{preview.loading && <p>Đang tải…</p>}{Boolean(preview.error) && <ErrorState stale={Boolean(preview.data)} error={preview.error} retry={refresh}/>} {preview.data && <><p>{preview.data.available?'Đã đọc được cấu hình dự kiến. Cấu hình không cấp quyền thực thi hoặc chứng minh phiên đã sẵn sàng.':'Chưa có thông tin cấu hình dự kiến.'}</p>{preview.data.blockers.map((blocker,index)=><p className="quote" key={index}>{reason(blocker.code)}</p>)}</>}</section>
    <section><h2>Hoạt động gần đây</h2><p className="muted">Cập nhật nhận trong lần mở trang này; không phải toàn bộ lịch sử thực thi.</p>{events.length?<ol className="timeline">{events.map((event,index)=><li key={`${event.cursor}:${index}`}><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString('vi')}</time> · {event.type==='reset'?'Đã yêu cầu đọc lại dữ liệu hiện hành':event.type==='notice'?'Có cập nhật cần kiểm tra trong công việc':'Dữ liệu dự án đã được cập nhật'}</li>)}</ol>:<p>Chưa nhận cập nhật trong lần mở trang này.</p>}</section>
  </>;
}
