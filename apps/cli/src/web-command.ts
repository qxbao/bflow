import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { WebSessionBootstrapRequestSchema, type UserInteractionClient } from '@bflow/contracts/web';
import { defaultHostEnvironment, detectPlatform, isolatedPlatformProfile } from '@bflow/machine-setup';
import type { LocalWebServer } from '@bflow/local-server';
import { readPreviewFile } from './preview-files.js';
import { withLifecycleLock } from './lifecycle-lock.js';
import { createWebWorkspaceServices, type WebWorkspaceOptions } from './web-workspace-services.js';
import type { CliIo } from './types.js';

export const WEB_HELP = 'Cách dùng: bflow web [--port N] [--no-open]\nWeb localhost (mặc định 127.0.0.1:4317). Ctrl-C chỉ đóng web; phiên dự án tiếp tục chạy. Không tự setup/init/index. Không hỗ trợ --json vì URL ghép nối chỉ dành cho terminal khởi chạy.';
export interface WebArgs { port: number; open: boolean; help?: boolean }
export function parseWebArgs(args: readonly string[]): WebArgs {
  let port = 4317, openBrowser = true, seenPort = false, seenOpen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { port, open: openBrowser, help: true };
    if (arg === '--port' && !seenPort) {
      const text = args[++i];
      if (!text || !/^[1-9][0-9]{0,4}$/.test(text) || Number(text) > 65535) throw new Error('web --port cần số nguyên từ 1 đến 65535.');
      port = Number(text); seenPort = true;
    } else if (arg === '--no-open' && !seenOpen) { openBrowser = false; seenOpen = true; }
    else throw new Error(`Tùy chọn bflow web không hợp lệ. ${WEB_HELP}`);
  }
  return { port, open: openBrowser };
}
export interface WebCommandOptions extends Partial<WebWorkspaceOptions> {
  stateDirectory?: string;
  assetsDirectory?: string;
  interaction?: (projectId: string) => Promise<UserInteractionClient>;
  io?: CliIo;
  /** Embedded terminal sink; defaults to the real stdout TTY. */
  isTerminal?: boolean;
  openBrowser?: (url: string) => Promise<void>;
}
export interface WebCommandHandle { origin: string; reused: boolean; close(): Promise<void> }

// Private locator is local state, never a browser or host credential. The bootstrap itself is not saved.
const LocatorSchema = z.object({ origin: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/),
  controlPort: z.number().int().min(1).max(65535), controlSecret: WebSessionBootstrapRequestSchema.shape.secret }).strict();
