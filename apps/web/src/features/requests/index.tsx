import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { WebCommandSchema, type WebAction } from '@bflow/contracts/web';
import { ApiClient, explain } from '../../api/client';
import { useCommands } from '../operations';
import type { CommandBody } from '../../api/commands';
type Draft={title:string;requestKind:'feature'|'bugfix'|'refactor'|'spike';objective:string;criteria:string;constraints:string;verificationMethod:'unit_test'|'integration_test'|'e2e_test'|'typecheck'|'lint'|'static_analysis'|'manual_review'};
const empty:Draft={title:'',requestKind:'feature',objective:'',criteria:'',constraints:'',verificationMethod:'integration_test'};
export function RequestForm({api,id,sessionId,enabled,runId,action}:{api:ApiClient;id:string;sessionId:string;enabled:boolean;runId?:string;action?:WebAction}) {
  const slot=runId?`revise:${runId}`:'create',key=`bflow:web:draft:${encodeURIComponent(id)}:${encodeURIComponent(sessionId)}:${encodeURIComponent(api.expiresAt??'unpaired')}:${slot}`,uid=useId();
  const [draft,setDraft]=useState<Draft>(()=>{try{const parsed=JSON.parse(sessionStorage.getItem(key)??'null');return parsed && Object.keys(empty).every(k=>typeof parsed[k]==='string')?{...empty,...parsed}:empty;}catch{return empty;}});
  const [errors,setErrors]=useState<Record<string,string>>({}),[message,setMessage]=useState('');const summary=useRef<HTMLDivElement>(null);
  const commands=useCommands(slot);
  useEffect(()=>{try{sessionStorage.setItem(key,JSON.stringify(draft));}catch{setMessage('Không lưu được bản nháp trong trình duyệt.');}},[key,draft]);
  useEffect(()=>{if(Object.keys(errors).length)summary.current?.focus();},[errors]);
  function field(key:keyof Draft){return {id:uid+key,value:draft[key],onChange:(e:{target:{value:string}})=>setDraft({...draft,[key]:e.target.value}), 'aria-invalid':Boolean(errors[key]),'aria-describedby':errors[key]?uid+key+'-error':undefined};}
  async function submit(event:FormEvent){event.preventDefault();if(!enabled || commands.busy || !commands.online)return;
    const requirements={objective:draft.objective.trim(),acceptanceCriteria:draft.criteria.split('\n').filter(x=>x.trim()).map(description=>({description:description.trim(),verificationMethod:draft.verificationMethod})),constraints:draft.constraints.split('\n').filter(x=>x.trim()).map(x=>x.trim())};
    const body:CommandBody=runId && action?{kind:'revise_request',runId,expectedVersion:{revisionToken:action.expectedVersion.revisionToken},...requirements}:{kind:'create_request',title:draft.title.trim(),requestKind:draft.requestKind,...requirements};
    const parsed=WebCommandSchema.safeParse({...body,apiVersion:1,projectId:id,commandId:crypto.randomUUID()});
    if(!parsed.success){const next:Record<string,string>={};for(const issue of parsed.error.issues){const key=issue.path[0]==='acceptanceCriteria'?'criteria':String(issue.path[0]);next[key]='Vui lòng nhập nội dung hợp lệ trong giới hạn cho phép.';}setErrors(next);return;}
    setErrors({});try{
      // Fresh readiness is observation; admission/authority stays on the host.
      if(!runId && (await api.sessionView(id)).state!=='ready')throw new Error('Phiên dự án chưa sẵn sàng.');
      if(runId){const fresh=await api.run(id,runId);if(!fresh.availableActions.some(a=>a.kind==='revise_request' && a.enabled && a.actionId===action?.actionId && a.expectedVersion.revisionToken===action.expectedVersion.revisionToken))throw new Error('Yêu cầu đã đổi. Đọc lại công việc trước khi chỉnh sửa.');}
      await commands.submit(body);setMessage('Đã gửi hoặc đang đối chiếu yêu cầu. Theo dõi thao tác bên dưới.');
    }catch(e){setMessage(e instanceof Error && !('code' in e)?e.message:explain(e));}
  }
  const input=(key:'title'|'objective'|'criteria'|'constraints',label:string,max:number,multiline=false)=><div className="my-4"><label htmlFor={uid+key}>{label}</label>{multiline?<textarea {...field(key)} maxLength={max} rows={4}/>:<input {...field(key)} maxLength={max}/>} {errors[key] && <p id={uid+key+'-error'} role="alert">{errors[key]}</p>}</div>;
  return <section className="panel min-w-0 border border-line bg-surface p-4 sm:p-5"><h2>{runId?'Chỉnh yêu cầu':'Tạo công việc'}</h2><p>Bản nháp yêu cầu được gửi qua tiếp nhận của phiên dự án. Tiêu chí chưa phải đặc tả đã duyệt.</p><form noValidate onSubmit={e=>void submit(e)}>
    {Object.keys(errors).length>0 && <div role="alert" ref={summary} tabIndex={-1}><h3>Kiểm tra thông tin</h3>{Object.keys(errors).map(key=><p key={key}><a href={'#'+uid+key}>{errors[key]}</a></p>)}</div>}
    {!runId && <>{input('title','Tên công việc',200)}<label htmlFor={uid+'kind'}>Loại yêu cầu</label><select id={uid+'kind'} value={draft.requestKind} onChange={e=>setDraft({...draft,requestKind:e.target.value as Draft['requestKind']})}><option value="feature">Tính năng</option><option value="bugfix">Sửa lỗi</option><option value="refactor">Cải tiến mã</option><option value="spike">Khảo sát</option></select></>}
    {runId && <p>Bản đọc hiện tại chưa có nội dung yêu cầu gốc. Nhập đầy đủ mục tiêu, tiêu chí và ràng buộc thay thế; đối chiếu lịch sử trước khi gửi.</p>}
    {input('objective','Mục tiêu',16000,true)}{input('criteria','Tiêu chí chấp nhận (mỗi dòng một tiêu chí)',16000,true)}<label htmlFor={uid+'method'}>Cách kiểm chứng tiêu chí</label><select id={uid+'method'} value={draft.verificationMethod} onChange={e=>setDraft({...draft,verificationMethod:e.target.value as Draft['verificationMethod']})}>{Object.entries({unit_test:'Kiểm thử đơn vị',integration_test:'Kiểm thử tích hợp',e2e_test:'Kiểm thử toàn luồng',typecheck:'Kiểm tra kiểu',lint:'Kiểm tra mã',static_analysis:'Phân tích tĩnh',manual_review:'Xem xét thủ công'}).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select>
    {input('constraints','Ràng buộc (mỗi dòng một ràng buộc)',16000,true)}<button className="border-ink bg-brand font-semibold text-ink hover:bg-ink hover:text-surface" disabled={!enabled || commands.busy || !commands.online}>{commands.busy?'Đang gửi…':runId?'Gửi chỉnh sửa':'Tạo công việc'}</button>{!enabled && <p>Phiên hoặc thao tác chưa sẵn sàng; tải lại trạng thái để kiểm tra.</p>}{message && <p role="status">{message}</p>}
  </form></section>;
}
