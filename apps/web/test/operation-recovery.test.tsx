import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CommandStore } from '../src/api/commands';
import { ApiClient, ApiError } from '../src/api/client';
const body={kind:'create_request' as const,title:'Tìm sách',requestKind:'feature' as const,objective:'Tìm nhanh',acceptanceCriteria:[{description:'Tìm theo tên',verificationMethod:'integration_test' as const}],constraints:[]};
const op=(id:string)=>({apiVersion:1,operationId:id,projectId:'p',owner:'host_interaction',operationKind:'create_request',state:'accepted',updatedAt:new Date().toISOString()});
beforeEach(()=>{localStorage.clear();vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('navigator',{onLine:true,locks:{request:async(_key:string,callback:()=>unknown)=>callback()}});});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('lost response, reload and changed body never send another mutation',async()=>{
  let posts=0;const fetcher=vi.fn(async(_path:string,options?:RequestInit)=>{if(options?.method==='POST'){posts++;throw new TypeError('lost ACK');}return new Response(JSON.stringify(op(store.records()[0]!.commandId)));});vi.stubGlobal('fetch',fetcher);
  const store=new CommandStore(new ApiClient(),'p','session');
  expect((await store.submit('create',body)).uncertain).toBe(true);
  const recovered=new CommandStore(new ApiClient(),'p','session');
  expect((await recovered.submit('create',body)).operation?.state).toBe('accepted');
  await expect(recovered.submit('create',{...body,title:'Khác'})).rejects.toThrow('đối chiếu');
  await expect(recovered.newIntent('create')).rejects.toThrow('Chưa xác định');expect(posts).toBe(1);
  expect(localStorage.getItem(store.prefix+'create')).not.toContain('Tìm sách');
});
test('two concurrent submissions reserve one durable ID',async()=>{
  let posts=0;vi.stubGlobal('fetch',async(_p:string,options:RequestInit)=>{posts++;return new Response(JSON.stringify(op(JSON.parse(options.body as string).commandId)));});
  const store=new CommandStore(new ApiClient(),'p','session');const first=store.submit('create',body);
  await expect(store.submit('create',body)).rejects.toThrow('đang');await first;expect(posts).toBe(1);
});
test('re-pairing after server restart observes IDs from the previous browser session',async()=>{
  let posts=0;vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{if(options?.method==='POST'){posts++;throw Error('lost');}return Response.json(op(path.split('/').at(-1)!));});
  const first=new CommandStore(new ApiClient(),'p','old-browser-session');await first.submit('create',body);
  const next=new CommandStore(new ApiClient(),'p','new-browser-session');expect(next.records()).toHaveLength(1);
  await next.submit('create',body);expect(posts).toBe(1);
});
test('invalid local command is rejected before reserving recovery metadata',async()=>{
  const store=new CommandStore(new ApiClient(),'p','session');await expect(store.submit('create',{...body,title:''})).rejects.toThrow();expect(store.records()).toHaveLength(0);
});
test('refuses mutations without cross-tab Web Locks support',async()=>{
  vi.stubGlobal('navigator',{onLine:true});const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const store=new CommandStore(new ApiClient(),'p','session');await expect(store.submit('create',body)).rejects.toThrow('khóa thao tác');expect(fetcher).not.toHaveBeenCalled();expect(store.records()).toHaveLength(0);
});
test('definitive refusal permits a corrected new intent with a new ID',async()=>{
  const ids:string[]=[];let fail=true;vi.stubGlobal('fetch',async(_path:string,options?:RequestInit)=>{const command=JSON.parse(options!.body as string);ids.push(command.commandId);if(fail){fail=false;return Response.json({apiVersion:1,code:'invalid_request',message:'Invalid',retryable:false,correlationId:'test'},{status:400});}return Response.json(op(command.commandId));});
  const store=new CommandStore(new ApiClient(),'p','session');await expect(store.submit('create',body)).rejects.toThrow('invalid_request');
  await store.submit('create',{...body,title:'Đã chỉnh yêu cầu'});expect(ids).toHaveLength(2);expect(ids[0]).not.toBe(ids[1]);
});
test('corrupt project recovery metadata blocks creating an untracked replacement',async()=>{
  const store=new CommandStore(new ApiClient(),'p','session');localStorage.setItem(store.prefix+'create','broken');
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await expect(store.submit('create',body)).rejects.toThrow('đối chiếu');expect(fetcher).not.toHaveBeenCalled();
});

