// W09 test-only deterministic UserInteractionClient behind the actual Local Server.
// Evaluated via Node stdin in the CLI package dependency scope (same pattern as W07);
// no sibling source/dist module path imports. Browser integration evidence only: the
// host semantics it models (first decision wins, operation receipts survive restart)
// are owned and tested by Runtime, not proven here.
import { createLocalWebServer } from '@bflow/local-server';
import { WebCommandSchema, WebRunViewSchema, WebDecisionSchema, WebEventSchema } from '@bflow/contracts/web';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const scratch=await mkdtemp(join(tmpdir(),'bflow-w09-')),repository=join(scratch,'thư viện');await mkdir(repository);execFileSync('git',['init','-q',repository]);
const now=()=>new Date().toISOString(),ok=value=>({ok:true,value});
const unavailable=async()=>({ok:false,error:{code:'transport_unavailable',retryable:true,message:'Fixture capability unavailable'}});
const artifacts={
  'artifact-html':{mediaType:'text/html',kind:'document',body:'<html><body><script>alert("html-xss")</script><img src=x onerror="alert(1)"></body></html>'},
  'artifact-svg':{mediaType:'image/svg+xml',kind:'document',body:'<svg xmlns="http://www.w3.org/2000/svg"><script>alert("svg-xss")</script></svg>'},
  'artifact-md':{mediaType:'text/markdown',kind:'document',body:'# Thiết kế\n\n<script>alert("md-xss")</script>\n[x](javascript:alert(1))\n'}
};
const checksum=body=>({algorithm:'sha256',value:createHash('sha256').update(body).digest('hex')});
const evidence=()=>Object.entries(artifacts).map(([artifactId,a])=>({artifactId,runId:'run',kind:a.kind,mediaType:a.mediaType,checksum:checksum(a.body),sizeBytes:Buffer.byteLength(a.body)}));
let revision=1,status='pending',hold=0,streamGeneration=0,eventStreams=0,cancelled=false,readRuns=0,sequence=0,ringStart=0,decisionOutcome;
const operations=new Map(),commands=[],effects=[],lifecycleCalls=[],artifactReads=[];
const version=()=>({revisionToken:`v${revision}`,approvalId:'design',target:{type:'specification',specId:'spec'},revision,generation:0,evidenceDigest:'b'.repeat(64)});
const decision=()=>WebDecisionSchema.parse({decisionId:'design',runId:'run',kind:'approval',status,question:'Duyệt gói thiết kế tìm kiếm',options:[],expectedVersion:version(),evidence:evidence()});
const run=()=>{readRuns++;return WebRunViewSchema.parse({apiVersion:1,runId:'run',sessionId:'fixture-host',revisionToken:`v${revision}`,title:'Tìm sách nhanh',originRunId:'run',currentRunId:'run',
  sdlcStatus:cancelled?'cancelled':status==='pending'?'awaiting_approval':'implementing',coreStatus:cancelled?'cancelled':'running',transportSummary:{states:['working'],observedAt:now()},
  tasks:[{taskId:'task-1',title:'Thêm ô tìm kiếm',status:'running'}],blockers:[],decisions:status==='pending'?[decision()]:[],clarifications:[],
  availableActions:[{kind:'answer_decision',actionId:'decide',enabled:status==='pending',...(status!=='pending'?{disabledReason:'no_pending_decision'}:{}),expectedVersion:version()},
    {kind:'resume',actionId:'resume',enabled:false,disabledReason:'not_resumable',expectedVersion:{revisionToken:`v${revision}`}},
    {kind:'cancel',actionId:'cancel',enabled:!cancelled,...(cancelled?{disabledReason:'terminal_run'}:{}),expectedVersion:{revisionToken:`v${revision}`}}],updatedAt:now()});};
