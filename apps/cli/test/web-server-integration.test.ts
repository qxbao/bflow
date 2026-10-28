import { afterEach,expect,it,vi } from 'vitest';
import { mkdtemp,rm,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { startWebCommand,type WebCommandHandle } from '../src/web-command.js';
import { initializeEnvironmentConfig } from '../src/environment-config.js';
const roots:string[]=[],servers:WebCommandHandle[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>s.close()));await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup(options:object={}){
 const root=await mkdtemp(join(tmpdir(),'web-default-'));roots.push(root);const repo=join(root,'repo with spaces');execFileSync('git',['init','--quiet',repo]);
 const output:string[]=[];const server=await startWebCommand({port:0,open:false},{stateDirectory:join(root,'web'),isTerminal:true,io:{stdout:s=>output.push(s),stderr:s=>output.push(s)},...options});servers.push(server);
 const send=(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>fetch(server.origin+path,{method,headers:{Origin:server.origin,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const secret=new URLSearchParams(new URL(output[0]!).hash.slice(1)).get('bootstrap');const response=await send('/api/v1/session/bootstrap','POST',{apiVersion:1,secret});expect(response.status).toBe(200);
 const session=await response.json();const headers={Cookie:response.headers.get('set-cookie')!.split(';')[0]!,'x-bflow-csrf':session.csrfToken};const registered=await send('/api/v1/projects','POST',{apiVersion:1,path:repo},headers);expect(registered.status).toBe(201);const project=await registered.json();
 return {repo,server,send,headers,project,output};
}
it('default binary composition resolves browser registration, reads missing host safely and refuses missing config without init/setup',async()=>{
 const f=await setup();const before=await readdir(f.repo);const session=await f.send(`/api/v1/projects/${f.project.projectId}/session`,'GET',undefined,f.headers);
 expect(session.status).toBe(200);expect(await session.json()).toMatchObject({projectId:f.project.projectId,state:'unavailable'});
 const operation=await f.send(`/api/v1/projects/${f.project.projectId}/session/start`,'POST',{apiVersion:1,operationId:crypto.randomUUID()},f.headers);
 expect(operation.status).toBe(202);expect(await operation.json()).toMatchObject({state:'failed'});expect(await readdir(f.repo)).toEqual(before);
 expect(f.output.join('')).not.toContain('còn chờ integration');
});
it('HTTP timeout is recovered from correlated CLI receipt without repeating lifecycle, and web close never stops the project',async()=>{
 let release!:()=>void;const wait=new Promise<void>(r=>release=r);const up=vi.fn(async()=>{await wait;return {};}),down=vi.fn();
 const f=await setup({createLifecycle:()=>({up,down,doctor:vi.fn()}),readSession:async(project:any,sessionId:string)=>({ok:true,value:{apiVersion:1,projectId:project.projectId,sessionId,state:'ready',pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()}})});
 await initializeEnvironmentConfig({cwd:f.repo});const id=crypto.randomUUID(),path=`/api/v1/projects/${f.project.projectId}`;
 try{
  const response=await f.send(path+'/session/start','POST',{apiVersion:1,operationId:id},f.headers);expect(response.status).toBe(202);expect(await response.json()).toMatchObject({state:'reconciliation_required'});expect(up).toHaveBeenCalledOnce();
  release();let observed:any;for(let i=0;i<40;i++){observed=await (await f.send(path+'/operations/'+id,'GET',undefined,f.headers)).json();if(observed.state==='applied')break;await new Promise(r=>setTimeout(r,25));}
  expect(observed).toMatchObject({state:'applied',result:{kind:'lifecycle',session:{state:'ready'}}});
  const replay=await f.send(path+'/session/start','POST',{apiVersion:1,operationId:id},f.headers);expect(await replay.json()).toEqual(observed);expect(up).toHaveBeenCalledOnce();
  await f.server.close();expect(down).not.toHaveBeenCalled();
 }finally{release();}
},15000);
