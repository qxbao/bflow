import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentEnvironmentSchema,
  CURRENT_PLATFORM_SCHEMA_VERSION,
  type AgentEnvironment
} from "@bflow/contracts";
import { CodexProviderAdapter, createFakeProviderRunner, trustAllCodexHooks } from "../src/index.js";
import { ensureCodexWorkspaceTrust } from "../src/codex-trust.js";
import { createProviderExecutionProbeCoalescer } from "../src/execution-probe-coalescer.js";
import type { ProviderCommandInvocation, ProviderCommandOutcome } from "../src/types.js";

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

function makeCodexEnvironment(cwd: string, stateDirectory: string): AgentEnvironment {
  return AgentEnvironmentSchema.parse({
    schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
    environmentId: "env-codex-round2",
    provider: "codex",
    role: "developer",
    scope: {
      kind: "session",
      machineId: "mach-1",
      repositoryId: "repo-1",
      workspaceRoot: cwd,
      sessionId: "sess-round2"
    },
    cwd,
    stateDirectory,
    configFingerprint: "a".repeat(64),
    permissionProfile: {
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      profileId: "perm-codex-auto",
      mode: "workspace_auto",
      scope: {
        kind: "session",
        machineId: "mach-1",
        repositoryId: "repo-1",
        workspaceRoot: cwd,
        sessionId: "sess-round2"
      },
      filesystem: "workspace_write",
      readableRoots: [cwd],
      writableRoots: [cwd],
      deniedRoots: [],
      isolation: "provider_policy",
      network: { mode: "deny", allowedHosts: [] },
      allowedTools: ["Read", "Edit"],
      deniedAction: "request_via_conversation",
      allowGlobalPermissionBypass: false
    },
    environmentVariables: {},
    secretBindings: {},
    requiredCapabilityIds: ["codex-implementation"],
    requiredMcpServiceIds: [],
    skillManifestDigest: "0".repeat(64)
  });
}

