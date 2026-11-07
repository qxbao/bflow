import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WebAgentViewSchema, WebProjectSessionSchema } from '@bflow/contracts/web';
import { AgentDialogue } from '../src/features/office/ui/interaction/AgentDialogue';
import { FirstVisit, replayFirstVisit } from '../src/features/office/ui/interaction/FirstVisit';
import { DirectorDialogue } from '../src/features/office/ui/interaction/DirectorDialogue';
import { OfficeNotifications } from '../src/features/office/ui/interaction/OfficeNotifications';
import type { OfficeAgent, OfficeModel } from '../src/features/office/model/types';
import { ApiClient } from '../src/api/client';
import { installApi, now, session } from './fixtures';

const agent: OfficeAgent = { instanceId: 'dev-1', label: 'Developer #1', role: 'developer', pose: 'ghost', certainty: 'unknown', statusText: 'Chưa xác định', runId: 'run-1', taskId: 'task-1' };
const view = WebAgentViewSchema.parse({ instanceId: 'dev-1', role: 'developer', displayName: 'Developer #1', permanent: false, provider: 'codex', allocation: 'active', transport: { state: 'done', observedAt: now }, boundAt: now, work: [{ messageId: 'm-1', kind: 'assignment', runId: 'run-1', taskId: 'task-1', delivery: 'accepted' }] });
const model: OfficeModel = { tier: 'full', certainty: 'confirmed', statusText: '', agents: [], tasks: [], pendingDecisions: 2, handoffs: [], connection: 'connected' };
const ready = WebProjectSessionSchema.parse({ ...session, state: 'ready', sessionId: 'session-1', pendingIntakes: [{ intakeId: 'intake-1', sessionId: 'session-1', correlationId: 'correlation-1', title: 'Intake title', status: 'clarifying', clarifications: [{ questionId: 'q-1', question: 'Which option?', options: ['Option A'], expectedVersion: { revisionToken: 'revision-1' } }], updatedAt: now }] });

