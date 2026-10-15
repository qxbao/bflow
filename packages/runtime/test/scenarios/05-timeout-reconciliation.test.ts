import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AgentExecutionHandle,
  AgentRequest,
  WorkflowDefinition
} from "@bflow/contracts";
import { TaskDispatcher } from "../../src/dispatcher.js";
import { SdlcWorkflowOrchestrator } from "../../src/orchestrator.js";
import { createRuntimeService, type ConcreteRuntimeService } from "../../src/service.js";
import { createSampleWorkflowDefinition, createTestHarness } from "../unit/fixtures.js";

async function setupScenarioRun(
  harness: any,
  runId: string,
  def: WorkflowDefinition = createSampleWorkflowDefinition()
): Promise<{ orchestrator: SdlcWorkflowOrchestrator; dispatcher: TaskDispatcher; service: ConcreteRuntimeService }> {
  await harness.engine.validateDefinition(def);
  const createRes = await harness.engine.createRun({
    runId,
    definition: def,
    idempotencyKey: `create-${runId}`,
    createdAt: new Date().toISOString()
  });
  if (!createRes.ok) throw new Error(`createRun failed: ${createRes.error.message}`);

  await harness.runStore.create({ snapshot: createRes.value.snapshot, definition: def }, `store-${runId}`);
  if (createRes.value.emittedEvents.length > 0) {
    await harness.runStore.appendEvents({
      runId,
      expectedVersion: 0,
      expectedLastSequence: 0,
      events: createRes.value.emittedEvents,
      idempotencyKey: `init-events-${runId}`
    });
  }

  const service = createRuntimeService({
    engine: harness.engine,
    runStore: harness.runStore,
    artifactStore: harness.artifactStore,
    agentRegistry: harness.agentRegistry,
    transport: harness.transport,
    qualityGate: harness.qualityGate
  });

  return { orchestrator: service.orchestrator, dispatcher: service.dispatcher, service };
}

