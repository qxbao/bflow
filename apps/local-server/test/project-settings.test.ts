import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
let f:Awaited<ReturnType<typeof fixture>>;afterEach(async()=>{await f?.close();});
it('validates settings ingress, CSRF and project identity before owner calls',async()=>{
 const read=vi.fn(async(id:string)=>({ok:true as const,value:{apiVersion:1 as const,projectId:id,revision:'a'.repeat(64),yaml:'x: 1',values:{x:1}}}));
 const save=vi.fn(async()=>({ok:false as const,error:{code:'validation' as const,retryable:false as const,message:'Invalid environment.roles.0.model'}}));
 const init=vi.fn(async(id:string,input:any)=>({ok:true as const,value:{apiVersion:1 as const,projectId:id,operationId:input.operationId,state:'running' as const,message:'Preparing',updatedAt:new Date().toISOString()}}));
 f=await fixture({readConfiguration:read,saveConfiguration:save,initializeProject:init});const {headers}=await f.login();const path=await f.repo();const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path},headers)).json;
 const base='/api/v1/projects/'+p.projectId;
 expect((await f.send(base+'/configuration','GET',undefined,headers)).json.values).toEqual({x:1});
 const request={apiVersion:1,expectedRevision:'a'.repeat(64),yaml:'bad'};
 expect((await f.send(base+'/configuration','PUT',request,{Cookie:headers.Cookie})).status).toBe(403);expect(save).not.toHaveBeenCalled();
 expect((await f.send(base+'/configuration','PUT',{...request,path:'/tmp/foreign'},headers)).status).toBe(400);expect(save).not.toHaveBeenCalled();
 const result=await f.send(base+'/configuration','PUT',request,headers);expect(result.status).toBe(200);expect(result.json).toMatchObject({ok:false,error:{code:'validation'}});
 const body={apiVersion:1,operationId:randomUUID(),acceptGitNexusLicense:true,update:false};expect((await f.send(base+'/initializations','POST',body,headers)).status).toBe(202);expect(init).toHaveBeenCalledOnce();
 expect((await f.send('/api/v1/projects/foreign/initializations','POST',body,headers)).status).toBe(404);expect(init).toHaveBeenCalledOnce();
});
it('returns unsupported for additive settings methods on older workspace adapters',async()=>{
 f=await fixture();const {headers}=await f.login(),path=await f.repo();const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path},headers)).json;
 expect((await f.send('/api/v1/projects/'+p.projectId+'/configuration','GET',undefined,headers)).status).toBe(422);
});
it('guards unregister on the server during initialization',async()=>{
 f=await fixture({projectMutationStatus:async(projectId)=>({ok:true,value:{apiVersion:1,projectId,initializationPending:true}})});
 const {headers}=await f.login(),path=await f.repo();const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path},headers)).json;
 expect((await f.send('/api/v1/projects/'+p.projectId,'DELETE',{apiVersion:1,confirmed:true},headers)).status).toBe(409);
 expect((await f.send('/api/v1/projects','GET',undefined,headers)).json.items).toHaveLength(1);
});
it('routes only explicitly confirmed recovery stop with force and never replays its ID',async()=>{
 let projectId='';const stop=vi.fn(async()=>({ok:true as const,value:{apiVersion:1 as const,projectId,state:'stopped' as const,pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()}}));
 f=await fixture({stopSession:stop});const {headers}=await f.login(),path=await f.repo();projectId=(await f.send('/api/v1/projects','POST',{apiVersion:1,path},headers)).json.projectId;
 const base='/api/v1/projects/'+projectId,operationId=randomUUID(),request={apiVersion:1,operationId,confirmed:true,force:true};
 expect((await f.send(base+'/session/stop','POST',{apiVersion:1,operationId,force:true},headers)).status).toBe(400);expect(stop).not.toHaveBeenCalled();
 expect((await f.send(base+'/session/stop','POST',request,headers)).status).toBe(202);expect(stop).toHaveBeenCalledWith(projectId,operationId,true);
 expect((await f.send(base+'/session/stop','POST',request,headers)).status).toBe(202);expect(stop).toHaveBeenCalledOnce();
 expect((await f.send(base+'/session/stop','POST',{...request,force:false},headers)).status).toBe(409);
});
