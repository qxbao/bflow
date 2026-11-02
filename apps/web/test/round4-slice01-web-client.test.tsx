import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, ConfigurationError } from '../src/api/client';
import { CommandStore } from '../src/api/commands';
import { Operations } from '../src/features/operations';
import { ClarificationForm } from '../src/features/clarifications';
import { Projects } from '../src/features/projects';
import { Settings } from '../src/features/settings';
import { ProjectConfiguration } from '../src/features/project-configuration';
import { ChatComposer } from '../src/features/chat/composer';
import { RunActions } from '../src/features/run-actions';
import { now, projects, run } from './fixtures';

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

describe('Round 4 Slice 01 — Web UI client hardening & failure recovery', () => {
  it('Attack 1: Corrupt operation record in localStorage surfaces actionable unblock button and clearCorrupted()', async () => {
    const brokenKey = 'bflow:web:operations:p:unpaired:broken-slot';
    localStorage.setItem(brokenKey, 'invalid-json{{{');

    const api = new ApiClient();
    const store = new CommandStore(api, 'p', 'unpaired');

    // store.records() should throw because of the broken key
    expect(() => store.records()).toThrow(/Mã phục hồi bị hỏng/);

    const refresh = vi.fn();
    render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={refresh}>
          <div>app content</div>
        </Operations>
      </MemoryRouter>,
    );

    // Error is shown
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Mã phục hồi bị hỏng');

    // An actionable button to clear corrupt records must be present to prevent infinite deadlock
    const clearBtn = screen.getByRole('button', { name: /Xóa mã phục hồi bị hỏng/i });
    expect(clearBtn).toBeTruthy();

    // Clicking it removes the corrupt key and unblocks
    fireEvent.click(clearBtn);

    await waitFor(() => {
      expect(localStorage.getItem(brokenKey)).toBeNull();
      expect(screen.queryByText(/Mã phục hồi bị hỏng/)).toBeNull();
    });
  });

  it('Attack 2: ClarificationForm surfaces operation status when submission is uncertain or in-flight', async () => {
    const question = {
      questionId: 'q1',
      question: 'Chọn loại cơ sở dữ liệu',
      options: ['PostgreSQL', 'SQLite'],
      expectedVersion: { revisionToken: 'r1' },
    };

    // Simulate valid run read, but POST command fails with network unavailable
    vi.stubGlobal('fetch', async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        throw new TypeError('Failed to fetch');
      }
      return Response.json({
        ...run,
        runId: 'run1',
        currentRunId: 'run1',
        clarifications: [question],
      });
    });

    const api = new ApiClient();
    const refresh = vi.fn();

    render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={refresh}>
          <ClarificationForm api={api} id="p" question={question} runId="run1" enabled={true} refresh={refresh} />
        </Operations>
      </MemoryRouter>,
    );

    // Enter answer
    const textarea = screen.getByRole('textbox', { name: /Câu trả lời/i });
    fireEvent.change(textarea, { target: { value: 'SQLite' } });

    // Submit answer
    const submitBtn = screen.getByRole('button', { name: /Gửi câu trả lời/i });
    fireEvent.click(submitBtn);

    // The form should surface that the operation is being processed or awaiting reconciliation,
    // not just leave a silently disabled button without explanation!
    await waitFor(() => {
      expect(submitBtn.hasAttribute('disabled')).toBe(true);
      expect(screen.getByText(/Đang xử lý hoặc chờ đối chiếu câu trả lời/i)).toBeTruthy();
    });
  });

  it('Attack 3: Projects registration guards against double-submit and trims leading/trailing whitespace in path', async () => {
    let registerCalls = 0;
    const pathsReceived: string[] = [];
    const createdProject = {
      apiVersion: 1,
      projectId: 'new-proj',
      displayName: 'Dự án mới',
      canonicalPath: '/work/new-proj',
      registrationState: 'registered',
    };

    vi.stubGlobal('fetch', async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        registerCalls++;
        const parsed = JSON.parse(opts.body as string);
        pathsReceived.push(parsed.path);
        // Delay response to allow simulated double-submit
        await new Promise(r => setTimeout(r, 50));
        return Response.json(createdProject, { status: 201 });
      }
      return Response.json({ apiVersion: 1, items: projects });
    });

    const api = new ApiClient();
    const refresh = vi.fn();
    render(
      <MemoryRouter>
        <Projects api={api} projects={[]} refresh={refresh} />
      </MemoryRouter>,
    );

    const input = screen.getByPlaceholderText('/duong-dan/du-an') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   /work/new-proj   ' } });

    const form = input.closest('form')!;
    // Simulate double submit by firing submit twice rapidly
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(registerCalls).toBe(1));
    expect(pathsReceived[0]).toBe('/work/new-proj'); // Trimmed whitespace!
  });

  it('Attack 4: Settings initialize and unregister guard against concurrent duplicate dispatch', async () => {
    let initCalls = 0;
    const project = {
      apiVersion: 1 as const,
      projectId: 'p',
      displayName: 'Vườn sách',
      canonicalPath: '/work/books',
      registrationState: 'registered' as const,
    };

    vi.stubGlobal('fetch', async (url: string, opts?: RequestInit) => {
      if (url.includes('/initializations') && opts?.method === 'POST') {
        initCalls++;
        await new Promise(r => setTimeout(r, 50));
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          operationId: 'op-init-1',
          state: 'running',
          message: 'Initializing...',
          updatedAt: now,
        }, { status: 202 });
      }
      if (url.includes('/configuration')) {
        return Response.json({
          apiVersion: 1,
          projectId: 'p',
          revision: 'rev1',
          yaml: 'projectName: Test\n',
          values: { projectName: 'Test' },
        });
      }
      return Response.json({});
    });

    const api = new ApiClient();
    render(
      <MemoryRouter>
        <Settings api={api} project={project} />
      </MemoryRouter>,
    );

    // Accept license to enable initialize button
    const licenseCheckbox = screen.getByLabelText(/Tôi chấp nhận điều kiện GitNexus/i);
    fireEvent.click(licenseCheckbox);

    const initBtn = screen.getByRole('button', { name: /Khởi tạo \/ sửa GitNexus/i });
    // Double click rapidly
    fireEvent.click(initBtn);
    fireEvent.click(initBtn);

    await waitFor(() => expect(initCalls).toBe(1));
  });

  it('Attack 5: ChatComposer displays informative notice on mount when pending message is awaiting reconciliation', async () => {
    const key = JSON.stringify(['bflow-chat', 'p', 'session-1']);
    localStorage.setItem(key, JSON.stringify({ version: 1, messageId: '12345678-1234-4234-8234-123456789012' }));

    const api = new ApiClient();
    const onPending = vi.fn();
    const refresh = vi.fn();

    render(
      <ChatComposer
        api={api}
        projectId="p"
        sessionId="session-1"
        runId="run-1"
        ready={true}
        sessionFresh={true}
        refresh={refresh}
        onPending={onPending}
      />,
    );

    // On mount with pending key, notice must inform the user why the composer is locked
    const notice = screen.getByRole('status');
    expect(notice.textContent).toMatch(/Đang có tin nhắn trước chờ đối chiếu kết quả gửi/i);
  });

  it('Attack 6: ProjectConfiguration bulk bar excludes agy from conversation and clears incompatible model on provider switch', async () => {
    const roles = [
      { role: 'conversation', cli: 'claude', model: 'haiku' },
      { role: 'developer', cli: 'claude', model: 'haiku' },
      { role: 'reviewer', cli: 'claude', model: 'haiku' },
    ];

    let savedValues: any = null;
    const api = {
      configuration: vi.fn(async () => ({
        apiVersion: 1,
        projectId: 'p',
        revision: 'rev1',
        yaml: '',
        values: { environment: { roles } },
      })),
      saveConfiguration: vi.fn(async (_id: string, input: any) => {
        savedValues = input.values;
        return { apiVersion: 1, projectId: 'p', revision: 'rev2', yaml: '', values: input.values };
      }),
    } as unknown as ApiClient;

    render(<ProjectConfiguration api={api} id="p" revision={0} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Áp dụng cho tất cả vai trò/i })).toBeTruthy());

    // Switch bulk provider to agy
    const bulkCliSelect = screen.getByLabelText(/Áp dụng nhanh Provider/i);
    fireEvent.change(bulkCliSelect, { target: { value: 'agy' } });

    // Click apply all
    const applyAllBtn = screen.getByRole('button', { name: /Áp dụng cho tất cả vai trò/i });
    fireEvent.click(applyAllBtn);

    // Save
    const saveBtn = screen.getByRole('button', { name: /Lưu cấu hình/i });
    fireEvent.click(saveBtn);

    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledTimes(1));
    const savedRoles = savedValues.environment.roles;

    // conversation role MUST NOT be changed to agy (Agy Conversation is unsupported)!
    const conversationRole = savedRoles.find((r: any) => r.role === 'conversation');
    expect(conversationRole.cli).not.toBe('agy');
    expect(conversationRole.cli).toBe('claude');

    // Developer and reviewer roles SHOULD be changed to agy
    const devRole = savedRoles.find((r: any) => r.role === 'developer');
    expect(devRole.cli).toBe('agy');
  });

  it('Attack 7: ProjectConfiguration allows reloading fresh configuration when stale_version error occurs while dirty', async () => {
    let loadCount = 0;
    const initialConfig = {
      apiVersion: 1,
      projectId: 'p',
      revision: 'rev-stale',
      yaml: 'projectName: Old\n',
      values: { projectName: 'Old' },
    };
    const freshConfig = {
      apiVersion: 1,
      projectId: 'p',
      revision: 'rev-fresh',
      yaml: 'projectName: Fresh\n',
      values: { projectName: 'Fresh' },
    };

    const api = {
      configuration: vi.fn(async () => {
        loadCount++;
        return loadCount === 1 ? initialConfig : freshConfig;
      }),
      saveConfiguration: vi.fn(async () => {
        throw new ConfigurationError('Phiên bản cấu hình đã thay đổi trên đĩa (stale_version).');
      }),
    } as unknown as ApiClient;

    render(<ProjectConfiguration api={api} id="p" revision={0} />);

    await screen.findByDisplayValue('Old');

    // Make an edit -> form is now dirty
    const input = screen.getByLabelText(/Tên dự án/i);
    fireEvent.change(input, { target: { value: 'Edited Project' } });

    // Save -> throws stale_version ConfigurationError
    const saveBtn = screen.getByRole('button', { name: /Lưu cấu hình/i });
    fireEvent.click(saveBtn);

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('Phiên bản cấu hình đã thay đổi');

    // "Tải cấu hình mới nhất" must NOT remain disabled when an error / stale_version occurs
    const reloadBtn = screen.getByRole('button', { name: /Tải cấu hình mới nhất/i });
    expect(reloadBtn.hasAttribute('disabled')).toBe(false);

    // Click reload
    fireEvent.click(reloadBtn);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Fresh')).toBeTruthy();
    });
  });

  it('Attack 8: RunActions clears previous error banner when availableActions are updated', async () => {
    let currentActions = [{
      actionId: 'act-resume-1',
      kind: 'resume' as const,
      enabled: true,
      expectedVersion: { revisionToken: 't1' },
    }];

    const runData = {
      ...run,
      availableActions: currentActions,
    };

    const api = {
      run: vi.fn(async () => {
        // First attempt throws stale version
        throw new ApiError('stale_version');
      }),
    } as unknown as ApiClient;

    const refresh = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={refresh}>
          <RunActions api={api} id="p" run={runData} fresh={true} refresh={refresh} />
        </Operations>
      </MemoryRouter>,
    );

    // Click resume -> throws stale_version and sets error
    const resumeBtn = screen.getByRole('button', { name: /Tiếp tục/i });
    fireEvent.click(resumeBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    // Parent refreshes and re-renders RunActions with new actions and updatedAt
    const updatedRunData = {
      ...run,
      updatedAt: '2026-10-29T00:05:00Z',
      availableActions: [{
        actionId: 'act-resume-2',
        kind: 'resume' as const,
        enabled: true,
        expectedVersion: { revisionToken: 't2' },
      }],
    };

    rerender(
      <MemoryRouter>
        <Operations api={api} id="p" refresh={refresh}>
          <RunActions api={api} id="p" run={updatedRunData} fresh={true} refresh={refresh} />
        </Operations>
      </MemoryRouter>,
    );

    // Stale error must be cleared now that fresh actions arrived
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('Attack 9: ApiClient mutating endpoints specify sufficient timeout for disk-bound local-server operations', async () => {
    const requestedTimeouts: number[] = [];
    const client = new ApiClient();

    vi.spyOn(client, 'request').mockImplementation(async (_path, _schema, _method, _body, timeoutMs) => {
      requestedTimeouts.push(timeoutMs ?? 10000);
      return {} as any;
    });

    await client.saveConfiguration('p', { apiVersion: 1, expectedRevision: 'rev' }).catch(() => {});
    await client.register('/work/p').catch(() => {});
    await client.unregister('p').catch(() => {});
    await client.initialize('p', { apiVersion: 1, operationId: '00000000-0000-4000-8000-000000000001', acceptGitNexusLicense: false }).catch(() => {});

    // Every mutating call to disk-heavy routes must have a timeout >= 25000ms
    for (const timeout of requestedTimeouts) {
      expect(timeout).toBeGreaterThanOrEqual(25000);
    }
  });
});
