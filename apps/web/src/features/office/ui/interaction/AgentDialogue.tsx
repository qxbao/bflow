import { useState } from 'react';
import { Link } from 'react-router';
import type { ApiClient } from '../../../../api/client';
import type { WebAgentView, WebHandoffView } from '@bflow/contracts/web';
import type { OfficeAgent } from '../../model/types';
import { roleLabel } from '../../model/labels';
import { AgentInspector } from '../AgentInspector';

/** Short, evidence-bound explanation of one worker. Technical reads stay unmounted until explicitly requested. */
export function AgentDialogue({ api, projectId, agent, view, handoffs, revision, titleOf }: {
  api: ApiClient; projectId: string; agent: OfficeAgent; view: WebAgentView | undefined;
  handoffs: readonly WebHandoffView[]; revision: number; titleOf: (runId: string, taskId?: string) => string;
}) {
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const assignments = view?.work.filter(work => ['queued', 'sending', 'accepted', 'unknown_delivery'].includes(work.delivery)) ?? [];
  const links = [...new Map(assignments.map(work => [work.runId, work])).values()];
  const delivery = (value: string): string => ({ queued: 'đang xếp hàng', sending: 'đang gửi', accepted: 'đã nhận', unknown_delivery: 'chưa xác định trạng thái bàn giao' }[value] ?? 'chưa xác định');
  const waitingAuthority = agent.pose === 'hand_raised' ? 'Đang chờ bạn quyết định' : agent.pose === 'preparing' ? 'Đang chờ hệ thống giao việc' : agent.pose === 'working' || agent.pose === 'typing' ? 'Đang thực hiện công việc' : agent.pose === 'sleeping' ? 'Chưa có yêu cầu chờ' : 'Chưa xác định từ dữ liệu hiện có.';
  return <section aria-label={`Nhân viên ${agent.label}`} data-component="AgentDialogue" className="min-w-0">
    <p className="m-0 text-xs font-data uppercase tracking-widest text-muted">Nhân viên · {roleLabel(agent.role)}</p>
    <h2 className="mt-1">{agent.label}</h2>
    <dl className="my-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="font-semibold">Đang làm</dt><dd className="m-0">{assignments.length ? assignments.map(work => `${titleOf(work.runId, work.taskId)} (${delivery(work.delivery)})`).join(', ') : view ? 'Chưa có việc đang được giao' : 'Chưa xác định từ dữ liệu hiện có'}</dd>
      <dt className="font-semibold">Chờ ai</dt><dd className="m-0">{waitingAuthority}</dd>
      <dt className="font-semibold">Trạng thái</dt><dd className="m-0">{agent.statusText}. Đây là quan sát hiện tại, không xác nhận công việc đã hoàn tất.</dd>
    </dl>
    {links.length > 0 && <nav aria-label="Công việc của nhân viên" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">{links.map(work => <Link key={work.runId} to={`${base}/runs/${encodeURIComponent(work.runId)}`}>Xem công việc: {titleOf(work.runId, work.taskId)} →</Link>)}</nav>}
    <details className="mt-4 border-t border-line pt-3" onToggle={event => setTechnicalOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold">Chi tiết kỹ thuật</summary>
      {technicalOpen && <AgentInspector api={api} projectId={projectId} agent={agent} view={view} handoffs={handoffs} revision={revision} titleOf={titleOf} />}
    </details>
  </section>;
}
