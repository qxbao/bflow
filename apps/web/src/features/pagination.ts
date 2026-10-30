import { useLocation, useSearchParams } from 'react-router';

/** Known cursors travel with each browser history entry, scoped to project/filters. */
export function useCursorPagination(scope:string) {
  const [query,setQuery]=useSearchParams(),location=useLocation();
  const cursor=query.get('cursor')??undefined;
  const state=location.state as {cursorHistory?:{scope?:unknown;trail?:unknown}}|null;
  const saved=state?.cursorHistory;
  const trail:string[]|undefined=!cursor?[]:saved?.scope===scope && Array.isArray(saved.trail) && saved.trail.every(item=>typeof item==='string')?saved.trail:undefined;
  function go(value:string|undefined,history:string[]|undefined){
    const params=new URLSearchParams(query);if(value)params.set('cursor',value);else params.delete('cursor');
    setQuery(params,{state:history?{cursorHistory:{scope,trail:history}}:null});
  }
  return {cursor,page:trail?trail.length+1:undefined,
    first:cursor?()=>go(undefined,[]):undefined,
    previous:trail?.length?()=>go(trail.at(-1)||undefined,trail.slice(0,-1)):undefined,
    next:(value:string)=>go(value,trail?[...trail,cursor??'']:undefined),
  };
}
export function localPage<T>(items:T[],raw:string|null,size:number){
  const requested=raw && /^\d+$/.test(raw)?Number(raw):1;
  const pages=Math.max(1,Math.ceil(items.length/size));
  const page=Math.max(1,Math.min(Number.isSafeInteger(requested)?requested:1,pages));
  return {page,pages,items:items.slice((page-1)*size,page*size)};
}
