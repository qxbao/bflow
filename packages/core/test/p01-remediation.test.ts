import { describe, expect, it } from "vitest";
import type {
  AgentExecutionHandle, AgentResult, DomainEvent, OperationResult, WorkflowAdvanceResult,
  WorkflowDefinition
} from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "../src/index.js";

const t0 = "2026-10-13T00:00:00.000Z";
const t1 = "2026-10-13T00:00:01.000Z";
const t2 = "2026-10-13T00:00:02.000Z";

function ok<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function workflow(options: {
  taskIds?: string[]; dependent?: boolean; concurrency?: number; approval?: boolean; gate?: boolean;
  reworks?: number; exhausted?: "fail" | "require_human"; attempts?: number; delay?: number;
  strategy?: "fixed" | "exponential"; errorCodes?: string[]; timeout?: "retry" | "fail" | "block";
} = {}): WorkflowDefinition {
  const ids = options.taskIds ?? ["A"];
  return {
    schemaVersion: "1", id: "audit", name: "Audit", version: "1.0.0",
    tasks: ids.map((id) => ({
      id, title: id, role: "worker", instruction: `Do ${id}`, acceptanceCriteria: ["done"],
      retry: {
        maxAttempts: options.attempts ?? 3, strategy: options.strategy ?? "fixed",
        initialDelayMs: options.delay ?? 0, maxDelayMs: (options.delay ?? 0) * 8,
        ...(options.strategy === "exponential" ? { multiplier: 2 } : {}),
        jitter: false, ...(options.errorCodes ? { retryableErrorCodes: options.errorCodes } : {})
      },
      rework: { maxReworks: options.reworks ?? 0, onExhausted: options.exhausted ?? "fail" },
      timeout: { executionTimeoutMs: 1000, onTimeout: options.timeout ?? "retry" },
      requiresApproval: options.approval === true,
      qualityGates: options.gate ? [{ gateId: "checks", phase: "after_result", required: true }] : []
    })),
    dependencies: options.dependent ? [{ taskId: "B", dependsOnTaskId: "A", condition: "succeeded" }] : [],
    qualityGates: options.gate ? [{ id: "checks", name: "Checks", evaluator: "test", required: true,
      timeout: { executionTimeoutMs: 1000, onTimeout: "fail" } }] : [],
    maxConcurrency: options.concurrency ?? 2, failurePolicy: "continue-independent",
    recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
  };
}

async function create(engine: DeterministicWorkflowEngine, definition = workflow()) {
  return ok(await engine.createRun({ runId: "run-audit", definition, createdAt: t0, idempotencyKey: "create" }));
}
async function advance(engine: DeterministicWorkflowEngine, state: WorkflowAdvanceResult, key: string, occurredAt = t1) {
  return ok(await engine.advance({ runId: "run-audit", expectedVersion: state.snapshot.version,
    idempotencyKey: key, occurredAt }));
}
function handle(state: WorkflowAdvanceResult, taskId = "A", executionId = `ex-${taskId}`): AgentExecutionHandle {
  const attemptId = state.snapshot.tasks.find((task) => task.taskId === taskId)?.attemptId;
  if (!attemptId) throw new Error("Missing attempt identity");
  return { executionId, requestId: `request-${executionId}`, attemptId, runId: "run-audit", taskId,
    idempotencyKey: `agent-${executionId}`, target: { transport: "test", agentId: "worker", paneId: "pane" },
    correlation: { token: `token-${executionId}`, provenance: "remote", verified: true }, acceptedAt: t1 };
}
async function bind(engine: DeterministicWorkflowEngine, state: WorkflowAdvanceResult, taskId = "A", executionId = `ex-${taskId}`) {
  const h = handle(state, taskId, executionId);
  const next = ok(await engine.bindAgentExecution({ runId: "run-audit", taskId,
    attempt: state.snapshot.tasks.find((task) => task.taskId === taskId)!.attempt,
    handle: h, expectedVersion: state.snapshot.version, idempotencyKey: `bind-${executionId}`, occurredAt: t1 }));
  return { state: next, handle: h };
}
function result(h: AgentExecutionHandle, status: AgentResult["status"] = "succeeded", errorCode = "retryable"): AgentResult {
  return {
    requestId: h.requestId, attemptId: h.attemptId, runId: h.runId, taskId: h.taskId,
    executionId: h.executionId, status,
    verification: { status: "verified", evidence: "verified output", correlation: h.correlation },
    artifactProposals: [], retryable: status === "failed" || status === "timed_out",
    startedAt: t1, completedAt: t2,
    ...(status === "failed" || status === "timed_out" ?
      { error: { code: errorCode, message: "worker failed", retryable: true } } : {})
  } as AgentResult;
}
async function record(engine: DeterministicWorkflowEngine, state: WorkflowAdvanceResult,
  h: AgentExecutionHandle, status: AgentResult["status"] = "succeeded", key = `result-${h.executionId}`,
  errorCode = "retryable") {
  return ok(await engine.recordAgentResult({ runId: "run-audit", taskId: h.taskId,
    expectedVersion: state.snapshot.version, result: result(h, status, errorCode),
    idempotencyKey: key, occurredAt: t2 }));
}
async function requestGate(engine: DeterministicWorkflowEngine, state: WorkflowAdvanceResult,
  evaluationId: string, attemptId?: string) {
  return engine.requestQualityGateEvaluation({ runId: "run-audit", taskId: "A", gateId: "checks",
    evaluationId, ...(attemptId ? { attemptId } : {}), expectedVersion: state.snapshot.version,
    idempotencyKey: `gate-request-${evaluationId}`, occurredAt: t1 });
}
async function gateResult(engine: DeterministicWorkflowEngine, state: WorkflowAdvanceResult,
  evaluationId: string, status: "passed" | "failed") {
  return engine.recordQualityGateResult({ expectedVersion: state.snapshot.version,
    idempotencyKey: `gate-result-${evaluationId}`,
    result: { runId: "run-audit", taskId: "A", gateId: "checks", evaluationId,
      status, findings: [], producedArtifacts: [], evaluatedAt: t2 } });
}
function approvalRequest(generation = 0, approvalId = `approval-${generation}`) {
  return { schemaVersion: 1 as const, approvalId, runId: "run-audit",
    target: { type: "task" as const, taskId: "A" }, revision: generation + 1, generation,
    requestedBy: "runtime", requestedAt: t2, reason: "review", evidence: [], idempotencyKey: `request-${approvalId}` };
}
function approvalDecision(generation = 0, decision: "approved" | "changes_requested" = "changes_requested",
  approvalId = `approval-${generation}`) {
  return { schemaVersion: 1 as const, approvalId, runId: "run-audit",
    target: { type: "task" as const, taskId: "A" }, revision: generation + 1, generation,
    decision, decidedBy: "reviewer", decidedAt: t2, reason: "review", feedbackArtifacts: [],
    idempotencyKey: `decision-${approvalId}` };
}

