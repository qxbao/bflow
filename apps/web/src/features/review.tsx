import { Link } from 'react-router';
import { ApiClient } from '../api/client';
import { useRead } from './data';
import { DecisionReview } from './decisions';
import type { WebDecision } from '@bflow/contracts/web';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
export function Review({api,id,revision,refresh}:{api:ApiClient;id:string;revision:number;refresh:()=>void}) {
  const result=useRead(`review:${id}`,()=>api.decisions(id),revision);
  return <><div className="eyebrow">Hộp xem xét</div><h1>Cần bạn quyết định</h1><p className="lead">Đọc câu hỏi và tài liệu của đúng phiên bản công việc.</p>{result.loading && <p role="status">Đang tải gói xem xét…</p>}{Boolean(result.error) && <><ErrorState stale={Boolean(result.data)} error={result.error} retry={refresh}/><Link to={`/projects/${encodeURIComponent(id)}/runs`}>Xem theo từng công việc</Link></>}{result.data && (result.data.items.length?result.data.items.map(decision=><section key={decision.decisionId}><ReviewItem api={api} id={id} decision={decision} revision={revision} fresh={!result.loading && !result.error} refresh={refresh}/><Link to={`/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(decision.runId)}`}>Xem ngữ cảnh công việc →</Link></section>):<EmptyState title="Không có quyết định đang chờ"><p>Các gói cần xem xét sẽ được cập nhật khi phiên dự án công bố.</p></EmptyState>)}</>;
}

function ReviewItem({api,id,decision,revision,fresh,refresh}:{api:ApiClient;id:string;decision:WebDecision;revision:number;fresh:boolean;refresh:()=>void}){const run=useRead(`review-run:${id}:${decision.runId}`,()=>api.run(id,decision.runId),revision);return <DecisionReview api={api} id={id} decision={decision} actions={run.data?.availableActions??[]} fresh={fresh && !run.loading && !run.error && run.data?.currentRunId===decision.runId} refresh={refresh}/>;}
