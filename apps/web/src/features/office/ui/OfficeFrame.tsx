import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { OperationsDock } from '../../operations';
import type { UiMode } from '../mode';
import { ModeSwitch } from './ModeSwitch';

const Slot=createContext<{mode:UiMode;overviewOpen:boolean;overview:ReactNode}>({mode:'classic',overviewOpen:false,overview:null});
/** Index route element: classic always shows the overview; visual only when the HUD opened it. */
export function OverviewOutlet() {
  const slot=useContext(Slot);
  return <>{slot.mode==='classic' || slot.overviewOpen?slot.overview:null}</>;
}
/**
 * `children` (the project `<Routes>`) keeps one fixed position in this fragment in both modes, so a mode switch never remounts it
 * and in-memory drafts survive. In classic the frame adds no DOM. In visual the stage and HUD are portalled into `host`, a node
 * AppShell renders only in visual mode, and AppShell turns `<main>` into the overlay panel around the same children.
 */
export function OfficeFrame({mode,overview,overviewOpen,panelOpen,host,stage,mark,onMode,onOverview,children}:{mode:UiMode;overview:ReactNode;overviewOpen:boolean;panelOpen:boolean;host:HTMLElement|null;stage:ReactNode;mark:ReactNode;onMode:(mode:UiMode)=>void;onOverview:()=>void;children:ReactNode}) {
  const opener=useRef<HTMLElement|null>(null),wasOpen=useRef(false);
  // Child effects run before AppShell's route-focus effect, so the opener is still the active element when the panel opens.
  useEffect(()=>{
    if(mode!=='visual'){wasOpen.current=false;return;}
    if(panelOpen && !wasOpen.current){const active=document.activeElement;opener.current=active instanceof HTMLElement && active!==document.body?active:null;}
    if(!panelOpen && wasOpen.current){const target=opener.current;opener.current=null;if(target?.isConnected)target.focus();}
    wasOpen.current=panelOpen;
  },[mode,panelOpen]);
  return <Slot.Provider value={{mode,overviewOpen,overview}}>{children}{mode==='visual' && host && createPortal(<>
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 border-b border-line pb-2.5 font-data text-sm">{mark}<div className="flex flex-wrap items-center gap-2"><button type="button" aria-pressed={overviewOpen} onClick={onOverview}>Tổng quan</button><ModeSwitch mode={mode} onChange={onMode}/></div></div>
    <OperationsDock/>
    <section aria-label="Danh sách công việc" className="my-4 border border-line bg-surface p-3.5 sm:p-4">{stage}</section>
  </>,host)}</Slot.Provider>;
}
