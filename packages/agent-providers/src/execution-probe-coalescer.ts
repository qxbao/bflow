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
 * One host factory owns this object and its raw runner. Only overlapping pings may share success;
 * completed observations are immediately evicted. Authentication and role/native readiness never
 * pass through this object. Each waiter has its own cancellation/deadline; the shared process is
 * cancelled only when no waiters remain, and always has the normal bounded probe timeout.
 */
export function createProviderExecutionProbeCoalescer(options: {
  readonly runner: ProviderCommandRunner;
}): ProviderExecutionProbeCoalescer {
  const running = new Map<string, InFlightProbe>();
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
      let entry = running.get(key);
      const follower = entry !== undefined;
      if (entry === undefined) {
        const controller = new AbortController();
        const outcome = Promise.resolve().then(() => options.runner.run({
          ...request.invocation, signal: controller.signal, timeoutMs: request.invocation.timeoutMs ?? 75_000
        }));
        entry = { controller, outcome, waiters: 0 };
        running.set(key, entry);
        const current = entry;
        // Both fulfillment and rejection evict immediately; do not retain failed/cancelled probes.
        void outcome.then(() => { if (running.get(key) === current) running.delete(key); },
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
            try { return observationKey() === key && await request.isCurrent(); }
            catch { return false; /* Uncertain configuration cannot establish proof. */ }
          };
          if (!await isCurrent()) return changedContext();
          if (waiter.signal.aborted) return outcome;
          if (!follower || successful(outcome)) return outcome;
          // A failed shared observation is never the follower's own proof. This is a new
          // readiness ping, not a replay of a workflow mutation. It remains inside the waiter's budget.
          const ownOutcome = await options.runner.run({ ...request.invocation, signal: waiter.signal,
            timeoutMs: request.invocation.timeoutMs ?? 75_000 });
          return await isCurrent() ? ownOutcome : changedContext();
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
