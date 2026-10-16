import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArtifactReferenceSchema,
  type ArtifactQuery,
  type ArtifactReference,
  type ArtifactStore,
  type ArtifactWrite,
  type OperationOptions,
  type OperationResult,
  type Page
} from "@bflow/contracts";

export interface TestArtifactStoreOptions {
  readonly root: string;
  readonly storeId?: string;
}

export class TestArtifactStore implements ArtifactStore {
  readonly root: string;
  readonly storeId: string;
  private closed = false;

  constructor(root: string, storeId = "test-store") {
    this.root = root;
    this.storeId = storeId;
  }

  close(): void {
    this.closed = true;
  }

  async put(write: ArtifactWrite, _options?: OperationOptions): Promise<OperationResult<ArtifactReference>> {
    if (this.closed) return { ok: false, error: { code: "validation_error", message: "Store is closed" } };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of write.content) {
        chunks.push(Buffer.from(chunk));
      }
      const data = Buffer.concat(chunks);
      const hash = createHash(write.options.expectedIntegrity.checksum.algorithm).update(data).digest("hex");
      if (hash.toLowerCase() !== write.options.expectedIntegrity.checksum.value.toLowerCase()) {
        return { ok: false, error: { code: "integrity_mismatch", message: "Artifact checksum mismatch" } };
      }
      if (write.options.expectedIntegrity.sizeBytes !== undefined && write.options.expectedIntegrity.sizeBytes !== data.length) {
        return { ok: false, error: { code: "integrity_mismatch", message: "Artifact size mismatch" } };
      }
      const artifactId = write.options.artifactId;
      const blobFileName = `blob-${artifactId}`;
      const blobPath = join(this.root, blobFileName);
      const metaPath = join(this.root, `meta-${artifactId}.json`);

      await mkdir(this.root, { recursive: true });
      await writeFile(blobPath, data);

      const reference = ArtifactReferenceSchema.parse({
        trust: "stored",
        artifactId,
        runId: write.options.runId,
        ...(write.options.taskId === undefined ? {} : { taskId: write.options.taskId }),
        kind: write.options.kind,
        uri: `artifact://${this.storeId}/${artifactId}`,
        mediaType: write.options.mediaType,
        sizeBytes: data.length,
        checksum: {
          ...write.options.expectedIntegrity.checksum,
          value: write.options.expectedIntegrity.checksum.value.toLowerCase()
        },
        createdAt: new Date().toISOString(),
        ...(write.options.metadata === undefined ? {} : { metadata: write.options.metadata })
      });

      await writeFile(metaPath, JSON.stringify(reference));
      return { ok: true, value: reference };
    } catch (error) {
      return { ok: false, error: { code: "internal_error", message: (error as Error).message } };
    }
  }

  async *get(reference: ArtifactReference, _options?: OperationOptions): AsyncIterable<OperationResult<Uint8Array>> {
    if (this.closed) {
      yield { ok: false, error: { code: "validation_error", message: "Store is closed" } };
      return;
    }
    const blobPath = join(this.root, `blob-${reference.artifactId}`);
    try {
      const data = await readFile(blobPath);
      yield { ok: true, value: new Uint8Array(data) };
    } catch (error) {
      yield { ok: false, error: { code: "not_found", message: (error as Error).message } };
    }
  }

  async resolve(artifactId: string, _options?: OperationOptions): Promise<OperationResult<ArtifactReference | null>> {
    if (this.closed) return { ok: false, error: { code: "validation_error", message: "Store is closed" } };
    const metaPath = join(this.root, `meta-${artifactId}.json`);
    try {
      const content = await readFile(metaPath, "utf8");
      return { ok: true, value: ArtifactReferenceSchema.parse(JSON.parse(content)) };
    } catch {
      return { ok: true, value: null };
    }
  }

  async find(query: ArtifactQuery, _options?: OperationOptions): Promise<OperationResult<Page<ArtifactReference>>> {
    if (this.closed) return { ok: false, error: { code: "validation_error", message: "Store is closed" } };
    try {
      const files = await readdir(this.root);
      const items: ArtifactReference[] = [];
      for (const file of files) {
        if (file.startsWith("meta-") && file.endsWith(".json")) {
          const content = await readFile(join(this.root, file), "utf8");
          const ref = ArtifactReferenceSchema.parse(JSON.parse(content));
          if (query.runId && ref.runId !== query.runId) continue;
          if (query.taskId && ref.taskId !== query.taskId) continue;
          if (query.kind && ref.kind !== query.kind) continue;
          items.push(ref);
        }
      }
      return { ok: true, value: { items, total: items.length } };
    } catch {
      return { ok: true, value: { items: [], total: 0 } };
    }
  }

  async delete(artifactId: string, _options?: OperationOptions): Promise<OperationResult<boolean>> {
    if (this.closed) return { ok: false, error: { code: "validation_error", message: "Store is closed" } };
    let deleted = false;
    try {
      await unlink(join(this.root, `meta-${artifactId}.json`));
      deleted = true;
    } catch {}
    try {
      await unlink(join(this.root, `blob-${artifactId}`));
      deleted = true;
    } catch {}
    return { ok: true, value: deleted };
  }
}

export async function openTestArtifactStore(options: TestArtifactStoreOptions): Promise<OperationResult<TestArtifactStore>> {
  await mkdir(options.root, { recursive: true });
  return { ok: true, value: new TestArtifactStore(options.root, options.storeId ?? "test-store") };
}

export const openFilesystemArtifactStore = openTestArtifactStore;
export type FilesystemArtifactStore = TestArtifactStore;
