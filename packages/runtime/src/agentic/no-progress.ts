import { digest, type JournalState, type TaskRecord } from "./journal.js";

export function blockerFingerprint(input: { code: string; runId: string; taskId: string; phase: string;
  sourceRevision: string; specDigest: string; strategyDigest: string; details: unknown }): string {
  return digest([input.code, input.runId, input.taskId, input.phase, input.sourceRevision,
    input.specDigest, input.strategyDigest, input.details]);
}

/** Number of earlier phase failures for this run/task with the same exact measurement inputs. */
export function priorSameFingerprint(state: Pick<JournalState, "outbound">, runId: string, taskId: string,
  fingerprint: string, excludeMessageId: string): number {
  const currentIndex = state.outbound.findIndex(out => out.message.message_id === excludeMessageId);
  if (currentIndex < 0) return 0;
  return state.outbound.slice(0, currentIndex).filter(out => out.message.run_id === runId &&
    out.taskId === taskId && out.phaseFailure?.blocker?.fingerprint === fingerprint).length;
}

export function inputsChanged(blocker: { specDigest: string; strategyDigest: string }, task: TaskRecord): boolean {
  return blocker.specDigest !== digest(task.spec.specification) || blocker.strategyDigest !== digest(task.spec.strategy);
}
