import { useState } from 'react';
import { Link } from 'react-router';
import { WebHttpContracts, type WebChatMessage } from '@bflow/contracts/web';
import { ApiClient, ApiError, projectPath } from '../../api/client';
import { useRead } from '../data';
import './chat.css';
import { ChatComposer } from './composer';

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
  const [cursor,setCursor]=useState<string>(),[reload,setReload]=useState(0);
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
  return <section className="chat-history panel" aria-label="Trò chuyện cùng phiên">
    <h2>Trò chuyện</h2>
    <p>Lịch sử Conversation của phiên đang gắn với công việc này. Các quyết định vẫn được xử lý tại gói xem xét của công việc.</p>
    <Link to={`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`}>Mở công việc và quyết định →</Link>
    <div aria-busy={result.loading}>
      {result.loading && <p role="status">Đang đọc lịch sử trò chuyện…</p>}
      {Boolean(result.error) && <p role="alert">Chưa đọc được lịch sử đã xác minh. {result.data?'Bản lịch sử bên dưới đã cũ. ':''}Đọc lại lịch sử hoặc kiểm tra phiên dự án.</p>}
      {result.data && (result.data.items.length?<ol className="chat-messages">{result.data.items.map(message=><li key={message.messageId}>
        <div className="eyebrow">{message.sender==='user'?'Bạn':'Conversation'} · {message.source==='web'?'Web':'Terminal'} · <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('vi')}</time></div>
        <p className="chat-content">{message.content}</p><span className="badge">{delivery[message.delivery]}</span>
        {message.delivery==='unknown_delivery' && <p>Không gửi lại khi chưa đối chiếu được kết quả chuyển tin.</p>}
        {message.runId && message.runId!==runId && <Link to={`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(message.runId)}`}>Mở công việc của tin nhắn →</Link>}
      </li>)}</ol>:<p>Chưa có tin nhắn trong trang lịch sử này.</p>)}
    </div>
    <div className="chat-controls"><button onClick={()=>setReload(value=>value+1)} disabled={result.loading}>Đọc lại lịch sử</button>
      {result.data?.nextCursor && <button disabled={result.loading || Boolean(result.error)} onClick={()=>setCursor(result.data!.nextCursor!)}>Trang tin nhắn tiếp theo</button>}
      {cursor && <button onClick={()=>setCursor(undefined)}>Về đầu lịch sử</button>}
    </div>
    <ChatComposer api={api} projectId={projectId} sessionId={sessionId} runId={runId} revision={revision} historyReady={!!result.data&&!result.error&&!result.loading} refresh={()=>setReload(value=>value+1)}/>
  </section>;
}
