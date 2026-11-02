import { useEffect, useId, useRef, useState } from 'react';
import type { WebAction, WebRunView } from '@bflow/contracts/web';
import { ApiClient, ApiError, explain } from '../../api/client';
import { isBenignDisabledReason, reason as explainReason } from '../../components/reasons';
import { ActionConfirmation } from '../../components/ActionConfirmation';
import { FieldLabel } from '../../components/FieldHelp';
import { useCommands } from '../operations';
import { RequestForm } from '../requests';
const unsettled=(cmd:{tracked?:unknown;operation?:{state:string}|undefined})=>Boolean(cmd.tracked && (!cmd.operation || !['applied','failed'].includes(cmd.operation.state)));
const isSettled=(cmd:{operation?:{state:string}|undefined})=>Boolean(cmd.operation && ['applied','failed'].includes(cmd.operation.state));
export function RunActions({api,id,run,fresh,refreshing=false,refresh}:{api:ApiClient;id:string;run:WebRunView;fresh:boolean;refreshing?:boolean;refresh?:(()=>void)|undefined}) {
  const [confirmCancel,setConfirmCancel]=useState(false),[reason,setReason]=useState(''),[error,setError]=useState(''),[revise,setRevise]=useState(false),uid=useId();
  const cancel=useCommands(`cancel:${run.runId}`),resume=useCommands(`resume:${run.runId}`);
  const lastActionSig=useRef(JSON.stringify([run.runId,run.updatedAt,run.availableActions.map(a=>[a.actionId,a.enabled,a.expectedVersion])]));
  useEffect(()=>{
    const currentSig=JSON.stringify([run.runId,run.updatedAt,run.availableActions.map(a=>[a.actionId,a.enabled,a.expectedVersion])]);
    if(lastActionSig.current!==currentSig){lastActionSig.current=currentSig;setError('');}
  },[run.runId,run.updatedAt,run.availableActions]);
  async function send(action:WebAction){
    if(!fresh || !action.enabled){setError('Thao tác chưa được gửi: trang đang cập nhật hoặc thao tác không còn khả dụng. Đợi tải xong rồi thử lại.');return;}
    if(action.kind==='cancel' && !reason.trim()){setError('Nêu lý do hủy công việc.');return;}
    const target=action.kind==='cancel'?cancel:resume;
    if(unsettled(target))return;
    try{
      const current=await api.run(id,run.runId);
      const allowed=current.availableActions.find(a=>a.actionId===action.actionId && a.kind===action.kind && a.enabled);
      if(!allowed || current.currentRunId!==run.runId){refresh?.();throw new Error('Thao tác đã thay đổi. Tải lại công việc trước khi tiếp tục.');}
      if(isSettled(target))await target.startNew();
      const version={revisionToken:allowed.expectedVersion.revisionToken};
      if(action.kind==='cancel')await cancel.submit({kind:'cancel',runId:run.runId,expectedVersion:version,reason:reason.trim()});
      else await resume.submit({kind:'resume',runId:run.runId,actionId:action.actionId,expectedVersion:version});
      setConfirmCancel(false);setError('');
    }catch(e){
      if(e instanceof ApiError && e.code==='stale_version')refresh?.();
      setError(e instanceof Error && !('code' in e)?e.message:explain(e));
    }
  }
  const historical=run.currentRunId!==run.runId;
  const actions=run.availableActions.filter(a=>['resume','cancel','revise_request'].includes(a.kind));
  const cancelAction=actions.find(a=>a.kind==='cancel');
  const notes=[...new Set(actions.filter(a=>!a.enabled && !isBenignDisabledReason(a.disabledReason)).map(a=>explainReason(a.disabledReason)))];
  return <><div data-component="RunActions" className="my-2.5 flex flex-wrap items-center gap-2">{actions.map(action=><button key={action.actionId} className={action.kind==='resume' && action.enabled?'border-ink bg-brand font-semibold text-ink hover:bg-ink hover:text-surface':''} disabled={(!fresh && !(refreshing && action.kind==='cancel')) || !action.enabled || historical || cancel.busy || resume.busy || !cancel.online || (action.kind==='cancel' && unsettled(cancel)) || (action.kind==='resume' && unsettled(resume))} onClick={()=>action.kind==='cancel'?setConfirmCancel(true):action.kind==='revise_request'?setRevise(v=>!v):void send(action)}>{action.kind==='resume'?'Tiếp tục':action.kind==='cancel'?'Hủy công việc':'Chỉnh yêu cầu'}</button>)}</div>
    {notes.map(note=><p key={note} className="my-2 text-xs text-muted">{note}</p>)}
    {confirmCancel && cancelAction && <ActionConfirmation title="Xác nhận yêu cầu hủy" onBack={()=>{setConfirmCancel(false);setError('');}}><p className="text-sm">Yêu cầu hủy cần hệ thống xử lý và xác nhận. Tiếp nhận chưa có nghĩa tiến trình đã dừng ngay.</p>{!fresh && <p role="status" className="text-sm text-muted">Trang đang cập nhật. Lý do bạn nhập được giữ lại; có thể gửi khi tải xong.</p>}<FieldLabel htmlFor={uid} label="Lý do hủy" help="Ghi lại lý do dừng công việc này để lưu vào nhật ký kiểm toán và giúp bạn dễ tra cứu về sau." example="Ví dụ: Đổi phạm vi yêu cầu sang công việc mới"/><textarea id={uid} maxLength={16000} rows={3} value={reason} onChange={e=>setReason(e.target.value)}/><div className="mt-2"><button disabled={!fresh || !cancelAction.enabled || historical || cancel.busy || !cancel.online || unsettled(cancel)} onClick={()=>void send(cancelAction)}>Gửi yêu cầu hủy</button></div></ActionConfirmation>}
    {error && <p role="alert">{error}</p>}{revise && actions.filter(a=>a.kind==='revise_request').map(action=><RequestForm key={action.actionId} api={api} id={id} sessionId={run.sessionId} runId={run.runId} action={action} enabled={(fresh || refreshing) && action.enabled && !historical} refresh={refresh}/>)}</>;
}
