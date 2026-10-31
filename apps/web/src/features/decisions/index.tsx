import { useEffect, useId, useRef, useState } from 'react';
import type { WebAction, WebDecision } from '@bflow/contracts/web';
import { ApiClient, ApiError, explain } from '../../api/client';
import { DecisionCard } from '../../components/DecisionCard';
import { outcomeLabels } from '../../components/OperationStatus';
import { StaleReviewBanner } from '../../components/StaleReviewBanner';
import { useCommands } from '../operations';
const same=(a:WebDecision,b:WebDecision)=>JSON.stringify(a)===JSON.stringify(b);
const unsettled=(cmd:{tracked?:unknown;operation?:{state:string}|undefined})=>Boolean(cmd.tracked && (!cmd.operation || !['applied','failed'].includes(cmd.operation.state)));
const isSettled=(cmd:{operation?:{state:string}|undefined})=>Boolean(cmd.operation && ['applied','failed'].includes(cmd.operation.state));
function authorized(decision:WebDecision,actions:WebAction[]){return actions.some(action=>action.kind==='answer_decision' && action.enabled && JSON.stringify(action.expectedVersion)===JSON.stringify(decision.expectedVersion));}
export type DecisionDraft={review:WebDecision|undefined;reason:string;option:string};
export function DecisionReview({api,id,decision,actions,fresh,refreshing=false,refresh,draft,onDraftChange}:{api:ApiClient;id:string;decision:WebDecision;actions:WebAction[];fresh:boolean;refreshing?:boolean;refresh:()=>void;draft?:DecisionDraft|undefined;onDraftChange?:((draft:DecisionDraft)=>void)|undefined}) {
  const [review,setReview]=useState<WebDecision|undefined>(()=>draft?.review),[reason,setReason]=useState(draft?.reason??''),[option,setOption]=useState(draft?.option??''),[error,setError]=useState(''),[stale,setStale]=useState(false),[clock,setClock]=useState(Date.now());const uid=useId();
  const commands=useCommands(`decision:${decision.decisionId}`);
  const report=useRef(onDraftChange);report.current=onDraftChange;
  useEffect(()=>{report.current?.({review,reason,option});},[review,reason,option]);
  useEffect(()=>{if(!decision.expiresAt)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[decision.expiresAt]);
  useEffect(()=>{if(commands.operation?.error?.code==='stale_version')setStale(true);},[commands.operation]);
  const changed=Boolean(review && !same(review,decision)),expired=Boolean(decision.expiresAt && Date.parse(decision.expiresAt)<=clock);
  const canReview=(fresh || refreshing) && decision.status==='pending' && !expired && authorized(decision,actions) && commands.online && !unsettled(commands);
  async function decide(outcome:'approved'|'rejected'|'changes_requested'){
    if(!review || !canReview || changed || stale || commands.busy || unsettled(commands))return;
    if(outcome!=='approved' && !reason.trim()){setError('Cần nêu lý do từ chối hoặc yêu cầu sửa.');return;}
    if(review.kind==='user_decision' && outcome==='approved' && review.options.length && !option){setError('Chọn một phương án trước khi quyết định.');return;}
    try{
      const current=await api.run(id,review.runId),live=current.decisions.find(d=>d.decisionId===review.decisionId);
      if(!live || !same(live,review) || live.status!=='pending' || (live.expiresAt && Date.parse(live.expiresAt)<=Date.now()) || !authorized(live,current.availableActions)){
        // The review form may disappear after refresh; keep an explicit not-sent notice outside it.
        commands.notify(`Lựa chọn “${outcomeLabels[outcome]}” cho gói phiên bản ${review.expectedVersion.revision} chưa được gửi: gói đã được quyết định hoặc đã đổi phiên bản (có thể từ tab hoặc terminal khác). Đọc lại công việc để xem kết quả hiện hành.`);
        setStale(true);refresh();return;}
      if(isSettled(commands))await commands.startNew();
      await commands.submit({kind:'answer_decision',runId:review.runId,decisionId:review.decisionId,expectedVersion:review.expectedVersion,outcome,...(reason.trim()?{reason:reason.trim()}:{}),...(review.kind==='user_decision' && option?{selectedOption:option}:{})});setError('');
    }catch(e){
      if(e instanceof ApiError && e.code==='stale_version'){commands.notify(`Lựa chọn “${outcomeLabels[outcome]}” không được áp dụng: phiên bản gói đã thay đổi. Đọc lại gói hiện hành.`);setStale(true);refresh();}
      else{const message=e instanceof Error && !(e instanceof ApiError)?e.message:explain(e);if(!(e instanceof ApiError))commands.notify(`Lựa chọn “${outcomeLabels[outcome]}” chưa được gửi. ${message}`);setError(message);}
    }
  }
  return <div><DecisionCard decision={review??decision} api={api} projectId={id}/>{changed || stale?<StaleReviewBanner onRead={()=>{if(isSettled(commands))void commands.startNew();setReview(undefined);setStale(false);setReason('');setOption('');setError('');refresh();}}/>:!review?<div className="mt-2.5"><button className="border-ink bg-brand font-semibold text-ink hover:bg-ink hover:text-surface" disabled={!canReview} onClick={()=>{setReview(structuredClone(decision));setError('');}}>Xem xét gói</button>{!canReview && <p className="my-1.5 text-xs text-muted">Gói chưa cho phép quyết định, đã hết hạn hoặc bản đọc chưa hiện hành.</p>}</div>:<fieldset className="bg-surface" disabled={!canReview || commands.busy}><legend>Quyết định cho phiên bản {review.expectedVersion.revision}</legend><p className="my-1 text-sm text-muted">Quyết định chỉ áp dụng cho đúng tài liệu phiên bản đang hiển thị.</p>{review.kind==='user_decision' && review.options.length>0 && <><label htmlFor={uid+'option'}>Phương án</label><select id={uid+'option'} value={option} onChange={e=>setOption(e.target.value)}><option value="">Chọn phương án</option>{review.options.map(o=><option key={o}>{o}</option>)}</select></>}<label className="mt-2" htmlFor={uid+'reason'}>Lý do (bắt buộc khi từ chối hoặc yêu cầu sửa)</label><textarea id={uid+'reason'} rows={3} maxLength={16000} value={reason} onChange={e=>setReason(e.target.value)} aria-describedby={error?uid+'error':undefined}/>{error && <p id={uid+'error'} role="alert">{error}</p>}<div className="mt-3 flex flex-wrap items-center gap-2"><button className="border-ink bg-brand font-semibold text-ink hover:bg-ink hover:text-surface" onClick={()=>void decide('approved')}>Duyệt gói</button><button onClick={()=>void decide('changes_requested')}>Yêu cầu sửa</button><button onClick={()=>void decide('rejected')}>Từ chối</button></div></fieldset>}</div>;
}
