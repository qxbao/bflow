import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitWorktreeInspector } from "../src/runner.js";

describe("production worktree safety inspection", () => {
  let root: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bflow-pane-safety-"));
    git("init", "-q");
    git("config", "user.name", "Safety Test");
    git("config", "user.email", "safety@example.test");
    await writeFile(join(root, "source.txt"), "original\n");
    await writeFile(join(root, ".gitignore"), "local-secret.txt\n");
    git("add", ".");
    git("commit", "-qm", "fixture");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each(["--assume-unchanged", "--skip-worktree"])("rejects edits hidden by %s without clearing flags or edits", async flag => {
    git("update-index", flag, "source.txt");
    await writeFile(join(root, "source.txt"), "unpreserved edit\n");
    const before = git("ls-files", "-v");
    const result = await createGitWorktreeInspector().inspect(root);
    expect(result).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(git("ls-files", "-v")).toBe(before);
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("unpreserved edit\n");
  });

  it("counts ignored files and preserves unusual filenames in dirty diagnostics", async () => {
    await writeFile(join(root, "local-secret.txt"), "must survive release\n");
    await writeFile(join(root, " name\nwith whitespace "), "untracked\n");
    const result = await createGitWorktreeInspector().inspect(root);
    expect(result).toMatchObject({ ok: true, value: { isClean: false } });
    if (result.ok) expect(result.value.dirtyFiles).toEqual(expect.arrayContaining(["local-secret.txt", " name\nwith whitespace "]));
    if (result.ok) expect((result.value as any).ignoredFiles).toEqual(["local-secret.txt"]);
  });

  it("ignores inherited repository and index overrides when inspecting a dirty checkout", async () => {
    const other = await mkdtemp(join(tmpdir(), "bflow-pane-clean-"));
    try {
      execFileSync("git", ["init", "-q", other]);
      await writeFile(join(root, "source.txt"), "dirty target\n");
      vi.stubEnv("GIT_DIR", join(other, ".git"));
      vi.stubEnv("GIT_WORK_TREE", other);
      vi.stubEnv("GIT_INDEX_FILE", join(other, ".git", "index"));
      const result = await createGitWorktreeInspector().inspect(root);
      expect(result).toMatchObject({ ok: true, value: { isClean: false, dirtyFiles: ["source.txt"] } });
    } finally {
      vi.unstubAllEnvs();
      await rm(other, { recursive: true, force: true });
    }
  });
});
