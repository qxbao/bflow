import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebProjectSchema, type WebProjectConfiguration } from '@bflow/contracts/web';
import { ApiClient } from '../src/api/client';
import { App } from '../src/app';
import { DecisionCard, Evidence } from '../src/components/DecisionCard';
import { ChatHistory } from '../src/features/chat';
import { ChatComposer } from '../src/features/chat/composer';
import { ChatPage } from '../src/features/chat/page';
import { ClarificationForm } from '../src/features/clarifications';
import { useRead } from '../src/features/data';
import { DecisionReview } from '../src/features/decisions';
import { Operations } from '../src/features/operations';
import { ProjectConfiguration } from '../src/features/project-configuration';
import { Review } from '../src/features/review';
import { RunActions } from '../src/features/run-actions';
import { SessionActions } from '../src/features/run-actions/session';
import { Runs, RunView } from '../src/features/runs';
import { Settings } from '../src/features/settings';
import { decision, now, preview, projects, run } from './fixtures';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current-location">{location.pathname + location.search}</output>;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('navigator', {
    onLine: true,
    locks: { request: async (_key: string, callback: () => unknown) => callback() },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Round 3 Slice 1 — Web UI, SSE event loop, forms, routing & operation reconciliation', () => {
  it('Attack 1a: preserves settled operation receipts against transient 503 polls, reconciles immediately on SSE revision bump, and retains tracked records offline', async () => {
    const commandId = '11111111-1111-4111-8111-111111111111';
    localStorage.setItem(
      'bflow:web:operations:p:unpaired:resume:run',
      JSON.stringify({
        slot: 'resume:run',
        scope: 'unpaired',
        commandId,
        fingerprint: 'a'.repeat(64),
        kind: 'resume',
      }),
    );

    let opState: 'accepted' | 'applied' | '503' = 'accepted';
    let opCalls = 0;
    vi.stubGlobal('fetch', async (path: string) => {
      if (path.includes('/operations/')) {
        opCalls++;
        if (opState === '503') {
          return Response.json(
            { apiVersion: 1, code: 'unavailable', message: 'Temporary 503', retryable: true, correlationId: 'c503' },
            { status: 503 },
          );
        }
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          operationId: commandId,
          owner: 'host_interaction',
          operationKind: 'resume',
          state: opState,
          ...(opState === 'applied' ? { result: { kind: 'interaction', runId: 'run', currentRunId: 'run' } } : {}),
          updatedAt: now,
        });
      }
      return Response.json(run);
    });

    const api = new ApiClient();
    const refresh = vi.fn();
    const view = (rev: number) => (
      <MemoryRouter initialEntries={['/projects/p/runs/run']}>
        <Operations api={api} id="p" revision={rev} refresh={refresh}>
          <span>body</span>
        </Operations>
      </MemoryRouter>
    );

    const mounted = render(view(0));
    await screen.findByText('Đã tiếp nhận, đang chờ xử lý.');
    expect(opCalls).toBe(1);

    // SSE event bumps revision -> Operations reconciles immediately without waiting 3000ms
    opState = 'applied';
    mounted.rerender(view(1));
    await screen.findByText(/Đã áp dụng thao tác/);
    expect(opCalls).toBe(2);

    // Subsequent revision bump or transient 503 must NOT re-poll an already settled operation or regress it to uncertain
    opState = '503';
    mounted.rerender(view(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(opCalls).toBe(2);
    expect(screen.getByText(/Đã áp dụng thao tác/)).toBeTruthy();
    expect(screen.queryByText(/Mất phản hồi/)).toBeNull();

    // Offline mount still surfaces pending localStorage operation records without network reads
    cleanup();
    vi.stubGlobal('navigator', {
      onLine: false,
      locks: { request: async (_key: string, callback: () => unknown) => callback() },
    });
    const offlineFetch = vi.fn();
    vi.stubGlobal('fetch', offlineFetch);
    render(
      <MemoryRouter initialEntries={['/projects/p/runs/run']}>
        <Operations api={new ApiClient()} id="p" revision={0} refresh={() => {}}>
          <span>offline</span>
        </Operations>
      </MemoryRouter>,
    );
    await screen.findByLabelText('Theo dõi thao tác');
    expect(offlineFetch).not.toHaveBeenCalled();
  });

  it('Attack 1b: auto-navigates RunView and ChatPage when an active run transitions live to a follow-up continuedAsRunId while preserving historical deep-links', async () => {
    const childRun = {
      ...run,
      runId: 'run-child',
      parentRunId: 'run',
      currentRunId: 'run-child',
      title: 'Tìm sách bản tiếp nối',
    };
    let parentSnapshot = { ...run, currentRunId: 'run' };

    vi.stubGlobal('fetch', async (path: string) => {
      if (path.endsWith('/runs/run')) return Response.json(parentSnapshot);
      if (path.endsWith('/runs/run-child')) return Response.json(childRun);
      if (path.endsWith('/session')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          sessionId: 'host-session',
          state: 'ready',
          pendingIntakes: [],
          blockers: [],
          updatedAt: now,
        });
      }
      return Response.json({ apiVersion: 1, items: [parentSnapshot, childRun] });
    });

    const api = new ApiClient();
    const runApp = (rev: number) => (
      <MemoryRouter initialEntries={['/projects/p/runs/run']}>
        <Operations api={api} id="p" revision={rev} refresh={() => {}}>
          <RunView key="run" api={api} id="p" runId="run" revision={rev} refresh={() => {}} />
          <LocationProbe />
        </Operations>
      </MemoryRouter>
    );

    const mounted = render(runApp(0));
    await screen.findByRole('heading', { name: run.title });
    expect(screen.getByLabelText('current-location').textContent).toBe('/projects/p/runs/run');

    // Run transitions live to follow-up child run
    parentSnapshot = { ...run, currentRunId: 'run-child', continuedAsRunId: 'run-child' };
    mounted.rerender(runApp(1));
    await waitFor(() =>
      expect(screen.getByLabelText('current-location').textContent).toBe('/projects/p/runs/run-child'),
    );
    cleanup();

    // ChatPage also transitions active run thread to follow-up child run
    parentSnapshot = { ...run, currentRunId: 'run' };
    const chatTree = (rev: number, currentId: string) => (
      <MemoryRouter initialEntries={[`/projects/p/chat/${currentId}`]}>
        <ChatPage api={api} id="p" revision={rev} refresh={() => {}} />
      </MemoryRouter>
    );
    // Verify via full App routing for /projects/p/chat/run -> /projects/p/chat/run-child
    let handlers = new Map<string, EventListener>();
    class FakeSSE {
      addEventListener(kind: string, fn: EventListener) {
        handlers.set(kind, fn);
      }
      close() {}
    }
    vi.stubGlobal('EventSource', FakeSSE);
    vi.stubGlobal('fetch', async (path: string) => {
      if (path === '/api/v1/session') {
        return Response.json({
          apiVersion: 1,
          sessionId: 'browser',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          csrfToken: 'csrf',
        });
      }
      if (path === '/api/v1/projects') return Response.json({ apiVersion: 1, items: projects });
      if (path.endsWith('/runs/run')) return Response.json(parentSnapshot);
      if (path.endsWith('/runs/run-child')) return Response.json(childRun);
      if (path.endsWith('/session')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          sessionId: 'host-session',
          state: 'ready',
          pendingIntakes: [],
          blockers: [],
          updatedAt: now,
        });
      }
      return Response.json({ apiVersion: 1, items: [parentSnapshot, childRun] });
    });

    void chatTree;
    render(
      <MemoryRouter initialEntries={['/projects/p/chat/run']}>
        <App api={new ApiClient()} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: run.title });
    parentSnapshot = { ...run, currentRunId: 'run-child', continuedAsRunId: 'run-child' };
    act(() => {
      handlers.get('invalidate')?.(
        new MessageEvent('invalidate', {
          data: JSON.stringify({
            apiVersion: 1,
            projectId: 'p',
            cursor: 'epoch:9',
            type: 'invalidate',
            resourceIds: ['run'],
            occurredAt: now,
          }),
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByLabelText('current-location').textContent).toBe('/projects/p/chat/run-child'),
    );
    await screen.findByRole('heading', { name: childRun.title });
  });

  it('Attack 1c: Settings survives corrupt initialization retry JSON without locking busy=true and notifies refresh on completion', async () => {
    const project = WebProjectSchema.parse(projects[0]);
    const config = {
      apiVersion: 1,
      projectId: 'p',
      revision: 'a'.repeat(64),
      yaml: 'projectName: Vườn sách\nenvironment: {}\n',
      values: { projectName: 'Vườn sách', environment: {} },
    };
    localStorage.setItem('bflow:init:p', 'op-broken');
    localStorage.setItem('bflow:init:p:request', '{corrupt-json');

    let mode: 'not_found' | 'succeeded' = 'not_found';
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (path.endsWith('/configuration')) return Response.json(config);
      if (path.includes('/initializations/') && (!init?.method || init.method === 'GET')) {
        if (mode === 'not_found') {
          return Response.json(
            { apiVersion: 1, code: 'not_found', message: 'Missing', retryable: false, correlationId: 'nf' },
            { status: 404 },
          );
        }
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          operationId: path.split('/').at(-1),
          state: 'succeeded',
          message: 'Initialized',
          updatedAt: now,
        });
      }
      if (init?.method === 'POST' && path.endsWith('/initializations')) {
        const body = JSON.parse(String(init.body));
        mode = 'succeeded';
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          operationId: body.operationId,
          state: 'running',
          message: 'Running',
          updatedAt: now,
        });
      }
      return Response.json(preview);
    });

    const refresh = vi.fn();
    render(
      <MemoryRouter>
        <Settings api={new ApiClient()} project={project} refresh={refresh} />
      </MemoryRouter>,
    );

    const retryBtn = await screen.findByRole('button', { name: 'Gửi lại cùng mã' });
    fireEvent.click(retryBtn);

    expect(await screen.findByText(/Dữ liệu yêu cầu khởi tạo đã lưu bị hỏng/)).toBeTruthy();
    expect(localStorage.getItem('bflow:init:p:request')).toBeNull();

    // Controls must NOT stay disabled (busy=false) — user can start a fresh initialization and succeed
    const skipBox = screen.getByLabelText(/Khởi tạo không dùng GitNexus/) as HTMLInputElement;
    expect(skipBox.disabled).toBe(false);
    fireEvent.click(skipBox);
    fireEvent.click(screen.getByRole('button', { name: 'Chuẩn bị dự án' }));

    await screen.findByText('Đã hoàn tất');
    expect(refresh).toHaveBeenCalled();
    expect(localStorage.getItem('bflow:init:p:request')).toBeNull();
  });

  it('Attack 2a: ClarificationForm keeps typed draft across background revisionToken drift and binds to live expectedVersion', async () => {
    const qV1 = {
      questionId: 'q-scope',
      question: 'Có giữ tương thích ngược không?',
      options: ['Có', 'Không'],
      expectedVersion: { revisionToken: 'tok-1' },
    };
    const qV2 = { ...qV1, expectedVersion: { revisionToken: 'tok-2' } };
    const submitted: any[] = [];

    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        submitted.push(body);
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          operationId: body.commandId,
          owner: 'host_interaction',
          operationKind: 'answer_clarification',
          state: 'applied',
          result: { kind: 'interaction', runId: 'run', currentRunId: 'run' },
          updatedAt: now,
        });
      }
      if (path.endsWith('/runs/run')) {
        return Response.json({ ...run, clarifications: [qV2] });
      }
      return Response.json(run);
    });

    const api = new ApiClient();
    const renderRunClarification = (q: typeof qV1) => (
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <ClarificationForm key={q.questionId} api={api} id="p" runId="run" question={q} enabled />
        </Operations>
      </MemoryRouter>
    );

    const mounted = render(renderRunClarification(qV1));
    const textarea = screen.getByLabelText('Câu trả lời') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Có, giữ nguyên toàn bộ endpoint v1' } });

    // Sibling clarification update shifts revisionToken from tok-1 to tok-2 during typing
    mounted.rerender(renderRunClarification(qV2));
    expect((screen.getByLabelText('Câu trả lời') as HTMLTextAreaElement).value).toBe(
      'Có, giữ nguyên toàn bộ endpoint v1',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Gửi câu trả lời' }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      kind: 'answer_clarification',
      questionId: 'q-scope',
      expectedVersion: { revisionToken: 'tok-2' },
      answer: 'Có, giữ nguyên toàn bộ endpoint v1',
    });
  });

  it('Attack 2b & 3a: DecisionReview preserves typed feedback across StaleReviewBanner, avoids stale_version loops, preserves option whitespace, and enforces test-integrity justification', async () => {
    const userDecisionV1 = {
      ...decision,
      decisionId: 'ud-integrity',
      kind: 'user_decision' as const,
      options: ['Approve test-integrity exception', '  Giữ nguyên test  '],
      expectedVersion: { ...decision.expectedVersion, approvalId: 'ud-integrity' },
    };
    const userDecisionV2 = {
      ...userDecisionV1,
      expectedVersion: { ...userDecisionV1.expectedVersion, revision: 2, evidenceDigest: 'b'.repeat(64) },
    };

    const posts: any[] = [];
    let live = userDecisionV1;
    let firstStale = true;
    const ops = new Map<string, unknown>();

    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        const op = firstStale
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
                correlationId: 'st-1',
              },
              updatedAt: now,
            }
          : {
              apiVersion: 1,
              projectId: 'p',
              operationId: body.commandId,
              owner: 'host_interaction',
              operationKind: 'answer_decision',
              state: 'applied',
              result: { kind: 'interaction', runId: 'run', currentRunId: 'run' },
              updatedAt: now,
            };
        firstStale = false;
        live = userDecisionV2;
        ops.set(body.commandId, op);
        return Response.json(op);
      }
      if (path.includes('/operations/')) return Response.json(ops.get(path.split('/').at(-1)!));
      return Response.json({
        ...run,
        decisions: [live],
        availableActions: [
          { actionId: 'decide', kind: 'answer_decision', enabled: true, expectedVersion: live.expectedVersion },
        ],
      });
    });

    const api = new ApiClient();
    const renderDecision = (d: typeof userDecisionV1) => (
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <DecisionReview
            api={api}
            id="p"
            decision={d}
            actions={[{ actionId: 'decide', kind: 'answer_decision', enabled: true, expectedVersion: d.expectedVersion }]}
            fresh
            refresh={() => {}}
          />
        </Operations>
      </MemoryRouter>
    );

    const mounted = render(renderDecision(userDecisionV1));
    fireEvent.click(screen.getByRole('button', { name: 'Xem xét gói' }));

    // Approving test-integrity exception WITHOUT reason must be blocked before POST
    fireEvent.change(screen.getByLabelText('Phương án'), {
      target: { value: 'Approve test-integrity exception' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Duyệt gói' }));
    expect(screen.getByRole('alert').textContent).toContain('ngoại lệ toàn vẹn kiểm thử');
    expect(posts).toHaveLength(0);

    // Select option with leading/trailing spaces and type detailed reason
    fireEvent.change(screen.getByLabelText('Phương án'), { target: { value: '  Giữ nguyên test  ' } });
    fireEvent.change(screen.getByLabelText(/Lý do/), {
      target: { value: 'Giữ nguyên bộ test biên và cập nhật snapshot chuẩn' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Duyệt gói' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].selectedOption).toBe('  Giữ nguyên test  ');

    // Operation settled as failed (stale_version) -> StaleReviewBanner appears
    const reread = await screen.findByRole('button', { name: 'Đọc lại gói hiện hành' });
    mounted.rerender(renderDecision(userDecisionV2));
    fireEvent.click(reread);

    // Banner dismisses without looping AND typed reason + valid option are preserved when re-opening v2!
    const reopen = await screen.findByRole('button', { name: 'Xem xét gói' });
    fireEvent.click(reopen);
    expect((screen.getByLabelText(/Lý do/) as HTMLTextAreaElement).value).toBe(
      'Giữ nguyên bộ test biên và cập nhật snapshot chuẩn',
    );
    expect((screen.getByLabelText('Phương án') as HTMLSelectElement).value).toBe('  Giữ nguyên test  ');

    fireEvent.click(screen.getByRole('button', { name: 'Duyệt gói' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].expectedVersion.revision).toBe(2);

    // Immediately after state=applied (before parent RunView removes pending decision), buttons stay disabled
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Duyệt gói' }) as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it('Attack 2c & 3b: RunActions binds live cancel revisionToken after refresh, Review keeps active fieldset enabled when inbox runIds grow, and DecisionCard handles prototype-* & Evidence updates', async () => {
    // 1. RunActions cancel modal opened at v1, background refresh updates run to v2 -> submits v2!
    const cancelV1 = { kind: 'cancel' as const, actionId: 'c1', enabled: true, expectedVersion: { revisionToken: 'v1' } };
    const cancelV2 = { kind: 'cancel' as const, actionId: 'c1', enabled: true, expectedVersion: { revisionToken: 'v2' } };
    const cancelPosts: any[] = [];
    vi.stubGlobal('fetch', async (_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        cancelPosts.push(body);
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          operationId: body.commandId,
          owner: 'host_interaction',
          operationKind: 'cancel',
          state: 'accepted',
          updatedAt: now,
        });
      }
      return Response.json({ ...run, revisionToken: 'v2', availableActions: [cancelV2] });
    });

    const api = new ApiClient();
    const cancelTree = (action: typeof cancelV1, fresh: boolean, refreshing = false) => (
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <RunActions api={api} id="p" run={{ ...run, availableActions: [action] }} fresh={fresh} refreshing={refreshing} />
        </Operations>
      </MemoryRouter>
    );

    const mountedCancel = render(cancelTree(cancelV1, false, true));
    fireEvent.click(screen.getByRole('button', { name: 'Hủy công việc' }));
    fireEvent.change(screen.getByLabelText('Lý do hủy'), { target: { value: 'Hủy để tách phạm vi mới' } });
    mountedCancel.rerender(cancelTree(cancelV2, true, false));
    fireEvent.click(screen.getByRole('button', { name: 'Gửi yêu cầu hủy' }));
    await waitFor(() => expect(cancelPosts).toHaveLength(1));
    expect(cancelPosts[0]).toMatchObject({
      kind: 'cancel',
      expectedVersion: { revisionToken: 'v2' },
      reason: 'Hủy để tách phạm vi mới',
    });
    cleanup();

    // 2. Multi-decision contention: transient disabledReason does NOT falsely show StaleReviewBanner
    localStorage.clear();
    const refreshSpy = vi.fn();
    vi.stubGlobal('fetch', async () =>
      Response.json({
        ...run,
        decisions: [decision],
        availableActions: [
          {
            actionId: 'decide',
            kind: 'answer_decision',
            enabled: false,
            disabledReason: 'delivery_reconciliation_required',
            expectedVersion: decision.expectedVersion,
          },
        ],
      }),
    );
    const apiContention = new ApiClient();
    render(
      <MemoryRouter>
        <Operations api={apiContention} id="p" refresh={() => {}}>
          <DecisionReview
            api={apiContention}
            id="p"
            decision={decision}
            actions={[{ actionId: 'decide', kind: 'answer_decision', enabled: true, expectedVersion: decision.expectedVersion }]}
            fresh
            refresh={refreshSpy}
          />
        </Operations>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Xem xét gói' }));
    fireEvent.change(screen.getByLabelText(/Lý do/), { target: { value: 'Vẫn giữ nguyên ghi chú này' } });
    fireEvent.click(screen.getByRole('button', { name: 'Duyệt gói' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Đọc lại gói hiện hành' })).toBeNull();
    expect((screen.getByLabelText(/Lý do/) as HTMLTextAreaElement).value).toBe('Vẫn giữ nguyên ghi chú này');
    expect(refreshSpy).toHaveBeenCalledOnce();
    cleanup();

    // 3. Review inbox: adding a second run's decision keeps run-1's textarea enabled while run-2 loads
    const d2 = {
      ...decision,
      decisionId: 'd-2',
      runId: 'run-2',
      question: 'Quyết định thứ hai',
      expectedVersion: { ...decision.expectedVersion, approvalId: 'd-2' },
    };
    let decisionItems = [decision];
    let resolveRun2: ((res: Response) => void) | undefined;
    vi.stubGlobal('fetch', (path: string) => {
      if (path.endsWith('/decisions')) return Promise.resolve(Response.json({ apiVersion: 1, items: decisionItems }));
      if (path.endsWith('/runs/run')) {
        return Promise.resolve(
          Response.json({
            ...run,
            availableActions: [
              { actionId: 'a1', kind: 'answer_decision', enabled: true, expectedVersion: decision.expectedVersion },
            ],
          }),
        );
      }
      return new Promise<Response>((resolve) => {
        resolveRun2 = resolve;
      });
    });

    const reviewApi = new ApiClient();
    const reviewTree = (rev: number) => (
      <MemoryRouter>
        <Operations api={reviewApi} id="p" refresh={() => {}}>
          <Review api={reviewApi} id="p" revision={rev} refresh={() => {}} />
        </Operations>
      </MemoryRouter>
    );
    const mountedReview = render(reviewTree(0));
    const openBtn = await screen.findByRole('button', { name: 'Xem xét gói' });
    await waitFor(() => expect((openBtn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(openBtn);
    const reasonBox = screen.getByLabelText(/Lý do/) as HTMLTextAreaElement;
    reasonBox.focus();
    fireEvent.change(reasonBox, { target: { value: 'Đang nhập dở' } });

    decisionItems = [decision, d2];
    mountedReview.rerender(reviewTree(1));
    await screen.findByRole('heading', { name: 'Quyết định thứ hai' });
    await waitFor(() => expect(resolveRun2).toBeTypeOf('function'));
    // Run 1's textarea MUST remain enabled and retain draft while Run 2 is still in flight!
    expect((screen.getByLabelText(/Lý do/) as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByLabelText(/Lý do/) as HTMLTextAreaElement).value).toBe('Đang nhập dở');
    await act(async () => {
      resolveRun2?.(Response.json({ ...run, runId: 'run-2', currentRunId: 'run-2', decisions: [d2] }));
    });
    cleanup();

    // 4. Prototype package label & Evidence checksum reset
    const protoDecision = { ...decision, decisionId: 'prototype-home', question: 'Duyệt bản mẫu giao diện' };
    render(<DecisionCard decision={protoDecision} api={new ApiClient()} projectId="p" />);
    expect(screen.getByText(/Bản mẫu \(Prototype\)/)).toBeTruthy();
    cleanup();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"summary":"Phiên bản 1"}', { headers: { 'Content-Disposition': 'inline', 'Content-Type': 'text/plain' } })),
    );
    const ev1 = {
      artifactId: 'art-1',
      runId: 'run',
      kind: 'report',
      mediaType: 'application/json',
      checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
    };
    const mountedEv = render(<Evidence api={new ApiClient()} projectId="p" evidence={ev1 as never} />);
    fireEvent.click(screen.getByRole('button', { name: 'Đọc nội dung an toàn' }));
    expect(await screen.findByText('Phiên bản 1')).toBeTruthy();

    mountedEv.rerender(
      <Evidence
        api={new ApiClient()}
        projectId="p"
        evidence={{ ...ev1, checksum: { algorithm: 'sha256', value: 'b'.repeat(64) } } as never}
      />,
    );
    expect(screen.queryByText('Phiên bản 1')).toBeNull();
  });

  it('Attack 4: refreshes immediately on SSE reconnect, deduplicates simultaneous key+revision useRead, guards out-of-order ProjectConfiguration loads, and resets stale pagination cursors', async () => {
    // 1. useRead: changing key and revision simultaneously issues 1 fetch (not 2) and never leaks prior key data into error state
    let readCount = 0;
    function ReadProbe({ k, rev, fail = false }: { k: string; rev: number; fail?: boolean }) {
      const res = useRead(
        k,
        async () => {
          readCount++;
          if (fail) throw new Error('boom');
          return `val:${k}:${rev}`;
        },
        rev,
      );
      return <output aria-label="probe">{`${res.data ?? 'none'}|${Boolean(res.error)}`}</output>;
    }
    const mountedProbe = render(<ReadProbe k="a" rev={0} />);
    await waitFor(() => expect(screen.getByLabelText('probe').textContent).toBe('val:a:0|false'));
    expect(readCount).toBe(1);

    mountedProbe.rerender(<ReadProbe k="b" rev={1} />);
    await waitFor(() => expect(screen.getByLabelText('probe').textContent).toBe('val:b:1|false'));
    expect(readCount).toBe(2);

    mountedProbe.rerender(<ReadProbe k="c" rev={2} fail />);
    await waitFor(() => expect(screen.getByLabelText('probe').textContent).toBe('none|true'));
    cleanup();

    // 2. SSE reconnect ('error' -> 'open' on quiet stream) refreshes stale views immediately
    const sources: { handlers: Map<string, EventListener> }[] = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    class ReconnectSSE {
      entry = { handlers: new Map<string, EventListener>() };
      constructor() {
        sources.push(this.entry);
      }
      addEventListener(kind: string, fn: EventListener) {
        this.entry.handlers.set(kind, fn);
      }
      close() {}
    }
    vi.stubGlobal('EventSource', ReconnectSSE);
    let runTitle = 'Tiêu đề trước khi rớt mạng';
    vi.stubGlobal('fetch', async (path: string) => {
      if (path === '/api/v1/session') {
        return Response.json({
          apiVersion: 1,
          sessionId: 'browser',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          csrfToken: 'csrf',
        });
      }
      if (path === '/api/v1/projects') return Response.json({ apiVersion: 1, items: projects });
      if (path.endsWith('/runs/run')) return Response.json({ ...run, title: runTitle });
      if (path.endsWith('/session')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          sessionId: 'host-session',
          state: 'ready',
          pendingIntakes: [],
          blockers: [],
          updatedAt: now,
        });
      }
      return Response.json({ apiVersion: 1, items: [] });
    });

    render(
      <MemoryRouter initialEntries={['/projects/p/runs/run']}>
        <App api={new ApiClient()} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Tiêu đề trước khi rớt mạng' });
    act(() => {
      sources[0]?.handlers.get('open')?.(new MessageEvent('open'));
      sources[0]?.handlers.get('error')?.(new MessageEvent('error'));
    });
    runTitle = 'Tiêu đề mới sau khi nối lại SSE';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(sources.length).toBeGreaterThanOrEqual(2);
    act(() => {
      sources.at(-1)?.handlers.get('open')?.(new MessageEvent('open'));
    });
    await screen.findByRole('heading', { name: 'Tiêu đề mới sau khi nối lại SSE' });
    vi.useRealTimers();
    cleanup();

    // 3. ProjectConfiguration: slow manual reload started before save cannot overwrite newer saved revision
    const baseCfg: WebProjectConfiguration = {
      apiVersion: 1,
      projectId: 'p',
      revision: '1'.repeat(64),
      yaml: 'projectName: Cũ\nenvironment: {}\n',
      values: { projectName: 'Cũ', environment: {} },
    };
    const savedCfg: WebProjectConfiguration = {
      ...baseCfg,
      revision: '2'.repeat(64),
      yaml: 'projectName: Mới đã lưu\nenvironment: {}\n',
      values: { projectName: 'Mới đã lưu', environment: {} },
    };
    let resolveSlowLoad!: (v: typeof baseCfg) => void;
    let loadCall = 0;
    const cfgApi = new ApiClient();
    vi.spyOn(cfgApi, 'configuration').mockImplementation(() => {
      loadCall++;
      if (loadCall === 1) return Promise.resolve(baseCfg);
      return new Promise((resolve) => {
        resolveSlowLoad = resolve;
      });
    });
    vi.spyOn(cfgApi, 'saveConfiguration').mockResolvedValue(savedCfg);

    render(<ProjectConfiguration api={cfgApi} id="p" revision={0} />);
    const nameInput = await screen.findByLabelText<HTMLInputElement>('Tên dự án');
    expect(nameInput.value).toBe('Cũ');

    // Trigger manual reload #2 (hangs), then user edits & saves -> slow reload #2 resolves with old 'Cũ' and must be ignored!
    fireEvent.click(screen.getByRole('button', { name: 'Tải cấu hình mới nhất' }));
    fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: 'Mới đã lưu' } });
    fireEvent.submit(screen.getByLabelText('Tên dự án').closest('form')!);
    await screen.findByText(/Đã lưu cấu hình/);

    await act(async () => {
      resolveSlowLoad(baseCfg);
    });
    expect((screen.getByLabelText('Tên dự án') as HTMLInputElement).value).toBe('Mới đã lưu');
    cleanup();

    // 4. Stale pagination cursor (409 stale_version) resets cursor to page 1 on retry while keeping filters
    vi.stubGlobal('fetch', async (path: string) => {
      if (path.includes('cursor=stale-tok')) {
        return Response.json(
          { apiVersion: 1, code: 'stale_version', message: 'Cursor invalidated', retryable: false, correlationId: 'sc' },
          { status: 409 },
        );
      }
      return Response.json({ apiVersion: 1, items: [run] });
    });
    render(
      <MemoryRouter initialEntries={['/?search=sach&cursor=stale-tok']}>
        <Runs api={new ApiClient()} id="p" revision={0} refresh={() => {}} />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Thử tải lại' }));
    await screen.findByRole('heading', { name: run.title });
    expect(screen.getByLabelText('current-location').textContent).toBe('/?search=sach');
  });

  it('Attack 5: allows force-stop recovery when GET /session returns 503 and unlocks ChatComposer after verified complete-history absence without auto-resending', async () => {
    // 1. SessionActions & Overview: initial GET /session fails with 503 (wedged host), Dừng phục hồi still works!
    const stopPosts: any[] = [];
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && path.endsWith('/session/stop')) {
        const body = JSON.parse(String(init.body));
        stopPosts.push(body);
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          operationId: body.operationId,
          owner: 'local_lifecycle',
          operationKind: 'session_stop',
          state: 'applied',
          result: {
            kind: 'lifecycle',
            session: { apiVersion: 1, projectId: 'p', state: 'stopped', pendingIntakes: [], blockers: [], updatedAt: now },
          },
          updatedAt: now,
        });
      }
      return Response.json(
        { apiVersion: 1, code: 'unavailable', message: 'Host hung', retryable: true, correlationId: 'h503' },
        { status: 503 },
      );
    });

    const api = new ApiClient();
    render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <SessionActions
            api={api}
            id="p"
            session={{ apiVersion: 1, projectId: 'p', state: 'unavailable', pendingIntakes: [], blockers: [], updatedAt: now }}
            fresh={false}
          />
        </Operations>
      </MemoryRouter>,
    );
    expect((screen.getByRole('button', { name: 'Khởi động phiên' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Tùy chọn phiên',{selector:'summary'}));
    const forceBtn = screen.getByRole('button', { name: 'Dừng khi bị kẹt' }) as HTMLButtonElement;
    expect(forceBtn.disabled).toBe(false);
    fireEvent.click(forceBtn);
    fireEvent.click(screen.getByRole('button', { name: 'Gửi yêu cầu dừng phiên' }));
    await waitFor(() => expect(stopPosts).toHaveLength(1));
    expect(stopPosts[0]).toMatchObject({ confirmed: true, force: true });
    cleanup();

    // 2. ChatHistory keeps send enabled across background session refresh, and ChatComposer unlocks after verified absence
    localStorage.clear();
    let chatPosts = 0;
    let failPost = true;
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (path.endsWith('/session')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          sessionId: 'host',
          state: 'ready',
          pendingIntakes: [],
          blockers: [],
          updatedAt: now,
        });
      }
      if (init?.method === 'POST') {
        chatPosts++;
        if (failPost) {
          failPost = false;
          throw new TypeError('Dropped before reaching server');
        }
        const body = JSON.parse(String(init.body));
        return Response.json({
          apiVersion: 1,
          messageId: body.messageId,
          sessionId: 'host',
          runId: 'run',
          sender: 'user',
          source: 'web',
          content: body.content,
          delivery: 'queued',
          createdAt: now,
        });
      }
      // Authoritative 200 OK complete transcript without the dropped message
      return Response.json({ apiVersion: 1, items: [] });
    });

    render(
      <MemoryRouter>
        <ChatHistory api={new ApiClient()} projectId="p" sessionId="host" runId="run" revision={0} />
      </MemoryRouter>,
    );
    const chatInput = await screen.findByLabelText<HTMLTextAreaElement>('Tin nhắn cho trợ lý');
    await waitFor(() => expect(chatInput.disabled).toBe(false));
    fireEvent.change(chatInput, { target: { value: 'Tin nhắn bị đứt mạng trước khi tới host' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi tin nhắn' }));

    await screen.findByText(/Chưa xác định được kết quả gửi/);
    expect(chatPosts).toBe(1);
    expect(screen.queryByRole('button', { name: 'Mở khóa khung soạn tin' })).toBeNull();

    // Reconcile walks complete 200 OK history -> confirms message absent -> offers explicit unlock without resending
    fireEvent.click(screen.getByRole('button', { name: 'Đối chiếu tin nhắn' }));
    const unlockBtn = await screen.findByRole('button', { name: 'Mở khóa khung soạn tin' });
    expect(chatPosts).toBe(1);

    fireEvent.click(unlockBtn);
    await waitFor(() => expect(chatInput.disabled).toBe(false));
    expect(chatInput.value).toBe('Tin nhắn bị đứt mạng trước khi tới host');
    expect(chatPosts).toBe(1);

    // Corrupt localStorage metadata can also be unlocked explicitly without bricking the session
    cleanup();
    localStorage.setItem(JSON.stringify(['bflow-chat', 'p', 'corrupt-sess']), '{broken');
    render(
      <ChatComposer
        api={new ApiClient()}
        projectId="p"
        sessionId="corrupt-sess"
        runId="run"
        ready
        sessionFresh
        refresh={() => {}}
        onPending={() => {}}
      />,
    );
    const corruptUnlock = await screen.findByRole('button', { name: 'Mở khóa khung soạn tin' });
    fireEvent.click(corruptUnlock);
    await waitFor(() =>
      expect((screen.getByLabelText('Tin nhắn cho trợ lý') as HTMLTextAreaElement).disabled).toBe(false),
    );
  });

  it('Cross-Slice Web 1: clears effort when switching a role or all roles to agy in ProjectConfiguration', async () => {
    const savedBodies: Array<Record<string, unknown>> = [];
    const baseConfig: WebProjectConfiguration = {
      apiVersion: 1,
      projectId: 'p',
      revision: '1'.repeat(64),
      yaml: 'projectName: Demo\nenvironment: {}\n',
      values: {
        environment: {
          roles: [
            { role: 'developer', cli: 'claude', model: 'sonnet', effort: 'high' },
            { role: 'reviewer', cli: 'codex', model: 'gpt-5.4', effort: 'medium' },
          ],
        },
      },
    };
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (path.endsWith('/configuration') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        savedBodies.push(body);
        return Response.json({
          ...baseConfig,
          revision: String(savedBodies.length + 1).repeat(64),
          values: body.values ?? baseConfig.values,
        });
      }
      return Response.json(baseConfig);
    });

    render(<ProjectConfiguration api={new ApiClient()} id="p" revision={0} />);
    const devCli = await screen.findByLabelText<HTMLSelectElement>('Công cụ AI (developer)');
    expect(devCli.value).toBe('claude');

    // Per-role switch to agy strips effort from developer while preserving reviewer's effort
    fireEvent.change(devCli, { target: { value: 'agy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cấu hình' }));
    await waitFor(() => expect(savedBodies.length).toBe(1));
    const firstRoles = ((savedBodies[0]?.values as Record<string, unknown>)?.environment as Record<string, unknown>)
      ?.roles as Array<Record<string, unknown>>;
    expect(firstRoles[0]?.cli).toBe('agy');
    expect('effort' in (firstRoles[0] ?? {})).toBe(false);
    expect(firstRoles[1]?.effort).toBe('medium');

    // Bulk applyAll to agy strips effort from every role
    fireEvent.change(screen.getByLabelText('Công cụ AI cho cả nhóm'), { target: { value: 'agy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng cho tất cả vai trò' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cấu hình' }));
    await waitFor(() => expect(savedBodies.length).toBe(2));
    const secondRoles = ((savedBodies[1]?.values as Record<string, unknown>)?.environment as Record<string, unknown>)
      ?.roles as Array<Record<string, unknown>>;
    expect(secondRoles.every((role) => role.cli === 'agy' && !('effort' in role))).toBe(true);
  });

  it('Cross-Slice Web 2: immediately reconnects EventSource when project session transitions from stopped to ready', async () => {
    const sockets: FakeEventSource[] = [];
    class FakeEventSource {
      url: string;
      closed = false;
      listeners = new Map<string, EventListener>();
      constructor(url: string) {
        this.url = url;
        sockets.push(this);
      }
      addEventListener(type: string, listener: EventListener) {
        this.listeners.set(type, listener);
      }
      emit(type: string) {
        this.listeners.get(type)?.(new Event(type));
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);

    let sessionState: 'stopped' | 'ready' = 'stopped';
    vi.stubGlobal('fetch', async (path: string) => {
      if (path === '/api/v1/session') {
        return Response.json({
          apiVersion: 1,
          sessionId: 'browser',
          csrfToken: 'csrf',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      if (path === '/api/v1/projects') return Response.json({ apiVersion: 1, items: projects });
      if (path.endsWith('/session')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          ...(sessionState === 'ready' ? { sessionId: 'host-1' } : {}),
          state: sessionState,
          pendingIntakes: [],
          blockers: [],
          updatedAt: now,
        });
      }
      if (path.includes('/runs')) return Response.json({ apiVersion: 1, items: [] });
      if (path.includes('/decisions')) return Response.json({ apiVersion: 1, items: [] });
      if (path.includes('/preview')) return Response.json(preview);
      return Response.json({ apiVersion: 1, items: [] });
    });

    render(
      <MemoryRouter initialEntries={['/projects/p']}>
        <App api={new ApiClient()} />
      </MemoryRouter>,
    );
    await screen.findAllByText('Vườn sách');
    await waitFor(() => expect(sockets.length).toBe(1));

    // Simulate 503 SSE failure while session is stopped -> subscribeEvents enters backoff timer
    act(() => {
      sockets[0]?.emit('error');
    });
    expect(sockets[0]?.closed).toBe(true);

    // Session transitions to ready -> Tải lại dữ liệu refreshes sessionView -> immediate new EventSource without waiting 30s backoff!
    sessionState = 'ready';
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại dữ liệu' }));
    await waitFor(() => expect(sockets.length).toBe(2));
    expect(sockets[1]?.closed).toBe(false);
  });
});
