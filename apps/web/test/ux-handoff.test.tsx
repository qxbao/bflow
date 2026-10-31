import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/app';
import { ApiClient, ApiError } from '../src/api/client';
import { Blockers } from '../src/components/Blockers';
import { Evidence } from '../src/components/DecisionCard';
import { ReadProblems } from '../src/components/ReadProblems';
import { RunActions } from '../src/features/run-actions';
import { Operations } from '../src/features/operations';
import { RequestForm } from '../src/features/requests';
import { ChatHistory } from '../src/features/chat';
import { decision, installApi, now, run } from './fixtures';

beforeEach(()=>{localStorage.clear();sessionStorage.clear();vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('navigator',{onLine:true,locks:{request:async(_key:string,callback:()=>unknown)=>callback()}});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const openRun=()=>render(<MemoryRouter initialEntries={['/projects/p/runs/run']}><App api={new ApiClient()}/></MemoryRouter>);

it('UX-02/UX-05: names who the run is waiting on from the projection, not from terminal state',async()=>{
 installApi({'/api/v1/projects/p/runs/run':{...run,decisions:[],blockers:[{code:'manual_resume_required',message:'x'}]}});openRun();
 const step=await screen.findByRole('region',{name:'Bước hiện tại'});
 expect(step.textContent).toContain('Đang bị chặn');expect(step.textContent).toContain('Tiếp tục');expect(step.textContent).not.toContain('Kết thúc lượt');
});
it('UX-03: a revision refused by Runtime is disabled with the valid way forward, reason shown once',async()=>{
 const action={kind:'revise_request' as const,actionId:'revise',enabled:false,disabledReason:'core_execution_started',expectedVersion:{revisionToken:'v'}};
 installApi({'/api/v1/projects/p/runs/run':{...run,availableActions:[action]}});openRun();
 const button=await screen.findByRole('button',{name:'Chỉnh yêu cầu'});expect((button as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getAllByText(/hủy công việc này rồi tạo công việc mới/)).toHaveLength(1);
});
it('UX-04: an approved package stays readable and is not offered for review again',async()=>{
 const approved={...decision,status:'approved'};
 installApi({'/api/v1/projects/p/runs/run':{...run,decisions:[approved]}});openRun();
 expect(await screen.findByRole('heading',{name:'Đã có hiệu lực'})).toBeTruthy();expect(screen.getByText('Xem xét thiết kế tìm kiếm')).toBeTruthy();expect(screen.getByText('Đã duyệt')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Xem xét gói'})).toBeNull();
});
it('UX-07: a form still tracking an earlier operation says so and only starts over on request',async()=>{
 const operation={apiVersion:1,projectId:'p',operationId:'',owner:'host_interaction',operationKind:'create_request',state:'failed',error:{apiVersion:1,code:'operation_not_allowed',message:'x',retryable:false,correlationId:'c'},updatedAt:new Date().toISOString()};
 const posts:unknown[]=[];vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){posts.push(path);return Response.json({});}return Response.json(path.includes('/operations/')?{...operation,operationId:path.split('/').at(-1)}:{apiVersion:1,projectId:'p',state:'ready',pendingIntakes:[],blockers:[],updatedAt:now});});
 const id='3f3b9a6e-3f0e-4b53-9a56-0c6a1d2b7e11',key='bflow:web:operations:p:unpaired:create';localStorage.setItem(key,JSON.stringify({slot:'create',scope:'unpaired',commandId:id,fingerprint:'a'.repeat(64),kind:'create_request'}));
 const api=new ApiClient();render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><RequestForm api={api} id="p" sessionId="s" enabled/></Operations></MemoryRouter>);
 expect((await screen.findByText(/Bấm gửi lúc này không tạo yêu cầu mới/)).textContent).toContain('không được áp dụng');
 expect((screen.getByRole('button',{name:'Tạo công việc'}) as HTMLButtonElement).disabled).toBe(true);expect(posts).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:'Soạn yêu cầu mới từ nội dung này'}));
 await waitFor(()=>expect(localStorage.getItem(key)).toBeNull());expect(posts).toHaveLength(0);
});
it('UX-12: shows this run plus shared messages and never another run',async()=>{
 const base={apiVersion:1,sessionId:'s',sender:'user',createdAt:now,delivery:'delivered',source:'web'};
 const items=[{...base,messageId:'11111111-1111-4111-8111-111111111111',runId:'run',content:'Tin của công việc'},{...base,messageId:'22222222-2222-4222-8222-222222222222',runId:'other',content:'Tin công việc khác'},{...base,messageId:'33333333-3333-4333-8333-333333333333',content:'Tin chung'}];
 vi.stubGlobal('fetch',async(path:string)=>Response.json(path.endsWith('/session')?{apiVersion:1,projectId:'p',state:'ready',sessionId:'s',pendingIntakes:[],blockers:[],updatedAt:now}:{apiVersion:1,items}));
 render(<MemoryRouter><ChatHistory api={new ApiClient()} projectId="p" sessionId="s" runId="run" revision={0}/></MemoryRouter>);
 expect(await screen.findByText('Tin của công việc')).toBeTruthy();expect(screen.getByText('Tin chung')).toBeTruthy();expect(screen.queryByText('Tin công việc khác')).toBeNull();
 expect(screen.getAllByText(/chưa có nghĩa đã được xử lý/).length).toBeGreaterThan(0);
});
it('UX-14: one cause across several reads is one notice with one retry',()=>{
 const error=new ApiError('unavailable'),retry=vi.fn();
 render(<ReadProblems retry={retry} problems={[{label:'công việc',error,stale:false},{label:'quyết định',error,stale:true}]}/>);
 expect(screen.getAllByRole('alert')).toHaveLength(1);expect(screen.getByText(/Ảnh hưởng: công việc, quyết định/)).toBeTruthy();expect(screen.getAllByRole('button')).toHaveLength(1);
});
it('UX-15: required blockers lead, optional degradation is labelled and unknown codes stay required',()=>{
 render(<Blockers items={[{code:'chat_adapter_unavailable',message:'x'},{code:'something_new',message:'x'},{code:'auto_resume_scheduled',message:'x'}]}/>);
 const text=screen.getAllByText(/./).map(node=>node.textContent).join('|');
 expect(text.indexOf('Cần xử lý')).toBeLessThan(text.indexOf('Đang kiểm tra'));expect(text.indexOf('Đang kiểm tra')).toBeLessThan(text.indexOf('Suy giảm tùy chọn'));
});
it('UX-17: operations of other runs that settled long ago move to history',async()=>{
 const old={apiVersion:1,projectId:'p',owner:'host_interaction',operationKind:'cancel',state:'applied',result:{kind:'interaction',runId:'other',currentRunId:'other'},updatedAt:'2026-01-01T00:00:00Z'};
 vi.stubGlobal('fetch',async(path:string)=>Response.json({...old,operationId:path.split('/').at(-1)}));
 localStorage.setItem('bflow:web:operations:p:unpaired:cancel:other',JSON.stringify({slot:'cancel:other',scope:'unpaired',commandId:'3f3b9a6e-3f0e-4b53-9a56-0c6a1d2b7e11',fingerprint:'a'.repeat(64),kind:'cancel'}));
 render(<MemoryRouter initialEntries={['/projects/p/runs/run']}><Operations api={new ApiClient()} id="p" refresh={()=>{}}><span/></Operations></MemoryRouter>);
 expect((await screen.findByText(/Lịch sử thao tác \(1\)/)).tagName).toBe('SUMMARY');
});
it('UX-18: a click during refresh explains that nothing was sent and keeps the reason',()=>{
 const cancel={kind:'cancel' as const,actionId:'c',enabled:true,expectedVersion:{revisionToken:'v'}},fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const api=new ApiClient();render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><RunActions api={api} id="p" run={{...run,availableActions:[cancel]}} fresh={false} refreshing/></Operations></MemoryRouter>);
 fireEvent.click(screen.getByRole('button',{name:'Hủy công việc'}));
 expect(screen.getByText(/Lý do bạn nhập được giữ lại/)).toBeTruthy();expect(fetcher).not.toHaveBeenCalled();
});
it('UX-21: JSON evidence has a readable view and keeps the raw document',async()=>{
 vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({objective:'Tìm sách',acceptanceCriteria:[{description:'Có bộ lọc'}]}),{headers:{'Content-Disposition':'inline','Content-Type':'text/plain'}}));
 render(<Evidence api={new ApiClient()} projectId="p" evidence={{artifactId:'artifact-1',runId:'run',kind:'report',mediaType:'application/json',checksum:{algorithm:'sha256',value:'a'.repeat(64)}} as never}/>);
 fireEvent.click(screen.getByRole('button',{name:'Đọc nội dung an toàn'}));
 expect(await screen.findByText('Mục tiêu')).toBeTruthy();expect(screen.getByText('Có bộ lọc')).toBeTruthy();expect(screen.getByText('Xem JSON gốc')).toBeTruthy();
});
it('UX-24: mixed verification methods are sent per criterion and nothing is silently uniform',async()=>{
 const commands:any[]=[];vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){const body=JSON.parse(init.body as string);commands.push(body);return Response.json({apiVersion:1,projectId:'p',operationId:body.commandId,owner:'host_interaction',operationKind:'create_request',state:'accepted',updatedAt:now});}return Response.json(path.includes('/operations/')?{apiVersion:1,projectId:'p',operationId:path.split('/').at(-1),owner:'host_interaction',operationKind:'create_request',state:'accepted',updatedAt:now}:{apiVersion:1,projectId:'p',state:'ready',pendingIntakes:[],blockers:[],updatedAt:now});});
 const api=new ApiClient();render(<MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><RequestForm api={api} id="p" sessionId="s" enabled/></Operations></MemoryRouter>);
 fireEvent.change(screen.getByLabelText('Tên công việc'),{target:{value:'Tên'}});fireEvent.change(screen.getByLabelText('Mục tiêu'),{target:{value:'Mục tiêu'}});
 fireEvent.change(screen.getByLabelText('Tiêu chí chấp nhận (mỗi dòng một tiêu chí)'),{target:{value:'DOM đúng\nKiểu đúng'}});
 fireEvent.change(screen.getByLabelText('Cách kiểm chứng: Kiểu đúng'),{target:{value:'typecheck'}});
 fireEvent.click(screen.getByRole('button',{name:'Tạo công việc'}));await waitFor(()=>expect(commands).toHaveLength(1));
 expect(commands[0].acceptanceCriteria).toEqual([{description:'DOM đúng',verificationMethod:'integration_test'},{description:'Kiểu đúng',verificationMethod:'typecheck'}]);
});
it('UX-28: a pairing link on a loaded document pairs again and erases the secret; other anchors are untouched',async()=>{
 const {fetcher}=installApi();openRun();await screen.findByRole('heading',{name:run.title});
 location.hash='#settings-readiness';window.dispatchEvent(new Event('hashchange'));expect(location.hash).toBe('#settings-readiness');
 fetcher.mockImplementation(async(path:string)=>new Response(JSON.stringify(path==='/api/v1/session/bootstrap'?{apiVersion:1,sessionId:'browser',expiresAt:new Date(Date.now()+3600000).toISOString(),csrfToken:'csrf'}:{apiVersion:1,items:[]})));
 location.hash='#bootstrap=secret-value';window.dispatchEvent(new Event('hashchange'));
 expect(location.hash).toBe('');await waitFor(()=>expect(fetcher.mock.calls.some(([path])=>path==='/api/v1/session/bootstrap')).toBe(true));
});
