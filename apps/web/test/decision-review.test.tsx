import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { DecisionReview } from '../src/features/decisions';
import { Operations } from '../src/features/operations';
import { ApiClient } from '../src/api/client';
import { decision,run,installApi } from './fixtures';
const action={actionId:'decide',kind:'answer_decision' as const,enabled:true,expectedVersion:decision.expectedVersion};
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('navigator',{onLine:true,locks:{request:async(_key:string,callback:()=>unknown)=>callback()}});localStorage.clear();});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function view(d=decision){return <MemoryRouter><Operations api={api} id="p" refresh={()=>{}}><DecisionReview api={api} id="p" decision={d} actions={[{...action,expectedVersion:d.expectedVersion}]} fresh refresh={()=>{}}/></Operations></MemoryRouter>;}
let api:ApiClient;
test('review pins evidence/version; changed revision requires explicit rereview and sends no POST',async()=>{
  const {fetcher}=installApi({'/api/v1/projects/p/runs/run':{...run,availableActions:[action]}});api=new ApiClient();const result=render(view());
  fireEvent.click(screen.getByRole('button',{name:'Xem xét gói'}));
  result.rerender(view({...decision,expectedVersion:{...decision.expectedVersion,revision:2,evidenceDigest:'b'.repeat(64)}}));
  expect(screen.getByRole('button',{name:'Đọc lại gói hiện hành'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Duyệt gói'})).toBeNull();
  expect(fetcher.mock.calls.filter(call=>(call as unknown as [string,RequestInit?])[1]?.method==='POST')).toHaveLength(0);
});
test('requires reason/options; uses exact reviewed version and applied follow-up link',async()=>{
  const d={...decision,kind:'user_decision' as const,options:['Sửa thiết kế','Giữ phạm vi']};const posts:unknown[]=[];
  vi.stubGlobal('fetch',async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){const body=JSON.parse(init.body as string);posts.push(body);return Response.json({apiVersion:1,projectId:'p',operationId:body.commandId,owner:'host_interaction',operationKind:'answer_decision',state:'applied',result:{kind:'interaction',runId:'run',currentRunId:'follow-up',continuedAsRunId:'follow-up'},updatedAt:new Date().toISOString()});}return Response.json({...run,decisions:[d],availableActions:[{...action,expectedVersion:d.expectedVersion}]});});api=new ApiClient();render(view(d));
  fireEvent.click(screen.getByRole('button',{name:'Xem xét gói'}));fireEvent.click(screen.getByRole('button',{name:'Yêu cầu sửa'}));expect(screen.getByRole('alert').textContent).toContain('lý do');
  fireEvent.change(screen.getByLabelText(/Lý do/),{target:{value:'Thiếu tiêu chí hiệu năng'}});fireEvent.click(screen.getByRole('button',{name:'Duyệt gói'}));expect(screen.getByRole('alert').textContent).toContain('phương án');
  fireEvent.change(screen.getByLabelText('Phương án'),{target:{value:'Sửa thiết kế'}});fireEvent.click(screen.getByRole('button',{name:'Yêu cầu sửa'}));
  await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0]).toMatchObject({kind:'answer_decision',outcome:'changes_requested',expectedVersion:d.expectedVersion,selectedOption:'Sửa thiết kế'});
});
test('expired and superseded reviews cannot be opened',()=>{installApi();api=new ApiClient();const result=render(view({...decision,expiresAt:'2000-01-01T00:00:00Z'}));expect((screen.getByRole('button',{name:'Xem xét gói'}) as HTMLButtonElement).disabled).toBe(true);result.rerender(view({...decision,status:'superseded'}));expect((screen.getByRole('button',{name:'Xem xét gói'}) as HTMLButtonElement).disabled).toBe(true);});

test('ordinary approval option metadata never forces or submits selectedOption',async()=>{
  const d={...decision,options:['Thông tin tham khảo']};const posts:any[]=[];vi.stubGlobal('fetch',async(_p:string,init?:RequestInit)=>{if(init?.method==='POST'){const command=JSON.parse(init.body as string);posts.push(command);return Response.json({apiVersion:1,projectId:'p',operationId:command.commandId,owner:'host_interaction',operationKind:'answer_decision',state:'accepted',updatedAt:new Date().toISOString()});}return Response.json({...run,decisions:[d],availableActions:[action]});});api=new ApiClient();render(view(d));
  fireEvent.click(screen.getByRole('button',{name:'Xem xét gói'}));fireEvent.click(screen.getByRole('button',{name:'Duyệt gói'}));await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0].selectedOption).toBeUndefined();
});
test('rejects a user decision with a reason without requiring an affirmative selection',async()=>{
  const d={...decision,kind:'user_decision' as const,options:['Phương án A']};const posts:any[]=[];vi.stubGlobal('fetch',async(_p:string,init?:RequestInit)=>{if(init?.method==='POST'){const command=JSON.parse(init.body as string);posts.push(command);return Response.json({apiVersion:1,projectId:'p',operationId:command.commandId,owner:'host_interaction',operationKind:'answer_decision',state:'accepted',updatedAt:new Date().toISOString()});}return Response.json({...run,decisions:[d],availableActions:[action]});});api=new ApiClient();render(view(d));
  fireEvent.click(screen.getByRole('button',{name:'Xem xét gói'}));fireEvent.change(screen.getByLabelText(/Lý do/),{target:{value:'Phạm vi không phù hợp'}});fireEvent.click(screen.getByRole('button',{name:'Từ chối'}));await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0]).toMatchObject({outcome:'rejected',reason:'Phạm vi không phù hợp'});expect(posts[0].selectedOption).toBeUndefined();
});
