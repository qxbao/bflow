// Explicit manual live adapter probe. Uses an already-created isolated Herdr
// session with real observer hooks; never starts or alters a user's session.
import { HostChat } from '../../dist/interaction/chat.js';
import { normalizedAssistantHistory } from '../../dist/interaction/chat-history.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const execute=promisify(execFile),provider=process.env.W08_PROVIDER,session=process.env.W08_SESSION,pane=process.env.W08_PANE,hookFile=process.env.W08_HOOK_FILE;
if(!['claude','codex'].includes(provider)||!session||!pane||!hookFile)throw Error('Explicit isolated live probe inputs required');
const hooks=async()=>(await readFile(hookFile,'utf8')).trim().split('\n').filter(Boolean).map(v=>JSON.parse(v));
const previous=(await hooks()).filter(h=>provider==='codex'?!!h.turn_id:!!h.prompt_id).at(-1);
if(!previous)throw Error('No actual native hook session evidence');
const nativeSessionId=previous.session_id,dir=await mkdtemp(join(tmpdir(),'w08-live-adapter-'));let admissions=0,wire;
try{
 const chat=new HostChat({directory:dir,projectId:'live-project',hostSessionId:session,
  session:async()=>{const r=JSON.parse((await execute('herdr',['--session',session,'agent','get',pane])).stdout).result.agent;return {sessionId:'live-conversation',nativeSessionId,paneId:pane,provider,ready:true,busy:!['done','idle'].includes(r.agent_status)};},
  prompt:async input=>{wire=input;await execute('herdr',['--session',session,'agent','prompt',pane,input],{timeout:15000});},
  admit:async id=>{admissions++;return {messageId:id};}});
 const messageId=randomUUID(),answer=`W08_${provider.toUpperCase()}_LIVE`;
 await chat.send({apiVersion:1,messageId,projectId:'live-project',sessionId:'live-conversation',content:`Reply only ${answer}. Do not use tools or change files.`},'live-local-user');
 let stop;
 const deadline=Date.now()+60000;
 while(Date.now()<deadline){
  const h=await hooks(),echo=h.find(v=>v.hook_event_name==='UserPromptSubmit'&&v.session_id===nativeSessionId&&v.prompt===wire);
  if(echo){await chat.echo({nativeSessionId:echo.session_id,paneId:pane,prompt:echo.prompt});await chat.echo({nativeSessionId:echo.session_id,paneId:pane,prompt:echo.prompt});
   const id=provider==='codex'?echo.turn_id:echo.prompt_id;stop=h.find(v=>v.hook_event_name==='Stop'&&v.session_id===nativeSessionId&&(provider==='codex'?v.turn_id:v.prompt_id)===id);
   if(stop)break;
  }
  await new Promise(accept=>setTimeout(accept,250));
 }
 if(!stop)throw Error('Real matching Stop missing; delivery remains unverified, no resend');
 const history=await normalizedAssistantHistory(provider,stop.transcript_path,nativeSessionId,'live-conversation');
 if(admissions!==1||!history.some(m=>m.content.trim()===answer)||(await chat.list('live-conversation')).items[0]?.delivery!=='delivered')throw Error('Live adapter assertions failed');
 console.log(JSON.stringify({provider,transport:'real isolated Herdr',nativeHooks:'real matching submit/stop',normalizedTranscript:true,admissions,duplicateEchoAdditionalAdmissions:0,workflowAcceptance:false}));
}finally{await rm(dir,{recursive:true,force:true});}
