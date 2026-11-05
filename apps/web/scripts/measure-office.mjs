#!/usr/bin/env node
// V8.6 repeatable measurement of the 3D office in real Chrome. Not part of any default test run.
//
//   pnpm --filter @bflow/web build
//   node apps/web/scripts/measure-office.mjs [--gl=auto|hardware|swiftshader] [--agents=30] [--toggles=20] [--assets=/abs/web/dist/client] [--cli=/abs/cli] [--out=file.json]
//
// It reports numbers only; it asserts nothing and loosens nothing. The budget comparison is printed beside each number.
// `--gl=auto` tries hardware GL first (headed when a display exists) and falls back to SwiftShader; the report says which one ran.
// Fixtures and software GL are not live Herdr/provider evidence.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const GL = arg('gl', 'auto'), AGENTS = Number(arg('agents', '30')), TOGGLES = Number(arg('toggles', '20')), OUT = arg('out', '');
const ASSETS = resolve(arg('assets', join(web, 'dist/client'))), CLI = resolve(arg('cli', resolve(web, '../cli')));
const BROWSER = process.env.BFLOW_WEB_TEST_BROWSER;
const BUDGET = { chunkGzipKiB: 250, assetsMiB: 4, movingFps: 30, idleFps: 8, hiddenFrames: 0, longTaskMs: 50 };

// ---- static: chunk and asset sizes ----
async function sizes() {
  const dist = ASSETS;
  const files = await readdir(join(dist, 'assets'));
  const out = { chunks: [], assets: [] };
  for (const f of files.filter(f => f.endsWith('.js'))) {
    const body = await readFile(join(dist, 'assets', f));
    out.chunks.push({ file: f, rawKiB: +(body.length / 1024).toFixed(1), gzipKiB: +(gzipSync(body, { level: 9 }).length / 1024).toFixed(1), threeJs: body.includes('THREE.WebGLRenderer') });
  }
  for (const f of await readdir(join(dist, 'office'))) {
    if (f === 'LICENSE.txt') continue;
    out.assets.push({ file: f, kiB: +((await stat(join(dist, 'office', f))).size / 1024).toFixed(1) });
  }
  out.graphicsChunkGzipKiB = out.chunks.filter(c => c.threeJs).reduce((n, c) => n + c.gzipKiB, 0);
  out.assetsTotalMiB = +(out.assets.reduce((n, a) => n + a.kiB, 0) / 1024).toFixed(3);
  return out;
}

// ---- the acceptance host (same stdin/IPC pattern as e2e/acceptance-fixture.ts) ----
async function startHost() {
  const child = spawn(process.execPath, ['--input-type=module'], { cwd: CLI, env: { ...process.env, W09_ASSETS: ASSETS }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.stdin.end(await readFile(join(web, 'e2e/acceptance-host.mjs'), 'utf8'));
  const ready = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('host did not start')), 15000);
    child.on('message', raw => { if (raw.ready) { clearTimeout(timer); accept(raw); } });
    child.once('exit', code => { if (code) reject(new Error('host exited')); });
  });
  return { pairing: ready.pairing, repository: ready.repository, close() { if (child.connected) child.send({ kind: 'close' }); setTimeout(() => child.kill(), 3000).unref(); } };
}

/** 10 role agents plus the rest as developers (max 20 seated). Same shape as e2e/office-fixture.ts workforceBody. */
function workforce(projectId, total) {
  const at = new Date().toISOString();
  const roles = [['conversation', 'conversation'], ['coordinator', 'coordination'], ['planner', 'coordination'], ['architect', 'coordination'], ['specifier', 'coordination'], ['tester', 'verification'], ['reviewer', 'verification'], ['qa', 'verification'], ['security', 'verification'], ['reviewer', 'verification']];
  const agent = (i, role, group, permanent) => ({ instanceId: `agent-${role}-${i}`, role, displayName: `${role} ${i}`, group, permanent, provider: i % 2 ? 'claude' : 'codex', allocation: 'active', transport: { state: i % 3 === 0 ? 'idle' : 'working', observedAt: at }, boundAt: at, work: [] });
  const agents = roles.slice(0, Math.min(roles.length, total)).map(([role, group], i) => agent(i, role, group, true));
  for (let i = 0; agents.length < total; i++) agents.push(agent(100 + i, 'developer', 'developer_worktree', false));
  return { apiVersion: 1, projectId, sessionId: 'fixture-host', revisionToken: 'w1', truncated: false, observedAt: at, agents, handoffs: [] };
}

