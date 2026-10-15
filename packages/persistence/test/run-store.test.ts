import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "../src/sqlite.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { AppendEventsRequestSchema, DomainEventSchema, RecoveryCheckpointSchema, StoredRunSchema, type OperationResult } from "@bflow/contracts";
import { now, workflow, runCreatedEvent } from "../../contracts/test/fixtures.js";
import { eventTailCursor, openSqliteRunStore, type SqliteRunStore } from "../src/index.js";

function value<T>(result: OperationResult<T>): T {
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function seed(id = "run-1") {
  const definition = workflow([]);
  return StoredRunSchema.parse({ definition, snapshot: { runId: id, workflowId: definition.id, workflowVersion: definition.version,
    status: "queued", tasks: definition.tasks.map((task) => ({ taskId: task.id, status: "pending", attempt: 0, generation: 0, version: 0 })),
    createdAt: now, updatedAt: now, version: 0, lastEventSequence: 0 } });
}
function batch() {
  return AppendEventsRequestSchema.parse({ runId: "run-1", expectedVersion: 0, expectedLastSequence: 0,
    idempotencyKey: "append-1", events: [runCreatedEvent()] });
}
function statusEvent(sequence: number, from: string, to: string, eventId = `event-${sequence}`) {
  return DomainEventSchema.parse({ ...runCreatedEvent(), sequence, aggregateVersion: sequence,
    eventId, idempotencyKey: `event-key-${eventId}`, type: "run.status_changed", payload: { from, to } });
}
describe("SQLite RunStore", () => {
  let directory: string;
  let filename: string;
  let store: SqliteRunStore;
  const stores: SqliteRunStore[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bflow-p03-runs-"));
    filename = join(directory, "runs.sqlite");
    store = value(openSqliteRunStore({ filename })); stores.push(store);
  });
  afterEach(async () => { for (const item of stores.splice(0)) item.close(); await rm(directory, { recursive: true, force: true }); });
  async function create() { value(await store.create(seed(), "create-1")); }
  async function initial() { await create(); value(await store.appendEvents(batch())); }
  function checkpoint() {
    return RecoveryCheckpointSchema.parse({ checkpointSchemaVersion: 1, codec: { name: "bflow.workflow-run-snapshot+json", version: 1 },
      checkpointId: "cp-1", runId: "run-1", version: 0, eventSequence: 0, state: seed().snapshot, createdAt: now });
  }
  function raw() { return new DatabaseSync(filename); }
  function corrupt(table: string, payload: unknown) {
    const db = raw(); const text = JSON.stringify(payload);
    db.prepare(`UPDATE ${table} SET payload=?,digest=?`).run(text, createHash("sha256").update(text).digest("hex")); db.close();
  }

  it("initializes versioned migrations, foreign keys and WAL", () => {
    const db = raw();
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)).toEqual(
      expect.arrayContaining(["runs", "events", "receipts", "command_receipts", "checkpoints"]));
    expect(db.prepare("PRAGMA foreign_key_list(events)").all()).toHaveLength(1);
    db.close();
  });
  it("migrations are repeatable across reopen", async () => {
    await initial(); store.close(); store = value(openSqliteRunStore({ filename })); stores.push(store);
    expect(value(await store.get("run-1"))?.snapshot.version).toBe(1);
    expect(value(await store.readEvents("run-1")).items).toEqual(batch().events);
  });
  it("rejects newer database schema rather than downgrading", () => {
    store.close(); const db = raw(); db.exec("PRAGMA user_version=2"); db.close();
    expect(openSqliteRunStore({ filename })).toMatchObject({ ok: false, error: { code: "unsupported_version", receivedVersion: 2 } });
  });
  it("requires file-backed configuration and returns a typed open failure", () => {
    expect(openSqliteRunStore({ filename: ":memory:" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(openSqliteRunStore({ filename: join(directory, "absent", "db") }).ok).toBe(false);
  });
  it("creates and returns cloned data, with durable create receipt", async () => {
    const run = seed(); const returned = value(await store.create(run, "create-1")); returned.snapshot.status = "failed";
    run.definition.name = "changed";
    expect(value(await store.get("run-1"))?.snapshot.status).toBe("queued");
    store.close(); store = value(openSqliteRunStore({ filename })); stores.push(store);
    expect(value(await store.create(seed(), "create-1"))).toEqual(seed());
  });
  it("rejects create receipt fingerprint collision", async () => {
    await create(); const other = seed(); other.definition.name = "different";
    expect(await store.create(other, "create-1")).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("rejects incompatible workflow or duplicate snapshot task IDs", async () => {
    const input = seed(); input.snapshot.workflowId = "wrong";
    expect(await store.create(input, "create")).toMatchObject({ ok: false, error: { code: "validation" } });
    const duplicate = seed(); duplicate.snapshot.tasks.push(duplicate.snapshot.tasks[0]!);
    expect((await store.create(duplicate, "create")).ok).toBe(false);
  });
  it("atomically appends and maintains version and status index", async () => {
    await create(); const request = batch(); request.events.push(statusEvent(2, "queued", "running"));
    expect(value(await store.appendEvents(request))).toEqual({ version: 2, lastSequence: 2, duplicate: false, duplicateEventIds: [] });
    expect(value(await store.get("run-1"))?.snapshot).toMatchObject({ status: "running", version: 2, lastEventSequence: 2 });
    expect(value(await store.find({ status: ["running"] })).items).toHaveLength(1);
  });
  it("rejects stale expected version and does not write", async () => {
    await initial();
    expect(await store.appendEvents({ ...batch(), idempotencyKey: "another" })).toMatchObject({ ok: false, error: { code: "conflict", version: { expected: 0, actual: 1 } } });
    expect(value(await store.readEvents("run-1")).items).toHaveLength(1);
  });
  it("rejects stale stream position independently of aggregate version", async () => {
    await initial();
    const request = { ...batch(), expectedVersion: 1, idempotencyKey: "tail", events: [{ ...statusEvent(2, "queued", "running"), sequence: 1 }] };
    expect(await store.appendEvents(request)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("returns the original append outcome after duplicate replay and restart", async () => {
    await initial(); store.close(); store = value(openSqliteRunStore({ filename })); stores.push(store);
    expect(value(await store.appendEvents(batch()))).toEqual({ version: 1, lastSequence: 1, duplicate: true, duplicateEventIds: ["event-1"] });
    expect(value(await store.get("run-1"))?.snapshot.version).toBe(1);
  });
  it("rejects append key collision even after state advances", async () => {
    await initial(); const different = batch(); different.events[0]!.occurredAt = "2026-10-14T00:00:00Z";
    expect(await store.appendEvents(different)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("deduplicates 12 concurrent identical appends", async () => {
    await create(); const results = await Promise.all(Array.from({ length: 12 }, () => store.appendEvents(batch())));
    expect(results.filter((result) => result.ok && !result.value.duplicate)).toHaveLength(1);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(value(await store.readEvents("run-1")).items).toHaveLength(1);
  });
  it("only one connection can commit a given optimistic version", async () => {
    await create(); const second = value(openSqliteRunStore({ filename })); stores.push(second);
    const results = await Promise.all([store.appendEvents(batch()), second.appendEvents({ ...batch(), idempotencyKey: "writer-2",
      events: [{ ...batch().events[0]!, eventId: "event-other", idempotencyKey: "event-other" }] })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.code === "conflict")).toHaveLength(1);
  });
  it("serializes actual multi-process writers on a local SQLite file", async () => {
    await create();
    const module = new URL("../dist/index.js", import.meta.url).href;
    const script = `import {openSqliteRunStore} from ${JSON.stringify(module)}; const opened=openSqliteRunStore({filename:process.argv[1]});
      if(!opened.ok) throw new Error(JSON.stringify(opened.error)); const result=await opened.value.appendEvents(JSON.parse(process.argv[2]));
      opened.value.close(); console.log(JSON.stringify(result));`;
    const execute = promisify(execFile);
    const results = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const request = batch(); request.idempotencyKey = `process-${index}`;
      request.events[0]!.eventId = `process-event-${index}`; request.events[0]!.idempotencyKey = `process-event-${index}`;
      return JSON.parse((await execute(process.execPath, ["--input-type=module", "-e", script, filename, JSON.stringify(request)])).stdout);
    }));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.error?.code === "conflict")).toHaveLength(3);
  });
  it.each(["sequence", "aggregateVersion", "runId", "eventId", "idempotencyKey"])("rejects invalid batch %s before any durable effect", async (field) => {
    await create(); const request = batch(); request.events.push(statusEvent(2, "queued", "running"));
    const second = request.events[1]!;
    if (field === "sequence" || field === "aggregateVersion") second[field] = 5;
    else if (field === "runId") second.runId = "other";
    else if (field === "eventId") second.eventId = request.events[0]!.eventId;
    else second.idempotencyKey = request.events[0]!.idempotencyKey;
    expect(await store.appendEvents(request)).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(value(await store.readEvents("run-1")).items).toHaveLength(0);
    expect(value(await store.get("run-1"))?.snapshot.version).toBe(0);
  });
  it("rolls back an earlier inserted event when a later globally duplicate event fails", async () => {
    await initial();
    const request = { runId: "run-1", expectedVersion: 1, expectedLastSequence: 1, idempotencyKey: "rollback",
      events: [statusEvent(2, "queued", "running"), statusEvent(3, "running", "blocked", "event-1")] };
    expect(await store.appendEvents(request)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(value(await store.get("run-1"))?.snapshot.status).toBe("queued");
    expect(value(await store.readEvents("run-1")).items).toHaveLength(1);
    expect(await store.appendEvents({ ...request, events: [request.events[0]!] })).toMatchObject({ ok: true });
  });
  it("persists command.completed and prevents duplicate command ledger entries atomically", async () => {
    await create(); const request = batch();
    request.events.push(DomainEventSchema.parse({ ...runCreatedEvent(), sequence: 2, aggregateVersion: 2, eventId: "receipt-1", idempotencyKey: "receipt-event-1",
      type: "command.completed", payload: { schemaVersion: 1, commandId: "cmd-1", idempotencyKey: "cmd-key", operation: "createRun",
        fingerprint: "a".repeat(64), firstEventSequence: 1, runnableTaskIds: [] } }));
    value(await store.appendEvents(request));
    const db = raw(); expect(db.prepare("SELECT count(*) AS n FROM command_receipts").get()?.n).toBe(1); db.close();
    const event = { ...request.events[1]!, sequence: 3, aggregateVersion: 3, eventId: "receipt-2", idempotencyKey: "receipt-event-2" };
    expect(await store.appendEvents({ runId: "run-1", expectedVersion: 2, expectedLastSequence: 2, idempotencyKey: "duplicate-command", events: [event] }))
      .toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(value(await store.readEvents("run-1")).items).toEqual(request.events);
  });
  it("returns full ordered history, pages and checkpoint tail cursor", async () => {
    await create(); const request = batch(); request.events.push(statusEvent(2, "queued", "running"), statusEvent(3, "running", "blocked"));
    value(await store.appendEvents(request));
    const first = value(await store.readEvents("run-1", { limit: 1 }));
    const second = value(await store.readEvents("run-1", { limit: 1, cursor: first.nextCursor }));
    const third = value(await store.readEvents("run-1", { cursor: second.nextCursor }));
    expect([...first.items, ...second.items, ...third.items]).toEqual(request.events);
    expect(third.nextCursor).toBeUndefined();
    expect(value(await store.readEvents("run-1", { cursor: eventTailCursor("run-1", 2) })).items.map((event) => event.sequence)).toEqual([3]);
  });
  it("queries run filters with stable pagination and cursor scope checking", async () => {
    for (const id of ["a", "b", "c"]) value(await store.create(seed(id), `create-${id}`));
    const first = value(await store.find({ limit: 2, workflowId: "delivery" }));
    expect(first.items.map((run) => run.snapshot.runId)).toEqual(["a", "b"]);
    expect(value(await store.find({ workflowId: "delivery", cursor: first.nextCursor })).items.map((run) => run.snapshot.runId)).toEqual(["c"]);
    expect(await store.find({ workflowId: "other", cursor: first.nextCursor })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(value(await store.find({ createdAfter: "2026-10-14T00:00:00Z" })).items).toHaveLength(0);
    expect(value(await store.find({ createdBefore: "2026-10-14T00:00:00Z", status: ["queued"] })).items).toHaveLength(3);
    expect(value(await store.find({ status: [] })).items).toHaveLength(0);
  });
  it("handles missing records and invalid queries explicitly", async () => {
    expect(value(await store.get("missing"))).toBeNull();
    expect(value(await store.loadLatestCheckpoint("missing"))).toBeNull();
    expect(await store.readEvents("missing")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await store.appendEvents(batch())).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await store.find({ limit: 0 })).toMatchObject({ ok: false, error: { code: "validation" } });
    await create(); expect(await store.readEvents("run-1", { cursor: "not-json" })).toMatchObject({ ok: false, error: { code: "validation" } });
  });
  it("saves snapshot checkpoint and preserves state after reopen", async () => {
    await create(); value(await store.saveCheckpoint(checkpoint(), 0));
    store.close(); store = value(openSqliteRunStore({ filename })); stores.push(store);
    expect(value(await store.loadLatestCheckpoint("run-1"))).toEqual(checkpoint());
    value(await store.saveCheckpoint(checkpoint(), 0));
  });
  it("round-trips the complete aggregate checkpoint without reconstructing auxiliary state", async () => {
    await create(); const aggregate = checkpoint(); aggregate.codec = { name: "bflow.workflow-aggregate+json", version: 1 };
    aggregate.state = { schemaVersion: 1, snapshot: seed().snapshot, approvals: [], gateRequests: [], gateOutcomes: [],
      successfulAttempts: [], cancellations: [], retrySchedules: [], attemptBaselines: [], commands: [] };
    value(await store.saveCheckpoint(aggregate, 0));
    expect(value(await store.loadLatestCheckpoint("run-1"))).toEqual(aggregate);
  });
  it("retains approval, gate, retry and original command outcome data in aggregate checkpoints", async () => {
    await create(); const aggregate = checkpoint(); aggregate.codec = { name: "bflow.workflow-aggregate+json", version: 1 };
    aggregate.state = { schemaVersion: 1, snapshot: seed().snapshot,
      approvals: [{ request: { schemaVersion: 1, approvalId: "approval-1", runId: "run-1", target: { type: "run" }, revision: 1,
        generation: 0, requestedBy: "reviewer", requestedAt: now, reason: "review", evidence: [], idempotencyKey: "approval-request" },
        decision: { schemaVersion: 1, approvalId: "approval-1", runId: "run-1", target: { type: "run" }, revision: 1,
          generation: 0, decidedBy: "human", decidedAt: now, decision: "approved", feedbackArtifacts: [], idempotencyKey: "approve" } }],
      gateRequests: [{ evaluationId: "evaluation-1", gateId: "gate-1", generation: 0, phase: "before_dispatch" }],
      gateOutcomes: [{ gateId: "gate-1", generation: 0, phase: "before_dispatch", status: "passed" }],
      successfulAttempts: [], cancellations: [],
      retrySchedules: [{ taskId: "build", generation: 0, attempt: 1, attemptId: "attempt-1", eligibleAt: now }],
      attemptBaselines: [{ taskId: "build", generation: 0, baseline: 0 }],
      commands: [{ receipt: { schemaVersion: 1, commandId: "cmd-1", idempotencyKey: "cmd-key", operation: "advance",
        fingerprint: "a".repeat(64), firstEventSequence: 1, runnableTaskIds: [] }, result: { snapshot: seed().snapshot, runnableTaskIds: [], emittedEvents: [] } }] };
    value(await store.saveCheckpoint(aggregate, 0)); store.close(); store = value(openSqliteRunStore({ filename })); stores.push(store);
    expect(value(await store.loadLatestCheckpoint("run-1"))).toEqual(aggregate);
  });
  it("rejects checkpoint workflow identity or task ownership mismatch", async () => {
    await create(); const cp = checkpoint(); cp.state = { ...seed().snapshot, workflowId: "other" };
    expect(await store.saveCheckpoint(cp, 0)).toMatchObject({ ok: false, error: { code: "corruption" } });
  });
  it("chooses latest checkpoint by stream position and supports tail queries", async () => {
    await create(); value(await store.saveCheckpoint(checkpoint(), 0)); value(await store.appendEvents(batch()));
    const newer = checkpoint(); newer.checkpointId = "cp-2"; newer.version = 1; newer.eventSequence = 1;
    newer.state = value(await store.get("run-1"))!.snapshot;
    value(await store.saveCheckpoint(newer, 1));
    expect(value(await store.loadLatestCheckpoint("run-1"))).toEqual(newer);
    expect(value(await store.readEvents("run-1", { cursor: eventTailCursor("run-1", 1) })).items).toEqual([]);
  });
  it("projects task events without inventing execution identity or business success", async () => {
    await create(); const request = batch();
    const taskEvent = (sequence: number, from: string, to: string, attempt: number) => DomainEventSchema.parse({ ...runCreatedEvent(),
      sequence, aggregateVersion: sequence, eventId: `task-${sequence}`, idempotencyKey: `task-${sequence}`, taskId: "build",
      type: "task.status_changed", payload: { from, to, intent: "normal", attempt, generationFrom: 0, generationTo: 0 } });
    request.events.push(taskEvent(2, "pending", "ready", 0), taskEvent(3, "ready", "running", 1));
    value(await store.appendEvents(request));
    expect(value(await store.get("run-1"))?.snapshot.tasks.find((task) => task.taskId === "build"))
      .toMatchObject({ status: "running", attempt: 1, generation: 0, version: 2, startedAt: now });
    expect(value(await store.get("run-1"))?.snapshot.tasks.find((task) => task.taskId === "build")?.attemptId).toBeUndefined();
    expect(value(await store.readEvents("run-1")).items).toEqual(request.events);
  });
  it("rejects stale checkpoint version and conflicting checkpoint ID", async () => {
    await create(); value(await store.saveCheckpoint(checkpoint(), 0));
    const changed = checkpoint(); changed.createdAt = "2026-10-14T00:00:00Z";
    expect(await store.saveCheckpoint(changed, 0)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await store.saveCheckpoint(checkpoint(), 1)).toMatchObject({ ok: false, error: { code: "conflict", version: { expected: 1, actual: 0 } } });
  });
  it("rejects unsupported checkpoint and event schema versions", async () => {
    await create();
    expect(await store.saveCheckpoint({ ...checkpoint(), checkpointSchemaVersion: 2 } as unknown as ReturnType<typeof checkpoint>, 0))
      .toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    const request = batch(); request.events[0] = { ...request.events[0], schemaVersion: 2 } as typeof request.events[number];
    expect(await store.appendEvents(request)).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
  });
  it("rejects unsupported checkpoint codec version with a typed compatibility error", async () => {
    await create(); const cp = checkpoint();
    expect(await store.saveCheckpoint({ ...cp, codec: { ...cp.codec, version: 2 } } as unknown as typeof cp, 0))
      .toMatchObject({ ok: false, error: { code: "unsupported_version", receivedVersion: 2, supportedVersions: [1] } });
  });
  it("detects schema-valid checkpoint corruption in workflow ownership", async () => {
    await create(); value(await store.saveCheckpoint(checkpoint(), 0));
    corrupt("checkpoints", { ...checkpoint(), state: { ...seed().snapshot, workflowId: "other" } });
    expect(await store.loadLatestCheckpoint("run-1")).toMatchObject({ ok: false, error: { code: "corruption" } });
  });
  it("rejects positions beyond the supported safe integer range", async () => {
    const unsafe = seed(); unsafe.snapshot.version = Number.MAX_SAFE_INTEGER + 1;
    expect(await store.create(unsafe, "unsafe")).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(value(await store.get("run-1"))).toBeNull();
  });
  it("upcasts legacy envelopes without inventing state", async () => {
    await create(); const request = batch(); delete (request.events[0] as unknown as Record<string, unknown>).schemaVersion;
    value(await store.appendEvents(request));
    expect(value(await store.readEvents("run-1")).items[0]?.schemaVersion).toBe(1);
  });
  it("rejects corrupted codec state and mismatched checkpoint position", async () => {
    await create();
    expect(await store.saveCheckpoint({ ...checkpoint(), state: { status: "queued" } }, 0)).toMatchObject({ ok: false, error: { code: "corruption" } });
    expect(await store.saveCheckpoint({ ...checkpoint(), version: 3 }, 0)).toMatchObject({ ok: false, error: { code: "corruption" } });
  });
  it("reports corrupted stored checkpoint rather than falling back silently", async () => {
    await create(); value(await store.saveCheckpoint(checkpoint(), 0)); corrupt("checkpoints", { ...checkpoint(), state: {} });
    expect(await store.loadLatestCheckpoint("run-1")).toMatchObject({ ok: false, error: { code: "corruption" } });
  });
  it("detects payload checksum and schema corruption", async () => {
    await initial(); const db = raw(); db.exec("UPDATE runs SET payload='{}'"); db.close();
    expect(await store.get("run-1")).toMatchObject({ ok: false, error: { code: "corruption" } });
  });
  it("rejects invalid stored event and missing history", async () => {
    await initial(); corrupt("events", { ...batch().events[0], payload: {} });
    expect(await store.readEvents("run-1")).toMatchObject({ ok: false, error: { code: "corruption" } });
    const db = raw(); db.exec("DELETE FROM events"); db.close();
    expect(await store.readEvents("run-1")).toMatchObject({ ok: false, error: { code: "corruption" } });
  });
  it("maps future stored event/checkpoint versions to unsupported_version", async () => {
    await initial(); corrupt("events", { ...batch().events[0], schemaVersion: 7 });
    expect(await store.readEvents("run-1")).toMatchObject({ ok: false, error: { code: "unsupported_version", receivedVersion: 7 } });
    const cp = checkpoint(); cp.version = 1; cp.eventSequence = 1; cp.state = value(await store.get("run-1"))!.snapshot;
    value(await store.saveCheckpoint(cp, 1)); corrupt("checkpoints", { ...cp, checkpointSchemaVersion: 7 });
    expect(await store.loadLatestCheckpoint("run-1")).toMatchObject({ ok: false, error: { code: "unsupported_version", receivedVersion: 7 } });
  });
  it("detects a missing middle event in paginated history", async () => {
    await create(); const request = batch(); request.events.push(statusEvent(2, "queued", "running"), statusEvent(3, "running", "blocked"));
    value(await store.appendEvents(request)); const db = raw(); db.exec("DELETE FROM events WHERE sequence=2"); db.close();
    const page = value(await store.readEvents("run-1", { limit: 1 }));
    expect(await store.readEvents("run-1", { cursor: page.nextCursor })).toMatchObject({ ok: false, error: { code: "corruption" } });
  });
  it("permits a declared nonzero import baseline without fabricating older history", async () => {
    const imported = seed(); imported.snapshot.version = 5; imported.snapshot.lastEventSequence = 8;
    value(await store.create(imported, "import"));
    value(await store.appendEvents({ runId: "run-1", expectedVersion: 5, expectedLastSequence: 8, idempotencyKey: "tail",
      events: [{ ...statusEvent(9, "queued", "running"), aggregateVersion: 6 }] }));
    expect(value(await store.readEvents("run-1")).items.map((event) => event.sequence)).toEqual([9]);
  });
  it.each([{ timeoutMs: 0 }, { deadline: "2020-01-01T00:00:00Z" }, { timeoutMs: -1 }, { deadline: "invalid" }])("no mutation for invalid/expired options %j", async (options) => {
    expect((await store.create(seed(), "create", options)).ok).toBe(false);
    expect(value(await store.get("run-1"))).toBeNull();
  });
  it("rolls back when deadline expires after acquiring the SQLite lock", async () => {
    await create(); let time = 0;
    const timed = value(openSqliteRunStore({ filename, clock: () => time++ })); stores.push(timed);
    expect(await timed.appendEvents(batch(), { deadline: new Date(4).toISOString() })).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started" } });
    expect(value(await store.get("run-1"))?.snapshot.version).toBe(0);
  });
  it("maps busy locks to conflict without partial writes", async () => {
    const busy = value(openSqliteRunStore({ filename, busyTimeoutMs: 0 })); stores.push(busy);
    await create(); const db = raw(); db.exec("BEGIN IMMEDIATE");
    expect(await busy.appendEvents(batch())).toMatchObject({ ok: false, error: { code: "conflict" } });
    db.exec("ROLLBACK"); db.close();
    expect((await busy.appendEvents(batch())).ok).toBe(true);
  });
  it("returns retry-safe timeout if its budget expires waiting for a process-held write lock", async () => {
    await create();
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked');
      process.stdin.once('data',()=>{db.exec('ROLLBACK');db.close();process.exit(0)});`, filename], { stdio: ["pipe", "pipe", "pipe"] });
    const ended = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    try {
      expect(await store.appendEvents(batch(), { timeoutMs: 25 })).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started" } });
      expect(value(await store.get("run-1"))?.snapshot.version).toBe(0);
    } finally { child.stdin.end("release"); await ended; }
  });
  it("aborts before mutation and closes connections idempotently", async () => {
    const controller = new AbortController(); controller.abort();
    expect(await store.create(seed(), "create", { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    store.close(); store.close();
    expect(await store.get("run-1")).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});
