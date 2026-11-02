import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { WebProject, WebProjectInspection, WebProjectInitialization } from '@bflow/contracts/web';
import { ApiClient, ApiError, ConfigurationError, explain } from '../api/client';
import { FieldHelp, FieldLabel } from '../components/FieldHelp';
import { StatusBadge } from '../components/StatusBadge';
import { ProjectConfiguration } from './project-configuration';

function humanizeCheck(check:{id:string;state:'passed'|'failed'|'unsupported';message:string}):{title:string;hint?:string} {
 const id=check.id.toLowerCase(),msg=check.message;
 if(id.includes('topology') || msg.includes('No topology manifest'))return {title:'Phiên làm việc chưa khởi động',hint:'Điều này bình thường khi dự án đang dừng. Sau khi lưu và commit cấu hình, mở Tổng quan và bấm “Khởi động phiên”.'};
 if(id.includes('runtime-shutdown'))return {title:'Cơ chế dừng phiên an toàn',hint:'Hệ thống sẽ tự lưu điểm kiểm tra (checkpoint) trước khi đóng các tiến trình khi dừng phiên.'};
 if(id.includes('tool-policy-') && id.includes('-installed'))return {title:`Công cụ trên máy (${check.id.replace(/^tool-policy-|-repository-installed$/g,'')})`,hint:'Đã tìm thấy trên PATH; Bflow sẽ xác thực bản cài đặt chuẩn khi phiên thực sự dùng công cụ này.'};
 if(id.includes('gitnexus') || msg.includes('GitNexus'))return {title:'Chỉ mục mã nguồn GitNexus',hint:'Khởi tạo GitNexus ở mục Khởi tạo bên dưới, hoặc chọn “Khởi tạo không dùng GitNexus” nếu không cần.'};
 if(id.includes('sandbox') || msg.includes('Bubblewrap'))return {title:'Môi trường cô lập kiểm chứng (Sandbox)',hint:'Hệ điều hành đang hạn chế user namespace (AppArmor). Các bước kiểm chứng không yêu cầu sandbox ứng dụng vẫn hoạt động.'};
 if(id.includes('skill'))return {title:'Danh mục kỹ năng hệ thống (Skills)',hint:'Cần đồng bộ bộ kỹ năng chuẩn của Bflow trên máy trước khi khởi động phiên.'};
 if(id.includes('config') || msg.includes('config.yml'))return {title:'Tệp cấu hình dự án (.bflow/config.yml)',hint:'Khởi tạo dự án ở mục Khởi tạo bên dưới rồi commit cấu hình vào Git.'};
 if(id.includes('provider') || id.includes('claude') || id.includes('codex') || id.includes('agy'))return {title:`Kết nối công cụ AI (${check.id})`,hint:'Đảm bảo công cụ đã đăng nhập sẵn sàng trên máy này.'};
 return {title:check.id};
}

