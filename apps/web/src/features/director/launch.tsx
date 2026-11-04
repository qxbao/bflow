import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import type { WebDirectorLaunchOptions, WebOperation } from '@bflow/contracts/web';
import { ApiError, explain } from '../../api/client';
import { useCommands } from '../operations';
import { DirectorPresenceStatus, useDirector } from './status';

type Provider=WebDirectorLaunchOptions['providers'][number]['provider'];
type LaunchResult=Extract<NonNullable<WebOperation['result']>,{kind:'director_launch'}>;
/** A per-viewer UI convenience only: never repository configuration and never a Director role. */
export const PROVIDER_PREFERENCE_KEY='bflow:web:director-provider';
export const providerLabels:Record<Provider,string>={claude:'Claude Code',codex:'Codex',agy:'Agy'};
const stateLabels={available:'Sẵn sàng',unavailable:'Không dùng được',unverified:'Chưa xác minh'} as const;
const PRESENCE_POLL_MS=3000,PRESENCE_WAIT_MS=3*60*1000;
function remembered():string|undefined{try{return localStorage.getItem(PROVIDER_PREFERENCE_KEY)??undefined;}catch{return undefined;}}
function remember(provider:Provider){try{localStorage.setItem(PROVIDER_PREFERENCE_KEY,provider);}catch{/* preference only */}}
function preselect(options:WebDirectorLaunchOptions):Provider|undefined{
  const usable=options.providers.filter(option=>option.state!=='unavailable'),saved=remembered();
  return (usable.find(option=>option.provider===saved)??usable.find(option=>option.state==='available')??usable[0])?.provider;
}
const time=(iso:string)=>new Date(iso).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'});

function CopyCommand({command}:{command:string}){
  const [state,setState]=useState('');
  async function copy(){
    try{if(!navigator.clipboard)throw Error('no clipboard');await navigator.clipboard.writeText(command);setState('Đã sao chép lệnh.');}
    catch{setState('Không sao chép tự động được; hãy chọn lệnh và sao chép thủ công.');}
  }
  return <div className="min-w-0">
    <pre className="my-1.5 overflow-x-auto border border-line bg-canvas p-2 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap"><code>{command}</code></pre>
    <div className="flex flex-wrap items-center gap-2"><button type="button" onClick={()=>void copy()}>Sao chép lệnh</button><span role="status" className="text-xs text-muted">{state}</span></div>
  </div>;
}

/**
 * "Mở phiên Director": provider choice at action time, one durable local_lifecycle operation per intent. The launch effect is uncertain
 * by nature, so an unsettled or uncertain operation is only re-read by its original ID; a new window needs an explicit new intent.
 * A terminal window opening is not Director readiness: only the view's presence (active/waiting) is.
 */
