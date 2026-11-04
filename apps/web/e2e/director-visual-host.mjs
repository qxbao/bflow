// Test-only deterministic Director backend for local UI evidence (Task 9). The actual Local Server serves the built Web and
// routes the six Director endpoints to this scripted port; nothing here is a provider, Herdr or the Runtime host.
// Evaluated via Node stdin in the CLI package's dependency scope; no sibling source/dist module path imports.
import { createLocalWebServer } from '@bflow/local-server';
import { WebCommandSchema, WebRunViewSchema } from '@bflow/contracts/web';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const scratch=await mkdtemp(join(tmpdir(),'bflow-t9-')),repository=join(scratch,'guides');await mkdir(repository);execFileSync('git',['init','-q',repository]);
const now=()=>new Date().toISOString(),ok=value=>({ok:true,value});
const unavailable=async()=>({ok:false,error:{code:'transport_unavailable',retryable:true,message:'Fixture capability unavailable'}});
const RUN='run-guides',SESSION='conv-1';
let presence='absent',terminal=true,sequence=0,launches=0;
const messages=[],commands=[];
const issueAt='2026-11-04T08:00:00.000Z';
const issues=[
 {schemaVersion:1,issueId:`park:${RUN}:implement:1`,runId:RUN,taskKey:'implement',kind:'transport_failure',status:'open',summary:'Developer không phản hồi sau 3 lần nhắc; công việc implement đã tạm dừng',attempts:3,evidence:[],suggestedAction:'Kiểm tra pane Developer rồi bấm Thử lại',createdAt:issueAt,updatedAt:issueAt},
 {schemaVersion:1,issueId:`park:${RUN}:docs:1`,runId:RUN,taskKey:'docs',kind:'verification_exhausted',status:'retrying',summary:'Kiểm tra tài liệu thất bại 3 vòng; đang thử lại',attempts:3,evidence:[],createdAt:issueAt,updatedAt:'2026-11-04T08:05:00.000Z'}
];
const snapshot=()=>({schemaVersion:1,generatedAt:now(),director:{presence,...(presence!=='absent'?{provider:'claude',heartbeatAt:now()}:{})},
 runs:[{runId:RUN,title:'Cập nhật hướng dẫn cài đặt',sdlcStatus:'implementing',tasks:[
  {taskKey:'implement',title:'Viết hướng dẫn cài đặt',status:'parked',role:'developer'},
  {taskKey:'docs',title:'Rà soát tài liệu',status:'running',role:'reviewer',startedAt:issueAt},
  {taskKey:'independent',title:'Cập nhật mục lục',status:'succeeded',role:'developer'}]}],
 pendingApprovals:1,pendingQuestions:0,issues:issues.filter(i=>i.status==='open'||i.status==='retrying')});
const page=cursor=>{let items,nextCursor;
 if(!cursor){items=messages.slice(-100);nextCursor=`a${items.at(-1)?.seq??0}`;}
 else if(cursor.startsWith('a')){const after=Number(cursor.slice(1));items=messages.filter(m=>m.seq>after).slice(0,100);nextCursor=`a${items.at(-1)?.seq??after}`;}
 else{const before=Number(cursor.slice(1));const older=messages.filter(m=>m.seq<before);items=older.slice(-100);nextCursor=older.length>items.length&&items.length?`b${items[0].seq}`:undefined;}
 return {apiVersion:1,items,...(nextCursor?{nextCursor}:{})};};
const append=(author,channel,text,messageId=crypto.randomUUID())=>{const existing=messages.find(m=>m.messageId===messageId);if(existing)return existing;const m={schemaVersion:1,seq:messages.length+1,messageId,author,channel,text,at:now()};messages.push(m);sequence++;return m;};
append('director','cli','Chào bạn, mình là Director của kho guides. Bạn muốn cập nhật gì?');
const COMMAND="cd '/repo/guides' && BFLOW_DIRECTOR_PROVIDER=claude 'claude' '/bflow-start'";
const director={
 readView:async projectId=>ok({apiVersion:1,projectId,layout:'director',sessionId:SESSION,snapshot:snapshot(),transcriptSeq:messages.length,cliCaptureMayBeIncomplete:false,observedAt:now()}),
 messages:async(_id,cursor)=>ok(page(cursor)),
 send:async input=>{const m=append('user','web',input.content,input.messageId);
  setTimeout(()=>{append('director','cli',`Đã nhận: “${input.content.slice(0,80)}”. Mình sẽ lập kế hoạch và báo lại.`);},400);return ok(m);},
 issues:async(_id,cursor)=>{const offset=cursor?Number(cursor.slice(1)):0;return ok({apiVersion:1,items:issues.slice(offset,offset+100)});},
 launchOptions:async projectId=>ok({apiVersion:1,projectId,terminal:terminal?{available:true}:{available:false,reason:'Không có phiên desktop để mở cửa sổ terminal'},
  providers:[{provider:'claude',state:'available',manualCommand:COMMAND},{provider:'codex',state:'unavailable',reason:'Không tìm thấy codex trên PATH',manualCommand:COMMAND.replace(/claude/g,'codex')}],observedAt:now()}),
 launch:async(_id,request)=>{launches++;setTimeout(()=>{presence='active';sequence++;},500);
  return ok({kind:'director_launch',provider:request.provider,mode:terminal?'terminal_opened':'manual_command',manualCommand:COMMAND,launchedAt:now()});}
};
const runView=()=>WebRunViewSchema.parse({apiVersion:1,runId:RUN,sessionId:SESSION,revisionToken:'v1',title:'Cập nhật hướng dẫn cài đặt',originRunId:RUN,currentRunId:RUN,
 sdlcStatus:'implementing',coreStatus:'running',transportSummary:{states:['idle'],observedAt:now()},tasks:[],blockers:[],decisions:[],clarifications:[],availableActions:[],updatedAt:now()});
