import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  fireEvent.click(screen.getByRole('button',{name:'3D'}));
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
  fireEvent.click(screen.getByRole('button',{name:'3D'}));
  expect((screen.getByLabelText(/Lý do/) as HTMLTextAreaElement).value).toBe('Nháp trong bộ nhớ');
  expect(marker.isConnected).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Classic'}));
  expect((screen.getByLabelText(/Lý do/) as HTMLTextAreaElement).value).toBe('Nháp trong bộ nhớ');
});
test('classic mode renders no visual chrome',async()=>{
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
  expect(screen.queryByRole('button',{name:'3D'})).toBeNull();
});

test('Esc closes the panel after Overview was opened and then another route visited',async()=>{
  writeMode('visual');installApi({'/api/v1/projects/p/session':readySession});app('/projects/p');
  const user=userEvent.setup(),main=()=>document.getElementById('main')!;
  await user.click(await screen.findByRole('button',{name:'Tổng quan'}));
  await waitFor(()=>expect(document.activeElement).toBe(main()));
  await user.click(within(screen.getByRole('navigation',{name:'Điều hướng chính'})).getByRole('link',{name:'Công việc'}));
  await waitFor(()=>expect(main().classList.contains('hidden')).toBe(false));
  await user.keyboard('{Escape}');
  await waitFor(()=>expect(main().classList.contains('hidden')).toBe(true));
  expect(screen.queryByRole('heading',{name:/Tổng quan/})).toBeNull();
});
test('Esc closes the panel while focus is in the HUD, and the sidebar Tổng quan link opens the overview',async()=>{
  writeMode('visual');installApi({'/api/v1/projects/p/session':readySession});app('/projects/p/runs/run');
  const user=userEvent.setup(),main=()=>document.getElementById('main')!;
  await screen.findByRole('heading',{name:'Tìm sách nhanh hơn'});
  screen.getByRole('button',{name:'3D',pressed:true}).focus();
  await user.keyboard('{Escape}');
  await waitFor(()=>expect(main().classList.contains('hidden')).toBe(true));
  const nav=within(screen.getByRole('navigation',{name:'Điều hướng chính'}));
  await user.click(nav.getByRole('link',{name:'Công việc'}));
  await user.click(nav.getByRole('link',{name:'Tổng quan'}));
  expect(await screen.findByRole('heading',{name:/Tổng quan/})).toBeTruthy();expect(main().classList.contains('hidden')).toBe(false);
});
test('visual HUD is pinned outside the panel and holds exactly one operations dock',async()=>{
  writeMode('visual');let saved:any;const posts:any[]=[];
  installApi({'/api/v1/projects/p/session':readySession});
  const base=globalThis.fetch;
  vi.stubGlobal('fetch',async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){const c=JSON.parse(init.body as string);posts.push(c);saved={apiVersion:1,operationId:c.commandId,projectId:'p',owner:'host_interaction',operationKind:'create_request',state:'accepted',updatedAt:new Date().toISOString()};return Response.json(saved);}
    if(saved && /operations/.test(path))return Response.json(saved);return base(path,init);});
  app('/projects/p');
  fireEvent.click(await screen.findByRole('button',{name:'Tổng quan'}));
  for(const [label,value] of [['Tên công việc','Tìm sách'],['Mục tiêu','Tìm nhanh'],['Tiêu chí chấp nhận (mỗi dòng một tiêu chí)','Tìm theo tên'],['Ràng buộc (mỗi dòng một ràng buộc)','Không đổi API']])fireEvent.change(await screen.findByLabelText(label!),{target:{value}});
  fireEvent.click(screen.getByRole('button',{name:'Tạo công việc'}));await waitFor(()=>expect(posts).toHaveLength(1));
  fireEvent.click(await screen.findByRole('button',{name:/Thao tác đã gửi/}));
  const docks=await screen.findAllByRole('region',{name:'Theo dõi thao tác'});
  expect(docks).toHaveLength(1);
  const bar=screen.getByRole('region',{name:'Thanh điều khiển'}),main=document.getElementById('main')!;
  expect(bar.contains(docks[0]!)).toBe(true);expect(main.contains(docks[0]!)).toBe(false);expect(bar.contains(main)).toBe(false);
  expect(bar.className).toMatch(/\bfixed\b/);expect(bar.className).toMatch(/z-30/);expect(main.className).toMatch(/bottom-\[var\(--hud-h/);
});
