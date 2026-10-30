import { ApiError, explain } from '../api/client';
export function ErrorState({error,retry,stale=false}:{error:unknown;retry:()=>void;stale?:boolean}) {
  return <section className="my-4 border border-line border-l-3 border-l-danger bg-surface p-4" role="alert"><h2>Chưa tải được dữ liệu</h2><p>{explain(error)}</p>{error instanceof ApiError && error.code==='unavailable' && <p className="text-sm text-muted">Đây là lỗi đọc dữ liệu: phiên và công việc có thể vẫn đang chạy. Dữ liệu chưa đọc được không có nghĩa là trống.</p>}{stale && <p>Dữ liệu bên dưới đã cũ. Chỉ tham khảo cho đến khi tải lại thành công.</p>}<button onClick={retry}>Thử tải lại</button></section>;
}
