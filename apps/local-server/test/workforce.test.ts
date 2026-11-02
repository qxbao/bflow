import { afterEach, expect, it } from 'vitest';
import { fixture, client } from './helpers.js';
import { WebWorkforceViewSchema, WebWorkforceExcerptsSchema, WebAgentTranscriptSchema } from '@bflow/contracts/web';
let f:Awaited<ReturnType<typeof fixture>>;afterEach(async()=>{await f?.close();});
const now=new Date().toISOString();
const view=(projectId:string,extra:object={})=>WebWorkforceViewSchema.parse({apiVersion:1,projectId,sessionId:'conv',revisionToken:'rev-1',agents:[],handoffs:[],truncated:false,observedAt:now,...extra});
const entry={entryId:'222e5738-377f-49a3-b3f4-e56f2fb9385d',occurredAt:now,kind:'handoff',role:'coordinator',action:'delegated',runId:'run-1'};
const excerpts=(projectId:string,extra:object={})=>WebWorkforceExcerptsSchema.parse({apiVersion:1,projectId,sessionId:'conv',items:[{instanceId:'agent-1',text:'done',observedAt:now}],observedAt:now,...extra});
const transcript=(projectId:string,instanceId:string,extra:object={})=>WebAgentTranscriptSchema.parse({apiVersion:1,projectId,sessionId:'conv',instanceId,source:'terminal_snapshot',text:'hello',truncated:false,observedAt:now,...extra});
async function setup(over:object){
  f=await fixture({},async()=>({...client,...over}));
  const {headers}=await f.login();
  const projectId=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},headers)).json.projectId as string;
  return {headers,projectId,workforce:`/api/v1/projects/${projectId}/workforce`,excerpts:`/api/v1/projects/${projectId}/workforce/excerpts`,transcript:`/api/v1/projects/${projectId}/agents/agent-1/transcript`,activity:`/api/v1/projects/${projectId}/runs/run-1/activity`};
}
it('requires cookie session',async()=>{
  const s=await setup({readWorkforce:async(id:string)=>({ok:true,value:view(id)}),readRunActivity:async()=>({ok:true,value:{apiVersion:1,items:[entry]}})});
  expect((await f.send(s.workforce)).status).toBe(401);
  expect((await f.send(s.activity)).status).toBe(401);
  expect((await f.send(s.workforce,'GET',undefined,s.headers)).status).toBe(200);
  expect((await f.send(s.activity,'GET',undefined,s.headers)).status).toBe(200);
});
it('rejects foreign origin',async()=>{
  const s=await setup({readWorkforce:async(id:string)=>({ok:true,value:view(id)}),readRunActivity:async()=>({ok:true,value:{apiVersion:1,items:[entry]}})});
  for(const p of [s.workforce,s.activity])expect((await f.send(p,'GET',undefined,{...s.headers,Origin:'http://evil.example'})).status).toBe(403);
});
it('missing workforce port answers operation_not_allowed',async()=>{
  const s=await setup({});
  for(const p of [s.workforce,s.activity]){const r=await f.send(p,'GET',undefined,s.headers);expect(r.status).toBe(422);expect(r.json.code).toBe('operation_not_allowed');}
});
it('serves workforce and activity with exact ids and cursor',async()=>{
  let seen:unknown;
  const s=await setup({readWorkforce:async(id:string)=>({ok:true,value:view(id)}),readRunActivity:async(id:string,run:string,cursor?:string)=>{seen={id,run,cursor};return {ok:true,value:{apiVersion:1,items:[entry],nextCursor:'n:2'}};}});
  const w=await f.send(s.workforce,'GET',undefined,s.headers);expect(w.status).toBe(200);expect(w.json.projectId).toBe(s.projectId);
  const a=await f.send(s.activity+'?cursor=c%3A1','GET',undefined,s.headers);expect(a.status).toBe(200);expect(a.json.nextCursor).toBe('n:2');
  expect(seen).toEqual({id:s.projectId,run:'run-1',cursor:'c:1'});
  expect((await f.send(s.workforce+'?x=1','GET',undefined,s.headers)).status).toBe(400);
});
it('response project mismatch maps to unavailable',async()=>{
  const s=await setup({readWorkforce:async()=>({ok:true,value:view('other-project')})});
  const r=await f.send(s.workforce,'GET',undefined,s.headers);expect(r.status).toBe(503);expect(r.json.code).toBe('unavailable');
});
it('invalid upstream payload maps to unavailable',async()=>{
  const s=await setup({readWorkforce:async()=>({ok:true,value:{apiVersion:1,paneId:'p1'}}),readRunActivity:async()=>({ok:true,value:{apiVersion:1,items:[{...entry,cwd:'/secret'}]}})});
  for(const p of [s.workforce,s.activity]){const r=await f.send(p,'GET',undefined,s.headers);expect(r.status).toBe(503);expect(r.body).not.toContain('secret');}
});

