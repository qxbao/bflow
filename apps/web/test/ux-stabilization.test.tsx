import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WebProjectSchema } from '@bflow/contracts/web';
import { ApiClient } from '../src/api/client';
import { DecisionCard, decisionQuestionLabel } from '../src/components/DecisionCard';
import { LoadingState } from '../src/components/LoadingState';
import { Settings } from '../src/features/settings';
import { ProjectConfiguration } from '../src/features/project-configuration';
import { RunView } from '../src/features/runs';
import { Operations } from '../src/features/operations';
import { decision, now, projects, run } from './fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Web UX stabilization & functional regression guards', () => {
  it('renders skeleton placeholders on initial load and an out-of-flow fixed status pill on background refresh', () => {
    const initial = render(<LoadingState loading initial label="Đang tải lần đầu…" />);
    expect(initial.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    initial.unmount();

    render(<LoadingState loading initial={false} label="Đang tải…" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Đang cập nhật dữ liệu…');
    expect(status.className).toContain('fixed');
  });

  it('keeps role Model inputs as textbox role and supports 1-click bulk Provider/Model apply across roles', async () => {
    const config = {
      apiVersion: 1,
      projectId: 'p',
      revision: 'a'.repeat(64),
      yaml: 'projectName: Vườn sách\nenvironment: {}\n',
      values: {
        projectName: 'Vườn sách',
        environment: {
          roles: [
            { role: 'conversation', cli: 'claude', model: 'sonnet', required: true },
            { role: 'developer', cli: 'codex', model: 'gpt-5', required: true },
          ],
        },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(config), { status: 200 })),
    );

    render(<ProjectConfiguration api={new ApiClient()} id="p" revision={0} />);
    const convModel = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Mô hình AI (conversation)' });
    const devModel = screen.getByRole<HTMLInputElement>('textbox', { name: 'Mô hình AI (developer)' });
    expect(convModel.getAttribute('list')).toBeNull();
    expect(convModel.value).toBe('sonnet');
    expect(devModel.value).toBe('gpt-5');

    fireEvent.change(screen.getByLabelText('Công cụ AI cho cả nhóm'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Mô hình AI cho cả nhóm'), { target: { value: 'haiku' } });
    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng cho tất cả vai trò' }));

    expect(convModel.value).toBe('haiku');
    expect(devModel.value).toBe('haiku');
    expect((screen.getByLabelText('Công cụ AI (developer)') as HTMLSelectElement).value).toBe('claude');
  });

  it.each([
    ['codex', 'GPT-6.1-Sol', 'gpt-6.1-sol'],
    ['codex', 'GPT-6.1-Terra', 'gpt-6.1-terra'],
    ['codex', 'GPT-5.6-Terra', 'gpt-5.6-terra'],
    ['agy', 'Gemini 4 Argon (High)', 'gemini-4-argon-high'],
    ['agy', 'Claude Sonnet 5.5 (Medium)', 'claude-sonnet-5-5-medium'],
    ['agy', 'GPT-OSS 120B (Medium)', 'gpt-oss-120b-medium'],
  ])('selects %s model %s by its native ID and keeps other providers out of quick picks', async (provider, label, modelId) => {
    const config = {
      apiVersion: 1, projectId: 'p', revision: 'a'.repeat(64), yaml: '',
      values: { environment: { roles: [
        { role: 'conversation', cli: 'claude', model: 'sonnet' },
        { role: 'developer', cli: 'codex', model: 'team-codex-model' },
        { role: 'reviewer', cli: 'agy', model: 'team-agy-model' },
      ] } },
    };
    let saved: any;
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        saved = JSON.parse(String(init.body));
        return Response.json({ ok: true, value: { ...config, values: saved.values } });
      }
      return Response.json(config);
    }));
    render(<ProjectConfiguration api={new ApiClient()} id="p" revision={0} />);
    await screen.findByLabelText('Công cụ AI (developer)');
    fireEvent.change(screen.getByLabelText('Công cụ AI cho cả nhóm'), { target: { value: provider } });
    expect(screen.queryByRole('button', { name: 'sonnet' })).toBeNull();
    expect(screen.queryByRole('button', { name: provider === 'codex' ? 'team-agy-model' : 'team-codex-model' })).toBeNull();
    expect(screen.getByRole('button', { name: provider === 'codex' ? 'team-codex-model' : 'team-agy-model' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: provider === 'codex' ? 'o4-mini' : 'gemini-2.5-pro' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect((screen.getByLabelText('Mô hình AI cho cả nhóm') as HTMLInputElement).value).toBe(modelId);
    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng cho tất cả vai trò' }));
    expect((screen.getByLabelText('Mô hình AI (developer)') as HTMLInputElement).value).toBe(modelId);
    expect((screen.getByLabelText('Mô hình AI (conversation)') as HTMLInputElement).value).toBe(provider === 'agy' ? 'sonnet' : modelId);
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cấu hình' }));
    await screen.findByText(/Đã lưu cấu hình/);
    expect(saved.values.environment.roles[1]).toEqual({ role: 'developer', cli: provider, model: modelId });
  });

  it('clears the bulk model when switching providers so a stale selection cannot be applied', async () => {
    const config = {
      apiVersion: 1, projectId: 'p', revision: 'a'.repeat(64), yaml: '',
      values: { environment: { roles: [{ role: 'developer', cli: 'claude', model: 'sonnet' }] } },
    };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(config)));
    render(<ProjectConfiguration api={new ApiClient()} id="p" revision={0} />);
    await screen.findByLabelText('Công cụ AI (developer)');
    fireEvent.click(screen.getByRole('button', { name: 'haiku' }));
    fireEvent.change(screen.getByLabelText('Công cụ AI cho cả nhóm'), { target: { value: 'codex' } });
    expect((screen.getByLabelText('Mô hình AI cho cả nhóm') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng cho tất cả vai trò' }));
    expect((screen.getByLabelText('Công cụ AI (developer)') as HTMLSelectElement).value).toBe('codex');
    expect((screen.getByLabelText('Mô hình AI (developer)') as HTMLInputElement).value).toBe('');
  });

  it('keeps warnings advisory and expands blocking failures independently of readiness', async () => {
    let ready = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path.endsWith('/configuration')) {
          return new Response(
            JSON.stringify({
              apiVersion: 1,
              projectId: 'p',
              configPath: '.bflow/config.yml',
              revision: 'rev-1',
              rawYaml: 'version: 3\n',
              values: { version: 3 },
              editablePaths: [],
              preservedKeys: [],
              observedAt: now,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            apiVersion: 1,
            projectId: 'p',
            ready,
            checks: [
              { id: 'p13-manifest', state: 'warning', message: 'No topology manifest yet. Run bflow up.' },
              ...(!ready ? [{id:'provider-auth',state:'failed',message:'Required provider authentication failed'}] : []),
              { id: 'git-repo', state: 'passed', message: 'Git repository clean' },
            ],
            observedAt: now,
          }),
          { status: 200 },
        );
      }),
    );

    render(
      <MemoryRouter>
        <Settings api={new ApiClient()} project={WebProjectSchema.parse(projects[0])} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra điều kiện sẵn sàng' }));
    expect(await screen.findByText(/Tất cả điều kiện bắt buộc đã sẵn sàng/)).toBeTruthy();
    expect(screen.getByText(/Xem 1 lưu ý tham khảo/)).toBeTruthy();

    ready = false;
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra điều kiện sẵn sàng' }));
    expect(await screen.findByText(/Một số điều kiện cần xử lý trước khi khởi động phiên/)).toBeTruthy();
    expect(screen.getByText('Phiên làm việc chưa khởi động')).toBeTruthy();
    expect(screen.getByText(/Xem 1 lưu ý tham khảo/).closest('details')?.open).toBe(false);
    expect(screen.getByText('Required provider authentication failed').closest('details')).toBeNull();
  });

  it('suppresses benign disabledReason notices while displaying actionable ones and plain-Vietnamese phase summaries', async () => {
    const viewWithActions = {
      ...run,
      decisions: [],
      availableActions: [
        { kind: 'resume', actionId: 'r1', enabled: false, disabledReason: 'not_resumable', expectedVersion: { revisionToken: 'v1' } },
        { kind: 'revise_request', actionId: 'r2', enabled: false, disabledReason: 'core_execution_started', expectedVersion: { revisionToken: 'v1' } },
        { kind: 'cancel', actionId: 'r3', enabled: true, expectedVersion: { revisionToken: 'v1' } },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path.endsWith('/runs/run')) return new Response(JSON.stringify(viewWithActions), { status: 200 });
        if (path.endsWith('/session'))
          return new Response(JSON.stringify({ apiVersion: 1, projectId: 'p', sessionId: 'host-session', state: 'ready', pendingIntakes: [], blockers: [], updatedAt: now }), { status: 200 });
        return new Response(JSON.stringify({ apiVersion: 1, items: [] }), { status: 200 });
      }),
    );

    render(
      <MemoryRouter>
        <Operations api={new ApiClient()} id="p" refresh={() => {}}>
          <RunView api={new ApiClient()} id="p" runId="run" revision={0} refresh={() => {}} />
        </Operations>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Hệ thống đang lập trình thay đổi theo kế hoạch/)).toBeTruthy();
    expect(screen.queryByText(/Công việc đang chạy bình thường hoặc chờ bước khác/)).toBeNull();
    expect(screen.getByText(/Nhiệm vụ đã bắt đầu thực thi nên không thể chỉnh yêu cầu tại chỗ/)).toBeTruthy();
  });

  it('translates runtime approval questions/JSON fields to Vietnamese and collapses long evidence lists cleanly', async () => {
    const manyEvidence = Array.from({ length: 6 }, (_, index) => ({
      ...decision.evidence[0]!,
      artifactId: `artifact-${index + 1}`,
    }));
    const pendingDelivery = {
      ...decision,
      decisionId: 'delivery-123',
      question: 'Approve delivery of independently verified integrated changes',
      status: 'pending' as const,
      evidence: manyEvidence,
    };
    const { unmount } = render(<DecisionCard decision={pendingDelivery} api={new ApiClient()} projectId="p" />);
    expect(screen.getByText('Phê duyệt bàn giao kết quả đã kiểm chứng độc lập')).toBeTruthy();
    expect(screen.getByText('Xem thêm 3 tài liệu kiểm chứng khác').tagName).toBe('SUMMARY');
    unmount();

    const settledDelivery = { ...pendingDelivery, status: 'approved' as const };
    render(<DecisionCard decision={settledDelivery} api={new ApiClient()} projectId="p" />);
    expect(screen.getByText('Tài liệu kiểm chứng đính kèm (6)').tagName).toBe('SUMMARY');
    expect(decisionQuestionLabel('Specification acceptance')).toBe('Phê duyệt đặc tả công việc');
    expect(decisionQuestionLabel('Custom question')).toBe('Custom question');
  });
});
