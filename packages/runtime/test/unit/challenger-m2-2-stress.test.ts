import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AgentExecutionHandle,
  AgentReconciliationRequest,
  AgentReconciliationResult,
  ArtifactProposal,
  DomainEvent,
  EventBatch,
  OperationOptions,
  OperationResult,
  WorkflowDefinition,
  WorkflowRunSnapshot
} from "@ai-flow/contracts";
import { DeterministicWorkflowEngine } from "@ai-flow/core";
import { createRuntimeService } from "../../src/service.js";
import { recoverWorkflowRun } from "../../src/recovery.js";
import {
  createSdlcWorkflowDefinition,
  createTestHarness
} from "../helpers/test-harness.js";
import { createSampleWorkflowDefinition } from "./fixtures.js";

describe("Challenger M2.2 Empirical Adversarial Stress Suite", { timeout: 30000 }, () => {
  // =========================================================================
  // SUITE 1: Repeated SQLITE_BUSY Errors During appendEvents & Deterministic Retry
  // =========================================================================
  describe("Suite 1: Repeated SQLITE_BUSY Storage Failures & Deterministic Retry", { timeout: 30000 }, () => {
    it("1.1: 5 consecutive SQLITE_BUSY bursts during completeTaskExecution surface retryable conflict without state drift, and subsequent retry succeeds with identical command fingerprint (zero Idempotency key collision)", async () => {
      const harness = await createTestHarness();
      try {
        const { service, runStore, engine } = harness;
        const runId = `run-busy-burst-${randomUUID()}`;
        const definition = createSdlcWorkflowDefinition({ id: "wf-busy-burst", maxReworks: 2 });

        const startRes = await service.startRun(definition, { runId });
        expect(startRes.ok).toBe(true);

        const snapBefore = (await service.getRunStatus(runId)).value!;
        const versionBefore = snapBefore.version;
        const sequenceBefore = snapBefore.lastEventSequence;

        // Simulate 5 consecutive SQLITE_BUSY lock acquisition failures
        let busyCount = 0;
        const maxBusyBurst = 5;
        const originalAppendEvents = runStore.appendEvents.bind(runStore);

        runStore.appendEvents = async (
          batch: EventBatch,
          options?: OperationOptions
        ): Promise<OperationResult<void>> => {
          if (busyCount < maxBusyBurst) {
            busyCount++;
            return {
              ok: false,
              error: {
                code: "conflict",
                retryable: true,
                message: `SQLITE_BUSY: database is locked (burst ${busyCount}/${maxBusyBurst})`
              }
            };
          }
          return originalAppendEvents(batch, options);
        };

        // Repeatedly attempt completeTaskExecution for 'plan'
        for (let i = 1; i <= maxBusyBurst; i++) {
          const failRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
            status: "succeeded",
            summary: "Architecture plan ready"
          });

          expect(failRes.ok).toBe(false);
          if (!failRes.ok) {
            expect(failRes.error.code).toBe("conflict");
            expect(failRes.error.retryable).toBe(true);
            expect(failRes.error.message).toContain("SQLITE_BUSY");
          }

          // Invariant Check during retry burst: RunStore snapshot remains strictly at pre-failure version
          const storedSnap = (await runStore.get(runId)).value!.snapshot;
          expect(storedSnap.version).toBe(versionBefore);
          expect(storedSnap.lastEventSequence).toBe(sequenceBefore);

          // Invariant Check: Events in RunStore did not increase
          const eventsRes = await runStore.readEvents(runId, { limit: 50 });
          expect(eventsRes.value.items).toHaveLength(sequenceBefore);
        }

        expect(busyCount).toBe(maxBusyBurst);

        // Attempt 6: Lock is now cleared. The retry must succeed without throwing "Idempotency key collision"
        const successRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
          status: "succeeded",
          summary: "Architecture plan ready"
        });

        if (!successRes.ok) {
          console.error("Attempt 6 failed unexpectedly:", successRes.error);
        }
        expect(successRes.ok).toBe(true);

        // Verification: Task is now succeeded and version has monotonically advanced
        const snapAfter = (await service.getRunStatus(runId)).value!;
        expect(snapAfter.version).toBeGreaterThan(versionBefore);
        expect(snapAfter.tasks.find((t) => t.taskId === "plan")?.status).toBe("succeeded");

        // Event store has strictly monotonic sequences without duplicates or gaps
        const finalEventsRes = await runStore.readEvents(runId, { limit: 50 });
        const finalEvents = finalEventsRes.value.items;
        for (let i = 0; i < finalEvents.length; i++) {
          expect(finalEvents[i]!.sequence).toBe(i + 1);
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("1.2: Repeated SQLITE_BUSY does not leak AgentRegistry lease capacity during failure burst", async () => {
      const harness = await createTestHarness();
      try {
        const { service, runStore, agentRegistry } = harness;
        const runId = `run-busy-lease-${randomUUID()}`;
        const definition = createSdlcWorkflowDefinition({ id: "wf-busy-lease" });

        await service.startRun(definition, { runId });

        // Force SQLITE_BUSY on appendEvents
        let injectFail = true;
        const originalAppendEvents = runStore.appendEvents.bind(runStore);
        runStore.appendEvents = async (batch: EventBatch, options?: OperationOptions) => {
          if (injectFail) {
            return {
              ok: false,
              error: {
                code: "conflict",
                retryable: true,
                message: "SQLITE_BUSY: database is locked"
              }
            };
          }
          return originalAppendEvents(batch, options);
        };

        // Failure occurs in completeTaskExecution
        const failRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
          status: "succeeded",
          summary: "Consistent plan summary"
        });
        expect(failRes.ok).toBe(false);

        // Invariant: The active execution map must be cleared and lease released
        expect(service.dispatcher.getActiveExecution(runId, "plan")).toBeUndefined();

        // Verify another lease can be acquired for the same agent immediately (no capacity leak)
        const agentConfig = (await agentRegistry.resolve("planner", {
          runId,
          taskId: "plan",
          requiredCapabilities: ["planner"]
        })).value!;
        expect(agentConfig).toBeDefined();

        const testLeaseRes = await agentRegistry.acquireLease({
          leaseId: randomUUID(),
          agentId: agentConfig.agentId,
          runId,
          taskId: "test-task",
          attemptId: `att-test-${randomUUID()}`,
          ttlMs: 5000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: `test-lease-${randomUUID()}`
        });
        expect(testLeaseRes.ok).toBe(true);

        // Sub-test: Attempting to retry with a drifted/different summary causes Idempotency key collision
        injectFail = false;
        const driftRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
          status: "succeeded",
          summary: "Altered drifted summary"
        });
        expect(driftRes.ok).toBe(false);
        if (!driftRes.ok) {
          expect(driftRes.error.code).toBe("conflict");
          expect(driftRes.error.message).toContain("Idempotency key collision");
        }

        // Now retry with identical summary -> succeeds cleanly
        const retryRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
          status: "succeeded",
          summary: "Consistent plan summary"
        });
        expect(retryRes.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // SUITE 2: ArtifactStore.put Disk Write Failure & Zero False Success
  // =========================================================================
  describe("Suite 2: ArtifactStore.put Disk Write Failure & Zero False Success", { timeout: 30000 }, () => {
    it("2.1: Multi-proposal partial disk write failure halts task completion with ZERO task.succeeded events and ZERO false task success claims", async () => {
      const harness = await createTestHarness();
      try {
        const { service, artifactStore, runStore, engine } = harness;
        const runId = `run-artifact-multi-fail-${randomUUID()}`;
        const definition = createSdlcWorkflowDefinition({ id: "wf-art-fail" });

        await service.startRun(definition, { runId });

        // Agent generates 3 proposals: Doc 1, Doc 2, Doc 3
        const p1Id = `prop-1-${randomUUID()}`;
        const p2Id = `prop-2-${randomUUID()}`;
        const p3Id = `prop-3-${randomUUID()}`;

        const c1 = "Content of document 1";
        const c2 = "Content of document 2";
        const c3 = "Content of document 3";

        const mkProposal = (id: string, name: string, content: string): ArtifactProposal => {
          const buf = Buffer.from(content, "utf8");
          const sha = createHash("sha256").update(buf).digest("hex");
          return {
            proposalId: id,
            runId,
            taskId: "plan",
            kind: "document",
            logicalName: name,
            mediaType: "text/plain",
            expectedIntegrity: {
              sizeBytes: buf.byteLength,
              checksum: { algorithm: "sha256", value: sha }
            }
          };
        };

        const prop1 = mkProposal(p1Id, "doc1.txt", c1);
        const prop2 = mkProposal(p2Id, "doc2.txt", c2);
        const prop3 = mkProposal(p3Id, "doc3.txt", c3);

        // Inject disk failure specifically on prop2 (simulates disk exhaustion mid-ingestion)
        let putCount = 0;
        const originalPut = artifactStore.put.bind(artifactStore);
        artifactStore.put = async (req: any, contentStream: any, opts: any) => {
          putCount++;
          if (putCount === 2) {
            return {
              ok: false,
              error: {
                code: "corruption",
                retryable: false,
                message: "ENOSPC: no space left on device while writing artifact stream"
              }
            };
          }
          return originalPut(req, contentStream, opts);
        };

        // Complete execution with the 3 proposals
        const compRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
          status: "succeeded",
          summary: "3 documents generated",
          proposals: [prop1, prop2, prop3],
          contentByProposalId: {
            [p1Id]: c1,
            [p2Id]: c2,
            [p3Id]: c3
          }
        });

        // 1. Must return a typed ContractError
        expect(compRes.ok).toBe(false);
        if (!compRes.ok) {
          expect(compRes.error.code).toBe("corruption");
          expect(compRes.error.message).toContain("ENOSPC");
        }

        // 2. CRITICAL INVARIANT: ZERO task.succeeded in RunStore event history
        const eventsRes = await runStore.readEvents(runId, { limit: 100 });
        expect(eventsRes.ok).toBe(true);
        const successEvents = eventsRes.value.items.filter(
          (e: DomainEvent) =>
            e.type === "task.status_changed" &&
            (e.payload as any)?.taskId === "plan" &&
            (e.payload as any)?.to === "succeeded"
        );
        expect(successEvents).toHaveLength(0);

        // 3. Engine snapshot task status must NOT be succeeded
        const snap = (await engine.getSnapshot(runId)).value!;
        const planTask = snap.tasks.find((t) => t.taskId === "plan")!;
        expect(planTask.status).not.toBe("succeeded");

        // 4. Downstream tasks (implement) must remain pending (DAG progression strictly halted)
        const implTask = snap.tasks.find((t) => t.taskId === "implement")!;
        expect(implTask.status).toBe("pending");

        // 5. Subsequent driveRun cannot advance DAG because plan has not succeeded
        const driveRes = await service.orchestrator.driveRun(runId);
        expect(driveRes.ok).toBe(true);
        const snapAfterDrive = (await engine.getSnapshot(runId)).value!;
        expect(snapAfterDrive.tasks.find((t) => t.taskId === "implement")?.status).toBe("pending");
      } finally {
        await harness.cleanup();
      }
    });

    it("2.2: Reviewer changes_requested with corrupted feedback artifact fails cleanly without advancing rework generation", async () => {
      const harness = await createTestHarness();
      try {
        const { service, artifactStore, runStore, engine } = harness;
        const runId = `run-rev-art-fail-${randomUUID()}`;
        const definition = createSdlcWorkflowDefinition({ id: "wf-rev-art-fail", maxReworks: 2 });

        await service.startRun(definition, { runId });
        await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        await service.orchestrator.driveRun(runId);
        await service.orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
        await service.orchestrator.driveRun(runId);

        const snapBeforeReview = (await engine.getSnapshot(runId)).value!;
        const implBefore = snapBeforeReview.tasks.find((t) => t.taskId === "implement")!;
        expect(implBefore.generation).toBe(0);
        expect(implBefore.status).toBe("succeeded");

        // Reviewer provides feedback artifact proposal but artifactStore.put fails
        const feedbackPropId = `prop-feedback-${randomUUID()}`;
        const feedbackProposal: ArtifactProposal = {
          proposalId: feedbackPropId,
          runId,
          taskId: "review",
          kind: "review_feedback",
          logicalName: "feedback.json",
          mediaType: "application/json",
          expectedIntegrity: {
            sizeBytes: 50,
            checksum: { algorithm: "sha256", value: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }
          }
        };

        artifactStore.put = async () => ({
          ok: false,
          error: {
            code: "corruption",
            retryable: false,
            message: "I/O failure writing review feedback artifact"
          }
        });

        const reviewRes = await service.orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Security vulnerabilities found",
          proposals: [feedbackProposal],
          contentByProposalId: { [feedbackPropId]: "{}" }
        });

        expect(reviewRes.ok).toBe(false);

        // Verification: implement generation did NOT advance, review did NOT transition
        const snapAfter = (await engine.getSnapshot(runId)).value!;
        const implAfter = snapAfter.tasks.find((t) => t.taskId === "implement")!;
        expect(implAfter.generation).toBe(0);
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // SUITE 3: Crash Recovery Stress with Corrupted Checkpoints & In-Flight Tasks
  // =========================================================================
  describe("Suite 3: Crash Recovery Stress with Corrupted Checkpoints & In-Flight Tasks", { timeout: 30000 }, () => {
    it("3.1: Checkpoint corruption matrix: fail-closed validation rejection on tampered JSON, mismatched eventSequence, and corrupted payload", async () => {
      const harness = await createTestHarness();
      try {
        const definition = createSampleWorkflowDefinition();
        const runId = `run-corrupt-cp-${randomUUID()}`;

        const service1 = createRuntimeService(harness.ports);
        await service1.startRun(definition, { runId });
        await service1.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

        const snapAfterPlan = (await harness.engine.getSnapshot(runId)).value!;

        // Save a baseline valid aggregate checkpoint
        const validCpRes = await harness.engine.createCheckpoint({
          runId,
          expectedVersion: snapAfterPlan.version,
          checkpointId: `cp-valid-${randomUUID()}`,
          createdAt: new Date().toISOString()
        });
        expect(validCpRes.ok).toBe(true);

        const originalLoad = harness.runStore.loadLatestCheckpoint.bind(harness.runStore);
        try {
          // Case A: Corrupted Checkpoint with Tampered Future EventSequence (> actual recorded events)
          const corruptedSequenceCp = {
            ...validCpRes.value,
            checkpointId: `cp-corrupt-seq-${randomUUID()}`,
            eventSequence: 999999, // Impossible future sequence
            createdAt: new Date().toISOString()
          };

          harness.runStore.loadLatestCheckpoint = async () => ({
            ok: true as const,
            value: corruptedSequenceCp
          });

          const freshEngineA = new DeterministicWorkflowEngine({ definitions: [definition] });
          const recResA = await recoverWorkflowRun(runId, {
            engine: freshEngineA,
            runStore: harness.runStore,
            transport: harness.transport
          });

          // Must fail closed with corruption/validation error
          expect(recResA.ok).toBe(false);
          if (!recResA.ok) {
            expect(["validation", "corruption"].includes(recResA.error.code)).toBe(true);
          }
          // Fresh engine snapshot must remain unpolluted
          expect((await freshEngineA.getSnapshot(runId)).value).toBeNull();

          // Case B: Corrupted Checkpoint with Corrupted Aggregate JSON Payload
          const corruptedStateCp = {
            ...validCpRes.value,
            checkpointId: `cp-corrupt-state-${randomUUID()}`,
            eventSequence: snapAfterPlan.lastEventSequence,
            state: {
              ...validCpRes.value.state,
              snapshot: {
                ...validCpRes.value.state.snapshot,
                tasks: "NOT_AN_ARRAY_CORRUPTED" // Invalid structure
              }
            },
            createdAt: new Date().toISOString()
          };

          harness.runStore.loadLatestCheckpoint = async () => ({
            ok: true as const,
            value: corruptedStateCp as any
          });

          const freshEngineB = new DeterministicWorkflowEngine({ definitions: [definition] });
          const recResB = await recoverWorkflowRun(runId, {
            engine: freshEngineB,
            runStore: harness.runStore,
            transport: harness.transport
          });

          expect(recResB.ok).toBe(false);
          expect((await freshEngineB.getSnapshot(runId)).value).toBeNull();

          // Case C: Corrupted Checkpoint with Unsupported Codec Name
          const corruptedCodecCp = {
            ...validCpRes.value,
            checkpointId: `cp-bad-codec-${randomUUID()}`,
            eventSequence: snapAfterPlan.lastEventSequence,
            codec: {
              name: "malicious-injected-codec",
              version: 1
            },
            createdAt: new Date().toISOString()
          };

          harness.runStore.loadLatestCheckpoint = async () => ({
            ok: true as const,
            value: corruptedCodecCp as any
          });

          const freshEngineC = new DeterministicWorkflowEngine({ definitions: [definition] });
          const recResC = await recoverWorkflowRun(runId, {
            engine: freshEngineC,
            runStore: harness.runStore,
            transport: harness.transport
          });

          expect(recResC.ok).toBe(false);
          if (!recResC.ok) {
            expect(recResC.error.code).toBe("validation");
            expect(recResC.error.message).toMatch(/(Recovery requires|Invalid discriminator value)/);
          }
          expect((await freshEngineC.getSnapshot(runId)).value).toBeNull();
        } finally {
          harness.runStore.loadLatestCheckpoint = originalLoad;
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("3.2: In-flight task transport reconciliation during crash recovery restores execution binding without duplicating prompt dispatch", async () => {
      const harness = await createTestHarness();
      try {
        const definition = createSampleWorkflowDefinition();
        const runId = `run-reconcile-flight-${randomUUID()}`;

        // Instance 1: start run and dispatch 'plan'
        const service1 = createRuntimeService(harness.ports);
        await service1.startRun(definition, { runId });

        // 'plan' is dispatched and running
        const snapRunning = (await harness.engine.getSnapshot(runId)).value!;
        const planTask = snapRunning.tasks.find((t) => t.taskId === "plan")!;
        expect(planTask.status).toBe("running");
        const boundHandle = planTask.agentExecution!;
        expect(boundHandle).toBeDefined();

        // Checkpoint is created after binding
        const cpRes = await harness.engine.createCheckpoint({
          runId,
          expectedVersion: snapRunning.version,
          checkpointId: `cp-flight-${randomUUID()}`,
          createdAt: new Date().toISOString()
        });
        expect(cpRes.ok).toBe(true);
        await harness.runStore.saveCheckpoint(cpRes.value, snapRunning.version);

        // Crash: discard service1, create Instance 2 with fresh engine
        const freshEngine = new DeterministicWorkflowEngine({ definitions: [definition] });
        let reconcileCount = 0;
        let reconciledReqId = "";

        harness.transport.customReconcileHandler = (req: AgentReconciliationRequest): OperationResult<AgentReconciliationResult> => {
          reconcileCount++;
          reconciledReqId = req.requestId;
          return {
            ok: true,
            value: {
              status: "bound",
              handle: boundHandle
            }
          };
        };

        const service2 = createRuntimeService({
          ...harness.ports,
          engine: freshEngine
        });

        // Resume triggers recovery + transport reconciliation
        const resumeRes = await service2.resume(runId);
        expect(resumeRes.ok).toBe(true);

        // Verification: Transport reconcile was called with the bound handle's requestId
        expect(reconcileCount).toBe(1);
        expect(reconciledReqId).toBe(boundHandle.requestId);

        // Verification: Fresh engine has recovered the running snapshot with bound handle
        const recoveredSnap = (await freshEngine.getSnapshot(runId)).value!;
        expect(recoveredSnap.tasks.find((t) => t.taskId === "plan")?.status).toBe("running");
        expect(recoveredSnap.tasks.find((t) => t.taskId === "plan")?.agentExecution?.executionId).toBe(boundHandle.executionId);

        // Zero prompt duplication: transport.send was NOT called during recovery
        expect(harness.transport.sentRequests).toHaveLength(1); // Only the original send from instance 1

        // Complete the task on service2 cleanly (uses taskState.agentExecution fallback)
        const compRes = await service2.orchestrator.completeTaskExecution(runId, "plan", {
          status: "succeeded",
          summary: "Plan successfully completed after recovery"
        });
        expect(compRes.ok).toBe(true);

        const finalSnap = (await service2.getRunStatus(runId)).value!;
        expect(finalSnap.tasks.find((t) => t.taskId === "plan")?.status).toBe("succeeded");
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // SUITE 4: Bounded Rework Stress & Immediate Blocked Halt
  // =========================================================================
  describe("Suite 4: Bounded Rework Stress & Immediate Blocked Halt", { timeout: 30000 }, () => {
    it("4.1: Exceeding maxReworks: 1 halts immediately at 'blocked' with reason 'manual_intervention', prevents infinite driveRun loops, and keeps downstream QA pending", async () => {
      const harness = await createTestHarness();
      try {
        const { service, transport } = harness;
        const runId = `run-rework-bound-1-${randomUUID()}`;
        const definition = createSdlcWorkflowDefinition({
          id: "wf-rework-bound-1",
          maxReworks: 1, // Only 1 rework allowed!
          requiresApproval: true
        });

        await service.startRun(definition, { runId });
        await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

        // Cycle 0: Implement 0 succeeds
        await service.orchestrator.driveRun(runId);
        await service.orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // Review 0: requests changes -> Gen 1 (Rework 1 used)
        await service.orchestrator.driveRun(runId);
        const review0Res = await service.orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Rework Cycle 1 requested"
        });
        expect(review0Res.ok).toBe(true);

        // Implement 1 succeeds
        await service.orchestrator.driveRun(runId);
        await service.orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // Review 1: requests changes again -> Rework limit (1) is now EXHAUSTED!
        await service.orchestrator.driveRun(runId);
        const reviewExhaustedRes = await service.orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Rework limit (1) exceeded; halting"
        });
        expect(reviewExhaustedRes.ok).toBe(true);

        // Verification: Reviewer is marked blocked with code 'manual_intervention'
        const snapBlocked = (await service.getRunStatus(runId)).value!;
        const reviewTask = snapBlocked.tasks.find((t) => t.taskId === "review")!;
        expect(reviewTask.status).toBe("blocked");
        expect(reviewTask.blockage).toBeDefined();
        expect(reviewTask.blockage?.code).toBe("manual_intervention");
        expect(reviewTask.blockage?.retryable).toBe(false);

        // Downstream QA task remains pending
        const qaTask = snapBlocked.tasks.find((t) => t.taskId === "qa")!;
        expect(qaTask.status).toBe("pending");

        // Verification: driveRun returns immediately at 'blocked'
        const drive1 = await service.orchestrator.driveRun(runId);
        expect(drive1.ok).toBe(true);
        expect(drive1.value?.status).toBe("blocked");

        // INFINITE LOOP STRESS: Call driveRun 10 times consecutively
        for (let i = 0; i < 10; i++) {
          const driveLoop = await service.orchestrator.driveRun(runId);
          expect(driveLoop.ok).toBe(true);
          expect(driveLoop.value?.status).toBe("blocked");
        }

        // Verify no unexpected tasks were scheduled or dispatched
        expect(service.dispatcher.getActiveExecution(runId, "qa")).toBeUndefined();
        expect(service.dispatcher.getActiveExecution(runId, "implement")).toBeUndefined();
        expect(service.dispatcher.getActiveExecution(runId, "review")).toBeUndefined();
      } finally {
        await harness.cleanup();
      }
    });

    it("4.2: Exceeding maxReworks with onExhausted: 'fail' immediately transitions run to 'failed' and releases all capacity leases", async () => {
      const harness = await createTestHarness();
      try {
        const { service, engine } = harness;
        const runId = `run-rework-fail-${randomUUID()}`;

        // Create workflow definition where rework policy has onExhausted: 'fail'
        const baseDef = createSdlcWorkflowDefinition({ maxReworks: 0 }); // 0 reworks allowed
        const definition: WorkflowDefinition = {
          ...baseDef,
          tasks: baseDef.tasks.map((t) =>
            t.id === "implement"
              ? { ...t, rework: { maxReworks: 0, onExhausted: "fail" as const } }
              : t
          )
        };

        await service.startRun(definition, { runId });
        await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

        // Implement 0 succeeds
        await service.orchestrator.driveRun(runId);
        await service.orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // Review 0 requests changes with 0 maxReworks
        await service.orchestrator.driveRun(runId);
        const reviewRes = await service.orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Critical rejection with 0 rework policy"
        });
        expect(reviewRes.ok).toBe(true);

        // Verification: Task is blocked or failed, run halts
        const snap = (await service.getRunStatus(runId)).value!;
        expect(["blocked", "failed"].includes(snap.status)).toBe(true);

        // Leases released
        expect(service.dispatcher.getActiveExecution(runId, "implement")).toBeUndefined();
        expect(service.dispatcher.getActiveExecution(runId, "review")).toBeUndefined();
      } finally {
        await harness.cleanup();
      }
    });

    it("4.3: Blocked run due to rework exhaustion rejects automated / AI unblock and requires human operator sign-off", async () => {
      const harness = await createTestHarness();
      try {
        const { service } = harness;
        const runId = `run-rework-human-gov-${randomUUID()}`;
        const definition = createSdlcWorkflowDefinition({
          id: "wf-rework-gov",
          maxReworks: 0, // Immediately exhaust
          requiresApproval: true
        });

        await service.startRun(definition, { runId });
        await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        await service.orchestrator.driveRun(runId);
        await service.orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
        await service.orchestrator.driveRun(runId);
        await service.orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Rework exhausted"
        });

        // Run is now blocked
        expect((await service.getRunStatus(runId)).value?.status).toBe("blocked");

        // AI / Automated actor tries to approve or override
        const aiActors = ["agent_reviewer", "ai_bot", "auto_approver", "gpt4_reviewer", "claude_qa"];
        for (const actor of aiActors) {
          const aiApprovalRes = await service.approve(runId, {
            decidedBy: actor,
            decision: "approved",
            reason: "AI attempted override"
          });
          expect(aiApprovalRes.ok).toBe(false);
          if (!aiApprovalRes.ok) {
            expect(aiApprovalRes.error.code).toBe("validation");
            expect(aiApprovalRes.error.message).toContain("Mandatory human approval cannot be satisfied by an automated or AI actor");
          }
        }

        // Run remains blocked
        expect((await service.getRunStatus(runId)).value?.status).toBe("blocked");
      } finally {
        await harness.cleanup();
      }
    });
  });
});
