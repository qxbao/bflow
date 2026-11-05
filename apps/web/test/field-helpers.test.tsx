import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { WebProjectSchema } from '@bflow/contracts/web';
import { ApiClient, ApiError } from '../src/api/client';
import { App } from '../src/app';
import { AppShell } from '../src/components/AppShell';
import { DecisionCard } from '../src/components/DecisionCard';
import { ErrorState } from '../src/components/ErrorState';
import { FieldHelp } from '../src/components/FieldHelp';
import { ClarificationForm } from '../src/features/clarifications';
import { ChatComposer } from '../src/features/chat/composer';
import { DecisionReview } from '../src/features/decisions';
import { Operations } from '../src/features/operations';
import { ProjectConfiguration } from '../src/features/project-configuration';
import { Projects } from '../src/features/projects';
import { RequestForm } from '../src/features/requests';
import { Review } from '../src/features/review';
import { RunActions } from '../src/features/run-actions';
import { Runs } from '../src/features/runs';
import { Settings } from '../src/features/settings';
import { decision, installApi, now, projects, run } from './fixtures';

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
});

function assertEveryControlHasWorkingHelper(container: HTMLElement) {
  const controls = Array.from(container.querySelectorAll<HTMLElement>('input, select, textarea'));
  expect(controls.length).toBeGreaterThan(0);

  for (const control of controls) {
    let scope: HTMLElement | null = control.parentElement;
    let helper: HTMLButtonElement | null = null;
    while (scope && scope !== container) {
      helper = scope.querySelector<HTMLButtonElement>('button[aria-label="Xem giải thích"]');
      if (helper) break;
      scope = scope.parentElement;
    }
    const controlDesc = `${control.tagName.toLowerCase()}#${control.id || control.getAttribute('aria-label') || control.getAttribute('placeholder') || 'unnamed'}`;
    expect(Boolean(control.id || control.getAttribute('name')), `Missing id/name attribute on control ${controlDesc}`).toBe(true);
    expect(helper, `Missing (?) helper for control ${controlDesc}`).not.toBeNull();
    expect(helper!.getAttribute('style'), `Inline style breaks CSP on ${controlDesc}`).toBeNull();

    fireEvent.mouseEnter(helper!.parentElement ?? helper!);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent?.trim().length ?? 0).toBeGreaterThan(15);
    expect(tooltip.getAttribute('style'), `Inline style breaks CSP on tooltip for ${controlDesc}`).toBeNull();
    expect(tooltip.className).toContain('pointer-events-none');
    fireEvent.mouseLeave(helper!.parentElement ?? helper!);
  }
}

