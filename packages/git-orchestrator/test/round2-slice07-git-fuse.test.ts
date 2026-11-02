import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gitDirectoryFlags } from "../src/git.js";
import * as journalModule from "../src/journal.js";

const execute = promisify(execFile);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function rawGit(cwd: string, ...args: string[]): Promise<string> {
  return (
    await execute(
      "git",
      ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
    )
  ).stdout.trim();
}

describe("Round 2 Slice 7 GitIntegrationEngine FUSE/NTFS worktree & fsync hardening", () => {
  it("emits core.fileMode=false for a POSIX linked worktree pointing to an NTFS/+x repository gitDir and includes logical + canonical safe.directory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2s7-git-flags-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const fuseLikeRepo = join(root, "ntfs-repo");
    await mkdir(fuseLikeRepo, { recursive: true });
    await rawGit(fuseLikeRepo, "init", "-b", "main");
    await rawGit(fuseLikeRepo, "config", "user.name", "Bflow Test");
    await rawGit(fuseLikeRepo, "config", "user.email", "bflow@example.invalid");
    await writeFile(join(fuseLikeRepo, "app.ts"), "export const ok = true;\n");
    await rawGit(fuseLikeRepo, "add", ".");
    await rawGit(fuseLikeRepo, "commit", "-m", "init");

    // Detached/linked worktree on POSIX /tmp (0644 .git file) whose backing repo on NTFS has +x on .git/HEAD & worktrees/*/HEAD
    const linkedWorktree = join(root, "posix-worktree");
    await rawGit(fuseLikeRepo, "worktree", "add", "--detach", linkedWorktree, "HEAD");
    await chmod(join(linkedWorktree, ".git"), 0o644);
    await chmod(join(fuseLikeRepo, ".git", "HEAD"), 0o755);

    const symlinkAlias = join(root, "alias-worktree");
    await symlink(linkedWorktree, symlinkAlias);

    const flags = await gitDirectoryFlags(symlinkAlias);
    expect(flags).toContain("core.fileMode=false");
    expect(flags).toContain(`safe.directory=${symlinkAlias}`);
    expect(flags).toContain(`safe.directory=${linkedWorktree}`);
    expect(flags).toContain(`safe.directory=${fuseLikeRepo}`);
  });

  it("recognizes bare Git repositories with +x HEAD metadata and adds safe.directory + core.fileMode=false", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2s7-git-bare-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const bareRepo = join(root, "bare.git");
    await mkdir(bareRepo, { recursive: true });
    await rawGit(bareRepo, "init", "--bare", "-b", "main");
    await chmod(join(bareRepo, "HEAD"), 0o755);

    const flags = await gitDirectoryFlags(bareRepo);
    expect(flags).toContain(`safe.directory=${bareRepo}`);
    expect(flags).toContain("core.fileMode=false");
  });

  it("tolerates ENOSYS in syncDirectory and benign FUSE/NTFS errnos on regular-file fsync while rethrowing EIO", async () => {
    let dirClosed = false;
    await expect(
      journalModule.syncDirectory("/virtual-fuse-dir", async () => ({
        sync: async () => {
          throw Object.assign(new Error("fsync ENOSYS"), { code: "ENOSYS" });
        },
        close: async () => {
          dirClosed = true;
        }
      }))
    ).resolves.toBeUndefined();
    expect(dirClosed).toBe(true);

    const syncFileHandle = (
      journalModule as unknown as {
        syncFileHandle?: (handle: { sync: () => Promise<void> }) => Promise<void>;
      }
    ).syncFileHandle;
    expect(typeof syncFileHandle).toBe("function");

    for (const code of ["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EROFS", "EPERM", "EACCES"]) {
      await expect(
        syncFileHandle!({
          sync: async () => {
            throw Object.assign(new Error(`file fsync ${code}`), { code });
          }
        })
      ).resolves.toBeUndefined();
    }

    await expect(
      syncFileHandle!({
        sync: async () => {
          throw Object.assign(new Error("real disk EIO"), { code: "EIO" });
        }
      })
    ).rejects.toThrow("real disk EIO");
  });
});
