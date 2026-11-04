import { useEffect, useRef, useState, type ReactNode } from 'react';
import { queueText, roleLabel } from '../model/labels';
import type { Certainty, OfficeDirectorPresence, OfficeModel, OfficeObjectId, OfficeTarget } from '../model/types';

const CERTAINTY: Readonly<Record<Certainty, string>> = { confirmed: 'Đã xác nhận', inferred: 'Suy luận', unknown: 'Chưa xác định' };
/** The seven interactive objects of §5.3 (the eighth row, the characters, is the agent list, one button each). Navigation arrives with the panel wiring (V7.2). */
const OBJECTS: readonly [OfficeObjectId, string][] = [
  ['counter', 'Quầy Conversation (trò chuyện)'], ['board', 'Bảng nhiệm vụ (công việc)'], ['mailbox', 'Hộp thư (quyết định)'],
  ['cabinet', 'Tủ tài liệu (bằng chứng)'], ['server', 'Máy chủ (phiên)'], ['settings', 'Bảng cài đặt'], ['door', 'Cửa ra vào (danh sách dự án)'],
];
/** In a Director layout the executive desk is the Director's; the counter label follows it. */
const DIRECTOR_COUNTER = 'Bàn Director (trò chuyện)';
const present = (p: OfficeDirectorPresence | undefined): boolean => p === 'active' || p === 'waiting';
/** Announcements are merged and spoken at most once per window. */
export const ANNOUNCE_WINDOW_MS = 5000;

/**
 * New pending decisions and errors, plus Director arrival/departure and new open issues, from model changes. The first model is the baseline and
 * says nothing. Director presence is compared with the last *confirmed* presence, so a failed read (unknown) is never announced as an absence and
 * the recovery from one is not announced as an arrival; the queue count is compared with the last count that was actually read.
 */
function useAnnouncement(model: OfficeModel, notice: string | undefined): string {
  const [text, setText] = useState('');
  const prev = useRef<{ pending: number; offline: boolean; failed: ReadonlySet<string>; presence: OfficeDirectorPresence | undefined; open: number | undefined } | undefined>(undefined);
  const queue = useRef<string[]>([]);
  const last = useRef(Number.NEGATIVE_INFINITY);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const push = (messages: string[]): void => {
    if (messages.length === 0) return;
    queue.current.push(...messages);
    if (timer.current !== undefined) return;
    const flush = (): void => { timer.current = undefined; last.current = Date.now(); setText(queue.current.splice(0).join('. ')); };
    const wait = last.current + ANNOUNCE_WINDOW_MS - Date.now();
    if (wait <= 0) flush(); else timer.current = setTimeout(flush, wait);
  };
  useEffect(() => {
    const failed = new Set(model.handoffs.filter(h => h.state === 'rejected' || h.state === 'failed').map(h => h.handoffId));
    const before = prev.current;
    const seen = model.director?.presence, queue = model.queue?.availability === 'ready' ? model.queue.open : undefined;
    const now = { pending: model.pendingDecisions, offline: model.connection === 'offline', failed,
      presence: seen !== undefined && seen !== 'unknown' ? seen : before?.presence, open: queue ?? before?.open };
    prev.current = now;
    if (!before) return;
    const out: string[] = [];
    if (now.pending > before.pending) out.push(`Có ${now.pending} quyết định đang chờ bạn`);
    if (now.offline && !before.offline) out.push('Mất kết nối tới máy chủ, đang hiển thị dữ liệu cũ');
    if ([...failed].some(id => !before.failed.has(id))) out.push('Có bàn giao bị từ chối hoặc thất bại');
    if (before.presence !== undefined && now.presence !== undefined && present(now.presence) !== present(before.presence)) out.push(present(now.presence) ? 'Director đã có mặt' : 'Director không còn báo hoạt động');
    if (queue !== undefined && before.open !== undefined && queue > before.open) out.push(`Có ${queue - before.open} sự cố mới cần xử lý`);
    push(out);
  }, [model]);
  useEffect(() => { if (notice) push([notice]); }, [notice]);
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current); }, []);
  return text;
}

