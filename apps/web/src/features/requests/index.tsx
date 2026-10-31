import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { WebCommandSchema, type WebAction } from '@bflow/contracts/web';
import { ApiClient, explain } from '../../api/client';
import { useCommands } from '../operations';
import type { CommandBody } from '../../api/commands';
type Method='unit_test'|'integration_test'|'e2e_test'|'typecheck'|'lint'|'static_analysis'|'manual_review';
type Draft={title:string;requestKind:'feature'|'bugfix'|'refactor'|'spike';objective:string;criteria:string;constraints:string;verificationMethod:Method;methods:Record<string,Method>};
const empty:Draft={title:'',requestKind:'feature',objective:'',criteria:'',constraints:'',verificationMethod:'integration_test',methods:{}};
const methodLabels:Record<Method,string>={unit_test:'Kiểm thử đơn vị',integration_test:'Kiểm thử tích hợp',e2e_test:'Kiểm thử toàn luồng',typecheck:'Kiểm tra kiểu',lint:'Kiểm tra mã',static_analysis:'Phân tích tĩnh',manual_review:'Xem xét thủ công'};
const lines=(text:string)=>[...new Set(text.split('\n').map(line=>line.trim()).filter(Boolean))];
export function RequestForm({api,id,sessionId,enabled,runId,action}:{api:ApiClient;id:string;sessionId:string;enabled:boolean;runId?:string;action?:WebAction}) {
  const slot=runId?`revise:${runId}`:'create',key=`bflow:web:draft:${encodeURIComponent(id)}:${encodeURIComponent(sessionId)}:${slot}`,uid=useId();
  const [draft,setDraft]=useState<Draft>(()=>{try{const parsed=JSON.parse(sessionStorage.getItem(key)??'null');return parsed && Object.keys(empty).filter(k=>k!=='methods').every(k=>typeof parsed[k]==='string')?{...empty,...parsed,methods:parsed.methods && typeof parsed.methods==='object'?parsed.methods:{}}:empty;}catch{return empty;}});
  const [errors,setErrors]=useState<Record<string,string>>({}),[message,setMessage]=useState('');const summary=useRef<HTMLDivElement>(null);
  const commands=useCommands(slot);
  useEffect(()=>{try{sessionStorage.setItem(key,JSON.stringify(draft));}catch{setMessage('Không lưu được bản nháp trong trình duyệt.');}},[key,draft]);
  useEffect(()=>{if(Object.keys(errors).length)summary.current?.focus();},[errors]);
  function field(key:'title'|'objective'|'criteria'|'constraints'){return {id:uid+key,value:draft[key],onChange:(e:{target:{value:string}})=>setDraft({...draft,[key]:e.target.value}), 'aria-invalid':Boolean(errors[key]),'aria-describedby':errors[key]?uid+key+'-error':undefined};}
  async function submit(event:FormEvent){event.preventDefault();if(commands.busy)return;
    if(!enabled || !commands.online){setMessage('Yêu cầu chưa được gửi: phiên hoặc kết nối chưa sẵn sàng. Bản nháp vẫn được giữ.');return;}
    if(commands.tracked){setMessage('Chưa tạo yêu cầu mới: biểu mẫu vẫn đang theo dõi thao tác trước.');return;}
    const requirements={objective:draft.objective.trim(),acceptanceCriteria:lines(draft.criteria).map(description=>({description,verificationMethod:draft.methods[description]??draft.verificationMethod})),constraints:draft.constraints.split('\n').filter(x=>x.trim()).map(x=>x.trim())};
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
    {input('objective','Mục tiêu',16000,true)}{input('criteria','Tiêu chí chấp nhận (mỗi dòng một tiêu chí)',16000,true)}<label htmlFor={uid+'method'}>Cách kiểm chứng mặc định</label><select id={uid+'method'} value={draft.verificationMethod} onChange={e=>setDraft({...draft,verificationMethod:e.target.value as Method})}>{Object.entries(methodLabels).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select>
    {lines(draft.criteria).length>0 && <fieldset><legend>Cách kiểm chứng từng tiêu chí</legend>{lines(draft.criteria).slice(0,100).map(line=><div className="my-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)] sm:items-center" key={line}><span className="text-sm [overflow-wrap:anywhere]">{line}</span><select aria-label={`Cách kiểm chứng: ${line}`} value={draft.methods[line]??draft.verificationMethod} onChange={e=>setDraft({...draft,methods:{...draft.methods,[line]:e.target.value as Method}})}>{Object.entries(methodLabels).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></div>)}</fieldset>}
    {input('constraints','Ràng buộc (mỗi dòng một ràng buộc)',16000,true)}{commands.tracked && <div role="status" className="my-3 border border-line border-l-3 border-l-accent p-3 text-sm"><p className="my-1">Biểu mẫu đang theo dõi thao tác trước{commands.tracked.operation?.state==='failed'?' (không được áp dụng)':commands.tracked.operation?.state==='applied'?' (đã áp dụng)':' (chưa có kết quả cuối)'}. Bấm gửi lúc này không tạo yêu cầu mới.</p>{commands.tracked.operation && ['applied','failed'].includes(commands.tracked.operation.state)?<button type="button" onClick={()=>{setMessage('');void commands.startNew();}}>Soạn yêu cầu mới từ nội dung này</button>:<p className="my-1">Đọc lại thao tác ở mục “Thao tác đã gửi”; chỉ tạo yêu cầu mới sau khi biết kết quả.</p>}</div>}<button className="border-ink bg-brand font-semibold text-ink hover:bg-ink hover:text-surface" disabled={!enabled || commands.busy || !commands.online || Boolean(commands.tracked)}>{commands.busy?'Đang gửi…':runId?'Gửi chỉnh sửa':'Tạo công việc'}</button>{!enabled && <p>Phiên hoặc thao tác chưa sẵn sàng; tải lại trạng thái để kiểm tra.</p>}{message && <p role="status">{message}</p>}
  </form></section>;
}
