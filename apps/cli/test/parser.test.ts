import { describe, expect, it } from "vitest";
import {
  parseCliArgs,
  getHelpText,
  CLI_EXIT_CODES
} from "../src/index.js";
import type {
  InitCommandArgs,
  RunCommandArgs,
  StatusCommandArgs,
  ApproveCommandArgs,
  ResumeCommandArgs,
  CancelCommandArgs,
  HelpCommandArgs
} from "../src/index.js";

describe("force environment shutdown arguments", () => {
  it("accepts explicit model checks only on doctor --deep", () => {
    const result = parseCliArgs(["doctor", "--deep", "--json"]);
    expect(result.ok && result.value).toMatchObject({ command: "doctor", deep: true, json: true });
    for (const command of ["up", "down", "attach", "recover"]) expect(parseCliArgs([command, "--deep"]).ok).toBe(false);
  });
  it("accepts an explicit force shutdown without requiring a second confirmation flag", () => {
    const result = parseCliArgs(["down", "--force", "--json", "--timeout", "12000"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ command: "down", force: true, json: true, timeoutMs: 12000 });
  });
  it.each(["up", "attach", "doctor", "recover"])("rejects force on %s", command => {
    expect(parseCliArgs([command, "--force"]).ok).toBe(false);
  });
  it("documents the recovery flag in down help", () => {
    expect(getHelpText("down")).toContain("--force");
    expect(getHelpText("down")).toContain("checkpoint");
  });
});

