import { expect, test } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startAcceptanceHost, type AcceptanceHost } from './acceptance-fixture';

// Software GL so the check also runs on machines without a GPU. The server's real CSP headers apply; nothing is relaxed.
test.use({ launchOptions: { ...(process.env.BFLOW_WEB_TEST_BROWSER ? { executablePath: process.env.BFLOW_WEB_TEST_BROWSER } : {}), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

const CLIENT = 'dist/client';

test('classic bundle contains no pixi chunk', async () => {
  const html = await readFile(join(CLIENT, 'index.html'), 'utf8');
  const entry = /<script[^>]*src="\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
  expect(entry).toBeTruthy();
  expect(html).not.toMatch(/modulepreload/);
  const entryText = await readFile(join(CLIENT, entry!), 'utf8');
  const chunks = await readdir(join(CLIENT, 'assets'));
  const texts = await Promise.all(chunks.filter(f => f.endsWith('.js')).map(async f => [f, await readFile(join(CLIENT, 'assets', f), 'utf8')] as const));
  // Non-vacuous: Pixi really is in the build, in some other chunk.
  const pixi = texts.filter(([, t]) => t.includes('pixijs.com'));
  expect(pixi.length).toBeGreaterThan(0);
  expect(entryText).not.toContain('pixijs.com');
  for (const [name] of pixi) {
    if (name === entry!.slice('assets/'.length)) continue;
    // The entry may name a Pixi chunk only as a dynamic import(), never as a static import or re-export.
    expect(entryText).not.toMatch(new RegExp(`(?:^|[;}])\\s*(?:import|export)[^;()]*?from\\s*["'][^"']*${name.replace(/\W/g, '\\$&')}["']`));
  }
});

let host: AcceptanceHost;
test.beforeEach(async () => { host = await startAcceptanceHost(); });
test.afterEach(async () => { await host?.close(); });

test('office renders with zero CSP violations', async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', e => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Content Security Policy/i.test(m.text())) errors.push(m.text()); });
  await page.goto(host.pairing);
  await page.getByLabel('Đường dẫn Git tuyệt đối').fill(host.repository);
  await page.getByRole('button', { name: 'Đăng ký dự án' }).click();
  await page.getByRole('link', { name: /thư viện.*Xem dự án/ }).click();
  await page.getByRole('button', { name: 'Trực quan' }).click();
  const stage = page.getByLabel('Cảnh văn phòng');
  await expect(stage).toHaveAttribute('data-office-renderer', 'ready', { timeout: 20000 });
  const canvas = stage.locator('canvas');
  await expect(canvas).toHaveAttribute('aria-hidden', 'true');
  // The canvas is not blank: sample it through a screenshot of the element and require more than one colour.
  const shot = await canvas.screenshot();
  expect(shot.length).toBeGreaterThan(2000);
  // Leaving and re-entering destroys and rebuilds the renderer on the same cached assets.
  await page.getByRole('button', { name: 'Cổ điển' }).click();
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveCount(0);
  await page.getByRole('button', { name: 'Trực quan' }).click();
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-renderer', 'ready', { timeout: 20000 });
  // Camera keys act on the scene and never throw.
  await page.getByLabel('Cảnh văn phòng').focus();
  for (const key of ['+', 'ArrowLeft', '-', '0']) await page.keyboard.press(key);
  await page.screenshot({ path: 'dist/test-results/office-static.png' });
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(errors).toEqual([]);
});
