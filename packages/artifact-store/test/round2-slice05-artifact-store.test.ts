import { createHash } from "node:crypto";
import { mkdtemp, open, readdir, rm, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFilesystemArtifactStore } from "../src/index.js";

const sha = (text: string) => ({
  checksum: { algorithm: "sha256" as const, value: createHash("sha256").update(text).digest("hex") },
  sizeBytes: Buffer.byteLength(text)
});

async function* chunks(parts: string[]) {
  for (const part of parts) yield Buffer.from(part);
}

async function getFileHandleProto(folder: string): Promise<FileHandle> {
  const probe = await open(join(folder, ".fh-probe"), "w+");
  const proto = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  return proto;
}

describe("Round 2 Slice 5 artifact-store hardening", () => {
  let folder: string;
  let root: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "bflow-r2s5-art-"));
    root = join(folder, "store");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });

  it("tolerates FUSE/NTFS non-capability regular-file fsync errors during put() while failing closed on EIO", async () => {
    const fhProto = await getFileHandleProto(folder);
    const opened = await openFilesystemArtifactStore({ root, storeId: "r2s5" });
    if (!opened.ok) throw new Error(opened.error.message);
    const store = opened.value;

    try {
      for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EROFS"]) {
        const spy = vi.spyOn(fhProto, "sync").mockImplementation(async function (this: FileHandle) {
          const st = await this.stat();
          if (st.isFile()) {
            throw Object.assign(new Error(`FUSE regular-file fsync unsupported: ${code}`), { code });
          }
        });

        const payload = `artifact-${code}`;
        const res = await store.put({
          options: {
            artifactId: `art-${code}`,
            runId: "run-1",
            kind: "log",
            mediaType: "text/plain",
            expectedIntegrity: sha(payload),
            idempotencyKey: `key-${code}`
          },
          content: chunks([payload])
        });
        expect(res.ok).toBe(true);
        spy.mockRestore();
      }

      // Real disk I/O error (EIO) on regular-file fsync must fail closed and clean up stage-* file
      vi.spyOn(fhProto, "sync").mockImplementation(async function (this: FileHandle) {
        const st = await this.stat();
        if (st.isFile()) {
          throw Object.assign(new Error("Physical write error"), { code: "EIO" });
        }
      });

      const failed = await store.put({
        options: {
          artifactId: "art-eio",
          runId: "run-1",
          kind: "log",
          mediaType: "text/plain",
          expectedIntegrity: sha("eio-body"),
          idempotencyKey: "key-eio"
        },
        content: chunks(["eio-body"])
      });
      expect(failed).toMatchObject({ ok: false, error: { code: "corruption" } });

      const entries = await readdir(root);
      expect(entries.filter((e) => e.startsWith("stage-"))).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("preserves primary SQLITE_BUSY conflict error when SQLite auto-rolls back during catalog transaction", async () => {
    const opened = await openFilesystemArtifactStore({ root, storeId: "r2s5" });
    if (!opened.ok) throw new Error(opened.error.message);
    const store = opened.value;

    try {
      const internalDb = (store as unknown as { db: DatabaseSync }).db;
      const origExec = internalDb.exec.bind(internalDb);
      const origPrepare = internalDb.prepare.bind(internalDb);

      vi.spyOn(internalDb, "prepare").mockImplementation(((sql: string) => {
        if (sql.includes("INSERT INTO artifacts")) {
          try {
            origExec("ROLLBACK");
          } catch {
            // ignore
          }
          throw Object.assign(new Error("database is locked"), { errcode: 5, errstr: "database is locked" });
        }
        return origPrepare(sql);
      }) as typeof internalDb.prepare);

      const res = await store.put({
        options: {
          artifactId: "art-busy",
          runId: "run-1",
          kind: "log",
          mediaType: "text/plain",
          expectedIntegrity: sha("busy-body"),
          idempotencyKey: "key-busy"
        },
        content: chunks(["busy-body"])
      });

      expect(res).toMatchObject({
        ok: false,
        error: { code: "conflict", retryable: true }
      });
    } finally {
      store.close();
    }
  });

  it("sweeps stale orphan stage-* and read-* files on openFilesystemArtifactStore while preserving fresh concurrent staging files and committed blobs", async () => {
    let nowMs = 10_000_000;
    const first = await openFilesystemArtifactStore({ root, storeId: "r2s5", clock: () => nowMs });
    if (!first.ok) throw new Error(first.error.message);
    const putRes = await first.value.put({
      options: {
        artifactId: "art-keep",
        runId: "run-1",
        kind: "log",
        mediaType: "text/plain",
        expectedIntegrity: sha("keep-me"),
        idempotencyKey: "key-keep"
      },
      content: chunks(["keep-me"])
    });
    expect(putRes.ok).toBe(true);
    first.value.close();

    const staleStage = join(root, "stage-11111111-1111-4111-8111-111111111111");
    const staleRead = join(root, "read-22222222-2222-4222-8222-222222222222");
    const freshStage = join(root, "stage-33333333-3333-4333-8333-333333333333");

    await writeFile(staleStage, "abandoned-stage");
    await writeFile(staleRead, "abandoned-read");
    await writeFile(freshStage, "active-stage");

    const staleDate = new Date(nowMs - 2 * 3_600_000); // 2 hours old (> default 1h threshold)
    const freshDate = new Date(nowMs - 5_000); // 5 seconds old (in-flight writer)
    await utimes(staleStage, staleDate, staleDate);
    await utimes(staleRead, staleDate, staleDate);
    await utimes(freshStage, freshDate, freshDate);

    const reopened = await openFilesystemArtifactStore({ root, storeId: "r2s5", clock: () => nowMs });
    if (!reopened.ok) throw new Error(reopened.error.message);
    try {
      const files = await readdir(root);
      expect(files).not.toContain("stage-11111111-1111-4111-8111-111111111111");
      expect(files).not.toContain("read-22222222-2222-4222-8222-222222222222");
      expect(files).toContain("stage-33333333-3333-4333-8333-333333333333");
      expect(files.some((f) => f.startsWith("blob-"))).toBe(true);
    } finally {
      reopened.value.close();
    }
  });
});
