import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexWorkspaceTrust } from "../src/codex-trust.js";
import { codexHookPolicyPath, inspectCodexHooks, trustAllCodexHooks } from "../src/codex-hook-trust.js";

const roots: string[] = [];
const originalOpen = fsPromises.open;

afterEach(async () => {
  if (fsPromises.open !== originalOpen) {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

describe("Slice 2 provider hardening", () => {
  it("preserves all worktree entries under concurrent ensureCodexWorkspaceTrust calls (including equal-byte-length sibling paths)", async () => {
    const dir = await makeTempDir("bflow-codex-trust-race-");
    const configFile = join(dir, "config.toml");

    const siblingWorktrees = [
      "/repo/.worktrees/task-01",
      "/repo/.worktrees/task-02",
      "/repo/.worktrees/task-03",
      "/repo/.worktrees/task-04",
      "/repo/.worktrees/task-05",
      "/repo/.worktrees/task-06",
      "/repo/.worktrees/task-07",
      "/repo/.worktrees/task-08",
      '/repo/.worktrees/task "quoted" space'
    ];

    const outcomes = await Promise.all(
      siblingWorktrees.map(wt => ensureCodexWorkspaceTrust(wt, configFile))
    );

    expect(outcomes).toEqual(siblingWorktrees.map(() => "trusted"));

    const parsed = parse(await readFile(configFile, "utf8")) as {
      projects?: Record<string, { trust_level?: string }>;
    };
    for (const wt of siblingWorktrees) {
      expect(parsed.projects?.[wt]?.trust_level).toBe("trusted");
    }
  });

  it("tolerates FUSE/NTFS directory fsync EINVAL after atomic rename in Codex hook approval store writes", async () => {
    const root = await makeTempDir("bflow-codex-fuse-fsync-");
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome, { mode: 0o700 });
    const hookScript = join(codexHome, "hook.sh");
    await writeFile(hookScript, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(
      join(codexHome, "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: hookScript }] }]
        }
      }),
      { mode: 0o600 }
    );
    const approvalStorePath = join(root, "state", "codex-hook-approvals.json");

    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      const info = await handle.stat();
      if (info.isDirectory()) {
        handle.sync = async () => {
          throw Object.assign(new Error("EINVAL: invalid argument, fsync"), { code: "EINVAL" });
        };
      }
      return handle;
    }) as typeof originalOpen;
    syncBuiltinESMExports();

    const policy = await trustAllCodexHooks({
      codexHomeDirectory: codexHome,
      approvalStorePath,
      approvedBy: "slice2-test",
      environment: { HOME: root, PATH: "/usr/bin:/bin" }
    });
    expect(policy.policy).toBe("trust_all");
    const persisted = JSON.parse(await readFile(codexHookPolicyPath(approvalStorePath), "utf8")) as {
      policies: unknown[];
    };
    expect(persisted.policies).toHaveLength(1);
    const inspected = await inspectCodexHooks({
      codexHomeDirectory: codexHome,
      approvalStorePath,
      environment: { HOME: root, PATH: "/usr/bin:/bin" }
    });
    expect(inspected.status).toBe("approved");
  });
});
