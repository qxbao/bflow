import { expect, test } from '@playwright/test';
import { startAcceptanceHost, type AcceptanceHost } from './acceptance-fixture';
import { browserOptions, enterVisual, mirror, openProject, rail, workforceBody } from './office-fixture';
// V8.4: the W09 security acceptance rows through the 3D mode. Real Chrome (software GL), the real Local Server stack and the same deterministic host.
test.use(browserOptions());
expect.configure({ timeout: 15000 });
let host: AcceptanceHost;
test.beforeEach(async () => { host = await startAcceptanceHost(); });
test.afterEach(async () => { await host?.close(); });

test('3D AC09 pairing and the mode switch leave no secret in the URL, storage or cookie jar', async ({ page, context }) => {
  const dialogs: string[] = []; page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });
  const secret = new URLSearchParams(new URL(host.pairing).hash.slice(1)).get('bootstrap')!;
  await openProject(page, host.pairing, host.repository, /thư viện.*Xem dự án/);
  await enterVisual(page);
  // Exercise the 3D surfaces that read data (panel, cabinet, server) before looking at what the browser kept.
  await rail(page, 'Tổng quan').click();
  await rail(page, 'Tài liệu').click();
  await mirror(page, /Máy chủ/);
  const traces = await page.evaluate(() => JSON.stringify({ href: location.href, ls: { ...localStorage }, ss: { ...sessionStorage }, cookie: document.cookie, title: document.title, html: document.documentElement.outerHTML.includes('bootstrap') }));
  expect(traces).not.toContain(secret);
  const parsed = JSON.parse(traces) as { ls: Record<string, string>; ss: Record<string, string>; cookie: string; html: boolean };
  expect(parsed.cookie).toBe('');
  expect(parsed.html).toBe(false);
  // The only convenience stored for 3D is the mode flag; nothing identifies the session, the CSRF token or the pairing code.
  expect(parsed.ls['bflow:ui:mode']).toBe('visual');
  for (const [key, value] of Object.entries({ ...parsed.ls, ...parsed.ss })) {
    expect(`${key}=${value}`, key).not.toMatch(/csrf|bootstrap|bflow_session|token|secret/i);
  }
  const [cookie] = await context.cookies(host.origin);
  expect(cookie).toMatchObject({ name: 'bflow_session', httpOnly: true, sameSite: 'Strict', domain: '127.0.0.1' });
  expect(dialogs).toEqual([]);
});

test('3D AC09 malicious HTML/SVG artifacts stay inert in the cabinet inspector; Markdown renders as text, never markup', async ({ page }) => {
  test.setTimeout(60000);
  const dialogs: string[] = []; page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });
  const violations: string[] = [];
  page.on('console', m => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  const base = await openProject(page, host.pairing, host.repository, /thư viện.*Xem dự án/);
  await enterVisual(page);
  await rail(page, 'Tài liệu').click();
  const cabinet = page.getByLabel('Tủ tài liệu');
  const sections = cabinet.locator('section.evidence');
  await expect(sections).toHaveCount(3);
  // HTML and SVG: the safe reader refuses inline rendering and explains download-only.
  for (const index of [0, 1]) {
    await sections.nth(index).getByRole('button', { name: 'Đọc nội dung an toàn' }).click();
    await expect(sections.nth(index).getByRole('alert')).toContainText('chỉ hỗ trợ tải xuống');
  }
  // Markdown with a script tag and a javascript: link is shown verbatim as text.
  await sections.nth(2).getByRole('button', { name: 'Đọc nội dung an toàn' }).click();
  await expect(sections.nth(2).getByLabel('Nội dung tài liệu')).toContainText('<script>alert("md-xss")</script>');
  expect(await page.locator('section.evidence script, section.evidence a[href^="javascript:"], section.evidence img, section.evidence svg').count()).toBe(0);
  // No executable content outside the app's own bundle: nothing injected into the document, nothing in the scene host.
  expect(await page.locator('script:not([src])').count()).toBe(0);
  expect(await page.getByLabel('Cảnh văn phòng').locator('script, iframe, object, embed').count()).toBe(0);
  const [download] = await Promise.all([page.waitForEvent('download'), sections.nth(0).getByRole('link', { name: 'Tải tài liệu' }).click()]);
  expect(await download.failure()).toBeNull();
  // The server still labels every artifact response as an attachment/sandboxed text, whatever surface asked for it.
  for (const [id, inline] of [['artifact-html', false], ['artifact-svg', false], ['artifact-md', true]] as const) {
    const r = await page.request.get(new URL(`/api/v1${base}/artifacts/${id}`, host.origin).href);
    expect(r.status(), id).toBe(200);
    const h = r.headers();
    expect(h['content-type']).toBe(inline ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    expect(h['content-disposition']).toMatch(inline ? /^inline;/ : /^attachment;/);
    expect(h['content-security-policy']).toContain('sandbox');
    expect(h['x-content-type-options']).toBe('nosniff');
  }
  // The same evidence reached from the run page of the panel is the same component with the same policy.
  await mirror(page, /Bảng nhiệm vụ/);
  await page.getByRole('link', { name: 'Tìm sách nhanh', exact: true }).first().click();
  await expect(page.locator('section.evidence')).toHaveCount(3);
  const reads = (await host.call('inspect')).artifactReads as string[];
  expect(reads).toEqual(expect.arrayContaining(['artifact-html', 'artifact-svg', 'artifact-md']));
  expect(dialogs).toEqual([]);
  expect(violations).toEqual([]);
});

