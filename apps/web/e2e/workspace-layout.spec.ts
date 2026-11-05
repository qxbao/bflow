import { expect, test } from '@playwright/test';
import { startAcceptanceHost, type AcceptanceHost } from './acceptance-fixture';
import { browserOptions, enterVisual, mirror, openProject, sceneReady } from './office-fixture';

test.use({ ...browserOptions(), viewport: { width: 1440, height: 900 } });
let host: AcceptanceHost;
test.beforeEach(async () => { host = await startAcceptanceHost(); });
test.afterEach(async () => { await host?.close(); });

test('3D reserves real space for the panel and adapts all pages to its content width', async ({ page }) => {
  test.setTimeout(120000);
  const base = await openProject(page, host.pairing, host.repository, /thư viện.*Xem dự án/);
  await enterVisual(page);
  await sceneReady(page);
  await page.getByRole('navigation', { name: 'Lối tắt' }).getByRole('button', { name: 'Tổng quan' }).click();
  const main = page.locator('#main'), scene = page.getByLabel('Cảnh văn phòng', { exact: true });
  await expect(main).toBeVisible();
  for (const width of [1920, 1440, 1280, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => {
      const a = await scene.boundingBox(), b = await main.boundingBox();
      return { width, scene:a, panel:b, valid:Boolean(a && b && a.x + a.width <= b.x + 1 && a.width >= 500 && b.width >= 420) };
    }).toEqual(expect.objectContaining({valid:true}));
  }
  for (const width of [1099, 1024, 768, 375, 812]) {
    await page.setViewportSize({ width, height: width === 812 ? 375 : 900 });
    await expect(main).toBeVisible();
    expect(await main.evaluate(e => e.getBoundingClientRect().width)).toBe(width);
    await expect(page.getByRole('button', { name: 'Đóng bảng' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:`dist/test-results/workspace-3d-${width}.png`});
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const path of ['runs', 'review', 'agents', 'issues', 'settings', 'chat']) {
    await page.goto(host.origin + base + '/' + path);
    await expect(main).toBeVisible();
    expect(await main.evaluate(e => e.scrollWidth <= e.clientWidth + 1), path).toBe(true);
  }
  await page.getByRole('button', { name: 'Đóng bảng' }).click();
  await expect(main).toBeHidden();
  await expect.poll(async () => (await scene.boundingBox())?.width).toBe(1440);
});

test('conversation history can be tucked away without losing the thread or draft', async ({ page }) => {
  const base = await openProject(page, host.pairing, host.repository, /thư viện.*Xem dự án/);
  await page.goto(host.origin + base + '/chat');
  const history = page.getByRole('button', { name: 'Lịch sử trò chuyện' });
  await expect(history).toBeVisible();
  await expect(history).toHaveAttribute('aria-expanded', 'true');
  await history.click();
  await expect(history).toHaveAttribute('aria-expanded', 'false');
  await history.click();
  await expect(history).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('navigation', { name: 'Trò chuyện theo công việc' }).getByRole('link').first().click();
  const draft = page.getByLabel('Tin nhắn cho trợ lý');
  await draft.fill('Bản nháp tiếng Việt vẫn còn khi đổi bố cục');
  await history.click();
  await history.click();
  await expect(draft).toHaveValue('Bản nháp tiếng Việt vẫn còn khi đổi bố cục');
  await enterVisual(page);
  await expect(draft).toHaveValue('Bản nháp tiếng Việt vẫn còn khi đổi bố cục');
  const log = page.getByRole('log', { name: 'Tin nhắn', exact: true });
  await expect(log).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(log).toBeInViewport();
  await expect(draft).toBeInViewport();
  expect(await draft.evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(72);
  const send = page.getByRole('button',{name:'Gửi tin nhắn'});
  const bounds = await page.locator('.chat-layout').boundingBox(), sendBounds = await send.boundingBox();
  expect(bounds && sendBounds && sendBounds.y+sendBounds.height <= bounds.y+bounds.height+1).toBe(true);
  await page.screenshot({path:'dist/test-results/workspace-chat-375.png'});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('a selected employee stays in the visible scene when the panel and viewport resize', async ({ page }) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await openProject(page, host.pairing, host.repository, /thư viện.*Xem dự án/);
  await enterVisual(page);
  await mirror(page, /^Coordinator \(Điều phối viên\)/);
  const scene=page.getByLabel('Cảnh văn phòng',{exact:true});
  const label=scene.locator('[data-kind="agent"]').filter({hasText:/^Coordinator/});
  for(const width of [1920,1280,1100,1440]) {
    await page.setViewportSize({width,height:900});
    await expect.poll(async()=>{
      const box=await scene.boundingBox(),tag=await label.boundingBox();
      return Boolean(box&&tag&&tag.x>=box.x+100&&tag.x+tag.width<=box.x+box.width);
    }).toBe(true);
  }
  await page.screenshot({path:'dist/test-results/workspace-selected-employee.png'});
});
