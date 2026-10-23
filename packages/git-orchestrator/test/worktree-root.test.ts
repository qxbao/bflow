import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "./test-artifact-store.js";
import { GitIntegrationEngine } from "../src/index.js";

const execute = promisify(execFile);
async function git(directory: string, ...args: string[]) {
  return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
    cwd: directory, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  })).stdout.trim();
}

// Agent CLIs refuse writes under `.git`, so Runtime places Developer worktrees under an explicit root in the checkout.
describe("GitIntegrationEngine worktreeRoot", () => {
  let temporary: string, repository: string, base: string, store: FilesystemArtifactStore;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "bflow-root-"));
    repository = join(temporary, "repository");
    await mkdir(join(repository, "src"), { recursive: true });
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "user.name", "Bflow Test");
    await git(repository, "config", "user.email", "bflow@example.invalid");
    await writeFile(join(repository, "src", "shared.txt"), "original\n");
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "initial");
    base = await git(repository, "rev-parse", "HEAD");
    const opened = await openFilesystemArtifactStore({ root: join(temporary, "artifacts"), storeId: "root-tests" });
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
  });
  afterEach(async () => { store?.close(); await rm(temporary, { recursive: true, force: true }); });
  const request = (taskId: string) => ({ runId: "run-1", taskId, attemptId: "attempt-1", baseRevision: base, ownedPaths: ["src"], developerId: `developer-${taskId}` });

  it("creates worktrees under the root without dirtying the main checkout", async () => {
    const root = join(await git(repository, "rev-parse", "--show-toplevel"), ".bflow", "state", "worktrees");
    const engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, worktreeRoot: root });
    const task = await engine.prepareTask(request("task-a"));
    expect(task.worktreePath.startsWith(`${root}/`)).toBe(true);
    expect(task.worktreePath).not.toContain("/.git/");
    expect(await git(repository, "status", "--porcelain", "--untracked-files=all")).toBe("");
    await expect(GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, worktreeRoot: "relative" })).rejects.toThrow(/absolute/);
  });

  it("reopens a journal whose earlier worktrees live in the legacy Git-directory location", async () => {
    const legacy = await (await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store })).prepareTask(request("task-a"));
    expect(legacy.worktreePath).toContain("/bflow-git/trees/");
    const root = join(await git(repository, "rev-parse", "--show-toplevel"), ".bflow", "state", "worktrees");
    const engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, worktreeRoot: root });
    expect((await engine.prepareTask(request("task-a"))).worktreePath).toBe(legacy.worktreePath);
    expect((await engine.prepareTask(request("task-b"))).worktreePath.startsWith(`${root}/`)).toBe(true);
  });
});