describe('FieldHelp (?) component & 100% control coverage', () => {
  it('supports hover, keyboard focus, click toggle, Escape, outside dismiss, zero inline styles and never activates sibling labels', async () => {
    const user = userEvent.setup();
    const onCheck = vi.fn();
    render(
      <div>
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" onChange={onCheck} />
            <span>Tùy chọn thử nghiệm</span>
          </label>
          <FieldHelp
            label="Tùy chọn thử nghiệm"
            help="Giải thích rõ ràng bằng tiếng Việt cho người dùng khi rê chuột hoặc bấm vào."
            example="Ví dụ: bật khi cần kiểm tra nhanh"
          />
        </div>
        <button type="button">Bên ngoài</button>
      </div>,
    );

    const checkbox = screen.getByRole('checkbox', { name: 'Tùy chọn thử nghiệm' }) as HTMLInputElement;
    const trigger = screen.getByRole('button', { name: 'Xem giải thích' });
    expect(trigger.getAttribute('data-field-help')).toBe('Tùy chọn thử nghiệm');
    expect(screen.queryByRole('tooltip')).toBeNull();

    // Hover opens & unhover closes
    fireEvent.mouseEnter(trigger.parentElement!);
    expect(screen.getByRole('tooltip').textContent).toContain('Giải thích rõ ràng bằng tiếng Việt');
    expect(screen.getByRole('tooltip').textContent).toContain('Ví dụ: bật khi cần kiểm tra nhanh');
    expect(screen.getByRole('tooltip').getAttribute('style')).toBeNull();
    fireEvent.mouseLeave(trigger.parentElement!);
    expect(screen.queryByRole('tooltip')).toBeNull();

    // Keyboard focus opens & Escape closes
    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();

    // Click pins open without toggling sibling checkbox, outside pointerdown closes
    await user.click(trigger);
    expect(onCheck).not.toHaveBeenCalled();
    expect(checkbox.checked).toBe(false);
    expect(screen.getByRole('tooltip')).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Bên ngoài' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('covers 100% of selects, inputs, checkboxes and textareas across every Bflow Web screen', async () => {
    const config = {
      apiVersion: 1,
      projectId: 'p',
      revision: 'a'.repeat(64),
      yaml: 'projectName: Sample\nenvironment: {}\n',
      values: {
        schemaVersion: '3',
        projectName: 'Sample',
        environment: {
          roles: [{ role: 'conversation', cli: 'claude', model: 'haiku', required: true }],
          deepwiki: { enabled: true, required: false },
          verification: { maxIterations: 3, regressionScope: 'affected' },
          skills: { requiredSkills: [] },
        },
      },
    };
    installApi({
      '/api/v1/projects/p/configuration': config,
      '/api/v1/projects/p/decisions': { apiVersion: 1, items: [decision] },
      '/api/v1/projects/p/runs/run': {
        ...run,
        decisions: [decision],
        availableActions: [
          { actionId: 'decide', kind: 'answer_decision', enabled: true, expectedVersion: decision.expectedVersion },
          { actionId: 'cancel', kind: 'cancel', enabled: true, expectedVersion: { revisionToken: 'v1' } },
        ],
      },
    });
    const api = new ApiClient();

    // 1. AppShell
    let view = render(
      <MemoryRouter initialEntries={['/projects/p']}>
        <AppShell projects={projects.map(item => WebProjectSchema.parse(item))} projectId="p">
          <div>Nội dung</div>
        </AppShell>
      </MemoryRouter>,
    );
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    // 2. Projects (with existing project so both searchbox and path input render)
    view = render(
      <MemoryRouter>
        <Projects api={api} projects={projects.map(item => WebProjectSchema.parse(item))} refresh={() => {}} />
      </MemoryRouter>,
    );
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    // 3. Settings + ProjectConfiguration (Form mode with all details expanded)
    view = render(
      <MemoryRouter>
        <Settings api={api} project={WebProjectSchema.parse(projects[0])} />
      </MemoryRouter>,
    );
    await screen.findByRole('textbox', { name: 'Mô hình AI (conversation)' });
    view.container.querySelectorAll('details').forEach(node => {
      node.open = true;
    });
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    // 4. ProjectConfiguration (YAML mode)
    view = render(<ProjectConfiguration api={api} id="p" revision={0} />);
    await screen.findByRole('textbox', { name: 'Mô hình AI (conversation)' });
    fireEvent.click(screen.getByRole('button', { name: 'Chỉnh tệp cấu hình' }));
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    // 5. RequestForm (with acceptance criteria lines so per-criterion selects render)
    view = render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <RequestForm api={api} id="p" sessionId="s" enabled />
        </Operations>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Kết quả cần đạt (mỗi dòng một ý)'), {
      target: { value: 'Chuyển đổi dấu tiếng Việt\nViết unit test đầy đủ' },
    });
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    // 6. Runs
    view = render(
      <MemoryRouter>
        <Runs api={api} id="p" revision={0} refresh={() => {}} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: run.title });
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    // 7. Review
    view = render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <Review api={api} id="p" revision={0} refresh={() => {}} />
        </Operations>
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: 'Xem xét gói' });
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    // 8. DecisionReview (user_decision with options + reason)
    const userDecision = {
      ...decision,
      kind: 'user_decision' as const,
      options: ['Phương án A', 'Phương án B'],
    };
    view = render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <DecisionReview
            api={api}
            id="p"
            decision={userDecision}
            actions={[{ actionId: 'decide', kind: 'answer_decision', enabled: true, expectedVersion: userDecision.expectedVersion }]}
            fresh
            refresh={() => {}}
          />
        </Operations>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Xem xét gói' }));
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    // 9. ClarificationForm
    view = render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <ClarificationForm
            api={api}
            id="p"
            runId="run"
            enabled
            question={{
              questionId: 'q1',
              question: 'Có giữ dấu gạch dưới không?',
              options: ['Có', 'Không'],
              expectedVersion: { revisionToken: 'v1' },
            }}
          />
        </Operations>
      </MemoryRouter>,
    );
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    // 10. RunActions (cancel confirmation modal)
    view = render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <RunActions
            api={api}
            id="p"
            run={{
              ...run,
              availableActions: [{ kind: 'cancel', actionId: 'c1', enabled: true, expectedVersion: { revisionToken: 'v1' } }],
            }}
            fresh
          />
        </Operations>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hủy công việc' }));
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    // 11. ChatComposer & ChatPage (/projects/:id/chat/:runId)
    view = render(
      <MemoryRouter>
        <ChatComposer
          api={api}
          projectId="p"
          sessionId="host-session"
          runId="run"
          ready
          sessionFresh
          refresh={() => {}}
          onPending={() => {}}
        />
      </MemoryRouter>,
    );
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    installApi({
      '/api/v1/projects/p/sessions/host-session/messages': { apiVersion: 1, items: [] },
    });
    view = render(
      <MemoryRouter initialEntries={['/projects/p/chat/run']}>
        <App api={api} />
      </MemoryRouter>,
    );
    await screen.findByLabelText('Tin nhắn cho trợ lý');
    assertEveryControlHasWorkingHelper(view.container);
    cleanup();

    // 12. ErrorState inline pairing
    view = render(<ErrorState error={new ApiError('session_required')} retry={() => {}} onPair={() => {}} />);
    assertEveryControlHasWorkingHelper(view.container);
  });
});

