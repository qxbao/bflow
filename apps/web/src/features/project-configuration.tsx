import { LoadingState } from '../components/LoadingState';
import { useEffect, useState, type FormEvent } from 'react';
import type { WebConfigValue, WebProjectConfiguration } from '@bflow/contracts/web';
import { ApiClient, explain } from '../api/client';

const titles:Record<string,string>={
 roles:'Provider và model theo vai trò',defaults:'Profile mặc định',permissions:'Quyền và độ tin cậy',
 verification:'Kiểm chứng',sdd:'Đặc tả và phê duyệt',tdd:'Chính sách TDD',concurrency:'Số tác vụ đồng thời',
 tools:'Công cụ tích hợp',requiredMcpServices:'MCP bắt buộc',requiredTools:'Công cụ bắt buộc',
 toolPolicy:'Quyền sử dụng công cụ',skills:'Skills',deepwiki:'Tra cứu tài liệu DeepWiki',
 fastPath:'Luồng nhanh',storage:'Lưu trữ',defaultWorkflow:'Workflow mặc định',
 herdrBinary:'Đường dẫn thực thi Herdr',startupTimeoutMs:'Thời gian chờ khởi động phiên (ms)',
 shutdownTimeoutMs:'Thời gian chờ dừng phiên (ms)',allowProviderFallback:'Cho phép dự phòng chuyển provider',
 reviewTimeoutMs:'Thời gian chờ đánh giá (ms)',maxIterations:'Số vòng sửa lỗi tối đa',
 regressionScope:'Phạm vi kiểm thử hồi quy',trustedWorkspace:'Tin cậy thư mục dự án',
 mode:'Chế độ quyền hạn',permissionMode:'Chế độ quyền hạn',isolation:'Cơ chế cô lập',
 minimumLevel:'Mức đặc tả tối thiểu',defaultPolicy:'Chính sách TDD mặc định',
 maxConcurrency:'Số tác vụ chạy song song',enabled:'Kích hoạt',
};
const roleLabels:Record<string,string>={
 conversation:'Trợ lý tiếp nhận',coordinator:'Điều phối viên',planner:'Lập kế hoạch',
 architect:'Kiến trúc sư',specifier:'Đặc tả',developer:'Lập trình viên',
 reviewer:'Kiểm duyệt mã',qa:'Kiểm thử QA',sos:'Cứu hộ sự cố (SOS)',
};
const choices:Record<string,string[]>={permissionMode:['restricted','workspace_auto','unattended_isolated'],cli:['claude','codex','agy'],effort:['minimal','low','medium','high','xhigh','max'],mode:['restricted','workspace_auto','unattended_isolated'],isolation:['provider_policy','os_sandbox','container'],minimumLevel:['lightweight','full'],regressionScope:['affected','full','mapped_only']};
const presetModels:Record<string,string[]>={claude:['haiku','sonnet','opus'],codex:['gpt-5.4','o4-mini'],agy:['gemini-2.5-pro']};

