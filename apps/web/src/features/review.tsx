import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiClient } from '../api/client';
import { useRead } from './data';
import { DecisionReview, type DecisionDraft } from './decisions';
import { phases } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { Pagination } from '../components/Pagination';
import { ActionConfirmation } from '../components/ActionConfirmation';
import { localPage } from './pagination';

export function Review({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) {
  const result=useRead(`review:${id}`,()=>api.decisions(id),revision);
  const [query,setQuery]=useSearchParams(),[drafts,setDrafts]=useState<Record<string,DecisionDraft>>({}),[pending,setPending]=useState<URLSearchParams>(),[draftEpoch,setDraftEpoch]=useState(0);
  const status=query.get('status')??'';
  const items=result.data?.items??[],filtered=items.filter(item=>!status || item.status===status);
  const pagination=localPage(filtered,query.get('page'),10);
  const dirty=pagination.items.some(item=>{const draft=drafts[JSON.stringify([item.runId,item.decisionId])];return Boolean(draft?.review && (draft.reason || draft.option));});
  const runIds=[...new Set(pagination.items.map(item=>item.runId))];
  const runs=useRead(JSON.stringify(['review-runs',id,runIds]),()=>Promise.all(runIds.map(async runId=>{try{return {runId,value:await api.run(id,runId),error:undefined};}catch(error){return {runId,value:undefined,error};}})),revision);
  const change=useCallback((next:URLSearchParams)=>{if(dirty)setPending(next);else setQuery(next);},[dirty,setQuery]);
  function page(value:number){const next=new URLSearchParams(query);next.set('page',String(value));change(next);}
  return <><div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">Hộp xem xét</div><h1>Cần bạn quyết định</h1>
    <p className="mb-4 max-w-2xl text-base text-muted">Đọc câu hỏi và tài liệu của đúng phiên bản công việc.</p>
    <div className="my-4 flex flex-wrap items-end justify-between gap-3"><div className="w-full sm:max-w-xs"><label htmlFor="review-status">Trạng thái gói</label><select id="review-status" value={status} onChange={event=>{const next=new URLSearchParams(query);if(event.target.value)next.set('status',event.target.value);else next.delete('status');next.delete('page');change(next);}}><option value="">Tất cả trạng thái</option>{['pending','approved','rejected','changes_requested','expired','superseded','cancelled'].map(value=><option key={value} value={value}>{phases[value]}</option>)}</select></div><p className="m-0 text-sm text-muted">{filtered.length} gói trong bản đọc hiện có</p></div>
    <LoadingState loading={result.loading} initial={!result.data} label="Đang tải gói xem xét…"/>
    {Boolean(result.error) && <><ErrorState stale={Boolean(result.data)} error={result.error} retry={refresh}/><Link to={`/projects/${encodeURIComponent(id)}/runs`}>Xem theo từng công việc</Link></>}
    {Boolean(runs.error) && pagination.items.length>0 && <ErrorState stale={Boolean(runs.data)} error={runs.error} retry={refresh}/>}
    {pending && <ActionConfirmation title="Rời nội dung quyết định chưa gửi?" onBack={()=>setPending(undefined)}><p>Lý do hoặc phương án đang nhập sẽ bị bỏ khi chuyển trang hoặc bộ lọc.</p><button onClick={()=>{setDrafts(old=>Object.fromEntries(Object.entries(old).filter(([key])=>!pagination.items.some(item=>key===JSON.stringify([item.runId,item.decisionId])))));setDraftEpoch(value=>value+1);setQuery(pending);setPending(undefined);}}>Bỏ nội dung và tiếp tục</button></ActionConfirmation>}
    {result.data && (pagination.items.length?<div>{pagination.items.map(decision=>{
      const observation=runs.data?.find(item=>item.runId===decision.runId),run=observation?.value;
      const key=JSON.stringify([decision.runId,decision.decisionId]);
      return <section key={`${decision.runId}:${decision.decisionId}:${draftEpoch}`} className="mb-5"><>{Boolean(observation?.error) && <ErrorState error={observation?.error} retry={refresh}/>}<DecisionReview draft={drafts[key]} onDraftChange={next=>setDrafts(old=>{const previous=old[key];return previous?.review===next.review && previous?.reason===next.reason && previous?.option===next.option?old:{...old,[key]:next};})} api={api} id={id} decision={decision} actions={run?.availableActions??[]} fresh={!result.loading && !result.error && !runs.loading && !runs.error && !observation?.error && run?.currentRunId===decision.runId} refreshing={(result.loading || runs.loading) && !result.error && !runs.error && !observation?.error && run?.currentRunId===decision.runId} refresh={refresh}/></><Link className="mt-2 inline-block text-sm" to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(decision.runId)}`}>Xem ngữ cảnh công việc →</Link></section>;
    })}</div>:<EmptyState title={status?'Không có gói phù hợp':'Không có quyết định đang chờ'}><p>{status?'Thử trạng thái khác để xem các gói trong bản đọc hiện có.':'Các gói cần xem xét sẽ được cập nhật khi phiên dự án công bố.'}</p></EmptyState>)}
    {filtered.length>10 && <Pagination label="Phân trang gói xem xét" page={pagination.page} previous={pagination.page>1?()=>page(pagination.page-1):undefined} next={pagination.page<pagination.pages?()=>page(pagination.page+1):undefined} busy={result.loading || Boolean(result.error) || Boolean(pending)} summary={`${filtered.length} gói trong bản đọc`}/>}
    <p className="text-xs text-muted">Danh sách phản ánh dữ liệu API đã trả về; lịch sử đầy đủ có thể vượt giới hạn bản đọc. <Link to={`/projects/${encodeURIComponent(id)}/runs`}>Xem theo từng công việc</Link>.</p>
  </>;
}
