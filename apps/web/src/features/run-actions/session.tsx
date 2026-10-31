import { useState } from 'react';
import type { WebProjectSession } from '@bflow/contracts/web';
import { ActionConfirmation } from '../../components/ActionConfirmation';
import { useCommands } from '../operations';
import { ApiClient, explain } from '../../api/client';
export function SessionActions({api,id,session,fresh}:{api:ApiClient;id:string;session:WebProjectSession;fresh:boolean}){
  const [confirm,setConfirm]=useState(false),[force,setForce]=useState(false),[error,setError]=useState('');
  const start=useCommands('session_start'),stop=useCommands('session_stop'),forceStop=useCommands('session_stop_force');
  async function submit(kind:'session_start'|'session_stop'){
    try{const current=await api.sessionView(id);if(!fresh || !start.online || (kind==='session_start'?!['stopped','unavailable'].includes(current.state):!force&&current.state!=='ready'))return;
      await (kind==='session_start'?start:force?forceStop:stop).submit({kind,...(force&&kind==='session_stop'?{force:true}:{})});setConfirm(false);setError('');
    }catch(e){setError(e instanceof Error && !('code' in e)?e.message:explain(e));}
  }
  const disabled=!fresh || !start.online || start.busy || stop.busy || forceStop.busy;
  const canStart=['stopped','unavailable'].includes(session.state);
  return <><div className="my-2.5 flex flex-wrap items-center gap-2"><button className={`min-w-36 ${canStart?'border-ink bg-brand font-semibold text-ink hover:bg-ink hover:text-surface':''}`} disabled={disabled || !canStart} onClick={()=>void submit('session_start')}>{start.busy?'Đang khởi động…':'Khởi động phiên'}</button><button className="min-w-28" disabled={disabled || session.state!=='ready'} onClick={()=>{setForce(false);setConfirm(true);}}>{stop.busy?'Đang dừng…':'Dừng phiên'}</button><button className="sm:ml-auto border-line text-xs text-muted" title="Chỉ dùng khi dừng phiên thông thường bị kẹt" disabled={disabled} onClick={()=>{setForce(true);setConfirm(true);}}>Dừng phục hồi</button></div>{confirm && <ActionConfirmation title="Xác nhận dừng phiên" onBack={()=>setConfirm(false)}>{force?<><p className="text-sm">Chỉ dùng khi dừng phiên thông thường bị kẹt. Mã nguồn và lịch sử công việc vẫn được giữ nguyên an toàn.</p><small className="my-1.5 block text-xs text-muted">Buộc dừng phiên Herdr sau quiesce và checkpoint. Attempt chưa xác minh có thể bị gián đoạn; giữ nguyên worktree và lịch sử. Không tự gửi lại thao tác chưa rõ kết quả.</small></>:<p className="text-sm">Hệ thống sẽ lưu trạng thái hiện tại rồi dừng phiên làm việc của dự án. Đóng tab trình duyệt không làm dừng phiên.</p>}<div className="mt-2"><button disabled={disabled} onClick={()=>void submit('session_stop')}>Gửi yêu cầu dừng phiên</button></div></ActionConfirmation>}{error && <p role="alert">{error}</p>}</>;
}
