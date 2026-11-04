import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { LocalWorkspaceServices, WebProject } from '@bflow/contracts/web';
import { createWebInteractionServices } from '../src/web-interaction.js';
import { createWebWorkspaceServices } from '../src/web-workspace-services.js';
import { initializeEnvironmentConfig } from '../src/environment-config.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

const SECRET = 'sk-ant-api03-SECRETVALUE0123456789abcdefghijklmnopqrst';
const uid = `local-user-${process.getuid?.() ?? 'local'}`;
const credential = { credential: 'c'.repeat(64), principalId: uid, socketPath: '/private/socket' };
const browser = () => ({ principalId: 'ledger', browserSessionId: 'browser-1', expiresAt: new Date(Date.now() + 60000).toISOString() });
const now = () => new Date().toISOString();

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dws-'))); dirs.push(root);
  const repo = join(root, 'repo'); await mkdir(repo); execFileSync('git', ['init', '-q', repo]);
  return { root, repo, project: { apiVersion: 1 as const, projectId: 'project-test', canonicalPath: repo, displayName: 'repo', registrationState: 'registered' as const } };
}
/** Fake terminal process: spawns, then exits 0 (client handoff). Records the argv/env it received. */
function fakeSpawn(seen: { env?: Record<string, string>; args?: readonly string[]; count: number }) {
  return ((_executable: string, args: readonly string[], options: { env: Record<string, string> }) => {
    seen.count++; seen.env = options.env; seen.args = args;
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    setImmediate(() => { child.emit('spawn'); setImmediate(() => child.emit('exit', 0, null)); });
    return child;
  }) as never;
}
function launchDeps(home: string, seen: { env?: Record<string, string>; count: number }) {
  return {
    platform: 'linux' as const,
    env: { PATH: '/usr/bin', HOME: home, ANTHROPIC_API_KEY: SECRET, BFLOW_HOME: join(home, 'bflow-home'), CODEX_HOME: join(home, 'codex-home'),
      BFLOW_DIRECTOR_TOKEN: 'director-token-value', DISPLAY: ':0' },
    findExecutable: async (name: string) => name === 'claude' ? '/opt/fake/claude' : name === 'env' ? '/usr/bin/env' : null,
    checkSkill: async () => 'current' as const,
    findTerminal: async () => ({ available: true as const, kind: 'xterm' as const, executable: '/opt/fake/xterm' }),
    runner: { run: async () => ({ started: true, exitCode: 0, stdout: 'claude 2.1.0', stderr: '' }) } as never,
    spawn: fakeSpawn(seen),
    earlyExitWindowMs: 200
  };
}

it('exposes a configured stopped Director project before a host or browser layout hint exists', async () => {
  const { project } = await repository();
  await initializeEnvironmentConfig({ cwd: project.canonicalPath });
  const services = createWebInteractionServices({ principalId: 'ledger', resolveProject: async () => project }, {
    sessionId: async () => 'host-1',
    openDirector: (async () => { throw new Error('Host unavailable'); }) as never,
    director: { readPresence: async () => 'host_stopped' }
  });
  expect(await services.director.readView(project.projectId, browser())).toMatchObject({ ok: true, value: {
    projectId: project.projectId, layout: 'not_started',
    snapshot: { director: { presence: 'absent' } }
  } });
  // A failed read from a potentially live host must never be presented as a safe cold start.
  const unknown = createWebInteractionServices({ principalId: 'ledger', resolveProject: async () => project }, {
    sessionId: async () => 'host-1', openDirector: (async () => { throw new Error('Host unresponsive'); }) as never,
    director: { readPresence: async () => 'unknown' }
  });
  expect(await unknown.director.readView(project.projectId, browser())).toMatchObject({ ok: false });
});

