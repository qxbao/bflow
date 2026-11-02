import { record, type JournalState, type RunRecord, type Outbound } from "./journal.js";

/** Released or delivery-exhausted current phase requests with no observed result: only explicit recovery may authorize a new measurement. */
/** `now` is the Runtime clock (ISO); it defaults to wall time only for callers that have no injected clock. */
export function unmeasuredPolicyPhaseRequests(state: JournalState, run: RunRecord, now: string = new Date().toISOString()): Outbound[] {
    return state.outbound.filter((item, itemIndex) => {
      if (!item.message || typeof item.message !== "object" || item.message.type !== "verification.requested") return false;
      const payload = record(item.message.payload);
      const isExpiredLease = Boolean(item.lease && Date.parse(item.lease.expiresAt) <= Date.parse(now));
      const terminalWithoutMeasurement = item.status === "released" ||
        (item.status === "failed" && !item.error?.includes("RoleCapabilityPreflightError")) ||
        (item.status === "accepted" && isExpiredLease);
      if (item.message.run_id !== run.runId || item.message.type !== "verification.requested" || payload.kind !== "conditional_evidence" ||
          !terminalWithoutMeasurement || item.phaseFailure || item.phaseRetirement || item.error?.startsWith("policy_phase_failed:")) return false;
      if (state.inbox.some(entry => entry.message.causation_id === item.message.message_id && entry.message.type === "verification.result" && entry.status !== "rejected")) return false;
      const task = run.tasks.find(entry => entry.taskId === payload.taskId);
      if (!task || task.verificationPending || (task.cycle !== undefined && task.cycle.status !== "rework_required")) return false;
      if (typeof payload.implementationAttemptId === "string") {
        const taskAssignments = state.outbound.filter(entry =>
          entry.message.run_id === run.runId &&
          entry.message.type === "task.assignment" &&
          entry.taskId === task.taskId &&
          entry.status !== "cancelled" &&
          (entry.handle?.attemptId ?? entry.attemptId) !== undefined
        );
        const activeAttemptId = taskAssignments.at(-1)?.handle?.attemptId ?? taskAssignments.at(-1)?.attemptId;
        const matchesKnownAttempt = taskAssignments.some(
          entry => (entry.handle?.attemptId ?? entry.attemptId) === payload.implementationAttemptId
        );
        if (
          activeAttemptId !== undefined &&
          activeAttemptId !== payload.implementationAttemptId &&
          (matchesKnownAttempt || taskAssignments.length > 1 || task.cycle !== undefined)
        ) {
          return false;
        }
      }
      const receipts = Array.isArray(task.spec.strategy.metadata?.tddEvidence) ? task.spec.strategy.metadata.tddEvidence : [];
      if (task.spec.strategy.tddDecision.mode === "required") {
        if (task.writerReleased || task.result) return false;
        const expected = ["red", "green", "refactor"][receipts.length];
        if (payload.phase !== expected) return false;
      } else {
        if (receipts.length > 0) return false;
        if (task.result !== undefined && task.result.status !== "succeeded") return false;
        if (!task.result && !task.writerReleased) {
          if (payload.phase !== "verification") return false;
        } else if (payload.phase !== "verification" && payload.phase !== undefined) {
          return false;
        }
      }
      const itemTime = Date.parse(item.message.occurred_at ?? "");
      // Only the newest request for this phase and attempt; an earlier one was already superseded.
      return !state.outbound.some((other, otherIndex) => {
        if (other === item || other.message.run_id !== run.runId || other.message.type !== "verification.requested") return false;
        const otherPayload = record(other.message.payload);
        if (otherPayload.kind !== "conditional_evidence" ||
            otherPayload.taskId !== payload.taskId ||
            (otherPayload.phase ?? undefined) !== (payload.phase ?? undefined) ||
            (otherPayload.implementationAttemptId ?? undefined) !== (payload.implementationAttemptId ?? undefined)) return false;
        const otherTime = Date.parse(other.message.occurred_at ?? "");
        if (Number.isFinite(otherTime) && Number.isFinite(itemTime) && otherTime !== itemTime) return otherTime > itemTime;
        const otherRaw = other.message.occurred_at ?? "", itemRaw = item.message.occurred_at ?? "";
        return otherRaw !== itemRaw ? otherRaw > itemRaw : otherIndex > itemIndex;
      });
    });
}
