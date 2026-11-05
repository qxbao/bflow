import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { WebOperationSchema } from '@bflow/contracts/web';
import type { LocalWebDirectorServices } from '../src/index.js';

let f: Awaited<ReturnType<typeof fixture>>;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });

const now = () => new Date().toISOString();
const snapshot = (at: string) => ({ schemaVersion: 1, generatedAt: at, director: { presence: 'absent' }, runs: [], pendingApprovals: 0, pendingQuestions: 0, issues: [] });
const SECRET = 'sk-ant-api03-SECRETVALUE0123456789abcdefghijklmnop';
type Port = { [K in keyof LocalWebDirectorServices]: ReturnType<typeof vi.fn> };
function director(overrides: Partial<Record<keyof LocalWebDirectorServices, (...args: any[]) => Promise<unknown>>> = {}) {
  const port: Record<string, any> = {
    readView: vi.fn(async (projectId: string) => ({ ok: true, value: { apiVersion: 1, projectId, layout: 'director', sessionId: 'conv-1',
      snapshot: snapshot(now()), transcriptSeq: 0, cliCaptureMayBeIncomplete: false, observedAt: now() } })),
    messages: vi.fn(async () => ({ ok: true, value: { apiVersion: 1, items: [], nextCursor: 'a0' } })),
    send: vi.fn(async (input: { messageId: string; content: string }) => ({ ok: true, value: { schemaVersion: 1, seq: 1, messageId: input.messageId,
      author: 'user', channel: 'web', text: input.content, at: now() } })),
    issues: vi.fn(async () => ({ ok: true, value: { apiVersion: 1, items: [] } })),
    launchOptions: vi.fn(async (projectId: string) => ({ ok: true, value: { apiVersion: 1, projectId, terminal: { available: true },
      providers: [{ provider: 'claude', state: 'available', manualCommand: "cd '/repo' && BFLOW_DIRECTOR_PROVIDER=claude 'claude' '/bflow-start'" }], observedAt: now() } })),
    launch: vi.fn(async (_projectId: string, request: { provider: string }) => ({ ok: true, value: { kind: 'director_launch', provider: request.provider,
      mode: 'terminal_opened', manualCommand: "cd '/repo' && BFLOW_DIRECTOR_PROVIDER=claude 'claude' '/bflow-start'", launchedAt: now() } })),
    ...overrides
  };
  for (const key of Object.keys(overrides)) port[key] = vi.fn(overrides[key as keyof LocalWebDirectorServices]!);
  return port as unknown as LocalWebDirectorServices & Port;
}
async function setup(port?: LocalWebDirectorServices) {
  f = await fixture({}, undefined, port ? { director: port } : {});
  const { headers } = await f.login();
  const projectId = (await f.send('/api/v1/projects', 'POST', { apiVersion: 1, path: await f.repo() }, headers)).json.projectId as string;
  const base = `/api/v1/projects/${projectId}/director`;
  return { headers, projectId, base };
}
const launchBody = (operationId = randomUUID(), provider = 'claude', replaceActive = false) => ({ apiVersion: 1, operationId, provider, replaceActive });
const sendBody = (projectId: string, content = 'Xin chào') => ({ apiVersion: 1, messageId: randomUUID(), projectId, sessionId: 'conv-1', content });
async function ledger(): Promise<string> {
  const names = (await readdir(f.stateDirectory)).filter(name => name.startsWith('operation-'));
  return (await Promise.all(names.map(name => readFile(join(f.stateDirectory, name), 'utf8')))).join('\n');
}

it('legacy backend without the Director port answers operation_not_allowed on all six routes; old routes unchanged', async () => {
  const { headers, projectId, base } = await setup();
  for (const [path, method, body] of [[base, 'GET'], [`${base}/messages`, 'GET'], [`${base}/messages`, 'POST', sendBody(projectId)],
    [`${base}/issues`, 'GET'], [`${base}/launch-options`, 'GET'], [`${base}/launch`, 'POST', launchBody()]] as const) {
    const response = await f.send(path, method, body, headers);
    expect(response.status, path).toBe(422);
    expect(response.json).toMatchObject({ code: 'operation_not_allowed', retryable: false });
    expect(response.json.message).toContain('bflow web');
  }
  expect(await ledger()).toBe('');
  expect((await f.send('/api/v1/projects', 'GET', undefined, headers)).status).toBe(200);
  expect((await f.send(`/api/v1/projects/${projectId}/session`, 'GET', undefined, headers)).status).toBe(503);
});

