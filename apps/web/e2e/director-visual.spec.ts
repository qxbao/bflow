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
  await page.getByRole('button', { name: 'Đóng bảng' }).click();
  await page.waitForTimeout(1500);
  await blur(page); await page.waitForTimeout(500);
  await shot(page, '10b-office3d-director-desk-scene');
  await mirror(page, /^Bảng sự cố \(/);
  await page.waitForTimeout(1500);
  await shot(page, '11-office3d-issue-board');
  await page.getByRole('button', { name: 'Đóng bảng' }).click();
  await page.waitForTimeout(1500);
  await blur(page); await page.waitForTimeout(500);
  await shot(page, '11b-office3d-issue-board-scene');
  // Director absent: an empty desk, not a fake agent.
  await call('configure', { presence: 'absent' });
  await expect(region.getByRole('button', { name: /^Director: Chưa có mặt\. Mức tin cậy: Đã xác nhận/ })).toHaveCount(1, { timeout: 20000 });
  await mirror(page, /^Director: Chưa có mặt/);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Đóng bảng' }).click();
  await page.waitForTimeout(1500);
  await blur(page); await page.waitForTimeout(500);
  await shot(page, '12-office3d-director-absent');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1000);
  await blur(page); await page.waitForTimeout(500);
  await shot(page, '13-office3d-phone-reduced-motion');
});
