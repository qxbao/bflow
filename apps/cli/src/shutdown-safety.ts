import type { WorkflowRunSnapshot } from "@bflow/contracts";

export interface UnverifiedWriter { readonly runId: string; readonly taskId: string; readonly agentId?: string; readonly paneId?: string }

/**
 * Running tasks whose bound execution has no verified correlation yet (no binding receipt, unverified handle). A Developer
 * proves its binding only when it reports; stopping it before that loses the attempt for good, because Core accepts no
 * result, failure or retry for an unverified execution.
 */
export function unverifiedWriters(runs: readonly WorkflowRunSnapshot[]): UnverifiedWriter[] {
  return runs.flatMap(run => run.tasks.filter(task => task.status === "running" && task.agentExecution !== undefined &&
    !task.agentExecution.correlation.verified && task.bindingVerification?.receipt.correlation.verified !== true)
    .map(task => ({ runId: run.runId, taskId: task.taskId,
      ...(task.agentExecution!.target.agentId ? { agentId: task.agentExecution!.target.agentId } : {}),
      ...(task.agentExecution!.target.paneId ? { paneId: task.agentExecution!.target.paneId } : {}) })));
}

export function unverifiedWriterBlocker(writers: readonly UnverifiedWriter[]): string | undefined {
  if (!writers.length) return undefined;
  const list = writers.map(item => `${item.agentId ?? "agent"} on task ${item.taskId} of run ${item.runId}`).join("; ");
  return `Unsafe shutdown: ${list} has not reported yet, so its execution is unverified. Stopping it now loses that attempt: it cannot be retried ` +
    "or failed afterwards and the run can only be cancelled. Wait until it reports, or cancel the run first. " +
    "bflow down --yes does not override this; bflow down --force stops anyway. Nothing was stopped.";
}