it('reads the Director view through the owner query and pages messages/sends with the registered Web credential only', async () => {
  const { project } = await repository();
  const opened: any[] = [];
  const service = {
    readDirector: vi.fn(async () => ({ ok: false, error: { code: 'transport_unavailable', retryable: true, message: 'down' } })),
    listDirectorIssues: vi.fn(async () => ({ ok: true, value: { apiVersion: 1, items: [] } })),
    listDirectorMessages: vi.fn(async () => ({ ok: true, value: { apiVersion: 1, items: [] } })),
    sendDirectorMessage: vi.fn(async (input: any) => ({ ok: true, value: { schemaVersion: 1, seq: 1, messageId: input.messageId, author: 'user', channel: 'web', text: input.content, at: now() } }))
  };
  const openDirector = vi.fn(async (options: any) => { opened.push(options); return service; });
  const register = vi.fn(async () => credential);
  const services = createWebInteractionServices({ principalId: 'ledger', resolveProject: async () => project },
    { register: register as never, openDirector: openDirector as never, sessionId: async () => 'host-1' });
  await services.director.readView(project.projectId, browser());
  await services.director.issues(project.projectId, 'o100', browser());
  expect(opened.slice(0, 2).every(options => options.interaction === undefined && options.sessionId === 'host-1' && options.repositoryPath === project.canonicalPath)).toBe(true);
  expect(service.listDirectorIssues).toHaveBeenCalledWith(project.projectId, 'o100');
  await services.director.messages(project.projectId, 'a2', browser());
  const body = { apiVersion: 1 as const, messageId: randomUUID(), projectId: project.projectId, sessionId: 'conv-1', content: 'Xin chào' };
  expect(await services.director.send(body, browser())).toMatchObject({ ok: true, value: { messageId: body.messageId } });
  expect(opened.slice(2).every(options => options.interaction?.credential === credential.credential)).toBe(true);
  expect(service.listDirectorMessages).toHaveBeenCalledWith(project.projectId, 'a2');
  // Foreign project, foreign body and expired/foreign browser context never reach the host.
  expect(await services.director.send({ ...body, projectId: 'project-other' }, browser())).toMatchObject({ ok: false, error: { code: 'validation' } });
  expect(await services.director.messages(project.projectId, undefined, { ...browser(), expiresAt: new Date(0).toISOString() })).toMatchObject({ ok: false });
  expect(await services.director.readView(project.projectId, { ...browser(), principalId: 'other' })).toMatchObject({ ok: false });
  expect(service.sendDirectorMessage).toHaveBeenCalledTimes(1);
});

it('reports a send as not written when the host cannot register the Web credential', async () => {
  const { project } = await repository();
  const openDirector = vi.fn();
  const services = createWebInteractionServices({ principalId: 'ledger', resolveProject: async () => project },
    { register: (async () => { throw Object.assign(new Error('connect ENOENT /private/socket'), { code: 'ENOENT' }); }) as never, openDirector: openDirector as never, sessionId: async () => 'host-1' });
  const result = await services.director.send({ apiVersion: 1, messageId: randomUUID(), projectId: project.projectId, sessionId: 'conv-1', content: 'x' }, browser());
  expect(result).toMatchObject({ ok: false, error: { code: 'transport_unavailable', details: { reason: 'unavailable' } } });
  expect(JSON.stringify(result)).not.toContain('/private/socket');
  expect(openDirector).not.toHaveBeenCalled();
});

it('passes the realpath canonical project path to the launch plan and guards presence', async () => {
  const { root, repo } = await repository();
  const link = join(root, 'link'); await symlink(repo, link);
  const linked: WebProject = { apiVersion: 1, projectId: 'project-test', canonicalPath: link, displayName: 'repo', registrationState: 'registered' };
  const build = vi.fn(async () => { throw Object.assign(new Error('stop'), { name: 'DirectorLaunchError', code: 'skill_missing' }); });
  const services = createWebInteractionServices({ principalId: 'ledger', resolveProject: async () => linked },
    { sessionId: async () => 'host-1', director: { build: build as never, readPresence: async () => 'absent' } });
  await services.director.launch('project-test', { provider: 'claude', replaceActive: false }, browser());
  expect(build).toHaveBeenCalledWith({ projectId: 'project-test', canonicalPath: repo }, 'claude', expect.anything());
  const seen = { count: 0 };
  const active = createWebInteractionServices({ principalId: 'ledger', resolveProject: async () => ({ ...linked, canonicalPath: repo }) },
    { sessionId: async () => 'host-1', director: { deps: launchDeps(root, seen), readPresence: async () => 'unknown' } });
  expect(await active.director.launch('project-test', { provider: 'claude', replaceActive: false }, browser()))
    .toMatchObject({ ok: false, error: { code: 'validation', details: { reason: 'director_active' } } });
  expect(seen.count).toBe(0);
  expect(await active.director.launch('project-test', { provider: 'claude', replaceActive: true }, browser()))
    .toMatchObject({ ok: true, value: { kind: 'director_launch', provider: 'claude', mode: 'terminal_opened' } });
  expect(seen.count).toBe(1);
});

