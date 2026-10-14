import { describe, expect, it } from "vitest";
import { TaskDispatcher } from "../../src/dispatcher.js";
import {
  createSampleWorkflowDefinition,
  createTestHarness
} from "./fixtures.js";

describe("TaskDispatcher", { timeout: 30000 }, () => {
  it("schedules ready tasks and appends advance events to RunStore", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-sched-1";
      const requestedAt = new Date().toISOString();

      await harness.engine.validateDefinition(definition);
      const createRes = await harness.engine.createRun({
        runId,
        definition,
        idempotencyKey: "create-key",
        createdAt: requestedAt
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      await harness.runStore.create({
        snapshot: createRes.value.snapshot,
        definition
      }, "store-create-key");

      await harness.runStore.appendEvents({
        runId,
        expectedVersion: 0,
        expectedLastSequence: 0,
        events: createRes.value.emittedEvents,
        idempotencyKey: "append-init"
      });

      const dispatcher = new TaskDispatcher({
        engine: harness.engine,
        runStore: harness.runStore,
        agentRegistry: harness.agentRegistry,
        transport: harness.transport
      });

      const scheduleRes = await dispatcher.scheduleReadyTasks(runId);
      expect(scheduleRes.ok).toBe(true);
      if (!scheduleRes.ok) return;

      // In sample workflow, 'plan' has no dependencies, so it should be runnable!
      expect(scheduleRes.value).toEqual(["plan"]);

      const snapRes = await harness.engine.getSnapshot(runId);
      expect(snapRes.ok).toBe(true);
      const planTask = snapRes.value?.tasks.find((t) => t.taskId === "plan");
      expect(planTask?.status).toBe("running");
      expect(planTask?.attempt).toBe(1);
      expect(planTask?.attemptId).toBeDefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("dispatches task, verifies lease/fencing token, and binds execution", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-dispatch-1";
      const requestedAt = new Date().toISOString();

      await harness.engine.validateDefinition(definition);
      const createRes = await harness.engine.createRun({
        runId,
        definition,
        idempotencyKey: "create-key",
        createdAt: requestedAt
      });
      if (!createRes.ok) throw new Error("createRun failed");

      await harness.runStore.create({ snapshot: createRes.value.snapshot, definition }, "store-key");
      await harness.runStore.appendEvents({
        runId,
        expectedVersion: 0,
        expectedLastSequence: 0,
        events: createRes.value.emittedEvents,
        idempotencyKey: "init-events"
      });

      const dispatcher = new TaskDispatcher({
        engine: harness.engine,
        runStore: harness.runStore,
        agentRegistry: harness.agentRegistry,
        transport: harness.transport
      });

      await dispatcher.scheduleReadyTasks(runId);
      const snapRes = await harness.engine.getSnapshot(runId);
      const snapshot = snapRes.value!;

      const dispatchRes = await dispatcher.dispatchTask(
        definition,
        snapshot,
        "plan",
        "Create spec"
      );
      expect(dispatchRes.ok).toBe(true);
      if (!dispatchRes.ok) return;

      const handle = dispatchRes.value;
      expect(handle.taskId).toBe("plan");
      expect(handle.runId).toBe(runId);
      expect(harness.transport.sentRequests).toHaveLength(1);

      const sentReq = harness.transport.sentRequests[0];
      expect(sentReq.role).toBe("planner");
      expect(sentReq.metadata?.fencingToken).toBeGreaterThan(0);
      expect(sentReq.metadata?.leaseId).toBeDefined();

      const active = dispatcher.getActiveExecution(runId, "plan");
      expect(active).toBeDefined();
      expect(active?.handle?.executionId).toBe(handle.executionId);
    } finally {
      await harness.cleanup();
    }
  });

  it("handles unknown delivery and reconciles to bound handle", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-recon-1";
      const requestedAt = new Date().toISOString();

      await harness.engine.validateDefinition(definition);
      const createRes = await harness.engine.createRun({ runId, definition, idempotencyKey: "c", createdAt: requestedAt });
      if (!createRes.ok) throw new Error("createRun failed");

      await harness.runStore.create({ snapshot: createRes.value.snapshot, definition }, "s");
      await harness.runStore.appendEvents({
        runId,
        expectedVersion: 0,
        expectedLastSequence: 0,
        events: createRes.value.emittedEvents,
        idempotencyKey: "e"
      });

      // Transport returns unknown_delivery on send
      harness.transport.customSendHandler = (req) => ({
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
          reason: "Network timeout during transport prompt dispatch",
          resendAllowed: false,
          manualInterventionRequired: true
        }
      });

      const dispatcher = new TaskDispatcher({
        engine: harness.engine,
        runStore: harness.runStore,
        agentRegistry: harness.agentRegistry,
        transport: harness.transport
      });

      await dispatcher.scheduleReadyTasks(runId);
      const snapRes = await harness.engine.getSnapshot(runId);
      const snapshot = snapRes.value!;

      // Dispatch should invoke reconcile and succeed with bound handle!
      const dispatchRes = await dispatcher.dispatchTask(
        definition,
        snapshot,
        "plan",
        "Create spec"
      );
      expect(dispatchRes.ok).toBe(true);
      if (dispatchRes.ok) {
        expect(dispatchRes.value.taskId).toBe("plan");
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("executes 3-stage cancellation and releases lease", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-cancel-1";
      const requestedAt = new Date().toISOString();

      await harness.engine.validateDefinition(definition);
      const createRes = await harness.engine.createRun({ runId, definition, idempotencyKey: "c", createdAt: requestedAt });
      if (!createRes.ok) throw new Error("createRun failed");

      await harness.runStore.create({ snapshot: createRes.value.snapshot, definition }, "s");
      await harness.runStore.appendEvents({
        runId,
        expectedVersion: 0,
        expectedLastSequence: 0,
        events: createRes.value.emittedEvents,
        idempotencyKey: "e"
      });

      const dispatcher = new TaskDispatcher({
        engine: harness.engine,
        runStore: harness.runStore,
        agentRegistry: harness.agentRegistry,
        transport: harness.transport
      });

      await dispatcher.scheduleReadyTasks(runId);
      const snapRes = await harness.engine.getSnapshot(runId);
      const snapshot = snapRes.value!;

      await dispatcher.dispatchTask(definition, snapshot, "plan", "Create spec");
      expect(dispatcher.getActiveExecution(runId, "plan")).toBeDefined();

      const cancelRes = await dispatcher.cancelTask(runId, "plan", "Operator aborted");
      expect(cancelRes.ok).toBe(true);

      expect(harness.transport.cancelledHandles).toHaveLength(1);
      expect(dispatcher.getActiveExecution(runId, "plan")).toBeUndefined();

      const freshSnap = await harness.engine.getSnapshot(runId);
      const planState = freshSnap.value?.tasks.find((t) => t.taskId === "plan");
      expect(planState?.status).toBe("cancelled");
    } finally {
      await harness.cleanup();
    }
  });
});
