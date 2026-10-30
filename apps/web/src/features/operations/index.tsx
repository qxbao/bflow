import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiClient } from '../../api/client';
import type { CommandBody } from '../../api/commands';
import { CommandStore, type Observation } from '../../api/commands';
import { OperationStatus, operationLabels } from '../../components/OperationStatus';
const Context=createContext<{store:CommandStore;refresh:()=>void;online:boolean;observations:Observation[];notify:(message:string)=>void}|null>(null);
export function Operations({api,id,refresh,children}:{api:ApiClient;id:string;refresh:()=>void;children:ReactNode}) {
  const [tick,setTick]=useState(0),[observations,setObservations]=useState<Observation[]>([]),[online,setOnline]=useState(navigator.onLine),[error,setError]=useState(''),[notices,setNotices]=useState<string[]>([]);
  const notify=useCallback((message:string)=>setNotices(list=>list.includes(message)?list:[...list.slice(-4),message]),[]);
  const changed=useCallback(()=>setTick(t=>t+1),[]);
  const store=useMemo(()=>new CommandStore(api,id,api.expiresAt??'unpaired',changed),[api,id,changed]);
  const refreshRef=useRef(refresh);refreshRef.current=refresh;
  const signatures=useRef(new Map<string,string>());
  useEffect(()=>{const update=()=>{setOnline(navigator.onLine);changed();};window.addEventListener('online',update);window.addEventListener('offline',update);window.addEventListener('storage',changed);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);window.removeEventListener('storage',changed);};},[changed]);
  useEffect(()=>{
    let active=true;let timer:ReturnType<typeof setTimeout>;
    const read=async()=>{
      let records;try{records=store.records();}catch(e){if(active)setError(e instanceof Error?e.message:'Cần đối chiếu thao tác.');return;}
      const values=await Promise.all(records.map(record=>store.observe(record)));
      if(!active)return;setObservations(values);
      for(const value of values){const signature=JSON.stringify(value.operation);if(value.operation && signatures.current.get(value.record.commandId)!==signature){signatures.current.set(value.record.commandId,signature);refreshRef.current();}}
      if(values.some(v=>!v.operation || !['applied','failed'].includes(v.operation.state)))timer=setTimeout(()=>void read(),3000);
    };
    if(online)void read();return()=>{active=false;clearTimeout(timer);};
  },[store,tick,online]);
  return <Context.Provider value={{store,refresh:changed,online:online && Boolean(navigator.locks),observations,notify}}>{!navigator.locks && <p role="status">Trình duyệt chưa hỗ trợ khóa thao tác giữa các tab. Dùng trình duyệt hỗ trợ Web Locks để gửi yêu cầu.</p>}{children}{error && <p role="alert">{error}</p>}{notices.length>0 && <section className="panel min-w-0 border border-line bg-surface p-4 sm:p-5" aria-label="Thao tác chưa được gửi"><h2>Thao tác chưa được gửi</h2>{notices.map(text=><p key={text} role="alert">{text}</p>)}<button onClick={()=>setNotices([])}>Đã hiểu</button></section>}{observations.length>0 && <section className="panel min-w-0 border border-line bg-surface p-4 sm:p-5" aria-label="Theo dõi thao tác"><h2>Thao tác đã gửi</h2>{observations.map(item=><div key={item.record.commandId}><OperationStatus observation={item} projectId={id}/><button onClick={changed}>Đọc lại thao tác</button>{item.operation && ['applied','failed'].includes(item.operation.state) && <button onClick={()=>{void store.newIntent(item.record.slot).then(()=>{setError('');changed();},e=>setError(String(e.message)));}}>Bắt đầu thao tác mới: {operationLabels[item.record.kind]}</button>}</div>)}{error && <p role="alert">{error}</p>}</section>}</Context.Provider>;
}
export function useCommands(slot:string) {
  const context=useContext(Context);if(!context)throw new Error('Operations boundary required');
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>();const running=useRef(false);
  async function submit(body:CommandBody){
    if(running.current || !context!.online)return;running.current=true;setBusy(true);setError(undefined);
    try{return await context!.store.submit(slot,body);}catch(e){setError(e);throw e;}finally{running.current=false;setBusy(false);context!.refresh();}
  }
  return {submit,busy,error,online:context.online,notify:context.notify,operation:context.observations.find(o=>o.record.slot===slot)?.operation};
}
