import { expect, test } from '@playwright/test';
import { startAcceptanceHost } from './acceptance-fixture';
import { browserOptions, enterVisual, mirror, openProject, rail, sceneReady, stableCount, startDirectHost, type DirectHost } from './office-fixture';
// V8.2: the Classic direct-actions scenario (same W07 host) repeated only through the 3D mode: HUD rail, DOM mirror buttons, the panel and the HUD dock.
// The Classic spec's final "Tổng quan" link expectation is stale at baseline and is deliberately not copied.
test.use(browserOptions());
// Under load the host's 2000 ms hold and the page's own reads can overlap; every wait below is a condition, never a longer sleep.
expect.configure({ timeout: 15000 });
test.describe.configure({ mode: 'serial' });
let host: DirectHost;
test.beforeAll(async () => { host = await startDirectHost(); });
test.afterAll(async () => { await host?.close(); });

test('3D: create, clarify, stale review, changes, resume, cancel and lost ACK use server state with one effect per intent', async ({ page, context }) => {
  test.setTimeout(240000);
  const base = await openProject(page, host.pairing, host.repository, /books.*Xem dự án/);
  await enterVisual(page);
  const csp: string[] = [];
  page.on('console', m => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
  const effects = async (kind: string) => (await host.call('inspect')).effects.filter((k: string) => k === kind).length;
  const settledApplied = page.getByText('Đã áp dụng thao tác. Trạng thái công việc được đọc riêng.').first();

  // Create: only the Overview panel from the rail; the double click reaches the host once.
  await rail(page, /^Tổng quan/).click();
  await page.getByLabel('Tên công việc').fill('Tìm sách nhanh');
  await page.getByLabel('Mục tiêu', { exact: true }).fill('Tìm sách theo tên và tác giả');
  await page.getByLabel('Tiêu chí chấp nhận (mỗi dòng một tiêu chí)').fill('Tìm được tên sách\nTìm được tác giả');
  await page.getByLabel('Ràng buộc (mỗi dòng một ràng buộc)').fill('Giữ tương thích');
  await host.call('configure', { delay: 2000 });
  await page.getByRole('button', { name: 'Tạo công việc', exact: true }).dblclick();
  await expect.poll(() => effects('create_request')).toBe(1);
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await context.setOffline(false);
  await page.reload();
  // The mode is remembered and the scene is rebuilt; the panel is closed on the index path, the draft is back when the Overview is reopened.
  await expect(page.getByRole('button', { name: '3D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await sceneReady(page);
  await rail(page, /^Tổng quan/).click();
  await expect(page.getByLabel('Tên công việc')).toHaveValue('Tìm sách nhanh');
  // The recovered operation is tracked by its stored ID: wait until the host's ACK arrives (condition, not a sleep); the form then refuses a second create while it is tracked.
  await expect(settledApplied).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Tạo công việc', exact: true })).toBeDisabled();
  await stableCount(() => effects('create_request'), 1);

  // Intake clarification in the Overview panel, then the run clarification from the task board.
  await page.getByRole('button', { name: 'Tên và tác giả', exact: true }).click();
  await page.getByRole('button', { name: 'Gửi câu trả lời' }).click();
  await expect.poll(async () => (await host.call('inspect')).commands.filter((c: any) => c.kind === 'answer_clarification' && c.intakeId === 'intake').length).toBe(1);
  await mirror(page, /Bảng nhiệm vụ/);
  await expect(page).toHaveURL(/\/runs$/);
  await page.getByRole('link', { name: 'Tìm sách nhanh', exact: true }).first().click();
  await expect(page).toHaveURL(/runs\/run$/);
  await page.getByRole('button', { name: 'Tên sách', exact: true }).click();
  await page.getByRole('button', { name: 'Gửi câu trả lời' }).click();
  await expect.poll(async () => (await host.call('inspect')).phase).toBe('reviewing');

  // Review is pinned to a version: a newer revision requires an explicit re-read and sends nothing.
  await page.getByRole('button', { name: 'Xem xét gói' }).click();
  await host.call('configure', { revision: 2 });
  await expect(page.getByRole('button', { name: 'Đọc lại gói hiện hành' })).toBeVisible();
  expect(await effects('answer_decision')).toBe(0);
  await page.getByRole('button', { name: 'Đọc lại gói hiện hành' }).click();
  await page.getByRole('button', { name: 'Xem xét gói' }).click();
  // Two tabs: both approve the same version, exactly one effect.
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByRole('button', { name: '3D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await other.getByRole('button', { name: 'Xem xét gói' }).click();
  await expect(page.getByRole('button', { name: 'Duyệt gói' })).toBeEnabled();
  await expect(other.getByRole('button', { name: 'Duyệt gói' })).toBeEnabled();
  await Promise.all([page, other].map(tab => tab.getByRole('button', { name: 'Duyệt gói' }).evaluate((b: HTMLButtonElement) => b.click())));
  await expect.poll(async () => (await host.call('inspect')).phase).toBe('blocked');
  await other.close();

  // Resume follows availableActions; cancel needs a reason and the accepted state is not "stopped".
  await expect(page.getByRole('button', { name: 'Tiếp tục', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
  await expect.poll(async () => (await host.call('inspect')).phase).toBe('implementing');
  await page.getByRole('button', { name: 'Hủy công việc', exact: true }).click();
  await page.getByLabel('Lý do hủy').fill('Thay đổi ưu tiên');
  await page.getByRole('button', { name: 'Gửi yêu cầu hủy' }).click();
  await stableCount(() => effects('cancel'), 1);
  await expect(page.getByText('Yêu cầu hủy chưa xác nhận tiến trình đã dừng.')).toBeVisible();
  expect((await host.call('inspect')).cancelled).toBe(false);

  // Restart the real HTTP server; re-pair and observe the same original operation ID from the 3D page.
  const before = await host.call('inspect');
  const repair = await host.call('restart');
  await page.goto(repair);
  await expect(page.getByRole('link', { name: /books.*Xem dự án/ })).toBeVisible();
  await page.goto(new URL(base + '/runs/run', repair).href);
  await expect(page.getByRole('button', { name: '3D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await sceneReady(page);
  await expect(page.getByText('Yêu cầu hủy chưa xác nhận tiến trình đã dừng.')).toBeVisible();
  await host.call('configure', { cancelled: true });
  await expect(page.getByText('Yêu cầu hủy đã áp dụng; chỉ trạng thái công việc mới xác nhận đã hủy.')).toBeVisible({ timeout: 10000 });
  const after = await host.call('inspect');
  expect(after.operationCount).toBe(before.operationCount);
  expect(after.commands.map((c: any) => c.commandId)).toEqual(before.commands.map((c: any) => c.commandId));
  expect(after.effects).toEqual(['create_request', 'answer_clarification', 'answer_clarification', 'answer_decision', 'resume', 'cancel']);
  expect(after.commands[3].expectedVersion.revision).toBe(2);
  expect(after.commands[4]).toMatchObject({ kind: 'resume', actionId: 'resume-exact', expectedVersion: { revisionToken: 'v2' } });
  expect(after.commands[0].acceptanceCriteria).toHaveLength(2);
  expect(after.commands[0].constraints).toEqual(['Giữ tương thích']);

  // Request changes: the dock offers a fresh operation for the settled slot; the follow-up run opens from the panel.
  await host.call('configure', { phase: 'reviewing', revision: 3, cancelled: false });
  await page.getByRole('button', { name: 'Bắt đầu thao tác mới: Quyết định gói', exact: true }).click();
  await page.getByRole('button', { name: 'Xem xét gói' }).click();
  await page.getByLabel(/Lý do \(bắt buộc/).fill('Bổ sung tiêu chí hiệu năng');
  await page.getByRole('button', { name: 'Yêu cầu sửa', exact: true }).click();
  await expect.poll(async () => (await host.call('inspect')).currentRunId).toBe('follow-up');
  // RunView follows the continuation by itself once the old run stops being current (the Classic "Mở công việc hiện hành" link is only on screen for an instant, so it is not asserted); the dock keeps its own link.
  await expect(page).toHaveURL(/runs\/follow-up$/);
  await expect(page.getByRole('link', { name: 'Mở công việc tiếp nối →' }).first()).toBeVisible();
  await stableCount(() => effects('answer_decision'), 2);

  // Session stop and start from the server object.
  await mirror(page, /Máy chủ/);
  await page.getByRole('button', { name: 'Dừng phiên', exact: true }).click();
  await page.getByRole('button', { name: 'Gửi yêu cầu dừng phiên' }).click();
  await expect.poll(async () => (await host.call('inspect')).ready).toBe(false);
  await page.getByRole('button', { name: 'Khởi động phiên', exact: true }).click();
  await expect.poll(async () => (await host.call('inspect')).ready).toBe(true);
  expect((await host.call('inspect')).lifecycleCalls).toEqual(['stop', 'start']);
  for (const width of [1440, 1280, 768]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${width}`).toBe(true);
  }
  expect(csp).toEqual([]);
});

// One raycast smoke test: a real pointer click on the canvas, aimed from the projected label of a character (labels are DOM, the character stands just below its tag).
test('3D raycast smoke: clicking a character in the scene opens its inspector', async ({ page }) => {
  test.setTimeout(60000);
  const acceptance = await startAcceptanceHost();
  try {
    await openProject(page, acceptance.pairing, acceptance.repository, /thư viện.*Xem dự án/);
    await enterVisual(page);
    const tags = page.getByLabel('Cảnh văn phòng').locator('[data-kind="agent"]');
    await expect.poll(() => tags.count(), { timeout: 10000 }).toBeGreaterThan(0);
    // The camera settles while this runs: every poll aims at each tag on screen once. The final expectation is hard.
    const opened = async (): Promise<boolean> => {
      for (let i = 0; i < await tags.count(); i++) {
        const box = await tags.nth(i).boundingBox();
        if (!box) continue;
        for (const dy of [14, 28, 44, 60]) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height + dy);
          if (await page.getByRole('main').getByText('Mức tin cậy', { exact: true }).isVisible().catch(() => false)) return true;
        }
      }
      return false;
    };
    await expect.poll(opened, { timeout: 20000, message: 'a click on a character must open the agent inspector' }).toBe(true);
    await expect(page.getByRole('button', { name: 'Đóng bảng' })).toBeVisible();
  } finally { await acceptance.close(); }
});
