import { record, type JournalState, type RunRecord, type Outbound } from "./journal.js";

/** Released, current phase requests with no observed result: only explicit recovery may authorize a new measurement. */
export function unmeasuredPolicyPhaseRequests(state: JournalState, run: RunRecord): Outbound[] {
    return state.outbound.filter((item, itemIndex) => {
      const payload = record(item.message.payload);
      if (item.message.run_id !== run.runId || item.message.type !== "verification.requested" || payload.kind !== "conditional_evidence" ||
          item.status !== "released" || item.phaseFailure || item.phaseRetirement || item.error?.startsWith("policy_phase_failed:")) return false;
      if (state.inbox.some(entry => entry.message.causation_id === item.message.message_id && entry.message.type === "verification.result" && entry.status !== "rejected")) return false;
      const task = run.tasks.find(entry => entry.taskId === payload.taskId);
      if (!task || task.writerReleased || task.result) return false;
      const receipts = Array.isArray(task.spec.strategy.metadata?.tddEvidence) ? task.spec.strategy.metadata.tddEvidence : [];
      const expected = task.spec.strategy.tddDecision.mode === "required" ? ["red", "green", "refactor"][receipts.length] : receipts.length === 0 ? "verification" : undefined;
      if (payload.phase !== expected) return false;
      const itemTime = Date.parse(item.message.occurred_at ?? "");
      // Only the newest request for this phase and attempt; an earlier one was already superseded.
      return !state.outbound.some((other, otherIndex) => {
        if (other === item || other.message.run_id !== run.runId || other.message.type !== "verification.requested") return false;
        const otherPayload = record(other.message.payload);
        if (otherPayload.taskId !== payload.taskId || otherPayload.phase !== payload.phase ||
            otherPayload.implementationAttemptId !== payload.implementationAttemptId) return false;
        const otherTime = Date.parse(other.message.occurred_at ?? "");
        if (Number.isFinite(otherTime) && Number.isFinite(itemTime) && otherTime !== itemTime) return otherTime > itemTime;
        const otherRaw = other.message.occurred_at ?? "", itemRaw = item.message.occurred_at ?? "";
        return otherRaw !== itemRaw ? otherRaw > itemRaw : otherIndex > itemIndex;
      });
    });
}
