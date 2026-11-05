import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { WebHttpContracts, WEB_LIMITS, type DirectorMessage, type WebChatSend } from '@bflow/contracts/web';
import { ApiError, explain } from '../../api/client';
import { FieldLabel } from '../../components/FieldHelp';
import { useDirector, type DirectorChatBlock, type DirectorPresenceState } from './status';
import { useDirectorTranscript, type DirectorTranscript } from './transcript';
import { immersiveOfficeEnabled } from '../office/immersive';

const DEFINITIVE=new Set(['invalid_request','forbidden','session_required','not_found','stale_version','operation_not_allowed','payload_too_large']);
const RECONCILE_PAGES=60;
const blockText:Record<DirectorChatBlock,string>={unknown:'Chưa xác nhận được phiên Director nên chưa gửi được tin. Tải lại dữ liệu hoặc kiểm tra phiên dự án.',legacy:'Phiên này dùng bố cục cũ (v2); trò chuyện Director không dùng được.',host_not_ready:'Phiên chưa sẵn sàng; tin chưa gửi được. Bấm Khởi động phiên để mở Director.',session_mismatch:'Phiên làm việc vừa đổi. Đang cập nhật trước khi cho gửi tin.'};
const ownNote:Record<DirectorPresenceState,string>={absent:'Đã lưu vào hội thoại; Director sẽ đọc khi mở phiên.',active:'Đã lưu vào hội thoại; đang chờ Director trả lời.',waiting:'Đã lưu vào hội thoại; đang chờ Director trả lời.',unknown:'Đã lưu vào hội thoại.'};
const PENDING_NOTICE='Đang có tin nhắn trước chờ đối chiếu kết quả gửi. Bấm “Đối chiếu tin nhắn” để kiểm tra; không tự gửi lại.';
const CORRUPT_NOTICE='Dữ liệu đối chiếu cục bộ bị hỏng. Kiểm tra hội thoại rồi mở khóa khung soạn tin nếu cần; không tự gửi lại.';
const UNCERTAIN_NOTICE='Chưa xác định được kết quả gửi. Bấm “Đối chiếu tin nhắn” để tìm tin gốc; Bflow không tự gửi lại.';
const SESSION_CHANGED_NOTICE='Không xác định được tin nhắn trước: phiên host đã đổi nên không đối chiếu được với hội thoại cũ và không gửi lại được bằng mã cũ. Bản nháp vẫn được giữ; bạn tự quyết định bỏ qua tin này.';

type Pending={messageId:string;sessionId:string|undefined};
const isId=(value:unknown):value is string=>typeof value==='string'&&/^[-a-f0-9]{36}$/i.test(value);
const draftKey=(projectId:string)=>`bflow:immersive-office:director-draft:v1:${encodeURIComponent(projectId)}`;
function readDraft(projectId:string):string {
  try {
    if(!immersiveOfficeEnabled())return '';
    const raw=sessionStorage.getItem(draftKey(projectId));if(!raw||raw.length>WEB_LIMITS.chatBytes*2+512)return '';
    const value:unknown=JSON.parse(raw);
    if(!value||typeof value!=='object'||(value as {version?:unknown}).version!==1||(value as {projectId?:unknown}).projectId!==projectId)return '';
    const content=(value as {content?:unknown}).content;
    return typeof content==='string'&&new TextEncoder().encode(content).byteLength<=WEB_LIMITS.chatBytes*2?content:'';
  } catch { return ''; }
}
function saveDraft(projectId:string,content:string):void {
  try {
    if(!immersiveOfficeEnabled())return;
    if(!content){sessionStorage.removeItem(draftKey(projectId));return;}
    const serialized=JSON.stringify({version:1,projectId,content});
    if(new TextEncoder().encode(content).byteLength<=WEB_LIMITS.chatBytes*2&&serialized.length<=WEB_LIMITS.chatBytes*2+512)sessionStorage.setItem(draftKey(projectId),serialized);
  } catch { /* Draft editing remains available when session storage is blocked or full. */ }
}
function readPending(key:string):Pending|undefined {
  const raw=localStorage.getItem(key);if(!raw)return;
  const value=JSON.parse(raw) as Record<string,unknown>|null;
  const keys=value&&typeof value==='object'?Object.keys(value).sort().join(','):'';
  if(value&&keys==='messageId,version'&&value.version===1&&isId(value.messageId))return {messageId:value.messageId,sessionId:undefined};
  if(value&&keys==='messageId,sessionId,version'&&value.version===2&&isId(value.messageId)&&typeof value.sessionId==='string'&&value.sessionId.length>0&&value.sessionId.length<=200)return {messageId:value.messageId,sessionId:value.sessionId};
  throw Error('Invalid Director chat recovery metadata');
}