const INIT = () => {
  const w = window;
  w.__m = { frames: [], long: [], gl: [] };
  // A frame is a clear of the default framebuffer: shadow maps and other targets are bound to a render target and do not count.
  const proto = w.WebGL2RenderingContext?.prototype;
  if (proto) {
    const bind = proto.bindFramebuffer, clear = proto.clear;
    proto.bindFramebuffer = function (target, fb) { this.__fb = fb; return bind.call(this, target, fb); };
    proto.clear = function (mask) { if (!this.__fb) w.__m.frames.push(performance.now()); return clear.call(this, mask); };
  }
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = original.call(this, type, ...rest);
    if (ctx && /webgl/.test(type)) w.__m.gl.push(ctx);
    return ctx;
  };
  new PerformanceObserver(list => { for (const e of list.getEntries()) w.__m.long.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true });
};

const summarize = (frames, from, to, longs) => {
  const inWin = frames.filter(t => t >= from && t < to);
  const gaps = inWin.slice(1).map((t, i) => t - inWin[i]);
  const burst = gaps.filter(g => g < 150);
  const fast = gaps.filter(g => g < 60); // consecutive moving frames; the 8 fps idle gaps (~125 ms) between camera moves are left out
  const sorted = [...gaps].sort((a, b) => a - b);
  const longTasks = longs.filter(l => l.start >= from && l.start < to);
  return {
    windowMs: Math.round(to - from), frames: inWin.length, fpsOverWindow: +(inWin.length / ((to - from) / 1000)).toFixed(2),
    fpsWhileRunning: burst.length ? +(1000 / (burst.reduce((n, g) => n + g, 0) / burst.length)).toFixed(2) : 0,
    fpsFastBursts: fast.length ? +(1000 / (fast.reduce((n, g) => n + g, 0) / fast.length)).toFixed(2) : 0, fastFrameShare: gaps.length ? +(fast.length / gaps.length).toFixed(2) : 0,
    medianGapMs: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(1) : 0,
    p95GapMs: sorted.length ? +sorted[Math.floor(sorted.length * 0.95)].toFixed(1) : 0,
    longTasks: longTasks.length, longestMs: longTasks.reduce((n, l) => Math.max(n, l.duration), 0),
  };
};

async function launch(mode) {
  const display = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const args = mode === 'hardware' ? ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const headless = mode === 'hardware' ? !display : true;
  return { browser: await chromium.launch({ ...(BROWSER ? { executablePath: BROWSER } : {}), headless, args }), headless };
}

async function rendererName(browser) {
  const page = await browser.newPage();
  const name = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  });
  await page.close();
  return name;
}
const software = name => !name || /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(name);

