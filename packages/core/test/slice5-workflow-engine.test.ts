import { describe, expect, it } from "vitest";
import type {
  AgentExecutionHandle,
  AgentResult,
  DomainEvent,
  OperationResult,
  TaskDefinition,
  WorkflowAdvanceResult,
  WorkflowDefinition
} from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "../src/index.js";

function ok<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const baseTask = (id: string, overrides: Partial<TaskDefinition> = {}): TaskDefinition => ({
  id,
  title: `Task ${id}`,
  role: "developer",
  instruction: `Execute ${id}`,
  acceptanceCriteria: ["ac-1"],
  retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
  timeout: { executionTimeoutMs: 60_000, heartbeatTimeoutMs: 10_000, onTimeout: "block" },
  requiresApproval: false,
  qualityGates: [],
  ...overrides
});

const makeWorkflow = (overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  schemaVersion: "1",
  id: "wf-slice5",
  name: "Slice 5 Workflow",
  version: "1.0.0",
  tasks: [baseTask("a"), baseTask("b")],
  dependencies: [{ taskId: "b", dependsOnTaskId: "a", condition: "succeeded" }],
  qualityGates: [],
  maxConcurrency: 2,
  failurePolicy: "block",
  recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" },
  ...overrides
});

function makeHandle(
  runId: string,
  state: WorkflowAdvanceResult,
  taskId: string,
  executionId: string,
  acceptedAt: string
): AgentExecutionHandle {
  const attemptId = state.snapshot.tasks.find((t) => t.taskId === taskId)?.attemptId;
  if (!attemptId) throw new Error(`Missing attemptId for task ${taskId}`);
  return {
    executionId,
    requestId: `req-${executionId}`,
    attemptId,
    runId,
    taskId,
    idempotencyKey: `send-${executionId}`,
    target: { transport: "herdr", agentId: "dev-1", paneId: "pane-1" },
    correlation: { token: `tok-${executionId}`, provenance: "remote", verified: true },
    acceptedAt
  };
}

function makeAgentResult(
  h: AgentExecutionHandle,
  status: AgentResult["status"],
  startedAt: string,
  completedAt: string
): AgentResult {
  return {
    requestId: h.requestId,
    attemptId: h.attemptId,
    runId: h.runId,
    taskId: h.taskId,
    executionId: h.executionId,
    status,
    verification: { status: "verified", evidence: "verified output", correlation: h.correlation },
    artifactProposals: [],
    retryable: false,
    startedAt,
    completedAt,
    ...(status === "failed" ? { error: { code: "agent_execution", message: "boom", retryable: false } } : {}),
    ...(status === "blocked"
      ? {
          blockage: {
            code: "manual_intervention",
            message: "Needs operator input",
            since: completedAt,
            retryable: true
          }
        }
      : {})
  } as AgentResult;
}

