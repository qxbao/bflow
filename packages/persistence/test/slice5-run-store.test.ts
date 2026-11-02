import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AppendEventsRequestSchema,
  DomainEventSchema,
  StoredRunSchema,
  type DomainEvent
} from "@bflow/contracts";
import { workflow, runCreatedEvent } from "../../contracts/test/fixtures.js";
import { openSqliteRunStore, type SqliteRunStore } from "../src/index.js";

function seedRun(id: string, ts = "2026-10-31T00:00:00.000Z") {
  const definition = workflow([]);
  return StoredRunSchema.parse({
    definition,
    snapshot: {
      runId: id,
      workflowId: definition.id,
      workflowVersion: definition.version,
      status: "queued",
      tasks: definition.tasks.map((task) => ({
        taskId: task.id,
        status: "pending",
        attempt: 0,
        generation: 0,
        version: 0
      })),
      createdAt: ts,
      updatedAt: ts,
      version: 0,
      lastEventSequence: 0
    }
  });
}

function createdEv(runId: string, ts = "2026-10-31T00:00:00.000Z"): DomainEvent {
  return DomainEventSchema.parse({
    ...runCreatedEvent(),
    runId,
    eventId: `${runId}-ev-1`,
    idempotencyKey: `${runId}-k-1`,
    occurredAt: ts,
    sequence: 1,
    aggregateVersion: 1
  });
}

function runStatusEv(runId: string, seq: number, from: string, to: string, ts = "2026-10-31T00:00:00.000Z"): DomainEvent {
  return DomainEventSchema.parse({
    ...runCreatedEvent(),
    runId,
    eventId: `${runId}-ev-${seq}`,
    idempotencyKey: `${runId}-k-${seq}`,
    occurredAt: ts,
    sequence: seq,
    aggregateVersion: seq,
    type: "run.status_changed",
    payload: { from, to }
  });
}

