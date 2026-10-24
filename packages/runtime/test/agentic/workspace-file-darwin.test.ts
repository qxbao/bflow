import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { darwinWorkspaceFile, prepareDarwinWorkspaceHelper } from "../../src/agentic/workspace-file-darwin.js";
import { assertWorkspaceFileCapability } from "../../src/agentic/workspace-file-readiness.js";

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
it("proves real workspace capability using an owned fixture on the actual platform", async () => {
  await expect(assertWorkspaceFileCapability()).resolves.toBeUndefined();
});
describe.runIf(process.platform === "darwin")("macOS descriptor-relative workspace helper", () => {
  async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-native-race-"))); cleanup.push(root);
    await mkdir(join(root, "workspace")); await mkdir(join(root, "workspace/src")); await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside/file"), "outside");
    return root;
  }
  function delayedWrite(binary: string, cwd: string, path: string, expected: string) {
    let child!: ChildProcess;
    const result = new Promise<{ code: unknown; error: string }>(accept => {
      child = execFile(binary, ["write", cwd, path, expected], { timeout: 5000, maxBuffer: 16384 }, (error, _stdout, stderr) => accept({ code: error?.code ?? 0, error: stderr }));
      child.stdin?.on("error", () => undefined);
    });
    return { child, result };
  }
  it("refuses a pinned parent moved outside the workspace and replaced by a symlink before mutation", async () => {
    const root = await fixture(), binary = await prepareDarwinWorkspaceHelper(), cwd = join(root, "workspace");
    const { child, result } = delayedWrite(binary, cwd, "src/new", "new");
    try {
      // Exclusive creation proves the helper has opened/pinned this parent before waiting for content.
      await expect.poll(async () => { try { return (await stat(join(cwd, "src/new"))).isFile(); } catch { return false; } }).toBe(true);
      await rename(join(cwd, "src"), join(root, "moved")); await symlink(join(root, "outside"), join(cwd, "src"));
      child.stdin!.end("unauthorized");
      expect(await result).toMatchObject({ code: 1, error: expect.stringMatching(/moved/) });
      expect(await readFile(join(root, "outside/file"), "utf8")).toBe("outside");
      expect(await readFile(join(root, "moved/new"), "utf8")).toBe("");
    } finally { child.kill("SIGKILL"); await result; }
  });
  it("refuses a leaf replaced after the digest read and preserves both original and replacement", async () => {
    const root = await fixture(), binary = await prepareDarwinWorkspaceHelper(), cwd = join(root, "workspace");
    // A new leaf gives a deterministic open barrier; replace it while stdin is still withheld.
    const { child, result } = delayedWrite(binary, cwd, "src/new", "new");
    try {
      await expect.poll(async () => { try { return (await stat(join(cwd, "src/new"))).isFile(); } catch { return false; } }).toBe(true);
      await rename(join(cwd, "src/new"), join(cwd, "src/original")); await writeFile(join(cwd, "src/new"), "replacement");
      child.stdin!.end("unauthorized");
      expect(await result).toMatchObject({ code: 1, error: expect.stringMatching(/replaced/) });
      expect(await readFile(join(cwd, "src/new"), "utf8")).toBe("replacement");
      expect(await readFile(join(cwd, "src/original"), "utf8")).toBe("");
    } finally { child.kill("SIGKILL"); await result; }
  });
  it("rejects a stale precondition in the native operation itself", async () => {
    const root = await fixture(), binary = await prepareDarwinWorkspaceHelper(), cwd = join(root, "workspace");
    await writeFile(join(cwd, "src/file"), "current");
    const { child, result } = delayedWrite(binary, cwd, "src/file", createHash("sha256").update("stale").digest("hex"));
    child.stdin!.end("bad");
    expect(await result).toMatchObject({ code: 1, error: expect.stringMatching(/digest changed/) });
    expect(await readFile(join(cwd, "src/file"), "utf8")).toBe("current");
  });
  it("rebuilds a missing cached helper before read/write and shares the replacement across concurrent callers", async () => {
    const root = await fixture(), cwd = join(root, "workspace"), before = await prepareDarwinWorkspaceHelper();
    await writeFile(join(cwd, "src/file"), "current");
    await rm(before);
    const paths = await Promise.all(Array.from({ length: 8 }, () => prepareDarwinWorkspaceHelper()));
    expect(new Set(paths).size).toBe(1); expect(paths[0]).not.toBe(before);
    expect(await darwinWorkspaceFile(cwd, "src/file")).toEqual(Buffer.from("current"));
    await darwinWorkspaceFile(cwd, "src/file", { bytes: Buffer.from("updated"), expectedSha256: createHash("sha256").update("current").digest("hex") });
    expect(await readFile(join(cwd, "src/file"), "utf8")).toBe("updated");
  });
});
