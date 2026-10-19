import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureGitNexusIndex } from "../src/integrations.js";
import type { ToolHost } from "../src/installer.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(lockKind: "storage" | "writer", content: string) {
  const root = await mkdtemp(join(tmpdir(), "bflow-index-busy-")); roots.push(root);
  const stateRoot = join(root, "state"); await mkdir(stateRoot);
  const name = lockKind === "storage" ? `gitnexus-storage-${createHash("sha256").update(root).digest("hex")}.lock` : "gitnexus-writer.lock";
  const lockPath = join(stateRoot, name); await writeFile(lockPath, content);
  const host: ToolHost = { async download() { throw Error("inspection must not download"); }, async run(executable, args) {
    if (executable === "git") return { exitCode: 0, stdout: args[0] === "rev-parse" ? "abc\n" : "", stderr: "" };
    expect(args).toEqual(["status", "--json"]);
    return { exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1, repository: root, status: "stale" }), stderr: "" };
  } };
  return { lockPath, stateRoot, input: { repositoryRoot: root, stateRoot, executable: "gitnexus", host } };
}

it("identifies the recorded reader PID and rebuild action without touching its lock", async () => {
  const bytes = JSON.stringify({ pid: process.pid, acquiredAt: "2026-10-19T08:00:00.000Z" });
  const f = await fixture("storage", bytes);
  const result = await ensureGitNexusIndex(f.input);
  expect(result.status).toBe("busy");
  expect(result.diagnostic).toContain("index needs rebuilding");
  expect(result.diagnostic).toContain(f.lockPath);
  expect(result.diagnostic).toContain(`recorded owner PID ${process.pid}`);
  expect(result.diagnostic).toContain("release");
  expect(result.diagnostic).toContain("reader or writer");
  expect(result.diagnostic).toContain("approved setup");
  expect(await readFile(f.lockPath, "utf8")).toBe(bytes);
});

it.each(["", "legacy lock", '{"pid":"not-a-process"}'])("reports an unknown writer owner without declaring an active writer: %j", async bytes => {
  const f = await fixture("writer", bytes);
  const result = await ensureGitNexusIndex(f.input);
  expect(result.status).toBe("busy");
  expect(result.diagnostic).toContain("index needs rebuilding");
  expect(result.diagnostic).toContain(f.lockPath);
  expect(result.diagnostic).toContain("owner unknown");
  expect(result.diagnostic).not.toContain("active");
  expect(result.diagnostic).not.toContain("not-a-process");
  expect(result.diagnostic).toContain("release");
  expect(result.diagnostic).toContain("approved setup");
  expect(await readFile(f.lockPath, "utf8")).toBe(bytes);
  expect((await readdir(f.stateRoot)).filter(name => name.endsWith(".lock"))).toEqual(["gitnexus-writer.lock"]);
});
