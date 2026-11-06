import { expect, test } from '@playwright/test';
import { startAcceptanceHost, type AcceptanceHost } from './acceptance-fixture';
import { browserOptions, enterVisual, mirror, openProject, workforceBody } from './office-fixture';

test.skip(!process.env.VITE_BFLOW_IMMERSIVE_OFFICE, 'Requires the immersive-office flag-on build.');
test.use(browserOptions());
expect.configure({ timeout: 15000 });

let host: AcceptanceHost;
test.beforeAll(async () => { host = await startAcceptanceHost(); });
test.afterAll(async () => { await host?.close(); });

test('three-step guide replays, notices open the inbox, and agent details retain uncertainty and terminal disclaimers', async ({ page }) => {
  await page.route(/\/api\/v1\/projects\/[^/]+\/workforce$/, async route => {
    const path = new URL(route.request().url()).pathname.split('/');
    const projectId = decodeURIComponent(path[path.length - 2]!);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workforceBody(projectId, { handoffState: 'unknown_delivery' })) });
  });
  const base = await openProject(page, host.pairing, host.repository, /thư viện.*Xem dự án/);
  await enterVisual(page);

  const guide = page.getByRole('region', { name: 'Hướng dẫn lần đầu' });
  await expect(guide).toContainText('Bắt đầu · 1/3');
  await guide.getByRole('button', { name: 'Tiếp' }).click();
  await expect(guide).toContainText('Bắt đầu · 2/3');
  await guide.getByRole('button', { name: 'Bỏ qua' }).click();
  const key = await page.evaluate(() => Object.keys(localStorage).find(value => value.startsWith('bflow:immersive-office:first-visit:')));
  expect(key).toBeTruthy();
  expect(await page.evaluate(keyName => localStorage.getItem(keyName!), key)).toBe('dismissed');
  await page.locator('.office-topbar').getByRole('button', { name: 'Xem lại hướng dẫn' }).click();
  await expect(guide).toContainText('Bắt đầu · 1/3');

  const commands: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/commands')) commands.push(request.url()); });
  await page.getByRole('button', { name: /1 yêu cầu cần bạn trả lời/ }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.locator('[data-component="DecisionInbox"]')).toBeVisible();
  expect(commands).toEqual([]);
  await page.locator('#main').getByRole('button', { name: /^Đóng cửa sổ/ }).click();

  await mirror(page, /Coordinator/);
  const agent = page.locator('[data-component="AgentDialogue"]');
  await expect(agent).toContainText('Chưa xác định từ dữ liệu hiện có.');
  await expect(agent).toContainText('không xác nhận công việc đã hoàn tất');
  await expect(agent.getByRole('link', { name: /Xem công việc/ })).toHaveAttribute('href', new RegExp(`${base}/runs/run$`));
  await agent.locator('details > summary').click();
  await expect(agent).toContainText('không phải bằng chứng hoàn thành công việc');
  await expect(agent).toContainText('có thể thiếu');
  expect(commands).toEqual([]);
});