type Stored={pending:Pending|undefined;corrupt:boolean};
type Controller={d:ReturnType<typeof useDirector>;transcript:DirectorTranscript;draft:string;setDraft:React.Dispatch<React.SetStateAction<string>>;initialDraft:(value:string,handoffKey?:string)=>void;immersive:boolean;busy:boolean;stored:Stored;scanAbsent:boolean;canUnlock:boolean;canResend:boolean;notice:string;focusTarget:{target:'input'|'recovery';n:number}|undefined;pending:Pending|undefined;uncertain:boolean;sessionChanged:boolean;tooLarge:boolean;canSend:boolean;submit:(event:FormEvent)=>void;keyDown:(event:KeyboardEvent<HTMLTextAreaElement>)=>void;resend:()=>void;reconcile:()=>void;unlock:()=>void;blockText:Record<DirectorChatBlock,string>;ownNote:Record<DirectorPresenceState,string>};
const ControllerContext=createContext<Controller|undefined>(undefined);
export function useDirectorChatController():Controller {const value=useContext(ControllerContext);if(!value)throw new Error('DirectorChat must be inside DirectorChatControllerProvider');return value;}

/** One project-scoped sender/recovery controller lives above Routes and visual/classic switches. Presentations only subscribe to it. */
export function DirectorChatControllerProvider({children,active=false}:{children:ReactNode;active?:boolean}) {
  const d=useDirector(),transcript=useDirectorTranscript(active&&(d.layout==='director'||d.layout==='not_started'));
  const controller=useController(d,transcript,false);
  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>;
}

