import type { JsonValue } from "@bflow/contracts";
import type { AppCheckRunCompleted } from "./app-check-runner.js";

/**
 * Evidence for one real-app gate run. The document binds the candidate (revision and tree), the app instance, the
 * selected checks and criteria, the browser lease and the driver bytes. Everything free text is sanitized BEFORE it is
 * stored: secrets are redacted, control characters are removed and sizes are bounded. Env VALUES are never stored.
 */

export const EVIDENCE_LIMITS = { tailBytes: 8192, messageBytes: 2048, bodyBytes: 4096 } as const;

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]"],
  [/\b(token|secret|password|passwd|api[_-]?key|authorization)(\s*[=:]\s*)[^\s,;"'&]+/gi, "$1$2[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"]
];
/** Configured env values shorter than this are too ambiguous to redact everywhere; they still never appear as stored env values. */
const MIN_SECRET_LENGTH = 4;

/** Redacts known secret shapes and configured env values, then removes control characters except tab and newline. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let value = text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  for (const secret of secrets) if (secret.length >= MIN_SECRET_LENGTH) value = value.split(secret).join("[REDACTED]");
  for (const [pattern, replacement] of SECRET_PATTERNS) value = value.replace(pattern, replacement);
  return value;
}

function bound(value: string, limit: number, keep: "head" | "tail"): string {
  if (value.length <= limit) return value;
  return keep === "head" ? `${value.slice(0, limit - 3)}...` : value.slice(value.length - limit);
}

/** Deep sanitization of an evidence document. Tails keep their end; messages and bodies keep their start. */
export function sanitizeAppEvidence(value: JsonValue, secrets: readonly string[] = [], key = ""): JsonValue {
  if (typeof value === "string") {
    const redacted = redactText(value, secrets);
    if (/Tail$/.test(key)) return bound(redacted, EVIDENCE_LIMITS.tailBytes, "tail");
    if (key === "message") return bound(redacted, EVIDENCE_LIMITS.messageBytes, "head");
    return bound(redacted, EVIDENCE_LIMITS.bodyBytes, "head");
  }
  if (Array.isArray(value)) return value.map(item => sanitizeAppEvidence(item, secrets, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeAppEvidence(item, secrets, name)]));
  }
  return value;
}

export interface AppEvidenceCheck {
  readonly identity: string;
  readonly checkId: string;
  readonly kind: "ui" | "api";
  readonly definitionDigest: string;
  readonly criterionIds: readonly string[];
  readonly status: "passed" | "failed";
  readonly findings: readonly { code: string; message: string; details?: Record<string, string | number | boolean | null> | undefined }[];
  readonly observations: Record<string, JsonValue>;
  readonly screenshotArtifactId?: string;
}

export interface AppEvidenceInput {
  readonly suiteId: string;
  readonly gateId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly attemptId: string;
  readonly scope: "task" | "workflow";
  readonly specFingerprint: string;
  readonly candidate: { readonly sourceRevision: string; readonly checkoutTree: string };
  readonly command: { readonly executable: string; readonly args: readonly string[] };
  readonly port: number;
  readonly readyPath: string;
  readonly browser?: { readonly executable: string; readonly resourceKey: string };
  readonly run: AppCheckRunCompleted;
  /** Configured env values: used only to redact them from free text. They are never stored. */
  readonly envValues: readonly string[];
  readonly checks: readonly AppEvidenceCheck[];
  readonly criteria: readonly { readonly criterionId: string; readonly identities: readonly string[]; readonly passed: boolean }[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** Builds the evidence document and sanitizes it. The result is safe to store as-is. */
export function buildAppEvidence(input: AppEvidenceInput): JsonValue {
  const driver = input.run.driver;
  const document = {
    schemaVersion: 1,
    kind: "bflow.app-check-evidence",
    suiteId: input.suiteId,
    gateId: input.gateId,
    runId: input.runId,
    taskId: input.taskId ?? null,
    attemptId: input.attemptId,
    scope: input.scope,
    specFingerprint: input.specFingerprint,
    candidate: { sourceRevision: input.candidate.sourceRevision, checkoutTree: input.candidate.checkoutTree },
    app: {
      instanceId: driver.instanceId,
      origin: driver.origin,
      command: { executable: input.command.executable, args: [...input.command.args] },
      envKeys: [...input.run.envKeys],
      envDigest: input.run.envDigest,
      port: input.port,
      readyPath: input.readyPath,
      startedAt: driver.startedAt,
      readyAt: driver.readyAt ?? null,
      exit: driver.appExit ?? null,
      stdoutTail: driver.appStdoutTail,
      stderrTail: driver.appStderrTail
    },
    browser: driver.browserReady && input.browser ? {
      executable: input.browser.executable,
      version: input.run.browserVersion ?? null,
      resourceKey: input.browser.resourceKey,
      lease: input.run.lease ?? null
    } : null,
    driver: { sha256: input.run.driverSha256 },
    checks: input.checks.map(check => ({
      identity: check.identity,
      checkId: check.checkId,
      kind: check.kind,
      definitionDigest: check.definitionDigest,
      criterionIds: [...check.criterionIds],
      status: check.status,
      findings: check.findings.map(finding => ({ code: finding.code, message: finding.message, ...(finding.details ? { details: finding.details } : {}) })),
      observations: check.observations,
      ...(check.screenshotArtifactId ? { screenshotArtifactId: check.screenshotArtifactId } : {})
    })),
    criteria: input.criteria.map(criterion => ({ criterionId: criterion.criterionId, identities: [...criterion.identities], passed: criterion.passed })),
    evidencePolicy: "real served entrypoint in a sandbox; static HTML, copied test apps and screenshot existence are not accepted as pass evidence",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt
  };
  return sanitizeAppEvidence(JSON.parse(JSON.stringify(document)) as JsonValue, input.envValues);
}
