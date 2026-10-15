import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type {
  AgentReconciliationRequest,
  AgentRequest,
  DomainEvent,
  OperationResult,
  WorkflowDefinition
} from "@bflow/contracts";
import { DefaultRunEventHub, createDomainEventStream } from "../../src/stream.js";
import { createSampleWorkflowDefinition, createTestHarness } from "./fixtures.js";
import { createRuntimeService } from "../../src/service.js";

async function setupRun(
  harness: any,
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

  return {
    service,
    orchestrator: service.orchestrator,
    dispatcher: service.dispatcher,
    definition: def
  };
}

describe("Challenger M2.1 Empirical Adversarial Stress Suite", { timeout: 30000 }, () => {
  // =========================================================================
  // SUITE 1: Transport Timeouts & Rapid Ambiguous Delivery Bursts
  // =========================================================================
  describe("Suite 1: Transport Timeouts & Rapid Ambiguous Delivery Bursts", () => {
    it(
      "1.1: Transport returns unknown_delivery, reconcile proves not_delivered, resend succeeds with ZERO un-reconciled prompt resend",
      async () => {
        const harness = await createTestHarness();
        try {
          const runId = `run-stress-timeout-1-${randomUUID()}`;
          const { dispatcher, definition } = await setupRun(harness, runId);

          let sendCount = 0;
          let reconcileCount = 0;
          const sentRequests: AgentRequest[] = [];

          harness.transport.customSendHandler = (req: AgentRequest) => {
            sendCount++;
            sentRequests.push({ ...req });
            if (sendCount === 1) {
              // Ambiguous delivery: transport timeout before receiving ACK
              return {
                ok: true,
                value: {
                  status: "unknown_delivery",
                  requestId: req.requestId,
                  attemptId: req.attemptId,
                  runId: req.runId,
                  taskId: req.taskId,
                  observedAt: new Date().toISOString()
                }
              };
            }
            // Second send succeeds
            const executionId = `exec-${randomUUID()}`;
            return {
              ok: true,
              value: {
                status: "accepted",
                requestId: req.requestId,
                attemptId: req.attemptId,
                runId: req.runId,
                taskId: req.taskId,
                observedAt: new Date().toISOString(),
                handle: {
                  executionId,
                  requestId: req.requestId,
                  attemptId: req.attemptId,
                  runId: req.runId,
                  taskId: req.taskId,
                  idempotencyKey: req.idempotency.key,
                  target: req.target,
                  correlation: { token: req.requestId, provenance: "transport", verified: true },
                  acceptedAt: new Date().toISOString()
                }
              }
            };
          };

          harness.transport.customReconcileHandler = (_req: AgentReconciliationRequest) => {
            reconcileCount++;
            return {
              ok: true,
              value: { status: "not_delivered" }
            };
          };

          // Step 1: schedule task
          await dispatcher.scheduleReadyTasks(runId);
          const snapReady = (await harness.engine.getSnapshot(runId)).value!;

          // Step 2: dispatch task
          const dispRes = await dispatcher.dispatchTask(definition, snapReady, "plan", "Execute plan");
          expect(dispRes.ok).toBe(true);

          // Invariant Check 1: exactly 2 sends and 1 reconciliation in strict order
          expect(sendCount).toBe(2);
          expect(reconcileCount).toBe(1);

          // Invariant Check 2: Prompt was NOT resent before reconciliation occurred
          expect(sentRequests.length).toBe(2);
          expect(sentRequests[0].idempotency.key).toBe(sentRequests[1].idempotency.key);

          // Invariant Check 3: execution is bound in engine snapshot
          const finalSnap = (await harness.engine.getSnapshot(runId)).value!;
          const planTask = finalSnap.tasks.find((t) => t.taskId === "plan")!;
          expect(planTask.status).toBe("running");
          expect(planTask.agentExecution?.executionId).toBe(dispRes.value!.executionId);
        } finally {
          await harness.cleanup();
        }
      },
      15000
    );

    it(
      "1.2: Repeated unknown_delivery on resend must NOT leave un-reconciled prompt or silently release lease without safe state",
      async () => {
        const harness = await createTestHarness();
        try {
          const runId = `run-stress-timeout-2-${randomUUID()}`;
          const { dispatcher, definition } = await setupRun(harness, runId);

          let sendCount = 0;
          let reconcileCount = 0;

          // Both initial send AND retry send return unknown_delivery
          harness.transport.customSendHandler = (req: AgentRequest) => {
            sendCount++;
            return {
              ok: true,
              value: {
                status: "unknown_delivery",
                requestId: req.requestId,
                attemptId: req.attemptId,
                runId: req.runId,
                taskId: req.taskId,
                observedAt: new Date().toISOString()
              }
            };
          };

          harness.transport.customReconcileHandler = (_req: AgentReconciliationRequest) => {
            reconcileCount++;
            return {
              ok: true,
              value: { status: "not_delivered" }
            };
          };

          await dispatcher.scheduleReadyTasks(runId);
          const snapReady = (await harness.engine.getSnapshot(runId)).value!;

          // Dispatch task
          const dispRes = await dispatcher.dispatchTask(definition, snapReady, "plan", "Execute plan");

          // When resend returns unknown_delivery:
          expect(dispRes.ok).toBe(false);
          expect(reconcileCount).toBeGreaterThanOrEqual(1);

          // Does dispatcher record or leak active execution?
          const active = dispatcher.getActiveExecution(runId, "plan");
          expect(active).toBeUndefined();
        } finally {
          await harness.cleanup();
        }
      },
      15000
    );

    it(
      "1.3: Reconcile proving 'bound' (delivered) must bind handle with ZERO duplicate prompt resend",
      async () => {
        const harness = await createTestHarness();
        try {
          const runId = `run-stress-timeout-3-${randomUUID()}`;
          const { dispatcher, definition } = await setupRun(harness, runId);

          let sendCount = 0;
          let reconcileCount = 0;
          const boundExecutionId = `exec-delivered-${randomUUID()}`;

          harness.transport.customSendHandler = (req: AgentRequest) => {
            sendCount++;
            return {
              ok: true,
              value: {
                status: "unknown_delivery",
                requestId: req.requestId,
                attemptId: req.attemptId,
                runId: req.runId,
                taskId: req.taskId,
                observedAt: new Date().toISOString()
              }
            };
          };

          harness.transport.customReconcileHandler = (req: AgentReconciliationRequest) => {
            reconcileCount++;
            return {
              ok: true,
              value: {
                status: "bound",
                handle: {
                  executionId: boundExecutionId,
                  requestId: req.requestId,
                  attemptId: req.attemptId,
                  runId: req.runId,
                  taskId: req.taskId,
                  idempotencyKey: req.idempotencyKey,
                  target: req.target,
                  correlation: { token: req.requestId, provenance: "transport", verified: true },
                  acceptedAt: new Date().toISOString()
                }
              }
            };
          };

          await dispatcher.scheduleReadyTasks(runId);
          const snapReady = (await harness.engine.getSnapshot(runId)).value!;

          const dispRes = await dispatcher.dispatchTask(definition, snapReady, "plan", "Execute plan");
          expect(dispRes.ok).toBe(true);

          // INVARIANT: Prompt was sent EXACTLY ONCE to transport, ZERO resend
          expect(sendCount).toBe(1);
          expect(reconcileCount).toBe(1);
          expect(dispRes.value?.executionId).toBe(boundExecutionId);

          // Verify engine bound the handle
          const snapBound = (await harness.engine.getSnapshot(runId)).value!;
          const planTask = snapBound.tasks.find((t) => t.taskId === "plan")!;
          expect(planTask.status).toBe("running");
          expect(planTask.agentExecution?.executionId).toBe(boundExecutionId);
        } finally {
          await harness.cleanup();
        }
      },
      15000
    );
  });

  // =========================================================================
  // SUITE 2: DAG Concurrency Stress, Single-Slot Registry & Fencing Tokens
  // =========================================================================
  describe("Suite 2: DAG Concurrency Stress, Single-Slot Registry & Fencing Tokens", () => {
    it(
      "2.1: Single-slot agent registry strictly enforces 1 active task, increments fencing tokens monotonically (2 > 1), and prevents capacity leak",
      async () => {
        const harness = await createTestHarness();
        try {
          // Re-configure developer agent with maxConcurrentTasks: 1
          await harness.agentRegistry.upsert({
            agentId: "agent-developer-1",
            role: "developer",
            transport: "herdr",
            enabled: true,
            priority: 10,
            maxConcurrentTasks: 1, // Single slot!
            capabilities: ["developer"],
            settings: { provider: "mock", kind: "agent", execution: { paneId: "pane-developer" } }
          });

          // Workflow with two parallel developer tasks
          const parallelDef: WorkflowDefinition = {
            schemaVersion: "1",
            id: "wf-single-slot-stress",
            name: "Single Slot Concurrency Stress",
            version: "1.0.0",
            description: "Stress test single slot capacity and monotonic fencing",
            maxConcurrency: 2,
            failurePolicy: "fail-fast",
            recovery: {
              checkpoint: "task-boundary",
              resumeStrategy: "checkpoint-then-replay",
              staleExecution: "reconcile"
            },
            qualityGates: [],
            tasks: [
              {
                id: "dev-a",
                title: "Developer Task A",
                role: "developer",
                instruction: "Implement feature A",
                acceptanceCriteria: ["Feature A ready"],
                retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 100, jitter: false },
                timeout: { executionTimeoutMs: 300_000, onTimeout: "fail" },
                requiresApproval: false,
                qualityGates: []
              },
              {
                id: "dev-b",
                title: "Developer Task B",
                role: "developer",
                instruction: "Implement feature B",
                acceptanceCriteria: ["Feature B ready"],
                retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 100, jitter: false },
                timeout: { executionTimeoutMs: 300_000, onTimeout: "fail" },
                requiresApproval: false,
                qualityGates: []
              }
            ],
            dependencies: []
          };

          const runId = `run-stress-single-slot-${randomUUID()}`;
          const { dispatcher, orchestrator } = await setupRun(harness, runId, parallelDef);

          // Advance both tasks to ready
          await dispatcher.scheduleReadyTasks(runId);
          const snapReady = (await harness.engine.getSnapshot(runId)).value!;

          // 1. Dispatch dev-a: acquires lease 1 with fencingToken 1
          const dispARes = await dispatcher.dispatchTask(parallelDef, snapReady, "dev-a", "Implement A");
          expect(dispARes.ok).toBe(true);

          const activeA = dispatcher.getActiveExecution(runId, "dev-a");
          expect(activeA).toBeDefined();
          const tokenA = activeA!.lease.fencingToken;
          expect(tokenA).toBeGreaterThanOrEqual(1);

          // 2. Dispatch dev-b: MUST FAIL with conflict because agent capacity is full (1/1 active)
          const dispBRes = await dispatcher.dispatchTask(parallelDef, snapReady, "dev-b", "Implement B");
          expect(dispBRes.ok).toBe(false);
          expect(dispBRes.error.code).toBe("conflict");
          expect(dispBRes.error.message).toContain("Agent concurrency limit reached");

          // 3. Complete dev-a: releases lease 1
          const compARes = await orchestrator.completeTaskExecution(runId, "dev-a", {
            status: "succeeded",
            summary: "Dev A finished"
          });
          expect(compARes.ok).toBe(true);

          // Verify active execution dev-a was cleared
          expect(dispatcher.getActiveExecution(runId, "dev-a")).toBeUndefined();

          // 4. Now dispatch dev-b: MUST SUCCEED with strictly higher fencing token (tokenB > tokenA)
          const snapAfterA = (await harness.engine.getSnapshot(runId)).value!;
          const dispBRetryRes = await dispatcher.dispatchTask(parallelDef, snapAfterA, "dev-b", "Implement B");
          expect(dispBRetryRes.ok).toBe(true);

          const activeB = dispatcher.getActiveExecution(runId, "dev-b");
          expect(activeB).toBeDefined();
          const tokenB = activeB!.lease.fencingToken;

          // Invariant Check: Monotonic fencing token increment
          expect(tokenB).toBeGreaterThan(tokenA);

          // 5. Complete dev-b: releases lease 2
          const compBRes = await orchestrator.completeTaskExecution(runId, "dev-b", {
            status: "succeeded",
            summary: "Dev B finished"
          });
          expect(compBRes.ok).toBe(true);
          expect(dispatcher.getActiveExecution(runId, "dev-b")).toBeUndefined();

          // Invariant Check: ZERO capacity leaks!
          // Verify agent can immediately accept a 3rd lease without "Agent concurrency limit reached"
          const testLeaseRes = await harness.agentRegistry.acquireLease({
            leaseId: randomUUID(),
            agentId: "agent-developer-1",
            runId: "canary-run",
            taskId: "canary-task",
            attemptId: "canary-attempt",
            ttlMs: 60_000,
            requestedAt: new Date().toISOString(),
            idempotencyKey: `canary-lease-${randomUUID()}`
          });
          expect(testLeaseRes.ok).toBe(true);
          expect(testLeaseRes.value.fencingToken).toBeGreaterThan(tokenB);
        } finally {
          await harness.cleanup();
        }
      },
      15000
    );

    it(
      "2.2: Tight maxConcurrency: 1 on diamond DAG enforces strictly serialized execution",
      async () => {
        const harness = await createTestHarness();
        try {
          const diamondDef: WorkflowDefinition = {
            schemaVersion: "1",
            id: "wf-diamond-tight-concurrency",
            name: "Diamond DAG Serialized Stress",
            version: "1.0.0",
            description: "Diamond DAG with maxConcurrency 1",
            maxConcurrency: 1, // Strict single concurrency limit
            failurePolicy: "fail-fast",
            recovery: {
              checkpoint: "task-boundary",
              resumeStrategy: "checkpoint-then-replay",
              staleExecution: "reconcile"
            },
            qualityGates: [],
            tasks: [
              {
                id: "root",
                title: "Root Task",
                role: "planner",
                instruction: "Root",
                acceptanceCriteria: ["done"],
                retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 100, jitter: false },
                timeout: { executionTimeoutMs: 300_000, onTimeout: "fail" },
                requiresApproval: false,
                qualityGates: []
              },
              {
                id: "branch-left",
                title: "Left Branch",
                role: "developer",
                instruction: "Left",
                acceptanceCriteria: ["done"],
                retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 100, jitter: false },
                timeout: { executionTimeoutMs: 300_000, onTimeout: "fail" },
                requiresApproval: false,
                qualityGates: []
              },
              {
                id: "branch-right",
                title: "Right Branch",
                role: "developer",
                instruction: "Right",
                acceptanceCriteria: ["done"],
                retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 100, jitter: false },
                timeout: { executionTimeoutMs: 300_000, onTimeout: "fail" },
                requiresApproval: false,
                qualityGates: []
              },
              {
                id: "join",
                title: "Join Task",
                role: "qa",
                instruction: "Join",
                acceptanceCriteria: ["done"],
                retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 100, maxDelayMs: 100, jitter: false },
                timeout: { executionTimeoutMs: 300_000, onTimeout: "fail" },
                requiresApproval: false,
                qualityGates: []
              }
            ],
            dependencies: [
              { taskId: "branch-left", dependsOnTaskId: "root", condition: "succeeded" },
              { taskId: "branch-right", dependsOnTaskId: "root", condition: "succeeded" },
              { taskId: "join", dependsOnTaskId: "branch-left", condition: "succeeded" },
              { taskId: "join", dependsOnTaskId: "branch-right", condition: "succeeded" }
            ]
          };

          const runId = `run-stress-diamond-${randomUUID()}`;
          const { dispatcher, orchestrator } = await setupRun(harness, runId, diamondDef);

          // 1. Root task dispatches and completes
          const sched1 = await dispatcher.scheduleReadyTasks(runId);
          expect(sched1.ok).toBe(true);
          expect(sched1.value).toEqual(["root"]);

          const snap1 = (await harness.engine.getSnapshot(runId)).value!;
          await dispatcher.dispatchTask(diamondDef, snap1, "root", "Execute root");
          await orchestrator.completeTaskExecution(runId, "root", { status: "succeeded" });

          // 2. Both branch-left and branch-right have dependencies satisfied!
          // BUT maxConcurrency: 1 means engine.advance must only release 1 task!
          const sched2 = await dispatcher.scheduleReadyTasks(runId);
          expect(sched2.ok).toBe(true);
          expect(sched2.value.length).toBe(1); // Exactly 1 runnable task released!
          const firstBranch = sched2.value[0];
          expect(["branch-left", "branch-right"]).toContain(firstBranch);

          // Dispatch first branch
          const snap2 = (await harness.engine.getSnapshot(runId)).value!;
          await dispatcher.dispatchTask(diamondDef, snap2, firstBranch, "Execute branch");

          // While first branch is running, scheduleReadyTasks must yield 0 new tasks
          const sched3 = await dispatcher.scheduleReadyTasks(runId);
          expect(sched3.ok).toBe(true);
          expect(sched3.value).toEqual([]);

          // Complete first branch
          await orchestrator.completeTaskExecution(runId, firstBranch, { status: "succeeded" });

          // Now second branch becomes runnable
          const sched4 = await dispatcher.scheduleReadyTasks(runId);
          expect(sched4.ok).toBe(true);
          expect(sched4.value.length).toBe(1);
          const secondBranch = sched4.value[0];
          expect(secondBranch).not.toBe(firstBranch);

          // Dispatch and complete second branch
          const snap4 = (await harness.engine.getSnapshot(runId)).value!;
          await dispatcher.dispatchTask(diamondDef, snap4, secondBranch, "Execute second branch");
          await orchestrator.completeTaskExecution(runId, secondBranch, { status: "succeeded" });

          // Now join task becomes runnable
          const sched5 = await dispatcher.scheduleReadyTasks(runId);
          expect(sched5.ok).toBe(true);
          expect(sched5.value).toEqual(["join"]);
        } finally {
          await harness.cleanup();
        }
      },
      15000
    );
  });

  // =========================================================================
  // SUITE 3: Event Stream Backpressure & Abortion Stress
  // =========================================================================
  describe("Suite 3: Event Stream Backpressure & Abortion Stress", () => {
    it(
      "3.1: Rapid event burst exceeding maxBufferSize triggers typed buffer overflow error without hanging or memory leak",
      async () => {
        const harness = await createTestHarness();
        try {
          const runId = `run-stress-stream-burst-${randomUUID()}`;
          const hub = new DefaultRunEventHub();

          // Create event stream with a small buffer of 5
          const stream = createDomainEventStream(
            { runStore: harness.runStore },
            hub,
            runId,
            { maxBufferSize: 5 }
          );

          // Burst 30 events into hub while stream consumer is reading slowly
          const receivedResults: Array<OperationResult<DomainEvent>> = [];
          const consumerPromise = (async () => {
            for await (const item of stream) {
              receivedResults.push(item);
              if (!item.ok) break;
              // Simulate slow consumer (50ms per event) to cause backpressure buildup
              await new Promise((r) => setTimeout(r, 50));
            }
          })();

          // Wait a tick for stream consumer to initialize and subscribe to hub
          await new Promise((r) => setTimeout(r, 30));

          // Now publish 30 events in a rapid burst
          const burstEvents: DomainEvent[] = Array.from({ length: 30 }, (_, i) => ({
            id: `evt-${i}`,
            sequence: i + 1,
            type: "task.status_changed" as const,
            aggregateId: runId,
            occurredAt: new Date().toISOString(),
            payload: {
              runId,
              taskId: "plan",
              from: "ready",
              to: "running",
              generation: 0,
              attempt: 1
            }
          }));

          hub.publish(runId, burstEvents);

          // Consumer must terminate with typed error rather than hanging
          await consumerPromise;

          expect(receivedResults.length).toBeGreaterThan(0);
          const terminalItem = receivedResults[receivedResults.length - 1];
          expect(terminalItem.ok).toBe(false);
          expect(terminalItem.error.code).toBe("validation");
          expect(terminalItem.error.message).toContain("Event buffer overflow");
        } finally {
          await harness.cleanup();
        }
      },
      15000
    );

    it(
      "3.2: Immediate abortion before stream start returns cancelled error promptly",
      async () => {
        const harness = await createTestHarness();
        try {
          const runId = `run-stress-stream-abort-pre-${randomUUID()}`;
          const hub = new DefaultRunEventHub();

          const controller = new AbortController();
          controller.abort("User cancelled watch");

          const stream = createDomainEventStream(
            { runStore: harness.runStore },
            hub,
            runId,
            { signal: controller.signal }
          );

          const items: Array<OperationResult<DomainEvent>> = [];
          for await (const item of stream) {
            items.push(item);
          }

          expect(items.length).toBe(1);
          expect(items[0].ok).toBe(false);
          expect(items[0].error.code).toBe("cancelled");
          expect(items[0].error.message).toContain("Watch cancelled before stream start");
        } finally {
          await harness.cleanup();
        }
      },
      10000
    );

    it(
      "3.3: Mid-stream abortion while waiting for events unblocks consumer and closes cleanly",
      async () => {
        const harness = await createTestHarness();
        try {
          const runId = `run-stress-stream-abort-mid-${randomUUID()}`;
          const hub = new DefaultRunEventHub();

          const controller = new AbortController();

          const stream = createDomainEventStream(
            { runStore: harness.runStore },
            hub,
            runId,
            { signal: controller.signal }
          );

          // Start consumer in background
          let streamCompleted = false;
          const receivedEvents: DomainEvent[] = [];

          const consumePromise = (async () => {
            for await (const item of stream) {
              if (item.ok) {
                receivedEvents.push(item.value);
              }
            }
            streamCompleted = true;
          })();

          // Wait a tick for consumer to enter waiting state on queue.pop()
          await new Promise((r) => setTimeout(r, 50));

          // Publish 1 event
          const event1: DomainEvent = {
            id: "evt-mid-1",
            sequence: 1,
            type: "task.status_changed",
            aggregateId: runId,
            occurredAt: new Date().toISOString(),
            payload: {
              runId,
              taskId: "plan",
              from: "ready",
              to: "running",
              generation: 0,
              attempt: 1
            }
          };
          hub.publish(runId, [event1]);

          // Wait another tick
          await new Promise((r) => setTimeout(r, 50));
          expect(receivedEvents.length).toBe(1);

          // Now abort mid-stream while consumer is waiting for event 2
          controller.abort();

          // Await consumption completion: must resolve without hanging
          await consumePromise;
          expect(streamCompleted).toBe(true);
        } finally {
          await harness.cleanup();
        }
      },
      10000
    );

    it(
      "3.4: Concurrent subscribers: one subscriber aborting does not disrupt or leak for the other subscriber",
      async () => {
        const harness = await createTestHarness();
        try {
          const runId = `run-stress-stream-multi-${randomUUID()}`;
          const hub = new DefaultRunEventHub();

          const controller1 = new AbortController();
          const controller2 = new AbortController();

          const stream1 = createDomainEventStream({ runStore: harness.runStore }, hub, runId, {
            signal: controller1.signal
          });
          const stream2 = createDomainEventStream({ runStore: harness.runStore }, hub, runId, {
            signal: controller2.signal
          });

          const events1: DomainEvent[] = [];
          const events2: DomainEvent[] = [];

          let done1 = false;
          let done2 = false;

          const p1 = (async () => {
            for await (const item of stream1) {
              if (item.ok) events1.push(item.value);
            }
            done1 = true;
          })();

          const p2 = (async () => {
            for await (const item of stream2) {
              if (item.ok) events2.push(item.value);
            }
            done2 = true;
          })();

          // Publish event 1 to both
          const makeEvt = (seq: number): DomainEvent => ({
            id: `evt-multi-${seq}`,
            sequence: seq,
            type: "task.status_changed",
            aggregateId: runId,
            occurredAt: new Date().toISOString(),
            payload: { runId, taskId: "plan", from: "ready", to: "running", generation: 0, attempt: 1 }
          });

          await new Promise((r) => setTimeout(r, 30));
          hub.publish(runId, [makeEvt(1)]);
          await new Promise((r) => setTimeout(r, 30));

          expect(events1.length).toBe(1);
          expect(events2.length).toBe(1);

          // Abort subscriber 1 only
          controller1.abort();
          await p1;
          expect(done1).toBe(true);
          expect(done2).toBe(false); // Subscriber 2 still active!

          // Publish event 2: subscriber 2 must still receive it
          hub.publish(runId, [makeEvt(2)]);
          await new Promise((r) => setTimeout(r, 30));
          expect(events2.length).toBe(2);

          // Publish terminal event to finish subscriber 2
          const terminalEvt: DomainEvent = {
            id: "evt-terminal",
            sequence: 3,
            type: "run.status_changed",
            aggregateId: runId,
            occurredAt: new Date().toISOString(),
            payload: { runId, from: "running", to: "succeeded" }
          };
          hub.publish(runId, [terminalEvt]);
          await p2;
          expect(done2).toBe(true);
        } finally {
          await harness.cleanup();
        }
      },
      10000
    );
  });
});
