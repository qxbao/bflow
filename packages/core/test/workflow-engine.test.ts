import { describe, expect, it } from "vitest";
import type {
  AgentExecutionHandle,
  AgentResult,
  DomainEvent,
  OperationResult,
  TaskDependency,
  WorkflowAdvanceResult,
  WorkflowDefinition
} from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "../src/index.js";

const time = "2026-10-13T00:00:00.000Z";
const later = "2026-10-13T00:01:00.000Z";

it("continues an exact stopped execution with a new handle while retaining task attempt and generation", async () => {
  const engine = new DeterministicWorkflowEngine();
  const started = await advance(engine, await create(engine, definition(["implement"])), "start-continuation");
  const first = handleFor(started, "implement");
  const bound = unwrap(await engine.bindAgentExecution({ runId: "run-1", taskId: "implement", expectedVersion: started.snapshot.version,
    attempt: 1, handle: first, occurredAt: later, idempotencyKey: "bind-old" }));
  const next = { ...first, executionId: "next-execution", requestId: "next-request", idempotencyKey: "next-send", acceptedAt: later,
    target: { ...first.target, agentId: "fallback-agent", paneId: "fallback-pane" } };
  const command = { runId: "run-1", taskId: "implement", expectedVersion: bound.snapshot.version, attempt: 1, handle: next,
    occurredAt: later, idempotencyKey: "continue-1", continuation: { previousExecutionId: first.executionId,
      switchId: "switch-1", policyDigest: "a".repeat(64), stoppedAt: later, ordinal: 1 } };
  const continued = unwrap(await engine.bindAgentExecution(command));
  expect(continued.snapshot.tasks[0]).toMatchObject({ status: "running", attempt: 1, generation: 0, agentExecution: next });
  expect(continued.emittedEvents[0]).toMatchObject({ type: "agent.execution_bound", payload: { continuation: command.continuation } });
  expect((await engine.bindAgentExecution(command)).ok).toBe(true);
  const checkpoint = unwrap(await engine.createCheckpoint({ runId: "run-1", expectedVersion: continued.snapshot.version,
    checkpointId: "continued-checkpoint", createdAt: later }));
  const restored = new DeterministicWorkflowEngine();
  await create(restored, definition(["implement"]));
  const recovered = unwrap(await restored.recover({ runId: "run-1", checkpoint, events: [], expectedVersion: continued.snapshot.version }));
  expect(recovered.snapshot.tasks[0]!.agentExecution).toEqual(next);
  expect((await restored.bindAgentExecution({ ...command, expectedVersion: recovered.snapshot.version, idempotencyKey: "foreign-continuation",
    handle: { ...next, executionId: "third", requestId: "third" } })).ok).toBe(false);
});

function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function definition(
  taskIds: readonly string[],
  dependencies: readonly TaskDependency[] = [],
  options: { readonly maxConcurrency?: number; readonly approvalTask?: string; readonly gatedTask?: string;
    readonly maxAttempts?: number } = {}
): WorkflowDefinition {
  const gate = {
    id: "tests",
    name: "Tests",
    evaluator: "vitest",
    required: true,
    timeout: { executionTimeoutMs: 1_000, onTimeout: "fail" as const }
  };
  return {
    schemaVersion: "1",
    id: "delivery",
    name: "Delivery",
    version: "1.0.0",
    tasks: taskIds.map((id) => ({
      id,
      title: id,
      role: "implementer",
      instruction: `Implement ${id}`,
      acceptanceCriteria: ["done"],
      retry: {
        maxAttempts: options.maxAttempts ?? 3,
        strategy: "fixed",
        initialDelayMs: 0,
        maxDelayMs: 0,
        jitter: false
      },
      timeout: { executionTimeoutMs: 10_000, onTimeout: "retry" },
      ...(options.approvalTask === id ? { rework: { maxReworks: 1, onExhausted: "fail" as const } } : {}),
      requiresApproval: options.approvalTask === id,
      qualityGates: options.gatedTask === id
        ? [{ gateId: "tests", phase: "after_result", required: true }]
        : []
    })),
    dependencies: [...dependencies],
    qualityGates: options.gatedTask === undefined ? [] : [gate],
    maxConcurrency: options.maxConcurrency ?? 2,
    failurePolicy: "continue-independent",
    recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
  };
}

