import { LoadingState } from './components/LoadingState';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, Route, Routes, useMatch, useNavigate, useParams } from 'react-router';
import type { WebEvent, WebProject, WebProjectSession } from '@bflow/contracts/web';
import { ApiClient, ApiError, consumeBootstrap } from './api/client';
import { subscribeEvents, type Connection } from './api/events';
import { AppShell } from './components/AppShell';
import { ConnectionBanner, connectionText } from './components/ConnectionBanner';
import { Blockers } from './components/Blockers';
import { ErrorState } from './components/ErrorState';
import { EmptyState } from './components/EmptyState';
import { Projects } from './features/projects';
import { Runs } from './features/runs';
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
import { DirectorChatControllerProvider, useDirectorChatController } from './features/director/chat-controller';
import { DirectorChat } from './features/director/chat';
import { immersiveOfficeEnabled } from './features/office/immersive';
import { DirectorInspector } from './features/office/ui/DirectorInspector';
import { useUiMode, type UiMode } from './features/office/mode';
import { OfficeFrame, OverviewOutlet } from './features/office/ui/OfficeFrame';
import { ModeSwitch } from './features/office/ui/ModeSwitch';
import { OfficeStage, type StageControl } from './features/office/ui/OfficeStage';
import { OfficeHud, agentCounts, currentRun } from './features/office/ui/OfficeHud';
import { useOfficeModel } from './features/office/ui/useOfficeModel';
import { useAgentExcerpts } from './features/office/ui/useAgentExcerpts';
import { TaskBoard } from './features/office/ui/interaction/TaskBoard';
import { TaskDetail } from './features/office/ui/interaction/TaskDetail';
import { DecisionInbox } from './features/office/ui/interaction/DecisionInbox';
import { DecisionDraftProvider, readDecisionDrafts, writeDecisionDrafts } from './features/office/ui/interaction/decision-drafts';
import { AgentDialogue } from './features/office/ui/interaction/AgentDialogue';
import { OfficeNotifications } from './features/office/ui/interaction/OfficeNotifications';
import { FirstVisit, replayFirstVisit } from './features/office/ui/interaction/FirstVisit';
import type { DecisionDraft } from './features/decisions';
import { AgentInspector, AgentList, handoffEvidence } from './features/office/ui/AgentInspector';
import { CabinetInspector, ServerInspector, runEvidence } from './features/office/ui/ObjectInspector';
import type { OfficeDirectorInput, OfficeTarget } from './features/office/model/types';
import { WindowManagerProvider, useWindows } from './features/office/ui/windows/WindowManager';
import { GameWindow } from './features/office/ui/windows/GameWindow';
import { Taskbar } from './features/office/ui/windows/Taskbar';
import { defaultRect, sceneInset } from './features/office/ui/windows/geometry';
import { isEscapeDismissal } from './components/AppShell';

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
  const [mode,setMode]=useUiMode(),[overviewOpen,setOverviewOpen]=useState(false),[host,setHost]=useState<HTMLElement|null>(null),[hud,setHud]=useState<HTMLElement|null>(null),[windowHost,setWindowHost]=useState<HTMLElement|null>(null),[dockPx,setDockPx]=useState(0);
  const inspectorOpeners=useRef(new Map<string,HTMLElement|null>());
  const navigate=useNavigate(),isIndex=Boolean(useMatch({path:'/projects/:projectId',end:true})),base=`/projects/${encodeURIComponent(projectId)}`;
  // Reset during render, not in an effect, so the previous project's inspector never paints for the new one.
  const [seenProject,setSeenProject]=useState(projectId);
  if(seenProject!==projectId){setSeenProject(projectId);setOverviewOpen(false);inspectorOpeners.current.clear();}
  // Overview is only meaningful at the index path; leaving it forgets the HUD-opened state.
  useEffect(()=>{if(!isIndex)setOverviewOpen(false);},[isIndex]);
  // Visual mode: the index path closes the panel (or shows the HUD-opened overview); every other route opens it.
  const visual=mode==='visual' && Boolean(project),panelOpen=!isIndex || overviewOpen;
  // The re-pair view cannot be dismissed (Esc and the close button do nothing): it reopens itself while the session is refused, so closing would only fight it.
  const closable=true;
  const close=useCallback(()=>{setOverviewOpen(false);if(!isIndex)navigate(base);},[isIndex,navigate,base]);
  const showOverview=useCallback(()=>{setOverviewOpen(true);},[]);
  const openOverview=useCallback(()=>{setOverviewOpen(true);if(!isIndex)navigate(base);},[isIndex,navigate,base]);
  const openInspector=useCallback((next:Inspector)=>{const id=next.kind==='agent'?`agent:${next.instanceId}`:next.kind;if(!inspectorOpeners.current.has(id)){const active=document.activeElement;inspectorOpeners.current.set(id,active instanceof HTMLElement&&active!==document.body?active:null);}},[]);
  const closeInspector=useCallback((id:string,focusHud=false)=>{requestAnimationFrame(()=>{const opener=inspectorOpeners.current.get(id);inspectorOpeners.current.delete(id);if(!focusHud&&opener?.isConnected)opener.focus();else document.getElementById('office-hud')?.focus();});},[]);
  return <WindowManagerProvider key={projectId} projectId={projectId} enabled={visual}><AppShell projects={projects} projectId={projectId} modeSwitch={project&&!visual?<ModeSwitch mode={mode} onChange={setMode}/>:undefined} visual={visual?{panelOpen,closable,immersive:immersiveOfficeEnabled(),dockPx,windowsRef:setWindowHost,onClose:close,onOverview:showOverview,hudRef:setHud,stageRef:setHost}:undefined}>{project?<ProjectContent key={projectId} api={api} project={project} projects={projects} revision={revision} refresh={refresh} onPair={onPair} frame={{mode,setMode,overviewOpen,panelOpen,hud,host,windowHost,openOverview,closePanels:close,dockPx,setDockPx,openInspector,closeInspector}}/>:projectsError?<ErrorState error={projectsError} retry={refresh} onPair={onPair}/>:projectsLoading?<LoadingState loading initial label="Đang tải dự án…"/>:<EmptyState title="Dự án chưa được đăng ký"><Link to="/">Mở quản lý dự án</Link></EmptyState>}</AppShell></WindowManagerProvider>;
}
type Frame={mode:UiMode;setMode:(mode:UiMode)=>void;overviewOpen:boolean;panelOpen:boolean;hud:HTMLElement|null;host:HTMLElement|null;windowHost:HTMLElement|null;openOverview:()=>void;closePanels:()=>void;dockPx:number;setDockPx:(px:number)=>void;openInspector:(next:Inspector)=>void;closeInspector:(id:string,focusHud?:boolean)=>void};
/** What the overlay panel shows in 3D besides pages: local state, never a route. */
export type Inspector={kind:'agent';instanceId:string}|{kind:'unseated'}|{kind:'cabinet'}|{kind:'server'}|{kind:'repair'}|{kind:'director'}|{kind:'queue'};
function ProjectContent({api,project,projects,revision,refresh,onPair,frame}:{api:ApiClient;project:WebProject;projects:WebProject[];revision:number;refresh:()=>void;onPair:(secret:string)=>Promise<void>;frame:Frame}) {
  const id=project.projectId;
  const chatRoute=Boolean(useMatch('/projects/:projectId/chat/*'));
  const [connection,setConnection]=useState<Connection>('connecting'),[events,setEvents]=useState<WebEvent[]>([]);
  const hadDisconnect=useRef(false);
  // An SSE reset (or a reconnect after a gap) restarts Director transcript cursors from the latest page.
  const [resetEpoch,setResetEpoch]=useState(0);
  const session=useRead(`session:${id}`,()=>api.sessionView(id),revision);
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
  return <Operations api={api} id={id} revision={revision} refresh={refresh} dock={frame.mode==='visual'?'external':chatRoute?'compact':'inline'}><DirectorProvider api={api} projectId={id} session={session} revision={revision} resetEpoch={resetEpoch}><ProjectSurfaces api={api} project={project} projects={projects} revision={revision} refresh={refresh} onPair={onPair} frame={frame} sessionRead={session} connection={connection} events={events}/></DirectorProvider></Operations>;
}
function ProjectSurfaces({api,project,projects,revision,refresh,onPair,frame,sessionRead,connection,events}:{api:ApiClient;project:WebProject;projects:WebProject[];revision:number;refresh:()=>void;onPair:(secret:string)=>Promise<void>;frame:Frame;sessionRead:{key:string;data?:WebProjectSession;error?:unknown;loading:boolean};connection:Connection;events:WebEvent[]}) {
  const id=project.projectId;
  const wm=useWindows();
  const topWindowId=wm.windows.filter(item=>item.display!=='minimized').sort((a,b)=>b.z-a.z)[0]?.id;
  useEffect(()=>{window.dispatchEvent(new Event('bflow:director-dialogue-state'));window.dispatchEvent(new Event('bflow:windows-changed'));},[wm.windows]);
  const [decisionDrafts,setDecisionDrafts]=useState<Record<string,DecisionDraft>>(()=>readDecisionDrafts(id));
  useEffect(()=>writeDecisionDrafts(id,decisionDrafts),[id,decisionDrafts]);
  const setDecisionDraft=(key:string,draft:DecisionDraft)=>setDecisionDrafts(old=>old[key]?.review===draft.review&&old[key]?.reason===draft.reason&&old[key]?.option===draft.option?old:{...old,[key]:draft});
  const [dialogueOpen,setDialogueOpen]=useState(false);
  const dialogueOpener=useRef<HTMLElement|null>(null);
  const composerRoute=Boolean(useMatch({path:'/projects/:projectId/chat',end:true}));
  const immersive=immersiveOfficeEnabled()&&frame.mode==='visual';
  const list=<><ul className="m-0 list-none p-0">{[['runs','Công việc'],['chat','Trò chuyện'],['agents','Nhân viên'],['review','Cần bạn quyết định'],['issues','Cần xử lý'],['settings','Cài đặt dự án']].map(([path,title])=><li key={path} className="border-t border-line py-2 first:border-t-0"><Link to={`/projects/${encodeURIComponent(id)}/${path}`}>{title}</Link></li>)}</ul>{immersive&&<button type="button" className="mt-3" onClick={()=>replayFirstVisit(id)}>Xem lại hướng dẫn</button>}</>;
  const mark=<div className="flex flex-wrap items-center gap-3"><span className="font-semibold text-ink">{project.displayName}</span><ConnectionBanner state={connection} inactive={Boolean(sessionRead.data&&!sessionRead.error&&['stopped','unavailable'].includes(sessionRead.data.state))}/></div>;
  const openDialogue=()=>{const active=document.activeElement instanceof HTMLElement?document.activeElement:null;dialogueOpener.current=active&&active!==document.body?active:null;wm.open('director-chat');setDialogueOpen(true);};
  const leaveDialogue=(restoreFocus=true)=>{if(!dialogueOpen)return;setDialogueOpen(false);wm.close('director-chat');if(restoreFocus)requestAnimationFrame(()=>{if(dialogueOpener.current?.isConnected)dialogueOpener.current.focus();else frame.hud?.focus();dialogueOpener.current=null;});};
  useEffect(()=>{if(frame.mode!=='visual'&&dialogueOpen)leaveDialogue(false);},[frame.mode,dialogueOpen]);
  const dialogueVisible=dialogueOpen;
  useEffect(()=>{if(!dialogueOpen)return;const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented&&!event.isComposing){event.preventDefault();leaveDialogue();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[dialogueOpen]);
  return <DirectorChatControllerProvider active={composerRoute||dialogueOpen}>
    {frame.mode!=='visual'&&<div className="mb-4 flex min-h-11 flex-wrap items-center justify-between gap-3 border-b border-line pb-2.5 font-data text-sm">{mark}<div className="flex flex-wrap items-center gap-2"><button className="min-w-28" onClick={refresh}>Tải lại dữ liệu</button></div></div>}
    <DecisionDraftProvider value={{drafts:decisionDrafts,setDraft:setDecisionDraft}}><OfficeFrame mode={frame.mode} overview={<Overview api={api} project={project} session={sessionRead} revision={revision} refresh={refresh} events={events}/>} overviewOpen={frame.overviewOpen} panelOpen={frame.panelOpen}>
      <Routes><Route index element={<OverviewOutlet/>}/><Route path="runs" element={immersive?<TaskBoard api={api} id={id} revision={revision} refresh={refresh}/>:<Runs api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="runs/:runId" element={immersive?<RunRoute api={api} id={id} revision={revision} refresh={refresh} immersive/>:<RunRoute api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="chat" element={<ChatPage api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="chat/:runId" element={<ChatPage api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="agents" element={<AgentsPage api={api} id={id} revision={revision}/>}/><Route path="issues" element={<IssuesPage/>}/><Route path="issues/:issueId" element={<IssueDetail/>}/><Route path="review" element={immersive?<DecisionInbox api={api} id={id} revision={revision} refresh={refresh}/>:<Review api={api} id={id} revision={revision} refresh={refresh}/>}/><Route path="settings" element={<Settings api={api} project={project} refresh={refresh}/>}/><Route path="*" element={<EmptyState title="Không tìm thấy trang"><Link to={`/projects/${encodeURIComponent(id)}`}>Về tổng quan dự án</Link></EmptyState>}/></Routes>
    </OfficeFrame></DecisionDraftProvider>
    {frame.mode==='visual'&&<VisualOffice api={api} project={project} projects={projects} onPair={onPair} session={sessionRead.data} connection={connection} revision={revision} refresh={refresh} list={list} frame={frame} dialogueOpen={dialogueVisible} onDirectorDialogue={openDialogue} onLeaveDialogue={leaveDialogue}/>}
    {frame.mode==='visual'&&immersive&&frame.windowHost&&createPortal(<GameWindow id="director-chat" kind="director-chat" z={wm.windows.find(item=>item.id==='director-chat')?.z??1} title="Trò chuyện với Director" icon="chat" color="var(--win-c-chat)" rect={wm.windows.find(item=>item.id==='director-chat')?.rect??defaultRect('director-chat',{width:window.innerWidth,height:window.innerHeight})} display={wm.windows.find(item=>item.id==='director-chat')?.display??'minimized'} active={topWindowId==='director-chat'} closable minimizable maximizable movable={window.innerWidth>=1100} resizable={window.innerWidth>=1100} hidden={!dialogueVisible} onFocus={()=>wm.focus('director-chat')} onClose={()=>leaveDialogue()} onMinimize={()=>wm.minimize('director-chat')} onToggleMaximize={()=>wm.toggleMaximize('director-chat')} onMove={(dx,dy)=>wm.move('director-chat',dx,dy)} onResize={(dx,dy)=>wm.resize('director-chat',dx,dy)}><DirectorChat immersive/></GameWindow>,frame.windowHost)}
  </DirectorChatControllerProvider>;
}
function RunRoute({api,id,revision,refresh,immersive=false}:{api:ApiClient;id:string;revision:number;refresh:()=>void;immersive?:boolean}) { const {runId=''}=useParams();return <TaskDetail key={runId} api={api} id={id} runId={runId} revision={revision} refresh={refresh} immersive={immersive}/>; }

/**
 * Rendered only in visual mode, so Classic issues no extra reads. Portals the scene into the full-screen stage node, the floating HUD into
 * the HUD node and any inspector into the panel; all from one model. Read-only: the HUD only navigates and hands a chat draft to the chat page.
 */
function VisualOffice({api,project,projects,onPair,session,connection,revision,refresh,list,frame,dialogueOpen,onDirectorDialogue,onLeaveDialogue}:{api:ApiClient;project:WebProject;projects:WebProject[];onPair:(secret:string)=>Promise<void>;session:WebProjectSession|undefined;connection:Connection;revision:number;refresh:()=>void;list:ReactNode;frame:Frame;dialogueOpen:boolean;onDirectorDialogue:()=>void;onLeaveDialogue:(restoreFocus?:boolean)=>void}) {
  const id=project.projectId,base=`/projects/${encodeURIComponent(id)}`,navigate=useNavigate();
  const immersive=immersiveOfficeEnabled();
  const wm=useWindows();
  // The Director desk and queue board read the shared Director state (Task 5) as a projection; the scene and model never call the API.
  const d=useDirector();
  const chatController=useDirectorChatController();
  const directorInput=useMemo<OfficeDirectorInput>(()=>({layout:d.layout,directorLayout:d.directorLayout,presence:d.presence,provider:d.provider,heartbeatAt:d.heartbeatAt,waitingSince:d.waitingSince,issues:d.presence!=='unknown'?d.view?.snapshot.issues:undefined}),
    [d.directorLayout,d.layout,d.presence,d.provider,d.heartbeatAt,d.waitingSince,d.view]);
  const state=useOfficeModel({api,id,session,connection,revision,director:directorInput});
  const {model,runs,stale,overflow,workforce,decisions,authRequired,error}=state;
  const control=useRef<StageControl|null>(null);
  const excerpts=useAgentExcerpts({api,id,enabled:model?.tier==='full'});
  const inspectorWindows=wm.windows.filter(item=>!['app','director-chat','operations','status'].includes(item.kind));
  const openInspector=useCallback((next:Inspector|undefined)=>{
    if(next){frame.openInspector(next);wm.open(next.kind,next.kind==='agent'?{instanceId:next.instanceId}:undefined);}
    else {for(const item of inspectorWindows){if(item.kind==='repair')continue;wm.close(item.id);frame.closeInspector(item.id);}control.current?.highlight?.(undefined);control.current?.preview?.(undefined);}
  },[wm.open,wm.close,frame.openInspector,frame.closeInspector,inspectorWindows]);
  // A refused session is never shown as stale data: the panel offers re-pairing, the same ErrorState Classic uses.
  useEffect(()=>{
    const hasRepair=wm.windows.some(item=>item.kind==='repair');
    if(authRequired&&!hasRepair){frame.openInspector({kind:'repair'});wm.open('repair');}
    else if(!authRequired&&hasRepair){wm.forceClose('repair');frame.closeInspector('repair');}
  },[authRequired,wm.windows,wm.open,wm.forceClose,frame.openInspector,frame.closeInspector]);
  const insetFor=()=>{
    const top=[...wm.windows].filter(item=>item.display!=='minimized').sort((a,b)=>b.z-a.z)[0];
    const visible=window.innerWidth>=1100?wm.windows:wm.windows.filter(item=>item.display!=='minimized'&&item.id===top?.id);
    // The shortcuts now occupy a horizontal row above the taskbar.
    return sceneInset(visible,{width:window.innerWidth,height:window.innerHeight},{left:0,bottom:132});
  };
  const hasModel=model!==undefined,refocusHud=useRef(false),panelNow=useRef(frame.panelOpen),mounted=useRef(true);
  panelNow.current=frame.panelOpen;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const dockSummary=useOperationsDockSummary();
  useEffect(()=>{control.current?.setInteracting?.(dialogueOpen);},[dialogueOpen]);
  useEffect(()=>{
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==='F6'&&!event.altKey&&!event.ctrlKey&&!event.metaKey){const targets=[...document.querySelectorAll<HTMLElement>('#office-hud nav[aria-label="Lối tắt"] button, #office-windows .bwin:not([hidden]) .bwin-titlebar, #office-hud .bflow-taskbar button')].filter(item=>!item.closest('[hidden]'));if(targets.length){event.preventDefault();const index=targets.findIndex(item=>item===document.activeElement||item.contains(document.activeElement));const direction=event.shiftKey?-1:1;targets[(index+direction+targets.length)%targets.length]?.focus();}return;}
      if(!isEscapeDismissal(event)||(event.target instanceof Element&&event.target.closest('dialog[open]')))return;
      const active=[...wm.windows].filter(item=>item.display!=='minimized').sort((a,b)=>b.z-a.z)[0];
      if(active?.kind==='repair')return;
      if(active?.kind==='director-chat'){event.preventDefault();onLeaveDialogue();return;}
      if(active&&active.kind!=='app'){event.preventDefault();wm.close(active.id);frame.closeInspector(active.id);control.current?.highlight?.(undefined);control.current?.preview?.(undefined);return;}
      if(frame.panelOpen){event.preventDefault();frame.closePanels();}
    };
    window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown);
  },[wm.windows,wm.close,dialogueOpen,frame]);
  // Toàn cảnh closes every panel (the re-pair view stays); the camera eases only after that commit, with the then-current inset.
  const pendingOverview=useRef(false);
  const settleOverview=()=>{pendingOverview.current=false;control.current?.setInset(insetFor());control.current?.focusZone('overview');};
  const focusZone=(zone:OfficeFocusZone)=>{
    if(zone!=='overview'){control.current?.focusZone(zone);return;}
    // Closing may navigate and the router can commit late, so the camera waits for the effect below once the panel is really closed.
    // Nothing to wait for when no panel is open or the open one (the re-pair view) cannot close.
    const waits=frame.panelOpen;
    closeToolsForOverview();
    frame.closePanels();
    if(waits)pendingOverview.current=true;else settleOverview();
  };
  const closeToolsForOverview=()=>{for(const item of wm.windows){if(item.kind==='repair'||item.kind==='app')continue;if(item.kind==='director-chat'){onLeaveDialogue(false);continue;}wm.close(item.id);if(!['operations','status'].includes(item.kind))frame.closeInspector(item.id);}control.current?.highlight?.(undefined);control.current?.preview?.(undefined);};
  const overview=()=>{closeToolsForOverview();frame.openOverview();};
  const closeAllWindows=()=>{closeToolsForOverview();frame.closePanels();};
  const topWindowId=wm.windows.filter(item=>item.display!=='minimized').sort((a,b)=>b.z-a.z)[0]?.id;
  useEffect(()=>{if(pendingOverview.current && !frame.panelOpen && mounted.current)settleOverview();},[frame.panelOpen]);// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{
    const apply=()=>control.current?.setInset(insetFor());
    apply();window.addEventListener('resize',apply);window.addEventListener('bflow:windows-changed',apply);return()=>{window.removeEventListener('resize',apply);window.removeEventListener('bflow:windows-changed',apply);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[frame.panelOpen,frame.dockPx,frame.hud,hasModel,dialogueOpen,wm.windows]);
  // An agent that vanished after the model loaded: drop its inspector and hand focus back to the HUD.
  useEffect(()=>{
    if(model?.tier!=='full')return;
    for(const item of inspectorWindows){if(item.kind!=='agent'||model.agents.some(agent=>agent.instanceId===item.params?.instanceId))continue;refocusHud.current=true;wm.close(item.id);frame.closeInspector(item.id,true);}
  },[model,inspectorWindows,frame.closeInspector,wm.close]);
  // Runs after OfficeFrame restored the opener, so the HUD (not a vanished control) ends up focused.
  useEffect(()=>{if(refocusHud.current){refocusHud.current=false;frame.hud?.focus();}},[frame.panelOpen,frame.hud,inspectorWindows]);
  const go=(path:string)=>{navigate(path);};
  const select=(target:OfficeTarget)=>{
    // Before the camera moves: centre the selection in what the panel leaves visible.
    control.current?.setInset(insetFor());
    if(target.kind==='agent'){openInspector({kind:'agent',instanceId:target.instanceId});return;}
    if(target.kind==='director'){if(immersiveOfficeEnabled()){control.current?.setInset(insetFor());onDirectorDialogue();return;}openInspector({kind:'director'});return;}
    if(target.kind==='queue'){openInspector({kind:'queue'});return;}
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
  const inspected=inspectorWindows.map(windowState=>{
  const inspector=windowState.kind==='agent'?{kind:'agent',instanceId:windowState.params?.instanceId??''} as Inspector:{kind:windowState.kind as Exclude<Inspector,{kind:'agent'}>['kind']} as Inspector;
  const agent=inspector.kind==='agent'?model?.agents.find(a=>a.instanceId===inspector.instanceId):undefined;
  const toolId=windowState.id;
  const toolWindow=windowState;
  let content:ReactNode;
  switch(inspector.kind){
    case 'repair': content=<ErrorState error={error} retry={refresh} onPair={onPair}/>;break;
    case 'agent': content=!agent?<EmptyState title="Nhân viên này không còn trong danh sách"><p>Có thể phiên đã thay đổi. Tải lại dữ liệu để xem danh sách hiện tại.</p></EmptyState>:immersive?<AgentDialogue key={inspector.instanceId} api={api} projectId={id} agent={agent} view={workforce?.agents.find(a=>a.instanceId===inspector.instanceId)} handoffs={workforce?.handoffs??[]} revision={revision} titleOf={titleOf}/>:<AgentInspector api={api} projectId={id} agent={agent} view={workforce?.agents.find(a=>a.instanceId===inspector.instanceId)} handoffs={workforce?.handoffs??[]} revision={revision} titleOf={titleOf}/>;break;
    case 'unseated': content=<AgentList title="Lập trình viên chưa hiện trong cảnh" note="Cảnh có tối đa 20 chỗ ngồi. Những nhân viên dưới đây vẫn đang được theo dõi." agents={(model?.agents??[]).filter(a=>!a.seat)} onPick={instanceId=>openInspector({kind:'agent',instanceId})}/>;break;
    case 'director': content=<DirectorInspector onChat={()=>{wm.close('director');frame.closeInspector('director');go(`${base}/chat`);}} onQueue={()=>{wm.close('director');frame.closeInspector('director');openInspector({kind:'queue'});}}/>;break;
    case 'queue': content=<IssueQueuePanel/>;break;
    case 'cabinet': content=<CabinetInspector api={api} projectId={id} run={run} evidence={runEvidence(run?.runId,decisions,handoffEvidence(workforce?.handoffs??[],undefined,run?.runId))}/>;break;
    case 'server': content=<ServerInspector api={api} projectId={id} session={session} fresh={!stale&&!authRequired} refresh={refresh}/>;break;
  }
  return frame.windowHost?createPortal(
    <GameWindow id={toolId!} kind={inspector.kind} title={inspector.kind==='agent'?(agent?.label??'Nhân viên'):inspector.kind==='unseated'?'Lập trình viên chưa hiện trong cảnh':inspector.kind==='director'?'Director':inspector.kind==='queue'?'Sự cố':inspector.kind==='cabinet'?'Tài liệu':inspector.kind==='server'?'Máy chủ':'Cần ghép nối lại'} icon={inspector.kind==='agent'||inspector.kind==='unseated'?'agents':inspector.kind==='director'?'chat':inspector.kind==='queue'?'issues':inspector.kind==='cabinet'?'docs':inspector.kind==='server'?'server':'hourglass'} color={inspector.kind==='repair'?'var(--win-c-alert)':inspector.kind==='agent'||inspector.kind==='unseated'?'var(--win-c-people)':inspector.kind==='queue'?'var(--win-c-decide)':inspector.kind==='cabinet'?'var(--win-c-docs)':inspector.kind==='director'?'var(--win-c-chat)':'var(--win-c-system)'} rect={toolWindow?.rect??defaultRect(inspector.kind,{width:window.innerWidth,height:window.innerHeight})} display={toolWindow?.display??'normal'} z={toolWindow?.z??1} active={toolId===topWindowId} closable={inspector.kind!=='repair'} minimizable={inspector.kind!=='repair'} maximizable={inspector.kind!=='repair'} movable={window.innerWidth>=1100&&inspector.kind!=='repair'} resizable={window.innerWidth>=1100&&inspector.kind!=='repair'} onFocus={()=>wm.focus(toolId!)} onClose={()=>{wm.close(toolId!);frame.closeInspector(toolId!);control.current?.highlight?.(undefined);control.current?.preview?.(undefined);}} onMinimize={()=>wm.minimize(toolId!)} onToggleMaximize={()=>wm.toggleMaximize(toolId!)} onMove={(dx,dy)=>wm.move(toolId!,dx,dy)} onResize={(dx,dy)=>wm.resize(toolId!,dx,dy)}>
    {content}</GameWindow>,frame.windowHost):null;
  });
  const operationsWindow=wm.windows.find(item=>item.id==='operations');
  const statusWindow=wm.windows.find(item=>item.id==='status');
  const sessionInactive=Boolean(session&&['stopped','unavailable'].includes(session.state));
  const statusLink=connectionText(connection,sessionInactive);
  const statusText=authRequired?'Cần ghép nối lại':stale?'Dữ liệu cũ':error!==undefined&&!model?'Lỗi đọc dữ liệu':statusLink.label;
  const visibleSessionBlockers=(session?.blockers??[]).filter(blocker=>(!d.directorLayout||blocker.code!=='chat_adapter_unavailable')&&(!sessionInactive||!['host_unavailable','host_inactive','session_unavailable'].includes(blocker.code)));
  const visibleBlockers=[...visibleSessionBlockers,...(currentRun(runs)?.blockers??[])];
  const statusBlockers=visibleBlockers.length;
  const sessionStateText=session?({ready:'Đang hoạt động',starting:'Đang khởi động',stopping:'Đang dừng',stopped:'Đã dừng',unavailable:'Chưa kết nối'}[session.state]??session.state):'Đang đọc phiên';
  const modelTierText=model?({full:'Đầy đủ',degraded:'Rút gọn',closed:'Phiên đang dừng'}[model.tier]??model.tier):(error?'Không đọc được dữ liệu':'Đang tải');
  const agentLabels=useMemo(()=>new Map((model?.agents??[]).map(a=>[a.instanceId,a.label])),[model?.agents]);
  return <>
    {frame.host && createPortal(<section aria-label="Danh sách công việc" className="m-0 h-full">{model?<OfficeStage model={model} onSelect={select} links={list} control={control} excerpts={excerpts} immersive={immersiveOfficeEnabled()}/>:<>{list}</>}</section>,frame.host)}
    {inspected}
    {frame.hud && createPortal(<><OfficeHud projectName={project.displayName} projects={projects} projectId={id} onProject={next=>navigate(next?`/projects/${encodeURIComponent(next)}`:'/')} session={session} model={model} runs={runs} connection={connection} stale={stale} failed={error!==undefined&&!authRequired&&!model} authRequired={authRequired} mode={frame.mode} onMode={frame.setMode} panelOpen={frame.panelOpen} immersive={immersiveOfficeEnabled()} onCameraControl={action=>control.current?.camera?.(action)} overflow={overflow}
      onOverview={overview} onNavigate={path=>{if(path==='')overview();else go(`${base}/${path}`);}} onDocuments={()=>openInspector({kind:'cabinet'})} onRefresh={refresh} onHistory={delta=>navigate(delta)} onPageReload={()=>navigate(0)}
      onFocusZone={focusZone} onAgentList={()=>openInspector({kind:'unseated'})}
      director={d.directorLayout?{canSend:d.chat.canSend,presenceLabel:presenceLabels[d.presence]}:undefined} onQueue={()=>openInspector({kind:'queue'})}
      windowOpen={wm.windows.some(item=>item.display!=='minimized')} notifications={immersive?<OfficeNotifications connection={connection} session={session} stale={stale} authRequired={authRequired} model={model} onInbox={()=>go(`${base}/review`)} onClarifications={overview} onServer={()=>openInspector({kind:'server'})} onDirector={()=>model?.director?select({kind:'director'}):go(`${base}/chat`)} onQueue={()=>openInspector({kind:'queue'})}/>:undefined}
      firstVisit={immersive?<FirstVisit projectId={id} active={!frame.panelOpen&&!dialogueOpen} onDirector={()=>model?.director?select({kind:'director'}):go(`${base}/chat`)} onTasks={()=>go(`${base}/runs`)} onInbox={()=>go(`${base}/review`)}/>:undefined}
      onChatDraft={draft=>{if(d.directorLayout&&immersive){chatController.initialDraft(draft,crypto.randomUUID());onDirectorDialogue();return;}navigate(`${base}/chat`,{state:{draft}});}} dock={<OperationsDock/>} dockSummary={dockSummary} onDockHeight={frame.setDockPx} onDockOpen={()=>wm.open('operations')} operationsOpen={Boolean(operationsWindow&&operationsWindow.display!=='minimized')} onStatusOpen={()=>wm.open('status')} onRun={runId=>go(`${base}/runs/${encodeURIComponent(runId)}`)} taskbar={quickChat => (<Taskbar quickChat={quickChat} agentLabels={agentLabels} mode={frame.mode} onMode={frame.setMode} onOverview={overview} onHistory={delta=>navigate(delta)} onPageReload={()=>navigate(0)} onRefresh={refresh} onCloseAll={closeAllWindows} projects={projects} projectId={id} onProject={next=>navigate(next?`/projects/${encodeURIComponent(next)}`:'/')} onNavigate={path=>go(`${base}/${path}`)} {...(d.directorLayout?{onQueue:()=>openInspector({kind:'queue'})}:{})} onDocuments={()=>openInspector({kind:'cabinet'})} onGuide={()=>replayFirstVisit(id)} onStatusOpen={()=>wm.open('status')} statusText={statusText}/>)} /> </>,frame.hud)}
    {frame.windowHost&&operationsWindow&&createPortal(<GameWindow id="operations" kind="operations" title="Thao tác đã gửi" icon="tasks" color="var(--win-c-work)" rect={operationsWindow.rect} display={operationsWindow.display} z={operationsWindow.z} active={topWindowId==='operations'} closable minimizable maximizable movable={window.innerWidth>=1100} resizable={window.innerWidth>=1100} onFocus={()=>wm.focus('operations')} onClose={()=>wm.close('operations')} onMinimize={()=>wm.minimize('operations')} onToggleMaximize={()=>wm.toggleMaximize('operations')} onMove={(dx,dy)=>wm.move('operations',dx,dy)} onResize={(dx,dy)=>wm.resize('operations',dx,dy)}><OperationsDock/></GameWindow>,frame.windowHost)}
    {frame.windowHost&&statusWindow&&createPortal(<GameWindow id="status" kind="status" title="Trạng thái văn phòng" icon="settings" color="var(--win-c-system)" rect={statusWindow.rect} display={statusWindow.display} z={statusWindow.z} active={topWindowId==='status'} closable minimizable maximizable movable={window.innerWidth>=1100} resizable={window.innerWidth>=1100} onFocus={()=>wm.focus('status')} onClose={()=>wm.close('status')} onMinimize={()=>wm.minimize('status')} onToggleMaximize={()=>wm.toggleMaximize('status')} onMove={(dx,dy)=>wm.move('status',dx,dy)} onResize={(dx,dy)=>wm.resize('status',dx,dy)}><dl className="status-window-details"><dt>Phiên</dt><dd>{sessionStateText}</dd><dt>Kết nối</dt><dd role="status">{statusLink.label}</dd><dt>Director</dt><dd>{d.directorLayout?presenceLabels[d.presence]:'Chưa có bàn Director'}</dd><dt>Nhân viên</dt><dd>{agentCounts(model).join(' · ')||'Chưa có dữ liệu nhân viên'}</dd><dt>Chất lượng dữ liệu</dt><dd>{modelTierText}</dd><dt>Điểm cần lưu ý</dt><dd>{statusBlockers}</dd><dt>Ghép nối lại</dt><dd>{authRequired?'Cần ghép nối lại':'Không cần'}</dd><dt>Dữ liệu cũ</dt><dd>{stale?'Có':'Không'}</dd></dl>{visibleBlockers.length>0&&<Blockers items={visibleBlockers}/>}</GameWindow>,frame.windowHost)}
  </>;
}
