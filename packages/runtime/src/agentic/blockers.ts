import type { JsonValue } from "@bflow/contracts";

export type BlockerFixableBy = "developer" | "director" | "user" | "environment" | "runtime";

export const BLOCKERS = {
  declared_test_missing: { fixableBy: "director",
    nextAction: "Kế hoạch khai tệp test chưa có trong commit. Resume không sửa được: hoặc giao Developer viết đúng các tệp đó, hoặc thu hẹp phạm vi test." },
  runner_identity_unselectable: { fixableBy: "director",
    nextAction: "Không gắn được tên test của tiêu chí vào đúng một runner. Sửa criterionMappings hoặc tách tiêu chí." },
  no_test_identities: { fixableBy: "director",
    nextAction: "Task không có danh tính test nào khớp runner. Kiểm criterionMappings, đường dẫn test và ownership." },
  runner_infrastructure: { fixableBy: "environment",
    nextAction: "Hạ tầng runner (bước prepare, sandbox hoặc gọi lệnh) lỗi, không phải lỗi mã hay kế hoạch. Sửa môi trường máy theo thông điệp lỗi (sandbox Bubblewrap/Seatbelt, toolchain, dependency, lệnh prepare), rồi resume để đo lại cùng revision." },
} as const satisfies Record<string, { fixableBy: BlockerFixableBy; nextAction: string }>;

export type BlockerCode = keyof typeof BLOCKERS;

export class TaskBlocker extends Error {
  readonly fixableBy: BlockerFixableBy;
  readonly nextAction: string;

  constructor(readonly code: BlockerCode, message: string, readonly details: Readonly<Record<string, JsonValue>> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = `TaskBlocker[${code}]`;
    this.fixableBy = BLOCKERS[code].fixableBy;
    this.nextAction = BLOCKERS[code].nextAction;
  }
}

export function blockerOf(error: unknown): TaskBlocker | undefined {
  return error instanceof TaskBlocker ? error : undefined;
}

export function isResumable(blocker: { fixableBy: BlockerFixableBy }): boolean {
  return blocker.fixableBy === "environment" || blocker.fixableBy === "runtime";
}