async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) || await realpath(directory) !== directory)
    throw new Error('Unsafe web private state directory; preserve state and inspect ownership.');
}
async function readLocator(file: string) {
  const info = await lstat(file);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) || info.nlink !== 1) throw new Error('Unsafe web locator');
  return LocatorSchema.parse(JSON.parse(await readPreviewFile(file, 8192)));
}
async function writeLocator(file: string, value: z.infer<typeof LocatorSchema>) {
  const temporary = file + '.tmp-' + randomBytes(8).toString('hex');
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(LocatorSchema.parse(value))); await handle.sync(); await handle.close(); await rename(temporary, file); }
  finally { await handle.close(); await unlink(temporary).catch(() => {}); }
}
function mac(key: string, purpose: string, origin: string, nonce: string, value = '') {
  return createHmac('sha256', key).update(JSON.stringify([purpose, origin, nonce, value])).digest('base64url');
}
function equalSecret(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function controlRequest(port: number, path: string, secret: string): Promise<string> {
  return new Promise((accept, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', timeout: 3000,
      headers: { 'content-type': 'application/json' } }, res => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); if (body.length > 4096) res.destroy(new Error('Invalid web control response')); });
      res.on('error', reject);
      res.on('end', () => { try {
        if (res.statusCode !== 200) throw new Error('Web instance did not authenticate control request');
        accept(WebSessionBootstrapRequestSchema.parse(JSON.parse(body)).secret);
      } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(new Error('Web owner verification timed out')));
    req.on('error', reject);
    req.end(JSON.stringify(WebSessionBootstrapRequestSchema.parse({ apiVersion: 1, secret })));
  });
}
async function bootstrapFromOwner(locator: z.infer<typeof LocatorSchema>): Promise<string> {
  const nonce = randomBytes(32).toString('base64url');
  // Authenticate the listener before sending even a one-use authorization. A stale port
  // may have been rebound by an unrelated user. Never disclose the persistent credential.
  const proof = await controlRequest(locator.controlPort, '/verify', nonce);
  if (!equalSecret(proof, mac(locator.controlSecret, 'verify', locator.origin, nonce))) throw new Error('Unverified web owner');
  const receipt = await controlRequest(locator.controlPort, '/pair', mac(locator.controlSecret, 'pair', locator.origin, nonce));
  const parts = receipt.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] ||
      !equalSecret(parts[1], mac(locator.controlSecret, 'paired', locator.origin, nonce, parts[0]))) throw new Error('Unverified pairing receipt');
  return parts[0];
}
export async function openWebBrowser(url: string): Promise<void> {
  const executable = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!executable) throw new Error('Unsupported browser opener');
  await new Promise<void>((accept, reject) => {
    const child = spawn(executable, [url], { shell: false, stdio: 'ignore', timeout: 10000 });
    child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error('Browser opener failed')));
  });
}
function defaultStateDirectory() {
  const host = defaultHostEnvironment();
  const platform = host.env.BFLOW_HOME ? isolatedPlatformProfile(detectPlatform(host), resolve(host.env.BFLOW_HOME)) : detectPlatform(host);
  return join(platform.paths.state, 'web');
}
/** Foreground web owner only. Closing never calls a project lifecycle service. */
export async function startWebCommand(args: WebArgs, options: WebCommandOptions = {}): Promise<WebCommandHandle> {
  const io = options.io ?? { stdout: (s: string) => process.stdout.write(s + '\n'), stderr: (s: string) => process.stderr.write(s + '\n') };
  const stateDirectory = resolve(options.stateDirectory ?? defaultStateDirectory());
  const ownerDirectory = join(stateDirectory, 'owner');
  await privateDirectory(stateDirectory); await privateDirectory(ownerDirectory);
  const locatorPath = join(stateDirectory, 'instance.json');
  let bootstrap: string;
  let handle: WebCommandHandle;
  ({ handle, bootstrap } = await withLifecycleLock(ownerDirectory, async () => {
    let existing: z.infer<typeof LocatorSchema> | undefined;
    try { existing = await readLocator(locatorPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) {
      if (args.port !== Number(new URL(existing.origin).port)) throw new Error(`Web đã chạy tại ${existing.origin}; dùng đúng --port để mở lại. Không đổi origin tự động.`);
      let secret: string;
      try { secret = await bootstrapFromOwner(existing); }
      catch { throw new Error('Không xác minh được web instance. Dừng owner cũ và kiểm tra private web state/locks trước khi khôi phục; không takeover theo PID.'); }
      return { bootstrap: secret, handle: { origin: existing.origin, reused: true, async close() {} } };
    }
    let assetsDirectory: string;
    try {
      assetsDirectory = options.assetsDirectory ?? (await import('@bflow/web/assets')).getWebAssetDirectory();
      const html = await readPreviewFile(join(assetsDirectory, 'index.html'), 1024 * 1024);
      const assets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(match => match[1]!);
      if (!assets.some(asset => asset.endsWith('.js'))) throw new Error('Missing entry bundle');
      for (const asset of assets) {
        const path = resolve(assetsDirectory, '.' + asset);
        if (!path.startsWith(resolve(assetsDirectory) + '/') || await realpath(path) !== path) throw new Error('Invalid built asset');
        const info = await lstat(path);
        if (!info.isFile() || info.size === 0) throw new Error('Missing built asset');
      }
    }
    catch { throw new Error('Thiếu production web assets. Chạy pnpm run build từ source checkout đã cài dependencies, rồi chạy lại bflow web.'); }
    // W03 exposes neither a registered-project resolver nor authenticated browser context.
    // Integration must supply these owner-side ports. Do not read its private registry format
    // or manufacture a signer/physical hook to hide that missing seam.
    const resolveProject = options.resolveProject ?? (async () => { throw new Error('Local Server registry resolver chưa được integration nối vào CLI.'); });
    const workspace = createWebWorkspaceServices({ ...options, resolveProject });
    const interaction = options.interaction ?? (async () => { throw new Error('Authenticated Local Server interaction context chưa được integration cung cấp.'); });
    let server: LocalWebServer;
    try {
      const { createLocalWebServer } = await import('@bflow/local-server');
      server = await createLocalWebServer({ host: '127.0.0.1', port: args.port,
      stateDirectory: join(stateDirectory, 'server'), assetsDirectory, workspace, interaction }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`Port ${args.port} đang bận (EADDRINUSE); dừng instance đúng chủ sở hữu hoặc chọn --port khác.`);
      throw error;
    }
    const controlSecret = randomBytes(32).toString('base64url');
    const challenges = new Map<string, { nonce: string; expires: number }>();
    const control = createServer({ requestTimeout: 3000, headersTimeout: 3000, maxHeaderSize: 2048 }, (req, res) => {
      let body = ''; req.setTimeout(3000, () => req.destroy());
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); if (body.length > 2048) req.destroy(); });
      req.on('error', () => { res.destroy(); });
      req.on('end', () => { void (async () => {
        try {
          if (req.method !== 'POST' || !['/pair', '/verify'].includes(req.url ?? '') || req.headers.origin !== undefined) throw new Error();
          const input = WebSessionBootstrapRequestSchema.parse(JSON.parse(body));
          for (const [key, challenge] of challenges) if (challenge.expires <= Date.now()) challenges.delete(key);
          let responseSecret: string;
          if (req.url === '/verify') {
            if (!/^[A-Za-z0-9_-]{43}$/.test(input.secret) || challenges.size >= 100) throw new Error();
            challenges.set(mac(controlSecret, 'pair', server.origin, input.secret), { nonce: input.secret, expires: Date.now() + 5000 });
            responseSecret = mac(controlSecret, 'verify', server.origin, input.secret);
          } else {
            const challenge = challenges.get(input.secret);
            if (!challenge) throw new Error();
            challenges.delete(input.secret);
            const bootstrap = await server.issueBootstrap();
            responseSecret = bootstrap + '.' + mac(controlSecret, 'paired', server.origin, challenge.nonce, bootstrap);
          }
          const response = WebSessionBootstrapRequestSchema.parse({ apiVersion: 1, secret: responseSecret });
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(response));
        } catch { res.writeHead(403); res.end(); }
      })(); });
    });
    let published = false;
    try {
      await new Promise<void>((accept, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', () => { control.off('error', reject); accept(); }); });
      const controlAddress = control.address();
      if (!controlAddress || typeof controlAddress === 'string') throw new Error('Missing control address');
      await writeLocator(locatorPath, { origin: server.origin, controlPort: controlAddress.port, controlSecret }); published = true;
      const secret = await server.issueBootstrap();
      let closing: Promise<void> | undefined;
      return { bootstrap: secret, handle: { origin: server.origin, reused: false, close() {
        return closing ??= (async () => {
          await new Promise<void>(r => { control.close(() => r()); control.closeAllConnections(); });
          await server.close();
          await unlink(locatorPath); // only the published owner removes this locator
        })();
      } } };
    } catch (error) {
      await new Promise<void>(r => control.close(() => r())); await server.close();
      if (published) await unlink(locatorPath); throw error;
    }
  }));
  const terminal = (options.isTerminal ?? (options.io === undefined && Boolean(process.stdout.isTTY)));
  const printPairing = (url: string) => {
    if (terminal) io.stdout(url);
    else io.stdout(`Bflow web: ${handle.origin} — chạy lại bflow web trong terminal để ghép nối; không ghi secret vào redirected output.`);
  };
  const pairingUrl = `${handle.origin}/#${new URLSearchParams({ bootstrap }).toString()}`;
  if (args.open) {
    try { await (options.openBrowser ?? openWebBrowser)(pairingUrl); io.stdout(`Bflow web: ${handle.origin} — Ctrl-C chỉ đóng web.`); }
    catch { io.stderr('Không mở được trình duyệt. Mở URL ghép nối bên dưới trong 60 giây, chỉ trên máy này:'); printPairing(pairingUrl); }
  } else printPairing(pairingUrl);
  if (!options.resolveProject || !options.interaction)
    io.stderr('Local web còn chờ integration nối registered-project resolver và authenticated interaction context; các thao tác project tương ứng chưa khả dụng.');
  return handle;
}
/** Only a newly-created owner waits for signals; a reuse invocation returns immediately. */
export async function runWebCommand(args: WebArgs, options: WebCommandOptions = {}): Promise<void> {
  let stopped = false;
  let notify: (() => void) | undefined;
  const stop = () => { stopped = true; notify?.(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const handle = await startWebCommand(args, options);
    if (handle.reused) return;
    if (!stopped) await new Promise<void>(accept => { notify = accept; });
    await handle.close();
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
