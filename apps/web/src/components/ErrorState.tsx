import { explain } from '../api/client';
export function ErrorState({error,retry,stale=false}:{error:unknown;retry:()=>void;stale?:boolean}) {
  return <section className="my-4 border border-line border-l-3 border-l-danger bg-surface p-4" role="alert"><h2>Chưa tải được dữ liệu</h2><p>{explain(error)}</p>{stale && <p>Dữ liệu bên dưới đã cũ. Chỉ tham khảo cho đến khi tải lại thành công.</p>}<button onClick={retry}>Thử tải lại</button></section>;
}
