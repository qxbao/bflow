import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { defaultRect, clampRect } from './geometry';
import type { WindowDisplay, WindowKind, WindowRect } from './GameWindow';

export interface WinState { id: string; kind: WindowKind; params?: { instanceId?: string }; rect: WindowRect; z: number; display: WindowDisplay; }
export type WindowAction =
  | { type: 'open'; kind: WindowKind; params?: { instanceId?: string }; viewport: { width: number; height: number }; saved?: { rect: WindowRect; display: WindowDisplay }; maxVisible?:number }
  | { type:'focus';id:string;maxVisible?:number }
  | { type: 'close' | 'minimize' | 'toggleMaximize'; id: string }
  | { type:'capacity';maxVisible:number }
  | { type:'viewport';viewport:{width:number;height:number} }
  | { type: 'move' | 'resize'; id: string; dx: number; dy: number; viewport: { width: number; height: number } }
  | { type: 'closeAll'; keep?: WindowKind[] }
  | { type: 'forceClose'; id: string }
  | { type: 'resetLayout'; viewport: { width: number; height: number };maxVisible?:number }
  | { type: 'restore'; states: Partial<Record<WindowKind, { rect: WindowRect; display: WindowDisplay }>>; viewport: { width: number; height: number } };

const idFor = (kind: WindowKind, params?: { instanceId?: string }) => kind === 'agent' ? `agent:${params?.instanceId ?? ''}` : kind;
function readLayout(raw:string):Partial<Record<WindowKind,{rect:WindowRect;display:WindowDisplay}>> {
  const parsed:unknown=JSON.parse(raw);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {};
  const result:Partial<Record<WindowKind,{rect:WindowRect;display:WindowDisplay}>>={};
  for(const kind of ['app','agent','unseated','director','director-chat','queue','cabinet','server','repair','operations','status'] as WindowKind[]){
    const value=(parsed as Record<string,unknown>)[kind];
    if(!value||typeof value!=='object'||Array.isArray(value))continue;
    const candidate=value as {rect?:unknown;display?:unknown},rect=candidate.rect;
    if(!rect||typeof rect!=='object')continue;
    const r=rect as Record<string,unknown>;
    if(![r.x,r.y,r.w,r.h].every(number=>typeof number==='number'&&Number.isFinite(number)))continue;
    if(!['normal','minimized','maximized'].includes(String(candidate.display)))continue;
    result[kind]={rect:{x:r.x as number,y:r.y as number,w:r.w as number,h:r.h as number},display:candidate.display as WindowDisplay};
  }
  return result;
}
const initial: WinState[] = [];
function normalized(states: WinState[], maxVisible=4): WinState[] {
  let result = [...states];
  const shown = result.filter(state => state.display !== 'minimized' && state.kind !== 'repair').sort((a,b)=>a.z-b.z);
  while (shown.length > maxVisible) { const victim = shown.shift()!; result = result.map(state => state.id === victim.id ? { ...state, display: 'minimized' } : state); }
  const repairZ = Math.max(0, ...result.filter(state => state.kind !== 'repair').map(state => state.z)) + 1;
  return result.map(state => state.kind === 'repair' ? { ...state, z: repairZ } : state);
}
export function windowReducer(states: WinState[] = initial, action: WindowAction): WinState[] {
  switch (action.type) {
    case 'open': {
      const id = idFor(action.kind, action.params), found = states.some(state => state.id === id);
      const nextZ = Math.max(0,...states.map(state=>state.z))+1;
      let next = found ? states.map(state => state.id === id ? { ...state, display: state.display === 'minimized' ? (action.saved?.display==='maximized'?'maximized':'normal') : state.display, rect: action.saved?clampRect(action.saved.rect,action.viewport):state.rect, z: nextZ } : state) : [...states, { id, kind: action.kind, ...(action.params ? { params: action.params } : {}), rect: action.saved?clampRect(action.saved.rect,action.viewport):defaultRect(action.kind, action.viewport, states.length), z: nextZ, display: action.saved?.display==='maximized'?'maximized' as const:'normal' as const }];
      if (!found && action.kind === 'agent') { const agents = next.filter(state => state.kind === 'agent'); if (agents.length > 3) next = next.filter(state => state.id !== agents.sort((a,b)=>a.z-b.z)[0]!.id); }
      return normalized(next,action.maxVisible);
    }
    case 'focus': { const nextZ=Math.max(0,...states.map(state=>state.z))+1; return normalized(states.map(state => state.id === action.id && state.display === 'minimized' ? { ...state, display: 'normal', z: nextZ } : state.id === action.id ? { ...state, z: nextZ } : state),action.maxVisible); }
    case 'capacity': return normalized(states,action.maxVisible);
    case 'viewport': return states.map(state=>({...state,rect:clampRect(state.rect,action.viewport)}));
    case 'close': return states.filter(state => state.id !== action.id || state.kind === 'repair');
    case 'forceClose': return states.filter(state => state.id !== action.id);
    case 'closeAll': { const next=states.filter(state => state.kind === 'repair' || action.keep?.includes(state.kind)); return next.length===states.length?states:next; }
    case 'minimize': return states.map(state => state.id === action.id && state.kind !== 'repair' ? { ...state, display: 'minimized' } : state);
    case 'toggleMaximize': return states.map(state => state.id === action.id ? { ...state, display: state.display === 'maximized' ? 'normal' : 'maximized' } : state);
    case 'move': return states.map(state => state.id === action.id ? { ...state, rect: clampRect({ ...state.rect, x: state.rect.x + action.dx, y: state.rect.y + action.dy },action.viewport) } : state);
    case 'resize': return states.map(state => state.id === action.id ? { ...state, rect: clampRect({ ...state.rect, w: state.rect.w + action.dx, h: state.rect.h + action.dy },action.viewport,state.kind==='app'?{w:420,h:320}:undefined) } : state);
    case 'resetLayout': return normalized(states.map((state, index) => ({ ...state, rect: defaultRect(state.kind, action.viewport, index), display: 'normal' })),action.maxVisible);
    case 'restore': return states.map(state => { const saved = action.states[state.kind]; return saved ? { ...state, rect: clampRect(saved.rect, action.viewport), display: saved.display } : state; });
  }
}

