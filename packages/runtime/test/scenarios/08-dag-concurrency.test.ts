/**
 * Integration Scenario 8: DAG Topological Ordering & Concurrency Bounds
 *
 * Verifies that:
 * 1. Multi-task Diamond DAGs execute strictly in topological dependency order.
 * 2. Join tasks dependent on multiple concurrent siblings never become runnable
 *    until ALL prerequisites have succeeded.
 * 3. Workflow-level concurrency limits (`definition.maxConcurrency`) strictly bound
 *    how many tasks can execute simultaneously.
 * 4. Agent Registry capacity limits (`maxConcurrentTasks`) and monotonic fencing tokens
 *    prevent concurrent slot over-subscription across tasks sharing the same agent role.
 * 5. Upstream task failure halts downstream dependent branches safely.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type {
  AcquireAgentLeaseRequest,
  AgentLease,
  OperationResult,
  WorkflowDefinition
} from "@ai-flow/contracts";
import { createRuntimeService } from "../../src/service.js";
import { createTestHarness } from "../unit/fixtures.js";

export function createDiamondWorkflowDefinition(options?: {
  readonly maxConcurrency?: number;
  readonly failurePolicy?: "fail-fast" | "block";
}): WorkflowDefinition {
  return {
    schemaVersion: "1",
    id: "diamond-sdlc-workflow",
    name: "Diamond SDLC Workflow",
    version: "1.0.0",
    description: "Diamond DAG with parallel frontend/backend tasks joining into integrate",
    maxConcurrency: options?.maxConcurrency ?? 2,
    failurePolicy: options?.failurePolicy ?? "fail-fast",
    recovery: {
      checkpoint: "task-boundary",
      resumeStrategy: "checkpoint-then-replay",
      staleExecution: "reconcile"
    },
    qualityGates: [],
    tasks: [
      {
        id: "plan",
        title: "Planning Phase",
        role: "planner",
        instruction: "Draft technical spec and interface contracts",
        acceptanceCriteria: ["Spec complete"],
        retry: { maxAttempts: 2, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 1000, jitter: false },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "implement_frontend",
        title: "Frontend Implementation",
        role: "developer",
        instruction: "Implement UI views and clients",
        acceptanceCriteria: ["Frontend builds and passes unit tests"],
        retry: { maxAttempts: 2, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 1000, jitter: false },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "implement_backend",
        title: "Backend Implementation",
        role: "developer",
        instruction: "Implement API routes and database models",
        acceptanceCriteria: ["Backend passes unit and integration tests"],
        retry: { maxAttempts: 2, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 1000, jitter: false },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "integrate",
        title: "End-to-End Integration & Verification",
        role: "qa",
        instruction: "Run end-to-end integration test suite across frontend and backend",
        acceptanceCriteria: ["All integration tests pass"],
        retry: { maxAttempts: 2, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 1000, jitter: false },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      }
    ],
    dependencies: [
      { taskId: "implement_frontend", dependsOnTaskId: "plan", condition: "succeeded" },
      { taskId: "implement_backend", dependsOnTaskId: "plan", condition: "succeeded" },
      { taskId: "integrate", dependsOnTaskId: "implement_frontend", condition: "succeeded" },
      { taskId: "integrate", dependsOnTaskId: "implement_backend", condition: "succeeded" }
    ]
  };
}

describe("Scenario 8: DAG Topological Ordering & Concurrency Bounds", { timeout: 30000 }, () => {
  it("8.1: enforces strict topological dependency ordering in Diamond DAG (join task waits for both siblings)", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createDiamondWorkflowDefinition({ maxConcurrency: 2 });
      const runId = `run-s8-diamond-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      const startRes = await service.startRun(definition, { runId });
      expect(startRes.ok).toBe(true);

      // Phase 1: Only 'plan' is runnable initially
      const snap0 = (await service.getRunStatus(runId)).value!;
      expect(snap0.tasks.find((t) => t.taskId === "plan")?.status).toBe("running");
      expect(snap0.tasks.find((t) => t.taskId === "implement_frontend")?.status).toBe("pending");
      expect(snap0.tasks.find((t) => t.taskId === "implement_backend")?.status).toBe("pending");
      expect(snap0.tasks.find((t) => t.taskId === "integrate")?.status).toBe("pending");

      // Phase 2: Complete 'plan'
      const planRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
        status: "succeeded",
        summary: "Architecture spec completed"
      });
      expect(planRes.ok).toBe(true);

      // Sibling tasks both transition to ready/running via driveRun
      await service.orchestrator.driveRun(runId);
      const snap1 = (await service.getRunStatus(runId)).value!;

      expect(snap1.tasks.find((t) => t.taskId === "plan")?.status).toBe("succeeded");
      const feTask = snap1.tasks.find((t) => t.taskId === "implement_frontend")!;
      const beTask = snap1.tasks.find((t) => t.taskId === "implement_backend")!;
      expect(["ready", "running"]).toContain(feTask.status);
      expect(["ready", "running"]).toContain(beTask.status);

      // CRITICAL CHECK: Join task 'integrate' MUST STILL BE pending
      const intTask1 = snap1.tasks.find((t) => t.taskId === "integrate")!;
      expect(intTask1.status).toBe("pending");

      // Phase 3: Complete 'implement_frontend' ONLY
      const feCompleteRes = await service.orchestrator.completeTaskExecution(runId, "implement_frontend", {
        status: "succeeded",
        summary: "Frontend components finished"
      });
      expect(feCompleteRes.ok).toBe(true);

      // Attempt to schedule tasks
      const scheduleRes1 = await service.dispatcher.scheduleReadyTasks(runId);
      expect(scheduleRes1.ok).toBe(true);

      // CRITICAL CHECK: 'integrate' CANNOT be runnable because 'implement_backend' is still not succeeded
      expect(scheduleRes1.value).not.toContain("integrate");

      const snap2 = (await service.getRunStatus(runId)).value!;
      expect(snap2.tasks.find((t) => t.taskId === "implement_frontend")?.status).toBe("succeeded");
      expect(snap2.tasks.find((t) => t.taskId === "implement_backend")?.status).toBe("running");
      expect(snap2.tasks.find((t) => t.taskId === "integrate")?.status).toBe("pending");

      // Phase 4: Complete 'implement_backend'
      const beCompleteRes = await service.orchestrator.completeTaskExecution(runId, "implement_backend", {
        status: "succeeded",
        summary: "Backend API and database complete"
      });
      expect(beCompleteRes.ok).toBe(true);

      // Now both prerequisites are succeeded: 'integrate' must become runnable!
      await service.orchestrator.driveRun(runId);
      const snap3 = (await service.getRunStatus(runId)).value!;
      const intTaskReady = snap3.tasks.find((t) => t.taskId === "integrate")!;
      expect(["ready", "running"]).toContain(intTaskReady.status);

      // Phase 5: Complete 'integrate'
      const intCompleteRes = await service.orchestrator.completeTaskExecution(runId, "integrate", {
        status: "succeeded",
        summary: "All end-to-end integration tests passed"
      });
      expect(intCompleteRes.ok).toBe(true);

      // Workflow run completes to 'succeeded'
      await service.orchestrator.driveRun(runId);
      const finalSnap = (await service.getRunStatus(runId)).value!;
      expect(finalSnap.status).toBe("succeeded");

      for (const t of finalSnap.tasks) {
        expect(t.status).toBe("succeeded");
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("8.2: workflow maxConcurrency limit bounds parallel task dispatch", async () => {
    const harness = await createTestHarness();
    try {
      // Configure maxConcurrency: 1 on Diamond DAG
      const definition = createDiamondWorkflowDefinition({ maxConcurrency: 1 });
      const runId = `run-s8-max-conc-1-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      await service.startRun(definition, { runId });

      // Plan succeeds
      await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

      // Schedule ready tasks
      const scheduleRes = await service.dispatcher.scheduleReadyTasks(runId);
      expect(scheduleRes.ok).toBe(true);

      // Since maxConcurrency is 1, EXACTLY 1 task can be selected to run!
      expect(scheduleRes.value.length).toBe(1);
      const runningTaskId = scheduleRes.value[0]!;
      const siblingTaskId = runningTaskId === "implement_frontend" ? "implement_backend" : "implement_frontend";

      const snap = (await service.getRunStatus(runId)).value!;
      expect(snap.tasks.find((t) => t.taskId === runningTaskId)?.status).toBe("running");
      // The other sibling must remain ready (cannot be running concurrently due to maxConcurrency: 1)
      expect(snap.tasks.find((t) => t.taskId === siblingTaskId)?.status).toBe("ready");

      // Dispatch the running task so it acquires lease and binds execution
      const currentSnap = (await service.getRunStatus(runId)).value!;
      await service.dispatcher.dispatchTask(definition, currentSnap, runningTaskId, "Implement feature");

      // Complete the first running sibling
      const completeRes = await service.orchestrator.completeTaskExecution(runId, runningTaskId, { status: "succeeded" });
      expect(completeRes.ok).toBe(true);

      // Now the second sibling can be scheduled
      const scheduleRes2 = await service.dispatcher.scheduleReadyTasks(runId);
      expect(scheduleRes2.ok).toBe(true);
      expect(scheduleRes2.value).toContain(siblingTaskId);
    } finally {
      await harness.cleanup();
    }
  });

  it("8.3: agent registry capacity limit (maxConcurrentTasks: 1) and monotonic fencing tokens prevent slot over-subscription", async () => {
    const harness = await createTestHarness();
    try {
      // Re-configure 'developer' agent in registry with maxConcurrentTasks: 1
      await harness.agentRegistry.upsert({
        agentId: "agent-developer-1",
        role: "developer",
        transport: "herdr",
        enabled: true,
        priority: 10,
        maxConcurrentTasks: 1, // Single capacity slot!
        capabilities: ["developer", "general"],
        settings: { provider: "mock", kind: "agent", execution: { paneId: "pane-developer" } }
      });

      // Diamond workflow allows maxConcurrency: 2 at the workflow level,
      // but the underlying agent registry restricts role 'developer' to 1 slot!
      const definition = createDiamondWorkflowDefinition({ maxConcurrency: 2 });
      const runId = `run-s8-lease-cap-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      await service.startRun(definition, { runId });
      await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

      // Both siblings are ready
      const snap = (await service.getRunStatus(runId)).value!;
      const feState = snap.tasks.find((t) => t.taskId === "implement_frontend")!;
      const beState = snap.tasks.find((t) => t.taskId === "implement_backend")!;

      // 1. Frontend acquires the single developer slot
      const lease1Req: AcquireAgentLeaseRequest = {
        leaseId: "lease-fe-1",
        agentId: "agent-developer-1",
        runId,
        taskId: "implement_frontend",
        attemptId: feState.attemptId ?? "attempt-fe-1",
        ttlMs: 30000,
        requestedAt: new Date().toISOString(),
        idempotencyKey: `idemp-fe-${runId}`
      };
      const lease1Res = await harness.agentRegistry.acquireLease(lease1Req);
      expect(lease1Res.ok).toBe(true);
      if (!lease1Res.ok) return;
      const lease1: AgentLease = lease1Res.value;
      expect(lease1.fencingToken).toBeGreaterThan(0);

      // 2. Backend attempts to acquire developer slot while Frontend holds it
      const lease2Req: AcquireAgentLeaseRequest = {
        leaseId: "lease-be-1",
        agentId: "agent-developer-1",
        runId,
        taskId: "implement_backend",
        attemptId: beState.attemptId ?? "attempt-be-1",
        ttlMs: 30000,
        requestedAt: new Date().toISOString(),
        idempotencyKey: `idemp-be-${runId}`
      };
      const lease2Res = await harness.agentRegistry.acquireLease(lease2Req);

      // Must be rejected with conflict because capacity (1) is fully occupied!
      expect(lease2Res.ok).toBe(false);
      if (!lease2Res.ok) {
        expect(lease2Res.error.code).toBe("conflict");
      }

      // 3. Frontend finishes and releases its lease
      const releaseRes = await harness.agentRegistry.releaseLease({
        leaseId: lease1.leaseId,
        fencingToken: lease1.fencingToken,
        expectedVersion: lease1.version,
        releasedAt: new Date().toISOString(),
        idempotencyKey: `rel-fe-${runId}`
      });
      expect(releaseRes.ok).toBe(true);

      // 4. Now Backend can acquire the slot:
      // Verifies MONOTONIC FENCING TOKEN increment (fencingToken2 > fencingToken1)
      const lease2RetryRes = await harness.agentRegistry.acquireLease({
        ...lease2Req,
        leaseId: "lease-be-2",
        idempotencyKey: `idemp-be-retry-${runId}`
      });
      expect(lease2RetryRes.ok).toBe(true);
      if (!lease2RetryRes.ok) return;
      const lease2: AgentLease = lease2RetryRes.value;

      expect(lease2.fencingToken).toBeGreaterThan(lease1.fencingToken);

      // Release Backend lease
      await harness.agentRegistry.releaseLease({
        leaseId: lease2.leaseId,
        fencingToken: lease2.fencingToken,
        expectedVersion: lease2.version,
        releasedAt: new Date().toISOString(),
        idempotencyKey: `rel-be-${runId}`
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("8.4: upstream sibling failure under fail-fast safely halts dependent DAG join branch", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createDiamondWorkflowDefinition({ maxConcurrency: 2, failurePolicy: "fail-fast" });
      const runId = `run-s8-fail-branch-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      await service.startRun(definition, { runId });
      await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

      await service.orchestrator.driveRun(runId);

      // Sibling 1 (implement_frontend) fails execution
      const failRes = await service.orchestrator.completeTaskExecution(runId, "implement_frontend", {
        status: "failed",
        summary: "Syntax and compile errors in UI bundle"
      });
      expect(failRes.ok).toBe(true);

      const snapAfterFailure = (await service.getRunStatus(runId)).value!;
      const feState = snapAfterFailure.tasks.find((t) => t.taskId === "implement_frontend")!;
      expect(feState.status).toBe("failed");

      // Verify join task 'integrate' NEVER becomes runnable
      const scheduleRes = await service.dispatcher.scheduleReadyTasks(runId);
      if (scheduleRes.ok) {
        expect(scheduleRes.value).not.toContain("integrate");
      }

      const currentSnap = (await service.getRunStatus(runId)).value!;
      const intTask = currentSnap.tasks.find((t) => t.taskId === "integrate")!;
      // Join task was halted and never ran
      expect(intTask.status).not.toBe("running");
      expect(intTask.status).not.toBe("succeeded");
    } finally {
      await harness.cleanup();
    }
  });
});
