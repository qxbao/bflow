import { expect, test } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startAcceptanceHost, type AcceptanceHost } from './acceptance-fixture';

// Software GL so the check also runs on machines without a GPU. The server's real CSP headers apply; nothing is relaxed.
test.use({ launchOptions: { ...(process.env.BFLOW_WEB_TEST_BROWSER ? { executablePath: process.env.BFLOW_WEB_TEST_BROWSER } : {}), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

const CLIENT = 'dist/client';

type Chunk = { file: string; text: string };
/** Static edges only: `import"./x.js"`, `import ... from"./x.js"`, `export ... from"./x.js"`. Dynamic `import("...")` is excluded by the paren. */
const STATIC_EDGE = /(?:^|[;}\s])(?:import|export)\s*(?:[^'"();]*?\bfrom\s*)?["']([^"']+)["']/g;
const DYNAMIC_EDGE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const resolveFrom = (from: string, spec: string): string => new URL(spec, `http://chunk.invalid/${from}`).pathname.slice(1);
const edges = (re: RegExp, c: Chunk): string[] => [...c.text.matchAll(re)].map(m => resolveFrom(c.file, m[1]!));

test('classic bundle contains no three.js chunk', async () => {
  const html = await readFile(join(CLIENT, 'index.html'), 'utf8');
  const rootsFromHtml = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+\.js)"/g)].map(m => resolveFrom('index.html', m[1]!));
  expect(rootsFromHtml.length).toBeGreaterThan(0);
  const files = (await readdir(join(CLIENT, 'assets'))).filter(f => f.endsWith('.js')).map(f => `assets/${f}`);
  const chunks = new Map<string, Chunk>(await Promise.all(files.map(async file => [file, { file, text: await readFile(join(CLIENT, file), 'utf8') }] as const)));
  const closure = (starts: string[], withDynamic = false): Set<string> => {
    const seen = new Set<string>();
    const queue = [...starts];
    while (queue.length > 0) {
      const f = queue.pop()!;
      const chunk = chunks.get(f);
      if (!chunk || seen.has(f)) continue;
      seen.add(f);
      queue.push(...edges(STATIC_EDGE, chunk), ...(withDynamic ? edges(DYNAMIC_EDGE, chunk) : []));
    }
    return seen;
  };
  // three.js chunks are found by content, plus everything reachable (static or dynamic) from a chunk the entry loads through import() whose closure holds three.js: the lazy scene chunk and its helpers.
  const marker = (f: string): boolean => chunks.get(f)?.text.includes('THREE.WebGLRenderer') === true;
  const three = new Set(files.filter(marker));
  expect(three.size).toBeGreaterThan(0);
  const eager = closure(rootsFromHtml);
  expect(eager.size).toBeGreaterThan(0);
  const lazyTargets = [...eager].flatMap(f => edges(DYNAMIC_EDGE, chunks.get(f)!));
  const lazyThree = lazyTargets.filter(t => [...closure([t], true)].some(marker));
  expect(lazyThree.length, 'the entry must reach the scene only through import()').toBeGreaterThan(0);
  for (const t of lazyThree) for (const f of closure([t], true)) if (!eager.has(f)) three.add(f); // shared code (the entry itself) is legitimately eager
  const leaked = [...eager].filter(f => three.has(f));
  expect(leaked).toEqual([]);
  expect(html).not.toMatch(/modulepreload/);
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
  // Toggle fast, before the first renderer can be ready: overlapping creations must not break the live one.
  for (const name of ['Trực quan', 'Classic', 'Trực quan', 'Classic', 'Trực quan'] as const) await page.getByRole('button', { name, exact: true }).click();
  const stage = page.getByLabel('Cảnh văn phòng');
  await expect(stage).toHaveAttribute('data-office-renderer', 'ready', { timeout: 20000 });
  const canvas = stage.locator('canvas');
  await expect(canvas).toHaveAttribute('aria-hidden', 'true');
  // The canvas is not blank: decode a screenshot of the element in a blank page and require several distinct colours.
  await expect(stage.locator('canvas')).toHaveCount(1);
  const shot = (await canvas.screenshot()).toString('base64');
  const probe = await page.context().newPage();
  const colours = await probe.evaluate(async b64 => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 7) seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
    return seen.size;
  }, shot);
  await probe.close();
  expect(colours).toBeGreaterThan(8);
  // Leaving and re-entering destroys and rebuilds the renderer on the same cached assets.
  await page.getByRole('button', { name: 'Classic', exact: true }).click();
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveCount(0);
  await page.getByRole('button', { name: 'Trực quan', exact: true }).click();
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-renderer', 'ready', { timeout: 20000 });
  // Camera keys act on the scene and never throw.
  await page.getByLabel('Cảnh văn phòng').focus();
  for (const key of ['+', 'ArrowLeft', '-', '0']) await page.keyboard.press(key);
  await page.screenshot({ path: 'dist/test-results/office-3d.png' });
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(errors).toEqual([]);
});

test('toggling the mode many times does not leak WebGL contexts', async ({ page }) => {
  test.setTimeout(120000);
  // Record every WebGL context the page creates; a destroyed renderer must have lost its context (forceContextLoss).
  await page.addInitScript(() => {
    const all: WebGLRenderingContext[] = [];
    (window as unknown as { __gl: WebGLRenderingContext[] }).__gl = all;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      const ctx = (original as (...a: unknown[]) => RenderingContext | null).call(this, type, ...rest);
      if (ctx && /webgl/.test(type)) all.push(ctx as WebGLRenderingContext);
      return ctx;
    } as typeof original;
  });
  await page.goto(host.pairing);
  await page.getByLabel('Đường dẫn Git tuyệt đối').fill(host.repository);
  await page.getByRole('button', { name: 'Đăng ký dự án' }).click();
  await page.getByRole('link', { name: /thư viện.*Xem dự án/ }).click();
  const TOGGLES = 12;
  for (let i = 0; i < TOGGLES; i++) {
    await page.getByRole('button', { name: 'Trực quan' }).click();
    await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-renderer', 'ready', { timeout: 20000 });
    await page.getByRole('button', { name: 'Classic', exact: true }).click();
    await expect(page.getByLabel('Cảnh văn phòng')).toHaveCount(0);
  }
  const { created, alive } = await page.evaluate(() => {
    const all = (window as unknown as { __gl: WebGLRenderingContext[] }).__gl;
    return { created: all.length, alive: all.filter(g => !g.isContextLost()).length };
  });
  expect(created).toBeGreaterThanOrEqual(TOGGLES);
  expect(alive).toBe(0);
});
