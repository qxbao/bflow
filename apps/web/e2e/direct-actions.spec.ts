import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
let child:ChildProcess,pairing:string,repository:string,seq=0;
const waiting=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function host(kind:string,values:Record<string,unknown>={}):Promise<any>{return new Promise((resolve,reject)=>{const requestId=++seq,timer=setTimeout(()=>{waiting.delete(requestId);reject(new Error('Fixture IPC timeout'));},10000);waiting.set(requestId,{resolve,reject,timer});child.send!({kind,requestId,...values});});}
test.beforeAll(async()=>{
  // CLI is the approved application composition root with a declared server dependency.
  child=spawn(process.execPath,['--input-type=module'],{cwd:resolve('../cli'),env:{...process.env,W07_ASSETS:resolve('dist/client')},stdio:['pipe','pipe','pipe','ipc']});
  child.stdin!.end(await readFile('e2e/direct-actions-host.mjs','utf8'));
  await new Promise<void>((accept,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture did not start')),15000);child.on('message',(raw:any)=>{if(raw.ready){pairing=raw.pairing;repository=raw.repository;clearTimeout(timer);accept();}else{const pending=waiting.get(raw.requestId);if(pending){clearTimeout(pending.timer);waiting.delete(raw.requestId);raw.error?pending.reject(new Error(raw.error)):pending.resolve(raw.value);}}});child.stderr!.on('data',()=>{});child.once('exit',code=>{if(code){clearTimeout(timer);reject(new Error('Fixture exited'));}});});
});
test.afterAll(async()=>{if(child?.connected)child.send!({kind:'close'});await new Promise<void>(accept=>{if(child?.exitCode!==null){accept();return;}child.once('exit',()=>accept());setTimeout(()=>{child.kill();accept();},4000);});});
test('structured create, clarify, stale review, changes, resume/cancel and lost ACK use server state and one effect per intent',async({page,context})=>{
  test.setTimeout(90000);
  await page.goto(pairing);await page.getByLabel('Đường dẫn Git tuyệt đối').fill(repository);await page.getByRole('button',{name:'Đăng ký dự án'}).click();await page.getByRole('link',{name:/books.*Xem dự án/}).click();
  await page.getByLabel('Tên công việc').fill('Tìm sách nhanh');await page.getByLabel('Mục tiêu',{exact:true}).fill('Tìm sách theo tên và tác giả');await page.getByLabel('Tiêu chí chấp nhận (mỗi dòng một tiêu chí)').fill('Tìm được tên sách\nTìm được tác giả');await page.getByLabel('Ràng buộc (mỗi dòng một ràng buộc)').fill('Giữ tương thích');
  await host('configure',{delay:2000});await page.getByRole('button',{name:'Tạo công việc',exact:true}).dblclick();
  await expect.poll(async()=>(await host('inspect')).effects.filter((k:string)=>k==='create_request').length).toBe(1);
  await context.setOffline(true);await page.waitForTimeout(300);await context.setOffline(false);await page.reload();
  await expect(page.getByLabel('Tên công việc')).toHaveValue('Tìm sách nhanh');
  await page.getByRole('button',{name:'Tạo công việc',exact:true}).click();
  expect((await host('inspect')).effects.filter((k:string)=>k==='create_request')).toHaveLength(1);
  await page.getByRole('button',{name:'Tên và tác giả',exact:true}).click();await page.getByRole('button',{name:'Gửi câu trả lời'}).click();
  await expect.poll(async()=>(await host('inspect')).commands.filter((command:any)=>command.kind==='answer_clarification' && command.intakeId==='intake').length).toBe(1);
  const base=new URL(page.url()).pathname;await page.goto(new URL(base+'/runs/run',page.url()).href);
  await page.getByRole('button',{name:'Tên sách',exact:true}).click();await page.getByRole('button',{name:'Gửi câu trả lời'}).click();
  await expect.poll(async()=>(await host('inspect')).phase).toBe('reviewing');
  await page.getByRole('button',{name:'Xem xét gói'}).click();await host('configure',{revision:2});
  await expect(page.getByRole('button',{name:'Đọc lại gói hiện hành'})).toBeVisible();
  expect((await host('inspect')).effects.filter((k:string)=>k==='answer_decision')).toHaveLength(0);
  await page.getByRole('button',{name:'Đọc lại gói hiện hành'}).click();await page.getByRole('button',{name:'Xem xét gói'}).click();
  const other=await context.newPage();await other.goto(page.url());await other.getByRole('button',{name:'Xem xét gói'}).click();
  try{await expect(page.getByRole('button',{name:'Duyệt gói'}),'first tab review').toBeEnabled();await expect(other.getByRole('button',{name:'Duyệt gói'}),'second tab review').toBeEnabled();}catch(error){await test.info().attach('review-tabs',{body:JSON.stringify(await Promise.all([page,other].map(async tab=>({url:tab.url(),text:await tab.getByRole('main').innerText()})))),contentType:'application/json'});throw error;}
  await Promise.all([page,other].map(tab=>tab.getByRole('button',{name:'Duyệt gói'}).evaluate((button:HTMLButtonElement)=>button.click())));
  await expect.poll(async()=>(await host('inspect')).phase).toBe('blocked');await other.close();await expect(page.getByRole('button',{name:'Tiếp tục',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Tiếp tục',exact:true}).click();
  await expect.poll(async()=>(await host('inspect')).phase).toBe('implementing');
  await page.getByRole('button',{name:'Hủy công việc',exact:true}).click();await page.getByLabel('Lý do hủy').fill('Thay đổi ưu tiên');await page.getByRole('button',{name:'Gửi yêu cầu hủy'}).click();
  await expect.poll(async()=>(await host('inspect')).effects.filter((k:string)=>k==='cancel').length).toBe(1);
  await expect(page.getByText('Yêu cầu hủy chưa xác nhận tiến trình đã dừng.')).toBeVisible();expect((await host('inspect')).cancelled).toBe(false);
  // Restart the real HTTP server; re-pair and observe the same original operation ID.
  const before=await host('inspect');const repair=await host('restart');await page.goto(repair);await expect(page.getByRole('link',{name:/books.*Xem dự án/})).toBeVisible();await page.goto(new URL(base+'/runs/run',repair).href);
  await expect(page.getByText('Yêu cầu hủy chưa xác nhận tiến trình đã dừng.')).toBeVisible();
  await host('configure',{cancelled:true});await expect(page.getByText('Yêu cầu hủy đã áp dụng; chỉ trạng thái công việc mới xác nhận đã hủy.')).toBeVisible({timeout:10000});
  const after=await host('inspect');expect(after.operationCount).toBe(before.operationCount);expect(after.commands.map((c:any)=>c.commandId)).toEqual(before.commands.map((c:any)=>c.commandId));
  expect(after.effects).toEqual(['create_request','answer_clarification','answer_clarification','answer_decision','resume','cancel']);expect(after.commands[3].expectedVersion.revision).toBe(2);expect(after.commands[4]).toMatchObject({kind:'resume',actionId:'resume-exact',expectedVersion:{revisionToken:'v2'}});
  expect(after.commands[0].acceptanceCriteria).toHaveLength(2);expect(after.commands[0].constraints).toEqual(['Giữ tương thích']);
  await host('configure',{phase:'reviewing',revision:3,cancelled:false});
  await page.getByRole('button',{name:'Bắt đầu thao tác mới: Quyết định gói',exact:true}).click();
  await page.getByRole('button',{name:'Xem xét gói'}).click();await page.getByLabel(/Lý do \(bắt buộc/).fill('Bổ sung tiêu chí hiệu năng');await page.getByRole('button',{name:'Yêu cầu sửa',exact:true}).click();
  await expect.poll(async()=>(await host('inspect')).currentRunId).toBe('follow-up');
  await expect(page.getByRole('link',{name:'Mở công việc hiện hành →'}).first()).toBeVisible();
  await page.getByRole('link',{name:'Mở công việc hiện hành →'}).last().click();await expect(page).toHaveURL(/runs\/follow-up$/);
  expect((await host('inspect')).effects.filter((kind:string)=>kind==='answer_decision')).toHaveLength(2);
  await page.getByRole('link',{name:'Tổng quan',exact:true}).click();await page.getByRole('button',{name:'Dừng phiên',exact:true}).click();await page.getByRole('button',{name:'Gửi yêu cầu dừng phiên'}).click();await expect.poll(async()=>(await host('inspect')).ready).toBe(false);
  await page.getByRole('button',{name:'Khởi động phiên',exact:true}).click();await expect.poll(async()=>(await host('inspect')).ready).toBe(true);expect((await host('inspect')).lifecycleCalls).toEqual(['stop','start']);
  for(const width of [1440,1280,768]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`dist/test-results/w07-${width}.png`,fullPage:true});}
});