describe("Round 2 Slice 2 — agent-providers hardening", () => {
  it("ensureCodexWorkspaceTrust tolerates FUSE/NTFS file/directory fsync EINVAL/ENOTSUP instead of silently skipping trust", async () => {
    const dir = await makeTempDir("bflow-r2-codex-trust-fsync-");
    const configFile = join(dir, "config.toml");

    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        const err = new Error("EINVAL: invalid argument, fsync") as NodeJS.ErrnoException;
        err.code = "EINVAL";
        throw err;
      };
      void originalSync;
      return handle;
    }) as typeof originalOpen;
    syncBuiltinESMExports();

    const outcome = await ensureCodexWorkspaceTrust("/repo/.worktrees/fuse-task", configFile);
    expect(outcome).toBe("trusted");

    const parsed = parse(await readFile(configFile, "utf8")) as {
      projects?: Record<string, { trust_level?: string }>;
    };
    expect(parsed.projects?.["/repo/.worktrees/fuse-task"]?.trust_level).toBe("trusted");

    const codexHome = join(dir, "codex-home");
    const storeDir = join(dir, "hook-store");
    await mkdir(codexHome, { mode: 0o700 });
    await mkdir(storeDir, { mode: 0o700 });
    const policy = await trustAllCodexHooks({
      codexHomeDirectory: codexHome,
      approvalStorePath: join(storeDir, "codex-hook-approvals.json"),
      approvedBy: "round2-slice2"
    });
    expect(policy.policy).toBe("trust_all");
  });

  it("ensureCodexWorkspaceTrust escapes U+007F (DEL) in workspace paths so TOML 1.0 basic strings remain valid", async () => {
    const dir = await makeTempDir("bflow-r2-codex-trust-del-");
    const configFile = join(dir, "config.toml");
    const weirdWorktree = "/repo/.worktrees/task-\x7f-edge";

    const outcome = await ensureCodexWorkspaceTrust(weirdWorktree, configFile);
    expect(outcome).toBe("trusted");

    const parsed = parse(await readFile(configFile, "utf8")) as {
      projects?: Record<string, { trust_level?: string }>;
    };
    expect(parsed.projects?.[weirdWorktree]?.trust_level).toBe("trusted");

    // Directory at config.toml path skips cleanly without throwing raw EISDIR
    const dirConfig = join(dir, "dir-config.toml");
    await mkdir(dirConfig, { mode: 0o700 });
    await expect(ensureCodexWorkspaceTrust(weirdWorktree, dirConfig)).resolves.toBe("skipped");
  });

  it("CodexProviderAdapter prepareLaunch serializes valid TOML -c overrides when strings contain U+007F or optional fields are undefined", async () => {
    const root = await makeTempDir("bflow-r2-codex-toml-");
    const cwd = join(root, "worktree");
    const stateDir = join(root, "state");
    const codexHome = join(root, "codex-home");
    const binPath = join(root, "codex");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(binPath, "#!/bin/sh\necho 'codex 0.116.0'\n", { mode: 0o700 });

    const runner = createFakeProviderRunner({
      versionOutput: "codex-cli 0.116.0",
      helpOutputs: {
        "": "Usage: codex --sandbox --ask-for-approval --add-dir --enable -c --model --no-daemon",
        "mcp": "Usage: codex mcp list"
      }
    });

    const adapter = new CodexProviderAdapter({
      executablePath: binPath,
      allowTestFilesystemOwnership: true,
      runner,
      launchEnvironment: { HOME: root, CODEX_HOME: codexHome },
      hostMcpServers: {
        bflow: {
          command: "/usr/bin/node",
          args: ["/host/mcp.js", "arg-\x7f-del"],
          // Simulate runtime object carrying an undefined optional key
          ...({ env: undefined } as unknown as Record<string, never>)
        }
      },
      hostHooks: {
        SessionStart: "/usr/bin/node /host/hook.js"
      }
    });

    const env = makeCodexEnvironment(cwd, stateDir);
    const prepared = await adapter.prepareLaunch(env);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const cOverrides: string[] = [];
    for (let i = 0; i < prepared.value.argv.length; i++) {
      if (prepared.value.argv[i] === "-c" && typeof prepared.value.argv[i + 1] === "string") {
        cOverrides.push(prepared.value.argv[i + 1]!);
      }
    }
    expect(cOverrides.length).toBeGreaterThan(0);

    // Codex's -c key=value splits dotted LHS paths literally and parses every RHS value as TOML 1.0.
    for (const override of cOverrides) {
      expect(override).not.toContain("=undefined");
      const eq = override.indexOf("=");
      expect(eq).toBeGreaterThan(0);
      expect(() => parse(`val = ${override.slice(eq + 1)}\n`)).not.toThrow();
    }
  });

  it("ExecutionProbeCoalescer clamps follower fallback retry timeoutMs to remaining waiter budget and never leaks unhandledRejection on abort", async () => {
    const observedTimeouts: number[] = [];
    let callCount = 0;

    const coalescer = createProviderExecutionProbeCoalescer({
      runner: {
        run: async (invocation: ProviderCommandInvocation): Promise<ProviderCommandOutcome> => {
          callCount++;
          observedTimeouts.push(invocation.timeoutMs ?? -1);
          if (callCount === 1) {
            // Leader probe consumes ~80ms and fails so follower falls back to its own probe
            await new Promise(resolve => setTimeout(resolve, 80));
            return { exitCode: 1, stdout: "", stderr: "transient leader failure", started: true };
          }
          return { exitCode: 0, stdout: "ok", stderr: "", started: true };
        }
      }
    });

    const request = {
      identity: "id-budget-clamp",
      invocation: {
        executable: "/usr/bin/true",
        args: ["probe"],
        timeoutMs: 75_000
      },
      isCurrent: async () => true
    };

    const [leader, follower] = await Promise.all([
      coalescer.probe(request, { timeoutMs: 500 }),
      coalescer.probe(request, { timeoutMs: 250 })
    ]);

    expect(leader.exitCode).toBe(1);
    expect(follower.exitCode).toBe(0);
    expect(observedTimeouts).toHaveLength(2);
    // The follower's fallback retry MUST be clamped to <= waiter's remaining budget (<= 250ms), NOT 75_000ms!
    expect(observedTimeouts[1]).toBeLessThanOrEqual(250);
    expect(observedTimeouts[1]).toBeGreaterThan(0);

    // Also verify zero unhandledRejection when waiter aborts before a rejecting runner finishes
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const rejectingCoalescer = createProviderExecutionProbeCoalescer({
        runner: {
          run: async () => {
            await new Promise(resolve => setTimeout(resolve, 40));
            throw new Error("late runner crash after waiter timeout");
          }
        }
      });
      const timedOut = await rejectingCoalescer.probe(
        {
          identity: "id-reject-after-timeout",
          invocation: { executable: "/usr/bin/true", args: [], timeoutMs: 5_000 },
          isCurrent: async () => true
        },
        { timeoutMs: 10 }
      );
      expect(timedOut.failure).toBe("timeout");
      await new Promise(resolve => setTimeout(resolve, 70));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
