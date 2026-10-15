import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import {
  createTestHarness,
  createSampleWorkflowDefinition
} from "./fixtures.js";
import { TaskDispatcher } from "../../src/dispatcher.js";
import { SdlcWorkflowOrchestrator } from "../../src/orchestrator.js";
import { AsyncQueue, createDomainEventStream, DefaultRunEventHub } from "../../src/stream.js";
import type {
  WorkflowRunSnapshot,
  WorkflowDefinition,
  DomainEvent,
  OperationResult
} from "@bflow/contracts";

async function setupRun(harness: any, runId: string, def: WorkflowDefinition = createSampleWorkflowDefinition()) {
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
  const dispatcher = new TaskDispatcher(harness.ports);
  await dispatcher.scheduleReadyTasks(runId);
  const snapRes = await harness.engine.getSnapshot(runId);
  return { snapshot: snapRes.value!, dispatcher, definition: def };
}

describe("Challenger M1 Iteration 2 Challenger 1 Empirical Adversarial Stress Suite", { timeout: 30000 }, () => {
  // =========================================================================
  // BUG 1: cancelTask after restart fallback
  // =========================================================================
  describe("Bug 1: TaskDispatcher.cancelTask restart fallback & 3-stage cancellation", () => {
    it("1.1: Post-restart cancelTask executes Stage 1, Stage 2, and Stage 3 with executionId", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher: dispatcher1, definition } = await setupRun(harness, runId);

        // Dispatch task 'plan' to bind execution handle
        const dispRes = await dispatcher1.dispatchTask(definition, snapshot, "plan", "Execute plan");
        expect(dispRes.ok).toBe(true);
        const boundHandle = dispRes.value!;
        expect(boundHandle.executionId).toBeDefined();

        // Verify task is bound in engine snapshot
        const boundSnap = (await harness.engine.getSnapshot(runId)).value!;
        const boundTask = boundSnap.tasks.find((t) => t.taskId === "plan")!;
        expect(boundTask.status).toBe("running");
        expect(boundTask.agentExecution?.executionId).toBe(boundHandle.executionId);

        // Simulate process restart: new TaskDispatcher with completely empty #activeExecutions
        const dispatcher2 = new TaskDispatcher(harness.ports);
        expect(dispatcher2.getActiveExecution(runId, "plan")).toBeUndefined();

        // Spies to verify 3-stage cancellation parameters
        const reqCancelSpy = vi.spyOn(harness.engine, "requestCancellation");
        const transportCancelSpy = vi.spyOn(harness.transport, "cancel");
        const confirmStopSpy = vi.spyOn(harness.engine, "confirmCancellationStop");

        // Execute cancellation via dispatcher2
        const cancelRes = await dispatcher2.cancelTask(runId, "plan", "Restart cancellation requested");
        expect(cancelRes.ok).toBe(true);

        // Verify Stage 1: engine.requestCancellation was called with executionId
        expect(reqCancelSpy).toHaveBeenCalledTimes(1);
        const reqArgs = reqCancelSpy.mock.calls[0][0];
        expect(reqArgs.runId).toBe(runId);
        expect(reqArgs.taskId).toBe("plan");
        expect(reqArgs.executionId).toBe(boundHandle.executionId);

        // Verify Stage 2: transport.cancel was called with bound handle
        expect(transportCancelSpy).toHaveBeenCalledTimes(1);
        const transportHandle = transportCancelSpy.mock.calls[0][0];
        expect(transportHandle.executionId).toBe(boundHandle.executionId);
        const transportCancelInput = transportCancelSpy.mock.calls[0][1];
        expect(transportCancelInput.executionId).toBe(boundHandle.executionId);

        // Verify Stage 3: engine.confirmCancellationStop was called with executionId
        expect(confirmStopSpy).toHaveBeenCalledTimes(1);
        const confirmArgs = confirmStopSpy.mock.calls[0][0];
        expect(confirmArgs.runId).toBe(runId);
        expect(confirmArgs.confirmation.executionId).toBe(boundHandle.executionId);
        expect(confirmArgs.confirmation.terminalStatus).toBe("cancelled");

        // Verify final engine state
        const postSnap = (await harness.engine.getSnapshot(runId)).value!;
        const planTask = postSnap.tasks.find((t) => t.taskId === "plan")!;
        expect(planTask.status).toBe("cancelled");
        expect(dispatcher2.getActiveExecution(runId, "plan")).toBeUndefined();
      } finally {
        await harness.cleanup();
      }
    });

    it("1.2: Post-restart cancelTask on an unbound task cancels cleanly without executionId", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        // Create run and schedule ready tasks, but do NOT dispatch
        const { snapshot } = await setupRun(harness, runId);
        const planTask = snapshot.tasks.find((t) => t.taskId === "plan")!;
        expect(planTask.status).toBe("running");
        expect(planTask.agentExecution).toBeUndefined(); // unbound!

        // New dispatcher after restart
        const dispatcher2 = new TaskDispatcher(harness.ports);
        const transportCancelSpy = vi.spyOn(harness.transport, "cancel");
        const confirmStopSpy = vi.spyOn(harness.engine, "confirmCancellationStop");

        const cancelRes = await dispatcher2.cancelTask(runId, "plan", "Cancel unbound task");
        expect(cancelRes.ok).toBe(true);

        // Stage 2 transport.cancel should NOT be called since no execution was bound
        expect(transportCancelSpy).not.toHaveBeenCalled();

        // Stage 3 confirmStop should not have executionId
        expect(confirmStopSpy).toHaveBeenCalledTimes(1);
        expect(confirmStopSpy.mock.calls[0][0].confirmation.executionId).toBeUndefined();

        // Engine status is cancelled
        const finalSnap = (await harness.engine.getSnapshot(runId)).value!;
        expect(finalSnap.tasks.find((t) => t.taskId === "plan")?.status).toBe("cancelled");
      } finally {
        await harness.cleanup();
      }
    });

    it("1.3: Post-restart cancelTask when transport.cancel fails still safely reaches terminal cancelled state", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher: dispatcher1, definition } = await setupRun(harness, runId);

        const dispRes = await dispatcher1.dispatchTask(definition, snapshot, "plan", "Execute plan");
        expect(dispRes.ok).toBe(true);

        // Transport cancel fails (e.g., agent unreachable or socket dead)
        vi.spyOn(harness.transport, "cancel").mockResolvedValueOnce({
          ok: false,
          error: { code: "unavailable", message: "Remote agent transport disconnected", retryable: false }
        });

        const dispatcher2 = new TaskDispatcher(harness.ports);
        const cancelRes = await dispatcher2.cancelTask(runId, "plan", "Abort dead transport");
        expect(cancelRes.ok).toBe(true);

        // Task must still be confirmed stopped as cancelled
        const postSnap = (await harness.engine.getSnapshot(runId)).value!;
        expect(postSnap.tasks.find((t) => t.taskId === "plan")?.status).toBe("cancelled");
      } finally {
        await harness.cleanup();
      }
    });

    it("1.4: Post-restart cancelTask is idempotent and rejects redundant cancels with conflict", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher: dispatcher1, definition } = await setupRun(harness, runId);

        await dispatcher1.dispatchTask(definition, snapshot, "plan", "Execute plan");
        const dispatcher2 = new TaskDispatcher(harness.ports);

        // First cancel succeeds
        const cancelRes1 = await dispatcher2.cancelTask(runId, "plan", "First cancel");
        expect(cancelRes1.ok).toBe(true);

        // Second cancel on terminal task returns conflict (already terminal)
        const cancelRes2 = await dispatcher2.cancelTask(runId, "plan", "Second cancel");
        expect(cancelRes2.ok).toBe(false);
        expect(cancelRes2.error.code).toBe("conflict");
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // BUGS 2 & 4: AsyncQueue & createDomainEventStream error delivery & listener cleanup
  // =========================================================================
  describe("Bugs 2 & 4: AsyncQueue & Stream listener cleanup and buffer overflow delivery", () => {
    it("2.1: AsyncQueue listener count drops to 0 after close() on non-aborted signal", () => {
      const controller = new AbortController();
      expect(getEventListeners(controller.signal, "abort").length).toBe(0);

      const queue = new AsyncQueue<string>({ signal: controller.signal, maxBufferSize: 10 });
      expect(getEventListeners(controller.signal, "abort").length).toBe(1);

      queue.close();
      expect(getEventListeners(controller.signal, "abort").length).toBe(0);
    });

    it("2.2: createDomainEventStream cleans up AbortSignal listeners upon consumer break / return", async () => {
      const harness = await createTestHarness();
      try {
        const hub = new DefaultRunEventHub();
        const runId = `run-${randomUUID()}`;
        await setupRun(harness, runId);

        const controller = new AbortController();
        expect(getEventListeners(controller.signal, "abort").length).toBe(0);

        const stream = createDomainEventStream(
          harness.ports,
          hub,
          runId,
          { signal: controller.signal }
        );

        // Start reading 1 item and then break immediately
        for await (const item of stream) {
          expect(item).toBeDefined();
          break; // Trigger return / finally
        }

        // Listener MUST be removed after loop break
        expect(getEventListeners(controller.signal, "abort").length).toBe(0);
      } finally {
        await harness.cleanup();
      }
    });

    it("2.3: Multiple concurrent streams sharing the same AbortSignal cleanly deregister individually", async () => {
      const harness = await createTestHarness();
      try {
        const hub = new DefaultRunEventHub();
        const runId = `run-${randomUUID()}`;
        await setupRun(harness, runId);

        const controller = new AbortController();
        const queues: AsyncQueue<any>[] = [];

        for (let i = 0; i < 50; i++) {
          queues.push(new AsyncQueue({ signal: controller.signal, maxBufferSize: 5 }));
        }
        expect(getEventListeners(controller.signal, "abort").length).toBe(50);

        // Close 20 queues
        for (let i = 0; i < 20; i++) {
          queues[i].close();
        }
        expect(getEventListeners(controller.signal, "abort").length).toBe(30);

        // Close remaining 30 queues
        for (let i = 20; i < 50; i++) {
          queues[i].close();
        }
        expect(getEventListeners(controller.signal, "abort").length).toBe(0);
      } finally {
        await harness.cleanup();
      }
    });

    it("2.4: Buffer overflow strictly delivers typed error result to consumer", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-overflow-${randomUUID()}`;
        const definition = createSampleWorkflowDefinition();
        await harness.engine.validateDefinition(definition);
        const createRes = await harness.engine.createRun({
          runId,
          definition,
          idempotencyKey: `create-${runId}`,
          createdAt: new Date().toISOString()
        });
        await harness.runStore.create(
          { snapshot: { ...createRes.value.snapshot, version: 0, lastEventSequence: 0 }, definition },
          `create-${runId}`
        );

        const hub = new DefaultRunEventHub();
        const maxBufferSize = 3;
        const stream = createDomainEventStream(harness.ports, hub, runId, { maxBufferSize });

        const makeEvent = (seq: number): DomainEvent => ({
          schemaVersion: 1,
          eventId: `evt-${runId}-${seq}`,
          runId,
          sequence: seq,
          aggregateVersion: seq,
          occurredAt: new Date().toISOString(),
          correlationId: `corr-${seq}`,
          idempotencyKey: `idemp-${seq}`,
          type: "task.status_changed",
          payload: { taskId: "plan", from: "ready", to: "running", attemptId: "att-1" }
        } as unknown as DomainEvent);

        // Publish 6 rapid events into a stream with buffer size 3
        // 1 event consumed by waiting pop + 3 events fill buffer = 4 ok events
        // 5th event causes overflow -> force pushes error
        // 6th event rejected by overflowed latch
        setTimeout(() => {
          hub.publish(runId, [
            makeEvent(1),
            makeEvent(2),
            makeEvent(3),
            makeEvent(4),
            makeEvent(5),
            makeEvent(6)
          ]);
        }, 30);

        const results: OperationResult<DomainEvent>[] = [];
        for await (const item of stream) {
          results.push(item);
        }

        // Expected: 4 successful events + 1 typed validation buffer overflow error
        expect(results.length).toBe(5);
        expect(results[0].ok).toBe(true);
        expect(results[1].ok).toBe(true);
        expect(results[2].ok).toBe(true);
        expect(results[3].ok).toBe(true);

        const terminalResult = results[4];
        expect(terminalResult.ok).toBe(false);
        if (!terminalResult.ok) {
          expect(terminalResult.error.code).toBe("validation");
          expect(terminalResult.error.message).toContain(`Event buffer overflow for runId: ${runId}`);
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("2.5: Overflowed stream rejects subsequent event batches and does not leak memory", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-overflow-subsequent-${randomUUID()}`;
        const definition = createSampleWorkflowDefinition();
        await harness.engine.validateDefinition(definition);
        const createRes = await harness.engine.createRun({
          runId,
          definition,
          idempotencyKey: `create-${runId}`,
          createdAt: new Date().toISOString()
        });
        await harness.runStore.create(
          { snapshot: { ...createRes.value.snapshot, version: 0, lastEventSequence: 0 }, definition },
          `create-${runId}`
        );

        const hub = new DefaultRunEventHub();
        const stream = createDomainEventStream(harness.ports, hub, runId, { maxBufferSize: 1 });

        const makeEvent = (seq: number): DomainEvent => ({
          schemaVersion: 1,
          eventId: `evt-${runId}-${seq}`,
          runId,
          sequence: seq,
          aggregateVersion: seq,
          occurredAt: new Date().toISOString(),
          correlationId: `corr-${seq}`,
          idempotencyKey: `idemp-${seq}`,
          type: "task.status_changed",
          payload: { taskId: "plan", from: "ready", to: "running", attemptId: "att-1" }
        } as unknown as DomainEvent);

        setTimeout(() => {
          hub.publish(runId, [makeEvent(1), makeEvent(2), makeEvent(3)]); // 1 to pop, 2 to buffer, 3 overflows
          // Later batch should be completely ignored by overflowed latch
          hub.publish(runId, [makeEvent(4), makeEvent(5)]);
        }, 30);

        const items: OperationResult<DomainEvent>[] = [];
        for await (const item of stream) {
          items.push(item);
        }

        // 2 ok items (1 from waiter, 1 from buffer) + 1 overflow error item = 3 items
        expect(items.length).toBe(3);
        expect(items[0].ok).toBe(true);
        expect(items[1].ok).toBe(true);
        expect(items[2].ok).toBe(false);
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // BUG 3: completeTaskExecution lease release & cleanup on failure
  // =========================================================================
  describe("Bug 3: completeTaskExecution lease release and active execution cleanup on failures", () => {
    it("3.1: Lease is released and capacity immediately available when recordAgentResult returns error", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);
        const orchestrator = new SdlcWorkflowOrchestrator(harness.ports, dispatcher);

        const dispRes = await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispRes.ok).toBe(true);
        expect(dispatcher.getActiveExecution(runId, "plan")).toBeDefined();

        // Simulate engine conflict during recordAgentResult
        vi.spyOn(harness.ports.engine, "recordAgentResult").mockResolvedValueOnce({
          ok: false,
          error: { code: "conflict", retryable: false, message: "Engine state conflict simulation" }
        });

        const completeRes = await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        expect(completeRes.ok).toBe(false);
        expect(completeRes.error.code).toBe("conflict");

        // Active execution map MUST be cleaned up
        expect(dispatcher.getActiveExecution(runId, "plan")).toBeUndefined();

        // Lease capacity MUST be freed in registry and immediately available
        const leaseProbe = await harness.agentRegistry.acquireLease({
          leaseId: `probe-lease-${randomUUID()}`,
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe-1",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `probe-key-${randomUUID()}`
        });
        expect(leaseProbe.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("3.2: Lease is released and capacity freed when recordAgentResult throws an exception", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);
        const orchestrator = new SdlcWorkflowOrchestrator(harness.ports, dispatcher);

        await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispatcher.getActiveExecution(runId, "plan")).toBeDefined();

        // Simulate unexpected engine exception
        vi.spyOn(harness.ports.engine, "recordAgentResult").mockRejectedValueOnce(
          new Error("Fatal database I/O exception")
        );

        // Expect completeTaskExecution to reject with the error
        await expect(
          orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" })
        ).rejects.toThrow("Fatal database I/O exception");

        // Despite exception, finally block MUST have cleared active execution and released lease
        expect(dispatcher.getActiveExecution(runId, "plan")).toBeUndefined();

        // Lease capacity is immediately re-acquirable
        const leaseProbe = await harness.agentRegistry.acquireLease({
          leaseId: `probe-lease-${randomUUID()}`,
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe-2",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `probe-key-${randomUUID()}`
        });
        expect(leaseProbe.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("3.3: Lease is released and capacity freed when persistEvents fails", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);
        const orchestrator = new SdlcWorkflowOrchestrator(harness.ports, dispatcher);

        await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispatcher.getActiveExecution(runId, "plan")).toBeDefined();

        // Simulate SQLite storage failure during persistEvents (appendEvents)
        vi.spyOn(harness.ports.runStore, "appendEvents").mockResolvedValueOnce({
          ok: false,
          error: { code: "storage_error", retryable: false, message: "Disk write failure simulation" }
        });

        const completeRes = await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        expect(completeRes.ok).toBe(false);
        expect(completeRes.error.code).toBe("storage_error");

        // Active execution cleared
        expect(dispatcher.getActiveExecution(runId, "plan")).toBeUndefined();

        // Lease capacity freed
        const leaseProbe = await harness.agentRegistry.acquireLease({
          leaseId: `probe-lease-${randomUUID()}`,
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe-3",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `probe-key-${randomUUID()}`
        });
        expect(leaseProbe.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("3.4: Strict capacity limit enforcement: 1-slot agent lease freed immediately on completeTaskExecution failure", async () => {
      const harness = await createTestHarness();
      try {
        // Configure agent-planner-1 with maxConcurrentTasks: 1
        await harness.agentRegistry.upsert({
          agentId: "agent-planner-1",
          role: "planner",
          transport: "herdr",
          enabled: true,
          priority: 10,
          maxConcurrentTasks: 1,
          capabilities: ["planner", "general"],
          settings: {
            provider: "mock",
            kind: "agent",
            execution: { paneId: "pane-planner" }
          }
        });

        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);
        const orchestrator = new SdlcWorkflowOrchestrator(harness.ports, dispatcher);

        // Dispatch task consumes the 1 capacity slot for agent-planner-1
        const dispRes = await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispRes.ok).toBe(true);

        // A second lease acquisition for agent-planner-1 MUST now fail with exhausted
        const probeBefore = await harness.agentRegistry.acquireLease({
          leaseId: `probe-fail-${randomUUID()}`,
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe-fail",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `probe-fail-${randomUUID()}`
        });
        expect(probeBefore.ok).toBe(false);
        expect(["capacity_exhausted", "resource_exhausted", "conflict"]).toContain(probeBefore.error.code);

        // Now fail completeTaskExecution
        vi.spyOn(harness.ports.engine, "recordAgentResult").mockResolvedValueOnce({
          ok: false,
          error: { code: "validation", retryable: false, message: "Simulated validation error" }
        });

        const completeRes = await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        expect(completeRes.ok).toBe(false);

        // Slot must now be immediately re-available!
        const probeAfter = await harness.agentRegistry.acquireLease({
          leaseId: `probe-success-${randomUUID()}`,
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe-success",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `probe-success-${randomUUID()}`
        });
        expect(probeAfter.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });
  });
});