test('3D hostile project name, run title and agent name stay inert text in the scene labels, HUD, mirror and inspector', async ({ page }) => {
  test.setTimeout(60000);
  const dialogs: string[] = []; page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const violations: string[] = []; page.on('console', m => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  const name = '<img src=x onerror=alert(1)>', title = '<script>alert(2)</script><b>run</b>';
  // The host stays unchanged: the hostile strings are injected into its real responses.
  await page.route(/\/api\/v1\/projects(\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch(); const body = await response.json();
    await route.fulfill({ response, json: { ...body, items: body.items.map((p: any) => ({ ...p, displayName: name })) } });
  });
  await page.route(/\/api\/v1\/projects\/[^/]+\/runs(\/run)?(\?.*)?$/, async route => {
    const response = await route.fetch(); const body = await response.json();
    await route.fulfill({ response, json: body.items ? { ...body, items: body.items.map((r: any) => ({ ...r, title })) } : { ...body, title } });
  });
  await page.route('**/api/v1/projects/*/workforce', route => route.fulfill({ json: (() => {
    const view = workforceBody(new URL(route.request().url()).pathname.split('/')[4]!, { developers: 1 }) as any;
    view.agents = view.agents.map((a: any) => ({ ...a, displayName: name }));
    return view;
  })() }));
  await openProject(page, host.pairing, host.repository, /Xem dự án/);
  await enterVisual(page);
  const hud = page.getByRole('region', { name: 'Văn phòng Bflow' });
  await expect(hud).toContainText(title);
  await expect(hud.getByRole('option', { name })).toHaveCount(1);
  const mirrorRegion = page.getByLabel('Bản văn bản của văn phòng');
  await expect(mirrorRegion).toContainText(name);
  // The labels over the characters are plain text nodes.
  await expect(page.getByLabel('Cảnh văn phòng').locator('[data-kind]').first()).toBeVisible();
  expect(await page.getByLabel('Cảnh văn phòng').locator('[data-kind] *').count()).toBe(0);
  // Inspector: the agent display name and the run title on the task board are text too.
  await mirrorRegion.getByRole('button', { name: /\(Điều phối viên\)/ }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toContainText(name);
  await mirror(page, /Bảng nhiệm vụ/);
  await expect(page.locator('#main')).toContainText(title);
  expect(await page.locator('img[src="x"], b, [onerror], script:not([src])').count()).toBe(0);
  expect(dialogs).toEqual([]); expect(errors).toEqual([]); expect(violations).toEqual([]);
});