describe("CLI Argument Parser - parseCliArgs", () => {
  describe("1. Help flag & command", () => {
    it("parses empty args as global help", () => {
      const res = parseCliArgs([]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("help");
        expect(res.value.help).toBe(true);
        expect(res.value.json).toBe(false);
        expect((res.value as HelpCommandArgs).topic).toBeUndefined();
      }
    });

    it("parses global --help and -h flags", () => {
      const longRes = parseCliArgs(["--help"]);
      expect(longRes.ok).toBe(true);
      if (longRes.ok) {
        expect(longRes.value.command).toBe("help");
        expect(longRes.value.help).toBe(true);
        expect(longRes.value.json).toBe(false);
      }

      const shortRes = parseCliArgs(["-h"]);
      expect(shortRes.ok).toBe(true);
      if (shortRes.ok) {
        expect(shortRes.value.command).toBe("help");
        expect(shortRes.value.help).toBe(true);
        expect(shortRes.value.json).toBe(false);
      }
    });

    it("parses 'help' command without topic as global help", () => {
      const res = parseCliArgs(["help"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("help");
        expect(res.value.help).toBe(true);
        expect(res.value.json).toBe(false);
        expect((res.value as HelpCommandArgs).topic).toBeUndefined();
      }
    });

    it("parses command-specific help with --help and -h", () => {
      const commands = ["init", "run", "status", "approve", "resume", "cancel"] as const;

      for (const cmd of commands) {
        const longRes = parseCliArgs([cmd, "--help"]);
        expect(longRes.ok).toBe(true);
        if (longRes.ok) {
          expect(longRes.value.command).toBe("help");
          expect((longRes.value as HelpCommandArgs).topic).toBe(cmd);
          expect(longRes.value.help).toBe(true);
          expect(longRes.value.json).toBe(false);
        }

        const shortRes = parseCliArgs([cmd, "-h"]);
        expect(shortRes.ok).toBe(true);
        if (shortRes.ok) {
          expect(shortRes.value.command).toBe("help");
          expect((shortRes.value as HelpCommandArgs).topic).toBe(cmd);
          expect(shortRes.value.help).toBe(true);
          expect(shortRes.value.json).toBe(false);
        }
      }
    });

    it("parses 'help <command>' syntax for each command topic", () => {
      const commands = ["init", "run", "status", "approve", "resume", "cancel"] as const;

      for (const cmd of commands) {
        const res = parseCliArgs(["help", cmd]);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.value.command).toBe("help");
          expect((res.value as HelpCommandArgs).topic).toBe(cmd);
          expect(res.value.help).toBe(true);
          expect(res.value.json).toBe(false);
        }
      }
    });

    it("supports --json flag with help command and flags", () => {
      const helpJson = parseCliArgs(["help", "--json"]);
      expect(helpJson.ok).toBe(true);
      if (helpJson.ok) {
        expect(helpJson.value.command).toBe("help");
        expect(helpJson.value.json).toBe(true);
      }

      const flagJson = parseCliArgs(["--help", "-j"]);
      expect(flagJson.ok).toBe(true);
      if (flagJson.ok) {
        expect(flagJson.value.command).toBe("help");
        expect(flagJson.value.json).toBe(true);
      }

      const cmdHelpJson = parseCliArgs(["run", "--help", "--json"]);
      expect(cmdHelpJson.ok).toBe(true);
      if (cmdHelpJson.ok) {
        expect(cmdHelpJson.value.command).toBe("help");
        expect((cmdHelpJson.value as HelpCommandArgs).topic).toBe("run");
        expect(cmdHelpJson.value.json).toBe(true);
      }
    });

    it("supports leading --json and -j before subcommands", () => {
      const statusRes = parseCliArgs(["--json", "status"]);
      expect(statusRes.ok).toBe(true);
      if (statusRes.ok) {
        expect(statusRes.value.command).toBe("status");
        expect(statusRes.value.json).toBe(true);
      }

      const runRes = parseCliArgs(["-j", "run", "Implement feature"]);
      expect(runRes.ok).toBe(true);
      if (runRes.ok) {
        expect(runRes.value.command).toBe("run");
        expect(runRes.value.json).toBe(true);
        expect((runRes.value as RunCommandArgs).requirement).toBe("Implement feature");
      }

      const initRes = parseCliArgs(["--json", "init", "--name", "my-app"]);
      expect(initRes.ok).toBe(true);
      if (initRes.ok) {
        expect(initRes.value.command).toBe("init");
        expect(initRes.value.json).toBe(true);
        expect((initRes.value as InitCommandArgs).projectName).toBe("my-app");
      }

      const statusRunRes = parseCliArgs(["-j", "status", "run-123"]);
      expect(statusRunRes.ok).toBe(true);
      if (statusRunRes.ok) {
        expect(statusRunRes.value.command).toBe("status");
        expect(statusRunRes.value.json).toBe(true);
        expect((statusRunRes.value as StatusCommandArgs).runId).toBe("run-123");
      }
    });

    it("supports leading --json and -j combined with --help and -h", () => {
      const res1 = parseCliArgs(["--json", "--help"]);
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        expect(res1.value.command).toBe("help");
        expect(res1.value.help).toBe(true);
        expect(res1.value.json).toBe(true);
      }

      const res2 = parseCliArgs(["-j", "-h"]);
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        expect(res2.value.command).toBe("help");
        expect(res2.value.help).toBe(true);
        expect(res2.value.json).toBe(true);
      }

      const res3 = parseCliArgs(["--help", "--json"]);
      expect(res3.ok).toBe(true);
      if (res3.ok) {
        expect(res3.value.command).toBe("help");
        expect(res3.value.help).toBe(true);
        expect(res3.value.json).toBe(true);
      }
    });

    it("rejects unknown help topic with validation error", () => {
      const res = parseCliArgs(["help", "nonexistent"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("nonexistent");
      }
    });
  });

  describe("getHelpText documentation", () => {
    it("returns non-empty global usage documenting all 6 commands", () => {
      const globalHelp = getHelpText();
      expect(globalHelp).toContain("Usage: bflow <command>");
      expect(globalHelp).toContain("init");
      expect(globalHelp).toContain("run");
      expect(globalHelp).toContain("status");
      expect(globalHelp).toContain("approve");
      expect(globalHelp).toContain("resume");
      expect(globalHelp).toContain("cancel");

      expect(getHelpText(undefined)).toBe(globalHelp);
      expect(getHelpText("help")).toBe(globalHelp);
    });

    it("returns dedicated help text for init command", () => {
      const text = getHelpText("init");
      expect(text).toContain("Usage: bflow init");
      expect(text).toContain("--dir");
      expect(text).toContain("--config");
      expect(text).toContain("--name");
      expect(text).toContain("--force");
    });

    it("returns dedicated help text for run command", () => {
      const text = getHelpText("run");
      expect(text).toContain("Usage: bflow run");
      expect(text).toContain("<requirement>");
      expect(text).toContain("--run-id");
      expect(text).toContain("--workflow");
    });

    it("returns dedicated help text for status command", () => {
      const text = getHelpText("status");
      expect(text).toContain("Usage: bflow status");
      expect(text).toContain("[run-id]");
      expect(text).toContain("--status");
      expect(text).toContain("--workflow-id");
      expect(text).toContain("--limit");
      expect(text).toContain("--cursor");
    });

    it("returns dedicated help text for approve command", () => {
      const text = getHelpText("approve");
      expect(text).toContain("Usage: bflow approve");
      expect(text).toContain("<task-id>");
      expect(text).toContain("--run");
      expect(text).toContain("--by");
      expect(text).toContain("--decision");
      expect(text).toContain("--reason");
    });

    it("returns dedicated help text for resume command", () => {
      const text = getHelpText("resume");
      expect(text).toContain("Usage: bflow resume");
      expect(text).toContain("<run-id>");
      expect(text).toContain("--idempotency-key");
    });

    it("returns dedicated help text for cancel command", () => {
      const text = getHelpText("cancel");
      expect(text).toContain("Usage: bflow cancel");
      expect(text).toContain("<run-id>");
      expect(text).toContain("--reason");
      expect(text).toContain("--by");
      expect(text).toContain("--task");
      expect(text).toContain("--expected-version");
    });
  });

  describe("2. bflow init argument parsing", () => {
    it("parses default 'bflow init' with force: false, json: false", () => {
      const res = parseCliArgs(["init"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("init");
        const args = res.value as InitCommandArgs;
        expect(args.force).toBe(false);
        expect(args.json).toBe(false);
        expect(args.dir).toBeUndefined();
        expect(args.configPath).toBeUndefined();
        expect(args.projectName).toBeUndefined();
      }
    });

    it("parses all options with --flag value syntax", () => {
      const res = parseCliArgs([
        "init",
        "--dir",
        "./Sub",
        "--config",
        "custom.json",
        "--name",
        "my-app",
        "--force",
        "--json"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("init");
        const args = res.value as InitCommandArgs;
        expect(args.dir).toBe("./Sub");
        expect(args.configPath).toBe("custom.json");
        expect(args.projectName).toBe("my-app");
        expect(args.force).toBe(true);
        expect(args.json).toBe(true);
      }
    });

    it("parses aliases: --yes, -y, -f, -j", () => {
      const resYes = parseCliArgs(["init", "--yes"]);
      expect(resYes.ok).toBe(true);
      if (resYes.ok) {
        expect((resYes.value as InitCommandArgs).force).toBe(true);
      }

      const resY = parseCliArgs(["init", "-y"]);
      expect(resY.ok).toBe(true);
      if (resY.ok) {
        expect((resY.value as InitCommandArgs).force).toBe(true);
      }

      const resF = parseCliArgs(["init", "-f"]);
      expect(resF.ok).toBe(true);
      if (resF.ok) {
        expect((resF.value as InitCommandArgs).force).toBe(true);
      }

      const resJ = parseCliArgs(["init", "-j"]);
      expect(resJ.ok).toBe(true);
      if (resJ.ok) {
        expect((resJ.value as InitCommandArgs).json).toBe(true);
      }

      const resUpdate = parseCliArgs(["init", "--update"]);
      expect(resUpdate.ok).toBe(true);
      if (resUpdate.ok) {
        expect((resUpdate.value as InitCommandArgs).update).toBe(true);
      }

      const resU = parseCliArgs(["init", "-u"]);
      expect(resU.ok).toBe(true);
      if (resU.ok) {
        expect((resU.value as InitCommandArgs).update).toBe(true);
      }
    });

    it("parses options using --flag=value syntax", () => {
      const res = parseCliArgs([
        "init",
        "--dir=./my-dir",
        "--config=bflow.config.json",
        "--name=service-a"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const args = res.value as InitCommandArgs;
        expect(args.dir).toBe("./my-dir");
        expect(args.configPath).toBe("bflow.config.json");
        expect(args.projectName).toBe("service-a");
      }
    });

    it("rejects boolean flags with =value syntax", () => {
      const cases = [
        ["init", "--force=false"],
        ["init", "--force=true"],
        ["init", "--yes=false"],
        ["init", "-f=true"],
        ["init", "-y=1"],
        ["init", "--json=false"],
        ["init", "-j=true"]
      ];

      for (const argv of cases) {
        const res = parseCliArgs(argv);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
          expect(res.error.message).toMatch(/does not take a value/i);
        }
      }
    });

    it("rejects whitespace-only string flag values for init", () => {
      const cases = [
        ["init", "--name", "   "],
        ["init", "--dir", "   "],
        ["init", "--config", "   "],
        ["init", "--name=\t  \n"],
        ["init", "--dir=  "]
      ];

      for (const argv of cases) {
        const res = parseCliArgs(argv);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
          expect(res.error.message).toMatch(/cannot be empty/i);
        }
      }
    });

    it("rejects unexpected positional arguments with validation error", () => {
      const res = parseCliArgs(["init", "unexpected"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Unexpected positional argument");
      }
    });

    it("rejects unknown flags with validation error", () => {
      const res = parseCliArgs(["init", "--unknown-flag=true"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Unknown option '--unknown-flag'");
      }
    });

    it("rejects missing flag values", () => {
      const res1 = parseCliArgs(["init", "--dir"]);
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.error.code).toBe("validation");
      }

      const res2 = parseCliArgs(["init", "--dir="]);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error.code).toBe("validation");
      }
    });
  });

  describe("3. bflow run argument parsing", () => {
    it("parses natural language requirement positional argument", () => {
      const res = parseCliArgs(["run", "Build authentication service"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("run");
        const args = res.value as RunCommandArgs;
        expect(args.requirement).toBe("Build authentication service");
        expect(args.json).toBe(false);
        expect(args.runId).toBeUndefined();
        expect(args.workflowPath).toBeUndefined();
        expect(args.configPath).toBeUndefined();
        expect(args.idempotencyKey).toBeUndefined();
      }
    });

    it("parses all optional flags for run", () => {
      const res = parseCliArgs([
        "run",
        "Build authentication service",
        "--run-id",
        "custom-run-101",
        "--workflow",
        "custom-wf.json",
        "--config",
        "custom-cfg.json",
        "--idempotency-key",
        "key-uuid-1",
        "--json"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const args = res.value as RunCommandArgs;
        expect(args.requirement).toBe("Build authentication service");
        expect(args.runId).toBe("custom-run-101");
        expect(args.workflowPath).toBe("custom-wf.json");
        expect(args.configPath).toBe("custom-cfg.json");
        expect(args.idempotencyKey).toBe("key-uuid-1");
        expect(args.json).toBe(true);
      }
    });

    it("supports -w for --workflow and --flag=value syntax", () => {
      const res = parseCliArgs([
        "run",
        "Implement search",
        "-w",
        "wf.json",
        "--run-id=run-888"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const args = res.value as RunCommandArgs;
        expect(args.workflowPath).toBe("wf.json");
        expect(args.runId).toBe("run-888");
      }
    });

    it("rejects whitespace-only string flag values for run", () => {
      const cases = [
        ["run", "Valid req", "--workflow", "   "],
        ["run", "Valid req", "--config", "   "],
        ["run", "Valid req", "--run-id", "   "],
        ["run", "Valid req", "--idempotency-key", "   "],
        ["run", "Valid req", "-w", "  "]
      ];

      for (const argv of cases) {
        const res = parseCliArgs(argv);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
        }
      }
    });

    it("rejects boolean flags with =value syntax for run", () => {
      const res1 = parseCliArgs(["run", "Build service", "--json=false"]);
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.error.code).toBe("validation");
        expect(res1.error.message).toMatch(/does not take a value/i);
      }

      const res2 = parseCliArgs(["run", "Build service", "--help=true"]);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error.code).toBe("validation");
      }
    });

    it("rejects missing requirement positional argument", () => {
      const res = parseCliArgs(["run"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("requirement");
      }
    });

    it("rejects whitespace-only requirement positional argument", () => {
      const res = parseCliArgs(["run", "   "]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("requirement");
      }
    });

    it("rejects extra positional arguments for run", () => {
      const res = parseCliArgs(["run", "Requirement 1", "Requirement 2"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Unexpected positional argument");
      }
    });

    it("rejects invalid identifier format for --run-id", () => {
      const res = parseCliArgs(["run", "Build service", "--run-id", "invalid id with spaces"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("run identifier");
      }
    });

    it("rejects unknown flags for run", () => {
      const res = parseCliArgs(["run", "Build service", "--bogus-flag=123"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
      }
    });
  });

  describe("4. bflow status argument parsing", () => {
    it("parses 'bflow status' without run-id as listing runs", () => {
      const res = parseCliArgs(["status"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("status");
        const args = res.value as StatusCommandArgs;
        expect(args.runId).toBeUndefined();
        expect(args.json).toBe(false);
      }
    });

    it("parses 'bflow status <run-id>' for inspecting a specific run", () => {
      const res = parseCliArgs(["status", "run-123"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("status");
        const args = res.value as StatusCommandArgs;
        expect(args.runId).toBe("run-123");
        expect(args.json).toBe(false);
      }
    });

    it("parses status filter options, workflow-id, limit, and cursor", () => {
      const res = parseCliArgs([
        "status",
        "--status",
        "running,waiting",
        "--workflow-id",
        "wf-auth",
        "--limit",
        "25",
        "--cursor",
        "cursor-token-1",
        "--json"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const args = res.value as StatusCommandArgs;
        expect(args.runId).toBeUndefined();
        expect(args.statusFilter).toEqual(["running", "waiting"]);
        expect(args.workflowId).toBe("wf-auth");
        expect(args.limit).toBe(25);
        expect(args.cursor).toBe("cursor-token-1");
        expect(args.json).toBe(true);
      }
    });

    it("parses all 8 valid lifecycle statuses in comma-separated filter", () => {
      const res = parseCliArgs([
        "status",
        "--status",
        "queued,running,waiting,blocked,succeeded,failed,cancelling,cancelled"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const args = res.value as StatusCommandArgs;
        expect(args.statusFilter).toHaveLength(8);
      }
    });

    it("rejects combining <run-id> with list filter and pagination flags", () => {
      const cases = [
        ["status", "run-123", "--limit", "10"],
        ["status", "run-123", "--status", "running"],
        ["status", "run-123", "--workflow-id", "wf-1"],
        ["status", "run-123", "--cursor", "cur-1"]
      ];

      for (const argv of cases) {
        const res = parseCliArgs(argv);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
          expect(res.error.message).toMatch(/Cannot combine <run-id> with list filter\/pagination/i);
        }
      }
    });

    it("rejects boolean flags with =value syntax for status", () => {
      const res = parseCliArgs(["status", "--json=false"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toMatch(/does not take a value/i);
      }
    });

    it("rejects invalid status values in --status", () => {
      const res1 = parseCliArgs(["status", "--status", "invalid_state"]);
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.error.code).toBe("validation");
        expect(res1.error.message).toContain("invalid_state");
      }

      const res2 = parseCliArgs(["status", "--status", "running,unknown_state"]);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error.code).toBe("validation");
      }
    });

    it("rejects non-integer or out-of-range --limit values", () => {
      const testCases = ["0", "-5", "501", "abc", "12.5"];
      for (const val of testCases) {
        const res = parseCliArgs(["status", "--limit", val]);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
          expect(res.error.message).toContain("--limit");
        }
      }
    });

    it("rejects more than one positional argument for status", () => {
      const res = parseCliArgs(["status", "run-1", "run-2"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Unexpected positional argument");
      }
    });

    it("rejects unknown flags for status", () => {
      const res = parseCliArgs(["status", "--unexpected-flag=val"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
      }
    });
  });

  describe("5. bflow approve argument parsing", () => {
    it("parses default 'bflow approve <task-id>' with decision: 'approved'", () => {
      const res = parseCliArgs(["approve", "qa"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("approve");
        const args = res.value as ApproveCommandArgs;
        expect(args.taskId).toBe("qa");
        expect(args.decision).toBe("approved");
        expect(args.decidedBy).toBe("human_operator");
        expect(args.runId).toBeUndefined();
        expect(args.reason).toBeUndefined();
      }
    });

    it("parses full flags for changes_requested decision with reason", () => {
      const res = parseCliArgs([
        "approve",
        "qa",
        "--run",
        "run-101",
        "--by",
        "alice_smith",
        "--decision",
        "changes_requested",
        "--reason",
        "Add edge case tests for expired tokens",
        "--revision",
        "2",
        "--generation",
        "1",
        "--json"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const args = res.value as ApproveCommandArgs;
        expect(args.taskId).toBe("qa");
        expect(args.runId).toBe("run-101");
        expect(args.decidedBy).toBe("alice_smith");
        expect(args.decision).toBe("changes_requested");
        expect(args.reason).toBe("Add edge case tests for expired tokens");
        expect(args.revision).toBe(2);
        expect(args.generation).toBe(1);
        expect(args.json).toBe(true);
      }
    });

    it("supports flag aliases: --run-id, --decided-by, --actor", () => {
      const res1 = parseCliArgs(["approve", "qa", "--run-id", "run-1"]);
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        expect((res1.value as ApproveCommandArgs).runId).toBe("run-1");
      }

      const res2 = parseCliArgs(["approve", "qa", "--decided-by", "bob_operator"]);
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        expect((res2.value as ApproveCommandArgs).decidedBy).toBe("bob_operator");
      }

      const res3 = parseCliArgs(["approve", "qa", "--actor", "charlie_lead"]);
      expect(res3.ok).toBe(true);
      if (res3.ok) {
        expect((res3.value as ApproveCommandArgs).decidedBy).toBe("charlie_lead");
      }
    });

    it("rejects missing <task-id> positional argument", () => {
      const res = parseCliArgs(["approve"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("task-id");
      }
    });

    it("rejects rejected decision when --reason is omitted", () => {
      const res = parseCliArgs(["approve", "qa", "--decision", "rejected"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toMatch(/reason/i);
      }
    });

    it("rejects changes_requested decision when --reason is omitted", () => {
      const res = parseCliArgs(["approve", "qa", "--decision", "changes_requested"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toMatch(/reason/i);
      }
    });

    it("rejects whitespace-only reason for rejected or changes_requested", () => {
      const res1 = parseCliArgs(["approve", "qa", "--reason", "   ", "--decision", "rejected"]);
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.error.code).toBe("validation");
        expect(res1.error.message).toMatch(/reason/i);
      }

      const res2 = parseCliArgs(["approve", "qa", "--reason", " \t \n", "--decision", "changes_requested"]);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error.code).toBe("validation");
        expect(res2.error.message).toMatch(/reason/i);
      }
    });

    it("rejects automated and AI approver identities (!isHumanApprover)", () => {
      const automatedActors = [
        "bot",
        "ai-assistant",
        "system",
        "claude",
        "gpt-4",
        "reviewer",
        "planner",
        "agent:planner",
        "llm_reviewer",
        "copilot-bot"
      ];

      for (const actor of automatedActors) {
        const res = parseCliArgs(["approve", "qa", "--by", actor]);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
          expect(res.error.message).toMatch(/human approval|automated|AI actor/i);
        }
      }
    });

    it("accepts valid human approver identities (isHumanApprover)", () => {
      const validHumanActors = [
        "alice",
        "bob_dev",
        "charlie.smith",
        "human_operator",
        "lead-engineer",
        "sarah_qa_lead"
      ];

      for (const actor of validHumanActors) {
        const res = parseCliArgs(["approve", "qa", "--by", actor]);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect((res.value as ApproveCommandArgs).decidedBy).toBe(actor);
        }
      }
    });

    it("rejects invalid revision and generation values", () => {
      const resRev = parseCliArgs(["approve", "qa", "--revision", "0"]);
      expect(resRev.ok).toBe(false);
      if (!resRev.ok) {
        expect(resRev.error.code).toBe("validation");
      }

      const resGen = parseCliArgs(["approve", "qa", "--generation", "-1"]);
      expect(resGen.ok).toBe(false);
      if (!resGen.ok) {
        expect(resGen.error.code).toBe("validation");
      }
    });

    it("rejects extra positional arguments for approve", () => {
      const res = parseCliArgs(["approve", "qa", "extra-arg"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Unexpected positional argument");
      }
    });
  });

  describe("6. bflow resume argument parsing", () => {
    it("parses 'bflow resume <run-id>' with optional flags", () => {
      const res = parseCliArgs(["resume", "run-123", "--idempotency-key", "idem-uuid-1", "--json"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("resume");
        const args = res.value as ResumeCommandArgs;
        expect(args.runId).toBe("run-123");
        expect(args.idempotencyKey).toBe("idem-uuid-1");
        expect(args.json).toBe(true);
      }
    });

    it("rejects missing <run-id> positional argument", () => {
      const res = parseCliArgs(["resume"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("run-id");
      }
    });

    it("rejects extra positional arguments for resume", () => {
      const res = parseCliArgs(["resume", "run-1", "run-2"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Unexpected positional argument");
      }
    });

    it("rejects unknown flags for resume", () => {
      const res = parseCliArgs(["resume", "run-1", "--unknown-opt=123"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
      }
    });
  });

  describe("7. bflow cancel argument parsing", () => {
    it("parses 'bflow cancel <run-id>' with all flags", () => {
      const res = parseCliArgs([
        "cancel",
        "run-123",
        "--reason",
        "Aborting release due to upstream outage",
        "--by",
        "alice_lead",
        "--task",
        "implement",
        "--expected-version",
        "4",
        "--json"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("cancel");
        const args = res.value as CancelCommandArgs;
        expect(args.runId).toBe("run-123");
        expect(args.reason).toBe("Aborting release due to upstream outage");
        expect(args.requestedBy).toBe("alice_lead");
        expect(args.taskId).toBe("implement");
        expect(args.expectedVersion).toBe(4);
        expect(args.json).toBe(true);
      }
    });

    it("supports flag aliases: --requested-by, --task-id", () => {
      const res = parseCliArgs([
        "cancel",
        "run-123",
        "--requested-by",
        "bob_ops",
        "--task-id",
        "qa"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const args = res.value as CancelCommandArgs;
        expect(args.requestedBy).toBe("bob_ops");
        expect(args.taskId).toBe("qa");
      }
    });

    it("rejects whitespace-only reason for cancel", () => {
      const res = parseCliArgs(["cancel", "run-1", "--reason", "   "]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toMatch(/cannot be empty/i);
      }
    });

    it("rejects missing <run-id> positional argument", () => {
      const res = parseCliArgs(["cancel"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("run-id");
      }
    });

    it("rejects negative or non-integer --expected-version", () => {
      const resNeg = parseCliArgs(["cancel", "run-1", "--expected-version", "-1"]);
      expect(resNeg.ok).toBe(false);
      if (!resNeg.ok) {
        expect(resNeg.error.code).toBe("validation");
        expect(resNeg.error.message).toContain("--expected-version");
      }

      const resStr = parseCliArgs(["cancel", "run-1", "--expected-version", "abc"]);
      expect(resStr.ok).toBe(false);
      if (!resStr.ok) {
        expect(resStr.error.code).toBe("validation");
      }
    });

    it("rejects unknown flags for cancel", () => {
      const res = parseCliArgs(["cancel", "run-1", "--bogus=true"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
      }
    });
  });

  describe("8. Global error handling & CLI exit codes", () => {
    it("verifies CLI_EXIT_CODES constant", () => {
      expect(CLI_EXIT_CODES.SUCCESS).toBe(0);
      expect(CLI_EXIT_CODES.RUNTIME_ERROR).toBe(1);
      expect(CLI_EXIT_CODES.USAGE_ERROR).toBe(2);
    });

    it("rejects unknown command with validation error", () => {
      const res = parseCliArgs(["deploy"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Unknown command 'deploy'");
      }
    });

    it("preserves json flag when unknown command has --json", () => {
      const res = parseCliArgs(["deploy", "--json"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.json).toBe(true);
      }
    });

    it("rejects missing option values with validation error", () => {
      const cases: readonly (readonly string[])[] = [
        ["run", "Build app", "--run-id"],
        ["status", "--limit"],
        ["approve", "qa", "--by"],
        ["cancel", "run-1", "--reason"]
      ];

      for (const argv of cases) {
        const res = parseCliArgs(argv);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
          expect(res.error.message).toContain("requires a value");
        }
      }
    });
  });

  describe("9. Version flag & command (--version, -v, version)", () => {
    it("parses --version and -v flags as version command", () => {
      const longRes = parseCliArgs(["--version"]);
      expect(longRes.ok).toBe(true);
      if (longRes.ok) {
        expect(longRes.value.command).toBe("version");
        expect(longRes.value.help).toBe(false);
        expect(longRes.value.json).toBe(false);
      }

      const shortRes = parseCliArgs(["-v"]);
      expect(shortRes.ok).toBe(true);
      if (shortRes.ok) {
        expect(shortRes.value.command).toBe("version");
        expect(shortRes.value.help).toBe(false);
        expect(shortRes.value.json).toBe(false);
      }
    });

    it("parses 'version' command and supports --json / -j", () => {
      const cmdRes = parseCliArgs(["version"]);
      expect(cmdRes.ok).toBe(true);
      if (cmdRes.ok) {
        expect(cmdRes.value.command).toBe("version");
        expect(cmdRes.value.json).toBe(false);
      }

      const jsonFlagRes = parseCliArgs(["--version", "--json"]);
      expect(jsonFlagRes.ok).toBe(true);
      if (jsonFlagRes.ok) {
        expect(jsonFlagRes.value.command).toBe("version");
        expect(jsonFlagRes.value.json).toBe(true);
      }

      const leadingJsonRes = parseCliArgs(["-j", "-v"]);
      expect(leadingJsonRes.ok).toBe(true);
      if (leadingJsonRes.ok) {
        expect(leadingJsonRes.value.command).toBe("version");
        expect(leadingJsonRes.value.json).toBe(true);
      }
    });

    it("rejects extra positional arguments or values with --version", () => {
      const extraArgRes = parseCliArgs(["--version", "extra"]);
      expect(extraArgRes.ok).toBe(false);
      if (!extraArgRes.ok) {
        expect(extraArgRes.error.code).toBe("validation");
      }

      const valueRes = parseCliArgs(["--version=1.0.0"]);
      expect(valueRes.ok).toBe(false);
      if (!valueRes.ok) {
        expect(valueRes.error.code).toBe("validation");
      }

      const cmdPositionalRes = parseCliArgs(["version", "extra"]);
      expect(cmdPositionalRes.ok).toBe(false);
      if (!cmdPositionalRes.ok) {
        expect(cmdPositionalRes.error.code).toBe("validation");
      }
    });
  });
});