export function DirectorLaunch(){
  const d=useDirector(),command=useCommands('director_launch'),uid=useId();
  const [open,setOpen]=useState(false),[options,setOptions]=useState<WebDirectorLaunchOptions>(),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [provider,setProvider]=useState<Provider>(),[replace,setReplace]=useState(false);
  const op=command.operation,tracked=command.tracked;
  const settled=Boolean(op&&['applied','failed'].includes(op.state));
  const unsettled=Boolean(tracked&&!settled);
  const uncertain=Boolean(tracked&&!tracked.submitting&&(!op||op.state==='reconciliation_required'));
  const result=op?.state==='applied'&&op.result?.kind==='director_launch'?op.result as LaunchResult:undefined;
  const present=d.presence==='active'||d.presence==='waiting';
  const arrived=Boolean(result&&present&&(!d.heartbeatAt||d.heartbeatAt>=result.launchedAt));
  const waitingForDirector=Boolean(result?.mode==='terminal_opened'&&!arrived&&Date.now()-Date.parse(result.launchedAt)<PRESENCE_WAIT_MS);
  useEffect(()=>{if(!waitingForDirector)return;const poll=setInterval(d.reload,PRESENCE_POLL_MS);return()=>clearInterval(poll);},[waitingForDirector,d.reload]);
  const needsReplace=d.presence!=='absent';
  const chosen=options?.providers.find(option=>option.provider===provider);
  const toggle=useRef<HTMLButtonElement>(null),outcome=useRef<HTMLDivElement>(null);
  const close=()=>{setOpen(false);requestAnimationFrame(()=>toggle.current?.focus());};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close();}};

  async function openPicker(){
    if(open){setOpen(false);return;}
    setOpen(true);setLoading(true);setError('');setOptions(undefined);setReplace(false);
    try{const value=await d.api.directorLaunchOptions(d.projectId);setOptions(value);setProvider(preselect(value));}
    catch(e){setError(explain(e));}
    finally{setLoading(false);}
  }
  async function launch(){
    if(!chosen||chosen.state==='unavailable'||(needsReplace&&!replace)||!command.online||unsettled)return;
    setError('');
    try{
      if(settled)await command.startNew();
      remember(chosen.provider);
      await command.submit({kind:'director_launch',provider:chosen.provider,replaceActive:needsReplace&&replace});
      // The picker closes; focus moves to the outcome region instead of being lost with the removed controls.
      setOpen(false);requestAnimationFrame(()=>outcome.current?.focus());
    }catch(e){setError(e instanceof Error&&!('code' in e)?e.message:explain(e));}
  }
  async function releaseUncertain(){
    if(!tracked)return;setError('');
    try{await command.startNew(tracked.record.commandId);}catch(e){setError(e instanceof Error?e.message:explain(e));}
  }
  return <div data-component="DirectorLaunch" className="min-w-0">
    {!unsettled&&<button ref={toggle} type="button" aria-expanded={open} aria-controls={`${uid}-picker`} className="min-w-40 border-ink bg-brand font-semibold text-on-brand hover:bg-ink hover:text-surface" disabled={!command.online||command.busy} onClick={()=>void openPicker()}>Mở phiên Director</button>}
    {open&&!unsettled&&<div id={`${uid}-picker`} onKeyDown={escape} className="mt-2.5 min-w-0 border border-line bg-canvas p-3">
      {loading&&<p role="status" className="my-1 text-sm text-muted">Đang kiểm tra cách mở Director trên máy này…</p>}
      {options&&<>
        {!options.terminal.available&&<p className="mt-0 mb-2 border-l-3 border-warning pl-3 text-sm">Máy này không mở được terminal tự động{options.terminal.reason?`: ${options.terminal.reason}`:'.'} Bflow sẽ trả về lệnh để bạn tự chạy.</p>}
        <div role="radiogroup" aria-label="Nhà cung cấp cho Director" className="grid gap-1.5">
          {options.providers.map(option=><div key={option.provider} className="min-w-0">
            <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${uid}-provider`} value={option.provider} checked={provider===option.provider} disabled={option.state==='unavailable'} onChange={()=>setProvider(option.provider)}/>{providerLabels[option.provider]} · {stateLabels[option.state]}</label>
            {option.reason&&<p className="my-0.5 ml-6 text-xs text-muted">{option.reason}</p>}
          </div>)}
        </div>
        {!options.providers.some(option=>option.state!=='unavailable')&&<p className="text-sm text-warning">Chưa có nhà cung cấp nào dùng được cho Director trên máy này.</p>}
        {needsReplace&&<label className="mt-2 flex items-start gap-2 text-sm"><input type="checkbox" checked={replace} onChange={event=>setReplace(event.target.checked)}/><span>Mở phiên thay thế. Director có thể đang chạy ({d.presence==='unknown'?'chưa đọc được trạng thái':'đang có mặt'}); phiên hiện có không bị dừng.</span></label>}
        {chosen&&<details className="mt-2"><summary className="text-sm">Lệnh tự chạy cho {providerLabels[chosen.provider]}</summary><CopyCommand command={chosen.manualCommand}/></details>}
        <div className="mt-2.5 flex flex-wrap gap-2"><button type="button" disabled={!chosen||chosen.state==='unavailable'||(needsReplace&&!replace)||!command.online||command.busy} onClick={()=>void launch()}>{command.busy?'Đang mở…':'Mở terminal Director'}</button><button type="button" onClick={close}>Đóng</button></div>
      </>}
    </div>}
    <div ref={outcome} tabIndex={-1} aria-label="Kết quả mở phiên Director" className="min-w-0 outline-none">
    {unsettled&&!uncertain&&<p role="status" className="my-2 text-sm">Đang mở terminal Director…</p>}
    {uncertain&&<div className="my-2 border-l-3 border-warning pl-3 text-sm">
      <p className="my-1">Không rõ cửa sổ terminal đã mở hay chưa. Kiểm tra màn hình: nếu chưa có cửa sổ Director, mở bằng thao tác mới. Bflow không tự thử lại.</p>
      <div className="flex flex-wrap gap-2"><button type="button" onClick={command.reread}>Đọc lại kết quả mở phiên</button><button type="button" disabled={op?.state!=='reconciliation_required'} onClick={()=>void releaseUncertain()}>Tôi đã kiểm tra màn hình, mở bằng thao tác mới</button></div>
    </div>}
    {result?.mode==='terminal_opened'&&<p role="status" className="my-2 text-sm">{arrived?'Director đã có mặt và đang nhận tin.':`Đã mở cửa sổ terminal lúc ${time(result.launchedAt)}. Việc này chưa có nghĩa Director đã sẵn sàng; hãy đợi trạng thái chuyển sang “Đang hoạt động” hoặc “Đang chờ”.`}</p>}
    {result?.mode==='terminal_opened'&&!arrived&&<details className="my-1"><summary className="text-sm">Không thấy cửa sổ? Lệnh tự chạy</summary><CopyCommand command={result.manualCommand}/></details>}
    {result?.mode==='manual_command'&&<div className="my-2 text-sm"><p className="my-1">Không mở được terminal tự động. Chạy lệnh sau trong một terminal trên máy này:</p><CopyCommand command={result.manualCommand}/>{arrived&&<p role="status" className="my-1">Director đã có mặt và đang nhận tin.</p>}</div>}
    {op?.state==='failed'&&<p className="my-2 border-l-3 border-danger pl-3 text-sm">{op.error?.message??'Chưa mở được Director.'}</p>}
    </div>
    {error&&<p role="alert" className="my-2 text-sm">{error}</p>}
  </div>;
}

/** Overview block: Director presence and the launch action. Shown for a Director layout, or while the view is unreadable (unknown). */
export function DirectorSessionPanel({chatPath}:{chatPath:string}){
  const d=useDirector();
  const unreadable=d.layout==='unknown'&&d.error!==undefined&&!(d.error instanceof ApiError&&d.error.code==='invalid_response');
  if(!d.directorLayout&&!unreadable)return null;
  return <section data-component="DirectorSessionPanel" aria-label="Director" className="panel my-3 min-w-0 border border-line bg-surface p-3.5 sm:p-4">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="m-0 text-base">Director</h2>{d.directorLayout&&<Link className="font-data text-xs font-semibold" to={chatPath}>Trò chuyện với Director →</Link>}</div>
    <DirectorPresenceStatus/>
    <div className="mt-2.5">
      {d.layout==='director'&&<DirectorLaunch/>}
      {d.layout==='not_started'&&<p className="my-1 text-sm text-muted">Host của phiên chưa sẵn sàng. Khởi động hạ tầng phiên ở trên trước, rồi mở phiên Director.</p>}
      {!d.directorLayout&&<p className="my-1 text-sm text-muted">Nếu phiên đang dừng, hãy khởi động hạ tầng phiên trước; việc đó chưa mở Director.</p>}
    </div>
  </section>;
}
