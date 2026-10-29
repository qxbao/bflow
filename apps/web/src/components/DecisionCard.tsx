import { useState } from 'react';
import type { WebDecision, WebEvidenceReference } from '@bflow/contracts/web';
import { ApiClient, ApiError, projectPath, explain } from '../api/client';
import { StatusBadge } from './StatusBadge';
export function Evidence({api,projectId,evidence}:{api:ApiClient;projectId:string;evidence:WebEvidenceReference}) {
  const [text,setText]=useState<string>(); const [error,setError]=useState<unknown>(); const [loading,setLoading]=useState(false);
  return <section className="evidence"><p>Tài liệu kiểm chứng · {evidence.mediaType}{evidence.sizeBytes!==undefined?` · ${new Intl.NumberFormat('vi').format(evidence.sizeBytes)} byte`:''}</p>
    <button disabled={loading} onClick={async()=>{setLoading(true);setError(undefined);try{setText(await api.artifact(projectId,evidence.artifactId));}catch(e){setError(e);}finally{setLoading(false);}}}>{loading?'Đang tải…':'Đọc nội dung an toàn'}</button>{' '}
    <a download href={`${projectPath(projectId)}/artifacts/${encodeURIComponent(evidence.artifactId)}`}>Tải tài liệu</a>
    {Boolean(error) && <p role="alert">{error instanceof ApiError && error.code==='attachment'?'Tài liệu này chỉ hỗ trợ tải xuống; trình duyệt không chạy nội dung của tài liệu.':explain(error)}</p>}
    {text!==undefined && <pre tabIndex={0} aria-label="Nội dung tài liệu">{text}</pre>}
  </section>;
}
export function DecisionCard({decision,api,projectId,headingLevel=3}:{decision:WebDecision;api:ApiClient;projectId:string;headingLevel?:2|3}) {
  const Heading=headingLevel===2?'h2':'h3';
  return <article className="panel"><div className="eyebrow">Gói xem xét · Phiên bản {decision.expectedVersion.revision}</div><Heading>{decision.question}</Heading><StatusBadge value={decision.status}/>
    {decision.expiresAt && <p>Hạn xem xét: {new Date(decision.expiresAt).toLocaleString('vi')}</p>}
    {decision.options.length>0 && <ul>{decision.options.map(option=><li key={option}>{option}</li>)}</ul>}
    <p className="muted">Đọc tài liệu và đối chiếu phiên bản trước khi quyết định.</p>
    {decision.evidence.length===0?<p>Chưa có tài liệu đính kèm.</p>:decision.evidence.map(item=><Evidence key={item.artifactId} api={api} projectId={projectId} evidence={item}/>)}
  </article>;
}
