import { LoadingState } from './components/LoadingState';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useMatch, useNavigate, useParams } from 'react-router';
import type { WebEvent, WebProject, WebProjectSession } from '@bflow/contracts/web';
import { ApiClient, ApiError, consumeBootstrap } from './api/client';
import { subscribeEvents, type Connection } from './api/events';
import { AppShell } from './components/AppShell';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ErrorState } from './components/ErrorState';
import { EmptyState } from './components/EmptyState';
import { Projects } from './features/projects';
import { Runs, RunView } from './features/runs';
import { ChatPage } from './features/chat/page';
import { Review } from './features/review';
import { Settings } from './features/settings';
import { useRead } from './features/data';
import { Operations } from './features/operations';
import { Overview } from './features/overview';
import { useUiMode, type UiMode } from './features/office/mode';
import { OfficeFrame, OverviewOutlet } from './features/office/ui/OfficeFrame';
import { ModeSwitch } from './features/office/ui/ModeSwitch';
import { OfficeStage } from './features/office/ui/OfficeStage';
import { deriveOffice } from './features/office/model/derive';
import { applySeats } from './features/office/model/seats';
import type { SeatMap } from './features/office/model/types';

export function App({api,bootstrap}:{api:ApiClient;bootstrap?:string|undefined}) {
  const [ready,setReady]=useState(false),[error,setError]=useState<unknown>(),[attempt,setAttempt]=useState(0),[revision,setRevision]=useState(0);
  const refresh=useCallback(()=>setRevision(value=>value+1),[]);
  const pair=useCallback(async(secret:string)=>{try{await api.authenticate(secret);setReady(true);setError(undefined);refresh();}catch(e){setReady(false);setError(e);throw e;}},[api,refresh]);
  useEffect(()=>{let active=true;void api.authenticate(attempt===0?bootstrap:undefined).then(()=>{if(active){setReady(true);setError(undefined);}},e=>{if(active)setError(e);});return()=>{active=false;};},[api,bootstrap,attempt]);
  useEffect(()=>{if(!ready || !api.expiresAt)return;const timer=setTimeout(()=>{setReady(false);setError(new ApiError('session_required'));},Math.min(2_147_483_647,Math.max(0,Date.parse(api.expiresAt)-Date.now())));return()=>clearTimeout(timer);},[api,ready,attempt]);
  // A pairing link opened on an already loaded document changes only the fragment; the secret is still consumed before any render.
  useEffect(()=>{const onHash=()=>{if(!location.hash.includes('bootstrap='))return;const secret=consumeBootstrap();if(!secret)return;setReady(false);setError(undefined);void api.authenticate(secret).then(()=>{setReady(true);setError(undefined);},e=>setError(e));};window.addEventListener('hashchange',onHash);return()=>window.removeEventListener('hashchange',onHash);},[api]);
  return <Routes><Route path="*" element={!ready?<AppShell projects={[]}>{error?<ErrorState error={error} retry={()=>setAttempt(value=>value+1)} onPair={pair}/>:<LoadingState loading initial label="Đang ghép nối trình duyệt…"/>}</AppShell>:<Workspace api={api} revision={revision} refresh={refresh} onPair={pair}/>}/></Routes>;
}
function Workspace({api,revision,refresh,onPair}:{api:ApiClient;revision:number;refresh:()=>void;onPair:(secret:string)=>Promise<void>}) {
  const result=useRead('projects',()=>api.projects(),revision);
  const projects=result.data?.items??[];
  return <Routes><Route path="/" element={<AppShell projects={projects}><LoadingState loading={result.loading} initial={!result.data} label="Đang tải dự án…"/>{Boolean(result.error) && <ErrorState stale={Boolean(result.data)} error={result.error} retry={refresh} onPair={onPair}/>}{result.data && <Projects api={api} projects={projects} refresh={refresh}/>}</AppShell>}/><Route path="/projects/:projectId/*" element={<Project api={api} projects={projects} projectsLoading={result.loading} projectsError={result.error} revision={revision} refresh={refresh} onPair={onPair}/>}/><Route path="*" element={<AppShell projects={projects}><EmptyState title="Không tìm thấy trang"><Link to="/">Về quản lý dự án</Link></EmptyState></AppShell>}/></Routes>;
}
function Project({api,projects,projectsLoading,projectsError,revision,refresh,onPair}:{api:ApiClient;projects:WebProject[];projectsLoading:boolean;projectsError:unknown;revision:number;refresh:()=>void;onPair:(secret:string)=>Promise<void>}) {
  const {projectId=''}=useParams(); const project=projects.find(project=>project.projectId===projectId);
  const [mode,setMode]=useUiMode(),[overviewOpen,setOverviewOpen]=useState(false),[host,setHost]=useState<HTMLElement|null>(null),[hud,setHud]=useState<HTMLElement|null>(null);
  const navigate=useNavigate(),isIndex=Boolean(useMatch({path:'/projects/:projectId',end:true})),base=`/projects/${encodeURIComponent(projectId)}`;
  useEffect(()=>setOverviewOpen(false),[projectId]);
  // Overview is only meaningful at the index path; leaving it forgets the HUD-opened state.
  useEffect(()=>{if(!isIndex)setOverviewOpen(false);},[isIndex]);
  // Visual mode: the index path closes the panel (or shows the HUD-opened overview); every other route opens it.
  const visual=mode==='visual' && Boolean(project),panelOpen=!isIndex || overviewOpen;
  const close=useCallback(()=>{setOverviewOpen(false);if(!isIndex)navigate(base);},[isIndex,navigate,base]);
  const showOverview=useCallback(()=>setOverviewOpen(true),[]);
  const openOverview=useCallback(()=>{setOverviewOpen(true);if(!isIndex)navigate(base);},[isIndex,navigate,base]);
  return <AppShell projects={projects} projectId={projectId} visual={visual?{panelOpen,onClose:close,onOverview:showOverview,hudRef:setHud,stageRef:setHost}:undefined}>{project?<ProjectContent key={projectId} api={api} project={project} revision={revision} refresh={refresh} frame={{mode,setMode,overviewOpen,panelOpen,hud,host,openOverview}}/>:projectsError?<ErrorState error={projectsError} retry={refresh} onPair={onPair}/>:projectsLoading?<LoadingState loading initial label="Đang tải dự án…"/>:<EmptyState title="Dự án chưa được đăng ký"><Link to="/">Mở quản lý dự án</Link></EmptyState>}</AppShell>;
}
type Frame={mode:UiMode;setMode:(mode:UiMode)=>void;overviewOpen:boolean;panelOpen:boolean;hud:HTMLElement|null;host:HTMLElement|null;openOverview:()=>void};
function ProjectContent({api,project,revision,refresh,frame}:{api:ApiClient;project:WebProject;revision:number;refresh:()=>void;frame:Frame}) {
  const id=project.projectId;
  const [connection,setConnection]=useState<Connection>('connecting'),[events,setEvents]=useState<WebEvent[]>([]);
  const hadDisconnect=useRef(false);
  const session=useRead(`session:${id}`,()=>api.sessionView(id),revision);
  const sessionInactive=Boolean(session.data && !session.error && ['stopped','unavailable'].includes(session.data.state));
  const wasNotReady=useRef(false),[reconnectEpoch,setReconnectEpoch]=useState(0);
  useEffect(()=>{
    const state=session.data?.state;
    if(!state)return;
    if(state!=='ready')wasNotReady.current=true;
    else if(wasNotReady.current){wasNotReady.current=false;setReconnectEpoch(value=>value+1);}
  },[session.data?.state]);
  useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const update=(event:WebEvent)=>{setEvents(old=>[event,...old].slice(0,25));if(timer===undefined)timer=setTimeout(()=>{timer=undefined;refresh();},150);};
    const onConnection=(next:Connection)=>{
      setConnection(next);
      if(next==='reconnecting' || next==='offline')hadDisconnect.current=true;
      else if(next==='connected' && hadDisconnect.current){hadDisconnect.current=false;refresh();}
    };
    const close=subscribeEvents(id,update,onConnection);
    const online=()=>refresh();
    window.addEventListener('online',online);
    return()=>{close();clearTimeout(timer);window.removeEventListener('online',online);};
  },[id,refresh,reconnectEpoch]);
  useEffect(()=>{if(connection==='connected')return;const poll=setInterval(refresh,15000);return()=>clearInterval(poll);},[connection,refresh]);
  const mark=<div className="flex flex-wrap items-center gap-3"><span className="font-semibold text-ink">{project.displayName}</span><ConnectionBanner state={connection} inactive={sessionInactive}/></div>;
  const visual=frame.mode==='visual';
  const list=<ul className="m-0 list-none p-0">{[['runs','Công việc'],['chat','Trò chuyện'],['review','Cần bạn quyết định'],['settings','Cài đặt dự án']].map(([path,title])=><li key={path} className="border-t border-line py-2 first:border-t-0"><Link to={`/projects/${encodeURIComponent(id)}/${path}`}>{title}</Link></li>)}</ul>;
  const stage=<VisualOffice api={api} id={id} session={session.data} connection={connection} revision={revision} list={list}/>;
  return <Operations api={api} id={id} revision={revision} refresh={refresh} dock={visual?'external':'inline'}>{!visual && <div className="mb-4 flex min-h-11 flex-wrap items-center justify-between gap-3 border-b border-line pb-2.5 font-data text-sm">{mark}<div className="flex flex-wrap items-center gap-2"><ModeSwitch mode={frame.mode} onChange={frame.setMode}/><button className="min-w-28" onClick={refresh}>Tải lại dữ liệu</button></div></div>}<OfficeFrame mode={frame.mode} overview={<Overview api={api} project={project} session={session} revision={revision} refresh={refresh} events={events}/>} overviewOpen={frame.overviewOpen} panelOpen={frame.panelOpen} hud={frame.hud} host={frame.host} stage={stage} mark={<>{mark}<button type="button" onClick={refresh}>Tải lại dữ liệu</button></>} onMode={frame.setMode} onOverview={frame.openOverview}><Routes><Route index element={<OverviewOutlet/>}/><Route path="runs" element={<Runs api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="runs/:runId" element={<RunRoute api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="chat" element={<ChatPage api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="chat/:runId" element={<ChatPage api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="review" element={<Review api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="settings" element={<Settings api={api} project={project} refresh={refresh}/>}/><Route path="*" element={<EmptyState title="Không tìm thấy trang"><Link to={`/projects/${encodeURIComponent(id)}`}>Về tổng quan dự án</Link></EmptyState>}/></Routes></OfficeFrame></Operations>;
}
function RunRoute({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) { const {runId=''}=useParams();return <RunView key={runId} api={api} id={id} runId={runId} revision={revision} refresh={refresh}/>; }

/** Rendered only in visual mode, so Classic issues no extra reads. Degraded tier until useOfficeModel lands: no workforce view. */
function VisualOffice({api,id,session,connection,revision,list}:{api:ApiClient;id:string;session:WebProjectSession|undefined;connection:Connection;revision:number;list:ReactNode}) {
  const runs=useRead(`office-runs:${id}`,()=>api.runs(id),revision),decisions=useRead(`office-decisions:${id}`,()=>api.decisions(id),revision);
  const seats=useRef<SeatMap>({entries:[],overflow:0});
  const office=useMemo(()=>{
    if(!session)return undefined;
    const derived=deriveOffice({session,runs:runs.data?.items??[],decisions:decisions.data?.items??[],connection,now:Date.now()});
    const seated=applySeats(seats.current,derived);seats.current=seated.seats;return seated.model;
  },[session,runs.data,decisions.data,connection]);
  return office?<OfficeStage model={office} onSelect={target=>{void target;}} links={list}/>:<>{list}</>;
}
