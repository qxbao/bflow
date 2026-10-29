// Local HTTP/browser queued/recovery coverage. No live provider/Herdr claim.
import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
let child:ChildProcess,pairing:string,repository:string;
test.beforeAll(async()=>{
 child=spawn(process.execPath,['--input-type=module'],{cwd:resolve('../cli'),env:{...process.env,W07_ASSETS:resolve('dist/client')},stdio:['pipe','pipe','pipe','ipc']});
 child.stdin!.end(await readFile('e2e/chat-host.mjs','utf8'));
 await new Promise<void>((accept,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Chat fixture startup timeout')),15000);
  child.on('message',(raw:any)=>{if(raw.ready){pairing=raw.pairing;repository=raw.repository;clearTimeout(timer);accept();}});
  child.once('exit',()=>{clearTimeout(timer);reject(new Error('Chat fixture exited before pairing'));});
 });
});
test.afterAll(async()=>{
 if(child?.connected)child.send!({kind:'close'});
 await new Promise<void>(accept=>{if(!child || child.exitCode!==null){accept();return;}const timer=setTimeout(()=>{child.kill();accept();},4000);child.once('exit',()=>{clearTimeout(timer);accept();});});
});
test('chat queued/lost ACK/restart reconcile by ID while direct approvals work independently',async({page,context})=>{
 test.setTimeout(60000);let seq=0;
 const command=(kind:string,body:Record<string,unknown>={})=>new Promise<any>((accept,reject)=>{const requestId=++seq;const timer=setTimeout(()=>{child.off('message',read);reject(new Error('Chat fixture IPC timeout'));},10000);const read=(raw:any)=>{if(raw.requestId===requestId){clearTimeout(timer);child.off('message',read);raw.error?reject(new Error(raw.error)):accept(raw.value);}};child.on('message',read);child.send!({kind,requestId,...body});});
 let posts=0;page.on('request',req=>{if(req.method()==='POST'&&new URL(req.url()).pathname.endsWith('/messages'))posts++;});
 await page.goto(pairing);await page.getByLabel('Đường dẫn Git tuyệt đối').fill(repository);await page.getByRole('button',{name:'Đăng ký dự án'}).click();await page.getByRole('link',{name:/books.*Xem dự án/}).click();await page.goto(page.url()+'/runs/run');
 const chat=page.getByRole('region',{name:'Trò chuyện cùng phiên'});await command('chat-busy',{busy:true});
 await page.route('**/messages',async route=>{if(route.request().method()==='POST'){await route.fetch();await route.abort();}else await route.continue();});
 await expect(chat.getByLabel('Tin nhắn cho Conversation')).toBeEnabled();await chat.getByLabel('Tin nhắn cho Conversation').fill('Giải thích công việc này');await chat.getByRole('button',{name:'Gửi tin nhắn'}).dblclick();
 await expect(chat.getByText(/Chưa xác định được kết quả gửi/)).toBeVisible();expect(posts).toBe(1);expect((await command('chat-inspect')).wires).toBe(0);
 await page.reload();await expect(chat.getByRole('button',{name:'Đối chiếu tin nhắn'})).toBeVisible();
 const other=await context.newPage();await other.goto(page.url());await expect(other.getByRole('button',{name:'Gửi tin nhắn'})).toBeDisabled();await other.close();
 await command('chat-restart');await chat.getByRole('button',{name:'Đối chiếu tin nhắn'}).click();await expect(chat.getByText(/Đã tìm thấy tin nhắn gốc/)).toBeVisible();expect(posts).toBe(1);
 await page.getByRole('button',{name:'Tên sách',exact:true}).click();await page.getByRole('button',{name:'Gửi câu trả lời'}).click();await page.getByRole('button',{name:'Xem xét gói'}).click();await page.getByRole('button',{name:'Duyệt gói'}).click();await expect(page.getByRole('button',{name:'Tiếp tục',exact:true})).toBeEnabled();
 await command('chat-busy',{busy:false});expect((await command('chat-inspect')).wires).toBe(1);await command('chat-restart');expect((await command('chat-inspect')).wires).toBe(1);
 await command('chat-echo');await chat.getByRole('button',{name:'Đọc lại lịch sử'}).click();await expect(chat.getByText('Đã chuyển',{exact:true})).toBeVisible();expect(posts).toBe(1);
 for(const width of [1440,1280,768]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await chat.scrollIntoViewIfNeeded();await page.screenshot({path:'dist/test-results/chat-send.png',fullPage:true});
});
