import { DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema, type RoleMessage } from "@bflow/contracts";
import { digest, record } from "./journal.js";
import { assignmentsForBinding } from "./assignment-survey.js";

/** Select a current physical delivery; the caller authenticates its exact persisted request/binding. */
export function selectExtensionCoordinatorDelivery(input: {
  outbound: readonly unknown[]; run: unknown; delegation: unknown; binding: unknown;
}): RoleMessage {
  const delegation = DelegationRequestSchema.parse(input.delegation), binding = PaneBindingSchema.parse(input.binding);
  const run = record(input.run), outbound = input.outbound.map(record);
  if (binding.role !== "coordinator" || run.runId !== delegation.runId || run.cancelled || run.supersededBy ||
      ["completed", "failed", "cancelled"].includes(String(run.status)) ||
      digest(DelegationRequestSchema.parse(run.delegation)) !== digest(delegation))
    throw new Error("Extension delegation is not the current active run");
  const approval = run.approval === undefined ? {} : record(run.approval);
  const decision = run.decision === undefined ? {} : record(run.decision);
  const userDecisions = run.userDecisions === undefined ? {} : record(run.userDecisions);
  if (approval.approvalId && decision.approvalId !== approval.approvalId ||
      Object.values(userDecisions).some(value => record(value).status === "pending"))
    throw new Error("Extension cannot bypass a pending human decision");
  if (Array.isArray(run.nativeDeliveries) && run.nativeDeliveries.length > 0 ||
      outbound.some(out => ["sending", "unknown_delivery"].includes(String(out.status)) && record(out.message).run_id === delegation.runId))
    throw new Error("Uncertain extension delivery must reconcile before starting");
  const original = outbound.find(out => ["accepted", "released"].includes(String(out.status)) && out.handle &&
    record(out.message).run_id === delegation.runId && record(out.message).type === "delegation.request" &&
    record(record(out.message).sender).role === "conversation" &&
    digest(DelegationRequestSchema.parse(record(out.message).payload)) === digest(delegation));
  if (!original) throw new Error("No accepted extension delegation belongs to this Coordinator");
  const action = run.pendingAction === undefined ? {} : record(run.pendingAction);
  for (const out of assignmentsForBinding(outbound, binding).filter(out => out.status === "accepted")) {
    const message = RoleMessageSchema.parse(out.message);
    if (message.run_id !== delegation.runId || message.correlation_id !== delegation.correlationId) continue;
    if (message.message_id === record(original.message).message_id) return message;
    const payload = record(message.payload);
    if (message.sender.role === "runtime" && message.type === "task.status" && payload.kind === "resume_run" &&
        action.kind === "resume_coordinator" && action.owner === "coordinator" && action.state === "queued" &&
        payload.actionId === action.actionId && message.causation_id === action.sourceMessageId) return message;
    if (message.sender.role === "runtime" && message.type === "task.status" && payload.kind === "user_resume_requested" &&
        run.pendingAction === undefined && payload.runId === delegation.runId && payload.actionId === `idle-${digest(delegation.runId)}` &&
        typeof payload.conversationUserMessageId === "string" && payload.conversationUserMessageId.trim() &&
        message.message_id === `resume-idle-${digest([delegation.runId, payload.conversationUserMessageId])}`) return message;
  }
  throw new Error("No current accepted Coordinator delivery authorizes this extension");
}