it('serves the Director reads parsed by contract and scoped to the canonical project', async () => {
  const port = director();
  const { headers, projectId, base } = await setup(port);
  const view = await f.send(base, 'GET', undefined, headers);
  expect(view.status).toBe(200);
  expect(view.json).toMatchObject({ projectId, layout: 'director' });
  expect((await f.send(`${base}/messages?cursor=a3`, 'GET', undefined, headers)).json).toEqual({ apiVersion: 1, items: [], nextCursor: 'a0' });
  expect(port.messages.mock.calls[0]!.slice(0, 2)).toEqual([projectId, 'a3']);
  expect(port.messages.mock.calls[0]![2]).toMatchObject({ browserSessionId: expect.any(String) });
  expect((await f.send(`${base}/issues?cursor=o100`, 'GET', undefined, headers)).status).toBe(200);
  expect(port.issues.mock.calls[0]!.slice(0, 2)).toEqual([projectId, 'o100']);
  expect((await f.send(`${base}/launch-options`, 'GET', undefined, headers)).json).toMatchObject({ projectId, terminal: { available: true } });
  // Unknown query keys and malformed cursors are refused at ingress.
  expect((await f.send(`${base}/messages?limit=5`, 'GET', undefined, headers)).status).toBe(400);
});

it('refuses a cross-project view or a foreign send body, and backend shapes that break the contract', async () => {
  const port = director({ readView: async () => ({ ok: true, value: { apiVersion: 1, projectId: 'project-other', layout: 'director',
    snapshot: snapshot(now()), transcriptSeq: 0, cliCaptureMayBeIncomplete: false, observedAt: now() } }),
    issues: async () => ({ ok: true, value: { apiVersion: 1, items: [{ token: SECRET }] } }) });
  const { headers, projectId, base } = await setup(port);
  const view = await f.send(base, 'GET', undefined, headers);
  expect(view.status).toBe(503);
  expect(view.body).not.toContain('project-other');
  expect((await f.send(`${base}/messages`, 'POST', { ...sendBody(projectId), projectId: 'project-other' }, headers)).status).toBe(403);
  expect(port.send).not.toHaveBeenCalled();
  const issues = await f.send(`${base}/issues`, 'GET', undefined, headers);
  expect(issues.status).toBe(503);
  expect(issues.body).not.toContain(SECRET);
  expect((await f.send('/api/v1/projects/project-unknown/director', 'GET', undefined, headers)).status).toBe(404);
});

it('requires cookie, CSRF and same Origin before any Director effect', async () => {
  const port = director();
  const { headers, projectId, base } = await setup(port);
  const noCsrf = await f.send(`${base}/messages`, 'POST', sendBody(projectId), { Cookie: headers.Cookie });
  expect(noCsrf.status).toBe(403);
  const badOrigin = await f.send(`${base}/launch`, 'POST', launchBody(), { ...headers, Origin: 'http://evil.example' });
  expect(badOrigin.status).toBe(403);
  expect((await f.send(`${base}/launch`, 'POST', launchBody(), { Cookie: headers.Cookie })).status).toBe(403);
  expect((await f.send(base, 'GET')).status).toBe(401);
  expect((await f.send(base, 'GET', undefined, { Cookie: 'bflow_session=' + 'A'.repeat(43) })).status).toBe(401);
  expect(port.send).not.toHaveBeenCalled();
  expect(port.launch).not.toHaveBeenCalled();
  expect(port.readView).not.toHaveBeenCalled();
  expect(await ledger()).toBe('');
});

it('rechecks the cookie after queueing: a send queued behind another never reaches the host once the session expired', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const port = director({ send: async (input: { messageId: string; content: string }) => {
    calls++; if (calls === 1) await gate;
    return { ok: true, value: { schemaVersion: 1, seq: calls, messageId: input.messageId, author: 'user', channel: 'web', text: input.content, at: now() } };
  } });
  const { headers, projectId, base } = await setup(port);
  const first = f.send(`${base}/messages`, 'POST', sendBody(projectId, 'một'), headers);
  await vi.waitFor(() => expect(calls).toBe(1));
  const second = f.send(`${base}/messages`, 'POST', sendBody(projectId, 'hai'), headers);
  await new Promise(resolve => setTimeout(resolve, 100));
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 13 * 3600 * 1000);
  release();
  expect((await first).status).toBe(202);
  const late = await second;
  expect(late.status).toBe(401);
  expect(late.json.code).toBe('session_required');
  expect(calls).toBe(1);
});