async function create(engine: DeterministicWorkflowEngine, workflow: WorkflowDefinition, runId = "run-1") {
  return unwrap(await engine.createRun({
    runId,
    definition: workflow,
    idempotencyKey: `${runId}/create`,
    createdAt: time
  }));
}

async function advance(engine: DeterministicWorkflowEngine, previous: WorkflowAdvanceResult, key: string) {
  return unwrap(await engine.advance({
    runId: previous.snapshot.runId,
    expectedVersion: previous.snapshot.version,
    idempotencyKey: key,
    occurredAt: later
  }));
}

function handleFor(result: WorkflowAdvanceResult, taskId: string, suffix = "1"): AgentExecutionHandle {
  const task = result.snapshot.tasks.find((candidate) => candidate.taskId === taskId);
  if (task?.attemptId === undefined) throw new Error(`Task ${taskId} has no attempt`);
  return {
    executionId: `execution-${taskId}-${suffix}`,
    requestId: `request-${taskId}-${suffix}`,
    attemptId: task.attemptId,
    runId: result.snapshot.runId,
    taskId,
    idempotencyKey: `agent/${taskId}/${suffix}`,
    target: { transport: "test", agentId: "agent-1", paneId: "pane-1" },
    correlation: { token: `remote-${taskId}-${suffix}`, provenance: "remote", verified: true },
    acceptedAt: time
  };
}

async function bind(engine: DeterministicWorkflowEngine, previous: WorkflowAdvanceResult, taskId: string, suffix = "1") {
  const handle = handleFor(previous, taskId, suffix);
  const task = previous.snapshot.tasks.find((candidate) => candidate.taskId === taskId);
  if (task === undefined) throw new Error("Missing task");
  const result = unwrap(await engine.bindAgentExecution({
    runId: previous.snapshot.runId,
    taskId,
    expectedVersion: previous.snapshot.version,
    attempt: task.attempt,
    handle,
    idempotencyKey: `bind/${taskId}/${suffix}`,
    occurredAt: time
  }));
  return { result, handle };
}

function agentResult(handle: AgentExecutionHandle, status: AgentResult["status"]): AgentResult {
  const common = {
    requestId: handle.requestId,
    attemptId: handle.attemptId,
    runId: handle.runId,
    taskId: handle.taskId,
    executionId: handle.executionId,
    status,
    verification: { status: "verified" as const, evidence: "signed-result", correlation: handle.correlation },
    artifactProposals: [],
    retryable: status === "failed" || status === "timed_out" || status === "blocked",
    startedAt: time,
    completedAt: later,
    ...((status === "failed" || status === "timed_out")
      ? { error: { code: "agent_error", message: "failed", retryable: true } }
      : {}),
    ...(status === "blocked"
      ? { blockage: { code: "external_dependency" as const, message: "waiting", since: time, retryable: true } }
      : {})
  };
  return common as AgentResult;
}

async function recordResult(
  engine: DeterministicWorkflowEngine,
  previous: WorkflowAdvanceResult,
  handle: AgentExecutionHandle,
  status: AgentResult["status"],
  key: string
) {
  return unwrap(await engine.recordAgentResult({
    runId: previous.snapshot.runId,
    taskId: handle.taskId,
    expectedVersion: previous.snapshot.version,
    result: agentResult(handle, status),
    idempotencyKey: key,
    occurredAt: later
  }));
}

async function finishTask(
  engine: DeterministicWorkflowEngine,
  previous: WorkflowAdvanceResult,
  taskId: string,
  key: string
) {
  const bound = await bind(engine, previous, taskId, key);
  return recordResult(engine, bound.result, bound.handle, "succeeded", `${key}/result`);
}

