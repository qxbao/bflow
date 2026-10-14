import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@ai-flow/contracts";
import { TaskDispatcher } from "../../src/dispatcher.js";
import { SdlcWorkflowOrchestrator } from "../../src/orchestrator.js";
import {
  createSdlcWorkflowDefinition,
  createTestHarness
} from "../helpers/test-harness.js";
import type { ConcreteRuntimeService } from "../../src/service.js";

async function setupScenarioRun(
  harness: any,
  runId: string,
  def: WorkflowDefinition = createSdlcWorkflowDefinition()
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

  return {
    orchestrator: harness.service.orchestrator,
    dispatcher: harness.service.dispatcher,
    service: harness.service
  };
}

describe("Integration Scenario 4: Blocked Agent & Operator Resume", { timeout: 30000 }, () => {
  it("4.1: Agent reports blockage ('external_dependency'), task transitions to blocked without consuming retries, run transitions to blocked", async () => {
    const harness = await createTestHarness();
    try {
      const runId = "run-blocked-dep-1";
      const { orchestrator, dispatcher, service } = await setupScenarioRun(harness, runId);

      // Advance plan to succeeded
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

      // Dispatch implement
      await orchestrator.driveRun(runId);
      const snapBefore = (await harness.engine.getSnapshot(runId)).value!;
      const implBefore = snapBefore.tasks.find((t) => t.taskId === "implement")!;
      expect(implBefore.status).toBe("running");
      expect(implBefore.attempt).toBe(1);

      // Verify active execution exists in dispatcher
      expect(dispatcher.getActiveExecution(runId, "implement")).toBeDefined();

      // Agent reports blockage via transport observation
      const blockRes = await orchestrator.completeTaskExecution(runId, "implement", {
        status: "blocked",
        summary: "Environment is missing system library 'libvips'",
        blockage: {
          code: "external_dependency",
          message: "Package 'libvips-dev' is required for image processing pipeline",
          since: new Date().toISOString(),
          retryable: false
        }
      });
      expect(blockRes.ok).toBe(true);

      // 1. Task transitions to 'blocked'
      const snapBlocked = (await harness.engine.getSnapshot(runId)).value!;
      const implBlocked = snapBlocked.tasks.find((t) => t.taskId === "implement")!;
      expect(implBlocked.status).toBe("blocked");
      expect(implBlocked.blockage?.code).toBe("external_dependency");
      expect(implBlocked.blockage?.message).toContain("libvips-dev");

      // 2. Critical Invariant: Retries are NOT consumed!
      expect(implBlocked.attempt).toBe(1);

      // 3. Run transitions to 'blocked'
      const runStatus = (await service.getRunStatus(runId)).value!;
      expect(runStatus.status).toBe("blocked");

      // 4. Active lease is released (no capacity leak during operator wait)
      expect(dispatcher.getActiveExecution(runId, "implement")).toBeUndefined();

      // 5. Preceding task states and artifacts remain intact
      const planTask = snapBlocked.tasks.find((t) => t.taskId === "plan")!;
      expect(planTask.status).toBe("succeeded");
    } finally {
      await harness.cleanup();
    }
  });

  it("4.2: Calling unblock and resume resumes execution to completion", async () => {
    const harness = await createTestHarness();
    try {
      const runId = "run-unblock-resume";
      const { orchestrator, service } = await setupScenarioRun(harness, runId);

      // Advance plan
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

      // Implement dispatches
      await orchestrator.driveRun(runId);
      const snapRunning = (await harness.engine.getSnapshot(runId)).value!;
      const implRunning = snapRunning.tasks.find((t) => t.taskId === "implement")!;
      expect(implRunning.status).toBe("running");

      // Implement is blocked on missing credentials
      const blockRes = await harness.engine.transitionTask({
        runId,
        taskId: "implement",
        from: "running",
        to: "blocked",
        intent: "normal",
        generationFrom: implRunning.generation,
        generationTo: implRunning.generation,
        expectedVersion: snapRunning.version,
        idempotencyKey: `block-manual-${runId}`,
        occurredAt: new Date().toISOString()
      });
      expect(blockRes.ok).toBe(true);
      await harness.runStore.appendEvents({
        runId,
        expectedVersion: snapRunning.version,
        expectedLastSequence: snapRunning.lastEventSequence,
        events: blockRes.value.emittedEvents,
        idempotencyKey: `block-events-${runId}`
      });

      const snap1 = (await harness.engine.getSnapshot(runId)).value!;
      const runStatus1 = (await service.getRunStatus(runId)).value!;
      expect(runStatus1.status).toBe("blocked");

      const implTask = snap1.tasks.find((t) => t.taskId === "implement")!;
      const unblockRes = await harness.engine.transitionTask({
        runId,
        taskId: "implement",
        from: "blocked",
        to: "running",
        intent: "normal",
        generationFrom: implTask.generation,
        generationTo: implTask.generation,
        expectedVersion: snap1.version,
        idempotencyKey: `unblock-manual-${runId}`,
        occurredAt: new Date().toISOString()
      });
      expect(unblockRes.ok).toBe(true);
      await harness.runStore.appendEvents({
        runId,
        expectedVersion: snap1.version,
        expectedLastSequence: snap1.lastEventSequence,
        events: unblockRes.value.emittedEvents,
        idempotencyKey: `unblock-events-${runId}`
      });

      // Run status transitions back to 'running'
      const runStatusUnblocked = (await service.getRunStatus(runId)).value!;
      expect(runStatusUnblocked.status).toBe("running");
      const snapUnblocked = (await harness.engine.getSnapshot(runId)).value!;
      const implUnblocked = snapUnblocked.tasks.find((t) => t.taskId === "implement")!;
      expect(implUnblocked.status).toBe("running");

      // Implement completes successfully
      const implSucceedRes = await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
      expect(implSucceedRes.ok).toBe(true);

      // Review completes with approval
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "review", { status: "succeeded", reviewDecision: "approved" });

      // QA completes
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "qa", { status: "succeeded" });

      // Reaches pre-merge approval hold
      const snapAppr = (await harness.engine.getSnapshot(runId)).value!;
      expect(snapAppr.status).toBe("waiting");

      // Operator approves
      const finalApprRes = await orchestrator.applyApprovalDecision({
        schemaVersion: 1,
        approvalId: `final-appr-${runId}`,
        runId,
        target: { type: "task", taskId: "qa" },
        revision: 1,
        generation: 0,
        decision: "approved",
        decidedBy: "lead_architect",
        decidedAt: new Date().toISOString(),
        feedbackArtifacts: [],
        idempotencyKey: `final-appr-decision-${runId}`
      });
      expect(finalApprRes.ok).toBe(true);

      const snapComplete = (await harness.engine.getSnapshot(runId)).value!;
      expect(snapComplete.status).toBe("succeeded");
    } finally {
      await harness.cleanup();
    }
  });

  it("4.3: Operator can cancel a blocked run cleanly", async () => {
    const harness = await createTestHarness();
    try {
      const runId = "run-cancel-blocked";
      const { orchestrator, dispatcher } = await setupScenarioRun(harness, runId);

      // Advance plan and block implement
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "implement", {
        status: "blocked",
        summary: "Unsupported architecture",
        blockage: {
          code: "manual_intervention",
          message: "Target architecture ARMv7 is unsupported",
          since: new Date().toISOString(),
          retryable: false
        }
      });

      // Operator cancels task
      const cancelRes = await dispatcher.cancelTask(runId, "implement", "Architecture unsupported, abandoning run");
      expect(cancelRes.ok).toBe(true);

      const snapFinal = (await harness.engine.getSnapshot(runId)).value!;
      const implState = snapFinal.tasks.find((t) => t.taskId === "implement")!;
      expect(implState.status).toBe("cancelled");
    } finally {
      await harness.cleanup();
    }
  });
});
