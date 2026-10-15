import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AgentRequest,
  ApprovalDecision,
  CancellationRequest,
  DomainEvent,
  StartRunInput,
  WorkflowDefinition
} from "@bflow/contracts";
import { TaskDispatcher } from "../../src/dispatcher.js";
import { createRuntimeService } from "../../src/service.js";
import { createDomainEventStream, DefaultRunEventHub } from "../../src/stream.js";
import {
  createSampleWorkflowDefinition,
  createTestHarness,
  type TestHarness
} from "./fixtures.js";

async function setupRun(
  harness: TestHarness,
  runId: string,
  def: WorkflowDefinition = createSampleWorkflowDefinition()
) {
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
    transport: harness.transport
  });

  const dispatcher = service.dispatcher;
  await dispatcher.scheduleReadyTasks(runId);
  const snapRes = await harness.engine.getSnapshot(runId);

  return {
    service,
    orchestrator: service.orchestrator,
    dispatcher,
    snapshot: snapRes.value!,
    definition: def
  };
}

describe("Challenger M3.1 Empirical White-Box Adversarial Stress Suite", { timeout: 30000 }, () => {
  // =========================================================================
  // SUITE 1: RuntimeService White-Box Ingress & Lifecycle Hardening
  // =========================================================================
  describe("Suite 1: RuntimeService Ingress & Lifecycle Hardening", () => {
    it("1.1: service.start fails closed with validation error on malformed StartRunInput", async () => {
      const harness = await createTestHarness();
      try {
        const service = createRuntimeService(harness.ports);

        const invalidInput = {
          runId: "invalid/with/slashes",
          requestedAt: "not-a-date"
        } as unknown as StartRunInput;

        const res = await service.start(invalidInput);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
          expect(res.error.retryable).toBe(false);
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("1.2: service.start rejects invalid workflow definition without mutating RunStore", async () => {
      const harness = await createTestHarness();
      try {
        const service = createRuntimeService(harness.ports);
        const runId = `run-invalid-def-${randomUUID()}`;

        // Definition with cyclic dependency: task-a -> task-b -> task-a
        const cyclicDef: WorkflowDefinition = {
          schemaVersion: "1",
          id: "cyclic-workflow",
          name: "Cyclic Workflow",
          version: "1.0.0",
          description: "Invalid cyclic DAG",
          maxConcurrency: 1,
          failurePolicy: "fail-fast",
          recovery: {
            checkpoint: "task-boundary",
            resumeStrategy: "checkpoint-then-replay",
            staleExecution: "reconcile"
          },
          qualityGates: [],
          tasks: [
            {
              id: "task-a",
              title: "Task A",
              role: "developer",
              instruction: "Do A",
              acceptanceCriteria: ["A done"],
              retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 1000, jitter: false },
              timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
              requiresApproval: false,
              qualityGates: []
            },
            {
              id: "task-b",
              title: "Task B",
              role: "developer",
              instruction: "Do B",
              acceptanceCriteria: ["B done"],
              retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 1000, jitter: false },
              timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
              requiresApproval: false,
              qualityGates: []
            }
          ],
          dependencies: [
            { taskId: "task-a", dependsOnTaskId: "task-b", condition: "succeeded" },
            { taskId: "task-b", dependsOnTaskId: "task-a", condition: "succeeded" }
          ]
        };

        const res = await service.start({
          runId,
          definition: cyclicDef,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `start-${runId}`
        });

        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
        }

        // Verify RunStore was NOT touched
        const stored = await harness.runStore.get(runId);
        expect(stored.ok).toBe(true);
        expect(stored.value).toBeNull();
      } finally {
        await harness.cleanup();
      }
    });

    it("1.3: service.getRun returns validation error on malformed runId and null on non-existent runId", async () => {
      const harness = await createTestHarness();
      try {
        const service = createRuntimeService(harness.ports);

        // Empty runId (fails IdentifierSchema)
        const emptyRes = await service.getRun("");
        expect(emptyRes.ok).toBe(false);
        if (!emptyRes.ok) {
          expect(emptyRes.error.code).toBe("validation");
        }

        // Whitespace runId (fails IdentifierSchema.trim().min(1))
        const whitespaceRes = await service.getRun("   ");
        expect(whitespaceRes.ok).toBe(false);
        if (!whitespaceRes.ok) {
          expect(whitespaceRes.error.code).toBe("validation");
        }

        // Non-existent valid runId
        const missingRes = await service.getRun("run-999-missing");
        expect(missingRes.ok).toBe(true);
        expect(missingRes.value).toBeNull();
      } finally {
        await harness.cleanup();
      }
    });

    it("1.4: service.findRuns fails closed with validation error on invalid query parameters", async () => {
      const harness = await createTestHarness();
      try {
        const service = createRuntimeService(harness.ports);

        const invalidRes = await service.findRuns({ limit: -5 } as any);
        expect(invalidRes.ok).toBe(false);
        if (!invalidRes.ok) {
          expect(invalidRes.error.code).toBe("validation");
          expect(invalidRes.error.retryable).toBe(false);
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("1.5: service.decide directly executes approval contract and enforces human governance", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-decide-${randomUUID()}`;
        const { service } = await setupRun(harness, runId);

        // AI actor decision is rejected
        const aiDecision: ApprovalDecision = {
          schemaVersion: 1,
          approvalId: `appr-ai-${randomUUID()}`,
          runId,
          target: { type: "run" },
          revision: 1,
          generation: 0,
          decision: "approved",
          decidedBy: "chatgpt-4o",
          decidedAt: new Date().toISOString(),
          feedbackArtifacts: [],
          idempotencyKey: `idemp-ai-${randomUUID()}`
        };

        const aiRes = await service.decide(aiDecision);
        expect(aiRes.ok).toBe(false);
        if (!aiRes.ok) {
          expect(aiRes.error.code).toBe("validation");
          expect(aiRes.error.message).toContain("Mandatory human approval cannot be satisfied by an automated or AI actor");
        }

        // Human decision on a run that is not waiting for approval
        const humanDecision: ApprovalDecision = {
          schemaVersion: 1,
          approvalId: `appr-human-${randomUUID()}`,
          runId,
          target: { type: "run" },
          revision: 1,
          generation: 0,
          decision: "approved",
          decidedBy: "lead_architect_human",
          decidedAt: new Date().toISOString(),
          feedbackArtifacts: [],
          idempotencyKey: `idemp-human-${randomUUID()}`
        };

        const humanRes = await service.decide(humanDecision);
        expect(humanRes.ok).toBe(false);
        if (!humanRes.ok) {
          expect(["conflict", "validation"]).toContain(humanRes.error.code);
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("1.6: service.cancel handles task-level overload, non-existent run, and schema validation", async () => {
      const harness = await createTestHarness();
      try {
        const service = createRuntimeService(harness.ports);
        const definition = createSampleWorkflowDefinition();
        const runId = `run-cancel-test-${randomUUID()}`;

        // 1. Non-existent run
        const notFoundRes = await service.cancel({ runId: "run-non-existent" });
        expect(notFoundRes.ok).toBe(false);
        if (!notFoundRes.ok) {
          expect(notFoundRes.error.code).toBe("not_found");
        }

        // 2. Malformed CancellationRequest
        const malformedRes = await service.cancel({
          schemaVersion: 99,
          cancellationId: "not-a-uuid"
        } as any);
        expect(malformedRes.ok).toBe(false);
        if (!malformedRes.ok) {
          expect(malformedRes.error.code).toBe("validation");
        }

        // 3. Task-level cancellation
        const { snapshot, dispatcher } = await setupRun(harness, runId, definition);
        await dispatcher.dispatchTask(definition, snapshot, "plan", "Do planning");

        const cancelTaskRes = await service.cancel({
          runId,
          taskId: "plan",
          reason: "Operator aborted planning phase"
        });

        expect(cancelTaskRes.ok).toBe(true);
        if (cancelTaskRes.ok) {
          const planTask = cancelTaskRes.value.tasks.find((t) => t.taskId === "plan");
          expect(planTask?.status).toBe("cancelled");
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("1.7: service.resume validates input object and fails closed on non-existent run", async () => {
      const harness = await createTestHarness();
      try {
        const service = createRuntimeService(harness.ports);

        const invalidResume = await service.resume({
          runId: "invalid/id/with/slashes",
          requestedAt: "invalid-date",
          idempotencyKey: "k"
        });
        expect(invalidResume.ok).toBe(false);
        if (!invalidResume.ok) {
          expect(invalidResume.error.code).toBe("validation");
        }

        const missingResume = await service.resume("run-does-not-exist");
        expect(missingResume.ok).toBe(false);
        if (!missingResume.ok) {
          expect(missingResume.error.code).toBe("not_found");
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("1.8: service.init propagates transport failure and allows subsequent re-initialization", async () => {
      const harness = await createTestHarness();
      try {
        let shouldFailInit = true;
        harness.transport.initialize = async () => {
          if (shouldFailInit) {
            return {
              ok: false,
              error: { code: "unavailable", retryable: true, message: "Transport connection timed out" }
            };
          }
          return {
            ok: true,
            value: {
              transportName: "fake-transport",
              protocolVersion: "1.0",
              supportsStreaming: true,
              supportsCancellation: true,
              supportsReconciliation: true
            }
          };
        };

        const service = createRuntimeService(harness.ports);

        // Attempt 1 fails
        const init1 = await service.init();
        expect(init1.ok).toBe(false);
        if (!init1.ok) {
          expect(init1.error.code).toBe("unavailable");
        }

        // Attempt 2 succeeds because initialized remained false
        shouldFailInit = false;
        const init2 = await service.init();
        expect(init2.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // SUITE 2: TaskDispatcher White-Box Edge Cases & Lease Safety
  // =========================================================================
  describe("Suite 2: TaskDispatcher White-Box Edge Cases & Lease Safety", () => {
    it("2.1: TaskDispatcher fails closed with not_found when task role has no registered agent", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-no-agent-${randomUUID()}`;
        const definition = createSampleWorkflowDefinition();

        const defWithUnknownRole: WorkflowDefinition = {
          ...definition,
          tasks: [
            {
              ...definition.tasks[0],
              role: "security-auditor-unregistered"
            },
            ...definition.tasks.slice(1)
          ]
        };

        const { snapshot, dispatcher } = await setupRun(harness, runId, defWithUnknownRole);

        const dispatchRes = await dispatcher.dispatchTask(
          defWithUnknownRole,
          snapshot,
          "plan",
          "Execute security audit"
        );

        expect(dispatchRes.ok).toBe(false);
        if (!dispatchRes.ok) {
          expect(dispatchRes.error.code).toBe("not_found");
          expect(dispatchRes.error.message).toContain("No agent found for role security-auditor-unregistered");
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("2.2: TaskDispatcher releases lease and returns conflict when transport returns rejected status", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-rejected-prompt-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);

        harness.transport.customSendHandler = (req: AgentRequest) => ({
          ok: true,
          value: {
            status: "rejected",
            requestId: req.requestId,
            attemptId: req.attemptId,
            runId: req.runId,
            taskId: req.taskId,
            idempotencyKey: req.idempotency.key,
            target: req.target,
            observedAt: new Date().toISOString(),
            reason: "Agent host out of GPU memory"
          }
        });

        const dispatchRes = await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispatchRes.ok).toBe(false);
        if (!dispatchRes.ok) {
          expect(dispatchRes.error.code).toBe("conflict");
          expect(dispatchRes.error.retryable).toBe(true);
          expect(dispatchRes.error.message).toContain("Agent rejected prompt: Agent host out of GPU memory");
        }

        // Verify lease was released and can be immediately acquired by another task
        const probeLease = await harness.agentRegistry.acquireLease({
          leaseId: `probe-lease-${randomUUID()}`,
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `probe-key-${randomUUID()}`
        });
        expect(probeLease.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("2.3: TaskDispatcher releases lease when transport reconcile returns an error", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-recon-error-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);

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
            reason: "Socket closed before transport ACK"
          }
        });

        harness.transport.customReconcileHandler = () => ({
          ok: false,
          error: { code: "unavailable", retryable: true, message: "Reconcile transport unreachable" }
        });

        const dispatchRes = await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispatchRes.ok).toBe(false);
        if (!dispatchRes.ok) {
          expect(dispatchRes.error.code).toBe("unavailable");
          expect(dispatchRes.error.message).toContain("Reconcile transport unreachable");
        }

        // Capacity lease must be released
        const probeLease = await harness.agentRegistry.acquireLease({
          leaseId: `probe-lease-${randomUUID()}`,
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `probe-key-${randomUUID()}`
        });
        expect(probeLease.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("2.4: TaskDispatcher releases lease when reconcile proves not_delivered but resend is rejected", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-recon-resend-rejected-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);

        let sendAttempt = 0;
        harness.transport.customSendHandler = (req: AgentRequest) => {
          sendAttempt++;
          if (sendAttempt === 1) {
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
                reason: "Network timeout on first send"
              }
            };
          }
          return {
            ok: true,
            value: {
              status: "rejected",
              requestId: req.requestId,
              attemptId: req.attemptId,
              runId: req.runId,
              taskId: req.taskId,
              idempotencyKey: req.idempotency.key,
              target: req.target,
              observedAt: new Date().toISOString(),
              reason: "Agent rejected prompt on retry"
            }
          };
        };

        harness.transport.customReconcileHandler = () => ({
          ok: true,
          value: {
            status: "not_delivered"
          }
        });

        const dispatchRes = await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispatchRes.ok).toBe(false);
        if (!dispatchRes.ok) {
          expect(dispatchRes.error.code).toBe("conflict");
          expect(dispatchRes.error.message).toContain("Resend returned rejected");
        }

        const probeLease = await harness.agentRegistry.acquireLease({
          leaseId: `probe-lease-${randomUUID()}`,
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `probe-key-${randomUUID()}`
        });
        expect(probeLease.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("2.5: TaskDispatcher releases lease when reconcile proves not_delivered but resend fails with transport error", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-recon-resend-err-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);

        let sendAttempt = 0;
        harness.transport.customSendHandler = (req: AgentRequest) => {
          sendAttempt++;
          if (sendAttempt === 1) {
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
                reason: "Initial transport timeout"
              }
            };
          }
          return {
            ok: false,
            error: { code: "timeout", retryable: true, message: "Transport timed out during resend" }
          };
        };

        harness.transport.customReconcileHandler = () => ({
          ok: true,
          value: {
            status: "not_delivered"
          }
        });

        const dispatchRes = await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispatchRes.ok).toBe(false);
        if (!dispatchRes.ok) {
          expect(dispatchRes.error.code).toBe("timeout");
          expect(dispatchRes.error.message).toContain("Transport timed out during resend");
        }

        const probeLease = await harness.agentRegistry.acquireLease({
          leaseId: `probe-lease-${randomUUID()}`,
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `probe-key-${randomUUID()}`
        });
        expect(probeLease.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("2.6: Unhandled exception in dispatchTask releases lease before rethrowing", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-unhandled-err-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);

        harness.transport.customSendHandler = () => {
          throw new Error("Catastrophic fatal transport panic");
        };

        await expect(
          dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan")
        ).rejects.toThrow("Catastrophic fatal transport panic");

        // Verify capacity lease was released cleanly in agent registry despite the thrown exception
        const probeLease = await harness.agentRegistry.acquireLease({
          leaseId: `probe-lease-${randomUUID()}`,
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `probe-key-${randomUUID()}`
        });
        expect(probeLease.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("2.7: scheduleReadyTasks returns not_found on non-existent runId", async () => {
      const harness = await createTestHarness();
      try {
        const dispatcher = new TaskDispatcher(harness.ports);
        const res = await dispatcher.scheduleReadyTasks("run-does-not-exist-at-all");
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("not_found");
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("2.8: cancelTask proceeds to confirm stop and releases lease even if transport cancel fails", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-cancel-transport-err-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);

        const dispatchRes = await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispatchRes.ok).toBe(true);

        harness.transport.customCancelHandler = () => ({
          ok: false,
          error: { code: "timeout", retryable: true, message: "Transport cancel connection timed out" }
        });

        const cancelRes = await dispatcher.cancelTask(runId, "plan", "Operator cancel");
        expect(cancelRes.ok).toBe(true);

        // Active execution is cleared and task is cancelled
        expect(dispatcher.getActiveExecution(runId, "plan")).toBeUndefined();
        const postSnap = (await harness.engine.getSnapshot(runId)).value!;
        const planTask = postSnap.tasks.find((t) => t.taskId === "plan")!;
        expect(planTask.status).toBe("cancelled");
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // SUITE 3: createDomainEventStream Buffering, Terminal Handling & Cleanup
  // =========================================================================
  describe("Suite 3: createDomainEventStream Buffering, Terminal Handling & Cleanup", () => {
    it("3.1: Watching an already terminal run replays historical events and terminates immediately", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-already-terminal-${randomUUID()}`;
        const service = createRuntimeService(harness.ports);
        const definition = createSampleWorkflowDefinition();

        const startRes = await service.startRun(definition, { runId });
        expect(startRes.ok).toBe(true);

        // Cancel the run so it becomes terminal 'cancelled'
        const cancelRes = await service.cancel({ runId, reason: "Aborting run" });
        expect(cancelRes.ok).toBe(true);
        expect(cancelRes.value.status).toBe("cancelled");

        const hub = new DefaultRunEventHub();
        const stream = createDomainEventStream(harness.ports, hub, runId);

        const yieldedEvents: DomainEvent[] = [];
        for await (const item of stream) {
          if (item.ok) {
            yieldedEvents.push(item.value);
          }
        }

        // Stream terminated immediately without hanging
        expect(yieldedEvents.length).toBeGreaterThanOrEqual(1);
        expect(
          yieldedEvents.some(
            (e) => e.type === "run.status_changed" && (e as any).payload.to === "cancelled"
          )
        ).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("3.2: Replays multi-page historical events (>100 events) in strict monotonic sequence", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-multipage-${randomUUID()}`;
        const definition = createSampleWorkflowDefinition();
        await harness.engine.validateDefinition(definition);

        const createRes = await harness.engine.createRun({
          runId,
          definition,
          idempotencyKey: `create-${runId}`,
          createdAt: new Date().toISOString()
        });
        const initialSnapshot = {
          ...createRes.value.snapshot,
          version: 0,
          lastEventSequence: 0
        };
        await harness.runStore.create({ snapshot: initialSnapshot, definition }, `store-${runId}`);

        // Append initial run.created event
        await harness.runStore.appendEvents({
          runId,
          expectedVersion: 0,
          expectedLastSequence: 0,
          events: createRes.value.emittedEvents,
          idempotencyKey: `init-events-${runId}`
        });

        // Generate 120 command.completed events in 4 batches of 30
        let currentSeq = createRes.value.emittedEvents.length;
        let currentVer = createRes.value.emittedEvents.length;

        for (let batch = 0; batch < 4; batch++) {
          const eventsBatch: DomainEvent[] = [];
          for (let i = 0; i < 30; i++) {
            currentSeq++;
            currentVer++;
            eventsBatch.push({
              schemaVersion: 1,
              eventId: `evt-cmd-${runId}-${currentSeq}`,
              runId,
              sequence: currentSeq,
              aggregateVersion: currentVer,
              occurredAt: new Date().toISOString(),
              correlationId: `corr-${currentSeq}`,
              idempotencyKey: `idemp-batch-${batch}-${i}`,
              type: "command.completed",
              payload: {
                schemaVersion: 1,
                commandId: `cmd-${batch}-${i}`,
                idempotencyKey: `cmd-key-${batch}-${i}`,
                operation: "advance",
                fingerprint: createHash("sha256").update(`fp-${batch}-${i}`).digest("hex"),
                firstEventSequence: currentSeq,
                runnableTaskIds: []
              }
            } as any);
          }

          const appendRes = await harness.runStore.appendEvents({
            runId,
            expectedVersion: currentVer - 30,
            expectedLastSequence: currentSeq - 30,
            events: eventsBatch,
            idempotencyKey: `batch-${batch}`
          });
          expect(appendRes.ok).toBe(true);
        }

        // Add 1 terminal event
        currentSeq++;
        currentVer++;
        const terminalEvent: DomainEvent = {
          schemaVersion: 1,
          eventId: `evt-term-${runId}`,
          runId,
          sequence: currentSeq,
          aggregateVersion: currentVer,
          occurredAt: new Date().toISOString(),
          correlationId: `corr-term`,
          idempotencyKey: `idemp-term`,
          type: "run.status_changed",
          payload: { from: "queued", to: "cancelled" }
        };
        await harness.runStore.appendEvents({
          runId,
          expectedVersion: currentVer - 1,
          expectedLastSequence: currentSeq - 1,
          events: [terminalEvent],
          idempotencyKey: "append-term"
        });

        const hub = new DefaultRunEventHub();
        const stream = createDomainEventStream(harness.ports, hub, runId);

        const receivedSequences: number[] = [];
        for await (const item of stream) {
          if (item.ok) {
            receivedSequences.push(item.value.sequence);
          }
        }

        // Total events: 2 (from createRun) + 120 (command.completed) + 1 (terminal) = 123 events (> 100 limit per page)
        expect(receivedSequences.length).toBe(123);
        expect(receivedSequences[0]).toBe(1);
        expect(receivedSequences[122]).toBe(123);

        // Strict monotonicity check
        for (let i = 0; i < receivedSequences.length; i++) {
          expect(receivedSequences[i]).toBe(i + 1);
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("3.3: createDomainEventStream yields error and terminates when runStore.readEvents fails", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-store-err-${randomUUID()}`;
        await setupRun(harness, runId);

        // Inject storage error in readEvents
        harness.runStore.readEvents = async () => ({
          ok: false,
          error: { code: "corruption", retryable: false, message: "Corrupted SQLite page on disk" }
        });

        const hub = new DefaultRunEventHub();
        const stream = createDomainEventStream(harness.ports, hub, runId);

        const items = [];
        for await (const item of stream) {
          items.push(item);
        }

        expect(items).toHaveLength(1);
        expect(items[0].ok).toBe(false);
        if (!items[0].ok) {
          expect(items[0].error.code).toBe("corruption");
          expect(items[0].error.message).toContain("Corrupted SQLite page on disk");
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("3.4: createDomainEventStream filters historical events via afterSequence option", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-after-seq-${randomUUID()}`;
        const definition = createSampleWorkflowDefinition();
        const service = createRuntimeService(harness.ports);

        const startRes = await service.startRun(definition, { runId });
        expect(startRes.ok).toBe(true);

        const cancelRes = await service.cancel({ runId, reason: "Cancel test" });
        expect(cancelRes.ok).toBe(true);

        // Read all events first to know total sequence count
        const allEventsRes = await harness.runStore.readEvents(runId);
        expect(allEventsRes.ok).toBe(true);
        const allEvents = allEventsRes.value.items;
        expect(allEvents.length).toBeGreaterThan(2);

        const cutSequence = allEvents[1].sequence;
        const hub = new DefaultRunEventHub();
        const stream = createDomainEventStream(harness.ports, hub, runId, { afterSequence: cutSequence });

        const receivedSeqs: number[] = [];
        for await (const item of stream) {
          if (item.ok) {
            receivedSeqs.push(item.value.sequence);
          }
        }

        // All yielded events must have sequence > cutSequence
        expect(receivedSeqs.length).toBe(allEvents.length - 2);
        for (const seq of receivedSeqs) {
          expect(seq).toBeGreaterThan(cutSequence);
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("3.5: Clean unsubscription: listener is cleanly deleted from hub when consumer breaks early", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-unsub-clean-${randomUUID()}`;
        const service = createRuntimeService(harness.ports);
        const definition = createSampleWorkflowDefinition();

        const startRes = await service.startRun(definition, { runId });
        expect(startRes.ok).toBe(true);

        const hub = new DefaultRunEventHub();
        const stream = createDomainEventStream(harness.ports, hub, runId);

        // Break after first yielded item
        let count = 0;
        for await (const item of stream) {
          count++;
          break;
        }

        expect(count).toBe(1);

        // Hub internal listeners map must not retain any listeners for this runId
        const listenersMap = (hub as any).listeners as Map<string, Set<any>>;
        expect(listenersMap.has(runId)).toBe(false);
      } finally {
        await harness.cleanup();
      }
    });
  });
});
