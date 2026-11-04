import { LoadingState } from './components/LoadingState';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
import { AgentsPage } from './features/agents';
import { Review } from './features/review';
import { Settings } from './features/settings';
import { IssueQueuePanel, IssuesPage } from './features/issues';
import { IssueDetail } from './features/issues/detail';
import { useRead } from './features/data';
import { Operations, OperationsDock, useOperationsDockSummary } from './features/operations';
import type { OfficeFocusZone } from './features/office/model/types';
import { Overview } from './features/overview';
import { DirectorProvider, presenceLabels, useDirector } from './features/director/status';
import { DirectorInspector } from './features/office/ui/DirectorInspector';
import { useUiMode, type UiMode } from './features/office/mode';
import { OfficeFrame, OverviewOutlet } from './features/office/ui/OfficeFrame';
import { ModeSwitch } from './features/office/ui/ModeSwitch';
import { OfficeStage, type StageControl } from './features/office/ui/OfficeStage';
import { OfficeHud, currentRun } from './features/office/ui/OfficeHud';
import { useOfficeModel } from './features/office/ui/useOfficeModel';
import { useAgentExcerpts } from './features/office/ui/useAgentExcerpts';
import { AgentInspector, AgentList, handoffEvidence } from './features/office/ui/AgentInspector';
import { CabinetInspector, ServerInspector, runEvidence } from './features/office/ui/ObjectInspector';
import type { OfficeDirectorInput, OfficeTarget } from './features/office/model/types';

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
  const [mode,setMode]=useUiMode(),[overviewOpen,setOverviewOpen]=useState(false),[host,setHost]=useState<HTMLElement|null>(null),[hud,setHud]=useState<HTMLElement|null>(null),[dockPx,setDockPx]=useState(0);
  const [inspector,setInspector]=useState<Inspector|undefined>(),[inspectorHost,setInspectorHost]=useState<HTMLElement|null>(null);
  const navigate=useNavigate(),isIndex=Boolean(useMatch({path:'/projects/:projectId',end:true})),base=`/projects/${encodeURIComponent(projectId)}`;
  // Reset during render, not in an effect, so the previous project's inspector never paints for the new one.
  const [seenProject,setSeenProject]=useState(projectId);
  if(seenProject!==projectId){setSeenProject(projectId);setOverviewOpen(false);setInspector(undefined);}
  // Overview is only meaningful at the index path; leaving it forgets the HUD-opened state.
  useEffect(()=>{if(!isIndex)setOverviewOpen(false);},[isIndex]);
  // Visual mode: the index path closes the panel (or shows the HUD-opened overview); every other route opens it.
  const visual=mode==='visual' && Boolean(project),panelOpen=!isIndex || overviewOpen || inspector!==undefined;
  // The re-pair view cannot be dismissed (Esc and the close button do nothing): it reopens itself while the session is refused, so closing would only fight it.
  const closable=inspector?.kind!=='repair';
  const close=useCallback(()=>{if(!closable)return;setOverviewOpen(false);setInspector(undefined);if(!isIndex)navigate(base);},[closable,isIndex,navigate,base]);
  const showOverview=useCallback(()=>{setInspector(undefined);setOverviewOpen(true);},[]);
  const openOverview=useCallback(()=>{setInspector(undefined);setOverviewOpen(true);if(!isIndex)navigate(base);},[isIndex,navigate,base]);
  // Inspectors live in the panel on the index path: opening one leaves any page route and the overview.
  const openInspector=useCallback((next:Inspector|undefined)=>{if(next){setOverviewOpen(false);if(!isIndex)navigate(base);}setInspector(next);},[isIndex,navigate,base]);
  return <AppShell projects={projects} projectId={projectId} visual={visual?{panelOpen,closable,dockPx,inspectorRef:setInspectorHost,onClose:close,onOverview:showOverview,hudRef:setHud,stageRef:setHost}:undefined}>{project?<ProjectContent key={projectId} api={api} project={project} projects={projects} revision={revision} refresh={refresh} onPair={onPair} frame={{mode,setMode,overviewOpen,panelOpen,hud,host,openOverview,closePanels:close,dockPx,setDockPx,inspector,openInspector,inspectorHost}}/>:projectsError?<ErrorState error={projectsError} retry={refresh} onPair={onPair}/>:projectsLoading?<LoadingState loading initial label="Đang tải dự án…"/>:<EmptyState title="Dự án chưa được đăng ký"><Link to="/">Mở quản lý dự án</Link></EmptyState>}</AppShell>;
}
type Frame={mode:UiMode;setMode:(mode:UiMode)=>void;overviewOpen:boolean;panelOpen:boolean;hud:HTMLElement|null;host:HTMLElement|null;openOverview:()=>void;closePanels:()=>void;dockPx:number;setDockPx:(px:number)=>void;inspector:Inspector|undefined;openInspector:(next:Inspector|undefined)=>void;inspectorHost:HTMLElement|null};
/** What the overlay panel shows in 3D besides pages: local state, never a route. */
export type Inspector={kind:'agent';instanceId:string}|{kind:'unseated'}|{kind:'cabinet'}|{kind:'server'}|{kind:'repair'}|{kind:'director'}|{kind:'queue'};
function ProjectContent({api,project,projects,revision,refresh,onPair,frame}:{api:ApiClient;project:WebProject;projects:WebProject[];revision:number;refresh:()=>void;onPair:(secret:string)=>Promise<void>;frame:Frame}) {
  const id=project.projectId;
  const [connection,setConnection]=useState<Connection>('connecting'),[events,setEvents]=useState<WebEvent[]>([]);
  const hadDisconnect=useRef(false);
  // An SSE reset (or a reconnect after a gap) restarts Director transcript cursors from the latest page.
  const [resetEpoch,setResetEpoch]=useState(0);
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
    const update=(event:WebEvent)=>{setEvents(old=>[event,...old].slice(0,25));if(event.type==='reset')setResetEpoch(value=>value+1);if(timer===undefined)timer=setTimeout(()=>{timer=undefined;refresh();},150);};
    const onConnection=(next:Connection)=>{
      setConnection(next);
      if(next==='reconnecting' || next==='offline')hadDisconnect.current=true;
      else if(next==='connected' && hadDisconnect.current){hadDisconnect.current=false;setResetEpoch(value=>value+1);refresh();}
    };
    const close=subscribeEvents(id,update,onConnection);
    const online=()=>refresh();
    window.addEventListener('online',online);
    return()=>{close();clearTimeout(timer);window.removeEventListener('online',online);};
  },[id,refresh,reconnectEpoch]);
  useEffect(()=>{if(connection==='connected')return;const poll=setInterval(refresh,15000);return()=>clearInterval(poll);},[connection,refresh]);
  const mark=<div className="flex flex-wrap items-center gap-3"><span className="font-semibold text-ink">{project.displayName}</span><ConnectionBanner state={connection} inactive={sessionInactive}/></div>;
  const visual=frame.mode==='visual';
  const list=<ul className="m-0 list-none p-0">{[['runs','Công việc'],['chat','Trò chuyện'],['agents','Nhân viên'],['review','Cần bạn quyết định'],['issues','Sự cố đang treo'],['settings','Cài đặt dự án']].map(([path,title])=><li key={path} className="border-t border-line py-2 first:border-t-0"><Link to={`/projects/${encodeURIComponent(id)}/${path}`}>{title}</Link></li>)}</ul>;
  return <Operations api={api} id={id} revision={revision} refresh={refresh} dock={visual?'external':'inline'}><DirectorProvider api={api} projectId={id} session={session} revision={revision} resetEpoch={resetEpoch}>{!visual && <div className="mb-4 flex min-h-11 flex-wrap items-center justify-between gap-3 border-b border-line pb-2.5 font-data text-sm">{mark}<div className="flex flex-wrap items-center gap-2"><ModeSwitch mode={frame.mode} onChange={frame.setMode}/><button className="min-w-28" onClick={refresh}>Tải lại dữ liệu</button></div></div>}<OfficeFrame mode={frame.mode} overview={<Overview api={api} project={project} session={session} revision={revision} refresh={refresh} events={events}/>} overviewOpen={frame.overviewOpen} panelOpen={frame.panelOpen}><Routes><Route index element={<OverviewOutlet/>}/><Route path="runs" element={<Runs api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="runs/:runId" element={<RunRoute api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="chat" element={<ChatPage api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="chat/:runId" element={<ChatPage api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="agents" element={<AgentsPage api={api} id={id} revision={revision}/>}/><Route path="issues" element={<IssuesPage/>}/><Route path="issues/:issueId" element={<IssueDetail/>}/><Route path="review" element={<Review api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="settings" element={<Settings api={api} project={project} refresh={refresh}/>}/><Route path="*" element={<EmptyState title="Không tìm thấy trang"><Link to={`/projects/${encodeURIComponent(id)}`}>Về tổng quan dự án</Link></EmptyState>}/></Routes></OfficeFrame>{visual && <VisualOffice api={api} project={project} projects={projects} onPair={onPair} session={session.data} connection={connection} revision={revision} refresh={refresh} list={list} frame={frame}/>}</DirectorProvider></Operations>;
}
function RunRoute({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) { const {runId=''}=useParams();return <RunView key={runId} api={api} id={id} runId={runId} revision={revision} refresh={refresh}/>; }

/**
 * Rendered only in visual mode, so Classic issues no extra reads. Portals the scene into the full-screen stage node, the floating HUD into
 * the HUD node and any inspector into the panel; all from one model. Read-only: the HUD only navigates and hands a chat draft to the chat page.
 */
function VisualOffice({api,project,projects,onPair,session,connection,revision,refresh,list,frame}:{api:ApiClient;project:WebProject;projects:WebProject[];onPair:(secret:string)=>Promise<void>;session:WebProjectSession|undefined;connection:Connection;revision:number;refresh:()=>void;list:ReactNode;frame:Frame}) {
  const id=project.projectId,base=`/projects/${encodeURIComponent(id)}`,navigate=useNavigate();
  // The Director desk and queue board read the shared Director state (Task 5) as a projection; the scene and model never call the API.
  const d=useDirector();
  const directorInput=useMemo<OfficeDirectorInput|undefined>(()=>d.directorLayout?{layout:d.layout,directorLayout:true,presence:d.presence,provider:d.provider,heartbeatAt:d.heartbeatAt,waitingSince:d.waitingSince,issues:d.presence!=='unknown'?d.view?.snapshot.issues:undefined}:undefined,
    [d.directorLayout,d.layout,d.presence,d.provider,d.heartbeatAt,d.waitingSince,d.view]);
  const state=useOfficeModel({api,id,session,connection,revision,director:directorInput});
  const {model,runs,stale,overflow,workforce,decisions,authRequired,error}=state;
  const control=useRef<StageControl|null>(null);
  const excerpts=useAgentExcerpts({api,id,enabled:model?.tier==='full'});
  const {inspector,openInspector}=frame;
  // A refused session is never shown as stale data: the panel offers re-pairing, the same ErrorState Classic uses.
  useEffect(()=>{
    if(authRequired)openInspector({kind:'repair'});
    else if(inspector?.kind==='repair')openInspector(undefined);
  },[authRequired,inspector?.kind,openInspector]);
  const RAIL_PX=84;
  /** Pixels the HUD covers: the rail, the bottom block, and the panel when it is (about to be) open beside the scene. */
  const insetFor=(open:boolean)=>{
    const w=window.innerWidth,bottom=frame.hud?.querySelector<HTMLElement>('[data-hud-bottom]')?.offsetHeight??0;
    return {right:RAIL_PX+(open&&w>=768?Math.min(720,w*0.7):0),bottom,left:0};
  };
  const hasModel=model!==undefined,refocusHud=useRef(false),panelNow=useRef(frame.panelOpen),mounted=useRef(true);
  panelNow.current=frame.panelOpen;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const dockSummary=useOperationsDockSummary();
  // Toàn cảnh closes every panel (the re-pair view stays); the camera eases only after that commit, with the then-current inset.
  const pendingOverview=useRef(false);
  const settleOverview=(open:boolean)=>{pendingOverview.current=false;control.current?.setInset(insetFor(open));control.current?.focusZone('overview');};
  const focusZone=(zone:OfficeFocusZone)=>{
    if(zone!=='overview'){control.current?.focusZone(zone);return;}
    // Closing may navigate and the router can commit late, so the camera waits for the effect below once the panel is really closed.
    // Nothing to wait for when no panel is open or the open one (the re-pair view) cannot close.
    const waits=frame.panelOpen && frame.inspector?.kind!=='repair';
    frame.closePanels();
    if(waits)pendingOverview.current=true;else settleOverview(frame.panelOpen);
  };
  useEffect(()=>{if(pendingOverview.current && !frame.panelOpen && mounted.current)settleOverview(false);},[frame.panelOpen]);// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{
    const apply=()=>control.current?.setInset(insetFor(frame.panelOpen));
    apply();window.addEventListener('resize',apply);return()=>window.removeEventListener('resize',apply);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[frame.panelOpen,frame.dockPx,frame.hud,hasModel]);
  // An agent that vanished after the model loaded: drop its inspector and hand focus back to the HUD.
  useEffect(()=>{
    if(inspector?.kind==='agent' && model?.tier==='full' && !model.agents.some(a=>a.instanceId===inspector.instanceId)){refocusHud.current=true;openInspector(undefined);}
  },[model,inspector,openInspector]);
  // Runs after OfficeFrame restored the opener, so the HUD (not a vanished control) ends up focused.
  useEffect(()=>{if(refocusHud.current && !frame.panelOpen){refocusHud.current=false;frame.hud?.focus();}},[frame.panelOpen,frame.hud]);
  const go=(path:string)=>{openInspector(undefined);navigate(path);};
  const select=(target:OfficeTarget)=>{
    // Before the camera moves: centre the selection in what the panel leaves visible.
    control.current?.setInset(insetFor(true));
    if(target.kind==='agent'){openInspector({kind:'agent',instanceId:target.instanceId});return;}
    if(target.kind==='director'||target.kind==='queue'){openInspector({kind:target.kind});return;}
    switch(target.object){
      case 'counter':go(`${base}/chat`);break;
      case 'board':go(`${base}/runs`);break;
      case 'mailbox':go(`${base}/review`);break;
      case 'settings':go(`${base}/settings`);break;
      case 'door':go('/');break;
      case 'cabinet':openInspector({kind:'cabinet'});break;
      case 'server':openInspector({kind:'server'});break;
    }
  };
  const run=currentRun(runs);
  const titleOf=(runId:string,taskId?:string)=>{const r=runs.find(x=>x.runId===runId);return (taskId?r?.tasks.find(t=>t.taskId===taskId)?.title:undefined)??r?.title??taskId??runId;};
  const agent=inspector?.kind==='agent'?model?.agents.find(a=>a.instanceId===inspector.instanceId):undefined;
  const inspected=inspector&&frame.inspectorHost?createPortal(
    inspector.kind==='repair'?<ErrorState error={error} retry={refresh} onPair={onPair}/>
    :inspector.kind==='agent'?(agent?<AgentInspector api={api} projectId={id} agent={agent} view={workforce?.agents.find(a=>a.instanceId===agent.instanceId)} handoffs={workforce?.handoffs??[]} revision={revision} titleOf={titleOf}/>:<EmptyState title="Nhân viên này không còn trong danh sách"><p>Có thể phiên đã thay đổi. Tải lại dữ liệu để xem danh sách hiện tại.</p></EmptyState>)
    :inspector.kind==='unseated'?<AgentList title="Lập trình viên chưa hiện trong cảnh" note="Cảnh có tối đa 20 chỗ ngồi. Những nhân viên dưới đây vẫn đang được theo dõi." agents={(model?.agents??[]).filter(a=>!a.seat)} onPick={instanceId=>openInspector({kind:'agent',instanceId})}/>
    :inspector.kind==='director'?<DirectorInspector onChat={()=>go(`${base}/chat`)} onQueue={()=>openInspector({kind:'queue'})}/>
    :inspector.kind==='queue'?<IssueQueuePanel/>
    :inspector.kind==='cabinet'?<CabinetInspector api={api} projectId={id} run={run} evidence={runEvidence(run?.runId,decisions,handoffEvidence(workforce?.handoffs??[],undefined,run?.runId))}/>
    :<ServerInspector api={api} projectId={id} session={session} fresh={!stale&&!authRequired} refresh={refresh}/>,frame.inspectorHost):null;
  return <>
    {frame.host && createPortal(<section aria-label="Danh sách công việc" className="m-0 h-full">{model?<OfficeStage model={model} onSelect={select} links={list} control={control} excerpts={excerpts}/>:<>{list}</>}</section>,frame.host)}
    {inspected}
    {frame.hud && createPortal(<OfficeHud projectName={project.displayName} projects={projects} projectId={id} onProject={next=>navigate(next?`/projects/${encodeURIComponent(next)}`:'/')} session={session} model={model} runs={runs} connection={connection} stale={stale} failed={error!==undefined&&!authRequired&&!model} authRequired={authRequired} mode={frame.mode} onMode={frame.setMode} panelOpen={frame.panelOpen} overflow={overflow}
      onOverview={frame.openOverview} onNavigate={path=>{if(path==='')frame.openOverview();else go(`${base}/${path}`);}} onDocuments={()=>openInspector({kind:'cabinet'})} onRefresh={refresh}
      onFocusZone={focusZone} onAgentList={()=>openInspector({kind:'unseated'})}
      director={directorInput?{canSend:d.chat.canSend,presenceLabel:presenceLabels[d.presence]}:undefined} onQueue={()=>openInspector({kind:'queue'})}
      onChatDraft={draft=>{openInspector(undefined);navigate(`${base}/chat`,{state:{draft}});}} dock={<OperationsDock/>} dockSummary={dockSummary} onDockHeight={frame.setDockPx}/>,frame.hud)}
  </>;
}
