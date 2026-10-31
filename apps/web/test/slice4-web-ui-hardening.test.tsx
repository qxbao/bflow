import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api/client';
import { subscribeEvents } from '../src/api/events';
import { App } from '../src/app';
import { ChatHistory } from '../src/features/chat';
import { DecisionReview } from '../src/features/decisions';
import { Operations } from '../src/features/operations';
import { SessionActions } from '../src/features/run-actions/session';
import { decision, now, projects, run } from './fixtures';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('navigator', {
    onLine: true,
    locks: { request: async (_key: string, callback: () => unknown) => callback() }
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Slice 4 — Web UI adversarial hardening', () => {
  it('does not trigger endless full-app refresh cycles every 3s when an operation remains reconciliation_required with changing updatedAt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const commandId = '11111111-1111-4111-8111-111111111111';
    localStorage.setItem(
      'bflow:web:operations:p:unpaired:cancel:run',
      JSON.stringify({
        slot: 'cancel:run',
        scope: 'unpaired',
        commandId,
        fingerprint: 'a'.repeat(64),
        kind: 'cancel'
      })
    );
    let tick = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          apiVersion: 1,
          projectId: 'p',
          operationId: commandId,
          owner: 'host_interaction',
          operationKind: 'cancel',
          state: 'reconciliation_required',
          error: {
            apiVersion: 1,
            code: 'reconciliation_required',
            message: 'Uncertain',
            retryable: false,
            correlationId: `corr-${++tick}`
          },
          updatedAt: new Date(Date.now() + tick * 3000).toISOString()
        })
      )
    );

    const refresh = vi.fn();
    render(
      <MemoryRouter initialEntries={['/projects/p/runs/run']}>
        <Operations api={new ApiClient()} id="p" refresh={refresh}>
          <span>child</span>
        </Operations>
      </MemoryRouter>
    );

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });
    // Semantic state did not change; refresh must NOT keep firing every 3s
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('deduplicates replayed SSE cursors across reconnects and reconnects immediately when window fires online', () => {
    vi.useFakeTimers();
    const sources: { url: string; handlers: Map<string, (event: MessageEvent) => void>; close: ReturnType<typeof vi.fn> }[] = [];
    class FakeEventSource {
      entry;
      constructor(url: string) {
        this.entry = { url, handlers: new Map<string, (event: MessageEvent) => void>(), close: vi.fn() };
        sources.push(this.entry);
      }
      addEventListener(kind: string, fn: (event: MessageEvent) => void) {
        this.entry.handlers.set(kind, fn);
      }
      close() {
        this.entry.close();
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);

    const changed = vi.fn();
    const state = vi.fn();
    const stop = subscribeEvents('p', changed, state);

    const evt = JSON.stringify({
      apiVersion: 1,
      cursor: 'epoch:5',
      projectId: 'p',
      type: 'invalidate',
      resourceIds: [],
      occurredAt: '2026-10-31T00:00:00Z'
    });
    sources[0]?.handlers.get('invalidate')?.(new MessageEvent('invalidate', { data: evt }));
    expect(changed).toHaveBeenCalledTimes(1);

    // Disconnect -> schedules 3s timer, then escalate backoff; firing window 'online' must reconnect immediately without waiting 30s
    sources[0]?.handlers.get('error')?.(new MessageEvent('error'));
    expect(sources).toHaveLength(1);
    window.dispatchEvent(new Event('online'));
    expect(sources).toHaveLength(2);
    expect(sources[1]?.url).toContain('cursor=epoch%3A5');

    // Replaying identical non-reset cursor after reconnect must be deduplicated
    sources[1]?.handlers.get('invalidate')?.(new MessageEvent('invalidate', { data: evt }));
    expect(changed).toHaveBeenCalledTimes(1);

    stop();
  });

  it('mints a fresh operationId when restarting a session after a previously settled session_start and allows DecisionReview resubmission on a new revision after stale_version failure', async () => {
    // 1. SessionActions: first start settled as failed (e.g. before config init), second click after fix must mint a new operationId and POST again
    const startIds: string[] = [];
    let firstAttempt = true;
    const stoppedSession = {
      apiVersion: 1 as const,
      projectId: 'p',
      state: 'stopped' as const,
      pendingIntakes: [],
      blockers: [],
      updatedAt: now
    };
    const operations = new Map<string, unknown>();
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && path.endsWith('/session/start')) {
        const body = JSON.parse(init.body as string);
        startIds.push(body.operationId);
        const op = firstAttempt
          ? {
              apiVersion: 1,
              projectId: 'p',
              operationId: body.operationId,
              owner: 'local_lifecycle',
              operationKind: 'session_start',
              state: 'failed',
              error: {
                apiVersion: 1,
                code: 'operation_not_allowed',
                message: 'Missing config',
                retryable: false,
                correlationId: 'c1'
              },
              updatedAt: now
            }
          : {
              apiVersion: 1,
              projectId: 'p',
              operationId: body.operationId,
              owner: 'local_lifecycle',
              operationKind: 'session_start',
              state: 'applied',
              result: { kind: 'lifecycle', session: { ...stoppedSession, state: 'ready', sessionId: 's1' } },
              updatedAt: now
            };
        firstAttempt = false;
        operations.set(body.operationId, op);
        return Response.json(op);
      }
      if (path.includes('/operations/')) {
        return Response.json(operations.get(path.split('/').at(-1)!));
      }
      return Response.json(stoppedSession);
    });

    const api = new ApiClient();
    render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <SessionActions api={api} id="p" session={stoppedSession} fresh />
        </Operations>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Khởi động phiên' }));
    await waitFor(() => expect(startIds).toHaveLength(1));
    await screen.findByText(/Thao tác không được áp dụng/);

    // User fixes config and clicks Khởi động phiên again -> must mint a new operationId and send POST #2
    fireEvent.click(screen.getByRole('button', { name: 'Khởi động phiên' }));
    await waitFor(() => expect(startIds).toHaveLength(2));
    expect(startIds[0]).not.toBe(startIds[1]);
    cleanup();

    // 2. DecisionReview: rev 1 settles as state=failed (stale_version), user clicks Đọc lại gói hiện hành and approves rev 2 -> must mint new commandId
    localStorage.clear();
    const decisionPosts: any[] = [];
    const decisionOps = new Map<string, unknown>();
    const rev2 = {
      ...decision,
      expectedVersion: { ...decision.expectedVersion, revision: 2, evidenceDigest: 'b'.repeat(64) }
    };
    let liveDecision = decision;
    let failStale = true;
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && path.endsWith('/commands')) {
        const body = JSON.parse(init.body as string);
        decisionPosts.push(body);
        const op = failStale
          ? {
              apiVersion: 1,
              projectId: 'p',
              operationId: body.commandId,
              owner: 'host_interaction',
              operationKind: 'answer_decision',
              state: 'failed',
              error: {
                apiVersion: 1,
                code: 'stale_version',
                message: 'Stale',
                retryable: false,
                correlationId: 'c2'
              },
              updatedAt: now
            }
          : {
              apiVersion: 1,
              projectId: 'p',
              operationId: body.commandId,
              owner: 'host_interaction',
              operationKind: 'answer_decision',
              state: 'applied',
              result: { kind: 'interaction', runId: 'run', currentRunId: 'run' },
              updatedAt: now
            };
        failStale = false;
        liveDecision = rev2;
        decisionOps.set(body.commandId, op);
        return Response.json(op);
      }
      if (path.includes('/operations/')) {
        return Response.json(decisionOps.get(path.split('/').at(-1)!));
      }
      return Response.json({
        ...run,
        decisions: [liveDecision],
        availableActions: [{ actionId: 'decide', kind: 'answer_decision', enabled: true, expectedVersion: liveDecision.expectedVersion }]
      });
    });

    const api2 = new ApiClient();
    const view = (d = decision) => (
      <MemoryRouter>
        <Operations api={api2} id="p" refresh={() => {}}>
          <DecisionReview
            api={api2}
            id="p"
            decision={d}
            actions={[{ actionId: 'decide', kind: 'answer_decision', enabled: true, expectedVersion: d.expectedVersion }]}
            fresh
            refresh={() => {}}
          />
        </Operations>
      </MemoryRouter>
    );
    const mounted = render(view(decision));
    fireEvent.click(screen.getByRole('button', { name: 'Xem xét gói' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duyệt gói' }));
    await waitFor(() => expect(decisionPosts).toHaveLength(1));
    const rereadBtn = await screen.findByRole('button', { name: 'Đọc lại gói hiện hành' });

    mounted.rerender(view(rev2));
    fireEvent.click(rereadBtn);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Xem xét gói' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Xem xét gói' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duyệt gói' }));
    await waitFor(() => expect(decisionPosts).toHaveLength(2));
    expect(decisionPosts[1].expectedVersion.revision).toBe(2);
    expect(decisionPosts[1].commandId).not.toBe(decisionPosts[0].commandId);
  });

  it('clears ChatComposer recovery lock on definitive pre-admission refusal and handles non-JSON 401 responses cleanly in ApiClient', async () => {
    // 1. ApiClient non-JSON 401 response clears session & throws ApiError('session_required') instead of SyntaxError
    let call = 0;
    vi.stubGlobal('fetch', async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ apiVersion: 1, sessionId: 'b1', expiresAt: '2026-11-01T00:00:00Z', csrfToken: 'csrf-1' })
        );
      }
      return new Response('Unauthorized plain text', { status: 401 });
    });
    const client = new ApiClient();
    await client.authenticate();
    expect(client.expiresAt).toBe('2026-11-01T00:00:00Z');
    await expect(client.projects()).rejects.toMatchObject({ code: 'session_required' });
    expect(client.expiresAt).toBeUndefined();

    // 2. ChatComposer definitive refusal (400 invalid_request) does NOT brick the textarea in uncertain=true
    let rejectFirst = true;
    const sentBodies: any[] = [];
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (path.endsWith('/session')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          sessionId: 'host',
          state: 'ready',
          pendingIntakes: [],
          blockers: [],
          updatedAt: now
        });
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        sentBodies.push(body);
        if (rejectFirst) {
          rejectFirst = false;
          return Response.json(
            { apiVersion: 1, code: 'operation_not_allowed', message: 'Denied', retryable: false, correlationId: 'c3' },
            { status: 409 }
          );
        }
        return Response.json({
          apiVersion: 1,
          messageId: body.messageId,
          sessionId: 'host',
          runId: 'run',
          sender: 'user',
          source: 'web',
          content: body.content,
          delivery: 'queued',
          createdAt: now
        });
      }
      return Response.json({ apiVersion: 1, items: [] });
    });

    render(
      <MemoryRouter>
        <ChatHistory api={new ApiClient()} projectId="p" sessionId="host" runId="run" revision={0} />
      </MemoryRouter>
    );
    const input = await screen.findByLabelText<HTMLTextAreaElement>('Tin nhắn cho Conversation');
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'Tin thử lần 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi tin nhắn' }));
    await waitFor(() => expect(sentBodies).toHaveLength(1));

    // Must NOT be locked in uncertain mode after definitive 409 refusal
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Đối chiếu tin nhắn' })).toBeNull();

    // User edits and retries -> succeeds with a new messageId
    fireEvent.change(input, { target: { value: 'Tin thử lần 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi tin nhắn' }));
    await waitFor(() => expect(sentBodies).toHaveLength(2));
    expect(sentBodies[1].messageId).not.toBe(sentBodies[0].messageId);
  });

  it('automatically polls Overview out of transient starting/stopping session states even when quiet SSE reports connected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    class QuietConnectedEventSource {
      addEventListener(kind: string, fn: (event: MessageEvent) => void) {
        if (kind === 'open') queueMicrotask(() => fn(new MessageEvent('open')));
      }
      close() {}
    }
    vi.stubGlobal('EventSource', QuietConnectedEventSource);

    let sessionCalls = 0;
    vi.stubGlobal('fetch', async (path: string) => {
      if (path === '/api/v1/session') {
        return Response.json({
          apiVersion: 1,
          sessionId: 'browser',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          csrfToken: 'csrf'
        });
      }
      if (path === '/api/v1/projects') return Response.json({ apiVersion: 1, items: projects });
      if (path.endsWith('/session')) {
        sessionCalls++;
        const state = sessionCalls >= 2 ? 'ready' : 'starting';
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          ...(state === 'ready' ? { sessionId: 'host-ready' } : {}),
          state,
          pendingIntakes: [],
          blockers: [],
          updatedAt: now
        });
      }
      if (path.endsWith('/preview')) {
        return Response.json({ apiVersion: 1, projectId: 'p', available: true, summary: 'ok', blockers: [], observedAt: now });
      }
      return Response.json({ apiVersion: 1, items: [] });
    });

    render(
      <MemoryRouter initialEntries={['/projects/p']}>
        <App api={new ApiClient()} />
      </MemoryRouter>
    );

    await screen.findByText(/Đang khởi động|starting/i);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() => expect(sessionCalls).toBeGreaterThanOrEqual(2));
    expect((await screen.findByRole('button', { name: 'Dừng phiên' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
