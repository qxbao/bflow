import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizedAssistantHistory } from '../../src/interaction/chat-history.js';
const roots:string[]=[];afterEach(async()=>{for(const r of roots.splice(0))await rm(r,{recursive:true,force:true});});
async function file(rows:unknown[]){const r=await mkdtemp(join(tmpdir(),'chat-history-'));roots.push(r);const path=join(r,'transcript.jsonl');await writeFile(path,rows.map(v=>JSON.stringify(v)).join('\n')+'\n');return path;}
const time='2026-10-29T03:22:00.887Z',uuid='68fac0e2-c55a-4813-92f9-9f2ad898b2a9';
it('reads Claude text blocks with stable native UUID and excludes tool/reasoning output',async()=>{
 const path=await file([{type:'assistant',uuid,sessionId:'native',timestamp:time,message:{role:'assistant',content:[{type:'thinking',thinking:'private'},{type:'text',text:'Xin chào'},{type:'tool_use',id:'tool',input:{secret:'private'}}]}}]);
 const a=await normalizedAssistantHistory('claude',path,'native','conversation');const b=await normalizedAssistantHistory('claude',path,'native','conversation');expect(a).toEqual(b);expect(a).toHaveLength(1);expect(a[0]?.content).toBe('Xin chào');
});
it('requires matching Codex session metadata before accepting final assistant rows',async()=>{
 const path=await file([{type:'session_meta',payload:{type:'session_meta',id:'foreign'}},{type:'response_item',ordinal:20,timestamp:time,payload:{type:'message',id:null,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'secret from foreign session'}]}}]);
 await expect(normalizedAssistantHistory('codex',path,'native','conversation')).rejects.toThrow();
});
it('uses stable Codex ordinals and excludes commentary and system messages',async()=>{
 const path=await file([{type:'session_meta',payload:{id:'native'}},{type:'response_item',ordinal:20,timestamp:time,payload:{type:'message',id:null,role:'assistant',phase:'commentary',content:[{type:'output_text',text:'internal'}]}},{type:'response_item',ordinal:21,timestamp:time,payload:{type:'message',id:null,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Kết quả'}]}}]);
 expect((await normalizedAssistantHistory('codex',path,'native','conversation')).map(m=>m.content)).toEqual(['Kết quả']);
});
it('rejects transcript symlinks',async()=>{const path=await file([]);await symlink(path,path+'.link');await expect(normalizedAssistantHistory('claude',path+'.link','native','conversation')).rejects.toThrow();});
it('derives transcript roots only from the validated launch environment',async()=>{
 const {nativeChatTranscriptRoot}=await import('../../src/interaction/chat-history.js');
 expect(nativeChatTranscriptRoot('claude',{CLAUDE_CONFIG_DIR:'/private/claude',HOME:'/other'})).toBe('/private/claude/projects');
 expect(nativeChatTranscriptRoot('claude',{HOME:'/private/home'})).toBe('/private/home/.claude/projects');
 expect(nativeChatTranscriptRoot('claude',{})).toBeUndefined();expect(nativeChatTranscriptRoot('agy',{HOME:'/private/home'})).toBeUndefined();
});
it('refuses transcript registrations from specialists before reading their content',async()=>{
 const {registeredAssistantHistory}=await import('../../src/interaction/chat-history.js');
 const path=await file([{type:'assistant',uuid,sessionId:'native',timestamp:time,message:{content:[{type:'text',text:'specialist secret'}]}}]);
 await expect(registeredAssistantHistory({role:'coordinator',sessionId:'native',transcriptPath:path,transcriptRoot:path.slice(0,path.lastIndexOf('/'))},'claude','native','conversation')).rejects.toThrow();
});
it('keeps normalized assistant messages in immutable receipts through native replacement and host restart',async()=>{
 const {HostReceiptJournal}=await import('../../src/agentic/host-receipts.js');
 const path=await file([{type:'assistant',uuid,sessionId:'old-native',timestamp:time,message:{content:[{type:'text',text:'Old assistant answer'}]}}]);
 const dir=path.slice(0,path.lastIndexOf('/')),journal=new HostReceiptJournal(join(dir,'receipts'),dir,'host');
 const messages=await normalizedAssistantHistory('claude',path,'old-native','conversation');
 await journal.recordChatAssistant('pane','claude','old-native',messages[0]!);
 const reopened=new HostReceiptJournal(join(dir,'receipts'),dir,'host');
 expect((await reopened.chatAssistantMessages('conversation')).map(m=>m.content)).toEqual(['Old assistant answer']);
 expect(await reopened.chatAssistantMessages('other')).toEqual([]);
});
it('does not advertise chat capability when the current normalized transcript cannot be validated',async()=>{
 const {registeredChatAvailable}=await import('../../src/interaction/chat-history.js');
 const path=await file([{type:'session_meta',payload:{id:'foreign'}}]);
 expect(await registeredChatAvailable({role:'conversation',sessionId:'native',transcriptPath:path,transcriptRoot:path.slice(0,path.lastIndexOf('/'))},'codex','native','conversation')).toBe(false);
 expect(await registeredChatAvailable({role:'conversation',sessionId:'native',transcriptPath:path,transcriptRoot:path.slice(0,path.lastIndexOf('/'))},'agy','native','conversation')).toBe(false);
});
