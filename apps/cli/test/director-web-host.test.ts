import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectorWaitResultSchema, SessionManifestSchema } from '@bflow/contracts';
import { callDirectorOwnerHost, callDirectorTool, ensureAgenticHost } from '@bflow/runtime';
import { startWebCommand, type WebCommandHandle } from '../src/web-command.js';
import { identifyRepository } from '../src/repository.js';

/**
 * Task 9 (Director C/D) cross-slice path with the real built host: a Director-layout host activated on a v3 manifest with a fake
 * Herdr binary, reached by the production `bflow web` composition (Local Server + CLI Web interaction) over HTTP and SSE.
 * Evidence level: source + real host process + fake Herdr/provider. Not a live provider or live Herdr transport.
 */

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined); });

/** Private JSON-line control protocol of the host (data-level client; role traffic in production travels through Herdr). */
function hostCall(socketPath: string, token: string, method: string, params: unknown): Promise<unknown> {
  return new Promise((accept, reject) => {
    const socket = connect(socketPath); let text = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ token, method, params }) + '\n'));
    socket.on('data', chunk => {
      text += String(chunk); const end = text.indexOf('\n'); if (end < 0) return;
      socket.end(); const response = JSON.parse(text.slice(0, end));
      response.ok === true ? accept(response.value) : reject(new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error)));
    });
  });
}

const FAKE_HERDR = [
  '#!/usr/bin/env node',
  'import { dirname, join } from "node:path";', 'import { fileURLToPath } from "node:url";',
  'const root = dirname(fileURLToPath(import.meta.url)); const args = process.argv.slice(2); const rest = args[0] === "--session" ? args.slice(2) : args;',
  'if(rest[0]==="--version") console.log("herdr test-fixture");',
  'else if(rest[0]==="api") console.log("protocol: 22\\nschema_version: 1");',
  'else if(rest[0]==="agent" && rest[1]==="get") { const role=rest[2].replace("pane-",""); console.log(JSON.stringify({result:{agent:{name:role,pane_id:rest[2],workspace_id:"workspace",tab_id:"tab",agent_status:"idle",agent_session:{source:"herdr:claude",kind:"id",value:"native-"+role}}}})); }',
  'else if(rest[0]==="pane") console.log(JSON.stringify({result:{}}));',
  'else console.log(JSON.stringify({running:false,socket:join(root,"herdr.sock")}));'
].join('\n');
const CONVERSATION_SESSION = 'conv-1';

/** Starts (or restarts) the Director-layout host for `repo` and activates it on the same v3 manifest. */
async function activateDirectorHost(repo: string, sessionId: string, herdrBinary: string) {
  const controller = await ensureAgenticHost({ repositoryPath: repo, sessionId, herdrBinary, layout: 'director', progressCommand: ['bflow', 'progress', '--follow'] });
  const launches = await controller.prepare();
  const hostDirectory = join(repo, '.bflow/state/host', sessionId);
  const roles = Object.keys(launches.roleLaunch).filter(role => role !== 'developer');
  const manifestFile = join(repo, '.bflow/state/panes', `${sessionId}.manifest.json`);
  let manifest;
  try {
    // Restart: `up` re-publishes the same session manifest (same panes and Conversation session) as `up` again.
    const previous = SessionManifestSchema.parse(JSON.parse(await readFile(manifestFile, 'utf8')));
    manifest = SessionManifestSchema.parse({ ...previous, status: 'up', updatedAt: new Date().toISOString() });
    await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  } catch {
    const at = new Date().toISOString();
    manifest = SessionManifestSchema.parse({ schemaVersion: 3, sessionId, workspaceRoot: repo, projectName: 'director-web', herdrWorkspaceId: 'workspace',
      herdrTabId: 'tab', status: 'up', conversationSessionId: CONVERSATION_SESSION, activeRunIds: [], createdAt: at, updatedAt: at,
      panes: roles.map(role => ({ schemaVersion: 2, bindingId: `binding-${role}`, sessionId, role, agentId: role, paneId: `pane-${role}`, workspaceId: 'workspace',
        tabId: 'tab', provider: 'claude', agentKind: 'claude', cwd: repo, permanent: true, readOnlyWorkspace: true, isolationMode: 'dedicated_pane',
        transportState: 'idle', boundAt: at, session: { source: 'herdr:claude', kind: 'id', value: `native-${role}` } })),
      progressPane: { tabId: 'tab-progress', paneId: 'pane-progress', command: ['bflow', 'progress', '--follow'], phase: 'running', restarts: [], launchedAt: at },
      attachTarget: { role: 'progress', tabId: 'tab-progress', paneId: 'pane-progress' } });
    await mkdir(join(repo, '.bflow/state/panes'), { recursive: true });
    await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  }
  for (const role of roles) {
    const config = JSON.parse(await readFile(join(hostDirectory, `${role}.json`), 'utf8'));
    await hostCall(config.socketPath, config.token, 'provider_started', { paneId: `pane-${role}`, nativeSessionId: `native-${role}` });
    await hostCall(config.socketPath, config.token, 'native_session', { paneId: `pane-${role}`, sessionId: `native-${role}` });
  }
  expect(await controller.activate(manifest)).toEqual({ ok: true, value: undefined });
  return controller;
}

