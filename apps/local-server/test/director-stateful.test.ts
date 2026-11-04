import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import type { LocalWebDirectorServices } from '../src/index.js';

// Director C/D Task 9: seeded stateful model of the Director launch/send routes across restarts and session expiry.
// Evidence level: real Local Server HTTP + persisted operation ledger with a scripted Director port (no terminal, no host).

let f: Awaited<ReturnType<typeof fixture>>;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });

/** mulberry32: reproducible sequences without new dependencies. */
function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { int: (n: number) => Math.floor(next() * n), pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]! };
}
const now = () => new Date().toISOString();
const COMMAND = "cd '/repo' && BFLOW_DIRECTOR_PROVIDER=claude 'claude' '/bflow-start'";
type Outcome = 'terminal_opened' | 'manual_command' | 'launch_uncertain' | 'refused' | 'thrown';
const EXPECTED_STATE: Record<Outcome, string> = { terminal_opened: 'applied', manual_command: 'applied', launch_uncertain: 'reconciliation_required', refused: 'failed', thrown: 'reconciliation_required' };

it('seeded launch/replay/restart/expiry/send sequence: one effect per operation ID, uncertain stays reconciliation_required, expired sessions never reach the port', async () => {
  const random = seeded(0xd1ec70);
  let nextOutcome: Outcome = 'terminal_opened';
  const sends: string[] = [];
  const port: LocalWebDirectorServices = {
    readView: async projectId => ({ ok: true, value: { apiVersion: 1, projectId, layout: 'director', sessionId: 'conv-1', transcriptSeq: sends.length, cliCaptureMayBeIncomplete: true,
      snapshot: { schemaVersion: 1, generatedAt: now(), director: { presence: 'absent' }, runs: [], pendingApprovals: 0, pendingQuestions: 0, issues: [] }, observedAt: now() } }),
    messages: async () => ({ ok: true, value: { apiVersion: 1, items: [] } }),
    send: async input => { sends.push(input.messageId); return { ok: true, value: { schemaVersion: 1, seq: sends.length, messageId: input.messageId, author: 'user', channel: 'web', text: input.content, at: now() } }; },
    issues: async () => ({ ok: true, value: { apiVersion: 1, items: [] } }),
    launchOptions: async projectId => ({ ok: true, value: { apiVersion: 1, projectId, terminal: { available: false, reason: 'Không có phiên desktop' },
      providers: [{ provider: 'claude', state: 'available', manualCommand: COMMAND }], observedAt: now() } }),
    launch: async (_projectId, request) => {
      const outcome = nextOutcome;
      if (outcome === 'thrown') throw new Error('terminal spawn crashed after fork');
      if (outcome === 'launch_uncertain') return { ok: false, error: { code: 'unknown_delivery', retryable: false, manualInterventionRequired: true, message: 'uncertain', details: { reason: 'launch_uncertain' } } };
      if (outcome === 'refused') return { ok: false, error: { code: 'validation', retryable: false, message: 'refused', details: { reason: 'provider_unavailable' } } };
      return { ok: true, value: { kind: 'director_launch', provider: request.provider, mode: outcome, manualCommand: COMMAND, launchedAt: now() } };
    }
  };
  const counted = { ...port, launch: vi.fn(port.launch), send: vi.fn(port.send) };
  f = await fixture({}, undefined, { director: counted });
  let { headers } = await f.login();
  const projectId = (await f.send('/api/v1/projects', 'POST', { apiVersion: 1, path: await f.repo() }, headers)).json.projectId as string;
  const base = `/api/v1/projects/${projectId}/director`;
  // The no-Desktop launch option is shown with its manual command; reading it has no effect.
  expect((await f.send(`${base}/launch-options`, 'GET', undefined, headers)).json).toMatchObject({ terminal: { available: false }, providers: [{ manualCommand: COMMAND }] });

  /** Model: operationId → {outcome, body, response} for every launch that reached the effect. */
  const model = new Map<string, { body: Record<string, unknown>; state: string; json: unknown }>();
  let expired = false, effects = 0, sent = 0;
  const realNow = Date.now.bind(Date);
  let clock: { mockRestore(): void } | undefined;
  const restoreClock = () => { clock?.mockRestore(); clock = undefined; };
  const ops = ['launch', 'launch', 'replay', 'replay', 'restart', 'expire', 'relogin', 'send', 'conflict'] as const;
  const trace: string[] = [];
  let refusedWhileExpired = 0;
  for (let step = 0; step < 80; step++) {
    const op = random.pick(ops); trace.push(op);
    if (op === 'launch') {
      nextOutcome = random.pick(['terminal_opened', 'manual_command', 'launch_uncertain', 'refused', 'thrown'] as const);
      const body = { apiVersion: 1, operationId: randomUUID(), provider: 'claude', replaceActive: random.int(2) === 1 };
      const response = await f.send(`${base}/launch`, 'POST', body, headers);
      if (expired) { expect(response.status).toBe(401); refusedWhileExpired++; continue; }
      expect(response.status).toBe(202);
      effects++;
      expect(response.json.state).toBe(EXPECTED_STATE[nextOutcome]);
      if (nextOutcome === 'manual_command') expect(response.json.result).toMatchObject({ mode: 'manual_command', manualCommand: COMMAND });
      model.set(body.operationId, { body, state: response.json.state, json: response.json });
    } else if (op === 'replay' && model.size > 0) {
      const [operationId, known] = [...model.entries()][random.int(model.size)]!;
      const response = await f.send(`${base}/launch`, 'POST', known.body, headers);
      if (expired) { expect(response.status).toBe(401); refusedWhileExpired++; continue; }
      // Replay observes the stored receipt only: an uncertain launch is never re-spawned, an applied one is returned unchanged.
      expect(response.json).toMatchObject({ operationId, state: known.state });
      if (known.state === 'applied') expect(response.json).toEqual(known.json);
    } else if (op === 'conflict' && model.size > 0 && !expired) {
      const [, known] = [...model.entries()][random.int(model.size)]!;
      const response = await f.send(`${base}/launch`, 'POST', { ...known.body, replaceActive: !known.body.replaceActive }, headers);
      expect(response.status).toBe(409);
    } else if (op === 'restart') {
      restoreClock(); await f.restart(); expired = false;
      ({ headers } = await f.login());
    } else if (op === 'expire') {
      restoreClock(); clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 13 * 3600 * 1000); expired = true;
    } else if (op === 'relogin') {
      restoreClock(); expired = false; ({ headers } = await f.login());
    } else if (op === 'send') {
      const response = await f.send(`${base}/messages`, 'POST', { apiVersion: 1, messageId: randomUUID(), projectId, sessionId: 'conv-1', content: `tin ${step}` }, headers);
      if (expired) { expect(response.status).toBe(401); refusedWhileExpired++; } else { expect(response.status).toBe(202); sent++; }
    }
    // Invariants: the launch effect ran exactly once per accepted operation ID, the send effect once per accepted message.
    expect(counted.launch).toHaveBeenCalledTimes(effects);
    expect(counted.send).toHaveBeenCalledTimes(sent);
  }
  restoreClock();
  // After a final restart every receipt is still observed exactly as recorded and nothing is launched again.
  await f.restart(); ({ headers } = await f.login());
  for (const [operationId, known] of model) {
    const observed = await f.send(`/api/v1/projects/${projectId}/operations/${operationId}`, 'GET', undefined, headers);
    expect(observed.json).toMatchObject({ operationId, state: known.state });
  }
  expect(counted.launch).toHaveBeenCalledTimes(effects);
  expect([...model.values()].some(item => item.state === 'reconciliation_required')).toBe(true);
  // The seed exercises every operation kind, and some requests arrived with an expired session.
  expect(new Set(trace)).toEqual(new Set(ops));
  expect(refusedWhileExpired).toBeGreaterThan(0);
  expect(new Set([...model.values()].map(item => item.state))).toEqual(new Set(['applied', 'failed', 'reconciliation_required']));
}, 120_000);
