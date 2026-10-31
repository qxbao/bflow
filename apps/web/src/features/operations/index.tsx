import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMatch } from 'react-router';
import { ApiClient } from '../../api/client';
import type { CommandBody } from '../../api/commands';
import { CommandStore, type Observation } from '../../api/commands';
import { OperationStatus, operationLabels } from '../../components/OperationStatus';
const RECENT_MS=10*60*1000;
const settled=(item:Observation)=>Boolean(item.operation && ['applied','failed'].includes(item.operation.state));
/** History is only a settled operation that is neither about the open run nor just finished. */
function belongsToHistory(item:Observation,runId:string|undefined){
  if(!settled(item))return false;
  const result=item.operation?.result;
  if(runId && (item.record.slot.endsWith(`:${runId}`) || (result?.kind==='interaction' && (result.runId===runId || result.currentRunId===runId))))return false;
  return Date.now()-Date.parse(item.operation!.updatedAt)>RECENT_MS;
}
const Context=createContext<{store:CommandStore;refresh:()=>void;online:boolean;observations:Observation[];notify:(message:string)=>void;startNew:(slot:string)=>Promise<void>}|null>(null);
export function Operations({api,id,refresh,children}:{api:ApiClient;id:string;refresh:()=>void;children:ReactNode}) {
  const [tick,setTick]=useState(0),[observations,setObservations]=useState<Observation[]>([]),[online,setOnline]=useState(navigator.onLine),[error,setError]=useState(''),[notices,setNotices]=useState<string[]>([]);
  const notify=useCallback((message:string)=>setNotices(list=>list.includes(message)?list:[...list.slice(-4),message]),[]);
  const changed=useCallback(()=>setTick(t=>t+1),[]);
  const store=useMemo(()=>new CommandStore(api,id,api.expiresAt??'unpaired',changed),[api,id,changed]);
  const refreshRef=useRef(refresh);refreshRef.current=refresh;
  const signatures=useRef(new Map<string,string>());
  const runId=useMatch('/projects/:projectId/runs/:runId')?.params.runId;
  const startNew=useCallback((slot:string)=>store.newIntent(slot).then(()=>{setError('');changed();},e=>setError(String(e.message))),[store,changed]);
  const row=(item:Observation)=><div key={item.record.commandId} className="border-t border-line py-2.5 first:border-t-0 first:pt-0"><OperationStatus observation={item} projectId={id}/><div className="mt-2 flex flex-wrap gap-2"><button onClick={changed}>Đọc lại thao tác</button>{settled(item) && <button onClick={()=>void startNew(item.record.slot)}>Bắt đầu thao tác mới: {operationLabels[item.record.kind]}</button>}</div></div>;
  const past=observations.filter(item=>belongsToHistory(item,runId)),current=observations.filter(item=>!belongsToHistory(item,runId));
  useEffect(()=>{const update=()=>{setOnline(navigator.onLine);changed();};window.addEventListener('online',update);window.addEventListener('offline',update);window.addEventListener('storage',changed);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);window.removeEventListener('storage',changed);};},[changed]);
  useEffect(()=>{
    let active=true;let timer:ReturnType<typeof setTimeout>;
    const read=async()=>{
      let records;try{records=store.records();}catch(e){if(active)setError(e instanceof Error?e.message:'Cần đối chiếu thao tác.');return;}
      const values=await Promise.all(records.map(record=>store.observe(record)));
      if(!active)return;setObservations(values);
      for(const value of values){const op=value.operation;const signature=op?JSON.stringify([op.state,op.result??null,op.error?.code??null,op.error?.message??null]):'';if(op && signatures.current.get(value.record.commandId)!==signature){signatures.current.set(value.record.commandId,signature);refreshRef.current();}}
      if(values.some(v=>!v.operation || !['applied','failed'].includes(v.operation.state)))timer=setTimeout(()=>void read(),3000);
    };
    if(online)void read();return()=>{active=false;clearTimeout(timer);};
  },[store,tick,online]);
  return <Context.Provider value={{store,refresh:changed,online:online && Boolean(navigator.locks),observations,notify,startNew}}>{!navigator.locks && <p role="status">Trình duyệt chưa hỗ trợ khóa thao tác giữa các tab. Dùng trình duyệt hỗ trợ Web Locks để gửi yêu cầu.</p>}{notices.length>0 && <section className="panel my-3 min-w-0 border border-warning border-l-3 bg-surface p-3.5 sm:p-4" aria-label="Thao tác chưa được gửi"><h2 className="m-0 text-base">Thao tác chưa được gửi</h2>{notices.map(text=><p key={text} role="alert" className="my-1.5 text-sm">{text}</p>)}<button onClick={()=>setNotices([])}>Đã hiểu</button></section>}{children}{error && <p role="alert">{error}</p>}{observations.length>0 && <section className="panel my-4 min-w-0 border border-line bg-surface p-3.5 sm:p-4" aria-label="Theo dõi thao tác"><h2 className="m-0 mb-2 text-base">Thao tác đã gửi</h2>{current.map(row)}{current.length===0 && <p className="my-1 text-sm text-muted">Không có thao tác đang theo dõi cho màn hình này.</p>}{past.length>0 && <details className="my-2"><summary>Lịch sử thao tác ({past.length})</summary>{past.map(row)}</details>}{error && <p role="alert">{error}</p>}</section>}</Context.Provider>;
}
export function useCommands(slot:string) {
  const context=useContext(Context);if(!context)throw new Error('Operations boundary required');
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>();const running=useRef(false);
  async function submit(body:CommandBody){
    if(running.current || !context!.online)return;running.current=true;setBusy(true);setError(undefined);
    try{return await context!.store.submit(slot,body);}catch(e){setError(e);throw e;}finally{running.current=false;setBusy(false);context!.refresh();}
  }
  return {submit,busy,error,online:context.online,notify:context.notify,operation:context.observations.find(o=>o.record.slot===slot)?.operation,tracked:context.observations.find(o=>o.record.slot===slot),startNew:()=>context.startNew(slot)};
}
