import type { ContractError, JsonValue, OperationResult } from "@bflow/contracts";

export function ok<T>(value: T): OperationResult<T> {
  return { ok: true, value };
}

type SimpleCode = "validation" | "conflict" | "not_found" | "corruption" | "transport_unavailable" | "cancelled";
const RETRYABLE: Record<SimpleCode, boolean> = {
  validation: false, conflict: true, not_found: false, corruption: false, transport_unavailable: true, cancelled: false
};

/** ContractError with the retryability fixed by its code, as the contract schema requires. */
export function fail<T = never>(code: SimpleCode, message: string, details?: JsonValue): OperationResult<T> {
  const error = { code, retryable: RETRYABLE[code], message, ...(details !== undefined ? { details } : {}) } as ContractError;
  return { ok: false, error };
}

export function failWith<T = never>(error: ContractError): OperationResult<T> {
  return { ok: false, error };
}
