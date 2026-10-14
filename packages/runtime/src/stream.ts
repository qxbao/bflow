import {
  IdentifierSchema,
  type AgentReadOptions,
  type DomainEvent,
  type OperationResult,
  type RunStore
} from "@ai-flow/contracts";

export interface RunEventHub {
  publish(runId: string, events: readonly DomainEvent[]): void;
  subscribe(runId: string, listener: (events: readonly DomainEvent[]) => void): () => void;
}

export class DefaultRunEventHub implements RunEventHub {
  private readonly listeners = new Map<string, Set<(events: readonly DomainEvent[]) => void>>();

  publish(runId: string, events: readonly DomainEvent[]): void {
    const runListeners = this.listeners.get(runId);
    if (!runListeners || events.length === 0) return;
    for (const listener of [...runListeners]) {
      try {
        listener(events);
      } catch {
        // Listener errors must not disrupt publication to other subscribers
      }
    }
  }

  subscribe(runId: string, listener: (events: readonly DomainEvent[]) => void): () => void {
    let runListeners = this.listeners.get(runId);
    if (!runListeners) {
      runListeners = new Set();
      this.listeners.set(runId, runListeners);
    }
    runListeners.add(listener);
    return () => {
      const set = this.listeners.get(runId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(runId);
      }
    };
  }
}

export interface DomainEventStreamOptions extends AgentReadOptions {
  readonly maxBufferSize?: number | undefined;
}

export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T | undefined) => void> = [];
  private closed = false;
  private readonly maxBufferSize: number;
  private readonly signal?: AbortSignal | undefined;
  private readonly abortListener?: () => void;

  constructor(options?: { signal?: AbortSignal | undefined; maxBufferSize?: number | undefined }) {
    this.maxBufferSize = Math.max(1, options?.maxBufferSize ?? 1000);
    if (options?.signal) {
      this.signal = options.signal;
      if (this.signal.aborted) {
        this.close();
      } else {
        this.abortListener = () => {
          this.close();
        };
        this.signal.addEventListener("abort", this.abortListener, { once: true });
      }
    }
  }

  push(item: T, options?: { force?: boolean } | boolean): boolean {
    if (this.closed) return false;
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(item);
      return true;
    }
    const force = typeof options === "boolean" ? options : (options?.force ?? false);
    if (!force && this.items.length >= this.maxBufferSize) {
      return false; // Backpressure limit reached
    }
    this.items.push(item);
    return true;
  }

  forcePush(item: T): boolean {
    return this.push(item, { force: true });
  }

  async pop(): Promise<T | undefined> {
    if (this.items.length > 0) {
      return this.items.shift();
    }
    if (this.closed) {
      return undefined;
    }
    return new Promise<T | undefined>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.signal && this.abortListener) {
      this.signal.removeEventListener("abort", this.abortListener);
    }
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(undefined);
    }
    this.items.length = 0;
  }
}

export async function* createDomainEventStream(
  ports: { readonly runStore: RunStore },
  hub: RunEventHub,
  runId: string,
  options?: DomainEventStreamOptions
): AsyncIterable<OperationResult<DomainEvent>> {
  const parsedRunId = IdentifierSchema.safeParse(runId);
  if (!parsedRunId.success) {
    yield {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: `Invalid runId: ${runId}`
      }
    };
    return;
  }

  const signal = options?.signal;
  if (signal?.aborted) {
    yield {
      ok: false,
      error: {
        code: "cancelled",
        retryable: false,
        message: "Watch cancelled before stream start"
      }
    };
    return;
  }

  const maxBufferSize = Math.max(1, options?.maxBufferSize ?? 1000);
  const queue = new AsyncQueue<OperationResult<DomainEvent>>({
    signal,
    maxBufferSize
  });

  let lastYieldedSequence = options?.afterSequence ?? 0;
  let overflowed = false;

  // Subscribe BEFORE querying historical events to eliminate delivery gap window
  const unsubscribe = hub.subscribe(runId, (events) => {
    if (overflowed) return;
    for (const event of events) {
      if (overflowed) return;
      if (event.sequence > lastYieldedSequence) {
        const enqueued = queue.push({ ok: true, value: event });
        if (!enqueued) {
          overflowed = true;
          queue.push(
            {
              ok: false,
              error: {
                code: "validation",
                retryable: false,
                message: `Event buffer overflow for runId: ${runId}`
              }
            },
            { force: true }
          );
          return;
        }
      }
    }
  });

  try {
    // 1. Replay historical events from RunStore
    let cursor: string | undefined = options?.resumeCursor;
    let hasMoreHistory = true;

    while (hasMoreHistory) {
      if (signal?.aborted) break;
      const historyResult = await ports.runStore.readEvents(runId, { cursor, limit: 100 }, options);
      if (!historyResult.ok) {
        if (historyResult.error.code === "not_found") {
          hasMoreHistory = false;
          break;
        }
        yield historyResult;
        return;
      }
      for (const event of historyResult.value.items) {
        if (event.sequence > lastYieldedSequence) {
          lastYieldedSequence = event.sequence;
          yield { ok: true, value: event };
        }
      }
      cursor = historyResult.value.nextCursor;
      hasMoreHistory = cursor !== undefined && historyResult.value.items.length > 0;
    }

    // 2. Check if run is already terminal in stored snapshot
    const storedRunResult = await ports.runStore.get(runId, options);
    if (!storedRunResult.ok) {
      yield storedRunResult;
      return;
    }
    if (storedRunResult.value !== null) {
      const currentSnapshot = storedRunResult.value.snapshot;
      const isTerminal = ["succeeded", "failed", "cancelled"].includes(currentSnapshot.status);
      if (isTerminal && lastYieldedSequence >= currentSnapshot.lastEventSequence) {
        return;
      }
    }

    // 3. Stream live events
    while (true) {
      if (signal?.aborted) break;
      const nextResult = await queue.pop();
      if (nextResult === undefined) break; // queue closed
      if (!nextResult.ok) {
        yield nextResult;
        return;
      }
      const event = nextResult.value;
      if (event.sequence > lastYieldedSequence) {
        lastYieldedSequence = event.sequence;
        yield nextResult;

        if (
          event.type === "run.status_changed" &&
          ["succeeded", "failed", "cancelled"].includes(event.payload.to)
        ) {
          break;
        }
      }
    }
  } finally {
    unsubscribe();
    queue.close();
  }
}
