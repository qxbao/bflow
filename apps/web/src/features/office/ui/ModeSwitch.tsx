import { UI_MODE_OPTIONS, type UiMode } from '../mode';
export function ModeSwitch({mode,onChange}:{mode:UiMode;onChange:(mode:UiMode)=>void}) {
  return <div role="group" aria-label="Chế độ hiển thị" className="inline-flex">{UI_MODE_OPTIONS.map(([value,label])=><button type="button" key={value} aria-pressed={mode===value} className="min-w-24 aria-pressed:border-accent aria-pressed:bg-faint aria-pressed:font-semibold" onClick={()=>{if(mode!==value)onChange(value);}}>{label}</button>)}</div>;
}