function useController(d:ReturnType<typeof useDirector>,transcript:DirectorTranscript,immersive:boolean) {
  const {api,projectId}=d,key=JSON.stringify(['bflow-director-chat',projectId]);
  const load=():Stored=>{try{return {pending:readPending(key),corrupt:false};}catch{return {pending:undefined,corrupt:true};}};
  const [draft,setDraft]=useState(()=>readDraft(projectId)),[busy,setBusy]=useState(false),[stored,setStored]=useState(load);
  const [scanAbsent,setScanAbsent]=useState(false),[canUnlock,setCanUnlock]=useState(()=>stored.corrupt),[notice,setNotice]=useState(()=>stored.corrupt?CORRUPT_NOTICE:stored.pending?PENDING_NOTICE:'');
  const [focusTarget,setFocusTarget]=useState<{target:'input'|'recovery';n:number}>();
  const memory=useRef<WebChatSend|undefined>(undefined),draftNow=useRef(draft),latestSession=useRef(d.chat.sessionId),inFlight=useRef(false);
  const appliedDraftHandoffs=useRef(new Set<string>());
  draftNow.current=draft;latestSession.current=d.chat.sessionId;
  useEffect(()=>saveDraft(projectId,draft),[projectId,draft]);
  const pending=stored.pending,uncertain=stored.corrupt||Boolean(pending);
  const currentSession=d.error===undefined&&d.view?.layout==='director'?d.view.sessionId:undefined;
  const sessionChanged=Boolean(pending&&currentSession!==undefined&&pending.sessionId!==currentSession);
  const canResend=Boolean(scanAbsent&&memory.current&&memory.current.messageId===pending?.messageId&&memory.current.sessionId===pending?.sessionId);
  const tooLarge=new TextEncoder().encode(draft).byteLength>WEB_LIMITS.chatBytes;
  const canSend=d.chat.canSend&&!busy&&!uncertain&&!tooLarge&&Boolean(draft.trim());
  const focus=(target:'input'|'recovery')=>setFocusTarget(old=>({target,n:(old?.n??0)+1}));
  const release=()=>{localStorage.removeItem(key);memory.current=undefined;setStored({pending:undefined,corrupt:false});setScanAbsent(false);setCanUnlock(false);};
  const settle=(message:DirectorMessage,submittedText:string)=>{release();setDraft(current=>current===submittedText?'':current);setNotice('');transcript.append(message);focus('input');};
  async function deliver(body:WebChatSend,first:boolean) {
    try{const message=await api.sendDirectorMessage(body);if(latestSession.current!==body.sessionId){setNotice(SESSION_CHANGED_NOTICE);return;}settle(message,body.content);}
    catch(error){if(error instanceof ApiError&&DEFINITIVE.has(error.code)){if(first){release();setNotice(explain(error));focus('input');return;}setScanAbsent(false);setNotice(`Gửi lại bị từ chối: ${explain(error)} Tin gốc có thể đã được lưu; bấm “Đối chiếu tin nhắn” để kiểm tra trước.`);focus('recovery');return;}setScanAbsent(false);setNotice(UNCERTAIN_NOTICE);focus('recovery');}
  }
  const locked=async(work:()=>Promise<void>)=>{if(inFlight.current)return;inFlight.current=true;setBusy(true);try{if(!navigator.locks)throw Error('Browser locks unavailable');await navigator.locks.request(key,work);}catch{setNotice('Chưa thực hiện được thao tác với tin nhắn. Kiểm tra kết nối; không có tin nào được tự gửi lại.');}finally{inFlight.current=false;setBusy(false);}};
  async function submit(event:FormEvent) {event.preventDefault();if(!canSend||!d.chat.sessionId)return;const sessionId=d.chat.sessionId;await locked(async()=>{const current=load();if(current.pending||current.corrupt){setStored(current);setNotice(current.corrupt?CORRUPT_NOTICE:PENDING_NOTICE);return;}const body=WebHttpContracts.sendDirectorMessage.body.parse({apiVersion:1,messageId:crypto.randomUUID(),projectId,sessionId,content:draft});localStorage.setItem(key,JSON.stringify({version:2,messageId:body.messageId,sessionId}));memory.current=body;setStored({pending:{messageId:body.messageId,sessionId},corrupt:false});setScanAbsent(false);setNotice('');await deliver(body,true);});}
  async function resend() {await locked(async()=>{const current=load(),body=memory.current;if(!current.pending||!body||body.messageId!==current.pending.messageId||body.sessionId!==current.pending.sessionId||current.pending.sessionId!==currentSession||!scanAbsent){setScanAbsent(false);setNotice(PENDING_NOTICE);return;}await deliver(body,false);});}
  async function reconcile() {await locked(async()=>{const current=load();setStored(current);if(current.corrupt){setCanUnlock(true);setNotice(CORRUPT_NOTICE);return;}const target=current.pending;if(!target){setNotice('');return;}if(currentSession===undefined){setNotice('Chưa đọc được phiên Director hiện tại nên chưa đối chiếu được. Thử lại sau; không gửi lại.');return;}if(target.sessionId!==currentSession){setCanUnlock(true);setNotice(SESSION_CHANGED_NOTICE);return;}try{let cursor:string|undefined,complete=false;for(let page=0;page<RECONCILE_PAGES;page++){const value=await api.directorMessages(projectId,cursor);if(latestSession.current!==target.sessionId){setNotice(SESSION_CHANGED_NOTICE);return;}const found=value.items.find(item=>item.messageId===target.messageId&&item.author==='user'&&item.channel==='web');if(found){const sentText=memory.current?.content;release();if(sentText!==undefined)setDraft(currentDraft=>currentDraft===sentText?'':currentDraft);setNotice('Đã tìm thấy tin nhắn gốc trong hội thoại. Không gửi lại tin này.');transcript.append(found);return;}const first=value.items[0]?.seq;if(first===undefined||first<=1||(cursor?.startsWith('b')&&!value.nextCursor)){complete=true;break;}cursor=`b${first}`;}if(complete){setScanAbsent(true);setCanUnlock(true);setNotice(`Đã đối chiếu toàn bộ hội thoại của phiên này nhưng không thấy tin (có thể yêu cầu bị gián đoạn trước khi tới host). ${memory.current?.messageId===target.messageId?'Bạn có thể gửi lại với cùng mã tin hoặc mở khóa khung soạn tin':'Bạn có thể mở khóa khung soạn tin để gửi lại thủ công'}; không có gì được tự gửi.`);}else{setScanAbsent(false);setNotice('Chưa tìm thấy kết quả xác thực. Tiếp tục đối chiếu tin nhắn gốc; không gửi lại.');}}catch{setScanAbsent(false);setNotice('Chưa đối chiếu được tin nhắn gốc. Kiểm tra kết nối rồi thử lại; không gửi lại.');}});}
  async function unlock() {await locked(async()=>{release();setNotice('Đã bỏ qua tin chưa xác định và mở khóa khung soạn tin; bản nháp được giữ lại và không có tin nào được tự gửi.');focus('input');});}
  const keyDown=(event:KeyboardEvent<HTMLTextAreaElement>)=>{if(event.key!=='Enter'||event.shiftKey||event.nativeEvent.isComposing)return;event.preventDefault();event.currentTarget.form?.requestSubmit();};
  const initialDraft=(value:string,handoffKey='')=>{if(!value||!handoffKey||appliedDraftHandoffs.current.has(handoffKey))return;appliedDraftHandoffs.current.add(handoffKey);setDraft(current=>current.trim()?`${current}\n\n${value}`:value);};
  return {d,transcript,draft,setDraft,initialDraft,immersive,busy,stored,scanAbsent,canUnlock,canResend,notice,focusTarget,pending,uncertain,sessionChanged,tooLarge,canSend,submit,keyDown,resend:()=>void resend(),reconcile:()=>void reconcile(),unlock:()=>void unlock(),blockText,ownNote};
}

