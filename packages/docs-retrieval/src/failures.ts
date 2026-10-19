/** What went wrong, in the terms an operator needs to act on. Distinct kinds never collapse into "failed". */
export type DocsFailureKind =
  | "network"
  | "timeout"
  | "auth_missing"
  | "auth_invalid"
  | "rate_limited"
  | "library_not_found"
  | "version_not_found"
  | "no_documentation"
  | "invalid_arguments"
  | "permission_denied"
  | "unavailable"
  | "upstream_error"
  | "protocol";

export interface DocsFailure {
  readonly kind: DocsFailureKind;
  readonly message: string;
  /** True when trying again later can succeed without any change by the operator. */
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly availableVersions?: readonly string[];
  readonly libraryId?: string;
  readonly status?: number;
}

const RETRYABLE: ReadonlySet<DocsFailureKind> = new Set(["network", "timeout", "rate_limited", "unavailable", "upstream_error"]);

export function failure(kind: DocsFailureKind, message: string, extra: Partial<Omit<DocsFailure, "kind" | "message" | "retryable">> = {}): DocsFailure {
  return { kind, message, retryable: RETRYABLE.has(kind), ...extra };
}

const splitVersions = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean);

/**
 * Classifies the text of a tool result that the server flagged `isError`. The server answers HTTP 200 for all of these,
 * so the text is the only signal. Patterns marked "observed" were captured from the hosted server on 2026-10-19; the
 * rate-limit and quota patterns are NOT observed (the limit could not be provoked) and are matched loosely.
 */
export function classifyToolError(text: string): DocsFailure {
  const trimmed = text.trim();
  // observed: "Invalid API key. Please check your API key. API keys should start with 'ctx7sk' prefix."
  if (/invalid api key|unauthori[sz]ed|authentication (failed|required)/i.test(trimmed)) return failure("auth_invalid", "The Context7 API key was rejected.");
  // observed: `Version "v1.0.0" not found for library "/react/react". Available versions: v19.2.7, v18.2.0`
  const version = /Version\s+"([^"]+)"\s+not found for library\s+"([^"]+)"(?:\.\s*Available versions:\s*(.+))?/i.exec(trimmed);
  if (version) return failure("version_not_found", `Version ${version[1]} is not available for ${version[2]}.`,
    { libraryId: version[2]!, availableVersions: version[3] ? splitVersions(version[3]) : [] });
  // observed: `Library "/nobody/nothing-xyz" not found. Please check the library ID or your access permissions.`
  const library = /Library\s+"([^"]+)"\s+not found/i.exec(trimmed);
  if (library) return failure("library_not_found", `Library ${library[1]} was not found, or the credential has no access to it.`, { libraryId: library[1]! });
  // observed: "Input validation error: Invalid arguments for tool query-docs: libraryId: Invalid input: ..."
  if (/input validation error|invalid arguments/i.test(trimmed)) return failure("invalid_arguments", trimmed.slice(0, 300));
  // not observed
  if (/rate limit|too many requests|quota (exceeded|reached)|\b429\b/i.test(trimmed)) return failure("rate_limited", "Context7 reported a rate limit or quota.");
  return failure("upstream_error", trimmed.slice(0, 300) || "Context7 reported an error without details.");
}

/** A transport or gateway error as `OperationResult` carries it (contract error code plus structured details). */
export interface GatewayErrorLike {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: unknown;
}

/** Maps a Gateway/driver error to a failure kind using the driver's structured `details.kind`. */
export function classifyGatewayError(error: GatewayErrorLike): DocsFailure {
  const details = (typeof error.details === "object" && error.details !== null ? error.details : {}) as Record<string, unknown>;
  const kind = typeof details["kind"] === "string" ? details["kind"] : undefined;
  const status = typeof details["status"] === "number" ? details["status"] : undefined;
  const retryAfterMs = typeof details["retryAfterMs"] === "number" ? details["retryAfterMs"] : undefined;
  const extra = { ...(status !== undefined ? { status } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  switch (kind) {
    case "auth_missing": return failure("auth_missing", "The Context7 API key is configured but not available to the Gateway.", extra);
    case "auth_rejected": return failure("auth_invalid", "Context7 rejected the API key.", extra);
    case "rate_limited": return failure("rate_limited", "Context7 rate limit reached.", extra);
    case "network": return failure("network", error.message, extra);
    case "timeout": return failure("timeout", error.message, extra);
    case "protocol": return failure("protocol", error.message, extra);
    case "upstream_http": case "session_lost": return failure("upstream_error", error.message, extra);
    case "cancelled": return failure("unavailable", "The request was cancelled.", extra);
    default: break;
  }
  if (error.code === "timeout") return failure("timeout", error.message);
  if (error.code === "not_found") return failure("unavailable", error.message);
  if (error.code === "validation" && /not (granted|allowed|authori[sz]ed|offered)|registration|bearer token|permission/i.test(error.message))
    return failure("permission_denied", error.message);
  if (error.code === "transport_unavailable") return failure("unavailable", error.message);
  return failure("upstream_error", error.message);
}