function Field({name,path,value,onChange,disabled=false}:{name:string;path:string;value:WebConfigValue;onChange:(v:WebConfigValue)=>void;disabled?:boolean}){
 const [draft,setDraft]=useState(JSON.stringify(value,null,2)),[error,setError]=useState('');
 useEffect(()=>{setDraft(JSON.stringify(value,null,2));setError('');},[value]);
 const id='config-'+path.replace(/[^a-zA-Z0-9_-]/g,'-');
 const label=titles[name]??name;
 if(value!==null && typeof value==='object' && !Array.isArray(value))return <fieldset className="my-2.5 min-w-0 border border-line p-3"><legend>{label}</legend><div className="grid gap-x-4 sm:grid-cols-2">{Object.entries(value).map(([key,item])=><div key={key} className={item!==null && typeof item==='object'?'sm:col-span-2':''}><Field name={key} path={`${path}.${key}`} value={item} onChange={next=>onChange({...value,[key]:next})} disabled={disabled || ['repositoryId','workspaceRoot','sessionName'].includes(key)}/></div>)}</div></fieldset>;
 if(typeof value==='boolean')return <label className="my-2 flex min-h-11 items-start gap-2.5 font-normal sm:min-h-9 [&_span]:min-w-0"><input type="checkbox" checked={value} disabled={disabled} onChange={e=>onChange(e.target.checked)}/><span>{label}<small className="font-mono text-xs">{path}</small></span></label>;
 if(typeof value==='string' || typeof value==='number')return <div className="my-2 [&_small]:mb-1 [&_small]:block"><label htmlFor={id}>{label}</label><small className="font-mono text-xs text-muted">{path}</small>{typeof value==='string' && choices[name]?.includes(value)?<select id={id} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}>{choices[name]!.map(option=><option key={option}>{option}</option>)}</select>:<input id={id} value={value} type={typeof value==='number'?'number':'text'} disabled={disabled} onChange={e=>onChange(typeof value==='number'?Number(e.target.value):e.target.value)}/>}</div>;
 return <div className="my-2 [&_small]:mb-1 [&_small]:block"><label htmlFor={id}>{name} (JSON)</label><textarea id={id} rows={Math.min(8,Math.max(2,draft.split('\n').length))} disabled={disabled} value={draft} aria-invalid={Boolean(error)} onChange={e=>{setDraft(e.target.value);try{const next=JSON.parse(e.target.value) as WebConfigValue;e.target.setCustomValidity('');onChange(next);setError('');}catch{e.target.setCustomValidity('JSON chưa hợp lệ.');setError('JSON chưa hợp lệ. Hoàn tất trước khi lưu.');}}}/>{error && <p role="alert">{error}</p>}</div>;
}

function Roles({value,onChange}:{value:WebConfigValue[];onChange:(v:WebConfigValue[])=>void}){
 const [bulkCli,setBulkCli]=useState('claude'),[bulkModel,setBulkModel]=useState('');
 const configuredModels=[...new Set(value.flatMap(item=>item && typeof item==='object' && !Array.isArray(item) && typeof item.model==='string' && item.model?[item.model]:[]))];
 const suggestions=[...new Set([...configuredModels,...(presetModels[bulkCli]??[])])];
 const applyAll=()=>{onChange(value.map(item=>{if(!item || typeof item!=='object' || Array.isArray(item))return item;const next:Record<string,WebConfigValue>={...item,cli:bulkCli};if(bulkModel.trim())next.model=bulkModel.trim();return next;}));};
 return <>
  <div className="my-2 border border-line bg-canvas p-2.5 text-xs">
   <div className="flex flex-wrap items-end gap-2">
    <div className="min-w-32"><label htmlFor="bulk-role-cli" className="text-xs">Áp dụng nhanh Provider</label><select id="bulk-role-cli" value={bulkCli} onChange={e=>setBulkCli(e.target.value)}>{['claude','codex','agy'].map(cli=><option key={cli}>{cli}</option>)}</select></div>
    <div className="min-w-40 flex-1"><label htmlFor="bulk-role-model" className="text-xs">Áp dụng nhanh Model</label><input id="bulk-role-model" value={bulkModel} placeholder="Ví dụ: haiku hoặc sonnet" onChange={e=>setBulkModel(e.target.value)}/></div>
    <button type="button" onClick={applyAll}>Áp dụng cho tất cả vai trò</button>
   </div>
   {suggestions.length>0 && <div className="mt-2 flex flex-wrap items-center gap-1.5"><span className="font-data text-muted">Chọn nhanh model:</span>{suggestions.map(m=><button type="button" key={m} className="min-h-7 px-2 py-0.5 text-xs" onClick={()=>setBulkModel(m)}>{m}</button>)}</div>}
  </div>
  <div className="grid items-start gap-2.5 md:grid-cols-2 2xl:grid-cols-3">{value.map((item,index)=>{
   if(!item || typeof item!=='object' || Array.isArray(item))return null;
   const roleName=String(item.role);
   const update=(key:string,next:string)=>{const role={...item};if(next)role[key]=next;else delete role[key];onChange(value.map((v,i)=>i===index?role:v));};
   const extraEntries=Object.entries(item).filter(([key])=>!['role','cli','model','profile-name','effort'].includes(key));
   return <fieldset className="my-0 min-w-0 border border-line bg-canvas p-2.5" key={index}><legend className="text-xs">{roleLabels[roleName]?`${roleLabels[roleName]} (${roleName})`:roleName}</legend><div className="grid gap-2 sm:grid-cols-2">
    <label className="text-xs">Provider ({roleName})<select value={String(item.cli??'claude')} onChange={e=>update('cli',e.target.value)}>{['claude','codex','agy'].map(cli=><option key={cli}>{cli}</option>)}</select></label>
    <label className="text-xs">Model ({roleName})<input value={String(item.model??'')} placeholder="Mặc định provider" onChange={e=>update('model',e.target.value)}/></label>
    <label className="text-xs">Profile ({roleName})<input value={String(item['profile-name']??'')} placeholder="Mặc định" onChange={e=>update('profile-name',e.target.value)}/></label>
    <label className="text-xs">Effort ({roleName})<select value={String(item.effort??'')} onChange={e=>update('effort',e.target.value)}><option value="">Mặc định</option>{choices.effort!.map(effort=><option key={effort}>{effort}</option>)}</select></label>
   </div>{extraEntries.length>0 && <details className="my-1.5 py-1"><summary className="min-h-8 text-xs">Thiết lập khác cho {roleName}</summary>{extraEntries.map(([key,v])=><Field key={key} name={key} path={`environment.roles.${index}.${key}`} value={v} onChange={next=>onChange(value.map((val,i)=>i===index?{...item,[key]:next}:val))}/>)}</details>}</fieldset>;
  })}</div>
 </>;
}

