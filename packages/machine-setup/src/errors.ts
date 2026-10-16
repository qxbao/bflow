import type { ContractError } from "@bflow/contracts";

type Details = Extract<ContractError, { code: "validation" }>["details"];

function withDetails<T extends object>(base: T, details: Details): T & { details?: Exclude<Details, undefined> } {
  return details === undefined ? base : { ...base, details };
}

export function validationError(message: string, details?: Details): ContractError {
  return withDetails({ code: "validation" as const, retryable: false as const, message }, details);
}

export function unsupportedVersion(
  message: string,
  receivedVersion: number,
  supportedVersions: readonly number[] = [3],
  details?: Details
): ContractError {
  return withDetails(
    {
      code: "unsupported_version" as const,
      retryable: false as const,
      supportedVersions: [...supportedVersions],
      receivedVersion,
      message
    },
    details
  );
}

export function conflictError(
  message: string,
  version?: { expected: number; actual: number },
  details?: Details
): ContractError {
  const base = { code: "conflict" as const, retryable: true as const, message };
  return withDetails(version ? { ...base, version } : base, details);
}

export function timeoutError(
  message: string,
  retrySafety: "not_started" | "observation_only" = "observation_only",
  details?: Details
): ContractError {
  return withDetails({ code: "timeout" as const, retryable: true as const, retrySafety, message }, details);
}

export function notFound(message: string, details?: Details): ContractError {
  return withDetails({ code: "not_found" as const, retryable: false as const, message }, details);
}

export function corruption(message: string, details?: Details): ContractError {
  return withDetails({ code: "corruption" as const, retryable: false as const, message }, details);
}
