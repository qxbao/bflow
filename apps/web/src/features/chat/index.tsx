import { LoadingState } from '../../components/LoadingState';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { WebHttpContracts, type WebChatMessage } from '@bflow/contracts/web';
import { ApiClient, ApiError, projectPath } from '../../api/client';
import { useRead } from '../data';
import { ChatComposer, type PendingMessage } from './composer';

type Delivery=WebChatMessage['delivery']|'sending';
const delivery:Record<Delivery,{label:string;icon:string;tone:string}>={
  sending:{label:'Đang gửi',icon:'…',tone:'text-muted'},
  accepted:{label:'Đã tiếp nhận',icon:'✓',tone:'text-muted'},queued:{label:'Đang chờ gửi',icon:'◷',tone:'text-muted'},delivered:{label:'Đã chuyển',icon:'✓✓',tone:'text-steel'},
  unknown_delivery:{label:'Chưa rõ đã gửi',icon:'?',tone:'text-warning'},failed:{label:'Gửi thất bại',icon:'!',tone:'text-danger'},
};
const deliveryNote:Partial<Record<Delivery,string>>={
  accepted:'Máy chủ đã nhận tin; chưa chuyển tới Conversation.',queued:'Tin đang chờ tới lượt chuyển tới Conversation.',
  delivered:'Đã tới Conversation; chưa có nghĩa đã được xử lý hay công việc đã hoàn thành.',
};
const PAGE_MESSAGES=30,MAX_PAGES=20,REPLY_WINDOW_MS=5*60*1000,REPLY_POLL_MS=5000;
/** Newest first needs the tail: the API pages oldest to newest, so walk forward within a bound. */
async function readAll(read:(cursor?:string)=>Promise<{items:WebChatMessage[];nextCursor?:string|undefined}>){
  const items=new Map<string,WebChatMessage>();const seen=new Set<string>();let cursor:string|undefined,complete=false;
  for(let page=0;page<MAX_PAGES;page++){
    const value=await read(cursor);for(const item of value.items)items.set(item.messageId,item);
    if(!value.nextCursor || seen.has(value.nextCursor)){complete=!value.nextCursor;break;}
    seen.add(value.nextCursor);cursor=value.nextCursor;
  }
  return {items:[...items.values()],complete};
}
/** The user's last message is still within the window in which its delivery or a reply can change. */
function settling(last:WebChatMessage|undefined,now:number){
  return !!last&&last.sender==='user'&&last.delivery!=='failed'&&now-Date.parse(last.createdAt)<REPLY_WINDOW_MS;
}
const day=(iso:string)=>new Date(iso).toLocaleDateString('vi');
function Status({value}:{value:Delivery}){
  const status=delivery[value];
  return <span className={`inline-flex items-center gap-1 ${status.tone}`}><span aria-hidden="true">{status.icon}</span><span>{status.label}</span></span>;
}
/** Normalized session history narrowed to one run; the host rechecks send authority independently. */
export function ChatHistory({api,projectId,sessionId,runId,revision,title}:{
  api:ApiClient;projectId:string;sessionId:string;runId:string;revision:number;title?:string;
}) {
  return <RunThread key={JSON.stringify([projectId,sessionId,runId])} api={api} projectId={projectId} sessionId={sessionId} runId={runId} revision={revision} title={title}/>;
}
function RunThread({api,projectId,sessionId,runId,revision,title}:{
  api:ApiClient;projectId:string;sessionId:string;runId:string;revision:number;title?:string|undefined;
}) {
  const [reload,setReload]=useState(0),[limit,setLimit]=useState(PAGE_MESSAGES),[pending,setPending]=useState<PendingMessage>(),[clock,setClock]=useState(()=>Date.now());
  const refresh=()=>setReload(value=>value+1);
  const readPage=async(at?:string)=>{
    const query=at?`?${new URLSearchParams({cursor:at})}`:'';
    const page=await api.request(`${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages${query}`,WebHttpContracts.messages.response);
    const ids=new Set<string>();
    for(const message of page.items){
      if(message.sessionId!==sessionId || ids.has(message.messageId))throw new ApiError('invalid_response');
      ids.add(message.messageId);
    }
    return page;
  };
  const result=useRead(JSON.stringify(['chat',projectId,sessionId]),()=>readAll(readPage),revision+reload);
  const session=useRead(`chat-session:${projectId}:${sessionId}`,()=>api.sessionView(projectId),revision);
  const ready=!session.error&&session.data?.state==='ready'&&session.data.sessionId===sessionId&&!session.data.blockers.some(b=>b.code==='chat_adapter_unavailable');
  // Replies carry no runId yet, so unassigned session messages stay; only other runs' messages are hidden.
  const relevant=(result.data?.items??[]).filter(message=>message.runId===runId || message.runId===undefined);
  const shown=relevant.slice(-limit),last=relevant.at(-1);
  const unsettled=settling(last,clock);
  // Inferred, not a provider signal: Conversation holds a delivered message and has not answered yet.
  const composing=unsettled&&last?.delivery==='delivered'&&ready&&!result.error;
  const optimistic=pending&&!relevant.some(message=>message.messageId===pending.messageId)?pending:undefined;
  useEffect(()=>{
    if(!unsettled)return;
    const poll=setInterval(()=>{setClock(Date.now());setReload(value=>value+1);},REPLY_POLL_MS);
    return()=>clearInterval(poll);
  },[unsettled]);
  const log=useRef<HTMLDivElement>(null),pinned=useRef(true),anchor=useRef<number|undefined>(undefined);
  // Follows new messages only while the reader is at the bottom, and keeps position when older ones load.
  useLayoutEffect(()=>{
    const element=log.current;if(!element)return;
    if(anchor.current!==undefined){element.scrollTop=element.scrollHeight-anchor.current;anchor.current=undefined;}
    else if(pinned.current)element.scrollTop=element.scrollHeight;
  },[last?.messageId,limit,composing,optimistic?.messageId,result.data===undefined]);
  const lastOwn=shown.filter(message=>message.sender==='user').at(-1)?.messageId;
  return <section className="m-0 flex h-[calc(100dvh-20rem)] lg:h-[calc(100dvh-15rem)] min-h-[26rem] min-w-0 flex-col bg-surface" aria-label="Trò chuyện của công việc">
    <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-steel font-data font-semibold text-surface">C</span>
      <div className="min-w-0 grow basis-40"><h2 className="m-0 truncate text-base">{title??'Conversation'}</h2><p className="m-0 font-data text-xs text-muted">{ready?'Conversation sẵn sàng nhận tin':'Conversation chưa sẵn sàng'}</p></div>
      <Link className="font-data text-sm" to={`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`}>Xem công việc →</Link>
      <button onClick={refresh}>Đọc lại lịch sử</button>
    </header>
    <div ref={log} role="log" aria-label="Tin nhắn" aria-busy={result.loading} tabIndex={0} onScroll={event=>{const e=event.currentTarget;pinned.current=e.scrollHeight-e.scrollTop-e.clientHeight<80;}} className="min-h-0 grow overflow-y-auto bg-canvas px-4 py-3">
      {!result.data&&<LoadingState loading={result.loading} initial label="Đang đọc lịch sử trò chuyện…"/>}
      {Boolean(result.error) && <p role="alert">Chưa đọc được lịch sử đã xác minh. {result.data?'Bản lịch sử bên dưới đã cũ. ':''}Đọc lại lịch sử hoặc kiểm tra phiên dự án.</p>}
      {result.data && !result.data.complete && <p className="text-center text-xs text-muted">Phiên quá dài nên chỉ đọc được phần đầu; tin mới nhất có thể chưa hiện.</p>}
      {relevant.length>shown.length && <div className="text-center"><button onClick={()=>{const e=log.current;if(e)anchor.current=e.scrollHeight-e.scrollTop;setLimit(value=>value+PAGE_MESSAGES);}}>Xem {Math.min(PAGE_MESSAGES,relevant.length-shown.length)} tin cũ hơn</button></div>}
      {result.data && !shown.length && !optimistic && <p className="mx-auto text-center text-sm text-muted">Chưa có tin nhắn trong công việc này.</p>}
      <ol className="m-0 flex list-none flex-col gap-2 p-0">{shown.map((message,index)=>{
        const own=message.sender==='user',previous=shown[index-1];
        return <li key={message.messageId} className="min-w-0">
          {(!previous||day(previous.createdAt)!==day(message.createdAt))&&<p className="mx-auto my-3 text-center font-data text-xs text-muted">{day(message.createdAt)}</p>}
          <div className={`flex flex-col ${own?'items-end':'items-start'}`}>
            {own?<p className="m-0 max-w-[85%] rounded-2xl rounded-br-sm bg-steel px-3 py-2 whitespace-pre-wrap text-surface [overflow-wrap:anywhere] sm:max-w-[70%]">{message.content}</p>:<p className="m-0 max-w-[85%] rounded-2xl rounded-bl-sm bg-faint px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere] sm:max-w-[70%]">{message.content}</p>}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-data text-xs text-muted">
              <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString('vi')}>{new Date(message.createdAt).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'})}</time>
              {message.source==='native'&&own&&<span>Từ terminal</span>}
              {own&&<Status value={message.delivery}/>}
            </div>
            {own&&message.messageId===lastOwn&&deliveryNote[message.delivery]&&<p className="m-0 max-w-[85%] text-right text-xs text-muted sm:max-w-[70%]">{deliveryNote[message.delivery]}</p>}
            {own&&message.delivery==='unknown_delivery'&&<p className="m-0 max-w-[85%] text-right text-xs text-warning sm:max-w-[70%]">Không gửi lại khi chưa đối chiếu được kết quả chuyển tin.</p>}
          </div>
        </li>;
      })}
      {optimistic&&<li className="flex min-w-0 flex-col items-end"><p className="m-0 max-w-[85%] rounded-2xl rounded-br-sm bg-steel/80 px-3 py-2 whitespace-pre-wrap text-surface [overflow-wrap:anywhere] sm:max-w-[70%]">{optimistic.content}</p><div className="mt-0.5 font-data text-xs"><Status value={optimistic.delivery}/></div></li>}
      </ol>
      {composing&&<div role="status" className="mt-2 inline-flex items-center gap-2 rounded-2xl rounded-bl-sm bg-faint px-3 py-2 font-data text-xs text-muted"><span aria-hidden="true" className="flex gap-1">{['0ms','150ms','300ms'].map(delay=><span key={delay} style={{animationDelay:delay}} className="size-1.5 animate-bounce rounded-full bg-muted"/>)}</span>Đang soạn tin</div>}
    </div>
    <ChatComposer api={api} projectId={projectId} sessionId={sessionId} runId={runId} ready={ready} sessionFresh={!session.loading} refresh={refresh} onPending={value=>{if(value)pinned.current=true;setPending(value);}}/>
  </section>;
}
