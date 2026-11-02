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
