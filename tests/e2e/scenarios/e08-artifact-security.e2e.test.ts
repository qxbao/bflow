import { describe, it, expect, afterEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import { createArtifactProposal } from "../helpers/fixtures.js";
import type { ArtifactReference, ArtifactStore, ArtifactWrite, OperationResult } from "@ai-flow/contracts";

function createByteStream(content: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(content);
    }
  };
}

async function readArtifactBytes(store: ArtifactStore, ref: ArtifactReference): Promise<OperationResult<Buffer>> {
  const chunks: Buffer[] = [];
  for await (const chunk of store.get(ref)) {
    if (!chunk.ok) {
      return chunk as OperationResult<Buffer>;
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return { ok: true, value: Buffer.concat(chunks) };
}

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
    expect((proposal as any).uri).toBeUndefined();
    expect((proposal as any).trust).toBeUndefined();

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
    expect(putRes.ok).toBe(true);

    const ref = putRes.value!;
    // 3. INVARIANT CHECK: Stored artifact has trusted reference attributes
    expect(ref.trust).toBe("stored");
    expect(ref.uri).toMatch(/^artifact:\/\/e2e-artifact-store\/art-/);
    expect(ref.sizeBytes).toBe(rawContent.byteLength);
    expect(ref.checksum.value.toLowerCase()).toBe(expectedHash.toLowerCase());

    // 4. Verify catalog retrieval via resolve
    const resolveRes = await harness.artifactStore.resolve(ref.artifactId);
    expect(resolveRes.ok).toBe(true);
    expect(resolveRes.value).not.toBeNull();
    expect(resolveRes.value?.checksum.value).toBe(expectedHash);

    // 5. Read stream content and verify byte-for-byte equality
    const readRes = await readArtifactBytes(harness.artifactStore, ref);
    expect(readRes.ok).toBe(true);
    expect(readRes.value?.toString("utf8")).toBe(rawContent.toString("utf8"));
  });

  it("strictly rejects artifact storage when payload checksum or size does not match expected integrity", async () => {
    harness = await createE2eHarness();
    const runId = `run-tamper-${randomUUID()}`;
    const realContent = Buffer.from("Legitimate uncorrupted artifact bytes");
    const tamperedContent = Buffer.from("TAMPERED malicious artifact bytes");
    const realHash = createHash("sha256").update(realContent).digest("hex");

    // Provide realHash in expectedIntegrity, but stream tamperedContent
    const write: ArtifactWrite = {
      content: createByteStream(tamperedContent),
      options: {
        artifactId: `art-tampered-${randomUUID()}`,
        runId,
        taskId: "plan",
        kind: "document",
        mediaType: "text/plain",
        idempotencyKey: `tamper-${randomUUID()}`,
        expectedIntegrity: {
          checksum: {
            algorithm: "sha256",
            value: realHash // Mismatched!
          },
          sizeBytes: realContent.byteLength // Mismatched!
        }
      }
    };

    const tamperRes = await harness.artifactStore.put(write);
    expect(tamperRes.ok).toBe(false);
    expect(tamperRes.error?.code).toBe("corruption");
    expect(tamperRes.error?.message).toContain("integrity mismatch");

    // Verify nothing was recorded in catalog
    const resolveRes = await harness.artifactStore.resolve(write.options.artifactId);
    expect(resolveRes.ok).toBe(true);
    expect(resolveRes.value).toBeNull();
  });

  it("strictly rejects path traversal, dot segments, and invalid artifact identifiers", async () => {
    harness = await createE2eHarness();
    const runId = `run-traversal-${randomUUID()}`;
    const content = Buffer.from("Some content");
    const hash = createHash("sha256").update(content).digest("hex");

    const invalidIds = [
      "../../etc/passwd",
      "..",
      ".",
      "art/sub/path",
      "art\\win\\path",
      "art null\0byte"
    ];

    for (const badId of invalidIds) {
      const write: ArtifactWrite = {
        content: createByteStream(content),
        options: {
          artifactId: badId,
          runId,
          taskId: "plan",
          kind: "document",
          mediaType: "text/plain",
          idempotencyKey: `traversal-${randomUUID()}`,
          expectedIntegrity: {
            checksum: { algorithm: "sha256", value: hash },
            sizeBytes: content.byteLength
          }
        }
      };

      const res = await harness.artifactStore.put(write);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("validation");
    }
  });

  it("rejects retrieval of foreign or non-existent artifact references", async () => {
    harness = await createE2eHarness();

    // 1. Resolve on non-existent artifactId returns null
    const nonExistentId = `art-nonexistent-${randomUUID()}`;
    const resolveRes = await harness.artifactStore.resolve(nonExistentId);
    expect(resolveRes.ok).toBe(true);
    expect(resolveRes.value).toBeNull();

    // 2. Stream get() on fabricated artifact reference fails with not_found
    const fakeRef: ArtifactReference = {
      trust: "stored",
      artifactId: nonExistentId,
      runId: "run-fake",
      kind: "document",
      uri: `artifact://e2e-artifact-store/${nonExistentId}`,
      mediaType: "text/plain",
      sizeBytes: 100,
      checksum: {
        algorithm: "sha256",
        value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      },
      createdAt: new Date().toISOString()
    };

    const readRes = await readArtifactBytes(harness.artifactStore, fakeRef);
    expect(readRes.ok).toBe(false);
    expect(readRes.error?.code).toBe("not_found");
  });
});
