import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitIntegrationEngine } from "../src/index.js";
import * as journalModule from "../src/journal.js";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "./test-artifact-store.js";

const execute = promisify(execFile);

async function rawGit(directory: string, ...args: string[]) {
  return (
    await execute(
      "git",
      ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      }
    )
  ).stdout.trim();
}

async function seedRepo(repository: string): Promise<string> {
  await mkdir(join(repository, "src", "nested"), { recursive: true });
  await rawGit(repository, "init", "-b", "main");
  await rawGit(repository, "config", "user.name", "Bflow Test");
  await rawGit(repository, "config", "user.email", "bflow@example.invalid");
  await writeFile(join(repository, "src", "shared.txt"), "original\n");
  await writeFile(join(repository, "src", "nested", "inner.txt"), "inner\n");
  await rawGit(repository, "add", ".");
  await rawGit(repository, "commit", "-m", "initial");
  return rawGit(repository, "rev-parse", "HEAD");
}

const cleanups: (() => Promise<void>)[] = [];
const stores: FilesystemArtifactStore[] = [];
const savedHome = process.env.HOME;

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function makeStore(root: string): Promise<FilesystemArtifactStore> {
  const opened = await openFilesystemArtifactStore({ root, storeId: "slice7-git-tests" });
  if (!opened.ok) throw new Error(opened.error.message);
  stores.push(opened.value);
  return opened.value;
}

