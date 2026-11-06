import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ParkedIssue, ParkedIssueKind, ParkedIssueStatus } from '@bflow/contracts/web';
import { ApiError, explain } from '../../api/client';
import { ActionConfirmation } from '../../components/ActionConfirmation';
import { LoadingState } from '../../components/LoadingState';
import { useCommands } from '../operations';
import { useRead } from '../data';
import { useDirector } from '../director/status';

/**
 * Parked issue queue (D-CD-01). The shared controller below is the only place issue reads and retry/dismiss writes live: Classic pages and
 * the 3D office inspector both embed `IssueQueuePanel`, so neither has a separate write path. Retry/dismiss are signed Web commands
 * admitted by Runtime; this UI never re-sends an effect of unknown outcome and a dismiss never unparks a task.
 */
export const kindLabels:Record<ParkedIssueKind,string>={
  transport_failure:'Lỗi kết nối tác tử',provider_failure:'Lỗi nhà cung cấp mô hình',verification_exhausted:'Hết lượt kiểm chứng',
  rework_exhausted:'Hết lượt sửa lại',user_decision_pending:'Chờ quyết định của bạn',environment:'Lỗi môi trường',other:'Sự cố khác',
};
export const issueStatusLabels:Record<ParkedIssueStatus,string>={open:'Đang mở',retrying:'Đang thử lại',resolved:'Đã giải quyết',dismissed:'Đã bỏ qua'};
const statusIcon:Record<ParkedIssueStatus,string>={open:'●',retrying:'◷',resolved:'✓',dismissed:'○'};
export type IssueFilter='active'|'all'|ParkedIssueStatus;
export const filterLabels:Record<IssueFilter,string>={active:'Cần xử lý (đang mở hoặc đang thử lại)',all:'Tất cả',open:'Chỉ sự cố đang mở',retrying:'Chỉ sự cố đang thử lại',resolved:'Chỉ sự cố đã giải quyết',dismissed:'Chỉ sự cố đã bỏ qua'};
const matches=(filter:IssueFilter,issue:ParkedIssue)=>filter==='all'||(filter==='active'?issue.status==='open'||issue.status==='retrying':issue.status===filter);
const unsupportedCodes=new Set(['operation_not_allowed','not_found']);
const stamp=(iso:string)=>new Date(iso).toLocaleString('vi');
/** The URI is `artifact://<store>/<id>`; the authenticated artifact route takes only the id. */
export const artifactIdOf=(uri:string)=>uri.replace(/^artifact:\/\//,'').split('/').filter(Boolean).at(-1)??'';

export interface IssueQueue{
  projectId:string;
  /** `unavailable`: layout or backend has no Director issue port; never rendered as an empty queue. */
  availability:'ready'|'unavailable'|'loading'|'unknown';
  /** runId -> its current run, for the active issues on this page; missing = not read (unknown), never assumed current. */
  currentRuns:Record<string,string>;
  items:ParkedIssue[];all:ParkedIssue[];
  filter:IssueFilter;setFilter(filter:IssueFilter):void;
  loading:boolean;error:unknown;
  /** A read that is neither loading nor failed: actions are only enabled against a fresh page. */
  fresh:boolean;
  page:number;hasNext:boolean;hasPrevious:boolean;next():void;previous():void;
  refresh():void;
}
/** Shared read controller. Reads follow the shared Director read epoch, so SSE/app revisions refresh it with no extra wiring. */
export function useIssueQueue():IssueQueue{
  const d=useDirector();
  const [trail,setTrail]=useState<string[]>([]),[filter,setFilter]=useState<IssueFilter>('active'),[scope,setScope]=useState(d.projectId);
  if(scope!==d.projectId){setScope(d.projectId);setTrail([]);}
  const cursor=trail.at(-1),usable=d.layout==='director'||d.layout==='not_started';
  const read=useRead(`issues:${d.projectId}:${cursor??''}:${usable}`,()=>usable?d.api.directorIssues(d.projectId,cursor):Promise.resolve(undefined),d.readEpoch);
  const missingPort=read.error instanceof ApiError&&unsupportedCodes.has(read.error.code);
  // `unknown` (Director view not readable, no confirmed layout) is neither loading forever nor unavailable: it offers a re-read.
  const availability:IssueQueue['availability']=d.layout==='legacy_v2'||d.layout==='unsupported'||missingPort?'unavailable':d.layout==='unknown'?(d.loading?'loading':'unknown'):read.data===undefined&&read.error===undefined?'loading':'ready';
  const all=read.data?.items??[];
  const activeRuns=[...new Set(all.filter(issue=>issue.status==='open'||issue.status==='retrying').map(issue=>issue.runId))].sort();
  const runs=useRead(`issue-runs:${d.projectId}:${activeRuns.join(',')}`,async()=>{
    const out:Record<string,string>={};
    await Promise.all(activeRuns.map(async runId=>{try{out[runId]=(await d.api.run(d.projectId,runId)).currentRunId;}catch{/* unknown stays unknown */}}));
    return out;
  },d.readEpoch);
  const next=read.data?.nextCursor;
  return {projectId:d.projectId,availability,currentRuns:runs.data??{},all,items:all.filter(issue=>matches(filter,issue)),filter,setFilter,loading:read.loading,error:missingPort?undefined:read.error,
    fresh:!read.loading&&read.error===undefined&&read.data!==undefined,page:trail.length+1,hasNext:Boolean(next),hasPrevious:trail.length>0,
    next:()=>{if(next)setTrail(old=>[...old,next]);},previous:()=>setTrail(old=>old.slice(0,-1)),refresh:d.reload};
}

const settledState=(op?:{state:string})=>Boolean(op&&['applied','failed'].includes(op.state));
/**
 * Retry/dismiss for one issue. Gates: a fresh read, the issue's own status, a still-current episode (checked again against the run at click
 * time), and no unsettled earlier command. An unsettled or uncertain command is observed only, never re-sent.
 */
export function IssueActions({issue,currentRunId,fresh,refresh}:{issue:ParkedIssue;currentRunId?:string|undefined;fresh:boolean;refresh:()=>void}){
  const d=useDirector(),retry=useCommands(`issue_retry:${issue.issueId}`),dismiss=useCommands(`issue_dismiss:${issue.issueId}`);
  const [confirm,setConfirm]=useState(false),[error,setError]=useState(''),[checking,setChecking]=useState(false),uid=useId();
  const stamp0=useRef(issue.updatedAt);
  useEffect(()=>{if(stamp0.current!==issue.updatedAt){stamp0.current=issue.updatedAt;setError('');setConfirm(false);}},[issue.updatedAt]);
  const unsettled=[retry,dismiss].some(cmd=>Boolean(cmd.tracked&&!settledState(cmd.operation)));
  const historical=currentRunId!==undefined&&currentRunId!==issue.runId;
  const base=!fresh||historical||checking||retry.busy||dismiss.busy||!retry.online||unsettled||d.layout==='legacy_v2';
  const canRetry=!base&&issue.status==='open',canDismiss=!base&&(issue.status==='open'||issue.status==='retrying');
  async function send(kind:'issue_retry'|'issue_dismiss'){
    const target=kind==='issue_retry'?retry:dismiss;
    setError('');setChecking(true);
    try{
      // The episode may have moved on since the page was read; the runtime also re-checks the exact updatedAt.
      const current=await d.api.run(d.projectId,issue.runId);
      if(current.currentRunId!==issue.runId){setError('Công việc đã được tiếp nối ở phiên bản khác nên sự cố này không còn thao tác được. Đã đọc lại hàng đợi.');return;}
      if(settledState(target.operation))await target.startNew();
      await target.submit({kind,runId:issue.runId,issueId:issue.issueId,expectedUpdatedAt:issue.updatedAt});
      setConfirm(false);
    }catch(e){
      setError(e instanceof ApiError?e.code==='stale_version'?'Sự cố đã thay đổi. Đã đọc lại hàng đợi; kiểm tra rồi thử lại nếu vẫn cần.':explain(e):'Chưa gửi được thao tác. Đọc lại hàng đợi rồi thử lại.');
    }finally{setChecking(false);refresh();}
  }
  const open=issue.status==='open'||issue.status==='retrying';
  return <div data-component="IssueActions" className="mt-2">
    {open&&<div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={!canRetry} onClick={()=>void send('issue_retry')}>Thử lại sự cố</button>
      <button type="button" disabled={!canDismiss} aria-expanded={confirm} aria-controls={confirm?uid:undefined} onClick={()=>setConfirm(true)}>Bỏ qua sự cố</button>
    </div>}
    {open&&issue.status==='retrying'&&<p className="my-1 text-xs text-muted">Sự cố đang được thử lại; chưa thể thử lại lần nữa cho đến khi có kết quả.</p>}
    {open&&historical&&<p role="status" className="my-1 text-xs text-warning">Công việc đã được tiếp nối ở phiên bản khác; sự cố của bản này chỉ để xem.</p>}
    {open&&!fresh&&<p role="status" className="my-1 text-xs text-muted">Đang đọc lại hàng đợi; thao tác sẽ bật khi dữ liệu mới về.</p>}
    {unsettled&&<p role="status" className="my-1 text-xs text-warning">Thao tác trước chưa rõ kết quả. Chỉ đọc lại để đối chiếu; không gửi lại.<button type="button" className="ml-2" onClick={()=>retry.tracked&&!settledState(retry.operation)?retry.reread():dismiss.reread()}>Đọc lại thao tác</button></p>}
    {confirm&&<div id={uid}><ActionConfirmation title="Xác nhận bỏ qua sự cố" onBack={()=>setConfirm(false)}>
      <p className="text-sm">Bỏ qua chỉ đóng sự cố trong hàng đợi. Nhiệm vụ liên quan vẫn ở trạng thái treo và công việc không tự chạy tiếp.</p>
      <div className="mb-2"><button type="button" disabled={!canDismiss} onClick={()=>void send('issue_dismiss')}>Xác nhận bỏ qua</button></div>
    </ActionConfirmation></div>}
    {error&&<p role="alert" className="my-1 text-sm">{error}</p>}
  </div>;
}

export function IssueBadge({status}:{status:ParkedIssueStatus}){
  return <span className={`inline-flex items-center gap-1 border px-2 py-0.5 font-data text-xs leading-5 ${status==='open'?'border-warning text-warning':'border-steel text-steel'}`}><span aria-hidden="true">{statusIcon[status]}</span><span>{issueStatusLabels[status]}</span></span>;
}
export function IssueSummary({issue}:{issue:ParkedIssue}){
  return <>
    <p className="my-1 flex flex-wrap items-center gap-2"><strong>{kindLabels[issue.kind]}</strong><IssueBadge status={issue.status}/><span className="font-data text-xs text-muted">{issue.attempts} lần thử</span></p>
    <p className="my-1 text-sm [overflow-wrap:anywhere]">{issue.summary}</p>
    {issue.suggestedAction&&<p className="my-1 text-sm text-muted [overflow-wrap:anywhere]">Gợi ý: {issue.suggestedAction}</p>}
    <p className="my-1 font-data text-xs text-muted">Cập nhật <time dateTime={issue.updatedAt}>{stamp(issue.updatedAt)}</time>{issue.evidence.length>0?` · ${issue.evidence.length} tài liệu`:''}</p>
  </>;
}

/** Embeddable queue (Classic page and office inspector). `compact` only trims the heading. */
export function IssueQueuePanel({compact=false}:{compact?:boolean}){
  const q=useIssueQueue(),Heading=compact?'h3':'h2';
  const base=`/projects/${encodeURIComponent(q.projectId)}/issues`;
  const filterId=useId();
  return <section data-component="IssueQueue" aria-label="Hàng đợi sự cố" className="min-w-0">
    <Heading className="issue-queue-heading m-0 text-base">Hàng đợi sự cố</Heading>
    {q.availability==='unavailable'&&<p role="status" className="my-2 text-sm text-muted">Hàng đợi sự cố chưa khả dụng với cấu hình hoặc phiên bản này. Đây không có nghĩa là không có sự cố.</p>}
    {q.availability==='unknown'&&<div role="status" className="my-2 text-sm"><p className="my-1">Chưa xác định được trạng thái hàng đợi. Lần đọc phiên Director gần nhất không thành công; đây không có nghĩa là không có sự cố.</p><button type="button" onClick={q.refresh}>Đọc lại</button></div>}
    {q.availability==='loading'&&<LoadingState loading initial label="Đang đọc hàng đợi sự cố…"/>}
    {q.availability==='ready'&&<>
      <div className="issue-filter-row my-2 flex flex-wrap items-end gap-3"><div><label htmlFor={filterId} className="block text-xs">Lọc theo trạng thái</label><select id={filterId} value={q.filter} onChange={e=>q.setFilter(e.target.value as IssueFilter)}>{(Object.keys(filterLabels) as IssueFilter[]).map(key=><option key={key} value={key}>{filterLabels[key]}</option>)}</select></div><button type="button" onClick={q.refresh}>Đọc lại hàng đợi</button></div>
      {Boolean(q.error)&&<p role="alert" className="issue-read-alert my-2 border-l-3 border-warning pl-3 text-sm">Chưa đọc được hàng đợi sự cố mới nhất; dữ liệu bên dưới có thể đã cũ. Đây không có nghĩa là hết sự cố.</p>}
      {q.items.length===0?<p className="issue-empty my-2 text-sm text-muted">{q.all.length===0&&q.page===1?'Chưa có sự cố nào được ghi nhận.':'Không có sự cố phù hợp bộ lọc trong trang này.'}</p>
        :<ul className="m-0 list-none border-t border-line p-0">{q.items.map(issue=><li key={issue.issueId} className="border-b border-line py-2.5"><IssueSummary issue={issue}/>
          <p className="my-1 text-sm"><Link to={`${base}/${encodeURIComponent(issue.issueId)}`}>Xem chi tiết sự cố →</Link></p>
          <IssueActions issue={issue} currentRunId={q.currentRuns[issue.runId]} fresh={q.fresh} refresh={q.refresh}/></li>)}</ul>}
      {(q.hasNext||q.hasPrevious)&&<nav aria-label="Phân trang hàng đợi sự cố" className="my-2 flex flex-wrap items-center gap-2"><button type="button" disabled={!q.hasPrevious||q.loading} onClick={q.previous}>Trang trước</button><span className="font-data text-xs text-muted">Trang {q.page}</span><button type="button" disabled={!q.hasNext||q.loading} onClick={q.next}>Trang sau</button></nav>}
    </>}
  </section>;
}

export function IssuesPage(){
  return <><div className="font-data text-xs font-semibold uppercase tracking-widest text-muted">Theo dõi sự cố</div><h1 data-component="Issues">Việc cần xử lý</h1>
    <p className="text-sm text-muted">Một số việc đã tạm dừng vì gặp vấn đề. Xem nguyên nhân, rồi chọn thử lại hoặc bỏ qua. Bỏ qua chỉ đóng thông báo, không chạy tiếp công việc.</p>
    <IssueQueuePanel/></>;
}