describe("Slice 5 persistence RunStore regressions", () => {
  let folder: string;
  let store: SqliteRunStore;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "bflow-s5-db-"));
    const opened = openSqliteRunStore({
      filename: join(folder, "runs.db"),
      busyTimeoutMs: 3_000
    });
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
  });

  afterEach(async () => {
    store.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("restores SQLite PRAGMA busy_timeout after short-timeout write and read operations", async () => {
    const res = await store.create(seedRun("run-busy"), "create-busy", { timeoutMs: 500 });
    expect(res.ok).toBe(true);

    const afterWrite = (store as any).db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(afterWrite.timeout).toBe(3_000);

    const readRes = await store.get("run-busy", { timeoutMs: 500 });
    expect(readRes.ok).toBe(true);

    const afterRead = (store as any).db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(afterRead.timeout).toBe(3_000);
  });

  it("normalizes multi-status filters in find() so duplicate or reordered status sets keep pagination cursors stable", async () => {
    const ts = "2026-10-31T00:00:00.000Z";
    for (const [id, st] of [
      ["run-a", "queued"],
      ["run-b", "running"],
      ["run-c", "blocked"]
    ] as const) {
      expect((await store.create(seedRun(id, ts), `create-${id}`)).ok).toBe(true);
      const events: DomainEvent[] = [createdEv(id, ts)];
      if (st !== "queued") {
        events.push(runStatusEv(id, 2, "queued", "running", ts));
      }
      if (st === "blocked") {
        events.push(runStatusEv(id, 3, "running", "blocked", ts));
      }
      const appendRes = await store.appendEvents(
        AppendEventsRequestSchema.parse({
          runId: id,
          expectedVersion: 0,
          expectedLastSequence: 0,
          idempotencyKey: `append-${id}`,
          events
        })
      );
      expect(appendRes.ok).toBe(true);
    }

    const page1 = await store.find({
      status: ["running", "queued", "blocked", "queued"],
      limit: 1
    });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.items).toHaveLength(1);
    expect(page1.value.nextCursor).toBeDefined();

    // Equivalent status set in different order without duplicate
    const page2 = await store.find({
      status: ["blocked", "queued", "running"],
      limit: 2,
      cursor: page1.value.nextCursor
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    // ORDER BY run_id ASC => run-a on page 1, [run-b, run-c] on page 2
    expect(page2.value.items.map((r) => r.snapshot.runId)).toEqual(["run-b", "run-c"]);
    expect(page2.value.nextCursor).toBeUndefined();

    // Genuinely different status filter must still reject the cursor
    const mismatched = await store.find({
      status: ["queued", "running"],
      cursor: page1.value.nextCursor
    });
    expect(mismatched).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("preserves original task startedAt and clears blockage across blocked -> running transitions in projection", async () => {
    const seeded = seedRun("run-proj");
    const taskId = seeded.snapshot.tasks[0]!.taskId;
    expect((await store.create(seeded, "create-proj")).ok).toBe(true);

    const events: DomainEvent[] = [
      createdEv("run-proj", "2026-10-31T00:00:00.000Z"),
      DomainEventSchema.parse({
        ...runCreatedEvent(),
        runId: "run-proj",
        taskId,
        eventId: "proj-ev-2",
        idempotencyKey: "proj-k-2",
        occurredAt: "2026-10-31T00:00:01.000Z",
        sequence: 2,
        aggregateVersion: 2,
        type: "task.status_changed",
        payload: {
          from: "pending",
          to: "ready",
          intent: "normal",
          attempt: 0,
          generationFrom: 0,
          generationTo: 0
        }
      }),
      DomainEventSchema.parse({
        ...runCreatedEvent(),
        runId: "run-proj",
        taskId,
        eventId: "proj-ev-3",
        idempotencyKey: "proj-k-3",
        occurredAt: "2026-10-31T00:00:02.000Z",
        sequence: 3,
        aggregateVersion: 3,
        type: "task.status_changed",
        payload: {
          from: "ready",
          to: "running",
          intent: "normal",
          attempt: 1,
          generationFrom: 0,
          generationTo: 0
        }
      }),
      DomainEventSchema.parse({
        ...runCreatedEvent(),
        runId: "run-proj",
        taskId,
        eventId: "proj-ev-4",
        idempotencyKey: "proj-k-4",
        occurredAt: "2026-10-31T00:00:03.000Z",
        sequence: 4,
        aggregateVersion: 4,
        type: "task.status_changed",
        payload: {
          from: "running",
          to: "blocked",
          intent: "normal",
          attempt: 1,
          generationFrom: 0,
          generationTo: 0,
          blockage: {
            code: "manual_intervention",
            message: "uncertain transport",
            since: "2026-10-31T00:00:03.000Z",
            retryable: true
          }
        }
      }),
      DomainEventSchema.parse({
        ...runCreatedEvent(),
        runId: "run-proj",
        taskId,
        eventId: "proj-ev-5",
        idempotencyKey: "proj-k-5",
        occurredAt: "2026-10-31T00:00:04.000Z",
        sequence: 5,
        aggregateVersion: 5,
        type: "task.status_changed",
        payload: {
          from: "blocked",
          to: "running",
          intent: "normal",
          attempt: 1,
          generationFrom: 0,
          generationTo: 0
        }
      })
    ];

    const appended = await store.appendEvents(
      AppendEventsRequestSchema.parse({
        runId: "run-proj",
        expectedVersion: 0,
        expectedLastSequence: 0,
        idempotencyKey: "append-proj",
        events
      })
    );
    expect(appended.ok).toBe(true);

    const loaded = await store.get("run-proj");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || !loaded.value) return;

    expect(loaded.value.snapshot.tasks[0]?.startedAt).toBe("2026-10-31T00:00:02.000Z");
    expect(loaded.value.snapshot.tasks[0]?.blockage).toBeUndefined();
  });
});
