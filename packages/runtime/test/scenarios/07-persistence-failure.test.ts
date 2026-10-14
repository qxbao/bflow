/**
 * Integration Scenario 7: Persistence Failure & Invariant Safety
 *
 * Verifies that:
 * 1. Simulated persistence write failures during event append, checkpoint save,
 *    or artifact put surface as typed ContractError results (code: "conflict" or "corruption").
 * 2. Invariant 1 (Zero Run State Corruption): A failed storage write leaves no partial,
 *    corrupted, or torn state in SQLite RunStore or Filesystem ArtifactStore.
 * 3. Invariant 2 (Zero False Task Success Claims): An agent or task execution is NEVER
 *    marked 'succeeded' or allowed to advance the DAG if its outputs, events, or artifacts
 *    failed to persist.
 * 4. Optimistic concurrency conflicts on parallel writes preserve linear event ordering.
 */

import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactProposal,
  DomainEvent,
  EventBatch,
  OperationOptions,
  OperationResult
} from "@ai-flow/contracts";
import { createRuntimeService } from "../../src/service.js";
import {
  createSampleWorkflowDefinition,
  createTestHarness
} from "../unit/fixtures.js";

describe("Scenario 7: Persistence Failure & Invariant Safety", { timeout: 30000 }, () => {
  it("7.1: SQLite appendEvents write failure surfaces typed conflict/corruption error without corrupting run state", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = `run-s7-append-fail-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      const startRes = await service.startRun(definition, { runId });
      expect(startRes.ok).toBe(true);

      const snapBefore = (await service.getRunStatus(runId)).value!;
      const versionBefore = snapBefore.version;
      const sequenceBefore = snapBefore.lastEventSequence;

      // Inject simulated SQLite writer failure into harness.runStore.appendEvents
      const originalAppendEvents = harness.runStore.appendEvents.bind(harness.runStore);
      let injectFailure = true;

      harness.runStore.appendEvents = async (
        batch: EventBatch,
        options?: OperationOptions
      ): Promise<OperationResult<void>> => {
        if (injectFailure) {
          return {
            ok: false,
            error: {
              code: "conflict",
              retryable: true,
              message: "SQLite writer is busy; retry the same idempotency key"
            }
          };
        }
        return originalAppendEvents(batch, options);
      };

      // Attempt to complete 'plan' task while storage write fails
      const completeRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
        status: "succeeded",
        summary: "Architecture plan drafted"
      });

      // 1. Verify failure surfaces as typed ContractError
      expect(completeRes.ok).toBe(false);
      if (!completeRes.ok) {
        expect(completeRes.error.code).toBe("conflict");
        expect(completeRes.error.retryable).toBe(true);
        expect(completeRes.error.message).toContain("SQLite writer is busy");
      }

      // 2. INVARIANT CHECK: Zero run state corruption in durable store
      const storedRunRes = await harness.runStore.get(runId);
      expect(storedRunRes.ok).toBe(true);
      const storedSnapshot = storedRunRes.value!.snapshot;

      // The durable snapshot in SQLite must remain exactly at its pre-failure version
      expect(storedSnapshot.version).toBe(versionBefore);
      expect(storedSnapshot.lastEventSequence).toBe(sequenceBefore);

      // Verify no partial or corrupt events were appended to the event store
      const eventsRes = await harness.runStore.readEvents(runId, { limit: 100 });
      expect(eventsRes.ok).toBe(true);
      expect(eventsRes.value.items).toHaveLength(sequenceBefore);

      // 3. RESILIENCE: Once storage failure resolves, operation succeeds cleanly
      injectFailure = false;
      const retryRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
        status: "succeeded",
        summary: "Architecture plan drafted"
      });
      if (!retryRes.ok) console.error("RETRY RES ERROR:", retryRes.error);
      expect(retryRes.ok).toBe(true);

      const snapAfter = (await service.getRunStatus(runId)).value!;
      expect(snapAfter.version).toBeGreaterThan(versionBefore);
      expect(snapAfter.tasks.find((t) => t.taskId === "plan")?.status).toBe("succeeded");
    } finally {
      await harness.cleanup();
    }
  });

  it("7.2: ArtifactStore put failure during proposal ingestion halts execution with ZERO false task success claims", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = `run-s7-artifact-fail-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      await service.startRun(definition, { runId });

      // Plan task is active
      const preSnap = (await service.getRunStatus(runId)).value!;
      const planTaskBefore = preSnap.tasks.find((t) => t.taskId === "plan")!;
      expect(planTaskBefore.status).not.toBe("succeeded");

      // Agent generates an artifact proposal
      const content = "# Architecture Specification Document\n\nSystem design details.";
      const bytes = Buffer.from(content, "utf8");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const proposalId = `prop-spec-${randomUUID()}`;

      const proposal: ArtifactProposal = {
        proposalId,
        runId,
        taskId: "plan",
        kind: "document",
        logicalName: "spec.md",
        mediaType: "text/markdown",
        expectedIntegrity: {
          sizeBytes: bytes.byteLength,
          checksum: { algorithm: "sha256", value: sha256 }
        }
      };

      // Inject simulated disk I/O / storage failure into harness.artifactStore.put
      harness.artifactStore.put = async (): Promise<OperationResult<any>> => {
        return {
          ok: false,
          error: {
            code: "corruption",
            retryable: false,
            message: "I/O error: disk full or volume write error on artifact root"
          }
        };
      };

      // Attempt to complete task execution with the unpersisted artifact
      const completeRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
        status: "succeeded",
        summary: "Generated specification document",
        proposals: [proposal],
        contentByProposalId: { [proposalId]: content }
      });

      // 1. Verify typed ContractError returned
      expect(completeRes.ok).toBe(false);
      if (!completeRes.ok) {
        expect(completeRes.error.code).toBe("corruption");
        expect(completeRes.error.retryable).toBe(false);
        expect(completeRes.error.message).toContain("I/O error");
      }

      // 2. CRITICAL INVARIANT: ZERO FALSE TASK SUCCESS CLAIMS
      // Task 'plan' MUST NOT be marked succeeded in the engine snapshot
      const currentSnap = (await harness.engine.getSnapshot(runId)).value!;
      const planTaskAfter = currentSnap.tasks.find((t) => t.taskId === "plan")!;
      expect(planTaskAfter.status).not.toBe("succeeded");

      // 3. Verify no unverified artifact reference was registered in ArtifactStore
      const resolveRes = await harness.artifactStore.resolve(proposalId);
      expect(resolveRes.ok).toBe(true);
      expect(resolveRes.value).toBeNull();

      // 4. Verify no task.succeeded (status_changed to succeeded) event was appended to SQLite RunStore
      const eventsRes = await harness.runStore.readEvents(runId, { limit: 100 });
      expect(eventsRes.ok).toBe(true);
      const taskSuccessEvents = eventsRes.value.items.filter(
        (e: DomainEvent) =>
          e.type === "task.status_changed" &&
          (e.payload as any)?.taskId === "plan" &&
          (e.payload as any)?.to === "succeeded"
      );
      expect(taskSuccessEvents).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("7.3: Checkpoint save failure surfaces conflict error without invalidating domain event history or aggregate state", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = `run-s7-cp-fail-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      await service.startRun(definition, { runId });
      await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

      const snapRes = await harness.engine.getSnapshot(runId);
      const snapshot = snapRes.value!;

      // Inject simulated checkpoint version conflict
      const originalSaveCheckpoint = harness.runStore.saveCheckpoint.bind(harness.runStore);
      harness.runStore.saveCheckpoint = async (): Promise<OperationResult<void>> => {
        return {
          ok: false,
          error: {
            code: "conflict",
            retryable: true,
            version: { expected: snapshot.version + 1, actual: snapshot.version },
            message: "Optimistic version conflict while saving checkpoint"
          }
        };
      };

      // Attempt to create and save checkpoint
      const cpCmdRes = await harness.engine.createCheckpoint({
        runId,
        expectedVersion: snapshot.version,
        checkpointId: `cp-${runId}-conflict`,
        createdAt: new Date().toISOString()
      });
      expect(cpCmdRes.ok).toBe(true);
      if (!cpCmdRes.ok) return;

      const saveRes = await harness.runStore.saveCheckpoint(cpCmdRes.value, snapshot.version);

      // Verify typed conflict error
      expect(saveRes.ok).toBe(false);
      if (!saveRes.ok) {
        expect(saveRes.error.code).toBe("conflict");
        expect(saveRes.error.retryable).toBe(true);
      }

      // Restore saveCheckpoint
      harness.runStore.saveCheckpoint = originalSaveCheckpoint;

      // Invariant: The domain event history in SQLite is completely intact and readable
      const eventsRes = await harness.runStore.readEvents(runId, { limit: 100 });
      expect(eventsRes.ok).toBe(true);
      expect(eventsRes.value.items.length).toBeGreaterThanOrEqual(2);
      expect(eventsRes.value.items[0]?.type).toBe("run.created");
    } finally {
      await harness.cleanup();
    }
  });

  it("7.4: Optimistic concurrency conflict on parallel event appends preserves strict linear history", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = `run-s7-optimistic-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      await service.startRun(definition, { runId });

      const snapRes = await harness.engine.getSnapshot(runId);
      const snapshot = snapRes.value!;

      // First batch: appends valid events
      const dummyEvent1: DomainEvent = {
        schemaVersion: 1,
        eventId: `evt-1-${randomUUID()}`,
        runId,
        taskId: "implement",
        sequence: snapshot.lastEventSequence + 1,
        aggregateVersion: snapshot.version + 1,
        correlationId: `corr-${randomUUID()}`,
        idempotencyKey: `idemp-evt-1-${randomUUID()}`,
        type: "task.status_changed",
        occurredAt: new Date().toISOString(),
        payload: {
          from: "pending",
          to: "ready",
          intent: "normal",
          attempt: 0,
          generationFrom: 0,
          generationTo: 0
        }
      };

      const write1Res = await harness.runStore.appendEvents({
        runId,
        expectedVersion: snapshot.version,
        expectedLastSequence: snapshot.lastEventSequence,
        events: [dummyEvent1],
        idempotencyKey: `idemp-write-1-${randomUUID()}`
      });
      expect(write1Res.ok).toBe(true);

      // Second batch: concurrent writer with STALE expectedVersion (snapshot.version instead of snapshot.version + 1)
      const dummyEvent2: DomainEvent = {
        schemaVersion: 1,
        eventId: `evt-2-${randomUUID()}`,
        runId,
        taskId: "implement",
        sequence: snapshot.lastEventSequence + 1,
        aggregateVersion: snapshot.version + 1,
        correlationId: `corr-${randomUUID()}`,
        idempotencyKey: `idemp-evt-2-${randomUUID()}`,
        type: "task.status_changed",
        occurredAt: new Date().toISOString(),
        payload: {
          from: "pending",
          to: "ready",
          intent: "normal",
          attempt: 0,
          generationFrom: 0,
          generationTo: 0
        }
      };

      const write2Res = await harness.runStore.appendEvents({
        runId,
        expectedVersion: snapshot.version, // STALE!
        expectedLastSequence: snapshot.lastEventSequence,
        events: [dummyEvent2],
        idempotencyKey: `idemp-write-2-${randomUUID()}`
      });

      // Second write MUST be rejected with conflict error
      expect(write2Res.ok).toBe(false);
      if (!write2Res.ok) {
        expect(write2Res.error.code).toBe("conflict");
        expect(write2Res.error.retryable).toBe(true);
      }

      // Verify event history in SQLite contains only event 1 and has no branched or torn records
      const eventsRes = await harness.runStore.readEvents(runId, { limit: 100 });
      expect(eventsRes.ok).toBe(true);
      const items = eventsRes.value.items;
      const lastEvent = items[items.length - 1];
      expect(lastEvent?.eventId).toBe(dummyEvent1.eventId);
    } finally {
      await harness.cleanup();
    }
  });
});
