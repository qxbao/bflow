import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ApiClient } from '../src/api/client';
import { Operations } from '../src/features/operations';
import { DirectorProvider } from '../src/features/director/status';
import { DirectorLaunch } from '../src/features/director/launch';
import { directorServer, locks, sessionRead, view, at } from './director-fixtures';

// Only Date is faked (timers stay real): "now" is 10 s after the synthetic launch, inside the wait-for-Director window.
const launchedNow=Date.parse(at)+10_000;
beforeEach(()=>{vi.useFakeTimers({toFake:['Date'],now:launchedNow});localStorage.clear();vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('navigator',{onLine:true,locks,clipboard:{writeText:vi.fn(async()=>{})}});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
const manual="cd '/work/books' && claude '/bflow-start'";
const options={apiVersion:1,projectId:'p',terminal:{available:true},observedAt:at,providers:[
  {provider:'claude',state:'available',manualCommand:manual},
  {provider:'codex',state:'unavailable',reason:'Không tìm thấy codex trên PATH.',manualCommand:"cd '/work/books' && codex '/bflow-start'"},
  {provider:'agy',state:'unverified',manualCommand:"cd '/work/books' && agy '/bflow-start'"}]};
type Op={state:string;result?:unknown;error?:unknown};
function launchServer({heartbeat=at,presence='absent' as 'absent'|'active'|'waiting',launch=():Op|Error=>({state:'applied',result:{kind:'director_launch',provider:'claude',mode:'terminal_opened',manualCommand:manual,launchedAt:at}}),opts=():unknown=>options}={}){
  const calls={options:0,launches:[] as any[],reads:[] as string[]};let current:Op|undefined;let id='';
  const op=(value:Op)=>({apiVersion:1,operationId:id,projectId:'p',owner:'local_lifecycle',operationKind:'director_launch',updatedAt:at,...value});
  const server=directorServer({view:()=>view({presence,heartbeatAt:heartbeat}),extra:(path,init)=>{
    if(path==='/api/v1/projects/p/director/launch-options'){calls.options++;const value=opts();return value instanceof Response?value:Response.json(value);}
    if(path==='/api/v1/projects/p/director/launch'){const body=JSON.parse(String(init.body));calls.launches.push(body);id=body.operationId;const value=launch();if(value instanceof Error)throw value;current=value;return Response.json(op(value),{status:202});}
    if(path.includes('/operations/')){calls.reads.push(path);return Response.json(op(current??{state:'reconciliation_required',error:{apiVersion:1,code:'reconciliation_required',message:'x',retryable:false,correlationId:'c'}}));}
    return undefined;
  }});
  return {...server,calls,setPresence:(value:typeof presence,beat=heartbeat)=>{presence=value;heartbeat=beat;}};
}
function open(revision=0){const api=new ApiClient();return <MemoryRouter><Operations api={api} id="p" refresh={()=>{}} dock="external"><DirectorProvider api={api} projectId="p" session={sessionRead()} revision={revision} resetEpoch={0}><DirectorLaunch/></DirectorProvider></Operations></MemoryRouter>;}
const startButton=()=>screen.findByRole('button',{name:'Mở phiên Director'});

it('reads launch options only when the action is opened and offers a provider picker',async()=>{
  const {calls}=launchServer();render(open());
  fireEvent.click(await startButton());expect(calls.options).toBe(1);
  const group=await screen.findByRole('radiogroup',{name:'Nhà cung cấp cho Director'});
  const radios=within(group).getAllByRole<HTMLInputElement>('radio');expect(radios).toHaveLength(3);
  expect(radios[1]!.disabled).toBe(true);expect(screen.getByText('Không tìm thấy codex trên PATH.')).toBeTruthy();
  expect(screen.getByText(/Chưa xác minh/)).toBeTruthy();expect(radios[0]!.checked).toBe(true);
});
it('launches with the chosen provider, remembers only a UI preference and never equates terminal opened with ready',async()=>{
  const {calls,setPresence}=launchServer();const rendered=render(open());
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  fireEvent.click(screen.getByRole('button',{name:'Mở terminal Director'}));
  await waitFor(()=>expect(calls.launches).toHaveLength(1));
  expect(calls.launches[0]).toMatchObject({apiVersion:1,provider:'claude',replaceActive:false});
  expect(calls.launches[0].operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText(/Đã mở cửa sổ terminal/)).toBeTruthy();
  expect(screen.getByText(/chưa có nghĩa Director đã sẵn sàng/)).toBeTruthy();
  expect(localStorage.getItem('bflow:web:director-provider')).toBe('claude');
  expect(JSON.stringify(localStorage)).not.toContain('/work/books');
  // A heartbeat not strictly after launchedAt is not the new session.
  setPresence('active',at);rendered.rerender(open(1));
  expect(await screen.findByText(/chưa xác nhận đây là phiên mới/)).toBeTruthy();expect(screen.queryByText(/Director đã có mặt/)).toBeNull();
  setPresence('active','2026-11-04T00:00:05.000Z');rendered.rerender(open(2));
  expect(await screen.findByText(/Director đã có mặt/)).toBeTruthy();
});
it('shows the manual command with a copy confirmation',async()=>{
  launchServer({launch:()=>({state:'applied',result:{kind:'director_launch',provider:'claude',mode:'manual_command',manualCommand:manual,launchedAt:at}})});render(open());
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  fireEvent.click(screen.getByRole('button',{name:'Mở terminal Director'}));
  expect(await screen.findByText(/Không mở được terminal tự động/)).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button',{name:'Sao chép lệnh'})[0]!);
  expect(await screen.findByText('Đã sao chép lệnh.')).toBeTruthy();
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(manual);
});
it('an uncertain launch is observed only: retrying never posts a second launch',async()=>{
  const {calls}=launchServer({launch:()=>new TypeError('lost')});render(open());
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  fireEvent.click(screen.getByRole('button',{name:'Mở terminal Director'}));
  expect(await screen.findByText(/Không rõ cửa sổ terminal đã mở hay chưa/)).toBeTruthy();
  expect(calls.launches).toHaveLength(1);
  expect(screen.queryByRole('button',{name:'Mở terminal Director'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Đọc lại kết quả mở phiên'}));
  await waitFor(()=>expect(calls.reads.length).toBeGreaterThan(0));expect(calls.launches).toHaveLength(1);
  // Only an explicit, confirmed new intent after checking the screen releases the slot; it does not itself launch.
  const release=screen.getByRole<HTMLButtonElement>('button',{name:'Tôi đã kiểm tra màn hình, mở bằng thao tác mới'});
  await waitFor(()=>expect(release.disabled).toBe(false));fireEvent.click(release);
  expect(await screen.findByRole('button',{name:'Mở phiên Director'})).toBeTruthy();expect(calls.launches).toHaveLength(1);
});
it('requires an explicit replacement when Director may already be running',async()=>{
  const {calls}=launchServer({presence:'active'});render(open());
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  const submit=screen.getByRole<HTMLButtonElement>('button',{name:'Mở terminal Director'});expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/Mở phiên thay thế/));expect(submit.disabled).toBe(false);
  fireEvent.click(submit);await waitFor(()=>expect(calls.launches).toHaveLength(1));expect(calls.launches[0].replaceActive).toBe(true);
});
it('a stopped view followed by a failed refresh requires explicit replacement and lets the owner confirm it',async()=>{
  let fail=false;
  directorServer({view:()=>fail?Response.json({apiVersion:1,code:'unavailable',message:'probe failed',retryable:true,correlationId:'t'},{status:503}):view({layout:'not_started',sessionId:undefined}),extra:path=>path.endsWith('/launch-options')?options:undefined});
  const rendered=render(open());
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  expect(screen.queryByLabelText(/Mở phiên thay thế/)).toBeNull();
  fail=true;rendered.rerender(open(1));
  const confirm=await screen.findByLabelText(/Mở phiên thay thế/);
  const submit=screen.getByRole<HTMLButtonElement>('button',{name:'Mở terminal Director'});
  expect(submit.disabled).toBe(true);
  fireEvent.click(confirm);expect(submit.disabled).toBe(false);
});
it('a launch refused before any effect shows the failure and allows a new attempt',async()=>{
  launchServer({launch:()=>({state:'failed',error:{apiVersion:1,code:'operation_not_allowed',message:'Kho mã chưa có skill /bflow-start.',retryable:false,correlationId:'c'}})});render(open());
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  fireEvent.click(screen.getByRole('button',{name:'Mở terminal Director'}));
  expect(await screen.findByText(/Kho mã chưa có skill \/bflow-start/)).toBeTruthy();
  expect(await screen.findByRole('button',{name:'Mở phiên Director'})).toBeTruthy();
});
it('launch-options failure is reported without opening a picker or a launch',async()=>{
  const {calls}=launchServer({opts:()=>Response.json({apiVersion:1,code:'operation_not_allowed',message:'no port',retryable:false,correlationId:'c'},{status:422})});render(open());
  fireEvent.click(await startButton());
  expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByRole('radiogroup')).toBeNull();expect(calls.launches).toHaveLength(0);
});
it('the remembered provider is preselected when it is still offered',async()=>{
  localStorage.setItem('bflow:web:director-provider','agy');launchServer();render(open());
  fireEvent.click(await startButton());
  const radios=within(await screen.findByRole('radiogroup')).getAllByRole<HTMLInputElement>('radio');expect(radios[2]!.checked).toBe(true);
});
it('Escape closes the picker and returns focus to the launch button',async()=>{
  launchServer();render(open());
  const button=await startButton();fireEvent.click(button);
  const group=await screen.findByRole('radiogroup');expect(button.getAttribute('aria-expanded')).toBe('true');
  fireEvent.keyDown(within(group).getAllByRole('radio')[0]!,{key:'Escape'});
  await waitFor(()=>expect(screen.queryByRole('radiogroup')).toBeNull());
  await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole('button',{name:'Mở phiên Director'})));
});
it('keeps unsettled launch progress in a status region and never animates it',async()=>{
  const {calls}=launchServer({launch:()=>({state:'accepted'})});render(open());
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  fireEvent.click(screen.getByRole('button',{name:'Mở terminal Director'}));
  expect((await screen.findByText('Đang mở terminal Director…')).getAttribute('role')).toBe('status');
  expect(calls.launches).toHaveLength(1);expect(document.querySelector('[class*="animate-"]')).toBeNull();
});
it('a replacement launch never claims the already-present Director as the new session',async()=>{
  const {calls,setPresence}=launchServer({presence:'active'});const rendered=render(open());
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  fireEvent.click(screen.getByLabelText(/Mở phiên thay thế/));fireEvent.click(screen.getByRole('button',{name:'Mở terminal Director'}));
  await waitFor(()=>expect(calls.launches).toHaveLength(1));
  setPresence('active','2026-11-04T00:10:00.000Z');rendered.rerender(open(1));
  expect(await screen.findByText(/chưa xác nhận đây là phiên mới/)).toBeTruthy();expect(screen.queryByText(/Director đã có mặt/)).toBeNull();
});
it('presence without a heartbeat is not treated as arrival',async()=>{
  const {setPresence}=launchServer();const rendered=render(open());
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  fireEvent.click(screen.getByRole('button',{name:'Mở terminal Director'}));
  await screen.findByText(/Đã mở cửa sổ terminal/);
  setPresence('waiting','');rendered.rerender(open(1));
  expect(await screen.findByText(/chưa xác nhận đây là phiên mới/)).toBeTruthy();expect(screen.queryByText(/Director đã có mặt/)).toBeNull();
});
it('while waiting for the Director a launch just opened, another launch requires an explicit replacement',async()=>{
  const {calls}=launchServer();render(open());
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  fireEvent.click(screen.getByRole('button',{name:'Mở terminal Director'}));
  expect(await screen.findByText(/hãy đợi trạng thái/)).toBeTruthy();
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  const submit=screen.getByRole<HTMLButtonElement>('button',{name:'Mở terminal Director'});expect(submit.disabled).toBe(true);
  expect(screen.getByLabelText(/Mở phiên thay thế\. Cửa sổ terminal Director mở lúc/)).toBeTruthy();
  fireEvent.click(submit);expect(calls.launches).toHaveLength(1);
  fireEvent.click(screen.getByLabelText(/Mở phiên thay thế/));expect(submit.disabled).toBe(false);
  fireEvent.click(submit);await waitFor(()=>expect(calls.launches).toHaveLength(2));expect(calls.launches[1].replaceActive).toBe(true);
});
it('after the wait window an applied launch without a registered Director stops saying "please wait"',async()=>{
  launchServer();const rendered=render(open());
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  fireEvent.click(screen.getByRole('button',{name:'Mở terminal Director'}));
  expect(await screen.findByText(/hãy đợi trạng thái/)).toBeTruthy();
  vi.setSystemTime(Date.parse(at)+3*60*1000+1000);rendered.rerender(open(1));
  expect(await screen.findByText(/Không thấy Director đăng ký sau khi mở cửa sổ; kiểm tra cửa sổ terminal hoặc mở lại\./)).toBeTruthy();
  expect(screen.queryByText(/hãy đợi trạng thái/)).toBeNull();
  // Past the window the replacement prompt is no longer forced while Director is confirmed absent.
  fireEvent.click(await startButton());await screen.findByRole('radiogroup');
  expect(screen.queryByLabelText(/Mở phiên thay thế/)).toBeNull();
});

