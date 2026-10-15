import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import { createStandardMvpWorkflow, expectFailure, expectOk } from "../helpers/fixtures.js";
import type {
  AgentExecutionHandle,
  AgentReconciliationRequest,
  AgentReconciliationResult,
  OperationResult,
  TaskState
} from "@ai-flow/contracts";

describe("Scenario E03 — Unknown Delivery & Transport Reconciliation", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("handles unknown delivery timeout: forbids blind resend and requires reconciliation", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    // Configure transport to simulate unknown delivery on first send
    harness.transport.setSimulateUnknownDelivery(true);

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Unknown delivery test - uncertain" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    // service.start immediately executes the drive loop, which hits unknown_delivery
    const startErr = expectFailure(startRes);
    expect(startErr.code).toBe("unknown_delivery");

    // CRITICAL RELIABILITY INVARIANT:
    // Exactly 1 send attempt must have occurred. NO BLIND AUTOMATIC RESEND!
    expect(harness.transport.sendCallsCount).toBe(1);

    // Reconcile must have been called exactly once
    expect(harness.transport.reconcileCallsCount).toBe(1);

    // Query snapshot state: task must NOT be running or completed
    const snapRes = await harness.service.getRun(runId);
    const snap = expectOk(snapRes);
    const planTask = snap?.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(planTask?.status).toBe("blocked");
  });

  it("reconciles unknown delivery when server ledger has record: binds without duplicate dispatch", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    // Simulate situation: prompt actually reached server and server recorded it,
    // but the HTTP response timed out on return, giving unknown_delivery to the client.
    harness.transport.setSimulateUnknownDelivery(true);

    let recordedRequestId: string | undefined;
    harness.transport.setCustomReconcileHandler(
      async (req: AgentReconciliationRequest): Promise<OperationResult<AgentReconciliationResult>> => {
        recordedRequestId = req.requestId;
        const executionId = `exec-reconciled-${randomUUID()}`;
        const handle: AgentExecutionHandle = {
          executionId,
          requestId: req.requestId,
          attemptId: req.attemptId,
          runId: req.runId,
          taskId: req.taskId,
          idempotencyKey: req.idempotencyKey,
          target: req.target,
          correlation: {
            token: req.requestId,
            provenance: "transport",
            verified: true
          },
          acceptedAt: new Date().toISOString()
        };
        return {
          ok: true,
          value: {
            status: "bound",
            handle
          }
        };
      }
    );

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Unknown delivery test - bound on reconcile" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    expectOk(startRes);

    const driveRes = await harness.service.orchestrator.driveRun(runId);
    const snap = expectOk(driveRes);

    const planTask = snap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(planTask?.status).toBe("running");
    expect(planTask?.agentExecution).toBeDefined();
    expect(planTask?.agentExecution?.requestId).toBe(recordedRequestId);

    // CRITICAL: Only 1 send side-effect occurred. Task bound from reconciliation proof!
    expect(harness.transport.sendCallsCount).toBe(1);
    expect(harness.transport.reconcileCallsCount).toBe(1);
  });

  it("safely re-sends when reconciliation proves remote agent never received prompt (not_delivered)", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    // First send times out
    harness.transport.setSimulateUnknownDelivery(true);

    // When reconcile is queried, server returns proof that request was never delivered
    harness.transport.setCustomReconcileHandler(
      async (req: AgentReconciliationRequest): Promise<OperationResult<AgentReconciliationResult>> => {
        // Once reconcile proves not_delivered, subsequent send will succeed
        harness.transport.setSimulateUnknownDelivery(false);
        return {
          ok: true,
          value: {
            status: "not_delivered",
            requestId: req.requestId,
            retrySafe: true,
            observedAt: new Date().toISOString()
          }
        };
      }
    );

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Unknown delivery test - not_delivered safe resend" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    expectOk(startRes);

    const driveRes = await harness.service.orchestrator.driveRun(runId);
    const snap = expectOk(driveRes);

    const planTask = snap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(planTask?.status).toBe("running");
    expect(planTask?.agentExecution).toBeDefined();

    // CRITICAL:
    // First send failed with unknown_delivery.
    // Reconcile was called and proved not_delivered.
    // Second send succeeded with accepted receipt.
    expect(harness.transport.sendCallsCount).toBe(2);
    expect(harness.transport.reconcileCallsCount).toBe(1);
  });
});
