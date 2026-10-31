import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { WebChatSendSchema, WebChatMessageSchema, IdentifierSchema, ApprovalDecisionSchema, WebDecisionSchema } from '@bflow/contracts';
import { canonicalWebJson } from '@bflow/contracts/web-host';
export const ChatRecordSchema=z.object({version:z.literal(1),projectId:IdentifierSchema,hostSessionId:IdentifierSchema,
 sequence:z.number().int().positive(),principalId:IdentifierSchema,input:WebChatSendSchema,nonce:z.string().uuid(),nativeSessionId:IdentifierSchema,paneId:IdentifierSchema,
 message:WebChatMessageSchema,echoObserved:z.boolean().default(false),admitted:z.boolean(),state:z.enum(['queued','dispatching','accepted','delivered','not_delivered']),result:z.unknown().optional(),approval:ApprovalDecisionSchema.optional(),approvalContext:z.array(WebDecisionSchema).default([])}).strict();
export type ChatRecord=z.infer<typeof ChatRecordSchema>;
const queues=new Map<string,Promise<unknown>>();
export class ChatDeliveryStore {
 constructor(readonly directory:string,readonly projectId:string,readonly hostSessionId:string){}
 exclusive<T>(work:()=>Promise<T>):Promise<T>{const p=(queues.get(this.directory)??Promise.resolve()).catch(()=>undefined).then(work);queues.set(this.directory,p);void p.finally(()=>{if(queues.get(this.directory)===p)queues.delete(this.directory);}).catch(()=>undefined);return p;}
 private async prepare(){await mkdir(this.directory,{recursive:true,mode:0o700});const st=await lstat(this.directory);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid?.())throw Error('Unsafe chat directory');}
 private filename(id:string){return createHash('sha256').update(id).digest('hex')+'.json';}
 async all():Promise<ChatRecord[]>{await this.prepare();const result:ChatRecord[]=[];
  for(const name of (await readdir(this.directory)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort()){
   if(result.length>=10000)throw Error('Chat history storage limit');
   const file=await open(join(this.directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{const st=await file.stat();if(!st.isFile()||st.size>262144||(st.mode&0o077)!==0||st.uid!==process.getuid?.())throw Error('Unsafe chat record');
    const bytes=Buffer.alloc(262145);const {bytesRead}=await file.read(bytes,0,bytes.length,0);if(bytesRead>262144)throw Error('Oversized chat record');
    const envelope=z.object({body:ChatRecordSchema,checksum:z.string()}).strict().parse(JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'))),r=envelope.body;
    if(envelope.checksum!==createHash('sha256').update(canonicalWebJson(r)).digest('hex')||r.projectId!==this.projectId||r.hostSessionId!==this.hostSessionId||this.filename(r.input.messageId)!==name||r.message.messageId!==r.input.messageId||r.message.sessionId!==r.input.sessionId)throw Error('Foreign or corrupt chat record');
    result.push(r);
   }finally{await file.close();}
  }if(new Set(result.map(r=>r.sequence)).size!==result.length)throw Error('Conflicting chat queue sequence');return result.sort((a,b)=>a.sequence-b.sequence);
 }
 async write(input:ChatRecord){await this.prepare();const body=ChatRecordSchema.parse(input),bytes=canonicalWebJson({body,checksum:createHash('sha256').update(canonicalWebJson(body)).digest('hex')});
  if(Buffer.byteLength(bytes)>262144)throw Error('Chat storage quota');const temp=join(this.directory,randomUUID()+'.tmp'),file=await open(temp,'wx',0o600);
  try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
  try{await rename(temp,join(this.directory,this.filename(body.input.messageId)));const dir=await open(this.directory,'r');try{try{await dir.sync();}catch(error){const code=(error as NodeJS.ErrnoException|undefined)?.code;if(!code||!['EINVAL','ENOTSUP','EOPNOTSUPP','ENOSYS','EPERM','EACCES','EBADF','EISDIR','EROFS'].includes(code))throw error;}}finally{await dir.close();}}finally{await rm(temp,{force:true});}
 }
}