describe("DeterministicWorkflowEngine", () => {
  it("runs and completes one task only from a verified, bound agent result", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await create(engine, definition(["A"]));
    state = await advance(engine, state, "advance-1");
    expect(state.runnableTaskIds).toEqual(["A"]);
    expect(state.snapshot.tasks[0]?.status).toBe("running");
    const bound = await bind(engine, state, "A");
    state = await recordResult(engine, bound.result, bound.handle, "succeeded", "result-A");
    expect(state.snapshot.tasks[0]?.status).toBe("succeeded");
    expect(state.snapshot.status).toBe("succeeded");
  });

  it("schedules a linear A -> B -> C DAG in order", async () => {
    const engine = new DeterministicWorkflowEngine();
    const workflow = definition(["A", "B", "C"], [
      { taskId: "B", dependsOnTaskId: "A", condition: "succeeded" },
      { taskId: "C", dependsOnTaskId: "B", condition: "succeeded" }
    ]);
    let state = await advance(engine, await create(engine, workflow), "advance-A");
    expect(state.runnableTaskIds).toEqual(["A"]);
    state = await finishTask(engine, state, "A", "finish-A");
    state = await advance(engine, state, "advance-B");
    expect(state.runnableTaskIds).toEqual(["B"]);
    state = await finishTask(engine, state, "B", "finish-B");
    state = await advance(engine, state, "advance-C");
    expect(state.runnableTaskIds).toEqual(["C"]);
  });

  it("supports fan-out and fan-in", async () => {
    const engine = new DeterministicWorkflowEngine();
    const workflow = definition(["A", "B", "C", "D"], [
      { taskId: "B", dependsOnTaskId: "A", condition: "succeeded" },
      { taskId: "C", dependsOnTaskId: "A", condition: "succeeded" },
      { taskId: "D", dependsOnTaskId: "B", condition: "succeeded" },
      { taskId: "D", dependsOnTaskId: "C", condition: "succeeded" }
    ], { maxConcurrency: 3 });
    let state = await advance(engine, await create(engine, workflow), "fan-A");
    state = await finishTask(engine, state, "A", "fan-finish-A");
    state = await advance(engine, state, "fan-BC");
    expect(state.runnableTaskIds).toEqual(["B", "C"]);
    state = await finishTask(engine, state, "B", "fan-finish-B");
    state = await finishTask(engine, state, "C", "fan-finish-C");
    state = await advance(engine, state, "fan-D");
    expect(state.runnableTaskIds).toEqual(["D"]);
  });

  it("rejects duplicate IDs, missing dependencies, self-dependencies and cycles", async () => {
    const engine = new DeterministicWorkflowEngine();
    const duplicate = definition(["A", "A"]);
    const missing = definition(["A"], [{ taskId: "A", dependsOnTaskId: "missing", condition: "succeeded" }]);
    const self = definition(["A"], [{ taskId: "A", dependsOnTaskId: "A", condition: "succeeded" }]);
    const cycle = definition(["A", "B"], [
      { taskId: "A", dependsOnTaskId: "B", condition: "succeeded" },
      { taskId: "B", dependsOnTaskId: "A", condition: "succeeded" }
    ]);
    for (const candidate of [duplicate, missing, self, cycle]) {
      expect(await engine.validateDefinition(candidate)).toMatchObject({ ok: false, error: { code: "validation" } });
    }
  });

  it("enforces workflow concurrency caps of one and greater than one", async () => {
    const single = new DeterministicWorkflowEngine();
    const one = await advance(single, await create(single, definition(["A", "B", "C"], [], { maxConcurrency: 1 })), "one");
    expect(one.runnableTaskIds).toHaveLength(1);
    expect(one.snapshot.tasks.filter((task) => task.status === "running")).toHaveLength(1);

    const parallel = new DeterministicWorkflowEngine();
    const two = await advance(parallel, await create(parallel, definition(["A", "B", "C"], [], { maxConcurrency: 2 }), "run-2"), "two");
    expect(two.runnableTaskIds).toEqual(["A", "B"]);
    expect(two.snapshot.tasks.filter((task) => task.status === "running")).toHaveLength(2);
  });

  it("does not issue the same attempt twice on duplicate or subsequent advance", async () => {
    const engine = new DeterministicWorkflowEngine();
    const created = await create(engine, definition(["A"]));
    const command = { runId: "run-1", expectedVersion: created.snapshot.version, idempotencyKey: "advance-once", occurredAt: later };
    const first = unwrap(await engine.advance(command));
    const replay = unwrap(await engine.advance(command));
    expect(replay).toEqual(first);
    const next = await advance(engine, first, "advance-again");
    expect(next.runnableTaskIds).toEqual([]);
    expect(next.snapshot.tasks[0]?.attempt).toBe(1);
  });

  it("replays events deterministically into the same snapshot", async () => {
    const workflow = definition(["A"]);
    const engine = new DeterministicWorkflowEngine();
    const events: DomainEvent[] = [];
    let state = await create(engine, workflow);
    events.push(...state.emittedEvents);
    state = await advance(engine, state, "replay-advance");
    events.push(...state.emittedEvents);
    const checkpointState = structuredClone(state.snapshot);
    const bound = await bind(engine, state, "A");
    state = bound.result;
    events.push(...state.emittedEvents);
    state = await recordResult(engine, state, bound.handle, "succeeded", "replay-result");
    events.push(...state.emittedEvents);

    const recovered = new DeterministicWorkflowEngine({ definitions: [workflow] });
    const replayed = unwrap(await recovered.recover({
      runId: "run-1", events, expectedVersion: state.snapshot.version
    }));
    expect(replayed.snapshot).toEqual(state.snapshot);
    expect(replayed.emittedEvents).toEqual([]);

    const fromCheckpoint = new DeterministicWorkflowEngine({ definitions: [workflow] });
    const checkpointReplay = unwrap(await fromCheckpoint.recover({
      runId: "run-1",
      checkpoint: {
        checkpointSchemaVersion: 1,
        codec: { name: "bflow.workflow-run-snapshot+json", version: 1 },
        checkpointId: "checkpoint-1",
        runId: "run-1",
        eventSequence: checkpointState.lastEventSequence,
        version: checkpointState.version,
        state: checkpointState,
        createdAt: later
      },
      events,
      expectedVersion: state.snapshot.version
    }));
    expect(checkpointReplay.snapshot).toEqual(state.snapshot);
  });

  it("binds a reconciled delivery and exposes an isolated snapshot", async () => {
    const engine = new DeterministicWorkflowEngine();
    const running = await advance(engine, await create(engine, definition(["A"])), "reconcile-start");
    const handle = handleFor(running, "A", "reconciled");
    const reconciled = unwrap(await engine.recordDeliveryReconciliation({
      runId: "run-1",
      taskId: "A",
      expectedVersion: running.snapshot.version,
      requestId: handle.requestId,
      result: { status: "bound", handle },
      idempotencyKey: "reconcile-bound",
      occurredAt: later
    }));
    expect(reconciled.snapshot.tasks[0]?.agentExecution).toEqual(handle);
    const loaded = unwrap(await engine.getSnapshot("run-1"));
    expect(loaded).toEqual(reconciled.snapshot);
    if (loaded !== null) loaded.tasks[0]!.status = "failed";
    expect(unwrap(await engine.getSnapshot("run-1"))?.tasks[0]?.status).toBe("running");
  });

  it("rejects invalid terminal reopening including succeeded -> running", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine, definition(["A"])), "invalid-start");
    state = await finishTask(engine, state, "A", "invalid-finish");
    const task = state.snapshot.tasks[0]!;
    const result = await engine.transitionTask({
      runId: "run-1", taskId: "A", expectedVersion: state.snapshot.version,
      from: "succeeded", to: "running", intent: "normal",
      generationFrom: task.generation, generationTo: task.generation,
      idempotencyKey: "invalid-reopen", occurredAt: later
    });
    expect(result).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("rejects expectedVersion mismatch with a typed conflict", async () => {
    const engine = new DeterministicWorkflowEngine();
    await create(engine, definition(["A"]));
    const result = await engine.advance({ runId: "run-1", expectedVersion: 0, idempotencyKey: "stale", occurredAt: later });
    expect(result).toMatchObject({ ok: false, error: { code: "conflict", version: { expected: 0, actual: 2 } } });
  });

  it("replays identical idempotent commands and rejects key collisions", async () => {
    const engine = new DeterministicWorkflowEngine();
    const created = await create(engine, definition(["A"]));
    const original = { runId: "run-1", expectedVersion: created.snapshot.version, idempotencyKey: "same-key", occurredAt: later };
    const first = unwrap(await engine.advance(original));
    expect(unwrap(await engine.advance(original))).toEqual(first);
    const collision = await engine.advance({ ...original, occurredAt: time });
    expect(collision).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("retries only until maxAttempts is exhausted", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine, definition(["A"], [], { maxAttempts: 2 })), "retry-start-1");
    let bound = await bind(engine, state, "A", "1");
    state = await recordResult(engine, bound.result, bound.handle, "failed", "retry-fail-1");
    expect(state.snapshot.tasks[0]).toMatchObject({ status: "ready", attempt: 1 });
    state = await advance(engine, state, "retry-start-2");
    bound = await bind(engine, state, "A", "2");
    state = await recordResult(engine, bound.result, bound.handle, "failed", "retry-fail-2");
    expect(state.snapshot.tasks[0]).toMatchObject({ status: "failed", attempt: 2 });
    expect(state.snapshot.status).toBe("failed");
  });

  it("keeps a blocked agent result blocked rather than successful", async () => {
    const engine = new DeterministicWorkflowEngine();
    const running = await advance(engine, await create(engine, definition(["A"])), "blocked-start");
    const bound = await bind(engine, running, "A");
    const state = await recordResult(engine, bound.result, bound.handle, "blocked", "blocked-result");
    expect(state.snapshot.tasks[0]?.status).toBe("blocked");
    expect(state.snapshot.status).toBe("blocked");
  });

  it("does not release a dependent after a required quality gate fails", async () => {
    const engine = new DeterministicWorkflowEngine();
    const workflow = definition(["A", "B"], [
      { taskId: "B", dependsOnTaskId: "A", condition: "succeeded" }
    ], { gatedTask: "A" });
    let state = await advance(engine, await create(engine, workflow), "gate-start");
    const bound = await bind(engine, state, "A");
    state = await recordResult(engine, bound.result, bound.handle, "succeeded", "gate-agent-result");
    expect(state.snapshot.tasks.find((task) => task.taskId === "A")?.status).toBe("waiting");
    state = unwrap(await engine.requestQualityGateEvaluation({
      runId: "run-1", taskId: "A", evaluationId: "evaluation-1", gateId: "tests",
      attemptId: bound.handle.attemptId, expectedVersion: state.snapshot.version,
      idempotencyKey: "gate-request", occurredAt: later
    }));
    state = unwrap(await engine.recordQualityGateResult({
      expectedVersion: state.snapshot.version,
      idempotencyKey: "gate-result",
      result: {
        gateId: "tests", runId: "run-1", taskId: "A", evaluationId: "evaluation-1",
        status: "failed", findings: [{ code: "tests_failed", severity: "error", message: "failed" }],
        producedArtifacts: [], evaluatedAt: later
      }
    }));
    expect(state.snapshot.tasks.find((task) => task.taskId === "A")?.status).toBe("blocked");
    state = await advance(engine, state, "gate-after-fail");
    expect(state.runnableTaskIds).not.toContain("B");
    expect(state.snapshot.tasks.find((task) => task.taskId === "B")?.status).toBe("pending");
  });

  it("rejects stale approval revisions and creates a new generation for rework", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine, definition(["A"], [], { approvalTask: "A" })), "approval-start");
    const bound = await bind(engine, state, "A");
    state = await recordResult(engine, bound.result, bound.handle, "succeeded", "approval-result");
    state = unwrap(await engine.requestApproval({
      expectedVersion: state.snapshot.version,
      idempotencyKey: "approval-request-command",
      request: {
        schemaVersion: 1, approvalId: "approval-1", runId: "run-1", target: { type: "task", taskId: "A" },
        revision: 1, generation: 0, requestedBy: "runtime", requestedAt: later,
        reason: "review", evidence: [], idempotencyKey: "approval-request"
      }
    }));
    const missing = await engine.applyApproval({
      expectedVersion: state.snapshot.version,
      idempotencyKey: "missing-decision-command",
      decision: {
        schemaVersion: 1, approvalId: "missing", runId: "run-1", target: { type: "task", taskId: "A" },
        revision: 1, generation: 0, decision: "approved", decidedBy: "reviewer", decidedAt: later,
        feedbackArtifacts: [], idempotencyKey: "missing-decision"
      }
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "validation" } });
    const stale = await engine.applyApproval({
      expectedVersion: state.snapshot.version,
      idempotencyKey: "stale-decision-command",
      decision: {
        schemaVersion: 1, approvalId: "approval-1", runId: "run-1", target: { type: "task", taskId: "A" },
        revision: 2, generation: 0, decision: "approved", decidedBy: "reviewer", decidedAt: later,
        feedbackArtifacts: [], idempotencyKey: "stale-decision"
      }
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    state = unwrap(await engine.applyApproval({
      expectedVersion: state.snapshot.version,
      idempotencyKey: "rework-decision-command",
      decision: {
        schemaVersion: 1, approvalId: "approval-1", runId: "run-1", target: { type: "task", taskId: "A" },
        revision: 1, generation: 0, decision: "changes_requested", decidedBy: "reviewer", decidedAt: later,
        reason: "revise", feedbackArtifacts: [], idempotencyKey: "rework-decision"
      }
    }));
    expect(state.snapshot.tasks[0]).toMatchObject({ status: "ready", generation: 1, attempt: 1 });
    state = await advance(engine, state, "rework-start");
    expect(state.snapshot.tasks[0]).toMatchObject({ status: "running", generation: 1, attempt: 2 });
  });

  it("resolves cancellation versus completion deterministically with completion winning", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine, definition(["A"])), "cancel-start");
    const bound = await bind(engine, state, "A");
    state = bound.result;
    state = unwrap(await engine.requestCancellation({
      schemaVersion: 1, cancellationId: "cancel-1", runId: "run-1", taskId: "A",
      requestedBy: "user", requestedAt: later, expectedVersion: state.snapshot.version,
      executionId: bound.handle.executionId, reason: "stop", idempotencyKey: "cancel-request"
    }));
    expect(state.snapshot.tasks[0]?.status).toBe("cancelling");
    state = await recordResult(engine, state, bound.handle, "succeeded", "completion-wins");
    expect(state.snapshot.tasks[0]?.status).toBe("succeeded");
    state = unwrap(await engine.recordCancellationResult({
      runId: "run-1", expectedVersion: state.snapshot.version, idempotencyKey: "cancel-accepted",
      result: { schemaVersion: 1, cancellationId: "cancel-1", status: "accepted",
        executionId: bound.handle.executionId, observedAt: later }
    }));
    state = unwrap(await engine.confirmCancellationStop({
      runId: "run-1", expectedVersion: state.snapshot.version, idempotencyKey: "cancel-confirmed",
      confirmation: { schemaVersion: 1, cancellationId: "cancel-1", executionId: bound.handle.executionId,
        stoppedAt: later, terminalStatus: "cancelled" }
    }));
    expect(state.snapshot.tasks[0]?.status).toBe("succeeded");
    expect(state.snapshot.status).toBe("succeeded");
  });

  it("returns typed validation for malformed schemas and unsupported recovery input", async () => {
    const engine = new DeterministicWorkflowEngine();
    const malformed = await engine.createRun({
      runId: "run-1", definition: { ...definition(["A"]), schemaVersion: "9" },
      idempotencyKey: "bad", createdAt: time
    } as unknown as Parameters<DeterministicWorkflowEngine["createRun"]>[0]);
    expect(malformed).toMatchObject({ ok: false, error: { code: "validation" } });

    const recovery = await engine.recover({ runId: "run-1", events: [], expectedVersion: 0 });
    expect(recovery).toMatchObject({ ok: false, error: { code: "validation" } });

    const unsupported = await engine.recover({
      runId: "run-1",
      expectedVersion: 1,
      events: [{ schemaVersion: 9 }]
    } as unknown as Parameters<DeterministicWorkflowEngine["recover"]>[0]);
    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: "unsupported_version", receivedVersion: 9 }
    });
  });
});