describe('Real-user UX fixes uncovered during Chrome DevTools session', () => {
  it('keeps Overview calm (no false-alarm red alert or yellow SSE warning) when project session is stopped/unavailable', async () => {
    class FailingEventSource {
      addEventListener(kind: string, fn: (event: MessageEvent) => void) {
        if (kind === 'error') queueMicrotask(() => fn(new MessageEvent('error')));
      }
      close() {}
    }
    vi.stubGlobal('EventSource', FailingEventSource);
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
      if (path.endsWith('/session')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          state: 'unavailable',
          pendingIntakes: [],
          blockers: [],
          updatedAt: now,
        });
      }
      if (path.endsWith('/preview')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          available: false,
          summary: 'Chưa có tệp cấu hình (.bflow/config.yml). Mở Cài đặt dự án để khởi tạo.',
          blockers: [],
          observedAt: now,
        });
      }
      return Response.json(
        { apiVersion: 1, code: 'unavailable', message: 'Host not running', retryable: true, correlationId: 'c1' },
        { status: 503 },
      );
    });

    render(
      <MemoryRouter initialEntries={['/projects/p']}>
        <App api={new ApiClient()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Phiên: Chưa sẵn sàng')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Khởi động phiên dự án để xem danh sách công việc/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Trình duyệt: đang kết nối lại/)).toBeNull();
    expect(screen.getByText(/Cập nhật trực tiếp: chờ khởi động phiên/)).toBeTruthy();
  });

  it('allows re-pairing directly from an expired browser session screen using a #bootstrap URL without losing the route', async () => {
    const user = userEvent.setup();
    let paired = false;
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (path === '/api/v1/session/bootstrap' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.secret === 'fresh-token-123') {
          paired = true;
          return Response.json({
            apiVersion: 1,
            sessionId: 'browser-2',
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            csrfToken: 'csrf-2',
          });
        }
      }
      if (!paired) {
        return Response.json(
          { apiVersion: 1, code: 'session_required', message: 'Expired', retryable: false, correlationId: 'c0' },
          { status: 401 },
        );
      }
      if (path === '/api/v1/projects') return Response.json({ apiVersion: 1, items: projects });
      return Response.json({ apiVersion: 1, items: [] });
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <App api={new ApiClient()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Phiên trình duyệt đã hết hạn/)).toBeTruthy();
    const input = screen.getByLabelText('Liên kết mở Bflow Web');

    // Trying an expired/wrong 60s bootstrap code shows explicit Vietnamese feedback without crashing
    await user.type(input, 'http://127.0.0.1:4317/#bootstrap=expired-token-000');
    await user.click(screen.getByRole('button', { name: 'Ghép nối lại' }));
    expect(await screen.findByText(/quá hạn 60 giây/)).toBeTruthy();

    // Pasting a fresh bootstrap code pairs immediately
    await user.type(input, 'http://127.0.0.1:4317/#bootstrap=fresh-token-123');
    await user.click(screen.getByRole('button', { name: 'Ghép nối lại' }));

    expect(await screen.findByRole('heading', { name: projects[0]!.displayName })).toBeTruthy();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('does not flash a false lost-response / not_found alarm while POST /commands is still in flight', async () => {
    let resolvePost!: (res: Response) => void;
    let getOperationCallsWhileInFlight = 0;
    let postInFlight = false;

    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (path.endsWith('/commands') && init?.method === 'POST') {
        postInFlight = true;
        return new Promise<Response>(resolve => {
          resolvePost = res => {
            postInFlight = false;
            resolve(res);
          };
        });
      }
      if (path.includes('/operations/')) {
        if (postInFlight) {
          getOperationCallsWhileInFlight++;
          return Response.json(
            { apiVersion: 1, code: 'not_found', message: 'Not written yet', retryable: false, correlationId: 'c404' },
            { status: 404 },
          );
        }
        const operationId = path.split('/').at(-1)!;
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          operationId,
          owner: 'host_interaction',
          operationKind: 'answer_decision',
          state: 'applied',
          result: { kind: 'interaction', runId: 'run', currentRunId: 'run' },
          updatedAt: new Date().toISOString(),
        });
      }
      return Response.json({ ...run, decisions: [decision], availableActions: [{ actionId: 'decide', kind: 'answer_decision', enabled: true, expectedVersion: decision.expectedVersion }] });
    });

    const api = new ApiClient();
    render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={() => {}}>
          <DecisionReview
            api={api}
            id="p"
            decision={decision}
            actions={[{ actionId: 'decide', kind: 'answer_decision', enabled: true, expectedVersion: decision.expectedVersion }]}
            fresh
            refresh={() => {}}
          />
        </Operations>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Xem xét gói' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duyệt gói' }));

    expect(await screen.findByText(/Đang gửi yêu cầu tới dịch vụ dự án/)).toBeTruthy();
    expect(screen.queryByText(/Mất phản hồi/)).toBeNull();
    expect(screen.queryByText(/Không tìm thấy công việc hoặc đối tượng của thao tác/)).toBeNull();
    expect(getOperationCallsWhileInFlight).toBe(0);

    const record = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
    resolvePost(
      Response.json({
        apiVersion: 1,
        projectId: 'p',
        operationId: record.commandId,
        owner: 'host_interaction',
        operationKind: 'answer_decision',
        state: 'applied',
        result: { kind: 'interaction', runId: 'run', currentRunId: 'run' },
        updatedAt: new Date().toISOString(),
      }),
    );

    expect(await screen.findByText(/Đã áp dụng thao tác/)).toBeTruthy();
  });

  it('preserves RequestForm drafts across session startup transitions (unavailable -> bf-* -> conv-bf-*)', async () => {
    let currentSession: Record<string, unknown> = {
      apiVersion: 1,
      projectId: 'p',
      state: 'unavailable',
      pendingIntakes: [],
      blockers: [],
      updatedAt: now,
    };
    const { handlers } = installApi();
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
      if (path.endsWith('/session')) return Response.json(currentSession);
      if (path.endsWith('/preview')) {
        return Response.json({ apiVersion: 1, projectId: 'p', available: false, summary: 'Chưa sẵn sàng', blockers: [], observedAt: now });
      }
      return Response.json({ apiVersion: 1, items: [] });
    });
    void handlers;

    render(
      <MemoryRouter initialEntries={['/projects/p']}>
        <App api={new ApiClient()} />
      </MemoryRouter>,
    );

    const titleInput = (await screen.findByLabelText('Tên công việc')) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Bản nháp trước khi bật phiên' } });
    fireEvent.change(screen.getByLabelText('Mục tiêu'), { target: { value: 'Giữ nguyên nội dung khi phiên chuyển trạng thái' } });
    expect(titleInput.value).toBe('Bản nháp trước khi bật phiên');

    // Transition 1: session starting with Herdr sessionId bf-123
    currentSession = { ...currentSession, state: 'starting', sessionId: 'bf-123' };
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại dữ liệu' }));
    await screen.findByText('Phiên: Đang khởi động');
    expect((screen.getByLabelText('Tên công việc') as HTMLInputElement).value).toBe('Bản nháp trước khi bật phiên');

    // Transition 2: session ready with Conversation sessionId conv-bf-123
    currentSession = { ...currentSession, state: 'ready', sessionId: 'conv-bf-123' };
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại dữ liệu' }));
    await screen.findByText('Phiên: Sẵn sàng');
    expect((screen.getByLabelText('Tên công việc') as HTMLInputElement).value).toBe('Bản nháp trước khi bật phiên');
    expect((screen.getByLabelText('Mục tiêu') as HTMLTextAreaElement).value).toBe('Giữ nguyên nội dung khi phiên chuyển trạng thái');
  });

  it('keeps ConnectionBanner calm on Settings (/settings) when project session is stopped/unavailable', async () => {
    class FailingEventSource {
      addEventListener(kind: string, fn: (event: MessageEvent) => void) {
        if (kind === 'error') queueMicrotask(() => fn(new MessageEvent('error')));
      }
      close() {}
    }
    vi.stubGlobal('EventSource', FailingEventSource);
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
      if (path.endsWith('/session')) {
        return Response.json({ apiVersion: 1, projectId: 'p', state: 'unavailable', pendingIntakes: [], blockers: [], updatedAt: now });
      }
      if (path.endsWith('/configuration')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          revision: 'rev-1',
          yaml: 'projectName: Vườn sách\n',
          values: { projectName: 'Vườn sách' },
        });
      }
      return Response.json({ apiVersion: 1, items: [] });
    });

    render(
      <MemoryRouter initialEntries={['/projects/p/settings']}>
        <App api={new ApiClient()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: /Cài đặt/ })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Cập nhật trực tiếp: chờ khởi động phiên/)).toBeTruthy());
    expect(screen.queryByText(/Trình duyệt: đang kết nối lại/)).toBeNull();
  });

  it('presents JSON evidence in human-first Vietnamese order with translated spec keys and collapsed internal metadata', async () => {
    const specDoc = {
      acceptanceCriteria: [
        { id: 'ac-1', category: 'functional', description: 'Chuyển dấu tiếng Việt', required: true, status: 'pending', verificationMethod: 'unit_test' },
      ],
      affectedPaths: ['src/slug.mjs', 'test/slug.test.mjs'],
      architectureNotes: 'Hàm thuần chuẩn hóa chuỗi NFD.',
      metadata: { conditionalTdd: { policyVersion: 1, internalBlob: true } },
      problemStatement: 'Chưa có hàm tạo URL slug tiếng Việt.',
      schemaVersion: 2,
      summary: 'Thêm hàm toSlug(input) chuẩn ESM.',
      tddDecision: { mode: 'required', requiresFailingTestFirst: true },
      title: 'Thêm hàm toSlug tiếng Việt',
    };
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify(specDoc), {
          headers: { 'Content-Disposition': 'inline', 'Content-Type': 'text/plain' },
        }),
    );

    const specDecision = {
      ...decision,
      evidence: [
        {
          artifactId: 'spec-1',
          runId: 'run',
          kind: 'document' as const,
          mediaType: 'application/json',
          sizeBytes: 512,
          checksum: { algorithm: 'sha256' as const, value: 'a'.repeat(64) },
        },
      ],
    };
    render(<DecisionCard api={new ApiClient()} projectId="p" decision={specDecision} />);
    fireEvent.click(screen.getByRole('button', { name: 'Đọc nội dung an toàn' }));

    expect(await screen.findByText('Bài toán cần giải quyết')).toBeTruthy();
    expect(screen.getByText('Tệp ảnh hưởng')).toBeTruthy();
    expect(screen.getByText('Ghi chú kiến trúc')).toBeTruthy();
    expect(screen.getByText('Quyết định kiểm thử (TDD)')).toBeTruthy();
    expect(screen.getByText('Kiểm thử đơn vị')).toBeTruthy();
    expect(screen.getByText('Chờ kiểm chứng')).toBeTruthy();

    const bodyText = document.body.textContent ?? '';
    expect(bodyText.indexOf('Thêm hàm toSlug tiếng Việt')).toBeLessThan(bodyText.indexOf('Chuyển dấu tiếng Việt'));
    expect(screen.getByText(/Thông tin định danh & siêu dữ liệu kỹ thuật/).tagName).toBe('SUMMARY');
    expect(screen.getByText('Xem JSON gốc')).toBeTruthy();

    cleanup();
    const deliveryDoc = {
      attemptId: 'attempt-1',
      change: {
        baseCommitHash: '9cb1ade',
        branchName: 'integration/bflow/run-1',
        dirtyWorkingTree: false,
        filesChanged: [{ additions: 24, changeType: 'added', deletions: 0, path: 'src/slug.ts' }],
        headCommitHash: '80564f6',
        integrationCommitHash: '9a48afa',
      },
      cycleId: 'cycle-1',
      integratedTaskIds: ['task-1'],
      iteration: 1,
      verdict: 'passed',
    };
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify(deliveryDoc), {
          headers: { 'Content-Disposition': 'inline', 'Content-Type': 'text/plain' },
        }),
    );
    render(<DecisionCard api={new ApiClient()} projectId="p" decision={specDecision} />);
    fireEvent.click(screen.getByRole('button', { name: 'Đọc nội dung an toàn' }));

    expect(await screen.findByText('Thay đổi tích hợp')).toBeTruthy();
    expect(screen.getByText('Nhánh tích hợp')).toBeTruthy();
    expect(screen.getByText('Commit tích hợp')).toBeTruthy();
    expect(screen.getByText('Tệp thay đổi')).toBeTruthy();
    expect(screen.getByText('Dòng thêm')).toBeTruthy();
    expect(screen.getByText('Dòng xóa')).toBeTruthy();
    expect(screen.getByText('Nhiệm vụ đã tích hợp')).toBeTruthy();
  });

  it('stays calm without a false red alert or first-time setup checklist when stopping an active configured session', async () => {
    let active = true;
    installApi();
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
      if (path.endsWith('/session')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          ...(active ? { sessionId: 'conv-bf-1', state: 'ready', conversationStatus: 'completed' } : { state: 'unavailable' }),
          pendingIntakes: [],
          blockers: [],
          updatedAt: now,
        });
      }
      if (path.endsWith('/preview')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          available: true,
          summary: 'Sẵn sàng',
          blockers: [],
          observedAt: now,
        });
      }
      if (!active) {
        return Response.json(
          { apiVersion: 1, code: 'unavailable', message: 'Session stopped', retryable: true, correlationId: 'c-stop' },
          { status: 503 },
        );
      }
      if (path.includes('/runs')) return Response.json({ apiVersion: 1, items: [run] });
      if (path.includes('/decisions')) return Response.json({ apiVersion: 1, items: [] });
      return Response.json({ apiVersion: 1, items: [] });
    });

    render(
      <MemoryRouter initialEntries={['/projects/p']}>
        <App api={new ApiClient()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Phiên: Sẵn sàng')).toBeTruthy();
    expect(await screen.findByText(run.title)).toBeTruthy();

    // User stops the session -> host becomes unavailable while cached runs/decisions remain in memory
    active = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại dữ liệu' }));

    expect(await screen.findByText('Phiên: Chưa sẵn sàng')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Đang hiển thị dữ liệu lưu từ phiên gần nhất/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/3 bước để bắt đầu làm việc/)).toBeNull();
    expect(screen.getByText(/để bắt đầu hoặc tiếp tục công việc/)).toBeTruthy();
  });
});
