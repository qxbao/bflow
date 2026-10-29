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
/** Normalized session history; the host rechecks send authority independently. */
export function ChatHistory({api,projectId,sessionId,runId,revision}:{
  api:ApiClient;projectId:string;sessionId:string;runId:string;revision:number;
}) {
  return <SessionHistory key={JSON.stringify([projectId,sessionId,runId])} api={api} projectId={projectId} sessionId={sessionId} runId={runId} revision={revision}/>;
}
function SessionHistory({api,projectId,sessionId,runId,revision}:{
  api:ApiClient;projectId:string;sessionId:string;runId:string;revision:number;
}) {
  const [cursors,setCursors]=useState<string[]>([]),[reload,setReload]=useState(0);
  const cursor=cursors.at(-1);
  const result=useRead(JSON.stringify(['chat',projectId,sessionId,cursor]),async()=>{
    const query=cursor?`?${new URLSearchParams({cursor})}`:'';
    const page=await api.request(`${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages${query}`,WebHttpContracts.messages.response);
    const ids=new Set<string>();
    for(const message of page.items){
      if(message.sessionId!==sessionId || ids.has(message.messageId))throw new ApiError('invalid_response');
      ids.add(message.messageId);
    }
    return page;
  },revision+reload);
  return <section className="my-5 min-w-0 border border-line bg-surface p-4 sm:p-5" aria-label="Trò chuyện cùng phiên">
    <h2>Trò chuyện</h2>
    <p>Lịch sử Conversation của phiên đang gắn với công việc này. Các quyết định vẫn được xử lý tại gói xem xét của công việc.</p>
    <Link to={`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`}>Mở công việc và quyết định →</Link>
    <div aria-busy={result.loading}>
      <LoadingState loading={result.loading} initial={!result.data} label="Đang đọc lịch sử trò chuyện…"/>
      {Boolean(result.error) && <p role="alert">Chưa đọc được lịch sử đã xác minh. {result.data?'Bản lịch sử bên dưới đã cũ. ':''}Đọc lại lịch sử hoặc kiểm tra phiên dự án.</p>}
      {result.data && (result.data.items.length?<ol className="my-4 list-none p-0 [&>li]:min-w-0 [&>li]:border-b [&>li]:border-line [&>li]:py-3">{result.data.items.map(message=><li key={message.messageId}>
        <div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">{message.sender==='user'?'Bạn':'Conversation'} · {message.source==='web'?'Web':'Terminal'} · <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('vi')}</time></div>
        <p className="whitespace-pre-wrap font-prose [overflow-wrap:anywhere]">{message.content}</p><span className="inline-flex max-w-full items-center border border-steel px-2 py-0.5 font-data text-xs leading-5 text-steel [overflow-wrap:anywhere]">{delivery[message.delivery]}</span>
        {message.delivery==='unknown_delivery' && <p>Không gửi lại khi chưa đối chiếu được kết quả chuyển tin.</p>}
        {message.runId && message.runId!==runId && <Link to={`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(message.runId)}`}>Mở công việc của tin nhắn →</Link>}
      </li>)}</ol>:<p>Chưa có tin nhắn trong trang lịch sử này.</p>)}
    </div>
    <div className="my-3 flex flex-wrap gap-2"><button onClick={()=>setReload(value=>value+1)} disabled={result.loading}>Đọc lại lịch sử</button>
    </div>
    <Pagination nextLabel="Trang tin nhắn tiếp theo" label="Phân trang trò chuyện" page={cursors.length+1} previous={cursor?()=>setCursors(old=>old.slice(0,-1)):undefined} first={cursor?()=>setCursors([]):undefined} next={result.data?.nextCursor?()=>setCursors(old=>[...old,result.data!.nextCursor!]):undefined} busy={result.loading || Boolean(result.error)}/>
    <ChatComposer api={api} projectId={projectId} sessionId={sessionId} runId={runId} revision={revision} historyReady={!!result.data&&!result.error&&!result.loading} refresh={()=>setReload(value=>value+1)}/>
  </section>;
}
