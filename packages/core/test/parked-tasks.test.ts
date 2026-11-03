import { describe, expect, it } from "vitest";
import {
  CURRENT_DOMAIN_EVENT_SCHEMA_VERSION,
  DomainEventSchema,
  RecoveryCheckpointSchema,
  decodeWorkflowAggregateCheckpointState,
  type DomainEvent,
  type WorkflowAdvanceResult
} from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "../src/index.js";
import { deterministicId } from "../src/reducer.js";
import { Driver, definition, later, statusOf, taskOf, time, unwrap } from "./helpers/parked-fixtures.js";

// B2b Task 12 (R-B2-14): `parked` takes no capacity, is neither terminal nor success, keeps dependents pending
// and leaves the Core run `blocked` when only parked work remains.

const AB_C = () => definition(["c", "a", "b"], [{ taskId: "b", dependsOnTaskId: "a", condition: "succeeded" }], { maxConcurrency: 1 });

async function start(workflow = AB_C(), runId = "run-parked") {
  const engine = new DeterministicWorkflowEngine({ definitions: [workflow] });
  const created = unwrap(await engine.createRun({ runId, definition: workflow, idempotencyKey: `${runId}/create`, createdAt: time }));
  return new Driver(engine, created);
}

/** Park `a` while ready (c holds the only slot), then let c finish. */
async function parkAAndFinishC() {
  const driver = await start();
  await driver.advance();
  expect([statusOf(driver.state, "c"), statusOf(driver.state, "a"), statusOf(driver.state, "b")]).toEqual(["running", "ready", "pending"]);
  await driver.move("a", "parked", "park");
  await driver.succeed("c");
  await driver.advance();
  return driver;
}

/** Craft one durable command the way the engine records it (deterministic ids, receipt last). */
function craftCommand(runId: string, after: WorkflowAdvanceResult["snapshot"], key: string,
  operation: "requestCancellation" | "confirmCancellationStop" | "transitionTask",
  events: readonly { readonly type: DomainEvent["type"]; readonly taskId?: string; readonly payload: unknown }[]): DomainEvent[] {
  const first = after.lastEventSequence + 1;
  const all = [...events, { type: "command.completed" as const, payload: {
    schemaVersion: 1, commandId: deterministicId("command", runId, key), idempotencyKey: key, operation,
    fingerprint: "0".repeat(64), firstEventSequence: first, runnableTaskIds: [] } }];
  return all.map((event, index) => DomainEventSchema.parse({
    schemaVersion: CURRENT_DOMAIN_EVENT_SCHEMA_VERSION,
    eventId: deterministicId("event", runId, String(first + index), event.type, key),
    runId, ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    sequence: first + index, aggregateVersion: after.version + index + 1, occurredAt: later,
    correlationId: deterministicId("correlation", runId, key),
    idempotencyKey: deterministicId("idempotency", runId, key, String(index + 1)),
    type: event.type, payload: event.payload
  }));
}

