import { expect, test, type Page } from '@playwright/test';
import { startAcceptanceHost, type AcceptanceHost } from './acceptance-fixture';
import { browserOptions, enterVisual, mirror, rail, workforceBody } from './office-fixture';
// V8.5: keyboard-only use, reduced motion and the four target widths of the 3D mode, in real Chrome against the real Local Server.
test.use(browserOptions());
let host: AcceptanceHost;
test.beforeEach(async () => { host = await startAcceptanceHost(); });
test.afterEach(async () => { await host?.close(); });

async function open(page: Page, developers = 3): Promise<void> {
  await page.route('**/api/v1/projects/*/workforce', route => route.fulfill({ json: workforceBody(new URL(route.request().url()).pathname.split('/')[4]!, { developers }) }));
  await page.goto(host.pairing);
  await page.getByLabel('Đường dẫn Git tuyệt đối').fill(host.repository);
  await page.getByRole('button', { name: 'Đăng ký dự án' }).click();
  await page.getByRole('link', { name: /thư viện.*Xem dự án/ }).click();
  await enterVisual(page);
  await expect(page.getByLabel('Bản văn bản của văn phòng').getByRole('button', { name: /\(Lập trình viên\)/ })).toHaveCount(developers);
}
const stageShot = async (page: Page): Promise<string> => (await page.getByLabel('Cảnh văn phòng').locator('canvas').screenshot()).toString('base64');
/** What is focused, as a stable description. */
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return { name: '', area: 'body', ring: false };
  const style = getComputedStyle(el);
  const area = el.closest('[aria-label="Bản văn bản của văn phòng"]') ? 'mirror' : el.closest('[aria-label="Lối tắt"]') ? 'rail' : el.closest('#office-hud') ? 'hud' : el.closest('#main') ? 'panel' : el.getAttribute('aria-label') === 'Cảnh văn phòng' ? 'stage' : 'other';
  return { name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 60), area, ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 };
});