describe("Integration Scenario 5: Timeout & Ambiguous Delivery Reconciliation", { timeout: 30000 }, () => {
  it("5.1 & 5.2: On unknown_delivery, reconcile proves 'not_delivered'; lease is preserved, prompt re-sent safely and bound", async () => {
    const harness = await createTestHarness();
    try {
      const runId = "run-timeout-recon-safe-resend";
      const { dispatcher } = await setupScenarioRun(harness, runId);

      let sendCallCount = 0;
      let reconcileCallCount = 0;

      // 1. First send returns unknown_delivery (transport timeout before ACK)
      harness.transport.customSendHandler = (req: AgentRequest) => {
        sendCallCount++;
        if (sendCallCount === 1) {
          return {
            ok: true,
            value: {
              status: "unknown_delivery",
              requestId: req.requestId,
              attemptId: req.attemptId,
              runId: req.runId,
              taskId: req.taskId,
              idempotencyKey: req.idempotency.key,
              target: req.target,
              observedAt: new Date().toISOString(),
              reason: "Socket timeout before acknowledgment",
              resendAllowed: false,
              manualInterventionRequired: true
            }
          };
        }
        // Second send succeeds!
        const executionId = `exec-resend-${randomUUID()}`;
        return {
          ok: true,
          value: {
            status: "accepted",
            requestId: req.requestId,
            attemptId: req.attemptId,
            runId: req.runId,
            taskId: req.taskId,
            observedAt: new Date().toISOString(),
            handle: {
              executionId,
              requestId: req.requestId,
              attemptId: req.attemptId,
              runId: req.runId,
              taskId: req.taskId,
              idempotencyKey: req.idempotency.key,
              target: req.target,
              correlation: { token: req.requestId, provenance: "transport", verified: true },
              acceptedAt: new Date().toISOString()
            }
          }
        };
      };

      // 2. Reconcile returns 'not_delivered' (confirming safe resend is allowed)
      harness.transport.customReconcileHandler = (req: any) => {
        reconcileCallCount++;
        return {
          ok: true,
          value: {
            status: "not_delivered",
            requestId: req.requestId,
            retrySafe: true,
            observedAt: new Date().toISOString()
          }
        };
      };

      // 3. Schedule and dispatch 'plan'
      const schedRes = await dispatcher.scheduleReadyTasks(runId);
      expect(schedRes.ok).toBe(true);

      const snapRes = await harness.engine.getSnapshot(runId);
      const snapshot = snapRes.value!;

      const dispatchRes = await dispatcher.dispatchTask(
        createSampleWorkflowDefinition(),
        snapshot,
        "plan",
        "Generate spec"
      );

      // Verify dispatch succeeded after safe resend
      expect(dispatchRes.ok).toBe(true);
      expect(reconcileCallCount).toBe(1);
      expect(sendCallCount).toBe(2);

      // Verify active execution is bound and lease retained
      const active = dispatcher.getActiveExecution(runId, "plan");
      expect(active).toBeDefined();
      expect(active?.handle).toBeDefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("5.3: On unknown_delivery, reconcile proves 'delivered' (bound handle); zero duplicate send, execution bound", async () => {
    const harness = await createTestHarness();
    try {
      const runId = "run-timeout-recon-bound";
      const { dispatcher } = await setupScenarioRun(harness, runId);

      let sendCallCount = 0;
      let capturedRequest: AgentRequest | null = null;

      harness.transport.customSendHandler = (req: AgentRequest) => {
        sendCallCount++;
        capturedRequest = req;
        return {
          ok: true,
          value: {
            status: "unknown_delivery",
            requestId: req.requestId,
            attemptId: req.attemptId,
            runId: req.runId,
            taskId: req.taskId,
            idempotencyKey: req.idempotency.key,
            target: req.target,
            observedAt: new Date().toISOString(),
            reason: "Read timeout after server processing",
            resendAllowed: false,
            manualInterventionRequired: true
          }
        };
      };

      // Reconcile confirms the prompt was actually delivered and bound to a remote execution handle
      const remoteExecutionId = `remote-exec-${randomUUID()}`;
      harness.transport.customReconcileHandler = (req: any) => {
        const handle: AgentExecutionHandle = {
          executionId: remoteExecutionId,
          requestId: req.requestId,
          attemptId: req.attemptId,
          runId: req.runId,
          taskId: req.taskId,
          idempotencyKey: req.idempotencyKey,
          target: req.target,
          correlation: { token: req.requestId, provenance: "transport", verified: true },
          acceptedAt: new Date().toISOString()
        };
        return {
          ok: true,
          value: {
            status: "bound",
            handle
          }
        };
      };

      // Schedule and dispatch 'plan'
      await dispatcher.scheduleReadyTasks(runId);
      const snapRes = await harness.engine.getSnapshot(runId);
      const snapshot = snapRes.value!;

      const dispatchRes = await dispatcher.dispatchTask(
        createSampleWorkflowDefinition(),
        snapshot,
        "plan",
        "Generate spec"
      );

      expect(dispatchRes.ok).toBe(true);
      if (dispatchRes.ok) {
        expect(dispatchRes.value.executionId).toBe(remoteExecutionId);
      }

      // CRITICAL INVARIANT: Prompt was NOT sent a second time (zero duplicate prompt execution)
      expect(sendCallCount).toBe(1);

      // Verify execution is bound in engine snapshot
      const freshSnap = (await harness.engine.getSnapshot(runId)).value!;
      const planTask = freshSnap.tasks.find((t) => t.taskId === "plan")!;
      expect(planTask.agentExecution?.executionId).toBe(remoteExecutionId);

      // Verify active execution exists in dispatcher
      const active = dispatcher.getActiveExecution(runId, "plan");
      expect(active?.handle?.executionId).toBe(remoteExecutionId);
    } finally {
      await harness.cleanup();
    }
  });

  it("5.4: On unknown_delivery, reconcile also returns unknown_delivery -> transitions task to blocked for operator intervention", async () => {
    const harness = await createTestHarness();
    try {
      const runId = "run-timeout-recon-uncertain";
      const { dispatcher } = await setupScenarioRun(harness, runId);

      harness.transport.customSendHandler = (req: AgentRequest) => ({
        ok: true,
        value: {
          status: "unknown_delivery",
          requestId: req.requestId,
          attemptId: req.attemptId,
          runId: req.runId,
          taskId: req.taskId,
          idempotencyKey: req.idempotency.key,
          target: req.target,
          observedAt: new Date().toISOString(),
          reason: "Network timeout",
          resendAllowed: false,
          manualInterventionRequired: true
        }
      });

      // Reconcile cannot verify delivery either
      harness.transport.customReconcileHandler = (req: any) => ({
        ok: true,
        value: {
          status: "unknown_delivery",
          requestId: req.requestId,
          retrySafe: false,
          observedAt: new Date().toISOString(),
          reason: "Remote transport agent unreachable",
          manualInterventionRequired: true
        }
      });

      await dispatcher.scheduleReadyTasks(runId);
      const snapRes = await harness.engine.getSnapshot(runId);
      const snapshot = snapRes.value!;

      const dispatchRes = await dispatcher.dispatchTask(
        createSampleWorkflowDefinition(),
        snapshot,
        "plan",
        "Generate spec"
      );

      // Dispatch fails with typed unknown_delivery error requiring manual intervention
      expect(dispatchRes.ok).toBe(false);
      if (!dispatchRes.ok) {
        expect(dispatchRes.error.code).toBe("unknown_delivery");
        expect((dispatchRes.error as any).manualInterventionRequired).toBe(true);
      }

      // Lease is released to prevent holding capacity
      expect(dispatcher.getActiveExecution(runId, "plan")).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("5.5: Task execution timeout with onTimeout: 'block' transitions task and run to blocked", async () => {
    const harness = await createTestHarness();
    try {
      const definition: WorkflowDefinition = {
        ...createSampleWorkflowDefinition(),
        tasks: createSampleWorkflowDefinition().tasks.map((t) =>
          t.id === "plan" ? { ...t, timeout: { executionTimeoutMs: 100, onTimeout: "block" } } : t
        )
      };
      const runId = "run-timeout-block";
      const { orchestrator, dispatcher, service } = await setupScenarioRun(harness, runId, definition);

      const driveRes = await orchestrator.driveRun(runId);
      expect(driveRes.ok).toBe(true);

      const snapRunning = (await harness.engine.getSnapshot(runId)).value!;
      const planTask = snapRunning.tasks.find((t) => t.taskId === "plan")!;
      const handle = dispatcher.getActiveExecution(runId, "plan")?.handle ?? planTask.agentExecution;
      expect(handle).toBeDefined();
      if (!handle) throw new Error("Expected bound handle for plan task");

      // Record timeout result from agent
      const timeOutRes = await harness.engine.recordAgentResult({
        runId,
        taskId: "plan",
        expectedVersion: snapRunning.version,
        idempotencyKey: `timeout-result-${runId}`,
        occurredAt: new Date().toISOString(),
        result: {
          requestId: handle.requestId,
          attemptId: handle.attemptId,
          runId,
          taskId: "plan",
          executionId: handle.executionId,
          status: "timed_out",
          verification: {
            status: "verified",
            evidence: "Verified timeout observation",
            correlation: { token: handle.correlation.token, provenance: "transport", verified: true }
          },
          artifactProposals: [],
          error: {
            code: "execution_timeout",
            message: "Execution exceeded 100ms timeout",
            retryable: false
          },
          retryable: false,
          startedAt: handle.acceptedAt,
          completedAt: new Date().toISOString(),
          output: { exitCode: 124, summary: "Execution exceeded 100ms timeout", artifactIds: [] }
        }
      });
      expect(timeOutRes.ok).toBe(true);

      const snapAfterTimeout = (await harness.engine.getSnapshot(runId)).value!;
      const planAfter = snapAfterTimeout.tasks.find((t) => t.taskId === "plan")!;
      expect(planAfter.status).toBe("blocked");

      const runStatus = (await service.getRunStatus(runId)).value!;
      expect(runStatus.status).toBe("blocked");
    } finally {
      await harness.cleanup();
    }
  });
});
