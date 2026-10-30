import { LoadingState } from '../../components/LoadingState';
import { useState } from 'react';
import { Link } from 'react-router';
import { WebHttpContracts, type WebChatMessage } from '@bflow/contracts/web';
import { ApiClient, ApiError, projectPath } from '../../api/client';
import { useRead } from '../data';
import { ChatComposer } from './composer';
import { Pagination } from '../../components/Pagination';

const delivery:Record<WebChatMessage['delivery'],string>={
  accepted:'Đã tiếp nhận',queued:'Đang chờ gửi',delivered:'Đã chuyển',
  unknown_delivery:'Chưa rõ đã gửi',failed:'Gửi thất bại',
};
const deliveryNote:Partial<Record<WebChatMessage['delivery'],string>>={
  accepted:'Máy chủ đã nhận tin; chưa chuyển tới Conversation.',queued:'Tin đang chờ tới lượt chuyển tới Conversation.',
  delivered:'Đã tới Conversation; chưa có nghĩa đã được xử lý hay công việc đã hoàn thành.',
};
const RECENT_MESSAGES=30,MAX_PAGES=20;
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
/** Normalized session history; the host rechecks send authority independently. */
export function ChatHistory({api,projectId,sessionId,runId,revision}:{
  api:ApiClient;projectId:string;sessionId:string;runId:string;revision:number;
}) {
  return <SessionHistory key={JSON.stringify([projectId,sessionId,runId])} api={api} projectId={projectId} sessionId={sessionId} runId={runId} revision={revision}/>;
}
function SessionHistory({api,projectId,sessionId,runId,revision}:{
  api:ApiClient;projectId:string;sessionId:string;runId:string;revision:number;
}) {
  const [cursors,setCursors]=useState<string[]>([]),[reload,setReload]=useState(0),[scope,setScope]=useState<'run'|'session'>('run');
  const cursor=cursors.at(-1);
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
  const result=useRead(JSON.stringify(['chat',projectId,sessionId,scope,scope==='session'?cursor:undefined]),async():Promise<{items:WebChatMessage[];nextCursor?:string|undefined;complete:boolean}>=>{
    if(scope==='run')return readAll(readPage);
    return {...await readPage(cursor),complete:true};
  },revision+reload);
  const relevant=(result.data?.items??[]).filter(message=>message.runId===runId || message.runId===undefined);
  const shown=scope==='run'?relevant.slice(-RECENT_MESSAGES):result.data?.items;
  return <section className="my-5 min-w-0 border border-line bg-surface p-4 sm:p-5" aria-label="Trò chuyện cùng phiên">
    <h2>Trò chuyện</h2>
    <p>Lịch sử Conversation của phiên đang gắn với công việc này. Các quyết định vẫn được xử lý tại gói xem xét của công việc.</p>
    <div className="my-3 flex flex-wrap items-center gap-2" role="group" aria-label="Phạm vi lịch sử"><button aria-pressed={scope==='run'} onClick={()=>setScope('run')}>Công việc này</button><button aria-pressed={scope==='session'} onClick={()=>{setCursors([]);setScope('session');}}>Toàn phiên</button></div>
    <p className="text-sm text-muted">{scope==='run'?`Đang hiện tối đa ${RECENT_MESSAGES} tin gần nhất của công việc này và tin chung của phiên.${relevant.length>RECENT_MESSAGES?` Còn ${relevant.length-RECENT_MESSAGES} tin cũ hơn.`:''}${result.data && !result.data.complete?' Phiên quá dài nên chỉ đọc phần đầu; mở Toàn phiên để xem tiếp.':''}`:'Đang hiện toàn bộ lịch sử của phiên, theo trang.'}</p>
    <Link to={`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`}>Mở công việc và quyết định →</Link>
    <div aria-busy={result.loading}>
      <LoadingState loading={result.loading} initial={!result.data} label="Đang đọc lịch sử trò chuyện…"/>
      {Boolean(result.error) && <p role="alert">Chưa đọc được lịch sử đã xác minh. {result.data?'Bản lịch sử bên dưới đã cũ. ':''}Đọc lại lịch sử hoặc kiểm tra phiên dự án.</p>}
      {shown && result.data && (shown.length?<ol className="my-4 list-none p-0 [&>li]:min-w-0 [&>li]:border-b [&>li]:border-line [&>li]:py-3">{shown.map(message=><li key={message.messageId}>
        <div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">{message.sender==='user'?'Bạn':'Conversation'} · {message.source==='web'?'Web':'Terminal'} · <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('vi')}</time></div>
        <p className="whitespace-pre-wrap font-prose [overflow-wrap:anywhere]">{message.content}</p><span className="inline-flex max-w-full items-center border border-steel px-2 py-0.5 font-data text-xs leading-5 text-steel [overflow-wrap:anywhere]">{delivery[message.delivery]}</span>
        {message.sender==='user' && deliveryNote[message.delivery] && <p className="my-1 text-xs text-muted">{deliveryNote[message.delivery]}</p>}
        {message.delivery==='unknown_delivery' && <p>Không gửi lại khi chưa đối chiếu được kết quả chuyển tin.</p>}
        {message.runId && message.runId!==runId && <Link to={`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(message.runId)}`}>Mở công việc của tin nhắn →</Link>}
      </li>)}</ol>:<p>Chưa có tin nhắn trong trang lịch sử này.</p>)}
    </div>
    <div className="my-3 flex flex-wrap gap-2"><button onClick={()=>setReload(value=>value+1)} disabled={result.loading}>Đọc lại lịch sử</button>
    </div>
    {scope==='session' && <Pagination nextLabel="Trang tin nhắn tiếp theo" label="Phân trang trò chuyện" page={cursors.length+1} previous={cursor?()=>setCursors(old=>old.slice(0,-1)):undefined} first={cursor?()=>setCursors([]):undefined} next={result.data?.nextCursor?()=>setCursors(old=>[...old,result.data!.nextCursor!]):undefined} busy={result.loading || Boolean(result.error)}/>}
    <ChatComposer api={api} projectId={projectId} sessionId={sessionId} runId={runId} revision={revision} historyReady={!!result.data&&!result.error&&!result.loading} refresh={()=>setReload(value=>value+1)}/>
  </section>;
}