it('classifies a post-spawn failure as uncertain and never retries', async () => {
  const { root, project } = await repository();
  let count = 0;
  const spawn = ((..._args: unknown[]) => {
    count++;
    const child = new EventEmitter() as EventEmitter & { unref(): void }; child.unref = () => {};
    setImmediate(() => { child.emit('spawn'); setImmediate(() => child.emit('exit', 1, null)); });
    return child;
  }) as never;
  const services = createWebInteractionServices({ principalId: 'ledger', resolveProject: async () => project },
    { sessionId: async () => 'host-1', director: { deps: { ...launchDeps(root, { count: 0 }), spawn }, readPresence: async () => 'absent' } });
  const result = await services.director.launch(project.projectId, { provider: 'claude', replaceActive: false }, browser());
  expect(result).toMatchObject({ ok: false, error: { code: 'unknown_delivery', manualInterventionRequired: true, details: { reason: 'launch_uncertain' } } });
  expect(count).toBe(1);
});

it('redacts BFLOW_HOME, provider-home and token values from launch options while keeping the project path', async () => {
  const { root, project } = await repository();
  const home = join(root, 'home');
  const inspect = vi.fn(async (repository: { projectId: string; canonicalPath: string }) => ({ apiVersion: 1, projectId: repository.projectId,
    terminal: { available: false, reason: `Không mở được ${join(home, 'bflow-home')}/state/socket` },
    providers: [{ provider: 'claude', state: 'unverified', reason: `Xem ${join(home, 'codex-home')}/auth.json token ${SECRET}`,
      manualCommand: `cd '${repository.canonicalPath}' && BFLOW_DIRECTOR_PROVIDER=claude 'claude' '/bflow-start'` }], observedAt: now() }));
  const services = createWebInteractionServices({ principalId: 'ledger', resolveProject: async () => project },
    { sessionId: async () => 'host-1', director: { inspect: inspect as never, sensitivePaths: () => [join(home, 'bflow-home'), join(home, 'codex-home')] } });
  const result = await services.director.launchOptions(project.projectId, browser());
  const text = JSON.stringify(result);
  expect(result.ok).toBe(true);
  expect(text).not.toContain('bflow-home');
  expect(text).not.toContain('codex-home');
  expect(text).not.toContain(SECRET);
  expect(text).toContain(`cd '${project.canonicalPath}'`);
});

it('end to end: the launch receipt holds only provider/replace/project/result — never the plan environment or secrets', async () => {
  const { root, repo } = await repository();
  const home = join(root, 'home'); await mkdir(home);
  const stateDirectory = join(root, 'state');
  const assetsDirectory = join(root, 'assets'); await mkdir(assetsDirectory); await writeFile(join(assetsDirectory, 'index.html'), '<html></html>');
  const seen: { env?: Record<string, string>; args?: readonly string[]; count: number } = { count: 0 };
  const unavailable = async () => ({ ok: false as const, error: { code: 'transport_unavailable' as const, retryable: true as const, message: 'x' } });
  const workspace: LocalWorkspaceServices = { inspectProject: unavailable, startSession: unavailable, stopSession: unavailable, reconcileSessionOperation: unavailable, preview: unavailable };
  const { createLocalWebServer } = await import('@bflow/local-server');
  const server = await createLocalWebServer({ host: '127.0.0.1', port: 0, stateDirectory, assetsDirectory, compose(context) {
    const signed = createWebInteractionServices({ principalId: context.principalId, resolveProject: context.resolveProject },
      { sessionId: async () => 'host-1', director: { deps: launchDeps(home, seen), readPresence: async () => 'host_stopped',
        sensitivePaths: () => [join(home, 'bflow-home'), join(home, 'codex-home')] } });
    return { workspace, interaction: signed.interaction, director: signed.director };
  } });
  try {
    const send = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; json: any; body: string; headers: any }>((resolve, reject) => {
      const target = new URL(server.origin);
      const text = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ hostname: target.hostname, port: target.port, path, method, headers: { Origin: server.origin,
        ...(text ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) } : {}), ...headers } }, res => {
        const chunks: Buffer[] = []; res.on('data', c => chunks.push(c));
        res.on('end', () => { const raw = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode!, json, body: raw, headers: res.headers }); });
      });
      req.on('error', reject); req.end(text);
    });
    const login = await send('/api/v1/session/bootstrap', 'POST', { apiVersion: 1, secret: await server.issueBootstrap() });
    const headers = { Cookie: login.headers['set-cookie'][0].split(';')[0], 'X-Bflow-CSRF': login.json.csrfToken };
    const projectId = (await send('/api/v1/projects', 'POST', { apiVersion: 1, path: repo }, headers)).json.projectId;
    const operationId = randomUUID();
    const launched = await send(`/api/v1/projects/${projectId}/director/launch`, 'POST', { apiVersion: 1, operationId, provider: 'claude', replaceActive: false }, headers);
    expect(launched.status).toBe(202);
    expect(launched.json).toMatchObject({ state: 'applied', result: { kind: 'director_launch', provider: 'claude', mode: 'terminal_opened' } });
    expect(launched.json.result.manualCommand).toContain(`cd '${repo}'`);
    // The plan really carried the user's environment to the terminal…
    expect(seen.count).toBe(1);
    expect(seen.env?.ANTHROPIC_API_KEY).toBe(SECRET);
    // …but nothing of it reached the receipt ledger or the Web response.
    const files = await readdir(stateDirectory);
    const ledger = (await Promise.all(files.filter(name => name.endsWith('.json')).map(name => readFile(join(stateDirectory, name), 'utf8')))).join('\n');
    expect(ledger).toContain('director_launch');
    for (const leak of [SECRET, 'director-token-value', join(home, 'bflow-home'), join(home, 'codex-home'), '/opt/fake/claude', '/opt/fake/xterm', 'ANTHROPIC_API_KEY'])
      for (const text of [ledger, launched.body]) expect(text).not.toContain(leak);
    // Replay observes the receipt; no second terminal.
    expect((await send(`/api/v1/projects/${projectId}/director/launch`, 'POST', { apiVersion: 1, operationId, provider: 'claude', replaceActive: false }, headers)).json).toEqual(launched.json);
    expect(seen.count).toBe(1);
  } finally { await server.close(); }
});

