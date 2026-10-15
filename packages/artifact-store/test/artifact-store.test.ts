import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "../src/sqlite.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { createServer } from "node:net";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { ArtifactWriteOptionsSchema, type ArtifactReference, type OperationResult } from "@bflow/contracts";
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
    directory = await mkdtemp(join(tmpdir(), "bflow-p03-artifacts-")); root = join(directory, "store");
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

  function connection(current: FilesystemArtifactStore): InstanceType<typeof DatabaseSync> {
    const db = Reflect.get(current, "db");
    if (!(db instanceof DatabaseSync)) throw new Error("Expected a real SQLite connection");
    return db;
  }
  function resizableWrite(initial: number, resized: number, expected: Buffer, withSize = true) {
    // The workspace TS lib predates RAB typings; use the actual Node constructor, not a test double.
    const buffer: ArrayBuffer & { resize(length: number): void } = Reflect.construct(ArrayBuffer, [initial, { maxByteLength: Math.max(initial, resized) }]);
    const view = new Uint8Array(buffer); view.fill(42);
    let changed!: () => void;
    const mutation = new Promise<void>((resolve) => { changed = resolve; });
    const write = input(expected);
    if (!withSize) delete write.options.expectedIntegrity.sizeBytes;
    write.content = (async function* () { setImmediate(() => { buffer.resize(resized); changed(); }); yield view; })();
    return { write, mutation };
  }
  it.each(["shrink", "grow"] as const)("A01: rejects %s audit checksum without publishing false success", async (mode) => {
    const initial = mode === "shrink" ? 128 * 1024 : 64 * 1024;
    const resized = mode === "shrink" ? 64 * 1024 : 128 * 1024;
    const expected = mode === "shrink" ? Buffer.alloc(resized, 42) : Buffer.concat([Buffer.alloc(initial, 42), Buffer.alloc(resized - initial)]);
    const fixture = resizableWrite(initial, resized, expected, false);
    expect(await store.put(fixture.write)).toMatchObject({ ok: false, error: { code: "corruption" } });
    await fixture.mutation;
    expect(value(await store.resolve("artifact-1"))).toBeNull();
    expect((await readdir(root)).filter((name) => name.startsWith("blob-"))).toEqual([]);
    expect(connection(store).prepare("SELECT count(*) AS n FROM receipts").get()?.n).toBe(0);
    await noTemporary();
    // Failed validation did not reserve the identity or poison a durable receipt.
    const reference = await put(); expect(await contents(reference)).toEqual(Buffer.from("report"));
  });
  it("A01: growing view cannot bypass expectedSize", async () => {
    const expected = Buffer.concat([Buffer.alloc(64 * 1024, 42), Buffer.alloc(64 * 1024)]);
    const fixture = resizableWrite(64 * 1024, 128 * 1024, expected);
    fixture.write.options.expectedIntegrity.sizeBytes = 64 * 1024;
    expect((await store.put(fixture.write)).ok).toBe(false); await fixture.mutation;
    expect(value(await store.resolve("artifact-1"))).toBeNull(); await noTemporary();
    expect(connection(store).prepare("SELECT count(*) AS n FROM receipts").get()?.n).toBe(0);
  });
  it.each(["shrink", "grow"] as const)("A01: %s after ingest preserves exact bytes/hash/size and reopen receipt", async (mode) => {
    const initial = mode === "shrink" ? 128 * 1024 : 64 * 1024;
    const expected = Buffer.alloc(initial, 42);
    const fixture = resizableWrite(initial, mode === "shrink" ? 64 * 1024 : 128 * 1024, expected);
    const reference = value(await store.put(fixture.write)); await fixture.mutation;
    expect(reference.sizeBytes).toBe(expected.length); expect((await stat(await blob())).size).toBe(expected.length);
    expect(reference.checksum.value).toBe(createHash("sha256").update(await readFile(await blob())).digest("hex"));
    expect(await contents(reference)).toEqual(expected);
    store.close(); store = value(await openFilesystemArtifactStore({ root, storeId: "local" })); stores.push(store);
    expect(value(await store.resolve("artifact-1"))).toEqual(reference); expect(await contents(reference)).toEqual(expected);
    expect(value(await store.put(input(expected)))).toEqual(reference); await noTemporary();
  });
  it("A01: stable single large chunk stays valid with bounded ingestion buffers", async () => {
    const expected = Buffer.alloc(8 * 1024 * 1024, 17);
    const reference = await put(expected);
    expect(reference.sizeBytes).toBe(expected.length);
    // Buffer.equals compares every byte natively; recursive object equality on 8M numeric keys
    // dominates execution time and does not add coverage of the storage behavior.
    expect((await contents(reference)).equals(expected)).toBe(true);
    expect((await stat(await blob())).size).toBe(expected.length); await noTemporary();
  });
  it.each(["timeout", "abort"] as const)("A02: FIFO %s probe is bounded and never yields verified bytes", async (mode) => {
    const reference = await put(); const file = await blob(); await unlink(file);
    await promisify(execFile)("mkfifo", [file]);
    const module = new URL("../dist/index.js", import.meta.url).href;
    const script = `import {openFilesystemArtifactStore} from ${JSON.stringify(module)};
      const opened=await openFilesystemArtifactStore({root:process.argv[1],storeId:'local'});if(!opened.ok)throw Error(JSON.stringify(opened));
      const signal=new AbortController();const timer=setTimeout(()=>signal.abort(),20);
      const options=process.argv[3]==='timeout'?{timeoutMs:50}:{signal:signal.signal,timeoutMs:1000};
      const start=Date.now();const output=[];for await(const result of opened.value.get(JSON.parse(process.argv[2]),options))output.push(result);
      const duplicate=await opened.value.put({options:JSON.parse(process.argv[4]),content:(async function*(){yield Buffer.from('report')})()},{timeoutMs:1000});
      clearTimeout(timer);opened.value.close();console.log(JSON.stringify({output,duplicate,elapsed:Date.now()-start}));`;
    const result = JSON.parse((await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, root,
      JSON.stringify(reference), mode, JSON.stringify(input().options)], { timeout: 2000, killSignal: "SIGKILL" })).stdout);
    expect(result.output).toHaveLength(1); expect(result.output.every((chunk: OperationResult<Uint8Array>) => !chunk.ok)).toBe(true);
    expect(["corruption", "cancelled", "timeout"]).toContain(result.output[0].error.code);
    expect(result.duplicate).toMatchObject({ ok: false, error: { code: "corruption" } });
    expect(result.elapsed).toBeLessThan(1500); await noTemporary();
  });
  it("A02: hard-linked blob is rejected without leaking a descriptor", async () => {
    const reference = await put(); const file = await blob(); const alias = join(directory, "hardlink"); await link(file, alias);
    expect(await results(reference)).toMatchObject([{ ok: false, error: { code: "corruption" } }]);
    await unlink(alias); expect(await contents(reference)).toEqual(Buffer.from("report")); await noTemporary();
  });
  it("A02: directory cannot be read as a blob", async () => {
    const reference = await put(); const file = await blob(); await unlink(file); await mkdir(file);
    expect(await results(reference)).toMatchObject([{ ok: false, error: { code: "corruption" } }]); await noTemporary();
  });
  it("A02: Unix socket is rejected before any open/connection", async () => {
    const reference = await put(); const file = await blob(); await unlink(file);
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(file, resolve); });
    try { expect(await results(reference)).toMatchObject([{ ok: false, error: { code: "corruption" } }]); }
    finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
    await noTemporary();
  });
  it("A02: a descriptor is closed if fstat fails after the real open", async () => {
    const reference = await put(); const sample = await open(join(directory, "prototype"), "wx+");
    const prototype: FileHandle = Object.getPrototypeOf(sample); await sample.close();
    const original = prototype.stat; let failed: FileHandle | undefined;
    prototype.stat = async function (this: FileHandle) { failed = this; throw new Error("injected fstat failure"); };
    try { expect(await results(reference)).toMatchObject([{ ok: false, error: { code: "corruption" } }]); }
    finally { prototype.stat = original; }
    expect(failed).toBeDefined(); await expect(failed!.stat()).rejects.toMatchObject({ code: "EBADF" }); await noTemporary();
  });
  it("A02: cleanup attempts both descriptors and temp removal after an earlier close error", async () => {
    const reference = await put(); const original = fsPromises.open; const closed: FileHandle[] = [];
    // Node installs close as an instance property. Inject on real opened handles, not an unused prototype.
    fsPromises.open = async (...args) => {
      const handle = await original(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close(); closed.push(handle);
        if (closed.length === 1) throw new Error("injected close acknowledgement failure");
      };
      return handle;
    };
    syncBuiltinESMExports();
    try {
      const output = await results(reference);
      expect(output[0]?.ok).toBe(true); expect(output.at(-1)).toMatchObject({ ok: false, error: { code: "corruption" } });
    } finally { fsPromises.open = original; syncBuiltinESMExports(); }
    expect(closed).toHaveLength(2);
    for (const handle of closed) await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    await noTemporary();
  });
  it("A03: concurrent process deletion during materialization returns the original read snapshot", async () => {
    const first = await put(Buffer.from("a"), "a"); await put(Buffer.from("b"), "b");
    const second = value(await openFilesystemArtifactStore({ root, storeId: "local" })); stores.push(second);
    const barrier = new Int32Array(new SharedArrayBuffer(4));
    const module = new URL("../dist/index.js", import.meta.url).href;
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{const {openFilesystemArtifactStore}=await import(workerData.module);const opened=await openFilesystemArtifactStore({root:workerData.root,storeId:'local'});
      if(!opened.ok)throw Error(JSON.stringify(opened));parentPort.once('message',async()=>{const result=await opened.value.delete('a');
      Atomics.store(new Int32Array(workerData.barrier),0,1);Atomics.notify(new Int32Array(workerData.barrier),0);parentPort.postMessage(result);opened.value.close();});parentPort.postMessage('ready');})().catch(e=>{throw e;});`,
      { eval: true, workerData: { root, module, barrier: barrier.buffer } });
    const db = connection(store); const prepare = db.prepare.bind(db); let intercepted = false;
    try {
      expect((await once(worker, "message"))[0]).toBe("ready");
      const deletion = once(worker, "message");
      db.prepare = (sql) => {
        const statement = prepare(sql);
        if (sql.startsWith("SELECT artifact_id FROM artifacts") && !intercepted) {
          const all = statement.all.bind(statement);
          statement.all = (...args) => {
            const rows = all(...args); intercepted = true; worker.postMessage("delete");
            expect(Atomics.wait(barrier, 0, 0, 10_000)).not.toBe("timed-out"); return rows;
          };
        }
        return statement;
      };
      const page = value(await store.find({ limit: 1 }));
      expect(page.items).toEqual([first]); expect(page.nextCursor).toBeDefined();
      expect((await deletion)[0]).toEqual({ ok: true, value: true });
      expect(value(await second.resolve("a"))).toBeNull();
      expect(value(await store.find({ cursor: page.nextCursor })).items.map((item) => item.artifactId)).toEqual(["b"]);
    } finally { db.prepare = prepare; await worker.terminate(); }
  });
  it("A03: two instances find/delete concurrently never return false corruption", async () => {
    for (const id of ["a", "b", "c"]) await put(Buffer.from(id), id);
    const other = value(await openFilesystemArtifactStore({ root, storeId: "local" })); stores.push(other);
    const [found, deleted] = await Promise.all([store.find({}), other.delete("a")]);
    expect(deleted).toEqual({ ok: true, value: true });
    const ids = value(found).items.map((item) => item.artifactId);
    expect([JSON.stringify(["a", "b", "c"]), JSON.stringify(["b", "c"])]).toContain(JSON.stringify(ids));
  });
  it.each(["resolve", "find"] as const)("A04: %s returns observation_only timeout if deadline expires after SELECT", async (method) => {
    await put(); let time = 0;
    const timed = value(await openFilesystemArtifactStore({ root, storeId: "local", clock: () => time })); stores.push(timed);
    const db = connection(timed); const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (method === "resolve" && sql === "SELECT * FROM artifacts WHERE artifact_id=?") {
        const get = statement.get.bind(statement); statement.get = (...args) => { const row = get(...args); time = 1000; return row; };
      } else if (method === "find" && sql.startsWith("SELECT artifact_id FROM artifacts")) {
        const all = statement.all.bind(statement); statement.all = (...args) => { const rows = all(...args); time = 1000; return rows; };
      }
      return statement;
    };
    try {
      const options = { deadline: new Date(500).toISOString() };
      const result = method === "resolve" ? await timed.resolve("artifact-1", options) : await timed.find({}, options);
      expect(result).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "observation_only" } });
    } finally { db.prepare = prepare; }
    time = 0; expect(value(await timed.resolve("artifact-1"))).not.toBeNull();
  });
  it.each(["resolve", "find"] as const)("A04: %s observes cancellation after SELECT", async (method) => {
    await put(); const controller = new AbortController(); const db = connection(store); const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === "SELECT * FROM artifacts WHERE artifact_id=?") {
        const get = statement.get.bind(statement); statement.get = (...args) => { const row = get(...args); controller.abort(); return row; };
      }
      return statement;
    };
    try {
      const result = method === "resolve" ? await store.resolve("artifact-1", { signal: controller.signal }) : await store.find({}, { signal: controller.signal });
      expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    } finally { db.prepare = prepare; }
    expect(value(await store.resolve("artifact-1"))).not.toBeNull();
  });
  it("A04: valid read deadlines succeed and invalid deadlines are typed validation", async () => {
    const reference = await put();
    expect(value(await store.resolve("artifact-1", { timeoutMs: 1000 }))).toEqual(reference);
    expect(value(await store.find({}, { timeoutMs: 1000 })).items).toEqual([reference]);
    expect(await store.resolve("artifact-1", { deadline: "bad" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await store.find({}, { deadline: "bad" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await store.resolve("artifact-1", { timeoutMs: 0 })).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "observation_only" } });
    expect(await store.find({}, { deadline: "2020-01-01T00:00:00Z" })).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "observation_only" } });
  });
  it.each(["put", "delete"] as const)("A04: %s returns the committed outcome when its budget expires after COMMIT", async (method) => {
    let time = 0; const timed = value(await openFilesystemArtifactStore({ root, storeId: "local", clock: () => time })); stores.push(timed);
    if (method === "delete") await put();
    const db = connection(timed); const exec = db.exec.bind(db);
    db.exec = (sql) => { exec(sql); if (sql === "COMMIT") time = 1000; };
    try {
      const result = method === "put" ? await timed.put(input(), { timeoutMs: 500 }) : await timed.delete("artifact-1", { timeoutMs: 500 });
      expect(result.ok).toBe(true);
    } finally { db.exec = exec; }
    if (method === "put") expect(value(await store.resolve("artifact-1"))).not.toBeNull();
    else expect(value(await store.resolve("artifact-1"))).toBeNull();
  });
});