/** Minimal SSE reader over the real Local Server stream; records every parsed event. */
function openStream(origin: string, path: string, headers: Record<string, string>) {
  const events: { id?: string; data: any }[] = [];
  let closed = false;
  let markOpen!: () => void;
  const opened = new Promise<void>(resolve => { markOpen = resolve; });
  const req = request(new URL(path, origin), { headers: { Origin: origin, Accept: 'text/event-stream', ...headers } }, res => {
    markOpen();
    let buffer = '';
    res.on('data', chunk => {
      buffer += String(chunk);
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
        const id = frame.split('\n').find(line => line.startsWith('id:'))?.slice(3).trim();
        if (data) events.push({ ...(id ? { id } : {}), data: JSON.parse(data) });
      }
    });
    res.on('close', () => { closed = true; });
  });
  req.on('error', () => { closed = true; markOpen(); });
  req.end();
  return { events, opened, get closed() { return closed; }, close: () => req.destroy() };
}

describe.skipIf(process.platform === 'win32')('Director Web over the activated real host (production bflow web composition)', () => {
  let server: WebCommandHandle | undefined;
  it('Web POST → SSE chat → director_wait → director_say → transcript; replay/conflict/CSRF; issue refusal; host restart → SSE reset and durable dedupe', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b9w-')));
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const repo = join(root, 'repo'); await mkdir(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'baseline'], { cwd: repo });
    const herdrBinary = join(root, 'herdr-fixture.mjs'); await writeFile(herdrBinary, FAKE_HERDR, { mode: 0o700 });
    const sessionId = (await identifyRepository(repo)).sessionName;
    let controller = await activateDirectorHost(repo, sessionId, herdrBinary);
    cleanups.push(async () => { await controller.quiesce().catch(() => undefined); await controller.shutdown(); });

    const output: string[] = [];
    server = await startWebCommand({ port: 0, open: false }, { stateDirectory: join(root, 'web'), isTerminal: true, io: { stdout: s => output.push(s), stderr: s => output.push(s) } });
    cleanups.push(() => server!.close());
    const send = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(server!.origin + path, { method, headers: { Origin: server!.origin, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text(); let json: any; try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, json };
    };
    const secret = new URLSearchParams(new URL(output[0]!).hash.slice(1)).get('bootstrap');
    const login = await fetch(server.origin + '/api/v1/session/bootstrap', { method: 'POST', headers: { Origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ apiVersion: 1, secret }) });
    expect(login.status).toBe(200);
    const csrf = (await login.json()).csrfToken as string;
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'x-bflow-csrf': csrf };
    const project = (await send('/api/v1/projects', 'POST', { apiVersion: 1, path: repo }, headers)).json;
    const base = `/api/v1/projects/${project.projectId}`;

    // Activated Director host: the Web view is the Director layout of this manifest's Conversation session; no Director yet.
    const view = await send(`${base}/director`, 'GET', undefined, headers);
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ layout: 'director', sessionId: CONVERSATION_SESSION, snapshot: { director: { presence: 'absent' } } });
    expect(JSON.stringify(view.json)).not.toContain(root);

    const stream = openStream(server.origin, `${base}/events`, { Cookie: headers.Cookie });
    cleanups.push(async () => stream.close());
    // Local Server flushes headers only after its first upstream poll: publishing earlier would race the stream's baseline cursor.
    await stream.opened;

    // Web message while the Director is absent: queued (written by the host), not refused.
    const first = { apiVersion: 1, messageId: randomUUID(), projectId: project.projectId, sessionId: CONVERSATION_SESSION, content: 'Thêm mục hướng dẫn cài đặt' };
    const posted = await send(`${base}/director/messages`, 'POST', first, headers);
    expect(posted.status).toBe(202);
    expect(posted.json).toMatchObject({ seq: 1, messageId: first.messageId, author: 'user', channel: 'web' });
    // SSE: the host's Director bridge publishes `chat` with the new message ID through the real feed and Local Server stream.
    await expect.poll(() => stream.events.some(event => event.data.type === 'chat' && event.data.resourceIds.includes(first.messageId)), { timeout: 10_000, interval: 100 }).toBe(true);

    // Lost ACK replay: the same ID and content returns the same record; no second seq. Same ID with other content conflicts.
    const replay = await send(`${base}/director/messages`, 'POST', first, headers);
    expect(replay).toMatchObject({ status: 202, json: { seq: 1, messageId: first.messageId } });
    const conflict = await send(`${base}/director/messages`, 'POST', { ...first, content: 'khác' }, headers);
    expect(conflict.status).toBe(409);
    // Wrong CSRF and a foreign host session never reach the host.
    expect((await send(`${base}/director/messages`, 'POST', { ...first, messageId: randomUUID() }, { ...headers, 'x-bflow-csrf': 'x'.repeat(43) })).status).toBe(403);
    expect((await send(`${base}/director/messages`, 'POST', { ...first, messageId: randomUUID(), sessionId: 'conv-other' }, headers)).status).toBe(403);
    const pageBefore = (await send(`${base}/director/messages`, 'GET', undefined, headers)).json;
    expect(pageBefore.items.map((m: any) => m.messageId)).toEqual([first.messageId]);

    // CLI Director opens: the queued Web message is delivered by director_wait from the durable ack (pre-registration replay).
    const host = { repositoryPath: repo, sessionId };
    const director = await callDirectorOwnerHost(host, 'director_register', { provider: 'claude' }) as { token: string; cursor: string };
    const waited = DirectorWaitResultSchema.parse(await callDirectorTool(host, director.token, 'director_wait', { cursor: director.cursor, timeoutMs: 1000 }));
    expect(waited.messages.map(message => message.messageId)).toEqual([first.messageId]);
    // Web reads never acknowledge: the GETs above did not move the ack, a reopened Director gets the same message again.
    const reopened = await callDirectorOwnerHost(host, 'director_register', { provider: 'claude' }) as { token: string; cursor: string };
    const again = DirectorWaitResultSchema.parse(await callDirectorTool(host, reopened.token, 'director_wait', { cursor: reopened.cursor, timeoutMs: 1000 }));
    expect(again.messages.map(message => message.messageId)).toEqual([first.messageId]);
    // The Director's reply (CLI channel) and presence reach the Web through the same feed and transcript.
    await callDirectorTool(host, reopened.token, 'director_say', { text: `Đã nhận yêu cầu; token ${reopened.token}` });
    await expect.poll(async () => (await send(`${base}/director/messages`, 'GET', undefined, headers)).json.items.length, { timeout: 10_000 }).toBe(2);
    const transcript = (await send(`${base}/director/messages`, 'GET', undefined, headers)).json;
    expect(transcript.items).toMatchObject([{ seq: 1, author: 'user', channel: 'web' }, { seq: 2, author: 'director', channel: 'cli' }]);
    expect(JSON.stringify(transcript)).not.toContain(reopened.token);
    await expect.poll(() => stream.events.some(event => event.data.type === 'chat' && event.data.resourceIds.includes(transcript.items[1].messageId)), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => stream.events.some(event => event.data.type === 'invalidate' && event.data.resourceIds.includes('director')), { timeout: 10_000 }).toBe(true);
    const chatIds = stream.events.filter(event => event.data.type === 'chat').flatMap(event => event.data.resourceIds);
    expect(new Set(chatIds).size).toBe(chatIds.length);
    expect((await send(`${base}/director`, 'GET', undefined, headers)).json).toMatchObject({ transcriptSeq: 2, snapshot: { director: { presence: expect.stringMatching(/^(active|waiting)$/) } } });

    // A chat "duyệt" is only text: it creates no operation and no approval.
    const approveText = await send(`${base}/director/messages`, 'POST', { ...first, messageId: randomUUID(), content: 'duyệt #1' }, headers);
    expect(approveText.status).toBe(202);
    expect((await send(`${base}/decisions`, 'GET', undefined, headers)).json).toMatchObject({ items: [] });

    // Signed Web issue retry through the real host admission: an unknown run/issue is refused before any effect.
    const issueCommand = { apiVersion: 1, commandId: randomUUID(), projectId: project.projectId, kind: 'issue_retry', runId: 'run-unknown',
      issueId: 'park:run-unknown:implement:1', expectedUpdatedAt: new Date().toISOString() };
    const issued = await send(`${base}/commands`, 'POST', issueCommand, headers);
    expect(issued.status).toBe(202);
    // The host refuses with validation/details.reason=forbidden before any receipt effect; the generic /commands route maps a
    // host `validation` error to the public `invalid_request` code (local-server errors.ts contractError), so that is what the browser sees.
    expect(issued.json).toMatchObject({ operationId: issueCommand.commandId, state: 'failed', error: { code: 'invalid_request', retryable: false } });
    expect((await send(`${base}/director/issues`, 'GET', undefined, headers)).json).toMatchObject({ items: [] });

    // Host restart (down/up of the same session and manifest): the stream ends, the old cursor resumes into a reset (new host
    // feed epoch); the durable transcript survives and a lost-ACK replay of the first message still deduplicates.
    const lastCursor = stream.events.at(-1)!.id ?? stream.events.at(-1)!.data.cursor;
    const beforeRestart = stream.events.length;
    await controller.quiesce(); await controller.shutdown();
    controller = await activateDirectorHost(repo, sessionId, herdrBinary);
    // Race-free contract: if the open stream's upstream poll lands inside the host downtime, Local Server closes it (the Web client
    // then reconnects with its last cursor, apps/web/src/api/events.ts). Otherwise its first frame after the restart must be the
    // `reset`. Either way the new epoch is never spliced into the old stream as a continuation; the resumed stream asserts the reset below.
    await expect.poll(() => stream.closed || stream.events.length > beforeRestart, { timeout: 15_000 }).toBe(true);
    if (stream.events.length > beforeRestart) expect(stream.events[beforeRestart]!.data.type).toBe('reset');
    const resumed = openStream(server.origin, `${base}/events`, { Cookie: headers.Cookie, 'Last-Event-ID': lastCursor });
    cleanups.push(async () => resumed.close());
    await expect.poll(() => resumed.events.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(resumed.events[0]!.data.type).toBe('reset');
    await expect.poll(async () => (await send(`${base}/director/messages`, 'GET', undefined, headers)).status, { timeout: 15_000 }).toBe(200);
    const afterRestart = (await send(`${base}/director/messages`, 'GET', undefined, headers)).json;
    expect(afterRestart.items.map((m: any) => m.seq)).toEqual([1, 2, 3]);
    expect((await send(`${base}/director/messages`, 'POST', first, headers))).toMatchObject({ status: 202, json: { seq: 1 } });
    expect((await send(`${base}/director/messages`, 'GET', undefined, headers)).json.items).toHaveLength(3);
    // The in-memory Director binding is gone after restart: CLI capture is reported as possibly incomplete.
    expect((await send(`${base}/director`, 'GET', undefined, headers)).json).toMatchObject({ layout: 'director', cliCaptureMayBeIncomplete: true });
  }, 120_000);
});
