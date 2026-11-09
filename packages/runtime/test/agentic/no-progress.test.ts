import { describe, expect, it } from "vitest";
import { digest, type JournalState, type TaskRecord } from "../../src/agentic/journal.js";
import { blockerFingerprint, inputsChanged, priorSameFingerprint } from "../../src/agentic/no-progress.js";

const input = { code: "declared_test_missing", runId: "run-1", taskId: "task-1", phase: "red",
  sourceRevision: "a".repeat(40), specDigest: "b".repeat(64), strategyDigest: "c".repeat(64), details: { paths: ["test/a.ts"] } };

describe("no-progress identity", () => {
  it("is stable for the same inputs and changes when any input changes", () => {
    const fingerprint = blockerFingerprint(input);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(blockerFingerprint(structuredClone(input))).toBe(fingerprint);
    for (const [key, value] of Object.entries({ code: "other", runId: "run-2", taskId: "task-2", phase: "green",
      sourceRevision: "d".repeat(40), specDigest: "e".repeat(64), strategyDigest: "f".repeat(64), details: { paths: ["test/b.ts"] } }))
      expect(blockerFingerprint({ ...input, [key]: value })).not.toBe(fingerprint);
  });

  it("counts only prior failures for the same run, task and fingerprint", () => {
    const outbound = [
      { message: { message_id: "old", run_id: "run-1" }, taskId: "task-1", phaseFailure: { blocker: { fingerprint: "fingerprint" } } },
      { message: { message_id: "current", run_id: "run-1" }, taskId: "task-1", phaseFailure: { blocker: { fingerprint: "fingerprint" } } },
      { message: { message_id: "other-run", run_id: "run-2" }, taskId: "task-1", phaseFailure: { blocker: { fingerprint: "fingerprint" } } },
      { message: { message_id: "other-task", run_id: "run-1" }, taskId: "task-2", phaseFailure: { blocker: { fingerprint: "fingerprint" } } },
      { message: { message_id: "later", run_id: "run-1" }, taskId: "task-1", phaseFailure: { blocker: { fingerprint: "fingerprint" } } }
    ] as unknown as JournalState["outbound"];
    expect(priorSameFingerprint({ outbound }, "run-1", "task-1", "fingerprint", "current")).toBe(1);
  });

  it("compares current spec and strategy digests", () => {
    const task = { spec: { specification: { title: "a" }, strategy: { mode: "required" } } } as unknown as TaskRecord;
    const blocker = { specDigest: digest(task.spec.specification), strategyDigest: digest(task.spec.strategy) };
    expect(inputsChanged(blocker, task)).toBe(false);
    expect(inputsChanged({ ...blocker, specDigest: digest({ title: "b" }) }, task)).toBe(true);
    expect(inputsChanged({ ...blocker, strategyDigest: digest({ mode: "recommended" }) }, task)).toBe(true);
  });
});
