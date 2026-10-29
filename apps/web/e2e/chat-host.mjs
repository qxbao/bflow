// Test-only deterministic UserInteractionClient. Evaluated via Node stdin in the
// CLI package's dependency scope; no sibling source/dist module path imports.
import { createLocalWebServer } from '@bflow/local-server';
import { WebCommandSchema, WebRunViewSchema, WebDecisionSchema } from '@bflow/contracts/web';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
const scratch=await mkdtemp(join(tmpdir(),'bflow-w07-')),repository=join(scratch,'books');await mkdir(repository);execFileSync('git',['init','-q',repository]);
const chat=spawn(process.execPath,[resolve('../../packages/runtime/test/interaction/chat-browser-host.mjs')],{env:{...process.env,W08_CHAT_DIRECTORY:join(scratch,'chat')},stdio:['ignore','ignore','inherit','ipc']});
let chatSequence=0;const chatPending=new Map();
chat.on('message',raw=>{const p=chatPending.get(raw.id);if(p){chatPending.delete(raw.id);raw.error?p.reject(new Error(raw.error)):p.resolve(raw.value);}});
const chatCall=(kind,body={})=>new Promise((resolve,reject)=>{const id=++chatSequence;chatPending.set(id,{resolve,reject});chat.send({id,kind,...body});});
const now=()=>new Date().toISOString(),ok=value=>({ok:true,value});
const unavailable=async()=>({ok:false,error:{code:'transport_unavailable',retryable:true,message:'Fixture capability unavailable'}});
let projectId,phase='clarifying',revision=1,delay=0,ready=true,currentRunId='run',cancelled=false,intakeAnswered=false;
let sequence=0;
const operations=new Map(),commands=[],effects=[],lifecycleCalls=[];
const decision=()=>WebDecisionSchema.parse({decisionId:'design',runId:'run',kind:'approval',status:phase==='reviewing'?'pending':'approved',question:'Duyệt thiết kế tìm kiếm',options:[],expectedVersion:{revisionToken:`v${revision}`,approvalId:'design',target:{type:'specification',specId:'spec'},revision,generation:0,evidenceDigest:'a'.repeat(64)},evidence:[]});
const question=()=>({questionId:'scope',question:'Cần tìm theo trường nào?',options:['Tên sách','Tên và tác giả'],expectedVersion:{revisionToken:`v${revision}`}});
const run=()=>WebRunViewSchema.parse({apiVersion:1,runId:'run',sessionId:'fixture-host',revisionToken:`v${revision}`,title:'Tìm sách nhanh',originRunId:'run',currentRunId,...(currentRunId!=='run'?{continuedAsRunId:currentRunId}:{}),sdlcStatus:cancelled?'cancelled':phase==='blocked'?'implementing':phase==='reviewing'?'awaiting_approval':'clarifying',coreStatus:cancelled?'cancelled':'running',transportSummary:{states:['done'],observedAt:now()},tasks:[],blockers:phase==='blocked'?[{code:'manual_remediation',message:'Cần tiếp tục sau xử lý'}]:[],decisions:phase==='reviewing'?[decision()]:[],clarifications:phase==='clarifying'?[question()]:[],availableActions:[{kind:'answer_decision',actionId:'decide',enabled:phase==='reviewing',...(phase!=='reviewing'?{disabledReason:'no_pending_decision'}:{}),expectedVersion:decision().expectedVersion},{kind:'resume',actionId:'resume-exact',enabled:phase==='blocked',...(phase!=='blocked'?{disabledReason:'not_resumable'}:{}),expectedVersion:{revisionToken:`v${revision}`}},{kind:'cancel',actionId:'cancel',enabled:!cancelled,...(cancelled?{disabledReason:'terminal_run'}:{}),expectedVersion:{revisionToken:`v${revision}`}},{kind:'revise_request',actionId:'revise',enabled:true,expectedVersion:{revisionToken:`v${revision}`}}],updatedAt:now()});
const session=id=>({apiVersion:1,projectId:id,sessionId:'fixture-host',state:ready?'ready':'stopped',pendingIntakes:effects.includes('create_request')?[{intakeId:'intake',sessionId:'fixture-host',correlationId:'correlation',title:'Tìm sách nhanh',status:'clarifying',clarifications:phase==='clarifying' && !intakeAnswered?[question()]:[],updatedAt:now()}]:[],blockers:[],updatedAt:now()});
const client={
 readProjectSession:async id=>{projectId=id;return ok(session(id));},listRuns:async()=>ok({apiVersion:1,items:effects.includes('create_request')?[run()]:[]}),readRun:async(_id,runId)=>ok(runId==='follow-up' && currentRunId==='follow-up'?{...run(),runId:'follow-up',currentRunId:'follow-up',parentRunId:'run',continuedAsRunId:undefined,decisions:[],clarifications:[],availableActions:[]}:run()),listDecisions:async()=>ok({apiVersion:1,items:phase==='reviewing'?[decision()]:[]}),
 execute:async raw=>{
  const command=WebCommandSchema.parse(raw);commands.push(command);
  if(operations.has(command.commandId))return ok(operations.get(command.commandId));
  if(command.expectedVersion && command.expectedVersion.revisionToken!==`v${revision}`)return {ok:false,error:{code:'conflict',retryable:false,message:'Stale fixture version'}};
  if(command.kind==='answer_decision' && command.selectedOption!==undefined)return {ok:false,error:{code:'validation',retryable:false,message:'Approval must not contain selectedOption'}};
  effects.push(command.kind);sequence++;
  if(command.kind==='answer_clarification'){if(command.intakeId)intakeAnswered=true;else phase='reviewing';}
  if(command.kind==='answer_decision'){if(command.outcome==='changes_requested')currentRunId='follow-up';phase='blocked';}
  if(command.kind==='resume')phase='implementing';
  const operation={apiVersion:1,operationId:command.commandId,projectId:command.projectId,owner:'host_interaction',operationKind:command.kind,state:command.kind==='cancel'?'accepted':'applied',...(command.kind==='cancel'?{}:{result:command.kind==='create_request'?{kind:'intake',intakeId:'intake'}:{kind:'interaction',runId:'run',currentRunId,...(currentRunId!=='run'?{continuedAsRunId:currentRunId}:{})}}),updatedAt:now()};
  operations.set(command.commandId,operation);
  if(delay){const duration=delay;delay=0;await new Promise(r=>setTimeout(r,duration));}
  return ok(operation);
 },readOperation:async(_id,id)=>operations.has(id)?ok(operations.get(id)):unavailable(),
 async *events(id,signal){let seen=-1;while(!signal?.aborted){if(seen!==sequence){seen=sequence;yield {apiVersion:1,cursor:`fixture:${sequence}`,projectId:id,type:'invalidate',resourceIds:[],occurredAt:now()};}await new Promise(r=>setTimeout(r,100));}},
 acknowledgeNotice:unavailable,listMessages:async(_id,sessionId,cursor)=>sessionId==='fixture-host'?ok(await chatCall('list',{cursor})):unavailable(),sendMessage:async input=>ok(await chatCall('send',{input})),readArtifact:unavailable
};
const workspace={inspectProject:async id=>ok({apiVersion:1,projectId:id,ready,checks:[],observedAt:now()}),preview:async id=>ok({apiVersion:1,projectId:id,available:true,summary:'Fixture',blockers:[],observedAt:now()}),startSession:async id=>{lifecycleCalls.push('start');ready=true;sequence++;return ok(session(id));},stopSession:async id=>{lifecycleCalls.push('stop');ready=false;sequence++;return ok(session(id));},reconcileSessionOperation:async op=>ok({...op,state:'applied',result:{kind:'lifecycle',session:session(op.projectId)}})};
const options={host:'127.0.0.1',port:0,stateDirectory:join(scratch,'state'),assetsDirectory:process.env.W07_ASSETS,workspace,interaction:async()=>client};let server=await createLocalWebServer(options);
process.on('message',async message=>{
 try{
  if(message.kind==='chat-inspect')process.send({requestId:message.requestId,value:await chatCall('inspect')});
  else if(message.kind==='chat-restart'||message.kind==='chat-echo'||message.kind==='chat-busy')process.send({requestId:message.requestId,value:await chatCall(message.kind.slice(5),{busy:message.busy})});
  else if(message.kind==='inspect')process.send({requestId:message.requestId,value:{commands,effects,operationCount:operations.size,phase,cancelled,ready,currentRunId,lifecycleCalls,operations:[...operations.values()]}});
  else if(message.kind==='configure'){sequence++;if(message.phase)phase=message.phase;if(message.revision)revision=message.revision;if(message.delay)delay=message.delay;if(message.cancelled!==undefined){cancelled=message.cancelled;for(const [id,op] of operations)if(op.operationKind==='cancel')operations.set(id,{...op,state:'applied',result:{kind:'interaction',runId:'run',currentRunId},updatedAt:now()});}process.send({requestId:message.requestId,value:true});}
  else if(message.kind==='restart'){const port=Number(new URL(server.origin).port);await server.close();server=await createLocalWebServer({...options,port});process.send({requestId:message.requestId,value:server.origin+'/#bootstrap='+await server.issueBootstrap()});}
  else if(message.kind==='close'){chat.kill();await server.close();await rm(scratch,{recursive:true,force:true});process.exit(0);}
 }catch(error){process.send({requestId:message.requestId,error:String(error)});}
});
process.send({ready:true,pairing:server.origin+'/#bootstrap='+await server.issueBootstrap(),repository});
