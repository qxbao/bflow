import type { Connection } from '../api/events';
const text:Record<Connection,string> = {connecting:'Trình duyệt: đang kết nối cập nhật.',connected:'Trình duyệt: đã kết nối cập nhật.',reconnecting:'Trình duyệt: đang kết nối lại. Dữ liệu đang xem có thể đã cũ.',offline:'Trình duyệt: mất kết nối. Đang giữ dữ liệu cũ để bạn tham khảo.'};
export function ConnectionBanner({state}:{state:Connection}) { return <div className={`connection ${state==='connected'?'':'stale'}`} role="status" aria-atomic="true">{text[state]}</div>; }