it('maps host refusals to actionable Vietnamese errors without backend text', async () => {
  const leak = `private token ${SECRET} /Users/me/.bflow/state/socket`;
  const port = director({
    readView: async () => ({ ok: false, error: { code: 'transport_unavailable', retryable: true, message: leak, details: { reason: 'unavailable' } } }),
    messages: async () => ({ ok: false, error: { code: 'validation', retryable: false, message: leak, details: { reason: 'operation_not_allowed' } } }),
    send: async () => ({ ok: false, error: { code: 'conflict', retryable: true, message: leak, details: { reason: 'stale_version' } } }),
    issues: async () => ({ ok: false, error: { code: 'unknown_delivery', retryable: false, manualInterventionRequired: true, message: leak } })
  });
  const { headers, projectId, base } = await setup(port);
  const down = await f.send(base, 'GET', undefined, headers);
  expect(down.status).toBe(503);
  expect(down.json).toMatchObject({ code: 'unavailable', retryable: true });
  expect(down.json.message).toContain('bflow up');
  const legacy = await f.send(`${base}/messages`, 'GET', undefined, headers);
  expect(legacy.status).toBe(422);
  expect(legacy.json.message).toContain('bố cục Director');
  const stale = await f.send(`${base}/messages`, 'POST', sendBody(projectId), headers);
  expect(stale.status).toBe(409);
  expect(stale.json.code).toBe('stale_version');
  const unknown = await f.send(`${base}/issues`, 'GET', undefined, headers);
  expect(unknown.status).toBe(503);
  expect(unknown.json.code).toBe('reconciliation_required');
  for (const response of [down, legacy, stale, unknown]) {
    expect(response.body).not.toContain(SECRET);
    expect(response.body).not.toContain('.bflow');
    expect(response.body).not.toContain('private token');
  }
});

it('reports an unavailable repository directory with an actionable message', async () => {
  const port = director();
  const { headers, base } = await setup(port);
  const { rm } = await import('node:fs/promises');
  await rm(join(f.directory, 'repo'), { recursive: true, force: true });
  const response = await f.send(base, 'GET', undefined, headers);
  expect(response.status).toBe(503);
  expect(response.json.message).toContain('đăng ký lại dự án');
  expect(port.readView).not.toHaveBeenCalled();
});

it('persists the launch intent before the effect and replays the same operation observe-only', async () => {
  let seenLedger = '';
  const port = director({ launch: async (_projectId: string, request: { provider: string; replaceActive: boolean }) => {
    seenLedger = await ledger();
    return { ok: true, value: { kind: 'director_launch', provider: request.provider, mode: 'manual_command',
      manualCommand: "cd '/repo' && BFLOW_DIRECTOR_PROVIDER=claude 'claude' '/bflow-start'", launchedAt: now() } };
  } });
  const { headers, projectId, base } = await setup(port);
  const body = launchBody(randomUUID(), 'claude', true);
  const first = await f.send(`${base}/launch`, 'POST', body, headers);
  expect(first.status).toBe(202);
  expect(WebOperationSchema.parse(first.json)).toMatchObject({ operationId: body.operationId, projectId, owner: 'local_lifecycle',
    operationKind: 'director_launch', state: 'applied', result: { kind: 'director_launch', provider: 'claude', mode: 'manual_command' } });
  expect(seenLedger).toContain('"state":"accepted"');
  expect(seenLedger).toContain('director_launch');
  expect(port.launch.mock.calls[0]!.slice(0, 2)).toEqual([projectId, { provider: 'claude', replaceActive: true }]);
  const replay = await f.send(`${base}/launch`, 'POST', body, headers);
  expect(replay.status).toBe(202);
  expect(replay.json).toEqual(first.json);
  expect((await f.send(`/api/v1/projects/${projectId}/operations/${body.operationId}`, 'GET', undefined, headers)).json).toEqual(first.json);
  // Same operation ID with a different provider or replaceActive is a conflict, never a second launch.
  const conflict = await f.send(`${base}/launch`, 'POST', { ...body, provider: 'codex' }, headers);
  expect(conflict.status).toBe(409);
  expect(conflict.json.code).toBe('operation_conflict');
  expect((await f.send(`${base}/launch`, 'POST', { ...body, replaceActive: false }, headers)).status).toBe(409);
  expect(port.launch).toHaveBeenCalledTimes(1);
  // After a restart the applied receipt is still replayed without an effect.
  await f.restart();
  const { headers: again } = await f.login();
  expect((await f.send(`${base}/launch`, 'POST', body, again)).json).toEqual(first.json);
  expect(port.launch).toHaveBeenCalledTimes(1);
});

