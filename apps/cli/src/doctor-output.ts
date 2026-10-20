import type { EnvironmentDoctorReport } from "@bflow/contracts";
import { bold, cyan, green, humanText, readableLabel, red, yellow } from "./presentation.js";

interface Check {
  id: string;
  name: string;
  group: string;
  status: "passed" | "failed" | "warn" | "skipped" | "unknown";
  reason: string;
  remediation: string;
  repair: string;
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? humanText(value, 350) : "";
function status(value: unknown): Check["status"] {
  return value === "pass" || value === "passed" ? "passed" : value === "fail" || value === "failed" ? "failed"
    : value === "warn" || value === "warning" ? "warn" : value === "skipped" ? "skipped" : "unknown";
}

/** One human report: detailed groups enrich flat checks instead of printing them twice. */
export function formatDoctorReport(report: EnvironmentDoctorReport, color = false): string {
  const checks = new Map<string, Check>();
  const raw = report.metadata?.["groups"];
  const groups: [string, unknown][] = Array.isArray(raw) ? raw.map((value, index) => {
    const group = record(value);
    return [text(group.group ?? group.name ?? group.title) || `Group ${index + 1}`, group.items ?? group.checks ?? [group]];
  }) : Object.entries(record(raw));
  for (const [group, values] of groups) for (const value of Array.isArray(values) ? values : [values]) {
    const item = record(value);
    if (!Object.keys(item).length) continue;
    const name = text(item.component ?? item.name ?? item.toolId ?? item.checkId) || "Unknown check";
    const id = text(item.checkId) || `${group}:${name}`;
    checks.set(id, { id, name, group: readableLabel(group), status: status(item.status),
      reason: text(item.reason ?? item.message), remediation: text(item.remediation), repair: text(item.repair_command ?? item.repairCommand) });
  }
  for (const flat of report.checks) {
    const id = flat.checkId || flat.name;
    const detailed = checks.get(id);
    if (detailed) {
      const flatStatus = status(flat.status);
      // An inconsistent legacy/detailed pair must not hide a failure or a warning.
      if (flatStatus === "failed" || flatStatus === "warn" && detailed.status !== "failed") detailed.status = flatStatus;
      if (!detailed.reason) detailed.reason = text(flat.message);
      else if (text(flat.message) && text(flat.message) !== detailed.reason) detailed.reason += `; ${text(flat.message)}`;
      if (!detailed.remediation) detailed.remediation = text(flat.remediation);
    } else checks.set(id, { id, name: text(flat.name), group: groups.length ? "Other checks" : "Checks", status: status(flat.status),
      reason: text(flat.message), remediation: text(flat.remediation), repair: "" });
  }
  const all = [...checks.values()];
  const passed = all.filter(check => check.status === "passed").length;
  const failed = all.filter(check => check.status === "failed").length;
  const warnings = all.filter(check => check.status === "warn").length;
  const skipped = all.filter(check => check.status === "skipped").length;
  const unknown = all.filter(check => check.status === "unknown").length;
  const healthy = report.healthy && !failed && !unknown;
  const mark = healthy ? "[OK]" : "[FAIL]";
  const headline = healthy ? `Environment healthy (${passed} passed${warnings ? `, ${warnings} warning(s)` : ""})`
    : `Environment unhealthy (${failed} check(s) failed, ${passed} passed${warnings ? `, ${warnings} warning(s)` : ""}${unknown ? `, ${unknown} unknown` : ""})`;
  const lines = [`${color ? (healthy ? green : red)(bold(mark), true) : mark} ${headline}${skipped ? `, ${skipped} skipped` : ""}`,
    `Repository: ${text(report.workspaceRoot)}`, ...(report.sessionId ? [`Session:    ${text(report.sessionId)}`] : []), "", "Component Groups:"];
  for (const group of new Set(all.map(check => check.group))) {
    const items = all.filter(check => check.group === group);
    lines.push("", `[${color ? cyan(group, true) : group}]`);
    for (const check of items.filter(item => !["passed", "skipped"].includes(item.status))) {
      const tag = check.status === "failed" ? "FAIL" : check.status === "warn" ? "WARN" : "UNKNOWN";
      lines.push(`  - [${color ? (check.status === "failed" ? red : yellow)(tag, true) : tag}] ${check.name}${check.reason ? `: ${check.reason}` : ""}`);
      if (check.remediation) lines.push(`      Next: ${check.remediation}`);
      if (check.repair) lines.push(`      Repair: ${check.repair}`);
    }
    for (const kind of ["passed", "skipped"] as const) {
      const names = items.filter(item => item.status === kind).map(item => item.name);
      if (names.length) lines.push(`  ${kind === "passed" ? "Passed" : "Skipped"} (${names.length}): ${names.slice(0, 8).join(", ")}${names.length > 8 ? `, +${names.length - 8} more` : ""}`);
    }
  }
  if (!healthy && !all.some(check => check.remediation || check.repair)) lines.push("", "Next: Run 'bflow doctor --json' to inspect the full diagnostic report.");
  lines.push("", "Full report: bflow doctor --json");
  return lines.join("\n");
}
