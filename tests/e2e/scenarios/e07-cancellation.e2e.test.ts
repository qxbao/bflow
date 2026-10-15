import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createStandardMvpWorkflow,
  createVerifiedAgentResult,
  expectOk,
  expectFailure
} from "../helpers/fixtures.js";
import type {
  TaskState,
  OperationResult,
  CancellationResult,
  CancellationRequest
} from "@ai-flow/contracts";

describe("Scenario E07 — Cancellation & Cleanup", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("PROBE (P06 DEFECT): Runtime prematurely marks task cancelled when transport only returns accepted without confirmed stop", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-cancel-probe-${randomUUID()}`;

    // 1. Start run -> 'plan' task begins running
    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Cancellation test" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    const startSnap = expectOk(startRes);
    const planTask = startSnap.tasks.find((t: TaskState) => t.taskId === "plan")!;
    expect(planTask.status).toBe("running");
    expect(planTask.agentExecution).toBeDefined();

    // 2. Request run cancellation via RuntimeService
    const cancelRes = await harness.service.cancel({
      runId,
      reason: "User cancelled operation before completion"
    });
    const cancelledSnap = expectOk(cancelRes);
    const cancelledPlanTask = cancelledSnap.tasks.find((t: TaskState) => t.taskId === "plan")!;

    // SAFETY INVARIANT (ADR 0002 / AGENTS.md):
    // Transport cancel returning status: "accepted" only means cancellation was REQUESTED at transport boundary.
    // The remote agent has NOT yet confirmed it stopped!
    // Until remote stop is confirmed, the task status must NOT be falsely marked as terminal "cancelled".
    // (Upstream P06 service.ts:399-408 violates this by unconditionally calling confirmCancellationStop)
    expect(cancelledPlanTask.status).not.toBe("cancelled");
  });

  it("executes confirmed cancellation workflow through Core engine with exact schema IDs and verified idempotency", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-cancel-core-${randomUUID()}`;

    // 1. Start run
    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Core cancellation protocol test" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    let currentSnap = expectOk(startRes);
    const planTask = currentSnap.tasks.find((t: TaskState) => t.taskId === "plan")!;
    expect(planTask.status).toBe("running");
    const planHandle = planTask.agentExecution!;

    const cancellationId = `cancel-req-${randomUUID()}`;
    const cancelRequest: CancellationRequest = {
      schemaVersion: 1,
      cancellationId,
      runId,
      requestedBy: "lead_operator",
      requestedAt: new Date().toISOString(),
      expectedVersion: currentSnap.version,
      reason: "Operator initiated cancellation",
      idempotencyKey: `idem-cancel-${cancellationId}`
    };

    // 2. Engine Step: Request cancellation
    const reqRes = await harness.ports.engine.requestCancellation(cancelRequest);
    const reqAdvance = expectOk(reqRes);
    expect(reqAdvance.snapshot.status).toBe("cancelling");
    const cancellingPlan = reqAdvance.snapshot.tasks.find((t: TaskState) => t.taskId === "plan")!;
    expect(cancellingPlan.status).toBe("cancelling");

    // Persist emitted events
    if (reqAdvance.emittedEvents.length > 0) {
      await harness.runStore.appendEvents({
        runId,
        expectedVersion: currentSnap.version,
        expectedLastSequence: currentSnap.lastEventSequence,
        events: reqAdvance.emittedEvents,
        idempotencyKey: `ev-${cancellationId}`
      });
    }
    currentSnap = reqAdvance.snapshot;

    // 3. Engine Step: Record cancellation receipt (transport accepted request)
    const recRes = await harness.ports.engine.recordCancellationResult({
      runId,
      expectedVersion: currentSnap.version,
      result: {
        schemaVersion: 1,
        cancellationId,
        status: "accepted",
        executionId: planHandle.executionId,
        observedAt: new Date().toISOString()
      },
      idempotencyKey: `rec-${cancellationId}`
    });
    const recAdvance = expectOk(recRes);
    // Task remains cancelling, NOT cancelled
    expect(recAdvance.snapshot.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("cancelling");

    if (recAdvance.emittedEvents.length > 0) {
      await harness.runStore.appendEvents({
        runId,
        expectedVersion: currentSnap.version,
        expectedLastSequence: currentSnap.lastEventSequence,
        events: recAdvance.emittedEvents,
        idempotencyKey: `rec-ev-${cancellationId}`
      });
    }
    currentSnap = recAdvance.snapshot;

    // 4. Verify negative case: Wrong execution confirmation is rejected by Core engine
    const wrongExecutionConfirm = await harness.ports.engine.confirmCancellationStop({
      runId,
      expectedVersion: currentSnap.version,
      confirmation: {
        schemaVersion: 1,
        cancellationId,
        executionId: `exec-wrong-mismatched-${randomUUID()}`,
        stoppedAt: new Date().toISOString(),
        terminalStatus: "cancelled"
      },
      idempotencyKey: `confirm-wrong-${randomUUID()}`
    });
    const wrongErr = expectFailure(wrongExecutionConfirm);
    expect(wrongErr.code).toBeDefined();

    // 5. Positive Step: Remote process actually confirms stop
    harness.transport.confirmStop(planHandle.executionId);

    const validConfirmRes = await harness.ports.engine.confirmCancellationStop({
      runId,
      expectedVersion: currentSnap.version,
      confirmation: {
        schemaVersion: 1,
        cancellationId,
        executionId: planHandle.executionId,
        stoppedAt: new Date().toISOString(),
        terminalStatus: "cancelled"
      },
      idempotencyKey: `confirm-valid-${cancellationId}`
    });
    const confirmedAdvance = expectOk(validConfirmRes);
    expect(confirmedAdvance.snapshot.status).toBe("cancelled");
    expect(confirmedAdvance.snapshot.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("cancelled");

    // Persist final stop events
    if (confirmedAdvance.emittedEvents.length > 0) {
      await harness.runStore.appendEvents({
        runId,
        expectedVersion: currentSnap.version,
        expectedLastSequence: currentSnap.lastEventSequence,
        events: confirmedAdvance.emittedEvents,
        idempotencyKey: `stop-ev-${cancellationId}`
      });
    }
    currentSnap = confirmedAdvance.snapshot;

    // 6. Idempotency: Duplicate cancellation request with identical cancellationId returns the cached receipt
    const dupReq = await harness.ports.engine.requestCancellation(cancelRequest);
    const dupRes = expectOk(dupReq);
    expect(dupRes.snapshot.status).toBe("cancelling"); // cached receipt snapshot from requestCancellation
    expect(dupRes.snapshot.version).toBe(reqAdvance.snapshot.version);
    expect(dupRes.emittedEvents.length).toBe(reqAdvance.emittedEvents.length);

    // Current aggregate snapshot is definitively cancelled
    const currentSnapshot = expectOk(await harness.ports.engine.getSnapshot(runId));
    expect(currentSnapshot?.status).toBe("cancelled");

    // 7. Verify late agent result from cancelled execution is rejected
    createVerifiedAgentResult({
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
    const lateErr = expectFailure(lateResult);
    expect(lateErr.code).toBeDefined();
  });

  it("PROBE PM-11: reveals that runtime unconditionally confirms cancellation stop even if transport.cancel fails", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-probe-pm11-${randomUUID()}`;

    // Force transport.cancel to fail / report error
    harness.transport.cancel = async (): Promise<OperationResult<CancellationResult>> => {
      return {
        ok: false,
        error: {
          code: "transport_unavailable",
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

    // SAFETY INVARIANT: Cancellation accepted must NOT be confirmed as stopped when transport cancel failed!
    // When transport.cancel fails, the task must NOT be falsely marked with terminal status "cancelled".
    // (Upstream P06 service.ts:399 violates this by unconditionally calling confirmCancellationStop even if transport.cancel fails)
    if (cancelRes.ok) {
      const planTask = cancelRes.value.tasks.find((t: TaskState) => t.taskId === "plan");
      expect(planTask?.status).not.toBe("cancelled");
    } else {
      expect(cancelRes.error.code).toBe("transport_unavailable");
    }
  });
});
