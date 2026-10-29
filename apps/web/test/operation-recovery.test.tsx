import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CommandStore } from '../src/api/commands';
import { ApiClient } from '../src/api/client';
const body={kind:'create_request' as const,title:'Tìm sách',requestKind:'feature' as const,objective:'Tìm nhanh',acceptanceCriteria:[{description:'Tìm theo tên',verificationMethod:'integration_test' as const}],constraints:[]};
const op=(id:string)=>({apiVersion:1,operationId:id,projectId:'p',owner:'host_interaction',operationKind:'create_request',state:'accepted',updatedAt:new Date().toISOString()});
beforeEach(()=>{localStorage.clear();vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('navigator',{onLine:true,locks:{request:async(_key:string,callback:()=>unknown)=>callback()}});});afterEach(()=>vi.unstubAllGlobals());
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
