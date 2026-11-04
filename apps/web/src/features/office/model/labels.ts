/** Vietnamese role labels; same wording as project-configuration roleLabels (not importable: that module is React). */
export const ROLE_LABELS: Readonly<Record<string, string>> = {
  conversation: 'Trợ lý tiếp nhận', coordinator: 'Điều phối viên', planner: 'Lập kế hoạch', architect: 'Kiến trúc sư',
  specifier: 'Đặc tả', developer: 'Lập trình viên', tester: 'Kiểm thử', reviewer: 'Kiểm duyệt mã', qa: 'Kiểm thử QA', security: 'Bảo mật'
};
export const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

const SHORT_STATUS: Readonly<Record<string, string>> = {
  working: 'Đang làm', typing: 'Đang làm', preparing: 'Chuẩn bị', hand_raised: 'Chờ bạn', question: 'Chưa rõ việc', sleeping: 'Rảnh', disconnected: 'Mất kết nối', ghost: 'Chưa rõ',
};
export const shortStatus = (pose: string): string => SHORT_STATUS[pose] ?? 'Chưa rõ';
/** The tag drawn over a character: "Dev #1 · Đang làm". Text only. */
export const agentTag = (label: string, pose: string): string => `${label.replace(/^Developer/, 'Dev')} · ${shortStatus(pose)}`;
/** The extra in-scene label a pose gets: a message box while the agent works, a Zzz while it sleeps. */
export const poseLabel = (pose: string): 'bubble' | 'sleep' | undefined => (pose === 'working' || pose === 'typing' || pose === 'preparing' ? 'bubble' : pose === 'sleeping' ? 'sleep' : undefined);

/** The Director desk tag: "Director · Hoạt động". `unknown` is a failed read, spelled differently from a confirmed absence. */
const DIRECTOR_SHORT: Readonly<Record<string, string>> = { active: 'Hoạt động', waiting: 'Đang chờ', absent: 'Vắng mặt', unknown: 'Chưa rõ' };
export const directorTag = (presence: string): string => `Director · ${DIRECTOR_SHORT[presence] ?? 'Chưa rõ'}`;
/** Longer Director status for the mirror and inspector. */
export const DIRECTOR_STATUS: Readonly<Record<string, string>> = { active: 'Đang hoạt động', waiting: 'Đang chờ tin của bạn', absent: 'Chưa có mặt', unknown: 'Chưa xác định' };
/** The queue board text: open and retrying counts, or that the queue could not be read. */
export function queueText(queue: { availability: string; open: number; retrying: number; truncated: boolean } | undefined): string {
  if (!queue || queue.availability !== 'ready') return 'chưa đọc được';
  const plus = queue.truncated ? '+' : '';
  const parts = [`${queue.open}${plus} đang mở`, ...(queue.retrying > 0 ? [`${queue.retrying}${plus} đang thử lại`] : [])];
  return parts.join(', ');
}
