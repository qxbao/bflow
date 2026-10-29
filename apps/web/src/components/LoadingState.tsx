/** Initial placeholders reserve space; background reads retain content and focus. */
export function LoadingState({loading,initial,label,rows=3}:{loading:boolean;initial:boolean;label:string;rows?:number}) {
  if(!loading)return null;
  return <div role="status" aria-live="polite" aria-busy="true" className={initial?'my-4 min-w-0':'my-2 font-data text-xs text-muted'}>
    <span className={initial?'sr-only':''}>{initial?label:'Đang cập nhật dữ liệu…'}</span>
    {initial && <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">{Array.from({length:rows},(_,index)=><div key={index} className="border border-line bg-surface p-4"><div className="mb-3 h-3 w-1/3 bg-faint"/><div className="h-3 w-3/4 bg-faint"/></div>)}</div>}
  </div>;
}
