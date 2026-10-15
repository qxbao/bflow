import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import { createStandardMvpWorkflow, expectFailure, expectOk } from "../helpers/fixtures.js";
import {
  DomainEventSchema,
  type AgentReconciliationRequest,
  type AgentReconciliationResult,
  type AgentRequest,
  type DomainEvent,
  type OperationResult,
  type TaskState
} from "@bflow/contracts";

type TaskDispatchRequestedEvent = Extract<DomainEvent, { type: "task.dispatch_requested" }>;

function isTaskDispatchRequestedEvent(event: DomainEvent): event is TaskDispatchRequestedEvent {
  return event.type === "task.dispatch_requested";
}

function matchesDispatchIntent(event: TaskDispatchRequestedEvent, req: AgentRequest): boolean {
  return (
    event.runId === req.runId &&
    event.taskId === req.taskId &&
    event.payload.requestId === req.requestId &&
    event.payload.attemptId === req.attemptId &&
    event.payload.agentId === req.target.agentId &&
    event.payload.attempt === req.attempt &&
    event.payload.target.transport === req.target.transport &&
    event.payload.target.agentId === req.target.agentId
  );
}

describe("Scenario E03 — Unknown Delivery & Transport Reconciliation", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("helper verification: validates matchesDispatchIntent logic against DomainEventSchema-parsed event and AgentRequest", () => {
    // Demonstrates that matching event passes and wrong requestId fails, without faking Runtime events in E2E scenarios
    const validRawEvent = {
      schemaVersion: 1,
      eventId: "evt-dispatch-1",
      runId: "run-test-1",
      taskId: "plan",
      sequence: 1,
      aggregateVersion: 1,
      occurredAt: new Date().toISOString(),
      correlationId: "corr-1",
      idempotencyKey: "idem-1",
      type: "task.dispatch_requested" as const,
      payload: {
        requestId: "req-1",
        attemptId: "att-1",
        agentId: "agent-planner",
        attempt: 1,
        target: {
          transport: "herdr",
          agentId: "agent-planner",
          paneId: "pane-planner"
        }
      }
    };
    const parsedEvent = DomainEventSchema.parse(validRawEvent);
    expect(isTaskDispatchRequestedEvent(parsedEvent)).toBe(true);

    if (isTaskDispatchRequestedEvent(parsedEvent)) {
      const matchingReq: AgentRequest = {
        requestId: "req-1",
        attemptId: "att-1",
        runId: "run-test-1",
        taskId: "plan",
        role: "planner",
        target: {
          transport: "herdr",
          agentId: "agent-planner",
          paneId: "pane-planner"
        },
        instruction: "Create implementation plan",
        inputs: [],
        attempt: 1,
        retry: {
          maxAttempts: 3,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        timeout: {
          executionTimeoutMs: 60000,
          onTimeout: "fail"
        },
        idempotency: {
          key: "idem-req-1",
          scope: "agent-request",
          fingerprint: "a".repeat(64)
        },
        createdAt: new Date().toISOString()
      };

      expect(matchesDispatchIntent(parsedEvent, matchingReq)).toBe(true);

      const mismatchedReq: AgentRequest = {
        ...matchingReq,
        requestId: "wrong-req-id"
      };
      expect(matchesDispatchIntent(parsedEvent, mismatchedReq)).toBe(false);
    }
  });

  it("handles unknown delivery timeout: forbids blind resend and requires reconciliation", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    // Configure transport to simulate unknown delivery before write
    harness.transport.setDeliveryMode("unknown-before-write");

    // Pre-send observation hook: assert EXACT task.dispatch_requested event is persisted in RunStore BEFORE transport write
    let exactDispatchRequestedEvent: TaskDispatchRequestedEvent | undefined;
    let payloadIdentityMatched = false;
    harness.transport.onBeforeSend = async (req: AgentRequest) => {
      const eventsRes = await harness.runStore.readEvents(req.runId, { limit: 100 });
      if (eventsRes.ok) {
        const found = eventsRes.value.items.find(
          (e: DomainEvent): e is TaskDispatchRequestedEvent => isTaskDispatchRequestedEvent(e) && e.taskId === req.taskId
        );
        if (found) {
          exactDispatchRequestedEvent = found;
          if (matchesDispatchIntent(found, req)) {
            payloadIdentityMatched = true;
          }
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

    // ARCHITECTURAL INVARIANT: EXACT task.dispatch_requested event with correlated payload identity
    // MUST be persisted in RunStore before transport send. Generic running state is NOT dispatch intent.
    // (Upstream P06 currently violates this by omitting task.dispatch_requested before transport send)
    expect(exactDispatchRequestedEvent).toBeDefined();
    expect(payloadIdentityMatched).toBe(true);

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

  it("retains unknown_delivery across harness restart: resume does not blind-resend when reconciliation remains uncertain", async () => {
    harness = await createE2eHarness();
    const runId = `run-restart-unknown-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    // Pre-restart: transport returns unknown_delivery before write, and initial reconcile also returns unknown_delivery
    harness.transport.setDeliveryMode("unknown-before-write");

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Unknown delivery across restart - remains uncertain" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    const startErr = expectFailure(startRes);
    expect(startErr.code).toBe("unknown_delivery");

    expect(harness.transport.sendCallsCount).toBe(1);
    expect(harness.transport.externalWriteCount).toBe(0);
    expect(harness.transport.reconcileCallsCount).toBe(1);

    const preRestartSnap = expectOk(await harness.service.getRun(runId));
    expect(preRestartSnap?.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("blocked");

    // Verify task.dispatch_requested is durably persisted in SQLite before restart
    const preRestartEvents = expectOk(await harness.runStore.readEvents(runId, { limit: 100 }));
    expect(preRestartEvents.items.some((e: DomainEvent) => isTaskDispatchRequestedEvent(e) && e.taskId === "plan")).toBe(true);

    // Restart harness against the same SQLite database and filesystem
    const restarted = await harness.restart();

    // Post-restart: reconciliation still returns unknown_delivery (no entry in serverLedger)
    const resumeRes = await restarted.service.resume(runId);
    const resumeSnap = expectOk(resumeRes);

    // CRITICAL INVARIANT: No blind automatic resend across restart!
    expect(harness.transport.sendCallsCount).toBe(1);
    expect(harness.transport.externalWriteCount).toBe(0);
    expect(harness.transport.reconcileCallsCount).toBe(2);

    const postRestartPlan = resumeSnap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(postRestartPlan?.status).toBe("blocked");
    expect(postRestartPlan?.agentExecution).toBeUndefined();
  });

  it("reconciles unknown_delivery as bound across harness restart: resume binds existing remote execution with zero duplicate sends", async () => {
    harness = await createE2eHarness();
    const runId = `run-restart-bound-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    // Pre-restart: remote write succeeds (recorded in serverLedger), but response times out
    harness.transport.setDeliveryMode("unknown-after-write");

    // Initial pre-restart reconciliation also returns unknown_delivery so task becomes "blocked" before restart
    harness.transport.setCustomReconcileHandler(
      async (req: AgentReconciliationRequest): Promise<OperationResult<AgentReconciliationResult>> => ({
        ok: true,
        value: {
          status: "unknown_delivery",
          requestId: req.requestId,
          retrySafe: false,
          observedAt: new Date().toISOString(),
          reason: "Remote ledger temporarily unreachable before restart",
          manualInterventionRequired: true
        }
      })
    );

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Unknown delivery across restart - reconciled bound" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    const startErr = expectFailure(startRes);
    expect(startErr.code).toBe("unknown_delivery");

    expect(harness.transport.sendCallsCount).toBe(1);
    expect(harness.transport.externalWriteCount).toBe(1);

    const preRestartSnap = expectOk(await harness.service.getRun(runId));
    const preRestartPlan = preRestartSnap?.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(preRestartPlan?.status).toBe("blocked");
    expect(preRestartPlan?.agentExecution).toBeUndefined();

    // Restart harness; clear custom handler so default reconciliation reads the bound handle from serverLedger
    harness.transport.setCustomReconcileHandler(undefined);
    const restarted = await harness.restart();

    const resumeRes = await restarted.service.resume(runId);
    const resumeSnap = expectOk(resumeRes);

    const postRestartPlan = resumeSnap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(postRestartPlan?.status).toBe("running");
    expect(postRestartPlan?.agentExecution).toBeDefined();

    // CRITICAL INVARIANT: Zero duplicate transport sends or external writes across restart!
    expect(harness.transport.sendCallsCount).toBe(1);
    expect(harness.transport.externalWriteCount).toBe(1);
    expect(harness.transport.reconcileCallsCount).toBe(2);
  });

  it("reconciles unknown_delivery as not_delivered (retrySafe) across harness restart: resume safely re-dispatches and binds task", async () => {
    harness = await createE2eHarness();
    const runId = `run-restart-not-delivered-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    // Pre-restart: send returns unknown_delivery before write, and initial reconcile fails due to transport unavailability
    harness.transport.setDeliveryMode("unknown-before-write");
    harness.transport.setCustomReconcileHandler(
      async (): Promise<OperationResult<AgentReconciliationResult>> => ({
        ok: false,
        error: {
          code: "transport_unavailable",
          retryable: true,
          message: "Transport offline during pre-restart reconciliation"
        }
      })
    );

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Unknown delivery across restart - reconciled not_delivered" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    const startErr = expectFailure(startRes);
    expect(startErr.code).toBe("transport_unavailable");

    expect(harness.transport.sendCallsCount).toBe(1);
    expect(harness.transport.externalWriteCount).toBe(0);

    // Restart harness; after restart, reconciliation proves not_delivered (retrySafe: true) and subsequent send succeeds
    harness.transport.setDeliveryMode("accepted");
    harness.transport.setCustomReconcileHandler(
      async (req: AgentReconciliationRequest): Promise<OperationResult<AgentReconciliationResult>> => ({
        ok: true,
        value: {
          status: "not_delivered",
          requestId: req.requestId,
          retrySafe: true,
          observedAt: new Date().toISOString()
        }
      })
    );

    const restarted = await harness.restart();
    const resumeRes = await restarted.service.resume(runId);
    const resumeSnap = expectOk(resumeRes);

    const postRestartPlan = resumeSnap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(postRestartPlan?.status).toBe("running");
    expect(postRestartPlan?.agentExecution).toBeDefined();

    // CRITICAL INVARIANT: Safe re-dispatch after restart proves not_delivered -> 2 total sends, 1 external write
    expect(harness.transport.sendCallsCount).toBe(2);
    expect(harness.transport.externalWriteCount).toBe(1);
    expect(harness.transport.reconcileCallsCount).toBe(2);
  });
});
