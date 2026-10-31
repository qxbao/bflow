import type { ContractError, OperationOptions, OperationResult } from "@bflow/contracts";
import { scheduleSafeTimeout } from "./operation-budget.js";

function fallbackFailure<T>(message: string): OperationResult<T> {
  return {
    ok: false,
    error: { code: "corruption", retryable: false, message }
  };
}

function safeCloneResult<T>(outcome: OperationResult<T>): OperationResult<T> {
  try {
    return structuredClone(outcome);
  } catch {
    return fallbackFailure("Operation outcome could not be cloned safely");
  }
}

function safeInvokeHandler<T>(fn: () => OperationResult<T>, fallbackMessage: string): OperationResult<T> {
  try {
    return safeCloneResult(fn());
  } catch {
    return fallbackFailure(fallbackMessage);
  }
}

/** Instance-local reservation. No external work starts until the key is installed. */
export class SingleFlight<T> {
  readonly #entries = new Map<string, { fingerprint: string; result: Promise<OperationResult<T>> }>();
  readonly #fingerprints = new Map<string, string>();

  async execute(
    key: string, fingerprint: string, action: () => Promise<OperationResult<T>>,
    onError: (error: unknown) => OperationResult<T>,
    observer?: { options: OperationOptions; clock: () => Date; interrupted: () => OperationResult<T> }
  ): Promise<OperationResult<T>> {
    let entry = this.#entries.get(key);
    const priorFingerprint = this.#fingerprints.get(key);
    if (priorFingerprint !== undefined && priorFingerprint !== fingerprint) {
      const error: ContractError = { code: "conflict", retryable: true, message: "Idempotency key reused with different payload" };
      return { ok: false, error };
    }
    const joining = entry !== undefined;
    if (entry === undefined) {
      this.#fingerprints.set(key, fingerprint);
      const result = Promise.resolve()
        .then(action)
        .then(
          (outcome) => safeCloneResult(outcome),
          (error) => safeInvokeHandler(() => onError(error), "Single-flight error handler failed")
        );
      entry = { fingerprint, result };
      this.#entries.set(key, entry);
      // A definite pre-side-effect failure can be retried with the same payload.
      // Its identity remains reserved; uncertainty retains the original outcome.
      void result.then((outcome) => {
        if (!outcome.ok && outcome.error.code !== "unknown_delivery" && this.#entries.get(key) === entry) {
          this.#entries.delete(key);
        }
      });
    }
    if (!joining || observer === undefined) return safeCloneResult(await entry.result);
    // Cancelling a duplicate caller's wait must not cancel the shared command or
    // overwrite its receipt. A possible mutation remains uncertain to that caller.
    return new Promise<OperationResult<T>>((resolve) => {
      let settled = false;
      let cancelTimer: (() => void) | undefined;
      const finish = (outcome: OperationResult<T>) => {
        if (settled) return;
        settled = true;
        cancelTimer?.();
        observer.options.signal?.removeEventListener("abort", interrupt);
        resolve(safeCloneResult(outcome));
      };
      const interrupt = () =>
        finish(safeInvokeHandler(() => observer.interrupted(), "Single-flight interruption handler failed"));
      observer.options.signal?.addEventListener("abort", interrupt, { once: true });
      if (observer.options.signal?.aborted) interrupt();
      const remaining = observer.options.deadline === undefined ? Infinity
        : Date.parse(observer.options.deadline) - observer.clock().getTime();
      if (remaining <= 0) interrupt();
      else if (Number.isFinite(remaining) && !settled) {
        cancelTimer = scheduleSafeTimeout(interrupt, remaining);
      }
      void entry.result.then(
        finish,
        (error) => finish(safeInvokeHandler(() => onError(error), "Single-flight error handler failed"))
      );
    });
  }
}
