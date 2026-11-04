import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { WebDirectorView, WebProjectSession } from '@bflow/contracts/web';
import { ApiClient, ApiError } from '../../api/client';
import { useRead } from '../data';

/**
 * Shared Director read state for Classic and the 3D office (D-CD-01). Read-only: it never writes, acknowledges or heartbeats.
 * `unknown` is a read failure or a not-yet-confirmed view; it never collapses into `absent`. `unsupported` is a backend without the
 * Director port (422/404), which keeps the legacy v2 UI unchanged. Presence and its 120s threshold are the server's, not recomputed here.
 */
export type DirectorLayout='director'|'not_started'|'legacy_v2'|'unknown'|'unsupported';
export type DirectorPresenceState='active'|'waiting'|'absent'|'unknown';
/** Why Director chat cannot send right now; `undefined` when it can. */
export type DirectorChatBlock='unknown'|'legacy'|'host_not_ready'|'session_mismatch';
export interface DirectorState {
  api:ApiClient;projectId:string;
  view:WebDirectorView|undefined;error:unknown;loading:boolean;
  layout:DirectorLayout;
  /**
   * The configuration is a Director layout: confirmed by the latest view received (stale or not), or, when no view could be read
   * (e.g. host stopped), by this browser's last confirmed layout hint. UX only: the hint never enables sending or launching.
   */
  directorLayout:boolean;
  /** `directorLayout` comes from the per-project UI hint, not from a view read in this mount. */
  hinted:boolean;
  presence:DirectorPresenceState;
  waitingSince:string|undefined;heartbeatAt:string|undefined;provider:string|undefined;
  hostReady:boolean;
  chat:{canSend:boolean;block:DirectorChatBlock|undefined;sessionId:string|undefined};
  /** Changes on every app revision and local reload: a refetch signal for the transcript. */
  readEpoch:number;
  /** Changes on an SSE reset (or reconnect): transcript cursors must restart from the latest page. */
  resetEpoch:number;
  reload():void;
}
type Read<T>={key:string;data?:T|undefined;error?:unknown;loading:boolean};

export const presenceLabels:Record<DirectorPresenceState,string>={
  active:'Director đang hoạt động',waiting:'Director đang chờ tin của bạn',absent:'Director chưa có mặt',unknown:'Chưa đọc được trạng thái Director',
};
const presenceNotes:Record<DirectorPresenceState,string>={
  active:'Director vừa báo hoạt động gần đây.',waiting:'Director đang chờ; tin mới sẽ được đọc ngay.',
  absent:'Không có phiên Director nào báo hoạt động trong 2 phút gần nhất.',
  unknown:'Lần đọc gần nhất thất bại hoặc chưa hoàn tất; đây không có nghĩa Director vắng mặt.',
};
const unsupportedCodes=new Set(['operation_not_allowed','not_found']);

/** Per-project, per-browser UI hint of the last layout a view read confirmed. Never authority; storage failures are ignored. */
export type LayoutHint='director'|'legacy_v2';
export const layoutHintKey=(projectId:string)=>`bflow:web:director-layout:${encodeURIComponent(projectId)}`;
export function readLayoutHint(projectId:string):LayoutHint|undefined{
  try{const value=localStorage.getItem(layoutHintKey(projectId));return value==='director'||value==='legacy_v2'?value:undefined;}catch{return undefined;}
}
function writeLayoutHint(projectId:string,hint:LayoutHint){
  try{if(localStorage.getItem(layoutHintKey(projectId))!==hint)localStorage.setItem(layoutHintKey(projectId),hint);}catch{/* hint only */}
}