it('crash boundary after spawn: a restart with an in-flight intent is reconciliation_required and never relaunches', async () => {
  let inFlight = '';
  let file = '';
  const port = director({ launch: async (_projectId: string, request: { provider: string }) => {
    // Snapshot the ledger exactly as persisted before the effect settles (what a crash right after spawn leaves).
    file = (await readdir(f.stateDirectory)).find(name => name.startsWith('operation-'))!;
    inFlight = await readFile(join(f.stateDirectory, file), 'utf8');
    return { ok: true, value: { kind: 'director_launch', provider: request.provider, mode: 'terminal_opened',
      manualCommand: "cd '/repo' && BFLOW_DIRECTOR_PROVIDER=claude 'claude' '/bflow-start'", launchedAt: now() } };
  } });
  const { headers, projectId, base } = await setup(port);
  const body = launchBody();
  expect((await f.send(`${base}/launch`, 'POST', body, headers)).json.state).toBe('applied');
  await f.server.close();
  await writeFile(join(f.stateDirectory, file), inFlight, { mode: 0o600 });
  await f.restart();
  const { headers: again } = await f.login();
  const observed = await f.send(`/api/v1/projects/${projectId}/operations/${body.operationId}`, 'GET', undefined, again);
  expect(observed.status).toBe(200);
  expect(observed.json).toMatchObject({ state: 'reconciliation_required', error: { code: 'reconciliation_required' } });
  expect(observed.json.error.message).toContain('không tự mở lại');
  const replay = await f.send(`${base}/launch`, 'POST', body, again);
  expect(replay.json.state).toBe('reconciliation_required');
  expect(port.launch).toHaveBeenCalledTimes(1);
});

it('keeps launch_uncertain and lost acknowledgements reconciliation_required; a proven pre-effect refusal fails definitively', async () => {
  const outcomes: unknown[] = [
    { ok: false, error: { code: 'unknown_delivery', retryable: false, manualInterventionRequired: true, message: `uncertain ${SECRET}`, details: { reason: 'launch_uncertain' } } },
    { ok: false, error: { code: 'transport_unavailable', retryable: true, message: `down ${SECRET}` } },
    { ok: false, error: { code: 'validation', retryable: false, message: `active ${SECRET}`, details: { reason: 'director_active' } } }
  ];
  let calls = 0;
  const port = director({ launch: async () => { calls++; const next = outcomes.shift(); if (!next) throw new Error(SECRET); return next; } });
  const { headers, base } = await setup(port);
  const uncertain = launchBody();
  const first = await f.send(`${base}/launch`, 'POST', uncertain, headers);
  expect(first.json).toMatchObject({ state: 'reconciliation_required', error: { code: 'reconciliation_required' } });
  expect(first.json.error.message).toContain('Không rõ cửa sổ terminal');
  expect((await f.send(`${base}/launch`, 'POST', uncertain, headers)).json.state).toBe('reconciliation_required');
  const lost = await f.send(`${base}/launch`, 'POST', launchBody(), headers);
  expect(lost.json).toMatchObject({ state: 'reconciliation_required', error: { code: 'reconciliation_required' } });
  const refused = await f.send(`${base}/launch`, 'POST', launchBody(), headers);
  expect(refused.json).toMatchObject({ state: 'failed', error: { code: 'operation_not_allowed' } });
  expect(refused.json.error.message).toContain('phiên thay thế');
  const thrown = await f.send(`${base}/launch`, 'POST', launchBody(), headers);
  expect(thrown.json.state).toBe('reconciliation_required');
  expect(calls).toBe(4);
  for (const response of [first, lost, refused, thrown]) expect(response.body).not.toContain(SECRET);
  expect(await ledger()).not.toContain(SECRET);
});

