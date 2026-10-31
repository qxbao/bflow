import { useEffect, useRef, useState } from 'react';
import type { WebDecision, WebEvidenceReference } from '@bflow/contracts/web';
import { ApiClient, ApiError, projectPath, explain } from '../api/client';
import { StatusBadge } from './StatusBadge';
const fieldLabels:Record<string,string>={
  id:'Mã',title:'Tên',name:'Tên',objective:'Mục tiêu',problemStatement:'Bài toán cần giải quyết',
  scope:'Phạm vi',inScope:'Trong phạm vi',outOfScope:'Ngoài phạm vi',summary:'Tóm tắt',description:'Mô tả',
  category:'Phân loại',required:'Bắt buộc',evidenceArtifactIds:'Tài liệu bằng chứng',changeClass:'Mức thay đổi',
  changeClassification:'Phân loại thay đổi',rationale:'Lý do',functionalRequirements:'Yêu cầu chức năng',
  acceptanceCriteria:'Tiêu chí chấp nhận',affectedPaths:'Tệp ảnh hưởng',changedFiles:'Tệp đã thay đổi',
  architectureNotes:'Ghi chú kiến trúc',dataModelChanges:'Thay đổi mô hình dữ liệu',
  constraints:'Ràng buộc',technicalConstraints:'Ràng buộc kỹ thuật',
  risks:'Rủi ro',risksAndTradeoffs:'Rủi ro & đánh đổi',riskLevel:'Mức độ rủi ro',riskClassification:'Phân loại rủi ro',
  securityConsiderations:'Lưu ý bảo mật',rollbackPlan:'Kế hoạch quay lui',migration:'Di chuyển dữ liệu',
  tasks:'Nhiệm vụ',dependencies:'Phụ thuộc',dependsOn:'Phụ thuộc vào',ownedPaths:'Đường dẫn phụ trách',
  owner:'Phụ trách',role:'Vai trò',complexity:'Độ phức tạp',level:'Mức độ',mode:'Chế độ',
  tddDecision:'Quyết định kiểm thử (TDD)',requiresFailingTestFirst:'Bắt buộc viết test lỗi trước (Red)',
  verifiableConditions:'Điều kiện kiểm chứng',strategy:'Chiến lược kiểm chứng',
  verificationMethod:'Cách kiểm chứng',testStrategy:'Chiến lược kiểm thử',proposedTestStrategy:'Đề xuất kiểm thử',
  criterionMappings:'Ánh xạ tiêu chí sang bài kiểm thử',criterionId:'Mã tiêu chí',testNames:'Bài kiểm thử',
  independentVerificationRequired:'Kiểm chứng độc lập bắt buộc',evidenceRequirements:'Yêu cầu bằng chứng',
  requiredVerificationMethods:'Phương pháp kiểm chứng bắt buộc',requiredTestLevels:'Cấp kiểm thử bắt buộc',
  suggestedTestLevels:'Cấp kiểm thử gợi ý',targetCommands:'Lệnh chạy kiểm thử',
  verdict:'Kết luận',findings:'Phát hiện',checks:'Hạng mục kiểm tra',integratedCommit:'Commit tích hợp',branch:'Nhánh Git',
  change:'Thay đổi tích hợp',integration:'Thông tin tích hợp',integratedTaskIds:'Nhiệm vụ đã tích hợp',
  branchName:'Nhánh tích hợp',baseCommitHash:'Commit gốc',headCommitHash:'Commit đầu nhánh',integrationCommitHash:'Commit tích hợp',
  dirtyWorkingTree:'Có thay đổi chưa lưu trong cây thư mục',filesChanged:'Tệp thay đổi',additions:'Dòng thêm',deletions:'Dòng xóa',
  changeType:'Loại thay đổi',path:'Đường dẫn',patchArtifact:'Tài liệu bản vá (diff)',worktreePath:'Đường dẫn worktree',
  iteration:'Vòng kiểm chứng',options:'Tùy chọn',plan:'Kế hoạch kiểm chứng',configuration:'Cấu hình kiểm tra',
  evaluator:'Bộ đánh giá',timeout:'Giới hạn thời gian',startedAt:'Bắt đầu lúc',completedAt:'Hoàn tất lúc',
  attemptId:'Mã lần thử',cycleId:'Mã chu kỳ kiểm chứng',changeSetId:'Mã tập thay đổi',
  version:'Phiên bản',status:'Trạng thái',metadata:'Siêu dữ liệu kỹ thuật',
  schemaVersion:'Phiên bản lược đồ',policyVersion:'Phiên bản chính sách',
  runId:'Mã công việc',sessionId:'Mã phiên',specId:'Mã đặc tả',decisionId:'Mã quyết định',
  strategyId:'Mã chiến lược',taskId:'Mã nhiệm vụ',traceability:'Liên kết truy vết',
  traceabilityTaskIds:'Nhiệm vụ liên kết',createdAt:'Thời điểm tạo',createdBy:'Tạo bởi',
  decidedAt:'Thời điểm quyết định',decidedBy:'Quyết định bởi',
};
const valueLabels:Record<string,Record<string,string>>={
  verificationMethod:{unit_test:'Kiểm thử đơn vị',integration_test:'Kiểm thử tích hợp',e2e_test:'Kiểm thử toàn luồng',typecheck:'Kiểm tra kiểu',lint:'Kiểm tra mã',static_analysis:'Phân tích tĩnh',manual_review:'Xem xét thủ công'},
  status:{pending:'Chờ kiểm chứng',passed:'Đạt',verified:'Đạt',failed:'Không đạt',inconclusive:'Chưa kết luận',blocked:'Bị chặn',completed:'Hoàn tất',succeeded:'Thành công'},
  verdict:{passed:'Đạt',approved:'Đã duyệt',failed:'Không đạt',rejected:'Từ chối',inconclusive:'Chưa kết luận',blocked:'Bị chặn'},
  category:{functional:'Chức năng',edge_case:'Trường hợp biên',non_functional:'Phi chức năng',security:'Bảo mật',performance:'Hiệu năng',regression:'Hồi quy'},
  mode:{required:'Bắt buộc',recommended:'Khuyến nghị',not_applicable:'Không áp dụng'},
  riskLevel:{low:'Thấp',medium:'Trung bình',high:'Cao',critical:'Nghiêm trọng'},
  complexity:{trivial:'Đơn giản',standard:'Tiêu chuẩn',complex:'Phức tạp'},
  changeType:{added:'Thêm mới',modified:'Chỉnh sửa',deleted:'Xóa',renamed:'Đổi tên'},
};
const priorityOrder=['title','name','summary','objective','problemStatement','description','verdict','status','change','integration','integratedTaskIds','scope','inScope','outOfScope','functionalRequirements','acceptanceCriteria','affectedPaths','changedFiles','filesChanged','architectureNotes','dataModelChanges','tddDecision','testStrategy','proposedTestStrategy','technicalConstraints','constraints','riskLevel','risksAndTradeoffs','risks','securityConsiderations','rollbackPlan','tasks','findings','checks','iteration','version'];
const technicalKeys=new Set(['metadata','schemaVersion','policyVersion','runId','sessionId','specId','decisionId','strategyId','taskId','attemptId','cycleId','changeSetId','traceability','traceabilityTaskIds','createdAt','createdBy','decidedAt','decidedBy']);
function sortEntries(entries:[string,unknown][]):[string,unknown][]{
  return [...entries].sort(([a],[b])=>{
    const ia=priorityOrder.indexOf(a),ib=priorityOrder.indexOf(b);
    if(ia!==-1 && ib!==-1)return ia-ib;
    if(ia!==-1)return -1;
    if(ib!==-1)return 1;
    return a.localeCompare(b);
  });
}
const questionLabels:Record<string,string>={
  'Specification acceptance':'Phê duyệt đặc tả công việc',
  'Approve delivery of independently verified integrated changes':'Phê duyệt bàn giao kết quả đã kiểm chứng độc lập',
};
export function decisionQuestionLabel(question:string):string{return questionLabels[question]??question;}
function Readable({value,depth=0,fieldKey}:{value:unknown;depth?:number;fieldKey?:string}) {
  if(typeof value==='boolean')return <span>{value?'Có':'Không'}</span>;
  if(value===null || typeof value!=='object'){
    const str=String(value);
    const translated=fieldKey?valueLabels[fieldKey]?.[str]:undefined;
    return <span className="[overflow-wrap:anywhere]">{translated??str}</span>;
  }
  if(depth>=4)return <code className="font-mono text-xs [overflow-wrap:anywhere]">{JSON.stringify(value)}</code>;
  if(Array.isArray(value))return value.length?<ul className="my-1 pl-4">{value.map((item,index)=><li key={index} className="my-1"><Readable value={item} depth={depth+1} {...(fieldKey?{fieldKey}:{})}/></li>)}</ul>:<span className="text-muted">Không có</span>;
  const allEntries=sortEntries(Object.entries(value));
  const primary=depth===0?allEntries.filter(([k])=>!technicalKeys.has(k)):allEntries;
  const technical=depth===0?allEntries.filter(([k])=>technicalKeys.has(k)):[];
  const renderList=(list:[string,unknown][])=><dl className="m-0 space-y-1.5">{list.map(([key,item])=><div key={key}><dt className="font-data text-xs font-semibold text-ink">{fieldLabels[key]??key}</dt><dd className="m-0 pl-3 text-sm"><Readable value={item} depth={depth+1} fieldKey={key}/></dd></div>)}</dl>;
  return <>{primary.length>0 && renderList(primary)}{technical.length>0 && <details className="mt-2.5 border-t border-line pt-2"><summary className="cursor-pointer font-data text-xs font-medium text-muted">Thông tin định danh & siêu dữ liệu kỹ thuật ({technical.length})</summary><div className="mt-1.5">{renderList(technical)}</div></details>}</>;
}
function parseObject(text:string):object|undefined{try{const value:unknown=JSON.parse(text);return value!==null && typeof value==='object'?value:undefined;}catch{return undefined;}}
/** Prefix conventions of Runtime approval ids; the target remains authoritative for the decision itself. */
function packageLabel(decision:WebDecision){
  if(decision.kind==='user_decision')return 'Quyết định của bạn';
  if(decision.decisionId.startsWith('design-'))return 'Thiết kế công việc';
  if(decision.decisionId.startsWith('prototype-'))return 'Bản mẫu (Prototype)';
  if(decision.decisionId.startsWith('task-approval-'))return 'Kết quả nhiệm vụ';
  if(decision.decisionId.startsWith('delivery-'))return 'Bàn giao';
  return decision.expectedVersion.target.type==='run'?'Gói của công việc':'Gói xem xét';
}
export function Evidence({api,projectId,evidence}:{api:ApiClient;projectId:string;evidence:WebEvidenceReference}) {
  const [text,setText]=useState<string>(); const [error,setError]=useState<unknown>(); const [loading,setLoading]=useState(false);
  const reqGen=useRef(0),identity=`${projectId}:${evidence.artifactId}:${evidence.checksum?.value??''}`,lastIdentity=useRef(identity);
  useEffect(()=>{
    if(lastIdentity.current!==identity){lastIdentity.current=identity;reqGen.current+=1;setText(undefined);setError(undefined);setLoading(false);}
  },[identity]);
  useEffect(()=>()=>{reqGen.current+=1;},[]);
  return <section className="evidence my-2.5 min-w-0 border-t border-line pt-2.5 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="m-0">Tài liệu kiểm chứng · {evidence.mediaType}{evidence.sizeBytes!==undefined?` · ${new Intl.NumberFormat('vi').format(evidence.sizeBytes)} byte`:''}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={loading} onClick={async()=>{const gen=++reqGen.current;setLoading(true);setError(undefined);try{const loaded=await api.artifact(projectId,evidence.artifactId);if(reqGen.current===gen)setText(loaded);}catch(e){if(reqGen.current===gen)setError(e);}finally{if(reqGen.current===gen)setLoading(false);}}}>{loading?'Đang tải…':'Đọc nội dung an toàn'}</button>
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
