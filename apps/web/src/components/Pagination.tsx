export function Pagination({label,page,previous,next,first,busy=false,summary,nextLabel='Trang tiếp theo'}:{label:string;page?:number|undefined;previous?: (()=>void)|undefined;next?:(()=>void)|undefined;first?:(()=>void)|undefined;busy?:boolean;summary?:string|undefined;nextLabel?:string}) {
  if(!previous && !next && !first)return summary?<p className="text-sm text-muted">{summary}</p>:null;
  return <nav aria-label={label} className="my-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
    <p className="m-0 font-data text-sm text-muted" role="status">{page?`Trang ${page}`:'Trang hiện tại'}{summary?` · ${summary}`:''}</p>
    <div className="flex flex-wrap gap-2">
      {first && <button disabled={busy} onClick={first}>Về trang đầu</button>}
      <button disabled={busy || !previous} onClick={previous}>Trang trước</button>
      <button disabled={busy || !next} onClick={next}>{nextLabel}</button>
    </div>
  </nav>;
}
