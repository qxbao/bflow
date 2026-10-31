import { useState } from 'react';
import type { WebDecision, WebEvidenceReference } from '@bflow/contracts/web';
import { ApiClient, ApiError, projectPath, explain } from '../api/client';
import { StatusBadge } from './StatusBadge';
const fieldLabels:Record<string,string>={id:'Mã',title:'Tên',objective:'Mục tiêu',scope:'Phạm vi',summary:'Tóm tắt',description:'Mô tả',category:'Phân loại',required:'Bắt buộc',evidenceArtifactIds:'Tài liệu bằng chứng',changeClass:'Mức thay đổi',rationale:'Lý do',acceptanceCriteria:'Tiêu chí chấp nhận',constraints:'Ràng buộc',risks:'Rủi ro',migration:'Di chuyển dữ liệu',tasks:'Nhiệm vụ',dependencies:'Phụ thuộc',dependsOn:'Phụ thuộc vào',ownedPaths:'Đường dẫn phụ trách',owner:'Phụ trách',role:'Vai trò',strategy:'Chiến lược kiểm chứng',verificationMethod:'Cách kiểm chứng',testStrategy:'Chiến lược kiểm thử',version:'Phiên bản',status:'Trạng thái'};
const questionLabels:Record<string,string>={
  'Specification acceptance':'Phê duyệt đặc tả công việc',
  'Approve delivery of independently verified integrated changes':'Phê duyệt bàn giao kết quả đã kiểm chứng độc lập',
};
export function decisionQuestionLabel(question:string):string{return questionLabels[question]??question;}
function Readable({value,depth=0}:{value:unknown;depth?:number}) {
  if(typeof value==='boolean')return <span>{value?'Có':'Không'}</span>;
  if(value===null || typeof value!=='object')return <span className="[overflow-wrap:anywhere]">{String(value)}</span>;
  if(depth>=4)return <code className="font-mono text-xs [overflow-wrap:anywhere]">{JSON.stringify(value)}</code>;
  if(Array.isArray(value))return value.length?<ul>{value.map((item,index)=><li key={index}><Readable value={item} depth={depth+1}/></li>)}</ul>:<span className="text-muted">Không có</span>;
  return <dl className="m-0">{Object.entries(value).map(([key,item])=><div key={key}><dt>{fieldLabels[key]??key}</dt><dd className="m-0 pl-3"><Readable value={item} depth={depth+1}/></dd></div>)}</dl>;
}
function parseObject(text:string):object|undefined{try{const value:unknown=JSON.parse(text);return value!==null && typeof value==='object'?value:undefined;}catch{return undefined;}}
/** Prefix conventions of Runtime approval ids; the target remains authoritative for the decision itself. */
function packageLabel(decision:WebDecision){
  if(decision.kind==='user_decision')return 'Quyết định của bạn';
  if(decision.decisionId.startsWith('design-'))return 'Thiết kế công việc';
  if(decision.decisionId.startsWith('task-approval-'))return 'Kết quả nhiệm vụ';
  if(decision.decisionId.startsWith('delivery-'))return 'Bàn giao';
  return decision.expectedVersion.target.type==='run'?'Gói của công việc':'Gói xem xét';
}
export function Evidence({api,projectId,evidence}:{api:ApiClient;projectId:string;evidence:WebEvidenceReference}) {
  const [text,setText]=useState<string>(); const [error,setError]=useState<unknown>(); const [loading,setLoading]=useState(false);
  return <section className="evidence my-2.5 min-w-0 border-t border-line pt-2.5 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="m-0">Tài liệu kiểm chứng · {evidence.mediaType}{evidence.sizeBytes!==undefined?` · ${new Intl.NumberFormat('vi').format(evidence.sizeBytes)} byte`:''}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={loading} onClick={async()=>{setLoading(true);setError(undefined);try{setText(await api.artifact(projectId,evidence.artifactId));}catch(e){setError(e);}finally{setLoading(false);}}}>{loading?'Đang tải…':'Đọc nội dung an toàn'}</button>
        <a download href={`${projectPath(projectId)}/artifacts/${encodeURIComponent(evidence.artifactId)}`}>Tải tài liệu</a>
      </div>
    </div>
    {Boolean(error) && <p role="alert">{error instanceof ApiError && error.code==='attachment'?'Tài liệu này chỉ hỗ trợ tải xuống; trình duyệt không chạy nội dung của tài liệu.':explain(error)}</p>}
    {text!==undefined && (parseObject(text)?<><div className="my-3 max-h-[60dvh] overflow-auto border border-line p-3"><Readable value={parseObject(text)}/></div><details><summary>Xem JSON gốc</summary><pre tabIndex={0} aria-label="Nội dung tài liệu">{text}</pre></details></>:<pre tabIndex={0} aria-label="Nội dung tài liệu">{text}</pre>)}
  </section>;
}
export function DecisionCard({decision,api,projectId,headingLevel=3}:{decision:WebDecision;api:ApiClient;projectId:string;headingLevel?:2|3}) {
  const Heading=headingLevel===2?'h2':'h3';
  const collapseSettled=decision.status!=='pending' && decision.evidence.length>2;
  const visiblePending=decision.status==='pending' && decision.evidence.length>3?decision.evidence.slice(0,3):decision.evidence;
  const extraPending=decision.status==='pending' && decision.evidence.length>3?decision.evidence.slice(3):[];
  return <article className="panel min-w-0 border border-line bg-surface p-3.5 sm:p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">{packageLabel(decision)} · Phiên bản {decision.expectedVersion.revision}</div><StatusBadge value={decision.status}/></div><Heading className="mt-1 mb-1.5">{decisionQuestionLabel(decision.question)}</Heading>
    {decision.expiresAt && <p className="my-1 text-sm">Hạn xem xét: {new Date(decision.expiresAt).toLocaleString('vi')}</p>}
    {decision.options.length>0 && <ul>{decision.options.map(option=><li key={option}>{option}</li>)}</ul>}
    {decision.status==='pending' && <p className="my-1.5 text-sm text-muted">Đọc tài liệu và đối chiếu phiên bản trước khi quyết định.</p>}
    {decision.evidence.length===0?<p className="my-2 text-sm text-muted">Chưa có tài liệu đính kèm.</p>:collapseSettled?<details className="mt-2.5 border-t border-line pt-2.5"><summary className="cursor-pointer text-sm font-medium text-ink">Tài liệu kiểm chứng đính kèm ({decision.evidence.length})</summary>{decision.evidence.map(item=><Evidence key={item.artifactId} api={api} projectId={projectId} evidence={item}/>)}</details>:<>{visiblePending.map(item=><Evidence key={item.artifactId} api={api} projectId={projectId} evidence={item}/>)}{extraPending.length>0 && <details className="mt-2 border-t border-line pt-2"><summary className="cursor-pointer text-sm font-medium text-ink">Xem thêm {extraPending.length} tài liệu kiểm chứng khác</summary>{extraPending.map(item=><Evidence key={item.artifactId} api={api} projectId={projectId} evidence={item}/>)}</details>}</>}
  </article>;
}
