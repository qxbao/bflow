import type { EnvironmentDoctorReport } from "@bflow/contracts";
import {
  bold,
  cyan,
  dim,
  green,
  greenTick,
  humanText,
  readableLabel,
  red,
  sanitizeIdentifier,
  yellow
} from "./presentation.js";

export interface DoctorFormatOptions {
  readonly color?: boolean | undefined;
  readonly debug?: boolean | undefined;
}

interface Check {
  id: string;
  name: string;
  group: string;
  status: "passed" | "failed" | "warn" | "skipped" | "unknown";
  reason: string;
  remediation: string;
  repair: string;
  version: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? humanText(value, 350) : "");

function status(value: unknown): Check["status"] {
  return value === "pass" || value === "passed"
    ? "passed"
    : value === "fail" || value === "failed"
    ? "failed"
    : value === "warn" || value === "warning"
    ? "warn"
    : value === "skipped"
    ? "skipped"
    : "unknown";
}

function formatCheckTag(checkStatus: Check["status"], useColor: boolean): string {
  const rawTag =
    checkStatus === "failed"
      ? "LỖI"
      : checkStatus === "warn"
      ? "CẢNH BÁO"
      : checkStatus === "skipped"
      ? "BỎ QUA"
      : "KHÔNG RÕ";
  if (!useColor) return rawTag;
  if (checkStatus === "failed") return red(rawTag, true);
  if (checkStatus === "warn") return yellow(rawTag, true);
  return dim(rawTag, true);
}

