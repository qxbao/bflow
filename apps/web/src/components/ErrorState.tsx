import { useId, useState, type FormEvent } from 'react';
import { ApiError, explain } from '../api/client';
import { FieldLabel } from './FieldHelp';

export function extractBootstrapSecret(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/(?:^|[#?&])bootstrap=([^&#\s]+)/);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return trimmed;
}

export function ErrorState({
  error,
  retry,
  stale = false,
  onPair,
}: {
  error: unknown;
  retry: () => void;
  stale?: boolean;
  onPair?: ((secret: string) => Promise<void> | void) | undefined;
}) {
  const pairId = useId();
  const [token, setToken] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairFeedback, setPairFeedback] = useState('');
  const canPair = Boolean(onPair && error instanceof ApiError && ['session_required', 'forbidden'].includes(error.code));

  async function submitPair(event: FormEvent) {
    event.preventDefault();
    const secret = extractBootstrapSecret(token);
    if (!secret || !onPair || pairing) return;
    setToken('');
    setPairFeedback('');
    setPairing(true);
    try {
      await onPair(secret);
    } catch {
      setPairFeedback('Mã ghép nối không hợp lệ, đã được dùng một lần hoặc đã quá hạn 60 giây. Chạy lại bflow web trên terminal để lấy liên kết mới.');
    } finally {
      setPairing(false);
    }
  }

  return (
    <section data-component="ErrorState" className="my-4 border border-line border-l-3 border-l-danger bg-surface p-4" role="alert">
      <h2>Chưa tải được dữ liệu</h2>
      <p>{explain(error)}</p>
      {error instanceof ApiError && error.code === 'unavailable' && (
        <p className="text-sm text-muted">
          Đây là lỗi đọc dữ liệu: phiên và công việc có thể vẫn đang chạy. Dữ liệu chưa đọc được không có nghĩa là trống.
        </p>
      )}
      {stale && <p>Dữ liệu bên dưới đã cũ. Chỉ tham khảo cho đến khi tải lại thành công.</p>}
      {canPair && (
        <form onSubmit={e => void submitPair(e)} className="my-3 border border-line bg-canvas p-3">
          <p className="mt-0 mb-2 text-sm text-muted">
            Chạy lệnh <code className="font-mono text-xs text-ink">bflow web</code> trên terminal để mở lại, hoặc dán liên kết ghép nối vào đây để tiếp tục ngay tại trang này:
          </p>
          <FieldLabel
            htmlFor={pairId}
            label="Mã hoặc đường dẫn ghép nối (#bootstrap=...)"
            help="Dán toàn bộ liên kết http://127.0.0.1:PORT/#bootstrap=... hiển thị trên terminal khi chạy bflow web (hoặc chỉ phần mã sau dấu =). Mỗi mã có hiệu lực 60 giây, chỉ dùng một lần để tạo phiên cookie an toàn và không lưu vào bộ nhớ trình duyệt."
            example="Ví dụ: http://127.0.0.1:4317/#bootstrap=..."
          />
          <div className="flex flex-col gap-2 sm:flex-row [&_input]:min-w-0 [&_input]:flex-1 [&_button]:shrink-0">
            <input
              id={pairId}
              type="password"
              autoComplete="off"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="http://127.0.0.1:4317/#bootstrap=..."
            />
            <button
              type="submit"
              disabled={pairing || !token.trim()}
              className="border-ink bg-brand font-semibold text-on-brand hover:bg-ink hover:text-surface"
            >
              {pairing ? 'Đang ghép nối…' : 'Ghép nối lại'}
            </button>
          </div>
          {pairFeedback && <p role="status" className="mt-2 mb-0 text-xs text-danger">{pairFeedback}</p>}
        </form>
      )}
      <button type="button" onClick={retry}>
        Thử tải lại
      </button>
    </section>
  );
}
