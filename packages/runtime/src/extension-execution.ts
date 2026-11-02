import { AgentBindingReceiptSchema, AgentExecutionHandleSchema, AgentRequestSchema, ArtifactReferenceSchema, RoleMessageSchema,
  canonicalReceiptJson, type AgentExecutionHandle, type AgentRequest, type AgentBindingVerification } from "@bflow/contracts";
import type { NativeExtensionIntent, NativeExtensionOutcome, NativeExtensionRolePort } from "./agentic/extension-delivery.js";
import { parseNativeExtensionOutput } from "./agentic/extension-output.js";

/** Private SDK WAL. Intent identity survives replacement of the provisional ID by the actual native execution ID. */
export interface ExtensionExecution {
  intent: NativeExtensionIntent;
  request?: AgentRequest;
  phase: "prepared" | "sending" | "accepted" | "completed";
  handle?: AgentExecutionHandle;
  outcome?: NativeExtensionOutcome;
  verification?: AgentBindingVerification;
}

export function extensionIntent(family: "analysis" | "qa", sessionId: string, assignment: {
  runId: string; taskId: string; attemptId: string; executionId: string; role: string; permissions: { read: readonly string[] };
}, payload: unknown, occurredAt: string): NativeExtensionIntent {
  const id = `${family}-native-${assignment.executionId}`;
  return { family, runId: assignment.runId, taskId: assignment.taskId, attemptId: assignment.attemptId, requestKey: id,
    outputKind: `${family}.${assignment.taskId}`, allowedReadPaths: [...assignment.permissions.read],
    message: RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: `${sessionId}:${assignment.runId}`,
      run_id: assignment.runId, sender: { role: "coordinator" }, recipient: { role: assignment.role }, type: "delegation.request",
      payload, artifact_references: [], occurred_at: occurredAt, idempotency_key: id }) };
}

const same = (a: unknown, b: unknown) => canonicalReceiptJson(a) === canonicalReceiptJson(b);

/** Delivery proof remains owned by the native bridge; Core independently authenticates the binding receipt. */
export async function executeExtension(input: {
  execution: ExtensionExecution; port: NativeExtensionRolePort; save(): Promise<void>;
  bind(handle: AgentExecutionHandle): Promise<void>;
}): Promise<NativeExtensionOutcome> {
  const { execution: state, port, save, bind } = input;
  if (!state.request) { state.request = AgentRequestSchema.parse(await port.prepare(state.intent)); await save(); }
  const request = AgentRequestSchema.parse(state.request);
  if (request.runId !== state.intent.runId || request.taskId !== state.intent.taskId || request.attemptId !== state.intent.attemptId ||
      request.target.transport !== "herdr") throw new Error("Native SDK request ownership mismatch");
  let outcome: NativeExtensionOutcome | undefined;
  if (state.phase === "sending" || state.phase === "accepted" || state.phase === "completed") {
    const reconciliation = await port.reconcile(request.requestId);
    if (reconciliation.status === "completed") { outcome = reconciliation.outcome; state.handle = outcome.handle; }
    else if (reconciliation.status === "bound") state.handle = reconciliation.handle;
    else if (reconciliation.status === "unknown") throw new Error("Native SDK delivery is unknown; reconcile before resending");
    else {
      if (state.handle) throw new Error("Native delivery cannot become not_delivered after acceptance");
      state.phase = "prepared";
    }
  }
  if (!state.handle) {
    state.phase = "sending"; await save();
    state.handle = AgentExecutionHandleSchema.parse(await port.dispatch(request));
  }
  const handle = AgentExecutionHandleSchema.parse(state.handle);
  if (handle.requestId !== request.requestId || handle.attemptId !== request.attemptId || handle.runId !== request.runId ||
      handle.taskId !== request.taskId || handle.idempotencyKey !== request.idempotency.key || !same(handle.target, request.target))
    throw new Error("Native SDK handle does not match its prepared request");
  state.phase = "accepted"; await save();
  await bind(handle);
  const raw = outcome ?? await port.waitResult(request.requestId);
  const parsed: NativeExtensionOutcome = { handle: AgentExecutionHandleSchema.parse(raw.handle), receipt: AgentBindingReceiptSchema.parse(raw.receipt),
    receiptEvidence: ArtifactReferenceSchema.parse(raw.receiptEvidence), evidence: ArtifactReferenceSchema.parse(raw.evidence),
    sender: RoleMessageSchema.parse({ ...state.intent.message, sender: raw.sender, recipient: { role: "runtime" } }).sender, output: parseNativeExtensionOutput(state.intent, raw.output) };
  if (!same(parsed.handle, handle) || !same(parsed.receipt.handle, handle) || parsed.receipt.correlation.token !== state.intent.message.message_id ||
      parsed.sender.role !== state.intent.message.recipient.role || parsed.sender.agent_id !== handle.target.agentId ||
      parsed.sender.pane_id !== handle.target.paneId || [parsed.evidence, parsed.receiptEvidence].some(ref => ref.runId !== request.runId || ref.taskId !== request.taskId))
    throw new Error("Native SDK output/receipt correlation mismatch");
  state.outcome = parsed; state.phase = "completed"; await save();
  return parsed;
}
