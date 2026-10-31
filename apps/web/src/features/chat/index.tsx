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
  accepted:'Máy chủ đã nhận tin; chưa chuyển tới trợ lý hội thoại.',queued:'Tin đang chờ tới lượt chuyển xử lý.',
  delivered:'Đã chuyển tới trợ lý hội thoại; chưa có nghĩa đã được xử lý hay công việc đã hoàn thành.',
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
    const page=await api.request(`${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages${query}`,WebHttpContracts.messages.response,'GET',undefined,40000);
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
  const historyRejected=result.error instanceof ApiError && ['invalid_request','operation_not_allowed','invalid_response'].includes(result.error.code);
  return <section className="my-4 min-w-0 border border-line bg-surface p-3.5 sm:p-4" aria-label="Trò chuyện cùng phiên">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="m-0 text-base">Trò chuyện</h2><div className="flex flex-wrap items-center gap-2"><div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Phạm vi lịch sử"><button aria-pressed={scope==='run'} onClick={()=>setScope('run')}>Công việc này</button><button aria-pressed={scope==='session'} onClick={()=>{setCursors([]);setScope('session');}}>Toàn phiên</button></div><button onClick={()=>setReload(value=>value+1)} disabled={result.loading}>Đọc lại lịch sử</button></div></div>
    <p className="my-1.5 text-xs text-muted">{scope==='run'?`Hiện tối đa ${RECENT_MESSAGES} tin gần nhất của công việc này và tin chung. Phê duyệt vẫn thực hiện ở mục Thiết kế, kết quả và phê duyệt phía trên.${relevant.length>RECENT_MESSAGES?` Còn ${relevant.length-RECENT_MESSAGES} tin cũ hơn.`:''}${result.data && !result.data.complete?' Phiên dài nên chỉ đọc phần đầu; chọn Toàn phiên để xem tiếp.':''}`:'Hiện toàn bộ lịch sử trò chuyện của phiên theo từng trang.'}</p>
    <div aria-busy={result.loading}>
      <LoadingState loading={result.loading} initial={!result.data} label="Đang đọc lịch sử trò chuyện…"/>
      {Boolean(result.error) && <p role="alert" className="my-2 border-l-3 border-warning pl-3 text-sm">Chưa đọc được lịch sử đã xác minh. {result.data?'Bản lịch sử bên dưới đã cũ. ':''}Đọc lại lịch sử hoặc kiểm tra phiên dự án.</p>}
      {shown && result.data && (shown.length?<ol className="my-3 max-h-96 overflow-y-auto list-none border-t border-line p-0 [&>li]:min-w-0 [&>li]:border-b [&>li]:border-line [&>li]:py-2.5">{shown.map(message=><li key={message.messageId}>
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-data text-xs font-semibold uppercase tracking-widest text-muted">{message.sender==='user'?'Bạn':'Trợ lý Bflow'} · {message.source==='web'?'Web':'Terminal'} · <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('vi')}</time></span><span className="inline-flex max-w-full items-center border border-steel px-2 py-0.5 font-data text-xs leading-5 text-steel [overflow-wrap:anywhere]">{delivery[message.delivery]}</span></div>
        <p className="my-1.5 whitespace-pre-wrap font-prose text-sm [overflow-wrap:anywhere]">{message.content}</p>
        {message.sender==='user' && deliveryNote[message.delivery] && <p className="my-1 text-xs text-muted">{deliveryNote[message.delivery]}</p>}
        {message.delivery==='unknown_delivery' && <p className="my-1 text-xs text-warning">Không gửi lại khi chưa đối chiếu được kết quả chuyển tin.</p>}
        {message.runId && message.runId!==runId && <Link className="text-xs" to={`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(message.runId)}`}>Mở công việc của tin nhắn →</Link>}
      </li>)}</ol>:<p className="my-2 text-sm text-muted">Chưa có tin nhắn trong trang lịch sử này.</p>)}
    </div>
    {scope==='session' && <Pagination nextLabel="Trang tin nhắn tiếp theo" label="Phân trang trò chuyện" page={cursors.length+1} previous={cursor?()=>setCursors(old=>old.slice(0,-1)):undefined} first={cursor?()=>setCursors([]):undefined} next={result.data?.nextCursor?()=>setCursors(old=>[...old,result.data!.nextCursor!]):undefined} busy={result.loading || Boolean(result.error)}/>}
    <ChatComposer api={api} projectId={projectId} sessionId={sessionId} runId={runId} revision={revision} historyReady={!!result.data&&!result.error&&!result.loading} historyRejected={historyRejected} refresh={()=>setReload(value=>value+1)}/>
  </section>;
}
