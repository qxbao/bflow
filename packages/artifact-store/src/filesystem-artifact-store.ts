import { createHash, randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  ArtifactIdSchema, ArtifactQuerySchema, ArtifactReferenceSchema, ArtifactWriteOptionsSchema,
  type ArtifactQuery, type ArtifactReference, type ArtifactStore, type ArtifactWrite,
  type OperationOptions, type OperationResult, type Page
} from "@ai-flow/contracts";
import { openCatalog } from "./catalog.js";
import { SafeRoot } from "./filesystem.js";
import { Budget, afterCursor, conflict, cursor, digest, fail, failure, fingerprint, parse, storedJson } from "./support.js";

export interface FilesystemArtifactStoreOptions {
  readonly root: string;
  readonly storeId: string;
  readonly busyTimeoutMs?: number;
  readonly clock?: () => number;
}
export async function openFilesystemArtifactStore(options: FilesystemArtifactStoreOptions): Promise<OperationResult<FilesystemArtifactStore>> {
  try {
    const busy = options.busyTimeoutMs ?? 5_000;
    if (!options.root || !/^[A-Za-z0-9._-]+$/.test(options.storeId) || [".", ".."].includes(options.storeId) ||
      !Number.isSafeInteger(busy) || busy < 0 || busy > 2_147_483_647) fail("validation", "Invalid artifact store configuration");
    const root = await SafeRoot.create(options.root);
    await root.check();
    return { ok: true, value: new FilesystemArtifactStore(root, openCatalog(root.file("catalog.sqlite"), options.storeId, busy),
      options.storeId, busy, options.clock ?? Date.now) };
  } catch (error) { return failure(error); }
}

