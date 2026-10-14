import type { DatabaseSync } from "node:sqlite";
import { StoreFailure } from "./support.js";

export const DATABASE_SCHEMA_VERSION = 1;
export const migrations = [{ version: 1, sql: `
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, version INTEGER NOT NULL CHECK(version >= 0),
    last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
    base_sequence INTEGER NOT NULL CHECK(base_sequence >= 0), base_version INTEGER NOT NULL CHECK(base_version >= 0),
    payload TEXT NOT NULL, digest TEXT NOT NULL
  ) STRICT;
  CREATE INDEX runs_workflow_status ON runs(workflow_id, status, run_id);
  CREATE INDEX runs_created_at ON runs(created_at, run_id);
  CREATE TABLE events (
    event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
    sequence INTEGER NOT NULL CHECK(sequence > 0), version INTEGER NOT NULL CHECK(version > 0),
    idempotency_key TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL,
    UNIQUE(run_id, sequence), UNIQUE(run_id, version), UNIQUE(run_id, idempotency_key)
  ) STRICT;
  CREATE TABLE receipts (
    operation TEXT NOT NULL, scope TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY(operation, scope, idempotency_key)
  ) STRICT;
  CREATE TABLE command_receipts (
    run_id TEXT NOT NULL REFERENCES runs(run_id), idempotency_key TEXT NOT NULL,
    command_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
    PRIMARY KEY(run_id, idempotency_key), UNIQUE(run_id, command_id)
  ) STRICT;
  CREATE TABLE checkpoints (
    checkpoint_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
    version INTEGER NOT NULL, event_sequence INTEGER NOT NULL,
    payload TEXT NOT NULL, digest TEXT NOT NULL
  ) STRICT;
  CREATE INDEX checkpoint_position ON checkpoints(run_id, version DESC, event_sequence DESC, checkpoint_id);
` }] as const;

export function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (typeof version !== "number" || version > DATABASE_SCHEMA_VERSION) {
      throw new StoreFailure({ code: "unsupported_version", retryable: false, supportedVersions: [0, 1],
        receivedVersion: typeof version === "number" ? version : 0, message: "Unsupported database schema" });
    }
    for (const migration of migrations) {
      if (migration.version > version) {
        db.exec(migration.sql);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
