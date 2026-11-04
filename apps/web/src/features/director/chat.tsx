import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { WebHttpContracts, WEB_LIMITS, type DirectorMessage, type WebChatSend } from '@bflow/contracts/web';
import { ApiError, explain } from '../../api/client';
import { FieldLabel } from '../../components/FieldHelp';
import { LoadingState } from '../../components/LoadingState';
import { DirectorPresenceStatus, useDirector, type DirectorChatBlock, type DirectorPresenceState } from './status';
import { useDirectorTranscript, type DirectorTranscript } from './transcript';
import { DirectorLaunch } from './launch';

/**
 * Refusals proven to precede any write on the FIRST attempt (the ID is then released). Same set as the legacy chat composer
 * (chat/composer.tsx). CommandStore (api/commands.ts) keeps its own set without `not_found` for command receipts; here a 404
 * comes from Local Server project resolution, which runs before the host append (local-server director.ts `requireProject`).
 */
const DEFINITIVE=new Set(['invalid_request','forbidden','session_required','not_found','stale_version','operation_not_allowed','payload_too_large']);
const REPLY_WINDOW_MS=5*60*1000,REPLY_POLL_MS=5000,RECONCILE_PAGES=60;
const blockText:Record<DirectorChatBlock,string>={
  unknown:'Chưa xác nhận được phiên Director nên chưa gửi được tin. Tải lại dữ liệu hoặc kiểm tra phiên dự án.',
  legacy:'Phiên này dùng bố cục cũ (v2); trò chuyện Director không dùng được.',
  host_not_ready:'Phiên chưa sẵn sàng; tin chưa gửi được. Bấm Khởi động phiên để mở Director.',
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
      <DirectorLaunch label="Khởi động phiên"/>
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

/** `sessionId`: the host session whose Director store holds the message; the host dedups a message ID only within that store. */
type Pending={messageId:string;sessionId:string|undefined};
const isId=(value:unknown):value is string=>typeof value==='string'&&/^[-a-f0-9]{36}$/i.test(value);
function readPending(key:string):Pending|undefined{
  const raw=localStorage.getItem(key);if(!raw)return;
  const value=JSON.parse(raw) as Record<string,unknown>|null;
  const keys=value&&typeof value==='object'?Object.keys(value).sort().join(','):'';
  // Version 1 (no session) predates per-session dedup: its session is unknown, so it is treated as a changed session.
  if(value&&keys==='messageId,version'&&value.version===1&&isId(value.messageId))return {messageId:value.messageId,sessionId:undefined};
  if(value&&keys==='messageId,sessionId,version'&&value.version===2&&isId(value.messageId)&&typeof value.sessionId==='string'&&value.sessionId.length>0&&value.sessionId.length<=200)
    return {messageId:value.messageId,sessionId:value.sessionId};
  throw Error('Invalid Director chat recovery metadata');
}
const PENDING_NOTICE='Đang có tin nhắn trước chờ đối chiếu kết quả gửi. Bấm “Đối chiếu tin nhắn” để kiểm tra; không tự gửi lại.';
const CORRUPT_NOTICE='Dữ liệu đối chiếu cục bộ bị hỏng. Kiểm tra hội thoại rồi mở khóa khung soạn tin nếu cần; không tự gửi lại.';
const UNCERTAIN_NOTICE='Chưa xác định được kết quả gửi. Bấm “Đối chiếu tin nhắn” để tìm tin gốc; Bflow không tự gửi lại.';
const SESSION_CHANGED_NOTICE='Không xác định được tin nhắn trước: phiên host đã đổi nên không đối chiếu được với hội thoại cũ và không gửi lại được bằng mã cũ. Bản nháp vẫn được giữ; bạn tự quyết định bỏ qua tin này.';
/**
 * Only the message ID and its host session survive a lost ACK (localStorage, project-scoped); the content stays in memory.
 * Recovery first observes the current session's transcript for that ID. Only after a complete scan of the same session did not find
 * it may this tab resend the identical payload under the original ID (the host dedups same ID + payload within one session store).
 * A definitive refusal releases the ID only on the first attempt; on a resend the original may already be stored, so the ID is kept.
 * When the host session changed, the old store cannot be observed: the user explicitly dismisses the pending item. Nothing is ever
 * resent automatically.
 */
function DirectorComposer({transcript,initialDraft}:{transcript:DirectorTranscript;initialDraft:string}){
  const d=useDirector(),{api,projectId}=d,key=JSON.stringify(['bflow-director-chat',projectId]);
  const load=():{pending:Pending|undefined;corrupt:boolean}=>{try{return {pending:readPending(key),corrupt:false};}catch{return {pending:undefined,corrupt:true};}};
  const [draft,setDraft]=useState(initialDraft),[busy,setBusy]=useState(false);
  const [stored,setStored]=useState(load);
  const [scanAbsent,setScanAbsent]=useState(false),[canUnlock,setCanUnlock]=useState(()=>stored.corrupt);
  const [notice,setNotice]=useState(()=>stored.corrupt?CORRUPT_NOTICE:stored.pending?PENDING_NOTICE:'');
  const [focusTarget,setFocusTarget]=useState<{target:'input'|'recovery';n:number}>();
  const memory=useRef<WebChatSend|undefined>(undefined),input=useRef<HTMLTextAreaElement>(null),recovery=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!focusTarget)return;(focusTarget.target==='recovery'?recovery.current:input.current)?.focus();},[focusTarget]);
  const focus=(target:'input'|'recovery')=>setFocusTarget(old=>({target,n:(old?.n??0)+1}));
  const pending=stored.pending,uncertain=stored.corrupt||Boolean(pending);
  // The session the current, freshly read view names; undefined while unknown (then nothing is decided either way).
  const currentSession=d.error===undefined&&d.view?.layout==='director'?d.view.sessionId:undefined;
  const sessionChanged=Boolean(pending&&currentSession!==undefined&&pending.sessionId!==currentSession);
  const tooLarge=new TextEncoder().encode(draft).byteLength>WEB_LIMITS.chatBytes;
  const canSend=d.chat.canSend&&!busy&&!uncertain&&!tooLarge&&Boolean(draft.trim());
  const release=()=>{localStorage.removeItem(key);memory.current=undefined;setStored({pending:undefined,corrupt:false});setScanAbsent(false);setCanUnlock(false);};
  const settle=(message:DirectorMessage)=>{release();setDraft('');setNotice('');transcript.append(message);focus('input');};
  async function deliver(body:WebChatSend,first:boolean){
    try{settle(await api.sendDirectorMessage(body));}
    catch(error){
      if(error instanceof ApiError&&DEFINITIVE.has(error.code)){
        if(first){release();setNotice(explain(error));focus('input');return;}
        // A resend refusal proves nothing about the original attempt, which may already be stored: keep the ID, observe again.
        setScanAbsent(false);setNotice(`Gửi lại bị từ chối: ${explain(error)} Tin gốc có thể đã được lưu; bấm “Đối chiếu tin nhắn” để kiểm tra trước.`);focus('recovery');return;
      }
      setScanAbsent(false);setNotice(UNCERTAIN_NOTICE);focus('recovery');
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
      const current=load();if(current.pending||current.corrupt){setStored(current);setNotice(current.corrupt?CORRUPT_NOTICE:PENDING_NOTICE);return;}
      const body=WebHttpContracts.sendDirectorMessage.body.parse({apiVersion:1,messageId:crypto.randomUUID(),projectId,sessionId,content:draft});
      localStorage.setItem(key,JSON.stringify({version:2,messageId:body.messageId,sessionId}));memory.current=body;
      setStored({pending:{messageId:body.messageId,sessionId},corrupt:false});setScanAbsent(false);setNotice('');
      await deliver(body,true);
    });
  }
  async function resend(){await locked(async()=>{
    const current=load(),body=memory.current;
    if(!current.pending||!body||body.messageId!==current.pending.messageId||body.sessionId!==current.pending.sessionId||current.pending.sessionId!==currentSession||!scanAbsent){setScanAbsent(false);setNotice(PENDING_NOTICE);return;}
    await deliver(body,false);
  });}
  async function reconcile(){await locked(async()=>{
    const current=load();setStored(current);
    if(current.corrupt){setCanUnlock(true);setNotice(CORRUPT_NOTICE);return;}
    const target=current.pending;
    if(!target){setNotice('');return;}
    if(currentSession===undefined){setNotice('Chưa đọc được phiên Director hiện tại nên chưa đối chiếu được. Thử lại sau; không gửi lại.');return;}
    if(target.sessionId!==currentSession){setCanUnlock(true);setNotice(SESSION_CHANGED_NOTICE);return;}
    try{
      let cursor:string|undefined,complete=false;
      for(let page=0;page<RECONCILE_PAGES;page++){
        const value=await api.directorMessages(projectId,cursor);
        const found=value.items.find(item=>item.messageId===target.messageId&&item.author==='user'&&item.channel==='web');
        if(found){release();setDraft('');setNotice('Đã tìm thấy tin nhắn gốc trong hội thoại. Không gửi lại tin này.');transcript.append(found);return;}
        const first=value.items[0]?.seq;
        // Latest page has no backward cursor: page older with b<first-seq>; an older page without nextCursor is the oldest.
        if(first===undefined||first<=1||(cursor?.startsWith('b')&&!value.nextCursor)){complete=true;break;}
        cursor=`b${first}`;
      }
      if(complete){setScanAbsent(true);setCanUnlock(true);setNotice(`Đã đối chiếu toàn bộ hội thoại của phiên này nhưng không thấy tin (có thể yêu cầu bị gián đoạn trước khi tới host). ${memory.current?.messageId===target.messageId?'Bạn có thể gửi lại với cùng mã tin hoặc mở khóa khung soạn tin':'Bạn có thể mở khóa khung soạn tin để gửi lại thủ công'}; không có gì được tự gửi.`);}
      else{setScanAbsent(false);setNotice('Chưa tìm thấy kết quả xác thực. Tiếp tục đối chiếu tin nhắn gốc; không gửi lại.');}
    }catch{setScanAbsent(false);setNotice('Chưa đối chiếu được tin nhắn gốc. Kiểm tra kết nối rồi thử lại; không gửi lại.');}
  });}
  async function unlock(){await locked(async()=>{release();setNotice('Đã bỏ qua tin chưa xác định và mở khóa khung soạn tin; bản nháp được giữ lại và không có tin nào được tự gửi.');focus('input');});}
  // Enter sends; an IME still composing Vietnamese text keeps Enter for itself.
  function keyDown(event:KeyboardEvent<HTMLTextAreaElement>){if(event.key!=='Enter'||event.shiftKey||event.nativeEvent.isComposing)return;event.preventDefault();event.currentTarget.form?.requestSubmit();}
  const block=d.chat.block;
  return <form onSubmit={submit} className="min-w-0 border-t border-line bg-surface px-4 py-3" aria-busy={busy}>
    {block&&<p id="director-chat-blocked" className="mt-0 mb-2 border-l-3 border-warning pl-3 text-sm">{blockText[block]}</p>}
    {!block&&d.presence==='absent'&&<p className="mt-0 mb-2 border-l-3 border-line pl-3 text-xs text-muted">Tin gửi lúc này được giữ lại cho tới khi Director mở phiên.</p>}
    {tooLarge&&<p role="alert" className="mt-0 mb-2 text-sm text-danger">Tin nhắn vượt quá giới hạn 16 KiB.</p>}
    <p role="status" className="mt-0 mb-2 min-h-0 text-sm empty:hidden">{sessionChanged&&!notice?SESSION_CHANGED_NOTICE:notice}</p>
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
      {sessionChanged&&!stored.corrupt?<>
        <p className="m-0 basis-full text-right text-xs text-warning">Không xác định, phiên đã đổi.</p>
        <button ref={recovery} type="button" disabled={busy} onClick={()=>void unlock()}>Bỏ qua tin chưa xác định</button>
      </>:<>
        {canUnlock&&<button type="button" disabled={busy} onClick={()=>void unlock()}>Mở khóa khung soạn tin</button>}
        {scanAbsent&&memory.current&&memory.current.messageId===pending?.messageId&&<button type="button" disabled={busy} onClick={()=>void resend()}>Gửi lại với cùng mã tin</button>}
        <button ref={recovery} type="button" disabled={busy} onClick={()=>void reconcile()}>Đối chiếu tin nhắn</button>
      </>}
    </div>}
  </form>;
}
