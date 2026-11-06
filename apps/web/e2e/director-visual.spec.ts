// Task 9 local UI evidence: the built Web against the actual Local Server with a scripted Director backend (director-visual-host.mjs),
// in a fresh Playwright browser context (private profile). Not live provider, Herdr or Runtime evidence.
import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { browserOptions, enterVisual, mirror, openProject, sceneReady } from './office-fixture';
test.use({ ...browserOptions(), viewport: { width: 1440, height: 900 } });
expect.configure({ timeout: 15000 });
test.describe.configure({ mode: 'serial' });
const evidence = process.env.T9_EVIDENCE ?? resolve('dist/test-results/task9');
let child: ChildProcess, pairing: string, repository: string, seq = 0;
const call = (kind: string, values: Record<string, unknown> = {}) => new Promise<any>((accept, reject) => {
  const requestId = ++seq, timer = setTimeout(() => reject(new Error('Fixture IPC timeout')), 10000);
  const read = (raw: any) => { if (raw.requestId !== requestId) return; clearTimeout(timer); child.off('message', read); raw.error ? reject(new Error(raw.error)) : accept(raw.value); };
  child.on('message', read); child.send!({ kind, requestId, ...values });
});
/** Focus returns to the keyboard mirror when a panel closes; blur it so the picture shows the WebGL scene, not the focused mirror. */
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const shot = async (page: Page, name: string) => { await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false }); };
test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  child = spawn(process.execPath, ['--input-type=module'], { cwd: resolve('../cli'), env: { ...process.env, T9_ASSETS: resolve('dist/client') }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', d => { stderr = (stderr + String(d)).slice(-4000); });
  child.stdin!.end(await readFile('e2e/director-visual-host.mjs', 'utf8'));
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Director fixture did not start: ' + stderr)), 15000);
    child.on('message', (raw: any) => { if (raw.ready) { pairing = raw.pairing; repository = raw.repository; clearTimeout(timer); accept(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Director fixture exited: ' + stderr)); });
  });
});
test.afterAll(async () => {
  if (child?.connected) child.send!({ kind: 'close' });
  await new Promise<void>(accept => { if (!child || child.exitCode !== null) { accept(); return; } const t = setTimeout(() => { child.kill(); accept(); }, 4000); child.once('exit', () => { clearTimeout(t); accept(); }); });
});

test('Classic: Director presence, launch picker, no-Desktop manual command, chat and issue queue retry', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const base = await openProject(page, pairing, repository, /guides.*Xem dự án/);
  const panel = page.getByRole('region', { name: 'Director', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Director chưa có mặt').first()).toBeVisible();
  await shot(page, '01-classic-overview-director-absent');

  // Launch picker: provider choice at action time; an unavailable provider is labelled, not hidden.
  await panel.getByRole('button', { name: 'Khởi động phiên' }).click();
  const providers = panel.getByRole('radiogroup', { name: 'Nhà cung cấp cho Director' });
  await expect(providers).toBeVisible();
  await expect(providers.getByText(/codex/i).first()).toBeVisible();
  await shot(page, '02-classic-launch-picker');
  await providers.getByRole('radio').first().check();
  await panel.getByRole('button', { name: 'Mở terminal Director' }).click();
  await expect(panel.getByText(/Đã mở cửa sổ terminal|Director đã có mặt/).first()).toBeVisible();
  await expect.poll(async () => (await call('inspect')).launches).toBe(1);
  await expect(panel.getByText('Director đã có mặt và đang nhận tin.')).toBeVisible({ timeout: 20000 });
  await shot(page, '03-classic-launch-arrived');

  // Chat: the Web message and the Director reply render as text in one transcript; "duyệt" is chat only.
  await page.goto(`${new URL(page.url()).origin}${base}/chat`);
  const chat = page.getByRole('region', { name: 'Trò chuyện với Director' });
  await expect(chat).toBeVisible();
  await chat.getByLabel('Tin nhắn cho Director').fill('Thêm mục cài đặt trên macOS vào guide.md');
  await chat.getByRole('button', { name: 'Gửi tin nhắn' }).click();
  const log = chat.getByRole('log', { name: 'Tin nhắn với Director' });
  await expect(log.getByText('Thêm mục cài đặt trên macOS vào guide.md')).toBeVisible();
  await expect(log.getByText(/Đã nhận: “Thêm mục cài đặt/)).toBeVisible({ timeout: 15000 });
  await shot(page, '04-classic-director-chat');
  expect((await call('inspect')).commands.filter((c: any) => c.kind === 'answer_decision')).toEqual([]);

  // Issue queue: the open issue can be retried once; the retrying one shows its state, never a duplicate command.
  await page.goto(`${new URL(page.url()).origin}${base}/issues`);
  const queue = page.getByRole('region', { name: 'Hàng đợi sự cố' });
  await expect(queue).toBeVisible();
  await expect(queue.getByText(/Developer không phản hồi/).first()).toBeVisible();
  await shot(page, '05-classic-issue-queue');
  const retry = queue.getByRole('button', { name: 'Thử lại sự cố' }).first();
  await expect(retry).toBeEnabled({ timeout: 15000 });
  await retry.dblclick();
  await expect.poll(async () => (await call('inspect')).commands.filter((c: any) => c.kind === 'issue_retry').length).toBe(1);
  await expect.poll(async () => (await call('inspect')).issues.filter((i: any) => i.status === 'retrying').length).toBe(2);
  await page.waitForTimeout(1500);
  expect((await call('inspect')).commands.filter((c: any) => c.kind === 'issue_retry').length).toBe(1);
  await shot(page, '06-classic-issue-queue-after-retry');

  // No desktop: the terminal is unavailable, the picker offers the manual command only.
  await call('configure', { terminal: false, presence: 'absent' });
  await page.goto(`${new URL(page.url()).origin}${base}`);
  const panel2 = page.getByRole('region', { name: 'Director', exact: true });
  await expect(panel2.getByText('Director chưa có mặt').first()).toBeVisible({ timeout: 15000 });
  await panel2.getByRole('button', { name: 'Khởi động phiên' }).click();
  await expect(panel2.getByText(/Không có phiên desktop/).first()).toBeVisible();
  await shot(page, '07-classic-launch-no-desktop');
  for (const width of [1280, 768, 390]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await shot(page, '08-classic-overview-phone-390');
  expect(errors.filter(e => !/Failed to load resource/.test(e))).toEqual([]);
});

test('Office3D: Director desk and issue board in the WebGL scene and the accessible mirror', async ({ page }) => {
  test.setTimeout(120000);
  await call('configure', { presence: 'active' });
  // A fresh context needs a fresh single-use bootstrap secret.
  await openProject(page, await call('pair'), repository, /guides.*Xem dự án/);
  await enterVisual(page);
  await sceneReady(page);
  await page.waitForTimeout(1500);
  await shot(page, '09-office3d-scene');
  const region = page.getByLabel('Bản văn bản của văn phòng');
  await expect(region.getByRole('button', { name: /^Director: Đang hoạt động/ })).toHaveCount(1);
  await expect(region.getByRole('button', { name: /^Bảng sự cố \(/ })).toHaveCount(1);
  await mirror(page, /^Director: Đang hoạt động/);
  await page.waitForTimeout(1500);
  await shot(page, '10-office3d-director-desk');
  // The panel closed: the camera stays on the desk, so the WebGL figure itself is in view.
  await page.getByRole('button', { name: 'Đóng cửa sổ Director' }).click();
  await page.waitForTimeout(1500);
  await blur(page); await page.waitForTimeout(500);
  await shot(page, '10b-office3d-director-desk-scene');
  await mirror(page, /^Bảng sự cố \(/);
  await page.waitForTimeout(1500);
  await shot(page, '11-office3d-issue-board');
  await page.getByRole('button', { name: 'Đóng cửa sổ Sự cố' }).click();
  await page.waitForTimeout(1500);
  await blur(page); await page.waitForTimeout(500);
  await shot(page, '11b-office3d-issue-board-scene');
  // Director absent: an empty desk, not a fake agent.
  await call('configure', { presence: 'absent' });
  await expect(region.getByRole('button', { name: /^Director: Chưa có mặt\. Mức tin cậy: Đã xác nhận/ })).toHaveCount(1, { timeout: 20000 });
  await mirror(page, /^Director: Chưa có mặt/);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Đóng cửa sổ Director' }).click();
  await page.waitForTimeout(1500);
  await blur(page); await page.waitForTimeout(500);
  await shot(page, '12-office3d-director-absent');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1000);
  await blur(page); await page.waitForTimeout(500);
  await shot(page, '13-office3d-phone-reduced-motion');
});

test('Immersive flag: Director desk opens one persistent, editable in-scene dialogue', async ({ page }) => {
  test.skip(!process.env.VITE_BFLOW_IMMERSIVE_OFFICE, 'This browser check requires a build with the immersive flag enabled.');
  test.setTimeout(120000);
  await call('configure', { presence: 'active', clearMessages: true });
  expect((await call('inspect')).messages).toHaveLength(0);
  const base = await openProject(page, await call('pair'), repository, /guides.*Xem dự án/);
  await enterVisual(page);
  await page.goto(`${new URL(page.url()).origin}${base}/chat`);
  await expect(page.getByRole('region', { name: 'Trò chuyện với Director' })).toHaveCount(1);
  const opener = page.getByLabel('Bản văn bản của văn phòng').getByRole('button', { name: /^Director: Đang hoạt động/ });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialogue = page.getByRole('dialog', { name: 'Trò chuyện với Director' });
  await expect(dialogue).toBeVisible();
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-state', 'interacting');
  await page.waitForTimeout(600);
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-state', 'interacting');
  await expect(dialogue.getByRole('region', { name: 'Trò chuyện với Director' })).toHaveCount(1);
  await expect(dialogue.getByText(/Chào bạn, tôi là Director/)).toBeVisible();
  const before = await call('inspect');
  await dialogue.getByText('Gợi ý trò chuyện',{exact:true}).click();
  await dialogue.getByRole('button', { name: 'Hỏi tiến độ' }).click();
  await expect(dialogue.getByLabel('Tin nhắn cho Director')).toHaveValue(/Cho tôi biết tiến độ/);
  const after = await call('inspect');
  expect(after.commands).toHaveLength(before.commands.length);
  expect(after.messages.filter((message: any) => message.author === 'user' && message.channel === 'web')).toHaveLength(before.messages.filter((message: any) => message.author === 'user' && message.channel === 'web').length);
  await dialogue.getByRole('button', { name: 'Thu nhỏ Trò chuyện với Director' }).click();
  await expect(dialogue).toBeHidden();
  await page.getByRole('group', { name: 'Cửa sổ đang mở' }).getByRole('button', { name: 'Trò chuyện với Director' }).click();
  await expect(dialogue).toBeVisible();
  await expect(dialogue.getByLabel('Tin nhắn cho Director')).toHaveValue(/Cho tôi biết tiến độ/);
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport);
    const editor=dialogue.getByLabel('Tin nhắn cho Director');
    await editor.scrollIntoViewIfNeeded();
    const input = await editor.boundingBox();
    expect(input).not.toBeNull();
    expect(input!.y + input!.height).toBeLessThanOrEqual(viewport.height);
    expect(await editor.evaluate(element=>{const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return Boolean(hit&&(hit===element||element.contains(hit)));})).toBe(true);
  }
  await dialogue.getByRole('button', { name: 'Đóng cửa sổ Trò chuyện với Director' }).click();
  await expect(dialogue).toBeHidden();
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-state', 'selected');
  await expect(opener).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-state', 'overview');
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-selected', 'false');
  const camera = page.getByText('Camera', { exact: true });
  const cameraBox = await camera.boundingBox();
  expect(cameraBox, `camera control bounds: ${JSON.stringify(cameraBox)}`).not.toBeNull();
  expect(cameraBox!.x, `camera control bounds: ${JSON.stringify(cameraBox)}`).toBeGreaterThanOrEqual(0);
  expect(cameraBox!.y, `camera control bounds: ${JSON.stringify(cameraBox)}`).toBeGreaterThanOrEqual(0);
  expect(cameraBox!.x + cameraBox!.width, `camera control bounds: ${JSON.stringify(cameraBox)}`).toBeLessThanOrEqual(812);
  expect(cameraBox!.y + cameraBox!.height, `camera control bounds: ${JSON.stringify(cameraBox)}`).toBeLessThanOrEqual(375);
  await camera.click();
  await expect(page.getByRole('button', { name: 'Phóng to' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Di chuyển góc nhìn sang trái' })).toBeVisible();
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(dialogue).toBeVisible();
  await page.goBack();
  await expect(dialogue).toBeHidden();
  await expect(page.getByRole('region', { name: 'Trò chuyện với Director' })).toHaveCount(1);
});

test('short landscape recovery keeps transcript, launch/read controls, suggestions and recovery target reachable', async ({ page }) => {
  test.skip(!process.env.VITE_BFLOW_IMMERSIVE_OFFICE, 'Requires a build with the immersive flag enabled.');
  test.setTimeout(120000);
  await call('configure', { presence: 'active', clearMessages: true, loseAckNext: true });
  await openProject(page, await call('pair'), repository, /guides.*Xem dự án/);
  await enterVisual(page);
  await page.setViewportSize({ width: 812, height: 375 });
  await mirror(page, /^Director: Đang hoạt động/);
  const dialogue=page.getByRole('dialog',{name:'Trò chuyện với Director'});
  await expect(dialogue).toBeVisible();
  await dialogue.getByLabel('Tin nhắn cho Director').fill('Kiểm tra khôi phục màn hình ngang');
  await dialogue.getByRole('button',{name:'Gửi tin nhắn'}).click();
  await expect(dialogue.getByRole('button',{name:'Đối chiếu tin nhắn'})).toBeFocused();
  await expect(dialogue.getByRole('heading', { name: 'Trò chuyện với Director' })).toBeVisible();
  await expect(dialogue.getByText('Gợi ý trò chuyện',{exact:true})).toBeVisible();
  await expect(dialogue.getByText(/không tự gửi lại/)).toBeVisible();
  const targets=[dialogue.getByRole('button',{name:'Đóng cửa sổ Trò chuyện với Director'}),dialogue.getByRole('button',{name:'Đọc lại hội thoại'}),dialogue.getByRole('button',{name:'Khởi động phiên'}),dialogue.getByText('Gợi ý trò chuyện',{exact:true}),dialogue.getByRole('button',{name:'Đối chiếu tin nhắn'})];
  await shot(page,'812-director-landscape-final');
  const chatGeometry=await dialogue.evaluate(root=>{const win=root.closest('.bwin'),box=(selector:string)=>{const el=win?.querySelector<HTMLElement>(selector),r=el?.getBoundingClientRect();return el&&r?{x:r.x,y:r.y,width:r.width,height:r.height,scrollTop:el.scrollTop}:undefined;};return {body:box('.bwin-body'),thread:box('.chat-thread'),header:box('.chat-thread > header'),form:box('.chat-thread > form')};});
  expect(chatGeometry.thread?.scrollTop).toBe(0);
  expect(chatGeometry.header!.y).toBeGreaterThanOrEqual(chatGeometry.body!.y);
  expect(chatGeometry.form!.y+chatGeometry.form!.height).toBeLessThanOrEqual(chatGeometry.body!.y+chatGeometry.body!.height);
  expect(chatGeometry.header!.y+chatGeometry.header!.height).toBeLessThanOrEqual(chatGeometry.form!.y);
  const compactControls=[targets[0]!,dialogue.getByLabel('Tin nhắn cho Director'),dialogue.getByRole('button',{name:'Gửi tin nhắn'}),targets[4]!];
  const compactBoxes=await Promise.all(compactControls.map(async target=>{const box=await target.boundingBox();expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(812);expect(box!.y+box!.height).toBeLessThanOrEqual(375);return box!;}));
  for(let i=0;i<compactBoxes.length;i++)for(let j=i+1;j<compactBoxes.length;j++)expect(compactBoxes[i]!.x+compactBoxes[i]!.width<=compactBoxes[j]!.x||compactBoxes[j]!.x+compactBoxes[j]!.width<=compactBoxes[i]!.x||compactBoxes[i]!.y+compactBoxes[i]!.height<=compactBoxes[j]!.y||compactBoxes[j]!.y+compactBoxes[j]!.height<=compactBoxes[i]!.y,`landscape controls ${i} and ${j} must not overlap`).toBe(true);
  for(const target of targets){
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeVisible();
    const box=await target.boundingBox();expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(812);expect(box!.y+box!.height).toBeLessThanOrEqual(375);
    const hit=await target.evaluate(element=>{const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return {ok:Boolean(hit&&(hit===element||element.contains(hit))),target:element.getAttribute('aria-label')||element.textContent,hit:hit?.outerHTML.slice(0,120)};});
    expect(hit.ok,`${hit.target} was obscured by ${hit.hit}`).toBe(true);
  }
  for(const viewport of [{width:375,height:812},{width:812,height:375},{width:768,height:900},{width:1099,height:900},{width:1100,height:900},{width:1440,height:900},{width:1920,height:1080}]){
    await page.setViewportSize(viewport);await expect(dialogue).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`horizontal overflow at ${viewport.width}x${viewport.height}`).toBe(true);
    for(const target of [targets[0]!,targets[1]!,targets[2]!,targets[4]!]){
      await target.scrollIntoViewIfNeeded();await expect(target).toBeVisible();const box=await target.boundingBox();expect(box,`${viewport.width}x${viewport.height}`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(viewport.width);expect(box!.y+box!.height).toBeLessThanOrEqual(viewport.height);
      const hit=await target.evaluate(element=>{const rect=element.getBoundingClientRect(),node=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return Boolean(node&&(node===element||element.contains(node)));});
      expect(hit,`${viewport.width}x${viewport.height}: ${await target.getAttribute('aria-label')||await target.textContent()}`).toBe(true);
    }
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{document.documentElement.style.zoom='2';});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const touch=await page.context().newCDPSession(page),summary=dialogue.getByText('Gợi ý trò chuyện',{exact:true});await summary.scrollIntoViewIfNeeded();const summaryBox=await summary.boundingBox();
  expect(summaryBox).not.toBeNull();
  await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  const touchPoint={x:summaryBox!.x+summaryBox!.width/2,y:summaryBox!.y+summaryBox!.height/2};
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touchPoint]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect(dialogue.locator('details.director-chat-suggestions')).toHaveAttribute('open','');
  await touch.send('Emulation.setTouchEmulationEnabled',{enabled:false});await touch.detach();
  const state=await call('inspect');
  expect(state.messages.filter((message:any)=>message.author==='user'&&message.channel==='web')).toHaveLength(1);
  expect(state.commands).toHaveLength(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
