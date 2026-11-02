import { useEffect, useId, useRef, useState } from 'react';
import type { WebAction, WebDecision } from '@bflow/contracts/web';
import { ApiClient, ApiError, explain } from '../../api/client';
import { DecisionCard } from '../../components/DecisionCard';
import { FieldLabel } from '../../components/FieldHelp';
import { outcomeLabels } from '../../components/OperationStatus';
import { reason as explainReason } from '../../components/reasons';
import { StaleReviewBanner } from '../../components/StaleReviewBanner';
import { useCommands } from '../operations';
const same=(a:WebDecision,b:WebDecision)=>JSON.stringify(a)===JSON.stringify(b);
const unsettled=(cmd:{tracked?:unknown;operation?:{state:string}|undefined})=>Boolean(cmd.tracked && (!cmd.operation || !['applied','failed'].includes(cmd.operation.state)));
const isSettled=(cmd:{operation?:{state:string}|undefined})=>Boolean(cmd.operation && ['applied','failed'].includes(cmd.operation.state));
function authorized(decision:WebDecision,actions:WebAction[]){return actions.some(action=>action.kind==='answer_decision' && action.enabled && JSON.stringify(action.expectedVersion)===JSON.stringify(decision.expectedVersion));}
export type DecisionDraft={review:WebDecision|undefined;reason:string;option:string};
export function DecisionReview({api,id,decision,actions,fresh,refreshing=false,refresh,draft,onDraftChange}:{api:ApiClient;id:string;decision:WebDecision;actions:WebAction[];fresh:boolean;refreshing?:boolean;refresh:()=>void;draft?:DecisionDraft|undefined;onDraftChange?:((draft:DecisionDraft)=>void)|undefined}) {
  const [review,setReview]=useState<WebDecision|undefined>(()=>draft?.review),[reason,setReason]=useState(draft?.reason??''),[option,setOption]=useState(draft?.option??''),[error,setError]=useState(''),[stale,setStale]=useState(false),[clock,setClock]=useState(Date.now()),[submittedVersionKey,setSubmittedVersionKey]=useState('');const uid=useId();
  const commands=useCommands(`decision:${decision.decisionId}`);
  const handledStaleOp=useRef<string|undefined>(undefined);
  const report=useRef(onDraftChange);report.current=onDraftChange;
  useEffect(()=>{report.current?.({review,reason,option});},[review,reason,option]);
  useEffect(()=>{if(!decision.expiresAt)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[decision.expiresAt]);
  useEffect(()=>{
    const op=commands.operation;
    if(op?.error?.code==='stale_version' && handledStaleOp.current!==op.operationId){
      handledStaleOp.current=op.operationId;
      setStale(true);
    }
  },[commands.operation]);
  const changed=Boolean(review && !same(review,decision)),expired=Boolean(decision.expiresAt && Date.parse(decision.expiresAt)<=clock);
  const decisionVersionKey=JSON.stringify(decision.expectedVersion);
  const alreadyApplied=commands.operation?.state==='applied' && submittedVersionKey===decisionVersionKey;
  const canReview=(fresh || refreshing) && decision.status==='pending' && !expired && authorized(decision,actions) && commands.online && !unsettled(commands) && !alreadyApplied;
  async function decide(outcome:'approved'|'rejected'|'changes_requested'){
    if(!review || !canReview || changed || stale || commands.busy || unsettled(commands))return;
    const validOption=review.kind==='user_decision' && review.options.includes(option)?option:'';
    if(outcome!=='approved' && !reason.trim()){setError('Cần nêu lý do từ chối hoặc yêu cầu sửa.');return;}
    if(review.kind==='user_decision' && outcome==='approved' && review.options.length>0 && !validOption){setError('Chọn một phương án trước khi quyết định.');return;}
    if(review.kind==='user_decision' && outcome==='approved' && validOption==='Approve test-integrity exception' && !reason.trim()){setError('Cần nêu lý do chấp thuận ngoại lệ toàn vẹn kiểm thử.');return;}
    try{
      const current=await api.run(id,review.runId),live=current.decisions.find(d=>d.decisionId===review.decisionId);
      if(!live || !same(live,review) || live.status!=='pending' || (live.expiresAt && Date.parse(live.expiresAt)<=Date.now())){
        // The review form may disappear after refresh; keep an explicit not-sent notice outside it.
        commands.notify(`Lựa chọn “${outcomeLabels[outcome]}” cho gói phiên bản ${review.expectedVersion.revision} chưa được gửi: gói đã được quyết định hoặc đã đổi phiên bản (có thể từ tab hoặc terminal khác). Đọc lại công việc để xem kết quả hiện hành.`);
        setStale(true);refresh();return;}
      if(!authorized(live,current.availableActions)){
        const blocked=current.availableActions.find(a=>a.kind==='answer_decision' && !a.enabled && JSON.stringify(a.expectedVersion)===JSON.stringify(live.expectedVersion))??current.availableActions.find(a=>a.kind==='answer_decision' && !a.enabled);
        setError(blocked?.disabledReason?explainReason(blocked.disabledReason):'Gói hiện tạm thời chưa thể gửi quyết định. Đợi hệ thống đối chiếu rồi thử lại.');
        refresh();return;
      }
      if(isSettled(commands))await commands.startNew();
      const targetVersionKey=JSON.stringify(review.expectedVersion);
      setSubmittedVersionKey(targetVersionKey);
      await commands.submit({kind:'answer_decision',runId:review.runId,decisionId:review.decisionId,expectedVersion:review.expectedVersion,outcome,...(reason.trim()?{reason:reason.trim()}:{}),...(validOption?{selectedOption:validOption}:{})});setError('');
    }catch(e){
      setSubmittedVersionKey('');
      if(e instanceof ApiError && e.code==='stale_version'){commands.notify(`Lựa chọn “${outcomeLabels[outcome]}” không được áp dụng: phiên bản gói đã thay đổi. Đọc lại gói hiện hành.`);setStale(true);refresh();}
      else{const message=e instanceof Error && !(e instanceof ApiError)?e.message:explain(e);if(!(e instanceof ApiError))commands.notify(`Lựa chọn “${outcomeLabels[outcome]}” chưa được gửi. ${message}`);setError(message);}
    }
  }
  return <div data-component="DecisionReview"><DecisionCard decision={review??decision} api={api} projectId={id}/>{changed || stale?<StaleReviewBanner onRead={()=>{if(commands.operation?.error?.code==='stale_version')handledStaleOp.current=commands.operation.operationId;if(isSettled(commands))void commands.startNew();setReview(undefined);setStale(false);setSubmittedVersionKey('');if(!(decision.kind==='user_decision' && decision.options.includes(option)))setOption('');setError('');refresh();}}/>:!review?<div className="mt-2.5"><button className="border-ink bg-brand font-semibold text-ink hover:bg-ink hover:text-surface" disabled={!canReview} onClick={()=>{setReview(structuredClone(decision));setOption(prev=>decision.kind==='user_decision' && decision.options.includes(prev)?prev:'');setError('');}}>Xem xét gói</button>{!canReview && <p className="my-1.5 text-xs text-muted">Gói chưa cho phép quyết định, đã hết hạn hoặc bản đọc chưa hiện hành.</p>}</div>:<fieldset className="bg-surface" disabled={!canReview || commands.busy}><legend>Quyết định cho phiên bản {review.expectedVersion.revision}</legend><p className="my-1 text-sm text-muted">Quyết định chỉ áp dụng cho đúng tài liệu phiên bản đang hiển thị.</p>{review.kind==='user_decision' && review.options.length>0 && <><FieldLabel htmlFor={uid+'option'} label="Phương án" help="Chọn một trong các phương án do hệ thống đề xuất trước khi bấm Duyệt gói."/><select id={uid+'option'} value={review.options.includes(option)?option:''} onChange={e=>setOption(e.target.value)}><option value="">Chọn phương án</option>{review.options.map(o=><option key={o} value={o}>{o}</option>)}</select></>}<FieldLabel className="mt-2 mb-1" htmlFor={uid+'reason'} label="Lý do (bắt buộc khi từ chối hoặc yêu cầu sửa)" help="Ghi chú hướng dẫn cụ thể để các vai trò AI chỉnh sửa đúng ý bạn khi bấm Yêu cầu sửa hoặc Từ chối (tùy chọn khi bấm Duyệt gói)." example="Ví dụ: Bổ sung xử lý chuỗi rỗng và thêm unit test cho ký tự đặc biệt"/><textarea id={uid+'reason'} rows={3} maxLength={16000} value={reason} onChange={e=>setReason(e.target.value)} aria-describedby={error?uid+'error':undefined}/>{error && <p id={uid+'error'} role="alert">{error}</p>}<div className="mt-3 flex flex-wrap items-center gap-2"><button className="border-ink bg-brand font-semibold text-ink hover:bg-ink hover:text-surface" disabled={!canReview || commands.busy} onClick={()=>void decide('approved')}>Duyệt gói</button><button disabled={!canReview || commands.busy} onClick={()=>void decide('changes_requested')}>Yêu cầu sửa</button><button disabled={!canReview || commands.busy} onClick={()=>void decide('rejected')}>Từ chối</button></div></fieldset>}</div>;
}
