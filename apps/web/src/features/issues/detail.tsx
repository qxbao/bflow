import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { ParkedIssue } from '@bflow/contracts/web';
import { ApiClient, ApiError, explain, projectPath } from '../../api/client';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { StatusBadge } from '../../components/StatusBadge';
import { useRead } from '../data';
import { useDirector } from '../director/status';
import { IssueActions, IssueSummary, artifactIdOf } from './index';

const MAX_PAGES=20;
/** There is no by-id route: scan the bounded paged list. Unknown (read failed) is never reported as absent. */
function useIssue(issueId:string){
  const d=useDirector();
  return useRead(`issue:${d.projectId}:${issueId}`,async()=>{
    let cursor:string|undefined;
    for(let page=0;page<MAX_PAGES;page++){
      const value=await d.api.directorIssues(d.projectId,cursor);
      const found=value.items.find(item=>item.issueId===issueId);if(found)return {issue:found as ParkedIssue|undefined};
      if(!value.nextCursor)break;cursor=value.nextCursor;
    }
    return {issue:undefined as ParkedIssue|undefined};
  },d.readEpoch);
}
/** Evidence is an artifact URI; reads and downloads go through the existing authenticated artifact route only. */
export function IssueEvidence({api,projectId,uri}:{api:ApiClient;projectId:string;uri:string}){
  const [text,setText]=useState<string>(),[error,setError]=useState<unknown>(),[loading,setLoading]=useState(false),artifactId=artifactIdOf(uri);
  async function load(){setLoading(true);setError(undefined);try{setText(await api.artifact(projectId,artifactId));}catch(e){setError(e);}finally{setLoading(false);}}
  return <li className="border-t border-line py-2 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs [overflow-wrap:anywhere]">{artifactId}</span>
      <span className="flex flex-wrap gap-2"><button type="button" disabled={loading||!artifactId} onClick={()=>void load()}>{loading?'Đang tải…':'Đọc nội dung an toàn'}</button>
        <a download href={`${projectPath(projectId)}/artifacts/${encodeURIComponent(artifactId)}`}>Tải tài liệu</a></span></div>
    {Boolean(error)&&<p role="alert">{error instanceof ApiError&&error.code==='attachment'?'Tài liệu này chỉ hỗ trợ tải xuống; trình duyệt không chạy nội dung của tài liệu.':explain(error)}</p>}
    {text!==undefined&&<pre tabIndex={0} aria-label="Nội dung tài liệu">{text}</pre>}
  </li>;
}

export function IssueDetail(){
  const {issueId=''}=useParams(),d=useDirector(),read=useIssue(issueId),issue=read.data?.issue;
  const run=useRead(`issue-run:${d.projectId}:${issue?.runId??''}`,()=>issue?d.api.run(d.projectId,issue.runId):Promise.resolve(undefined),d.readEpoch);
  const base=`/projects/${encodeURIComponent(d.projectId)}`,runView=run.data;
  const parked=runView?.tasks.filter(task=>task.status==='parked')??[],pending=runView?.decisions.filter(item=>item.status==='pending')??[];
  return <><Link className="font-data text-sm" to={`${base}/issues`}>← Hàng đợi sự cố</Link>
    <LoadingState loading={read.loading} initial={!read.data} label="Đang đọc sự cố…"/>
    {Boolean(read.error)&&<ErrorState stale={Boolean(read.data)} error={read.error} retry={d.reload}/>}
    {read.data&&!issue&&!read.error&&<p role="status" className="my-3 text-sm">Không thấy sự cố này trong hàng đợi đã đọc. Có thể nó đã bị xóa khỏi lịch sử hoặc nằm ngoài giới hạn trang.</p>}
    {issue&&<article data-component="IssueDetail" className="my-3 min-w-0">
      <h1 className="mt-1 mb-2">Chi tiết sự cố</h1>
      <IssueSummary issue={issue}/>
      <dl className="content-grid my-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2"><div><dt>Tạo lúc</dt><dd><time dateTime={issue.createdAt}>{new Date(issue.createdAt).toLocaleString('vi')}</time></dd></div><div><dt>Mã sự cố</dt><dd className="font-mono [overflow-wrap:anywhere]">{issue.issueId}</dd></div>{issue.taskKey&&<div><dt>Nhiệm vụ</dt><dd className="font-mono [overflow-wrap:anywhere]">{issue.taskKey}</dd></div>}</dl>
      <section aria-label="Công việc liên quan" className="my-3 border border-line bg-surface p-3"><h2 className="m-0 text-base">Công việc liên quan</h2>
        {Boolean(run.error)&&<p role="alert" className="text-sm">Chưa đọc được trạng thái công việc.</p>}
        {runView&&<><p className="my-1"><Link to={`${base}/runs/${encodeURIComponent(runView.runId)}`}>{runView.title}</Link> <StatusBadge value={runView.sdlcStatus}/></p>
          {parked.length>0&&<><p className="my-1 text-sm">Nhiệm vụ còn treo ({parked.length}), kể cả khi sự cố đã được bỏ qua:</p><ul className="m-0 list-none p-0 text-sm">{parked.map(task=><li key={task.taskId} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-1.5"><span>{task.title===task.taskId?'Nhiệm vụ chưa có tên hiển thị':task.title}</span><StatusBadge value={task.status}/></li>)}</ul></>}
          {pending.length>0&&<p role="status" className="my-2 text-sm">Có {pending.length} gói đang chờ bạn quyết định. Thử lại sự cố không thay thế quyết định đó; hãy xử lý ở mục <Link to={`${base}/review`}>Cần bạn quyết định</Link>.</p>}</>}
      </section>
      <section aria-label="Tài liệu bằng chứng" className="my-3"><h2 className="m-0 text-base">Tài liệu bằng chứng</h2>
        {issue.evidence.length===0?<p className="text-sm text-muted">Chưa có tài liệu đính kèm.</p>:<ul className="m-0 list-none p-0">{issue.evidence.map(uri=><IssueEvidence key={uri} api={d.api} projectId={d.projectId} uri={uri}/>)}</ul>}</section>
      <IssueActions issue={issue} currentRunId={runView?.currentRunId} fresh={!read.loading&&!read.error} refresh={d.reload}/>
    </article>}
  </>;
}
