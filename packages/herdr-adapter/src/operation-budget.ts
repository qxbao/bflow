import type { OperationOptions, OperationResult } from "@bflow/contracts";

/** Normalize a relative timeout once, so every substep shares one deadline. */
export function operationBudget<T extends OperationOptions>(
  options: T | undefined, clock: () => Date, defaultTimeoutMs: number
): OperationResult<T & OperationOptions> {
  const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
  const absolute = options?.deadline === undefined ? Infinity : Date.parse(options.deadline);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || (options?.deadline !== undefined && !Number.isFinite(absolute))) {
    return { ok: false, error: { code: "validation", retryable: false, message: "Invalid operation timeout or deadline" } };
  }
  if (options?.signal?.aborted) return { ok: false, error: { code: "cancelled", retryable: false, message: "Operation aborted before start" } };
  const current = clock().getTime();
  const end = Math.min(current + timeoutMs, absolute);
  if (end <= current) return { ok: false, error: { code: "timeout", retryable: true, retrySafety: "not_started", message: "Operation deadline elapsed before start" } };
  if (!Number.isFinite(end) || end > 8.64e15) return { ok: false, error: { code: "validation", retryable: false, message: "Operation deadline exceeds supported range" } };
  return { ok: true, value: { ...options, timeoutMs, deadline: new Date(end).toISOString() } as T & OperationOptions };
}
