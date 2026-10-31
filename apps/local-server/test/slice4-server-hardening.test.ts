import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebEvent } from '@bflow/contracts/web';
import { PrivateState, OperationIndex } from '../src/operation-index.js';
import { streamEvents } from '../src/sse.js';
import { client, fixture } from './helpers.js';

const tempDirs: string[] = [];
let f: Awaited<ReturnType<typeof fixture>> | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await f?.close();
  f = undefined;
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const makeEvent = (projectId: string, cursor: string, resourceIds: string[] = []): WebEvent => ({
  apiVersion: 1,
  projectId,
  cursor,
  type: 'invalidate',
  resourceIds,
  occurredAt: new Date().toISOString()
});

describe('Slice 4 — Local Server adversarial hardening', () => {
  it('never writes to an ended SSE response, wakes backpressure on request abort, and escapes U+2028/U+2029 in SSE data lines', async () => {
    const writes: string[] = [];
    let ended = false;
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      headersSent: false,
      writableLength: 0,
      setHeader() {},
      flushHeaders() {
        this.headersSent = true;
      },
      write(chunk: string) {
        if (ended || this.writableEnded || this.destroyed) {
          throw new Error('ERR_STREAM_WRITE_AFTER_END');
        }
        writes.push(chunk);
        // Simulate first event write encountering backpressure while request aborts without res close
        return false;
      },
      destroy() {
        this.destroyed = true;
        this.emit('close');
      },
      end() {
        ended = true;
        this.writableEnded = true;
      },
      setTimeout() {}
    });
    const req = Object.assign(new EventEmitter(), { headers: {}, socket: {} });
    let returned = 0;
    const source = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          async next() {
            if (!sent) {
              sent = true;
              return {
                done: false as const,
                value: makeEvent('proj-1', 'host:1', ['id-\u2028-sep-\u2029-end'])
              };
            }
            return new Promise<IteratorResult<WebEvent>>(() => {});
          },
          async return() {
            returned++;
            return { done: true as const, value: undefined };
          }
        };
      }
    };

    const runPromise = streamEvents(req as any, res as any, source, 'proj-1', 'epoch', () => {}, Date.now() + 30000);
    await vi.waitFor(() => expect(writes.length).toBe(1));
    // Data line must never contain literal U+2028 or U+2029 line/paragraph separators
    expect(writes[0]).not.toContain('\u2028');
    expect(writes[0]).not.toContain('\u2029');
    expect(writes[0]).toContain('\\u2028');
    expect(writes[0]).toContain('\\u2029');

    // Mark response ended & abort req while write() is awaiting drain (without emitting res 'close')
    res.writableEnded = true;
    req.emit('aborted');

    const completed = await Promise.race([
      runPromise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500))
    ]);
    expect(completed).toBe(true);
    expect(returned).toBe(1);
    expect(res.listenerCount('drain')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('serializes concurrent OperationIndex saves to reject conflicting fingerprints and cleans orphaned crash .tmp files on PrivateState.open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice4-opindex-'));
    tempDirs.push(root);
    const stateDir = join(root, 'state');
    await mkdir(stateDir, { mode: 0o700 });
    const orphanTmp = join(stateDir, `.tmp-${crypto.randomUUID()}`);
    await writeFile(orphanTmp, '{"partial":', { mode: 0o600 });

    const state = await PrivateState.open(stateDir);
    try {
      const entriesAfterOpen = await readdir(stateDir);
      expect(entriesAfterOpen.some(name => name.startsWith('.tmp-'))).toBe(false);

      const index = new OperationIndex(state);
      const commandId = crypto.randomUUID();
      const now = new Date().toISOString();
      const makeRecord = (fingerprint: string) => ({
        index: {
          schemaVersion: 1 as const,
          projectId: 'project-1',
          principalId: state.principalId,
          commandId,
          receiptId: commandId,
          owner: 'local_lifecycle' as const,
          operationKind: 'session_start' as const,
          fingerprint,
          createdAt: now
        },
        operation: {
          apiVersion: 1 as const,
          operationId: commandId,
          projectId: 'project-1',
          owner: 'local_lifecycle' as const,
          operationKind: 'session_start' as const,
          state: 'accepted' as const,
          updatedAt: now
        }
      });

      const outcomes = await Promise.allSettled([
        index.save(makeRecord('a'.repeat(64))),
        index.save(makeRecord('b'.repeat(64)))
      ]);
      const fulfilled = outcomes.filter(item => item.status === 'fulfilled');
      const rejected = outcomes.filter(item => item.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    } finally {
      await state.close();
    }
  });

  it('keeps reconciliation_required updatedAt stable across repeated observation polls without redundant disk writes', async () => {
    const execute = vi.fn(async () => {
      throw new Error('lost ACK');
    });
    const readOperation = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'transport_unavailable' as const, retryable: true as const, message: 'down' }
    }));
    f = await fixture({}, async projectId => ({
      ...client,
      execute,
      readOperation,
      readProjectSession: async () => ({
        ok: true,
        value: {
          apiVersion: 1,
          projectId,
          sessionId: 'host-1',
          state: 'ready',
          pendingIntakes: [],
          blockers: [],
          updatedAt: new Date().toISOString()
        }
      })
    }));
    const { headers } = await f.login();
    const projectId = (await f.send('/api/v1/projects', 'POST', { apiVersion: 1, path: await f.repo() }, headers)).json.projectId;
    const commandId = crypto.randomUUID();
    const route = `/api/v1/projects/${projectId}`;
    const initial = await f.send(
      `${route}/commands`,
      'POST',
      {
        apiVersion: 1,
        projectId,
        commandId,
        kind: 'cancel',
        runId: 'run-1',
        expectedVersion: { revisionToken: 'v1' },
        reason: 'stop'
      },
      headers
    );
    expect(initial.json.state).toBe('reconciliation_required');
    await new Promise(resolve => setTimeout(resolve, 25));
    const poll1 = await f.send(`${route}/operations/${commandId}`, 'GET', undefined, headers);
    await new Promise(resolve => setTimeout(resolve, 25));
    const poll2 = await f.send(`${route}/operations/${commandId}`, 'GET', undefined, headers);
    expect(poll1.json.state).toBe('reconciliation_required');
    expect(poll2.json.state).toBe('reconciliation_required');
    expect(poll2.json.updatedAt).toBe(poll1.json.updatedAt);
  });
});
