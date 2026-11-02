import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEnvironmentSchema, type AgentEnvironment } from "@bflow/contracts";
import {
  CLAUDE_MCP_STARTUP_TIMEOUT_MS,
  CLAUDE_MCP_TOOL_TIMEOUT_MS,
  CodexProviderAdapter,
  createFakeProviderRunner,
  ensureCodexWorkspaceTrust,
  isCodexWorkspaceTrusted,
  preparePrivateCodexHome,
  propagateClaudeWorktreeTrustIfRootTrusted,
  propagateCodexWorktreeTrustIfRootTrusted,
  providerLaunchEnvironment,
  providerSessionEnvironment
} from "../src/index.js";

describe("Flow-04 provider MCP timeouts and dynamic worktree trust propagation", () => {
  let baseDir: string;
  let fakeBinaryPath: string;
  let codexHomeDir: string;

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow04-providers-")));
    fakeBinaryPath = join(baseDir, "codex");
    await writeFile(fakeBinaryPath, "#!/bin/sh\necho codex\n", { mode: 0o700 });
    codexHomeDir = join(baseDir, "codex-home");
    await mkdir(codexHomeDir, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  function makeCodexEnvironment(workspaceRoot: string, cwd = workspaceRoot): AgentEnvironment {
    const scope = {
      kind: "session" as const,
      machineId: "machine-1",
      repositoryId: "repo-1",
      workspaceRoot,
      sessionId: "sess-1"
    };
    return AgentEnvironmentSchema.parse({
      schemaVersion: 3,
      environmentId: "env-flow04-codex",
      role: "developer",
      provider: "codex",
      scope,
      cwd,
      stateDirectory: join(baseDir, "role-state"),
      configFingerprint: "b".repeat(64),
      permissionProfile: {
        schemaVersion: 3,
        profileId: "perm-codex",
        mode: "workspace_auto",
        scope,
        filesystem: "workspace_write",
        readableRoots: [workspaceRoot],
        writableRoots: [workspaceRoot],
        deniedRoots: [],
        isolation: "provider_policy",
        network: { mode: "deny", allowedHosts: [] },
        allowedTools: ["Read", "Edit"],
        deniedAction: "request_via_conversation",
        allowGlobalPermissionBypass: false
      },
      environmentVariables: {},
      secretBindings: {},
      requiredCapabilityIds: [],
      requiredMcpServiceIds: [],
      skillManifestDigest: "0".repeat(64)
    });
  }

  it("keeps providerSessionEnvironment minimal while providerLaunchEnvironment sets MCP_TOOL_TIMEOUT=600000 for Claude", () => {
    expect(providerSessionEnvironment("claude")).toEqual({
      DISABLE_AUTOUPDATER: "1",
      MCP_TIMEOUT: CLAUDE_MCP_STARTUP_TIMEOUT_MS
    });
    expect(providerLaunchEnvironment("claude")).toEqual({
      DISABLE_AUTOUPDATER: "1",
      MCP_TIMEOUT: CLAUDE_MCP_STARTUP_TIMEOUT_MS,
      MCP_TOOL_TIMEOUT: CLAUDE_MCP_TOOL_TIMEOUT_MS
    });
    expect(CLAUDE_MCP_STARTUP_TIMEOUT_MS).toBe("120000");
    expect(CLAUDE_MCP_TOOL_TIMEOUT_MS).toBe("600000");
    expect(providerLaunchEnvironment("codex")).toEqual({});
    expect(providerLaunchEnvironment("agy")).toEqual({});
  });

  it("injects startup_timeout_sec=120 and tool_timeout_sec=600 into Codex MCP TOML entries and preserves higher overrides", async () => {
    const workspaceRoot = join(baseDir, "repo");
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    await mkdir(join(baseDir, "role-state"), { recursive: true, mode: 0o700 });
    const env = makeCodexEnvironment(workspaceRoot);

    const adapter = new CodexProviderAdapter({
      codexHomeDirectory: codexHomeDir,
      runner: createFakeProviderRunner({ scenario: "healthy" }),
      executablePath: fakeBinaryPath,
      allowTestFilesystemOwnership: true,
      hostMcpServers: {
        bflow: {
          command: fakeBinaryPath,
          args: ["/opt/bflow/host.js", "mcp", "/opt/bflow/dev.json"]
        },
        custom_slow: {
          command: fakeBinaryPath,
          args: ["/opt/bflow/slow.js"],
          startup_timeout_sec: 180,
          tool_timeout_sec: 900
        }
      }
    });

    const launch = await adapter.prepareLaunch(env);
    if (!launch.ok) {
      throw new Error(`prepareLaunch failed: ${JSON.stringify(launch.error)}`);
    }
    expect(launch.ok).toBe(true);

    const mcpArg = launch.value.argv.find(item => item.startsWith("mcp_servers="));
    expect(mcpArg).toBeDefined();
    expect(mcpArg).toContain('"bflow"={');
    expect(mcpArg).toContain('"startup_timeout_sec"=120,"tool_timeout_sec"=600');
    expect(mcpArg).toContain('"startup_timeout_sec"=180,"tool_timeout_sec"=900');
  });

  it("propagates Codex trust to dynamic worktrees and symlink realpaths only when workspaceRoot is trusted", async () => {
    const realRoot = join(baseDir, "real-mount");
    await mkdir(realRoot, { recursive: true, mode: 0o700 });
    const symlinkMount = join(baseDir, "sym-mount");
    await symlink(realRoot, symlinkMount);

    const workspaceRoot = join(symlinkMount, "repo");
    const worktreeA = join(symlinkMount, "repo", ".bflow", "worktrees", "task-a");
    const worktreeDenied = join(symlinkMount, "repo", ".bflow", "worktrees", "task-denied");
    await mkdir(worktreeA, { recursive: true, mode: 0o700 });
    await mkdir(worktreeDenied, { recursive: true, mode: 0o700 });

    const configFile = join(codexHomeDir, "config.toml");

    // 1. Untrusted root -> skipped, file untouched
    expect(
      await propagateCodexWorktreeTrustIfRootTrusted({
        workspaceRoot,
        worktreePath: worktreeA,
        configFile
      })
    ).toBe("skipped");

    // 2. Trust workspaceRoot -> worktreeA and its canonical realpath become trusted
    expect(await ensureCodexWorkspaceTrust(workspaceRoot, configFile)).toBe("trusted");
    expect(
      await propagateCodexWorktreeTrustIfRootTrusted({
        workspaceRoot,
        worktreePath: worktreeA,
        configFile
      })
    ).toBe("trusted");
    expect(await isCodexWorkspaceTrusted(worktreeA, configFile)).toBe(true);
    expect(await isCodexWorkspaceTrusted(join(realRoot, "repo", ".bflow", "worktrees", "task-a"), configFile)).toBe(
      true
    );

    // 3. Explicit untrusted entry on worktreeDenied is never overwritten
    const current = await readFile(configFile, "utf8");
    await writeFile(
      configFile,
      `${current}\n[projects.${JSON.stringify(worktreeDenied)}]\ntrust_level = "untrusted"\n`,
      { mode: 0o600 }
    );
    expect(
      await propagateCodexWorktreeTrustIfRootTrusted({
        workspaceRoot,
        worktreePath: worktreeDenied,
        configFile
      })
    ).toBe("skipped");

    // 4. Private Codex home also writes both lexical and realpath trusted project entries
    const privateState = join(baseDir, "private-codex-state");
    await mkdir(privateState, { recursive: true, mode: 0o700 });
    const prepared = await preparePrivateCodexHome(
      privateState,
      codexHomeDir,
      baseDir,
      { OPENAI_API_KEY: "sk-test-key" },
      { trustedProjects: [workspaceRoot, worktreeA] }
    );
    expect(prepared.mode).toBe("private");
    const privateConfig = await readFile(join(prepared.CODEX_HOME, "config.toml"), "utf8");
    expect(privateConfig).toContain(worktreeA);
    expect(privateConfig).toContain(join(realRoot, "repo", ".bflow", "worktrees", "task-a"));
  });

  it("propagates Claude trust across ORCA_CLAUDE_CONFIG_DIR, CLAUDE_CONFIG_DIR and HOME .claude.json files only where root is trusted", async () => {
    const homeDir = join(baseDir, "claude-home");
    const claudeDir = join(homeDir, ".claude");
    const orcaDir = join(baseDir, "orca-claude");
    await mkdir(claudeDir, { recursive: true, mode: 0o700 });
    await mkdir(orcaDir, { recursive: true, mode: 0o700 });

    const workspaceRoot = join(baseDir, "claude-repo");
    const worktreePath = join(workspaceRoot, ".bflow", "worktrees", "task-1");
    const deniedWorktree = join(workspaceRoot, ".bflow", "worktrees", "task-denied");
    await mkdir(worktreePath, { recursive: true, mode: 0o700 });
    await mkdir(deniedWorktree, { recursive: true, mode: 0o700 });

    const homeStateFile = join(homeDir, ".claude.json");
    const nestedStateFile = join(claudeDir, ".claude.json");
    const orcaStateFile = join(orcaDir, ".claude.json");

    // Root trusted in nestedStateFile & orcaStateFile, NOT trusted in homeStateFile
    await writeFile(
      homeStateFile,
      JSON.stringify({ projects: { [workspaceRoot]: { hasTrustDialogAccepted: false } } }),
      { mode: 0o600 }
    );
    await writeFile(
      nestedStateFile,
      JSON.stringify({
        projects: {
          [workspaceRoot]: { hasTrustDialogAccepted: true },
          [deniedWorktree]: { hasTrustDialogAccepted: false }
        }
      }),
      { mode: 0o600 }
    );
    await writeFile(
      orcaStateFile,
      JSON.stringify({ projects: { [workspaceRoot]: { hasTrustDialogAccepted: true } } }),
      { mode: 0o600 }
    );

    const env = {
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: claudeDir,
      ORCA_CLAUDE_CONFIG_DIR: orcaDir
    };

    expect(
      await propagateClaudeWorktreeTrustIfRootTrusted({
        workspaceRoot,
        worktreePath,
        env
      })
    ).toBe("trusted");

    const homeParsed = JSON.parse(await readFile(homeStateFile, "utf8")) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    const nestedParsed = JSON.parse(await readFile(nestedStateFile, "utf8")) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    const orcaParsed = JSON.parse(await readFile(orcaStateFile, "utf8")) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };

    expect(homeParsed.projects[worktreePath]).toBeUndefined();
    expect(nestedParsed.projects[worktreePath]?.hasTrustDialogAccepted).toBe(true);
    expect(orcaParsed.projects[worktreePath]?.hasTrustDialogAccepted).toBe(true);

    // Explicit false on deniedWorktree must not be overridden
    expect(
      await propagateClaudeWorktreeTrustIfRootTrusted({
        workspaceRoot,
        worktreePath: deniedWorktree,
        env: { CLAUDE_CONFIG_DIR: claudeDir }
      })
    ).toBe("skipped");
  });
});
