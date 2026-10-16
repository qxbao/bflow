import {
  type AgentHealthCheck,
  AgentHealthCheckSchema,
  type AgentHealthResult
} from "@bflow/contracts";

export function scrubDiagnosticText(input: string): string {
  if (!input) return "";
  let text = input;

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

  // Strip non-printable control characters except standard space
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

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
