import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WebProjectSchema } from '@bflow/contracts/web';
import { ApiClient } from '../src/api/client';
import { DecisionCard } from '../src/components/DecisionCard';
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
    const convModel = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Model (conversation)' });
    const devModel = screen.getByRole<HTMLInputElement>('textbox', { name: 'Model (developer)' });
    expect(convModel.getAttribute('list')).toBeNull();
    expect(convModel.value).toBe('sonnet');
    expect(devModel.value).toBe('gpt-5');

    fireEvent.change(screen.getByLabelText('Áp dụng nhanh Provider'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Áp dụng nhanh Model'), { target: { value: 'haiku' } });
    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng cho tất cả vai trò' }));

    expect(convModel.value).toBe('haiku');
    expect(devModel.value).toBe('haiku');
    expect((screen.getByLabelText('Provider (developer)') as HTMLSelectElement).value).toBe('claude');
  });

  it('shows advisory notes collapsed when inspection.ready is true and expanded warnings when ready is false', async () => {
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
              { id: 'p13-manifest', state: 'failed', message: 'No topology manifest yet. Run bflow up.' },
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
  });
});
