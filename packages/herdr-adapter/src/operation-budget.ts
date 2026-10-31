import type { OperationOptions, OperationResult } from "@bflow/contracts";

const MAX_TIMEOUT_SLICE_MS = 2_147_483_647;
const MAX_DATE_EPOCH_MS = 8.64e15;

/**
 * Schedules a timeout without overflowing Node's signed 32-bit `setTimeout` limit (2,147,483,647 ms).
 * Chains bounded slices until the full delay has elapsed and returns an idempotent cancel function.
 */
export function scheduleSafeTimeout(callback: () => void, delayMs: number): () => void {
  let cancelled = false;
  let remaining = Math.max(1, Math.ceil(delayMs));
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (cancelled) return;
    const slice = Math.min(remaining, MAX_TIMEOUT_SLICE_MS);
    remaining -= slice;
    timer = setTimeout(() => {
      timer = undefined;
      if (cancelled) return;
      if (remaining > 0) {
        arm();
      } else {
        callback();
      }
    }, slice);
  };

  arm();

  return () => {
    cancelled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

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
  if (!Number.isFinite(current) || Math.abs(current) > MAX_DATE_EPOCH_MS) {
    return { ok: false, error: { code: "validation", retryable: false, message: "Operation clock exceeds supported Date range" } };
  }
  const rawEnd = Math.min(current + timeoutMs, absolute);
  if (rawEnd <= current) return { ok: false, error: { code: "timeout", retryable: true, retrySafety: "not_started", message: "Operation deadline elapsed before start" } };
  const end = Math.ceil(rawEnd);
  if (!Number.isFinite(end) || Math.abs(end) > MAX_DATE_EPOCH_MS) {
    return { ok: false, error: { code: "validation", retryable: false, message: "Operation deadline exceeds supported range" } };
  }
  const boundedTimeoutMs = Math.min(timeoutMs, end - current);
  return { ok: true, value: { ...options, timeoutMs: boundedTimeoutMs, deadline: new Date(end).toISOString() } as T & OperationOptions };
}

/** Validate SemVer 2.0.0, allowing an optional leading v. */
export function isSafeSemver(input: string): boolean {
  // The final assertion also rejects a trailing newline, which $ alone allows.
  return typeof input === "string" && /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$(?![\s\S])/.test(input);
}
