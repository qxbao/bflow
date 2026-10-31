import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api/client';
import { ChatComposer } from '../src/features/chat/composer';
import { Operations } from '../src/features/operations';
import { RequestForm } from '../src/features/requests';
import { SessionActions } from '../src/features/run-actions/session';
import { Settings } from '../src/features/settings';
import { now, projects } from './fixtures';

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

describe('Round 2 Slice 4 — Web UI recovery & state-isolation hardening', () => {
  it('keeps "Dừng phục hồi" (forceStop) enabled when normal "Dừng phiên" (stop) is stuck in reconciliation_required', async () => {
    const stuckStopId = '22222222-2222-4222-8222-222222222222';
    localStorage.setItem(
      'bflow:web:operations:p:unpaired:session_stop',
      JSON.stringify({
        slot: 'session_stop',
        scope: 'unpaired',
        commandId: stuckStopId,
        fingerprint: 'b'.repeat(64),
        kind: 'session_stop'
      })
    );

    const readySession = {
      apiVersion: 1 as const,
      projectId: 'p',
      sessionId: 's-ready',
      state: 'ready' as const,
      pendingIntakes: [],
      blockers: [],
      updatedAt: now
    };
    const forcePosts: { operationId: string; force?: boolean }[] = [];
    const operations = new Map<string, unknown>([
      [
        stuckStopId,
        {
          apiVersion: 1,
          projectId: 'p',
          operationId: stuckStopId,
          owner: 'local_lifecycle',
          operationKind: 'session_stop',
          state: 'reconciliation_required',
          error: {
            apiVersion: 1,
            code: 'reconciliation_required',
            message: 'Dừng phiên chưa được xác nhận.',
            retryable: false,
            operationId: stuckStopId,
            correlationId: 'corr-stop-stuck'
          },
          updatedAt: now
        }
      ]
    ]);

    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && path.endsWith('/session/stop')) {
        const body = JSON.parse(String(init.body));
        forcePosts.push(body);
        const settled = {
          apiVersion: 1,
          projectId: 'p',
          operationId: body.operationId,
          owner: 'local_lifecycle',
          operationKind: 'session_stop',
          state: 'applied',
          result: { kind: 'lifecycle', session: { ...readySession, state: 'stopped' } },
          updatedAt: now
        };
        operations.set(body.operationId, settled);
        return Response.json(settled, { status: 202 });
      }
      if (path.includes('/operations/')) {
        return Response.json(operations.get(path.split('/').at(-1)!));
      }
      return Response.json(readySession);
    });

    const api = new ApiClient();
    render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <SessionActions api={api} id="p" session={readySession} fresh />
        </Operations>
      </MemoryRouter>
    );

    // Wait for Operations to observe the stuck `session_stop` record
    await screen.findByText('Dừng phiên chưa được xác nhận.');

    const normalStopBtn = screen.getByRole('button', { name: 'Dừng phiên' }) as HTMLButtonElement;
    const forceStopBtn = screen.getByRole('button', { name: 'Dừng phục hồi' }) as HTMLButtonElement;
    expect(normalStopBtn.disabled).toBe(true);
    expect(forceStopBtn.disabled).toBe(false);

    // Operator clicks "Dừng phục hồi" and confirms -> must submit force=true with a distinct operationId
    fireEvent.click(forceStopBtn);
    const confirmSubmitBtn = screen.getByRole('button', { name: 'Gửi yêu cầu dừng phiên' }) as HTMLButtonElement;
    expect(confirmSubmitBtn.disabled).toBe(false);
    fireEvent.click(confirmSubmitBtn);

    await waitFor(() => expect(forcePosts).toHaveLength(1));
    expect(forcePosts[0]).toMatchObject({ force: true });
    expect(forcePosts[0]?.operationId).not.toBe(stuckStopId);
  });

  it('prevents Settings permanent running lockout on definitive 4xx initialization poll errors and isolates RequestForm/ChatComposer state across session/project changes without overwriting drafts', async () => {
    // 1. Settings: stale/invalid operationId in localStorage returning 400 invalid_request must NOT leave Settings permanently disabled
    localStorage.setItem('bflow:init:p', 'bad-op-id');
    vi.stubGlobal('fetch', async (path: string) => {
      if (path.includes('/initializations/')) {
        return Response.json(
          { apiVersion: 1, code: 'invalid_request', message: 'Invalid operationId', retryable: false, correlationId: 'c-bad' },
          { status: 400 }
        );
      }
      if (path.endsWith('/configuration')) {
        return Response.json(
          { apiVersion: 1, code: 'not_found', message: 'Missing config', retryable: false, correlationId: 'c-cfg' },
          { status: 404 }
        );
      }
      return Response.json({ apiVersion: 1, items: [] });
    });

    const api = new ApiClient();
    render(
      <MemoryRouter>
        <Settings api={api} project={{ ...projects[0]!, apiVersion: 1, registrationState: 'registered' }} />
      </MemoryRouter>
    );

    const inspectBtn = (await screen.findByRole('button', { name: 'Kiểm tra điều kiện sẵn sàng' })) as HTMLButtonElement;
    await waitFor(() => expect(inspectBtn.disabled).toBe(false));
    expect(localStorage.getItem('bflow:init:p')).toBeNull();
    cleanup();

    // 2. RequestForm: changing sessionId/projectId without remounting must load target draft instead of overwriting it with previous draft
    const keyA = 'bflow:web:draft:proj-a:sess-1:create';
    const keyB = 'bflow:web:draft:proj-b:sess-2:create';
    sessionStorage.setItem(
      keyA,
      JSON.stringify({
        title: 'Bản nháp dự án A',
        requestKind: 'feature',
        objective: 'Mục tiêu A',
        criteria: 'Tiêu chí A',
        constraints: '',
        verificationMethod: 'unit_test',
        methods: {}
      })
    );
    sessionStorage.setItem(
      keyB,
      JSON.stringify({
        title: 'Bản nháp dự án B',
        requestKind: 'bugfix',
        objective: 'Mục tiêu B',
        criteria: 'Tiêu chí B',
        constraints: '',
        verificationMethod: 'integration_test',
        methods: {}
      })
    );

    const formApi = new ApiClient();
    const formView = (projId: string, sessId: string) => (
      <MemoryRouter>
        <Operations api={formApi} id={projId} refresh={() => {}}>
          <RequestForm api={formApi} id={projId} sessionId={sessId} enabled />
        </Operations>
      </MemoryRouter>
    );
    const mountedForm = render(formView('proj-a', 'sess-1'));
    expect((screen.getByLabelText('Tên công việc') as HTMLInputElement).value).toBe('Bản nháp dự án A');

    mountedForm.rerender(formView('proj-b', 'sess-2'));
    await waitFor(() => expect((screen.getByLabelText('Tên công việc') as HTMLInputElement).value).toBe('Bản nháp dự án B'));
    expect(JSON.parse(sessionStorage.getItem(keyB)!).title).toBe('Bản nháp dự án B');
    cleanup();

    // 3. ChatComposer: changing sessionId clears old session's uncertain lock when new session has no pending chat receipt
    localStorage.setItem(
      JSON.stringify(['bflow-chat', 'p', 'sess-old']),
      JSON.stringify({ version: 1, messageId: '33333333-3333-4333-8333-333333333333' })
    );
    vi.stubGlobal('fetch', async (path: string) => {
      if (path.endsWith('/session')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          sessionId: currentChatSession,
          state: 'ready',
          pendingIntakes: [],
          blockers: [],
          updatedAt: now
        });
      }
      return Response.json({ apiVersion: 1, items: [] });
    });
    let currentChatSession = 'sess-old';
    const chatApi = new ApiClient();
    const mountedChat = render(
      <ChatComposer
        api={chatApi}
        projectId="p"
        sessionId="sess-old"
        runId="r-1"
        revision={0}
        historyReady
        refresh={() => {}}
      />
    );
    expect(await screen.findByRole('button', { name: 'Đối chiếu tin nhắn' })).toBeTruthy();

    currentChatSession = 'sess-new';
    mountedChat.rerender(
      <ChatComposer
        api={chatApi}
        projectId="p"
        sessionId="sess-new"
        runId="r-1"
        revision={1}
        historyReady
        refresh={() => {}}
      />
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Đối chiếu tin nhắn' })).toBeNull());
    const textarea = screen.getByLabelText('Tin nhắn cho Conversation') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.disabled).toBe(false));
  });
});
