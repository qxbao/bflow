/** Vietnamese role labels; same wording as project-configuration roleLabels (not importable: that module is React). */
export const ROLE_LABELS: Readonly<Record<string, string>> = {
  conversation: 'Trợ lý tiếp nhận', coordinator: 'Điều phối viên', planner: 'Lập kế hoạch', architect: 'Kiến trúc sư',
  specifier: 'Đặc tả', developer: 'Lập trình viên', tester: 'Kiểm thử', reviewer: 'Kiểm duyệt mã', qa: 'Kiểm thử QA', security: 'Bảo mật'
};
export const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;
