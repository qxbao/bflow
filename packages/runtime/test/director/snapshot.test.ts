import { describe, expect, it } from "vitest";
import { DirectorProgressSnapshotSchema } from "@bflow/contracts";
import { buildDirectorProgressSnapshot } from "../../src/director/index.js";

const task = (taskId: string, extra: Record<string, unknown> = {}) => ({
  taskId, spec: { specification: { title: `Task ${taskId}` } }, worktrees: [], outboundIds: [], ...extra
});
const state = {
  runs: [
    {
      runId: "run-1", status: "implementing", cancelled: false,
      workflowSpec: { specification: { title: "Add login" } },
      definition: { id: "wf-1", name: "Login flow", tasks: [{ id: "t1", role: "developer" }] },
      approval: { approvalId: "ap-1" },
      userDecisions: { q1: { status: "pending" }, q2: { status: "answered" } },
      tasks: [
        task("t1", { outboundIds: ["o1"] }),
        task("t2", { result: { status: "succeeded" }, cycle: { status: "passed" } }),
        task("t3", { result: { status: "failed" } }),
        task("t4", { status: "bogus" }),
        "garbage"
      ]
    },
    { runId: "run-2", status: "weird", cancelled: false, definition: { id: "wf-2" }, tasks: [task("a", { status: "ready" })] },
    null,
    { status: "intake" }
  ],
  outbound: [], inbox: []
};

describe("buildDirectorProgressSnapshot", () => {
  const snap = buildDirectorProgressSnapshot({ state, presence: "waiting", session: null, issues: [], now: new Date("2026-11-03T00:00:00Z") });

  it("parses through the schema and skips malformed entries", () => {
    expect(DirectorProgressSnapshotSchema.parse(snap)).toEqual(snap);
    expect(snap.runs.map(r => r.runId)).toEqual(["run-1", "run-2"]);
    expect(snap.runs[0]!.tasks.map(t => [t.taskKey, t.status])).toEqual([["t1", "running"], ["t2", "succeeded"], ["t3", "failed"]]);
    expect(snap.runs[0]!.tasks[0]!.role).toBe("developer");
  });
  it("derives titles and statuses with fallbacks", () => {
    expect(snap.runs[0]!.title).toBe("Add login");
    expect(snap.runs[0]!.sdlcStatus).toBe("implementing");
    expect(snap.runs[1]!.title).toBe("wf-2");
    expect(snap.runs[1]!.sdlcStatus).toBe("intake");
  });
  it("counts pending approvals and questions", () => {
    expect(snap.pendingApprovals).toBe(1);
    expect(snap.pendingQuestions).toBe(1);
  });
  it("does not throw on non-object state", () => {
    expect(buildDirectorProgressSnapshot({ state: 42, presence: "absent", session: null, issues: [], now: new Date() }).runs).toEqual([]);
  });
  it("keeps only the newest 100 runs", () => {
    const many = { runs: Array.from({ length: 120 }, (_, i) => ({ runId: `r${i}`, status: "intake", tasks: [] })) };
    const result = buildDirectorProgressSnapshot({ state: many, presence: "absent", session: null, issues: [], now: new Date() });
    expect(result.runs).toHaveLength(100);
    expect(result.runs[0]!.runId).toBe("r20");
  });
});