describe("Slice 7 GitIntegrationEngine FUSE/NTFS, symlink, and worktree hardening", () => {
  it("suppresses phantom core.fileMode dirty diffs when filesystem forces +x on .git metadata while preserving POSIX +x tracking", async () => {
    const temp = await mkdtemp(join(tmpdir(), "bflow-git-filemode-"));
    cleanups.push(() => rm(temp, { recursive: true, force: true }));

    // 1. Simulated FUSE/NTFS/VFAT mount where .git/HEAD and working files report +x despite 100644 index entries
    const fuseRepo = join(temp, "fuse-like-repo");
    const base = await seedRepo(fuseRepo);
    await rawGit(fuseRepo, "config", "core.fileMode", "true");
    await chmod(join(fuseRepo, ".git", "HEAD"), 0o755);
    await chmod(join(fuseRepo, "src", "shared.txt"), 0o755);
    await chmod(join(fuseRepo, "src", "nested", "inner.txt"), 0o755);

    const store = await makeStore(join(temp, "artifacts"));
    const engine = await GitIntegrationEngine.open({
      repositoryPath: join(fuseRepo, "src", "nested"),
      artifactStore: store,
      worktreeRoot: join(temp, "fuse-worktrees")
    });
    expect((await engine.inspect()).dirty).toBe(false);

    const task = await engine.prepareTask({
      runId: "run-fm",
      taskId: "task-fm",
      attemptId: "attempt-1",
      baseRevision: base,
      ownedPaths: ["src"],
      developerId: "dev-fm"
    });
    // Force +x on the worktree gitfile and working tree files as fuseblk does
    await chmod(join(task.worktreePath, ".git"), 0o755);
    await chmod(join(task.worktreePath, "src", "shared.txt"), 0o755);
    await writeFile(join(task.worktreePath, "src", "shared.txt"), "updated\n");
    await chmod(join(task.worktreePath, "src", "shared.txt"), 0o755);
    await rawGit(task.worktreePath, "-c", "core.fileMode=false", "add", "src/shared.txt");
    await rawGit(task.worktreePath, "-c", "core.fileMode=false", "commit", "-m", "task update");
    await chmod(join(task.worktreePath, "src", "nested", "inner.txt"), 0o755);

    const collected = await engine.collectTask(task.key);
    expect(collected.filesChanged).toEqual([
      { path: "src/shared.txt", changeType: "modified", additions: 1, deletions: 1 }
    ]);

    // 2. Normal POSIX mount (.git/HEAD is 0644): executable mode bit transitions MUST still be tracked
    const posixRepo = join(temp, "posix-repo");
    await seedRepo(posixRepo);
    await rawGit(posixRepo, "config", "core.fileMode", "true");
    await chmod(join(posixRepo, ".git", "HEAD"), 0o644);
    await chmod(join(posixRepo, "src", "shared.txt"), 0o755);

    const posixEngine = await GitIntegrationEngine.open({
      repositoryPath: posixRepo,
      artifactStore: store,
      worktreeRoot: join(temp, "posix-worktrees")
    });
    expect((await posixEngine.inspect()).dirty).toBe(true);
  });

  it("operates under isolated HOME without global safe.directory on foreign-owned FUSE mounts, including from subdirectories", async () => {
    const cacheParent = resolve(import.meta.dirname, "../../..", "node_modules", ".cache");
    await mkdir(cacheParent, { recursive: true });
    const mountRoot = await mkdtemp(join(cacheParent, "bflow-slice7-fuse-"));
    cleanups.push(() => rm(mountRoot, { recursive: true, force: true }));

    const isolatedHome = await mkdtemp(join(tmpdir(), "bflow-git-isolated-home-"));
    cleanups.push(() => rm(isolatedHome, { recursive: true, force: true }));

    const repo = join(mountRoot, "repo");
    const base = await seedRepo(repo);
    // Explicitly test core.fileMode=true on the real workspace filesystem as well
    await rawGit(repo, "config", "core.fileMode", "true");

    // Isolate HOME so no ~/.gitconfig safe.directory=* can mask dubious-ownership checks
    process.env.HOME = isolatedHome;

    const store = await makeStore(join(isolatedHome, "artifacts"));
    const engine = await GitIntegrationEngine.open({
      repositoryPath: join(repo, "src", "nested"),
      artifactStore: store,
      worktreeRoot: join(mountRoot, "worktrees")
    });
    expect((await engine.inspect()).dirty).toBe(false);

    const task = await engine.prepareTask({
      runId: "run-fuse",
      taskId: "task-fuse",
      attemptId: "attempt-1",
      baseRevision: base,
      ownedPaths: ["src"],
      developerId: "dev-fuse"
    });
    await writeFile(join(task.worktreePath, "src", "shared.txt"), "fuse-safe\n");
    await rawGit(task.worktreePath, "-c", "core.fileMode=false", "add", "src/shared.txt");
    await rawGit(task.worktreePath, "-c", "core.fileMode=false", "commit", "-m", "fuse commit");

    const changeSet = await engine.collectTask(task.key);
    expect(changeSet.filesChanged.map(f => f.path)).toEqual(["src/shared.txt"]);
  });

  it("canonicalizes symlinked worktreeRoot parents so prepareTask and collectTask match Git canonical paths", async () => {
    const temp = await mkdtemp(join(tmpdir(), "bflow-git-symroot-"));
    cleanups.push(() => rm(temp, { recursive: true, force: true }));

    const repo = join(temp, "repo");
    const base = await seedRepo(repo);
    const realParent = join(temp, "real-state");
    await mkdir(realParent, { recursive: true });
    const symlinkParent = join(temp, "linked-state");
    await symlink(realParent, symlinkParent);

    const store = await makeStore(join(temp, "artifacts"));
    const engine = await GitIntegrationEngine.open({
      repositoryPath: repo,
      artifactStore: store,
      worktreeRoot: join(symlinkParent, "nested", "worktrees")
    });

    const task = await engine.prepareTask({
      runId: "run-sym",
      taskId: "task-sym",
      attemptId: "attempt-1",
      baseRevision: base,
      ownedPaths: ["src"],
      developerId: "dev-sym"
    });
    expect((await stat(task.worktreePath)).isDirectory()).toBe(true);

    // Reopening with the symlinked worktreeRoot must recognize existing journal records
    const reopened = await GitIntegrationEngine.open({
      repositoryPath: repo,
      artifactStore: store,
      worktreeRoot: join(symlinkParent, "nested", "worktrees")
    });
    const same = await reopened.prepareTask({
      runId: "run-sym",
      taskId: "task-sym",
      attemptId: "attempt-1",
      baseRevision: base,
      ownedPaths: ["src"],
      developerId: "dev-sym"
    });
    expect(same.worktreePath).toBe(task.worktreePath);
  });

  it("recovers cleanly when a managed or prunable worktree directory was deleted externally on disk", async () => {
    const temp = await mkdtemp(join(tmpdir(), "bflow-git-stale-wt-"));
    cleanups.push(() => rm(temp, { recursive: true, force: true }));

    const repo = join(temp, "repo");
    const base = await seedRepo(repo);
    const store = await makeStore(join(temp, "artifacts"));
    const engine = await GitIntegrationEngine.open({
      repositoryPath: repo,
      artifactStore: store,
      worktreeRoot: join(temp, "worktrees")
    });

    // 1. Managed locked worktree whose directory was externally deleted before cleanupTask
    const task = await engine.prepareTask({
      runId: "run-stale",
      taskId: "task-deleted",
      attemptId: "attempt-1",
      baseRevision: base,
      ownedPaths: ["src"],
      developerId: "dev-1"
    });
    await engine.cancelTask(task.key);
    await rm(task.worktreePath, { recursive: true, force: true });

    const cleaned = await engine.cleanupTask(task.key);
    expect(cleaned.status).toBe("cleaned");

    // 2. Unlocked prunable worktree registration holding a target branch/path whose directory vanished
    const staleBranch = "agent/developer-2/run-stale/task-prunable/attempt-1";
    const ghostDir = join(temp, "ghost-worktree");
    await rawGit(repo, "worktree", "add", "-b", staleBranch, ghostDir, base);
    await rm(ghostDir, { recursive: true, force: true });
    // Delete the stale branch ref after directory vanished? No: keep prunable registration, delete branch only after prune or test branch_in_use
    // Actually git refuses `branch -D` while prunable worktree still references it unless pruned first!
    // And prepareTask for a DIFFERENT task or after branch deletion shouldn't trip over prunable entries:
    // If an external crash left an unlocked prunable worktree at a path, git worktree prune clears it so branch/worktree checks are accurate.
    await rawGit(repo, "update-ref", "-d", `refs/heads/${staleBranch}`);
    const recovered = await engine.prepareTask({
      runId: "run-stale",
      taskId: "task-prunable",
      attemptId: "attempt-1",
      baseRevision: base,
      ownedPaths: ["src"],
      developerId: "developer-2"
    });
    expect(recovered.status).toBe("active");
  });

  it("tolerates benign FUSE/NTFS directory fsync errnos in syncDirectory while rethrowing real I/O failures", async () => {
    const syncDirectory = (
      journalModule as unknown as {
        syncDirectory?: (
          directory: string,
          openDirectory?: (path: string, flags: string) => Promise<{ sync: () => Promise<void>; close: () => Promise<void> }>
        ) => Promise<void>;
      }
    ).syncDirectory;
    expect(typeof syncDirectory).toBe("function");

    for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EACCES", "EBADF", "EROFS"]) {
      let closed = false;
      await expect(
        syncDirectory!("/virtual-fuse-dir", async () => ({
          sync: async () => {
            throw Object.assign(new Error(`fsync ${code}`), { code });
          },
          close: async () => {
            closed = true;
          }
        }))
      ).resolves.toBeUndefined();
      expect(closed).toBe(true);
    }

    let closedOnIoError = false;
    await expect(
      syncDirectory!("/virtual-fuse-dir", async () => ({
        sync: async () => {
          throw Object.assign(new Error("disk I/O failure"), { code: "EIO" });
        },
        close: async () => {
          closedOnIoError = true;
        }
      }))
    ).rejects.toThrow("disk I/O failure");
    expect(closedOnIoError).toBe(true);
  });
});
