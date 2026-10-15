import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import { createStandardMvpWorkflow, expectFailure, expectOk } from "../helpers/fixtures.js";
import type {
  AgentReconciliationRequest,
  AgentReconciliationResult,
  DomainEvent,
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

    // Configure transport to simulate unknown delivery before write
    harness.transport.setDeliveryMode("unknown-before-write");

    // Pre-send observation hook: assert task.dispatch_requested or running state is persisted in RunStore BEFORE transport write
    let dispatchIntentObservedBeforeWrite = false;
    harness.transport.onBeforeSend = async (req) => {
      const eventsRes = await harness.runStore.readEvents(req.runId, { limit: 100 });
      if (eventsRes.ok) {
        const hasDispatchIntent = eventsRes.value.items.some(
          (e: DomainEvent) =>
            (e.type === "task.dispatch_requested" && e.taskId === req.taskId) ||
            (e.type === "task.status_changed" && e.taskId === req.taskId && e.payload.to === "running")
        );
        if (hasDispatchIntent) {
          dispatchIntentObservedBeforeWrite = true;
        }
      }
    };

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

    // ARCHITECTURAL INVARIANT: task.dispatch_requested or running state MUST be persisted in RunStore before transport send
    expect(dispatchIntentObservedBeforeWrite).toBe(true);

    // CRITICAL RELIABILITY INVARIANT:
    // Exactly 1 send attempt occurred. NO BLIND AUTOMATIC RESEND!
    expect(harness.transport.sendCallsCount).toBe(1);
    // External write did NOT occur in drop-before-write mode
    expect(harness.transport.externalWriteCount).toBe(0);

    // Reconcile must have been called exactly once
    expect(harness.transport.reconcileCallsCount).toBe(1);

    // Query snapshot state: task must NOT be running or completed
    const snapRes = await harness.service.getRun(runId);
    const snap = expectOk(snapRes);
    const planTask = snap?.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(planTask?.status).toBe("blocked");
  });

  it("reconciles unknown-after-write when server ledger recorded execution: binds without duplicate dispatch", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    // Mode: unknown-after-write (remote external write occurs, but response times out)
    harness.transport.setDeliveryMode("unknown-after-write");

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

    // CRITICAL:
    // Exactly 1 transport send was called.
    // Exactly 1 external write was recorded on remote system.
    // Exactly 1 reconciliation query was executed.
    expect(harness.transport.sendCallsCount).toBe(1);
    expect(harness.transport.externalWriteCount).toBe(1);
    expect(harness.transport.reconcileCallsCount).toBe(1);
  });

  it("safely re-sends when reconciliation proves remote agent never received prompt (not_delivered)", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    // First send times out before write
    harness.transport.setDeliveryMode("unknown-before-write");

    // When reconcile is queried, server returns proof that request was never delivered
    harness.transport.setCustomReconcileHandler(
      async (req: AgentReconciliationRequest): Promise<OperationResult<AgentReconciliationResult>> => {
        // Once reconcile proves not_delivered, subsequent send will succeed
        harness.transport.setDeliveryMode("accepted");
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
    // First send resulted in unknown_delivery (before write: 0 external writes).
    // Reconcile was called and proved not_delivered.
    // Second send succeeded with accepted receipt (1 external write).
    expect(harness.transport.sendCallsCount).toBe(2);
    expect(harness.transport.externalWriteCount).toBe(1);
    expect(harness.transport.reconcileCallsCount).toBe(1);
  });
});
