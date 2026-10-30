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

/**
 * Classifies the text of a tool result that the server flagged `isError`. The server answers HTTP 200 for all of these,
 * so the text is the only signal. The patterns are loose: DeepWiki's wording for an unindexed repository, a validation
 * failure or a limit was not exhaustively observed, and anything unrecognised stays a generic upstream error.
 */
export function classifyToolError(text: string): DocsFailure {
  const trimmed = text.trim();
  // An unindexed or private repository is answered with a "not found" style message; it is not a transport problem.
  if (/repo(sitory)?\b.*(not found|not indexed|does not exist|no access)|not found.*repo(sitory)?|has not been indexed/i.test(trimmed))
    return failure("library_not_found", "DeepWiki has no wiki for this repository. It may be private or not yet indexed.");
  if (/input validation error|invalid arguments/i.test(trimmed)) return failure("invalid_arguments", trimmed.slice(0, 300));
  if (/rate limit|too many requests|quota (exceeded|reached)|\b429\b/i.test(trimmed)) return failure("rate_limited", "DeepWiki reported a rate limit or quota.");
  // Unclassified upstream error text is untrusted and may echo request content: report it generically (fail closed).
  return failure("upstream_error", "DeepWiki reported an error for this request.");
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
    case "rate_limited": return failure("rate_limited", "DeepWiki rate limit reached.", extra);
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
