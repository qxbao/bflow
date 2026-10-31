import { createHash } from "node:crypto";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("Slice 5 artifact-store regressions", () => {
  let folder: string;
  let root: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "bflow-s5-art-"));
    root = join(folder, "store");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });

  it("P03-RA01: enforces abort and deadline checks after snapshot.read before yielding final chunk and marks get() timeouts observation_only", async () => {
    const fhProto = await getFileHandleProto(folder);
    let nowMs = 1_000;
    const opened = await openFilesystemArtifactStore({
      root,
      storeId: "s5",
      busyTimeoutMs: 1_000,
      clock: () => nowMs
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const store = opened.value;

    try {
      const putRes = await store.put({
        options: {
          artifactId: "art-ra01",
          runId: "run-1",
          kind: "log",
          mediaType: "text/plain",
          expectedIntegrity: sha("hello-world"),
          idempotencyKey: "k-ra01"
        },
        content: chunks(["hello-world"])
      });
      if (!putRes.ok) throw new Error(putRes.error.message);

      // 1. Expired budget on get() must report observation_only (read-only), not not_started
      const expiredItems = [];
      for await (const item of store.get(putRes.value, { timeoutMs: 0 })) {
        expiredItems.push(item);
      }
      expect(expiredItems).toMatchObject([
        { ok: false, error: { code: "timeout", retrySafety: "observation_only" } }
      ]);

      // 2. Abort triggered during snapshot.read on the final chunk must NOT yield { ok: true }
      const controller = new AbortController();
      const origRead = fhProto.read;
      let readCalls = 0;
      vi.spyOn(fhProto, "read").mockImplementation(async function (this: FileHandle, ...args: any[]) {
        readCalls += 1;
        const res = await (origRead as any).apply(this, args);
        // Copy loop passes offset null; snapshot.read passes numeric offset 0
        if (typeof args[3] === "number" && args[3] === 0) {
          controller.abort();
        }
        return res;
      });

      const abortedItems = [];
      for await (const item of store.get(putRes.value, { signal: controller.signal })) {
        abortedItems.push(item);
      }
      expect(readCalls).toBeGreaterThanOrEqual(2);
      expect(abortedItems).toHaveLength(1);
      expect(abortedItems[0]).toMatchObject({
        ok: false,
        error: { code: "cancelled", retryable: false }
      });

      vi.restoreAllMocks();

      // 3. Deadline expiring during snapshot.read on the final chunk must yield timeout, not { ok: true }
      vi.spyOn(fhProto, "read").mockImplementation(async function (this: FileHandle, ...args: any[]) {
        const res = await (origRead as any).apply(this, args);
        if (typeof args[3] === "number" && args[3] === 0) {
          nowMs += 500;
        }
        return res;
      });

      const timedOutItems = [];
      for await (const item of store.get(putRes.value, { timeoutMs: 100 })) {
        timedOutItems.push(item);
      }
      expect(timedOutItems).toHaveLength(1);
      expect(timedOutItems[0]).toMatchObject({
        ok: false,
        error: { code: "timeout", retrySafety: "observation_only" }
      });
    } finally {
      store.close();
    }
  });

  it("tolerates FUSE/NTFS directory fsync non-capability errors (EINVAL/ENOTSUP/EPERM) while failing closed on EIO", async () => {
    const fhProto = await getFileHandleProto(folder);
    const opened = await openFilesystemArtifactStore({ root, storeId: "s5-fuse" });
    if (!opened.ok) throw new Error(opened.error.message);
    const store = opened.value;

    try {
      const origSync = fhProto.sync;
      for (const code of ["EINVAL", "ENOTSUP", "EPERM"] as const) {
        vi.spyOn(fhProto, "sync").mockImplementation(async function (this: FileHandle) {
          const st = await this.stat();
          if (st.isDirectory()) {
            throw Object.assign(new Error(`directory fsync unsupported: ${code}`), { code });
          }
          return origSync.call(this);
        });

        const id = `art-${code.toLowerCase()}`;
        const res = await store.put({
          options: {
            artifactId: id,
            runId: "run-fuse",
            kind: "report",
            mediaType: "text/plain",
            expectedIntegrity: sha(code),
            idempotencyKey: `key-${code}`
          },
          content: chunks([code])
        });
        expect(res.ok).toBe(true);
        vi.restoreAllMocks();
      }

      // Real storage I/O error (EIO) on directory sync must still fail closed
      vi.spyOn(fhProto, "sync").mockImplementation(async function (this: FileHandle) {
        const st = await this.stat();
        if (st.isDirectory()) {
          throw Object.assign(new Error("Input/output error"), { code: "EIO" });
        }
        return origSync.call(this);
      });

      const ioFail = await store.put({
        options: {
          artifactId: "art-eio",
          runId: "run-fuse",
          kind: "report",
          mediaType: "text/plain",
          expectedIntegrity: sha("eio"),
          idempotencyKey: "key-eio"
        },
        content: chunks(["eio"])
      });
      expect(ioFail.ok).toBe(false);
    } finally {
      store.close();
    }
  });

  it("restores SQLite PRAGMA busy_timeout after short-timeout operations", async () => {
    const opened = await openFilesystemArtifactStore({
      root,
      storeId: "s5-busy",
      busyTimeoutMs: 2_500
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const store = opened.value;

    try {
      const res = await store.put(
        {
          options: {
            artifactId: "art-busy",
            runId: "run-1",
            kind: "log",
            mediaType: "text/plain",
            expectedIntegrity: sha("busy"),
            idempotencyKey: "k-busy"
          },
          content: chunks(["busy"])
        },
        { timeoutMs: 500 }
      );
      expect(res.ok).toBe(true);

      const pragma = (store as any).db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      expect(pragma.timeout).toBe(2_500);
    } finally {
      store.close();
    }
  });
});
