import { createHash } from "node:crypto";
import { ContractErrorSchema, IsoDateTimeSchema, type ContractError, type OperationOptions, type OperationResult } from "@bflow/contracts";

export class StoreFailure extends Error {
  constructor(readonly error: ContractError) { super(error.message); }
}
export function fail(code: "validation" | "corruption" | "not_found", message: string): never {
  throw new StoreFailure({ code, message, retryable: false });
}
export function conflict(message: string, expected?: number, actual?: number): never {
  throw new StoreFailure({ code: "conflict", message, retryable: true,
    ...(expected === undefined || actual === undefined ? {} : { version: { expected, actual } }) });
}
export interface Parser<T> { parse(input: unknown): T }
export function parse<T>(schema: Parser<T>, input: unknown, stored = false): T {
  try { return schema.parse(input); }
  catch { return fail(stored ? "corruption" : "validation", stored ? "Stored payload is invalid" : "Invalid input payload"); }
}
export function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new StoreFailure(result.error);
  return result.value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}
export function fingerprint(value: unknown): string { return digest(JSON.stringify(canonical(value))); }
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function storedJson(payload: unknown, checksum: unknown): unknown {
  if (typeof payload !== "string" || typeof checksum !== "string" || digest(payload) !== checksum) fail("corruption", "Stored payload checksum mismatch");
  try { return JSON.parse(payload); } catch { return fail("corruption", "Stored payload is not JSON"); }
}
export function failure<T>(error: unknown): OperationResult<T> {
  if (error instanceof StoreFailure) return { ok: false, error: ContractErrorSchema.parse(error.error) };
  const code = typeof error === "object" && error !== null && "errcode" in error ? error.errcode : undefined;
  if (typeof code === "number" && [5, 6].includes(code & 255)) {
    return { ok: false, error: { code: "conflict", retryable: true, message: "SQLite writer is busy; retry the same idempotency key" } };
  }
  if (typeof code === "number" && (code & 255) === 19) {
    return { ok: false, error: { code: "conflict", retryable: true, message: "SQLite uniqueness or integrity constraint rejected the operation" } };
  }
  return { ok: false, error: { code: "corruption", retryable: false, message: "Storage operation failed", details: {
    cause: error instanceof Error ? error.name : "UnknownError"
  } } };
}

/** One budget, including lock acquisition; zero timeout means no time to start. */
export class Budget {
  readonly end: number;
  constructor(readonly options: OperationOptions | undefined, readonly clock: () => number) {
    const timeout = options?.timeoutMs;
    const deadline = options?.deadline === undefined ? Infinity : Date.parse(parse(IsoDateTimeSchema, options.deadline));
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0) || Number.isNaN(deadline)) fail("validation", "Invalid timeout or deadline");
    this.end = Math.min(timeout === undefined ? Infinity : clock() + timeout, deadline);
    this.check();
  }
  check(): void {
    if (this.options?.signal?.aborted) throw new StoreFailure({ code: "cancelled", retryable: false, message: "Operation cancelled" });
    if (this.clock() >= this.end) throw new StoreFailure({ code: "timeout", retryable: true, retrySafety: "not_started", message: "Deadline expired before commit" });
  }
  remaining(maximum: number): number { this.check(); return Math.max(0, Math.min(maximum, Math.floor(this.end - this.clock()))); }
}

export function cursor(scope: string, position: string | number): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, position })).toString("base64url");
}
export function position(input: string | undefined, scope: string): unknown {
  if (input === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || !("v" in decoded) || decoded.v !== 1 ||
      !("scope" in decoded) || decoded.scope !== scope || !("position" in decoded)) fail("validation", "Invalid or foreign cursor");
    return decoded.position;
  } catch (error) { if (error instanceof StoreFailure) throw error; return fail("validation", "Invalid cursor"); }
}
