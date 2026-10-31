import { useState, type FormEvent } from 'react';
import { WebHttpContracts, WEB_LIMITS } from '@bflow/contracts/web';
import { ApiClient, ApiError, explain, projectPath } from '../../api/client';
import { useRead } from '../data';
const DEFINITIVE_PRE_ADMISSION_CODES=new Set(['invalid_request','forbidden','session_required','not_found','stale_version','operation_not_allowed','payload_too_large']);
function pending(key:string):string|undefined {
 const raw=localStorage.getItem(key);if(!raw)return;
 const value:unknown=JSON.parse(raw);
 if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='messageId,version'||!('version' in value)||value.version!==1||!('messageId' in value)||typeof value.messageId!=='string'||!/^[-a-f0-9]{36}$/i.test(value.messageId))throw Error('Invalid chat recovery metadata');
 return value.messageId;
}
export function ChatComposer({api,projectId,sessionId,runId,revision,refresh}:{api:ApiClient;projectId:string;sessionId:string;runId:string;revision:number;historyReady:boolean;refresh:()=>void}){
 const key=JSON.stringify(['bflow-chat',projectId,sessionId]);
 const [draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[uncertain,setUncertain]=useState(()=>{try{return !!pending(key);}catch{return true;}});
 const session=useRead(`chat-session:${projectId}:${sessionId}`,()=>api.sessionView(projectId),revision);
 // Sending is governed by fresh host/session readiness; unavailable first-message history remains an independent read error.
 const ready=!session.loading&&!session.error&&session.data?.state==='ready'&&session.data.sessionId===sessionId&&!session.data.blockers.some(b=>b.code==='chat_adapter_unavailable');
 async function submit(event:FormEvent){event.preventDefault();if(!ready||busy||uncertain)return;
  setBusy(true);setNotice('');
  try{
   if(!navigator.locks)throw Error('Browser locks unavailable');
   await navigator.locks.request(key,async()=>{
    if(pending(key)){setUncertain(true);throw Error('Pending chat');}
    const input=WebHttpContracts.sendMessage.body.parse({apiVersion:1,messageId:crypto.randomUUID(),projectId,sessionId,runId,content:draft});
    // Only an ID survives a failed HTTP ACK. Message content/credentials never enter localStorage.
    localStorage.setItem(key,JSON.stringify({version:1,messageId:input.messageId}));setUncertain(true);
    let message;
    try{
     message=await api.request(`${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages`,WebHttpContracts.sendMessage.response,'POST',input);
    }catch(error){
     if(error instanceof ApiError && DEFINITIVE_PRE_ADMISSION_CODES.has(error.code)){
      localStorage.removeItem(key);setUncertain(false);setNotice(explain(error));return;
     }
     throw error;
    }
    if(message.messageId!==input.messageId||message.sessionId!==sessionId||message.runId!==runId||message.sender!=='user'||message.source!=='web'||message.content!==input.content)throw new ApiError('invalid_response');
    localStorage.removeItem(key);setUncertain(false);setDraft('');setNotice('Đã tiếp nhận tin nhắn. Trạng thái chuyển tin được đối chiếu trong lịch sử.');refresh();
   });
  }catch{setNotice('Chưa xác định được kết quả gửi. Đối chiếu tin nhắn gốc; không gửi lại.');}
  finally{setBusy(false);}
 }
 async function reconcile(){if(busy)return;setBusy(true);
  try{
   if(!navigator.locks)throw Error('Browser locks unavailable');
   await navigator.locks.request(key,async()=>{
    const id=pending(key);if(!id){setUncertain(false);return;}
    let cursor:string|undefined;const seen=new Set<string>();
    for(let page=0;page<102;page++){
     const suffix=cursor?`?${new URLSearchParams({cursor})}`:'';
     const history=await api.request(`${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`,WebHttpContracts.messages.response);
     if(history.items.some(m=>m.sessionId!==sessionId))throw Error('Foreign history');
     const message=history.items.find(m=>m.messageId===id&&m.sender==='user'&&m.source==='web');
     if(message){localStorage.removeItem(key);setUncertain(false);setDraft('');setNotice('Đã tìm thấy tin nhắn gốc. Không gửi lại tin này.');refresh();return;}
     if(!history.nextCursor||seen.has(history.nextCursor))break;cursor=history.nextCursor;seen.add(cursor);
    }
    setNotice('Chưa tìm thấy kết quả xác thực. Tiếp tục đối chiếu tin nhắn gốc; không gửi lại.');
   });
  }catch{setNotice('Chưa đối chiếu được tin nhắn gốc. Kiểm tra kết nối rồi đọc lại; không gửi lại.');}
  finally{setBusy(false);}
 }
 const tooLarge=new TextEncoder().encode(draft).byteLength>WEB_LIMITS.chatBytes;
 return <form onSubmit={submit} className="min-w-0 [&_textarea]:my-3" aria-busy={busy}>
  {!ready&&<p id="chat-unavailable" className="my-3 border-l-3 border-warning pl-3 text-sm">Trò chuyện qua web chưa sẵn sàng trong phiên này. Bạn vẫn có thể dùng biểu mẫu và nút quyết định.</p>}
  <label htmlFor="chat-draft">Tin nhắn cho Conversation</label><textarea id="chat-draft" value={draft} onChange={e=>setDraft(e.target.value)} disabled={!ready||busy||uncertain} aria-describedby={!ready?'chat-unavailable':undefined} rows={3}/>
  {tooLarge&&<p role="alert">Tin nhắn vượt quá giới hạn 16 KiB.</p>}
  <button type="submit" disabled={!ready||busy||uncertain||tooLarge||!draft.trim()}>{busy?'Đang xử lý…':'Gửi tin nhắn'}</button>
  {uncertain&&<button type="button" disabled={busy} onClick={()=>void reconcile()}>Đối chiếu tin nhắn</button>}
  {notice&&<p role="status">{notice}</p>}
 </form>;
}
