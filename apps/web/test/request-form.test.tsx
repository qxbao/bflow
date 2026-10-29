import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/app';
import { ApiClient } from '../src/api/client';
import { RequestForm } from '../src/features/requests';
import { Operations } from '../src/features/operations';
import { installApi,session } from './fixtures';
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();sessionStorage.clear();});
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('navigator',{onLine:true,locks:{request:async(_key:string,callback:()=>unknown)=>callback()}});});
test('offers a structured request form from project overview',async()=>{
  installApi();render(<MemoryRouter initialEntries={['/projects/p']}><App api={new ApiClient()}/></MemoryRouter>);
  expect(await screen.findByRole('button',{name:'Tạo công việc'})).toBeTruthy();
});
function form(api:ApiClient,id='p'){return <MemoryRouter><Operations api={api} id={id} refresh={()=>{}}><RequestForm api={api} id={id} sessionId="host" enabled/></Operations></MemoryRouter>;}
test('invalid fields have focused summary and inline errors; project-scoped drafts survive return',async()=>{
  installApi();const api=new ApiClient();const view=render(form(api));fireEvent.click(screen.getByRole('button',{name:'Tạo công việc'}));
  await waitFor(()=>expect(document.activeElement?.getAttribute('role')).toBe('alert'));
  expect(screen.getByLabelText('Mục tiêu',{exact:true}).getAttribute('aria-invalid')).toBe('true');
  fireEvent.change(screen.getByLabelText('Tên công việc'),{target:{value:'Giữ bản nháp'}});view.unmount();
  const back=render(form(api));expect((screen.getByLabelText('Tên công việc') as HTMLInputElement).value).toBe('Giữ bản nháp');back.unmount();
  render(form(api,'q'));expect((screen.getByLabelText('Tên công việc') as HTMLInputElement).value).toBe('');
});
test('submits criteria/constraints and back/resubmit observes the same ID',async()=>{
  const bodies:any[]=[];let saved:any;
  vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(path.endsWith('/session'))return Response.json({...session,state:'ready'});if(init?.method==='POST'){const command=JSON.parse(init.body as string);bodies.push(command);saved={apiVersion:1,operationId:command.commandId,projectId:'p',owner:'host_interaction',operationKind:'create_request',state:'applied',result:{kind:'intake',intakeId:'intake'},updatedAt:new Date().toISOString()};}return Response.json(saved);});
  const api=new ApiClient(),view=render(form(api));
  for(const [label,value] of [['Tên công việc','Tìm sách'],['Mục tiêu','Tìm nhanh'],['Tiêu chí chấp nhận (mỗi dòng một tiêu chí)','Tìm theo tên\nTìm theo tác giả'],['Ràng buộc (mỗi dòng một ràng buộc)','Không đổi API']])fireEvent.change(screen.getByLabelText(label!),{target:{value}});
  fireEvent.click(screen.getByRole('button',{name:'Tạo công việc'}));await waitFor(()=>expect(bodies).toHaveLength(1));view.unmount();render(form(api));fireEvent.click(screen.getByRole('button',{name:'Tạo công việc'}));await screen.findByText(/Đã gửi hoặc đang đối chiếu/);
  expect(bodies).toHaveLength(1);expect(bodies[0].acceptanceCriteria).toEqual([{description:'Tìm theo tên',verificationMethod:'integration_test'},{description:'Tìm theo tác giả',verificationMethod:'integration_test'}]);expect(bodies[0].constraints).toEqual(['Không đổi API']);
});