export function deriveDirectorState(input:{api:ApiClient;projectId:string;view:Read<WebDirectorView>;session:Read<WebProjectSession>;readEpoch:number;resetEpoch:number;reload:()=>void;hint?:LayoutHint|undefined}):DirectorState{
  const {view,session}=input,data=view.data,error=view.error;
  const layout:DirectorLayout=data?data.layout:error!==undefined&&error instanceof ApiError&&unsupportedCodes.has(error.code)?'unsupported':'unknown';
  const fresh=Boolean(data)&&error===undefined;
  const presence:DirectorPresenceState=fresh?data!.snapshot.director.presence:'unknown';
  const hostReady=Boolean(session.data&&session.error===undefined&&session.data.state==='ready');
  const sessionId=fresh&&data!.layout==='director'?data!.sessionId:undefined;
  const block:DirectorChatBlock|undefined=!fresh?'unknown':layout==='legacy_v2'?'legacy':layout!=='director'||!hostReady||!sessionId?'host_not_ready'
    :session.data!.sessionId!==undefined&&session.data!.sessionId!==sessionId?'session_mismatch':undefined;
  return {api:input.api,projectId:input.projectId,view:data,error,loading:view.loading,layout,
    directorLayout:layout==='director'||layout==='not_started'||(layout==='unknown'&&input.hint==='director'),
    hinted:layout==='unknown'&&input.hint==='director',presence,
    waitingSince:fresh&&presence==='waiting'?data!.waitingSince:undefined,
    heartbeatAt:fresh?data!.snapshot.director.heartbeatAt:undefined,provider:fresh?data!.snapshot.director.provider:undefined,
    hostReady,chat:{canSend:block===undefined,block,sessionId},readEpoch:input.readEpoch,resetEpoch:input.resetEpoch,reload:input.reload};
}

const Context=createContext<DirectorState|null>(null);
/** One Director view read per project, shared by every surface below it. */
export function DirectorProvider({api,projectId,session,revision,resetEpoch,children}:{api:ApiClient;projectId:string;session:Read<WebProjectSession>;revision:number;resetEpoch:number;children:ReactNode}){
  const [local,setLocal]=useState(0);
  const reload=useCallback(()=>setLocal(value=>value+1),[]);
  const readEpoch=revision+local;
  const view=useRead(`director:${projectId}`,()=>api.director(projectId),readEpoch);
  // A fresh view confirms the configured layout; `not_started` is a Director configuration whose host is not ready yet.
  const confirmed:LayoutHint|undefined=view.data&&view.error===undefined?(view.data.layout==='legacy_v2'?'legacy_v2':'director'):undefined;
  useEffect(()=>{if(confirmed)writeLayoutHint(projectId,confirmed);},[projectId,confirmed]);
  const hint=confirmed??readLayoutHint(projectId);
  const value=useMemo(()=>deriveDirectorState({api,projectId,view,session,readEpoch,resetEpoch,reload,hint}),[api,projectId,view,session,readEpoch,resetEpoch,reload,hint]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useDirector():DirectorState{
  const value=useContext(Context);if(!value)throw new Error('DirectorProvider required');
  return value;
}
/** Optional variant for surfaces rendered outside a project (tests, pages without Director). */
export function useOptionalDirector():DirectorState|null{return useContext(Context);}

const time=(iso:string)=>new Date(iso).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'});
const tone:Record<DirectorPresenceState,string>={active:'border-steel text-steel',waiting:'border-steel text-steel',absent:'border-line text-muted',unknown:'border-warning text-warning'};
const icon:Record<DirectorPresenceState,string>={active:'●',waiting:'◷',absent:'○',unknown:'?'};
/** Text + icon (never colour alone), in a polite status region; background refreshes keep its box size. */
export function DirectorPresenceStatus({compact=false}:{compact?:boolean}){
  const d=useDirector();
  return <div role="status" aria-live="polite" className="min-w-0">
    <p className="m-0 flex flex-wrap items-center gap-2 font-data text-sm">
      <span className={`inline-flex items-center gap-1 border px-2 py-0.5 text-xs leading-5 ${tone[d.presence]}`}><span aria-hidden="true">{icon[d.presence]}</span><span>{presenceLabels[d.presence]}</span></span>
      {d.provider&&d.presence!=='unknown'&&<span className="text-xs text-muted">{d.provider}</span>}
      {d.waitingSince&&<span className="text-xs text-muted">từ <time dateTime={d.waitingSince}>{time(d.waitingSince)}</time></span>}
    </p>
    {!compact&&<p className="mt-1 mb-0 text-xs text-muted">{presenceNotes[d.presence]}</p>}
  </div>;
}
