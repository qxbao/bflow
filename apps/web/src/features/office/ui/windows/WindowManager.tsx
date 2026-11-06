import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { defaultRect, clampRect } from './geometry';
import type { WindowDisplay, WindowKind, WindowRect } from './GameWindow';

export interface WinState { id: string; kind: WindowKind; params?: { instanceId?: string }; rect: WindowRect; z: number; display: WindowDisplay; }
export type WindowAction =
  | { type: 'open'; kind: WindowKind; params?: { instanceId?: string }; viewport: { width: number; height: number } }
  | { type: 'focus' | 'close' | 'minimize' | 'toggleMaximize'; id: string }
  | { type: 'move' | 'resize'; id: string; dx: number; dy: number }
  | { type: 'closeAll'; keep?: WindowKind[] }
  | { type: 'resetLayout'; viewport: { width: number; height: number } }
  | { type: 'restore'; states: Partial<Record<WindowKind, { rect: WindowRect; display: WindowDisplay }>>; viewport: { width: number; height: number } };

const idFor = (kind: WindowKind, params?: { instanceId?: string }) => kind === 'agent' ? `agent:${params?.instanceId ?? ''}` : kind;
const initial: WinState[] = [];
function normalized(states: WinState[]): WinState[] {
  let result = states.map((state, index) => ({ ...state, z: index + 1 }));
  const shown = result.filter(state => state.display !== 'minimized' && state.kind !== 'repair').sort((a,b)=>a.z-b.z);
  while (shown.length > 4) { const victim = shown.shift()!; result = result.map(state => state.id === victim.id ? { ...state, display: 'minimized' } : state); }
  return result.map(state => state.kind === 'repair' ? { ...state, z: result.length + 1 } : state);
}
export function windowReducer(states: WinState[] = initial, action: WindowAction): WinState[] {
  switch (action.type) {
    case 'open': {
      const id = idFor(action.kind, action.params), found = states.some(state => state.id === id);
      let next = found ? states.map(state => state.id === id ? { ...state, display: state.display === 'minimized' ? 'normal' : state.display, z: states.length + 1 } : state) : [...states, { id, kind: action.kind, ...(action.params ? { params: action.params } : {}), rect: defaultRect(action.kind, action.viewport, states.length), z: states.length + 1, display: 'normal' as const }];
      if (!found && action.kind === 'agent') { const agents = next.filter(state => state.kind === 'agent'); if (agents.length > 3) next = next.filter(state => state.id !== agents.sort((a,b)=>a.z-b.z)[0]!.id); }
      return normalized(next);
    }
    case 'focus': return normalized(states.map(state => state.id === action.id && state.display === 'minimized' ? { ...state, display: 'normal', z: states.length + 1 } : state.id === action.id ? { ...state, z: states.length + 1 } : state));
    case 'close': return states.filter(state => state.id !== action.id || state.kind === 'repair');
    case 'closeAll': return states.filter(state => state.kind === 'repair' || action.keep?.includes(state.kind));
    case 'minimize': return states.map(state => state.id === action.id && state.kind !== 'repair' ? { ...state, display: 'minimized' } : state);
    case 'toggleMaximize': return states.map(state => state.id === action.id ? { ...state, display: state.display === 'maximized' ? 'normal' : 'maximized' } : state);
    case 'move': return states.map(state => state.id === action.id ? { ...state, rect: { ...state.rect, x: state.rect.x + action.dx, y: state.rect.y + action.dy } } : state);
    case 'resize': return states.map(state => state.id === action.id ? { ...state, rect: { ...state.rect, w: Math.max(320, state.rect.w + action.dx), h: Math.max(240, state.rect.h + action.dy) } } : state);
    case 'resetLayout': return states.map((state, index) => ({ ...state, rect: defaultRect(state.kind, action.viewport, index), display: 'normal' }));
    case 'restore': return states.map(state => { const saved = action.states[state.kind]; return saved ? { ...state, rect: clampRect(saved.rect, action.viewport), display: saved.display } : state; });
  }
}

interface WindowContextValue { windows: WinState[]; open: (kind: WindowKind, params?: { instanceId?: string }) => string; focus: (id: string) => void; close: (id: string) => void; minimize: (id: string) => void; toggleMaximize: (id: string) => void; move: (id: string, dx: number, dy: number) => void; resize: (id: string, dx: number, dy: number) => void; closeAll: (keep?: WindowKind[]) => void; resetLayout: () => void; }
const WindowContext = createContext<WindowContextValue | null>(null);
export function WindowManagerProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [windows, dispatch] = useReducer(windowReducer, initial);
  const viewport = useCallback(() => ({ width: window.innerWidth, height: window.innerHeight }), []);
  const key = `bflow:ui:windows:${encodeURIComponent(projectId)}`;
  useEffect(() => {
    try { const raw = localStorage.getItem(key); if (!raw) return; const data = JSON.parse(raw) as Partial<Record<WindowKind, { rect: WindowRect; display: WindowDisplay }>>; dispatch({ type: 'restore', states: data, viewport: viewport() }); } catch { /* unavailable or corrupt storage is ignored */ }
  }, [key, viewport]);
  useEffect(() => {
    try { const data: Record<string, unknown> = {}; for (const state of windows) data[state.kind] = { rect: state.rect, display: state.display }; localStorage.setItem(key, JSON.stringify(data)); } catch { /* private browsing and quota errors are non-fatal */ }
  }, [key, windows]);
  const value = useMemo<WindowContextValue>(() => ({ windows,
    open: (kind, params) => { const id = idFor(kind, params); dispatch({ type: 'open', kind, ...(params ? { params } : {}), viewport: viewport() }); return id; },
    focus: id => dispatch({ type: 'focus', id }), close: id => dispatch({ type: 'close', id }), minimize: id => dispatch({ type: 'minimize', id }), toggleMaximize: id => dispatch({ type: 'toggleMaximize', id }),
    move: (id, dx, dy) => dispatch({ type: 'move', id, dx, dy }), resize: (id, dx, dy) => dispatch({ type: 'resize', id, dx, dy }), closeAll: keep => dispatch({ type: 'closeAll', ...(keep ? { keep } : {}) }), resetLayout: () => dispatch({ type: 'resetLayout', viewport: viewport() }),
  }), [windows, viewport]);
  return <WindowContext.Provider value={value}>{children}</WindowContext.Provider>;
}
export function useWindows(): WindowContextValue { const value = useContext(WindowContext); if (!value) throw new Error('useWindows must be used within WindowManagerProvider'); return value; }
