import { BFLOW_INBOX_NUDGE } from "../agentic/conversation-inbox.js";
import { randomUUID } from 'node:crypto';
import { WebChatSendSchema, WebChatMessageSchema, WebPageSchema, ApprovalDecisionSchema, WebDecisionSchema, type WebChatMessage } from '@bflow/contracts';
import { canonicalWebJson } from '@bflow/contracts/web-host';
import { ChatDeliveryStore, type ChatRecord } from './chat-delivery.js';
export interface ChatTransportPort {
 directory:string;projectId:string;hostSessionId:string;
 session():Promise<{sessionId:string;nativeSessionId:string;paneId:string;provider:string;ready:boolean;busy:boolean}>;
 prompt(wire:string,target:{paneId:string;nativeSessionId:string;sessionId:string}):Promise<void>;
 admit(messageId:string,content:string,principalId:string,runId?:string):Promise<unknown>;
 history?(sessionId:string):Promise<WebChatMessage[]>;
 approvalContext?(runId?:string):Promise<unknown[]>;
 observeAdmission?(record:Readonly<ChatRecord>):Promise<unknown|undefined>;
}
const marker='[bflow-web:';
export class HostChat {
 private readonly store:ChatDeliveryStore;
 private readonly activeEcho=new Set<string>();
 constructor(private readonly port:ChatTransportPort){this.store=new ChatDeliveryStore(port.directory,port.projectId,port.hostSessionId);}
 private wire(r:ChatRecord){return `${marker}${r.input.messageId}:${r.nonce}]\n${r.input.content}`;}
 async supported(){const s=await this.port.session();return s.ready&&['claude','codex'].includes(s.provider);}
 async send(raw:unknown,principalId:string):Promise<WebChatMessage>{
  const input=WebChatSendSchema.parse(raw);
  if(input.content.trim()===BFLOW_INBOX_NUDGE||input.content.startsWith(marker))throw Error('Reserved non-human chat input');
  let envelope:unknown;try{envelope=JSON.parse(input.content);}catch{/* Ordinary text. */}
  if(envelope&&typeof envelope==='object'&&('schema_version' in envelope||'sender' in envelope||'type' in envelope))throw Error('Role envelopes cannot become authenticated human input');
  const message=await this.store.exclusive(async()=>{
   if(input.projectId!==this.port.projectId)throw Error('Foreign chat project');
   const existing=(await this.store.all()).find(r=>r.input.messageId===input.messageId);
   if(existing){if(existing.principalId!==principalId||canonicalWebJson(existing.input)!==canonicalWebJson(input))throw Error('Chat replay conflict');return existing.message;}
   const session=await this.port.session();if(!await this.supported())throw Error('Chat provider unsupported or unavailable');
   if(session.sessionId!==input.sessionId)throw Error('Foreign Conversation session');
   const approvalContext=(this.port.approvalContext?await this.port.approvalContext(input.runId):[]).map(v=>WebDecisionSchema.parse(v));
   const message=WebChatMessageSchema.parse({apiVersion:1,messageId:input.messageId,sessionId:input.sessionId,...(input.runId?{runId:input.runId}:{}),content:input.content,sender:'user',source:'web',createdAt:new Date().toISOString(),delivery:'queued'});
   await this.store.write({version:1,projectId:this.port.projectId,hostSessionId:this.port.hostSessionId,sequence:Math.max(0,...(await this.store.all()).map(r=>r.sequence))+1,principalId,input,nonce:randomUUID(),nativeSessionId:session.nativeSessionId,paneId:session.paneId,message,approvalContext,echoObserved:false,admitted:false,state:'queued'});return message;
  });
  await this.pump();return (await this.store.all()).find(r=>r.input.messageId===message.messageId)!.message;
 }
 async pump():Promise<void>{
  const observed=(await this.store.all()).filter(r=>r.echoObserved&&!r.admitted);
  if(observed.length){const s=await this.port.session();for(const r of observed){if(s.sessionId===r.input.sessionId&&s.nativeSessionId===r.nativeSessionId&&s.paneId===r.paneId)await this.echo({nativeSessionId:r.nativeSessionId,paneId:r.paneId,prompt:this.wire(r)});}}
  const candidate=await this.store.exclusive(async()=>{
   const all=await this.store.all();
   if(!all.some(r=>r.state==='queued'))return;
   const s=await this.port.session();if(!s.ready)return;
   const matches=(r:ChatRecord)=>s.sessionId===r.input.sessionId&&s.nativeSessionId===r.nativeSessionId&&s.paneId===r.paneId;
   // An old unknown dispatch is retained for observation, never replayed into a new native session.
   if(all.some(r=>(r.state==='dispatching'||r.state==='accepted')&&matches(r)))return;
   let r:ChatRecord|undefined;
   for(const queued of all.filter(v=>v.state==='queued')){
    if(!matches(queued)){await this.store.write({...queued,state:'not_delivered',message:{...queued.message,delivery:'failed'}});continue;}
    r=queued;break;
   }
   if(!r||s.busy)return;
   const next={...r,state:'dispatching' as const,message:{...r.message,delivery:'unknown_delivery' as const}};await this.store.write(next);return next;
  });
  if(!candidate)return;
  try{await this.port.prompt(this.wire(candidate),{paneId:candidate.paneId,nativeSessionId:candidate.nativeSessionId,sessionId:candidate.input.sessionId});await this.store.exclusive(async()=>{const current=(await this.store.all()).find(r=>r.input.messageId===candidate.input.messageId)!;if(current.state==='dispatching')await this.store.write({...current,state:'accepted',message:{...current.message,delivery:'accepted'}});});}
  catch{/* Uncertain write/ACK never authorizes resend. The exact native echo may still reconcile. */}
 }
 async echo(input:{nativeSessionId:string;paneId:string;prompt:string}):Promise<unknown|undefined>{
  if(!input.prompt.startsWith(marker))return undefined;
  return this.store.exclusive(async()=>{
   const r=(await this.store.all()).find(r=>this.wire(r)===input.prompt);
   if(!r||r.state==='queued'||r.nativeSessionId!==input.nativeSessionId||r.paneId!==input.paneId)throw Error('Uncorrelated web echo');
   const s=await this.port.session();if(s.sessionId!==r.input.sessionId||s.nativeSessionId!==r.nativeSessionId||s.paneId!==r.paneId)throw Error('Web echo session replaced');
   // Admission itself must be idempotent on messageId, so a crash before this final receipt replays one turn.
   await this.store.write({...r,echoObserved:true});
   this.activeEcho.add(r.input.messageId);
   try{const result=r.admitted?r.result:await this.port.admit(r.input.messageId,r.input.content,r.principalId,r.input.runId);
    const current=(await this.store.all()).find(v=>v.input.messageId===r.input.messageId)!;
    await this.store.write({...current,admitted:true,state:'delivered',result,message:{...r.message,delivery:'delivered'}});return result;
   }finally{this.activeEcho.delete(r.input.messageId);}
  });
 }
 async recordApproval(messageId:string,raw:unknown){
  if(!this.activeEcho.has(messageId))throw Error('Approval requires the current correlated web echo');
  const decision=ApprovalDecisionSchema.parse(raw),r=(await this.store.all()).find(r=>r.input.messageId===messageId);
  if(!r||decision.sessionId!==r.input.sessionId||decision.decidedBy!==r.principalId)throw Error('Foreign web chat approval');
  const current=(this.port.approvalContext?await this.port.approvalContext(r.input.runId):[]).map(v=>WebDecisionSchema.parse(v));
  const pinned=r.approvalContext.find(a=>a.decisionId===decision.approvalId&&a.status==='pending');
  if(!pinned||canonicalWebJson(current)!==canonicalWebJson(r.approvalContext)||pinned.runId!==decision.runId||pinned.expectedVersion.approvalId!==decision.approvalId||pinned.expectedVersion.revision!==decision.revision||pinned.expectedVersion.generation!==decision.generation||canonicalWebJson(pinned.expectedVersion.target)!==canonicalWebJson(decision.target))throw Error('Stale chat approval context; use the current decision card');
  if(r.approval&&canonicalWebJson(r.approval)!==canonicalWebJson(decision))throw Error('Conflicting web approval');
  await this.store.write({...r,approval:decision});
 }
 async authenticateHuman(raw:unknown){const decision=ApprovalDecisionSchema.parse(raw);return (await this.store.all()).some(r=>r.approval&&canonicalWebJson(r.approval)===canonicalWebJson(decision));}
 async list(sessionId:string,cursor?:string){
  if(this.port.observeAdmission)await this.store.exclusive(async()=>{
   for(const r of await this.store.all()){
    if(r.input.sessionId!==sessionId||r.state==='queued'||r.state==='not_delivered'||r.admitted)continue;
    const result=await this.port.observeAdmission!(r);
    if(result!==undefined)await this.store.write({...r,admitted:true,state:'delivered',result,message:{...r.message,delivery:'delivered'}});
   }
  });
  const records=(await this.store.all()).filter(r=>r.input.sessionId===sessionId);
  let native:WebChatMessage[]=[];
  try{native=this.port.history?await this.port.history(sessionId):[];}catch(error){if(!records.length)throw error;}
  const merged=[...records.map(r=>r.state==='dispatching'||r.state==='accepted'?{...r.message,delivery:'unknown_delivery' as const}:r.message),...native].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  const offset=cursor===undefined?0:Number(cursor);
  if(!Number.isSafeInteger(offset)||offset<0||String(offset)!==(cursor??'0'))throw Error('Invalid chat cursor');
  return WebPageSchema(WebChatMessageSchema).parse({apiVersion:1,items:merged.slice(offset,offset+100),...(offset+100<merged.length?{nextCursor:String(offset+100)}:{})});
 }
}