it('a stale browser session cannot replay a launch: authorization runs again inside the operation queue', async () => {
  const port = director();
  const { headers, base } = await setup(port);
  const body = launchBody();
  expect((await f.send(`${base}/launch`, 'POST', body, headers)).status).toBe(202);
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 13 * 3600 * 1000);
  expect((await f.send(`${base}/launch`, 'POST', body, headers)).status).toBe(401);
  expect((await f.send(`${base}/launch`, 'POST', launchBody(), headers)).status).toBe(401);
  expect(port.launch).toHaveBeenCalledTimes(1);
});

it('an uncertain launch does not block unregister; after re-registering, its replay stays reconciliation_required and never spawns', async () => {
  const port = director({ launch: async () => ({ ok: false, error: { code: 'unknown_delivery', retryable: false, manualInterventionRequired: true,
    message: 'uncertain', details: { reason: 'launch_uncertain' } } }) });
  const { headers, projectId, base } = await setup(port);
  const body = launchBody();
  expect((await f.send(`${base}/launch`, 'POST', body, headers)).json.state).toBe('reconciliation_required');
  const removed = await f.send(`/api/v1/projects/${projectId}`, 'DELETE', { apiVersion: 1, confirmed: true }, headers);
  expect(removed.status).toBe(204);
  // The receipt is kept as audit: the same canonical path re-registers to the same project ID, and the replay only observes.
  const again = await f.send('/api/v1/projects', 'POST', { apiVersion: 1, path: join(f.directory, 'repo') }, headers);
  expect(again.json.projectId).toBe(projectId);
  const replay = await f.send(`${base}/launch`, 'POST', body, headers);
  expect(replay.status).toBe(202);
  expect(replay.json).toMatchObject({ operationId: body.operationId, state: 'reconciliation_required' });
  expect((await f.send(`/api/v1/projects/${projectId}/operations/${body.operationId}`, 'GET', undefined, headers)).json.state).toBe('reconciliation_required');
  expect(port.launch).toHaveBeenCalledTimes(1);
});

it('binds a profile to the durable launch intent and refuses reusing its ID for another account',async()=>{
 const port=director({launch:async(_id,request)=>({ok:true,value:{kind:'director_launch',provider:request.provider,profileName:request.profileName,
  mode:'manual_command',manualCommand:'ai-isolator run codex --name work -- $bflow-start',launchedAt:now()}})});
 const {headers,projectId,base}=await setup(port);const body={...launchBody(randomUUID(),'codex',false),profileName:'work'};
 const first=await f.send(`${base}/launch`,'POST',body,headers);expect(first.status).toBe(202);
 expect(first.json).toMatchObject({state:'applied',result:{provider:'codex',profileName:'work'}});
 expect(port.launch.mock.calls[0]![1]).toEqual({provider:'codex',profileName:'work',replaceActive:false});
 expect((await f.send(`${base}/launch`,'POST',body,headers)).json).toEqual(first.json);
 expect((await f.send(`${base}/launch`,'POST',{...body,profileName:'personal'},headers)).status).toBe(409);
 const {profileName:_,...native}=body;expect((await f.send(`${base}/launch`,'POST',native,headers)).status).toBe(409);
 expect(port.launch).toHaveBeenCalledOnce();
 expect((await f.send(`${base}/launch`,'POST',{...body,operationId:randomUUID(),profileName:'../secret'},headers)).status).toBe(400);
});
it('never settles a launch as applied when the returned profile differs from the requested one',async()=>{
 const port=director({launch:async()=>({ok:true,value:{kind:'director_launch',provider:'codex',profileName:'other',mode:'terminal_opened',manualCommand:'codex',launchedAt:now()}})});
 const {headers,base}=await setup(port);expect((await f.send(`${base}/launch`,'POST',{...launchBody(randomUUID(),'codex',false),profileName:'work'},headers)).json)
  .toMatchObject({state:'reconciliation_required'});
});