async function measure(browser, host) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(INIT);
  await page.route('**/api/v1/projects/*/workforce', route => route.fulfill({ json: workforce(new URL(route.request().url()).pathname.split('/')[4], AGENTS) }));
  const cdp = await context.newCDPSession(page);
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); const { usedSize } = await cdp.send('Runtime.getHeapUsage'); return +(usedSize / 1048576).toFixed(2); };
  await page.goto(host.pairing);
  await page.getByLabel('Đường dẫn Git tuyệt đối').fill(host.repository);
  await page.getByRole('button', { name: 'Đăng ký dự án' }).click();
  await page.getByRole('link', { name: /Xem dự án/ }).click();
  const stage = page.getByLabel('Cảnh văn phòng');
  const enter = async () => { await page.getByRole('button', { name: '3D', exact: true }).click(); await stage.waitFor(); await page.waitForFunction(() => document.querySelector('[aria-label="Cảnh văn phòng"]')?.getAttribute('data-office-renderer') === 'ready', null, { timeout: 60000 }); };
  const leave = async () => { await page.getByRole('button', { name: 'Web', exact: true }).click(); await stage.waitFor({ state: 'detached' }); };
  const t = () => page.evaluate(() => performance.now());
  const data = async () => page.evaluate(() => ({ frames: window.__m.frames.slice(), long: window.__m.long.slice() }));
  const result = { agentsRequested: AGENTS };

  // Scene load.
  const t0 = await t();
  await enter();
  const tutorial = page.getByRole('region', { name: 'Hướng dẫn lần đầu' });
  if (await tutorial.count()) await tutorial.getByRole('button', { name: 'Bỏ qua' }).click();
  await page.waitForTimeout(1500);
  const t1 = await t();
  result.seatedMirrorAgents = await page.getByLabel('Bản văn bản của văn phòng').getByRole('button', { name: /Mức tin cậy/ }).count();
  const loadData = await data();
  result.sceneLoad = { ...summarize(loadData.frames, t0, t1, loadData.long), note: 'click on 3D until 1.5 s after ready; includes GLB parse and shader compile' };

  // Moving: the camera presets ease for a fixed time; cycle them back to back.
  const cams = ['Developer', 'Coordinator', 'QA', 'Conversation', 'Toàn cảnh'];
  const m0 = await t();
  for (let i = 0; i < 10; i++) { await page.getByRole('group', { name: 'Góc nhìn camera' }).getByRole('button', { name: cams[i % cams.length], exact: true }).click(); await page.waitForTimeout(750); }
  const m1 = await t();
  const moveData = await data();
  result.moving = summarize(moveData.frames, m0, m1, moveData.long);

  // Idle: agents with a running clip, nothing else changes.
  await page.waitForTimeout(1500);
  const i0 = await t();
  await page.waitForTimeout(8000);
  const i1 = await t();
  const idleData = await data();
  result.idle = summarize(idleData.frames, i0, i1, idleData.long);

  // Hidden tab: visibilitychange with document.hidden forced (the app reads document.hidden). Chrome headless never hides a tab by itself.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(500);
  const h0 = await t();
  await page.waitForTimeout(4000);
  const h1 = await t();
  const hiddenData = await data();
  result.hidden = { method: 'document.hidden overridden plus visibilitychange (emulated)', frames: hiddenData.frames.filter(x => x >= h0 && x < h1).length, windowMs: Math.round(h1 - h0) };
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });

  // Long tasks over the whole interactive session (everything after the load window).
  const all = await data();
  result.longTasksAfterLoad = { count: all.long.filter(l => l.start >= t1).length, durationsMs: all.long.filter(l => l.start >= t1).map(l => +l.duration.toFixed(1)) };

  // Click-to-response: pick an agent through the mirror and time until the inspector shows.
  const clickTimes = [];
  for (let i = 0; i < 5; i++) {
    const s = await t();
    await page.getByLabel('Bản văn bản của văn phòng').getByRole('button', { name: /\(Điều phối viên\)/ }).focus();
    await page.keyboard.press('Enter');
    await page.locator('#main').waitFor({ state: 'visible' });
    clickTimes.push(+((await t()) - s).toFixed(1));
    await page.keyboard.press('Escape');
    await page.locator('#main').waitFor({ state: 'hidden' });
  }
  result.inspectorOpenMs = clickTimes;

  // Mode toggles and heap.
  await leave();
  const series = [{ toggles: 0, heapMiB: await heap(), liveGlContexts: await page.evaluate(() => window.__m.gl.filter(g => !g.isContextLost()).length) }];
  for (let n = 1; n <= TOGGLES; n++) {
    await enter(); await page.waitForTimeout(400); await leave();
    if (n % 5 === 0) series.push({ toggles: n, heapMiB: await heap(), liveGlContexts: await page.evaluate(() => window.__m.gl.filter(g => !g.isContextLost()).length) });
  }
  result.toggleHeap = { series, note: 'used JS heap after forced GC, scene closed; the first sample already includes one full visit' };
  await context.close();
  return result;
}

