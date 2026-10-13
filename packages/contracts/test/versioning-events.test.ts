import { describe, expect, it } from "vitest";
import {
  AppendEventsRequestSchema,
  DomainEventSchema,
  RecoveryCheckpointSchema,
  decodeWorkflowRunCheckpointState,
  parseDomainEventWithCompatibility,
  parseRecoveryCheckpointWithCompatibility,
  validateEventBatch
} from "../src/index.js";
import { handle, later, now, runCreatedEvent } from "./fixtures.js";

describe("domain event compatibility", () => {
  it("round-trips the current event version", () => {
    const parsed = DomainEventSchema.parse(runCreatedEvent());
    expect(DomainEventSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("upcasts a legacy P00 event without schemaVersion", () => {
    const legacy = runCreatedEvent({ sequence: 0, aggregateVersion: 0 });
    const { schemaVersion: _schemaVersion, ...withoutVersion } = legacy;
    const result = parseDomainEventWithCompatibility(withoutVersion);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.schemaVersion).toBe(1);
  });

  it("rejects unsupported event versions with a typed error", () => {
    const result = parseDomainEventWithCompatibility({ ...runCreatedEvent(), schemaVersion: 9 });
    expect(result).toMatchObject({ ok: false, error: { code: "unsupported_version", receivedVersion: 9 } });
  });

  it("rejects a malformed event version", () => {
    const result = parseDomainEventWithCompatibility({ ...runCreatedEvent(), schemaVersion: "1" });
    expect(result).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

describe("checkpoint compatibility", () => {
  const legacyCheckpoint = {
    checkpointId: "checkpoint-1",
    runId: "run-1",
    eventSequence: 3,
    version: 3,
    state: {
      runId: "run-1",
      workflowId: "delivery",
      workflowVersion: "1.0.0",
      status: "running",
      tasks: [
        {
          taskId: "build",
          status: "running",
          attempt: 1,
          generation: 0,
          attemptId: "attempt-1",
          agentExecution: handle,
          startedAt: now,
          version: 1
        }
      ],
      createdAt: now,
      updatedAt: later,
      version: 3,
      lastEventSequence: 3
    },
    createdAt: now
  };

  it("upcasts legacy checkpoint codec metadata and round-trips", () => {
    const result = parseRecoveryCheckpointWithCompatibility(legacyCheckpoint);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(RecoveryCheckpointSchema.parse(result.value)).toEqual(result.value);
      expect(decodeWorkflowRunCheckpointState(result.value)).toMatchObject({
        ok: true,
        value: { tasks: [{ agentExecution: { executionId: "execution-1" } }] }
      });
    }
  });

  it("rejects unsupported checkpoint versions", () => {
    expect(
      parseRecoveryCheckpointWithCompatibility({ ...legacyCheckpoint, checkpointSchemaVersion: 2 })
    ).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
  });

  it("reports corruption when checkpoint state does not match its codec", () => {
    const result = parseRecoveryCheckpointWithCompatibility({ ...legacyCheckpoint, state: { status: "running" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(decodeWorkflowRunCheckpointState(result.value)).toMatchObject({ ok: false, error: { code: "corruption" } });
  });
});

describe("event batch invariants", () => {
  it("accepts a contiguous batch for one aggregate", () => {
    const request = {
      runId: "run-1",
      expectedVersion: 0,
      expectedLastSequence: 0,
      events: [runCreatedEvent()],
      idempotencyKey: "append-1"
    };
    expect(validateEventBatch(request)).toEqual([]);
    expect(AppendEventsRequestSchema.safeParse(request).success).toBe(true);
  });

  it.each([
    ["wrong run", { runId: "other-run" }],
    ["sequence gap", { sequence: 2 }],
    ["version gap", { aggregateVersion: 2 }]
  ])("rejects %s", (_name, eventOverrides) => {
    const request = {
      runId: "run-1",
      expectedVersion: 0,
      expectedLastSequence: 0,
      events: [runCreatedEvent(eventOverrides)],
      idempotencyKey: "append-1"
    };
    expect(AppendEventsRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects duplicate event and idempotency identities", () => {
    const first = runCreatedEvent();
    const second = runCreatedEvent({ sequence: 2, aggregateVersion: 2 });
    const issues = validateEventBatch({
      runId: "run-1",
      expectedVersion: 0,
      expectedLastSequence: 0,
      events: [first, second]
    });
    expect(issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(["eventId", "idempotencyKey"]));
  });
});
