import { afterEach, expect, it } from 'vitest';
import { fixture } from './helpers.js';
import { WebApiErrorSchema } from '@bflow/contracts/web';
let f: Awaited<ReturnType<typeof fixture>>;
afterEach(async()=>{await f?.close();});
it('rejects hostile Host, cross-site/null Origin, forged cookies and unauthorized SSE over real HTTP',async()=>{
 f=await fixture();
 for(const headers of [{Host:'evil.test'}, {Origin:'null'}, {Origin:'https://evil.test'}, {'Sec-Fetch-Site':'cross-site'}]) {
  const r=await f.send('/api/v1/projects','GET',undefined,headers); expect(r.status).toBe(403); expect(WebApiErrorSchema.safeParse(r.json).success).toBe(true); expect(r.headers['access-control-allow-origin']).toBeUndefined();
 }
 for(const path of ['/api/v1/projects','/api/v1/projects/other/events']) expect((await f.send(path,'GET',undefined,{Cookie:'bflow_session=forged'})).status).toBe(401);
});
it('requires exact origin and CSRF for every authenticated mutation and caps bytes',async()=>{
 f=await fixture();const {headers}=await f.login();
 for(const h of [{Cookie:headers.Cookie},{...headers,'X-Bflow-CSRF':'bad'},{...headers,Origin:''}]) expect((await f.send('/api/v1/projects','POST',{apiVersion:1,path:'/tmp'},h)).status).toBe(403);
 const r=await f.send('/api/v1/projects','POST','x'.repeat(262145),headers);expect(r.status).toBe(413);
 expect(r.body).not.toContain('secret');expect(r.headers['cache-control']).toBe('no-store');
});
it('returns JSON 413 for oversized chunked bodies, and denies cross-origin bootstrap without consuming secret',async()=>{
 f=await fixture();const {headers}=await f.login();const secret=await f.server.issueBootstrap();
 expect((await f.send('/api/v1/session/bootstrap','POST',{apiVersion:1,secret},{Origin:'https://evil.test'})).status).toBe(403);
 expect((await f.send('/api/v1/session/bootstrap','POST',{apiVersion:1,secret})).status).toBe(200);
 const {request}=await import('node:http');
 const result=await new Promise<{status:number;text:string}>((resolve,reject)=>{
  const req=request(f.server.origin+'/api/v1/projects',{method:'POST',headers:{...headers,Origin:f.server.origin,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode!,text}));});
  req.on('error',reject);req.write('x'.repeat(131072));req.write('x'.repeat(131073));req.end();
 });expect(result.status).toBe(413);expect(WebApiErrorSchema.safeParse(JSON.parse(result.text)).success).toBe(true);
});
