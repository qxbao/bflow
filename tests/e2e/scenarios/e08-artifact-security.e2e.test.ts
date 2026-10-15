import { describe, it, expect, afterEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createArtifactProposal,
  createByteStream,
  expectOk,
  expectFailure,
  readArtifactBytes
} from "../helpers/fixtures.js";
import type { ArtifactReference, ArtifactWrite } from "@ai-flow/contracts";

describe("Scenario E08 — Artifact Security & Trust Boundary", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("ingests untrusted proposal through ArtifactStore, computing real checksum and minting trusted reference", async () => {
    harness = await createE2eHarness();
    const runId = `run-artifact-${randomUUID()}`;
    const rawContent = Buffer.from("# Technical Architecture\nDatabase: SQLite\nMode: WAL\n");
    const expectedHash = createHash("sha256").update(rawContent).digest("hex");

    const { proposal } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "arch.md",
      content: rawContent.toString("utf8")
    });

    // 1. INVARIANT CHECK: Agent proposal is an untrusted proposal, NOT a trusted reference
    expect(proposal.logicalName).toBe("arch.md");
    expect("uri" in proposal).toBe(false);
    expect("trust" in proposal).toBe(false);

    // 2. Put into real FilesystemArtifactStore
    const write: ArtifactWrite = {
      content: createByteStream(rawContent),
      options: {
        artifactId: `art-${randomUUID()}`,
        runId,
        taskId: "plan",
        kind: "document",
        mediaType: "text/markdown",
        idempotencyKey: `write-${randomUUID()}`,
        expectedIntegrity: {
          checksum: {
            algorithm: "sha256",
            value: expectedHash
          },
          sizeBytes: rawContent.byteLength
        }
      }
    };

    const putRes = await harness.artifactStore.put(write);
    const reference = expectOk(putRes);

    // 3. INVARIANT CHECK: Reference minted by ArtifactStore is trusted and schema-valid
    expect(reference.artifactId).toBe(write.options.artifactId);
    expect(reference.runId).toBe(runId);
    expect(reference.taskId).toBe("plan");
    expect(reference.checksum.value).toBe(expectedHash);
    expect(reference.checksum.algorithm).toBe("sha256");
    expect(reference.uri).toContain("artifact://");
    expect(reference.trust).toBe("stored");

    // 4. Read back and verify bytes
    const readRes = await readArtifactBytes(harness.artifactStore, reference);
    const readBytes = expectOk(readRes);
    expect(readBytes.equals(rawContent)).toBe(true);
  });

  it("strictly detects and rejects corrupt artifact content violating expected integrity", async () => {
    harness = await createE2eHarness();
    const runId = `run-corrupt-${randomUUID()}`;
    const legitimateContent = Buffer.from("Legitimate uncorrupted payload");
    const wrongChecksum = createHash("sha256").update(Buffer.from("Completely different bytes")).digest("hex");

    // Attempt to put content with mismatched expected checksum
    const write: ArtifactWrite = {
      content: createByteStream(legitimateContent),
      options: {
        artifactId: `art-corrupt-${randomUUID()}`,
        runId,
        taskId: "implement",
        kind: "patch",
        mediaType: "text/plain",
        idempotencyKey: `write-corrupt-${randomUUID()}`,
        expectedIntegrity: {
          checksum: {
            algorithm: "sha256",
            value: wrongChecksum // MISMATCHED SHA-256!
          },
          sizeBytes: legitimateContent.byteLength
        }
      }
    };

    const putRes = await harness.artifactStore.put(write);
    const putErr = expectFailure(putRes);

    // ArtifactStore must fail with corruption error and reject the write
    expect(putErr.code).toBe("corruption");
    expect(putErr.message).toMatch(/(?:integrity mismatch|integrity check failed)/i);

    // Verify artifact was not cataloged
    const resolveRes = await harness.artifactStore.resolve(write.options.artifactId);
    const resolveVal = expectOk(resolveRes);
    expect(resolveVal).toBeNull();
  });

  it("strictly enforces security sandboxing and rejects path traversal in artifact paths", async () => {
    harness = await createE2eHarness();
    const runId = `run-traversal-${randomUUID()}`;
    const payload = Buffer.from("Attempted path escape content");
    const checksum = createHash("sha256").update(payload).digest("hex");

    // Path traversal attempt in artifactId
    const writeTraversal: ArtifactWrite = {
      content: createByteStream(payload),
      options: {
        artifactId: `../../etc/passwd-${randomUUID()}`,
        runId,
        taskId: "plan",
        kind: "other",
        mediaType: "text/plain",
        idempotencyKey: `write-traversal-${randomUUID()}`,
        expectedIntegrity: {
          checksum: {
            algorithm: "sha256",
            value: checksum
          },
          sizeBytes: payload.byteLength
        }
      }
    };

    const putRes = await harness.artifactStore.put(writeTraversal);
    const putErr = expectFailure(putRes);

    // Must be rejected with validation error
    expect(putErr.code).toBe("validation");
    expect(putErr.message).toMatch(/(?:invalid artifact input|invalid path)/i);
  });

  it("prevents consumers from accessing uningested fake ArtifactReference", async () => {
    harness = await createE2eHarness();
    const fakeArtifactId = `art-fake-${randomUUID()}`;

    // Synthesized reference that was never written through ArtifactStore
    const fakeRef: ArtifactReference = {
      artifactId: fakeArtifactId,
      runId: "run-fake",
      taskId: "plan",
      kind: "document",
      mediaType: "text/markdown",
      sizeBytes: 123,
      checksum: {
        algorithm: "sha256",
        value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      },
      uri: `artifact://e2e-artifact-store/${fakeArtifactId}`,
      createdAt: new Date().toISOString(),
      trust: "stored"
    };

    const readRes = await readArtifactBytes(harness.artifactStore, fakeRef);
    const readErr = expectFailure(readRes);
    expect(readErr.code).toBe("not_found");
  });
});
