import { describe, it, expect, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import {
  createTestHarness,
  createSampleWorkflowDefinition,
  FakeAgentTransport
} from "./fixtures.js";
import { TaskDispatcher } from "../../src/dispatcher.js";
import { SdlcWorkflowOrchestrator, isHumanApprover } from "../../src/orchestrator.js";
import { recoverWorkflowRun } from "../../src/recovery.js";
import { AsyncQueue, createDomainEventStream, DefaultRunEventHub } from "../../src/stream.js";
import type { ArtifactProposal, WorkflowRunSnapshot, WorkflowDefinition } from "@bflow/contracts";

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

describe("Challenger M1.1 Empirical Adversarial Stress Suite", { timeout: 30000 }, () => {
  // =========================================================================
  // SUITE 1: TaskDispatcher Adversarial Stress
  // =========================================================================
  describe("Suite 1: TaskDispatcher Adversarial Stress", () => {
    it("1.1: Concurrent dispatches of the same task race for execution binding", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);

        // Fire two concurrent dispatchTask calls for the same task
        const [res1, res2] = await Promise.all([
          dispatcher.dispatchTask(definition, snapshot, "plan", "Instruction 1"),
          dispatcher.dispatchTask(definition, snapshot, "plan", "Instruction 2")
        ]);

        const successes = [res1, res2].filter((r) => r.ok);
        const failures = [res1, res2].filter((r) => !r.ok);

        expect(successes.length).toBeGreaterThanOrEqual(1);
        if (failures.length > 0) {
          expect(["conflict", "validation"]).toContain(failures[0].error.code);
        }

        const postSnap = await harness.ports.engine.getSnapshot(runId);
        const planTask = postSnap.value!.tasks.find((t) => t.taskId === "plan");
        expect(planTask?.agentExecution).toBeDefined();
      } finally {
        await harness.cleanup();
      }
    });

    it("1.2: Concurrent scheduleReadyTasks racing with optimistic locking", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { dispatcher } = await setupRun(harness, runId);

        const results = await Promise.all([
          dispatcher.scheduleReadyTasks(runId),
          dispatcher.scheduleReadyTasks(runId),
          dispatcher.scheduleReadyTasks(runId),
          dispatcher.scheduleReadyTasks(runId),
          dispatcher.scheduleReadyTasks(runId)
        ]);

        for (const res of results) {
          if (!res.ok) {
            expect(["conflict", "validation"]).toContain(res.error.code);
          }
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("1.3: Lease collisions and capacity exhaustion", async () => {
      const harness = await createTestHarness();
      try {
        // Configure an agent with maxConcurrentTasks: 1
        await harness.agentRegistry.upsert({
          agentId: "agent-bottleneck",
          role: "developer",
          transport: "herdr",
          enabled: true,
          priority: 100,
          maxConcurrentTasks: 1,
          capabilities: ["developer"],
          settings: { provider: "mock", kind: "agent", execution: { paneId: "pane-dev" } }
        });

        const runId1 = `run-cap-1`;
        const runId2 = `run-cap-2`;
        await setupRun(harness, runId1);
        await setupRun(harness, runId2);

        // Acquire lease on agent-bottleneck for run 1
        const lease1 = await harness.agentRegistry.acquireLease({
          leaseId: "lease-sat-1",
          agentId: "agent-bottleneck",
          runId: runId1,
          taskId: "task-1",
          attemptId: "att-1",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: "sat-key-1"
        });
        expect(lease1.ok).toBe(true);

        // Attempting another lease for run 2 on the same agent MUST fail with conflict
        const lease2 = await harness.agentRegistry.acquireLease({
          leaseId: "lease-sat-2",
          agentId: "agent-bottleneck",
          runId: runId2,
          taskId: "task-2",
          attemptId: "att-2",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: "sat-key-2"
        });
        expect(lease2.ok).toBe(false);
        expect(lease2.error.code).toBe("conflict");
      } finally {
        await harness.cleanup();
      }
    });

    it("1.4: Expired lease or invalid fencing token (<= 0) is rejected immediately", async () => {
      let simulatedTime = Date.now();
      const clock = () => new Date(simulatedTime);
      const harness = await createTestHarness(clock);
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, definition } = await setupRun(harness, runId);

        const dispatcher = new TaskDispatcher({
          ...harness.ports,
          clock,
          defaultLeaseTtlMs: 100
        });

        const origAcquire = harness.agentRegistry.acquireLease.bind(harness.agentRegistry);
        vi.spyOn(harness.agentRegistry, "acquireLease").mockImplementation(async (req, opts) => {
          const res = await origAcquire(req, opts);
          if (res.ok) {
            return {
              ok: true,
              value: {
                ...res.value,
                expiresAt: new Date(simulatedTime - 1000).toISOString()
              }
            };
          }
          return res;
        });

        const dispRes = await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispRes.ok).toBe(false);
        expect(dispRes.error.code).toBe("conflict");
        expect(dispRes.error.message).toContain("Lease expired or invalid fencing token");
      } finally {
        await harness.cleanup();
      }
    });

    it("1.5: Rapid cancellation while execution is in-flight", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);

        const dispRes = await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispRes.ok).toBe(true);
        const handle = dispRes.value;

        const cancelRes = await dispatcher.cancelTask(runId, "plan", "User abort");
        expect(cancelRes.ok).toBe(true);

        expect(harness.transport.cancelledHandles.some((h) => h.executionId === handle.executionId)).toBe(true);
        expect(dispatcher.getActiveExecution(runId, "plan")).toBeUndefined();

        const postSnap = (await harness.ports.engine.getSnapshot(runId)).value!;
        const planState = postSnap.tasks.find((t) => t.taskId === "plan")!;
        expect(planState.status).toBe("cancelled");
      } finally {
        await harness.cleanup();
      }
    });

    it("1.6: cancelTask successfully cancels bound task after restart using snapshot fallback", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher: dispatcher1, definition } = await setupRun(harness, runId);

        const dispRes = await dispatcher1.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispRes.ok).toBe(true);
        const boundHandle = dispRes.value!;

        // A new TaskDispatcher instance (e.g. after restart or on another node) has empty in-memory activeExecutions
        const dispatcher2 = new TaskDispatcher(harness.ports);
        expect(dispatcher2.getActiveExecution(runId, "plan")).toBeUndefined();

        // Successfully cancel via dispatcher2 using snapshot fallback
        const cancelRes = await dispatcher2.cancelTask(runId, "plan", "Cancel after restart");

        expect(cancelRes.ok).toBe(true);
        expect(harness.transport.cancelledHandles.some((h) => h.executionId === boundHandle.executionId)).toBe(true);
        expect(dispatcher2.getActiveExecution(runId, "plan")).toBeUndefined();

        const postSnap = (await harness.ports.engine.getSnapshot(runId)).value!;
        const planState = postSnap.tasks.find((t) => t.taskId === "plan")!;
        expect(planState.status).toBe("cancelled");
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // SUITE 2: AsyncQueue & createDomainEventStream Stress
  // =========================================================================
  describe("Suite 2: AsyncQueue & Stream Stress", () => {
    it("2.1: Producer-consumer speed mismatch with 2,000 rapid events", async () => {
      const queue = new AsyncQueue<number>({ maxBufferSize: 2500 });

      for (let i = 0; i < 2000; i++) {
        expect(queue.push(i)).toBe(true);
      }

      const received: number[] = [];
      for (let i = 0; i < 2000; i++) {
        const val = await queue.pop();
        expect(val).toBe(i);
        received.push(val!);
      }

      expect(received.length).toBe(2000);
      expect(received[0]).toBe(0);
      expect(received[1999]).toBe(1999);
    });

    it("2.2: Buffer overflow delivers error event when queue is full", () => {
      const queue = new AsyncQueue<{ ok: boolean; value?: number; error?: string }>({ maxBufferSize: 5 });

      // Fill queue to capacity (5 items)
      for (let i = 0; i < 5; i++) {
        expect(queue.push({ ok: true, value: i })).toBe(true);
      }

      // 6th item overflows
      const sixthPushed = queue.push({ ok: true, value: 5 });
      expect(sixthPushed).toBe(false);

      // In createDomainEventStream line 150, forced push guarantees error delivery
      const errorPushed = queue.push({ ok: false, error: "Buffer overflow" }, { force: true });
      expect(errorPushed).toBe(true);
    });

    it("2.3: Sudden consumer abort mid-stream cleans up immediately", async () => {
      const harness = await createTestHarness();
      try {
        const hub = new DefaultRunEventHub();
        const runId = `run-${randomUUID()}`;
        await setupRun(harness, runId);

        const controller = new AbortController();
        const stream = createDomainEventStream(
          harness.ports,
          hub,
          runId,
          { signal: controller.signal }
        );

        let receivedCount = 0;
        const readerPromise = (async () => {
          for await (const eventRes of stream) {
            if (eventRes.ok) {
              receivedCount++;
              if (receivedCount === 3) {
                controller.abort();
              }
            }
          }
        })();

        for (let i = 1; i <= 10; i++) {
          hub.publish(runId, [
            {
              type: "run.status_changed",
              runId,
              sequence: 10 + i,
              occurredAt: new Date().toISOString(),
              commandKey: `cmd-${i}`,
              payload: { from: "running", to: "running" }
            } as any
          ]);
          await new Promise((r) => setTimeout(r, 10));
        }

        await readerPromise;
        expect(receivedCount).toBeLessThanOrEqual(4);
      } finally {
        await harness.cleanup();
      }
    });

    it("2.4: Memory leak test: 1,000 subscribe and unsubscribe cycles", () => {
      const hub = new DefaultRunEventHub();
      const runId = "run-leak-test";

      const unsubs: Array<() => void> = [];
      for (let i = 0; i < 1000; i++) {
        unsubs.push(hub.subscribe(runId, () => {}));
      }

      for (const unsub of unsubs) {
        unsub();
      }

      const listenersMap = (hub as any).listeners as Map<string, Set<any>>;
      expect(listenersMap.has(runId)).toBe(false);
      expect(listenersMap.size).toBe(0);
    });
  });

  // =========================================================================
  // SUITE 3: Corrupted Inputs, State Mismatches & Fault Injection
  // =========================================================================
  describe("Suite 3: Corrupted Inputs & State Mismatches", () => {
    it("3.1: dispatchTask with missing attemptId returns validation error", async () => {
      const harness = await createTestHarness();
      try {
        const def = createSampleWorkflowDefinition();
        const runId = `run-${randomUUID()}`;

        const snapshot: WorkflowRunSnapshot = {
          runId,
          workflowId: def.id,
          workflowVersion: def.version,
          status: "running",
          tasks: [
            { taskId: "plan", status: "pending", attempt: 0, generation: 0, version: 0 }
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1,
          lastEventSequence: 1
        };

        const dispatcher = new TaskDispatcher(harness.ports);
        const res = await dispatcher.dispatchTask(def, snapshot, "plan", "Instruction");

        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("missing attemptId");
      } finally {
        await harness.cleanup();
      }
    });

    it("3.2: dispatchTask with stale snapshot version releases lease cleanly", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot: engineSnap, definition } = await setupRun(harness, runId);

        const staleSnap: WorkflowRunSnapshot = {
          ...engineSnap,
          version: 999
        };

        const dispatcher = new TaskDispatcher(harness.ports);
        const res = await dispatcher.dispatchTask(definition, staleSnap, "plan", "Instruction");

        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("conflict");

        // Verify capacity not leaked
        const leaseProbe = await harness.agentRegistry.acquireLease({
          leaseId: "probe-lease",
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: "probe-key"
        });
        expect(leaseProbe.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("3.3: completeTaskExecution cleans up activeExecution and releases lease on recordAgentResult failure", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);
        const orchestrator = new SdlcWorkflowOrchestrator(harness.ports, dispatcher);

        const dispRes = await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");
        expect(dispRes.ok).toBe(true);
        expect(dispatcher.getActiveExecution(runId, "plan")).toBeDefined();

        // Simulate engine failure during recordAgentResult
        vi.spyOn(harness.ports.engine, "recordAgentResult").mockResolvedValueOnce({
          ok: false,
          error: { code: "conflict", retryable: false, message: "Engine state conflict" }
        });

        const completeRes = await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        expect(completeRes.ok).toBe(false);

        // Verified: active execution is cleared from dispatcher map
        const activeAfter = dispatcher.getActiveExecution(runId, "plan");
        expect(activeAfter).toBeUndefined();

        // Verified: lease capacity is released and can be acquired
        const leaseProbe = await harness.agentRegistry.acquireLease({
          leaseId: "probe-lease",
          agentId: "agent-planner-1",
          runId,
          taskId: "plan",
          attemptId: "att-probe",
          ttlMs: 60000,
          requestedAt: new Date().toISOString(),
          idempotencyKey: "probe-key"
        });
        expect(leaseProbe.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });

    it("3.4: Proposal checksum mismatch and size mismatch rejected", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-${randomUUID()}`;
        const { snapshot, dispatcher, definition } = await setupRun(harness, runId);
        const orchestrator = new SdlcWorkflowOrchestrator(harness.ports, dispatcher);
        await dispatcher.dispatchTask(definition, snapshot, "plan", "Do plan");

        const content = "Real uncorrupted content";
        const realSha = createHash("sha256").update(content).digest("hex");

        const badChecksumProposal: ArtifactProposal = {
          proposalId: "prop-bad-checksum",
          runId,
          taskId: "plan",
          logicalName: "spec.txt",
          kind: "document",
          mediaType: "text/plain",
          expectedIntegrity: {
            sizeBytes: Buffer.byteLength(content),
            checksum: { algorithm: "sha256", value: "0000000000000000000000000000000000000000000000000000000000000000" }
          }
        };

        const res1 = await orchestrator.completeTaskExecution(runId, "plan", {
          status: "succeeded",
          proposals: [badChecksumProposal],
          contentByProposalId: { [badChecksumProposal.proposalId]: content }
        });
        expect(res1.ok).toBe(false);
        expect(res1.error.code).toBe("validation");
        expect(res1.error.message).toContain("Checksum mismatch");

        const badSizeProposal: ArtifactProposal = {
          proposalId: "prop-bad-size",
          runId,
          taskId: "plan",
          logicalName: "spec.txt",
          kind: "document",
          mediaType: "text/plain",
          expectedIntegrity: {
            sizeBytes: 99999,
            checksum: { algorithm: "sha256", value: realSha }
          }
        };

        const res2 = await orchestrator.completeTaskExecution(runId, "plan", {
          status: "succeeded",
          proposals: [badSizeProposal],
          contentByProposalId: { [badSizeProposal.proposalId]: content }
        });
        expect(res2.ok).toBe(false);
        expect(res2.error.code).toBe("validation");
        expect(res2.error.message).toContain("Size mismatch");
      } finally {
        await harness.cleanup();
      }
    });

    it("3.5: Automated / AI actor self-approval is strictly rejected", () => {
      expect(isHumanApprover("ai-reviewer")).toBe(false);
      expect(isHumanApprover("agent-developer")).toBe(false);
      expect(isHumanApprover("bot-merge")).toBe(false);
      expect(isHumanApprover("system:auto")).toBe(false);
      expect(isHumanApprover("llm_evaluator")).toBe(false);
      expect(isHumanApprover("qa-bot")).toBe(false);
      expect(isHumanApprover("planner_auto")).toBe(false);
      expect(isHumanApprover("")).toBe(false);
      expect(isHumanApprover("   ")).toBe(false);

      expect(isHumanApprover("alice_lead")).toBe(true);
      expect(isHumanApprover("bob-security")).toBe(true);
      expect(isHumanApprover("human_operator")).toBe(true);
    });

    it("3.6: recoverWorkflowRun with missing sequence 1 and non-aggregate checkpoint codec", async () => {
      const harness = await createTestHarness();
      try {
        const def = createSampleWorkflowDefinition();
        const runId1 = `run-missing-seq1`;

        const corruptedSnap: WorkflowRunSnapshot = {
          runId: runId1,
          workflowId: def.id,
          workflowVersion: def.version,
          status: "queued",
          tasks: def.tasks.map((t) => ({ taskId: t.id, status: "pending", attempt: 0, generation: 0, version: 0 })),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 0,
          lastEventSequence: 0
        };
        const createRes = await harness.runStore.create({ snapshot: corruptedSnap, definition: def }, `create-${runId1}`);
        expect(createRes.ok).toBe(true);

        const recoverMissingSeq = await recoverWorkflowRun(runId1, harness.ports);
        expect(recoverMissingSeq.ok).toBe(false);
        expect(recoverMissingSeq.error.code).toBe("corruption");
        expect(recoverMissingSeq.error.message).toContain("missing initial run.created event at sequence 1");

        // Non-aggregate checkpoint codec
        const runId2 = `run-snapshot-codec`;
        const { snapshot } = await setupRun(harness, runId2);

        const cpSaveRes = await harness.runStore.saveCheckpoint(
          {
            checkpointSchemaVersion: 1,
            checkpointId: "cp-snapshot-codec",
            runId: runId2,
            eventSequence: snapshot.lastEventSequence,
            version: snapshot.version,
            codec: { name: "bflow.workflow-run-snapshot+json", version: 1 },
            state: snapshot as any,
            createdAt: new Date().toISOString()
          },
          snapshot.version
        );
        expect(cpSaveRes.ok, `cpSaveRes failed: ${cpSaveRes.error?.message}`).toBe(true);

        const recoverNonAggregate = await recoverWorkflowRun(runId2, harness.ports);
        expect(recoverNonAggregate.ok).toBe(false);
        expect(["validation", "corruption"]).toContain(recoverNonAggregate.error.code);
        expect(recoverNonAggregate.error.message).toContain("Recovery requires complete event history or a complete aggregate checkpoint");
      } finally {
        await harness.cleanup();
      }
    });
  });
});
