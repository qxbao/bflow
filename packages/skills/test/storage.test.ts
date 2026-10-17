import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleDigest, canonical, readBundle, sha256, SkillFileStore } from "../src/storage.js";

let sandbox: string;
beforeEach(async () => { sandbox = await mkdtemp(join(tmpdir(), "bflow-skills-storage-")); });
afterEach(async () => { await rm(sandbox, { recursive: true, force: true }); });

describe("canonical skill documents", () => {
  it("sorts nested keys and preserves JSON data without invoking accessors", () => {
    expect(canonical({ z: [{ b: 2, a: 1 }], a: null })).toBe('{"a":null,"z":[{"a":1,"b":2}]}');
    expect(sha256("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("getter invoked"); } });
    expect(() => canonical(getter)).toThrow("Expected JSON data property");
  });

  it("rejects non-JSON, cycles, sparse arrays and hidden properties", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const input of [undefined, NaN, Infinity, 1n, new Date(), new Array(1), cycle, { a: undefined }, { [Symbol("x")]: 1 }, Object.defineProperty({}, "hidden", { value: 1 })]) {
      expect(() => canonical(input)).toThrow();
    }
  });
});

describe("complete source bundle reads", () => {
  it("includes every regular resource in the digest with stable path ordering", async () => {
    await mkdir(join(sandbox, "references"));
    await writeFile(join(sandbox, "SKILL.md"), "skill\n");
    await writeFile(join(sandbox, "references", "details.txt"), "BOM:\ufeff Tiếng Việt\n");
    const files = await readBundle(sandbox);
    expect(Object.keys(files)).toEqual(["SKILL.md", "references/details.txt"]);
    expect(bundleDigest(files)).toBe(bundleDigest({ "references/details.txt": "BOM:\ufeff Tiếng Việt\n", "SKILL.md": "skill\n" }));
    const before = bundleDigest(files);
    await writeFile(join(sandbox, "references", "details.txt"), "changed");
    expect(bundleDigest(await readBundle(sandbox))).not.toBe(before);
  });

  it("rejects a symlink root, ancestor, resource and .git directories", async () => {
    const source = join(sandbox, "source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "skill");
    await symlink(source, join(sandbox, "alias"));
    await expect(readBundle(join(sandbox, "alias"))).rejects.toThrow("Unsafe directory");
    await mkdir(join(source, "child"));
    await expect(readBundle(join(sandbox, "alias", "child"))).rejects.toThrow("Unsafe directory");
    await symlink(join(source, "SKILL.md"), join(source, "reference"));
    await expect(readBundle(source)).rejects.toThrow("symlink");
    await rm(join(source, "reference"));
    await mkdir(join(source, ".git"));
    await expect(readBundle(source)).rejects.toThrow("Unsafe bundle path");
  });

  it("rejects FIFOs without waiting for a writer and rejects invalid UTF8", async () => {
    execFileSync("mkfifo", [join(sandbox, "pipe")]);
    await expect(readBundle(sandbox)).rejects.toThrow("special file");
    await rm(join(sandbox, "pipe"));
    await writeFile(join(sandbox, "bad"), Buffer.from([0xc0, 0x80]));
    await expect(readBundle(sandbox)).rejects.toThrow();
  });

  it("enforces per-file, total-byte, file-count and depth bounds", async () => {
    await writeFile(join(sandbox, "large"), Buffer.alloc(256 * 1024 + 1));
    await expect(readBundle(sandbox)).rejects.toThrow("bounded regular file");
    await rm(join(sandbox, "large"));
    await Promise.all(Array.from({ length: 9 }, (_, index) => writeFile(join(sandbox, `big-${index}`), Buffer.alloc(256 * 1024))));
    await expect(readBundle(sandbox)).rejects.toThrow("size exceeds");
    await rm(sandbox, { recursive: true });
    await mkdir(sandbox);
    await Promise.all(Array.from({ length: 129 }, (_, index) => writeFile(join(sandbox, `file-${index}`), "x")));
    await expect(readBundle(sandbox)).rejects.toThrow("file count");
    await rm(sandbox, { recursive: true });
    await mkdir(join(sandbox, ...Array<string>(34).fill("sub")), { recursive: true });
    await expect(readBundle(sandbox)).rejects.toThrow("depth");
  });
});

describe("private immutable SkillFileStore", () => {
  const files = { "SKILL.md": "description", "references/example.md": "example" };
  const store = () => new SkillFileStore(join(sandbox, "store"));

  it("round trips complete bundles and immutable canonical documents with private modes", async () => {
    const storage = store();
    const digest = await storage.putBundle(files);
    expect(await storage.getBundle(digest)).toEqual(files);
    expect(await storage.putBundle(files)).toBe(digest);
    expect(await storage.list()).toEqual([digest]);
    await storage.writeImmutableDocument("entry-1", { b: 2, a: 1 });
    await storage.writeImmutableDocument("entry-1", { a: 1, b: 2 });
    expect(await storage.readDocument("entry-1")).toEqual({ a: 1, b: 2 });
    expect(await storage.readDocument("missing")).toBeNull();
    for (const path of [storage.root, join(storage.root, "bundles"), join(storage.root, "bundles", digest), join(storage.root, "bundles", digest, "references"), join(storage.root, "docs")]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    expect((await lstat(join(storage.root, "bundles", digest, "SKILL.md"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(storage.root, "docs", "entry-1.json"))).mode & 0o777).toBe(0o600);
    await expect(storage.writeImmutableDocument("entry-1", { a: 2 })).rejects.toThrow("conflict");
    expect(await readFile(join(storage.root, "docs", "entry-1.json"), "utf8")).toBe('{"a":1,"b":2}');
  });

  it("rejects relative roots, traversal, absolute paths and path conflicts before writing", async () => {
    expect(() => new SkillFileStore("relative")).toThrow("absolute");
    const storage = store();
    for (const path of ["../escape", "/absolute", "a\\b", "a/../b", "a//b", ".git/config", "a\0b", "a/./b"]) {
      await expect(storage.putBundle({ [path]: "x" })).rejects.toThrow("Unsafe bundle path");
    }
    for (const name of ["../escape", "/absolute", "a/b", "a\\b", "", ".", ".."]) {
      await expect(storage.writeImmutableDocument(name, {})).rejects.toThrow("document name");
    }
    await expect(storage.putBundle({ a: "file", "a/b": "child" })).rejects.toThrow("Conflicting");
    await expect(storage.getBundle("../escape")).rejects.toThrow("digest");
    await expect(lstat(storage.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects existing permissive directories, symlink roots and symlink ancestors", async () => {
    const storage = store();
    await mkdir(storage.root, { mode: 0o755 });
    await expect(storage.list()).rejects.toThrow("0700");
    await rm(storage.root, { recursive: true });
    await symlink(sandbox, storage.root);
    await expect(storage.list()).rejects.toThrow("Unsafe directory");
    await expect(new SkillFileStore(join(storage.root, "nested")).list()).rejects.toThrow("Unsafe directory");
  });

  it("rejects linked internal directories and permissive nested bundle directories", async () => {
    const storage = store();
    const digest = await storage.putBundle(files);
    await chmod(join(storage.root, "bundles", digest, "references"), 0o755);
    await expect(storage.getBundle(digest)).rejects.toThrow("0700");
    await rm(join(storage.root, "docs"), { recursive: true });
    await symlink(sandbox, join(storage.root, "docs"));
    await expect(storage.readDocument("missing")).rejects.toThrow("Unsafe directory");
  });

  it("takes an owned snapshot before asynchronous writes", async () => {
    const storage = store();
    const input = { "SKILL.md": "original" };
    const operation = storage.putBundle(input);
    input["SKILL.md"] = "mutated";
    expect(await storage.getBundle(await operation)).toEqual({ "SKILL.md": "original" });
    await expect(storage.putBundle({ "SKILL.md": "\ud800" })).rejects.toThrow("Invalid UTF8");
    await expect(storage.putBundle({ "SKILL.md": "x".repeat(256 * 1024 + 1) })).rejects.toThrow("size exceeds");
    await expect(storage.putBundle({ [`${"nested/".repeat(33)}SKILL.md`]: "x" })).rejects.toThrow("depth");
    const manyDirectories = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`a${index}/b/c/d/file`, "x"]));
    await expect(storage.putBundle(manyDirectories)).rejects.toThrow("entry count");
  });

  it("does not overwrite corrupt bundle bytes, modes or documents", async () => {
    const storage = store();
    const digest = await storage.putBundle(files);
    const file = join(storage.root, "bundles", digest, "SKILL.md");
    await writeFile(file, "corrupt");
    await expect(storage.getBundle(digest)).rejects.toThrow("Corrupted bundle");
    await expect(storage.putBundle(files)).rejects.toThrow("Corrupted bundle");
    expect(await readFile(file, "utf8")).toBe("corrupt");
    await writeFile(file, files["SKILL.md"]);
    await chmod(file, 0o644);
    await expect(storage.getBundle(digest)).rejects.toThrow("private");
    await storage.writeImmutableDocument("doc", {});
    await writeFile(join(storage.root, "docs", "doc.json"), '{ "a": 1 }');
    await expect(storage.readDocument("doc")).rejects.toThrow("Corrupted document");
    await expect(storage.writeImmutableDocument("doc", {})).rejects.toThrow("conflict");
  });

  it("rejects symlink bundle resources, document links and FIFO documents", async () => {
    const storage = store();
    const digest = await storage.putBundle(files);
    const resource = join(storage.root, "bundles", digest, "SKILL.md");
    await rm(resource);
    await symlink("/etc/passwd", resource);
    await expect(storage.getBundle(digest)).rejects.toThrow("symlink");
    const doc = join(storage.root, "docs", "evil.json");
    await symlink("/etc/passwd", doc);
    await expect(storage.readDocument("evil")).rejects.toThrow();
    await expect(storage.writeImmutableDocument("evil", {})).rejects.toThrow();
    await rm(doc);
    execFileSync("mkfifo", [doc]);
    await expect(storage.readDocument("evil")).rejects.toThrow("bounded regular file");
  });

  it("publishes concurrent bundles/documents atomically with one winner on conflict", async () => {
    const storage = store();
    const results = await Promise.all(Array.from({ length: 12 }, () => storage.putBundle(files)));
    expect(new Set(results).size).toBe(1);
    expect(await storage.list()).toEqual([results[0]]);
    await Promise.all(Array.from({ length: 12 }, () => storage.writeImmutableDocument("same", { a: 1 })));
    const writers = await Promise.allSettled([storage.writeImmutableDocument("race", { a: 1 }), storage.writeImmutableDocument("race", { a: 2 })]);
    expect(writers.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(writers.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect([{ a: 1 }, { a: 2 }]).toContainEqual(await storage.readDocument("race"));
    expect((await readdir(join(storage.root, "docs"))).some((name) => name.startsWith(".tmp-"))).toBe(false);
    expect((await readdir(join(storage.root, "bundles"))).some((name) => name.startsWith(".tmp-"))).toBe(false);
  });
});
