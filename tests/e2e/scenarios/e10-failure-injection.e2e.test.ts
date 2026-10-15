import { describe, it, expect, afterEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import {
  createArtifactProposal,
  createByteStream,
  createStandardMvpWorkflow,
  createVerifiedAgentResult,
  expectOk,
  expectFailure,
  readArtifactBytes
} from "../helpers/fixtures.js";
import { buildCompleteFeatureWorkflowExample } from "@bflow/agent-registry";
import type {
  AgentExecutionHandle,
  ArtifactReference,
  ArtifactStore,
  ArtifactWrite,
  DomainEvent,
  TaskState
} from "@bflow/contracts";

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

  it("enforces receipt collision semantics: idempotent re-binding succeeds while conflicting handles or uncertain delivery after binding fail with conflict", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-receipt-collision-${randomUUID()}`;

    const snap = expectOk(
      await harness.service.start({
        runId,
        definition,
        input: { requirement: "Receipt collision verification" },
        idempotencyKey: `start-${runId}`,
        requestedAt: new Date().toISOString()
      })
    );

    const planTask = snap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(planTask?.status).toBe("running");
    expect(planTask?.agentExecution).toBeDefined();
    const boundHandle = planTask!.agentExecution!;

    // 1. Idempotent re-binding with identical handle succeeds without emitting a duplicate agent.execution_bound event
    const idemKey = `bind-idem-${randomUUID()}`;
    const idemBind = expectOk(
      await harness.engine.bindAgentExecution({
        runId,
        taskId: "plan",
        expectedVersion: snap.version,
        attempt: planTask!.attempt,
        handle: boundHandle,
        idempotencyKey: idemKey,
        occurredAt: new Date().toISOString()
      })
    );
    expect(idemBind.emittedEvents.some((e) => e.type === "agent.execution_bound")).toBe(false);
    const currentVersion = idemBind.snapshot.version;

    // 2. Reusing the same command idempotencyKey with a modified payload fails with Idempotency key collision
    const collidingHandle: AgentExecutionHandle = {
      ...boundHandle,
      executionId: `exec-collision-${randomUUID()}`
    };
    const keyCollisionErr = expectFailure(
      await harness.engine.bindAgentExecution({
        runId,
        taskId: "plan",
        expectedVersion: snap.version,
        attempt: planTask!.attempt,
        handle: collidingHandle,
        idempotencyKey: idemKey,
        occurredAt: new Date().toISOString()
      })
    );
    expect(keyCollisionErr.code).toBe("conflict");
    expect(keyCollisionErr.message).toContain("Idempotency key collision");

    // 3. Conflicting handle for the same attempt with a fresh idempotencyKey fails with conflict
    const conflictingHandle: AgentExecutionHandle = {
      ...boundHandle,
      executionId: `exec-conflict-${randomUUID()}`
    };
    const conflictBindErr = expectFailure(
      await harness.engine.bindAgentExecution({
        runId,
        taskId: "plan",
        expectedVersion: currentVersion,
        attempt: planTask!.attempt,
        handle: conflictingHandle,
        idempotencyKey: `bind-conflict-${randomUUID()}`,
        occurredAt: new Date().toISOString()
      })
    );
    expect(conflictBindErr.code).toBe("conflict");
    expect(conflictBindErr.message).toContain("already has a different execution");

    // 4. Delivery reconciliation with a conflicting bound handle fails with conflict
    const conflictReconErr = expectFailure(
      await harness.engine.recordDeliveryReconciliation({
        runId,
        taskId: "plan",
        expectedVersion: currentVersion,
        requestId: boundHandle.requestId,
        result: {
          status: "bound",
          handle: conflictingHandle
        },
        idempotencyKey: `recon-conflict-${randomUUID()}`,
        occurredAt: new Date().toISOString()
      })
    );
    expect(conflictReconErr.code).toBe("conflict");
    expect(conflictReconErr.message).toContain("conflicts with the bound execution");

    // 5. Delivery reconciliation claiming not_delivered after execution is already bound fails with conflict
    const absentAfterBoundErr = expectFailure(
      await harness.engine.recordDeliveryReconciliation({
        runId,
        taskId: "plan",
        expectedVersion: currentVersion,
        requestId: boundHandle.requestId,
        result: {
          status: "not_delivered",
          requestId: boundHandle.requestId,
          retrySafe: true,
          observedAt: new Date().toISOString()
        },
        idempotencyKey: `recon-absent-conflict-${randomUUID()}`,
        occurredAt: new Date().toISOString()
      })
    );
    expect(absentAfterBoundErr.code).toBe("conflict");
    expect(absentAfterBoundErr.message).toContain("cannot be uncertain or absent after execution binding");
  });

  it("enforces session replacement and stale execution fencing against replaced handles and stale AgentResults", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-session-fencing-${randomUUID()}`;

    const snap = expectOk(
      await harness.service.start({
        runId,
        definition,
        input: { requirement: "Session replacement fencing" },
        idempotencyKey: `start-${runId}`,
        requestedAt: new Date().toISOString()
      })
    );

    const planTask = snap.tasks.find((t: TaskState) => t.taskId === "plan")!;
    const boundHandle = planTask.agentExecution!;

    // 1. Binding with a stale attemptId is rejected with conflict
    const staleAttemptHandle: AgentExecutionHandle = {
      ...boundHandle,
      attemptId: `attempt-stale-${randomUUID()}`
    };
    const staleBindErr = expectFailure(
      await harness.engine.bindAgentExecution({
        runId,
        taskId: "plan",
        expectedVersion: snap.version,
        attempt: planTask.attempt,
        handle: staleAttemptHandle,
        idempotencyKey: `bind-stale-attempt-${randomUUID()}`,
        occurredAt: new Date().toISOString()
      })
    );
    expect(staleBindErr.code).toBe("conflict");
    expect(staleBindErr.message).toContain("does not match current attempt");

    // 2. Recording an AgentResult from a replaced/stale executionId is rejected with conflict
    const replacedSessionResult = createVerifiedAgentResult({
      handle: {
        ...boundHandle,
        executionId: `exec-replaced-session-${randomUUID()}`
      },
      status: "succeeded"
    });
    const replacedResultErr = expectFailure(
      await harness.engine.recordAgentResult({
        runId,
        taskId: "plan",
        expectedVersion: snap.version,
        result: replacedSessionResult,
        idempotencyKey: `result-replaced-${randomUUID()}`,
        occurredAt: new Date().toISOString()
      })
    );
    expect(replacedResultErr.code).toBe("conflict");
    expect(replacedResultErr.message).toContain("does not match the bound execution");

    // 3. Recording an AgentResult with a forged/mismatched correlation token is rejected with validation
    const forgedTokenResult = createVerifiedAgentResult({
      handle: boundHandle,
      status: "succeeded"
    });
    const tamperedCorrelationResult = {
      ...forgedTokenResult,
      verification: {
        status: "verified" as const,
        evidence: "Fixture correlation tampered",
        correlation: {
          token: `forged-token-${randomUUID()}`,
          provenance: boundHandle.correlation.provenance,
          verified: true
        }
      }
    };
    const forgedTokenErr = expectFailure(
      await harness.engine.recordAgentResult({
        runId,
        taskId: "plan",
        expectedVersion: snap.version,
        result: tamperedCorrelationResult,
        idempotencyKey: `result-forged-token-${randomUUID()}`,
        occurredAt: new Date().toISOString()
      })
    );
    expect(forgedTokenErr.code).toBe("validation");
    expect(forgedTokenErr.message).toContain("correlation is not verified");

    // Verify task remains running with original bound execution
    const afterSnap = expectOk(await harness.service.getRun(runId))!;
    const afterPlan = afterSnap.tasks.find((t: TaskState) => t.taskId === "plan")!;
    expect(afterPlan.status).toBe("running");
    expect(afterPlan.agentExecution?.executionId).toBe(boundHandle.executionId);
  });

  it("fails closed when artifact publication fails during completeTaskExecution before recording agent.result_recorded", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-artifact-pub-fail-${randomUUID()}`;

    expectOk(
      await harness.service.start({
        runId,
        definition,
        input: { requirement: "Failed artifact publication test" },
        idempotencyKey: `start-${runId}`,
        requestedAt: new Date().toISOString()
      })
    );

    const { proposal } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "plan.md",
      content: "Expected authentic plan bytes"
    });

    // Supply corrupted bytes that do not match the proposal's SHA-256 checksum
    const corruptedBytes = Buffer.from("Corrupted bytes that fail ArtifactStore integrity check", "utf8");

    const completeRes = await harness.service.orchestrator.completeTaskExecution(runId, "plan", {
      status: "succeeded",
      summary: "Attempt completion with failing artifact publication",
      proposals: [proposal],
      contentByProposalId: { [proposal.proposalId]: corruptedBytes }
    });
    const pubErr = expectFailure(completeRes);
    expect(["corruption", "validation"]).toContain(pubErr.code);

    // Verify agent.result_recorded was NOT persisted and task remains running
    const eventsPage = expectOk(await harness.runStore.readEvents(runId, { limit: 100 }));
    expect(eventsPage.items.some((e) => e.type === "agent.result_recorded")).toBe(false);

    const currentSnap = expectOk(await harness.service.getRun(runId))!;
    expect(currentSnap.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("running");
  });

  it("verifies P02 buildCompleteFeatureWorkflowExample requires real ArtifactStore and produces trusted stored references", async () => {
    harness = await createE2eHarness();

    // 1. Rejects missing ArtifactStore fail-closed with validation error
    const missingStoreRes = await buildCompleteFeatureWorkflowExample(
      undefined as unknown as ArtifactStore
    );
    const missingErr = expectFailure(missingStoreRes);
    expect(missingErr.code).toBe("validation");
    expect(missingErr.message).toContain("ArtifactStore is required");

    // 2. Ingests all stage proposals through real FilesystemArtifactStore into trusted 'stored' references
    const example = expectOk(await buildCompleteFeatureWorkflowExample(harness.artifactStore));
    const refs: ArtifactReference[] = [
      example.stages.planner.storedReference,
      example.stages.developer.storedPatchReference,
      example.stages.developer.storedTestReportReference,
      example.stages.reviewer.storedReviewReportReference,
      example.stages.qa.storedQaReportReference
    ];

    for (const ref of refs) {
      expect(ref.trust).toBe("stored");
      const bytes = expectOk(await readArtifactBytes(harness.artifactStore, ref));
      expect(bytes.byteLength).toBe(ref.sizeBytes);
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      expect(actualHash).toBe(ref.checksum.value);
    }
  });
});
