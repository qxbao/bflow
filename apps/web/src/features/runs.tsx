import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiClient } from '../api/client';
import { useRead } from './data';
import { reason } from '../components/reasons';
import { StatusBadge, phases } from '../components/StatusBadge';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { DecisionReview } from './decisions';
import { ClarificationForm } from './clarifications';
import { RunActions } from './run-actions';
import { ChatHistory } from './chat';
export function Runs({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) {
  const [query,setQuery]=useSearchParams(),[search,setSearch]=useState(query.get('search')??'');
  const phase=query.get('phase')??'',term=query.get('search')??'',cursor=query.get('cursor')??undefined;
  const result=useRead(`runs:${id}:${term}:${phase}:${cursor??''}`,()=>api.runs(id,term,phase,cursor),revision);
  function submit(event:FormEvent){event.preventDefault();setQuery({...(search.trim()?{search:search.trim()}:{}),...(phase?{phase}: {})});}
  return <><div className="eyebrow">Theo dõi tiến độ</div><h1>Công việc</h1><form className="filters" onSubmit={submit}><div><label htmlFor="search">Tìm công việc</label><input id="search" maxLength={200} value={search} onChange={e=>setSearch(e.target.value)}/></div><div><label htmlFor="phase">Giai đoạn</label><select id="phase" value={phase} onChange={e=>setQuery({...(term?{search:term}:{}),...(e.target.value?{phase:e.target.value}:{})})}><option value="">Tất cả giai đoạn</option>{Object.entries(phases).filter(([key])=>['intake','clarifying','specifying','planning','tdd_deciding','implementing','verifying','reviewing','awaiting_approval','completed','escalated','failed','cancelled'].includes(key)).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></div><button>Tìm kiếm</button></form>
    {result.loading && <p role="status">Đang tải công việc…</p>}{Boolean(result.error) && <ErrorState stale={Boolean(result.data)} error={result.error} retry={()=>{setQuery({});refresh();}}/>}
    {result.data && <>{result.data.items.length===0?<EmptyState title="Chưa có công việc phù hợp"><p>Công việc đã tiếp nhận sẽ xuất hiện tại đây. Bạn có thể thay đổi bộ lọc.</p></EmptyState>:<div className="run-list">{result.data.items.map(run=><article className="run-row" key={run.runId}><div><Link to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.runId)}`}><h2>{run.title}</h2></Link><p className="muted">Cập nhật {new Date(run.updatedAt).toLocaleString('vi')}</p></div><StatusBadge value={run.sdlcStatus}/><span>{run.tasks.length} nhiệm vụ · {run.decisions.filter(d=>d.status==='pending').length} chờ xem xét</span></article>)}</div>}{result.data.nextCursor && <button onClick={()=>setQuery({...Object.fromEntries(query),cursor:result.data!.nextCursor!})}>Trang tiếp theo</button>}{cursor && <button onClick={()=>{const next=new URLSearchParams(query);next.delete('cursor');setQuery(next);}}>Về trang đầu</button>}</>}
  </>;
}
export function RunView({api,id,runId,revision,refresh}:{api:ApiClient;id:string;runId:string;revision:number;refresh:()=>void}) {
  const result=useRead(`run:${id}:${runId}`,()=>api.run(id,runId),revision),run=result.data;
  return <><Link to={`/projects/${encodeURIComponent(id)}/runs`}>← Công việc</Link>{result.loading && <p role="status">Đang tải chi tiết…</p>}{Boolean(result.error) && <ErrorState stale={Boolean(result.data)} error={result.error} retry={refresh}/>}{run && <>
    <div className="eyebrow">Chi tiết công việc</div><h1>{run.title}</h1>{run.currentRunId!==run.runId && <section className="connection stale"><p>Bạn đang xem lịch sử. Phiên bản hiện hành đã thay đổi.</p><Link to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.currentRunId)}`}>Mở công việc hiện hành →</Link></section>}
    <div className="stats"><div><span className="eyebrow">Giai đoạn nghiệp vụ</span><StatusBadge value={run.sdlcStatus}/></div><div><span className="eyebrow">Bộ máy thực thi</span>{run.coreStatus?<StatusBadge value={run.coreStatus}/>:<p>Chưa có trạng thái thực thi</p>}</div><div><span className="eyebrow">Kết nối terminal</span>{run.transportSummary.states.length?run.transportSummary.states.map((state,index)=><StatusBadge key={index} value={state}/>):<p>Chưa có quan sát</p>}<small>Quan sát lúc {new Date(run.transportSummary.observedAt).toLocaleString('vi')}. Kết thúc lượt không xác nhận công việc thành công.</small></div></div>
    <section><h2>Điểm cần xử lý</h2>{run.blockers.length?run.blockers.map((blocker,index)=><p className="quote" key={index}>{reason(blocker.code)}</p>):<p>Chưa ghi nhận điểm chặn.</p>}{run.clarifications.map(question=><ClarificationForm key={question.questionId+question.expectedVersion.revisionToken} api={api} id={id} runId={run.runId} question={question} enabled={!result.loading && !result.error && run.currentRunId===run.runId && !['completed','failed','cancelled'].includes(run.sdlcStatus)}/>)}</section>
    <section><h2>Nhiệm vụ</h2>{run.tasks.length?<ul className="tasks">{run.tasks.map(task=><li key={task.taskId}><span>{task.title===task.taskId?'Nhiệm vụ chưa có tên hiển thị':task.title}</span><StatusBadge value={task.status}/></li>)}</ul>:<p>Chưa có nhiệm vụ được công bố.</p>}</section>
    <section><h2>Thiết kế, kết quả và kiểm chứng</h2>{run.decisions.length?run.decisions.map(decision=><DecisionReview key={decision.decisionId} decision={decision} api={api} id={id} actions={run.availableActions} fresh={!result.loading && !result.error && run.currentRunId===run.runId} refresh={refresh}/>):<p>Chưa có gói thiết kế, thay đổi hoặc kết quả kiểm chứng được công bố trong bản đọc này. Không suy luận đã kiểm tra từ trạng thái terminal.</p>}</section>
    <section><h2>Thao tác tiếp theo</h2><RunActions api={api} id={id} run={run} fresh={!result.loading && !result.error} refreshing={result.loading && !result.error}/>{run.availableActions.filter(action=>!action.enabled).map(action=><p key={action.actionId} className="quote">{reason(action.disabledReason)}</p>)}</section>
    <ChatHistory api={api} projectId={id} sessionId={run.sessionId} runId={run.runId} revision={revision}/>
    <section><h2>Mốc quan sát</h2><p><time dateTime={run.updatedAt}>{new Date(run.updatedAt).toLocaleString('vi')}</time> · Lần cập nhật của bản đọc hiện tại.</p><p className="muted">Chưa có dữ liệu lịch sử công việc đầy đủ để hiển thị. Cập nhật trực tiếp ở trang tổng quan chỉ phản ánh lần mở trang này.</p></section>
    <details><summary>Thông tin đối chiếu</summary><dl><dt>Mã công việc</dt><dd className="identifier">{run.runId}</dd><dt>Cập nhật</dt><dd>{new Date(run.updatedAt).toLocaleString('vi')}</dd></dl></details>
  </>}</>;
}