it('recovers each run using its own definition when generated workflow labels are reused',async()=>{
 const engine=new DeterministicWorkflowEngine();
 const first=unwrap(await engine.createRun({runId:'run-first',definition:definition(['first-task']),createdAt:time,idempotencyKey:'create-first'}));
 const checkpoint=unwrap(await engine.createCheckpoint({runId:'run-first',expectedVersion:first.snapshot.version,checkpointId:'checkpoint-first',createdAt:later}));
 const second=unwrap(await engine.createRun({runId:'run-second',definition:definition(['second-task']),createdAt:time,idempotencyKey:'create-second'}));
 expect(first.snapshot.workflowId).toBe(second.snapshot.workflowId);expect(first.snapshot.workflowVersion).toBe(second.snapshot.workflowVersion);
 const recovered=unwrap(await engine.recover({runId:'run-first',checkpoint,events:[],expectedVersion:first.snapshot.version}));
 expect(recovered.snapshot.tasks.map(task=>task.taskId)).toEqual(['first-task']);
 expect(unwrap(await engine.getSnapshot('run-second'))?.tasks.map(task=>task.taskId)).toEqual(['second-task']);
 const restarted=new DeterministicWorkflowEngine();
 await restarted.createRun({runId:'run-first',definition:definition(['first-task']),createdAt:time,idempotencyKey:'create-first'});
 await restarted.createRun({runId:'run-second',definition:definition(['second-task']),createdAt:time,idempotencyKey:'create-second'});
 expect(unwrap(await restarted.recover({runId:'run-first',checkpoint,events:[],expectedVersion:first.snapshot.version})).snapshot.tasks.map(task=>task.taskId)).toEqual(['first-task']);
});
