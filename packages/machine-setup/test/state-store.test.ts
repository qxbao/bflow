import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetupStateStore, digest } from "../src/index.js";

let root: string;
let paths: { config: string; data: string; state: string; managedBin: string };
const NOW = new Date("2026-01-02T03:04:05.678Z");
const uid = typeof process.getuid === "function" ? process.getuid() : null;

function store(over: { readOnly?: boolean; hostname?: string; pid?: number } = {}) {
  return new SetupStateStore(paths, { uid, now: () => NOW, ...over });
}
function ok<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}
function receipt(over: Record<string, unknown> = {}) {
  const d = digest("x");
  return {
    schemaVersion: 3,
    receiptId: "r1",
    planId: "p1",
    planDigest: d,
    stepId: "s1",
    scope: { kind: "machine", machineId: "m-1" },
    status: "applied",
    desiredStateDigest: d,
    observedStateDigest: d,
    ownedPaths: ["/x"],
    observedAt: NOW.toISOString(),
    diagnostics: [],
    idempotencyKey: "key-1",
    ...over
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ms-ss-"));
  paths = {
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    state: path.join(root, "state"),
    managedBin: path.join(root, "data", "bin")
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("private dirs and atomic writes", () => {
  it("creates 0700 dirs and 0600 files, tightening loose dirs", async () => {
    const s = store();
    const d = path.join(root, "a", "b");
    ok(await s.ensurePrivateDir(d));
    expect((await stat(d)).mode & 0o777).toBe(0o700);
    const { chmod } = await import("node:fs/promises");
    await chmod(d, 0o755);
    ok(await s.ensurePrivateDir(d));
    expect((await stat(d)).mode & 0o777).toBe(0o700);
    const f = path.join(d, "f.txt");
    ok(await s.writeFileAtomic(f, "hello"));
    expect((await stat(f)).mode & 0o777).toBe(0o600);
    expect(await readFile(f, "utf8")).toBe("hello");
  });
  it("rejects a symlinked dir and a uid mismatch", async () => {
    const real = path.join(root, "real");
    await mkdir(real);
    const link = path.join(root, "link");
    await symlink(real, link);
    const r = await store().ensurePrivateDir(link);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("validation");
    if (uid !== null) {
      const other = new SetupStateStore(paths, { uid: uid + 1, now: () => NOW });
      const r2 = await other.ensurePrivateDir(real);
      expect(r2.ok).toBe(false);
    }
  });
  it("leaves no temp files after atomic writes", async () => {
    const s = store();
    const d = path.join(root, "w");
    ok(await s.ensurePrivateDir(d));
    for (let i = 0; i < 3; i++) ok(await s.writeFileAtomic(path.join(d, "f"), `v${i}`));
    expect(await readdir(d)).toEqual(["f"]);
    expect(await readFile(path.join(d, "f"), "utf8")).toBe("v2");
  });
});

describe("backups", () => {
  it("backs up existing files uniquely and indexes them", async () => {
    const s = store();
    const f = path.join(root, "orig.txt");
    await writeFile(f, "one");
    const b1 = ok(await s.backupFile(f));
    const b2 = ok(await s.backupFile(f));
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    expect(b1).not.toBe(b2);
    expect(b1!.startsWith(path.join(paths.state, "backups"))).toBe(true);
    expect(path.basename(b1!)).toBe("orig.txt");
    expect(path.basename(path.dirname(b1!))).toMatch(/^2026-01-02T03-04-05-678Z-[0-9a-f]{8}/);
    expect(await readFile(b1!, "utf8")).toBe("one");
    const idx = (await readFile(path.join(paths.state, "backups", "index.jsonl"), "utf8")).trim().split("\n");
    expect(idx).toHaveLength(2);
    const e = JSON.parse(idx[0]!);
    expect(e.original).toBe(f);
    expect(e.backup).toBe(b1);
    expect(e.sha256).toBe(createHash("sha256").update("one").digest("hex"));
    expect(e.createdAt).toBe(NOW.toISOString());
  });
  it("returns null for a missing file", async () => {
    expect(ok(await store().backupFile(path.join(root, "nope")))).toBeNull();
  });
});

describe("lock", () => {
  it("live lock conflicts, release frees", async () => {
    const a = ok(await store().acquireLock());
    const r = await store().acquireLock();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("conflict");
    await a.release();
    const b = ok(await store().acquireLock());
    await b.release();
  });
  it("replaces a stale lock of a dead pid on the same host only", async () => {
    const s = store();
    ok(await s.ensurePrivateDir(paths.state));
    const lock = path.join(paths.state, "setup.lock");
    await writeFile(lock, JSON.stringify({ pid: 2147483646, hostname: os.hostname(), startedAt: NOW.toISOString() }));
    const l = ok(await s.acquireLock());
    expect(JSON.parse(await readFile(lock, "utf8")).pid).toBe(process.pid);
    await l.release();
    await writeFile(lock, JSON.stringify({ pid: 2147483646, hostname: "other-host", startedAt: NOW.toISOString() }));
    const r = await s.acquireLock();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("conflict");
  });
  it("release does not remove a lock that is no longer ours", async () => {
    const s = store();
    const l = ok(await s.acquireLock());
    const lock = path.join(paths.state, "setup.lock");
    await writeFile(lock, JSON.stringify({ pid: 1, hostname: "elsewhere", startedAt: "x" }));
    await l.release();
    expect((await stat(lock)).isFile()).toBe(true);
  });
});

describe("journal, receipts, approvals, changes", () => {
  it("journal round-trips and validates", async () => {
    const s = store();
    expect(ok(await s.readJournal())).toBeNull();
    const j = {
      schemaVersion: 3 as const,
      planId: "p1",
      planDigest: digest("p"),
      revision: 1,
      steps: { s1: { status: "started" as const, startedAt: NOW.toISOString(), idempotencyKey: "k1" } }
    };
    ok(await s.writeJournal(j));
    expect(ok(await s.readJournal())).toEqual(j);
    const jp = path.join(paths.state, "setup", "journal.json");
    expect((await stat(jp)).mode & 0o777).toBe(0o600);
    await writeFile(jp, JSON.stringify({ ...j, schemaVersion: 2 }));
    const r = await s.readJournal();
    expect(!r.ok && r.error.code).toBe("unsupported_version");
    await writeFile(jp, JSON.stringify({ ...j, extra: 1 }));
    const r2 = await s.readJournal();
    expect(!r2.ok && r2.error.code).toBe("validation");
  });
  it("receipts round-trip and latestReceipt picks the last", async () => {
    const s = store();
    expect(ok(await s.readReceipts())).toEqual([]);
    ok(await s.appendReceipt(receipt() as never));
    ok(await s.appendReceipt(receipt({ receiptId: "r2", status: "already_satisfied" }) as never));
    ok(await s.appendReceipt(receipt({ receiptId: "r3", idempotencyKey: "key-2" }) as never));
    expect(ok(await s.readReceipts())).toHaveLength(3);
    expect(ok(await s.latestReceipt("key-1"))?.receiptId).toBe("r2");
    expect(ok(await s.latestReceipt("nope"))).toBeNull();
  });
  it("rejects invalid receipts on append", async () => {
    const r = await store().appendReceipt(receipt({ status: "bogus" }) as never);
    expect(r.ok).toBe(false);
  });
  it("corrupt receipt line names the line number", async () => {
    const s = store();
    ok(await s.appendReceipt(receipt() as never));
    const rp = path.join(paths.state, "setup", "receipts.jsonl");
    await writeFile(rp, (await readFile(rp, "utf8")) + "{not json\n");
    const r = await s.readReceipts();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("corruption");
      expect(r.error.message).toContain("line 2");
    }
  });
  it("unknown receipt schemaVersion is unsupported_version", async () => {
    const s = store();
    ok(await s.ensurePrivateDir(path.join(paths.state, "setup")));
    await writeFile(path.join(paths.state, "setup", "receipts.jsonl"), JSON.stringify(receipt({ schemaVersion: 4 })) + "\n");
    const r = await s.readReceipts();
    expect(!r.ok && r.error.code).toBe("unsupported_version");
  });
  it("approvals round-trip, reject unknown version and unsafe ids", async () => {
    const s = store();
    const a = {
      schemaVersion: 3 as const,
      receiptId: "ap1",
      planId: "p1",
      planDigest: digest("p"),
      machineId: "m-1",
      stepIds: ["s1"],
      approvedBy: "operator" as const,
      approvedAt: NOW.toISOString()
    };
    expect(ok(await s.readApproval("ap1"))).toBeNull();
    ok(await s.writeApproval(a));
    expect(ok(await s.readApproval("ap1"))).toEqual(a);
    const ap = path.join(paths.state, "setup", "approvals", "ap1.json");
    await writeFile(ap, JSON.stringify({ ...a, schemaVersion: 9 }));
    const r = await s.readApproval("ap1");
    expect(!r.ok && r.error.code).toBe("unsupported_version");
    expect((await s.readApproval("../x")).ok).toBe(false);
    expect((await s.writeApproval({ ...a, receiptId: "../evil" })).ok).toBe(false);
  });
  it("change log appends and reads", async () => {
    const s = store();
    const c = { at: NOW.toISOString(), planId: "p1", stepId: "s1", kind: "write_file", target: "/x", machineWide: false };
    ok(await s.appendChange(c));
    ok(await s.appendChange({ ...c, stepId: "s2" }));
    expect(ok(await s.readChanges()).map((x) => x.stepId)).toEqual(["s1", "s2"]);
  });
});

describe("readOnly", () => {
  it("every mutating method returns a validation error and writes nothing", async () => {
    const s = store({ readOnly: true });
    const f = path.join(root, "f");
    await writeFile(f, "x");
    const results = [
      await s.ensurePrivateDir(path.join(root, "d")),
      await s.writeFileAtomic(path.join(root, "g"), "x"),
      await s.backupFile(f),
      await s.acquireLock(),
      await s.writeJournal({ schemaVersion: 3, planId: "p", planDigest: digest("p"), revision: 1, steps: {} }),
      await s.appendReceipt(receipt() as never),
      await s.writeApproval({
        schemaVersion: 3, receiptId: "a", planId: "p", planDigest: digest("p"), machineId: "m",
        stepIds: [], approvedBy: "operator", approvedAt: NOW.toISOString()
      }),
      await s.appendChange({ at: NOW.toISOString(), planId: "p", stepId: "s", kind: "k", target: "t", machineWide: false })
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("validation");
        expect(r.error.message).toContain("read-only mode");
      }
    }
    await expect(stat(paths.state)).rejects.toThrow();
    await expect(stat(path.join(root, "d"))).rejects.toThrow();
    expect(ok(await s.readJournal())).toBeNull();
  });
});
