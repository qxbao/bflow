import { expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Chrome arguments of the office-csp spec: software GL so the 3D scene also runs without a GPU. The server's real CSP applies. */
export const WEBGL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
export const browserOptions = (extra: string[] = []) => ({ launchOptions: { ...(process.env.BFLOW_WEB_TEST_BROWSER ? { executablePath: process.env.BFLOW_WEB_TEST_BROWSER } : {}), args: [...WEBGL_ARGS, ...extra] } });

/** The W07 direct-actions host (the same file the Classic workflow spec uses), driven over IPC. */
export interface DirectHost { pairing: string; repository: string; call(kind: string, values?: Record<string, unknown>): Promise<any>; close(): Promise<void> }
export async function startDirectHost(): Promise<DirectHost> {
  const child: ChildProcess = spawn(process.execPath, ['--input-type=module'], { cwd: resolve('../cli'), env: { ...process.env, W07_ASSETS: resolve('dist/client') }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.stdin!.end(await readFile('e2e/direct-actions-host.mjs', 'utf8'));
  let seq = 0;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const ready = await new Promise<any>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture did not start')), 15000);
    child.on('message', (raw: any) => {
      if (raw.ready) { clearTimeout(timer); accept(raw); return; }
      const pending = waiting.get(raw.requestId);
      if (pending) { clearTimeout(pending.timer); waiting.delete(raw.requestId); raw.error ? pending.reject(new Error(raw.error)) : pending.resolve(raw.value); }
    });
    child.stderr!.on('data', () => {});
    child.once('exit', code => { if (code) { clearTimeout(timer); reject(new Error('Fixture exited')); } });
  });
  const call = (kind: string, values: Record<string, unknown> = {}) => new Promise<any>((resolveCall, reject) => {
    const requestId = ++seq, timer = setTimeout(() => { waiting.delete(requestId); reject(new Error('Fixture IPC timeout')); }, 10000);
    waiting.set(requestId, { resolve: resolveCall, reject, timer });
    child.send!({ kind, requestId, ...values });
  });
  return { pairing: ready.pairing, repository: ready.repository, call, async close() {
    if (child.connected) child.send!({ kind: 'close' });
    await new Promise<void>(accept => { if (child.exitCode !== null) { accept(); return; } child.once('exit', () => accept()); setTimeout(() => { child.kill(); accept(); }, 4000); });
  } };
}

/** Pairs, registers the fixture repository when needed and opens the project page (Classic). */
export async function openProject(page: Page, pairing: string, repository: string, name: RegExp): Promise<string> {
  await page.goto(pairing);
  const link = page.getByRole('link', { name });
  if (!await link.isVisible().catch(() => false)) { await page.getByLabel('Đường dẫn Git tuyệt đối').fill(repository); await page.getByRole('button', { name: 'Đăng ký dự án' }).click(); }
  await link.click();
  return new URL(page.url()).pathname;
}
/** Switches to the 3D mode with the Classic top-bar switch and waits for the scene. */
export async function enterVisual(page: Page, scene = true): Promise<void> {
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.getByRole('button', { name: '3D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  if (scene) await expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-renderer', 'ready', { timeout: 20000 });
}
/** HUD rail (the shortcut column). */
export const rail = (page: Page, name: string | RegExp) => page.getByRole('navigation', { name: 'Lối tắt' }).getByRole('button', { name });
/** Mirror button: the stable surface. It is visually hidden while the scene is healthy, so it is reached by focus and Enter like a keyboard user, never by clicking canvas pixels. */
/** The operations dock is collapsed by default: expand it (idempotent) before reading operation status. */
export async function openDock(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /Thao tác đã gửi/ }).first();
  await expect(toggle).toBeVisible({ timeout: 15000 });
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}
/** Closes the decision modal synchronously if it is still mounted after the host settles the decision. */
export async function closeDecisionReviewIfOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open][aria-label^="Quyết định phiên bản"]');
    if (dialog?.open) dialog.close();
  });
}
export async function mirror(page: Page, name: string | RegExp): Promise<void> {
  const button = page.getByLabel('Bản văn bản của văn phòng').getByRole('button', { name });
  await button.focus();
  await page.keyboard.press('Enter');
}

/** A schema-valid D-WEB-03 workforce view for the acceptance host (session `fixture-host`, run `run`), served through page.route so the host stays unchanged. */
export function workforceBody(projectId: string, options: { developers?: number; handoffState?: string } = {}): unknown {
  const at = '2026-11-02T00:00:00.000Z';
  const developers = Array.from({ length: options.developers ?? 0 }, (_, i) => ({ instanceId: `agent-dev-${String(i + 1).padStart(2, '0')}`, role: 'developer', displayName: `Developer ${i + 1}`, group: 'developer_worktree', permanent: false, provider: 'claude', allocation: 'active',
    transport: { state: 'idle', observedAt: at }, boundAt: `2026-11-02T00:${String(i + 1).padStart(2, '0')}:00.000Z`, work: [] }));
  return { apiVersion: 1, projectId, sessionId: 'fixture-host', revisionToken: 'w1', truncated: false, observedAt: at,
    agents: [
      { instanceId: 'agent-conversation-1', role: 'conversation', displayName: 'Conversation', group: 'conversation', permanent: true, provider: 'claude', allocation: 'active', transport: { state: 'idle', observedAt: at }, boundAt: '2026-11-01T23:00:00.000Z', work: [] },
      { instanceId: 'agent-coordinator-1', role: 'coordinator', displayName: 'Coordinator', group: 'coordination', permanent: true, provider: 'codex', allocation: 'active', transport: { state: 'working', observedAt: at }, boundAt: '2026-11-01T23:00:01.000Z',
        work: [{ messageId: 'fixture-delegation-1', kind: 'delegation', runId: 'run', delivery: options.handoffState === 'unknown_delivery' ? 'unknown_delivery' : 'accepted', ...(options.handoffState === 'unknown_delivery' ? {} : { acceptedAt: '2026-11-01T23:30:00.000Z' }) }] },
      ...developers],
    handoffs: [{ handoffId: 'handoff-out-0', ordinal: 0, runId: 'run', messageType: 'delegation_request', direction: 'outbound', from: { role: 'conversation', instanceId: 'agent-conversation-1' }, to: { role: 'coordinator', instanceId: 'agent-coordinator-1' }, state: options.handoffState ?? 'accepted', evidence: [] }] };
}
/** Records every WebGL context the page creates (the office-csp spec's technique), so a test can lose one on purpose and count the live ones. */
export const recordWebGl = (): void => {
  const all: WebGLRenderingContext[] = [];
  (window as unknown as { __gl: WebGLRenderingContext[] }).__gl = all;
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    const ctx = (original as (...a: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    if (ctx && /webgl/.test(type)) all.push(ctx as WebGLRenderingContext);
    return ctx;
  } as typeof original;
};

/** The scene (not only the mode flag) is live: used after a reload or a re-pair wherever the picture matters. */
export const sceneReady = (page: Page) => expect(page.getByLabel('Cảnh văn phòng')).toHaveAttribute('data-office-renderer', 'ready', { timeout: 20000 });
/** "Exactly N effects": wait for N, then keep observing for longer than the fixture's 2000 ms hold so a late duplicate would show. */
export async function stableCount(read: () => Promise<number>, expected: number, windowMs = 2400): Promise<void> {
  await expect.poll(read, { timeout: 20000 }).toBe(expected);
  const end = Date.now() + windowMs;
  while (Date.now() < end) { expect(await read()).toBe(expected); await new Promise(r => setTimeout(r, 250)); }
}