/**
 * The real DOM mirror of the scene (§5.7): the stable surface for assistive technology and tests. While the canvas is healthy it is
 * visually hidden but still reachable by Tab (and revealed over the scene while focused); when the canvas failed it is the visible,
 * complete list. `extra` carries page navigation that has no scene object yet.
 */
export function AccessibleOffice({ model, onSelect, visible, notice, extra }: { model: OfficeModel; onSelect: (target: OfficeTarget) => void; visible: boolean; notice?: string | undefined; extra?: ReactNode }) {
  const announced = useAnnouncement(model, notice);
  const taskTitle = (runId: string | undefined, taskId: string | undefined): string => {
    if (!taskId) return 'Không có việc';
    return model.tasks.find(t => t.taskId === taskId && t.runId === runId)?.title ?? taskId;
  };
  return <>
    <div aria-live="polite" role="status" className="sr-only">{announced}</div>
    <section aria-label="Bản văn bản của văn phòng" className={visible ? '' : 'sr-only focus-within:not-sr-only focus-within:absolute focus-within:inset-x-3 focus-within:top-28 focus-within:bottom-36 focus-within:z-20 focus-within:overflow-auto focus-within:rounded-xl focus-within:bg-surface md:focus-within:right-24'}>
      <div className="border border-line p-3">
        {notice && <p className="m-0 mb-2 font-semibold">{notice}</p>}
        {model.tier !== 'full' && <p className="m-0 mb-2">{model.statusText} ({CERTAINTY[model.certainty]})</p>}
        {model.director && <>
          <h3 className="m-0 text-base font-semibold">Director</h3>
          <ul className="my-2 list-none p-0"><li className="py-1.5">
            <button type="button" className="text-left" onClick={() => onSelect({ kind: 'director' })}>
              <span className="font-semibold">Director:</span> {model.director.statusText}. Mức tin cậy: {CERTAINTY[model.director.certainty]}{model.director.heartbeatAt ? `, báo hoạt động lúc ${model.director.heartbeatAt}` : ''}{model.director.provider ? `, ${model.director.provider}` : ''}.
            </button>
          </li></ul>
        </>}
        <h3 className="m-0 text-base font-semibold">Nhân viên</h3>
        {model.agents.length === 0 ? <p className="m-0 text-sm text-muted">Chưa có nhân viên nào.</p> : <ul className="my-2 list-none p-0">
          {model.agents.map(a => <li key={a.instanceId} className="border-t border-line py-1.5 first:border-t-0">
            <button type="button" className="text-left" onClick={() => onSelect({ kind: 'agent', instanceId: a.instanceId })}>
              <span className="font-semibold">{a.label}</span> ({roleLabel(a.role)}): {a.statusText}. Mức tin cậy: {CERTAINTY[a.certainty]}{a.observedAt ? `, quan sát lúc ${a.observedAt}` : ''}. Việc: {taskTitle(a.runId, a.taskId)}.
            </button>
          </li>)}
        </ul>}
        <h3 className="m-0 text-base font-semibold">Đối tượng</h3>
        <ul className="my-2 list-none p-0">
          {OBJECTS.map(([object, label]) => <li key={object} className="py-0.5">
            <button type="button" onClick={() => onSelect({ kind: 'object', object })}>{object === 'counter' && model.director ? DIRECTOR_COUNTER : label}{object === 'mailbox' && model.pendingDecisions > 0 ? ` (${model.pendingDecisions} đang chờ)` : ''}</button>
          </li>)}
          {model.director && <li className="py-0.5"><button type="button" onClick={() => onSelect({ kind: 'queue' })}>Bảng sự cố ({queueText(model.queue)})</button></li>}
        </ul>
        {extra}
      </div>
    </section>
  </>;
}
