import { describe, expect, it, vi } from "vitest";
import { dependencyHeadsFor, prepareDependencyBaseWorktree } from "../../src/agentic/dependency-base.js";
import type { RunRecord, TaskRecord } from "../../src/agentic/journal.js";
import type { GitPolicy } from "../../src/agentic/ports.js";

const RUN_BASE = "1".repeat(40), HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40), MERGED = "c".repeat(40);
const request = { runId: "run-1", taskId: "task-c", attemptId: "attempt-1", ownedPaths: ["src"], forbiddenPaths: [], developerId: "dev-1" };
const worktree = (baseCommitHash: string) => ({ key: `key-${baseCommitHash.slice(0, 4)}`, worktreePath: "/tmp/wt", branchName: "agent/x", baseCommitHash });

function task(taskId: string, headCommitHash?: string): TaskRecord {
  return { taskId, spec: {} as TaskRecord["spec"], worktrees: [], outboundIds: [],
    ...(headCommitHash ? { changeSet: { headCommitHash } as TaskRecord["changeSet"] } : {}) };
}
function run(dependencies: { taskId: string; dependsOnTaskId: string }[], tasks: TaskRecord[]): RunRecord {
  return { runId: "run-1", tasks, definition: { dependencies: dependencies.map(dep => ({ ...dep, condition: "succeeded" })) } } as unknown as RunRecord;
}
function fakeGit(behaviour: (request: Parameters<GitPolicy["prepareTask"]>[0]) => Promise<ReturnType<typeof worktree>>) {
  return { prepareTask: vi.fn(behaviour) };
}

describe("dependency-aware task base", () => {
  it("collects verified dependency heads in definition order without duplicates", () => {
    const record = run([
      { taskId: "c", dependsOnTaskId: "b" }, { taskId: "c", dependsOnTaskId: "a" }, { taskId: "c", dependsOnTaskId: "a" },
      { taskId: "c", dependsOnTaskId: "pending" }
    ], [task("a", HEAD_A), task("b", HEAD_B), task("c"), task("pending")]);
    expect(dependencyHeadsFor(record, "c")).toEqual([HEAD_B, HEAD_A]);
    expect(dependencyHeadsFor(record, "a")).toEqual([]);
  });

  it("uses the run base when there are no dependencies", async () => {
    const git = fakeGit(async () => worktree(RUN_BASE));
    await prepareDependencyBaseWorktree(git, request, { runBaseRevision: RUN_BASE, priorHead: undefined, dependencyHeads: [] });
    expect(git.prepareTask).toHaveBeenCalledWith({ ...request, baseRevision: RUN_BASE });
  });

  it("bases a single dependency directly on its verified head", async () => {
    const git = fakeGit(async () => worktree(HEAD_A));
    await prepareDependencyBaseWorktree(git, request, { runBaseRevision: RUN_BASE, priorHead: undefined, dependencyHeads: [HEAD_A] });
    expect(git.prepareTask).toHaveBeenCalledWith({ ...request, baseRevision: HEAD_A });
  });

  it("asks Git to merge several dependency heads over the run base", async () => {
    const git = fakeGit(async () => worktree(MERGED));
    const result = await prepareDependencyBaseWorktree(git, request, { runBaseRevision: RUN_BASE, priorHead: undefined, dependencyHeads: [HEAD_A, HEAD_B] });
    expect(git.prepareTask).toHaveBeenCalledWith({ ...request, baseRevision: RUN_BASE, dependencyHeads: [HEAD_A, HEAD_B] });
    expect(result).toEqual({ tree: worktree(MERGED) });
  });

  it("continues a rework from its own previous head and ignores dependency heads", async () => {
    const git = fakeGit(async () => worktree(HEAD_B));
    await prepareDependencyBaseWorktree(git, request, { runBaseRevision: RUN_BASE, priorHead: HEAD_B, dependencyHeads: [HEAD_A, HEAD_B] });
    expect(git.prepareTask).toHaveBeenCalledWith({ ...request, baseRevision: HEAD_B });
  });

  it("falls back to the run base with the conflict reason when the dependency merge conflicts", async () => {
    const conflict = Object.assign(new Error("Dependency outputs conflict for task-c: src/same.txt"), { code: "dependency_base_conflict" });
    const git = fakeGit(async input => {
      if (input.dependencyHeads) throw conflict;
      return worktree(RUN_BASE);
    });
    const result = await prepareDependencyBaseWorktree(git, request, { runBaseRevision: RUN_BASE, priorHead: undefined, dependencyHeads: [HEAD_A, HEAD_B] });
    expect(result).toEqual({ tree: worktree(RUN_BASE), conflict: conflict.message });
    expect(git.prepareTask).toHaveBeenLastCalledWith({ ...request, baseRevision: RUN_BASE });
  });

  it("does not hide unrelated preparation failures", async () => {
    const git = fakeGit(async () => { throw Object.assign(new Error("branch collision"), { code: "branch_collision" }); });
    await expect(prepareDependencyBaseWorktree(git, request, { runBaseRevision: RUN_BASE, priorHead: undefined, dependencyHeads: [HEAD_A, HEAD_B] }))
      .rejects.toThrow("branch collision");
    expect(git.prepareTask).toHaveBeenCalledTimes(1);
  });
});
