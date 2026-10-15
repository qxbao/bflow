/**
 * Integration Scenario 6: Restart Recovery & Aggregate Replay
 *
 * Verifies that:
 * 1. A new RuntimeService instance reconstructs state from SQLite RunStore using
 *    an aggregate checkpoint (`bflow.workflow-aggregate+json` codec) + event tail replay
 *    from `eventTailCursor`.
 * 2. In-flight bound executions are reconciled with AgentTransport and active execution
 *    maps are re-established.
 * 3. Execution resumes seamlessly to successful completion on the new RuntimeService instance.
 * 4. Fallback recovery from complete domain event history functions when no checkpoint exists.
 * 5. Incompatible or corrupted checkpoint codecs fail closed with typed validation errors.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DeterministicWorkflowEngine } from "@bflow/core";
import type {
  AgentExecutionHandle,
  AgentReconciliationRequest,
  AgentReconciliationResult,
  OperationResult,
  WorkflowDefinition
} from "@bflow/contracts";
import { createRuntimeService } from "../../src/service.js";
import { eventTailCursor, recoverWorkflowRun } from "../../src/recovery.js";
import {
  createSampleWorkflowDefinition,
  createTestHarness,
  FakeAgentTransport
} from "../unit/fixtures.js";

describe("Scenario 6: Restart Recovery & Aggregate Replay", { timeout: 30000 }, () => {
  it("6.1: reconstructs state from SQLite RunStore using aggregate checkpoint + event tail, reconciles in-flight execution, and resumes to completion", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition({ requiresApproval: true });
      const runId = `run-s6-restart-${randomUUID()}`;

      // Instance 1: Start the workflow
      const service1 = createRuntimeService(harness.ports);
      const startRes = await service1.startRun(definition, { runId });
      expect(startRes.ok).toBe(true);
      if (!startRes.ok) return;

      // 1. Advance through 'plan' task to completion
      const planCompleteRes = await service1.orchestrator.completeTaskExecution(runId, "plan", {
        status: "succeeded",
        summary: "Architecture plan generated successfully"
      });
      expect(planCompleteRes.ok).toBe(true);

      // Snapshot after 'plan' succeeded
      const snapAfterPlanRes = await harness.engine.getSnapshot(runId);
      expect(snapAfterPlanRes.ok).toBe(true);
      const snapAfterPlan = snapAfterPlanRes.value!;
      expect(snapAfterPlan.tasks.find((t) => t.taskId === "plan")?.status).toBe("succeeded");

      // 2. Create aggregate checkpoint at task boundary (after 'plan')
      const cpRes = await harness.engine.createCheckpoint({
        runId,
        expectedVersion: snapAfterPlan.version,
        checkpointId: `cp-${runId}-1`,
        createdAt: new Date().toISOString()
      });
      expect(cpRes.ok).toBe(true);
      if (!cpRes.ok) return;

      const saveCpRes = await harness.runStore.saveCheckpoint(cpRes.value, snapAfterPlan.version);
      expect(saveCpRes.ok).toBe(true);
      const checkpointSequence = cpRes.value.eventSequence;

      // 3. Drive the run so 'implement' is scheduled and dispatched (in-flight bound execution)
      // This appends events (advance + agent.execution_bound) strictly AFTER checkpoint.eventSequence
      await service1.orchestrator.driveRun(runId);

      const snapAfterDispatchRes = await harness.engine.getSnapshot(runId);
      expect(snapAfterDispatchRes.ok).toBe(true);
      const snapAfterDispatch = snapAfterDispatchRes.value!;
      const implementTask = snapAfterDispatch.tasks.find((t) => t.taskId === "implement");

      expect(implementTask?.status).toBe("running");
      expect(implementTask?.agentExecution).toBeDefined();
      expect(snapAfterDispatch.lastEventSequence).toBeGreaterThan(checkpointSequence);

      const boundHandle: AgentExecutionHandle = implementTask!.agentExecution!;
      expect(boundHandle.executionId).toBeDefined();
      expect(boundHandle.runId).toBe(runId);
      expect(boundHandle.taskId).toBe("implement");

      // Verify that eventTailCursor correctly encodes the position after checkpoint
      const tailCursor = eventTailCursor(runId, checkpointSequence);
      const decodedCursor = JSON.parse(Buffer.from(tailCursor, "base64url").toString("utf8"));
      expect(decodedCursor).toEqual({
        v: 1,
        scope: `events:${runId}`,
        position: checkpointSequence
      });

      // 4. SIMULATE SERVICE CRASH / RESTART:
      // Completely discard service1 and its in-memory engine instance.
      // Create a fresh, empty DeterministicWorkflowEngine instance (no in-memory runs).
      const freshEngine = new DeterministicWorkflowEngine({
        definitions: [definition],
        clock: harness.ports.clock ? () => harness.ports.clock!().toISOString() : undefined
      });

      // Verify fresh engine knows nothing about the run yet
      const preRecoverySnap = await freshEngine.getSnapshot(runId);
      expect(preRecoverySnap.ok).toBe(true);
      expect(preRecoverySnap.value).toBeNull();

      // Configure transport to reconcile the in-flight handle on restart
      let reconcileCalled = false;
      let reconciledRequestId = "";
      harness.transport.customReconcileHandler = (req: AgentReconciliationRequest): OperationResult<AgentReconciliationResult> => {
        reconcileCalled = true;
        reconciledRequestId = req.requestId;
        return {
          ok: true,
          value: {
            status: "bound",
            handle: boundHandle
          }
        };
      };

      // Instance 2: Create new RuntimeService instance with the fresh engine
      const service2Ports = {
        ...harness.ports,
        engine: freshEngine
      };
      const service2 = createRuntimeService(service2Ports);

      // 5. RESUME on Instance 2:
      // Triggers recoverWorkflowRun -> loads checkpoint -> replays tail events -> reconciles transport
      const resumeRes = await service2.resume(runId);
      expect(resumeRes.ok).toBe(true);
      if (!resumeRes.ok) return;

      // Verify state was reconstructed in freshEngine
      const recoveredSnapRes = await freshEngine.getSnapshot(runId);
      expect(recoveredSnapRes.ok).toBe(true);
      const recoveredSnap = recoveredSnapRes.value!;

      expect(recoveredSnap.runId).toBe(runId);
      expect(recoveredSnap.tasks.find((t) => t.taskId === "plan")?.status).toBe("succeeded");
      const recoveredImplement = recoveredSnap.tasks.find((t) => t.taskId === "implement");
      expect(recoveredImplement?.status).toBe("running");
      expect(recoveredImplement?.agentExecution?.executionId).toBe(boundHandle.executionId);

      // Verify transport reconciliation occurred
      expect(reconcileCalled).toBe(true);
      expect(reconciledRequestId).toBe(boundHandle.requestId);

      // 6. Complete remaining lifecycle on service2:
      // A: Implement completes
      const implCompleteRes = await service2.orchestrator.completeTaskExecution(runId, "implement", {
        status: "succeeded",
        summary: "Feature code and unit tests completed"
      });
      expect(implCompleteRes.ok).toBe(true);

      // B: Drive run -> review is scheduled and dispatched
      await service2.orchestrator.driveRun(runId);
      const reviewCompleteRes = await service2.orchestrator.completeTaskExecution(runId, "review", {
        status: "succeeded",
        reviewDecision: "approved",
        reviewReason: "Architecture and test coverage verified"
      });
      expect(reviewCompleteRes.ok).toBe(true);

      // C: Drive run -> qa is scheduled and dispatched
      await service2.orchestrator.driveRun(runId);
      const qaCompleteRes = await service2.orchestrator.completeTaskExecution(runId, "qa", {
        status: "succeeded",
        summary: "All automated integration tests passed"
      });
      expect(qaCompleteRes.ok).toBe(true);

      // D: Pre-merge human approval hold
      const preMergeSnap = (await service2.getRunStatus(runId)).value!;
      expect(preMergeSnap.status).toBe("waiting");

      // Verify handoff report was persisted in ArtifactStore
      const reportRes = await harness.artifactStore.resolve(`report-${runId}-handoff`);
      expect(reportRes.ok).toBe(true);
      expect(reportRes.value?.artifactId).toBe(`report-${runId}-handoff`);

      // E: Operator human sign-off
      const approveRes = await service2.approve(runId, {
        decidedBy: "lead_architect",
        decision: "approved",
        reason: "Production release approved"
      });
      expect(approveRes.ok).toBe(true);
      if (!approveRes.ok) return;

      // F: Final workflow run reaches 'succeeded'
      expect(approveRes.value.status).toBe("succeeded");
      const finalSnap = (await service2.getRunStatus(runId)).value!;
      expect(finalSnap.status).toBe("succeeded");

      // 7. Post-recovery Invariants:
      // All 4 tasks succeeded
      for (const taskId of ["plan", "implement", "review", "qa"]) {
        const task = finalSnap.tasks.find((t) => t.taskId === taskId);
        expect(task?.status).toBe("succeeded");
      }

      // Verify event history in SQLite is strictly monotonic without gaps
      const allEventsRes = await harness.runStore.readEvents(runId, { limit: 100 });
      expect(allEventsRes.ok).toBe(true);
      const events = allEventsRes.value.items;
      for (let i = 0; i < events.length; i++) {
        expect(events[i]!.sequence).toBe(i + 1);
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("6.2: recovers workflow run from complete event history across restarts when no aggregate checkpoint exists", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition({ requiresApproval: false });
      const runId = `run-s6-no-cp-${randomUUID()}`;

      // Start on instance 1 without saving any aggregate checkpoints
      const service1 = createRuntimeService(harness.ports);
      const startRes = await service1.startRun(definition, { runId });
      expect(startRes.ok).toBe(true);

      await service1.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

      const snap1 = (await harness.engine.getSnapshot(runId)).value!;
      expect(snap1.tasks.find((t) => t.taskId === "plan")?.status).toBe("succeeded");

      // Verify no checkpoint exists in RunStore
      const cpCheck = await harness.runStore.loadLatestCheckpoint(runId);
      expect(cpCheck.ok).toBe(true);
      expect(cpCheck.value).toBeNull();

      // Restart: fresh engine
      const freshEngine = new DeterministicWorkflowEngine({
        definitions: [definition],
        clock: harness.ports.clock ? () => harness.ports.clock!().toISOString() : undefined
      });

      const service2 = createRuntimeService({
        ...harness.ports,
        engine: freshEngine
      });

      // Recovery reconstitution test: reconstitute exact snapshot version 12 from events
      const recoveryPorts = {
        engine: freshEngine,
        runStore: harness.runStore,
        transport: harness.transport
      };
      const recRes = await recoverWorkflowRun(runId, recoveryPorts);
      expect(recRes.ok).toBe(true);

      const recoveredSnap = (await freshEngine.getSnapshot(runId)).value!;
      expect(recoveredSnap.runId).toBe(runId);
      expect(recoveredSnap.version).toBe(snap1.version);
      expect(recoveredSnap.lastEventSequence).toBe(snap1.lastEventSequence);
      expect(recoveredSnap.tasks.find((t) => t.taskId === "plan")?.status).toBe("succeeded");

      // Resume triggers driving execution forward
      const resumeRes = await service2.resume(runId);
      expect(resumeRes.ok).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("6.3: fails closed with typed validation error when checkpoint codec is invalid or incompatible", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = `run-s6-bad-codec-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      await service.startRun(definition, { runId });

      const startSnap = (await service.getRun(runId)).value!;

      // Craft an incompatible checkpoint with non-aggregate codec (valid snapshot checkpoint, but recovery requires aggregate)
      const badCheckpoint = {
        checkpointSchemaVersion: 1 as const,
        checkpointId: `cp-bad-${randomUUID()}`,
        runId,
        eventSequence: startSnap.lastEventSequence,
        version: startSnap.version,
        state: startSnap,
        createdAt: new Date().toISOString(),
        codec: {
          name: "bflow.workflow-run-snapshot+json" as const,
          version: 1 as const
        }
      };

      const saveRes = await harness.runStore.saveCheckpoint(badCheckpoint, startSnap.version);
      expect(saveRes.ok).toBe(true);

      const freshEngine = new DeterministicWorkflowEngine({ definitions: [definition] });
      const recoveryPorts = {
        engine: freshEngine,
        runStore: harness.runStore,
        transport: harness.transport
      };

      const recoveryRes = await recoverWorkflowRun(runId, recoveryPorts);
      expect(recoveryRes.ok).toBe(false);
      if (!recoveryRes.ok) {
        expect(recoveryRes.error.code).toBe("validation");
        expect(recoveryRes.error.retryable).toBe(false);
        expect(recoveryRes.error.message).toContain("aggregate checkpoint");
      }

      // Fresh engine snapshot remains empty (unpolluted)
      const snap = await freshEngine.getSnapshot(runId);
      expect(snap.value).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});
