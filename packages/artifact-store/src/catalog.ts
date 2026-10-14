import type { DatabaseSync as DatabaseConnection } from "node:sqlite";
import { DatabaseSync } from "./sqlite.js";
import { ArtifactFailure } from "./support.js";

export function openCatalog(filename: string, storeId: string, busyTimeoutMs: number): DatabaseConnection {
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (typeof version !== "number" || version > 1) throw new ArtifactFailure({ code: "unsupported_version", retryable: false,
        supportedVersions: [0, 1], receivedVersion: typeof version === "number" ? version : 0, message: "Unsupported artifact catalog schema" });
      if (version === 0) db.exec(`
        CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL) STRICT;
        CREATE TABLE artifacts (
          artifact_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL,
          blob TEXT NOT NULL UNIQUE, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
          payload TEXT NOT NULL, digest TEXT NOT NULL
        ) STRICT;
        CREATE INDEX artifacts_query ON artifacts(deleted,run_id,task_id,kind,artifact_id);
        CREATE TABLE receipts (
          idempotency_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
          artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), payload TEXT NOT NULL, digest TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version=1;
      `);
      const identity = db.prepare("SELECT store_id FROM identity WHERE singleton=1").get();
      if (identity === undefined) db.prepare("INSERT INTO identity VALUES(1,?)").run(storeId);
      else if (identity.store_id !== storeId) throw new ArtifactFailure({ code: "conflict", retryable: true, message: "Storage root belongs to a different storeId" });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return db;
  } catch (error) { db.close(); throw error; }
}
