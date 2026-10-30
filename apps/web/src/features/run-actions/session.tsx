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
  return <><div className="my-4 flex flex-wrap items-center gap-2"><button disabled={disabled || !['stopped','unavailable'].includes(session.state)} onClick={()=>void submit('session_start')}>Khởi động phiên</button><button disabled={disabled || session.state!=='ready'} onClick={()=>{setForce(false);setConfirm(true);}}>Dừng phiên</button><button disabled={disabled} onClick={()=>{setForce(true);setConfirm(true);}}>Dừng phục hồi</button></div>{confirm && <ActionConfirmation title="Xác nhận dừng phiên" onBack={()=>setConfirm(false)}>{force && <p>Buộc dừng phiên Herdr sau quiesce và checkpoint. Attempt chưa xác minh có thể bị gián đoạn; giữ nguyên worktree và lịch sử. Dùng khi dừng thường bị lỗi pane/worktree group. Không tự gửi lại thao tác chưa rõ kết quả.</p>}<p>Phiên sẽ quiesce và lưu trạng thái theo lifecycle hiện có. Đóng tab không thực hiện thao tác này.</p><button disabled={disabled} onClick={()=>void submit('session_stop')}>Gửi yêu cầu dừng phiên</button></ActionConfirmation>}{error && <p role="alert">{error}</p>}</>;
}
