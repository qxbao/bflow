import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { App } from '../src/app';
import { ApiClient } from '../src/api/client';
import { CommandStore } from '../src/api/commands';
import { MODE_KEY, readMode, writeMode } from '../src/features/office/mode';
import { decision,installApi,run,session } from './fixtures';
const action={actionId:'decide',kind:'answer_decision' as const,enabled:true,expectedVersion:decision.expectedVersion};
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('navigator',{onLine:true,locks:{request:async(_key:string,callback:()=>unknown)=>callback()}});localStorage.clear();sessionStorage.clear();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();sessionStorage.clear();});
function app(path:string){return render(<MemoryRouter initialEntries={[path]}><App api={new ApiClient()}/></MemoryRouter>);}
const readySession={...session,state:'ready',sessionId:'host-session'};

test('defaults to classic when storage throws',()=>{
  vi.stubGlobal('localStorage',{getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}});
  expect(readMode()).toBe('classic');expect(()=>writeMode('visual')).not.toThrow();
});
test('mode key does not break CommandStore.records',()=>{
  writeMode('visual');expect(localStorage.getItem('bflow:ui:mode')).toBe('visual');expect(MODE_KEY).toBe('bflow:ui:mode');
  const store=new CommandStore(new ApiClient(),'p','unpaired',()=>{});
  expect(()=>store.records()).not.toThrow();expect(store.records()).toEqual([]);
});
test('mode switch preserves request draft',async()=>{
  installApi({'/api/v1/projects/p/session':readySession});app('/projects/p');
  const field=await screen.findByLabelText('Tên công việc');fireEvent.change(field,{target:{value:'Nháp giữ lại'}});
  fireEvent.click(screen.getByRole('button',{name:'Trực quan'}));
  // Overview is closed in visual mode; reopening it from the HUD restores the form from its session draft.
  fireEvent.click(await screen.findByRole('button',{name:'Tổng quan'}));
  expect((await screen.findByLabelText('Tên công việc') as HTMLInputElement).value).toBe('Nháp giữ lại');
  expect(localStorage.getItem(MODE_KEY)).toBe('visual');
});
test('mode switch preserves in-memory decision draft',async()=>{
  installApi({'/api/v1/projects/p/session':readySession,'/api/v1/projects/p/runs/run':{...run,availableActions:[action]}});app('/projects/p/runs/run');
  fireEvent.click(await screen.findByRole('button',{name:'Xem xét gói'}));
  fireEvent.change(screen.getByLabelText(/Lý do/),{target:{value:'Nháp trong bộ nhớ'}});
  const marker=document.getElementById('main')!.querySelector('h1,h2')!;
  fireEvent.click(screen.getByRole('button',{name:'Trực quan'}));
  expect((screen.getByLabelText(/Lý do/) as HTMLTextAreaElement).value).toBe('Nháp trong bộ nhớ');
  expect(marker.isConnected).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Cổ điển'}));
  expect((screen.getByLabelText(/Lý do/) as HTMLTextAreaElement).value).toBe('Nháp trong bộ nhớ');
});
test('classic mode keeps one operations dock and no visual chrome',async()=>{
  installApi({'/api/v1/projects/p/session':readySession});app('/projects/p/runs/run');
  await screen.findByRole('heading',{name:'Tìm sách nhanh hơn'});
  expect(screen.queryByRole('region',{name:'Văn phòng'})).toBeNull();expect(screen.queryByRole('button',{name:'Đóng bảng'})).toBeNull();
});
test('deep link /runs/:id opens overlay in visual mode',async()=>{
  writeMode('visual');installApi({'/api/v1/projects/p/session':readySession});app('/projects/p/runs/run');
  expect(await screen.findByRole('heading',{name:'Tìm sách nhanh hơn'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Đóng bảng'})).toBeTruthy();expect(screen.getByRole('region',{name:'Văn phòng'})).toBeTruthy();
  expect(document.getElementById('main')!.classList.contains('hidden')).toBe(false);
});
test('index path keeps the panel closed until Tổng quan opens it',async()=>{
  writeMode('visual');installApi({'/api/v1/projects/p/session':readySession});app('/projects/p');
  const overview=await screen.findByRole('button',{name:'Tổng quan'});
  expect(document.getElementById('main')!.classList.contains('hidden')).toBe(true);
  fireEvent.click(overview);expect(document.getElementById('main')!.classList.contains('hidden')).toBe(false);
  expect(await screen.findByRole('heading',{name:/Tổng quan/})).toBeTruthy();
});
test('Esc closes overlay and restores focus',async()=>{
  writeMode('visual');installApi({'/api/v1/projects/p/session':readySession});app('/projects/p');
  const user=userEvent.setup();
  const link=await screen.findByRole('link',{name:'Công việc'});
  link.focus();await user.click(link);
  const main=document.getElementById('main')!;
  await waitFor(()=>expect(document.activeElement).toBe(main));
  await user.keyboard('{Escape}');
  await waitFor(()=>expect(main.classList.contains('hidden')).toBe(true));
  await waitFor(()=>expect(document.activeElement).toBe(link));
});
test('page / is identical in both modes and offers no mode switch',async()=>{
  installApi();app('/');await screen.findByRole('button',{name:'Đăng ký dự án'});
  expect(screen.queryByRole('button',{name:'Trực quan'})).toBeNull();
});
