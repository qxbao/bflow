import { useId, useState } from 'react';
import type { WebAction, WebRunView } from '@bflow/contracts/web';
import { ApiClient, explain } from '../../api/client';
import { reason as explainReason } from '../../components/reasons';
import { ActionConfirmation } from '../../components/ActionConfirmation';
import { useCommands } from '../operations';
import { RequestForm } from '../requests';
const unsettled=(cmd:{tracked?:unknown;operation?:{state:string}|undefined})=>Boolean(cmd.tracked && (!cmd.operation || !['applied','failed'].includes(cmd.operation.state)));
const isSettled=(cmd:{operation?:{state:string}|undefined})=>Boolean(cmd.operation && ['applied','failed'].includes(cmd.operation.state));
export function RunActions({api,id,run,fresh,refreshing=false}:{api:ApiClient;id:string;run:WebRunView;fresh:boolean;refreshing?:boolean}) {
  const [confirm,setConfirm]=useState<WebAction>(),[reason,setReason]=useState(''),[error,setError]=useState(''),[revise,setRevise]=useState(false),uid=useId();
  const cancel=useCommands(`cancel:${run.runId}`),resume=useCommands(`resume:${run.runId}`);
  async function send(action:WebAction){
    if(!fresh || !action.enabled){setError('Thao tác chưa được gửi: trang đang cập nhật hoặc thao tác không còn khả dụng. Đợi tải xong rồi thử lại.');return;}
    if(action.kind==='cancel' && !reason.trim()){setError('Nêu lý do hủy công việc.');return;}
    const target=action.kind==='cancel'?cancel:resume;
    if(unsettled(target))return;
    try{
      const current=await api.run(id,run.runId);
      const allowed=current.availableActions.find(a=>a.actionId===action.actionId && a.kind===action.kind && a.enabled && JSON.stringify(a.expectedVersion)===JSON.stringify(action.expectedVersion));
      if(!allowed || current.currentRunId!==run.runId)throw new Error('Thao tác đã thay đổi. Tải lại công việc trước khi tiếp tục.');
      if(isSettled(target))await target.startNew();
      const version={revisionToken:action.expectedVersion.revisionToken};
      if(action.kind==='cancel')await cancel.submit({kind:'cancel',runId:run.runId,expectedVersion:version,reason:reason.trim()});
      else await resume.submit({kind:'resume',runId:run.runId,actionId:action.actionId,expectedVersion:version});
      setConfirm(undefined);setError('');
    }catch(e){setError(e instanceof Error && !('code' in e)?e.message:explain(e));}
  }
  const historical=run.currentRunId!==run.runId;
  return <><div className="my-4 flex flex-wrap items-center gap-2">{run.availableActions.filter(a=>['resume','cancel','revise_request'].includes(a.kind)).map(action=><div key={action.actionId}><button disabled={(!fresh && !(refreshing && action.kind==='cancel')) || !action.enabled || historical || cancel.busy || resume.busy || !cancel.online || (action.kind==='cancel' && unsettled(cancel)) || (action.kind==='resume' && unsettled(resume))} onClick={()=>action.kind==='cancel'?setConfirm(action):action.kind==='revise_request'?setRevise(v=>!v):void send(action)}>{action.kind==='resume'?'Tiếp tục':action.kind==='cancel'?'Hủy công việc':'Chỉnh yêu cầu'}</button>{!action.enabled && <p>{explainReason(action.disabledReason)}</p>}</div>)}</div>
    {confirm && <ActionConfirmation title="Xác nhận yêu cầu hủy" onBack={()=>{setConfirm(undefined);setError('');}}><p>Yêu cầu hủy cần được xử lý và xác nhận. Tiếp nhận chưa có nghĩa tiến trình đã dừng.</p>{!fresh && <p role="status" className="text-sm text-muted">Trang đang cập nhật. Lý do bạn nhập được giữ lại; có thể gửi khi tải xong.</p>}<label htmlFor={uid}>Lý do hủy</label><textarea id={uid} maxLength={16000} rows={3} value={reason} onChange={e=>setReason(e.target.value)}/><button disabled={!fresh || historical || cancel.busy || !cancel.online || unsettled(cancel)} onClick={()=>void send(confirm)}>Gửi yêu cầu hủy</button></ActionConfirmation>}
    {error && <p role="alert">{error}</p>}{revise && run.availableActions.filter(a=>a.kind==='revise_request').map(action=><RequestForm key={action.actionId} api={api} id={id} sessionId={run.sessionId} runId={run.runId} action={action} enabled={fresh && action.enabled && !historical}/>)}</>;
}
