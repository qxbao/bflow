import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { WebHttpContracts, WEB_LIMITS, type WebChatMessage } from '@bflow/contracts/web';
import { ApiClient, ApiError, explain, projectPath } from '../../api/client';
import { FieldLabel } from '../../components/FieldHelp';
const DEFINITIVE_PRE_ADMISSION_CODES=new Set(['invalid_request','forbidden','session_required','not_found','stale_version','operation_not_allowed','payload_too_large']);
/** Held in memory only, for the bubble shown before history contains this message ID. */
export type PendingMessage={messageId:string;content:string;delivery:WebChatMessage['delivery']|'sending'};
function pending(key:string):string|undefined {
 const raw=localStorage.getItem(key);if(!raw)return;
 const value:unknown=JSON.parse(raw);
 if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='messageId,version'||!('version' in value)||value.version!==1||!('messageId' in value)||typeof value.messageId!=='string'||!/^[-a-f0-9]{36}$/i.test(value.messageId))throw Error('Invalid chat recovery metadata');
 return value.messageId;
}
export function ChatComposer({api,projectId,sessionId,runId,ready,sessionFresh,refresh,onPending,initialDraft=''}:{initialDraft?:string;api:ApiClient;projectId:string;sessionId:string;runId:string;ready:boolean;sessionFresh:boolean;refresh:()=>void;onPending:(message:PendingMessage|undefined)=>void}){
 const key=JSON.stringify(['bflow-chat',projectId,sessionId]);
 const [draft,setDraft]=useState(initialDraft),[busy,setBusy]=useState(false),[sending,setSending]=useState(false),[notice,setNotice]=useState(()=>{try{return pending(key)?'Đang có tin nhắn trước chờ đối chiếu kết quả gửi. Bấm “Đối chiếu tin nhắn” để kiểm tra.':'';}catch{return 'Dữ liệu đối chiếu cục bộ bị hỏng. Kiểm tra lịch sử trò chuyện rồi mở khóa khung soạn tin nếu cần; không tự gửi lại.';}}),[uncertain,setUncertain]=useState(()=>{try{return !!pending(key);}catch{return true;}}),[canUnlock,setCanUnlock]=useState(()=>{try{pending(key);return false;}catch{return true;}});
 useEffect(()=>{try{const hasPending=Boolean(pending(key));setUncertain(hasPending);setCanUnlock(false);setNotice(hasPending?'Đang có tin nhắn trước chờ đối chiếu kết quả gửi. Bấm “Đối chiếu tin nhắn” để kiểm tra.':'');}catch{setUncertain(true);setCanUnlock(true);setNotice('Dữ liệu đối chiếu cục bộ bị hỏng. Kiểm tra lịch sử trò chuyện rồi mở khóa khung soạn tin nếu cần; không tự gửi lại.');}},[key]);
 const tooLarge=new TextEncoder().encode(draft).byteLength>WEB_LIMITS.chatBytes;
 // Sending is governed by fresh host/session readiness; a background re-read keeps the draft editable and focused.
 const canSend=ready&&sessionFresh&&!busy&&!uncertain&&!tooLarge&&!!draft.trim();
 async function submit(event:FormEvent){event.preventDefault();if(!canSend)return;
  setBusy(true);setNotice('');setCanUnlock(false);
  try{
   if(!navigator.locks)throw Error('Browser locks unavailable');
   await navigator.locks.request(key,async()=>{
    if(pending(key)){setUncertain(true);throw Error('Pending chat');}
    const input=WebHttpContracts.sendMessage.body.parse({apiVersion:1,messageId:crypto.randomUUID(),projectId,sessionId,runId,content:draft});
    // Only an ID survives a failed HTTP ACK. Message content/credentials never enter localStorage.
    localStorage.setItem(key,JSON.stringify({version:1,messageId:input.messageId}));setUncertain(true);
    setSending(true);onPending({messageId:input.messageId,content:input.content,delivery:'sending'});
    let message;
    try{
     message=await api.request(`${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages`,WebHttpContracts.sendMessage.response,'POST',input,40000);
    }catch(error){
     if(error instanceof ApiError && DEFINITIVE_PRE_ADMISSION_CODES.has(error.code)){
      localStorage.removeItem(key);setUncertain(false);setCanUnlock(false);onPending(undefined);setNotice(explain(error));return;
     }
     throw error;
    }
    if(message.messageId!==input.messageId||message.sessionId!==sessionId||message.runId!==runId||message.sender!=='user'||message.source!=='web'||message.content!==input.content)throw new ApiError('invalid_response');
    localStorage.removeItem(key);setUncertain(false);setCanUnlock(false);setDraft('');onPending({messageId:input.messageId,content:input.content,delivery:message.delivery});setNotice('');refresh();
   });
  }catch{onPending(undefined);setNotice('Chưa xác định được kết quả gửi. Đối chiếu tin nhắn gốc; không gửi lại.');}
  finally{setSending(false);setBusy(false);}
 }
 async function reconcile(){if(busy)return;setBusy(true);
  try{
   if(!navigator.locks)throw Error('Browser locks unavailable');
   await navigator.locks.request(key,async()=>{
    let id:string|undefined;
    try{id=pending(key);}catch{setCanUnlock(true);setNotice('Dữ liệu đối chiếu cục bộ bị hỏng. Kiểm tra lịch sử trò chuyện rồi mở khóa khung soạn tin nếu cần; không tự gửi lại.');return;}
    if(!id){setUncertain(false);setCanUnlock(false);return;}
    let cursor:string|undefined,complete=false;const seen=new Set<string>();
    for(let page=0;page<102;page++){
     const suffix=cursor?`?${new URLSearchParams({cursor})}`:'';
     const history=await api.request(`${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`,WebHttpContracts.messages.response,'GET',undefined,40000);
     if(history.items.some(m=>m.sessionId!==sessionId))throw Error('Foreign history');
     const message=history.items.find(m=>m.messageId===id&&m.sender==='user'&&m.source==='web');
     if(message){localStorage.removeItem(key);setUncertain(false);setCanUnlock(false);setDraft('');setNotice('Đã tìm thấy tin nhắn gốc. Không gửi lại tin này.');refresh();return;}
     if(!history.nextCursor){complete=true;break;}
     if(seen.has(history.nextCursor))break;cursor=history.nextCursor;seen.add(cursor);
    }
    if(complete){
     setCanUnlock(true);
     setNotice('Đã đối chiếu toàn bộ lịch sử hiện hành nhưng không có tin nhắn này (có thể yêu cầu bị gián đoạn trước khi tới máy chủ). Bạn có thể đọc lại hoặc mở khóa khung soạn tin để chỉnh sửa thủ công; hệ thống không tự gửi lại.');
    }else{
     setNotice('Chưa tìm thấy kết quả xác thực. Tiếp tục đối chiếu tin nhắn gốc; không gửi lại.');
    }
   });
  }catch{
   let corrupt=false;try{pending(key);}catch{corrupt=true;}
   setCanUnlock(corrupt);
   setNotice('Chưa đối chiếu được tin nhắn gốc. Kiểm tra kết nối rồi đọc lại; không gửi lại.');
  }
  finally{setBusy(false);}
 }
 async function unlock(){if(busy)return;setBusy(true);
  try{
   if(!navigator.locks)throw Error('Browser locks unavailable');
   await navigator.locks.request(key,async()=>{
    localStorage.removeItem(key);setUncertain(false);setCanUnlock(false);
    setNotice('Đã mở khóa khung soạn tin; bản nháp được giữ lại và không có tin nào được tự gửi.');
   });
  }finally{setBusy(false);}
 }
 // Enter sends; an IME still composing Vietnamese text keeps Enter for itself.
 function keyDown(event:KeyboardEvent<HTMLTextAreaElement>){if(event.key!=='Enter'||event.shiftKey||event.nativeEvent.isComposing)return;event.preventDefault();event.currentTarget.form?.requestSubmit();}
 return <form onSubmit={submit} className="min-w-0 border-t border-line bg-surface px-4 py-3" aria-busy={busy}>
  {!ready&&<p id="chat-unavailable" className="mt-0 mb-2 border-l-3 border-warning pl-3 text-sm">Trò chuyện qua web chưa sẵn sàng trong phiên này. Bạn vẫn có thể dùng biểu mẫu và nút quyết định.</p>}
  {tooLarge&&<p role="alert" className="mt-0 mb-2 text-sm text-danger">Tin nhắn vượt quá giới hạn 16 KiB.</p>}
  {notice&&<p role="status" className="mt-0 mb-2 text-sm">{notice}</p>}
  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
   <FieldLabel
    htmlFor="chat-draft"
    className="mb-0"
    labelClassName="font-data text-xs font-medium text-muted"
    label="Tin nhắn cho Conversation"
    help="Gửi trao đổi hoặc câu hỏi bổ sung tới Trợ lý hội thoại (Conversation) của riêng công việc này. Nhấn Enter để gửi, Shift+Enter để xuống dòng; các quyết định phê duyệt chính thức vẫn thực hiện ở trang chi tiết công việc."
   />
   <span className="hidden font-data text-xs text-muted lg:inline">Enter để gửi · Shift+Enter để xuống dòng</span>
  </div>
  <div className="flex items-end gap-2">
   <textarea id="chat-draft" value={sending?'':draft} onChange={e=>setDraft(e.target.value)} onKeyDown={keyDown} readOnly={busy} disabled={!ready||(uncertain&&!busy)} aria-describedby={!ready?'chat-unavailable':undefined} rows={1} placeholder={ready?'Nhập tin nhắn…':'Trò chuyện trực tiếp chưa bật trong phiên này'} className="max-h-40 min-h-11 resize-none rounded-2xl px-4 lg:min-h-9"/>
   <button type="submit" aria-label="Gửi tin nhắn" disabled={!canSend} className="shrink-0 rounded-full border-steel bg-steel px-4 text-surface hover:bg-ink">{busy?'Đang gửi…':'Gửi'}</button>
  </div>
  {uncertain&&<div className="mt-1.5 flex flex-wrap justify-end gap-2">{canUnlock&&<button type="button" disabled={busy} onClick={()=>void unlock()}>Mở khóa khung soạn tin</button>}<button type="button" disabled={busy} onClick={()=>void reconcile()}>Đối chiếu tin nhắn</button></div>}
 </form>;
}
