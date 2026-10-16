import type { OperationOptions, OperationResult } from "@bflow/contracts";

interface PendingAcquisition {
  readonly resolve: (result: OperationResult<() => void>) => void;
  readonly key?: string | undefined;
  readonly options?: OperationOptions | undefined;
  cleanup?: (() => void) | undefined;
}

export class BoundedConcurrencyLimiter {
  private readonly _maxConcurrency: number;
  private _activeCount: number = 0;
  private _isQuiescing: boolean = false;
  private readonly _activeKeyList: string[] = [];
  private readonly _queue: PendingAcquisition[] = [];
  private _quiesceWaiters: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error(`maxConcurrency must be an integer >= 1, received: ${maxConcurrency}`);
    }
    this._maxConcurrency = maxConcurrency;
  }

  public get maxConcurrency(): number {
    return this._maxConcurrency;
  }

  public get activeCount(): number {
    return this._activeCount;
  }

  public get pendingCount(): number {
    return this._queue.length;
  }

  public get isQuiescing(): boolean {
    return this._isQuiescing;
  }

  public get activeKeys(): readonly string[] {
    return [...this._activeKeyList];
  }

  private _createRelease(key?: string): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this._activeCount--;
      if (key !== undefined) {
        const idx = this._activeKeyList.indexOf(key);
        if (idx >= 0) {
          this._activeKeyList.splice(idx, 1);
        }
      }
      this._checkQuiesce();
      this._drainQueue();
    };
  }

  private _checkQuiesce(): void {
    if (this._isQuiescing && this._activeCount === 0) {
      const waiters = [...this._quiesceWaiters];
      this._quiesceWaiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    }
  }

  private _drainQueue(): void {
    if (this._isQuiescing) {
      return;
    }
    while (this._queue.length > 0 && this._activeCount < this._maxConcurrency) {
      const next = this._queue.shift();
      if (!next) {
        break;
      }
      if (next.cleanup) {
        next.cleanup();
      }
      this._activeCount++;
      if (next.key !== undefined) {
        this._activeKeyList.push(next.key);
      }
      const release = this._createRelease(next.key);
      next.resolve({ ok: true, value: release });
    }
  }

  public async acquire(
    key?: string,
    options?: OperationOptions
  ): Promise<OperationResult<() => void>> {
    if (this._isQuiescing) {
      return {
        ok: false,
        error: {
          code: "conflict",
          retryable: true,
          message: "Concurrency limiter is quiescing"
        }
      };
    }

    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: {
          code: "cancelled",
          retryable: false,
          message: "Acquisition aborted"
        }
      };
    }

    if (this._activeCount < this._maxConcurrency) {
      this._activeCount++;
      if (key !== undefined) {
        this._activeKeyList.push(key);
      }
      return {
        ok: true,
        value: this._createRelease(key)
      };
    }

    return new Promise<OperationResult<() => void>>((resolve) => {
      const pending: PendingAcquisition = {
        resolve,
        ...(key !== undefined ? { key } : {}),
        ...(options !== undefined ? { options } : {})
      };

      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (onAbort !== undefined && options?.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
      };
      pending.cleanup = cleanup;

      if (options?.signal) {
        onAbort = () => {
          cleanup();
          const idx = this._queue.indexOf(pending);
          if (idx >= 0) {
            this._queue.splice(idx, 1);
            resolve({
              ok: false,
              error: {
                code: "cancelled",
                retryable: false,
                message: "Acquisition aborted"
              }
            });
          }
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          const idx = this._queue.indexOf(pending);
          if (idx >= 0) {
            this._queue.splice(idx, 1);
            resolve({
              ok: false,
              error: {
                code: "timeout",
                retryable: true,
                retrySafety: "observation_only",
                message: `Acquisition timed out after ${options.timeoutMs}ms`
              }
            });
          }
        }, options.timeoutMs);
      }

      this._queue.push(pending);
    });
  }

  public async run<T>(
    fn: () => Promise<OperationResult<T>>,
    key?: string,
    options?: OperationOptions
  ): Promise<OperationResult<T>> {
    const acq = await this.acquire(key, options);
    if (!acq.ok) {
      return { ok: false, error: acq.error };
    }
    const release = acq.value;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  public async quiesce(options?: OperationOptions): Promise<OperationResult<void>> {
    this._isQuiescing = true;

    // Reject any queued acquisitions waiting for a slot
    while (this._queue.length > 0) {
      const pending = this._queue.shift()!;
      if (pending.cleanup) {
        pending.cleanup();
      }
      pending.resolve({
        ok: false,
        error: {
          code: "conflict",
          retryable: true,
          message: "Concurrency limiter is quiescing"
        }
      });
    }

    if (this._activeCount === 0) {
      return { ok: true, value: undefined };
    }

    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: {
          code: "cancelled",
          retryable: false,
          message: "Quiesce aborted"
        }
      };
    }

    return new Promise<OperationResult<void>>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;

      const onDone = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (onAbort !== undefined && options?.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
        resolve({ ok: true, value: undefined });
      };

      if (options?.signal) {
        onAbort = () => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          const idx = this._quiesceWaiters.indexOf(onDone);
          if (idx >= 0) {
            this._quiesceWaiters.splice(idx, 1);
          }
          resolve({
            ok: false,
            error: {
              code: "cancelled",
              retryable: false,
              message: "Quiesce aborted"
            }
          });
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (onAbort !== undefined && options?.signal) {
            options.signal.removeEventListener("abort", onAbort);
          }
          const idx = this._quiesceWaiters.indexOf(onDone);
          if (idx >= 0) {
            this._quiesceWaiters.splice(idx, 1);
          }
          resolve({
            ok: false,
            error: {
              code: "timeout",
              retryable: true,
              retrySafety: "observation_only",
              message: `Quiesce timed out after ${options.timeoutMs}ms`
            }
          });
        }, options.timeoutMs);
      }

      this._quiesceWaiters.push(onDone);
    });
  }

  public resume(): void {
    this._isQuiescing = false;
    this._drainQueue();
  }
}
