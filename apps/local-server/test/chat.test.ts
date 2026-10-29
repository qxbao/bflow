import { afterEach, expect, it } from 'vitest';
import { fixture, client } from './helpers.js';
import { WebChatMessageSchema } from '@bflow/contracts/web';
let f:Awaited<ReturnType<typeof fixture>>;afterEach(async()=>{await f?.close();});
const messageId='222e5738-377f-49a3-b3f4-e56f2fb9385d';
it('routes authenticated chat with exact project/session and preserves cursor and message identity',async()=>{
 let sends=0,seen:unknown,query:unknown;
 const message=WebChatMessageSchema.parse({apiVersion:1,messageId,sessionId:'conv',runId:'run',sender:'user',source:'web',content:'Xin chào',createdAt:new Date().toISOString(),delivery:'queued'});
 f=await fixture({},async()=>({...client,listMessages:async(id,session,cursor)=>{query={id,session,cursor};return {ok:true,value:{apiVersion:1,items:[message]}};},sendMessage:async input=>{sends++;seen=input;return {ok:true,value:message};}}));
 const {headers}=await f.login(),projectId=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},headers)).json.projectId;
 const path=`/api/v1/projects/${projectId}/sessions/conv/messages`,body={apiVersion:1,messageId,projectId,sessionId:'conv',runId:'run',content:'Xin chào'};
 expect((await f.send(path+'?cursor=next%3A1','GET',undefined,headers)).status).toBe(200);expect(query).toEqual({id:projectId,session:'conv',cursor:'next:1'});
 expect((await f.send(path,'POST',body,headers)).status).toBe(202);expect(seen).toEqual(body);expect(sends).toBe(1);
 expect((await f.send(path,'POST',{...body,sessionId:'foreign'},headers)).status).toBe(403);
 expect((await f.send(path,'POST',body,{Cookie:headers.Cookie})).status).toBe(403);expect(sends).toBe(1);
 expect((await f.send(path,'GET')).status).toBe(401);
});
it('rejects adapter responses belonging to another session',async()=>{
 f=await fixture({},async()=>({...client,listMessages:async()=>({ok:true,value:{apiVersion:1,items:[WebChatMessageSchema.parse({apiVersion:1,messageId,sessionId:'foreign',sender:'user',source:'web',content:'private',createdAt:new Date().toISOString(),delivery:'delivered'})]}})}));
 const {headers}=await f.login(),p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},headers)).json.projectId;
 const r=await f.send(`/api/v1/projects/${p}/sessions/conv/messages`,'GET',undefined,headers);expect(r.status).toBe(503);expect(r.body).not.toContain('private');
});
