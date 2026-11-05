import { expect, test, type Page } from '@playwright/test';
import { startAcceptanceHost, type AcceptanceHost } from './acceptance-fixture';
import { browserOptions, enterVisual, mirror, openDock, recordWebGl, sceneReady, stableCount, workforceBody } from './office-fixture';
// V8.3: the W09 recovery scenarios of recovery.spec.ts through the 3D mode (same deterministic host, assertions on host-side effect logs),
// plus the §8.3 browser/fault rows: uncertain delivery, lost WebGL context, expired session, a full developer pool and repeated mode switching.
test.use(browserOptions());
expect.configure({ timeout: 15000 });
let host: AcceptanceHost;
test.beforeEach(async () => { host = await startAcceptanceHost(); });
test.afterEach(async () => { await host?.close(); });
const distinct = (commands: any[], kind: string) => new Set(commands.filter(c => c.kind === kind).map(c => c.commandId)).size;

async function openProject(page: Page, pairing = host.pairing): Promise<string> {
  await page.goto(pairing);
  const link = page.getByRole('link', { name: /thư viện.*Xem dự án/ });
  if (!await link.isVisible().catch(() => false)) { await page.getByLabel('Đường dẫn Git tuyệt đối').fill(host.repository); await page.getByRole('button', { name: 'Đăng ký dự án' }).click(); }
  await link.click();
  return new URL(page.url()).pathname;
}
/** Enters 3D and opens the run from the task board object. */
async function openRun(page: Page, pairing = host.pairing): Promise<string> {
  const base = await openProject(page, pairing);
  await enterVisual(page);
  await mirror(page, /Bảng nhiệm vụ/);
  await page.getByRole('link', { name: 'Tìm sách nhanh', exact: true }).first().click();
  await expect(page).toHaveURL(/runs\/run$/);
  await expect(page.getByRole('button', { name: 'Xem xét gói' })).toBeVisible();
  return base;
}

