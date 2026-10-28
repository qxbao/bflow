import { afterEach, expect, it, vi } from 'vitest';
import { fixture, client } from './helpers.js';
let f: Awaited<ReturnType<typeof fixture>>;
afterEach(async()=>{await f?.close();});
it('persists lifecycle owner before start, reconciles lost ACK after restart without host or resend',async()=>{
 const start=vi.fn(async()=>{throw Error('private host token');});
 const reconcile=vi.fn(async(op:any)=>({ok:true as const,value:{...op,state:'applied',result:{kind:'lifecycle',session:{apiVersion:1,projectId:op.projectId,state:'ready',pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()}}}}));
 f=await fixture({startSession:start,reconcileSessionOperation:reconcile});const {headers}=await f.login();
 const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},headers)).json.projectId;const id=crypto.randomUUID();const route=`/api/v1/projects/${p}`;
 const r=await f.send(route+'/session/start','POST',{apiVersion:1,operationId:id},headers);expect(r.status).toBe(202);expect(r.json.state).toBe('reconciliation_required');expect(start).toHaveBeenCalledTimes(1);
 expect((await f.send(route,'DELETE',{apiVersion:1,confirmed:true},headers)).status).toBe(409);
 await f.restart();const next=await f.login();const read=await f.send(route+'/operations/'+id,'GET',undefined,next.headers);expect(read.json.owner).toBe('local_lifecycle');expect(read.json.state).toBe('applied');expect(start).toHaveBeenCalledTimes(1);expect(reconcile).toHaveBeenCalledTimes(1);
 expect((await f.send(route+'/session/start','POST',{apiVersion:1,operationId:id},next.headers)).json).toEqual(read.json);expect(start).toHaveBeenCalledTimes(1);
 expect((await f.send(route+'/session/stop','POST',{apiVersion:1,operationId:id,confirmed:true},next.headers)).status).toBe(409);
});
it('pins host owner/session and command fingerprint; old commands never execute in a new host',async()=>{
 let sessionId='host-one';const execute=vi.fn(async()=>{throw Error('lost ACK');});const readOperation=vi.fn(async()=>({ok:false as const,error:{code:'not_found' as const,retryable:false as const,message:'missing'}}));
 f=await fixture({},async(projectId)=>({...client,execute,readOperation,readProjectSession:async()=>({ok:true,value:{apiVersion:1,projectId,sessionId,state:'ready',pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()}})}));
 const {headers}=await f.login();const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},headers)).json.projectId;
 const command={apiVersion:1,projectId:p,commandId:crypto.randomUUID(),kind:'cancel',runId:'run',expectedVersion:{revisionToken:'v'},reason:'cancel'};const route=`/api/v1/projects/${p}`;
 expect((await f.send(route+'/commands','POST',command,headers)).json.state).toBe('reconciliation_required');expect(execute).toHaveBeenCalledTimes(1);
 expect((await f.send(route+'/commands','POST',{...command,reason:'changed'},headers)).status).toBe(409);
 await f.restart();sessionId='host-two';const next=await f.login();expect((await f.send(route+'/commands','POST',command,next.headers)).json.state).toBe('reconciliation_required');expect(execute).toHaveBeenCalledTimes(1);
});
it('stops through workspace only, caches final receipts after host loss, retains tombstones across unregister',async()=>{
 const stop=vi.fn(async(projectId:string)=>({ok:true as const,value:{apiVersion:1 as const,projectId,state:'stopped' as const,pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()}}));
 const interaction=vi.fn(async()=>{throw Error('Host gone');});
 f=await fixture({stopSession:stop},interaction);const {headers}=await f.login();const path=await f.repo();const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path},headers)).json.projectId;
 const route=`/api/v1/projects/${p}`,id=crypto.randomUUID(),body={apiVersion:1,operationId:id,confirmed:true};
 const result=await f.send(route+'/session/stop','POST',body,headers);expect(result.status).toBe(202);expect(result.json.state).toBe('applied');expect(result.json.result.session.state).toBe('stopped');
 expect((await f.send(route+'/operations/'+id,'GET',undefined,headers)).json).toEqual(result.json);expect(interaction).not.toHaveBeenCalled();
 expect((await f.send(route,'DELETE',{apiVersion:1,confirmed:true},headers)).status).toBe(204);
 await f.send('/api/v1/projects','POST',{apiVersion:1,path},headers);await f.restart();const next=await f.login();
 expect((await f.send(route+'/session/stop','POST',body,next.headers)).json).toEqual(result.json);expect(stop).toHaveBeenCalledTimes(1);
 const other=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo('other')},next.headers)).json.projectId;
 expect((await f.send(`/api/v1/projects/${other}/operations/${id}`,'GET',undefined,next.headers)).status).toBe(404);
});
it('rejects malformed/foreign backend operation data and serializes duplicate concurrent starts',async()=>{
 const start=vi.fn(async()=>{await new Promise(r=>setTimeout(r,20));return {ok:true as const,value:{apiVersion:1 as const,projectId:'foreign',state:'ready' as const,pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()}};});
 f=await fixture({startSession:start});const {headers}=await f.login();const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},headers)).json.projectId;
 const id=crypto.randomUUID(),route=`/api/v1/projects/${p}/session/start`;
 const results=await Promise.all([f.send(route,'POST',{apiVersion:1,operationId:id},headers),f.send(route,'POST',{apiVersion:1,operationId:id},headers)]);
 expect(start).toHaveBeenCalledTimes(1);for(const result of results){expect(result.json.state).toBe('reconciliation_required');expect(result.body).not.toContain('foreign');}
});
it('returns the durable operation ID when post-effect ledger writes fail and never retries delivery',async()=>{
 const {chmod}=await import('node:fs/promises');
 const start=vi.fn(async()=>{await chmod(f.stateDirectory,0o500);throw Error('lost ACK');});
 f=await fixture({startSession:start});const {headers}=await f.login();const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},headers)).json.projectId;
 const id=crypto.randomUUID(),route=`/api/v1/projects/${p}/session/start`;let response;
 try{response=await f.send(route,'POST',{apiVersion:1,operationId:id},headers);}finally{await chmod(f.stateDirectory,0o700);}
 expect(response.status).toBe(503);expect(response.json.code).toBe('reconciliation_required');expect(response.json.operationId).toBe(id);
 await f.send(route,'POST',{apiVersion:1,operationId:id},headers);expect(start).toHaveBeenCalledTimes(1);
});
it('keeps bootstrap and unrelated reads responsive while a lifecycle ACK hangs; close is bounded',async()=>{
 let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 let release!:()=>void;const wait=new Promise<never>((_resolve,reject)=>{release=()=>reject(Error('late ACK'));});
 const start=vi.fn(async()=>{entered();return wait;});
 f=await fixture({startSession:start});const {headers}=await f.login();const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},headers)).json.projectId;
 const pending=f.send(`/api/v1/projects/${p}/session/start`,'POST',{apiVersion:1,operationId:crypto.randomUUID()},headers).catch(()=>undefined);await started;
 try {const responsive=await Promise.race([f.send('/api/v1/projects','GET',undefined,headers),new Promise<undefined>(r=>setTimeout(()=>r(undefined),250))]);
 expect(responsive?.status).toBe(200);
 const login=await Promise.race([f.login(),new Promise<undefined>(r=>setTimeout(()=>r(undefined),250))]);expect(login).toBeDefined();
 const close=await Promise.race([f.server.close().then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),7000))]);expect(close).toBe(true);await pending;} finally {release();await pending;}
});
it('does not accept a plausible same-ID receipt from a replacement host session',async()=>{
 let sessionId='original';const readOperation=vi.fn(async(projectId:string,operationId:string)=>({ok:true as const,value:{apiVersion:1 as const,projectId,operationId,owner:'host_interaction' as const,operationKind:'cancel' as const,state:'applied' as const,result:{kind:'interaction' as const,runId:'wrong-run',currentRunId:'wrong-run'},updatedAt:new Date().toISOString()}}));
 f=await fixture({},async(projectId)=>({...client,execute:async()=>{throw Error('lost ACK');},readOperation,readProjectSession:async()=>({ok:true,value:{apiVersion:1,projectId,sessionId,state:'ready',pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()}})}));
 const {headers}=await f.login();const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},headers)).json.projectId;const id=crypto.randomUUID();const route=`/api/v1/projects/${p}`;
 await f.send(route+'/commands','POST',{apiVersion:1,commandId:id,projectId:p,kind:'cancel',runId:'original-run',expectedVersion:{revisionToken:'v'},reason:'cancel'},headers);
 await f.restart();sessionId='replacement';const login=await f.login();const r=await f.send(route+'/operations/'+id,'GET',undefined,login.headers);expect(r.json.state).toBe('reconciliation_required');expect(readOperation).not.toHaveBeenCalled();
});
it('revalidates session expiry after a mutation waits in the operation queue',async()=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 f=await fixture({startSession:async(projectId)=>{entered();await wait;return {ok:true,value:{apiVersion:1,projectId,state:'ready',pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()}};}});
 const {headers}=await f.login();const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},headers)).json.projectId;const id=crypto.randomUUID(),route=`/api/v1/projects/${p}/session/start`,body={apiVersion:1,operationId:id};
 const first=f.send(route,'POST',body,headers);await started;const second=f.send(route,'POST',body,headers);await new Promise(r=>setTimeout(r,40));const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+43200001);
 try{release();await first;expect((await second).status).toBe(401);}finally{vi.restoreAllMocks();release();}
});
