import { describe, it, expect, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_BIN = resolve(process.cwd(), "apps/cli/dist/bin.js");

function runCli(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [CLI_BIN, ...args],
      {
        cwd: cwd ?? process.cwd(),
        env: env ? { ...process.env, ...env } : process.env,
        encoding: "utf8",
        timeout: 10000,
        killSignal: "SIGKILL"
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && "code" in error && typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0;
        res({ stdout, stderr, exitCode });
      }
    );
  });
}

describe("Scenario E09 — CLI Subprocess Verification & End-to-End Execution", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "bflow-cli-e2e-"));
    execFileSync("git", ["init", "--quiet", dir]);
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    const errors: unknown[] = [];
    for (const dir of tempDirs) {
      try {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch (err) {
        errors.push(err);
      }
    }
    tempDirs.length = 0;
    if (errors.length > 0) {
      throw new AggregateError(errors, "CLI test cleanup encountered errors");
    }
  });

  it("prints help and exits with 0 on --help", async () => {
    const { stdout, stderr, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Autonomous SDLC workflow orchestration CLI");
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain("init");
    expect(stdout).toContain("run");
    expect(stdout).toContain("status");
    expect(stdout).toContain("approve");
    expect(stdout).toContain("resume");
    expect(stdout).toContain("cancel");
  });

  it("handles unknown commands and exits with 2 (validation)", async () => {
    const { stderr, exitCode } = await runCli(["unknown-command"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Unknown command 'unknown-command'");
  });

  it("PROBE PM-13 (VERIFIED): CLI --version returns exit code 0 and semver string", async () => {
    const { stdout, stderr, exitCode } = await runCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("validates command arguments: missing requirement in run exits with 2", async () => {
    const { stderr, exitCode } = await runCli(["run"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Missing required <requirement> argument");
  });

  it("executes 'bflow init' successfully in empty directory, creating config file", async () => {
    const workDir = makeTempDir();
    const { stdout, exitCode } = await runCli(["init"], workDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("bflow repository configuration ready at:");
    const configPath = join(workDir, ".bflow", "config.yml");
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(workDir, ".bflow", "config.yaml"))).toBe(false);
    const configText = readFileSync(configPath, "utf8");
    expect(configText).toContain("# Bflow repository configuration");
    expect(configText).toContain("environment:\n");
    expect(configText.trimStart().startsWith("{")).toBe(false);
  });

  it("fails gracefully when .bflow/config.json contains malformed JSON", async () => {
    const workDir = makeTempDir();
    const configDir = join(workDir, ".bflow");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "{ invalid JSON content !!!", "utf8");

    const statusRes = await runCli(["status", "-j"], workDir);
    expect(statusRes.exitCode).toBeGreaterThanOrEqual(1);
  });

  it("composes RuntimeService in bin.ts: fails closed without config, and executes run, status, and cancel end-to-end after init", async () => {
    const workDir = makeTempDir();

    // 1. Without .bflow/config.yml, runtime status <runId> -j fails closed with not_found
    const uninitStatus = await runCli(["status", "run-123", "-j"], workDir);
    expect(uninitStatus.exitCode).toBe(1);
    const parsedUninit = JSON.parse(uninitStatus.stderr);
    expect(parsedUninit.ok).toBe(false);
    expect(parsedUninit.error.code).toBe("not_found");

    // 2. Initialize repository configuration
    const initRes = await runCli(["init"], workDir);
    expect(initRes.exitCode).toBe(0);

    // 3. Create executable mock-herdr script in workDir for HerdrAdapter CLI verification
    const mockHerdrPath = join(workDir, "mock-herdr.mjs");
    const mockHerdrScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("herdr 0.9.1\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] === "schema") {
  process.stdout.write("protocol: 22\\nschema_version: 1\\n");
  process.exit(0);
}
const makeAgent = (paneId, status, rev) => {
  const role = paneId.startsWith("pane-") ? paneId.slice("pane-".length) : paneId;
  return {
    agent: "claude-code",
    name: role + "-default",
    agent_status: status,
    workspace_id: "ws-1",
    tab_id: "tab-1",
    pane_id: paneId,
    terminal_id: "term-" + paneId,
    revision: rev,
    state_change_seq: rev,
    agent_session: { source: "herdr", kind: "id", value: "session-" + paneId }
  };
};
if (args[0] === "agent" && args[1] === "get") {
  const paneId = args[2] ?? "pane-planner";
  process.stdout.write(JSON.stringify({ id: "cli:agent:get", result: { type: "agent_info", agent: makeAgent(paneId, "idle", 1) } }) + "\\n");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "prompt") {
  const paneId = args[2] ?? "pane-planner";
  process.stdout.write(JSON.stringify({ id: "cli:agent:prompt", result: { type: "agent_prompted", agent: makeAgent(paneId, "working", 2) } }) + "\\n");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "send-keys") {
  process.stdout.write(JSON.stringify({ id: "cli:agent:send-keys", result: { type: "ok" } }) + "\\n");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "wait") {
  const paneId = args[2] ?? "pane-planner";
  process.stdout.write(JSON.stringify({ id: "cli:agent:wait", result: { type: "agent_wait", agent: makeAgent(paneId, "working", 2) } }) + "\\n");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "read") {
  process.stdout.write("");
  process.exit(0);
}
process.exit(0);
`;
    writeFileSync(mockHerdrPath, mockHerdrScript, "utf8");
    chmodSync(mockHerdrPath, 0o755);

    const cliEnv = { BFLOW_HERDR_BIN: mockHerdrPath };

    // 4. Execute bflow run "Build authentication feature" -j
    const runRes = await runCli(["run", "Build authentication feature", "-j"], workDir, cliEnv);
    expect(runRes.exitCode).toBe(0);
    const parsedRun = JSON.parse(runRes.stdout);
    expect(parsedRun.ok).toBe(true);
    expect(parsedRun.command).toBe("run");
    expect(parsedRun.data.status).toBe("running");
    const runId: string = parsedRun.data.runId;
    expect(typeof runId).toBe("string");

    // 5. Execute bflow status <runId> -j
    const statusRes = await runCli(["status", runId, "-j"], workDir, cliEnv);
    expect(statusRes.exitCode).toBe(0);
    const parsedStatus = JSON.parse(statusRes.stdout);
    expect(parsedStatus.ok).toBe(true);
    expect(parsedStatus.command).toBe("status");
    expect(parsedStatus.data.runId).toBe(runId);

    // 6. Execute bflow cancel <runId> --reason "Stop test" -j
    const cancelRes = await runCli(["cancel", runId, "--reason", "Stop test", "-j"], workDir, cliEnv);
    expect(cancelRes.exitCode).toBe(0);
    const parsedCancel = JSON.parse(cancelRes.stdout);
    expect(parsedCancel.ok).toBe(true);
    expect(parsedCancel.command).toBe("cancel");
    expect(["cancelling", "cancelled"]).toContain(parsedCancel.data.status);
  });
});
