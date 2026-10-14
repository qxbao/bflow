import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "../src/sqlite.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { ArtifactWriteOptionsSchema, type ArtifactReference, type OperationResult } from "@ai-flow/contracts";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "../src/index.js";

function value<T>(result: OperationResult<T>): T {
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function* bytes(...chunks: Uint8Array[]) { yield* chunks; }
function input(content = Buffer.from("report"), id = "artifact-1", algorithm: "sha256" | "sha512" = "sha256") {
  return { options: ArtifactWriteOptionsSchema.parse({ artifactId: id, runId: "run-1", taskId: "build", kind: "report",
    mediaType: "application/octet-stream", expectedIntegrity: { checksum: { algorithm, value: createHash(algorithm).update(content).digest("hex") },
      sizeBytes: content.length }, idempotencyKey: `put-${id}`, metadata: { nested: { description: "trusted" } } }), content: bytes(content) };
}
describe("Filesystem ArtifactStore", () => {
  let directory: string;
  let root: string;
  let store: FilesystemArtifactStore;
  const stores: FilesystemArtifactStore[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ai-flow-p03-artifacts-")); root = join(directory, "store");
    store = value(await openFilesystemArtifactStore({ root, storeId: "local" })); stores.push(store);
  });
  afterEach(async () => { for (const item of stores.splice(0)) item.close(); await rm(directory, { recursive: true, force: true }); });
  async function put(content?: Buffer, id?: string) { return value(await store.put(input(content, id))); }
  async function contents(reference: ArtifactReference) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of store.get(reference)) chunks.push(value(chunk));
    return Buffer.concat(chunks);
  }
  async function results(reference: ArtifactReference, options?: Parameters<typeof store.get>[1]) {
    const output = [];
    for await (const result of store.get(reference, options)) output.push(result);
    return output;
  }
  async function blob() {
    const files = (await readdir(root)).filter((name) => name.startsWith("blob-")); expect(files).toHaveLength(1);
    return join(root, files[0]!);
  }
  async function noTemporary() { expect((await readdir(root)).filter((name) => /^(stage|read)-/.test(name))).toEqual([]); }

  it("writes and reads a trusted artifact round-trip", async () => {
    const reference = await put();
    expect(reference).toMatchObject({ trust: "stored", uri: "artifact://local/artifact-1", sizeBytes: 6 });
    expect(await contents(reference)).toEqual(Buffer.from("report"));
    expect(value(await store.resolve(reference.artifactId))).toEqual(reference); await noTemporary();
  });
  it("stores arbitrary binary bytes", async () => {
    const data = Buffer.from([0, 255, 128, 1, 13, 10]); const reference = await put(data);
    expect(await contents(reference)).toEqual(data);
  });
  it("supports empty artifacts with an explicit successful empty stream chunk", async () => {
    const reference = await put(Buffer.alloc(0));
    expect(reference.sizeBytes).toBe(0); expect(await contents(reference)).toHaveLength(0);
    expect(await results(reference)).toHaveLength(1);
  });
  it("streams a large artifact in bounded read chunks", async () => {
    const chunk = Buffer.alloc(64 * 1024, 42); const count = 160;
    const hash = createHash("sha256"); for (let i = 0; i < count; i++) hash.update(chunk);
    const write = input(); write.options.expectedIntegrity = { checksum: { algorithm: "sha256", value: hash.digest("hex") }, sizeBytes: chunk.length * count };
    write.content = (async function* () { for (let i = 0; i < count; i++) yield chunk; })();
    const reference = value(await store.put(write)); let size = 0; let chunks = 0;
    for await (const result of store.get(reference)) { const data = value(result); expect(data.length).toBeLessThanOrEqual(64 * 1024); size += data.length; chunks++; }
    expect(size).toBe(chunk.length * count); expect(chunks).toBe(count); await noTemporary();
  });
  it.each(["sha256", "sha512"] as const)("verifies %s checksum and normalizes uppercase digests", async (algorithm) => {
    const write = input(Buffer.from("hash"), "artifact-1", algorithm); write.options.expectedIntegrity.checksum.value = write.options.expectedIntegrity.checksum.value.toUpperCase();
    const reference = value(await store.put(write)); expect(reference.checksum.value).toBe(reference.checksum.value.toLowerCase());
    expect(await contents(reference)).toEqual(Buffer.from("hash"));
  });
  it("rejects checksum mismatch without publishing any artifact", async () => {
    const write = input(); write.content = bytes(Buffer.from("wrong!"));
    expect(await store.put(write)).toMatchObject({ ok: false, error: { code: "corruption" } });
    expect(value(await store.resolve("artifact-1"))).toBeNull();
    expect((await readdir(root)).filter((name) => name.startsWith("blob-"))).toEqual([]); await noTemporary();
  });
  it.each([5, 7])("rejects expected size %i", async (sizeBytes) => {
    const write = input(); write.options.expectedIntegrity.sizeBytes = sizeBytes;
    expect(await store.put(write)).toMatchObject({ ok: false, error: { code: "corruption" } }); await noTemporary();
  });
  it("derives size when the caller supplies only checksum", async () => {
    const write = input(); delete write.options.expectedIntegrity.sizeBytes;
    expect(value(await store.put(write)).sizeBytes).toBe(6);
  });
  it("rejects forged metadata and wrong store references", async () => {
    const reference = await put();
    expect((await results({ ...reference, uri: "artifact://foreign/artifact-1" }))[0]).toMatchObject({ ok: false, error: { code: "validation" } });
    expect((await results({ ...reference, runId: "another-run" }))[0]).toMatchObject({ ok: false, error: { code: "validation" } });
    expect((await results({ ...reference, checksum: { algorithm: "sha256", value: "a".repeat(64) } }))[0]?.ok).toBe(false);
  });
  it.each(["../outside", "/etc/passwd", "a/b", "a\\b", ".", ".."])("rejects path artifact ID %s", async (artifactId) => {
    const write = input(); write.options.artifactId = artifactId;
    expect(await store.put(write)).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await store.resolve(artifactId)).toMatchObject({ ok: false, error: { code: "validation" } });
  });
  it.each(["file:///etc/passwd", "artifact://local/../outside", "artifact://local/%2e%2e"])("rejects URI escape %s", async (uri) => {
    const reference = await put(); expect((await results({ ...reference, uri }))[0]).toMatchObject({ ok: false, error: { code: "validation" } });
  });
  it("fails closed for IDs not representable by the shared reference URI", async () => {
    const write = input(); write.options.artifactId = "artifact with spaces";
    expect(await store.put(write)).toMatchObject({ ok: false, error: { code: "validation" } });
  });
  it("rejects symlink blob escape and never yields outside bytes", async () => {
    const reference = await put(); const file = await blob(); const outside = join(directory, "secret");
    await writeFile(outside, "outside secret"); await unlink(file); await symlink(outside, file);
    const output = await results(reference); expect(output.every((result) => !result.ok)).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside secret");
  });
  it("rejects configured root and catalog symlinks", async () => {
    const link = join(directory, "linked"); await symlink(root, link);
    expect((await openFilesystemArtifactStore({ root: link, storeId: "local" })).ok).toBe(false);
    store.close(); const dbFile = join(root, "catalog.sqlite"); await unlink(dbFile); await symlink(join(directory, "external.sqlite"), dbFile);
    expect((await openFilesystemArtifactStore({ root, storeId: "local" })).ok).toBe(false);
  });
  it("cleans partial files when the input stream throws", async () => {
    const write = input(); write.content = (async function* () { yield Buffer.from("rep"); throw new Error("upstream failure"); })();
    expect(await store.put(write)).toMatchObject({ ok: false, error: { code: "corruption" } });
    expect(value(await store.resolve("artifact-1"))).toBeNull(); await noTemporary();
  });
  it("rejects non-byte input and cleans its partial file", async () => {
    const write = input(); write.content = (async function* () { yield "not bytes"; })() as unknown as typeof write.content;
    expect(await store.put(write)).toMatchObject({ ok: false, error: { code: "validation" } }); await noTemporary();
  });
  it("cancels midway through writing without a receipt or blob", async () => {
    const controller = new AbortController(); const write = input();
    write.content = (async function* () { yield Buffer.from("rep"); controller.abort(); yield Buffer.from("ort"); })();
    expect(await store.put(write, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(value(await store.resolve("artifact-1"))).toBeNull(); await noTemporary();
  });
  it("aborts a stalled upstream iterator and cleans local resources", async () => {
    const controller = new AbortController(); let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const write = input(); write.content = { [Symbol.asyncIterator]() { return { next() { entered(); return new Promise<IteratorResult<Uint8Array>>(() => {}); } }; } };
    const pending = store.put(write, { signal: controller.signal }); await started; controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } }); await noTemporary();
  });
  it("bounds an uncooperative stream with a timeout", async () => {
    const write = input(); write.content = { [Symbol.asyncIterator]() { return { next() { return new Promise<IteratorResult<Uint8Array>>(() => {}); } }; } };
    expect(await store.put(write, { timeoutMs: 20 })).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started" } }); await noTemporary();
  });
  it("deduplicates 12 concurrent identical puts and publishes one live blob", async () => {
    const outputs = await Promise.all(Array.from({ length: 12 }, () => store.put(input())));
    expect(outputs.every((result) => result.ok)).toBe(true); expect(outputs.map(value)).toEqual(Array(12).fill(value(outputs[0]!)));
    expect((await readdir(root)).filter((name) => name.startsWith("blob-"))).toHaveLength(1);
    await noTemporary();
  });
  it("handles multi-instance concurrent writes through its durable catalog", async () => {
    const second = value(await openFilesystemArtifactStore({ root, storeId: "local" })); stores.push(second);
    const outputs = await Promise.all([store.put(input()), second.put(input())]);
    expect(outputs.map(value)[0]).toEqual(outputs.map(value)[1]);
    expect((await readdir(root)).filter((name) => name.startsWith("blob-"))).toHaveLength(1);
  });
  it("handles multi-process identical puts on a local filesystem", async () => {
    const module = new URL("../dist/index.js", import.meta.url).href;
    const script = `import {openFilesystemArtifactStore} from ${JSON.stringify(module)};
      const opened=await openFilesystemArtifactStore({root:process.argv[1],storeId:'local'}); if(!opened.ok) throw new Error(JSON.stringify(opened.error));
      const data=Buffer.from('report'); const options=JSON.parse(process.argv[2]);
      const result=await opened.value.put({options,content:(async function*(){yield data;})()}); opened.value.close(); console.log(JSON.stringify(result));`;
    const execute = promisify(execFile);
    const outputs = await Promise.all(Array.from({ length: 3 }, async () => JSON.parse((await execute(process.execPath,
      ["--input-type=module", "-e", script, root, JSON.stringify(input().options)])).stdout)));
    expect(outputs.every((result) => result.ok)).toBe(true);
    expect(outputs.map((result) => result.value)).toEqual(Array(3).fill(outputs[0].value));
    expect((await readdir(root)).filter((name) => name.startsWith("blob-"))).toHaveLength(1);
  });
  it("returns original durable receipt after restart", async () => {
    const reference = await put(); store.close(); store = value(await openFilesystemArtifactStore({ root, storeId: "local" })); stores.push(store);
    expect(value(await store.put(input()))).toEqual(reference); expect(await contents(reference)).toEqual(Buffer.from("report"));
  });
  it("rejects idempotency collision and prevents immutable artifact replacement", async () => {
    const reference = await put(); const changed = input(); changed.options.runId = "other";
    expect(await store.put(changed)).toMatchObject({ ok: false, error: { code: "conflict" } });
    const other = input(Buffer.from("other!")); other.options.idempotencyKey = "new-key";
    expect(await store.put(other)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await contents(reference)).toEqual(Buffer.from("report")); await noTemporary();
  });
  it("validates duplicate stream content rather than blindly returning a cached receipt", async () => {
    await put(); const duplicate = input(); duplicate.content = bytes(Buffer.from("other!"));
    expect(await store.put(duplicate)).toMatchObject({ ok: false, error: { code: "corruption" } });
  });
  it("detects tampering before returning even one successful byte chunk", async () => {
    const reference = await put(); await writeFile(await blob(), "tamper");
    const output = await results(reference); expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ ok: false, error: { code: "corruption" } }); await noTemporary();
  });
  it("does not return a successful cached put receipt for a tampered stored blob", async () => {
    await put(); await writeFile(await blob(), "tamper");
    expect(await store.put(input())).toMatchObject({ ok: false, error: { code: "corruption" } });
    expect((await readdir(root)).filter((name) => name.startsWith("blob-"))).toHaveLength(1); await noTemporary();
  });
  it("rejects oversize stored blobs before exposing any bytes", async () => {
    const reference = await put(); await writeFile(await blob(), Buffer.alloc(128 * 1024));
    expect(await results(reference)).toMatchObject([{ ok: false, error: { code: "corruption" } }]); await noTemporary();
  });
  it("keeps a verified published blob hidden when catalog commit is rejected", async () => {
    const db = new DatabaseSync(join(root, "catalog.sqlite"));
    db.exec("CREATE TRIGGER reject_artifact BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT,'injected failure'); END;"); db.close();
    expect((await store.put(input())).ok).toBe(false);
    expect(value(await store.resolve("artifact-1"))).toBeNull();
    expect((await readdir(root)).filter((name) => name.startsWith("blob-"))).toHaveLength(0); await noTemporary();
  });
  it("never trusts unindexed orphan blobs after reopen", async () => {
    await writeFile(join(root, "blob-00000000-0000-0000-0000-000000000000"), "orphan");
    store.close(); store = value(await openFilesystemArtifactStore({ root, storeId: "local" })); stores.push(store);
    expect(value(await store.find({})).items).toEqual([]); expect(value(await store.resolve("artifact-1"))).toBeNull();
  });
  it("rejects a symlink ancestor before creating directories outside storage", async () => {
    const link = join(directory, "linked"); await symlink(root, link);
    expect((await openFilesystemArtifactStore({ root: join(link, "escape"), storeId: "local" })).ok).toBe(false);
    expect(await readdir(root)).not.toContain("escape");
  });
  it("reads a verified private snapshot even if the stored blob changes between yielded chunks", async () => {
    const original = Buffer.alloc(128 * 1024, 7); const reference = await put(original);
    const iterator = store.get(reference)[Symbol.asyncIterator](); const first = await iterator.next();
    expect(first.done).toBe(false); await writeFile(await blob(), Buffer.alloc(original.length, 9));
    const chunks = [value(first.value!)]; for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) chunks.push(value(chunk));
    expect(Buffer.concat(chunks)).toEqual(original); await noTemporary();
  });
  it("protects catalog receipts from caller object aliasing", async () => {
    const reference = await put(); const expected = structuredClone(reference);
    reference.checksum.value = "f".repeat(64); reference.uri = "artifact://foreign/artifact-1";
    reference.metadata!.nested = { description: "mutated" };
    expect(value(await store.resolve("artifact-1"))).toEqual(expected);
    expect(value(await store.put(input()))).toEqual(expected);
  });
  it("queries metadata with pagination and rejects foreign cursors", async () => {
    for (const id of ["a", "b", "c"]) await put(Buffer.from(id), id);
    const first = value(await store.find({ runId: "run-1", limit: 2 }));
    expect(first.items.map((reference) => reference.artifactId)).toEqual(["a", "b"]);
    expect(value(await store.find({ runId: "run-1", cursor: first.nextCursor })).items.map((reference) => reference.artifactId)).toEqual(["c"]);
    expect(await store.find({ runId: "other", cursor: first.nextCursor })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(value(await store.find({ kind: "log" })).items).toEqual([]);
  });
  it("deletes durably, reserves old identities and handles missing records", async () => {
    const reference = await put(); expect(value(await store.delete("artifact-1"))).toBe(true);
    expect(value(await store.delete("artifact-1"))).toBe(false); expect(value(await store.resolve("artifact-1"))).toBeNull();
    expect(value(await store.find({})).items).toEqual([]);
    expect((await results(reference))[0]).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await store.put(input())).toMatchObject({ ok: false, error: { code: "conflict" } });
    store.close(); store = value(await openFilesystemArtifactStore({ root, storeId: "local" })); stores.push(store);
    expect(value(await store.resolve("artifact-1"))).toBeNull(); expect(value(await store.resolve("missing"))).toBeNull();
  });
  it("detects corrupted catalog metadata and unsupported schema", async () => {
    await put(); const db = new DatabaseSync(join(root, "catalog.sqlite")); db.exec("UPDATE artifacts SET payload='{}'"); db.close();
    expect(await store.resolve("artifact-1")).toMatchObject({ ok: false, error: { code: "corruption" } });
    store.close(); const newer = new DatabaseSync(join(root, "catalog.sqlite")); newer.exec("PRAGMA user_version=2"); newer.close();
    expect(await openFilesystemArtifactStore({ root, storeId: "local" })).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
  });
  it("refuses to reopen a root under another store identity", async () => {
    expect(await openFilesystemArtifactStore({ root, storeId: "different" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it.each([{ timeoutMs: 0 }, { deadline: "2020-01-01T00:00:00Z" }, { timeoutMs: -1 }, { deadline: "bad" }])("does not start a write for invalid/expired options %j", async (options) => {
    let consumed = false; const write = input(); write.content = (async function* () { consumed = true; yield Buffer.from("report"); })();
    expect((await store.put(write, options)).ok).toBe(false); expect(consumed).toBe(false);
    expect(value(await store.resolve("artifact-1"))).toBeNull(); await noTemporary();
  });
  it("checks deadline between streaming and publication", async () => {
    let time = 0; const timed = value(await openFilesystemArtifactStore({ root, storeId: "local", clock: () => time })); stores.push(timed);
    const write = input(); write.content = (async function* () { yield Buffer.from("report"); time = 10; })();
    expect(await timed.put(write, { deadline: new Date(10).toISOString() })).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started" } });
    expect(value(await store.resolve("artifact-1"))).toBeNull(); expect((await readdir(root)).filter((file) => file.startsWith("blob-"))).toHaveLength(0); await noTemporary();
  });
  it("times out before catalog mutation while a different process holds the write lock", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked');
      process.stdin.once('data',()=>{db.exec('ROLLBACK');db.close();process.exit(0)});`, join(root, "catalog.sqlite")], { stdio: ["pipe", "pipe", "pipe"] });
    const ended = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    try {
      expect(await store.put(input(), { timeoutMs: 25 })).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started" } });
      expect(value(await store.resolve("artifact-1"))).toBeNull();
      expect((await readdir(root)).filter((name) => name.startsWith("blob-"))).toHaveLength(0); await noTemporary();
    } finally { child.stdin.end("release"); await ended; }
  });
  it("cancels reads and cleans snapshot on consumer early return", async () => {
    const reference = await put(Buffer.alloc(128 * 1024));
    for await (const result of store.get(reference)) { value(result); break; }
    await noTemporary(); const controller = new AbortController(); controller.abort();
    expect((await results(reference, { signal: controller.signal }))[0]).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
  it("reports typed operations after close", async () => {
    const reference = await put(); store.close(); store.close();
    expect(await store.resolve("artifact-1")).toMatchObject({ ok: false, error: { code: "validation" } });
    expect((await results(reference))[0]).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});