it('workspace reconciliation never treats a director_launch as a session receipt and never settles it', async () => {
  const { root, project } = await repository();
  const receiptDirectory = join(root, 'receipts');
  const services = createWebWorkspaceServices({ resolveProject: async () => project, receiptDirectory });
  const operation = { apiVersion: 1 as const, operationId: randomUUID(), projectId: project.projectId, owner: 'local_lifecycle' as const,
    operationKind: 'director_launch' as const, state: 'accepted' as const, updatedAt: now() };
  expect(await services.reconcileSessionOperation(operation)).toMatchObject({ ok: true, value: { state: 'reconciliation_required', operationKind: 'director_launch' } });
  await expect(readdir(receiptDirectory)).rejects.toThrow();
});

it('bounds the presence read: a hung read counts as unknown (needs replaceActive) and never delays the spawn into the uncertain window', async () => {
  const { root, project } = await repository();
  const seen = { count: 0 };
  const hung = () => new Promise<never>(() => {});
  const services = createWebInteractionServices({ principalId: 'ledger', resolveProject: async () => project },
    { sessionId: async () => 'host-1', director: { deps: launchDeps(root, seen), readPresence: hung, presenceTimeoutMs: 50 } });
  const started = Date.now();
  expect(await services.director.launch(project.projectId, { provider: 'claude', replaceActive: false }, browser()))
    .toMatchObject({ ok: false, error: { code: 'validation', details: { reason: 'director_active' } } });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(seen.count).toBe(0);
  expect(await services.director.launch(project.projectId, { provider: 'claude', replaceActive: true }, browser()))
    .toMatchObject({ ok: true, value: { mode: 'terminal_opened' } });
  expect(seen.count).toBe(1);
});

it('refuses a Director view whose session differs from the host manifest Conversation session', async () => {
  const { project } = await repository();
  const view = (sessionId?: string) => ({ ok: true, value: { apiVersion: 1, projectId: project.projectId, layout: 'director', ...(sessionId ? { sessionId } : {}),
    snapshot: { schemaVersion: 1, generatedAt: now(), director: { presence: 'absent' }, runs: [], pendingApprovals: 0, pendingQuestions: 0, issues: [] },
    transcriptSeq: 0, cliCaptureMayBeIncomplete: false, observedAt: now() } });
  let served = view('conv-foreign');
  const openDirector = vi.fn(async () => ({ readDirector: async () => served }));
  const services = createWebInteractionServices({ principalId: 'ledger', resolveProject: async () => project },
    { openDirector: openDirector as never, sessionId: async () => 'host-1', director: { conversationSessionId: async () => 'conv-1' } });
  expect(await services.director.readView(project.projectId, browser())).toMatchObject({ ok: false, error: { code: 'transport_unavailable' } });
  served = view('conv-1');
  expect(await services.director.readView(project.projectId, browser())).toMatchObject({ ok: true, value: { sessionId: 'conv-1' } });
  // Either side absent (not started, or manifest unreadable): nothing to compare, the view is returned as read.
  served = view();
  expect(await services.director.readView(project.projectId, browser())).toMatchObject({ ok: true, value: { layout: 'director' } });
  const unknown = createWebInteractionServices({ principalId: 'ledger', resolveProject: async () => project },
    { openDirector: openDirector as never, sessionId: async () => 'host-1', director: { conversationSessionId: async () => undefined } });
  served = view('conv-foreign');
  expect(await unknown.director.readView(project.projectId, browser())).toMatchObject({ ok: true });
});
