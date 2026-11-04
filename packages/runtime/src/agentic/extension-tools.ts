import { AgentBindingReceiptSchema, AgentExecutionHandleSchema, AgentRequestSchema, PaneBindingSchema, RoleMessageSchema,
  type PaneBinding } from "@bflow/contracts";
import { digest, json, record, type Outbound } from "./journal.js";
import { parseNativeExtensionOutput } from "./extension-output.js";

/** Prepares a request for the native plugin to sign; the placeholder signature is never authenticated evidence. */
export function prepareNativeExtensionOutput(bindingInput: PaneBinding, outbound: Outbound, input: unknown, issuerId: string) {
  const binding = PaneBindingSchema.parse(bindingInput), message = RoleMessageSchema.parse(outbound.message);
  if (outbound.status !== "accepted" || !outbound.request || !outbound.handle) throw new Error("Native extension output requires an accepted assignment");
  const request = AgentRequestSchema.parse(outbound.request), handle = AgentExecutionHandleSchema.parse(outbound.handle);
  const intent = record(record(message.payload).intent);
  if (record(message.payload).kind !== "extension.assignment" || intent.runId !== request.runId || intent.taskId !== request.taskId ||
      intent.attemptId !== request.attemptId || message.run_id !== request.runId || request.requestId !== handle.requestId ||
      request.attemptId !== handle.attemptId || request.runId !== handle.runId || request.taskId !== handle.taskId ||
      digest(request.target) !== digest(handle.target) || handle.target.transport !== "herdr" ||
      handle.target.agentId !== binding.agentId || handle.target.paneId !== binding.paneId || digest(handle.target.session) !== digest(binding.session) ||
      binding.role !== request.role || message.recipient.role !== binding.role || message.recipient.agent_id !== binding.agentId ||
      message.recipient.pane_id !== binding.paneId || !binding.readOnlyWorkspace)
    throw new Error("Native extension output actor/binding scope mismatch");
  const output = parseNativeExtensionOutput({ family: String(intent.family), taskId: request.taskId }, input);
  const at = new Date().toISOString();
  const receipt = AgentBindingReceiptSchema.parse({ schemaVersion: 1, receiptId: `binding-${handle.requestId}`, issuerId, handle,
    correlation: { token: message.message_id, provenance: "transport", verified: true }, observedAt: at,
    signature: { algorithm: "ed25519", value: Buffer.alloc(64).toString("base64") } });
  const envelope = (type: "execution.receipt" | "spec.draft", payload: unknown, suffix: string) => RoleMessageSchema.parse({
    schema_version: 2, message_id: `extension-${suffix}-${digest(request.requestId)}`, correlation_id: message.correlation_id,
    causation_id: message.message_id, run_id: message.run_id, sender: { role: binding.role, agent_id: binding.agentId, pane_id: binding.paneId },
    recipient: { role: "coordinator" }, type, payload: json(payload), artifact_references: [], occurred_at: at,
    idempotency_key: `extension-${suffix}:${request.requestId}` });
  return { binding: envelope("execution.receipt", receipt, "binding"),
    output: envelope("spec.draft", { kind: "extension.result", requestId: request.requestId, output }, "output"),
    bindingOperationId: `extension-binding:${request.requestId}`, outputOperationId: `extension-output:${request.requestId}` };
}
