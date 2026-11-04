import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { WebHttpContracts, WEB_LIMITS, type DirectorMessage, type WebChatSend } from '@bflow/contracts/web';
import { ApiError, explain } from '../../api/client';
import { FieldLabel } from '../../components/FieldHelp';
import { LoadingState } from '../../components/LoadingState';
import { DirectorPresenceStatus, useDirector, type DirectorChatBlock, type DirectorPresenceState } from './status';
import { useDirectorTranscript, type DirectorTranscript } from './transcript';

/** Refusals proven to precede any write: the message ID is released and nothing was stored. */
const DEFINITIVE=new Set(['invalid_request','forbidden','session_required','not_found','stale_version','operation_not_allowed','payload_too_large']);
const REPLY_WINDOW_MS=5*60*1000,REPLY_POLL_MS=5000,RECONCILE_PAGES=60;
const blockText:Record<DirectorChatBlock,string>={
  unknown:'Chưa xác nhận được phiên Director nên chưa gửi được tin. Tải lại dữ liệu hoặc kiểm tra phiên dự án.',
  legacy:'Phiên này dùng bố cục cũ (v2); trò chuyện Director không dùng được.',
  host_not_ready:'Host của phiên chưa sẵn sàng; tin chưa gửi được. Khởi động hạ tầng phiên ở trang Tổng quan rồi thử lại.',
  session_mismatch:'Phiên host vừa thay đổi. Đang đọc lại trạng thái trước khi cho gửi tin.',
};
const ownNote:Record<DirectorPresenceState,string>={
  absent:'Đã lưu vào hội thoại; Director sẽ đọc khi mở phiên.',active:'Đã lưu vào hội thoại; đang chờ Director trả lời.',
  waiting:'Đã lưu vào hội thoại; đang chờ Director trả lời.',unknown:'Đã lưu vào hội thoại.',
};
const day=(iso:string)=>new Date(iso).toLocaleDateString('vi');
const clock=(iso:string)=>new Date(iso).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'});

