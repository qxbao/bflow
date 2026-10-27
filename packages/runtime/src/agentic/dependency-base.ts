import type { GitPolicy, TaskWorktree } from "./ports.js";
import type { RunRecord } from "./journal.js";

type PrepareRequest = Parameters<GitPolicy["prepareTask"]>[0];

/** Verified heads of a task's dependencies, in definition order. Duplicates collapse; a dependency without a change set is absent. */
export function dependencyHeadsFor(run: RunRecord, taskId: string): string[] {
  const heads: string[] = [];
  for (const dependency of run.definition?.dependencies ?? []) {
    if (dependency.taskId !== taskId) continue;
    const head = run.tasks.find(item => item.taskId === dependency.dependsOnTaskId)?.changeSet?.headCommitHash;
    if (head !== undefined && !heads.includes(head)) heads.push(head);
  }
  return heads;
}

export function isDependencyBaseConflict(error: unknown): error is Error {
  return error instanceof Error && "code" in error && error.code === "dependency_base_conflict";
}

/**
 * Chooses the Developer base: a rework continues from its own head; one dependency head is the base itself; several heads are
 * merged by Git. When the merge conflicts, the task starts from the run base and `conflict` carries the reason, so final
 * integration reports the overlap through its normal conflict flow.
 */
export async function prepareDependencyBaseWorktree(git: Pick<GitPolicy, "prepareTask">, request: Omit<PrepareRequest, "baseRevision" | "dependencyHeads">,
  bases: { runBaseRevision: string; priorHead: string | undefined; dependencyHeads: readonly string[] }): Promise<{ tree: TaskWorktree; conflict?: string }> {
  if (bases.priorHead !== undefined) return { tree: await git.prepareTask({ ...request, baseRevision: bases.priorHead }) };
  if (bases.dependencyHeads.length === 1) return { tree: await git.prepareTask({ ...request, baseRevision: bases.dependencyHeads[0]! }) };
  if (bases.dependencyHeads.length >= 2) {
    try {
      return { tree: await git.prepareTask({ ...request, baseRevision: bases.runBaseRevision, dependencyHeads: [...bases.dependencyHeads] }) };
    } catch (error) {
      if (!isDependencyBaseConflict(error)) throw error;
      return { tree: await git.prepareTask({ ...request, baseRevision: bases.runBaseRevision }), conflict: error.message };
    }
  }
  return { tree: await git.prepareTask({ ...request, baseRevision: bases.runBaseRevision }) };
}
