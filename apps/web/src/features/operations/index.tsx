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
const Context=createContext<{store:CommandStore;refresh:()=>void;ingest:(observation:Observation)=>void;online:boolean;observations:Observation[];error:string;notify:(message:string)=>void;startNew:(slot:string,superseded?:string)=>Promise<void>;dock:ReactNode}|null>(null);
export function Operations({api,id,revision,refresh,dock='inline',children}:{api:ApiClient;id:string;revision?:number|undefined;refresh:()=>void;dock?:'inline'|'external';children:ReactNode}) {
  const [tick,setTick]=useState(0),[observations,setObservations]=useState<Observation[]>([]),[online,setOnline]=useState(navigator.onLine),[error,setError]=useState(''),[notices,setNotices]=useState<string[]>([]);
  const notify=useCallback((message:string)=>setNotices(list=>list.includes(message)?list:[...list.slice(-4),message]),[]);
  const forceRead=useRef(false);
  const changed=useCallback(()=>{setTick(t=>t+1);},[]);
  const reread=useCallback(()=>{forceRead.current=true;setTick(t=>t+1);},[]);
  const store=useMemo(()=>new CommandStore(api,id,api.expiresAt??'unpaired',changed),[api,id,changed]);
  const refreshRef=useRef(refresh);refreshRef.current=refresh;
  const signatures=useRef(new Map<string,string>());
  const known=useRef(new Map<string,{observation:Observation;observedAt:number}>());
  const lastRevision=useRef(revision);
  useEffect(()=>{signatures.current.clear();known.current.clear();},[store]);
  const recordSignature=useCallback((value:Observation)=>{
    const op=value.operation;
    if(!op)return;
    const signature=JSON.stringify([op.state,op.result??null,op.error?.code??null,op.error?.message??null]);
    if(signatures.current.get(value.record.commandId)!==signature){signatures.current.set(value.record.commandId,signature);refreshRef.current();}
  },[]);
  const ingest=useCallback((observation:Observation)=>{
    known.current.set(observation.record.commandId,{observation,observedAt:Date.now()});
    recordSignature(observation);
    setObservations(previous=>{
      const index=previous.findIndex(item=>item.record.commandId===observation.record.commandId || item.record.slot===observation.record.slot);
      return index===-1?[...previous,observation]:previous.map((item,i)=>i===index?observation:item);
    });
  },[recordSignature]);
  const runId=useMatch('/projects/:projectId/runs/:runId')?.params.runId;
  const startNew=useCallback((slot:string,superseded?:string)=>store.newIntent(slot,superseded).then(()=>{
    for(const [commandId,entry] of known.current)if(entry.observation.record.slot===slot){known.current.delete(commandId);signatures.current.delete(commandId);}
    setError('');changed();
  },e=>setError(String(e.message))),[store,changed]);
  const row=(item:Observation)=><div key={item.record.commandId} className="border-t border-line py-2.5 first:border-t-0 first:pt-0"><OperationStatus observation={item} projectId={id}/><div className="mt-2 flex flex-wrap gap-2"><button onClick={reread}>Đọc lại thao tác</button>{settled(item) && <button onClick={()=>void startNew(item.record.slot)}>Bắt đầu thao tác mới: {operationLabels[item.record.kind]}</button>}</div></div>;
  const past=observations.filter(item=>belongsToHistory(item,runId)),current=observations.filter(item=>!belongsToHistory(item,runId));
  useEffect(()=>{const update=()=>{setOnline(navigator.onLine);reread();};window.addEventListener('online',update);window.addEventListener('offline',update);window.addEventListener('storage',reread);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);window.removeEventListener('storage',reread);};},[reread]);
  useEffect(()=>{
    if(lastRevision.current===revision)return;
    lastRevision.current=revision;
    try{
      const records=store.records();
      if(records.some(record=>{const entry=known.current.get(record.commandId);return !entry || !settled(entry.observation);}))reread();
    }catch{reread();}
  },[revision,store,reread]);
  useEffect(()=>{
    let active=true;let timer:ReturnType<typeof setTimeout>;
    const read=async(forced:boolean)=>{
      let records;try{records=store.records();if(active)setError('');}catch(e){if(active)setError(e instanceof Error?e.message:'Cần đối chiếu thao tác.');return;}
      const liveIds=new Set(records.map(record=>record.commandId));
      for(const commandId of known.current.keys())if(!liveIds.has(commandId)){known.current.delete(commandId);signatures.current.delete(commandId);}
      if(!online){
        const offlineValues=records.map(record=>{const cached=known.current.get(record.commandId)?.observation;return cached?{...cached,record}:{record,uncertain:true};});
        if(active)setObservations(offlineValues);
        return;
      }
      const now=Date.now();
      const values=await Promise.all(records.map(async record=>{
        const cached=known.current.get(record.commandId);
        if(cached && settled(cached.observation))return {...cached.observation,record};
        if(!forced && cached?.observation.operation && now-cached.observedAt<500)return {...cached.observation,record};
        const observed=await store.observe(record);
        if(!observed.submitting)known.current.set(record.commandId,{observation:observed,observedAt:Date.now()});
        return observed;
      }));
      if(!active)return;setObservations(values);
      for(const value of values)recordSignature(value);
      if(values.some(v=>!v.operation || !['applied','failed'].includes(v.operation.state)))timer=setTimeout(()=>void read(true),3000);
    };
    const forced=forceRead.current;forceRead.current=false;
    void read(forced);return()=>{active=false;clearTimeout(timer);};
  },[store,tick,online,recordSignature]);
  // The dock is the error banner plus the tracked-operations list; `external` only moves where it renders.
  const panel=<>{error && <div role="alert" className="my-2 border border-danger border-l-3 bg-surface p-3 text-sm"><p className="my-1">{error}</p>{error.includes('Mã phục hồi bị hỏng') && <button type="button" onClick={()=>{store.clearCorrupted();reread();}}>Xóa mã phục hồi bị hỏng</button>}</div>}{observations.length>0 && <section data-component="OperationsDock" className="panel my-4 min-w-0 border border-line bg-surface p-3.5 sm:p-4" aria-label="Theo dõi thao tác"><h2 className="m-0 mb-2 text-base">Thao tác đã gửi</h2>{current.map(row)}{current.length===0 && <p className="my-1 text-sm text-muted">Không có thao tác đang theo dõi cho màn hình này.</p>}{past.length>0 && <details className="my-2"><summary>Lịch sử thao tác ({past.length})</summary>{past.map(row)}</details>}</section>}</>;
  return <Context.Provider value={{store,refresh:changed,ingest,online:online && Boolean(navigator.locks),observations,error,notify,startNew,dock:panel}}>{!navigator.locks && <p role="status">Trình duyệt chưa hỗ trợ khóa thao tác giữa các tab. Dùng trình duyệt hỗ trợ Web Locks để gửi yêu cầu.</p>}{notices.length>0 && <section className="panel my-3 min-w-0 border border-warning border-l-3 bg-surface p-3.5 sm:p-4" aria-label="Thao tác chưa được gửi"><h2 className="m-0 text-base">Thao tác chưa được gửi</h2>{notices.map(text=><p key={text} role="alert" className="my-1.5 text-sm">{text}</p>)}<button onClick={()=>setNotices([])}>Đã hiểu</button></section>}{children}{dock==='inline' && panel}</Context.Provider>;
}
/** Renders the operations dock where `Operations dock="external"` left it out. */
export function OperationsDock() {
  const context=useContext(Context);if(!context)throw new Error('Operations boundary required');
  return <>{context.dock}</>;
}
/** What the collapsed HUD dock toggle shows: the tracked count, and whether something needs a look (error banner, or an uncertain/failed operation). */
export function useOperationsDockSummary():{count:number;attention:boolean} {
  const context=useContext(Context);if(!context)throw new Error('Operations boundary required');
  const {observations,error}=context;
  return {count:observations.length,attention:Boolean(error) || observations.some(item=>item.uncertain || item.operation?.state==='reconciliation_required' || item.operation?.state==='failed')};
}
export function useCommands(slot:string) {
  const context=useContext(Context);if(!context)throw new Error('Operations boundary required');
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>();const running=useRef(false);
  async function submit(body:CommandBody){
    if(running.current || !context!.online)return;running.current=true;setBusy(true);setError(undefined);
    try{const observed=await context!.store.submit(slot,body);context!.ingest(observed);return observed;}catch(e){setError(e);throw e;}finally{running.current=false;setBusy(false);context!.refresh();}
  }
  return {submit,busy,error,online:context.online,notify:context.notify,operation:context.observations.find(o=>o.record.slot===slot)?.operation,tracked:context.observations.find(o=>o.record.slot===slot),startNew:(superseded?:string)=>context.startNew(slot,superseded)};
}
