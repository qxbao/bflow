import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, client } from './helpers.js';
it.each(['text/html','image/svg+xml','text/markdown','application/json','text/plain'])('serves %s as inert content and requires exact authenticated scope',async mediaType=>{
 const bytes=Buffer.from('<script>alert(1)</script> [x](javascript:alert(1)) ![remote](https://example.test/track)');let ack=0;
 const f=await fixture({},async()=>({...client,async readArtifact(_p,id){return {ok:true as const,value:{metadata:{apiVersion:1,artifactId:id,runId:'r',mediaType,checksum:{algorithm:'sha256' as const,value:createHash('sha256').update(bytes).digest('hex')},sizeBytes:bytes.length,disposition:'inline' as const,previewLimitBytes:1048576},chunks:(async function*(){yield bytes;})()}};},async acknowledgeNotice(_p,id){ack++;return {ok:true as const,value:{apiVersion:1 as const,noticeId:id,displayedAt:new Date().toISOString()}};}}));
 try{
 const auth=await f.login(),project=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},auth.headers)).json;
 const base=`/api/v1/projects/${project.projectId}`;
 expect((await f.send(base+'/artifacts/a')).status).toBe(401);
 const response=await f.send(base+'/artifacts/a','GET',undefined,auth.headers);expect(response.status).toBe(200);expect(response.body).toBe(bytes.toString());expect(response.headers['x-content-type-options']).toBe('nosniff');expect(response.headers['content-security-policy']).toContain('sandbox');
 if(['text/html','image/svg+xml'].includes(mediaType))expect(response.headers['content-disposition']).toContain('attachment');
 else expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
 for(const path of ['/artifacts/%2e%2e','/artifacts/%252e%252e','/artifacts/a%2fb'])expect((await f.send(base+path,'GET',undefined,auth.headers)).status).toBeGreaterThanOrEqual(400);
 expect(ack).toBe(0);expect((await f.send(base+'/notices/exact/displayed','POST',{apiVersion:1},{Cookie:auth.headers.Cookie})).status).toBe(403);expect(ack).toBe(0);
 const displayed=await f.send(base+'/notices/exact/displayed','POST',{apiVersion:1},auth.headers);expect(displayed.status).toBe(200);expect(displayed.json.noticeId).toBe('exact');expect(ack).toBe(1);
 }finally{await f.close();}
});
it('downloads previews over 1 MiB and rejects foreign metadata and over-quota artifacts before headers',async()=>{
 const bytes=Buffer.alloc(1048577,65);let mode='large',cleaned=0;
 const f=await fixture({},async()=>({...client,async readArtifact(_p,id){return {ok:true as const,value:{metadata:{apiVersion:1 as const,artifactId:mode==='foreign'?'wrong':id,runId:'r',mediaType:'text/plain',checksum:{algorithm:'sha256' as const,value:createHash('sha256').update(bytes).digest('hex')},sizeBytes:mode==='quota'?64*1024*1024+1:bytes.length,disposition:'inline' as const,previewLimitBytes:1048576},chunks:{[Symbol.asyncIterator](){let offset=0;return {async next(){if(offset>=bytes.length)return {done:true as const,value:undefined};const value=bytes.subarray(offset,offset+65536);offset+=value.length;return {done:false as const,value};},async return(){cleaned++;return {done:true as const,value:undefined};}};}}}};}}));
 try{const auth=await f.login(),project=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},auth.headers)).json,path=`/api/v1/projects/${project.projectId}/artifacts/a`;
 const response=await f.send(path,'GET',undefined,auth.headers);expect(response.status).toBe(200);expect(response.headers['content-disposition']).toContain('attachment');expect(response.body.length).toBe(bytes.length);
 mode='foreign';expect((await f.send(path,'GET',undefined,auth.headers)).status).toBe(503);
 mode='quota';expect((await f.send(path,'GET',undefined,auth.headers)).status).toBe(413);expect(cleaned).toBe(3);
 }finally{await f.close();}
});
import { EventEmitter } from 'node:events';
import { artifactResponse } from '../src/artifact-response.js';
it('browser disconnect cannot hold shutdown behind a stalled artifact iterator return',async()=>{
 let returned=0;
 const res=Object.assign(new EventEmitter(),{destroyed:false,headersSent:false,setHeader(){},write(){return true;},end(){},destroy(){this.destroyed=true;this.emit('close');}});
 const req=Object.assign(new EventEmitter(),{});
 const work=artifactResponse(req as any,res as any,{metadata:{apiVersion:1,artifactId:'a',runId:'r',mediaType:'text/plain',checksum:{algorithm:'sha256',value:'a'.repeat(64)},sizeBytes:1,disposition:'inline',previewLimitBytes:1048576},chunks:{[Symbol.asyncIterator](){return {next:()=>new Promise(()=>{}),return(){returned++;return new Promise(()=>{});}};}}},'a',()=>{});
 setTimeout(()=>res.destroy(),10);
 expect(await Promise.race([work.then(()=>'closed'),new Promise(r=>setTimeout(()=>r('stuck'),100))])).toBe('closed');expect(returned).toBeGreaterThan(0);
});