const session=id=>({apiVersion:1,projectId:id,sessionId:'fixture-host',state:'ready',pendingIntakes:[],blockers:[],updatedAt:now()});
const client={
 readProjectSession:async id=>ok(session(id)),listRuns:async()=>ok({apiVersion:1,items:[run()]}),readRun:async()=>ok(run()),listDecisions:async()=>ok({apiVersion:1,items:status==='pending'?[decision()]:[]}),
 execute:async raw=>{
  const command=WebCommandSchema.parse(raw);commands.push(command);
  if(operations.has(command.commandId))return ok(operations.get(command.commandId));
  // Serialized authority model: the first committed decision bumps the version; a later
  // conflicting decision on the old version is refused, never applied twice.
  if(command.expectedVersion && command.expectedVersion.revisionToken!==`v${revision}`){
    const failed={apiVersion:1,operationId:command.commandId,projectId:command.projectId,owner:'host_interaction',operationKind:command.kind,state:'failed',
      error:{apiVersion:1,code:'stale_version',message:'Phiên bản đã thay đổi.',retryable:false,operationId:command.commandId,correlationId:'fixture'},updatedAt:now()};
    operations.set(command.commandId,failed);return ok(failed);
  }
  effects.push(command.kind);sequence++;
  if(command.kind==='answer_decision'){status=command.outcome==='approved'?'approved':command.outcome;decisionOutcome=command.outcome;revision++;}
  if(command.kind==='cancel'){cancelled=true;revision++;}
  const operation={apiVersion:1,operationId:command.commandId,projectId:command.projectId,owner:'host_interaction',operationKind:command.kind,state:'applied',
    result:{kind:'interaction',runId:'run',currentRunId:'run'},updatedAt:now()};
  operations.set(command.commandId,operation);
  if(hold){const duration=hold;hold=0;await new Promise(r=>setTimeout(r,duration));}
  return ok(operation);
 },
 readOperation:async(_id,id)=>operations.has(id)?ok(operations.get(id)):unavailable(),
 // Ring buffer model: a cursor older than ringStart cannot be replayed and receives `reset`.
 async *events(id,cursor,signal){
  const generation=streamGeneration;eventStreams++;
  let seen=cursor===undefined?-1:Number(cursor.split(':')[1]);
  if(cursor!==undefined && seen<ringStart){yield WebEventSchema.parse({apiVersion:1,cursor:`fixture:${sequence}`,projectId:id,type:'reset',resourceIds:[],occurredAt:now()});seen=sequence;}
  while(!signal?.aborted && generation===streamGeneration){if(seen!==sequence){seen=sequence;yield WebEventSchema.parse({apiVersion:1,cursor:`fixture:${sequence}`,projectId:id,type:'invalidate',resourceIds:[],occurredAt:now()});}await new Promise(r=>setTimeout(r,100));}
 },
 readArtifact:async(_id,artifactId)=>{
  artifactReads.push(artifactId);const a=artifacts[artifactId];if(!a)return {ok:false,error:{code:'not_found',retryable:false,message:'missing'}};
  const bytes=new TextEncoder().encode(a.body);
  return ok({metadata:{apiVersion:1,artifactId,runId:'run',mediaType:a.mediaType,checksum:checksum(a.body),sizeBytes:bytes.byteLength,
    disposition:a.mediaType==='text/markdown'?'inline':'attachment',previewLimitBytes:1048576},chunks:(async function*(){yield bytes;})()});
 },
 acknowledgeNotice:unavailable,listMessages:unavailable,sendMessage:unavailable
};
const workspace={inspectProject:async id=>ok({apiVersion:1,projectId:id,ready:true,checks:[],observedAt:now()}),preview:async id=>ok({apiVersion:1,projectId:id,available:true,summary:'Fixture',blockers:[],observedAt:now()}),
 startSession:async id=>{lifecycleCalls.push('start');return ok(session(id));},stopSession:async id=>{lifecycleCalls.push('stop');return ok(session(id));},
 reconcileSessionOperation:async op=>ok({...op,state:'applied',result:{kind:'lifecycle',session:session(op.projectId)}})};
const options={host:'127.0.0.1',port:0,stateDirectory:join(scratch,'state'),assetsDirectory:process.env.W09_ASSETS,workspace,interaction:async()=>client};let server=await createLocalWebServer(options);
process.on('message',async message=>{
 try{
  if(message.kind==='inspect')process.send({requestId:message.requestId,value:{commands,effects,operationCount:operations.size,status,decisionOutcome,cancelled,readRuns,lifecycleCalls,artifactReads,sequence,revision,eventStreams}});
  else if(message.kind==='configure'){if(message.hold)hold=message.hold;if(message.bump){revision++;sequence++;}if(message.evict){sequence+=message.evict;ringStart=sequence;}if(message.drop)streamGeneration++;process.send({requestId:message.requestId,value:true});}
  else if(message.kind==='restart'){const port=Number(new URL(server.origin).port);await server.close();server=await createLocalWebServer({...options,port});process.send({requestId:message.requestId,value:server.origin+'/#bootstrap='+await server.issueBootstrap()});}
  else if(message.kind==='pair')process.send({requestId:message.requestId,value:server.origin+'/#bootstrap='+await server.issueBootstrap()});
  else if(message.kind==='close'){await server.close();await rm(scratch,{recursive:true,force:true});process.exit(0);}
 }catch(error){process.send({requestId:message.requestId,error:String(error)});}
});
process.send({ready:true,pairing:server.origin+'/#bootstrap='+await server.issueBootstrap(),repository,origin:server.origin});
