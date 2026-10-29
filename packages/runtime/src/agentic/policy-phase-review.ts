import { AgentExecutionHandleSchema, AgentLeaseSchema, ExecutorLineageSchema, PaneBindingSchema, RoleMessageSchema, SpecificationSchema, TestStrategySchema } from "@bflow/contracts";
import { z } from "zod";
import { digest, record, textField } from "./journal.js";
import { assertIndependentProfileExecutor } from "./profile-admission.js";

export const PolicyReviewSubmissionSchema = z.object({
  observationId: z.string().trim().min(1),
  criteria: z.array(z.object({ criterionId: z.string().trim().min(1), passed: z.boolean(), summary: z.string().trim().min(1) }).strict())
}).strict();

/** A host-private binding, derived from authenticated Runtime assignments, never from a caller's receipt. */
export function policyPhaseReviewAssignment(stateInput: unknown, runInput: unknown, bindingInput: unknown,
  runId: string, taskId: string, phase: string) {
  const binding = PaneBindingSchema.parse(bindingInput), run = record(runInput), state = record(stateInput);
  if (binding.role !== "qa" || !binding.session) throw new Error("Policy manual review requires the assigned independent native QA session");
  if (run.cancelled || ["cancelled", "failed", "completed", "escalated", "awaiting_approval"].includes(String(run.status)))
    throw new Error("Policy review is outside the active approved run");
  const tasks = Array.isArray(run.tasks) ? run.tasks.map(record) : [];
  const task = tasks.find(item => item.taskId === taskId);
  if (!task) throw new Error("Unknown policy review task");
  const dossier = record(task.spec), specification = SpecificationSchema.parse(dossier.specification), strategy = TestStrategySchema.parse(dossier.strategy);
  if (specification.status !== "approved" || strategy.tddDecision.runId !== runId || strategy.tddDecision.taskId !== taskId)
    throw new Error("Policy review requires an approved matching task specification");
  const outbound = Array.isArray(state.outbound) ? state.outbound.map(record) : [];
  const implementations = outbound.filter(out => record(out.message).run_id === runId && record(out.message).type === "task.assignment" && out.handle);
  for (const out of implementations) {
    const target = AgentExecutionHandleSchema.parse(out.handle).target;
    if (target.agentId === binding.agentId || target.paneId === binding.paneId ||
        target.session && digest(target.session) === digest(binding.session)) throw new Error("Implementer cannot review its own change or reuse its native executor");
  }
  const implementation = [...implementations].reverse().find(out => out.taskId === taskId && out.status === "accepted");
  if (!implementation) throw new Error("Current implementation assignment unavailable for policy review");
  const implementationHandle = AgentExecutionHandleSchema.parse(implementation.handle);
  if (!implementationHandle.target.session) throw new Error("Implementation native executor proof unavailable for policy review");
  const matches = outbound.filter(out => out.handle && ["accepted", "released"].includes(String(out.status)) && !out.phaseRetirement &&
    !String(out.error ?? "").startsWith("policy_phase_failed:") && record(out.message).type === "verification.requested" &&
    record(out.message).run_id === runId && record(record(out.message).payload).kind === "conditional_evidence" &&
    record(record(out.message).payload).taskId === taskId && record(record(out.message).payload).phase === phase &&
    record(record(out.handle).target).agentId === binding.agentId && record(record(out.handle).target).paneId === binding.paneId &&
    digest(record(record(out.handle).target).session) === digest(binding.session));
  if (matches.length !== 1) throw new Error("No unique assigned policy review request for this phase and native verifier");
  const request = matches[0]!, message = RoleMessageSchema.parse(request.message), handle = AgentExecutionHandleSchema.parse(request.handle);
  const payload = record(message.payload);
  const lease = AgentLeaseSchema.safeParse(request.lease);
  if (!lease.success || lease.data.agentId !== binding.agentId || lease.data.runId !== runId ||
      lease.data.taskId !== handle.taskId || lease.data.attemptId !== handle.attemptId || Date.parse(lease.data.expiresAt) <= Date.now())
    throw new Error("Policy review lease is missing, expired or belongs to another assignment");
  const lineage = (out: Record<string, unknown>) => out.executorLineage === undefined ? undefined : ExecutorLineageSchema.parse(out.executorLineage);
  assertIndependentProfileExecutor({ ...handle.target, executorLineage: lineage(request) }, implementations.map(out => ({
    ...AgentExecutionHandleSchema.parse(out.handle).target, executorLineage: lineage(out)
  })));
  if (message.sender.role !== "coordinator" || message.recipient.role !== binding.role || handle.runId !== runId ||
      payload.runId !== runId || payload.implementationAttemptId !== implementationHandle.attemptId ||
      digest(SpecificationSchema.parse(payload.specification)) !== digest(specification) ||
      digest(TestStrategySchema.parse(payload.strategy).tddDecision) !== digest(strategy.tddDecision))
    throw new Error("Policy review request belongs to a stale attempt or specification");
  const revision = textField(payload.sourceRevision);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Policy review request needs a pinned source revision");
  const { transportState: _state, lastHeartbeatAt: _heartbeat, ...identity } = binding;
  const stamp = digest({ runId, taskId, phase, specification, decision: strategy.tddDecision,
    implementationHandle, implementationLineage: lineage(implementation) ?? null,
    request: message, handle, verifierLineage: lineage(request) ?? null, binding: identity,
    leaseId: lease.data.leaseId, fencingToken: lease.data.fencingToken });
  return { stamp, requestId: message.message_id, revision, cwd: textField(implementationHandle.target.worktreePath),
    base: textField(run.baseRevision), specification, strategy, requestStatus: request.status };
}
