import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ParkedIssueSchema, WebRunViewSchema, type ParkedIssue } from '@bflow/contracts/web';
import { ApiClient } from '../src/api/client';
import { CommandStore } from '../src/api/commands';
import { Operations } from '../src/features/operations';
import { DirectorProvider } from '../src/features/director/status';
import { IssueQueuePanel, IssuesPage } from '../src/features/issues';
import { IssueDetail } from '../src/features/issues/detail';
import { Runs, RunView } from '../src/features/runs';
import { directorServer, locks, sessionRead, uuid, view } from './director-fixtures';
import { run as baseRun } from './fixtures';

beforeEach(()=>{localStorage.clear();vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{configurable:true,value:locks});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

const t1='2026-11-04T01:00:00.000Z',t2='2026-11-04T02:00:00.000Z';
const issue=(patch:Partial<ParkedIssue>={}):ParkedIssue=>ParkedIssueSchema.parse({schemaVersion:1,issueId:'iss-1',runId:'run',taskKey:'task',kind:'verification_exhausted',status:'open',
  summary:'Kiểm chứng không đạt sau 3 lượt',attempts:2,evidence:[],suggestedAction:'Xem lại kết quả kiểm thử',createdAt:t1,updatedAt:t1,...patch});
const runView=(patch:Record<string,unknown>={})=>WebRunViewSchema.parse({...baseRun,decisions:[],...patch});
const err=(code:string,status:number)=>Response.json({apiVersion:1,code,message:'x',retryable:false,correlationId:'c'},{status});
const op=(id:string,state:string,extra:Record<string,unknown>={})=>({apiVersion:1,operationId:id,projectId:'p',owner:'host_interaction',operationKind:'issue_retry',state,updatedAt:t2,...extra});

interface Setup{issues:ParkedIssue[];run?:ReturnType<typeof runView>;onCommand?:(body:any)=>Response|Error|undefined;artifact?:string}
function server(setup:Setup){
  const calls={commands:[] as any[],issueGets:0,runGets:0,artifacts:[] as string[],ops:[] as string[]},known=new Map<string,unknown>();
  const s=directorServer({extra:(path,init)=>{
    const url=new URL(path,'http://local');
    if(url.pathname==='/api/v1/projects/p/director/issues'){calls.issueGets++;return {apiVersion:1,items:setup.issues};}
    if(url.pathname==='/api/v1/projects/p/runs/run'){calls.runGets++;return setup.run??runView();}
    if(url.pathname.startsWith('/api/v1/projects/p/artifacts/')){calls.artifacts.push(url.pathname);return new Response(setup.artifact??'bằng chứng',{headers:{'Content-Disposition':'inline','Content-Type':'text/plain'}});}
    if(url.pathname==='/api/v1/projects/p/commands'){
      const body=JSON.parse(String(init.body));calls.commands.push(body);
      const out=setup.onCommand?.(body)??op(body.commandId,'applied',{operationKind:body.kind,result:{kind:'issue',issueId:body.issueId,status:body.kind==='issue_retry'?'retrying':'dismissed'}});
      if(out instanceof Error)throw out;
      if(!(out instanceof Response))known.set(body.commandId,out);
      return out instanceof Response?out:Response.json(out,{status:202});
    }
    if(url.pathname.includes('/operations/')){calls.ops.push(url.pathname);return known.get(url.pathname.split('/').at(-1)!)??err('not_found',404);}
    return undefined;
  }});
  return {...s,calls};
}
function shell(children:React.ReactNode,{revision=0,entry='/projects/p/issues'}:{revision?:number;entry?:string}={}){
  const api=new ApiClient();
  return <MemoryRouter initialEntries={[entry]}><Operations api={api} id="p" refresh={()=>{}} dock="external">
    <DirectorProvider api={api} projectId="p" session={sessionRead()} revision={revision} resetEpoch={0}>{children}</DirectorProvider></Operations></MemoryRouter>;
}
const page=(revision=0)=>shell(<Routes><Route path="/projects/:projectId/issues" element={<IssuesPage/>}/><Route path="/projects/:projectId/issues/:issueId" element={<IssueDetail/>}/></Routes>,{revision});
const detail=()=>shell(<Routes><Route path="/projects/:projectId/issues/:issueId" element={<IssueDetail/>}/></Routes>,{entry:'/projects/p/issues/iss-1'});

it('lists kind, status, attempts and suggestion, hiding closed issues until filtered',async()=>{
  server({issues:[issue(),issue({issueId:'iss-2',status:'dismissed',kind:'environment',summary:'Thiếu công cụ'}),issue({issueId:'iss-3',status:'resolved',summary:'Đã xong'})]});
  render(page());
  expect(await screen.findByText('Hết lượt kiểm chứng')).toBeTruthy();
  expect(screen.getByText('Đang mở')).toBeTruthy();expect(screen.getByText('2 lần thử')).toBeTruthy();expect(screen.getByText(/Xem lại kết quả kiểm thử/)).toBeTruthy();
  expect(screen.queryByText('Thiếu công cụ')).toBeNull();
  fireEvent.change(screen.getByLabelText('Lọc theo trạng thái'),{target:{value:'all'}});
  expect(screen.getByText('Thiếu công cụ')).toBeTruthy();expect(screen.getByText('Đã bỏ qua')).toBeTruthy();expect(screen.getByText('Đã giải quyết')).toBeTruthy();
});
it('reports a backend without the Director port as unavailable, not as an empty queue',async()=>{
  directorServer({extra:path=>path.includes('/director/issues')?err('operation_not_allowed',422):undefined});
  render(page());
  expect(await screen.findByText(/chưa khả dụng/)).toBeTruthy();expect(screen.queryByText('Chưa có sự cố nào được ghi nhận.')).toBeNull();
});
it('a failed read is not shown as an empty queue',async()=>{
  directorServer({extra:path=>path.includes('/director/issues')?err('unavailable',503):undefined});
  render(page());
  expect(await screen.findByRole('alert')).toBeTruthy();
});
it('retry sends one signed command with expectedUpdatedAt, then the queue and run reflect Runtime state',async()=>{
  const setup:Setup={issues:[issue()]};const {calls}=server(setup);
  const rendered=render(page());
  fireEvent.click(await screen.findByRole('button',{name:'Thử lại sự cố'}));
  await waitFor(()=>expect(calls.commands).toHaveLength(1));
  expect(calls.commands[0]).toMatchObject({apiVersion:1,projectId:'p',kind:'issue_retry',runId:'run',issueId:'iss-1',expectedUpdatedAt:t1});
  expect(calls.commands[0].commandId).toMatch(/^[0-9a-f-]{36}$/);
  // Runtime moves the issue to retrying and the run back to implementing; the UI only reads that back.
  setup.issues=[issue({status:'retrying',updatedAt:t2})];
  rendered.rerender(page(1));
  expect(await screen.findByText('Đang thử lại')).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button',{name:'Thử lại sự cố'}).disabled).toBe(true);
  await waitFor(()=>expect(screen.getByRole<HTMLButtonElement>('button',{name:'Bỏ qua sự cố'}).disabled).toBe(false));
  fireEvent.click(screen.getByRole('link',{name:'Xem chi tiết sự cố →'}));
  expect(await screen.findByText('Triển khai')).toBeTruthy();
});
it('a double click sends a single command',async()=>{
  const {calls}=server({issues:[issue()]});render(page());
  const button=await screen.findByRole('button',{name:'Thử lại sự cố'});
  fireEvent.click(button);fireEvent.click(button);
  await waitFor(()=>expect(calls.commands).toHaveLength(1));await new Promise(r=>setTimeout(r,30));expect(calls.commands).toHaveLength(1);
});
it('a stale issue is refused definitively, re-read and leaves no recovery record',async()=>{
  const {calls}=server({issues:[issue()],onCommand:()=>err('stale_version',409)});render(page());
  fireEvent.click(await screen.findByRole('button',{name:'Thử lại sự cố'}));
  expect(await screen.findByText(/Sự cố đã thay đổi/)).toBeTruthy();
  await waitFor(()=>expect(calls.issueGets).toBeGreaterThan(1));
  expect(Object.keys(localStorage).filter(k=>k.includes('operations'))).toHaveLength(0);
});
it('a non-current episode cannot be acted on and sends nothing',async()=>{
  const {calls}=server({issues:[issue()],run:runView({currentRunId:'child'})});render(page());
  fireEvent.click(await screen.findByRole('button',{name:'Thử lại sự cố'}));
  expect((await screen.findAllByText(/tiếp nối ở phiên bản khác/)).length).toBeGreaterThan(0);expect(calls.commands).toHaveLength(0);
});
it('list rows disable actions for a non-current episode without clicking',async()=>{
  const {calls}=server({issues:[issue()],run:runView({currentRunId:'child'})});render(page());
  await screen.findByText('Hết lượt kiểm chứng');
  await waitFor(()=>expect(screen.getByRole<HTMLButtonElement>('button',{name:'Thử lại sự cố'}).disabled).toBe(true));
  expect(screen.getByRole<HTMLButtonElement>('button',{name:'Bỏ qua sự cố'}).disabled).toBe(true);expect(calls.commands).toHaveLength(0);
});
it('an unreadable Director view is an explicit unknown state with a re-read control, not endless loading',async()=>{
  let fail=true;
  directorServer({view:()=>fail?err('unavailable',503):view(),extra:path=>path.includes('/director/issues')?{apiVersion:1,items:[issue()]}:undefined});
  render(page());
  expect(await screen.findByText(/Chưa xác định được trạng thái hàng đợi/)).toBeTruthy();expect(screen.queryByText('Đang đọc hàng đợi sự cố…')).toBeNull();
  fail=false;fireEvent.click(screen.getByRole('button',{name:'Đọc lại'}));
  expect(await screen.findByText('Hết lượt kiểm chứng')).toBeTruthy();
});
it('a non-API error shows Vietnamese text, never the raw message',async()=>{
  vi.stubGlobal('navigator',{onLine:true,locks:{request:async()=>{throw new Error('RAW_ENGLISH_BOOM');}}});
  server({issues:[issue()]});render(page());
  fireEvent.click(await screen.findByRole('button',{name:'Thử lại sự cố'}));
  expect(await screen.findByText(/Chưa gửi được thao tác/)).toBeTruthy();expect(screen.queryByText(/RAW_ENGLISH_BOOM/)).toBeNull();
});
it('the detail disables actions for a historical run',async()=>{
  server({issues:[issue()],run:runView({currentRunId:'child'})});render(detail());
  expect(await screen.findByText(/chỉ để xem/)).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button',{name:'Thử lại sự cố'}).disabled).toBe(true);
});
it('an uncertain send is observed only: no second command and actions stay locked',async()=>{
  const {calls}=server({issues:[issue()],onCommand:()=>new TypeError('lost')});render(page());
  fireEvent.click(await screen.findByRole('button',{name:'Thử lại sự cố'}));
  expect(await screen.findByText(/chưa rõ kết quả/)).toBeTruthy();
  expect(calls.commands).toHaveLength(1);
  expect(screen.getByRole<HTMLButtonElement>('button',{name:'Thử lại sự cố'}).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button',{name:'Bỏ qua sự cố'}).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Đọc lại thao tác'}));
  await waitFor(()=>expect(calls.ops.length).toBeGreaterThan(0));expect(calls.commands).toHaveLength(1);
});
it('a pending gate task keeps its own decision while retry is a separate issue command',async()=>{
  const decision=baseRun.decisions[0]!;
  const {calls}=server({issues:[issue()],run:runView({decisions:[decision]})});render(detail());
  expect(await screen.findByText(/gói đang chờ bạn quyết định/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Thử lại sự cố'}));
  await waitFor(()=>expect(calls.commands).toHaveLength(1));
  expect(calls.commands[0].kind).toBe('issue_retry');expect(calls.commands.some(c=>c.kind==='answer_decision')).toBe(false);
  expect(screen.getByText(/Thử lại sự cố không thay thế quyết định đó/)).toBeTruthy();
});
it('dismiss asks to confirm, sends only the dismiss command and the parked task stays visible',async()=>{
  const parkedRun=runView({sdlcStatus:'completed_with_parked',tasks:[{taskId:'task',title:'Thêm bộ lọc sách',status:'parked'}]});
  const {calls}=server({issues:[issue()],run:parkedRun});render(detail());
  fireEvent.click(await screen.findByRole('button',{name:'Bỏ qua sự cố'}));
  expect(screen.getByText(/vẫn ở trạng thái treo/)).toBeTruthy();expect(calls.commands).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Xác nhận bỏ qua'}));
  await waitFor(()=>expect(calls.commands).toHaveLength(1));
  expect(calls.commands[0]).toMatchObject({kind:'issue_dismiss',issueId:'iss-1',expectedUpdatedAt:t1});
  expect(screen.getByText('Thêm bộ lọc sách')).toBeTruthy();expect(screen.getByText(/1 nhiệm vụ|Nhiệm vụ còn treo \(1\)/)).toBeTruthy();
});
it('a dismissed issue shows no actions but still lists the parked task',async()=>{
  server({issues:[issue({status:'dismissed'})],run:runView({sdlcStatus:'completed_with_parked',tasks:[{taskId:'task',title:'Thêm bộ lọc sách',status:'parked'}]})});render(detail());
  expect(await screen.findByText('Đã bỏ qua')).toBeTruthy();expect(screen.queryByRole('button',{name:'Thử lại sự cố'})).toBeNull();
  expect(await screen.findByText('Thêm bộ lọc sách')).toBeTruthy();
});
it('evidence goes through the authenticated artifact route',async()=>{
  const {calls}=server({issues:[issue({evidence:['artifact://store/art-1']})]});render(detail());
  const link=await screen.findByRole<HTMLAnchorElement>('link',{name:'Tải tài liệu'});
  expect(link.getAttribute('href')).toBe('/api/v1/projects/p/artifacts/art-1');
  fireEvent.click(screen.getByRole('button',{name:'Đọc nội dung an toàn'}));
  expect(await screen.findByLabelText('Nội dung tài liệu')).toBeTruthy();expect(calls.artifacts).toEqual(['/api/v1/projects/p/artifacts/art-1']);
});
it('the embeddable panel acts through the same controller',async()=>{
  const {calls}=server({issues:[issue()]});
  render(shell(<IssueQueuePanel compact/>));
  fireEvent.click(await screen.findByRole('button',{name:'Thử lại sự cố'}));
  await waitFor(()=>expect(calls.commands).toHaveLength(1));
});
it('issue recovery records pass kind validation and are not treated as corrupt',()=>{
  const api=new ApiClient(),store=new CommandStore(api,'p','scope');
  for(const kind of ['issue_retry','issue_dismiss'] as const){
    const record={slot:`${kind}:iss-1`,scope:'scope',commandId:uuid(1),fingerprint:'a'.repeat(64),kind};
    localStorage.setItem(`${store.projectPrefix}scope:${record.slot}`,JSON.stringify(record));
  }
  expect(store.records().map(r=>r.kind).sort()).toEqual(['issue_dismiss','issue_retry']);
  localStorage.setItem(`${store.projectPrefix}scope:bad`,JSON.stringify({slot:'bad',scope:'scope',commandId:uuid(2),fingerprint:'a'.repeat(64),kind:'issue_unknown'}));
  expect(()=>store.records()).toThrow();
  store.clearCorrupted();expect(store.records()).toHaveLength(2);
});
const done=()=>screen.queryAllByText('Hoàn tất').filter(e=>e.tagName!=='OPTION');
it('completed_with_parked has its own label and parked count and never the verified-completed marker',async()=>{
  const parked=runView({sdlcStatus:'completed_with_parked',coreStatus:'succeeded',tasks:[{taskId:'a',title:'Xong',status:'succeeded'},{taskId:'b',title:'Treo',status:'parked'}]});
  directorServer({extra:path=>path==='/api/v1/projects/p/runs?limit=25'?{apiVersion:1,items:[parked]}:path==='/api/v1/projects/p/runs/run'?parked:undefined});
  const api=new ApiClient();
  const open=(entry:string)=><MemoryRouter initialEntries={[entry]}><Operations api={api} id="p" refresh={()=>{}}><DirectorProvider api={api} projectId="p" session={sessionRead()} revision={0} resetEpoch={0}><Routes><Route path="/projects/:projectId/runs" element={<Runs api={api} id="p" revision={0} refresh={()=>{}}/>}/><Route path="/projects/:projectId/runs/:runId" element={<RunView api={api} id="p" runId="run" revision={0} refresh={()=>{}}/>}/></Routes></DirectorProvider></Operations></MemoryRouter>;
  const {unmount}=render(open('/projects/p/runs'));
  expect(await screen.findByText('Xong một phần — còn mục treo')).toBeTruthy();
  expect(screen.getByText(/1\/2 nhiệm vụ hoàn thành/)).toBeTruthy();expect(screen.getByText(/1 nhiệm vụ còn treo/)).toBeTruthy();
  expect(done()).toHaveLength(0);
  unmount();render(open('/projects/p/runs/run'));
  expect((await screen.findAllByText(/Xong một phần — còn mục treo/)).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/1 nhiệm vụ còn treo/).length).toBeGreaterThan(0);expect(done()).toHaveLength(0);
  expect(screen.getByText(/chưa được kiểm chứng hoàn tất/)).toBeTruthy();
});