const textPorts={readWorkforceExcerpts:async(id:string)=>({ok:true,value:excerpts(id)}),readAgentTranscript:async(id:string,agent:string)=>({ok:true,value:transcript(id,agent)})};
it('text routes require a cookie session and reject a foreign origin',async()=>{
  const s=await setup(textPorts);
  for(const p of [s.excerpts,s.transcript]){
    expect((await f.send(p)).status).toBe(401);
    expect((await f.send(p,'GET',undefined,{...s.headers,Origin:'http://evil.example'})).status).toBe(403);
    expect((await f.send(p,'GET',undefined,s.headers)).status).toBe(200);
  }
});
it('missing text ports answer operation_not_allowed',async()=>{
  const s=await setup({});
  for(const p of [s.excerpts,s.transcript]){const r=await f.send(p,'GET',undefined,s.headers);expect(r.status).toBe(422);expect(r.json.code).toBe('operation_not_allowed');}
});
it('text routes pass exact ids and reject queries',async()=>{
  let seen:unknown;
  const s=await setup({...textPorts,readAgentTranscript:async(id:string,agent:string)=>{seen={id,agent};return {ok:true,value:transcript(id,agent)};}});
  const t=await f.send(s.transcript,'GET',undefined,s.headers);expect(t.status).toBe(200);expect(t.json.text).toBe('hello');
  expect(seen).toEqual({id:s.projectId,agent:'agent-1'});
  const e=await f.send(s.excerpts,'GET',undefined,s.headers);expect(e.status).toBe(200);expect(e.json.items[0].instanceId).toBe('agent-1');
  for(const p of [s.excerpts,s.transcript])expect((await f.send(p+'?x=1','GET',undefined,s.headers)).status).toBe(400);
});
it('text route id mismatches map to unavailable',async()=>{
  const s=await setup({readWorkforceExcerpts:async()=>({ok:true,value:excerpts('other-project')}),readAgentTranscript:async(id:string)=>({ok:true,value:transcript(id,'agent-2')})});
  for(const p of [s.excerpts,s.transcript]){const r=await f.send(p,'GET',undefined,s.headers);expect(r.status).toBe(503);expect(r.json.code).toBe('unavailable');}
  const t=await setup({readAgentTranscript:async()=>({ok:true,value:transcript('other-project','agent-1')})});
  expect((await f.send(t.transcript,'GET',undefined,t.headers)).status).toBe(503);
});
it('upstream extra fields on text routes are rejected without a leak',async()=>{
  const s=await setup({readWorkforceExcerpts:async(id:string)=>({ok:true,value:{...excerpts(id),paneId:'pane-secret'}}),
    readAgentTranscript:async(id:string,agent:string)=>({ok:true,value:{...transcript(id,agent),paneId:'pane-secret'}})});
  for(const p of [s.excerpts,s.transcript]){const r=await f.send(p,'GET',undefined,s.headers);expect(r.status).toBe(503);expect(r.body).not.toContain('secret');}
});
it('not_found from the transcript port maps to not_found',async()=>{
  const s=await setup({readAgentTranscript:async()=>({ok:false,error:{code:'not_found',retryable:false,message:'Agent not found in this session.'}})});
  expect((await f.send(s.transcript,'GET',undefined,s.headers)).status).toBe(404);
});
