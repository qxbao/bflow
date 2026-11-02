import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { WebCommandSchema, type WebAction } from '@bflow/contracts/web';
import { ApiClient, ApiError, explain } from '../../api/client';
import { FieldHelp, FieldLabel } from '../../components/FieldHelp';
import { useCommands } from '../operations';
import type { CommandBody } from '../../api/commands';
type Method='unit_test'|'integration_test'|'e2e_test'|'typecheck'|'lint'|'static_analysis'|'manual_review';
type Draft={title:string;requestKind:'feature'|'bugfix'|'refactor'|'spike';objective:string;criteria:string;constraints:string;verificationMethod:Method;methods:Record<string,Method>};
const empty:Draft={title:'',requestKind:'feature',objective:'',criteria:'',constraints:'',verificationMethod:'integration_test',methods:{}};
const methodLabels:Record<Method,string>={unit_test:'Kiểm thử đơn vị',integration_test:'Kiểm thử tích hợp',e2e_test:'Kiểm thử toàn luồng',typecheck:'Kiểm tra kiểu',lint:'Kiểm tra mã',static_analysis:'Phân tích tĩnh',manual_review:'Xem xét thủ công'};
const lines=(text:string)=>[...new Set(text.split('\n').map(line=>line.trim()).filter(Boolean))];
function parseDraft(raw:string|null):Draft|undefined{
  if(!raw)return undefined;
  try{
    const parsed=JSON.parse(raw);
    if(parsed && Object.keys(empty).filter(k=>k!=='methods').every(k=>typeof parsed[k]==='string'))return {...empty,...parsed,methods:parsed.methods && typeof parsed.methods==='object'?parsed.methods:{}};
  }catch{/* ignore malformed draft */}
  return undefined;
}
const readDraft=(primaryKey:string,fallbackKey:string):Draft=>parseDraft(sessionStorage.getItem(primaryKey))??parseDraft(sessionStorage.getItem(fallbackKey))??empty;
export function RequestForm({api,id,sessionId,enabled,runId,action,refresh}:{api:ApiClient;id:string;sessionId:string;enabled:boolean;runId?:string|undefined;action?:WebAction|undefined;refresh?:(()=>void)|undefined}) {
  const slot=runId?`revise:${runId}`:'create',key=`bflow:web:draft:${encodeURIComponent(id)}:${slot}`,legacyKey=`bflow:web:draft:${encodeURIComponent(id)}:${encodeURIComponent(sessionId)}:${slot}`,uid=useId();
  const [draft,setDraft]=useState<Draft>(()=>readDraft(key,legacyKey));
  const loadedKey=useRef(key);
  const [errors,setErrors]=useState<Record<string,string>>({}),[message,setMessage]=useState('');const summary=useRef<HTMLDivElement>(null);
  const commands=useCommands(slot);
  useEffect(()=>{
    if(loadedKey.current!==key){
      loadedKey.current=key;
      setDraft(readDraft(key,legacyKey));
      setErrors({});
      setMessage('');
      return;
    }
    try{sessionStorage.setItem(key,JSON.stringify(draft));}catch{setMessage('Không lưu được bản nháp trong trình duyệt.');}
  },[key,legacyKey,draft]);
  useEffect(()=>{if(Object.keys(errors).length)summary.current?.focus();},[errors]);
  function field(key:'title'|'objective'|'criteria'|'constraints'){return {id:uid+key,value:draft[key],onChange:(e:{target:{value:string}})=>setDraft(prev=>({...prev,[key]:e.target.value})), 'aria-invalid':Boolean(errors[key]),'aria-describedby':errors[key]?uid+key+'-error':undefined};}
  async function submit(event:FormEvent){event.preventDefault();if(commands.busy)return;
    if(!enabled || !commands.online){setMessage('Yêu cầu chưa được gửi: phiên hoặc kết nối chưa sẵn sàng. Bản nháp vẫn được giữ.');return;}
    if(commands.tracked){setMessage('Chưa tạo yêu cầu mới: biểu mẫu vẫn đang theo dõi thao tác trước.');return;}
    const requirements={objective:draft.objective.trim(),acceptanceCriteria:lines(draft.criteria).map(description=>({description,verificationMethod:draft.methods[description]??draft.verificationMethod})),constraints:draft.constraints.split('\n').filter(x=>x.trim()).map(x=>x.trim())};
    let body:CommandBody=runId && action?{kind:'revise_request',runId,expectedVersion:{revisionToken:action.expectedVersion.revisionToken},...requirements}:{kind:'create_request',title:draft.title.trim(),requestKind:draft.requestKind,...requirements};
    const parsed=WebCommandSchema.safeParse({...body,apiVersion:1,projectId:id,commandId:crypto.randomUUID()});
    if(!parsed.success){const next:Record<string,string>={};for(const issue of parsed.error.issues){const key=issue.path[0]==='acceptanceCriteria'?'criteria':String(issue.path[0]);next[key]='Vui lòng nhập nội dung hợp lệ trong giới hạn cho phép.';}setErrors(next);return;}
    setErrors({});try{
      // Fresh readiness is observation; admission/authority stays on the host.
      if(!runId && (await api.sessionView(id)).state!=='ready'){refresh?.();throw new Error('Phiên dự án chưa sẵn sàng.');}
      if(runId){
        const fresh=await api.run(id,runId);
        const liveAction=fresh.currentRunId===runId?fresh.availableActions.find(a=>a.kind==='revise_request' && a.enabled && a.actionId===action?.actionId):undefined;
        if(!liveAction){refresh?.();throw new Error('Yêu cầu đã đổi. Đọc lại công việc trước khi chỉnh sửa.');}
        body={kind:'revise_request',runId,expectedVersion:{revisionToken:liveAction.expectedVersion.revisionToken},...requirements};
      }
      await commands.submit(body);setMessage('Đã gửi hoặc đang đối chiếu yêu cầu. Theo dõi thao tác bên dưới.');
    }catch(e){
      if(e instanceof ApiError && e.code==='stale_version')refresh?.();
      setMessage(e instanceof Error && !('code' in e)?e.message:explain(e));
    }
  }
  const criteriaLines=lines(draft.criteria);
  return <section data-component="RequestForm" className="panel my-4 min-w-0 border border-line bg-surface p-3.5 sm:p-4"><div className="mb-2 flex flex-wrap items-baseline justify-between gap-2"><h2 className="m-0 text-base">{runId?'Chỉnh yêu cầu':'Tạo công việc'}</h2><span className="text-xs text-muted">Bản nháp tự lưu trên trình duyệt này</span></div>
    <p className="my-1.5 text-sm text-muted">{runId?'Nhập đầy đủ mục tiêu, tiêu chí và ràng buộc thay thế cho công việc này.':'Mô tả kết quả bạn mong muốn. Hệ thống sẽ phân tích, lập đặc tả và trình bạn duyệt khi cần.'}</p>
    <form noValidate onSubmit={e=>void submit(e)}>
      {Object.keys(errors).length>0 && <div role="alert" ref={summary} tabIndex={-1} className="my-2.5 border border-danger border-l-3 bg-canvas p-3"><h3 className="m-0 text-sm">Kiểm tra thông tin</h3>{Object.keys(errors).map(k=><p key={k} className="my-1 text-sm"><a href={'#'+uid+k}>{errors[k]}</a></p>)}</div>}
      {!runId?<div className="my-2.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="sm:col-span-2 lg:col-span-1"><FieldLabel htmlFor={uid+'title'} label="Tên công việc" help="Đặt tiêu đề ngắn gọn (tối đa 200 ký tự) tóm tắt việc cần làm để dễ nhận biết trong danh sách công việc và lịch sử nhánh Git." example="Ví dụ: Thêm hàm chuyển tiêu đề tiếng Việt sang URL slug"/><input {...field('title')} maxLength={200} placeholder="Ví dụ: Chuyển đổi chuỗi thời lượng sang giây"/>{errors.title && <p id={uid+'title-error'} role="alert" className="my-1 text-xs text-danger">{errors.title}</p>}</div>
        <div><FieldLabel htmlFor={uid+'kind'} label="Loại yêu cầu" help="Phân loại mục đích công việc để hệ thống chọn mức đặc tả (SDD) và chiến lược kiểm thử (TDD) phù hợp: Tính năng mới, Sửa lỗi, Cải tiến cấu trúc mã hoặc Khảo sát kỹ thuật."/><select id={uid+'kind'} value={draft.requestKind} onChange={e=>setDraft(prev=>({...prev,requestKind:e.target.value as Draft['requestKind']}))}><option value="feature">Tính năng</option><option value="bugfix">Sửa lỗi</option><option value="refactor">Cải tiến mã</option><option value="spike">Khảo sát</option></select></div>
        <div><FieldLabel htmlFor={uid+'method'} label="Cách kiểm chứng mặc định" help="Phương pháp kiểm chứng sẽ tự động gán cho mọi tiêu chí chấp nhận bên dưới (bạn vẫn có thể đổi riêng từng tiêu chí sau khi nhập)." example="Gợi ý: Kiểm thử đơn vị cho hàm logic, Kiểm thử tích hợp cho API/luồng"/><select id={uid+'method'} value={draft.verificationMethod} onChange={e=>setDraft(prev=>({...prev,verificationMethod:e.target.value as Method}))}>{Object.entries(methodLabels).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></div>
      </div>:<div className="my-2.5 sm:max-w-xs"><FieldLabel htmlFor={uid+'method'} label="Cách kiểm chứng mặc định" help="Phương pháp kiểm chứng mặc định áp dụng cho các tiêu chí chấp nhận khi bạn chưa chọn riêng từng dòng."/><select id={uid+'method'} value={draft.verificationMethod} onChange={e=>setDraft(prev=>({...prev,verificationMethod:e.target.value as Method}))}>{Object.entries(methodLabels).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></div>}

      <div className="my-2.5 grid gap-3 lg:grid-cols-2">
        <div><FieldLabel htmlFor={uid+'objective'} label="Mục tiêu" help="Mô tả rõ bài toán thực tế, hành vi mong muốn và phạm vi chức năng cần đạt được. Thông tin càng cụ thể thì bản đặc tả càng sát ý bạn." example="Ví dụ: Tạo hàm toSlug(input) chuẩn hóa dấu tiếng Việt thành chuỗi chữ thường nối bằng dấu gạch ngang"/><textarea {...field('objective')} maxLength={16000} rows={3} placeholder="Mô tả chức năng hoặc lỗi cần giải quyết…"/>{errors.objective && <p id={uid+'objective-error'} role="alert" className="my-1 text-xs text-danger">{errors.objective}</p>}</div>
        <div><FieldLabel htmlFor={uid+'criteria'} label="Tiêu chí chấp nhận (mỗi dòng một tiêu chí)" help="Liệt kê các điều kiện cụ thể cần thỏa mãn để công việc được coi là hoàn tất. Mỗi dòng sẽ trở thành một hạng mục được Reviewer và QA đối chiếu độc lập." example="Ví dụ: Chuyển 'Đường Đua Mới!' thành 'duong-dua-moi'"/><textarea {...field('criteria')} maxLength={16000} rows={3} placeholder="Ví dụ: Hỗ trợ 30s, 5m, 2h, 1h30m&#10;Báo lỗi khi đầu vào không hợp lệ"/>{errors.criteria && <p id={uid+'criteria-error'} role="alert" className="my-1 text-xs text-danger">{errors.criteria}</p>}</div>
      </div>

      {criteriaLines.length>0 && <fieldset className="my-2.5 bg-canvas p-2.5"><legend>Cách kiểm chứng từng tiêu chí ({criteriaLines.length})</legend>{criteriaLines.slice(0,100).map((line,index)=><div className="my-1.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(190px,240px)] sm:items-center" key={line}><span className="text-sm [overflow-wrap:anywhere]">{line}</span><div className="flex items-center gap-1.5"><select id={`${uid}criterion-${index}`} aria-label={`Cách kiểm chứng: ${line}`} value={draft.methods[line]??draft.verificationMethod} onChange={e=>setDraft(prev=>({...prev,methods:{...prev.methods,[line]:e.target.value as Method}}))}>{Object.entries(methodLabels).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select><FieldHelp label={`Cách kiểm chứng: ${line}`} help="Chọn cách hệ thống xác minh riêng cho tiêu chí này (ví dụ Kiểm thử đơn vị, Kiểm tra kiểu hoặc Kiểm thử tích hợp)."/></div></div>)}</fieldset>}

      <div className="my-2.5"><FieldLabel htmlFor={uid+'constraints'} label="Ràng buộc (mỗi dòng một ràng buộc)" help="Tùy chọn: ghi rõ các giới hạn kỹ thuật như chỉ sửa trong thư mục nhất định, không cài thêm thư viện ngoài, hoặc giữ tương thích ngược." example="Ví dụ: Không dùng thư viện bên thứ ba; chạy test bằng node --test"/><textarea {...field('constraints')} className="min-h-14" maxLength={16000} rows={2} placeholder="Tùy chọn: giới hạn phạm vi file, giữ tương thích API…"/>{errors.constraints && <p id={uid+'constraints-error'} role="alert" className="my-1 text-xs text-danger">{errors.constraints}</p>}</div>

      {commands.tracked && <div role="status" className="my-2.5 border border-line border-l-3 border-l-accent bg-canvas p-3 text-sm"><p className="my-1">Biểu mẫu đang theo dõi thao tác trước{commands.tracked.operation?.state==='failed'?' (không được áp dụng)':commands.tracked.operation?.state==='applied'?' (đã áp dụng)':' (chưa có kết quả cuối)'}. Bấm gửi lúc này không tạo yêu cầu mới.</p>{commands.tracked.operation && ['applied','failed'].includes(commands.tracked.operation.state)?<div className="mt-2 flex flex-wrap items-center gap-3">{commands.tracked.operation.result?.kind==='interaction' && <Link className="font-data text-xs font-semibold text-ink" to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(commands.tracked.operation.result.currentRunId)}`}>Mở công việc vừa tạo →</Link>}<button type="button" onClick={()=>{setMessage('');void commands.startNew();}}>Soạn yêu cầu mới từ nội dung này</button></div>:<p className="my-1 text-xs text-muted">Đọc lại thao tác ở mục “Thao tác đã gửi”; chỉ tạo yêu cầu mới sau khi biết kết quả.</p>}</div>}

      <div className="mt-3 flex flex-wrap items-center gap-3"><button className="min-w-36 border-ink bg-brand font-semibold text-ink hover:bg-ink hover:text-surface" disabled={!enabled || commands.busy || !commands.online || Boolean(commands.tracked)}>{commands.busy?'Đang gửi…':runId?'Gửi chỉnh sửa':'Tạo công việc'}</button>{!enabled && <span className="text-xs text-muted">{runId?'Công việc hiện không còn cho phép chỉnh sửa yêu cầu tại chỗ. Bản nháp vẫn được giữ.':'Khởi động phiên dự án phía trên để bật gửi yêu cầu. Bản nháp vẫn được giữ.'}</span>}</div>
      {message && <p role="status" className="my-2 text-sm">{message}</p>}
    </form></section>;
}
