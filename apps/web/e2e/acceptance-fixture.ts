import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
/** Starts the actual Local Server with the W09 deterministic host in a child process (W07 pattern). */
export interface AcceptanceHost {pairing:string;origin:string;repository:string;call(kind:string,values?:Record<string,unknown>):Promise<any>;close():Promise<void>}
export async function startAcceptanceHost():Promise<AcceptanceHost>{
  const child:ChildProcess=spawn(process.execPath,['--input-type=module'],{cwd:resolve('../cli'),env:{...process.env,W09_ASSETS:resolve('dist/client')},stdio:['pipe','pipe','pipe','ipc']});
  child.stdin!.end(await readFile('e2e/acceptance-host.mjs','utf8'));
  let seq=0;const waiting=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let stderr='';child.stderr!.on('data',d=>{stderr=(stderr+String(d)).slice(-4000);});
  const ready=await new Promise<any>((accept,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Fixture did not start: '+stderr)),15000);
    child.on('message',(raw:any)=>{
      if(raw.ready){clearTimeout(timer);accept(raw);return;}
      const pending=waiting.get(raw.requestId);if(!pending)return;
      clearTimeout(pending.timer);waiting.delete(raw.requestId);raw.error?pending.reject(new Error(raw.error)):pending.resolve(raw.value);
    });
    child.once('exit',code=>{if(code){clearTimeout(timer);reject(new Error('Fixture exited: '+stderr));}});
  });
  const call=(kind:string,values:Record<string,unknown>={})=>new Promise<any>((accept,reject)=>{
    const requestId=++seq,timer=setTimeout(()=>{waiting.delete(requestId);reject(new Error('Fixture IPC timeout'));},15000);
    waiting.set(requestId,{resolve:accept,reject,timer});child.send!({kind,requestId,...values});
  });
  return {pairing:ready.pairing,origin:ready.origin,repository:ready.repository,call,async close(){
    if(child.connected)child.send!({kind:'close'});
    await new Promise<void>(accept=>{if(child.exitCode!==null){accept();return;}child.once('exit',()=>accept());setTimeout(()=>{child.kill();accept();},4000);});
  }};
}