const host = await startHost();
try {
  const os = await (await import('node:os')).default;
  const report = { when: new Date().toISOString(), environment: { cpu: os.cpus()[0]?.model ?? 'unknown', logicalCpus: os.cpus().length, totalRamGiB: +(os.totalmem() / 1073741824).toFixed(1), platform: `${os.platform()} ${os.release()} (${os.arch()})`, node: process.version, viewport: '1280x800', assetsPath: ASSETS, cliPath: CLI }, budgets: BUDGET, sizes: await sizes() };
  let mode = GL === 'swiftshader' ? 'swiftshader' : 'hardware';
  let launched = await launch(mode);
  let name = await rendererName(launched.browser);
  report.glAttempts = [{ mode, headless: launched.headless, renderer: name, software: software(name) }];
  if (GL === 'auto' && software(name)) {
    await launched.browser.close();
    mode = 'swiftshader';
    launched = await launch(mode);
    name = await rendererName(launched.browser);
    report.glAttempts.push({ mode, headless: launched.headless, renderer: name, software: software(name) });
  }
  report.gl = { ran: mode, headless: launched.headless, renderer: name, software: software(name), hardwareGpuUsed: !software(name) };
  report.browserVersion = launched.browser.version();
  report.run = await measure(launched.browser, host);
  await launched.browser.close();
  const verdict = (ok) => ok ? 'within' : 'OVER';
  const r = report.run;
  report.vsBudget = {
    graphicsChunkGzipKiB: `${report.sizes.graphicsChunkGzipKiB} of ${BUDGET.chunkGzipKiB}: ${verdict(report.sizes.graphicsChunkGzipKiB < BUDGET.chunkGzipKiB)}`,
    assetsTotalMiB: `${report.sizes.assetsTotalMiB} of ${BUDGET.assetsMiB}: ${verdict(report.sizes.assetsTotalMiB < BUDGET.assetsMiB)}`,
    movingFps: `${r.moving.fpsOverWindow} over the whole window (target ${BUDGET.movingFps}, cap ${BUDGET.movingFps}): ${verdict(r.moving.fpsOverWindow >= BUDGET.movingFps && r.moving.fpsOverWindow <= BUDGET.movingFps)}`,
    movingFpsBurstAdvisory: `advisory only, not a verdict: ${r.moving.fpsFastBursts} fps over consecutive moving frames (${Math.round(r.moving.fastFrameShare * 100)}% of frame gaps), median gap ${r.moving.medianGapMs} ms`,
    idleFpsOverWindow: `${r.idle.fpsOverWindow} (max ${BUDGET.idleFps}; the 8 fps timer is the cap, so this is the same on any GPU): ${verdict(r.idle.fpsOverWindow <= BUDGET.idleFps)}`,
    hiddenFrames: `${r.hidden.frames} (max ${BUDGET.hiddenFrames}): ${verdict(r.hidden.frames === 0)}`,
    sceneLoadLongTask: `longest ${r.sceneLoad.longestMs} ms in ${r.sceneLoad.longTasks} long task(s) while entering 3D (max ${BUDGET.longTaskMs} ms): ${verdict(r.sceneLoad.longestMs <= BUDGET.longTaskMs)}`,
    longTasks: `after load ${r.longTasksAfterLoad.count}; moving ${r.moving.longTasks}; idle ${r.idle.longTasks} (each over ${BUDGET.longTaskMs} ms by definition): ${verdict(r.longTasksAfterLoad.count === 0)}`,
  };
  const text = JSON.stringify(report, null, 2);
  if (OUT) await writeFile(OUT, text + '\n');
  console.log(text);
} finally { host.close(); }
