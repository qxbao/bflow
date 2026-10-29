// Local HTTP/browser capability-unavailable coverage. No live provider/Herdr claim.
import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
let child:ChildProcess,pairing:string,repository:string;
test.beforeAll(async()=>{
 child=spawn(process.execPath,['--input-type=module'],{cwd:resolve('../cli'),env:{...process.env,W07_ASSETS:resolve('dist/client')},stdio:['pipe','pipe','pipe','ipc']});
 child.stdin!.end(await readFile('e2e/direct-actions-host.mjs','utf8'));
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
test('unavailable chat cannot submit or retry and direct decision remains usable',async({page})=>{
 const posts:string[]=[];page.on('request',request=>{if(request.method()==='POST')posts.push(new URL(request.url()).pathname);});
 await page.goto(pairing);await page.getByLabel('Đường dẫn Git tuyệt đối').fill(repository);await page.getByRole('button',{name:'Đăng ký dự án'}).click();
 await page.getByRole('link',{name:/books.*Xem dự án/}).click();
 await page.goto(page.url()+'/runs/run');
 const chat=page.getByRole('region',{name:'Trò chuyện cùng phiên'});
 await expect(chat.getByRole('alert')).toBeVisible();await expect(chat.getByRole('button',{name:'Gửi tin nhắn'})).toBeDisabled();
 await expect(chat.getByText(/Trò chuyện qua web chưa sẵn sàng/)).toBeVisible();
 await chat.getByRole('button',{name:'Đọc lại lịch sử'}).click();await expect(chat.getByRole('alert')).toBeVisible();
 await page.getByRole('button',{name:'Tên sách',exact:true}).click();await page.getByRole('button',{name:'Gửi câu trả lời'}).click();
 await page.getByRole('button',{name:'Xem xét gói'}).click();await expect(page.getByRole('button',{name:'Duyệt gói'})).toBeEnabled();
 await page.getByRole('button',{name:'Duyệt gói'}).click();await expect(page.getByRole('button',{name:'Tiếp tục',exact:true})).toBeEnabled();
 expect(posts.filter(path=>path.endsWith('/messages'))).toHaveLength(0);
 await page.reload();await expect(chat.getByRole('button',{name:'Gửi tin nhắn'})).toBeDisabled();
 for(const width of [1440,1280,768]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await chat.scrollIntoViewIfNeeded();await page.screenshot({path:'dist/test-results/chat-unavailable.png',fullPage:true});
});
