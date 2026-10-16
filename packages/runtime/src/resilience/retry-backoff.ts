import {
  RetryPolicySchema,
  type ContractError,
  type OperationOptions,
  type OperationResult,
  type RetryPolicy
} from "@bflow/contracts";

export function computeBackoffDelayMs(
  policy: RetryPolicy,
  attempt: number,
  random?: () => number
): number {
  const validated = RetryPolicySchema.parse(policy);
  const normalizedAttempt = Math.max(1, attempt);
  const rand = random ?? Math.random;

  let rawDelay: number;
  switch (validated.strategy) {
    case "fixed":
      rawDelay = validated.initialDelayMs;
      break;
    case "linear":
      rawDelay = validated.initialDelayMs * normalizedAttempt;
      break;
    case "exponential": {
      const multiplier = validated.multiplier ?? 2;
      rawDelay = validated.initialDelayMs * Math.pow(multiplier, normalizedAttempt - 1);
      break;
    }
  }

  const clamped = Math.min(validated.maxDelayMs, rawDelay);

  if (validated.jitter) {
    const r = rand();
    const factor = 0.5 + 0.5 * r;
    const jittered = Math.floor(clamped * factor);
    return Math.max(0, Math.min(validated.maxDelayMs, jittered));
  }

  return clamped;
}

export function isRetryEligible(
  error: ContractError,
  policy: RetryPolicy,
  attempt: number
): { readonly eligible: boolean; readonly reason: string } {
  if (attempt >= policy.maxAttempts) {
    return {
      eligible: false,
      reason: `Max attempts reached (${attempt}/${policy.maxAttempts})`
    };
  }

  if (!error.retryable) {
    return {
      eligible: false,
      reason: `Error code "${error.code}" is not retryable`
    };
  }

  const err = error as {
    readonly code: string;
    readonly retryable: boolean;
    readonly manualInterventionRequired?: boolean | undefined;
    readonly retrySafety?: string | undefined;
  };

  if (
    err.code === "unknown_delivery" ||
    err.manualInterventionRequired === true ||
    err.retrySafety === "manual_intervention_only" ||
    err.retrySafety === "after_reconciliation"
  ) {
    return {
      eligible: false,
      reason: `Error code "${error.code}" with retrySafety "${err.retrySafety ?? "unknown"}" requires manual intervention or reconciliation before retry`
    };
  }

  if (policy.retryableErrorCodes && policy.retryableErrorCodes.length > 0) {
    if (!policy.retryableErrorCodes.includes(error.code)) {
      return {
        eligible: false,
        reason: `Error code "${error.code}" is not in configured retryableErrorCodes: [${policy.retryableErrorCodes.join(", ")}]`
      };
    }
  }

  return {
    eligible: true,
    reason: "Error is eligible for retry"
  };
}

export async function withOperationTimeout<T>(
  operation: (options: OperationOptions) => Promise<OperationResult<T>>,
  timeoutMs: number,
  options?: OperationOptions & {
    /** @deprecated Accepted for source compatibility; timeout always returns unknown_delivery. */
    readonly onTimeoutCode?: ContractError["code"] | undefined;
    readonly timeoutMessage?: string | undefined;
  }
): Promise<OperationResult<T>> {
  if (options?.signal?.aborted) {
    return {
      ok: false,
      error: {
        code: "cancelled",
        retryable: false,
        message: "Operation was aborted prior to execution"
      }
    };
  }

  const controller = new AbortController();
  let onParentAbort: (() => void) | undefined;
  if (options?.signal) {
    onParentAbort = () => controller.abort();
    options.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  let timeoutId: NodeJS.Timeout | undefined;
  let didTimeout = false;

  const timeoutPromise = new Promise<OperationResult<T>>((resolve) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
      const message = options?.timeoutMessage ?? `Operation timed out after ${timeoutMs}ms`;
      // Aborting the local wait does not prove the operation stopped or was not delivered.
      const error: ContractError = {
        code: "unknown_delivery",
        retryable: false,
        manualInterventionRequired: true,
        message
      };
      resolve({ ok: false, error });
    }, timeoutMs);
  });

  const operationPromise = (async (): Promise<OperationResult<T>> => {
    try {
      const opOptions: OperationOptions = {
        signal: controller.signal,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(options?.deadline !== undefined ? { deadline: options.deadline } : {})
      };
      return await operation(opOptions);
    } catch (err) {
      if (didTimeout) {
        return new Promise<OperationResult<T>>(() => {});
      }
      return {
        ok: false,
        error: {
          code: controller.signal.aborted ? "cancelled" : "corruption",
          retryable: false,
          message: err instanceof Error ? err.message : String(err)
        }
      };
    }
  })();

  try {
    return await Promise.race([timeoutPromise, operationPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (onParentAbort !== undefined && options?.signal) {
      options.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(new Error("Operation aborted"));
    };
    timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
};

export async function executeWithRetry<T>(
  operation: (attempt: number, options: OperationOptions) => Promise<OperationResult<T>>,
  config: {
    readonly policy: RetryPolicy;
    readonly options?: OperationOptions | undefined;
    readonly random?: (() => number) | undefined;
    readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
    readonly onRetry?: ((info: { attempt: number; delayMs: number; error: ContractError }) => void) | undefined;
  }
): Promise<OperationResult<T> & { readonly attempts: number; readonly totalDelayMs: number }> {
  const validatedPolicy = RetryPolicySchema.parse(config.policy);
  const sleepFn = config.sleep ?? defaultSleep;
  const opOptions = config.options ?? {};

  let attempt = 1;
  let totalDelayMs = 0;

  let result = await operation(attempt, opOptions);

  while (attempt < validatedPolicy.maxAttempts) {
    if (result.ok) {
      break;
    }

    const currentError = result.error;
    const eligibility = isRetryEligible(currentError, validatedPolicy, attempt);
    if (!eligibility.eligible) {
      break;
    }

    const delayMs = computeBackoffDelayMs(validatedPolicy, attempt, config.random);
    config.onRetry?.({ attempt, delayMs, error: currentError });

    try {
      await sleepFn(delayMs, opOptions.signal);
    } catch {
      return {
        ok: false,
        error: {
          code: "cancelled",
          retryable: false,
          message: "Operation was cancelled during retry backoff"
        },
        attempts: attempt,
        totalDelayMs
      };
    }

    totalDelayMs += delayMs;
    attempt++;
    result = await operation(attempt, opOptions);
  }

  return {
    ...result,
    attempts: attempt,
    totalDelayMs
  };
}
