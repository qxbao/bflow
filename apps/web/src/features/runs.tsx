import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiClient } from '../api/client';
import { useRead } from './data';
import { isBenignDisabledReason, reason, severity } from '../components/reasons';
import { Blockers } from '../components/Blockers';
import { DecisionCard } from '../components/DecisionCard';
import type { WebRunView } from '@bflow/contracts/web';
import { StatusBadge, phases } from '../components/StatusBadge';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { DecisionReview } from './decisions';
import { ClarificationForm } from './clarifications';
import { RunActions } from './run-actions';
import { Pagination } from '../components/Pagination';
import { LoadingState } from '../components/LoadingState';
import { useCursorPagination } from './pagination';
export function ago(iso:string){const minutes=Math.max(0,Math.round((Date.now()-Date.parse(iso))/60000));return minutes<1?'dưới 1 phút trước':minutes<60?`${minutes} phút trước`:minutes<1440?`${Math.round(minutes/60)} giờ trước`:`${Math.round(minutes/1440)} ngày trước`;}
const activeWork:Record<string,string>={intake:'Hệ thống đang tiếp nhận yêu cầu của bạn.',clarifying:'Đang làm rõ thêm thông tin yêu cầu.',specifying:'Hệ thống đang biên soạn bản đặc tả kỹ thuật.',planning:'Hệ thống đang chia nhỏ kế hoạch thực hiện.',tdd_deciding:'Hệ thống đang xác định chiến lược kiểm thử.',implementing:'Hệ thống đang lập trình thay đổi theo kế hoạch.',verifying:'Hệ thống đang chạy các bước kiểm chứng độc lập.',reviewing:'Hệ thống đang rà soát chất lượng kết quả.'};
/** "Who is it waiting on" from authoritative projection fields only; terminal idle/done is never used here. */
function waitingOn(run:WebRunView):{title:string;detail:string}{
  if(run.currentRunId!==run.runId)return {title:'Đây là bản lịch sử',detail:'Công việc đã được tiếp nối ở phiên bản khác.'};
  if(['completed','failed','cancelled'].includes(run.sdlcStatus))return {title:'Công việc đã kết thúc',detail:'Không còn bước tiếp theo.'};
  const required=run.blockers.find(item=>severity(item.code)==='action');
  const resumeEnabled=run.availableActions.some(action=>action.kind==='resume' && action.enabled);
  if(run.decisions.some(item=>item.status==='pending'))return {title:'Đang chờ bạn',detail:'Có gói cần bạn xem xét và quyết định ngay bên dưới.'};
  if(run.clarifications.length)return {title:'Đang chờ bạn',detail:'Có câu hỏi làm rõ cần bạn trả lời bên dưới.'};
  if(required)return {title:'Đang bị chặn',detail:reason(required.code)};
  if(resumeEnabled && run.blockers.some(item=>item.code==='auto_resume_scheduled'))return {title:'Hệ thống đang tự khôi phục',detail:'Bflow đã lên lịch tự thử lại an toàn; bạn cũng có thể bấm “Tiếp tục” ở mục Thao tác công việc để chạy lại ngay.'};
  if(resumeEnabled)return {title:'Sẵn sàng tiếp tục',detail:'Công việc đang tạm dừng an toàn. Bạn có thể bấm “Tiếp tục” ở mục Thao tác công việc bên dưới.'};
  const check=run.blockers.find(item=>severity(item.code)==='checking');
  if(check)return {title:'Đang chờ hệ thống',detail:reason(check.code)};
  return {title:'Đang xử lý',detail:activeWork[run.sdlcStatus]??'Hệ thống đang xử lý bước hiện tại.'};
}
export function Runs({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) {
  const [query,setQuery]=useSearchParams(),[search,setSearch]=useState(query.get('search')??'');
  const phase=query.get('phase')??'',term=query.get('search')??'';
  const pagination=useCursorPagination(JSON.stringify([id,term,phase])),cursor=pagination.cursor;
  useEffect(()=>setSearch(term),[term]);
  const result=useRead(`runs:${id}:${term}:${phase}:${cursor??''}`,()=>api.runs(id,term,phase,cursor),revision);
  function submit(event:FormEvent){event.preventDefault();setQuery({...(search.trim()?{search:search.trim()}:{}),...(phase?{phase}: {})});}
  return <><div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">Theo dõi tiến độ</div><h1>Công việc</h1><form className="my-4 flex flex-wrap items-end gap-3 [&>div]:min-w-0 [&>div]:basis-48 [&>div]:grow" onSubmit={submit}><div><label htmlFor="search">Tìm công việc</label><input id="search" type="search" placeholder="Tên công việc" maxLength={200} value={search} onChange={e=>setSearch(e.target.value)}/></div><div><label htmlFor="phase">Giai đoạn</label><select id="phase" value={phase} onChange={e=>setQuery({...(term?{search:term}:{}),...(e.target.value?{phase:e.target.value}:{})})}><option value="">Tất cả giai đoạn</option>{Object.entries(phases).filter(([key])=>['intake','clarifying','specifying','planning','tdd_deciding','implementing','verifying','reviewing','awaiting_approval','completed','escalated','failed','cancelled'].includes(key)).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></div><button className="min-w-24">Tìm kiếm</button></form>
    <LoadingState loading={result.loading} initial={!result.data} label="Đang tải công việc…"/>{Boolean(result.error) && <ErrorState stale={Boolean(result.data)} error={result.error} retry={refresh}/>}
    {result.data && <>{result.data.items.length===0?<EmptyState title="Chưa có công việc phù hợp"><p>Công việc đã tiếp nhận sẽ xuất hiện tại đây. Bạn có thể thay đổi bộ lọc.</p></EmptyState>:<div className="min-w-0 border-b border-line">{result.data.items.map(run=>{const doneTasks=run.tasks.filter(t=>t.status==='succeeded').length,pendingDec=run.decisions.filter(d=>d.status==='pending').length;return <article className="grid min-w-0 grid-cols-1 items-start gap-2 border-t border-line py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4 [&_h2]:m-0 [&_h2]:text-lg [&_p]:my-1" key={run.runId}><div><Link to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.runId)}`}><h2>{run.title}</h2></Link><p className="text-xs text-muted">Cập nhật {ago(run.updatedAt)} ({new Date(run.updatedAt).toLocaleString('vi')}) · {run.tasks.length?`${doneTasks}/${run.tasks.length} nhiệm vụ hoàn thành`:'Chưa chia nhiệm vụ'}{pendingDec?` · ${pendingDec} gói chờ bạn duyệt`:''}</p></div><StatusBadge value={run.sdlcStatus}/></article>;})}</div>}<Pagination label="Phân trang công việc" page={pagination.page} first={pagination.first} previous={pagination.previous} next={result.data.nextCursor?()=>pagination.next(result.data!.nextCursor!):undefined} busy={result.loading || Boolean(result.error)} summary={`${result.data.items.length} công việc trong trang này`}/>
    </>}
  </>;
}
export function RunView({api,id,runId,revision,refresh}:{api:ApiClient;id:string;runId:string;revision:number;refresh:()=>void}) {
  const result=useRead(`run:${id}:${runId}`,()=>api.run(id,runId),revision),run=result.data;
  const doneCount=run?.tasks.filter(t=>t.status==='succeeded').length??0;
  return <><Link className="font-data text-sm" to={`/projects/${encodeURIComponent(id)}/runs`}>← Danh sách công việc</Link><LoadingState loading={result.loading} initial={!run} label="Đang tải chi tiết…"/>{Boolean(result.error) && <ErrorState stale={Boolean(result.data)} error={result.error} retry={refresh}/>}{run && <>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">Chi tiết công việc</div><div className="flex flex-wrap items-center gap-1.5"><StatusBadge prefix="Giai đoạn" value={run.sdlcStatus}/>{run.tasks.length>0 && <span className="inline-flex items-center border border-line bg-surface px-2 py-0.5 font-data text-xs leading-5 text-ink">{doneCount}/{run.tasks.length} nhiệm vụ hoàn thành</span>}</div></div>
    <h1 className="mt-1 mb-3">{run.title}</h1>
    {run.currentRunId!==run.runId && <section className="my-3 border border-line border-l-3 border-l-warning bg-surface px-3 py-2 font-data text-sm text-warning"><p className="my-1">Bạn đang xem bản lịch sử. Phiên bản hiện hành đã được tiếp nối.</p><Link to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.currentRunId)}`}>Mở công việc hiện hành →</Link></section>}
    {run.parentRunId && <p className="my-1 text-sm"><Link to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.parentRunId)}`}>← Tiếp nối từ công việc trước</Link></p>}
    <section aria-label="Bước hiện tại" className="my-3 border border-line border-l-3 border-l-accent bg-surface p-3.5 sm:p-4"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="m-0 text-base">{waitingOn(run).title}</h2><span className="font-data text-xs text-muted">Cập nhật {ago(run.updatedAt)}</span></div><p className="my-1 text-sm">{waitingOn(run).detail}</p></section>

    <div className="my-4 grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(260px,310px)]"><div className="min-w-0">
    {(run.blockers.length>0 || run.clarifications.length>0) && <section className="mt-0"><h2>Điểm cần bạn lưu ý</h2>{run.blockers.length>0 && <Blockers items={run.blockers}/>}{run.clarifications.map(question=><ClarificationForm key={question.questionId+question.expectedVersion.revisionToken} api={api} id={id} runId={run.runId} question={question} enabled={!result.loading && !result.error && run.currentRunId===run.runId && !['completed','failed','cancelled'].includes(run.sdlcStatus)}/>)}</section>}
    <section id="run-decisions" className="mt-0"><h2>Thiết kế, kết quả và phê duyệt</h2>{run.decisions.some(item=>item.status!=='pending') && <><h3>Đã có hiệu lực</h3>{run.decisions.filter(item=>item.status!=='pending').map(decision=><DecisionCard key={decision.decisionId} decision={decision} api={api} projectId={id}/>)}</>}{run.decisions.some(item=>item.status!=='pending') && run.decisions.some(item=>item.status==='pending') && <h3>Đang chờ quyết định</h3>}{run.decisions.length?run.decisions.filter(item=>item.status==='pending').map(decision=><DecisionReview key={decision.decisionId} decision={decision} api={api} id={id} actions={run.availableActions} fresh={!result.loading && !result.error && run.currentRunId===run.runId} refreshing={result.loading && !result.error && run.currentRunId===run.runId} refresh={refresh}/>):<p className="text-sm text-muted">Chưa có gói thiết kế hoặc kết quả kiểm chứng nào cần bạn duyệt ở bước này.</p>}</section>
    <section><h2>Nhiệm vụ thực hiện {run.tasks.length>0?`(${doneCount}/${run.tasks.length})`:''}</h2>{run.tasks.length?<ul className="m-0 list-none border-t border-line p-0 [&_li]:flex [&_li]:flex-wrap [&_li]:items-center [&_li]:justify-between [&_li]:gap-2 [&_li]:border-b [&_li]:border-line [&_li]:py-2.5">{run.tasks.map(task=><li key={task.taskId}><span className="text-sm">{task.title===task.taskId?'Nhiệm vụ chưa có tên hiển thị':task.title}</span><StatusBadge value={task.status}/></li>)}</ul>:<p className="text-sm text-muted">Hệ thống sẽ hiển thị danh sách nhiệm vụ ngay sau khi hoàn tất lập kế hoạch.</p>}</section>
    </div><div className="min-w-0">
    <section className="mt-0 border border-line bg-surface p-3.5 sm:p-4"><h2 className="m-0 mb-2 text-base">Thao tác công việc</h2>{run.blockers.length===0 && run.clarifications.length===0 && <p className="my-1 text-xs text-muted">Chưa ghi nhận điểm chặn nào.</p>}<RunActions api={api} id={id} run={run} fresh={!result.loading && !result.error} refreshing={result.loading && !result.error}/>{run.availableActions.filter(action=>!action.enabled && action.kind==='answer_decision' && !isBenignDisabledReason(action.disabledReason)).map(action=><p key={action.actionId} className="my-2 border-l-3 border-warning pl-2.5 text-xs text-muted">{reason(action.disabledReason)}</p>)}</section>
    </div></div>

    <section><h2>Trò chuyện</h2><Link to={`/projects/${encodeURIComponent(id)}/chat/${encodeURIComponent(run.runId)}`}>Mở trò chuyện của công việc →</Link></section>

    <details className="my-3"><summary>Chi tiết kỹ thuật & chẩn đoán thực thi</summary><div className="mt-2 grid gap-3 border border-line bg-surface p-3.5 text-sm sm:grid-cols-3"><div><span className="mb-1 block font-data text-xs font-semibold uppercase tracking-widest text-muted">Giai đoạn nghiệp vụ</span><StatusBadge value={run.sdlcStatus}/></div><div><span className="mb-1 block font-data text-xs font-semibold uppercase tracking-widest text-muted">Bộ máy thực thi</span>{run.coreStatus?<StatusBadge value={run.coreStatus}/>:<StatusBadge value="unknown"/>}</div><div><span className="mb-1 block font-data text-xs font-semibold uppercase tracking-widest text-muted">Tiến trình nền (chẩn đoán)</span>{run.transportSummary.states.length?run.transportSummary.states.map((state,index)=><StatusBadge key={index} value={state}/>):<span className="text-xs text-muted">Chưa có quan sát</span>}<small className="mt-1 block text-xs text-muted">Quan sát {ago(run.transportSummary.observedAt)}. Chỉ dùng để chẩn đoán kết nối; kết thúc lượt không xác nhận công việc hoàn thành.</small></div></div><dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2"><div><dt className="mt-1">Mã đối chiếu công việc</dt><dd className="font-mono [overflow-wrap:anywhere]">{run.runId}</dd></div><div><dt className="mt-1">Cập nhật bản đọc</dt><dd><time dateTime={run.updatedAt}>{new Date(run.updatedAt).toLocaleString('vi')}</time></dd></div></dl></details>
  </>}</>;
}
