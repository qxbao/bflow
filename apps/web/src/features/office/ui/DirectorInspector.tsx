import { DirectorPresenceStatus } from '../../director/status';

/**
 * The Director desk inspector (3D). Read-only: presence comes from the shared Director view (host heartbeat, never a Herdr pane), and the
 * buttons only navigate to the shared Classic chat and issue queue, which own every write.
 */
export function DirectorInspector({ onChat, onQueue }: { onChat: () => void; onQueue: () => void }) {
  return <section aria-label="Bàn Director" data-component="DirectorDesk" className="min-w-0">
    <h2 className="mt-0">Bàn Director</h2>
    <DirectorPresenceStatus />
    <p className="text-sm text-muted">Director chạy trực tiếp từ phiên làm việc của bạn để điều phối tiến độ. Trạng thái hiển thị dựa trên nhịp kết nối thực tế của phiên.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={onChat}>Mở trò chuyện với Director</button>
      <button type="button" onClick={onQueue}>Mở hàng đợi sự cố</button>
    </div>
  </section>;
}
