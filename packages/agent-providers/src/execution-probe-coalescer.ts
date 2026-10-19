import { createHash } from "node:crypto";
import { canonicalReceiptJson, type OperationOptions } from "@bflow/contracts";
import type { ProviderCommandInvocation, ProviderCommandOutcome, ProviderCommandRunner } from "./types.js";

interface ExecutionProbeRequest {
  /** Adapter-produced digest of the exact account, configuration and session observation. */
  readonly identity: string;
  readonly invocation: ProviderCommandInvocation;
  /** Recheck before accepting an observation or retrying; false blocks a changed context. */
  readonly isCurrent: () => Promise<boolean>;
}

export interface ProviderExecutionProbeCoalescer {
  /** Only the adapter's minimal readiness ping belongs here, never arbitrary provider commands. */
  probe(request: ExecutionProbeRequest, options?: OperationOptions): Promise<ProviderCommandOutcome>;
}

interface InFlightProbe {
  readonly controller: AbortController;
  readonly outcome: Promise<ProviderCommandOutcome>;
  waiters: number;
  completedAt?: number;
}

function interrupted(failure: "aborted" | "timeout"): ProviderCommandOutcome {
  return { exitCode: null, stdout: "", stderr: failure === "aborted" ? "Readiness probe cancelled" : "Readiness probe timed out",
    started: false, failure };
}

function changedContext(): ProviderCommandOutcome {
  return { exitCode: null, started: false, stdout: "", stderr: "Readiness probe context changed; run a fresh health check",
    failure: "invalid_arguments", cause: "Readiness probe context changed" };
}

function successful(outcome: ProviderCommandOutcome): boolean {
  return outcome.started && outcome.exitCode === 0 && outcome.failure === undefined;
}

/**
 * One host factory owns this object and its raw runner. Overlapping pings may share success;
 * completed successes require an explicit bounded TTL and fresh snapshot verification.
 * Authentication and role/native readiness never pass through this object. Each waiter has its
 * own cancellation/deadline; the shared process is cancelled only when no waiters remain,
 * and always has the normal bounded probe timeout.
 */
export function createProviderExecutionProbeCoalescer(options: {
  readonly runner: ProviderCommandRunner;
  /** Opt-in model execution success reuse only, 0 (default) through 30,000 ms. */
  readonly successfulResultTtlMs?: number;
}): ProviderExecutionProbeCoalescer {
  const ttl = options.successfulResultTtlMs ?? 0;
  if (!Number.isFinite(ttl) || ttl < 0 || ttl > 30_000) throw new RangeError("Successful execution probe TTL must be between 0 and 30000 ms");
  const running = new Map<string, InFlightProbe>();
  const completed = new Map<string, { outcome: ProviderCommandOutcome; completedAt: number }>();
  const prune = () => {
    const now = performance.now();
    for (const [key, entry] of completed) if (now - entry.completedAt >= ttl) completed.delete(key);
  };
  const remember = (key: string, outcome: ProviderCommandOutcome, completedAt: number) => {
    if (ttl === 0 || !successful(outcome) || performance.now() - completedAt >= ttl) return;
    prune();
    completed.set(key, { outcome: { ...outcome }, completedAt });
    while (completed.size > 128) completed.delete(completed.keys().next().value!);
  };
  return {
    async probe(request, operation) {
      const signal = operation?.signal;
      if (signal?.aborted) return interrupted("aborted");
      const timeoutMs = Math.min(request.invocation.timeoutMs ?? 75_000, operation?.timeoutMs ?? Infinity,
        operation?.deadline === undefined ? Infinity : Date.parse(operation.deadline) - Date.now());
      if (!(timeoutMs > 0)) return interrupted("timeout");

      const observationKey = () => createHash("sha256").update(canonicalReceiptJson({
        identity: request.identity,
        executable: request.invocation.executable,
        args: request.invocation.args,
        cwd: request.invocation.cwd ?? process.cwd(),
        // Snapshot the actual inherited environment too, including account selectors. Only its digest
        // is retained; no credentials or provider output are written to disk or diagnostics.
        env: { ...process.env, ...request.invocation.env },
        maxOutputBytes: request.invocation.maxOutputBytes ?? null
      })).digest("hex");
      const key = observationKey();
      prune();
      const cached = completed.get(key);
      let entry = running.get(key);
      const follower = entry !== undefined || cached !== undefined;
      if (entry === undefined && cached !== undefined) entry = {
        controller: new AbortController(), outcome: Promise.resolve(cached.outcome), waiters: 0, completedAt: cached.completedAt
      };
      if (entry === undefined) {
        const controller = new AbortController();
        const outcome = Promise.resolve().then(() => options.runner.run({
          ...request.invocation, signal: controller.signal, timeoutMs: request.invocation.timeoutMs ?? 75_000
        }));
        entry = { controller, outcome, waiters: 0 };
        running.set(key, entry);
        const current = entry;
        // Evict the in-flight entry immediately. Only a live waiter with a verified snapshot may retain success below.
        void outcome.then(() => {
          current.completedAt = performance.now();
          if (running.get(key) === current) running.delete(key);
        },
          () => { if (running.get(key) === current) running.delete(key); });
      }
      const current = entry;
      current.waiters++;
      const waiter = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;
      const cancellation = new Promise<ProviderCommandOutcome>(resolve => {
        stop = () => { waiter.abort(); resolve(interrupted("aborted")); };
        signal?.addEventListener("abort", stop, { once: true });
        timer = setTimeout(() => { waiter.abort(); resolve(interrupted("timeout")); }, Math.min(timeoutMs, 2_147_483_647));
        // Close the race between the initial check and listener installation.
        if (signal?.aborted) stop();
      });
      try {
        const observation = async (): Promise<ProviderCommandOutcome> => {
          let outcome: ProviderCommandOutcome;
          try { outcome = await current.outcome; }
          catch (error) {
            if (!follower) throw error;
            outcome = { ...interrupted("aborted"), cause: "Shared readiness probe did not complete" };
          }
          if (waiter.signal.aborted) return outcome;
          const isCurrent = async (): Promise<boolean> => {
            try { return observationKey() === key && await request.isCurrent() && observationKey() === key; }
            catch { return false; /* Uncertain configuration cannot establish proof. */ }
          };
          if (!await isCurrent()) { completed.delete(key); return changedContext(); }
          if (waiter.signal.aborted) return outcome;
          const expiredReuse = follower && ttl > 0 && current.completedAt !== undefined && performance.now() - current.completedAt >= ttl;
          if (!expiredReuse && (!follower || successful(outcome))) {
            if (current.completedAt !== undefined) remember(key, outcome, current.completedAt);
            return { ...outcome };
          }
          completed.delete(key);
          // A failed or expired shared observation is never the follower's own proof. This is a new
          // readiness ping, not a replay of a workflow mutation. It remains inside the waiter's budget.
          const ownOutcome = await options.runner.run({ ...request.invocation, signal: waiter.signal,
            timeoutMs: request.invocation.timeoutMs ?? 75_000 });
          const completedAt = performance.now();
          if (!await isCurrent()) { completed.delete(key); return changedContext(); }
          if (!waiter.signal.aborted) remember(key, ownOutcome, completedAt);
          return { ...ownOutcome };
        };
        return await Promise.race([observation(), cancellation]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (stop !== undefined) signal?.removeEventListener("abort", stop);
        current.waiters--;
        if (current.waiters === 0) {
          if (running.get(key) === current) running.delete(key);
          current.controller.abort();
        }
      }
    }
  };
}