export function ProjectConfiguration({api,id,revision,disabled=false,onDirtyChange,onRevisionChange}:{api:ApiClient;id:string;revision:number;disabled?:boolean;onDirtyChange?:(dirty:boolean)=>void;onRevisionChange?:(revision:string)=>void}){
 const [saved,setSaved]=useState<WebProjectConfiguration>(),[values,setValues]=useState<Record<string,WebConfigValue>>({}),[yaml,setYaml]=useState(''),[mode,setMode]=useState<'form'|'yaml'>('form'),[error,setError]=useState<unknown>(),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[editorRevision,setEditorRevision]=useState(0),[invalidDraft,setInvalidDraft]=useState(false);
 const dirty=invalidDraft || Boolean(saved && (mode==='yaml'?yaml!==saved.yaml:JSON.stringify(values)!==JSON.stringify(saved.values)));
 useEffect(()=>{onDirtyChange?.(dirty);return()=>onDirtyChange?.(false);},[dirty,onDirtyChange]);
 useEffect(()=>{onRevisionChange?.(saved?.revision??'');},[saved?.revision,onRevisionChange]);
 const assign=(config:WebProjectConfiguration)=>{setSaved(config);setValues(config.values);setYaml(config.yaml);setEditorRevision(value=>value+1);setInvalidDraft(false);};
 async function load(){setBusy(true);setError(undefined);try{assign(await api.configuration(id));}catch(e){setError(e);}finally{setBusy(false);}}
 useEffect(()=>{void load();},[api,id,revision]);
 async function save(event:FormEvent){event.preventDefault();if(!saved)return;setBusy(true);setError(undefined);setMessage('');try{assign(await api.saveConfiguration(id,{apiVersion:1,expectedRevision:saved.revision,...(mode==='yaml'?{yaml}:{values})}));setMessage('Đã lưu cấu hình. Các thay đổi áp dụng khi khởi động lại phiên.');}catch(e){setError(e);}finally{setBusy(false);}}
 const env=values.environment && typeof values.environment==='object' && !Array.isArray(values.environment)?values.environment:{};
 const setEnv=(key:string,value:WebConfigValue)=>setValues({...values,environment:{...env,[key]:value}});
 const envEntries=Object.entries({...{requiredMcpServices:[],requiredTools:[]},...env}).filter(([key])=>!['roles','repositoryId','workspaceRoot','sessionName'].includes(key));
 return <section id="settings-configuration" className="panel my-4 min-w-0 border border-line bg-surface p-3.5 sm:p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="m-0 text-base">Cấu hình dự án (.bflow/config.yml)</h2>{saved && <div className="flex flex-wrap items-center gap-1.5"><button aria-pressed={mode==='form'} disabled={busy||disabled||dirty} onClick={()=>setMode('form')}>Form cấu hình</button><button aria-pressed={mode==='yaml'} disabled={busy||disabled||dirty} onClick={()=>setMode('yaml')}>YAML đầy đủ</button></div>}</div>
 <p className="my-1.5 text-sm text-muted">Chọn provider, model và chính sách cho dự án. Nếu phiên đang chạy, cần dừng rồi khởi động lại phiên để áp dụng cấu hình mới.</p>
 <LoadingState loading={busy} initial={!saved} label="Đang đọc / lưu cấu hình…"/>{Boolean(error) && <p role="alert" className="my-2 border-l-3 border-warning pl-3 text-sm">{saved?explain(error):'Chưa có tệp cấu hình. Hãy thực hiện bước “Khởi tạo / sửa GitNexus” ngay bên dưới để tạo cấu hình mặc định.'}</p>}
 {!saved && <button disabled={busy||disabled} onClick={()=>void load()}>Đọc lại cấu hình</button>}
 {saved && <>{dirty && <p className="my-1.5 text-xs text-warning">Đang có thay đổi chưa lưu. Lưu hoặc bỏ thay đổi trước khi chuyển chế độ xem.</p>}
 <form onSubmit={save} onChange={e=>setInvalidDraft(!e.currentTarget.checkValidity())}><fieldset key={editorRevision} disabled={busy||disabled} className="m-0 min-w-0 border-0 p-0">{mode==='yaml'?<><label htmlFor="config-yaml">Nội dung YAML đầy đủ</label><textarea id="config-yaml" className="w-full overflow-auto font-mono text-base leading-relaxed whitespace-pre lg:text-sm [tab-size:2]" rows={18} spellCheck={false} value={yaml} onChange={e=>setYaml(e.target.value)}/></>:<>
 <div className="my-2 sm:max-w-md"><label>Tên dự án<input value={String(values.projectName??'')} onChange={e=>setValues({...values,projectName:e.target.value})}/></label></div>
 <details open className="my-2"><summary>Provider và model theo vai trò ({Array.isArray(env.roles)?env.roles.length:0})</summary>{Array.isArray(env.roles) && <Roles value={env.roles} onChange={v=>setEnv('roles',v)}/>}</details>
 <div className="grid items-start gap-x-4 lg:grid-cols-2">
  {envEntries.map(([key,value])=><details key={key} className="my-1"><summary>{titles[key]??key}</summary><Field name={key} path={`environment.${key}`} value={value} onChange={v=>setEnv(key,v)}/></details>)}
  <details className="my-1"><summary>Lưu trữ, workflow và thông tin hệ thống</summary>{Object.entries(values).filter(([key])=>!['projectName','environment'].includes(key)).map(([key,value])=><Field key={key} name={key} path={key} value={value} onChange={v=>setValues({...values,[key]:v})} disabled={['schemaVersion','runtimeId','createdAt'].includes(key)}/>)}</details>
 </div>
 </>}</fieldset><div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3"><button className="min-w-32 border-ink bg-brand font-semibold text-ink hover:bg-ink hover:text-surface" disabled={busy||disabled||!dirty}>Lưu cấu hình</button><button type="button" disabled={busy||disabled} onClick={()=>{assign(saved);setMessage('');setError(undefined);}}>Bỏ thay đổi</button><button type="button" disabled={busy||disabled||dirty} onClick={()=>void load()}>Tải cấu hình mới nhất</button></div></form></>}
 {saved?.gitIgnore!==undefined && <details className="my-2"><summary>Quy tắc Git .bflow/.gitignore sẽ được commit cùng cấu hình</summary><pre className="text-xs">{saved.gitIgnore}</pre></details>}
 {message && <p role="status" className="my-2 text-sm text-success">{message}</p>}
 </section>;
}
