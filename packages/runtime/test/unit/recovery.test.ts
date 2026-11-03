import { describe, expect, it, vi } from "vitest";
import { eventTailCursor, recoverWorkflowRun } from "../../src/recovery.js";
import { DeterministicWorkflowEngine } from "@bflow/core";
import {
  createSampleWorkflowDefinition,
  createTestHarness
} from "./fixtures.js";

describe("Workflow Recovery", { timeout: 30000 }, () => {
  it("generates opaque eventTailCursor with valid scope and position", () => {
    const cursor = eventTailCursor("run-test-1", 5);
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    expect(decoded).toEqual({
      v: 1,
      scope: "events:run-test-1",
      position: 5
    });
  });

  it("recovers workflow from complete event history across restarts", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-recover-history-1";
      const requestedAt = new Date().toISOString();

      await harness.engine.validateDefinition(definition);
      const createRes = await harness.engine.createRun({ runId, definition, idempotencyKey: "c", createdAt: requestedAt });
      if (!createRes.ok) throw new Error("createRun failed");
      const initialSnapshot = {
        ...createRes.value.snapshot,
        version: 0,
        lastEventSequence: 0
      };
      const createStoreRes = await harness.runStore.create({ snapshot: initialSnapshot, definition }, "s");
      if (!createStoreRes.ok) throw new Error(createStoreRes.error.message);
      const appendCreateRes = await harness.runStore.appendEvents({
        runId,
        expectedVersion: 0,
        expectedLastSequence: 0,
        events: createRes.value.emittedEvents,
        idempotencyKey: "e"
      });
      if (!appendCreateRes.ok) throw new Error(appendCreateRes.error.message);

      // Advance run
      const advRes = await harness.engine.advance({
        runId,
        expectedVersion: createRes.value.snapshot.version,
        idempotencyKey: "adv-1",
        occurredAt: new Date().toISOString()
      });
      if (!advRes.ok) throw new Error("advance failed");

      await harness.runStore.appendEvents({
        runId,
        expectedVersion: createRes.value.snapshot.version,
        expectedLastSequence: createRes.value.snapshot.lastEventSequence,
        events: advRes.value.emittedEvents,
        idempotencyKey: "adv-events-1"
      });

      // Simulate engine restart by creating a brand new engine instance
      const newEngine = new DeterministicWorkflowEngine({ definitions: [definition] });

      const recoverPorts = {
        engine: newEngine,
        runStore: harness.runStore,
        transport: harness.transport
      };

      const recoveryRes = await recoverWorkflowRun(runId, recoverPorts);
      expect(recoveryRes.ok ? null : recoveryRes.error).toBe(null);
      if (!recoveryRes.ok) return;

      const recoveredSnapshot = recoveryRes.value.snapshot;
      expect(recoveredSnapshot.runId).toBe(runId);
      expect(recoveredSnapshot.version).toBe(advRes.value.snapshot.version);
      expect(recoveredSnapshot.lastEventSequence).toBe(advRes.value.snapshot.lastEventSequence);

      const planTask = recoveredSnapshot.tasks.find((t) => t.taskId === "plan");
      expect(planTask?.status).toBe("running");
    } finally {
      await harness.cleanup();
    }
  });

  it("recovers workflow from aggregate checkpoint and event tail", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-recover-checkpoint-1";
      const requestedAt = new Date().toISOString();

      await harness.engine.validateDefinition(definition);
      const createRes = await harness.engine.createRun({ runId, definition, idempotencyKey: "c", createdAt: requestedAt });
      if (!createRes.ok) throw new Error("createRun failed");

      const initialSnapshot = {
        ...createRes.value.snapshot,
        version: 0,
        lastEventSequence: 0
      };
      const createStoreRes = await harness.runStore.create({ snapshot: initialSnapshot, definition }, "s");
      if (!createStoreRes.ok) throw new Error(createStoreRes.error.message);
      const appendCreateRes = await harness.runStore.appendEvents({
        runId,
        expectedVersion: 0,
        expectedLastSequence: 0,
        events: createRes.value.emittedEvents,
        idempotencyKey: "e"
      });
      if (!appendCreateRes.ok) throw new Error(appendCreateRes.error.message);

      // Advance
      const advRes = await harness.engine.advance({
        runId,
        expectedVersion: createRes.value.snapshot.version,
        idempotencyKey: "adv-1",
        occurredAt: new Date().toISOString()
      });
      if (!advRes.ok) throw new Error("advance failed");

      await harness.runStore.appendEvents({
        runId,
        expectedVersion: createRes.value.snapshot.version,
        expectedLastSequence: createRes.value.snapshot.lastEventSequence,
        events: advRes.value.emittedEvents,
        idempotencyKey: "adv-events-1"
      });

      // Create aggregate checkpoint
      const cpRes = await harness.engine.createCheckpoint({
        runId,
        expectedVersion: advRes.value.snapshot.version,
        checkpointId: "cp-1",
        createdAt: new Date().toISOString()
      });
      expect(cpRes.ok).toBe(true);
      if (!cpRes.ok) return;

      await harness.runStore.saveCheckpoint(cpRes.value, advRes.value.snapshot.version);

      // Simulate fresh engine instance
      const freshEngine = new DeterministicWorkflowEngine({ definitions: [definition] });

      const recoverPorts = {
        engine: freshEngine,
        runStore: harness.runStore,
        transport: harness.transport
      };

      const recoveryRes = await recoverWorkflowRun(runId, recoverPorts);
      expect(recoveryRes.ok).toBe(true);
      if (!recoveryRes.ok) return;

      const recoveredSnapshot = recoveryRes.value.snapshot;
      expect(recoveredSnapshot.runId).toBe(runId);
      expect(recoveredSnapshot.version).toBe(advRes.value.snapshot.version);

      const planTask = recoveredSnapshot.tasks.find((t) => t.taskId === "plan");
      expect(planTask?.status).toBe("running");
    } finally {
      await harness.cleanup();
    }
  });

  it("recovers a parked task from a codec-3 aggregate checkpoint and refuses codec 4 (B2b)", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-recover-parked-1";
      const at = new Date().toISOString();
      await harness.engine.validateDefinition(definition);
      const created = await harness.engine.createRun({ runId, definition, idempotencyKey: "c", createdAt: at });
      if (!created.ok) throw new Error("createRun failed");
      const stored = await harness.runStore.create({ snapshot: { ...created.value.snapshot, version: 0, lastEventSequence: 0 }, definition }, "s");
      if (!stored.ok) throw new Error(stored.error.message);
      let previous = created.value;
      const append = async (next: typeof previous, key: string) => {
        const appended = await harness.runStore.appendEvents({ runId, expectedVersion: previous.snapshot.version,
          expectedLastSequence: previous.snapshot.lastEventSequence, events: next.emittedEvents, idempotencyKey: key });
        if (!appended.ok) throw new Error(appended.error.message);
        previous = next;
      };
      const appendCreate = await harness.runStore.appendEvents({ runId, expectedVersion: 0, expectedLastSequence: 0, events: created.value.emittedEvents, idempotencyKey: "e" });
      if (!appendCreate.ok) throw new Error(appendCreate.error.message);
      const advanced = await harness.engine.advance({ runId, expectedVersion: previous.snapshot.version, idempotencyKey: "adv-1", occurredAt: at });
      if (!advanced.ok) throw new Error("advance failed");
      await append(advanced.value, "adv-events-1");
      const plan = advanced.value.snapshot.tasks.find((task) => task.taskId === "plan")!;
      expect(plan.status).toBe("running");
      const parked = await harness.engine.transitionTask({ runId, taskId: "plan", expectedVersion: previous.snapshot.version, from: "running", to: "parked",
        intent: "park", generationFrom: plan.generation, generationTo: plan.generation, idempotencyKey: "park-plan", occurredAt: at });
      if (!parked.ok) throw new Error(parked.error.message);
      await append(parked.value, "park-events-1");
      const checkpoint = await harness.engine.createCheckpoint({ runId, expectedVersion: parked.value.snapshot.version, checkpointId: "cp-parked", createdAt: at });
      if (!checkpoint.ok) throw new Error(checkpoint.error.message);
      expect(checkpoint.value.codec.version).toBe(3);
      const saved = await harness.runStore.saveCheckpoint(checkpoint.value, parked.value.snapshot.version);
      expect(saved.ok ? null : saved.error).toBeNull();

      const recovered = await recoverWorkflowRun(runId, { engine: new DeterministicWorkflowEngine({ definitions: [definition] }),
        runStore: harness.runStore, transport: harness.transport });
      expect(recovered.ok ? null : recovered.error).toBeNull();
      if (!recovered.ok) return;
      expect(recovered.value.snapshot.tasks.find((task) => task.taskId === "plan")?.status).toBe("parked");

      // Codec 4 is still refused before any recovery is attempted.
      const future = { ...checkpoint.value, codec: { name: "bflow.workflow-aggregate+json", version: 4 } };
      vi.spyOn(harness.runStore, "loadLatestCheckpoint").mockResolvedValue({ ok: true, value: future as never });
      const refused = await recoverWorkflowRun(runId, { engine: new DeterministicWorkflowEngine({ definitions: [definition] }),
        runStore: harness.runStore, transport: harness.transport });
      expect(refused.ok).toBe(false);
      vi.restoreAllMocks();
    } finally {
      await harness.cleanup();
    }
  });

  it("reconciles in-flight bound executions during recovery", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-recover-recon-1";
      const requestedAt = new Date().toISOString();

      await harness.engine.validateDefinition(definition);
      const createRes = await harness.engine.createRun({ runId, definition, idempotencyKey: "c", createdAt: requestedAt });
      if (!createRes.ok) throw new Error("createRun failed");

      const initialSnapshot = {
        ...createRes.value.snapshot,
        version: 0,
        lastEventSequence: 0
      };
      const createStoreRes = await harness.runStore.create({ snapshot: initialSnapshot, definition }, "s");
      if (!createStoreRes.ok) throw new Error(createStoreRes.error.message);
      const appendCreateRes = await harness.runStore.appendEvents({
        runId,
        expectedVersion: 0,
        expectedLastSequence: 0,
        events: createRes.value.emittedEvents,
        idempotencyKey: "e"
      });
      if (!appendCreateRes.ok) throw new Error(appendCreateRes.error.message);

      const advRes = await harness.engine.advance({
        runId,
        expectedVersion: createRes.value.snapshot.version,
        idempotencyKey: "adv-1",
        occurredAt: new Date().toISOString()
      });
      if (!advRes.ok) throw new Error("advance failed");

      await harness.runStore.appendEvents({
        runId,
        expectedVersion: createRes.value.snapshot.version,
        expectedLastSequence: createRes.value.snapshot.lastEventSequence,
        events: advRes.value.emittedEvents,
        idempotencyKey: "adv-events-1"
      });

      const planAttemptId = advRes.value.snapshot.tasks.find((t) => t.taskId === "plan")!.attemptId!;
      const handle = {
        executionId: "exec-in-flight",
        requestId: "req-in-flight",
        attemptId: planAttemptId,
        runId,
        taskId: "plan",
        idempotencyKey: "idemp-bind",
        target: { transport: "herdr", agentId: "agent-planner-1", paneId: "pane-planner" },
        correlation: { token: "req-in-flight", provenance: "transport" as const, verified: true },
        acceptedAt: new Date().toISOString()
      };

      const bindRes = await harness.engine.bindAgentExecution({
        runId,
        taskId: "plan",
        expectedVersion: advRes.value.snapshot.version,
        attempt: 1,
        handle,
        idempotencyKey: "bind-idemp",
        occurredAt: new Date().toISOString()
      });
      if (!bindRes.ok) throw new Error("bindAgentExecution failed");

      await harness.runStore.appendEvents({
        runId,
        expectedVersion: advRes.value.snapshot.version,
        expectedLastSequence: advRes.value.snapshot.lastEventSequence,
        events: bindRes.value.emittedEvents,
        idempotencyKey: "bind-events"
      });

      // Transport reconcile confirms bound handle
      harness.transport.customReconcileHandler = () => ({
        ok: true,
        value: {
          status: "bound",
          handle
        }
      });

      const freshEngine = new DeterministicWorkflowEngine({ definitions: [definition] });

      const recoverPorts = {
        engine: freshEngine,
        runStore: harness.runStore,
        transport: harness.transport
      };

      const recoveryRes = await recoverWorkflowRun(runId, recoverPorts);
      expect(recoveryRes.ok).toBe(true);
      if (!recoveryRes.ok) return;

      expect(recoveryRes.value.reconciledTasks).toContain("plan");
      const recoveredPlanTask = recoveryRes.value.snapshot.tasks.find((t) => t.taskId === "plan");
      expect(recoveredPlanTask?.status).toBe("running");
      expect(recoveredPlanTask?.agentExecution?.executionId).toBe(handle.executionId);
    } finally {
      await harness.cleanup();
    }
  });
});