export function DirectorChatComposer({initialDraft='',handoffKey='',immersive=false}:{initialDraft?:string;handoffKey?:string;immersive?:boolean}) {
  const c=useDirectorChatController(),input=useRef<HTMLTextAreaElement|null>(null),recovery=useRef<HTMLButtonElement|null>(null);
  useEffect(()=>{c.initialDraft(initialDraft,handoffKey);},[initialDraft,handoffKey]);
  useEffect(()=>{if(!c.focusTarget)return;(c.focusTarget.target==='recovery'?recovery.current:input.current)?.focus();},[c.focusTarget]);
  const d=c.d,block=d.chat.block;
  return <form onSubmit={c.submit} className={`shrink-0 min-w-0 border-t border-line bg-surface px-4 py-3 ${immersive?'max-[480px]:px-2 max-[480px]:py-1':''}`} aria-busy={c.busy}>
    {(immersive||c.immersive)&&<details className="director-chat-suggestions mb-3"><summary className="min-h-10 cursor-pointer rounded-lg border border-line px-3 py-2 text-sm font-medium">Gợi ý trò chuyện</summary><div className={`mt-2 flex flex-wrap gap-2 ${immersive?'max-[480px]:mt-1 max-[480px]:gap-1':''}`} aria-label="Gợi ý trò chuyện">{([
      ['Giao việc','Tôi muốn giao việc: …\nMục tiêu: …\nTiêu chí chấp nhận: …'],['Hỏi tiến độ','Cho tôi biết tiến độ công việc gần nhất và bước tiếp theo.'],['Giải thích việc đang chờ','Vì sao công việc đang chờ? Tôi cần biết ai cần hành động và còn thiếu điều gì.'],
    ] as const).map(([label,text])=><button key={label} type="button" className={`min-h-11 ${immersive?'max-[480px]:min-h-9 max-[480px]:px-2 max-[480px]:py-1':''}`} disabled={c.busy||c.uncertain||Boolean(c.draft.trim())} onClick={()=>{c.setDraft(text);input.current?.focus();}}>{label}</button>)}</div></details>}
    {block&&<p id="director-chat-blocked" className="mt-0 mb-2 border-l-3 border-warning pl-3 text-sm">{c.blockText[block]}</p>}
    {!block&&d.presence==='absent'&&<p className="mt-0 mb-2 border-l-3 border-line pl-3 text-xs text-muted">Tin gửi lúc này được giữ lại cho tới khi Director mở phiên.</p>}
    {c.tooLarge&&<p role="alert" className="mt-0 mb-2 text-sm text-danger">Tin nhắn vượt quá giới hạn 16 KiB.</p>}
    {!immersive&&<p role="status" className="mt-0 mb-2 min-h-0 text-sm empty:hidden">{c.sessionChanged&&!c.notice?SESSION_CHANGED_NOTICE:c.notice}</p>}
    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2"><FieldLabel htmlFor="director-draft" className="mb-0" labelClassName="font-data text-xs font-medium text-muted" label="Tin nhắn cho Director" help="Giao việc, hỏi tiến độ hoặc trao đổi với Director của dự án. Enter để gửi, Shift+Enter để xuống dòng."/><span className="hidden font-data text-xs text-muted lg:inline">Enter để gửi · Shift+Enter để xuống dòng</span></div>
    <div className="flex items-end gap-2"><textarea ref={input} id="director-draft" value={c.draft} onChange={e=>c.setDraft(e.target.value)} onKeyDown={c.keyDown} readOnly={c.busy} disabled={Boolean(block)||(c.uncertain&&!c.busy)} aria-describedby={block?'director-chat-blocked':'director-chat-approval'} rows={2} placeholder={block?'Chưa gửi được tin lúc này':'Nhập tin nhắn…'} className="max-h-40 min-h-11 resize-none rounded-2xl px-4 lg:min-h-9"/><button type="submit" aria-label="Gửi tin nhắn" disabled={!c.canSend} className="min-w-16 shrink-0 rounded-full border-steel bg-steel px-4 text-surface hover:bg-ink">{c.busy?'Đang gửi…':'Gửi'}</button></div>
    <p id="director-chat-approval" className={`mt-1.5 mb-0 text-xs text-muted ${immersive?'max-[480px]:mt-0 max-[480px]:leading-tight':''}`}>Để phê duyệt, dùng nút Duyệt ở trang công việc. Tin nhắn không thay thế việc phê duyệt.</p>
    {c.uncertain&&<div className="mt-1.5 flex flex-wrap justify-end gap-2">{c.sessionChanged&&!c.stored.corrupt?<><p className="m-0 basis-full text-right text-xs text-warning">Không xác định, phiên đã đổi.</p><button ref={recovery} type="button" disabled={c.busy} onClick={c.unlock}>Bỏ qua tin chưa xác định</button></>:<>{c.canUnlock&&<button type="button" disabled={c.busy} onClick={c.unlock}>Mở khóa khung soạn tin</button>}{c.canResend&&<button type="button" disabled={c.busy} onClick={c.resend}>Gửi lại với cùng mã tin</button>}<button ref={recovery} type="button" disabled={c.busy} onClick={c.reconcile}>Đối chiếu tin nhắn</button></>}</div>}
    {immersive&&<p role="status" className="mt-1 mb-0 min-h-0 text-xs empty:hidden">{c.sessionChanged&&!c.notice?SESSION_CHANGED_NOTICE:c.notice}</p>}
  </form>;
}
