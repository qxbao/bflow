import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import {
  propagateClaudeWorktreeTrustIfRootTrusted,
  resolveClaudeTrustStateFiles
} from "../src/claude-trust.js";
import {
  ensureCodexWorkspaceTrust,
  isCodexWorkspaceTrusted,
  propagateCodexWorktreeTrustIfRootTrusted
} from "../src/codex-trust.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("Flow-04 Round 4 Provider Trust and Trailing Slash Normalization", () => {
  it("propagates Claude workspace trust even when projects root has trailing slash or worktree has trailing slash", async () => {
    const home = await makeTempDir("claude-trust-test-");
    const claudeJsonFile = join(home, ".claude.json");
    const workspaceRoot = "/workspace/my-repo";
    const worktreePath = "/workspace/my-repo/.worktrees/task-1";

    // Write .claude.json with trailing slash in the root entry!
    await writeFile(
      claudeJsonFile,
      JSON.stringify({
        projects: {
          [`${workspaceRoot}/`]: {
            hasTrustDialogAccepted: true
          }
        }
      })
    );

    const env = { HOME: home };
    // Propagate trust without trailing slash in workspaceRoot argument
    const result = await propagateClaudeWorktreeTrustIfRootTrusted({
      workspaceRoot,
      worktreePath: `${worktreePath}/`,
      env
    });

    expect(result).toBe("trusted");

    const content = JSON.parse(await readFile(claudeJsonFile, "utf8"));
    // Both normalized and/or worktree keys should be trusted
    expect(
      content.projects[worktreePath]?.hasTrustDialogAccepted === true ||
      content.projects[`${worktreePath}/`]?.hasTrustDialogAccepted === true
    ).toBe(true);
  });

  it("checks and propagates Codex workspace trust with trailing slashes", async () => {
    const codexHome = await makeTempDir("codex-trust-test-");
    const configFile = join(codexHome, "config.toml");
    const workspaceRoot = "/workspace/codex-repo";
    const worktreePath = "/workspace/codex-repo/.worktrees/dev-1";

    // Write config.toml with trailing slash in projects table
    await writeFile(
      configFile,
      `[projects."${workspaceRoot}/"]\ntrust_level = "trusted"\n`
    );

    // isCodexWorkspaceTrusted should find it even if called without trailing slash
    expect(await isCodexWorkspaceTrusted(workspaceRoot, configFile)).toBe(true);

    const result = await propagateCodexWorktreeTrustIfRootTrusted({
      workspaceRoot,
      worktreePath,
      configFile
    });

    expect(result).toBe("trusted");

    const parsed = parse(await readFile(configFile, "utf8")) as Record<string, unknown>;
    const projects = parsed["projects"] as Record<string, unknown>;
    const worktreeEntry = projects[worktreePath] ?? projects[`${worktreePath}/`];
    expect((worktreeEntry as Record<string, unknown>)?.["trust_level"]).toBe("trusted");
  });
});
