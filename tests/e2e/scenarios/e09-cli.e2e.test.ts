import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_BIN = resolve(process.cwd(), "apps/cli/dist/bin.js");

function runCli(
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [CLI_BIN, ...args],
      {
        cwd: cwd ?? process.cwd(),
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

describe("Scenario E09 — CLI Subprocess Verification & Prerequisite Gate", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ai-flow-cli-e2e-"));
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

  it("PROBE PM-13 (P07 DEFECT): CLI --version must return exit code 0 and semver string", async () => {
    const { stdout, stderr, exitCode } = await runCli(["--version"]);
    // INVARIANT: Standard CLI entrypoints must support --version flag returning exit code 0 and valid semver
    // (Upstream P07 does not implement a --version handler and treats it as an unknown command exiting with 2)
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("validates command arguments: missing requirement in run exits with 2", async () => {
    const { stderr, exitCode } = await runCli(["run"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Missing required <requirement> argument");
  });

  it("executes 'flow init' successfully in empty directory, creating config file", async () => {
    const workDir = makeTempDir();
    const { stdout, exitCode } = await runCli(["init"], workDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Initialized AI Flow repository configuration");
    expect(existsSync(join(workDir, ".ai-flow", "config.json"))).toBe(true);
  });

  it("fails gracefully when .ai-flow/config.json contains malformed JSON", async () => {
    const workDir = makeTempDir();
    const configDir = join(workDir, ".ai-flow");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "{ invalid JSON content !!!", "utf8");

    const statusRes = await runCli(["status", "-j"], workDir);
    expect(statusRes.exitCode).toBeGreaterThanOrEqual(1);
  });

  it("PREREQUISITE GATE (BLOCKED_BY_P07): business commands fail because bin.ts does not compose RuntimeService", async () => {
    const workDir = makeTempDir();
    // Initialize repository first
    await runCli(["init"], workDir);

    // Attempt to start a workflow run via CLI binary
    const runRes = await runCli(["run", "Build authentication feature", "-j"], workDir);

    // Real verification: binary returns exit code 1 with transport_unavailable
    expect(runRes.exitCode).toBe(1);

    const parsedJson = JSON.parse(runRes.stderr);
    expect(parsedJson.ok).toBe(false);
    expect(parsedJson.error.code).toBe("transport_unavailable");
    expect(parsedJson.error.message).toContain("RuntimeService is not configured");

    // Attempt to check status
    const statusRes = await runCli(["status", "-j"], workDir);
    expect(statusRes.exitCode).toBe(1);
    const parsedStatus = JSON.parse(statusRes.stderr);
    expect(parsedStatus.ok).toBe(false);
    expect(parsedStatus.error.code).toBe("transport_unavailable");

    // CONCLUSION: CLI E2E execution is BLOCKED_BY_P07 because CLI entrypoint (apps/cli/src/bin.ts)
    // lacks runtime container wiring and dependency injection.
  });
});
