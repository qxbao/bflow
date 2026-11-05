import { expect, test } from '@playwright/test';
import { startAcceptanceHost, type AcceptanceHost } from './acceptance-fixture';
import { browserOptions, enterVisual, openDock, openProject } from './office-fixture';

test.skip(!process.env.VITE_BFLOW_IMMERSIVE_OFFICE, 'Requires the immersive-office flag-on build.');
test.use(browserOptions());
expect.configure({ timeout: 15000 });

let host: AcceptanceHost;
test.beforeAll(async () => { host = await startAcceptanceHost(); });
test.afterAll(async () => { await host?.close(); });

test('task board deep links, history, modal review draft and stale revision stay safe across modes', async ({ page }) => {
  test.setTimeout(120000);
  const posts: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/commands')) posts.push(request.url()); });
  const base = await openProject(page, host.pairing, host.repository, /thư viện.*Xem dự án/);
  await enterVisual(page);

  await page.goto(new URL(`${base}/runs`, host.origin).href);
  const board = page.locator('[data-component="TaskBoard"]');
  await expect(board.getByRole('heading', { name: 'Việc đang diễn ra' })).toBeVisible();
  const card = board.getByRole('link', { name: /Tìm sách nhanh/ });
  await expect(card).toContainText('0/1 nhiệm vụ hoàn thành');
  await expect(card).toContainText('Đang chờ bạn');
  await card.click();
  await expect(page).toHaveURL(/\/runs\/run$/);
  await expect(page.getByRole('heading', { name: 'Tìm sách nhanh' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/runs$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/runs\/run$/);

  // Direct links retain the current run route; the review opens a real dialog above the scene.
  await page.goto(new URL(`${base}/runs/run`, host.origin).href);
  await expect(page.getByRole('button', { name: 'Mở nội dung cần quyết định' })).toBeVisible();
  await page.getByRole('button', { name: 'Mở nội dung cần quyết định' }).click();
  const taskDialog = page.getByRole('dialog', { name: /Quyết định phiên bản 1/ });
  await expect(taskDialog).toBeVisible();
  await expect(taskDialog.getByText(/Tài liệu kiểm chứng/).first()).toBeVisible();
  await taskDialog.getByRole('button', { name: 'Xem xét gói' }).click();
  const reason = taskDialog.getByLabel(/Lý do \(bắt buộc/);
  await reason.fill('Giữ lại bản nháp khi đổi chế độ và trang.');
  await page.keyboard.press('Escape');
  await expect(taskDialog).toBeHidden();
  await expect(page).toHaveURL(/\/runs\/run$/);
  await expect(page.getByRole('button', { name: 'Mở nội dung cần quyết định' })).toBeFocused();
  await page.getByRole('button', { name: 'Mở nội dung cần quyết định' }).click();
  await expect(taskDialog.getByLabel(/Lý do \(bắt buộc/)).toHaveValue('Giữ lại bản nháp khi đổi chế độ và trang.');
  await taskDialog.getByRole('button', { name: 'Quay lại công việc' }).click();

  // The same draft is available from the inbox, then remains available after revisiting the run detail.
  await page.getByRole('navigation', { name: 'Lối tắt' }).getByRole('button', { name: /Quyết định/ }).click();
  const inbox = page.locator('[data-component="DecisionInbox"]');
  await expect(inbox.getByRole('heading', { name: /Cần bạn quyết định/ })).toContainText('1');
  const request = inbox.getByRole('button', { name: /Duyệt gói thiết kế tìm kiếm/ });
  await request.click();
  await expect(page).toHaveURL(/decision=design/);
  let inboxDialog = page.getByRole('dialog', { name: /Duyệt gói thiết kế tìm kiếm/ });
  await expect(inboxDialog).toBeVisible();
  await expect(inboxDialog.getByLabel(/Lý do \(bắt buộc/)).toHaveValue('Giữ lại bản nháp khi đổi chế độ và trang.');
  await page.keyboard.press('Escape');
  await expect(inboxDialog).toBeHidden();
  await expect(page).toHaveURL(/\/review$/);
  await expect(request).toBeFocused();
  await request.click();
  await expect(page).toHaveURL(/decision=design/);
  inboxDialog = page.getByRole('dialog', { name: /Duyệt gói thiết kế tìm kiếm/ });
  await expect(inboxDialog.getByLabel(/Lý do \(bắt buộc/)).toHaveValue('Giữ lại bản nháp khi đổi chế độ và trang.');
  await inboxDialog.getByRole('link', { name: /Mở công việc liên quan/ }).click();
  await expect(page).toHaveURL(/\/runs\/run$/);
  await page.getByRole('button', { name: 'Mở nội dung cần quyết định' }).click();
  const revisited = page.getByRole('dialog', { name: /Quyết định phiên bản 1/ });
  await expect(revisited.getByLabel(/Lý do \(bắt buộc/)).toHaveValue('Giữ lại bản nháp khi đổi chế độ và trang.');
  await revisited.getByRole('button', { name: 'Quay lại công việc' }).click();
  await page.getByRole('button', { name: 'Đóng bảng' }).click();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  await page.getByRole('button', { name: 'Web', exact: true }).click();
  await page.getByRole('link', { name: 'Công việc', exact: true }).click();
  await page.getByRole('link', { name: /Tìm sách nhanh/ }).click();
  const classicReason = page.getByLabel(/Lý do \(bắt buộc/);
  await expect(classicReason).toHaveValue('Giữ lại bản nháp khi đổi chế độ và trang.');
  await classicReason.fill('Đã sửa trong chế độ Web, giữ bản nháp này.');
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mở nội dung cần quyết định' })).toBeVisible();
  await page.getByRole('button', { name: 'Mở nội dung cần quyết định' }).click();
  const revisitedAfterMode = page.getByRole('dialog', { name: /Quyết định phiên bản 1/ });
  await expect(revisitedAfterMode.getByLabel(/Lý do \(bắt buộc/)).toHaveValue('Đã sửa trong chế độ Web, giữ bản nháp này.');

  // Refreshing newer authority marks the pinned draft stale. It is not submitted until the user explicitly reads the new version.
  await revisitedAfterMode.getByRole('button', { name: 'Quay lại công việc' }).click();
  await host.call('configure', { bump: true });
  await expect.poll(async () => (await host.call('inspect')).revision).toBe(2);
  await page.getByRole('button', { name: 'Mở nội dung cần quyết định' }).click();
  const staleDialog = page.getByRole('dialog', { name: /Quyết định phiên bản 2/ });
  await expect(staleDialog.getByRole('button', { name: 'Đọc lại gói hiện hành' })).toBeVisible();
  await expect(staleDialog.getByText(/Gói xem xét · Phiên bản 1/)).toBeVisible();
  expect(posts).toEqual([]);
  await staleDialog.getByRole('button', { name: 'Đọc lại gói hiện hành' }).click();
  await staleDialog.getByRole('button', { name: 'Xem xét gói' }).click();
  await expect(staleDialog.getByLabel(/Lý do \(bắt buộc/)).toHaveValue('Đã sửa trong chế độ Web, giữ bản nháp này.');
  await staleDialog.getByRole('button', { name: 'Duyệt gói', exact: true }).click();
  await expect.poll(async () => (await host.call('inspect')).effects.filter((effect: string) => effect === 'answer_decision').length).toBe(1);
  const approved = await host.call('inspect');
  expect(approved.commands.filter((command: any) => command.kind === 'answer_decision')).toHaveLength(1);
  expect(approved.commands.find((command: any) => command.kind === 'answer_decision')).toMatchObject({ runId: 'run', decisionId: 'design', expectedVersion: { revision: 2 }, outcome: 'approved' });
  await openDock(page);
  await expect(page.getByText('Đã áp dụng thao tác. Trạng thái công việc được đọc riêng.')).toBeVisible();

  // The surrounding foreground stays centered and the WebGL scene remains visible at both sides of the legacy breakpoint.
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await page.getByRole('main').boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThan(2);
    await expect(page.getByLabel('Cảnh văn phòng')).toBeVisible();
  }
});
