import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainEventSchema, StoredRunSchema, type DomainEvent } from "@bflow/contracts";
import { runCreatedEvent, workflow } from "../../contracts/test/fixtures.js";
import { openSqliteRunStore, SqliteRunStore } from "../src/index.js";

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

describe("Round 2 Slice 5 persistence RunStore hardening", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "bflow-r2s5-run-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });

  it("preserves the primary StoreFailure / SQLITE_BUSY conflict error when SQLite has already auto-rolled back the transaction", async () => {
    const opened = await openSqliteRunStore({ filename: join(folder, "runs.sqlite"), busyTimeoutMs: 250 });
    if (!opened.ok) throw new Error(opened.error.message);
    const store = opened.value;

    try {
      await store.create(seedRun("run-1"), "create-1");

      // Simulate SQLite auto-rollback on a mid-transaction statement error (e.g. SQLITE_BUSY),
      // after which ROLLBACK throws "cannot rollback - no transaction is active"
      const internalDb = (store as unknown as { db: DatabaseSync }).db;
      const origExec = internalDb.exec.bind(internalDb);
      const origPrepare = internalDb.prepare.bind(internalDb);

      vi.spyOn(internalDb, "prepare").mockImplementation(((sql: string) => {
        if (sql.includes("INSERT INTO events")) {
          // Force auto-rollback inside SQLite and throw SQLITE_BUSY
          try {
            origExec("ROLLBACK");
          } catch {
            // ignore
          }
          throw Object.assign(new Error("database is locked"), { errcode: 5, errstr: "database is locked" });
        }
        return origPrepare(sql);
      }) as typeof internalDb.prepare);

      const appended = await store.appendEvents({
        runId: "run-1",
        expectedVersion: 0,
        expectedLastSequence: 0,
        events: [createdEv("run-1")],
        idempotencyKey: "append-busy"
      });

      // Must surface the real retryable SQLITE_BUSY conflict, NOT a masked `corruption` error from `ROLLBACK`!
      expect(appended).toMatchObject({
        ok: false,
        error: { code: "conflict", retryable: true }
      });

      vi.restoreAllMocks();

      // Store remains consistent and usable at version 0 after rollback
      const loaded = await store.get("run-1");
      expect(loaded).toMatchObject({
        ok: true,
        value: { snapshot: { version: 0, lastEventSequence: 0 } }
      });
    } finally {
      store.close();
    }
  });

  it("rejects directory and symlink collisions on filename before opening DatabaseSync", async () => {
    const dirDb = join(folder, "dir.sqlite");
    await mkdir(dirDb);
    const openedDir = await openSqliteRunStore({ filename: dirDb });
    expect(openedDir).toMatchObject({ ok: false, error: { code: "validation" } });

    const targetDb = join(folder, "real.sqlite");
    await writeFile(targetDb, "");
    const symlinkDb = join(folder, "link.sqlite");
    await symlink(targetDb, symlinkDb);
    const openedSymlink = await openSqliteRunStore({ filename: symlinkDb });
    expect(openedSymlink).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(SqliteRunStore).toBeDefined();
  });
});
