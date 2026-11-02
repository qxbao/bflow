import { AgentRequestSchema, AgentSubmissionReceiptSchema, AgentReconciliationResultSchema, canonicalReceiptJson,
  type AgentRequest, type AgentSubmissionReceipt, type AgentReconciliationResult } from "@bflow/contracts";

/** Shared receipt ownership checks for implementation and read-only extension dispatch. */
export function parseSubmissionForRequest(requestInput: AgentRequest, input: unknown): AgentSubmissionReceipt {
  const request = AgentRequestSchema.parse(requestInput), receipt = AgentSubmissionReceiptSchema.parse(input);
  if (receipt.requestId !== request.requestId || receipt.attemptId !== request.attemptId ||
      receipt.runId !== request.runId || receipt.taskId !== request.taskId) throw new Error("Transport receipt ownership mismatch");
  if (receipt.status === "accepted" && (canonicalReceiptJson(receipt.handle.target) !== canonicalReceiptJson(request.target) ||
      receipt.handle.idempotencyKey !== request.idempotency.key)) throw new Error("Transport binding mismatch");
  return receipt;
}

export function parseReconciliationForRequest(requestInput: AgentRequest, input: unknown): AgentReconciliationResult {
  const request = AgentRequestSchema.parse(requestInput), result = AgentReconciliationResultSchema.parse(input);
  if (result.status === "bound") {
    const handle = result.handle;
    if (handle.requestId !== request.requestId || handle.attemptId !== request.attemptId || handle.runId !== request.runId ||
        handle.taskId !== request.taskId || handle.idempotencyKey !== request.idempotency.key ||
        canonicalReceiptJson(handle.target) !== canonicalReceiptJson(request.target)) throw new Error("Reconciled handle ownership mismatch");
  } else if (result.requestId !== request.requestId) throw new Error("Reconciliation request mismatch");
  return result;
}