const operations=new Map();
const session=id=>({apiVersion:1,projectId:id,sessionId:SESSION,state:'ready',pendingIntakes:[],blockers:[{code:'chat_adapter_unavailable',message:'legacy chat'}],updatedAt:now()});
const client={
 readProjectSession:async id=>ok(session(id)),listRuns:async()=>ok({apiVersion:1,items:[runView()]}),readRun:async()=>ok(runView()),listDecisions:async()=>ok({apiVersion:1,items:[]}),
 execute:async raw=>{const command=WebCommandSchema.parse(raw);commands.push(command);if(operations.has(command.commandId))return ok(operations.get(command.commandId));
  let state='applied',result;
  if(command.kind==='issue_retry'||command.kind==='issue_dismiss'){const issue=issues.find(i=>i.issueId===command.issueId);
   if(!issue||issue.updatedAt!==command.expectedUpdatedAt){state='failed';}
   else{issue.status=command.kind==='issue_retry'?'retrying':'dismissed';issue.updatedAt=now();result={kind:'issue',issueId:issue.issueId,status:issue.status};}}
  const operation={apiVersion:1,operationId:command.commandId,projectId:command.projectId,owner:'host_interaction',operationKind:command.kind,state,...(result?{result}:{}),
   ...(state==='failed'?{error:{apiVersion:1,code:'stale_version',message:'Sự cố đã thay đổi',retryable:false,correlationId:'fixture'}}:{}),updatedAt:now()};
  operations.set(command.commandId,operation);sequence++;return ok(operation);},
 readOperation:async(_id,id)=>operations.has(id)?ok(operations.get(id)):unavailable(),
 async *events(id,signal){let seen=-1;while(!signal?.aborted){if(seen!==sequence){seen=sequence;yield {apiVersion:1,cursor:`fixture:${sequence}`,projectId:id,type:'invalidate',resourceIds:['director'],occurredAt:now()};}await new Promise(r=>setTimeout(r,150));}},
 acknowledgeNotice:unavailable,listMessages:unavailable,sendMessage:unavailable,readArtifact:unavailable
};
const workspace={inspectProject:async id=>ok({apiVersion:1,projectId:id,ready:true,checks:[],observedAt:now()}),preview:async id=>ok({apiVersion:1,projectId:id,available:true,summary:'Fixture',blockers:[],observedAt:now()}),
 startSession:async id=>ok(session(id)),stopSession:async id=>ok(session(id)),reconcileSessionOperation:async op=>ok({...op,state:'applied',result:{kind:'lifecycle',session:session(op.projectId)}})};
const server=await createLocalWebServer({host:'127.0.0.1',port:0,stateDirectory:join(scratch,'state'),assetsDirectory:process.env.T9_ASSETS,workspace,interaction:async()=>client,director});
process.on('message',async message=>{
 try{
  if(message.kind==='inspect')process.send({requestId:message.requestId,value:{commands,launches,presence,messages,issues}});
  else if(message.kind==='configure'){if(message.terminal!==undefined)terminal=message.terminal;if(message.presence)presence=message.presence;sequence++;process.send({requestId:message.requestId,value:true});}
  else if(message.kind==='pair')process.send({requestId:message.requestId,value:server.origin+'/#bootstrap='+await server.issueBootstrap()});
  else if(message.kind==='close'){await server.close();await rm(scratch,{recursive:true,force:true});process.exit(0);}
 }catch(error){process.send({requestId:message.requestId,error:String(error)});}
});
process.send({ready:true,pairing:server.origin+'/#bootstrap='+await server.issueBootstrap(),repository});