/** One human report: detailed groups enrich flat checks instead of printing them twice. */
export function formatDoctorReport(
  report: EnvironmentDoctorReport,
  options?: boolean | DoctorFormatOptions | undefined,
  debugArg?: boolean | undefined
): string {
  const useColor = typeof options === "boolean" ? options : Boolean(options?.color);
  const debug =
    typeof options === "object" && options !== null
      ? Boolean(options.debug)
      : Boolean(debugArg);

  const groupedById = new Map<string, Check>();
  const groupItems = new Map<string, Check[]>();

  const raw = report.metadata?.["groups"];
  const groups: [string, unknown][] = Array.isArray(raw)
    ? raw.map((value, index) => {
        const group = record(value);
        return [
          text(group.group ?? group.name ?? group.title) || `Group ${index + 1}`,
          group.items ?? group.checks ?? [group]
        ];
      })
    : Object.entries(record(raw));

  for (const [groupKey, values] of groups) {
    const safeGroupName = readableLabel(groupKey) || sanitizeIdentifier(groupKey);
    if (!groupItems.has(safeGroupName)) {
      groupItems.set(safeGroupName, []);
    }
    const list = groupItems.get(safeGroupName)!;
    for (const value of Array.isArray(values) ? values : [values]) {
      const item = record(value);
      if (!Object.keys(item).length) continue;
      const name =
        text(item.component ?? item.name ?? item.toolId ?? item.checkId) ||
        "Unknown check";
      const id = text(item.checkId) || `${groupKey}:${name}`;
      const check: Check = {
        id,
        name,
        group: safeGroupName,
        status: status(item.status),
        reason: text(item.reason ?? item.message),
        remediation: text(item.remediation),
        repair: text(item.repair_command ?? item.repairCommand),
        version: text(item.detected_version ?? item.version)
      };
      groupedById.set(id, check);
      list.push(check);
    }
  }

  const basicChecks: Check[] = [];
  for (const flat of report.checks) {
    const id = flat.checkId || flat.name;
    const detailed = groupedById.get(id);
    if (detailed) {
      const flatStatus = status(flat.status);
      // An inconsistent legacy/detailed pair must not hide a failure or a warning.
      if (
        flatStatus === "failed" ||
        (flatStatus === "warn" && detailed.status !== "failed")
      ) {
        detailed.status = flatStatus;
      }
      if (!detailed.reason) detailed.reason = text(flat.message);
      else if (text(flat.message) && text(flat.message) !== detailed.reason) {
        detailed.reason += `; ${text(flat.message)}`;
      }
      if (!detailed.remediation) detailed.remediation = text(flat.remediation);
    } else {
      basicChecks.push({
        id: text(id),
        name: text(flat.name || flat.checkId),
        group: "Checks",
        status: status(flat.status),
        reason: text(flat.message),
        remediation: text(flat.remediation),
        repair: "",
        version: ""
      });
    }
  }

  const all = [...basicChecks, ...groupedById.values()];
  const failed = all.filter((check) => check.status === "failed").length;
  const unknown = all.filter((check) => check.status === "unknown").length;
  const healthy = Boolean(report.healthy) && failed === 0 && unknown === 0;

  const headerTitle = healthy
    ? useColor
      ? green(bold("✓ [KHỎE MẠNH] Hệ thống hoạt động tốt"), true)
      : "✓ [KHỎE MẠNH] Hệ thống hoạt động tốt"
    : useColor
    ? red(bold("✗ [CẦN XỬ LÝ] Phát hiện vấn đề trong môi trường"), true)
    : "✗ [CẦN XỬ LÝ] Phát hiện vấn đề trong môi trường";

  const lines: string[] = [
    `${headerTitle}${healthy ? ` ${greenTick(useColor)}` : ""}`,
    `Kho mã nguồn: ${sanitizeIdentifier(report.workspaceRoot)}`
  ];

  if (debug) {
    if (report.sessionId) {
      lines.push(`Phiên:        ${sanitizeIdentifier(report.sessionId)}`);
    }
    if (report.checkedAt) {
      lines.push(`Kiểm tra lúc: ${sanitizeIdentifier(report.checkedAt)}`);
    }
  }

  if (basicChecks.length > 0) {
    const basicNonPassed = basicChecks.filter((c) => c.status !== "passed");
    const basicPassed = basicChecks.filter((c) => c.status === "passed");
    lines.push("");
    for (const check of basicNonPassed) {
      const tag = formatCheckTag(check.status, useColor);
      const identity =
        check.status === "skipped" && check.id !== check.name
          ? `${check.name} (${check.id})`
          : check.name;
      lines.push(
        `  - [${tag}] ${identity}${check.reason ? `: ${check.reason}` : ""}`
      );
      if (check.remediation) {
        lines.push(
          `      ${useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:"} ${check.remediation}`
        );
      }
      if (check.repair) {
        lines.push(
          `      ${useColor ? cyan(bold("🔧 Sửa chữa:"), true) : "🔧 Sửa chữa:"} ${check.repair}`
        );
      }
    }
    if (basicPassed.length > 0) {
      if (debug) {
        const names = basicPassed.map((c) => c.name).join(", ");
        lines.push(
          `  Đạt (${basicPassed.length}/${basicChecks.length}): ${names} ${greenTick(useColor)}`
        );
      } else {
        lines.push(
          `  • Kiểm tra cơ bản: Đạt (${basicPassed.length}/${basicChecks.length}) ${greenTick(useColor)}`
        );
      }
    }
  }

  if (groupItems.size > 0) {
    lines.push("", "Nhóm thành phần:");
    for (const [safeGroupName, items] of groupItems.entries()) {
      if (items.length === 0) continue;
      const nonPassed = items.filter((item) => item.status !== "passed");
      const passedItems = items.filter((item) => item.status === "passed");
      const groupBracket = `[${useColor ? cyan(safeGroupName, true) : safeGroupName}]`;

      if (!debug && nonPassed.length === 0) {
        lines.push(
          `  • ${groupBracket} Đạt (${passedItems.length}/${items.length}) ${greenTick(useColor)}`
        );
        continue;
      }

      lines.push("", `  ${groupBracket}`);
      for (const check of nonPassed) {
        const tag = formatCheckTag(check.status, useColor);
        const identity =
          check.status === "skipped" && check.id !== check.name
            ? `${check.name} (${check.id})`
            : check.name;
        const ver = debug && check.version ? ` (v${check.version})` : "";
        lines.push(
          `    - [${tag}] ${identity}${ver}${check.reason ? `: ${check.reason}` : ""}`
        );
        if (check.remediation) {
          lines.push(
            `        ${useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:"} ${check.remediation}`
          );
        }
        if (check.repair) {
          lines.push(
            `        ${useColor ? cyan(bold("🔧 Sửa chữa:"), true) : "🔧 Sửa chữa:"} ${check.repair}`
          );
        }
      }

      if (passedItems.length > 0) {
        if (debug) {
          for (const check of passedItems) {
            const ver = check.version ? ` (v${check.version})` : "";
            lines.push(
              `    - [${useColor ? green("ĐẠT", true) : "ĐẠT"}] ${check.name}${ver}${check.reason ? `: ${check.reason}` : ""} ${greenTick(useColor)}`
            );
          }
        } else {
          const names = passedItems.map((item) => item.name);
          const preview = `${names.slice(0, 8).join(", ")}${
            names.length > 8 ? `, +${names.length - 8} mục khác` : ""
          }`;
          lines.push(
            `    Đạt (${passedItems.length}): ${preview} ${greenTick(useColor)}`
          );
        }
      }
    }
  }

  if (!healthy && !all.some((check) => check.remediation || check.repair)) {
    lines.push(
      "",
      `${useColor ? cyan(bold("👉 Tiếp theo:"), true) : "👉 Tiếp theo:"} Chạy 'bflow doctor --json' hoặc 'bflow doctor --debug' để xem toàn bộ báo cáo chẩn đoán.`
    );
  }
  lines.push("", "Báo cáo đầy đủ: bflow doctor --json");
  return lines.join("\n");
}
