import { useState } from 'react';
import type { WebProjectSession } from '@bflow/contracts/web';
import { ActionConfirmation } from '../../components/ActionConfirmation';
import { useCommands } from '../operations';
import { ApiClient, explain } from '../../api/client';
const unsettled=(cmd:{tracked?:unknown;operation?:{state:string}|undefined})=>Boolean(cmd.tracked && (!cmd.operation || !['applied','failed'].includes(cmd.operation.state)));
const isSettled=(cmd:{operation?:{state:string}|undefined})=>Boolean(cmd.operation && ['applied','failed'].includes(cmd.operation.state));
/** `startLabel` lets a Director layout name this the infrastructure (host) start, distinct from opening a Director session. */
export function SessionActions({api,id,session,fresh,refresh,startLabel='Khởi động phiên',showStart=true,showStop=true}:{api:ApiClient;id:string;session:WebProjectSession;fresh:boolean;refresh?:(()=>void)|undefined;startLabel?:string;showStart?:boolean;showStop?:boolean}){
  const [confirm,setConfirm]=useState(false),[force,setForce]=useState(false),[error,setError]=useState('');
  const start=useCommands('session_start'),stop=useCommands('session_stop'),forceStop=useCommands('session_stop_force');
  // A stop applied after an uncertain operation proves nothing from it is still running. Nothing is resent; only the lock lifts.
  const stoppedAt=[stop,forceStop].flatMap(cmd=>cmd.operation?.state==='applied'?[cmd.operation.updatedAt]:[]).sort().at(-1);
  const superseded=(cmd:{operation?:{state:string;updatedAt:string}|undefined})=>Boolean(cmd.operation?.state==='reconciliation_required' && stoppedAt!==undefined && cmd.operation.updatedAt<stoppedAt);
  const blocking=(cmd:typeof start)=>unsettled(cmd) && !superseded(cmd);
  async function submit(kind:'session_start'|'session_stop'){
    try{
      if(!start.online)return;
      if(kind==='session_stop' && force){
        if(unsettled(forceStop))return;
        if(isSettled(forceStop))await forceStop.startNew();
        await forceStop.submit({kind:'session_stop',force:true});setConfirm(false);setError('');return;
      }
      if(!fresh)return;
      const current=await api.sessionView(id);
      if(kind==='session_start'?!['stopped','unavailable'].includes(current.state):current.state!=='ready'){
        refresh?.();
        setError('Trạng thái phiên đã thay đổi. Đang cập nhật lại thông tin phiên.');
        return;
      }
      const target=kind==='session_start'?start:stop;
      if(blocking(target))return;
      if(superseded(target))await target.startNew(target.tracked?.record.commandId);
      else if(isSettled(target))await target.startNew();
      await target.submit({kind});setConfirm(false);setError('');
    }catch(e){setError(e instanceof Error && !('code' in e)?e.message:explain(e));}
  }
  const busy=start.busy || stop.busy || forceStop.busy;
  const baseDisabled=!fresh || !start.online || busy;
  const normalDisabled=baseDisabled || blocking(start) || blocking(stop) || unsettled(forceStop);
  const forceDisabled=!start.online || busy || unsettled(forceStop);
  const canStart=['stopped','unavailable'].includes(session.state);
  return <><div data-component="SessionActions" className="my-2.5 flex flex-wrap items-center gap-2">{showStart&&<button className={`min-w-36 ${canStart?'border-ink bg-brand font-semibold text-on-brand hover:bg-ink hover:text-surface':''}`} disabled={normalDisabled || !canStart} onClick={()=>void submit('session_start')}>{start.busy?'Đang khởi động…':startLabel}</button>}{showStop&&<><button className="min-w-28" disabled={normalDisabled || session.state!=='ready'} onClick={()=>{setForce(false);setConfirm(true);}}>{stop.busy?'Đang dừng…':'Dừng phiên'}</button><button className="sm:ml-auto border-line text-xs text-muted" title="Chỉ dùng khi dừng phiên thông thường bị kẹt" disabled={forceDisabled} onClick={()=>{setForce(true);setConfirm(true);}}>Dừng phục hồi</button></>}</div>{confirm && <ActionConfirmation title="Xác nhận dừng phiên" onBack={()=>setConfirm(false)}>{force?<><p className="text-sm">Chỉ dùng khi dừng phiên thông thường bị kẹt. Mã nguồn và lịch sử công việc vẫn được giữ nguyên an toàn.</p><small className="my-1.5 block text-xs text-muted">Buộc dừng phiên Herdr sau quiesce và checkpoint. Attempt chưa xác minh có thể bị gián đoạn; giữ nguyên worktree và lịch sử. Không tự gửi lại thao tác chưa rõ kết quả.</small></>:<p className="text-sm">Hệ thống sẽ lưu trạng thái hiện tại rồi dừng phiên làm việc của dự án. Đóng tab trình duyệt không làm dừng phiên.</p>}<div className="mt-2"><button disabled={force?forceDisabled:normalDisabled} onClick={()=>void submit('session_stop')}>Gửi yêu cầu dừng phiên</button></div></ActionConfirmation>}{error && <p role="alert">{error}</p>}</>;
}
