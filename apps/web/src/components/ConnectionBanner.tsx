import type { Connection } from '../api/events';
const text:Record<Connection,string> = {
  connecting:'Đang kết nối cập nhật trực tiếp…',
  connected:'Trực tiếp: đã kết nối',
  reconnecting:'Trình duyệt: đang kết nối lại. Dữ liệu đang xem có thể đã cũ.',
  offline:'Trình duyệt: mất kết nối. Đang giữ dữ liệu cũ để bạn tham khảo.',
};
export function ConnectionBanner({state,inactive=false}:{state:Connection;inactive?:boolean}) {
  const waitingForSession=inactive && state==='reconnecting';
  const degraded=!waitingForSession && (state==='reconnecting'||state==='offline');
  const label=waitingForSession?'Cập nhật trực tiếp: chờ khởi động phiên':text[state];
  return <div className={`inline-flex min-h-7 items-center border-l-2 px-2.5 py-0.5 font-data text-xs leading-5 ${degraded?'border-warning bg-faint text-warning':state==='connected'?'border-success text-muted':'border-line text-muted'}`} role="status" aria-atomic="true">{label}</div>;
}
