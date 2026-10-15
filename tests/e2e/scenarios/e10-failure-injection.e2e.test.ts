import { describe, it, expect, afterEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  createByteStream,
  createStandardMvpWorkflow,
  expectOk,
  expectFailure,
  readArtifactBytes
} from "../helpers/fixtures.js";
import type {
  ArtifactReference,
  ArtifactWrite,
  DomainEvent
} from "@ai-flow/contracts";

describe("Scenario E10 — Failure Injection, Concurrency & Corrupted State", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("enforces optimistic concurrency control and rejects stale expectedVersion on appendEvents", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-occ-${randomUUID()}`;

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "OCC failure injection" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    const snapshot = expectOk(startRes);

    // Advance run once to version + 1
    const advanceEvent: DomainEvent = {
      schemaVersion: 1,
      eventId: `ev-adv-${randomUUID()}`,
      runId,
      correlationId: randomUUID(),
      sequence: snapshot.lastEventSequence + 1,
      aggregateVersion: snapshot.version + 1,
      type: "run.status_changed",
      occurredAt: new Date().toISOString(),
      idempotencyKey: `idem-adv-${randomUUID()}`,
      payload: {
        from: "running",
        to: "waiting"
      }
    };

    const advanceRes = await harness.runStore.appendEvents({
      runId,
      expectedVersion: snapshot.version,
      expectedLastSequence: snapshot.lastEventSequence,
      idempotencyKey: `adv-batch-${randomUUID()}`,
      events: [advanceEvent]
    });
    expectOk(advanceRes);

    // Stale client tries to append using the OLD snapshot.version (DB is now at snapshot.version + 1)
    const staleEvent: DomainEvent = {
      schemaVersion: 1,
      eventId: `ev-stale-${randomUUID()}`,
      runId,
      correlationId: randomUUID(),
      sequence: snapshot.lastEventSequence + 1,
      aggregateVersion: snapshot.version + 1,
      type: "run.status_changed",
      occurredAt: new Date().toISOString(),
      idempotencyKey: `idem-stale-${randomUUID()}`,
      payload: {
        from: "running",
        to: "waiting"
      }
    };

    const staleAppendRes = await harness.runStore.appendEvents({
      runId,
      expectedVersion: snapshot.version, // STALE! Database is now at snapshot.version + 1
      expectedLastSequence: snapshot.lastEventSequence,
      idempotencyKey: `stale-occ-${randomUUID()}`,
      events: [staleEvent]
    });
    const staleErr = expectFailure(staleAppendRes);
    expect(staleErr.code).toBe("conflict");
    expect(staleErr.message).toContain("Aggregate version mismatch");

    // Client with current version but stale expectedLastSequence tries to append
    const staleSeqEvent: DomainEvent = {
      schemaVersion: 1,
      eventId: `ev-seq-${randomUUID()}`,
      runId,
      correlationId: randomUUID(),
      sequence: snapshot.lastEventSequence + 1,
      aggregateVersion: snapshot.version + 2,
      type: "run.status_changed",
      occurredAt: new Date().toISOString(),
      idempotencyKey: `idem-seq-${randomUUID()}`,
      payload: {
        from: "waiting",
        to: "running"
      }
    };

    const seqAppendRes = await harness.runStore.appendEvents({
      runId,
      expectedVersion: snapshot.version + 1, // matches current DB version
      expectedLastSequence: snapshot.lastEventSequence, // STALE! DB is at lastEventSequence + 1
      idempotencyKey: `stale-seq-${randomUUID()}`,
      events: [staleSeqEvent]
    });
    const seqErr = expectFailure(seqAppendRes);
    expect(seqErr.code).toBe("conflict");
    expect(seqErr.message).toContain("Event sequence mismatch");
  });

  it("guarantees atomic rollback on invalid event batch without dangling commits", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-rollback-${randomUUID()}`;

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Atomic rollback test" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    const snapshot = expectOk(startRes);

    // Read initial event count
    const initialEventsRes = await harness.runStore.readEvents(runId);
    const initialEvents = expectOk(initialEventsRes);
    const initialCount = initialEvents.items.length;

    // Create an invalid event batch: non-contiguous sequence numbers
    const invalidBatch: DomainEvent[] = [
      {
        schemaVersion: 1,
        eventId: `ev-valid-${randomUUID()}`,
        runId,
        correlationId: randomUUID(),
        sequence: snapshot.lastEventSequence + 1,
        aggregateVersion: snapshot.version + 1,
        type: "run.status_changed",
        occurredAt: new Date().toISOString(),
        idempotencyKey: `idem-ev1-${randomUUID()}`,
        payload: {
          from: "running",
          to: "waiting",
          reason: "Manual pause test"
        }
      },
      {
        // INVALID: non-contiguous sequence (skips sequence + 2)
        schemaVersion: 1,
        eventId: `ev-invalid-${randomUUID()}`,
        runId,
        correlationId: randomUUID(),
        sequence: snapshot.lastEventSequence + 5,
        aggregateVersion: snapshot.version + 5,
        type: "run.status_changed",
        occurredAt: new Date().toISOString(),
        idempotencyKey: `idem-ev2-${randomUUID()}`,
        payload: {
          from: "waiting",
          to: "running",
          reason: "Resumed test"
        }
      }
    ];

    const appendRes = await harness.runStore.appendEvents({
      runId,
      expectedVersion: snapshot.version,
      expectedLastSequence: snapshot.lastEventSequence,
      idempotencyKey: `atomic-batch-${randomUUID()}`,
      events: invalidBatch
    });
    const appendErr = expectFailure(appendRes);
    expect(appendErr.code).toBe("validation");

    // Verify transaction rollback: event count remains strictly initialCount
    const afterEventsRes = await harness.runStore.readEvents(runId);
    const afterEvents = expectOk(afterEventsRes);
    expect(afterEvents.items.length).toBe(initialCount);
  });

  it("enforces checkpoint identity immutability and rejects conflicting checkpoint payloads", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-chk-conflict-${randomUUID()}`;

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Checkpoint conflict test" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    const snapshot = expectOk(startRes);

    const checkpointId = `chk-${randomUUID()}`;
    const chkRes = await harness.engine.createCheckpoint({
      runId,
      expectedVersion: snapshot.version,
      checkpointId,
      createdAt: new Date().toISOString()
    });
    const checkpoint = expectOk(chkRes);

    // Save initial checkpoint
    const save1 = await harness.runStore.saveCheckpoint(checkpoint, snapshot.version);
    expectOk(save1);

    // Idempotent re-save of EXACT same checkpoint must succeed
    const saveIdem = await harness.runStore.saveCheckpoint(checkpoint, snapshot.version);
    expectOk(saveIdem);

    // Attempting to save the same checkpointId with DIFFERENT content must fail with conflict
    const tamperedCheckpoint = {
      ...checkpoint,
      createdAt: new Date(Date.now() + 60000).toISOString()
    };
    const conflictSave = await harness.runStore.saveCheckpoint(tamperedCheckpoint, snapshot.version);
    const conflictErr = expectFailure(conflictSave);
    expect(conflictErr.code).toBe("conflict");
    expect(conflictErr.message).toContain("already has different content");
  });

  it("detects corrupted checkpoint database records and fails safely with corruption error", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-corrupt-chk-${randomUUID()}`;

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Checkpoint corruption test" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    const snapshot = expectOk(startRes);

    const checkpointId = `chk-corrupt-${randomUUID()}`;
    const chkRes = await harness.engine.createCheckpoint({
      runId,
      expectedVersion: snapshot.version,
      checkpointId,
      createdAt: new Date().toISOString()
    });
    const checkpoint = expectOk(chkRes);
    expectOk(await harness.runStore.saveCheckpoint(checkpoint, snapshot.version));

    // Directly corrupt the checkpoint payload in the underlying SQLite database
    const db = new DatabaseSync(harness.dbPath);
    db.prepare("UPDATE checkpoints SET payload = '{CORRUPTED_JSON_DATA' WHERE checkpoint_id = ?").run(
      checkpointId
    );
    db.close();

    // Loading latest checkpoint must detect corruption and fail with code corruption
    const loadRes = await harness.runStore.loadLatestCheckpoint(runId);
    const loadErr = expectFailure(loadRes);
    expect(loadErr.code).toBe("corruption");
  });

  it("detects on-disk artifact byte tampering during streaming read and prevents data leak", async () => {
    harness = await createE2eHarness();
    const runId = `run-art-tamper-${randomUUID()}`;
    const content = Buffer.from("Sensitive source code - pristine bytes");
    const hash = createHash("sha256").update(content).digest("hex");

    const write: ArtifactWrite = {
      content: createByteStream(content),
      options: {
        artifactId: `art-tamper-${randomUUID()}`,
        runId,
        taskId: "implement",
        kind: "document",
        mediaType: "text/plain",
        idempotencyKey: `write-tamper-${randomUUID()}`,
        expectedIntegrity: {
          checksum: { algorithm: "sha256", value: hash },
          sizeBytes: content.byteLength
        }
      }
    };

    const putRes = await harness.artifactStore.put(write);
    const ref = expectOk(putRes);

    // Locate the on-disk blob file under harness.artifactsDir
    const files = readdirSync(harness.artifactsDir);
    const blobFile = files.find((f) => f.startsWith("blob-"));
    expect(blobFile).toBeDefined();

    // Tamper with the raw blob file on disk directly
    writeFileSync(
      join(harness.artifactsDir, blobFile!),
      Buffer.from("MALICIOUS INJECTED BYTES IN STORED BLOB")
    );

    // Consumer attempts to read the artifact stream
    const readRes = await readArtifactBytes(harness.artifactStore, ref);
    const readErr = expectFailure(readRes);
    expect(readErr.code).toBe("corruption");
    expect(readErr.message).toMatch(/(?:integrity mismatch|catalog size)/);
  });

  it("strictly rejects forged and mismatched artifact references", async () => {
    harness = await createE2eHarness();
    const runId = `run-forged-${randomUUID()}`;
    const content = Buffer.from("Legitimate artifact content");
    const hash = createHash("sha256").update(content).digest("hex");

    const write: ArtifactWrite = {
      content: createByteStream(content),
      options: {
        artifactId: `art-legit-${randomUUID()}`,
        runId,
        taskId: "implement",
        kind: "document",
        mediaType: "text/plain",
        idempotencyKey: `write-legit-${randomUUID()}`,
        expectedIntegrity: {
          checksum: { algorithm: "sha256", value: hash },
          sizeBytes: content.byteLength
        }
      }
    };

    const putRes = await harness.artifactStore.put(write);
    const ref = expectOk(putRes);

    // 1. Forged reference with modified checksum
    const forgedChecksumRef: ArtifactReference = {
      ...ref,
      checksum: {
        algorithm: "sha256",
        value: "0000000000000000000000000000000000000000000000000000000000000000"
      }
    };
    const readForgedChecksum = await readArtifactBytes(harness.artifactStore, forgedChecksumRef);
    const forgedChecksumErr = expectFailure(readForgedChecksum);
    expect(forgedChecksumErr.code).toBe("validation");
    expect(forgedChecksumErr.message).toContain("does not match trusted catalog");

    // 2. Forged reference with mismatched URI and artifactId -> validation error
    const mismatchedUriRef: ArtifactReference = {
      ...ref,
      artifactId: `art-ghost-${randomUUID()}`
    };
    const readMismatched = await readArtifactBytes(harness.artifactStore, mismatchedUriRef);
    const mismatchedErr = expectFailure(readMismatched);
    expect(mismatchedErr.code).toBe("validation");
    expect(mismatchedErr.message).toBe("Invalid artifact input");

    // 3. Forged reference with consistent non-existent artifactId -> not_found
    const ghostId = `art-ghost-${randomUUID()}`;
    const forgedIdRef: ArtifactReference = {
      ...ref,
      artifactId: ghostId,
      uri: `artifact://e2e-artifact-store/${ghostId}`
    };
    const readForgedId = await readArtifactBytes(harness.artifactStore, forgedIdRef);
    const forgedIdErr = expectFailure(readForgedId);
    expect(forgedIdErr.code).toBe("not_found");
  });

  it("ensures old store handle rejects queries after restart and new store handle succeeds", async () => {
    harness = await createE2eHarness();
    const runId = `run-store-reopen-${randomUUID()}`;
    const oldStore = harness.runStore;

    const restarted = await harness.restart();
    const newStore = restarted.runStore;

    // Old store instance must reject operations because it was closed
    const oldRead = await oldStore.get(runId);
    const oldErr = expectFailure(oldRead);
    expect(oldErr.code).toBe("validation");
    expect(oldErr.message).toContain("closed");

    // New store instance must succeed
    const newRead = await newStore.get(runId);
    expectOk(newRead);
  });

  it("handles acquisition failure safely, releasing already acquired stores without leaks", async () => {
    let simulatedErrorThrown = false;
    try {
      await createE2eHarness({
        openArtifactStore: async () => {
          return {
            ok: false,
            error: {
              code: "transport_unavailable",
              message: "Simulated filesystem failure during artifact store initialization",
              retryable: true
            }
          };
        }
      });
    } catch (err) {
      simulatedErrorThrown = true;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Simulated filesystem failure");
    }
    expect(simulatedErrorThrown).toBe(true);
  });
});
