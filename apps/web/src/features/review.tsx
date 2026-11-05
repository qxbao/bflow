import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { WebRunView } from '@bflow/contracts/web';
import { ApiClient } from '../api/client';
import { useRead } from './data';
import { DecisionReview } from './decisions';
import { phases } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { Pagination } from '../components/Pagination';
import { ActionConfirmation } from '../components/ActionConfirmation';
import { FieldLabel } from '../components/FieldHelp';
import { localPage } from './pagination';
import { useDecisionDraftStore, decisionDraftKey } from './office/ui/interaction/decision-drafts';

export function Review({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) {
  const result=useRead(`review:${id}`,()=>api.decisions(id),revision);
  const [query,setQuery]=useSearchParams(),[pending,setPending]=useState<URLSearchParams>(),[draftEpoch,setDraftEpoch]=useState(0);
  const {drafts,setDraft}=useDecisionDraftStore();
  const status=query.get('status')??'';
  const items=result.data?.items??[],filtered=items.filter(item=>!status || item.status===status);
  const pagination=localPage(filtered,query.get('page'),10);
  const dirty=pagination.items.some(item=>{const draft=drafts[decisionDraftKey(item.runId,item.decisionId)];return Boolean(draft?.review && (draft.reason || draft.option));});
  const runIds=[...new Set(pagination.items.map(item=>item.runId))];
  const cachedRuns=useRef(new Map<string,{runId:string;value:WebRunView|undefined;error:unknown}>()),cachedProject=useRef(id);
  if(cachedProject.current!==id){cachedProject.current=id;cachedRuns.current.clear();}
  const runs=useRead(JSON.stringify(['review-runs',id,runIds]),()=>Promise.all(runIds.map(async runId=>{try{return {runId,value:await api.run(id,runId),error:undefined};}catch(error){return {runId,value:undefined,error};}})),revision);
  useEffect(()=>{if(!runs.data)return;for(const item of runs.data)cachedRuns.current.set(item.runId,item);},[runs.data]);
  const change=useCallback((next:URLSearchParams)=>{if(dirty)setPending(next);else setQuery(next);},[dirty,setQuery]);
  function page(value:number){const next=new URLSearchParams(query);next.set('page',String(value));change(next);}
  return <><div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">Yêu cầu của bạn</div><h1 data-component="Review">Cần bạn quyết định</h1>
    <p className="mb-4 max-w-2xl text-base text-muted">Xem nội dung, rồi chọn đồng ý hoặc yêu cầu thay đổi.</p>
    <div className="my-4 flex flex-wrap items-end justify-between gap-3"><div className="w-full sm:max-w-xs"><FieldLabel htmlFor="review-status" label="Trạng thái yêu cầu" help="Lọc hộp phê duyệt theo tình trạng quyết định (ví dụ Chờ quyết định để xem các gói đang đợi bạn xử lý, hoặc Đã duyệt để tra cứu lại)."/><select id="review-status" value={status} onChange={event=>{const next=new URLSearchParams(query);if(event.target.value)next.set('status',event.target.value);else next.delete('status');next.delete('page');change(next);}}><option value="">Tất cả trạng thái</option>{['pending','approved','rejected','changes_requested','expired','superseded','cancelled'].map(value=><option key={value} value={value}>{phases[value]}</option>)}</select></div>{result.data&&<p className="m-0 text-sm text-muted">{filtered.length} yêu cầu đã tải</p>}</div>
    <LoadingState loading={result.loading} initial={!result.data} label="Đang tải yêu cầu…"/>
    {Boolean(result.error) && <><ErrorState stale={Boolean(result.data)} error={result.error} retry={refresh}/><Link to={`/projects/${encodeURIComponent(id)}/runs`}>Xem theo từng công việc</Link></>}
    {Boolean(runs.error) && pagination.items.length>0 && <ErrorState stale={Boolean(runs.data)} error={runs.error} retry={refresh}/>}
    {pending && <ActionConfirmation title="Rời nội dung quyết định chưa gửi?" onBack={()=>setPending(undefined)}><p>Lý do hoặc phương án đang nhập sẽ bị bỏ khi chuyển trang hoặc bộ lọc.</p><button onClick={()=>{pagination.items.forEach(item=>setDraft(decisionDraftKey(item.runId,item.decisionId),{review:undefined,reason:'',option:''}));setDraftEpoch(value=>value+1);setQuery(pending);setPending(undefined);}}>Bỏ nội dung và tiếp tục</button></ActionConfirmation>}
    {result.data && (pagination.items.length?<div>{pagination.items.map(decision=>{
      const observation=runs.data?.find(item=>item.runId===decision.runId)??(runs.loading?cachedRuns.current.get(decision.runId):undefined),run=observation?.value;
      const key=decisionDraftKey(decision.runId,decision.decisionId);
      return <section key={`${decision.runId}:${decision.decisionId}:${draftEpoch}`} className="mb-5"><>{Boolean(observation?.error) && <ErrorState error={observation?.error} retry={refresh}/>}<DecisionReview draft={drafts[key]} onDraftChange={next=>setDraft(key,next)} api={api} id={id} decision={decision} actions={run?.availableActions??[]} fresh={!result.loading && !result.error && !runs.loading && !runs.error && !observation?.error && run?.currentRunId===decision.runId} refreshing={(result.loading || runs.loading) && !result.error && !runs.error && !observation?.error && run?.currentRunId===decision.runId} refresh={refresh}/></><Link className="mt-2 inline-block text-sm" to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(decision.runId)}`}>Xem ngữ cảnh công việc →</Link></section>;
    })}</div>:<EmptyState title={status?'Không có yêu cầu phù hợp':'Không có quyết định đang chờ'}><p>{status?'Thử trạng thái khác để xem các yêu cầu đã tải.':'Các gói cần xem xét sẽ được cập nhật khi phiên dự án công bố.'}</p></EmptyState>)}
    {filtered.length>10 && <Pagination label="Phân trang yêu cầu" page={pagination.page} previous={pagination.page>1?()=>page(pagination.page-1):undefined} next={pagination.page<pagination.pages?()=>page(pagination.page+1):undefined} busy={result.loading || Boolean(result.error) || Boolean(pending)} summary={`${filtered.length} yêu cầu đã tải`}/>}
    <details><summary>Về danh sách này</summary><p className="text-sm text-muted">Danh sách có thể chưa gồm toàn bộ lịch sử. <Link to={`/projects/${encodeURIComponent(id)}/runs`}>Xem theo từng công việc</Link>.</p></details>
  </>;
}
