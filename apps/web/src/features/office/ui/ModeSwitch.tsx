import type { UiMode } from '../mode';
const options:[UiMode,string][]=[['classic','Web'],['visual','3D']];
/**
 * The one Web | 3D pill for both modes: same size and the same top-right spot, and a shared `view-transition-name` so the mode
 * change morphs the pill in place instead of fading it out and in. Theme colors come from the surrounding scope.
 */
export function ModeSwitch({mode,onChange,className=''}:{mode:UiMode;onChange:(mode:UiMode)=>void;className?:string}) {
  return <div role="group" aria-label="Chế độ hiển thị" className={`mode-switch inline-flex gap-0.5 rounded-xl border border-line bg-surface/85 p-0.5 backdrop-blur-md ${className}`}>{options.map(([value,label])=><button type="button" key={value} aria-pressed={mode===value} className="min-h-8 min-w-11 rounded-lg border-0 px-2.5 py-1 font-data text-xs leading-none aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-surface" onClick={()=>{if(mode!==value)onChange(value);}}>{label}</button>)}</div>;
}