describe("parked tasks (R-B2-14)", () => {
  it("lets independent work finish while a parked prerequisite holds its dependent pending; the run is blocked", async () => {
    const driver = await parkAAndFinishC();
    expect(statusOf(driver.state, "a")).toBe("parked");
    expect(statusOf(driver.state, "c")).toBe("succeeded");
    expect(statusOf(driver.state, "b")).toBe("pending");
    expect(driver.state.snapshot.status).toBe("blocked");
    expect(driver.state.runnableTaskIds).toEqual([]);
  });

  it("does not let a parked task take capacity", async () => {
    const workflow = definition(["a", "c"], [], { maxConcurrency: 1 });
    const driver = await start(workflow, "run-capacity");
    await driver.move("a", "ready", "normal");
    await driver.move("a", "parked", "park");
    await driver.advance();
    expect(statusOf(driver.state, "c")).toBe("running");
    expect(driver.state.snapshot.status).toBe("running");
  });

  it("unparks to ready, reruns with a fresh attempt and then releases the dependent", async () => {
    const driver = await parkAAndFinishC();
    expect(taskOf(driver.state, "a").attempt).toBe(0);
    await driver.move("a", "ready", "unpark");
    expect(statusOf(driver.state, "a")).toBe("ready");
    expect(driver.state.snapshot.status).toBe("running");
    await driver.advance();
    expect(statusOf(driver.state, "a")).toBe("running");
    expect(taskOf(driver.state, "a").attempt).toBe(1);
    await driver.succeed("a");
    expect(statusOf(driver.state, "a")).toBe("succeeded");
    const advanced = await driver.advance();
    expect(advanced.emittedEvents.some((event) => event.type === "task.status_changed" && event.taskId === "b" &&
      event.payload.from === "pending" && event.payload.to === "ready")).toBe(true);
    await driver.succeed("b");
    expect(driver.state.snapshot.status).toBe("succeeded");
  });

  it("refuses unpark while the parked task's dependencies are unsatisfied", async () => {
    const workflow = definition(["a", "b"], [{ taskId: "b", dependsOnTaskId: "a", condition: "completed" }]);
    const driver = await start(workflow, "run-unpark-deps");
    await driver.move("b", "parked", "park");
    await driver.move("a", "parked", "park");
    expect(driver.state.snapshot.status).toBe("blocked");
    const refused = await driver.transition("b", "ready", "unpark");
    expect(refused).toMatchObject({ ok: false, error: { code: "validation", message: "Dependencies are not satisfied for task b" } });
  });

  it("parks a running task without an execution, but a bound execution requires a confirmed stop of exactly that execution", async () => {
    const workflow = definition(["a", "c"], [], { maxConcurrency: 2 });
    const driver = await start(workflow, "run-running");
    await driver.advance();
    expect(statusOf(driver.state, "a")).toBe("running");
    await driver.move("a", "parked", "park");
    expect(statusOf(driver.state, "a")).toBe("parked");
    await driver.bind("c");
    const refused = await driver.transition("c", "parked", "park");
    expect(refused).toMatchObject({ ok: false, error: { code: "validation", message: "Parking a bound execution requires confirmed stop" } });
    expect(statusOf(driver.state, "c")).toBe("running");
  });

  it("accepts parking a bound execution once that exact execution's stop is confirmed (durable history)", async () => {
    // The live cancellation commands move a stopped task straight to cancelled, so this state is built from a
    // durable history: a task-scoped cancellation request plus a stop confirmation for the bound execution.
    const workflow = definition(["a"]);
    const driver = await start(workflow, "run-confirmed");
    await driver.advance();
    const handle = await driver.bind("a");
    const history = await collect(driver);
    const runId = driver.state.snapshot.runId;
    const request = { schemaVersion: 1, cancellationId: "stop-a", runId, taskId: "a", executionId: handle.executionId,
      requestedBy: "runtime", requestedAt: later, expectedVersion: driver.state.snapshot.version, idempotencyKey: "stop-a-request" };
    const requested = craftCommand(runId, driver.state.snapshot, "stop-a-request", "requestCancellation",
      [{ type: "cancellation.requested", taskId: "a", payload: request }]);
    const afterRequest = { ...driver.state.snapshot, lastEventSequence: requested.at(-1)!.sequence, version: requested.at(-1)!.aggregateVersion };
    const confirmed = craftCommand(runId, afterRequest, "stop-a-confirm", "confirmCancellationStop",
      [{ type: "cancellation.stop_confirmed", taskId: "a", payload: { schemaVersion: 1, cancellationId: "stop-a",
        executionId: handle.executionId, stoppedAt: later, terminalStatus: "cancelled" } }]);
    const durable = [...history, ...requested, ...confirmed];

    const restarted = new DeterministicWorkflowEngine({ definitions: [workflow] });
    const recovered = unwrap(await restarted.recover({ runId, events: durable, expectedVersion: confirmed.at(-1)!.aggregateVersion }));
    expect(statusOf(recovered, "a")).toBe("running");
    const resumed = new Driver(restarted, recovered, "resumed");
    const parked = await resumed.move("a", "parked", "park");
    expect(taskOf(parked, "a")).toMatchObject({ status: "parked", agentExecution: handle });
    expect(parked.snapshot.status).toBe("blocked");

    // Replay applies the same rule: the identical park event without the stop evidence is corruption.
    const parkEvents = parked.emittedEvents;
    const forged = [...history, ...craftCommand(runId, driver.state.snapshot, "forged-park", "transitionTask",
      parkEvents.filter((event) => event.type !== "command.completed").map((event) => ({ type: event.type, taskId: event.taskId, payload: event.payload })))];
    const rejected = await new DeterministicWorkflowEngine({ definitions: [workflow] })
      .recover({ runId, events: forged, expectedVersion: forged.at(-1)!.aggregateVersion });
    expect(rejected).toMatchObject({ ok: false, error: { code: "corruption", message: "Bound task parked without verified stop evidence" } });

    // A late result of the stopped execution never settles a parked task.
    const late = await restarted.recordAgentResult({ runId, taskId: "a", expectedVersion: parked.snapshot.version, idempotencyKey: "late-a",
      occurredAt: later, result: { requestId: handle.requestId, attemptId: handle.attemptId, runId, taskId: "a", executionId: handle.executionId,
        status: "succeeded", verification: { status: "verified", evidence: "signed-result", correlation: handle.correlation },
        artifactProposals: [], retryable: false, startedAt: time, completedAt: later } });
    expect(late).toMatchObject({ ok: false, error: { code: "conflict", message: "Task a is parked" } });

    // Unparking clears the stopped execution and its attempt identity; the attempt number continues.
    const unparked = await resumed.move("a", "ready", "unpark");
    expect(taskOf(unparked, "a").agentExecution).toBeUndefined();
    expect(taskOf(unparked, "a").attemptId).toBeUndefined();
    expect(taskOf(unparked, "a").attempt).toBe(1);
    await resumed.advance();
    expect(taskOf(resumed.state, "a")).toMatchObject({ status: "running", attempt: 2 });
  });

  it("never enters or leaves parked with the normal intent", async () => {
    const driver = await parkAAndFinishC();
    const into = await driver.transition("b", "parked", "normal");
    expect(into).toMatchObject({ ok: false, error: { code: "validation" } });
    if (!into.ok) expect(into.error.message).toContain("pending cannot transition to parked with normal intent");
    const out = await driver.transition("a", "ready", "normal");
    expect(out).toMatchObject({ ok: false, error: { code: "validation" } });
    if (!out.ok) expect(out.error.message).toContain("parked cannot transition to ready with normal intent");
  });

  it("cancelling a parked task cancels its succeeded-dependent as an unsatisfied dependency", async () => {
    const driver = await parkAAndFinishC();
    await driver.move("a", "cancelled", "cancel");
    await driver.advance();
    expect(statusOf(driver.state, "a")).toBe("cancelled");
    expect(statusOf(driver.state, "b")).toBe("cancelled");
    const cancelledB = (await collect(driver)).find((event) => event.type === "task.status_changed" && event.taskId === "b" &&
      event.payload.to === "cancelled");
    expect(cancelledB?.type === "task.status_changed" ? cancelledB.payload.reason : undefined).toBe("required dependency did not succeed");
  });

  it("cancels a parked task directly on a task-scoped or run-wide cancellation request", async () => {
    const driver = await parkAAndFinishC();
    driver.state = unwrap(await driver.engine.requestCancellation({ schemaVersion: 1, cancellationId: "cancel-run", runId: driver.state.snapshot.runId,
      requestedBy: "user", requestedAt: later, expectedVersion: driver.state.snapshot.version, idempotencyKey: "cancel-run" }));
    expect(statusOf(driver.state, "a")).toBe("cancelled");
    expect(statusOf(driver.state, "b")).toBe("cancelled");
    expect(driver.state.snapshot.status).toBe("cancelled");

    const single = await parkAAndFinishC();
    single.state = unwrap(await single.engine.requestCancellation({ schemaVersion: 1, cancellationId: "cancel-a", runId: single.state.snapshot.runId,
      taskId: "a", requestedBy: "user", requestedAt: later, expectedVersion: single.state.snapshot.version, idempotencyKey: "cancel-a" }));
    expect(statusOf(single.state, "a")).toBe("cancelled");
  });

  it("does not cancel parked tasks under fail-fast and does not count them as failures", async () => {
    const workflow = definition(["a", "c"], [], { maxConcurrency: 1, failurePolicy: "fail-fast" });
    const driver = await start(workflow, "run-fail-fast");
    await driver.move("a", "ready", "normal");
    await driver.move("a", "parked", "park");
    await driver.advance();
    await driver.succeed("c");
    await driver.advance();
    expect(statusOf(driver.state, "a")).toBe("parked");
    expect(driver.state.snapshot.status).toBe("blocked");
  });

  it("checkpoints parked state with aggregate codec 3, rejects it under codec 2 and recovers it", async () => {
    const plain = await start(definition(["a"]), "run-plain");
    const plainCheckpoint = unwrap(await plain.engine.createCheckpoint({ runId: "run-plain", expectedVersion: plain.state.snapshot.version,
      checkpointId: "cp-plain", createdAt: later }));
    expect(plainCheckpoint.codec.version).toBe(1);

    const driver = await parkAAndFinishC();
    const checkpoint = unwrap(await driver.engine.createCheckpoint({ runId: driver.state.snapshot.runId,
      expectedVersion: driver.state.snapshot.version, checkpointId: "cp-parked", createdAt: later }));
    expect(checkpoint.codec).toEqual({ name: "bflow.workflow-aggregate+json", version: 3 });
    const downgraded = RecoveryCheckpointSchema.parse({ ...checkpoint, codec: { ...checkpoint.codec, version: 2 } });
    expect(decodeWorkflowAggregateCheckpointState(downgraded))
      .toEqual({ ok: false, error: { code: "validation", retryable: false, message: "Parked tasks require aggregate codec 3" } });
    const restarted = new DeterministicWorkflowEngine({ definitions: [AB_C()] });
    expect(await restarted.recover({ runId: driver.state.snapshot.runId, checkpoint: downgraded, events: [],
      expectedVersion: checkpoint.version })).toMatchObject({ ok: false, error: { message: "Parked tasks require aggregate codec 3" } });
    const recovered = unwrap(await restarted.recover({ runId: driver.state.snapshot.runId, checkpoint, events: [],
      expectedVersion: checkpoint.version }));
    expect(statusOf(recovered, "a")).toBe("parked");
    expect(recovered.snapshot.status).toBe("blocked");

    // Full history replay accepts park and unpark transitions.
    const unparked = await driver.move("a", "ready", "unpark");
    const history = await collect(driver);
    const replayed = unwrap(await new DeterministicWorkflowEngine({ definitions: [AB_C()] }).recover({ runId: driver.state.snapshot.runId,
      events: history, expectedVersion: unparked.snapshot.version }));
    expect(replayed.snapshot).toEqual(unparked.snapshot);
  });
});

/** Every durable event so far, read back from a codec checkpoint's command receipts. */
async function collect(driver: Driver): Promise<DomainEvent[]> {
  const checkpoint = unwrap(await driver.engine.createCheckpoint({ runId: driver.state.snapshot.runId,
    expectedVersion: driver.state.snapshot.version, checkpointId: `collect-${driver.state.snapshot.version}`, createdAt: later }));
  const state = decodeWorkflowAggregateCheckpointState(checkpoint);
  if (!state.ok) throw new Error(state.error.message);
  return state.value.commands.flatMap((command) => command.result.emittedEvents);
}
