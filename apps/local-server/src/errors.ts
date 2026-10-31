import { randomUUID } from 'node:crypto';
import { WebApiErrorSchema, WebApiErrorStatus, type WebApiError } from '@bflow/contracts/web';
import type { ContractError, OperationResult } from '@bflow/contracts';

export class HttpError extends Error {
  constructor(readonly code: WebApiError['code'], readonly operationId?: string) { super(code); }
}
export function publicError(error: unknown): WebApiError {
  const code = error instanceof HttpError ? error.code : 'unavailable';
  return WebApiErrorSchema.parse({ apiVersion: 1, code, message: {
    invalid_request: 'Yêu cầu không hợp lệ.', session_required: 'Vui lòng mở lại phiên web.', forbidden: 'Yêu cầu không được phép.',
    not_found: 'Không tìm thấy tài nguyên.', stale_version: 'Dữ liệu đã thay đổi. Vui lòng tải lại.', operation_conflict: 'Mã thao tác đã được sử dụng.',
    payload_too_large: 'Yêu cầu vượt quá giới hạn.', operation_not_allowed: 'Thao tác chưa được hỗ trợ.', unavailable: 'Dịch vụ hiện không khả dụng.',
    reconciliation_required: 'Cần đối chiếu thao tác trước khi tiếp tục.'
  }[code], retryable: code === 'unavailable', correlationId: randomUUID(),
    ...(error instanceof HttpError && error.operationId ? { operationId: error.operationId } : {}) });
}
export { WebApiErrorStatus };
export function contractError(error: ContractError): HttpError {
  return new HttpError(({ validation: 'invalid_request', conflict: 'stale_version', not_found: 'not_found', unsupported_version: 'operation_not_allowed',
    unknown_delivery: 'reconciliation_required', corruption: 'unavailable', timeout: 'unavailable', cancelled: 'operation_not_allowed', transport_unavailable: 'unavailable' } as const)[error.code]);
}
export function unwrap<T>(result: OperationResult<T>): T { if (!result.ok) throw contractError(result.error); return result.value; }

/** Bounds waiting only. The underlying operation may continue; never infer non-delivery. */
export async function observeWithinDeadline<T>(call:()=>Promise<T>, deadlineMs = 5000):Promise<T> {
  let timer:ReturnType<typeof setTimeout> | undefined;
  try {return await Promise.race([Promise.resolve().then(call),new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>reject(new HttpError('unavailable')),deadlineMs);
  })]);} finally {if(timer)clearTimeout(timer);}
}