/** Project-scoped Director conversation. Text only; replies appear as whole messages, never as simulated typing or streaming. */
export function DirectorChat({initialDraft=''}:{initialDraft?:string}){
  const d=useDirector(),transcript=useDirectorTranscript(d.layout==='director'||d.layout==='not_started');
  const {items}=transcript,last=items.at(-1);
  const awaitingReply=Boolean(last&&last.author==='user'&&Date.now()-Date.parse(last.at)<REPLY_WINDOW_MS);
  // Fallback for a missed SSE signal while a reply can still arrive; it only re-reads the view and newer pages.
  useEffect(()=>{if(!awaitingReply)return;const poll=setInterval(d.reload,REPLY_POLL_MS);return()=>clearInterval(poll);},[awaitingReply,d.reload]);
  const log=useRef<HTMLDivElement>(null),pinned=useRef(true),anchor=useRef<number|undefined>(undefined);
  useLayoutEffect(()=>{
    const element=log.current;if(!element)return;
    if(anchor.current!==undefined){element.scrollTop=element.scrollHeight-anchor.current;anchor.current=undefined;}
    else if(pinned.current)element.scrollTop=element.scrollHeight;
  },[last?.messageId,items.length]);
  const lastOwn=[...items].reverse().find(item=>item.author==='user');
  const replied=Boolean(lastOwn&&items.some(item=>item.author==='director'&&item.seq>lastOwn.seq));
  return <section data-component="DirectorChat" aria-label="Trò chuyện với Director" className="m-0 flex h-[calc(100dvh-20rem)] min-h-[26rem] min-w-0 flex-col bg-surface lg:h-[calc(100dvh-15rem)]">
    <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-steel font-data font-semibold text-surface">D</span>
      <div className="min-w-0 grow basis-40"><h2 className="m-0 truncate text-base">Director</h2><DirectorPresenceStatus compact/></div>
      <button type="button" onClick={()=>{d.reload();void transcript.refresh();}}>Đọc lại hội thoại</button>
    </header>
    <div ref={log} role="log" aria-label="Tin nhắn với Director" aria-busy={transcript.loading} tabIndex={0} onScroll={event=>{const e=event.currentTarget;pinned.current=e.scrollHeight-e.scrollTop-e.clientHeight<80;}} className="min-h-0 grow overflow-y-auto bg-canvas px-4 py-3">
      {!transcript.loaded&&<LoadingState loading={transcript.loading||!transcript.error} initial label="Đang đọc hội thoại Director…"/>}
      {Boolean(transcript.error)&&<p role="alert" className="my-2 border-l-3 border-warning pl-3 text-sm">Chưa đọc được hội thoại Director. {transcript.loaded?'Các tin bên dưới có thể đã cũ. ':''}Đọc lại hội thoại hoặc kiểm tra phiên dự án.</p>}
      {d.view?.cliCaptureMayBeIncomplete&&<p className="my-2 text-center text-xs text-muted">Trao đổi gõ trực tiếp trong terminal của Director có thể chưa được ghi đầy đủ ở đây.</p>}
      {transcript.hasOlder&&<div className="text-center"><button type="button" disabled={transcript.loadingOlder} onClick={()=>{const e=log.current;if(e)anchor.current=e.scrollHeight-e.scrollTop;void transcript.loadOlder();}}>{transcript.loadingOlder?'Đang đọc tin cũ…':'Xem tin cũ hơn'}</button></div>}
      {Boolean(transcript.olderError)&&<p role="alert" className="text-center text-xs text-warning">Chưa đọc được tin cũ hơn. Thử lại sau.</p>}
      {transcript.loaded&&!items.length&&<p className="mx-auto text-center text-sm text-muted">Chưa có tin nhắn với Director.</p>}
      <ol className="m-0 flex list-none flex-col gap-2 p-0">{items.map((item,index)=><Bubble key={item.seq} item={item} previous={items[index-1]} note={item.messageId===lastOwn?.messageId&&!replied?ownNote[d.presence]:undefined}/>)}</ol>
    </div>
    <DirectorComposer transcript={transcript} initialDraft={initialDraft}/>
  </section>;
}
function Bubble({item,previous,note}:{item:DirectorMessage;previous:DirectorMessage|undefined;note:string|undefined}){
  const own=item.author==='user';
  return <li className="min-w-0">
    {(!previous||day(previous.at)!==day(item.at))&&<p className="mx-auto my-3 text-center font-data text-xs text-muted">{day(item.at)}</p>}
    <div className={`flex flex-col ${own?'items-end':'items-start'}`}>
      <p className={`m-0 max-w-[85%] rounded-2xl px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere] sm:max-w-[70%] ${own?'rounded-br-sm bg-steel text-surface':'rounded-bl-sm bg-faint'}`}>{item.text}</p>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-data text-xs text-muted">
        <span>{own?'Bạn':'Director'}</span>
        <time dateTime={item.at} title={new Date(item.at).toLocaleString('vi')}>{clock(item.at)}</time>
        {own&&item.channel==='cli'&&<span>Từ terminal</span>}
      </div>
      {note&&<p className="m-0 max-w-[85%] text-right text-xs text-muted sm:max-w-[70%]">{note}</p>}
    </div>
  </li>;
}

type Pending={messageId:string};
function readPending(key:string):Pending|undefined{
  const raw=localStorage.getItem(key);if(!raw)return;
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='messageId,version'||(value as {version?:unknown}).version!==1||typeof (value as {messageId?:unknown}).messageId!=='string'||!/^[-a-f0-9]{36}$/i.test((value as {messageId:string}).messageId))throw Error('Invalid Director chat recovery metadata');
  return {messageId:(value as {messageId:string}).messageId};
}
const PENDING_NOTICE='Đang có tin nhắn trước chờ đối chiếu kết quả gửi. Bấm “Đối chiếu tin nhắn” để kiểm tra; không tự gửi lại.';
const CORRUPT_NOTICE='Dữ liệu đối chiếu cục bộ bị hỏng. Kiểm tra hội thoại rồi mở khóa khung soạn tin nếu cần; không tự gửi lại.';
/**
 * Only the message ID survives a lost ACK (localStorage, project-scoped so it survives a host restart); the content stays in memory.
 * Recovery observes the transcript for that ID, or, in this same tab, resends the identical payload under the original ID, which the
 * host treats idempotently (same ID + payload → same seq). Nothing is ever resent automatically.
 */