export class FilesystemArtifactStore implements ArtifactStore {
  private closed = false;
  constructor(private readonly root: SafeRoot, private readonly db: DatabaseSync, private readonly storeId: string,
    private readonly busy: number, private readonly clock: () => number) {}
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  private async execute<T>(options: OperationOptions | undefined, work: (budget: Budget) => Promise<T>, postObservation = false): Promise<OperationResult<T>> {
    try {
      if (this.closed) fail("validation", "Store is closed");
      const budget = new Budget(options, this.clock, postObservation);
      await this.root.check();
      budget.check(postObservation);
      const value = await work(budget);
      // Only observations opt into this check; committed mutations must retain their actual outcome.
      if (postObservation) budget.check(true);
      return { ok: true, value };
    } catch (error) { return failure(error); }
  }
  private transaction<T>(budget: Budget, work: () => T): T {
    budget.check();
    this.db.exec(`PRAGMA busy_timeout=${budget.remaining(this.busy)}`);
    try { this.db.exec("BEGIN IMMEDIATE"); }
    catch (error) { budget.check(); throw error; }
    try { budget.check(); const result = work(); budget.check(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private observation<T>(options: OperationOptions | undefined, work: () => T): Promise<OperationResult<T>> {
    return this.execute(options, async (budget) => {
      budget.check(true);
      this.db.exec("BEGIN DEFERRED");
      let value: T;
      try {
        value = work();
        budget.check(true);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      // Read-only COMMIT has no business mutation; do not apply this post-check to put/delete.
      budget.check(true);
      return value;
    }, true);
  }
  private record(id: string, includeDeleted = false): { reference: ArtifactReference; blob: string; deleted: boolean } | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE artifact_id=?").get(id);
    if (row === undefined) return null;
    const reference = parse(ArtifactReferenceSchema, storedJson(row.payload, row.digest), true);
    if (reference.artifactId !== id || reference.uri !== `artifact://${this.storeId}/${id}` || typeof row.blob !== "string" ||
      row.run_id !== reference.runId || row.kind !== reference.kind || row.task_id !== (reference.taskId ?? null) ||
      row.deleted !== 0 && row.deleted !== 1 || !Number.isSafeInteger(reference.sizeBytes)) fail("corruption", "Artifact index, size or ownership mismatch");
    this.root.file(row.blob);
    if (!row.blob.startsWith("blob-")) fail("corruption", "Invalid artifact object name");
    if (row.deleted === 1 && !includeDeleted) return null;
    return { reference, blob: row.blob, deleted: row.deleted === 1 };
  }
  private async verify(reference: ArtifactReference, blob: string, budget: Budget): Promise<void> {
    const source = await this.root.open(blob);
    try {
      const hash = createHash(reference.checksum.algorithm);
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      while (true) {
        budget.check();
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (reference.sizeBytes === undefined || size > reference.sizeBytes) fail("corruption", "Cached artifact exceeds catalog size");
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (size !== reference.sizeBytes || hash.digest("hex") !== reference.checksum.value.toLowerCase()) fail("corruption", "Cached artifact failed integrity verification");
    } finally { await source.close(); }
  }
  async put(write: ArtifactWrite, options?: OperationOptions): Promise<OperationResult<ArtifactReference>> {
    return this.execute(options, async (budget) => {
      const input = parse(ArtifactWriteOptionsSchema, write?.options);
      if (!/^[A-Za-z0-9._-]+$/.test(input.artifactId)) fail("validation", "artifactId cannot be represented by the approved artifact URI schema");
      if (write?.content === undefined || typeof write.content[Symbol.asyncIterator] !== "function") fail("validation", "Artifact content must be an async byte stream");
      const stage = `stage-${randomUUID()}`;
      const blob = `blob-${randomUUID()}`;
      let handle: FileHandle | undefined;
      let published = false;
      let committed = false;
      let staged = false;
      const iterator = write.content[Symbol.asyncIterator]();
      let exhausted = false;
      try {
        handle = await this.root.open(stage, true); staged = true;
        const hash = createHash(input.expectedIntegrity.checksum.algorithm);
        let size = 0;
        while (true) {
          budget.check();
          const chunk = await budget.wait(Promise.resolve(iterator.next()));
          if (chunk.done) { exhausted = true; break; }
          if (!(chunk.value instanceof Uint8Array)) fail("validation", "Artifact stream yielded non-byte content");
          // Consume this view entirely in one JS turn. Retaining it across await permits resize,
          // detach or reuse by its producer. Synchronous bounded writes avoid a whole-chunk copy
          // or an unbounded queue of pending async buffers while supporting arbitrary chunk sizes.
          const length = chunk.value.byteLength;
          for (let offset = 0; offset < length; offset += 64 * 1024) {
            budget.check();
            const bytes = Buffer.from(chunk.value.subarray(offset, Math.min(length, offset + 64 * 1024)));
            size += bytes.byteLength;
            if (!Number.isSafeInteger(size)) fail("validation", "Artifact size exceeds supported range");
            if (input.expectedIntegrity.sizeBytes !== undefined && size > input.expectedIntegrity.sizeBytes) fail("corruption", "Artifact exceeds expected size");
            let written = 0;
            while (written < bytes.byteLength) {
              budget.check();
              const count = writeSync(handle.fd, bytes, written, bytes.byteLength - written, null);
              if (count <= 0) fail("corruption", "Artifact write made no progress");
              written += count;
            }
            hash.update(bytes);
          }
        }
        if (hash.digest("hex") !== input.expectedIntegrity.checksum.value.toLowerCase() ||
          input.expectedIntegrity.sizeBytes !== undefined && size !== input.expectedIntegrity.sizeBytes) fail("corruption", "Artifact integrity mismatch");
        await handle.sync();
        const final = await handle.stat();
        if (!final.isFile() || final.nlink !== 1 || final.size !== size) fail("corruption", "Staged artifact size or file identity is inconsistent");
        const reference = parse(ArtifactReferenceSchema, { trust: "stored", artifactId: input.artifactId, runId: input.runId,
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }), kind: input.kind, uri: `artifact://${this.storeId}/${input.artifactId}`,
          mediaType: input.mediaType, sizeBytes: size, checksum: { ...input.expectedIntegrity.checksum, value: input.expectedIntegrity.checksum.value.toLowerCase() },
          createdAt: new Date(this.clock()).toISOString(), ...(input.metadata === undefined ? {} : { metadata: input.metadata }) });
        await handle.close(); handle = undefined;
        await this.root.check();
        budget.check();
        await rename(this.root.file(stage), this.root.file(blob)); published = true;
        await this.root.sync();
        const result = this.transaction(budget, () => {
          const old = this.db.prepare("SELECT * FROM receipts WHERE idempotency_key=?").get(input.idempotencyKey);
          const hash = fingerprint(input);
          if (old !== undefined) {
            if (old.fingerprint !== hash) conflict("Artifact idempotency key has a different payload");
            const cached = parse(ArtifactReferenceSchema, storedJson(old.payload, old.digest), true);
            const current = this.record(cached.artifactId, true) ?? fail("corruption", "Artifact receipt has no catalog record");
            if (current.deleted) conflict("Artifact was deleted; its idempotency key remains reserved");
            if (fingerprint(cached) !== fingerprint(current.reference) || old.artifact_id !== cached.artifactId) fail("corruption", "Artifact receipt differs from its catalog record");
            return cached;
          }
          if (this.record(input.artifactId, true) !== null) conflict("Artifact identifier is immutable and already exists");
          const payload = JSON.stringify(reference);
          this.db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,0,?,?)").run(reference.artifactId, reference.runId,
            reference.taskId ?? null, reference.kind, blob, payload, digest(payload));
          this.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?)").run(input.idempotencyKey, hash, reference.artifactId, payload, digest(payload));
          return reference;
        });
        committed = result === reference;
        if (!committed) {
          const existing = this.record(result.artifactId, true) ?? fail("corruption", "Cached artifact disappeared");
          if (existing.deleted) conflict("Cached artifact was concurrently deleted");
          await this.verify(existing.reference, existing.blob, budget);
        }
        return result;
      } finally {
        if (!exhausted && iterator.return !== undefined) {
          // An uncooperative producer cannot delay local cleanup forever.
          try { void Promise.resolve(iterator.return()).catch(() => undefined); } catch { /* local cleanup still required */ }
        }
        await this.cleanup([handle], staged && !committed ? published ? blob : stage : undefined);
      }
    });
  }
  private async removeFile(name: string): Promise<void> {
    await this.root.check();
    try { await unlink(this.root.file(name)); }
    catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error; }
  }
  private async cleanup(handles: readonly (FileHandle | undefined)[], temporary?: string): Promise<void> {
    // Attempt every release even if an earlier close fails; surface the first cleanup failure.
    let first: unknown;
    let failed = false;
    for (const handle of handles) {
      try { await handle?.close(); }
      catch (error) { if (!failed) { first = error; failed = true; } }
    }
    try { if (temporary !== undefined) await this.removeFile(temporary); }
    catch (error) { if (!failed) { first = error; failed = true; } }
    if (failed) throw first;
  }
  async *get(input: ArtifactReference, options?: OperationOptions): AsyncIterable<OperationResult<Uint8Array>> {
    const temporary = `read-${randomUUID()}`;
    let source: FileHandle | undefined;
    let snapshot: FileHandle | undefined;
    let created = false;
    try {
      if (this.closed) fail("validation", "Store is closed");
      const budget = new Budget(options, this.clock);
      const reference = parse(ArtifactReferenceSchema, input);
      await this.root.check(); budget.check();
      const record = this.record(reference.artifactId) ?? fail("not_found", "Artifact does not exist");
      if (fingerprint(reference) !== fingerprint(record.reference)) fail("validation", "Reference does not match trusted catalog");
      source = await this.root.open(record.blob);
      snapshot = await this.root.open(temporary, true); created = true;
      const hash = createHash(reference.checksum.algorithm);
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      while (true) {
        budget.check(true);
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        if (record.reference.sizeBytes === undefined || size + bytesRead > record.reference.sizeBytes) fail("corruption", "Stored artifact exceeds catalog size");
        hash.update(buffer.subarray(0, bytesRead));
        await snapshot.writeFile(buffer.subarray(0, bytesRead)); size += bytesRead;
      }
      if (hash.digest("hex") !== reference.checksum.value.toLowerCase() || size !== record.reference.sizeBytes) fail("corruption", "Stored artifact integrity mismatch");
      // Yield only after a private snapshot is completely verified. No bytes from a corrupt blob escape.
      let offset = 0;
      while (offset < size) {
        budget.check(true);
        const bytes = Buffer.alloc(Math.min(64 * 1024, size - offset));
        const read = await snapshot.read(bytes, 0, bytes.length, offset);
        if (read.bytesRead !== bytes.length) fail("corruption", "Verified read snapshot changed");
        offset += read.bytesRead;
        yield { ok: true, value: bytes };
      }
      if (size === 0) { budget.check(true); yield { ok: true, value: new Uint8Array() }; }
    } catch (error) { yield failure(error); }
    finally {
      try { await this.cleanup([source, snapshot], created ? temporary : undefined); }
      catch (error) { yield failure(error); }
    }
  }
  async resolve(artifactId: string, options?: OperationOptions): Promise<OperationResult<ArtifactReference | null>> {
    return this.observation(options, () => this.record(parse(ArtifactIdSchema, artifactId))?.reference ?? null);
  }
  async find(input: ArtifactQuery, options?: OperationOptions): Promise<OperationResult<Page<ArtifactReference>>> {
    return this.observation(options, () => {
      const query = parse(ArtifactQuerySchema, input);
      const { cursor: requestCursor, limit = 100, ...filters } = query;
      const scope = `artifacts:${this.storeId}:${fingerprint(filters)}`;
      const values: SQLInputValue[] = [afterCursor(requestCursor, scope)];
      const clauses = ["artifact_id > ?", "deleted=0"];
      for (const [field, value] of [["run_id", query.runId], ["task_id", query.taskId], ["kind", query.kind]] as const) {
        if (value !== undefined) { clauses.push(`${field}=?`); values.push(value); }
      }
      const rows = this.db.prepare(`SELECT artifact_id FROM artifacts WHERE ${clauses.join(" AND ")} ORDER BY artifact_id LIMIT ?`).all(...values, limit + 1);
      const items = rows.slice(0, limit).map((row) => {
        if (typeof row.artifact_id !== "string") fail("corruption", "Invalid artifact index");
        return this.record(row.artifact_id)?.reference ?? fail("corruption", "Artifact disappeared during query");
      });
      const last = items.at(-1);
      return { items, ...(rows.length > limit && last !== undefined ? { nextCursor: cursor(scope, last.artifactId) } : {}) };
    });
  }
  async delete(artifactId: string, options?: OperationOptions): Promise<OperationResult<boolean>> {
    return this.execute(options, async (budget) => {
      const id = parse(ArtifactIdSchema, artifactId);
      // Tombstone is the atomic public deletion. Retain blob/receipts for reader safety and audit;
      // offline retention cleanup is an operator responsibility, not cross-resource transaction magic.
      return this.transaction(budget, () => {
        const record = this.record(id);
        if (record === null) return false;
        this.db.prepare("UPDATE artifacts SET deleted=1 WHERE artifact_id=? AND deleted=0").run(id);
        return true;
      });
    });
  }
}
