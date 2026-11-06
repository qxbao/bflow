import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { WebProjectSession, WebRunView } from '@bflow/contracts/web';
import { phases } from '../../../components/StatusBadge';
import type { Connection } from '../../../api/events';
import { connectionText } from '../../../components/ConnectionBanner';
import type { UiMode } from '../mode';
import { ModeSwitch } from './ModeSwitch';
import type { OfficeFocusZone, OfficeModel, OfficePose } from '../model/types';

/** Terminal runs are not "being worked on". */
const FINISHED = new Set(['completed', 'completed_with_parked', 'failed', 'cancelled']);
const SESSION: Record<string, string> = { ready: 'Phiên sẵn sàng', starting: 'Phiên đang khởi động', stopping: 'Phiên đang dừng', stopped: 'Phiên đã dừng', unavailable: 'Phiên chưa sẵn sàng' };

/** The run the "Đang làm" block shows: the most recently updated run that has not reached a terminal state. */
export function currentRun(runs: readonly WebRunView[]): WebRunView | undefined {
  return runs.filter(r => !FINISHED.has(r.sdlcStatus)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
/** Chat can take a draft only when the session is ready and its chat adapter is not reported unavailable. */
export function chatAvailable(session: WebProjectSession | undefined): boolean {
  return session?.state === 'ready' && !session.blockers.some(b => b.code === 'chat_adapter_unavailable');
}

type Bucket = 'working' | 'waiting' | 'idle' | 'lost' | 'unknown';
const BUCKET: Readonly<Record<OfficePose, Bucket>> = { working: 'working', typing: 'working', preparing: 'working', hand_raised: 'waiting', question: 'waiting', sleeping: 'idle', disconnected: 'lost', ghost: 'unknown' };
const BUCKET_TEXT: Readonly<Record<Bucket, string>> = { working: 'đang làm', waiting: 'đang chờ', idle: 'rảnh', lost: 'mất kết nối', unknown: 'chưa rõ' };
/** Agent counts by the derived status (never from a Herdr "done"). Only non-empty buckets are listed. */
export function agentCounts(model: OfficeModel | undefined): string[] {
  if (!model || model.tier !== 'full') return [];
  const n: Record<Bucket, number> = { working: 0, waiting: 0, idle: 0, lost: 0, unknown: 0 };
  for (const a of model.agents) n[BUCKET[a.pose]] += 1;
  return (Object.keys(n) as Bucket[]).filter(k => n[k] > 0).map(k => `${n[k]} ${BUCKET_TEXT[k]}`);
}

type IconName = 'issues' | 'overview' | 'tasks' | 'decision' | 'chat' | 'docs' | 'settings' | 'refresh' | 'send' | 'agents' | 'all' | 'coordinator' | 'developer' | 'qa';
const PATHS: Readonly<Record<IconName, ReactNode>> = {
  issues: <><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/></>,
  overview: <><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></>,
  tasks: <><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/></>,
  decision: <><path d="M4 13l3-8h10l3 8v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/></>,
  chat: <path d="M5 5h14a1 1 0 011 1v9a1 1 0 01-1 1H11l-5 4v-4H5a1 1 0 01-1-1V6a1 1 0 011-1z"/>,
  docs: <><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></>,
  settings: <><path d="M5 7h9M18 7h1M5 17h1M10 17h9"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></>,
  refresh: <path d="M19 12a7 7 0 11-2.1-5M19 4v4h-4"/>,
  agents: <><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.2"/><path d="M16 14.2c2.8-.4 5 1.6 5 4.8"/></>,
  send: <path d="M4 12l16-8-6 16-2-6z"/>,
  all: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>,
  coordinator: <><circle cx="12" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M12 8v4M12 12H6v4M12 12h6v4"/></>,
  developer: <><rect x="3" y="5" width="18" height="12" rx="1"/><path d="M9 21h6M12 17v4"/></>,
  qa: <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4"/>,
};
function Icon({ name }: { name: IconName }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{PATHS[name]}</svg>;
}

const panel = 'rounded-xl border border-line bg-surface/85 backdrop-blur-md';
const railButton = 'relative flex min-h-12 w-[3.75rem] flex-col items-center justify-center gap-0.5 rounded-lg border-transparent px-1 py-1 text-[0.625rem] leading-tight';
const camButton = 'flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs sm:px-3';

export interface OfficeHudProps {
  projectName: string;
  projects: readonly { projectId: string; displayName: string }[];
  projectId: string;
  onProject: (projectId: string) => void;
  session: WebProjectSession | undefined;
  model: OfficeModel | undefined;
  runs: readonly WebRunView[];
  connection: Connection;
  stale: boolean;
  /** Reads failed and there is no model: "failed", not "not available". */
  failed: boolean;
  /** The session cookie was refused: re-pairing is offered in the panel. */
  authRequired: boolean;
  mode: UiMode;
  onMode: (mode: UiMode) => void;
  panelOpen: boolean;
  immersive?: boolean;
  /** Optional stable compact status slot for the opt-in immersive presentation. */
  notifications?: ReactNode;
  /** Three-step onboarding and its persistent replay control. */
  firstVisit?: ReactNode;
  onCameraControl?: (action: 'left' | 'right' | 'up' | 'down' | 'zoom-in' | 'zoom-out') => void;
  /** Seatless Developers, for the "+n" chip. */
  overflow: number;
  onOverview: () => void;
  /** Opens the cabinet inspector (the Tài liệu button). */
  onDocuments: () => void;
  onNavigate: (path: '' | 'runs' | 'review' | 'chat' | 'agents' | 'settings') => void;
  onRefresh: () => void;
  onFocusZone: (zone: OfficeFocusZone) => void;
  onAgentList: () => void;
  /**
   * Director layout only (from the shared Director state): the chat bar follows the Director chat gate instead of the legacy v2
   * `chat_adapter_unavailable` blocker, and the pill shows the presence text. Absent for legacy v2 projects, which keep the old gate.
   */
  director?: { canSend: boolean; presenceLabel: string } | undefined;
  /** Opens the shared issue queue panel (the queue board); the rail offers it only while the model has a Director desk. */
  onQueue?: (() => void) | undefined;
  /** Receives the draft; the page that takes it over decides what happens. The HUD never sends anything. */
  onChatDraft: (draft: string) => void;
  /** The operations dock, rendered once at the bottom (collapsed behind a toggle until opened). */
  dock: ReactNode;
  /** Drives the dock toggle: shown when something is tracked or needs attention. */
  dockSummary: { count: number; attention: boolean };
  /** Set on the shell ancestor so the panel can stop above the dock on small screens. */
  onDockHeight?: (px: number) => void;
}

/**
 * The floating HUD of visual mode (reference layout). Pure presentation over data it is handed: it issues no requests. The root is
 * click-through; every control sits in an opaque-enough panel. While the panel is open on a phone only the dock stays, so nothing hides it.
 */
export function OfficeHud(p: OfficeHudProps) {
  const [draft, setDraft] = useState('');
  const [dockOpen, setDockOpen] = useState(false);
  const dockId = useId();
  const bottom = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  // The rail sits in the gap between the office card and the bottom controls, so a taller card or dock never overlaps it.
  const [railGap, setRailGap] = useState<{ top: number; bottom: number }>();
  const { onDockHeight } = p;
  useEffect(() => {
    const el = bottom.current;
    if (!el || !onDockHeight) return;
    const measure = (): void => onDockHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return () => onDockHeight(0);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => { observer.disconnect(); onDockHeight(0); };
  }, [onDockHeight]);
  useEffect(() => {
    const top = card.current, end = bottom.current;
    if (!top || !end || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => { if (top.offsetHeight > 0) setRailGap({ top: top.offsetTop + top.offsetHeight, bottom: end.offsetHeight }); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(top);
    observer.observe(end);
    return () => observer.disconnect();
  }, []);
  const run = currentRun(p.runs), counts = agentCounts(p.model), chat = p.director ? p.director.canSend : chatAvailable(p.session);
  const desk = p.model?.director !== undefined, queue = p.model?.queue;
  const pending = p.model?.pendingDecisions ?? 0;
  // Questions waiting in the Overview panel (intakes), and notes the owner should see (session and current run blockers).
  const clarifications = (p.session?.pendingIntakes ?? []).reduce((n, i) => n + i.clarifications.length, 0);
  const blockers = (p.session?.blockers.length ?? 0) + (run?.blockers.length ?? 0);
  const link = connectionText(p.connection, p.session?.state === 'stopped' || p.session?.state === 'unavailable');
  const warn = p.stale || p.authRequired || link.degraded || blockers > 0;
  const done = run ? run.tasks.filter(t => t.status === 'succeeded').length : 0;
  const hideOnPhone = p.panelOpen ? 'max-md:hidden' : '';
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const text = draft.trim();
    if (!chat || !text) return;
    setDraft('');
    p.onChatDraft(text);
  };
  const rail: [IconName, string, () => void, number?, string?][] = [
    ['overview', 'Tổng quan', p.onOverview, clarifications, 'Câu hỏi chờ trả lời: '], ['tasks', 'Công việc', () => p.onNavigate('runs')], ['decision', 'Quyết định', () => p.onNavigate('review'), pending, 'Đang chờ: '],
    ['chat', 'Trò chuyện', () => p.onNavigate('chat')],
    ...(desk && p.onQueue ? [['issues', 'Sự cố', p.onQueue, queue?.availability === 'ready' ? queue.open : undefined, 'Sự cố đang mở: '] as [IconName, string, () => void, number?, string?]] : []),
    ['agents', 'Nhân viên', () => p.onNavigate('agents')], ['docs', 'Tài liệu', p.onDocuments], ['settings', 'Cài đặt', () => p.onNavigate('settings')], ['refresh', 'Tải lại dữ liệu', p.onRefresh],
  ];
  const cams: [OfficeFocusZone, IconName, string][] = [['overview', 'all', 'Toàn cảnh'], ['conversation', 'chat', desk ? 'Director' : 'Trợ lý'], ['coordinator', 'coordinator', 'Điều phối'], ['developer', 'developer', 'Lập trình'], ['qa', 'qa', 'Kiểm tra']];
  return <>
    <div className={`pointer-events-none office-topbar absolute inset-x-4 top-4 ${hideOnPhone}`}>
      <section ref={card} aria-label="Văn phòng Bflow" className={`pointer-events-auto m-0 min-w-0 p-3 ${panel}`}>
        <h2 className="m-0 font-display text-xl leading-none font-extrabold tracking-wide text-ink">Bflow Office</h2>
        <select aria-label="Chuyển dự án" value={p.projectId} onChange={e => p.onProject(e.target.value)} className="mt-1 min-h-9 w-full truncate px-2 py-1 text-xs lg:min-h-8">
          {p.projects.some(x => x.projectId === p.projectId) ? null : <option value={p.projectId}>{p.projectName}</option>}
          {p.projects.map(x => <option key={x.projectId} value={x.projectId}>{x.displayName}</option>)}
          <option value="">Quản lý dự án…</option>
        </select>
        <div className="mt-2 border-t border-line pt-2">
          <p className="m-0 font-data text-[0.625rem] font-semibold tracking-[.14em] text-accent uppercase">Đang làm</p>
          {run ? <>
            <p className="m-0 mt-0.5 line-clamp-2 text-sm leading-snug font-semibold text-ink">{run.title}</p>
            <p className="m-0 mt-0.5 font-data text-xs text-muted">{phases[run.sdlcStatus] ?? 'Chưa xác định'}{run.tasks.length > 0 ? ` · ${done}/${run.tasks.length} việc đã xong` : ''}</p>
          </> : <p className="m-0 mt-0.5 font-data text-xs text-muted">Chưa có công việc đang chạy</p>}
        </div>
        <details aria-label="Trạng thái văn phòng" className="office-status mt-2 border-t border-line pt-1.5 font-data text-xs text-ink"><summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 text-xs"><span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${warn ? 'bg-warning' : 'bg-success'}`}/><span className="min-w-0 flex-1 truncate">Kết nối{p.stale?' · Dữ liệu cũ':p.authRequired?' · Cần ghép nối lại':link.degraded?' · Cần kiểm tra':''}</span><span aria-hidden="true" className="office-status-chevron text-muted">▾</span></summary><div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-1">
          <span>{p.session ? SESSION[p.session.state] ?? 'Phiên chưa rõ' : 'Đang đọc phiên'}</span>
          <span aria-hidden="true" className="text-line">|</span>
          <span role="status" className={link.degraded ? 'text-warning' : ''}>{link.label}</span>
          {p.director && <><span aria-hidden="true" className="text-line">|</span><span>{p.director.presenceLabel}</span></>}
          {counts.length > 0 && <><span aria-hidden="true" className="text-line">|</span><span>{counts.join(' · ')}</span></>}
          {p.model?.tier === 'degraded' && <><span aria-hidden="true" className="text-line">|</span><span className={p.failed ? 'text-warning' : 'text-muted'}>{p.failed ? 'Không đọc được dữ liệu nhân viên' : 'Chưa có dữ liệu nhân viên'}</span></>}
          {blockers > 0 && <span className="rounded border border-warning px-1.5 text-warning">{blockers} điểm cần lưu ý</span>}
          {p.authRequired && <span className="rounded border border-warning px-1.5 text-warning">Cần ghép nối lại</span>}
          {p.stale && <span className="rounded border border-warning px-1.5 text-warning">Dữ liệu cũ</span>}
        </div></details>
      </section>
      {p.immersive && p.notifications}
      {p.immersive && p.firstVisit}
      <ModeSwitch mode={p.mode} onChange={p.onMode} className="office-mode pointer-events-auto"/>
    </div>
    <nav aria-label="Lối tắt" style={railGap ? { top: railGap.top + 28, maxHeight: `calc(100% - ${railGap.top + railGap.bottom + 40}px)` } : undefined} className={`pointer-events-auto office-rail absolute flex flex-col gap-1 p-1 ${railGap ? 'office-rail-anchored' : ''} ${panel} ${hideOnPhone}`}>
      {rail.map(([icon, label, action, badge, badgeText]) => <button type="button" key={label} className={railButton} onClick={action}>
        <Icon name={icon}/><span className="text-center">{label}</span>
        {badge !== undefined && badge > 0 && <span className="absolute top-0.5 right-1.5 min-w-4 rounded-full bg-danger px-1 text-center text-[0.625rem] leading-4 font-semibold text-canvas"><span className="sr-only">{badgeText}</span>{badge}</span>}
      </button>)}
    </nav>
    <div ref={bottom} data-hud-bottom className={`absolute inset-x-3 bottom-0 flex flex-col gap-2 pb-3 ${p.panelOpen ? 'max-md:pb-0' : ''}`}>
      {(p.dockSummary.count > 0 || p.dockSummary.attention) && <button type="button" aria-expanded={dockOpen} aria-controls={dockId} onClick={() => setDockOpen(open => !open)} className={`pointer-events-auto self-start rounded-lg px-3 py-1.5 text-xs ${panel} ${p.dockSummary.attention ? 'border-warning text-warning' : ''}`}>Thao tác đã gửi ({p.dockSummary.count})</button>}
      {/* Live region that exists before the state changes, so a screen reader hears the dock needing a look while it stays collapsed. */}
      <span role="status" className="sr-only" data-testid="dock-attention">{p.dockSummary.attention ? 'Có thao tác cần xem trong Thao tác đã gửi' : ''}</span>
      <div id={dockId} hidden={!dockOpen} data-hud-dock className="pointer-events-auto max-h-[40dvh] overflow-y-auto empty:hidden">{p.dock}</div>
      <div className={`flex flex-col items-stretch gap-2 ${p.panelOpen ? '' : 'md:flex-row md:items-end'} ${hideOnPhone}`}>
        <div role="group" aria-label="Góc nhìn camera" className={`office-cameras pointer-events-auto flex flex-wrap gap-1 self-start p-1 ${panel}`}>
          {cams.map(([zone, icon, label]) => <button type="button" key={zone} aria-label={label} title={label} className={camButton} onClick={() => { if (zone === 'overview') setDockOpen(false); p.onFocusZone(zone); }}><Icon name={icon}/><span className="max-sm:hidden">{label}</span></button>)}
          {p.immersive&&<details className="relative"><summary className={`${camButton} cursor-pointer list-none ${panel}`} aria-label="Điều khiển camera">Camera</summary><div className={`absolute bottom-full left-0 z-30 mb-1 grid grid-cols-3 gap-1 p-1 ${panel}`}><span/><button type="button" aria-label="Di chuyển góc nhìn lên" onClick={()=>p.onCameraControl?.('up')}>↑</button><span/><button type="button" aria-label="Di chuyển góc nhìn sang trái" onClick={()=>p.onCameraControl?.('left')}>←</button><button type="button" aria-label="Thu nhỏ" onClick={()=>p.onCameraControl?.('zoom-out')}>−</button><button type="button" aria-label="Di chuyển góc nhìn sang phải" onClick={()=>p.onCameraControl?.('right')}>→</button><span/><button type="button" aria-label="Phóng to" onClick={()=>p.onCameraControl?.('zoom-in')}>+</button><span/><button type="button" aria-label="Di chuyển góc nhìn xuống" onClick={()=>p.onCameraControl?.('down')}>↓</button></div></details>}
          {p.overflow > 0 && <button type="button" className={`${camButton} text-accent`} aria-label={`Còn ${p.overflow} lập trình viên chưa hiện trong cảnh. Mở danh sách nhân viên`} title="Mở danh sách nhân viên" onClick={p.onAgentList}>+{p.overflow}</button>}
        </div>
        <form onSubmit={submit} className={`office-quick-chat pointer-events-auto m-0 flex min-w-0 flex-1 items-center gap-2 py-1 pr-1 pl-3 md:mx-auto md:w-full md:max-w-xl ${panel}`}>
          <Icon name="chat"/>
          <input aria-label="Trò chuyện với Bflow" placeholder={chat ? (p.director ? 'Trò chuyện với Director…' : 'Trò chuyện với Bflow...') : 'Chưa trò chuyện được lúc này'} disabled={!chat} value={draft} onChange={e => setDraft(e.target.value)} className="min-w-0 flex-1 rounded-none border-0 bg-transparent px-1 text-sm"/>
          <button type="submit" disabled={!chat || !draft.trim()} aria-label="Mở trò chuyện với nội dung này" title="Mở trò chuyện (chưa gửi)" className="shrink-0 rounded-lg border-transparent px-2.5"><Icon name="send"/></button>
        </form>
      </div>
    </div>
  </>;
}
