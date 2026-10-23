import { record } from "./journal.js";

/** Compact view of already-admitted journal data; never infers evidence from agent text or transport state. */
export function policyEvidenceView(runs: readonly Record<string, unknown>[], outbound: readonly Record<string, unknown>[]) {
  return runs.flatMap(run => (Array.isArray(run.tasks) ? run.tasks : []).map(value => {
    const task = record(value), strategy = record(record(task.spec).strategy), metadata = record(strategy.metadata ?? {});
    const accepted = (Array.isArray(metadata.tddEvidence) ? metadata.tddEvidence.map(record) : []).filter(result => {
      const meta = result.metadata;
      return meta !== null && typeof meta === "object" && !Array.isArray(meta) &&
        record(meta).conditionalTdd !== null && typeof record(meta).conditionalTdd === "object" && !Array.isArray(record(meta).conditionalTdd);
    });
    return { runId: run.runId, taskId: task.taskId,
      acceptedPolicyEvidence: accepted.map(result => {
        const phase = record(record(result.metadata).conditionalTdd);
        return { verificationId: result.verificationId, phase: phase.phase, sourceRevision: phase.sourceRevision, testRevision: phase.testRevision,
          resultStatus: result.status, independentExecution: result.independentExecution, evidenceArtifacts: result.evidenceArtifacts };
      }),
      rejectedPolicyOutcomes: outbound.filter(out => out.phaseFailure && record(out.message).run_id === run.runId &&
        record(out.message).payload !== null && typeof record(out.message).payload === "object" && !Array.isArray(record(out.message).payload) &&
        record(record(out.message).payload).taskId === task.taskId).map(out => {
          const payload = record(record(out.message).payload), failure = record(out.phaseFailure);
          return { requestId: record(out.message).message_id, phase: payload.phase, sourceRevision: payload.sourceRevision,
            summary: failure.summary, repairable: failure.repairable, phaseRecorded: false,
            evidenceArtifacts: out.phaseFailureEvidence ? [out.phaseFailureEvidence] : [] };
        }) };
  }));
}