function DirectorComposer({transcript,initialDraft}:{transcript:DirectorTranscript;initialDraft:string}){
  const d=useDirector(),{api,projectId}=d,key=JSON.stringify(['bflow-director-chat',projectId]);
  const status=()=>{try{return {pending:Boolean(readPending(key)),corrupt:false};}catch{return {pending:true,corrupt:true};}};
  const [draft,setDraft]=useState(initialDraft),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(()=>status().pending),[canUnlock,setCanUnlock]=useState(()=>status().corrupt);
  const [notice,setNotice]=useState(()=>{const s=status();return s.corrupt?CORRUPT_NOTICE:s.pending?PENDING_NOTICE:'';});
  const memory=useRef<WebChatSend|undefined>(undefined),input=useRef<HTMLTextAreaElement>(null);
  const tooLarge=new TextEncoder().encode(draft).byteLength>WEB_LIMITS.chatBytes;
  const canSend=d.chat.canSend&&!busy&&!uncertain&&!tooLarge&&Boolean(draft.trim());
  const settle=(message:DirectorMessage)=>{localStorage.removeItem(key);memory.current=undefined;setUncertain(false);setCanUnlock(false);setDraft('');setNotice('');transcript.append(message);};
  async function deliver(body:WebChatSend){
    try{settle(await api.sendDirectorMessage(body));}
    catch(error){
      if(error instanceof ApiError&&DEFINITIVE.has(error.code)){localStorage.removeItem(key);memory.current=undefined;setUncertain(false);setCanUnlock(false);setNotice(explain(error));return;}
      setNotice('Chưa xác định được kết quả gửi. Đối chiếu tin nhắn gốc hoặc gửi lại với cùng mã tin; Bflow không tự gửi lại.');
    }
  }
  const locked=async(work:()=>Promise<void>)=>{
    if(busy)return;setBusy(true);
    try{if(!navigator.locks)throw Error('Browser locks unavailable');await navigator.locks.request(key,work);}
    catch{setNotice('Chưa thực hiện được thao tác với tin nhắn. Kiểm tra kết nối; không có tin nào được tự gửi lại.');}
    finally{setBusy(false);}
  };
  async function submit(event:FormEvent){event.preventDefault();if(!canSend||!d.chat.sessionId)return;const sessionId=d.chat.sessionId;
    await locked(async()=>{
      if(readPending(key)){setUncertain(true);setNotice(PENDING_NOTICE);return;}
      const body=WebHttpContracts.sendDirectorMessage.body.parse({apiVersion:1,messageId:crypto.randomUUID(),projectId,sessionId,content:draft});
      localStorage.setItem(key,JSON.stringify({version:1,messageId:body.messageId}));memory.current=body;setUncertain(true);setNotice('');
      await deliver(body);
    });
    input.current?.focus();
  }
  async function resend(){await locked(async()=>{
    const pending=readPending(key),body=memory.current;
    if(!pending||!body||body.messageId!==pending.messageId){setNotice(PENDING_NOTICE);return;}
    await deliver(body);
  });}
  async function reconcile(){await locked(async()=>{
    let pending:Pending|undefined;
    try{pending=readPending(key);}catch{setCanUnlock(true);setNotice(CORRUPT_NOTICE);return;}
    if(!pending){setUncertain(false);setCanUnlock(false);setNotice('');return;}
    try{
      let cursor:string|undefined,complete=false;
      for(let page=0;page<RECONCILE_PAGES;page++){
        const value=await api.directorMessages(projectId,cursor);
        const found=value.items.find(item=>item.messageId===pending!.messageId&&item.author==='user'&&item.channel==='web');
        if(found){localStorage.removeItem(key);memory.current=undefined;setUncertain(false);setCanUnlock(false);setDraft('');setNotice('Đã tìm thấy tin nhắn gốc trong hội thoại. Không gửi lại tin này.');transcript.append(found);return;}
        const first=value.items[0]?.seq;
        // Latest page has no backward cursor: page older with b<first-seq>; an older page without nextCursor is the oldest.
        if(first===undefined||first<=1||(cursor?.startsWith('b')&&!value.nextCursor)){complete=true;break;}
        cursor=`b${first}`;
      }
      if(complete){setCanUnlock(true);setNotice('Đã đối chiếu toàn bộ hội thoại hiện có nhưng không thấy tin này (có thể yêu cầu bị gián đoạn trước khi tới host). Bạn có thể gửi lại với cùng mã tin hoặc mở khóa khung soạn tin; không có gì được tự gửi.');}
      else setNotice('Chưa tìm thấy kết quả xác thực. Tiếp tục đối chiếu tin nhắn gốc; không gửi lại.');
    }catch{setNotice('Chưa đối chiếu được tin nhắn gốc. Kiểm tra kết nối rồi thử lại; không gửi lại.');}
  });}
  async function unlock(){await locked(async()=>{localStorage.removeItem(key);memory.current=undefined;setUncertain(false);setCanUnlock(false);setNotice('Đã mở khóa khung soạn tin; bản nháp được giữ lại và không có tin nào được tự gửi.');});}
  // Enter sends; an IME still composing Vietnamese text keeps Enter for itself.
  function keyDown(event:KeyboardEvent<HTMLTextAreaElement>){if(event.key!=='Enter'||event.shiftKey||event.nativeEvent.isComposing)return;event.preventDefault();event.currentTarget.form?.requestSubmit();}
  const block=d.chat.block;
  return <form onSubmit={submit} className="min-w-0 border-t border-line bg-surface px-4 py-3" aria-busy={busy}>
    {block&&<p id="director-chat-blocked" className="mt-0 mb-2 border-l-3 border-warning pl-3 text-sm">{blockText[block]}</p>}
    {!block&&d.presence==='absent'&&<p className="mt-0 mb-2 border-l-3 border-line pl-3 text-xs text-muted">Tin gửi lúc này được giữ lại cho tới khi Director mở phiên.</p>}
    {tooLarge&&<p role="alert" className="mt-0 mb-2 text-sm text-danger">Tin nhắn vượt quá giới hạn 16 KiB.</p>}
    <p role="status" className="mt-0 mb-2 min-h-0 text-sm empty:hidden">{notice}</p>
    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
      <FieldLabel htmlFor="director-draft" className="mb-0" labelClassName="font-data text-xs font-medium text-muted" label="Tin nhắn cho Director"
        help="Giao việc, hỏi tiến độ hoặc trao đổi với Director của dự án. Enter để gửi, Shift+Enter để xuống dòng."/>
      <span className="hidden font-data text-xs text-muted lg:inline">Enter để gửi · Shift+Enter để xuống dòng</span>
    </div>
    <div className="flex items-end gap-2">
      <textarea ref={input} id="director-draft" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={keyDown} readOnly={busy} disabled={Boolean(block)||(uncertain&&!busy)} aria-describedby={block?'director-chat-blocked':'director-chat-approval'} rows={1} placeholder={block?'Chưa gửi được tin lúc này':'Nhập tin nhắn…'} className="max-h-40 min-h-11 resize-none rounded-2xl px-4 lg:min-h-9"/>
      <button type="submit" aria-label="Gửi tin nhắn" disabled={!canSend} className="min-w-16 shrink-0 rounded-full border-steel bg-steel px-4 text-surface hover:bg-ink">{busy?'Đang gửi…':'Gửi'}</button>
    </div>
    <p id="director-chat-approval" className="mt-1.5 mb-0 text-xs text-muted">Tin nhắn trò chuyện không phải là phê duyệt. Duyệt hoặc từ chối chỉ thực hiện bằng thẻ quyết định trên trang công việc.</p>
    {uncertain&&<div className="mt-1.5 flex flex-wrap justify-end gap-2">
      {canUnlock&&<button type="button" disabled={busy} onClick={()=>void unlock()}>Mở khóa khung soạn tin</button>}
      {memory.current&&<button type="button" disabled={busy} onClick={()=>void resend()}>Gửi lại với cùng mã tin</button>}
      <button type="button" disabled={busy} onClick={()=>void reconcile()}>Đối chiếu tin nhắn</button>
    </div>}
  </form>;
}