it('submits and remembers the selected ai-isolator profile without showing a native command preview',async()=>{
 const {calls}=launchServer({opts:()=>({...options,providers:options.providers.map(p=>p.provider==='claude'?{...p,profiles:[{name:'personal',state:'available'},{name:'blocked',state:'unavailable',reason:'Backend chưa sẵn sàng'}]}:p)}),
  launch:()=>({state:'applied',result:{kind:'director_launch',provider:'claude',profileName:'personal',mode:'terminal_opened',manualCommand:'ai-isolator run claude --name personal -- /bflow-start',launchedAt:at}})});
 render(open());fireEvent.click(await startButton());
 const profile=await screen.findByRole('combobox',{name:'Profile ai-isolator'});
 fireEvent.change(profile,{target:{value:'personal'}});
 expect(screen.queryByText('Lệnh tự chạy cho Claude Code')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Mở terminal Director'}));
 await waitFor(()=>expect(calls.launches).toHaveLength(1));
 expect(calls.launches[0]).toMatchObject({provider:'claude',profileName:'personal'});
 expect(localStorage.getItem('bflow:web:director-profile:claude')).toBe('personal');
 expect(await screen.findByText(/Profile Director: personal/)).toBeTruthy();
});
it('does not silently fall back to native when a remembered profile is no longer offered',async()=>{
 localStorage.setItem('bflow:web:director-profile:claude','removed');launchServer();render(open());fireEvent.click(await startButton());
 await screen.findByRole('combobox',{name:'Profile ai-isolator'});
 expect(screen.getByRole<HTMLButtonElement>('button',{name:'Mở terminal Director'}).disabled).toBe(true);
 expect(screen.getByText(/Profile đã chọn không còn sẵn sàng/)).toBeTruthy();
});