// Failure guidance must come from a local translation, never backend message text.
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WebOperationSchema } from '@bflow/contracts/web';
import { OperationStatus } from '../src/components/OperationStatus';
import type { Observation } from '../src/api/commands';
const record={slot:'create',scope:'browser',commandId:'00000000-0000-4000-8000-000000000001',fingerprint:'a'.repeat(64),kind:'create_request' as const};
function failed(code:'invalid_request'|'stale_version'|'unavailable',state:'failed'|'reconciliation_required'='failed'):Observation{return {record,operation:WebOperationSchema.parse({...op(record.commandId),state,error:{apiVersion:1,code,message:'PRIVATE /secret/socket host-token',retryable:code==='unavailable',correlationId:'safe-correlation'}})};}
function show(observation:Observation){return render(<MemoryRouter><OperationStatus observation={observation} projectId="p"/></MemoryRouter>);}
test('failed input explains correction for workflow forms without raw backend text',()=>{
  show(failed('invalid_request'));expect(screen.getByText(/Kiểm tra nội dung yêu cầu, câu trả lời và các trường bắt buộc/)).toBeTruthy();expect(screen.getByText(/Sau khi sửa thông tin, chọn “Bắt đầu thao tác mới”/)).toBeTruthy();expect(document.body.textContent).not.toContain('PRIVATE');expect(document.body.textContent).not.toContain('socket');cleanup();
});
test('stale failure requires rereading the current review before a new intent',()=>{
  show(failed('stale_version'));expect(screen.getByText(/Phiên bản công việc hoặc gói xem xét đã thay đổi/)).toBeTruthy();expect(screen.getByText(/Đọc lại công việc và xem xét gói hiện hành trước khi bắt đầu thao tác mới/)).toBeTruthy();cleanup();
});
test('uncertain operation explains the cause but never suggests a new mutation',()=>{
  show(failed('invalid_request','reconciliation_required'));expect(screen.getByText(/Kiểm tra nội dung yêu cầu/)).toBeTruthy();expect(screen.getByText(/Chỉ đọc lại thao tác để đối chiếu; chưa gửi lại hoặc bắt đầu thao tác mới/)).toBeTruthy();expect(screen.queryByText(/Sau khi sửa thông tin/)).toBeNull();cleanup();
});
test('lost operation lookup explains session expiry without exposing exception messages',()=>{
  show({record,uncertain:true,error:new ApiError('session_required')});expect(screen.getByText(/Phiên trình duyệt đã hết hạn/)).toBeTruthy();expect(document.body.textContent).not.toContain('PRIVATE');cleanup();
});

// D-CD-01 Director launch: an uncertain terminal launch is observed by its original operation ID and never relaunched.
const launch={kind:'director_launch' as const,provider:'claude' as const,replaceActive:false};
const launchOp=(id:string,state='reconciliation_required')=>({apiVersion:1,operationId:id,projectId:'p',owner:'local_lifecycle',operationKind:'director_launch',state,
  ...(state==='reconciliation_required'?{error:{apiVersion:1,code:'reconciliation_required',message:'uncertain',retryable:false,operationId:id,correlationId:'c'}}:{}),updatedAt:new Date().toISOString()});
test('director launch posts only the provider choice and an operation ID to the launch route',async()=>{
  const posts:{path:string;body:any}[]=[];
  vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{const body=JSON.parse(String(init!.body));posts.push({path,body});return Response.json(launchOp(body.operationId,'accepted'),{status:202});});
  const store=new CommandStore(new ApiClient(),'p','session');
  const observed=await store.submit('director_launch',launch);
  expect(observed.operation?.operationKind).toBe('director_launch');
  expect(posts).toHaveLength(1);expect(posts[0]!.path).toBe('/api/v1/projects/p/director/launch');
  expect(Object.keys(posts[0]!.body).sort()).toEqual(['apiVersion','operationId','provider','replaceActive']);
  expect(posts[0]!.body).toMatchObject({apiVersion:1,provider:'claude',replaceActive:false,operationId:store.records()[0]!.commandId});
});
test('uncertain director launch: reload, a second tab and an identical retry only observe the original ID',async()=>{
  let posts=0;const reads:string[]=[];
  vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){posts++;throw new TypeError('lost ACK');}reads.push(path);return Response.json(launchOp(path.split('/').at(-1)!));});
  const first=new CommandStore(new ApiClient(),'p','tab-1');
  expect((await first.submit('director_launch',launch)).uncertain).toBe(true);
  const original=first.records()[0]!.commandId;
  const otherTab=new CommandStore(new ApiClient(),'p','tab-2');
  const observed=await otherTab.submit('director_launch',launch);
  expect(observed.operation?.state).toBe('reconciliation_required');
  await expect(otherTab.submit('director_launch',{...launch,provider:'codex'})).rejects.toThrow('đối chiếu');
  expect(posts).toBe(1);expect(reads.every(path=>path.endsWith(`/operations/${original}`))).toBe(true);
  // Only an explicit new intent naming this exact uncertain operation releases the slot; nothing is resent by it.
  await expect(otherTab.newIntent('director_launch')).rejects.toThrow('Chưa xác định');
  await otherTab.newIntent('director_launch',original);expect(otherTab.records()).toHaveLength(0);expect(posts).toBe(1);
  expect(JSON.stringify(localStorage)).not.toContain('claude');
});
test('concurrent director launches in one tab reserve one operation',async()=>{
  let posts=0;vi.stubGlobal('fetch',async(_p:string,init:RequestInit)=>{posts++;return Response.json(launchOp(JSON.parse(String(init.body)).operationId,'accepted'),{status:202});});
  const store=new CommandStore(new ApiClient(),'p','session');const first=store.submit('director_launch',launch);
  await expect(store.submit('director_launch',launch)).rejects.toThrow('đang');await first;expect(posts).toBe(1);
});
test('a backend without the Director port refuses definitively and keeps no recovery record',async()=>{
  vi.stubGlobal('fetch',async()=>Response.json({apiVersion:1,code:'operation_not_allowed',message:'no port',retryable:false,correlationId:'c'},{status:422}));
  const store=new CommandStore(new ApiClient(),'p','session');
  await expect(store.submit('director_launch',launch)).rejects.toThrow('operation_not_allowed');expect(store.records()).toHaveLength(0);
});
