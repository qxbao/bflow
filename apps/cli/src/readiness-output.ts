interface ReadinessCheck {
  name: string;
  code: string;
  message: string;
  remediation: string;
}

interface BlockedRole {
  role: string;
  provider: string;
  optional: boolean;
  status: string;
  messages: string[];
  checks: ReadinessCheck[];
}

/** Keep cleanup outcomes visible even when distinct causes exceed the display budget. */
export function boundReadinessReport(message: string): string {
  const lines = message.split("\n");
  if (lines.length <= 256 && message.length <= 64_000) return message;
  const notice = "... [đã rút gọn (truncated); dùng --json để xem toàn bộ báo cáo lỗi]";
  const cleanup = lines.filter(line => line.startsWith("Automatic cleanup ") || line.startsWith("Tự động dọn dẹp ")).slice(-16);
  const footer = cleanup.length ? "\n\n" + cleanup.join("\n").slice(0, 8192) : "";
  const content = lines.filter(line => !line.startsWith("Automatic cleanup ") && !line.startsWith("Tự động dọn dẹp "));
  const body = content.slice(0, 255 - (footer ? cleanup.length + 1 : 0)).join("\n")
    .slice(0, 64_000 - notice.length - footer.length - 1).trimEnd();
  return `${body}\n${notice}${footer}`;
}

/** Human-only view of the CLI-authored report. Unknown layouts retain their original text. */
export function summarizeReadinessReport(message: string): string | undefined {
  const roles: BlockedRole[] = [];
  const cleanup: string[] = [];
  let current: BlockedRole | undefined;
  for (const line of message.split("\n").slice(1)) {
    if (!line.trim() || line === "Blocked roles:") continue;
    const role = /^  - ([\w-]+) \[([\w-]+)\]( \(optional\))?: ([\w-]+)$/.exec(line);
    if (role) {
      current = { role: role[1]!, provider: role[2]!, optional: !!role[3], status: role[4]!, messages: [], checks: [] };
      roles.push(current);
      continue;
    }
    const check = /^      ([\w-]+) \(([\w.-]+)\): (.*)$/.exec(line);
    if (check && current) {
      const text = check[3]!;
      const split = text.lastIndexOf(" Remediation: ");
      current.checks.push({ name: check[1]!, code: check[2]!,
        message: split < 0 ? text : text.slice(0, split), remediation: split < 0 ? "" : text.slice(split + " Remediation: ".length) });
    } else if (line.startsWith("      ") && current) {
      current.messages.push(line.trim());
    } else if (line.startsWith("Automatic cleanup ") || line.startsWith("Tự động dọn dẹp ")) {
      cleanup.push(line);
      current = undefined;
    } else return undefined;
  }
  if (!roles.length) return undefined;

  const groups = new Map<string, { provider: string; code: string; cause: string; remediation: string; roles: Set<string>; checks: Set<string> }>();
  for (const role of roles) {
    const summary = role.checks.map(check => `${check.name}:${check.code}`).join(", ");
    // Only discard the exact generated summary; preserve additional role-specific context.
    const messages = role.messages.filter(message => !["preflight", "activated"].some(stage =>
      message === `Provider ${role.provider} ${stage} health is ${role.status} (${summary})`));
    const checks = [...role.checks, ...messages.map(message => ({ name: "", code: "", message, remediation: "" }))];
    if (!checks.length) return undefined;
    const flags = [...(role.optional ? ["tùy chọn"] : []), ...(role.status !== "blocked" ? [role.status] : [])];
    const label = role.role + (flags.length ? ` (${flags.join(", ")})` : "");
    for (const check of checks) {
      const cause = check.message
        .replace(/^Provider execution probe was skipped because inherited state is blocked: /, "")
        .replace(/^Global Codex hook configuration cannot be safely reviewed: /, "");
      const key = JSON.stringify([role.provider, check.code, cause, check.remediation]);
      let group = groups.get(key);
      if (!group) {
        group = { provider: role.provider, code: check.code, cause, remediation: check.remediation, roles: new Set(), checks: new Set() };
        groups.set(key, group);
      }
      group.roles.add(label);
      if (check.name) group.checks.add(check.name.replace(/_/g, " "));
    }
  }

  const lines = ["Khởi động bị chặn. Chưa có khung pane nào được mở."];
  for (const group of groups.values()) {
    const plugin = group.code.startsWith("codex_global_hooks_")
      ? /^Cannot inspect enabled plugin ([^:]+): (.+)$/.exec(group.cause) : null;
    lines.push("", `${group.provider}: ${plugin ? plugin[2] : group.cause}`);
    if (plugin) lines.push(`  Plugin: ${plugin[1]}`);
    lines.push(`  Vai trò bị ảnh hưởng (${group.roles.size}): ${[...group.roles].join(", ")}`);
    if (group.checks.size) lines.push(`  Kiểm tra bị chặn: ${[...group.checks].join(", ")}`);
    if (group.code) lines.push(`  Mã lỗi: ${group.code}`);
    // Keep specific recovery steps; the broad all-hook alternative remains in JSON/setup.
    const remediation = group.code.startsWith("codex_global_hooks_")
      ? group.remediation.replace(/\s*Or explicitly choose\b(?=[\s\S]*--trust-all)[\s\S]*$/i, "").trim()
      : group.remediation;
    if (remediation) lines.push(`  Cách khắc phục: ${remediation}`);
  }
  if (cleanup.length) lines.push("", ...cleanup);
  return lines.join("\n");
}
