import { AgentAssignmentSchema, AgentExecutionHandleSchema, AgentLeaseSchema, PaneBindingSchema, RoleMessageSchema } from "@bflow/contracts";
import type { AgentRole, PaneBinding, RoleMessage } from "@bflow/contracts";
import { isCoordinatorTrigger } from "./host-receipts.js";
import { digest, record, textField } from "./journal.js";

export interface AgyAdmissionSelection {
  readonly role: AgentRole;
  readonly binding: PaneBinding;
  readonly launchId: string;
  readonly expectedLaunchId: string;
  readonly messageId: string;
  readonly envelopeDigest: string;
  readonly state: { readonly outbound: readonly unknown[]; readonly runs: readonly unknown[] };
  readonly now?: number;
}

/** Selects only an exact accepted Runtime envelope for the current Agy principal. */
export function selectAgyAdmission(input: AgyAdmissionSelection): RoleMessage {
  const binding = PaneBindingSchema.parse(input.binding);
  if (binding.provider !== "agy" || binding.role !== input.role || binding.role === "conversation" || !binding.session)
    throw new Error("Agy assignment admission requires a current non-Conversation Agy pane");
  if (!input.launchId || input.launchId !== input.expectedLaunchId) throw new Error("Agy assignment admission belongs to a stale launch");
  if (!/^[a-f0-9]{64}$/.test(input.envelopeDigest)) throw new Error("Agy assignment envelope digest is malformed");

  const candidates = input.state.outbound.map(record).filter(item => record(item.message).message_id === textField(input.messageId));
  if (candidates.length !== 1) throw new Error("Agy assignment id is missing or ambiguous in the pinned Runtime outbox");
  const item = candidates[0]!;
  if (item.status !== "accepted") throw new Error("Agy assignment is not an accepted current delivery");
  const message = RoleMessageSchema.parse(item.message);
  if (digest(message) !== input.envelopeDigest) throw new Error("Agy assignment digest does not match the pinned envelope");
  const handle = AgentExecutionHandleSchema.parse(item.handle);
  const target = record(record(item.request).target);
  if (handle.target.paneId !== binding.paneId || handle.target.agentId !== binding.agentId ||
      handle.target.workspaceId !== binding.workspaceId || handle.target.tabId !== binding.tabId ||
      digest(handle.target.session) !== digest(binding.session) ||
      target.paneId !== binding.paneId || target.agentId !== binding.agentId || target.workspaceId !== binding.workspaceId ||
      target.tabId !== binding.tabId || digest(target.session) !== digest(binding.session))
    throw new Error("Agy assignment is pinned to another pane or native session");

  if (binding.role === "coordinator") {
    if (message.recipient.role !== "coordinator" || !isCoordinatorTrigger(message))
      throw new Error("Agy Coordinator admission requires an exact delegation or Runtime wake");
    return message;
  }

  if (message.type !== "task.assignment" || message.recipient.role !== binding.role || message.sender.role !== "coordinator")
    throw new Error("Agy specialist admission requires a Coordinator task assignment");
  const assignment = AgentAssignmentSchema.parse(item.assignment);
  const payload = record(message.payload);
  const envelopeAssignment = AgentAssignmentSchema.parse(payload.assignment);
  const lease = AgentLeaseSchema.parse(item.lease);
  const now = input.now ?? Date.now();
  if (digest(assignment) !== digest(envelopeAssignment) || assignment.role !== binding.role || assignment.paneId !== binding.paneId ||
      assignment.agentId !== binding.agentId || assignment.status !== "assigned" && assignment.status !== "active" ||
      assignment.runId !== message.run_id || assignment.taskId !== item.taskId || assignment.leaseId !== lease.leaseId ||
      assignment.fencingToken !== lease.fencingToken || lease.agentId !== binding.agentId || lease.runId !== assignment.runId ||
      lease.taskId !== assignment.taskId || Date.parse(lease.expiresAt) <= now)
    throw new Error("Agy assignment lease, fence or task binding is stale");
  const run = input.state.runs.map(record).find(value => value.runId === message.run_id);
  if (!run || run.cancelled === true || ["completed", "failed", "cancelled"].includes(String(run.status)))
    throw new Error("Agy assignment belongs to a cancelled, completed or missing run");
  return message;
}
