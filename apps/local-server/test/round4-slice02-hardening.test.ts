import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebEvent } from '@bflow/contracts/web';
import { streamEvents } from '../src/sse.js';
import { fixture, client } from './helpers.js';

let f: Awaited<ReturnType<typeof fixture>> | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await f?.close();
  f = undefined;
});

const makeEvent = (projectId: string, cursor: string, type: WebEvent['type'] = 'invalidate', resourceIds: string[] = ['run-1']): WebEvent => ({
  apiVersion: 1,
  projectId,
  cursor,
  type,
  resourceIds,
  occurredAt: new Date().toISOString()
});

describe('Round 4 Slice 2 — Local Server Hardening Regression Suite', () => {
  it('delivers all queued and terminal events before ending SSE stream when upstream completes', async () => {
    const writtenChunks: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      headersSent: false,
      writableLength: 0,
      statusCode: 0,
      setHeader() {},
      flushHeaders() { this.headersSent = true; },
      write(text: string) {
        writtenChunks.push(text);
        // Simulate async socket drain delay to exercise concurrent producer completion
        setImmediate(() => this.emit('drain'));
        return false;
      },
      destroy() { this.destroyed = true; this.emit('close'); },
      end() { this.writableEnded = true; this.emit('close'); },
      setTimeout() {}
    });
    const req = Object.assign(new EventEmitter(), { headers: {} });

    // Source yields 3 events in sequence then completes (done: true)
    const events: WebEvent[] = [
      makeEvent('proj-1', 'host:1', 'reset'),
      makeEvent('proj-1', 'host:2', 'invalidate'),
      makeEvent('proj-1', 'host:3', 'invalidate') // terminal event
    ];

    let idx = 0;
    const source = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (idx < events.length) {
              const val = events[idx++];
              return { done: false as const, value: val };
            }
            return { done: true as const, value: undefined };
          },
          async return() {
            return { done: true as const, value: undefined };
          }
        };
      }
    };

    await streamEvents(req as any, res as any, source, 'proj-1', 'epoch1', () => {}, Date.now() + 10000);

    expect(res.writableEnded).toBe(true);
    // Parse delivered events from writtenChunks
    const fullText = writtenChunks.join('');
    const eventMatches = [...fullText.matchAll(/id: ([^\n]+)\nevent: ([^\n]+)\ndata: ([^\n]+)\n\n/g)];
    const cursorsDelivered = eventMatches.map(m => m[1]);

    // All 3 events, including the terminal event host:3, MUST be delivered
    expect(cursorsDelivered).toContain('epoch1_host:1');
    expect(cursorsDelivered).toContain('epoch1_host:2');
    expect(cursorsDelivered).toContain('epoch1_host:3');
    expect(cursorsDelivered).toHaveLength(3);
  });

  it('rejects command with operation_not_allowed when session is not ready to avoid bricking CommandStore', async () => {
    f = await fixture(
      {},
      async projectId => ({
        ...client,
        readProjectSession: async () => ({
          ok: true,
          value: {
            apiVersion: 1,
            projectId,
            sessionId: 'conv-1',
            state: 'unavailable', // session not ready
            pendingIntakes: [],
            blockers: [{ code: 'host_unavailable', message: 'Host is stopped.' }],
            updatedAt: new Date().toISOString()
          }
        })
      })
    );

    const { headers } = await f.login();
    const repoPath = await f.repo('repo-stopped');
    const project = (await f.send('/api/v1/projects', 'POST', { apiVersion: 1, path: repoPath }, headers)).json;

    const command = {
      apiVersion: 1,
      projectId: project.projectId,
      commandId: randomUUID(),
      kind: 'cancel',
      runId: 'run-1',
      expectedVersion: { revisionToken: 'tok-12345678' },
      reason: 'test reason'
    };

    const res = await f.send(`/api/v1/projects/${project.projectId}/commands`, 'POST', command, headers);
    // Must be 422 (operation_not_allowed) so that CommandStore clears the slot rather than leaving it in limbo
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('operation_not_allowed');
    expect(res.json.retryable).toBe(false);
  });

  it('blocks unregistering a project while an operation is still reconciliation_required', async () => {
    f = await fixture();
    const { headers } = await f.login();
    const repoPath = await f.repo('repo-reconcile');
    const project = (await f.send('/api/v1/projects', 'POST', { apiVersion: 1, path: repoPath }, headers)).json;
    const opId = randomUUID();

    // Close server temporarily so we can write into the PrivateState ledger
    const stateDir = f.stateDirectory;
    await f.server.close();

    const { PrivateState, OperationIndex } = await import('../src/operation-index.js');
    const state = await PrivateState.open(stateDir);
    try {
      const idx = new OperationIndex(state);
      await idx.save({
        index: {
          schemaVersion: 1,
          projectId: project.projectId,
          principalId: state.principalId,
          commandId: opId,
          receiptId: opId,
          owner: 'local_lifecycle',
          operationKind: 'session_start',
          fingerprint: 'a'.repeat(64),
          createdAt: new Date().toISOString()
        },
        operation: {
          apiVersion: 1,
          operationId: opId,
          projectId: project.projectId,
          owner: 'local_lifecycle',
          operationKind: 'session_start',
          state: 'reconciliation_required',
          error: {
            apiVersion: 1,
            code: 'reconciliation_required',
            message: 'Uncertain startup',
            retryable: false,
            correlationId: randomUUID()
          },
          updatedAt: new Date().toISOString()
        }
      });

      // Now check that unresolved(project.projectId) fails closed and blocks unregister
      const isUnresolved = await idx.unresolved(project.projectId);
      expect(isUnresolved).toBe(true);
    } finally {
      await state.close();
    }

    // Restart server and check unregister
    await f.restart();
    const login = await f.login();
    const deleteRes = await f.send(`/api/v1/projects/${project.projectId}`, 'DELETE', { apiVersion: 1, confirmed: true }, login.headers);
    expect(deleteRes.status).toBe(409);
  });
});
