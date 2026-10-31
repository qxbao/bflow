/** Initial placeholders reserve space; background reads retain content and focus without shifting document flow. */
export function LoadingState({loading,initial,label,rows=3}:{loading:boolean;initial:boolean;label:string;rows?:number}) {
  if(!loading)return null;
  if(!initial)return <div role="status" aria-live="polite" aria-busy="true" className="pointer-events-none fixed right-4 bottom-4 z-30 border border-line bg-surface px-3 py-1.5 font-data text-xs leading-4 text-muted">
    <span>Đang cập nhật dữ liệu…</span>
  </div>;
  return <div role="status" aria-live="polite" aria-busy="true" className="my-4 min-w-0">
    <span className="sr-only">{label}</span>
    <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">{Array.from({length:rows},(_,index)=><div key={index} className="border border-line bg-surface p-4"><div className="mb-3 h-3 w-1/3 bg-faint"/><div className="h-3 w-3/4 bg-faint"/></div>)}</div>
  </div>;
}