export function Settings({api,project,refresh=()=>{}}:{api:ApiClient;project:WebProject;refresh?:()=>void}) {
 const navigate=useNavigate(),id=project.projectId;
 const key=`bflow:init:${id}`;
 const [inspection,setInspection]=useState<WebProjectInspection>(),[inspecting,setInspecting]=useState(false),[error,setError]=useState<unknown>(),[busy,setBusy]=useState(false),[license,setLicense]=useState(false),[update,setUpdate]=useState(false),[provider,setProvider]=useState(''),[skipGitNexus,setSkipGitNexus]=useState(false),[job,setJob]=useState<WebProjectInitialization>(),[operationId,setOperationId]=useState(()=>localStorage.getItem(key)??''),[confirmRemove,setConfirmRemove]=useState(false),[configRevision,setConfigRevision]=useState(0),[pollAttempt,setPollAttempt]=useState(0),[configDirty,setConfigDirty]=useState(false),[configFileRevision,setConfigFileRevision]=useState(''),[commitConfiguration,setCommitConfiguration]=useState(false);
 const refreshRef=useRef(refresh);refreshRef.current=refresh;
 const inspectGen=useRef(0),activeId=useRef(id);activeId.current=id;
 const running=job?.state==='running' || Boolean(operationId && !job);
 useEffect(()=>{
  inspectGen.current+=1;
  setInspecting(false);setInspection(undefined);setError(undefined);setJob(undefined);setConfirmRemove(false);setConfigDirty(false);setConfigFileRevision('');setCommitConfiguration(false);
  setOperationId(localStorage.getItem(`bflow:init:${id}`)??'');
 },[id]);
 async function inspect(){
  const targetId=id,gen=++inspectGen.current;
  const current=()=>activeId.current===targetId && inspectGen.current===gen;
  setInspecting(true);setError(undefined);
  try{const next=await api.inspect(targetId);if(current())setInspection(next);}catch(e){if(current())setError(e);}finally{if(current())setInspecting(false);}
 }
 useEffect(()=>{
  if(!operationId)return;let active=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const next=await api.initialization(id,operationId);if(!active)return;setJob(next);setError(undefined);if(next.state==='running')timer=setTimeout(()=>void poll(),1500);else{if(next.state==='succeeded'){setConfigRevision(v=>v+1);refreshRef.current();}localStorage.removeItem(key);if(next.state!=='interrupted')localStorage.removeItem(key+':request');}}catch(e){if(active){setError(e);if(e instanceof ApiError && ['not_found','invalid_request','forbidden','operation_not_allowed'].includes(e.code)){localStorage.removeItem(key);setJob({apiVersion:1,projectId:id,operationId,state:'interrupted',message:e.code==='not_found'?'Chưa tìm thấy biên nhận. Có thể yêu cầu chưa được gửi. Dùng Gửi lại cùng mã để kiểm tra và tiếp tục an toàn.':explain(e),updatedAt:new Date().toISOString()});}else timer=setTimeout(()=>void poll(),5000);}}};
  void poll();return()=>{active=false;clearTimeout(timer);};
 },[api,id,operationId,pollAttempt,key]);
 async function initialize(retry=false){
  if(busy||running)return;
  setError(undefined);setBusy(true);
  let op='';
  try{
   let request:Record<string,unknown>|null;
   if(retry){
    try{
     const parsed:unknown=JSON.parse(localStorage.getItem(key+':request')??'null');
     request=parsed && typeof parsed==='object' && 'operationId' in parsed && typeof parsed.operationId==='string'?parsed as Record<string,unknown>:null;
    }catch{
     localStorage.removeItem(key+':request');
     throw new ConfigurationError('Dữ liệu yêu cầu khởi tạo đã lưu bị hỏng. Hãy thực hiện khởi tạo mới.');
    }
    if(!request){
     localStorage.removeItem(key+':request');
     throw new ConfigurationError('Không còn biên nhận yêu cầu khởi tạo để gửi lại. Hãy thực hiện khởi tạo mới.');
    }
   }else{
    request={apiVersion:1,operationId:crypto.randomUUID(),acceptGitNexusLicense:license,skipGitNexus,update,...(commitConfiguration?{commitConfiguration:true,expectedConfigurationRevision:configFileRevision}:{}),...(provider?{provider}:{})};
   }
   op=String(request.operationId);
   localStorage.setItem(key,op);localStorage.setItem(key+':request',JSON.stringify(request));
   setJob(undefined);
   setJob(await api.initialize(id,request));setOperationId(op);setPollAttempt(value=>value+1);
  }catch(e){
   setError(e);
   if(e instanceof ConfigurationError || (e instanceof ApiError && ['invalid_request','forbidden','operation_not_allowed','not_found','stale_version'].includes(e.code))){
    setOperationId('');localStorage.removeItem(key);localStorage.removeItem(key+':request');return;
   }
   if(op){setOperationId(op);setPollAttempt(value=>value+1);}
  }finally{setBusy(false);}
 }
 async function unregister(){if(busy||running)return;setBusy(true);setError(undefined);try{await api.unregister(id);refresh();navigate('/');}catch(e){setError(e);}finally{setBusy(false);}}
 const attentionChecks=inspection?.checks.filter(c=>c.state!=='passed')??[],passedChecks=inspection?.checks.filter(c=>c.state==='passed')??[];
 return <><div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">Thông tin trên máy này</div><h1>Cài đặt dự án</h1>
 <nav aria-label="Các phần cài đặt" className="my-3 flex flex-wrap gap-x-5 gap-y-2 border-b border-line pb-2.5 font-data text-sm"><a href="#settings-readiness">Điều kiện sẵn sàng</a><a href="#settings-configuration">Cấu hình</a><a href="#settings-initialize">Khởi tạo</a><a href="#settings-remove" className="text-danger">Hủy đăng ký</a></nav>
 {Boolean(error) && <p role="alert" className="my-3 border border-danger border-l-3 bg-surface p-3 text-sm">{explain(error)}</p>}

 <section id="settings-readiness" className="panel my-4 min-w-0 border border-line bg-surface p-3.5 sm:p-4">
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="m-0 text-base">{project.displayName}</h2><p className="my-1 font-mono text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">{project.canonicalPath}</p></div><button className="min-w-52" disabled={inspecting||busy||running} onClick={()=>void inspect()}>{inspecting?'Đang kiểm tra…':'Kiểm tra điều kiện sẵn sàng'}</button></div>
  {!configFileRevision && <p className="my-2 border-l-3 border-accent bg-canvas px-3 py-2 text-sm">Dự án mới đăng ký? Hãy xuống mục <a href="#settings-initialize" className="font-semibold">Khởi tạo / sửa GitNexus ↓</a> để tạo cấu hình ban đầu.</p>}
  {inspection && <div className="mt-3 border-t border-line pt-3">
   <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><h3 className="m-0 text-sm">Kết quả kiểm tra</h3><StatusBadge value={inspection.ready?'passed':'failed'}/></div><span className="font-data text-xs text-muted">{attentionChecks.length} {inspection.ready?'lưu ý tham khảo':'mục cần lưu ý'} · {passedChecks.length} mục đạt · Quan sát lúc {new Date(inspection.observedAt).toLocaleTimeString('vi')}</span></div>
   <p className="my-1.5 text-sm">{inspection.ready?'Tất cả điều kiện bắt buộc đã sẵn sàng. Bạn có thể khởi động phiên ở trang Tổng quan.':'Một số điều kiện cần xử lý trước khi khởi động phiên:'}</p>
   {!inspection.ready && attentionChecks.length>0 && <ul className="my-2 list-none border border-line bg-canvas p-0 [&>li]:border-b [&>li]:border-line [&>li]:p-3 [&>li:last-child]:border-b-0">{attentionChecks.map((check,index)=>{const info=humanizeCheck(check);return <li key={index}><div className="flex flex-wrap items-center justify-between gap-2"><strong className="font-data text-sm">{info.title}</strong><StatusBadge value={check.state}/></div>{info.hint && <p className="my-1 text-sm text-ink">{info.hint}</p>}<p className="my-0.5 font-mono text-xs text-muted [overflow-wrap:anywhere]">{check.message}</p></li>;})}</ul>}
   {inspection.ready && attentionChecks.length>0 && <details className="my-2"><summary>Xem {attentionChecks.length} lưu ý tham khảo (không chặn khởi động)</summary><ul className="my-2 list-none border border-line bg-canvas p-0 [&>li]:border-b [&>li]:border-line [&>li]:p-3 [&>li:last-child]:border-b-0">{attentionChecks.map((check,index)=>{const info=humanizeCheck(check);return <li key={index}><div className="flex flex-wrap items-center justify-between gap-2"><strong className="font-data text-sm">{info.title}</strong><span className="badge badge-info inline-flex min-h-6 items-center gap-1.5 border px-2 py-0.5 font-data text-xs font-medium whitespace-nowrap">Lưu ý</span></div>{info.hint && <p className="my-1 text-sm text-ink">{info.hint}</p>}<p className="my-0.5 font-mono text-xs text-muted [overflow-wrap:anywhere]">{check.message}</p></li>;})}</ul></details>}
   {passedChecks.length>0 && <details className="my-2"><summary>Xem {passedChecks.length} hạng mục đã đạt</summary><ul className="my-2 max-h-64 overflow-y-auto list-none border border-line bg-canvas p-0 text-xs [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:justify-between [&>li]:gap-2 [&>li]:border-b [&>li]:border-line [&>li]:px-3 [&>li]:py-1.5 [&>li:last-child]:border-b-0">{passedChecks.map((check,index)=><li key={index}><span className="font-mono [overflow-wrap:anywhere]">{check.message}</span><StatusBadge value={check.state}/></li>)}</ul></details>}
  </div>}
 </section>

 <ProjectConfiguration api={api} id={id} revision={configRevision} disabled={busy||running} onDirtyChange={setConfigDirty} onRevisionChange={setConfigFileRevision}/>

 <section id="settings-initialize" className="panel my-4 min-w-0 border border-line bg-surface p-3.5 sm:p-4">
  <h2 className="mt-0 text-base">Khởi tạo / sửa GitNexus & Commit cấu hình</h2>
  <p className="my-1.5 text-sm">Tạo tệp cấu hình Bflow nếu chưa có, tùy chọn lập chỉ mục mã nguồn GitNexus và commit cấu hình sạch vào Git trước khi khởi động phiên.</p>
  <div className="my-2.5 grid gap-1.5 sm:grid-cols-2">
   <div className="flex min-h-11 items-start justify-between gap-2 border border-line bg-canvas p-2.5 sm:min-h-9">
    <label htmlFor="init-skip-gitnexus" className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 font-normal [&_span]:min-w-0"><input id="init-skip-gitnexus" type="checkbox" checked={skipGitNexus} disabled={busy||running} onChange={e=>setSkipGitNexus(e.target.checked)}/><span className="text-sm">Khởi tạo không dùng GitNexus (tắt công cụ này trong cấu hình)</span></label>
    <FieldHelp label="Khởi tạo không dùng GitNexus" help="Chọn mục này nếu bạn muốn tạo nhanh .bflow/config.yml mà không cần lập chỉ mục đồ thị mã nguồn GitNexus (ví dụ kho mã nhỏ hoặc dự án thương mại không dùng giấy phép phi thương mại của GitNexus)."/>
   </div>
   <div className="flex min-h-11 items-start justify-between gap-2 border border-line bg-canvas p-2.5 sm:min-h-9">
    <label htmlFor="init-accept-gitnexus" className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 font-normal [&_span]:min-w-0"><input id="init-accept-gitnexus" type="checkbox" checked={license} disabled={busy||running} onChange={e=>setLicense(e.target.checked)}/><span className="text-sm">Tôi chấp nhận điều kiện GitNexus và cho phép tạo chỉ mục dự án</span></label>
    <FieldHelp label="Chấp nhận điều kiện GitNexus" help="Xác nhận bạn đồng ý giấy phép PolyForm-Noncommercial-1.0.0 của GitNexus và cho phép Bflow lập chỉ mục mã nguồn cục bộ (.gitnexus/) để các vai trò AI tra cứu phụ thuộc chính xác hơn."/>
   </div>
   <div className="flex min-h-11 items-start justify-between gap-2 border border-line bg-canvas p-2.5 sm:min-h-9">
    <label htmlFor="init-update-config" className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 font-normal [&_span]:min-w-0"><input id="init-update-config" type="checkbox" checked={update} disabled={busy||running||commitConfiguration} onChange={e=>setUpdate(e.target.checked)}/><span className="text-sm">Cập nhật cấu hình: bổ sung mặc định mới, giữ lựa chọn đã có</span></label>
    <FieldHelp label="Cập nhật cấu hình" help="Tương đương lệnh bflow init --update: tự động điền thêm các khóa cấu hình mặc định của phiên bản Bflow mới mà không ghi đè model hay chính sách bạn đã chọn."/>
   </div>
   <div className="flex min-h-11 items-start justify-between gap-2 border border-line bg-canvas p-2.5 sm:min-h-9">
    <label htmlFor="init-commit-config" className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 font-normal [&_span]:min-w-0"><input id="init-commit-config" type="checkbox" checked={commitConfiguration} disabled={busy||running||configDirty||!configFileRevision} onChange={e=>{setCommitConfiguration(e.target.checked);if(e.target.checked)setUpdate(false);}}/><span className="text-sm">Commit cấu hình đã xem vào Git: chỉ .bflow/config.yml và .bflow/.gitignore (không chạy Git hooks)</span></label>
    <FieldHelp label="Commit cấu hình vào Git" help="Bflow yêu cầu tệp cấu hình phải được commit sạch trước khi mở worktree cho lập trình viên. Tùy chọn này chỉ commit đúng 2 tệp .bflow/config.yml và .bflow/.gitignore bạn đang xem; nếu kho đang có tệp khác staged thì hệ thống sẽ dừng an toàn."/>
   </div>
  </div>
  <div className="my-2.5 grid items-end gap-3 sm:grid-cols-[minmax(0,280px)_auto]">
   <div>
    <FieldLabel htmlFor="init-provider" label="Provider khi tạo / cập nhật cấu hình" help="Chọn công cụ AI mặc định (claude, codex hoặc agy) khi khởi tạo tệp .bflow/config.yml lần đầu hoặc khi chạy cập nhật. Để mặc định nếu muốn giữ nguyên cấu hình hiện tại."/>
    <select id="init-provider" disabled={busy||running} value={provider} onChange={e=>setProvider(e.target.value)}><option value="">Giữ cấu hình hiện tại / mặc định</option>{['claude','codex','agy'].map(cli=><option key={cli}>{cli}</option>)}</select>
   </div>
   <div><button className="min-w-48 border-ink bg-brand font-semibold text-ink hover:bg-ink hover:text-surface" disabled={busy||running||configDirty||(!license&&!skipGitNexus)} onClick={()=>void initialize()}>{running?'Đang khởi tạo…':'Khởi tạo / sửa GitNexus'}</button></div>
  </div>
  {configDirty && <p className="my-1.5 text-xs text-warning">Bạn đang có thay đổi cấu hình chưa lưu. Hãy lưu hoặc bỏ thay đổi ở mục Cấu hình trước.</p>}
  <details className="my-2"><summary>Lưu ý giấy phép GitNexus & quy tắc Commit</summary><p className="my-1 text-xs text-muted">GitNexus dùng giấy phép PolyForm-Noncommercial-1.0.0 (phi thương mại), ghi .gitnexus/ và .git/info/exclude. Tùy chọn Commit chỉ ghi .bflow/config.yml và .bflow/.gitignore; nếu kho đang có file khác staged thì thao tác sẽ dừng an toàn.</p></details>
  {job && <div role="status" className="mt-3 border-t border-line pt-2.5"><p className="my-1 font-data text-sm font-semibold">{job.state==='running'?'Đang thực hiện':job.state==='succeeded'?'Đã hoàn tất':job.state==='interrupted'?'Bị gián đoạn — cần kiểm tra':'Khởi tạo chưa hoàn tất'}</p><pre className="max-h-36 text-xs">{job.message}</pre><p className="my-1 font-mono text-xs text-muted [overflow-wrap:anywhere]">Mã thao tác: {job.operationId}</p>{job.state==='interrupted' && localStorage.getItem(key+':request') && <button disabled={busy} onClick={()=>void initialize(true)}>Gửi lại cùng mã</button>}</div>}
 </section>

 <section id="settings-remove" className="panel my-4 min-w-0 border border-line border-l-3 border-l-danger bg-surface p-3.5 sm:p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="m-0 text-base">Hủy đăng ký dự án</h2><p className="my-1 text-sm text-muted">Chỉ gỡ dự án khỏi danh sách web. Mã nguồn, cấu hình và lịch sử trên máy vẫn giữ nguyên.</p></div>{!confirmRemove && <button disabled={busy||running} onClick={()=>setConfirmRemove(true)}>Hủy đăng ký dự án</button>}</div>{confirmRemove && <div className="mt-2 border-t border-line pt-2.5"><p className="my-1.5 text-sm font-medium">Xác nhận hủy đăng ký {project.displayName}?</p><div className="flex flex-wrap items-center gap-2"><button disabled={busy||running} onClick={()=>void unregister()}>Xác nhận hủy đăng ký</button><button disabled={busy} onClick={()=>setConfirmRemove(false)}>Giữ dự án</button></div></div>}</section>
 </>;
}
