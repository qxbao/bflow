import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { WebChatMessageSchema, WEB_LIMITS, type WebChatMessage } from '@bflow/contracts';
/** Stable provider-native IDs, never text/time or terminal snapshots. */
export function chatMessageId(provider:string,nativeSessionId:string,nativeId:string):string {
 const h=createHash('sha256').update(JSON.stringify([provider,nativeSessionId,nativeId])).digest('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
const ClaudeRow=z.object({type:z.string(),uuid:z.string().uuid().optional(),sessionId:z.string().optional(),timestamp:z.string().datetime().optional(),
 message:z.object({role:z.string().optional(),content:z.unknown()}).passthrough().optional()}).passthrough();
const CodexRow=z.object({type:z.string(),ordinal:z.number().int().nonnegative().optional(),timestamp:z.string().datetime().optional(),
 payload:z.object({type:z.string(),role:z.string().optional(),phase:z.string().optional(),id:z.string().nullable().optional(),content:z.unknown().optional()}).passthrough().optional()}).passthrough();
export async function normalizedAssistantHistory(provider:string,path:string,nativeSessionId:string,sessionId:string,runId?:string):Promise<WebChatMessage[]>{
 if(!['claude','codex'].includes(provider))throw Error('Normalized chat adapter unsupported');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.size>16*1024*1024)throw Error('Unsafe or oversized native transcript');
  const buffer=Buffer.alloc(16*1024*1024+1);let size=0;
  while(size<buffer.length){const r=await file.read(buffer,size,buffer.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}
  if(size>16*1024*1024)throw Error('Native transcript limit');
  const lines=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size)).split('\n'),result:WebChatMessage[]=[];
  let codexSessionVerified=false;
  for(let index=0;index<lines.length;index++){
   const line=lines[index];if(!line?.trim())continue;
   let value:unknown;try{value=JSON.parse(line);}catch{if(index===lines.length-1)break;throw Error('Malformed native transcript');}
   let id:string|undefined,time:string|undefined,parts:unknown;
   if(provider==='claude'){const row=ClaudeRow.parse(value);if(row.type!=='assistant'||row.sessionId!==nativeSessionId)continue;id=row.uuid;time=row.timestamp;parts=row.message?.content;}
   else{const header=z.object({type:z.string()}).passthrough().parse(value);
    if(header.type==='session_meta'){const meta=z.object({payload:z.object({id:z.string()}).passthrough()}).passthrough().parse(value);if(meta.payload.id!==nativeSessionId)throw Error('Foreign Codex session');codexSessionVerified=true;continue;}
    if(header.type!=='response_item')continue;
    const row=CodexRow.parse(value);if(row.type!=='response_item'||row.payload?.type!=='message'||row.payload.role!=='assistant'||row.payload.phase!=='final_answer')continue;
    if(!codexSessionVerified)throw Error('Codex transcript session unverified');if(row.ordinal===undefined)throw Error('Codex transcript has no stable ordinal');id=`${row.ordinal}:${row.payload.id??''}`;time=row.timestamp;parts=row.payload.content;}
   if(!id||!time||!Array.isArray(parts))continue;
   const content=parts.flatMap(part=>{const p=z.object({type:z.string(),text:z.string().optional()}).passthrough().parse(part);return ['text','output_text'].includes(p.type)&&p.text?[p.text]:[];}).join('\n');
   if(!content.trim()||Buffer.byteLength(content)>WEB_LIMITS.chatBytes)continue;
   result.push(WebChatMessageSchema.parse({apiVersion:1,messageId:chatMessageId(provider,nativeSessionId,id),sessionId,...(runId?{runId}:{}),sender:'conversation',content,createdAt:time,delivery:'delivered',source:'native'}));
  }return result.slice(-100);
 }finally{await file.close();}
}

/** Uses only the already-validated launch material; never the host account environment. */
export function nativeChatTranscriptRoot(provider:string,env:Record<string,string|undefined>):string|undefined{
 const base=provider==='codex'?env.CODEX_HOME:provider==='claude'?(env.CLAUDE_CONFIG_DIR||(env.HOME?join(env.HOME,'.claude'):undefined)):undefined;
 return base&&isAbsolute(base)?(provider==='claude'?join(base,'projects'):base):undefined;
}
export async function registeredAssistantHistory(registration:unknown,provider:string,nativeSessionId:string,sessionId:string){
 const r=z.object({role:z.literal('conversation'),sessionId:z.string(),transcriptRoot:z.string(),transcriptPath:z.string()}).passthrough().parse(registration);
 if(r.sessionId!==nativeSessionId)throw Error('Foreign native transcript session');
 const path=await realpath(r.transcriptPath),root=await realpath(r.transcriptRoot);
 if(!path.startsWith(root+'/'))throw Error('Foreign native transcript root');
 return normalizedAssistantHistory(provider,path,nativeSessionId,sessionId);
}
