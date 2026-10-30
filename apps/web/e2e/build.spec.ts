import { expect, test } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// Actual built CLI/Local Server, isolated registry and Git repository; no fake HTTP APIs.
let child:ChildProcess, scratch:string, pairing:string, repository:string;
test.beforeAll(async()=>{
  scratch=await mkdtemp(join(tmpdir(),'bflow-web-w06-'));repository=join(scratch,'sach');
  await mkdir(repository);execFileSync('git',['init','--quiet',repository]);
  execFileSync('git',['-C',repository,'config','user.name','Web settings test']);
  execFileSync('git',['-C',repository,'config','user.email','web-settings@localhost']);
  const binary=resolve('../cli/dist/bin.js');
  const quote=(text:string)=>"'"+text.replaceAll("'","'\\''")+"'";
  child=spawn('script',['-q','-c',`${quote(process.execPath)} ${quote(binary)} web --port 4318 --no-open`,'/dev/null'],{
    env:{...process.env,BFLOW_HOME:join(scratch,'home')},stdio:['pipe','pipe','pipe'],detached:true,
  });
  pairing=await new Promise<string>((accept,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Local web fixture did not start')),15000);
    let buffer='';child.stdout!.on('data',data=>{buffer=(buffer+String(data)).slice(-8192);const match=buffer.match(/http:\/\/127\.0\.0\.1:4318\/#bootstrap=[A-Za-z0-9_%+.-]+/);if(match){clearTimeout(timer);accept(match[0]);}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Local web fixture exited before pairing'));});
  });
});
test.afterAll(async()=>{
  if(child?.pid){process.kill(-child.pid,'SIGINT');await new Promise<void>(accept=>{child.once('exit',()=>accept());setTimeout(()=>{try{process.kill(-child.pid!,'SIGTERM');}catch{}accept();},3000);});}
  if(scratch)await rm(scratch,{recursive:true,force:true});
});
test('pairs with actual HTTP, registers a real Git root, reloads deep links and preserves accessible layouts',async({page})=>{
  test.setTimeout(90000); // Includes two durable init jobs, config commit and responsive screenshots.
  let feeds=0;page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/events'))feeds++;});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(pairing);
  await expect(page.getByRole('heading',{name:'Chưa có dự án'})).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByLabel('Đường dẫn Git tuyệt đối').fill(repository);
  await page.getByRole('button',{name:'Đăng ký dự án'}).click();
  await page.getByRole('link',{name:/sach.*Xem dự án/}).click();
  await expect(page.getByText('Phiên: Chưa sẵn sàng')).toBeVisible();
  await expect(page.getByRole('link',{name:'Kiểm tra điều kiện dự án →'})).toBeVisible();
  await expect.poll(()=>feeds,{timeout:12000}).toBeGreaterThanOrEqual(2);
  await page.getByRole('link',{name:'Công việc',exact:true}).click();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Công việc',exact:true})).toBeVisible();
  // Missing host is surfaced honestly; no host is started by these reads.
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('link',{name:'Tổng quan',exact:true}).click();
  for(const width of [1440,1280,768]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  if(await page.getByRole('button',{name:'Điều hướng',exact:true}).isVisible())await page.getByRole('button',{name:'Điều hướng',exact:true}).click();
  await page.getByRole('link',{name:'Quản lý dự án'}).click();
  for(const width of [1440,1280,768,375]){
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:`dist/test-results/projects-${width}.png`,fullPage:true});
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.keyboard.press('Tab');
  expect(await page.evaluate(()=>{const target=document.activeElement;return target?getComputedStyle(target).outlineStyle!== 'none':false;})).toBe(true);
  expect(await page.evaluate(()=>localStorage.length)).toBe(0);
  expect(await page.evaluate(()=>document.fonts.check('900 40px "Big Shoulders Display"'))).toBe(true);
  // Repository settings use the real CLI composition and filesystem (no host/model fixture).
  await page.getByRole('link',{name:/sach.*Xem dự án/}).click();
  if(await page.getByRole('button',{name:'Điều hướng',exact:true}).isVisible())await page.getByRole('button',{name:'Điều hướng',exact:true}).click();
  await page.getByRole('link',{name:'Cài đặt dự án',exact:true}).click();
  await page.getByLabel('Khởi tạo không dùng GitNexus (tắt công cụ này trong cấu hình)').check();
  await page.getByRole('button',{name:'Khởi tạo / sửa GitNexus',exact:true}).click();
  await expect(page.getByText('Đã hoàn tất',{exact:true})).toBeVisible({timeout:30000});
  await page.getByRole('textbox',{name:'Model (conversation)',exact:true}).fill('haiku');
  await page.getByRole('button',{name:'Lưu cấu hình',exact:true}).click();
  await expect(page.getByText('Đã lưu cấu hình. Các thay đổi áp dụng khi khởi động lại phiên.')).toBeVisible();
  await page.getByLabel(/Commit cấu hình đã xem vào Git/).check();
  await page.getByRole('button',{name:'Khởi tạo / sửa GitNexus',exact:true}).click();
  await expect(page.getByText('Đã hoàn tất',{exact:true})).toBeVisible({timeout:30000});
  expect(execFileSync('git',['-C',repository,'show','--pretty=format:','--name-only','HEAD'],{encoding:'utf8'}).trim().split('\n').sort()).toEqual(['.bflow/.gitignore','.bflow/config.yml']);
  await page.getByRole('button',{name:'YAML đầy đủ',exact:true}).click();
  expect(await page.getByLabel('Nội dung YAML đầy đủ').evaluate(node=>getComputedStyle(node).fontSize)).toBe('16px');
  await page.getByLabel('Nội dung YAML đầy đủ').fill('schemaVersion: "1"\n');
  await page.getByRole('button',{name:'Lưu cấu hình',exact:true}).click();
  await expect(page.locator('#settings-configuration').getByRole('alert')).toContainText('missing required');
  await page.getByRole('button',{name:'Bỏ thay đổi',exact:true}).click();
  await page.getByRole('button',{name:'Form cấu hình',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Model (conversation)',exact:true})).toHaveValue('haiku');
  await page.getByRole('button',{name:'Hủy đăng ký dự án',exact:true}).click();
  await page.getByRole('button',{name:'Xác nhận hủy đăng ký',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Chưa có dự án',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});
