import { useCallback, useState } from 'react';
import { flushSync } from 'react-dom';
export type UiMode='classic'|'visual';
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
  const set=useCallback((next:UiMode)=>{
    writeMode(next);
    // Cross-fade the Web <-> 3D swap where the browser supports View Transitions; otherwise (and under reduced motion) switch at once.
    const doc=typeof document==='undefined'?undefined:document as Document&{startViewTransition?:(update:()=>void)=>unknown};
    const reduced=typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(doc?.startViewTransition&&!reduced)doc.startViewTransition(()=>flushSync(()=>setState(next)));
    else setState(next);
  },[]);
  return [mode,set];
}
