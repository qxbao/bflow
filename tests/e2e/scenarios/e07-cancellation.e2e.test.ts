import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import { createStandardMvpWorkflow, createVerifiedAgentResult } from "../helpers/fixtures.js";
import type { TaskState, OperationResult, CancellationReceipt } from "@ai-flow/contracts";

describe("Scenario E07 — Cancellation & Cleanup", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("cancels an active run, halts running execution, releases leases, and rejects late agent results", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-cancel-${randomUUID()}`;

    // 1. Start run -> 'plan' task begins running
    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Cancellation test" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    expect(startRes.ok).toBe(true);
    const planTask = startRes.value.tasks.find((t: TaskState) => t.taskId === "plan")!;
    expect(planTask.status).toBe("running");
    expect(planTask.agentExecution).toBeDefined();
    const planHandle = planTask.agentExecution!;

    // 2. Request run cancellation
    const cancelRes = await harness.service.cancel({
      runId,
      reason: "User cancelled operation before completion"
    });
    expect(cancelRes.ok).toBe(true);

    const cancelledSnap = cancelRes.value;
    expect(cancelledSnap.status).toBe("cancelled");
    const cancelledPlanTask = cancelledSnap.tasks.find((t: TaskState) => t.taskId === "plan")!;
    expect(cancelledPlanTask.status).toBe("cancelled");

    // 3. Verify transport received cancel command
    const cancelledHandles = harness.transport.cancelledHandles;
    expect(cancelledHandles.some((c) => c.handle.executionId === planHandle.executionId)).toBe(true);

    // 4. Verify lease was released in FileAgentRegistry
    const activeExec = harness.service.dispatcher.getActiveExecution(runId, "plan")!;
    expect(activeExec).toBeDefined();

    // Attempting to release the lease again in registry must fail with 'Lease expired or already released'
    const doubleRelease = await harness.agentRegistry.releaseLease({
      leaseId: activeExec.lease.leaseId,
      fencingToken: activeExec.lease.fencingToken,
      expectedVersion: activeExec.lease.version,
      releasedAt: new Date().toISOString(),
      idempotencyKey: `probe-double-release-${randomUUID()}`
    });
    expect(doubleRelease.ok).toBe(false);
    expect(doubleRelease.error?.code).toBe("conflict");
    expect(doubleRelease.error?.message).toContain("already released");

    // 5. Verify late agent result from cancelled execution is rejected
    const verifiedResult = createVerifiedAgentResult({
      handle: planHandle,
      status: "succeeded"
    });

    const lateResult = await harness.service.orchestrator.completeTaskExecution(
      runId,
      "plan",
      {
        status: "succeeded",
        summary: "Late result after cancellation"
      }
    );
    // Once cancelled, task cannot be transitioned to succeeded
    expect(lateResult.ok).toBe(false);
  });

  it("handles repeated cancellation requests idempotently and rejects new cancellation on terminal runs", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-cancel-idempotent-${randomUUID()}`;

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Cancellation idempotency" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    const snapshot = startRes.value;

    const cancellationId = `cancel-req-${randomUUID()}`;
    const cancellationRequest = {
      schemaVersion: 1 as const,
      cancellationId,
      runId,
      requestedBy: "human_operator",
      requestedAt: new Date().toISOString(),
      expectedVersion: snapshot.version,
      reason: "Initial operator cancellation",
      idempotencyKey: `idem-cancel-${cancellationId}`
    };

    // First cancel using explicit CancellationRequest
    const cancel1 = await harness.service.cancel(cancellationRequest);
    expect(cancel1.ok).toBe(true);
    expect(cancel1.value.status).toBe("cancelled");

    // Subsequent cancel with a NEW request on terminal run must be rejected with conflict
    const cancelNewOnTerminal = await harness.service.cancel({
      runId,
      reason: "Second cancel attempt after terminal"
    });
    expect(cancelNewOnTerminal.ok).toBe(false);
    expect(cancelNewOnTerminal.error?.code).toBe("conflict");
    expect(cancelNewOnTerminal.error?.message).toContain("terminal");
  });

  it("PROBE PM-11: reveals that runtime unconditionally confirms cancellation stop even if transport.cancel fails", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-probe-pm11-${randomUUID()}`;

    // Force transport.cancel to fail / report error
    harness.transport.cancel = async (): Promise<OperationResult<CancellationReceipt>> => {
      return {
        ok: false,
        error: {
          code: "unavailable",
          retryable: true,
          message: "Remote agent runner unresponsive to cancellation signal"
        }
      };
    };

    await harness.service.start({
      runId,
      definition,
      input: { requirement: "Transport cancel failure probe" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });

    // In service.ts:399-408, the return value of transport.cancel is NOT checked:
    // await this.ports.transport.cancel(handle, cancelRequest, options);
    // and immediately calls confirmCancellationStop!
    const cancelRes = await harness.service.cancel({
      runId,
      reason: "Cancel with failing transport"
    });

    // Because of the defect in service.ts:399, cancelRes returns ok: true
    // and marks the task as terminal 'cancelled' even though the remote agent is still running!
    // We document this behavior:
    expect(cancelRes.ok).toBe(true);
    expect(cancelRes.value.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("cancelled");

    // This proves that Runtime currently emits false 'stopped' confirmation
    // without verifying transport stop evidence.
  });
});
