import type { ReactNode } from 'react';
import type { WebProjectSession } from '@bflow/contracts/web';
import type { Connection } from '../../../../api/events';
import { connectionText } from '../../../../components/ConnectionBanner';
import type { OfficeModel } from '../../model/types';

const SESSION: Readonly<Record<string, string>> = { ready: 'Phiên sẵn sàng', starting: 'Phiên đang khởi động', stopping: 'Phiên đang dừng', stopped: 'Phiên đã dừng', unavailable: 'Phiên chưa sẵn sàng' };

/** Stable, non-announcing notice slot derived only from the existing session and office model. */
export function OfficeNotifications({ connection, session, stale, authRequired, model, onInbox, onClarifications, onServer, onDirector, onQueue }: {
  connection: Connection; session: WebProjectSession | undefined; stale: boolean; authRequired: boolean;
  model: OfficeModel | undefined; onInbox: () => void; onClarifications: () => void;
  onServer?: () => void; onDirector?: () => void; onQueue?: () => void;
}) {
  const link = connectionText(connection, session?.state === 'stopped' || session?.state === 'unavailable');
  const pending = model?.pendingDecisions ?? 0;
  const openIssues = model?.queue?.availability === 'ready' ? model.queue.open : 0;
  const intake = (session?.pendingIntakes ?? []).reduce((count, item) => count + item.clarifications.length, 0);
  const notices: ReactNode[] = [];
  if (authRequired) notices.push(<span key="auth" className="text-warning">Cần ghép nối lại</span>);
  if (stale) notices.push(<span key="stale" className="text-warning">Dữ liệu đang hiển thị có thể đã cũ</span>);
  if (link.degraded) notices.push(<span key="connection" className="text-warning">{link.label}</span>);
  if (session && session.state !== 'ready' && onServer) notices.push(<button key="server" type="button" className="min-h-9 px-2 py-1 text-xs" onClick={onServer}>Phiên đang dừng · Mở máy chủ phiên</button>);
  if (session?.state === 'ready' && model?.director?.presence === 'absent' && onDirector) notices.push(<button key="director" type="button" className="min-h-9 px-2 py-1 text-xs" onClick={onDirector}>Director chưa có mặt · Mở bàn Director</button>);
  if (openIssues > 0 && onQueue) notices.push(<button key="queue" type="button" className="min-h-9 px-2 py-1 text-xs" onClick={onQueue}>{openIssues} sự cố đang mở · Xem hàng đợi</button>);
  if (pending > 0) notices.push(<button key="pending" type="button" className="min-h-9 px-2 py-1 text-xs" onClick={onInbox}>{pending} yêu cầu cần bạn trả lời · Mở hộp thư</button>);
  if (intake > 0) notices.push(<button key="intake" type="button" className="min-h-9 px-2 py-1 text-xs" onClick={onClarifications}>{intake} câu hỏi đang chờ · Mở tổng quan</button>);
  if (notices.length === 0) notices.push(<span key="ok" className="text-muted">{session ? SESSION[session.state] ?? 'Trạng thái phiên chưa rõ' : 'Đang đọc trạng thái phiên'}</span>);
  return <section aria-label="Thông báo văn phòng" data-component="OfficeNotifications" className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface/90 px-3 py-1.5 text-xs backdrop-blur-md">
    {notices}
  </section>;
}
