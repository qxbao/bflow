import { ContractErrorSchema, type ContractError } from "@bflow/contracts";
import type { CliCommandName } from "./types.js";

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
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

export function dim(text: string, enabled = true): string {
  return colorize(text, ANSI.dim, enabled);
}

export function bold(text: string, enabled = true): string {
  return colorize(text, ANSI.bold, enabled);
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
  // Must depend on exported error.code and timeout.retrySafety, with priority over incidental message fragments
  if (
    error.code === "unknown_delivery" ||
    (error.code === "timeout" && "retrySafety" in error && (error as { retrySafety?: unknown }).retrySafety === "observation_only") ||
    msg.includes("reconcile the existing session") ||
    msg.includes("unknown_delivery")
  ) {
    return "Inspect 'bflow status' or 'bflow doctor' and reconcile existing delivery before retry; no automatic resend.";
  }

  // 2. State corruption guidance (prefer typed error.code corruption over message text)
  if (
    error.code === "corruption" ||
    msg.includes("corrupt") ||
    msg.includes("belongs to another repository") ||
    msg.includes("foreign")
  ) {
    return "Preserve the .bflow directory and run 'bflow doctor' to diagnose state integrity.";
  }

  // 3. Check for specific authored instructions already embedded in the message
  if (msg.includes("Run bflow recover --yes")) {
    return "Stop any old Bflow lifecycle commands, then run 'bflow recover --yes' to migrate the legacy lock.";
  }
  if (msg.includes("Run claude auth login") || msg.includes("Run codex login") || msg.includes("auth login")) {
    return "Authenticate using 'claude auth login' or 'codex login' before running 'bflow up'.";
  }
  if (msg.includes("Run bflow up before attach")) {
    return "Run 'bflow up' to start the environment before running 'bflow attach'.";
  }
  if (msg.includes("Unsafe shutdown")) {
    return "Inspect active runs with 'bflow status'. If shutdown is intended, rerun 'bflow down --yes'. Never delete .bflow.";
  }
  if (msg.includes("Wait for it or interrupt that command") || msg.includes("is still running")) {
    return "Wait for the active command to finish or stop its process. Do not delete the lifecycle.guard file.";
  }

  // 4. Specific workflow run / task not found or conflict (MUST precede generic not found / executable checks)
  if (msg.includes("Run '") && msg.includes("not found")) {
    return "Verify the run ID with 'bflow status --limit 10' or run 'bflow status <run-id>'.";
  }
  if (msg.includes("Task '") && msg.includes("not found")) {
    return "Verify the task ID with 'bflow status <run-id>'.";
  }
  if (msg.includes("No run found containing task")) {
    return "Specify the target run explicitly: 'bflow approve <task-id> --run <run-id>'.";
  }
  if (msg.includes("Multiple active runs") || msg.includes("Specify --run")) {
    return "Specify the target run explicitly: 'bflow approve <task-id> --run <run-id>'.";
  }

  // 5. Missing repo
  if (msg.includes("not a git repository") || msg.includes("cannot identify repository") || msg.includes("Git repository root")) {
    return "Navigate to a valid Git repository root or run 'git init'.";
  }

  // 6. Missing config
  if (error.code === "not_found" && (msg.includes("config") || msg.includes("Configuration not found") || command === "run")) {
    return "Run 'bflow init' to initialize repository configuration.";
  }

  // 7. Malformed config
  if (msg.includes("config.yaml") || msg.includes("Invalid configuration") || msg.includes("identity mismatch")) {
    return "Inspect .bflow/config.yaml and run 'bflow doctor'. Preserve existing configuration.";
  }

  // 8. Missing executable (do not match broad 'not found')
  if (msg.includes("ENOENT") || msg.includes("Missing/unavailable dependency") || msg.includes("flock") || msg.includes("not installed") || msg.includes("executable is not available")) {
    return "Ensure the required executable is installed and available on PATH, then run 'bflow doctor'.";
  }

  // 9. Authentication
  if (msg.includes("not authenticated") || msg.includes("auth status") || msg.includes("Authentication diagnostics")) {
    return "Run 'claude auth login' or 'codex login' to authenticate before running 'bflow up'.";
  }

  // 10. Unsupported default provider / custom host requirement
  if (msg.includes("verified Claude native hooks") || msg.includes("operator-supplied custom host") || msg.includes("unsupported provider") || (command === "init" && msg.includes("provider"))) {
    return "Use 'bflow init --provider claude' or supply a verified custom host integration via BFLOW_ENVIRONMENT_MODULE.";
  }

  // 11. Attach before up
  if (msg.includes("No active repository session") || msg.includes("session is stopped")) {
    return "Run 'bflow up' to start the environment before running 'bflow attach'.";
  }

  // 12. Busy lock
  if (msg.includes("guard") || msg.includes("Another bflow")) {
    return "Wait for the active command to finish or stop its process. Do not delete the lifecycle.guard file.";
  }

  // 13. Legacy lock
  if (msg.includes("legacy lifecycle lock") || msg.includes("recover --yes")) {
    return "Stop any running Bflow commands, then run 'bflow recover --yes' to migrate the legacy lock.";
  }

  // 14. Unsafe shutdown
  if (command === "down" && (msg.includes("active runs") || msg.includes("uncommitted changes"))) {
    return "Inspect active runs with 'bflow status'. If shutdown is intended, rerun 'bflow down --yes'. Never delete .bflow.";
  }

  // 15. Corruption or foreign receipts (fallback for message matching)
  if (msg.includes("corrupt") || msg.includes("belongs to another repository") || msg.includes("mismatch") || msg.includes("foreign")) {
    return "Preserve the .bflow directory and run 'bflow doctor' to diagnose state integrity.";
  }

  // 16. Usage / validation errors
  if (error.code === "validation" && (msg.includes("Unknown option") || msg.includes("requires a value") || msg.includes("does not take a value") || msg.includes("Unexpected argument"))) {
    return `Run '${command ? `bflow ${command} --help` : "bflow --help"}' for usage information.`;
  }

  // Default fallback
  return `Run '${command ? `bflow ${command} --help` : "bflow --help"}' or 'bflow doctor' for diagnostics.`;
}

/**
 * Formats a progress step for interactive stderr.
 */
export function formatProgressStep(step: string, useColor = false): string {
  const marker = useColor ? cyan(bold("[..]")) : "[..]";
  return `${marker} ${step}`;
}