beforeEach(() => { localStorage.clear(); installApi({}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

test('FirstVisit has exactly three short steps, skip persists, and replay starts again', () => {
  const onDirector = vi.fn(), onTasks = vi.fn(), onInbox = vi.fn();
  const props = { projectId: 'phase4-project', active: true, onDirector, onTasks, onInbox };
  const { rerender } = render(<FirstVisit {...props} />);
  expect(screen.getByText('Bắt đầu · 1/3')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Director' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
  expect(screen.getByText('Bắt đầu · 2/3')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Bỏ qua' }));
  expect(screen.queryByRole('region', { name: 'Hướng dẫn lần đầu' })).toBeNull();
  expect(localStorage.getItem('bflow:immersive-office:first-visit:phase4-project')).toBe('dismissed');
  replayFirstVisit('phase4-project');
  rerender(<FirstVisit {...props} />);
  expect(screen.getByText('Bắt đầu · 1/3')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Director' }));
  expect(onDirector).toHaveBeenCalledTimes(1);
  expect(onTasks).not.toHaveBeenCalled();
  expect(onInbox).not.toHaveBeenCalled();
});

test('FirstVisit retains its step while temporarily hidden and completes after the third step', () => {
  const props = { projectId: 'phase4-project', active: true, onDirector: vi.fn(), onTasks: vi.fn(), onInbox: vi.fn() };
  const { rerender } = render(<FirstVisit {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
  rerender(<FirstVisit {...props} active={false} />);
  expect(screen.queryByRole('region', { name: 'Hướng dẫn lần đầu' })).toBeNull();
  rerender(<FirstVisit {...props} />);
  expect(screen.getByText('Bắt đầu · 2/3')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
  expect(screen.getByText('Bắt đầu · 3/3')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Hoàn tất' }));
  expect(localStorage.getItem('bflow:immersive-office:first-visit:phase4-project')).toBe('completed');
});

test('OfficeNotifications routes approvals to the inbox and clarifications to overview without adding a live announcer', () => {
  const onInbox = vi.fn(), onClarifications = vi.fn();
  const { container } = render(<OfficeNotifications connection="connected" session={ready} stale={false} authRequired={false} model={model} onInbox={onInbox} onClarifications={onClarifications} />);
  fireEvent.click(screen.getByRole('button', { name: /2 yêu cầu cần bạn trả lời/ }));
  fireEvent.click(screen.getByRole('button', { name: /1 câu hỏi đang chờ/ }));
  expect(onInbox).toHaveBeenCalledTimes(1);
  expect(onClarifications).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[aria-live]')).toBeNull();
});

test('inactive Director dialogue has no backdrop or click target', () => {
  const { container } = render(<DirectorDialogue active={false} onClose={vi.fn()}><p>Hidden transcript</p></DirectorDialogue>);
  expect(container.querySelector('.fixed.inset-0.z-40')).toBeNull();
  expect(container.querySelector('[aria-label="Hội thoại tại bàn Director"][aria-hidden="true"]')).toBeTruthy();
});

test('AgentDialogue reports unknown waiting authority and mounts technical evidence only on disclosure', async () => {
  const fetcher = installApi({}).fetcher;
  render(<MemoryRouter><AgentDialogue api={new ApiClient()} projectId="p" agent={agent} view={view} handoffs={[]} revision={0} titleOf={() => 'Build search'} /></MemoryRouter>);
  expect(screen.getByText('Build search (đã nhận)')).toBeTruthy();
  expect(screen.getByText('Chưa xác định từ dữ liệu hiện có.')).toBeTruthy();
  expect(screen.getByText(/không xác nhận công việc đã hoàn tất/)).toBeTruthy();
  expect(screen.getByRole('link', { name: /Xem công việc: Build search/ }).getAttribute('href')).toBe('/projects/p/runs/run-1');
  expect(fetcher.mock.calls.some(([path]) => String(path).includes('/activity'))).toBe(false);
  fireEvent.click(screen.getByText('Chi tiết kỹ thuật'));
  expect(await screen.findByText(/Nhật ký chỉ ghi vai trò/)).toBeTruthy();
  expect(fetcher.mock.calls.some(([path]) => String(path).includes('/activity'))).toBe(true);
  expect(screen.getByText(/Nội dung gần đây/)).toBeTruthy();
});

test('OfficeNotifications offers one-click actions for stopped session, absent Director and open queue issues, and AgentDialogue maps known poses', () => {
  const onServer = vi.fn(), onDirector = vi.fn(), onQueue = vi.fn();
  const stoppedSession = WebProjectSessionSchema.parse({ ...session, state: 'stopped', pendingIntakes: [] });
  const directorModel: OfficeModel = {
    ...model,
    director: { label: 'Director', presence: 'absent', certainty: 'confirmed', statusText: 'Chưa có mặt' },
    queue: { availability: 'ready', open: 2, retrying: 0, truncated: false },
  };
  const { rerender } = render(
    <OfficeNotifications
      connection="connected"
      session={stoppedSession}
      stale={false}
      authRequired={false}
      model={directorModel}
      onInbox={() => {}}
      onClarifications={() => {}}
      onServer={onServer}
      onDirector={onDirector}
      onQueue={onQueue}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Phiên đang dừng · Mở máy chủ phiên' }));
  expect(onServer).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '2 sự cố đang mở · Xem hàng đợi' }));
  expect(onQueue).toHaveBeenCalledTimes(1);

  rerender(
    <OfficeNotifications
      connection="connected"
      session={ready}
      stale={false}
      authRequired={false}
      model={directorModel}
      onInbox={() => {}}
      onClarifications={() => {}}
      onServer={onServer}
      onDirector={onDirector}
      onQueue={onQueue}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Director chưa có mặt · Mở bàn Director' }));
  expect(onDirector).toHaveBeenCalledTimes(1);

  cleanup();
  render(<MemoryRouter><AgentDialogue api={new ApiClient()} projectId="p" agent={{ ...agent, pose: 'hand_raised' }} view={view} handoffs={[]} revision={0} titleOf={() => 'Build search'} /></MemoryRouter>);
  expect(screen.getByText('Đang chờ bạn quyết định')).toBeTruthy();
});
