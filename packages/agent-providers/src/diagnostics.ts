import {
  type AgentHealthCheck,
  AgentHealthCheckSchema,
  type AgentHealthResult
} from "@bflow/contracts";
import type { ProviderCommandOutcome } from "./types.js";

function redactDiagnosticText(input: string): string {
  if (!input) return "";
  let text = input;

  // Opaque credentials need not use a recognizable provider token prefix.
  // Redact before whitespace folding/truncation so quoted values remain whole.
  text = text.replace(/(--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|token|password|passwd|secret|authorization)(?:=|\s+))(?:(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$))|(?:'[^']*(?:'|$))|[^\s]+)/gi,
    "$1[REDACTED]");
  text = text.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH)[A-Z0-9_]*)=(?:(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$))|(?:'[^']*(?:'|$))|[^\s]+)/gi,
    "$1=[REDACTED]");
  text = text.replace(/((["'])[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|AUTH)[A-Z0-9_-]*\2\s*:\s*)(?:(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$))|(?:'[^']*(?:'|$))|[^,\s}\]]+)/gi,
    '$1"[REDACTED]"');

  // Redact Bearer tokens
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");

  // Redact API keys and tokens (OpenAI sk-..., Anthropic sk-ant-..., Google AIza..., GitHub ghp_...)
  text = text.replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]");
  text = text.replace(/\bAIza[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]");
  text = text.replace(/\bghp_[A-Za-z0-9]+/g, "[REDACTED_TOKEN]");

  // Redact secret:// followed by sensitive material
  text = text.replace(/secret:\/\/[A-Za-z0-9._/-]+(?:\s*=\s*|\s*:\s*)[^\s]+/g, "secret://[REDACTED]");

  // Redact email addresses
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]");

  // Remove terminal colour sequences before control characters and error-line selection.
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

  // Strip non-printable control characters except standard space
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  return text;
}

/** Select failure evidence before the health check's 240-character display limit. */
export function executionProbeFailureDiagnostic(outcome: ProviderCommandOutcome): string {
  // Redact the complete streams first: quoted credentials can span multiple lines.
  const streams = [outcome.stderr, outcome.stdout, outcome.cause ?? ""].map(output =>
    redactDiagnosticText(output).split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  // A terminal CLI error explains its exit; timestamped worker logs can arrive
  // afterwards (for example an optional MCP authentication failure).
  const terminalError = streams.map(lines => {
    let index = lines.length - 1;
    while (index >= 0 && !/^(?:error|fatal)\s*:/i.test(lines[index]!)) index -= 1;
    if (index < 0) return undefined;
    const continuation = lines.slice(index + 1, index + 8);
    const nextLog = continuation.findIndex(line => /^\d{4}-\d{2}-\d{2}T/.test(line));
    return [lines[index], ...continuation.slice(0, nextLog < 0 ? undefined : nextLog)].join(" ");
  }).find(line => line !== undefined);
  // Otherwise prefer stderr's concrete error over model commentary in stdout.
  const error = terminalError ?? streams.map(lines => {
    let index = lines.length - 1;
    while (index >= 0 && !/(?:^|\s)(?:error|fatal)\b|"error"\s*:/i.test(lines[index]!)) index -= 1;
    // Preserve continuation lines, including pretty-printed JSON error.message/code.
    return index < 0 ? undefined : lines.slice(index, index + 8).join(" ");
  })
    .find(line => line !== undefined);
  const detail = error ?? streams[2]?.at(-1) ?? streams[0]?.at(-1) ?? streams[1]?.at(-1) ?? "Provider returned no diagnostic output.";
  const processState = outcome.failure ?? (outcome.started ? `exit ${outcome.exitCode ?? "unknown"}` : "not started");
  return `${processState}: ${detail}`;
}

export function scrubDiagnosticText(input: string): string {
  let text = redactDiagnosticText(input);

  // Collapse multiline strings and tabs into single spaces
  text = text.replace(/\s+/g, " ").trim();

  // Truncate to a single clean sentence <= 240 characters
  if (text.length > 240) {
    text = text.slice(0, 237) + "...";
  }

  return text;
}

export function createHealthCheck(
  check: AgentHealthCheck["check"],
  status: AgentHealthCheck["status"],
  code: string,
  message: string,
  remediation?: string
): AgentHealthCheck {
  const scrubbedMessage = scrubDiagnosticText(message) || "No diagnostic details available.";
  const scrubbedRemediation = remediation ? scrubDiagnosticText(remediation) : undefined;

  return AgentHealthCheckSchema.parse({
    check,
    status,
    code,
    message: scrubbedMessage,
    ...(scrubbedRemediation !== undefined && scrubbedRemediation.length > 0
      ? { remediation: scrubbedRemediation }
      : {})
  });
}

export function formatProviderDiagnosticReport(health: AgentHealthResult): {
  summary: string;
  status: AgentHealthResult["status"];
  failedChecks: Array<{ check: string; code: string; cause: string; remediation: string }>;
} {
  const failedChecks: Array<{ check: string; code: string; cause: string; remediation: string }> = [];

  for (const item of health.checks) {
    if (item.status !== "passed") {
      failedChecks.push({
        check: item.check,
        code: item.code,
        cause: item.message,
        remediation: item.remediation ?? "Review provider configuration, prerequisites, and authentication."
      });
    }
  }

  let summary: string;
  if (health.status === "ready") {
    summary = `Provider '${health.provider}' in role '${health.role}' is ready (${health.stage}).`;
  } else if (health.status === "unsupported") {
    summary = `Provider '${health.provider}' in role '${health.role}' is unsupported (${failedChecks.length} unsupported/failed check(s)).`;
  } else {
    summary = `Provider '${health.provider}' in role '${health.role}' is blocked (${failedChecks.length} failed/unknown check(s)).`;
  }

  return {
    summary,
    status: health.status,
    failedChecks
  };
}