test('3D AC08 response lost after commit, Local Server restart mid-operation and browser close keep one effect per intent', async ({ browser }) => {
  test.setTimeout(120000);
  const context = await browser.newContext(), page = await context.newPage();
  const base = await openRun(page);
  let dropped = 0;
  await page.route('**/api/v1/projects/*/commands', async route => { const response = await route.fetch(); dropped++; expect(response.status()).toBe(202); await route.abort('connectionreset'); }, { times: 1 });
  await page.getByRole('button', { name: 'Xem xét gói' }).click(); await page.getByRole('button', { name: 'Duyệt gói' }).click();
  await expect.poll(() => dropped).toBe(1);
  await expect.poll(async () => (await host.call('inspect')).effects.filter((k: string) => k === 'answer_decision').length).toBe(1);
  await openDock(page);
  await expect(page.getByText(/Mất phản hồi|Chưa xác định kết quả|Đã áp dụng thao tác/).first()).toBeVisible();
  await page.reload();
  // The reload keeps 3D and rebuilds the scene; the dock (HUD) recovers the operation by its stored ID without a second POST.
  await expect(page.getByRole('button', { name: '3D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await sceneReady(page);
  await openDock(page);
  await expect(page.getByText('Đã áp dụng thao tác. Trạng thái công việc được đọc riêng.').first()).toBeVisible({ timeout: 15000 });
  await stableCount(async () => (await host.call('inspect')).effects.filter((k: string) => k === 'answer_decision').length, 1);
  let state = await host.call('inspect');
  expect(state.effects.filter((k: string) => k === 'answer_decision')).toHaveLength(1);
  expect(distinct(state.commands, 'answer_decision')).toBe(1);
  expect(state.decisionOutcome).toBe('approved');

  // Restart the Local Server while a cancel is in flight inside the host, then re-pair on the same origin (3D is remembered).
  await host.call('configure', { hold: 3000 });
  await page.getByRole('button', { name: 'Hủy công việc', exact: true }).click(); await page.getByLabel('Lý do hủy').fill('Đổi ưu tiên');
  await page.getByRole('button', { name: 'Gửi yêu cầu hủy' }).click();
  await expect.poll(async () => (await host.call('inspect')).effects.filter((k: string) => k === 'cancel').length).toBe(1);
  const repair = await host.call('restart');
  await page.goto(repair); await expect(page.getByRole('link', { name: /thư viện.*Xem dự án/ })).toBeVisible();
  await page.goto(new URL(base + '/runs/run', repair).href);
  await expect(page.getByRole('button', { name: '3D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await sceneReady(page);
  await openDock(page);
  await expect(page.getByText('Yêu cầu hủy đã áp dụng; chỉ trạng thái công việc mới xác nhận đã hủy.')).toBeVisible({ timeout: 15000 });
  // The host held the cancel for 3 s inside the restart; wait it out and keep watching for a duplicate.
  await stableCount(async () => (await host.call('inspect')).effects.filter((k: string) => k === 'cancel').length, 1, 3200);
  state = await host.call('inspect');
  expect(state.effects).toEqual(['answer_decision', 'cancel']);
  expect(distinct(state.commands, 'cancel')).toBe(1);

  // Closing the browser is not a lifecycle or workflow action.
  await context.close();
  await stableCount(async () => (await host.call('inspect')).commands.length, state.commands.length, 1500);
  const closed = await host.call('inspect');
  expect(closed.lifecycleCalls).toEqual([]); expect(closed.effects).toEqual(state.effects); expect(closed.commands.length).toBe(state.commands.length);
});

test('3D AC08/AC05 two tabs with conflicting decisions commit exactly one; the opposite outcome is never sent', async ({ browser }) => {
  test.setTimeout(90000);
  const context = await browser.newContext(), a = await context.newPage();
  await openRun(a);
  const b = await context.newPage(); await b.goto(a.url());
  await expect(b.getByRole('button', { name: '3D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const tab of [a, b]) await tab.getByRole('button', { name: 'Xem xét gói' }).click();
  await b.getByLabel(/Lý do \(bắt buộc/).fill('Thiếu tiêu chí hiệu năng');
  await Promise.all([a.getByRole('button', { name: 'Duyệt gói' }).evaluate((el: HTMLButtonElement) => el.click()), b.getByRole('button', { name: 'Từ chối' }).evaluate((el: HTMLButtonElement) => el.click())]);
  await stableCount(async () => (await host.call('inspect')).effects.length, 1, 2400);
  const state = await host.call('inspect');
  expect(state.effects).toEqual(['answer_decision']);
  expect(state.commands.map((c: any) => c.outcome)).toHaveLength(1);
  const winner = state.decisionOutcome === 'approved' ? a : b, loser = winner === a ? b : a;
  await openDock(winner); await openDock(loser);
  await expect(winner.getByText(/Đã áp dụng thao tác|Mất phản hồi/).first()).toBeVisible();
  await expect(winner.getByText(`Quyết định gói: ${state.decisionOutcome === 'approved' ? 'Duyệt' : 'Từ chối'}`).first()).toBeVisible();
  await expect(loser.getByText(/chưa được gửi|không được áp dụng/).first()).toBeVisible({ timeout: 10000 });
  await context.close();
});

test('3D AC08 SSE eviction after a dropped stream yields reset and a snapshot reload; no mutation or walk replay', async ({ page }) => {
  test.setTimeout(60000);
  const posts: string[] = [];
  page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
  await openRun(page);
  await expect(page.getByText('Phiên bản 1').first()).toBeVisible();
  await expect.poll(async () => (await host.call('inspect')).eventStreams).toBeGreaterThanOrEqual(1);
  const before = await host.call('inspect');
  const postsBefore = posts.length;
  await host.call('configure', { bump: true, evict: 1500, drop: true });
  await expect.poll(async () => (await host.call('inspect')).eventStreams, { timeout: 20000 }).toBeGreaterThan(before.eventStreams);
  await expect(page.getByText('Phiên bản 2').first()).toBeVisible({ timeout: 20000 });
  const after = await host.call('inspect');
  expect(after.readRuns).toBeGreaterThan(before.readRuns);
  expect(after.commands).toHaveLength(0); expect(after.effects).toHaveLength(0);
  expect(posts.length).toBe(postsBefore);
  // The scene survived the reset and is still the single live canvas.
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-renderer', 'ready');
  await expect(page.getByLabel('Cảnh văn phòng').locator('canvas')).toHaveCount(1);
});

test('3D unknown_delivery shows a "chưa xác định" label and offers no resend', async ({ page }) => {
  test.setTimeout(60000);
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  let state = 'accepted';
  await page.route('**/api/v1/projects/*/workforce', route => route.fulfill({ json: workforceBody(new URL(route.request().url()).pathname.split('/')[4]!, { handoffState: state }) }));
  await openProject(page);
  await enterVisual(page);
  const mirrorAgent = page.getByLabel('Bản văn bản của văn phòng').getByRole('button', { name: /\(Điều phối viên\)/ });
  await expect(mirrorAgent).not.toContainText('Chưa xác định việc đã tới');
  // The next read reports an uncertain delivery.
  state = 'unknown_delivery';
  await page.getByRole('button', { name: 'Tải lại dữ liệu' }).click();
  await expect(mirrorAgent).toContainText('Chưa xác định việc đã tới');
  await expect(mirrorAgent).toContainText('Mức tin cậy: Chưa xác định');
  await expect(page.getByLabel('Trạng thái văn phòng')).toContainText('chưa rõ');
  // Nothing in the page claims the work arrived, and no resend is offered.
  await mirrorAgent.focus(); await page.keyboard.press('Enter');
  await expect(page.getByText('Chưa rõ đã tới nơi').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Gửi lại/ })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('3D lost WebGL context falls back to the HTML list and keeps the draft', async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(recordWebGl);
  await openProject(page);
  await enterVisual(page);
  await page.getByRole('button', { name: 'Tổng quan', exact: true }).first().click();
  await page.getByLabel('Tên công việc').fill('Nháp phải còn nguyên');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __gl: unknown[] }).__gl.length)).toBeGreaterThan(0);
  await page.evaluate(() => { for (const gl of (window as unknown as { __gl: WebGLRenderingContext[] }).__gl) gl.getExtension('WEBGL_lose_context')?.loseContext(); });
  await expect(page.getByText(/Cảnh đồ họa bị mất ngữ cảnh hiển thị/).first()).toBeVisible();
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveCount(0);
  await expect(page.getByLabel('Bản văn bản của văn phòng').getByRole('button', { name: /Quầy Conversation/ })).toBeVisible();
  await expect(page.getByLabel('Tên công việc')).toHaveValue('Nháp phải còn nguyên');
  // The list still navigates.
  await mirror(page, /Bảng nhiệm vụ/);
  await expect(page).toHaveURL(/\/runs$/);
});

test('3D session expiry returns to pairing and destroys the scene', async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(recordWebGl);
  let shorten = false;
  await page.route('**/api/v1/session', async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: shorten ? { ...body, expiresAt: new Date(Date.now() + 25000).toISOString() } : body });
  });
  await openProject(page);
  await enterVisual(page);
  // Reload so the client re-reads its session and arms the expiry timer (25 s: a slow start still gets its scene first).
  shorten = true;
  await page.reload();
  const pairing = page.getByLabel('Liên kết mở Bflow Web');
  const stage = page.getByLabel('Cảnh văn phòng');
  await expect(stage.or(pairing)).toBeVisible({ timeout: 30000 });
  const sawScene = await stage.isVisible();
  if (!sawScene) test.info().annotations.push({ type: 'slow-start', description: 'the session expired before the scene appeared; only the end state is checked' });
  await expect(pairing).toBeVisible({ timeout: 40000 });
  await expect(stage).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Văn phòng Bflow' })).toHaveCount(0);
  const { created, alive } = await page.evaluate(() => { const all = (window as unknown as { __gl: WebGLRenderingContext[] }).__gl; return { created: all.length, alive: all.filter(g => !g.isContextLost()).length }; });
  expect(created).toBeGreaterThan(0); expect(alive).toBe(0);
});

test('3D shows exactly the seated developers plus an overflow chip, without crashing', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  let developers = 20;
  await page.route('**/api/v1/projects/*/workforce', route => route.fulfill({ json: workforceBody(new URL(route.request().url()).pathname.split('/')[4]!, { developers }) }));
  await openProject(page);
  await enterVisual(page);
  const mirrorDevs = () => page.getByLabel('Bản văn bản của văn phòng').getByRole('button', { name: /\(Lập trình viên\)/ });
  // Twenty fill the pool exactly: all in the scene, no chip.
  await expect(mirrorDevs()).toHaveCount(20);
  await expect(page.getByRole('button', { name: /^Còn \d+ lập trình viên chưa hiện/ })).toHaveCount(0);
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-renderer', 'ready');
  // Twenty-three: still twenty seats, and the chip names the three left out.
  developers = 23;
  await page.getByRole('button', { name: 'Tải lại dữ liệu' }).click();
  await expect(mirrorDevs()).toHaveCount(23);
  const chip = page.getByRole('button', { name: 'Còn 3 lập trình viên chưa hiện trong cảnh. Mở danh sách nhân viên' });
  await expect(chip).toHaveText('+3');
  await chip.click();
  // The panel lists exactly the unseated ones (23 - 20 seats), so exactly twenty characters stand in the scene.
  const unseated = page.getByLabel('Lập trình viên chưa hiện trong cảnh');
  await expect(unseated.getByRole('heading', { name: 'Lập trình viên chưa hiện trong cảnh' })).toBeVisible();
  await expect(unseated.getByRole('button')).toHaveCount(3);
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-renderer', 'ready');
  expect(errors).toEqual([]);
});

test('3D mode toggled 50 times neither leaks WebGL contexts nor leaves a canvas behind', async ({ page }) => {
  test.setTimeout(300000);
  await page.addInitScript(recordWebGl);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openProject(page);
  const TOGGLES = 50;
  const live = () => page.evaluate(() => (window as unknown as { __gl: WebGLRenderingContext[] }).__gl.filter(g => !g.isContextLost()).length);
  for (let i = 0; i < TOGGLES; i++) {
    await page.getByRole('button', { name: '3D', exact: true }).click();
    await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-renderer', 'ready', { timeout: 20000 });
    // Never more than the one live context, however many scenes were created before.
    expect(await live(), `live contexts in visit ${i + 1}`).toBe(1);
    await page.getByRole('button', { name: 'Web', exact: true }).click();
    await expect(page.getByLabel('Cảnh văn phòng')).toHaveCount(0);
  }
  const { created, alive } = await page.evaluate(() => { const all = (window as unknown as { __gl: WebGLRenderingContext[] }).__gl; return { created: all.length, alive: all.filter(g => !g.isContextLost()).length }; });
  expect(created).toBeGreaterThanOrEqual(TOGGLES);
  expect(alive).toBe(0);
  expect(await page.locator('canvas').count()).toBe(0);
  expect(errors).toEqual([]);
});
