import { useCallback, useState } from 'react';
export type UiMode='classic'|'visual';
export const UI_MODE_OPTIONS:readonly (readonly [UiMode,string])[]=[['classic','Classic'],['visual','3D']];
/** Deliberately outside the `bflow:web:operations:` prefix: CommandStore.records() treats malformed keys there as corruption. */
export const MODE_KEY='bflow:ui:mode';
export function readMode():UiMode {
  try{return localStorage.getItem(MODE_KEY)==='visual'?'visual':'classic';}catch{return 'classic';}
}
export function writeMode(mode:UiMode) {
  try{localStorage.setItem(MODE_KEY,mode);}catch{/* storage is a convenience only */}
}
export function useUiMode():[UiMode,(mode:UiMode)=>void] {
  const [mode,setState]=useState<UiMode>(readMode);
  const set=useCallback((next:UiMode)=>{writeMode(next);setState(next);},[]);
  return [mode,set];
}
