import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { fixture, client } from './helpers.js';
import { streamEvents, upstreamCursor } from '../src/sse.js';
import type { WebEvent } from '@bflow/contracts/web';
const event=(projectId:string,cursor='host:1',type:WebEvent['type']='reset'):WebEvent=>({apiVersion:1,projectId,cursor,type,resourceIds:[],occurredAt:new Date().toISOString()});
it('scopes server cursors and rejects malformed input while resetting another server epoch',()=>{
 expect(upstreamCursor('server','server_host:12')).toBe('host:12');
 expect(upstreamCursor('server','old_host:12')).toBeUndefined();
 expect(()=>upstreamCursor('server','bad')).toThrow();
});
it('authenticates actual SSE HTTP, preserves cursor replay and cleans up browser disconnect and server close',async()=>{
 let returned=0;const cursors:(string|undefined)[]=[];
 const f=await fixture({},async()=>({...client,events(projectId,cursor){cursors.push(cursor);return { [Symbol.asyncIterator](){let sent=false;return {async next(){if(!sent){sent=true;return {done:false as const,value:event(projectId,cursor??'host:1',cursor?'invalidate':'reset')};}return new Promise<IteratorResult<WebEvent>>(()=>{});},async return(){returned++;return {done:true as const,value:undefined};}};}};}}));
 const auth=await f.login();const project=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},auth.headers)).json;
 const path=`/api/v1/projects/${project.projectId}/events`;
 const first=async(headers:Record<string,string>={})=>new Promise<{text:string;headers:import('node:http').IncomingHttpHeaders}>((resolve,reject)=>{
 const req=request(f.server.origin+path,{headers:{...auth.headers,...headers}},res=>{let text='';res.on('data',chunk=>{text+=chunk;if(text.includes('data:')){resolve({text,headers:res.headers});res.destroy();}});});req.on('error',reject);req.end();});
 try{
 expect((await f.send(path)).status).toBe(401);
 const a=await first();expect(a.headers['content-type']).toBe('text/event-stream; charset=utf-8');expect(a.headers['cache-control']).toBe('no-store');
 const cursor=/id: ([^\n]+)/.exec(a.text)![1]!;expect(JSON.parse(/data: ([^\n]+)/.exec(a.text)![1]!)).toMatchObject({type:'reset',cursor});
 await expect.poll(()=>returned).toBe(1);
 await first({'Last-Event-ID':cursor});expect(cursors.at(-1)).toBe('host:1');await expect.poll(()=>returned).toBe(2);
 expect((await f.send(path+'?cursor=malformed','GET',undefined,auth.headers)).status).toBe(400);
 expect((await f.send(path,'GET',undefined,{...auth.headers,'Last-Event-ID':'bad'})).status).toBe(400);
 await f.restart();const login=await f.login();Object.assign(auth.headers,login.headers);
 await first({'Last-Event-ID':cursor});expect(cursors.at(-1)).toBeUndefined();
 }finally{await f.close();}
});
it('bounds slow-client queues to 100 and releases iterator/listeners without waiting for network delivery',async()=>{
 const res=Object.assign(new EventEmitter(),{destroyed:false,headersSent:false,writableLength:1,setHeader(){},flushHeaders(){this.headersSent=true;},write(){return false;},destroy(){this.destroyed=true;this.emit('close');},end(){this.emit('close');},setTimeout(){}});
 const req=Object.assign(new EventEmitter(),{headers:{},socket:{}});let returned=0;
 const events={ [Symbol.asyncIterator](){let i=0;return {async next(){return {done:false as const,value:event('p',`host:${++i}`)};},async return(){returned++;return {done:true as const,value:undefined};}};}};
 const stats=await streamEvents(req as any,res as any,events,'p','server',()=>{},Date.now()+10000);
 expect(res.destroyed).toBe(true);expect(stats.maxQueued).toBeLessThanOrEqual(100);expect(returned).toBe(1);expect(res.listenerCount('drain')).toBe(0);expect(res.listenerCount('close')).toBe(0);
});
it('closes expired browser streams and rejects other-project events without treating them as delivery',async()=>{
 for(const mode of ['expired','foreign']){
  const res=Object.assign(new EventEmitter(),{destroyed:false,headersSent:false,writableLength:0,statusCode:0,setHeader(){},flushHeaders(){this.headersSent=true;},write(){return true;},destroy(){this.destroyed=true;this.emit('close');},end(){this.emit('close');},setTimeout(){}});
  const req=Object.assign(new EventEmitter(),{headers:{}});let returned=0;
  const events={ [Symbol.asyncIterator](){let sent=false;return {async next(){if(!sent){sent=true;return {done:false as const,value:event(mode==='foreign'?'other':'p')};}return new Promise<IteratorResult<WebEvent>>(()=>{});},async return(){returned++;return {done:true as const,value:undefined};}};}};
  if(mode==='foreign')await expect(streamEvents(req as any,res as any,events,'p','server',()=>{},Date.now()+1000)).rejects.toThrow();
  else {await streamEvents(req as any,res as any,events,'p','server',()=>{},Date.now()+25);expect(res.destroyed).toBe(true);}
  expect(returned).toBe(1);expect(res.listenerCount('close')).toBe(0);
 }
});
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
it('bounds retained memory while a healthy long-lived SSE connection delivers 80000 events',()=>{
 const modulePath=fileURLToPath(new URL('../dist/sse.js',import.meta.url));
 const code=`import { EventEmitter } from 'node:events';
 import { streamEvents } from ${JSON.stringify(modulePath)};
 const res=Object.assign(new EventEmitter(),{destroyed:false,headersSent:false,writableLength:0,setHeader(){},flushHeaders(){this.headersSent=true;},write(){return true;},destroy(){this.destroyed=true;this.emit('close');},end(){this.emit('close');},setTimeout(){}});
 const req=new EventEmitter();let ready;const produced=new Promise(r=>ready=r);let i=0;
 const source={ [Symbol.asyncIterator](){return {async next(){if(i===80000){ready();return new Promise(()=>{});}return {done:false,value:{apiVersion:1,projectId:'p',cursor:'host:'+ ++i,type:'invalidate',resourceIds:[],occurredAt:'2026-10-29T00:00:00.000Z'}};},async return(){return {done:true};}};}};
 global.gc();const before=process.memoryUsage().heapUsed;
 const work=streamEvents(req,res,source,'p','server',()=>{},Date.now()+30000);
 await produced;await new Promise(r=>setImmediate(r));global.gc();const growth=process.memoryUsage().heapUsed-before;
 const listeners=res.listenerCount('close');res.destroy();await work;console.log(JSON.stringify({growth,listeners}));`;
 const result=JSON.parse(execFileSync(process.execPath,['--expose-gc','--input-type=module','-e',code],{encoding:'utf8',timeout:25000}));
 expect(result.growth).toBeLessThan(16*1024*1024);expect(result.listeners).toBeLessThanOrEqual(3);
});
