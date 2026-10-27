import { ContractErrorSchema, type ContractError } from "@bflow/contracts";
import type { CliCommandName } from "./types.js";
import { posix, win32 } from "node:path";

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m"
} as const;

export function colorize(text: string, code: string, enabled: boolean): string {
  if (!enabled || !text) return text;
  return `${code}${text}${ANSI.reset}`;
}

export function green(text: string, enabled = true): string {
  return colorize(text, ANSI.green, enabled);
}

export function yellow(text: string, enabled = true): string {
  return colorize(text, ANSI.yellow, enabled);
}

export function red(text: string, enabled = true): string {
  return colorize(text, ANSI.red, enabled);
}

export function cyan(text: string, enabled = true): string {
  return colorize(text, ANSI.cyan, enabled);
}

export function blue(text: string, enabled = true): string {
  return colorize(text, ANSI.blue, enabled);
}

export function magenta(text: string, enabled = true): string {
  return colorize(text, ANSI.magenta, enabled);
}

export function gray(text: string, enabled = true): string {
  return colorize(text, ANSI.gray, enabled);
}

export function dim(text: string, enabled = true): string {
  return colorize(text, ANSI.dim, enabled);
}

export function bold(text: string, enabled = true): string {
  return colorize(text, ANSI.bold, enabled);
}

/** Green checkmark for completed tasks and steps. */
export function greenTick(enabled = true): string {
  return green("✓", enabled);
}

export interface StreamColorOptions {
  readonly isTTY?: boolean | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly explicit?: boolean | undefined;
}

/**
 * Independently resolves color support for a stream.
 * Precedence:
 * 1. Explicit override if provided.
 * 2. Non-empty NO_COLOR disables color (overrides FORCE_COLOR).
 * 3. FORCE_COLOR="0" disables color.
 * 4. Non-zero explicit FORCE_COLOR enables color (including pipes).
 * 5. Otherwise, enabled if stream isTTY && TERM !== "dumb".
 */
export function resolveStreamColor(options?: StreamColorOptions): boolean {
  if (options?.explicit !== undefined) {
    return options.explicit;
  }
  const env = options?.env ?? process.env;
  const noColor = env["NO_COLOR"];
  if (noColor !== undefined && noColor !== "") {
    return false;
  }
  const forceColor = env["FORCE_COLOR"];
  if (forceColor === "0") {
    return false;
  }
  if (forceColor !== undefined && forceColor !== "") {
    return true;
  }
  const term = env["TERM"];
  if (term === "dumb") {
    return false;
  }
  return Boolean(options?.isTTY);
}

/**
 * Determines whether stderr is an interactive human terminal for progress emission.
 * NOTE: FORCE_COLOR NEVER enables progress. Progress requires an interactive TTY stream.
 */
export function isStderrInteractive(options?: {
  readonly isTTY?: boolean | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly explicitInteractive?: boolean | undefined;
}): boolean {
  if (options?.explicitInteractive !== undefined) {
    return options.explicitInteractive;
  }
  const env = options?.env ?? process.env;
  if (env["TERM"] === "dumb") {
    return false;
  }
  return Boolean(options?.isTTY);
}

/**
 * Strips ANSI escape sequences, C0/C1 control characters, and CR.
 */
export function stripAnsi(text: string): string {
  return text
    // ANSI CSI sequences
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    // ANSI OSC sequences
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // General 2-character escape sequences
    .replace(/\x1b[@-Z\\-_]/g, "")
    // C0 control characters including \r (CR) and \x7F (DEL), preserving \n and \t
    .replace(/[\x00-\x08\x0B\x0C\x0D\x0E-\x1F\x7F]/g, "")
    // C1 control characters (0x80 - 0x9F)
    .replace(/[\u0080-\u009F]/g, "");
}

/**
 * Redacts common credentials (tokens, private keys, API keys, passwords) from untrusted human text.
 */
