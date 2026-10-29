import { useEffect, useState, type FormEvent } from 'react';
import type { WebConfigValue, WebProjectConfiguration } from '@bflow/contracts/web';
import { ApiClient, explain } from '../api/client';

const titles:Record<string,string>={roles:'Provider và model theo vai trò',defaults:'Profile mặc định',permissions:'Quyền và độ tin cậy',verification:'Kiểm chứng',sdd:'Đặc tả và phê duyệt',tdd:'Chính sách TDD',concurrency:'Số tác vụ đồng thời',tools:'Công cụ tích hợp',requiredMcpServices:'MCP bắt buộc',requiredTools:'Công cụ bắt buộc',toolPolicy:'Quyền sử dụng công cụ',skills:'Skills',context7:'Tra cứu tài liệu Context7',fastPath:'Luồng nhanh',storage:'Lưu trữ',defaultWorkflow:'Workflow mặc định'};
const choices:Record<string,string[]>={permissionMode:['restricted','workspace_auto','unattended_isolated'],cli:['claude','codex','agy'],effort:['minimal','low','medium','high','xhigh','max'],mode:['restricted','workspace_auto','unattended_isolated'],isolation:['provider_policy','os_sandbox','container'],minimumLevel:['lightweight','full'],regressionScope:['affected','full','mapped_only']};
function Field({name,path,value,onChange,disabled=false}:{name:string;path:string;value:WebConfigValue;onChange:(v:WebConfigValue)=>void;disabled?:boolean}){
 const [draft,setDraft]=useState(JSON.stringify(value,null,2)),[error,setError]=useState('');
 useEffect(()=>{setDraft(JSON.stringify(value,null,2));setError('');},[value]);
 const id='config-'+path.replace(/[^a-zA-Z0-9_-]/g,'-');
 if(value!==null && typeof value==='object' && !Array.isArray(value))return <fieldset className="config-group"><legend>{titles[name]??name}</legend>{Object.entries(value).map(([key,item])=><Field key={key} name={key} path={`${path}.${key}`} value={item} onChange={next=>onChange({...value,[key]:next})} disabled={disabled || ['repositoryId','workspaceRoot','sessionName'].includes(key)}/>)}</fieldset>;
 if(typeof value==='boolean')return <label className="check-row"><input type="checkbox" checked={value} disabled={disabled} onChange={e=>onChange(e.target.checked)}/><span>{name}<small>{path}</small></span></label>;
 if(typeof value==='string' || typeof value==='number')return <div className="config-field"><label htmlFor={id}>{name}</label><small className="muted">{path}</small>{typeof value==='string' && choices[name]?.includes(value)?<select id={id} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}>{choices[name]!.map(option=><option key={option}>{option}</option>)}</select>:<input id={id} value={value} type={typeof value==='number'?'number':'text'} disabled={disabled} onChange={e=>onChange(typeof value==='number'?Number(e.target.value):e.target.value)}/>}</div>;
 return <div className="config-field"><label htmlFor={id}>{name} (JSON)</label><textarea id={id} rows={Math.min(12,draft.split('\n').length+1)} disabled={disabled} value={draft} aria-invalid={Boolean(error)} onChange={e=>{setDraft(e.target.value);try{const next=JSON.parse(e.target.value) as WebConfigValue;e.target.setCustomValidity('');onChange(next);setError('');}catch{e.target.setCustomValidity('JSON chưa hợp lệ.');setError('JSON chưa hợp lệ. Hoàn tất trước khi lưu.');}}}/>{error && <p role="alert">{error}</p>}</div>;
}
function Roles({value,onChange}:{value:WebConfigValue[];onChange:(v:WebConfigValue[])=>void}){
 return <div>{value.map((item,index)=>{
  if(!item || typeof item!=='object' || Array.isArray(item))return null;
  const update=(key:string,next:string)=>{const role={...item};if(next)role[key]=next;else delete role[key];onChange(value.map((v,i)=>i===index?role:v));};
  return <fieldset className="config-group" key={index}><legend>{String(item.role)}</legend><div className="config-grid">
   <label>Provider ({String(item.role)})<select value={String(item.cli??'claude')} onChange={e=>update('cli',e.target.value)}>{['claude','codex','agy'].map(cli=><option key={cli}>{cli}</option>)}</select></label>
   <label>Model ({String(item.role)})<input value={String(item.model??'')} placeholder="Mặc định của provider" onChange={e=>update('model',e.target.value)}/></label>
   <label>Profile ({String(item.role)})<input value={String(item['profile-name']??'')} placeholder="Profile mặc định" onChange={e=>update('profile-name',e.target.value)}/></label>
   <label>Effort ({String(item.role)})<select value={String(item.effort??'')} onChange={e=>update('effort',e.target.value)}><option value="">Mặc định</option>{choices.effort!.map(effort=><option key={effort}>{effort}</option>)}</select></label>
  </div><details><summary>Thiết lập khác cho {String(item.role)}</summary>{Object.entries(item).filter(([key])=>!['role','cli','model','profile-name','effort'].includes(key)).map(([key,v])=><Field key={key} name={key} path={`environment.roles.${index}.${key}`} value={v} onChange={next=>onChange(value.map((v,i)=>i===index?{...item,[key]:next}:v))}/>)}</details></fieldset>;
 })}</div>;
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
 return <section className="panel"><h2>Cấu hình .bflow/config.yml</h2><p>Chọn provider, model và chính sách theo dự án. Dừng rồi khởi động phiên để áp dụng cấu hình mới.</p>
 {busy && <p role="status">Đang đọc / lưu cấu hình…</p>}{Boolean(error) && <p role="alert">{saved?explain(error):'Chưa đọc được cấu hình. Khởi tạo dự án bên trên; nếu file đã có, kiểm tra quyền đọc và định dạng YAML.'}</p>}
 {!saved && <button disabled={busy||disabled} onClick={()=>void load()}>Đọc lại cấu hình</button>}
 {saved && <><div className="action-buttons"><button aria-pressed={mode==='form'} disabled={busy||disabled||dirty} onClick={()=>setMode('form')}>Form cấu hình</button><button aria-pressed={mode==='yaml'} disabled={busy||disabled||dirty} onClick={()=>setMode('yaml')}>YAML đầy đủ</button></div>{dirty && <p className="muted">Có thay đổi chưa lưu. Lưu hoặc bỏ thay đổi trước khi chuyển chế độ.</p>}
 <form onSubmit={save} onChange={e=>setInvalidDraft(!e.currentTarget.checkValidity())}><fieldset key={editorRevision} disabled={busy||disabled} className="config-editor">{mode==='yaml'?<><label htmlFor="config-yaml">Nội dung YAML đầy đủ</label><textarea id="config-yaml" className="yaml-editor" rows={24} spellCheck={false} value={yaml} onChange={e=>setYaml(e.target.value)}/></>:<>
 <label>Tên dự án<input value={String(values.projectName??'')} onChange={e=>setValues({...values,projectName:e.target.value})}/></label>
 <details open><summary>Provider và model theo vai trò</summary>{Array.isArray(env.roles) && <Roles value={env.roles} onChange={v=>setEnv('roles',v)}/>}</details>
 {Object.entries({...{requiredMcpServices:[],requiredTools:[]},...env}).filter(([key])=>!['roles','repositoryId','workspaceRoot','sessionName'].includes(key)).map(([key,value])=><details key={key}><summary>{titles[key]??key}</summary><Field name={key} path={`environment.${key}`} value={value} onChange={v=>setEnv(key,v)}/></details>)}
 <details><summary>Lưu trữ, workflow và thông tin hệ thống</summary>{Object.entries(values).filter(([key])=>!['projectName','environment'].includes(key)).map(([key,value])=><Field key={key} name={key} path={key} value={value} onChange={v=>setValues({...values,[key]:v})} disabled={['schemaVersion','runtimeId','createdAt'].includes(key)}/>)}</details>
 </>}</fieldset><div className="action-buttons"><button className="primary" disabled={busy||disabled||!dirty}>Lưu cấu hình</button><button type="button" disabled={busy||disabled} onClick={()=>{assign(saved);setMessage('');setError(undefined);}}>Bỏ thay đổi</button><button type="button" disabled={busy||disabled||dirty} onClick={()=>void load()}>Tải cấu hình mới nhất</button></div></form></>}
 {saved?.gitIgnore!==undefined && <details><summary>Quy tắc Git .bflow/.gitignore sẽ được commit cùng cấu hình</summary><pre>{saved.gitIgnore}</pre></details>}
 {message && <p role="status">{message}</p>}
 </section>;
}