interface WindowContextValue { windows: WinState[]; open: (kind: WindowKind, params?: { instanceId?: string }) => string; focus: (id: string) => void; close: (id: string) => void; forceClose: (id: string) => void; minimize: (id: string) => void; toggleMaximize: (id: string) => void; move: (id: string, dx: number, dy: number) => void; resize: (id: string, dx: number, dy: number) => void; closeAll: (keep?: WindowKind[]) => void; resetLayout: () => void; }
const WindowContext = createContext<WindowContextValue | null>(null);
export function WindowManagerProvider({ projectId, enabled=true, children }: { projectId: string; enabled?:boolean; children: ReactNode }) {
  const [windows, dispatch] = useReducer(windowReducer, initial);
  const [hydrated,setHydrated]=useState(false);
  const savedRef=useRef<Partial<Record<WindowKind,{rect:WindowRect;display:WindowDisplay}>>>({});
  const viewport = useCallback(() => ({ width: window.innerWidth, height: window.innerHeight }), []);
  const key = `bflow:ui:windows:${encodeURIComponent(projectId)}`;
  useEffect(() => {
    if(!enabled){setHydrated(false);return;}
    try { const raw = localStorage.getItem(key); if(raw)savedRef.current=readLayout(raw); } catch { /* unavailable or corrupt storage is ignored */ }
    setHydrated(true);
  }, [key,enabled]);
  useEffect(()=>{const resize=()=>dispatch({type:'viewport',viewport:{width:window.innerWidth,height:window.innerHeight}});window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(() => {
    if(!enabled||!hydrated)return;
    try { const latest=localStorage.getItem(key);const data: Record<string, unknown> = { ...savedRef.current,...(latest?readLayout(latest):{}) }; for (const state of windows) data[state.kind] = { rect: state.rect, display: state.display }; savedRef.current=data as Partial<Record<WindowKind,{rect:WindowRect;display:WindowDisplay}>>; localStorage.setItem(key, JSON.stringify(data)); } catch { /* private browsing and quota errors are non-fatal */ }
  }, [key, windows, hydrated,enabled]);
  const value = useMemo<WindowContextValue>(() => ({ windows,
    open: (kind, params) => { const id = idFor(kind, params), saved=savedRef.current[kind]; dispatch({ type: 'open', kind, ...(params ? { params } : {}), viewport: viewport(), ...(saved ? { saved } : {}),maxVisible:4 }); return id; },
    focus: id => dispatch({ type: 'focus', id,maxVisible:4 }), close: id => dispatch({ type: 'close', id }), forceClose:id=>dispatch({type:'forceClose',id}), minimize: id => dispatch({ type: 'minimize', id }), toggleMaximize: id => dispatch({ type: 'toggleMaximize', id }),
    move: (id, dx, dy) => dispatch({ type: 'move', id, dx, dy, viewport:viewport() }), resize: (id, dx, dy) => dispatch({ type: 'resize', id, dx, dy, viewport:viewport() }), closeAll: keep => dispatch({ type: 'closeAll', ...(keep ? { keep } : {}) }), resetLayout: () => dispatch({ type: 'resetLayout', viewport: viewport(),maxVisible:4 }),
  }), [windows, viewport]);
  return <WindowContext.Provider value={value}>{children}</WindowContext.Provider>;
}
export function useWindows(): WindowContextValue { const value = useContext(WindowContext); if (!value) throw new Error('useWindows must be used within WindowManagerProvider'); return value; }