export function redactSensitive(text: string): string {
  let result = text;
  // Startup reports can include CLI failure text with opaque credential values.
  result = result.replace(/(--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|token|password|passwd|secret|authorization)(?:=|\s+))(?:(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$))|(?:'[^']*(?:'|$))|[^\s]+)/gi,
    "$1[REDACTED]");
  result = result.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH)[A-Z0-9_]*)=(?:(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$))|(?:'[^']*(?:'|$))|[^\s]+)/gi,
    "$1=[REDACTED]");
  result = result.replace(/((["'])[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|AUTH)[A-Z0-9_-]*\2\s*:\s*)(?:(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$))|(?:'[^']*(?:'|$))|[^,\s}\]]+)/gi,
    '$1"[REDACTED]"');
  // Common API keys / secret tokens:
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_), Anthropic/OpenAI keys (sk-, sk_...)
  result = result.replace(/\b(?:gh[pousr]|sk)[-_][A-Za-z0-9_\-]{16,}/g, "[REDACTED_SECRET]");
  // Complete RFC-style Bearer tokens (including +, /, ~, = padding)
  result = result.replace(/Bearer\s+[A-Za-z0-9_\-.~+/=]+/gi, "Bearer [REDACTED_TOKEN]");
  // JWTs
  result = result.replace(/eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+/g, "[REDACTED_JWT]");
  // Explicit password, token, secret, apiKey fields (both JSON quoted and unquoted forms)
  result = result.replace(
    /(["']?)(password|token|secret|apiKey|api_key)\1(\s*[:=]\s*)(?:(["'])((?:\\.|(?!\4)[^\\])*)\4|([^"'\s,;{}]+))/gi,
    (_match, quote, key, sep, valQuote) => {
      if (quote) {
        const q = valQuote || quote;
        return `${quote}${key}${quote}${sep}${q}[REDACTED]${q}`;
      }
      return `${key}=[REDACTED]`;
    }
  );
  // PEM private keys (PKCS#8 generic 'PRIVATE KEY', RSA, EC, ENCRYPTED, etc.)
  result = result.replace(/-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
  return result;
}

/**
 * Bounds terminal and subprocess messages to prevent huge stack/account/terminal dumps.
 */
export function boundMessage(text: string, maxLength = 350): string {
  const lines = text.split("\n");
  const nonStackLines = lines.filter((l) => !/^\s+at\s+/.test(l));
  const clean = nonStackLines.slice(0, 5).join("\n").trim();
  if (clean.length > maxLength) {
    return clean.slice(0, maxLength).trimEnd() + "... [truncated]";
  }
  return clean;
}

/**
 * Sanitizes untrusted dynamic fields for human output before ANSI styling.
 * Strips ANSI escapes, C0/C1 control codes and CR, redacts sensitive credentials,
 * removes multiline stack traces, and bounds length.
 */
export function humanText(value: unknown, maxLength = 250): string {
  if (value === null || value === undefined) {
    return "";
  }
  const str = typeof value === "string" ? value : String(value);
  return boundMessage(redactSensitive(stripAnsi(str)), maxLength);
}

export function sanitizeIdentifier(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const str = typeof value === "string" ? value : String(value);
  return redactSensitive(stripAnsi(str)).replace(/[\r\n]+/g, "").trim();
}

/**
 * Extracts validated safe scalar fields from error.details.
 * Enforces per-field bounds and never dumps full objects or unvalidated fields.
 */
export function extractSafeDetails(details: unknown): Record<string, string | number | boolean> | null {
  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  const allowedKeys = new Set([
    "stage",
    "role",
    "provider",
    "paneId",
    "sessionId",
    "sessionName",
    "workspaceRoot",
    "taskId",
    "runId",
    "reason"
  ]);
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (allowedKeys.has(key)) {
      if (typeof value === "string") {
        const clean = sanitizeIdentifier(value);
        if (key === "reason" && !/^[a-z0-9_:-]{1,100}$/i.test(clean)) continue;
        const maxLen = key === "workspaceRoot" ? 300 : 200;
        safe[key] = clean.length > maxLen ? clean.slice(0, maxLen).trimEnd() + "... [truncated]" : clean;
      } else if (typeof value === "number" || typeof value === "boolean") {
        safe[key] = value;
      }
    }
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

/**
 * Validates or normalizes any error into a schema-compliant ContractError.
 */
export function toContractError(
  err: unknown,
  defaultMessage = "An unexpected internal error occurred."
): ContractError {
  if (typeof err === "object" && err !== null && "contractError" in err) {
    const candidate = (err as { contractError: unknown }).contractError;
    const parsed = ContractErrorSchema.safeParse(candidate);
    if (parsed.success) {
      return parsed.data;
    }
  }
  const parsedDirect = ContractErrorSchema.safeParse(err);
  if (parsedDirect.success) {
    return parsedDirect.data;
  }
  let rawMsg = "";
  if (err instanceof Error) {
    rawMsg = err.message;
  } else if (typeof err === "string") {
    rawMsg = err;
  } else if (
    err !== null &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    rawMsg = (err as { message: string }).message;
  } else if (err !== null && err !== undefined) {
    rawMsg = String(err);
  }
  const cleanMsg = boundMessage(redactSensitive(stripAnsi(rawMsg)), 200).trim();
  const message = cleanMsg.length > 0 ? cleanMsg : defaultMessage;
  return {
    code: "validation",
    retryable: false,
    message
  };
}

/**
 * Resolves a specific, useful supported action for an error, preserving authored instructions when present.
 */
export function resolveActionableRemediation(
  error: ContractError,
  command?: CliCommandName | undefined
): string {
  const msg = error.message;

  // 1. Dispatch / retry safety guidance for uncertain delivery or observation-only timeout
  if (
    error.code === "unknown_delivery" ||
    (error.code === "timeout" && "retrySafety" in error && (error as { retrySafety?: unknown }).retrySafety === "observation_only") ||
    msg.includes("reconcile the existing session") ||
    msg.includes("unknown_delivery")
  ) {
    return "Kiểm tra 'bflow status' hoặc 'bflow doctor' để đối soát phiên hiện tại trước khi thử lại; không tự động gửi lại.";
  }

  // 2. State corruption guidance (prefer typed error.code corruption over message text)
  if (
    error.code === "corruption" ||
    msg.includes("corrupt") ||
    msg.includes("belongs to another repository") ||
    msg.includes("foreign")
  ) {
    return "Giữ nguyên thư mục .bflow và chạy 'bflow doctor' để chẩn đoán tính toàn vẹn trạng thái.";
  }

  if (msg.includes("verification_sandbox_unavailable") || msg.includes("Runtime independent verification capability unavailable")) {
    return "Chạy 'bflow doctor' để kiểm tra sandbox xác minh; xem cách cài Bubblewrap/cấp quyền userns AppArmor tại packages/runtime/README.md, rồi chạy lại 'bflow up'.";
  }

  // 3. Check for specific authored instructions already embedded in the message
  if (msg.startsWith("Provider readiness is not satisfied;") && msg.includes("codex_global_hooks_")) {
    return "Chạy 'bflow setup --codex-hooks --plan' để kiểm tra nguồn hook và nguyên nhân bị chặn.";
  }
  if (msg.includes("Run bflow recover --yes")) {
    return "Dừng các lệnh Bflow cũ đang chạy, sau đó chạy 'bflow recover --yes' để chuyển đổi khóa vòng đời cũ.";
  }
  if (msg.includes("Agent provider 'agy'") || msg.includes("Agy access check failed")) {
    if (msg.includes("blocked")) return "Gỡ bỏ chính sách chặn của workspace/provider và kiểm tra lại bằng 'bflow agent check agy' hoặc 'bflow doctor'.";
    if (msg.includes("not authenticated")) return "Chạy 'agy' ở chế độ tương tác để đăng nhập, sau đó xác minh bằng 'agy models' và 'bflow doctor'.";
    return "Chạy 'agy models' trong kho mã nguồn này để kiểm tra quyền truy cập provider, sau đó chạy lại 'bflow doctor'.";
  }
  if (msg.includes("Run claude auth login") || msg.includes("Run codex login") || msg.includes("auth login")) {
    return "Xác thực bằng 'claude auth login' hoặc 'codex login' trước khi chạy 'bflow up'.";
  }
  if (msg.includes("Run bflow up before attach")) {
    return "Chạy 'bflow up' để khởi động môi trường trước khi chạy 'bflow attach'.";
  }
  if (msg.includes("Unsafe shutdown")) {
    return "Kiểm tra các luồng đang chạy bằng 'bflow status'. Nếu vẫn muốn dừng, hãy chạy 'bflow down --yes'. Không xóa thư mục .bflow.";
  }
  if (msg.includes("Wait for it or interrupt that command") || msg.includes("is still running")) {
    return "Đợi lệnh đang chạy hoàn tất hoặc dừng tiến trình đó. Không xóa tệp lifecycle.guard.";
  }

  // 4. Specific workflow run / task not found or conflict (MUST precede generic not found / executable checks)
  if (msg.includes("Run '") && msg.includes("not found")) {
    return "Kiểm tra mã luồng chạy bằng 'bflow status --limit 10' hoặc chạy 'bflow status <run-id>'.";
  }
  if (msg.includes("Task '") && msg.includes("not found")) {
    return "Kiểm tra mã tác vụ bằng 'bflow status <run-id>'.";
  }
  if (msg.includes("No run found containing task")) {
    return "Chỉ định rõ luồng chạy mục tiêu: 'bflow approve <task-id> --run <run-id>'.";
  }
  if (msg.includes("Multiple active runs") || msg.includes("Specify --run")) {
    return "Chỉ định rõ luồng chạy mục tiêu: 'bflow approve <task-id> --run <run-id>'.";
  }

  // 5. Missing repo
  if (msg.includes("not a git repository") || msg.includes("cannot identify repository") || msg.includes("Git repository root")) {
    return "Di chuyển tới thư mục gốc của kho Git hợp lệ hoặc chạy 'git init'.";
  }

  // 6. Missing config
  if (error.code === "not_found" && (msg.includes("config") || msg.includes("Configuration not found") || command === "run")) {
    return "Chạy 'bflow init' để khởi tạo cấu hình kho mã nguồn.";
  }

  // 7. Malformed config
  if (msg.includes("config.yaml") || msg.includes("config.yml") || msg.includes("Invalid configuration") || msg.includes("identity mismatch")) {
    return "Kiểm tra tệp .bflow/config.yml và chạy 'bflow doctor'. Giữ nguyên cấu hình hiện có.";
  }

  // 8. Missing executable (do not match broad 'not found')
  if (/\b(?:EACCES|EPERM)\b/.test(msg)) {
    return "Kiểm tra quyền sở hữu và quyền đọc/ghi của đường dẫn ở trên, sau đó chạy lại lệnh.";
  }
  if (/\bENOENT\b.*\b(?:open|stat|read|scandir)\b/i.test(msg)) {
    return "Kiểm tra đường dẫn tệp đầu vào và truyền một tệp hợp lệ có thể đọc; dùng --help để xem lại tham số.";
  }
  if (/\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b|\bfetch failed\b/i.test(msg)) {
    return "Kiểm tra kết nối mạng và địa chỉ dịch vụ, sau đó chạy 'bflow doctor' để chẩn đoán kết nối.";
  }
  if (/\bERR_MODULE_NOT_FOUND\b|Cannot find (?:module|package)/i.test(msg)) {
    return "Cài đặt lại hoặc biên dịch lại Bflow CLI, sau đó chạy 'bflow doctor' để kiểm tra các thành phần.";
  }
  if (msg.includes("ENOENT") || msg.includes("Missing/unavailable dependency") || msg.includes("flock") || msg.includes("not installed") || msg.includes("executable is not available")) {
    return "Đảm bảo phần mềm thực thi cần thiết đã được cài đặt và có trong PATH, sau đó chạy 'bflow doctor'.";
  }

  // 9. Authentication
  if (msg.includes("not authenticated") || msg.includes("auth status") || msg.includes("Authentication diagnostics")) {
    return "Chạy 'claude auth login' hoặc 'codex login' để xác thực trước khi chạy 'bflow up'.";
  }

  // 10. Unsupported default provider / custom host requirement
  if (msg.includes("verified Claude native hooks") || msg.includes("operator-supplied custom host") || msg.includes("unsupported provider") || (command === "init" && msg.includes("provider"))) {
    return "Sử dụng 'bflow init --provider claude' hoặc cung cấp custom host hợp lệ qua BFLOW_ENVIRONMENT_MODULE.";
  }

  // 11. Attach before up
  if (msg.includes("No active repository session") || msg.includes("session is stopped")) {
    return "Chạy 'bflow up' để khởi động môi trường trước khi chạy 'bflow attach'.";
  }

  // 12. Busy lock
  if (msg.includes("guard") || msg.includes("Another bflow")) {
    return "Đợi lệnh đang chạy hoàn tất hoặc dừng tiến trình đó. Không xóa tệp lifecycle.guard.";
  }

  // 13. Legacy lock
  if (msg.includes("legacy lifecycle lock") || msg.includes("recover --yes")) {
    return "Dừng các lệnh Bflow đang chạy, sau đó chạy 'bflow recover --yes' để chuyển đổi khóa vòng đời cũ.";
  }

  // 14. Unsafe shutdown
  if (command === "down" && (msg.includes("active runs") || msg.includes("uncommitted changes"))) {
    return "Kiểm tra các luồng đang chạy bằng 'bflow status'. Nếu vẫn muốn dừng, hãy chạy 'bflow down --yes'. Không xóa thư mục .bflow.";
  }

  // 15. Corruption or foreign receipts (fallback for message matching)
  if (msg.includes("corrupt") || msg.includes("belongs to another repository") || msg.includes("mismatch") || msg.includes("foreign")) {
    return "Giữ nguyên thư mục .bflow và chạy 'bflow doctor' để chẩn đoán tính toàn vẹn trạng thái.";
  }

  // 16. Usage / validation errors
  if (error.code === "validation" && (msg.includes("Unknown option") || msg.includes("requires a value") || msg.includes("does not take a value") || msg.includes("Unexpected argument"))) {
    return `Chạy '${command ? `bflow ${command} --help` : "bflow --help"}' để xem hướng dẫn sử dụng.`;
  }

  // Default fallback
  return `Chạy '${command ? `bflow ${command} --help` : "bflow --help"}' hoặc 'bflow doctor' để chẩn đoán.`;
}

/**
 * Formats a progress step for interactive stderr.
 */
export function formatProgressStep(step: string, useColor = false, number = 1): string {
  const marker = `[${number}]`;
  return `${useColor ? cyan(bold(marker)) : marker} ${humanLine(step)}`;
}

/** Single-line terminal text, including redaction before truncation. */
export function humanLine(value: unknown, maxLength = 180): string {
  return humanText(value, maxLength).replace(/\s+/g, " ").trim();
}

export function readableLabel(value: unknown): string {
  return humanLine(value).replace(/[_-]+/g, " ");
}

/** Labels only; identifiers and copyable commands must keep their original spelling. */
export function fieldLabel(value: string): string {
  const known: Record<string, string> = {
    commandId: "Command ID", correlationId: "Correlation ID", runId: "Run ID",
    taskId: "Task ID", idempotencyKey: "Idempotency key"
  };
  return known[value] ?? readableLabel(value.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
}

export function statusTag(value: unknown, useColor = false): string {
  const status = humanLine(value || "unknown", 80).toLowerCase();
  const label = readableLabel(status).toUpperCase();
  const paint = ["passed", "pass", "succeeded", "ready", "healthy", "present", "approved", "applied", "already_satisfied", "reused", "up", "valid"].includes(status) ? green
    : ["failed", "fail", "not_ready", "unhealthy", "invalid", "missing", "unavailable", "unsupported", "error"].includes(status) ? red
    : ["skipped", "stopped", "down", "cancelled", "not_applicable"].includes(status) ? dim
    : yellow;
  return paint(`[${label}]`, useColor);
}

export const SETUP_COMPONENT_LABELS: Readonly<Record<string, string>> = {
  path: "Đưa bflow và các công cụ đã cài vào PATH của terminal",
  "role-skills": "Cài đặt các kỹ năng (skills) cho agent",
  "isolator-profiles": "Đồng bộ hồ sơ (profile) giữa môi trường gốc và cô lập",
  "mcp-config": "Cấu hình các công cụ MCP",
  services: "Khởi động và xác minh dịch vụ MCP Gateway",
  "environment-manifest": "Lưu cấu hình máy đã xác minh",
  doctor: "Kiểm tra lại toàn bộ thiết lập"
};

function targetPathApi(path: string): typeof posix {
  // Backslashes are valid filename characters on POSIX; a Windows root is unambiguous.
  return !posix.isAbsolute(path) && win32.isAbsolute(path) ? win32 : posix;
}

/** Collapse bundles only for known skill targets; retain every other target by name. */
export function formatTargetPaths(paths: readonly string[], indent = "    ", options: { skillBundles?: boolean } = {}): string[] {
  const groups = new Map<string, { bundles: number; files: string[] }>();
  for (const raw of paths) {
    const path = sanitizeIdentifier(raw);
    const api = targetPathApi(path);
    const parent = api.dirname(path);
    const name = api.basename(path);
    const bundle = options.skillBundles === true && api.basename(parent) === "bundles" && /^[a-f0-9]{64}$/i.test(name);
    const key = `${bundle ? "bundles" : "files"}:${parent}`;
    const group = groups.get(key) ?? { bundles: 0, files: [] };
    if (bundle) group.bundles++;
    else group.files.push(path);
    groups.set(key, group);
  }
  const lines: string[] = [];
  for (const [key, group] of groups) {
    if (group.bundles) {
      lines.push(`${indent}- ${group.bundles} gói kỹ năng đã ghim`);
      lines.push(`${indent}  Kho lưu trữ: ${key.slice("bundles:".length)}`);
    } else if (group.files.length > 1 && group.files.every(path => {
      const api = targetPathApi(path);
      return api.extname(path) !== "";
    })) {
      lines.push(`${indent}- ${key.slice("files:".length)}`);
      for (const path of group.files) {
        const api = targetPathApi(path);
        lines.push(`${indent}  - ${api.basename(path)}`);
      }
    } else for (const path of group.files) lines.push(`${indent}- ${path}`);
  }
  return lines;
}

/** Readable approval scope, with repeated machine-wide target lists grouped by component. */
export function formatSetupPreview(text: string, useColor = false): string {
  let number = 0;
  let component: string | undefined;
  let groupedBundles = false;
  const clean = redactSensitive(stripAnsi(text));
  const input = clean.split("\n");
  const lines: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const line = input[index]!;
    const match = /^- (\S+:\S+) (\[[^\]]*\]) (.*)$/.exec(line);
    if (match) {
      const [, id, flags, summary] = match;
      component = id!.slice(id!.indexOf(":") + 1);
      const label = SETUP_COMPONENT_LABELS[component] ?? humanLine(summary);
      const readableFlags = flags!.slice(1, -1).split(", ").map(flag => flag === "approval" ? "cần phê duyệt"
        : flag === "no-approval" ? "không cần phê duyệt" : flag === "machine-wide" ? "tài khoản này" : readableLabel(flag)).join("; ");
      lines.push("", `${formatProgressStep(label, useColor, ++number)} [${readableFlags}]`);
      lines.push(dim(`    ${humanLine(id)}: ${humanLine(summary, 2000)}`, useColor));
      continue;
    }
    if (/^\s+target: /.test(line)) {
      const paths: string[] = [];
      do { paths.push(input[index]!.replace(/^\s+target: /, "")); index++; }
      while (index < input.length && /^\s+target: /.test(input[index]!));
      index--;
      const targets = formatTargetPaths(paths, "    ", { skillBundles: component === "role-skills" });
      groupedBundles ||= targets.some(value => /^\s*- \d+ gói kỹ năng đã ghim$/.test(value));
      lines.push(...targets.map(value => dim(value, useColor)));
      continue;
    }
    if (line === "Machine-wide changes:") {
      const groups = new Map<string, string[]>();
      while (index + 1 < input.length) {
        const change = /^- (\S+:\S+): (.*)$/.exec(input[index + 1]!);
        if (!change) break;
        index++;
        const paths = groups.get(change[1]!) ?? [];
        paths.push(change[2]!);
        groups.set(change[1]!, paths);
      }
      lines.push("", useColor ? cyan(bold("Thay đổi trên tài khoản này:"), true) : "Thay đổi trên tài khoản này:");
      for (const [step, paths] of groups) {
        const component = step.slice(step.indexOf(":") + 1);
        lines.push(`  ${SETUP_COMPONENT_LABELS[component] ?? readableLabel(component)} (${paths.length} mục tiêu)`);
        const targets = formatTargetPaths(paths, "    ", { skillBundles: component === "role-skills" });
        groupedBundles ||= targets.some(value => /^\s*- \d+ gói kỹ năng đã ghim$/.test(value));
        lines.push(...targets);
      }
      continue;
    }
    const bounded = humanText(line, 2000);
    if (/^Apply plan /.test(line) && groupedBundles) {
      lines.push("Các mã băm gói kỹ năng đã được gom nhóm ở trên. Xem đầy đủ: bflow setup --plan --json", "");
    }
    lines.push(/^\s+command:/.test(line) ? dim(`    ${bounded.trimStart()}`, useColor)
      : line.endsWith(":") ? (useColor ? cyan(bold(bounded), true) : bounded) : bounded);
  }
  return lines.join("\n");
}
