import { describe, expect, it } from "vitest";
import type { WorkflowRunSnapshot } from "@bflow/contracts";
import { unverifiedWriterBlocker, unverifiedWriters } from "../src/shutdown-safety.js";

const now = "2026-10-28T08:00:00.000Z";
const handle = { executionId: "exec-1", requestId: "request-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-multiply", idempotencyKey: "assign-1",
  target: { transport: "herdr", agentId: "dev-1", paneId: "w2:p2" }, correlation: { token: "request-1", provenance: "orchestrator" as const, verified: false }, acceptedAt: now };
function run(task: Record<string, unknown>): WorkflowRunSnapshot {
  return { runId: "run-1", workflowId: "wf", workflowVersion: "1", status: "running", createdAt: now, updatedAt: now, version: 9, lastEventSequence: 9,
    tasks: [{ taskId: "task-multiply", status: "running", attempt: 1, generation: 0, attemptId: "attempt-1", version: 3, ...task }] } as unknown as WorkflowRunSnapshot;
}

// Live regression (2026-10-28, run-16d0fd2f…): `bflow down --yes` stopped a Developer whose execution had no binding proof yet.
// Core cannot retry or fail an unverified attempt, so the run could only be cancelled afterwards.
describe("shutdown safety for unverified writers", () => {
  it("finds a running task whose bound execution is not verified yet", () => {
    expect(unverifiedWriters([run({ agentExecution: handle })])).toEqual([{ runId: "run-1", taskId: "task-multiply", agentId: "dev-1", paneId: "w2:p2" }]);
  });
  it("ignores verified executions, unbound tasks and non-running tasks", () => {
    expect(unverifiedWriters([run({ agentExecution: { ...handle, correlation: { ...handle.correlation, verified: true } } })])).toEqual([]);
    expect(unverifiedWriters([run({ agentExecution: handle, bindingVerification: { receipt: { correlation: { verified: true } } } })])).toEqual([]);
    expect(unverifiedWriters([run({})])).toEqual([]);
    expect(unverifiedWriters([run({ agentExecution: handle, status: "waiting" })])).toEqual([]);
  });
  it("explains the permanent loss and only --force as the override", () => {
    const message = unverifiedWriterBlocker(unverifiedWriters([run({ agentExecution: handle })]));
    expect(message).toMatch(/dev-1.*task-multiply.*run-1/);
    expect(message).toMatch(/cannot be retried/);
    expect(message).toMatch(/bflow down --force/);
    expect(unverifiedWriterBlocker([])).toBeUndefined();
  });
});
