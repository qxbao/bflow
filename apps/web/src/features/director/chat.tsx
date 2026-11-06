import { useEffect, useLayoutEffect, useRef } from 'react';
import type { DirectorMessage } from '@bflow/contracts/web';
import { LoadingState } from '../../components/LoadingState';
import { DirectorPresenceStatus } from './status';
import { DirectorLaunch } from './launch';
import { DirectorChatComposer, DirectorChatControllerProvider, useDirectorChatController } from './chat-controller';
export { DirectorChatControllerProvider };

/**
 * Refusals proven to precede any write on the FIRST attempt (the ID is then released). Same set as the legacy chat composer
 * (chat/composer.tsx). CommandStore (api/commands.ts) keeps its own set without `not_found` for command receipts; here a 404
 * comes from Local Server project resolution, which runs before the host append (local-server director.ts `requireProject`).
 */
const day=(iso:string)=>new Date(iso).toLocaleDateString('vi');
const clock=(iso:string)=>new Date(iso).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'});

/** Project-scoped Director conversation. Text only; replies appear as whole messages, never as simulated typing or streaming. */
export function DirectorChat({initialDraft='',handoffKey='',immersive=false}:{initialDraft?:string;handoffKey?:string;immersive?:boolean}){
  const c=useDirectorChatController(),d=c.d,transcript=c.transcript;
  const {items}=transcript,last=items.at(-1);
  const awaitingReply=Boolean(last&&last.author==='user'&&Date.now()-Date.parse(last.at)<5*60*1000);
  // Fallback for a missed SSE signal while a reply can still arrive; it only re-reads the view and newer pages.
  useEffect(()=>{if(!awaitingReply)return;const poll=setInterval(d.reload,5000);return()=>clearInterval(poll);},[awaitingReply,d.reload]);
  const log=useRef<HTMLDivElement>(null),pinned=useRef(true),anchor=useRef<number|undefined>(undefined);
  useLayoutEffect(()=>{
    const element=log.current;if(!element)return;
    if(anchor.current!==undefined){element.scrollTop=element.scrollHeight-anchor.current;anchor.current=undefined;}
    else if(pinned.current)element.scrollTop=element.scrollHeight;
  },[last?.messageId,items.length]);
  const lastOwn=[...items].reverse().find(item=>item.author==='user');
  const replied=Boolean(lastOwn&&items.some(item=>item.author==='director'&&item.seq>lastOwn.seq));
  return <section data-component="DirectorChat" aria-label="Trò chuyện với Director" className={`chat-thread m-0 min-w-0 bg-surface ${immersive?'flex h-full min-h-0 flex-col':''}`}>
    <header className={`flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 ${immersive?'max-[480px]:gap-1 max-[480px]:px-2 max-[480px]:py-1':''}`}>
      <span aria-hidden="true" className={`flex size-10 shrink-0 items-center justify-center rounded-full bg-steel font-data font-semibold text-surface ${immersive?'max-[480px]:size-8':''}`}>D</span>
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
      {transcript.loaded&&!items.length&&(immersive?<p className="mx-auto my-8 max-w-sm rounded-2xl bg-surface px-5 py-4 text-center text-sm">Chào bạn, tôi là Director của dự án này. Bạn có thể giao việc, hỏi tiến độ hoặc hỏi điều gì đang chờ xử lý.</p>:<p className="mx-auto text-center text-sm text-muted">Chưa có tin nhắn với Director.</p>)}
      <ol className="m-0 flex list-none flex-col gap-2 p-0">{items.map((item,index)=><Bubble key={item.seq} item={item} previous={items[index-1]} note={item.messageId===lastOwn?.messageId&&!replied?c.ownNote[d.presence]:undefined}/>)}</ol>
    </div>
    <DirectorChatComposer initialDraft={initialDraft} handoffKey={handoffKey} immersive={immersive}/>
  </section>;
}
function Bubble({item,previous,note}:{item:DirectorMessage;previous:DirectorMessage|undefined;note:string|undefined}){
  const own=item.author==='user';
  return <li className="min-w-0">
    {(!previous||day(previous.at)!==day(item.at))&&<p className="mx-auto my-3 text-center font-data text-xs text-muted">{day(item.at)}</p>}
    <div className={`flex flex-col ${own?'items-end':'items-start'}`}>
      <p className={`m-0 max-w-[92%] rounded-2xl px-4 py-3 whitespace-pre-wrap [overflow-wrap:anywhere] sm:max-w-[85%] ${own?'rounded-br-sm bg-steel text-surface':'rounded-bl-sm bg-faint'}`}>{item.text}</p>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-data text-xs text-muted">
        <span>{own?'Bạn':'Director'}</span>
        <time dateTime={item.at} title={new Date(item.at).toLocaleString('vi')}>{clock(item.at)}</time>
        {own&&item.channel==='cli'&&<span>Từ terminal</span>}
      </div>
      {note&&<p className="m-0 max-w-[85%] text-right text-xs text-muted sm:max-w-[85%]">{note}</p>}
    </div>
  </li>;
}