describe("P01 remediation invariants", () => {
  it("P01-01: checkpoint plus tail retains approvals, gates, success evidence, and command receipts", async () => {
    const definition = workflow({ approval: true, gate: true, reworks: 1 });
    const engine = new DeterministicWorkflowEngine({ definitions: [definition] });
    const history: DomainEvent[] = [];
    let state = await create(engine, definition); history.push(...state.emittedEvents);
    state = await advance(engine, state, "start"); history.push(...state.emittedEvents);
    const bound = await bind(engine, state); state = bound.state; history.push(...state.emittedEvents);
    state = ok(await requestGate(engine, state, "eval-a", bound.handle.attemptId)); history.push(...state.emittedEvents);
    state = await record(engine, state, bound.handle); history.push(...state.emittedEvents);
    state = ok(await gateResult(engine, state, "eval-a", "passed")); history.push(...state.emittedEvents);
    const approvalExpectedVersion = state.snapshot.version;
    state = ok(await engine.requestApproval({ expectedVersion: approvalExpectedVersion,
      idempotencyKey: "ask-approval", request: approvalRequest() })); history.push(...state.emittedEvents);
    const checkpoint = ok(await engine.createCheckpoint({ runId: "run-audit", expectedVersion: state.snapshot.version,
      checkpointId: "checkpoint-a", createdAt: t2 }));
    const duplicate = await engine.requestApproval({ expectedVersion: approvalExpectedVersion,
      idempotencyKey: "ask-approval", request: approvalRequest() });
    expect(duplicate).toMatchObject({ ok: true, value: { snapshot: { version: state.snapshot.version } } });
    state = ok(await engine.applyApproval({ expectedVersion: state.snapshot.version,
      idempotencyKey: "approve", decision: approvalDecision(0, "approved") })); history.push(...state.emittedEvents);
    const full = new DeterministicWorkflowEngine({ definitions: [definition] });
    const tail = new DeterministicWorkflowEngine({ definitions: [definition] });
    const fullState = ok(await full.recover({ runId: "run-audit", events: history,
      expectedVersion: state.snapshot.version }));
    const tailState = ok(await tail.recover({ runId: "run-audit", checkpoint,
      events: history.filter((event) => event.sequence > checkpoint.eventSequence),
      expectedVersion: state.snapshot.version }));
    expect(tailState.snapshot).toEqual(fullState.snapshot);
    expect(ok(await tail.createCheckpoint({ runId: "run-audit", expectedVersion: state.snapshot.version,
      checkpointId: "checkpoint-b", createdAt: t2 })).state).toEqual(
      ok(await full.createCheckpoint({ runId: "run-audit", expectedVersion: state.snapshot.version,
        checkpointId: "checkpoint-c", createdAt: t2 })).state);
    expect(await tail.requestApproval({ expectedVersion: approvalExpectedVersion, idempotencyKey: "ask-approval",
      request: approvalRequest() })).toMatchObject({ ok: true, value: { snapshot: { version: checkpoint.version } } });
    expect(await tail.requestApproval({ expectedVersion: approvalExpectedVersion, idempotencyKey: "ask-approval",
      request: { ...approvalRequest(), reason: "different payload" } }))
      .toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("P01-01: rejects incomplete and corrupted checkpoints and partial history", async () => {
    const definition = workflow();
    const engine = new DeterministicWorkflowEngine({ definitions: [definition] });
    const created = await create(engine, definition);
    const checkpoint = ok(await engine.createCheckpoint({ runId: "run-audit", expectedVersion: created.snapshot.version,
      checkpointId: "checkpoint-a", createdAt: t1 }));
    const recovered = new DeterministicWorkflowEngine({ definitions: [definition] });
    expect(await recovered.recover({ runId: "run-audit", events: created.emittedEvents.slice(1),
      expectedVersion: created.snapshot.version })).toMatchObject({ ok: false });
    const damaged = structuredClone(checkpoint);
    (damaged.state as { commands: unknown[] }).commands = [];
    expect(await recovered.recover({ runId: "run-audit", checkpoint: damaged, events: [],
      expectedVersion: created.snapshot.version })).toMatchObject({ ok: false, error: { code: "corruption" } });
    const legacy = { ...checkpoint, codec: { name: "bflow.workflow-run-snapshot+json" as const, version: 1 as const },
      state: created.snapshot };
    expect(await recovered.recover({ runId: "run-audit", checkpoint: legacy, events: [],
      expectedVersion: created.snapshot.version })).toMatchObject({ ok: false });
  });

  it("P01-01: retry eligibility and attempt baseline survive checkpoint replay", async () => {
    const definition = workflow({ delay: 5000, attempts: 2 });
    const engine = new DeterministicWorkflowEngine({ definitions: [definition] });
    let state = await advance(engine, await create(engine, definition), "start");
    const first = await bind(engine, state); state = first.state;
    state = await record(engine, state, first.handle, "failed");
    const checkpoint = ok(await engine.createCheckpoint({ runId: "run-audit", expectedVersion: state.snapshot.version,
      checkpointId: "retry-checkpoint", createdAt: t2 }));
    const restarted = new DeterministicWorkflowEngine({ definitions: [definition] });
    const recovered = ok(await restarted.recover({ runId: "run-audit", checkpoint, events: [],
      expectedVersion: state.snapshot.version }));
    expect((await advance(restarted, recovered, "early", "2026-10-13T00:00:06.000Z")).snapshot.tasks[0]?.status)
      .toBe("retrying");
    expect((await advance(engine, state, "early", "2026-10-13T00:00:06.000Z")).snapshot.tasks[0]?.status)
      .toBe("retrying");
    const next = ok(await engine.getSnapshot("run-audit"));
    const nextRecovered = ok(await restarted.getSnapshot("run-audit"));
    if (!next || !nextRecovered) throw new Error("Missing retry snapshot");
    const eligible = "2026-10-13T00:00:07.000Z";
    const mainResult = ok(await engine.advance({ runId: "run-audit", expectedVersion: next.version,
      idempotencyKey: "eligible", occurredAt: eligible }));
    const replayResult = ok(await restarted.advance({ runId: "run-audit", expectedVersion: nextRecovered.version,
      idempotencyKey: "eligible", occurredAt: eligible }));
    expect(replayResult.snapshot).toEqual(mainResult.snapshot);
    expect(mainResult.snapshot.tasks[0]).toMatchObject({ status: "running", attempt: 2 });
  });

  it("P01-01/06: cancellation state survives checkpoint and only its bound execution is stopped", async () => {
    const definition = workflow({ taskIds: ["A", "B"] });
    const engine = new DeterministicWorkflowEngine({ definitions: [definition] });
    let state = await advance(engine, await create(engine, definition), "start");
    const a = await bind(engine, state, "A"); state = a.state;
    const b = await bind(engine, state, "B"); state = b.state;
    state = ok(await engine.requestCancellation({ schemaVersion: 1, cancellationId: "cancel-A",
      runId: "run-audit", taskId: "A", executionId: a.handle.executionId,
      requestedBy: "user", requestedAt: t2, expectedVersion: state.snapshot.version,
      idempotencyKey: "cancel" }));
    const checkpoint = ok(await engine.createCheckpoint({ runId: "run-audit", expectedVersion: state.snapshot.version,
      checkpointId: "cancel-checkpoint", createdAt: t2 }));
    const restarted = new DeterministicWorkflowEngine({ definitions: [definition] });
    const recovered = ok(await restarted.recover({ runId: "run-audit", checkpoint, events: [],
      expectedVersion: state.snapshot.version }));
    expect(await restarted.confirmCancellationStop({ runId: "run-audit", expectedVersion: recovered.snapshot.version,
      idempotencyKey: "wrong", confirmation: { schemaVersion: 1, cancellationId: "cancel-A",
        executionId: b.handle.executionId, stoppedAt: t2, terminalStatus: "cancelled" } })).toMatchObject({ ok: false });
    const command = { runId: "run-audit", expectedVersion: state.snapshot.version, idempotencyKey: "stop",
      confirmation: { schemaVersion: 1 as const, cancellationId: "cancel-A", executionId: a.handle.executionId,
        stoppedAt: t2, terminalStatus: "cancelled" as const } };
    expect(ok(await restarted.confirmCancellationStop(command)).snapshot).toEqual(
      ok(await engine.confirmCancellationStop(command)).snapshot);
  });

  it("P01-06: run-wide cancellation confirms each execution separately and survives recovery", async () => {
    const definition = workflow({ taskIds: ["A", "B"] });
    const engine = new DeterministicWorkflowEngine({ definitions: [definition] });
    let state = await advance(engine, await create(engine, definition), "start");
    const a = await bind(engine, state, "A"); state = a.state;
    const b = await bind(engine, state, "B"); state = b.state;
    state = ok(await engine.requestCancellation({ schemaVersion: 1, cancellationId: "cancel-all",
      runId: "run-audit", requestedBy: "user", requestedAt: t2,
      expectedVersion: state.snapshot.version, idempotencyKey: "cancel-all-request" }));
    state = ok(await engine.recordCancellationResult({ runId: "run-audit", expectedVersion: state.snapshot.version,
      idempotencyKey: "cancel-accepted", result: { schemaVersion: 1, cancellationId: "cancel-all",
        status: "accepted", observedAt: t2 } }));
    state = ok(await engine.confirmCancellationStop({ runId: "run-audit", expectedVersion: state.snapshot.version,
      idempotencyKey: "stop-A", confirmation: { schemaVersion: 1, cancellationId: "cancel-all",
        executionId: a.handle.executionId, stoppedAt: t2, terminalStatus: "cancelled" } }));
    expect(state.snapshot.tasks.map((task) => task.status)).toEqual(["cancelled", "cancelling"]);
    expect(state.snapshot.status).toBe("cancelling");
    const checkpoint = ok(await engine.createCheckpoint({ runId: "run-audit", expectedVersion: state.snapshot.version,
      checkpointId: "partial-stop", createdAt: t2 }));
    const restarted = new DeterministicWorkflowEngine({ definitions: [definition] });
    const recovered = ok(await restarted.recover({ runId: "run-audit", checkpoint, events: [],
      expectedVersion: state.snapshot.version }));
    const stopB = { runId: "run-audit", expectedVersion: state.snapshot.version,
      idempotencyKey: "stop-B", confirmation: { schemaVersion: 1 as const,
        cancellationId: "cancel-all", executionId: b.handle.executionId,
        stoppedAt: t2, terminalStatus: "cancelled" as const } };
    const originalDone = ok(await engine.confirmCancellationStop(stopB));
    const recoveredDone = ok(await restarted.confirmCancellationStop({ ...stopB,
      expectedVersion: recovered.snapshot.version }));
    expect(recoveredDone.snapshot).toEqual(originalDone.snapshot);
    expect(recoveredDone.snapshot.status).toBe("cancelled");
  });

  it("P01-01/11: rework generation and policy survive a checkpoint", async () => {
    const definition = workflow({ approval: true, reworks: 1 });
    const engine = new DeterministicWorkflowEngine({ definitions: [definition] });
    let state = await advance(engine, await create(engine, definition), "start");
    const bound = await bind(engine, state);
    state = await record(engine, bound.state, bound.handle);
    state = ok(await engine.requestApproval({ expectedVersion: state.snapshot.version,
      idempotencyKey: "ask", request: approvalRequest() }));
    state = ok(await engine.applyApproval({ expectedVersion: state.snapshot.version,
      idempotencyKey: "change", decision: approvalDecision() }));
    const checkpoint = ok(await engine.createCheckpoint({ runId: "run-audit", expectedVersion: state.snapshot.version,
      checkpointId: "rework-checkpoint", createdAt: t2 }));
    const restarted = new DeterministicWorkflowEngine({ definitions: [definition] });
    const recovered = ok(await restarted.recover({ runId: "run-audit", checkpoint, events: [],
      expectedVersion: state.snapshot.version }));
    const main = await advance(engine, state, "rework-start");
    const tail = await advance(restarted, recovered, "rework-start");
    expect(tail.snapshot).toEqual(main.snapshot);
    expect(tail.snapshot.tasks[0]).toMatchObject({ generation: 1, attempt: 2, status: "running" });
  });

  it("P01-02: replay rejects a task status event whose source differs from current state", async () => {
    const definition = workflow();
    const engine = new DeterministicWorkflowEngine({ definitions: [definition] });
    const created = await create(engine, definition);
    const advanceState = await advance(engine, created, "start");
    const ready = advanceState.emittedEvents.find((event) => event.type === "task.status_changed");
    if (ready?.type !== "task.status_changed") throw new Error("Missing transition");
    const forged: DomainEvent = { ...ready, payload: { ...ready.payload, from: "ready", to: "running" } };
    const recovered = new DeterministicWorkflowEngine({ definitions: [definition] });
    expect(await recovered.recover({ runId: "run-audit", events: [...created.emittedEvents, forged],
      expectedVersion: forged.aggregateVersion })).toMatchObject({ ok: false, error: { code: "corruption" } });
  });

  it("P01-02: replay rejects duplicate event identities and sequence gaps", async () => {
    const engine = new DeterministicWorkflowEngine();
    const created = await create(engine);
    const recovered = new DeterministicWorkflowEngine({ definitions: [workflow()] });
    const duplicated = [...created.emittedEvents, created.emittedEvents[1]!];
    expect(await recovered.recover({ runId: "run-audit", events: duplicated,
      expectedVersion: duplicated.length })).toMatchObject({ ok: false, error: { code: "corruption" } });
    const skipped = created.emittedEvents.map((event, index) => index === 1
      ? { ...event, sequence: event.sequence + 1, aggregateVersion: event.aggregateVersion + 1 } : event);
    expect(await recovered.recover({ runId: "run-audit", events: skipped,
      expectedVersion: 3 })).toMatchObject({ ok: false, error: { code: "corruption" } });
    const forgedReceipt = created.emittedEvents.map((event) => event.type === "command.completed"
      ? { ...event, payload: { ...event.payload, runnableTaskIds: ["A"] } } : event);
    expect(await recovered.recover({ runId: "run-audit", events: forgedReceipt,
      expectedVersion: created.snapshot.version })).toMatchObject({ ok: false, error: { code: "corruption" } });
  });

  it("P01-03: direct transitions respect dependencies and concurrency", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await create(engine, workflow({ taskIds: ["A", "B"], dependent: true, concurrency: 1 }));
    const B = state.snapshot.tasks[1]!;
    expect(await engine.transitionTask({ runId: "run-audit", taskId: "B", from: "pending", to: "ready",
      intent: "normal", generationFrom: 0, generationTo: 0, expectedVersion: state.snapshot.version,
      idempotencyKey: "skip-dependency", occurredAt: t1 })).toMatchObject({ ok: false });
    state = await advance(engine, state, "start");
    expect(state.snapshot.tasks[1]).toMatchObject({ status: "pending" });
    const bound = await bind(engine, state); state = await record(engine, bound.state, bound.handle);
    state = await advance(engine, state, "release-B");
    expect(state.snapshot.tasks[1]).toMatchObject({ status: "running" });
    expect(B.status).toBe("pending");
    const parallel = new DeterministicWorkflowEngine();
    let occupied = await create(parallel, workflow({ taskIds: ["A", "B"], concurrency: 1 }));
    occupied = await advance(parallel, occupied, "occupy");
    expect(await parallel.transitionTask({ runId: "run-audit", taskId: "B", from: "ready", to: "running",
      intent: "normal", generationFrom: 0, generationTo: 0, expectedVersion: occupied.snapshot.version,
      idempotencyKey: "over-capacity", occurredAt: t1 })).toMatchObject({ ok: false });
  });

  it("P01-03: a dependent task is not lost while its prerequisite awaits approval", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine,
      workflow({ taskIds: ["A", "B"], dependent: true, approval: true, reworks: 1 })), "start");
    const bound = await bind(engine, state);
    state = await record(engine, bound.state, bound.handle);
    state = await advance(engine, state, "await-approval");
    expect(state.snapshot.tasks[1]?.status).toBe("pending");
    state = ok(await engine.requestApproval({ expectedVersion: state.snapshot.version,
      idempotencyKey: "ask", request: approvalRequest() }));
    state = ok(await engine.applyApproval({ expectedVersion: state.snapshot.version,
      idempotencyKey: "approve", decision: approvalDecision(0, "approved") }));
    state = await advance(engine, state, "release-dependent");
    expect(state.snapshot.tasks[1]?.status).toBe("running");
  });

  it("P01-04: rejects unverified correlation and foreign/stale executions", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine), "start");
    const bound = await bind(engine, state); state = bound.state;
    const base = result(bound.handle);
    for (const invalid of [
      { ...base, verification: { ...base.verification,
        correlation: { ...base.verification.correlation, verified: false } } },
      { ...base, verification: { ...base.verification,
        correlation: { ...base.verification.correlation, token: "wrong" } } },
      { ...base, executionId: "foreign" },
      { ...base, attemptId: "old-attempt" }
    ]) {
      expect(await engine.recordAgentResult({ runId: "run-audit", taskId: "A",
        expectedVersion: state.snapshot.version, result: invalid, idempotencyKey: `invalid-${invalid.executionId}-${invalid.attemptId}-${invalid.verification.correlation.token}-${invalid.verification.correlation.verified}`,
        occurredAt: t2 })).toMatchObject({ ok: false });
    }
    state = await record(engine, state, bound.handle);
    expect(state.snapshot.tasks[0]?.status).toBe("succeeded");
  });

  it("P01-05: identical reconciliation is idempotent and conflicting binding is rejected", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine), "start");
    const bound = await bind(engine, state); state = bound.state;
    const command = { runId: "run-audit", taskId: "A", requestId: bound.handle.requestId,
      expectedVersion: state.snapshot.version, idempotencyKey: "reconcile-same", occurredAt: t1,
      result: { status: "bound" as const, handle: bound.handle } };
    state = ok(await engine.recordDeliveryReconciliation(command));
    expect((await engine.recordDeliveryReconciliation(command)).ok).toBe(true);
    const foreign = { ...bound.handle, executionId: "ex-other" };
    expect(await engine.recordDeliveryReconciliation({ ...command, expectedVersion: state.snapshot.version,
      idempotencyKey: "reconcile-other", result: { status: "bound", handle: foreign } })).toMatchObject({ ok: false });
    expect((ok(await engine.getSnapshot("run-audit"))?.tasks[0]?.agentExecution?.executionId)).toBe(bound.handle.executionId);
  });

  it("P01-04/05: an old attempt cannot reconcile or record a result after retry begins", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine), "start");
    const first = await bind(engine, state, "A", "ex-old");
    state = await record(engine, first.state, first.handle, "failed", "old-failed");
    state = await advance(engine, state, "retry-start");
    expect(await engine.recordDeliveryReconciliation({ runId: "run-audit", taskId: "A",
      requestId: first.handle.requestId, expectedVersion: state.snapshot.version,
      idempotencyKey: "reconcile-old", occurredAt: t2,
      result: { status: "bound", handle: first.handle } })).toMatchObject({ ok: false });
    expect(await engine.recordAgentResult({ runId: "run-audit", taskId: "A",
      expectedVersion: state.snapshot.version, result: result(first.handle),
      idempotencyKey: "old-success", occurredAt: t2 })).toMatchObject({ ok: false });
    const second = await bind(engine, state, "A", "ex-new");
    state = await record(engine, second.state, second.handle);
    expect(state.snapshot.tasks[0]).toMatchObject({ status: "succeeded", attempt: 2 });
  });

  it("P01-06: cross-task cancellation identity is rejected and a late stop cannot override completion", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine, workflow({ taskIds: ["A", "B"] })), "start");
    const a = await bind(engine, state, "A"); state = a.state;
    const b = await bind(engine, state, "B"); state = b.state;
    const invalid = await engine.requestCancellation({ schemaVersion: 1, cancellationId: "cancel-A",
      runId: "run-audit", taskId: "A", executionId: b.handle.executionId,
      requestedBy: "user", requestedAt: t2, expectedVersion: state.snapshot.version,
      idempotencyKey: "cancel-invalid" });
    expect(invalid).toMatchObject({ ok: false });
    expect(ok(await engine.getSnapshot("run-audit"))?.tasks.map((task) => task.status)).toEqual(["running", "running"]);
    state = ok(await engine.requestCancellation({ schemaVersion: 1, cancellationId: "cancel-A",
      runId: "run-audit", taskId: "A", executionId: a.handle.executionId,
      requestedBy: "user", requestedAt: t2, expectedVersion: state.snapshot.version,
      idempotencyKey: "cancel-valid" }));
    const wrongStop = await engine.confirmCancellationStop({ runId: "run-audit", expectedVersion: state.snapshot.version,
      idempotencyKey: "stop-wrong", confirmation: { schemaVersion: 1, cancellationId: "cancel-A",
        executionId: b.handle.executionId, stoppedAt: t2, terminalStatus: "cancelled" } });
    expect(wrongStop).toMatchObject({ ok: false });
    state = await record(engine, state, a.handle, "succeeded", "A-completed");
    const stopExpectedVersion = state.snapshot.version;
    state = ok(await engine.confirmCancellationStop({ runId: "run-audit", expectedVersion: stopExpectedVersion,
      idempotencyKey: "stop-late", confirmation: { schemaVersion: 1, cancellationId: "cancel-A",
        executionId: a.handle.executionId, stoppedAt: t2, terminalStatus: "cancelled" } }));
    expect(state.snapshot.tasks.map((task) => task.status)).toEqual(["succeeded", "running"]);
    const duplicate = await engine.confirmCancellationStop({ runId: "run-audit", expectedVersion: stopExpectedVersion,
      idempotencyKey: "stop-late", confirmation: { schemaVersion: 1, cancellationId: "cancel-A",
        executionId: a.handle.executionId, stoppedAt: t2, terminalStatus: "cancelled" } });
    expect(duplicate).toMatchObject({ ok: true, value: { snapshot: { version: state.snapshot.version } } });
  });

  it("P01-06: cancellation refusal records intent but never fabricates a confirmed stop", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine), "start");
    const bound = await bind(engine, state); state = bound.state;
    state = ok(await engine.requestCancellation({ schemaVersion: 1, cancellationId: "cancel-A",
      runId: "run-audit", taskId: "A", executionId: bound.handle.executionId,
      requestedBy: "user", requestedAt: t2, expectedVersion: state.snapshot.version,
      idempotencyKey: "cancel-request" }));
    state = ok(await engine.recordCancellationResult({ runId: "run-audit", expectedVersion: state.snapshot.version,
      idempotencyKey: "cancel-refused", result: { schemaVersion: 1, cancellationId: "cancel-A",
        status: "refused", reason: "not stopped", observedAt: t2 } }));
    expect(state.snapshot.tasks[0]?.status).toBe("cancelling");
    expect(state.snapshot.status).toBe("running");
    expect(await engine.recordCancellationResult({ runId: "run-audit", expectedVersion: state.snapshot.version,
      idempotencyKey: "cancel-refused-again", result: { schemaVersion: 1, cancellationId: "cancel-A",
        status: "refused", reason: "not stopped", observedAt: t2 } })).toMatchObject({ ok: false });
  });

  it("P01-07/08: gate requests require current attempt and stale outcomes cannot block a new attempt", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine, workflow({ gate: true })), "start");
    const first = await bind(engine, state, "A", "ex-first"); state = first.state;
    expect(await requestGate(engine, state, "missing-attempt")).toMatchObject({ ok: false });
    state = ok(await requestGate(engine, state, "eval-first", first.handle.attemptId));
    state = await record(engine, state, first.handle, "failed", "first-failed");
    expect(state.snapshot.tasks[0]?.status).toBe("ready");
    state = await advance(engine, state, "retry-start");
    const second = await bind(engine, state, "A", "ex-second"); state = second.state;
    const before = state.snapshot.tasks[0];
    expect(await requestGate(engine, state, "stale-request", first.handle.attemptId)).toMatchObject({ ok: false });
    state = ok(await gateResult(engine, state, "eval-first", "failed"));
    expect(state.snapshot.tasks[0]).toMatchObject({ status: before?.status, attemptId: before?.attemptId });
    state = ok(await requestGate(engine, state, "eval-second", second.handle.attemptId));
    state = await record(engine, state, second.handle, "succeeded", "second-succeeded");
    expect(state.snapshot.tasks[0]?.status).toBe("waiting");
    state = ok(await gateResult(engine, state, "eval-second", "passed"));
    expect(state.snapshot.tasks[0]?.status).toBe("succeeded");
  });

  it("P01-09: retryable codes, max attempts, fixed delay, and early advance are enforced", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine, workflow({ attempts: 2, delay: 5000,
      errorCodes: ["retryable"] })), "start");
    const first = await bind(engine, state, "A", "ex-first");
    state = await record(engine, first.state, first.handle, "failed", "first-failed");
    expect(state.snapshot.tasks[0]?.status).toBe("retrying");
    const schedule = state.emittedEvents.find((event) => event.type === "task.retry_scheduled");
    expect(schedule?.payload).toMatchObject({ eligibleAt: "2026-10-13T00:00:07.000Z" });
    state = await advance(engine, state, "too-early", "2026-10-13T00:00:06.000Z");
    expect(state.snapshot.tasks[0]?.status).toBe("retrying");
    state = await advance(engine, state, "eligible", "2026-10-13T00:00:07.000Z");
    expect(state.snapshot.tasks[0]?.status).toBe("running");
    const second = await bind(engine, state, "A", "ex-second");
    state = await record(engine, second.state, second.handle, "failed", "second-failed");
    expect(state.snapshot.tasks[0]?.status).toBe("failed");
    const nonRetryable = new DeterministicWorkflowEngine();
    let other = await advance(nonRetryable, await create(nonRetryable, workflow({ errorCodes: ["allowed"] })), "start");
    const bound = await bind(nonRetryable, other);
    other = await record(nonRetryable, bound.state, bound.handle, "failed", "not-allowed", "other");
    expect(other.snapshot.tasks[0]?.status).toBe("failed");
  });

  it("P01-09: exponential backoff and timeout policy are deterministic", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine, workflow({ strategy: "exponential", delay: 1000,
      attempts: 4 })), "start");
    const first = await bind(engine, state, "A", "ex-one");
    state = await record(engine, first.state, first.handle, "failed", "one-failed");
    expect(state.emittedEvents.find((event) => event.type === "task.retry_scheduled")?.payload)
      .toMatchObject({ eligibleAt: "2026-10-13T00:00:03.000Z" });
    state = await advance(engine, state, "retry-one", "2026-10-13T00:00:03.000Z");
    const second = await bind(engine, state, "A", "ex-two");
    state = await record(engine, second.state, second.handle, "failed", "two-failed");
    expect(state.emittedEvents.find((event) => event.type === "task.retry_scheduled")?.payload)
      .toMatchObject({ eligibleAt: "2026-10-13T00:00:04.000Z" });
    const timeout = new DeterministicWorkflowEngine();
    let timed = await advance(timeout, await create(timeout, workflow({ timeout: "fail" })), "start");
    const bound = await bind(timeout, timed);
    timed = await record(timeout, bound.state, bound.handle, "timed_out", "timeout");
    expect(timed.snapshot.tasks[0]?.status).toBe("failed");
  });

  it("P01-03/09: administrative transitions cannot manufacture a retry or clear an attempted blockage", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine,
      workflow({ taskIds: ["A", "B"], errorCodes: ["allowed"] })), "start");
    const a = await bind(engine, state, "A");
    state = await record(engine, a.state, a.handle, "failed", "nonretryable", "other");
    expect(state.snapshot.tasks[0]?.status).toBe("failed");
    expect(await engine.transitionTask({ runId: "run-audit", taskId: "A", from: "failed", to: "retrying",
      intent: "retry", generationFrom: 0, generationTo: 0, expectedVersion: state.snapshot.version,
      idempotencyKey: "manual-retry", occurredAt: t2 })).toMatchObject({ ok: false });
    const timeout = new DeterministicWorkflowEngine();
    let blocked = await advance(timeout, await create(timeout, workflow({ timeout: "block" })), "start");
    const bound = await bind(timeout, blocked);
    blocked = await record(timeout, bound.state, bound.handle, "timed_out", "blocked-timeout");
    expect(blocked.snapshot.tasks[0]?.status).toBe("blocked");
    expect(await timeout.transitionTask({ runId: "run-audit", taskId: "A", from: "blocked", to: "ready",
      intent: "normal", generationFrom: 0, generationTo: 0, expectedVersion: blocked.snapshot.version,
      idempotencyKey: "clear-blockage", occurredAt: t2 })).toMatchObject({ ok: false });
  });

  it("P01-10/11: terminal runs reject late approval, and rework obeys maxReworks", async () => {
    const engine = new DeterministicWorkflowEngine();
    let state = await advance(engine, await create(engine, workflow({ reworks: 1 })), "start");
    const bound = await bind(engine, state);
    state = await record(engine, bound.state, bound.handle);
    expect(state.snapshot.status).toBe("succeeded");
    expect(await engine.requestApproval({ expectedVersion: state.snapshot.version,
      idempotencyKey: "late-request", request: approvalRequest() })).toMatchObject({ ok: false });
    expect(await engine.applyApproval({ expectedVersion: state.snapshot.version,
      idempotencyKey: "late-change", decision: approvalDecision() })).toMatchObject({ ok: false });

    const rework = new DeterministicWorkflowEngine();
    let current = await advance(rework, await create(rework, workflow({ approval: true, reworks: 1 })), "start");
    const first = await bind(rework, current, "A", "ex-first");
    current = await record(rework, first.state, first.handle);
    current = ok(await rework.requestApproval({ expectedVersion: current.snapshot.version,
      idempotencyKey: "ask-0", request: approvalRequest(0) }));
    current = ok(await rework.applyApproval({ expectedVersion: current.snapshot.version,
      idempotencyKey: "change-0", decision: approvalDecision(0) }));
    expect(current.snapshot.tasks[0]).toMatchObject({ status: "ready", generation: 1 });
    current = await advance(rework, current, "rework-start");
    const second = await bind(rework, current, "A", "ex-second");
    current = await record(rework, second.state, second.handle);
    current = ok(await rework.requestApproval({ expectedVersion: current.snapshot.version,
      idempotencyKey: "ask-1", request: approvalRequest(1) }));
    current = ok(await rework.applyApproval({ expectedVersion: current.snapshot.version,
      idempotencyKey: "change-1", decision: approvalDecision(1) }));
    expect(current.snapshot.tasks[0]).toMatchObject({ status: "succeeded", generation: 1 });
    expect(current.snapshot.status).toBe("failed");
  });

  it("P01-11: zero reworks and require_human exhaustion do not create another generation", async () => {
    for (const exhausted of ["fail", "require_human"] as const) {
      const engine = new DeterministicWorkflowEngine();
      let state = await advance(engine, await create(engine, workflow({ approval: true, reworks: 0, exhausted })), "start");
      const bound = await bind(engine, state);
      state = await record(engine, bound.state, bound.handle);
      state = ok(await engine.requestApproval({ expectedVersion: state.snapshot.version,
        idempotencyKey: "ask", request: approvalRequest() }));
      state = ok(await engine.applyApproval({ expectedVersion: state.snapshot.version,
        idempotencyKey: "change", decision: approvalDecision() }));
      expect(state.snapshot.tasks[0]?.generation).toBe(0);
      expect(state.snapshot.status).toBe(exhausted === "fail" ? "failed" : "blocked");
      if (exhausted === "require_human") {
        state = ok(await engine.requestApproval({ expectedVersion: state.snapshot.version,
          idempotencyKey: "higher-revision-request", request: {
            ...approvalRequest(0, "approval-higher"), revision: 2
          } }));
        state = ok(await engine.applyApproval({ expectedVersion: state.snapshot.version,
          idempotencyKey: "higher-revision-approval", decision: {
            ...approvalDecision(0, "approved", "approval-higher"), revision: 2
          } }));
        expect(state.snapshot.status).toBe("succeeded");
      }
    }
  });
});
