import { createHash } from "node:crypto";
import { ContractErrorSchema, IsoDateTimeSchema, type ContractError, type OperationOptions, type OperationResult } from "@bflow/contracts";

export class ArtifactFailure extends Error {
  constructor(readonly error: ContractError) { super(error.message); }
}
export function fail(code: "validation" | "corruption" | "not_found", message: string): never {
  throw new ArtifactFailure({ code, message, retryable: false });
}
export function conflict(message: string): never { throw new ArtifactFailure({ code: "conflict", retryable: true, message }); }
export function parse<T>(schema: { parse(input: unknown): T }, input: unknown, stored = false): T {
  try { return schema.parse(input); } catch { return fail(stored ? "corruption" : "validation", stored ? "Invalid stored artifact payload" : "Invalid artifact input"); }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function fingerprint(value: unknown): string { return digest(JSON.stringify(canonical(value))); }
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function storedJson(payload: unknown, checksum: unknown): unknown {
  if (typeof payload !== "string" || digest(payload) !== checksum) fail("corruption", "Artifact catalog checksum mismatch");
  try { return JSON.parse(payload); } catch { return fail("corruption", "Artifact catalog is not JSON"); }
}
export function failure<T>(error: unknown): OperationResult<T> {
  if (error instanceof ArtifactFailure) return { ok: false, error: ContractErrorSchema.parse(error.error) };
  const code = typeof error === "object" && error !== null && "errcode" in error ? error.errcode : undefined;
  if (typeof code === "number" && [5, 6, 19].includes(code & 255)) {
    return { ok: false, error: { code: "conflict", retryable: true, message: "Artifact catalog is busy or identity conflicts" } };
  }
  return { ok: false, error: { code: "corruption", retryable: false, message: "Artifact storage operation failed",
    details: { cause: error instanceof Error ? error.name : "UnknownError" } } };
}
export class Budget {
  readonly end: number;
  constructor(readonly options: OperationOptions | undefined, readonly clock: () => number, observing = false) {
    const timeout = options?.timeoutMs;
    const deadline = options?.deadline === undefined ? Infinity : Date.parse(parse(IsoDateTimeSchema, options.deadline));
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0) || Number.isNaN(deadline)) fail("validation", "Invalid timeout or deadline");
    this.end = Math.min(timeout === undefined ? Infinity : clock() + timeout, deadline);
    this.check(observing);
  }
  check(observing = false): void {
    if (this.options?.signal?.aborted) throw new ArtifactFailure({ code: "cancelled", retryable: false, message: "Artifact operation cancelled" });
    if (this.clock() >= this.end) throw new ArtifactFailure({ code: "timeout", retryable: true,
      retrySafety: observing ? "observation_only" : "not_started",
      message: observing ? "Artifact observation deadline expired" : "Artifact deadline expired before catalog commit" });
  }
  remaining(maximum: number): number { this.check(); return Math.max(0, Math.min(maximum, Math.floor(this.end - this.clock()))); }
  /** Bound a stalled upstream iterator, using re-armed timers to avoid Node delay overflow. */
  async wait<T>(pending: Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new ArtifactFailure({ code: "cancelled", retryable: false, message: "Artifact stream cancelled" }));
      this.options?.signal?.addEventListener("abort", abort, { once: true });
      const arm = () => {
        const remaining = this.end - this.clock();
        if (remaining <= 0) reject(new ArtifactFailure({ code: "timeout", retryable: true, retrySafety: "not_started", message: "Artifact stream timed out" }));
        else if (Number.isFinite(remaining)) timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
      };
      arm();
    });
    try { const value = await Promise.race([pending, stopped]); this.check(); return value; }
    finally { if (timer !== undefined) clearTimeout(timer); if (abort !== undefined) this.options?.signal?.removeEventListener("abort", abort); }
  }
}
export function cursor(scope: string, after: string): string { return Buffer.from(JSON.stringify({ v: 1, scope, after })).toString("base64url"); }
export function afterCursor(input: string | undefined, scope: string): string {
  if (input === undefined) return "";
  try {
    const value: unknown = JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || !("v" in value) || value.v !== 1 || !("scope" in value) || value.scope !== scope ||
      !("after" in value) || typeof value.after !== "string") fail("validation", "Invalid artifact cursor");
    return value.after;
  } catch (error) { if (error instanceof ArtifactFailure) throw error; return fail("validation", "Invalid artifact cursor"); }
}