describe("Slice 5 core workflow engine regressions", () => {
  it("settles run-wide cancellation immediately to cancelled when tasks are queued/pending/ready without wedging in cancelling", async () => {
    const def = makeWorkflow();
    const engine = new DeterministicWorkflowEngine({ definitions: [def] });

    // Case 1: queued run with only pending tasks
    const created1 = ok(
      await engine.createRun({
        runId: "run-queued-cancel",
        definition: def,
        createdAt: "2026-10-31T00:00:00.000Z",
        idempotencyKey: "k-create-1"
      })
    );

    const cancelQueued = ok(
      await engine.requestCancellation({
        schemaVersion: 1,
        cancellationId: "cancel-queued-1",
        runId: "run-queued-cancel",
        requestedBy: "user",
        requestedAt: "2026-10-31T00:00:01.000Z",
        expectedVersion: created1.snapshot.version,
        reason: "User aborted before start",
        idempotencyKey: "k-cancel-1"
      })
    );
    expect(cancelQueued.snapshot.status).toBe("cancelled");
    expect(cancelQueued.snapshot.tasks.every((t) => t.status === "cancelled")).toBe(true);

    const cp1 = ok(
      await engine.createCheckpoint({
        runId: "run-queued-cancel",
        expectedVersion: cancelQueued.snapshot.version,
        checkpointId: "cp-1",
        createdAt: "2026-10-31T00:00:02.000Z"
      })
    );
    const recovered1 = new DeterministicWorkflowEngine({ definitions: [def] });
    expect(
      (
        await recovered1.recover({
          runId: "run-queued-cancel",
          checkpoint: cp1,
          events: [],
          expectedVersion: cancelQueued.snapshot.version
        })
      ).ok
    ).toBe(true);

    // Case 2: run with an unbound ready task (before_dispatch gate) and a pending downstream task
    const preGateDef = makeWorkflow({
      tasks: [
        baseTask("a", { qualityGates: [{ gateId: "pre", phase: "before_dispatch", required: true }] }),
        baseTask("b")
      ],
      qualityGates: [
        {
          id: "pre",
          name: "Pre-dispatch",
          evaluator: "host",
          required: true,
          timeout: { executionTimeoutMs: 5_000, onTimeout: "fail" }
        }
      ]
    });
    const engine2 = new DeterministicWorkflowEngine({ definitions: [preGateDef] });
    const created2 = ok(
      await engine2.createRun({
        runId: "run-ready-cancel",
        definition: preGateDef,
        createdAt: "2026-10-31T00:00:00.000Z",
        idempotencyKey: "k-create-2"
      })
    );
    const adv2 = ok(
      await engine2.advance({
        runId: "run-ready-cancel",
        expectedVersion: created2.snapshot.version,
        occurredAt: "2026-10-31T00:00:01.000Z",
        idempotencyKey: "k-adv-2"
      })
    );
    expect(adv2.snapshot.tasks.find((t) => t.taskId === "a")?.status).toBe("ready");

    const cancelReady = ok(
      await engine2.requestCancellation({
        schemaVersion: 1,
        cancellationId: "cancel-ready-2",
        runId: "run-ready-cancel",
        requestedBy: "user",
        requestedAt: "2026-10-31T00:00:02.000Z",
        expectedVersion: adv2.snapshot.version,
        reason: "User aborted while ready",
        idempotencyKey: "k-cancel-2"
      })
    );
    expect(cancelReady.snapshot.tasks.find((t) => t.taskId === "a")?.status).toBe("cancelled");
    expect(cancelReady.snapshot.tasks.find((t) => t.taskId === "b")?.status).toBe("cancelled");
    expect(cancelReady.snapshot.status).toBe("cancelled");
  });

  it("settles partial-progress cancelled runs [succeeded, cancelled] to cancelled (not failed) and never marks unapproved cancelling runs succeeded", async () => {
    const def = makeWorkflow();
    const engine = new DeterministicWorkflowEngine({ definitions: [def] });

    // Part A: task a succeeded, task b running -> cancelled => run must be cancelled, not failed
    let s = ok(
      await engine.createRun({
        runId: "run-partial-cancel",
        definition: def,
        createdAt: "2026-10-31T00:00:00.000Z",
        idempotencyKey: "k1"
      })
    );
    s = ok(
      await engine.advance({
        runId: "run-partial-cancel",
        expectedVersion: s.snapshot.version,
        occurredAt: "2026-10-31T00:00:01.000Z",
        idempotencyKey: "k2"
      })
    );
    const hA = makeHandle("run-partial-cancel", s, "a", "ex-a1", "2026-10-31T00:00:02.000Z");
    s = ok(
      await engine.bindAgentExecution({
        runId: "run-partial-cancel",
        taskId: "a",
        attempt: 1,
        handle: hA,
        expectedVersion: s.snapshot.version,
        occurredAt: "2026-10-31T00:00:02.000Z",
        idempotencyKey: "k3"
      })
    );
    s = ok(
      await engine.recordAgentResult({
        runId: "run-partial-cancel",
        taskId: "a",
        expectedVersion: s.snapshot.version,
        result: makeAgentResult(hA, "succeeded", "2026-10-31T00:00:02.000Z", "2026-10-31T00:00:03.000Z"),
        occurredAt: "2026-10-31T00:00:03.000Z",
        idempotencyKey: "k4"
      })
    );
    s = ok(
      await engine.advance({
        runId: "run-partial-cancel",
        expectedVersion: s.snapshot.version,
        occurredAt: "2026-10-31T00:00:04.000Z",
        idempotencyKey: "k5"
      })
    );
    const hB = makeHandle("run-partial-cancel", s, "b", "ex-b1", "2026-10-31T00:00:05.000Z");
    s = ok(
      await engine.bindAgentExecution({
        runId: "run-partial-cancel",
        taskId: "b",
        attempt: 1,
        handle: hB,
        expectedVersion: s.snapshot.version,
        occurredAt: "2026-10-31T00:00:05.000Z",
        idempotencyKey: "k6"
      })
    );
    s = ok(
      await engine.requestCancellation({
        schemaVersion: 1,
        cancellationId: "cancel-partial",
        runId: "run-partial-cancel",
        requestedBy: "user",
        requestedAt: "2026-10-31T00:00:06.000Z",
        expectedVersion: s.snapshot.version,
        reason: "Cancel remaining work",
        idempotencyKey: "k7"
      })
    );
    s = ok(
      await engine.confirmCancellationStop({
        runId: "run-partial-cancel",
        expectedVersion: s.snapshot.version,
        confirmation: {
          schemaVersion: 1,
          cancellationId: "cancel-partial",
          executionId: hB.executionId,
          stoppedAt: "2026-10-31T00:00:07.000Z",
          terminalStatus: "cancelled"
        },
        idempotencyKey: "k8"
      })
    );
    expect(s.snapshot.status).toBe("cancelled");

    // Part B: task requiring human approval completes late while cancelling => must settle to cancelled, not unapproved succeeded (which fails recover())
    const approvalDef = makeWorkflow({
      id: "wf-slice5-approval",
      tasks: [baseTask("a", { requiresApproval: true })],
      dependencies: []
    });
    const engineB = new DeterministicWorkflowEngine({ definitions: [approvalDef] });
    const events: DomainEvent[] = [];
    let sb = ok(
      await engineB.createRun({
        runId: "run-unapproved-cancel",
        definition: approvalDef,
        createdAt: "2026-10-31T00:00:00.000Z",
        idempotencyKey: "ak1"
      })
    );
    events.push(...sb.emittedEvents);
    sb = ok(
      await engineB.advance({
        runId: "run-unapproved-cancel",
        expectedVersion: sb.snapshot.version,
        occurredAt: "2026-10-31T00:00:01.000Z",
        idempotencyKey: "ak2"
      })
    );
    events.push(...sb.emittedEvents);
    const hApproval = makeHandle("run-unapproved-cancel", sb, "a", "ex-1", "2026-10-31T00:00:02.000Z");
    sb = ok(
      await engineB.bindAgentExecution({
        runId: "run-unapproved-cancel",
        taskId: "a",
        attempt: 1,
        handle: hApproval,
        expectedVersion: sb.snapshot.version,
        occurredAt: "2026-10-31T00:00:02.000Z",
        idempotencyKey: "ak3"
      })
    );
    events.push(...sb.emittedEvents);
    sb = ok(
      await engineB.requestCancellation({
        schemaVersion: 1,
        cancellationId: "cancel-unapproved",
        runId: "run-unapproved-cancel",
        requestedBy: "user",
        requestedAt: "2026-10-31T00:00:03.000Z",
        expectedVersion: sb.snapshot.version,
        reason: "Abort before human approval",
        idempotencyKey: "ak4"
      })
    );
    events.push(...sb.emittedEvents);
    sb = ok(
      await engineB.recordAgentResult({
        runId: "run-unapproved-cancel",
        taskId: "a",
        expectedVersion: sb.snapshot.version,
        result: makeAgentResult(hApproval, "succeeded", "2026-10-31T00:00:02.000Z", "2026-10-31T00:00:04.000Z"),
        occurredAt: "2026-10-31T00:00:04.000Z",
        idempotencyKey: "ak5"
      })
    );
    events.push(...sb.emittedEvents);
    expect(sb.snapshot.status).toBe("cancelled");

    // Replay from genesis must succeed cleanly without corruption
    const replayEngine = new DeterministicWorkflowEngine({ definitions: [approvalDef] });
    const replayed = await replayEngine.recover({
      runId: "run-unapproved-cancel",
      events,
      expectedVersion: sb.snapshot.version
    });
    expect(replayed.ok).toBe(true);
  });

  it("surfaces blocked and waiting run statuses in multi-task DAGs with downstream pending tasks, bridges blocked->waiting, clears blockage, and preserves startedAt on resume", async () => {
    const def = makeWorkflow({
      id: "wf-slice5-multi",
      tasks: [baseTask("a", { requiresApproval: true }), baseTask("b")]
    });
    const engine = new DeterministicWorkflowEngine({ definitions: [def] });
    const allEvents: DomainEvent[] = [];

    let s = ok(
      await engine.createRun({
        runId: "run-multi-block",
        definition: def,
        createdAt: "2026-10-31T00:00:00.000Z",
        idempotencyKey: "mk1"
      })
    );
    allEvents.push(...s.emittedEvents);

    // Advance transitions task a ready -> running at 00:00:01.000Z, while task b stays pending
    s = ok(
      await engine.advance({
        runId: "run-multi-block",
        expectedVersion: s.snapshot.version,
        occurredAt: "2026-10-31T00:00:01.000Z",
        idempotencyKey: "mk2"
      })
    );
    allEvents.push(...s.emittedEvents);

    // 1. Unknown delivery reconciliation before binding blocks task a and MUST move run to blocked (even with pending task b!)
    s = ok(
      await engine.recordDeliveryReconciliation({
        runId: "run-multi-block",
        taskId: "a",
        requestId: "req-ex-a1",
        expectedVersion: s.snapshot.version,
        result: {
          status: "unknown_delivery",
          requestId: "req-ex-a1",
          reason: "Transport timed out",
          retrySafe: false,
          manualInterventionRequired: true,
          observedAt: "2026-10-31T00:00:02.000Z"
        },
        occurredAt: "2026-10-31T00:00:02.000Z",
        idempotencyKey: "mk3"
      })
    );
    allEvents.push(...s.emittedEvents);
    expect(s.snapshot.status).toBe("blocked");
    expect(s.snapshot.tasks.find((t) => t.taskId === "a")?.blockage).toBeDefined();

    // Reconcile delivery as bound while task a is blocked
    const hA = makeHandle("run-multi-block", s, "a", "ex-a1", "2026-10-31T00:00:03.000Z");
    s = ok(
      await engine.recordDeliveryReconciliation({
        runId: "run-multi-block",
        taskId: "a",
        requestId: hA.requestId,
        expectedVersion: s.snapshot.version,
        result: { status: "bound", handle: hA },
        occurredAt: "2026-10-31T00:00:03.000Z",
        idempotencyKey: "mk4"
      })
    );
    allEvents.push(...s.emittedEvents);

    // 2. When blocked task a receives a verified succeeded result with requiresApproval:true while task b is pending:
    //    - task a transitions blocked -> running -> succeeded (clearing task.blockage and preserving original startedAt 00:00:01.000Z!)
    //    - run transitions blocked -> running -> waiting (bridging blocked -> waiting cleanly!)
    s = ok(
      await engine.recordAgentResult({
        runId: "run-multi-block",
        taskId: "a",
        expectedVersion: s.snapshot.version,
        result: makeAgentResult(hA, "succeeded", "2026-10-31T00:00:01.000Z", "2026-10-31T00:00:04.000Z"),
        occurredAt: "2026-10-31T00:00:04.000Z",
        idempotencyKey: "mk5"
      })
    );
    allEvents.push(...s.emittedEvents);

    const taskAfterComplete = s.snapshot.tasks.find((t) => t.taskId === "a")!;
    expect(taskAfterComplete.status).toBe("succeeded");
    expect(taskAfterComplete.blockage).toBeUndefined();
    expect(taskAfterComplete.startedAt).toBe("2026-10-31T00:00:01.000Z");
    expect(s.snapshot.status).toBe("waiting");

    // Verify replay matches snapshot identically
    const replayed = await new DeterministicWorkflowEngine({ definitions: [def] }).recover({
      runId: "run-multi-block",
      events: allEvents,
      expectedVersion: s.snapshot.version
    });
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.snapshot).toEqual(s.snapshot);
    }
  });

  it("cascades transitive dependency cancellation across reverse-ordered tasks [c, b, a] in a single advance()", async () => {
    const def = makeWorkflow({
      id: "wf-slice5-cascade",
      tasks: [baseTask("c"), baseTask("b"), baseTask("a")],
      dependencies: [
        { taskId: "b", dependsOnTaskId: "a", condition: "succeeded" },
        { taskId: "c", dependsOnTaskId: "b", condition: "succeeded" }
      ],
      failurePolicy: "continue-independent"
    });
    const engine = new DeterministicWorkflowEngine({ definitions: [def] });

    let s = ok(
      await engine.createRun({
        runId: "run-cascade",
        definition: def,
        createdAt: "2026-10-31T00:00:00.000Z",
        idempotencyKey: "rk1"
      })
    );
    s = ok(
      await engine.advance({
        runId: "run-cascade",
        expectedVersion: s.snapshot.version,
        occurredAt: "2026-10-31T00:00:01.000Z",
        idempotencyKey: "rk2"
      })
    );
    const hA = makeHandle("run-cascade", s, "a", "ex-a1", "2026-10-31T00:00:02.000Z");
    s = ok(
      await engine.bindAgentExecution({
        runId: "run-cascade",
        taskId: "a",
        attempt: 1,
        handle: hA,
        expectedVersion: s.snapshot.version,
        occurredAt: "2026-10-31T00:00:02.000Z",
        idempotencyKey: "rk3"
      })
    );
    s = ok(
      await engine.recordAgentResult({
        runId: "run-cascade",
        taskId: "a",
        expectedVersion: s.snapshot.version,
        result: makeAgentResult(hA, "failed", "2026-10-31T00:00:02.000Z", "2026-10-31T00:00:03.000Z"),
        occurredAt: "2026-10-31T00:00:03.000Z",
        idempotencyKey: "rk4"
      })
    );
    s = ok(
      await engine.advance({
        runId: "run-cascade",
        expectedVersion: s.snapshot.version,
        occurredAt: "2026-10-31T00:00:04.000Z",
        idempotencyKey: "rk5"
      })
    );
    expect(s.snapshot.tasks.find((t) => t.taskId === "b")?.status).toBe("cancelled");
    expect(s.snapshot.tasks.find((t) => t.taskId === "c")?.status).toBe("cancelled");
    expect(s.snapshot.status).toBe("failed");
  });
});
