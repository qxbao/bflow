import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebChatMessageSchema, type WebEvent } from '@bflow/contracts/web';
import { streamEvents } from '../src/sse.js';
import { client, fixture } from './helpers.js';

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

describe('Round 3 Slice 2 — Local Server concurrency & SSE host-restart continuity', () => {
  it('does not starve cancel commands, session stop, configuration saves, or project registration behind 35s chat/notice RPCs', async () => {
    let enterChat!: () => void;
    const chatEntered = new Promise<void>(resolve => {
      enterChat = resolve;
    });
    let releaseChat!: () => void;
    const chatGate = new Promise<void>(resolve => {
      releaseChat = resolve;
    });

    let enterNotice!: () => void;
    const noticeEntered = new Promise<void>(resolve => {
      enterNotice = resolve;
    });
    let releaseNotice!: () => void;
    const noticeGate = new Promise<void>(resolve => {
      releaseNotice = resolve;
    });

    const chatOrder: string[] = [];
    const execute = vi.fn(async (cmd: any) => ({
      ok: true as const,
      value: {
        apiVersion: 1 as const,
        operationId: cmd.commandId,
        projectId: cmd.projectId,
        owner: 'host_interaction' as const,
        operationKind: cmd.kind,
        state: 'applied' as const,
        result: { kind: 'interaction' as const, runId: 'run-1', currentRunId: 'run-1' },
        updatedAt: new Date().toISOString()
      }
    }));
    const stopSession = vi.fn(async (projectId: string) => ({
      ok: true as const,
      value: {
        apiVersion: 1 as const,
        projectId,
        sessionId: 'host-1',
        state: 'stopped' as const,
        pendingIntakes: [],
        blockers: [],
        updatedAt: new Date().toISOString()
      }
    }));
    const saveConfiguration = vi.fn(async (projectId: string) => ({
      ok: true as const,
      value: {
        apiVersion: 1 as const,
        projectId,
        revision: 'c'.repeat(64),
        yaml: 'schemaVersion: "1"\n',
        values: { schemaVersion: '1' }
      }
    }));

    f = await fixture(
      { stopSession, saveConfiguration },
      async projectId => ({
        ...client,
        execute,
        readProjectSession: async () => ({
          ok: true,
          value: {
            apiVersion: 1,
            projectId,
            sessionId: 'conv-1',
            state: 'ready',
            pendingIntakes: [],
            blockers: [],
            updatedAt: new Date().toISOString()
          }
        }),
        acknowledgeNotice: async (_id, noticeId) => {
          enterNotice();
          await noticeGate;
          return {
            ok: true,
            value: {
              apiVersion: 1,
              noticeId,
              displayedAt: new Date().toISOString()
            }
          };
        },
        sendMessage: async input => {
          chatOrder.push(`start:${input.messageId}`);
          if (chatOrder.length === 1) {
            enterChat();
            await chatGate;
          }
          chatOrder.push(`end:${input.messageId}`);
          return {
            ok: true,
            value: WebChatMessageSchema.parse({
              apiVersion: 1,
              messageId: input.messageId,
              sessionId: input.sessionId,
              runId: input.runId,
              sender: 'user',
              source: 'web',
              content: input.content,
              createdAt: new Date().toISOString(),
              delivery: 'queued'
            })
          };
        }
      })
    );

    const { headers } = await f.login();
    const projectId = (await f.send('/api/v1/projects', 'POST', { apiVersion: 1, path: await f.repo('primary') }, headers)).json.projectId as string;
    const base = `/api/v1/projects/${projectId}`;

    const msg1Id = randomUUID();
    const msg2Id = randomUUID();
    const pendingChat1 = f.send(
      `${base}/sessions/conv-1/messages`,
      'POST',
      { apiVersion: 1, messageId: msg1Id, projectId, sessionId: 'conv-1', runId: 'run-1', content: 'first slow turn' },
      headers
    );
    const pendingNotice = f.send(`${base}/notices/notice-1/displayed`, 'POST', { apiVersion: 1 }, headers);

    await Promise.all([chatEntered, noticeEntered]);

    // Queue a second chat message on the same conversation session to verify per-session ordering is preserved
    const pendingChat2 = f.send(
      `${base}/sessions/conv-1/messages`,
      'POST',
      { apiVersion: 1, messageId: msg2Id, projectId, sessionId: 'conv-1', runId: 'run-1', content: 'second queued turn' },
      headers
    );

    // While both chat and notice RPCs are blocked mid-turn, critical mutations must complete promptly (< 1000ms)
    const startedAt = Date.now();
    const [cancelRes, saveRes, secondRepoRes, stopRes] = await Promise.all([
      f.send(
        `${base}/commands`,
        'POST',
        {
          apiVersion: 1,
          projectId,
          commandId: randomUUID(),
          kind: 'cancel',
          runId: 'run-1',
          expectedVersion: { revisionToken: 'v1' },
          reason: 'urgent cancel during slow chat'
        },
        headers
      ),
      f.send(`${base}/configuration`, 'PUT', { apiVersion: 1, expectedRevision: 'a'.repeat(64), yaml: 'schemaVersion: "1"\n' }, headers),
      f.send('/api/v1/projects', 'POST', { apiVersion: 1, path: await f.repo('secondary') }, headers),
      f.send(`${base}/session/stop`, 'POST', { apiVersion: 1, operationId: randomUUID(), confirmed: true }, headers)
    ]);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1500);
    expect(cancelRes.status).toBe(202);
    expect(cancelRes.json.state).toBe('applied');
    expect(saveRes.status).toBe(200);
    expect(saveRes.json.ok).toBe(true);
    expect(secondRepoRes.status).toBe(201);
    expect(stopRes.status).toBe(202);
    expect(stopRes.json.state).toBe('applied');

    // Second chat message on conv-1 must still wait for msg1 to finish
    expect(chatOrder).toEqual([`start:${msg1Id}`]);

    releaseChat();
    releaseNotice();

    const [chat1Res, chat2Res, noticeRes] = await Promise.all([pendingChat1, pendingChat2, pendingNotice]);
    expect(chat1Res.status).toBe(202);
    expect(chat2Res.status).toBe(202);
    expect(noticeRes.status).toBe(200);
    expect(chatOrder).toEqual([`start:${msg1Id}`, `end:${msg1Id}`, `start:${msg2Id}`, `end:${msg2Id}`]);
  });

  it('promotes discontinuous upstream SSE cursors (host epoch change, sequence regression, or mid-stream sequence restart) to reset events', async () => {
    // 1. Mid-stream host restart: hostA:1 -> hostA:2 -> hostA:1 (same prefix reset) -> hostB:1 (new host epoch) -> hostB:2
    const frames: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      headersSent: false,
      writableLength: 0,
      statusCode: 0,
      setHeader() {},
      flushHeaders() {
        this.headersSent = true;
      },
      write(chunk: string) {
        frames.push(chunk);
        return true;
      },
      destroy() {
        this.destroyed = true;
        this.emit('close');
      },
      end() {
        this.writableEnded = true;
        this.emit('close');
      },
      setTimeout() {}
    });
    const req = Object.assign(new EventEmitter(), { headers: {}, socket: {} });

    const upstreamSequence: WebEvent[] = [
      makeEvent('proj-1', 'hostA:1', 'reset', []),
      makeEvent('proj-1', 'hostA:2', 'invalidate', ['run-1']),
      makeEvent('proj-1', 'hostA:1', 'invalidate', ['run-1']), // sequence regressed 2 -> 1 without reset
      makeEvent('proj-1', 'hostA:1', 'invalidate', ['run-1']), // duplicate 1 -> 1 mid-stream after another restart
      makeEvent('proj-1', 'hostB:1', 'invalidate', ['run-2']), // epoch changed hostA -> hostB without reset
      makeEvent('proj-1', 'hostB:2', 'invalidate', ['run-2']) // normal monotonic continuation
    ];

    const source = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next(): Promise<IteratorResult<WebEvent>> {
            if (index < upstreamSequence.length) {
              return { done: false, value: upstreamSequence[index++]! };
            }
            return { done: true, value: undefined };
          }
        };
      }
    };

    await streamEvents(req as any, res as any, source, 'proj-1', 'srvEpoch', () => {}, Date.now() + 30000);
    const parsedEvents = frames.map(raw => JSON.parse(/data: ([^\n]+)/.exec(raw)![1]!) as WebEvent);
    expect(parsedEvents.map(item => ({ cursor: item.cursor, type: item.type }))).toEqual([
      { cursor: 'srvEpoch_hostA:1', type: 'reset' },
      { cursor: 'srvEpoch_hostA:2', type: 'invalidate' },
      { cursor: 'srvEpoch_hostA:1', type: 'reset' },
      { cursor: 'srvEpoch_hostA:1', type: 'reset' },
      { cursor: 'srvEpoch_hostB:1', type: 'reset' },
      { cursor: 'srvEpoch_hostB:2', type: 'invalidate' }
    ]);

    // 2. End-to-end HTTP Last-Event-ID reconnect across a host restart while local-server stays running (same server eventEpoch)
    let currentHostCursor = 'hostOne:42';
    f = await fixture({}, async () => ({
      ...client,
      events(projectId) {
        return {
          [Symbol.asyncIterator]() {
            let sent = false;
            return {
              async next(): Promise<IteratorResult<WebEvent>> {
                if (!sent) {
                  sent = true;
                  return { done: false, value: makeEvent(projectId, currentHostCursor, 'invalidate', ['run-9']) };
                }
                return new Promise(() => {});
              },
              async return() {
                return { done: true, value: undefined };
              }
            };
          }
        };
      }
    }));

    const auth = await f.login();
    const project = (await f.send('/api/v1/projects', 'POST', { apiVersion: 1, path: await f.repo() }, auth.headers)).json;
    const ssePath = `/api/v1/projects/${project.projectId}/events`;
    const readFirstEvent = async (extraHeaders: Record<string, string> = {}) =>
      new Promise<WebEvent>((resolve, reject) => {
        const reqHttp = request(f.server.origin + ssePath, { headers: { ...auth.headers, ...extraHeaders } }, resHttp => {
          let buf = '';
          resHttp.on('data', chunk => {
            buf += chunk;
            if (buf.includes('\n\n') && buf.includes('data:')) {
              const dataLine = /data: ([^\n]+)/.exec(buf)![1]!;
              resHttp.destroy();
              resolve(JSON.parse(dataLine) as WebEvent);
            }
          });
        });
        reqHttp.on('error', reject);
        reqHttp.end();
      });

    const firstConn = await readFirstEvent();
    expect(firstConn.cursor).toMatch(/_hostOne:42$/);

    // Host restarts with new epoch hostTwo:1 while local-server keeps running
    currentHostCursor = 'hostTwo:1';
    const afterEpochChange = await readFirstEvent({ 'Last-Event-ID': firstConn.cursor });
    expect(afterEpochChange.type).toBe('reset');
    expect(afterEpochChange.cursor).toMatch(/_hostTwo:1$/);
  });
});
