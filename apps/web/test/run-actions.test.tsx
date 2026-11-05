import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { RunActions } from '../src/features/run-actions';
import { Operations } from '../src/features/operations';
import { ApiClient } from '../src/api/client';
import { run } from './fixtures';
const version={revisionToken:'v1'},resume={kind:'resume' as const,actionId:'resume-1',expectedVersion:version,enabled:false,disabledReason:'approval_required'},cancel={kind:'cancel' as const,actionId:'cancel-1',expectedVersion:version,enabled:true};
beforeEach(()=>{localStorage.clear();vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('navigator',{onLine:true,locks:{request:async(_key:string,callback:()=>unknown)=>callback()}});});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('non-resumable blocker disables resume; cancel confirms reason and accepted is not stopped',async()=>{
  const current={...run,availableActions:[resume,cancel]};const posts:unknown[]=[];
  vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){const body=JSON.parse(init.body as string);posts.push(body);return Response.json({apiVersion:1,projectId:'p',operationId:body.commandId,owner:'host_interaction',operationKind:'cancel',state:'accepted',updatedAt:new Date().toISOString()});}if(path.includes('/operations/'))return Response.json({apiVersion:1,projectId:'p',operationId:path.split('/').at(-1),owner:'host_interaction',operationKind:'cancel',state:'accepted',updatedAt:new Date().toISOString()});return Response.json(current);});
  const api=new ApiClient();render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><RunActions api={api} id="p" run={current} fresh/></Operations></MemoryRouter>);
  expect((screen.getByRole('button',{name:'Tiếp tục'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Hủy công việc'}));expect(posts).toHaveLength(0);fireEvent.click(screen.getByRole('button',{name:'Gửi yêu cầu hủy'}));expect(screen.getByRole('alert').textContent).toContain('lý do');
  fireEvent.change(screen.getByLabelText('Lý do hủy'),{target:{value:'Đổi ưu tiên'}});fireEvent.click(screen.getByRole('button',{name:'Gửi yêu cầu hủy'}));await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0]).toMatchObject({kind:'cancel',expectedVersion:version,reason:'Đổi ưu tiên'});
  expect(await screen.findByText('Yêu cầu hủy chưa xác nhận tiến trình đã dừng.')).toBeTruthy();expect(screen.queryByText('Đã hoàn thành')).toBeNull();
});
test('answers an actual run projection question without an invented clarification action',async()=>{
  const {App}=await import('../src/app');const {installApi,now,projects}=await import('./fixtures');
  const question={questionId:'q',question:'Phạm vi làm rõ?',options:['Giữ phạm vi'],expectedVersion:{revisionToken:'question-version'}};
  const projected={...run,clarifications:[question],availableActions:[cancel]};
  installApi();const commands:any[]=[];
  vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){const body=JSON.parse(init.body as string);commands.push(body);return Response.json({apiVersion:1,projectId:'p',operationId:body.commandId,owner:'host_interaction',operationKind:'answer_clarification',state:'accepted',updatedAt:now});}if(path==='/api/v1/session')return Response.json({apiVersion:1,sessionId:'browser',expiresAt:new Date(Date.now()+3600000).toISOString(),csrfToken:'csrf'});if(path==='/api/v1/projects')return Response.json({apiVersion:1,items:projects});return Response.json(path.includes('/operations/')?{apiVersion:1,projectId:'p',operationId:path.split('/').at(-1),owner:'host_interaction',operationKind:'answer_clarification',state:'accepted',updatedAt:now}:projected);});
  render(<MemoryRouter initialEntries={['/projects/p/runs/run']}><App api={new ApiClient()}/></MemoryRouter>);
  const button=await screen.findByRole('button',{name:'Gửi câu trả lời'});expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Câu trả lời'),{target:{value:'Giữ phạm vi'}});fireEvent.click(button);await waitFor(()=>expect(commands).toHaveLength(1));expect(commands[0]).toMatchObject({kind:'answer_clarification',runId:'run',questionId:'q',expectedVersion:{revisionToken:'question-version'},answer:'Giữ phạm vi'});
});
test('revise retains run context and sends the available action version with full replacement requirements',async()=>{
  const action={kind:'revise_request' as const,actionId:'revise-run',enabled:true,expectedVersion:{revisionToken:'revise-version'}};
  const current={...run,availableActions:[action]};const commands:any[]=[];
  vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){const command=JSON.parse(init.body as string);commands.push(command);return Response.json({apiVersion:1,projectId:'p',operationId:command.commandId,owner:'host_interaction',operationKind:'revise_request',state:'accepted',updatedAt:new Date().toISOString()});}return Response.json(path.includes('/operations/')?{apiVersion:1,projectId:'p',operationId:path.split('/').at(-1),owner:'host_interaction',operationKind:'revise_request',state:'accepted',updatedAt:new Date().toISOString()}:current);});
  const api=new ApiClient();render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><RunActions api={api} id="p" run={current} fresh/></Operations></MemoryRouter>);
  fireEvent.click(screen.getByRole('button',{name:'Chỉnh yêu cầu'}));fireEvent.change(screen.getByLabelText('Mục tiêu'),{target:{value:'Giữ mục tiêu và thêm bộ lọc'}});fireEvent.change(screen.getByLabelText('Kết quả cần đạt (mỗi dòng một ý)'),{target:{value:'Giữ tìm kiếm tên\nThêm lọc tác giả'}});fireEvent.change(screen.getByLabelText('Điều cần lưu ý (không bắt buộc)'),{target:{value:'Giữ tương thích API'}});fireEvent.click(screen.getByRole('button',{name:'Gửi chỉnh sửa'}));
  await waitFor(()=>expect(commands).toHaveLength(1));expect(commands[0]).toMatchObject({kind:'revise_request',runId:'run',expectedVersion:{revisionToken:'revise-version'},objective:'Giữ mục tiêu và thêm bộ lọc',constraints:['Giữ tương thích API']});expect(commands[0].acceptanceCriteria).toHaveLength(2);
});
test('recovery stop requires confirmation and uses a separate force intent',async()=>{
 const {SessionActions}=await import('../src/features/run-actions/session');const session={apiVersion:1 as const,projectId:'p',state:'unavailable' as const,pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()};const posts:any[]=[];
 vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){const body=JSON.parse(init.body as string);posts.push(body);return Response.json({apiVersion:1,projectId:'p',operationId:body.operationId,owner:'local_lifecycle',operationKind:'session_stop',state:'accepted',updatedAt:new Date().toISOString()});}if(path.includes('/operations/'))return Response.json({apiVersion:1,projectId:'p',operationId:path.split('/').at(-1),owner:'local_lifecycle',operationKind:'session_stop',state:'accepted',updatedAt:new Date().toISOString()});return Response.json(session);});
 const api=new ApiClient();render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><SessionActions api={api} id="p" session={session} fresh/></Operations></MemoryRouter>);
 fireEvent.click(screen.getByText('Tùy chọn phiên',{selector:'summary'}));fireEvent.click(screen.getByRole('button',{name:'Dừng khi bị kẹt'}));expect(posts).toHaveLength(0);expect(screen.getByText(/Lưu trạng thái rồi buộc dừng phiên/)).toBeTruthy();expect(screen.getByText(/Việc chưa xác minh có thể bị gián đoạn/).closest('details')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Gửi yêu cầu dừng phiên'}));await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0]).toMatchObject({apiVersion:1,confirmed:true,force:true,operationId:expect.any(String)});
 expect(Object.keys(localStorage).some(key=>key.endsWith(':session_stop_force'))).toBe(true);
});
test('a later applied stop releases an uncertain start so a stopped session can start again',async()=>{
 const {SessionActions}=await import('../src/features/run-actions/session');const session={apiVersion:1 as const,projectId:'p',state:'stopped' as const,pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()};const starts:any[]=[];
 const startId='11111111-1111-4111-8111-111111111111',stopId='22222222-2222-4222-8222-222222222222',fingerprint='a'.repeat(64);
 const seed=(slot:string,commandId:string,kind:string)=>localStorage.setItem(`bflow:web:operations:p:s:${slot}`,JSON.stringify({slot,scope:'s',commandId,fingerprint,kind}));
 seed('session_start',startId,'session_start');seed('session_stop_force',stopId,'session_stop');
 const operations:Record<string,unknown>={
  [startId]:{apiVersion:1,projectId:'p',operationId:startId,owner:'local_lifecycle',operationKind:'session_start',state:'reconciliation_required',updatedAt:'2026-11-01T15:19:23.033Z'},
  [stopId]:{apiVersion:1,projectId:'p',operationId:stopId,owner:'local_lifecycle',operationKind:'session_stop',state:'applied',result:{kind:'lifecycle',session:{...session,updatedAt:'2026-11-01T15:34:57.730Z'}},updatedAt:'2026-11-01T15:34:57.738Z'}};
 vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){const body=JSON.parse(init.body as string);starts.push(body);return Response.json({apiVersion:1,projectId:'p',operationId:body.operationId,owner:'local_lifecycle',operationKind:'session_start',state:'accepted',updatedAt:new Date().toISOString()});}if(path.includes('/operations/'))return Response.json(operations[path.split('/').at(-1)!]);return Response.json(session);});
 const api=new ApiClient();render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><SessionActions api={api} id="p" session={session} fresh/></Operations></MemoryRouter>);
 await waitFor(()=>expect(screen.getAllByText(/Mã đối chiếu thao tác/)).toHaveLength(2));
 const button=screen.getByRole('button',{name:'Khởi động phiên'}) as HTMLButtonElement;
 expect(button.disabled).toBe(false);
 fireEvent.click(button);await waitFor(()=>expect(starts).toHaveLength(1));
 expect(starts[0].operationId).not.toBe(startId);
});
test('an uncertain start without a later applied stop keeps the session controls locked',async()=>{
 const {SessionActions}=await import('../src/features/run-actions/session');const session={apiVersion:1 as const,projectId:'p',state:'stopped' as const,pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()};
 const startId='11111111-1111-4111-8111-111111111111';let observed=false;
 localStorage.setItem('bflow:web:operations:p:s:session_start',JSON.stringify({slot:'session_start',scope:'s',commandId:startId,fingerprint:'a'.repeat(64),kind:'session_start'}));
 vi.stubGlobal('fetch',async(path:string)=>{if(path.includes('/operations/')){observed=true;return Response.json({apiVersion:1,projectId:'p',operationId:startId,owner:'local_lifecycle',operationKind:'session_start',state:'reconciliation_required',updatedAt:'2026-11-01T15:19:23.033Z'});}return Response.json(session);});
 const api=new ApiClient();render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><SessionActions api={api} id="p" session={session} fresh/></Operations></MemoryRouter>);
 await waitFor(()=>expect(observed).toBe(true));await screen.findByText(/Mã đối chiếu thao tác/);
 expect((screen.getByRole('button',{name:'Khởi động phiên'}) as HTMLButtonElement).disabled).toBe(true);
});
test('can open a cancellation confirmation during background refresh while mutation stays blocked until fresh',async()=>{
 const current={...run,availableActions:[cancel]};const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const api=new ApiClient();
 render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><RunActions api={api} id="p" run={current} fresh={false} refreshing/></Operations></MemoryRouter>);
 const open=screen.getByRole('button',{name:'Hủy công việc'});expect((open as HTMLButtonElement).disabled).toBe(false);fireEvent.click(open);
 fireEvent.change(screen.getByLabelText('Lý do hủy'),{target:{value:'Giữ lý do trong lúc tải lại'}});
 expect((screen.getByRole('button',{name:'Gửi yêu cầu hủy'}) as HTMLButtonElement).disabled).toBe(true);expect(fetcher).not.toHaveBeenCalled();
});
