import { WebEventSchema, type WebEvent } from '@bflow/contracts/web';
import { projectPath } from './client';
export type Connection = 'connecting' | 'connected' | 'reconnecting' | 'offline';
/** Recreate streams on error: HTTP failures can permanently close native EventSource.
 * New instances send only the last validated cursor, avoiding conflicting query/Last-Event-ID.
 * Events remain invalidations, never command or workflow acknowledgements. */
export function subscribeEvents(projectId:string,changed:(event:WebEvent)=>void,state:(state:Connection)=>void):()=>void {
  let stopped=false,source:EventSource|undefined,timer:ReturnType<typeof setTimeout>|undefined,cursor:string|undefined,deliveredCursor:string|undefined,attempt=0;
  const retry=()=>{
    source?.close();
    if(stopped || timer!==undefined)return;
    state(navigator.onLine?'reconnecting':'offline');
    timer=setTimeout(()=>{timer=undefined;connect();},Math.min(30000,3000*2**Math.min(attempt++,4)));
  };
  const connect=()=>{
    if(stopped)return;
    const query=cursor?`?${new URLSearchParams({cursor})}`:'';
    const current=new EventSource(`${projectPath(projectId)}/events${query}`,{withCredentials:true});source=current;
    const receive=(event:MessageEvent<string>)=>{
      if(stopped || source!==current)return;
      try{
        const parsed=WebEventSchema.safeParse(JSON.parse(event.data));
        if(!parsed.success || parsed.data.projectId!==projectId || parsed.data.type!==event.type ||
          (event.lastEventId && event.lastEventId!==parsed.data.cursor)){retry();return;}
        cursor=parsed.data.cursor;attempt=0;state('connected');
        if(parsed.data.type!=='reset' && parsed.data.cursor===deliveredCursor)return;
        deliveredCursor=parsed.data.cursor;changed(parsed.data);
      }catch{retry();}
    };
    for(const kind of ['invalidate','operation','notice','chat','reset'])current.addEventListener(kind,receive);
    current.addEventListener('open',()=>{if(!stopped && source===current){attempt=0;state('connected');}});
    current.addEventListener('error',()=>{if(!stopped && source===current)retry();});
  };
  const onOnline=()=>{
    if(stopped)return;
    if(source && (source as {readyState?:number}).readyState===1){state('connected');return;}
    attempt=0;
    if(timer!==undefined){clearTimeout(timer);timer=undefined;}
    source?.close();
    state('reconnecting');
    connect();
  };
  const onOffline=()=>{if(!stopped)state('offline');};
  if(typeof window!=='undefined'){window.addEventListener('online',onOnline);window.addEventListener('offline',onOffline);}
  state('connecting');connect();
  return()=>{stopped=true;clearTimeout(timer);if(typeof window!=='undefined'){window.removeEventListener('online',onOnline);window.removeEventListener('offline',onOffline);}source?.close();};
}
