import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import type { WebDirectorLaunchOptions, WebOperation } from '@bflow/contracts/web';
import { explain } from '../../api/client';
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
const profilePreferenceKey=(provider:Provider)=>`bflow:web:director-profile:${provider}`;
function rememberedProfile(provider:Provider):string{try{const name=localStorage.getItem(profilePreferenceKey(provider))??'';return /^[A-Za-z0-9._-]{0,128}$/.test(name)?name:'';}catch{return '';}}
function rememberProfile(provider:Provider,name:string){try{localStorage.setItem(profilePreferenceKey(provider),name);}catch{/* preference only */}}
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
export function DirectorLaunch({label='Mở phiên Director'}:{label?:string}){
  const d=useDirector(),command=useCommands('director_launch'),uid=useId();
  const [open,setOpen]=useState(false),[options,setOptions]=useState<WebDirectorLaunchOptions>(),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [provider,setProvider]=useState<Provider>(),[profileName,setProfileName]=useState(''),[replace,setReplace]=useState(false);
  const op=command.operation,tracked=command.tracked;
  const settled=Boolean(op&&['applied','failed'].includes(op.state));
  const unsettled=Boolean(tracked&&!settled);
  const uncertain=Boolean(tracked&&!tracked.submitting&&(!op||op.state==='reconciliation_required'));
  const result=op?.state==='applied'&&op.result?.kind==='director_launch'?op.result as LaunchResult:undefined;
  const present=d.presence==='active'||d.presence==='waiting';
  // "Arrived" needs an observed absent → active/waiting transition for this operation plus a heartbeat strictly after launchedAt.
  // A replacement launch (Director already present) never shows that transition, so an old Director's heartbeat is never claimed.
  const [sawAbsent,setSawAbsent]=useState<string>();
  const commandId=tracked?.record.commandId;
  useEffect(()=>{if(result&&commandId&&d.presence==='absent')setSawAbsent(commandId);},[result,commandId,d.presence]);
  const heartbeat=d.heartbeatAt?Date.parse(d.heartbeatAt):Number.NaN,launched=result?Date.parse(result.launchedAt):Number.NaN;
  const freshHeartbeat=Number.isFinite(heartbeat)&&Number.isFinite(launched)&&heartbeat>launched;
  const arrived=Boolean(result&&present&&freshHeartbeat&&sawAbsent===commandId);
  const unconfirmedPresent=Boolean(result&&present&&!arrived);
  const waitingForDirector=Boolean(result?.mode==='terminal_opened'&&!arrived&&Date.now()-Date.parse(result.launchedAt)<PRESENCE_WAIT_MS);
  useEffect(()=>{if(!waitingForDirector)return;const poll=setInterval(d.reload,PRESENCE_POLL_MS);return()=>clearInterval(poll);},[waitingForDirector,d.reload]);
  // Re-render once the wait window ends so the "please wait" text is replaced even without another presence change.
  const [,setExpired]=useState(0);
  useEffect(()=>{
    if(!waitingForDirector||!result)return;
    const timer=setTimeout(()=>setExpired(n=>n+1),Math.max(0,Date.parse(result.launchedAt)+PRESENCE_WAIT_MS-Date.now())+1);
    return()=>clearTimeout(timer);
  },[waitingForDirector,result]);
  // A window opened by this launch may still be starting Director while presence reads absent: another launch must be an
  // explicit replacement, never a silent second Director.
  const needsReplace=d.presence!=='absent'||waitingForDirector;
  const chosen=options?.providers.find(option=>option.provider===provider);
  const selectedProfile=chosen?.profiles?.find(profile=>profile.name===profileName);
  const profileBlocked=Boolean(profileName&&(!selectedProfile||selectedProfile.state==='unavailable'));
  const toggle=useRef<HTMLButtonElement>(null),outcome=useRef<HTMLDivElement>(null);
  const close=()=>{setOpen(false);requestAnimationFrame(()=>toggle.current?.focus());};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close();}};

  async function openPicker(){
    if(open){setOpen(false);return;}
    setOpen(true);setLoading(true);setError('');setOptions(undefined);setReplace(false);
    try{const value=await d.api.directorLaunchOptions(d.projectId);setOptions(value);const selected=preselect(value);setProvider(selected);setProfileName(selected?rememberedProfile(selected):'');}
    catch(e){setError(explain(e));}
    finally{setLoading(false);}
  }
  async function launch(){
    if(!chosen||chosen.state==='unavailable'||profileBlocked||(needsReplace&&!replace)||!command.online||unsettled)return;
    setError('');
    try{
      if(settled)await command.startNew();
      remember(chosen.provider);rememberProfile(chosen.provider,profileName);
      const observed=await command.submit({kind:'director_launch',provider:chosen.provider,...(profileName?{profileName}:{}),replaceActive:needsReplace&&replace});
      // Director was confirmed absent when this launch was chosen: a later presence can only be the new session.
      if(observed&&!needsReplace)setSawAbsent(observed.record.commandId);
      // The picker closes; focus moves to the outcome region instead of being lost with the removed controls.
      setOpen(false);requestAnimationFrame(()=>outcome.current?.focus());
    }catch(e){setError(e instanceof Error&&!('code' in e)?e.message:explain(e));}
  }
  async function releaseUncertain(){
    if(!tracked)return;setError('');
    try{await command.startNew(tracked.record.commandId);}catch(e){setError(e instanceof Error?e.message:explain(e));}
  }
  return <div data-component="DirectorLaunch" className="min-w-0">
    {!unsettled&&<button ref={toggle} type="button" aria-expanded={open} aria-controls={`${uid}-picker`} className="min-w-40 border-ink bg-brand font-semibold text-on-brand hover:bg-ink hover:text-surface" disabled={!command.online||command.busy} onClick={()=>void openPicker()}>{label}</button>}
    {open&&!unsettled&&<div id={`${uid}-picker`} onKeyDown={escape} className="mt-2.5 min-w-0 border border-line bg-canvas p-3">
      {loading&&<p role="status" className="my-1 text-sm text-muted">Đang kiểm tra cách mở Director trên máy này…</p>}
      {options&&<>
        {!options.terminal.available&&<p className="mt-0 mb-2 border-l-3 border-warning pl-3 text-sm">Máy này không mở được terminal tự động{options.terminal.reason?`: ${options.terminal.reason}`:'.'} Bflow sẽ trả về lệnh để bạn tự chạy.</p>}
        <div role="radiogroup" aria-label="Nhà cung cấp cho Director" className="grid gap-1.5">
          {options.providers.map(option=><div key={option.provider} className="min-w-0">
            <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${uid}-provider`} value={option.provider} checked={provider===option.provider} disabled={option.state==='unavailable'} onChange={()=>{setProvider(option.provider);setProfileName(rememberedProfile(option.provider));}}/>{providerLabels[option.provider]} · {stateLabels[option.state]}</label>
            {option.reason&&<p className="my-0.5 ml-6 text-xs text-muted">{option.reason}</p>}
          </div>)}
        </div>
        {chosen&&<div className="mt-3 min-w-0">
          <label htmlFor={`${uid}-profile`} className="block text-sm">Profile ai-isolator</label>
          <select id={`${uid}-profile`} className="mt-1 w-full" value={profileName} onChange={event=>setProfileName(event.target.value)}>
            <option value="">Mặc định trên máy (không dùng ai-isolator)</option>
            {profileName&&!selectedProfile&&<option value={profileName} disabled>{profileName} · Không còn sẵn sàng</option>}
            {(chosen.profiles??[]).map(profile=><option key={profile.name} value={profile.name} disabled={profile.state==='unavailable'}>{profile.name}{profile.state==='unavailable'?' · Không dùng được':''}</option>)}
          </select>
          {profileBlocked&&<p role="alert" className="my-1 text-sm text-warning">Profile đã chọn không còn sẵn sàng. Chọn lại profile hoặc chọn rõ cấu hình mặc định trên máy.{selectedProfile?.reason?` ${selectedProfile.reason}`:''}</p>}
          {chosen.profiles?.filter(profile=>profile.state==='unavailable').map(profile=><p key={profile.name} className="my-1 text-xs text-muted">{profile.name}: {profile.reason??'Chưa dùng được.'}</p>)}
          {chosen.provider==='agy'&&<p className="my-1 text-xs text-muted">ai-isolator hiện hỗ trợ profile Codex và Claude Code.</p>}
        </div>}
        {!options.providers.some(option=>option.state!=='unavailable')&&<p className="text-sm text-warning">Chưa có nhà cung cấp nào dùng được cho Director trên máy này.</p>}
        {needsReplace&&<label className="mt-2 flex items-start gap-2 text-sm"><input type="checkbox" checked={replace} onChange={event=>setReplace(event.target.checked)}/><span>{d.presence==='absent'&&waitingForDirector&&result?`Mở phiên thay thế. Cửa sổ terminal Director mở lúc ${time(result.launchedAt)} có thể đang khởi động Director; cửa sổ đó không bị đóng.`:`Mở phiên thay thế. Director có thể đang chạy (${d.presence==='unknown'?'chưa đọc được trạng thái':'đang có mặt'}); phiên hiện có không bị dừng.`}</span></label>}
        {chosen&&!profileName&&<details className="mt-2"><summary className="text-sm">Lệnh tự chạy cho {providerLabels[chosen.provider]}</summary><CopyCommand command={chosen.manualCommand}/></details>}
        <div className="mt-2.5 flex flex-wrap gap-2"><button type="button" disabled={!chosen||chosen.state==='unavailable'||profileBlocked||(needsReplace&&!replace)||!command.online||command.busy} onClick={()=>void launch()}>{command.busy?'Đang mở…':'Mở terminal Director'}</button><button type="button" onClick={close}>Đóng</button></div>
      </>}
    </div>}
    <div ref={outcome} tabIndex={-1} aria-label="Kết quả mở phiên Director" className="min-w-0 outline-none">
    {unsettled&&!uncertain&&<p role="status" className="my-2 text-sm">Đang mở terminal Director…</p>}
    {uncertain&&<div className="my-2 border-l-3 border-warning pl-3 text-sm">
      <p className="my-1">Không rõ cửa sổ terminal đã mở hay chưa. Kiểm tra màn hình: nếu chưa có cửa sổ Director, mở bằng thao tác mới. Bflow không tự thử lại.</p>
      <div className="flex flex-wrap gap-2"><button type="button" onClick={command.reread}>Đọc lại kết quả mở phiên</button><button type="button" disabled={op?.state!=='reconciliation_required'} onClick={()=>void releaseUncertain()}>Tôi đã kiểm tra màn hình, mở bằng thao tác mới</button></div>
    </div>}
    {result?.profileName&&<p className="my-1 text-sm">Profile Director: {result.profileName}</p>}
    {result?.mode==='terminal_opened'&&<p role="status" className="my-2 text-sm">{arrived?'Director đã có mặt và đang nhận tin.':unconfirmedPresent?`Đã mở cửa sổ terminal lúc ${time(result.launchedAt)}. Có Director đang có mặt, nhưng chưa xác nhận đây là phiên mới vừa mở.`:waitingForDirector?`Đã mở cửa sổ terminal lúc ${time(result.launchedAt)}. Việc này chưa có nghĩa Director đã sẵn sàng; hãy đợi trạng thái chuyển sang “Đang hoạt động” hoặc “Đang chờ”.`:`Đã mở cửa sổ terminal lúc ${time(result.launchedAt)}. Không thấy Director đăng ký sau khi mở cửa sổ; kiểm tra cửa sổ terminal hoặc mở lại.`}</p>}
    {result?.mode==='terminal_opened'&&!arrived&&<details className="my-1"><summary className="text-sm">Không thấy cửa sổ? Lệnh tự chạy</summary><CopyCommand command={result.manualCommand}/></details>}
    {result?.mode==='manual_command'&&<div className="my-2 text-sm"><p className="my-1">Không mở được terminal tự động. Chạy lệnh sau trong một terminal trên máy này:</p><CopyCommand command={result.manualCommand}/>{arrived?<p role="status" className="my-1">Director đã có mặt và đang nhận tin.</p>:unconfirmedPresent?<p role="status" className="my-1">Có Director đang có mặt, nhưng chưa xác nhận đây là phiên mới vừa mở.</p>:null}</div>}
    {op?.state==='failed'&&<p className="my-2 border-l-3 border-danger pl-3 text-sm">{op.error?.message??'Chưa mở được Director.'}</p>}
    </div>
    {error&&<p role="alert" className="my-2 text-sm">{error}</p>}
  </div>;
}

/**
 * Overview block: Director presence and the launch action, only for a Director layout (confirmed by a view, or by this browser's
 * last confirmed layout hint while the view is unreadable). Legacy or never-confirmed projects get no Director panel.
 */
export function DirectorSessionPanel({chatPath}:{chatPath:string}){
  const d=useDirector();
  if(!d.directorLayout)return null;
  return <section data-component="DirectorSessionPanel" aria-label="Director" className="panel my-3 min-w-0 border border-line bg-surface p-3.5 sm:p-4">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="m-0 text-base">Trợ lý dự án · Director</h2><Link className="font-data text-xs font-semibold" to={chatPath}>Trò chuyện với Director →</Link></div>
    <DirectorPresenceStatus/>
    <div className="mt-2.5">
      {(d.layout==='director'||d.layout==='not_started'||d.hinted)&&<DirectorLaunch label="Khởi động phiên"/>}
      {d.layout==='not_started'&&<p className="my-1 text-sm text-muted">Chọn công cụ AI để bắt đầu. Director sẽ giúp bạn lập kế hoạch và giao việc cho nhóm.</p>}
      {d.hinted&&<p className="my-1 text-sm text-muted">Chưa đọc được trạng thái Director. Kiểm tra phiên hiện có trước khi xác nhận mở phiên thay thế.</p>}
    </div>
  </section>;
}