test('keyboard only: Tab reaches the HUD, the stage and every mirror object; arrows, plus, minus and 0 drive the camera; Esc closes the panel', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  // Reduced motion keeps the clips still, so the picture after `0` can be compared with the initial one exactly.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  // Tab order: collect until the cycle leaves the page or 80 stops.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const seen: { name: string; area: string; ring: boolean }[] = [];
  for (let i = 0; i < 80; i++) { await page.keyboard.press('Tab'); seen.push(await focused(page)); }
  const areas = new Set(seen.map(s => s.area));
  for (const area of ['hud', 'rail', 'stage', 'mirror']) expect(areas.has(area), `Tab reaches ${area}`).toBe(true);
  const names = seen.filter(s => s.area === 'mirror').map(s => s.name).join('\n');
  for (const part of [/Conversation/, /Điều phối viên/, /Developer #1/, /Quầy Conversation/, /Bảng nhiệm vụ/, /Hộp thư/, /Tủ tài liệu/, /Máy chủ/, /Bảng cài đặt/, /Cửa ra vào/]) expect(names).toMatch(part);
  // Every stop shows a visible focus indicator.
  expect(seen.filter(s => s.area !== 'body' && !s.ring).map(s => `${s.area}:${s.name}`)).toEqual([]);
  // The mirror shows itself while it holds focus.
  await page.getByLabel('Bản văn bản của văn phòng').getByRole('button', { name: /Quầy Conversation/ }).focus();
  const box = await page.getByLabel('Bản văn bản của văn phòng').boundingBox();
  expect(box && box.width > 100 && box.height > 100).toBe(true);

  // Camera keys on the stage change the picture; 0 fits the view again.
  const stage = page.getByLabel('Cảnh văn phòng');
  await stage.focus();
  await page.waitForTimeout(500);
  const before = await stageShot(page);
  await page.keyboard.press('+'); await page.waitForTimeout(700);
  const zoomed = await stageShot(page);
  expect(zoomed).not.toBe(before);
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(700);
  const panned = await stageShot(page);
  expect(panned).not.toBe(zoomed);
  await page.keyboard.press('-'); await page.waitForTimeout(700);
  expect(await stageShot(page)).not.toBe(panned);
  await page.keyboard.press('0'); await page.waitForTimeout(900);
  expect(await stageShot(page)).toBe(before);

  // Enter on a mirror agent opens the inspector; Esc closes it and returns focus to that button.
  const agent = page.getByLabel('Bản văn bản của văn phòng').getByRole('button', { name: /Developer #1/ });
  await agent.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('#main')).toContainText('Developer 1');
  await page.keyboard.press('Escape');
  await expect(page.locator('#main')).toBeHidden();
  await expect(agent).toBeFocused();
  // The same from a rail button.
  await rail(page, /^Tổng quan/).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#main')).toBeHidden();
  await expect(rail(page, /^Tổng quan/)).toBeFocused();
  // Esc pressed while focus is in the HUD (not in the panel) closes the panel too.
  await rail(page, /^Tổng quan/).click();
  await expect(page.locator('#main')).toBeVisible();
  await page.getByRole('group', { name: 'Góc nhìn camera' }).getByRole('button', { name: 'Toàn cảnh' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#main')).toBeHidden();
  // A mirror object opens its page and Esc comes back.
  await mirror(page, /Hộp thư/);
  await expect(page.locator('#main')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#main')).toBeHidden();
  expect(errors).toEqual([]);
});

test('reduced motion: the scene still renders, nothing animates in the HTML and the preference reaches the page', async ({ page }) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  // CSS animations and transitions are switched off by the global rule; opening the panel must not leave a running animation.
  await rail(page, /^Tổng quan/).click();
  await expect(page.locator('#main')).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
  // A mode round trip still works with the preference on.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Web', exact: true }).click();
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveCount(0);
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-renderer', 'ready', { timeout: 20000 });
});

for (const width of [375, 768, 1280, 1440]) {
  test(`${width}px: no horizontal scroll, HUD controls do not overlap and labels stay clear of them`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: width < 768 ? 740 : 800 });
    await open(page, 5);
    await page.waitForTimeout(800);
    const result = await page.evaluate(() => {
      const root = document.documentElement;
      const rects = (els: Element[]) => els.map(e => ({ name: (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 40), r: e.getBoundingClientRect() })).filter(x => x.r.width > 0 && x.r.height > 0);
      const hud = document.getElementById('office-hud')!;
      const controls = rects([...hud.querySelectorAll('button, input, select, a[href]')]);
      const overlap = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      const clashes: string[] = [];
      for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) if (overlap(controls[i]!.r, controls[j]!.r)) clashes.push(`${controls[i]!.name} x ${controls[j]!.name}`);
      const outside = controls.filter(c => c.r.left < -0.5 || c.r.right > innerWidth + 0.5 || c.r.top < -0.5 || c.r.bottom > innerHeight + 0.5).map(c => c.name);
      // Name tags only: a message box is wider than the safe-area test its anchor passes, and it is decoration over the character (aria-hidden), not a control label.
      const labels = rects([...document.querySelectorAll('[aria-label="Cảnh văn phòng"] [data-kind="agent"]')]);
      const covered = labels.filter(l => controls.some(c => overlap(l.r, c.r))).map(l => l.name);
      const small = controls.filter(c => c.r.height < 32 || c.r.width < 32).map(c => `${c.name} ${Math.round(c.r.width)}x${Math.round(c.r.height)}`);
      return { scrollW: root.scrollWidth, bodyW: document.body.scrollWidth, innerW: innerWidth, controls: controls.length, labels: labels.length, clashes, outside, covered, small };
    });
    expect(result.scrollW).toBeLessThanOrEqual(result.innerW);
    expect(result.bodyW).toBeLessThanOrEqual(result.innerW);
    expect(result.controls).toBeGreaterThan(10);
    expect(result.clashes).toEqual([]);
    expect(result.outside).toEqual([]);
    expect(result.covered).toEqual([]);
    expect(result.small).toEqual([]);
    // The panel opens inside the viewport too, full width on a phone.
    await rail(page, /^Tổng quan/).click();
    const panel = await page.locator('#main').boundingBox();
    expect(panel && panel.x >= -0.5 && panel.x + panel.width <= width + 0.5).toBe(true);
    if (width < 768) expect(Math.round(panel!.width)).toBe(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `dist/test-results/office-a11y-${width}.png` });
  });
}
