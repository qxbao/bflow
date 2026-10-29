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
  vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){const body=JSON.parse(init.body as string);commands.push(body);return Response.json({apiVersion:1,projectId:'p',operationId:body.commandId,owner:'host_interaction',operationKind:'answer_clarification',state:'accepted',updatedAt:now});}if(path==='/api/v1/session')return Response.json({apiVersion:1,sessionId:'browser',expiresAt:'2026-10-30T00:00:00Z',csrfToken:'csrf'});if(path==='/api/v1/projects')return Response.json({apiVersion:1,items:projects});return Response.json(path.includes('/operations/')?{apiVersion:1,projectId:'p',operationId:path.split('/').at(-1),owner:'host_interaction',operationKind:'answer_clarification',state:'accepted',updatedAt:now}:projected);});
  render(<MemoryRouter initialEntries={['/projects/p/runs/run']}><App api={new ApiClient()}/></MemoryRouter>);
  const button=await screen.findByRole('button',{name:'Gửi câu trả lời'});expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Câu trả lời'),{target:{value:'Giữ phạm vi'}});fireEvent.click(button);await waitFor(()=>expect(commands).toHaveLength(1));expect(commands[0]).toMatchObject({kind:'answer_clarification',runId:'run',questionId:'q',expectedVersion:{revisionToken:'question-version'},answer:'Giữ phạm vi'});
});
test('revise retains run context and sends the available action version with full replacement requirements',async()=>{
  const action={kind:'revise_request' as const,actionId:'revise-run',enabled:true,expectedVersion:{revisionToken:'revise-version'}};
  const current={...run,availableActions:[action]};const commands:any[]=[];
  vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){const command=JSON.parse(init.body as string);commands.push(command);return Response.json({apiVersion:1,projectId:'p',operationId:command.commandId,owner:'host_interaction',operationKind:'revise_request',state:'accepted',updatedAt:new Date().toISOString()});}return Response.json(path.includes('/operations/')?{apiVersion:1,projectId:'p',operationId:path.split('/').at(-1),owner:'host_interaction',operationKind:'revise_request',state:'accepted',updatedAt:new Date().toISOString()}:current);});
  const api=new ApiClient();render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><RunActions api={api} id="p" run={current} fresh/></Operations></MemoryRouter>);
  fireEvent.click(screen.getByRole('button',{name:'Chỉnh yêu cầu'}));fireEvent.change(screen.getByLabelText('Mục tiêu'),{target:{value:'Giữ mục tiêu và thêm bộ lọc'}});fireEvent.change(screen.getByLabelText('Tiêu chí chấp nhận (mỗi dòng một tiêu chí)'),{target:{value:'Giữ tìm kiếm tên\nThêm lọc tác giả'}});fireEvent.change(screen.getByLabelText('Ràng buộc (mỗi dòng một ràng buộc)'),{target:{value:'Giữ tương thích API'}});fireEvent.click(screen.getByRole('button',{name:'Gửi chỉnh sửa'}));
  await waitFor(()=>expect(commands).toHaveLength(1));expect(commands[0]).toMatchObject({kind:'revise_request',runId:'run',expectedVersion:{revisionToken:'revise-version'},objective:'Giữ mục tiêu và thêm bộ lọc',constraints:['Giữ tương thích API']});expect(commands[0].acceptanceCriteria).toHaveLength(2);
});
test('recovery stop requires confirmation and uses a separate force intent',async()=>{
 const {SessionActions}=await import('../src/features/run-actions/session');const session={apiVersion:1 as const,projectId:'p',state:'unavailable' as const,pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()};const posts:any[]=[];
 vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){const body=JSON.parse(init.body as string);posts.push(body);return Response.json({apiVersion:1,projectId:'p',operationId:body.operationId,owner:'local_lifecycle',operationKind:'session_stop',state:'accepted',updatedAt:new Date().toISOString()});}if(path.includes('/operations/'))return Response.json({apiVersion:1,projectId:'p',operationId:path.split('/').at(-1),owner:'local_lifecycle',operationKind:'session_stop',state:'accepted',updatedAt:new Date().toISOString()});return Response.json(session);});
 const api=new ApiClient();render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><SessionActions api={api} id="p" session={session} fresh/></Operations></MemoryRouter>);
 fireEvent.click(screen.getByRole('button',{name:'Dừng phục hồi'}));expect(posts).toHaveLength(0);expect(screen.getByText(/Buộc dừng phiên Herdr sau quiesce và checkpoint/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Gửi yêu cầu dừng phiên'}));await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0]).toMatchObject({apiVersion:1,confirmed:true,force:true,operationId:expect.any(String)});
 expect(Object.keys(localStorage).some(key=>key.endsWith(':session_stop_force'))).toBe(true);
});
test('can open a cancellation confirmation during background refresh while mutation stays blocked until fresh',async()=>{
 const current={...run,availableActions:[cancel]};const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const api=new ApiClient();
 render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><RunActions api={api} id="p" run={current} fresh={false} refreshing/></Operations></MemoryRouter>);
 const open=screen.getByRole('button',{name:'Hủy công việc'});expect((open as HTMLButtonElement).disabled).toBe(false);fireEvent.click(open);
 fireEvent.change(screen.getByLabelText('Lý do hủy'),{target:{value:'Giữ lý do trong lúc tải lại'}});
 expect((screen.getByRole('button',{name:'Gửi yêu cầu hủy'}) as HTMLButtonElement).disabled).toBe(true);expect(fetcher).not.toHaveBeenCalled();
});
