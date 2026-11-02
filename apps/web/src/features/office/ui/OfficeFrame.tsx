import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { UiMode } from '../mode';

const Slot=createContext<{mode:UiMode;overviewOpen:boolean;overview:ReactNode}>({mode:'classic',overviewOpen:false,overview:null});
/** Index route element: classic always shows the overview; visual only when the HUD opened it. */
export function OverviewOutlet() {
  const slot=useContext(Slot);
  return <>{slot.mode==='classic' || slot.overviewOpen?slot.overview:null}</>;
}
/**
 * `children` (the project `<Routes>`) keeps one fixed position in this fragment in both modes, so a mode switch never remounts it
 * and in-memory drafts survive. The frame adds no DOM: the stage and HUD are portalled by `VisualOffice` into nodes AppShell renders only in
 * visual mode, and AppShell turns `<main>` into the overlay panel around the same children. The frame keeps the panel's focus hand-off.
 */
export function OfficeFrame({mode,overview,overviewOpen,panelOpen,children}:{mode:UiMode;overview:ReactNode;overviewOpen:boolean;panelOpen:boolean;children:ReactNode}) {
  const opener=useRef<HTMLElement|null>(null),wasOpen=useRef(false);
  // Child effects run before AppShell's route-focus effect, so the opener is still the active element when the panel opens.
  useEffect(()=>{
    if(mode!=='visual'){wasOpen.current=false;return;}
    if(panelOpen && !wasOpen.current){const active=document.activeElement;opener.current=active instanceof HTMLElement && active!==document.body?active:null;}
    if(!panelOpen && wasOpen.current){const target=opener.current;opener.current=null;if(target?.isConnected)target.focus();}
    if(panelOpen && !wasOpen.current)document.getElementById('main')?.focus();
    wasOpen.current=panelOpen;
  },[mode,panelOpen]);
  return <Slot.Provider value={{mode,overviewOpen,overview}}>{children}</Slot.Provider>;
}
