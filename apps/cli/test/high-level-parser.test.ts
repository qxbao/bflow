import { describe, expect, it } from "vitest";
import {
  parseCliArgs,
  getHelpText
} from "../src/index.js";
import {
  SUPPORTED_CLI_COMMANDS,
  CLI_COMMAND_REFERENCE,
  renderCommandReferenceMarkdown
} from "../src/command-reference.js";
import type {
  HelpCommandArgs,
  RepoInspectCommandArgs,
  TaskPlanCommandArgs,
  TaskImplementCommandArgs,
  VerifyCommandArgs,
  GitPrepareCommandArgs,
  McpStatusCommandArgs,
  ToolStatusCommandArgs,
  SkillsSyncCommandArgs,
  AgentCheckCommandArgs
} from "../src/types.js";

describe("High-Level CLI Argument Parser & Command Reference", () => {
  describe("1. Command Reference & SupportedCommandsSchema compatibility", () => {
    it("matches SupportedCommandsSchema regex for all commands", () => {
      const pattern = /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/;
      for (const cmd of SUPPORTED_CLI_COMMANDS) {
        expect(cmd).toMatch(pattern);
      }
    });

    it("includes all 25 required command prefixes in SUPPORTED_CLI_COMMANDS", () => {
      expect(SUPPORTED_CLI_COMMANDS).toContain("help");
      expect(SUPPORTED_CLI_COMMANDS).toContain("version");
      expect(SUPPORTED_CLI_COMMANDS).toContain("init");
      expect(SUPPORTED_CLI_COMMANDS).toContain("config-migrate");
      expect(SUPPORTED_CLI_COMMANDS).toContain("up");
      expect(SUPPORTED_CLI_COMMANDS).toContain("down");
      expect(SUPPORTED_CLI_COMMANDS).toContain("attach");
      expect(SUPPORTED_CLI_COMMANDS).toContain("status");
      expect(SUPPORTED_CLI_COMMANDS).toContain("doctor");
      expect(SUPPORTED_CLI_COMMANDS).toContain("recover");
      expect(SUPPORTED_CLI_COMMANDS).toContain("run");
      expect(SUPPORTED_CLI_COMMANDS).toContain("approve");
      expect(SUPPORTED_CLI_COMMANDS).toContain("resume");
      expect(SUPPORTED_CLI_COMMANDS).toContain("cancel");
      expect(SUPPORTED_CLI_COMMANDS).toContain("repo inspect");
      expect(SUPPORTED_CLI_COMMANDS).toContain("task plan");
      expect(SUPPORTED_CLI_COMMANDS).toContain("task implement");
      expect(SUPPORTED_CLI_COMMANDS).toContain("verify");
      expect(SUPPORTED_CLI_COMMANDS).toContain("git prepare");
      expect(SUPPORTED_CLI_COMMANDS).toContain("mcp status");
      expect(SUPPORTED_CLI_COMMANDS).toContain("tool status");
      expect(SUPPORTED_CLI_COMMANDS).toContain("tools status");
      expect(SUPPORTED_CLI_COMMANDS).toContain("skills sync");
      expect(SUPPORTED_CLI_COMMANDS).toContain("skills list");
      expect(SUPPORTED_CLI_COMMANDS).toContain("agent check");
      expect(SUPPORTED_CLI_COMMANDS.length).toBe(25);
    });

    it("has complete CLI_COMMAND_REFERENCE documentation entries", () => {
      expect(CLI_COMMAND_REFERENCE.length).toBeGreaterThanOrEqual(24);
      for (const entry of CLI_COMMAND_REFERENCE) {
        expect(entry.command).toBeTruthy();
        expect(entry.syntax).toBeTruthy();
        expect(entry.purpose).toBeTruthy();
        expect(entry.reusedEngines.length).toBeGreaterThan(0);
        expect(entry.exitCodes.length).toBe(3);
        expect(entry.idempotencyAndRetry).toBeTruthy();
        expect(entry.permissionRequirements).toBeTruthy();
        expect(entry.skills.length).toBeGreaterThan(0);
      }
    });

    it("renders valid Markdown command reference document", () => {
      const md = renderCommandReferenceMarkdown();
      expect(md).toContain("# Bflow CLI Command Reference");
      expect(md).toContain("`repo inspect`");
      expect(md).toContain("`task plan`");
      expect(md).toContain("`task implement`");
      expect(md).toContain("`verify`");
      expect(md).toContain("`git prepare`");
      expect(md).toContain("`mcp status`");
      expect(md).toContain("`tool status`");
      expect(md).toContain("`skills sync`");
      expect(md).toContain("`agent check`");
      expect(md).toContain("inspect-repository");
      expect(md).toContain("conditional-tdd");
    });
  });

  describe("2. Help topic resolution & getHelpText", () => {
    it("parses --help and -h flags for all 9 high-level commands", () => {
      const cases: readonly [string[], string][] = [
        [["repo", "inspect", "--help"], "repo inspect"],
        [["--help", "repo", "inspect"], "repo inspect"],
        [["help", "repo", "inspect"], "repo inspect"],
        [["task", "plan", "-h"], "task plan"],
        [["help", "task", "plan"], "task plan"],
        [["task", "implement", "--help"], "task implement"],
        [["help", "task", "implement"], "task implement"],
        [["verify", "--help"], "verify"],
        [["help", "verify"], "verify"],
        [["git", "prepare", "-h"], "git prepare"],
        [["help", "git", "prepare"], "git prepare"],
        [["mcp", "status", "--help"], "mcp status"],
        [["help", "mcp", "status"], "mcp status"],
        [["tool", "status", "-h"], "tool status"],
        [["tools", "status", "--help"], "tool status"],
        [["skills", "sync", "--help"], "skills sync"],
        [["skills", "list", "-h"], "skills sync"],
        [["agent", "check", "--help"], "agent check"]
      ];

      for (const [argv, expectedTopic] of cases) {
        const res = parseCliArgs(argv);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.value.command).toBe("help");
          expect((res.value as HelpCommandArgs).topic).toBe(expectedTopic);
        }
      }
    });

    it("supports prefix help shortcuts (bflow help <prefix>)", () => {
      const prefixCases: readonly [string[], string][] = [
        [["help", "repo"], "repo inspect"],
        [["help", "task"], "task plan"],
        [["help", "git"], "git prepare"],
        [["help", "mcp"], "mcp status"],
        [["help", "tool"], "tool status"],
        [["help", "tools"], "tool status"],
        [["help", "skills"], "skills sync"],
        [["help", "agent"], "agent check"]
      ];

      for (const [argv, expectedTopic] of prefixCases) {
        const res = parseCliArgs(argv);
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.value.command).toBe("help");
          expect((res.value as HelpCommandArgs).topic).toBe(expectedTopic);
        }
      }
    });

    it("preserves json flag on help requests", () => {
      const res = parseCliArgs(["repo", "inspect", "--help", "--json"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.json).toBe(true);
        expect(res.value.command).toBe("help");
        expect((res.value as HelpCommandArgs).topic).toBe("repo inspect");
      }
    });

    it("provides dedicated help text in getHelpText for all high-level commands", () => {
      const topics = [
        "repo inspect",
        "task plan",
        "task implement",
        "verify",
        "git prepare",
        "mcp status",
        "tool status",
        "skills sync",
        "agent check"
      ] as const;

      for (const topic of topics) {
        const text = getHelpText(topic);
        expect(text).toContain(`Usage: bflow ${topic}`);
      }
    });

    it("documents high-level commands in global help", () => {
      const globalHelp = getHelpText();
      expect(globalHelp).toContain("repo inspect");
      expect(globalHelp).toContain("task plan");
      expect(globalHelp).toContain("task implement");
      expect(globalHelp).toContain("verify");
      expect(globalHelp).toContain("git prepare");
      expect(globalHelp).toContain("mcp status");
      expect(globalHelp).toContain("tool status");
      expect(globalHelp).toContain("skills sync");
      expect(globalHelp).toContain("agent check");
    });
  });

  describe("3. bflow repo inspect argument parsing", () => {
    it("parses valid repo inspect without flags", () => {
      const res = parseCliArgs(["repo", "inspect"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as RepoInspectCommandArgs;
        expect(cmd.command).toBe("repo inspect");
        expect(cmd.includeFiles).toBe(false);
        expect(cmd.dir).toBeUndefined();
        expect(cmd.maxFiles).toBeUndefined();
        expect(cmd.resume).toBe(false);
      }
    });

    it("parses repo inspect with all flags and common flags", () => {
      const res = parseCliArgs([
        "repo",
        "inspect",
        "--dir",
        "./workspace",
        "--include-files",
        "--max-files",
        "1000",
        "--correlation-id",
        "corr-1",
        "--idempotency-key",
        "idemp-1",
        "--resume",
        "--actor",
        "operator",
        "--role",
        "coordinator",
        "--permission-mode",
        "workspace_auto",
        "--session-id",
        "sess-1",
        "--isolation",
        "os_sandbox",
        "--json"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as RepoInspectCommandArgs;
        expect(cmd.command).toBe("repo inspect");
        expect(cmd.dir).toBe("./workspace");
        expect(cmd.includeFiles).toBe(true);
        expect(cmd.maxFiles).toBe(1000);
        expect(cmd.correlationId).toBe("corr-1");
        expect(cmd.idempotencyKey).toBe("idemp-1");
        expect(cmd.resume).toBe(true);
        expect(cmd.actor).toBe("operator");
        expect(cmd.role).toBe("coordinator");
        expect(cmd.permissionMode).toBe("workspace_auto");
        expect(cmd.sessionId).toBe("sess-1");
        expect(cmd.isolation).toBe("os_sandbox");
        expect(cmd.json).toBe(true);
      }
    });

    it("rejects missing subcommand for bflow repo", () => {
      const res = parseCliArgs(["repo"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Missing subcommand for 'bflow repo'");
        expect(res.command).toBe("repo inspect");
      }
    });

    it("rejects unknown subcommand for bflow repo", () => {
      const res = parseCliArgs(["repo", "clean"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Unknown subcommand 'clean' for 'bflow repo'");
      }
    });

    it("rejects unexpected positional arguments for repo inspect", () => {
      const res = parseCliArgs(["repo", "inspect", "extra-arg"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Unexpected positional argument 'extra-arg'");
      }
    });

    it("rejects invalid --max-files values", () => {
      const invalidValues = ["0", "-5", "20000", "abc"];
      for (const val of invalidValues) {
        const res = parseCliArgs(["repo", "inspect", "--max-files", val]);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
          expect(res.error.message).toContain("--max-files");
        }
      }
    });

    it("rejects empty --dir option", () => {
      const res = parseCliArgs(["repo", "inspect", "--dir", "   "]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("--dir");
      }
    });
  });

  describe("4. bflow task plan argument parsing", () => {
    it("parses task plan with --spec flag", () => {
      const res = parseCliArgs(["task", "plan", "--spec", "./specs/auth.json", "--run-id", "run-1"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as TaskPlanCommandArgs;
        expect(cmd.command).toBe("task plan");
        expect(cmd.specPath).toBe("./specs/auth.json");
        expect(cmd.runId).toBe("run-1");
      }
    });

    it("parses task plan with positional spec path", () => {
      const res = parseCliArgs(["task", "plan", "./specs/auth.json", "-w", "./wf.json"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as TaskPlanCommandArgs;
        expect(cmd.command).toBe("task plan");
        expect(cmd.specPath).toBe("./specs/auth.json");
        expect(cmd.workflowPath).toBe("./wf.json");
      }
    });

    it("rejects task plan when spec is missing", () => {
      const res = parseCliArgs(["task", "plan"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("--spec");
      }
    });

    it("rejects unexpected positional arguments when --spec is already passed", () => {
      const res = parseCliArgs(["task", "plan", "--spec", "./specs/auth.json", "extra"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Unexpected positional argument 'extra'");
      }
    });

    it("rejects unknown subcommand for bflow task", () => {
      const res = parseCliArgs(["task", "archive"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Unknown subcommand 'archive' for 'bflow task'");
      }
    });
  });

  describe("5. bflow task implement argument parsing", () => {
    it("parses task implement with positional task ID and required --run-id", () => {
      const res = parseCliArgs(["task", "implement", "task-1", "--run-id", "run-101"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as TaskImplementCommandArgs;
        expect(cmd.command).toBe("task implement");
        expect(cmd.taskId).toBe("task-1");
        expect(cmd.runId).toBe("run-101");
        expect(cmd.requireRedEvidence).toBe(false);
        expect(cmd.autoApprove).toBe(false);
        expect(cmd.ownedPaths).toEqual([]);
        expect(cmd.forbiddenPaths).toEqual([]);
      }
    });

    it("parses task implement with --task-id flag", () => {
      const res = parseCliArgs(["task", "implement", "--task-id", "task-1", "--run", "run-101"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as TaskImplementCommandArgs;
        expect(cmd.taskId).toBe("task-1");
        expect(cmd.runId).toBe("run-101");
      }
    });

    it("parses repeatable and comma-separated --owned-path and --forbidden-path", () => {
      const res = parseCliArgs([
        "task",
        "implement",
        "task-1",
        "--run-id",
        "run-101",
        "--owned-path",
        "src/core,src/utils",
        "--owned-path",
        "src/types.ts",
        "--forbidden-path",
        "packages/contracts",
        "--forbidden-path",
        "package.json,pnpm-lock.yaml",
        "--require-red-evidence",
        "--auto-approve",
        "--approved-by",
        "lead-reviewer",
        "--developer-id",
        "dev-agent-1",
        "--base-revision",
        "abc1234",
        "--attempt-id",
        "att-1",
        "--target-branch",
        "feature/auth",
        "--environment",
        "worktree-1"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as TaskImplementCommandArgs;
        expect(cmd.ownedPaths).toEqual(["src/core", "src/utils", "src/types.ts"]);
        expect(cmd.forbiddenPaths).toEqual(["packages/contracts", "package.json", "pnpm-lock.yaml"]);
        expect(cmd.requireRedEvidence).toBe(true);
        expect(cmd.autoApprove).toBe(true);
        expect(cmd.approvedBy).toBe("lead-reviewer");
        expect(cmd.developerId).toBe("dev-agent-1");
        expect(cmd.baseRevision).toBe("abc1234");
        expect(cmd.attemptId).toBe("att-1");
        expect(cmd.targetBranch).toBe("feature/auth");
        expect(cmd.environmentName).toBe("worktree-1");
      }
    });

    it("rejects task implement when task ID is missing", () => {
      const res = parseCliArgs(["task", "implement", "--run-id", "run-101"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Task identifier is required");
      }
    });

    it("rejects task implement when run ID is missing", () => {
      const res = parseCliArgs(["task", "implement", "task-1"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("--run-id");
      }
    });

    it("rejects invalid task identifier format", () => {
      const res = parseCliArgs(["task", "implement", "invalid taskId with spaces", "--run-id", "run-101"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Invalid task identifier");
      }
    });
  });

  describe("6. bflow verify argument parsing", () => {
    it("parses verify with default scope and positional taskId", () => {
      const res = parseCliArgs(["verify", "task-1", "--run-id", "run-101"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as VerifyCommandArgs;
        expect(cmd.command).toBe("verify");
        expect(cmd.taskId).toBe("task-1");
        expect(cmd.runId).toBe("run-101");
        expect(cmd.scope).toBe("task");
        expect(cmd.maxIterations).toBeUndefined();
      }
    });

    it("parses verify with workflow scope and artifacts", () => {
      const res = parseCliArgs([
        "verify",
        "--scope",
        "workflow",
        "--run-id",
        "run-101",
        "--spec",
        "./spec.json",
        "--plan",
        "./plan.json",
        "--change-set",
        "./diff.json",
        "--cycle",
        "./cycle.json",
        "--max-iterations",
        "5"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as VerifyCommandArgs;
        expect(cmd.command).toBe("verify");
        expect(cmd.scope).toBe("workflow");
        expect(cmd.runId).toBe("run-101");
        expect(cmd.specPath).toBe("./spec.json");
        expect(cmd.planPath).toBe("./plan.json");
        expect(cmd.changeSetPath).toBe("./diff.json");
        expect(cmd.cyclePath).toBe("./cycle.json");
        expect(cmd.maxIterations).toBe(5);
      }
    });

    it("rejects invalid scope in verify", () => {
      const res = parseCliArgs(["verify", "--scope", "cluster"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Must be 'task' or 'workflow'");
      }
    });

    it("rejects invalid --max-iterations in verify", () => {
      const res = parseCliArgs(["verify", "--max-iterations", "0"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("--max-iterations");
      }
    });
  });

  describe("7. bflow git prepare argument parsing", () => {
    it("parses git prepare with repeatable tasks and dependencies", () => {
      const res = parseCliArgs([
        "git",
        "prepare",
        "--run-id",
        "run-101",
        "--task",
        "task-a",
        "--task",
        "task-b:task-a",
        "--task",
        "task-c:task-a,task-b",
        "--target-branch",
        "main",
        "--auto-approve"
      ]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as GitPrepareCommandArgs;
        expect(cmd.command).toBe("git prepare");
        expect(cmd.runId).toBe("run-101");
        expect(cmd.targetBranch).toBe("main");
        expect(cmd.autoApprove).toBe(true);
        expect(cmd.tasks).toEqual([
          { taskKey: "task-a", dependsOn: [] },
          { taskKey: "task-b", dependsOn: ["task-a"] },
          { taskKey: "task-c", dependsOn: ["task-a", "task-b"] }
        ]);
      }
    });

    it("rejects git prepare without --run-id", () => {
      const res = parseCliArgs(["git", "prepare"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("--run-id");
      }
    });

    it("rejects invalid task key in --task", () => {
      const res = parseCliArgs(["git", "prepare", "--run-id", "run-101", "--task", "bad key:task-a"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Invalid task key");
      }
    });

    it("rejects invalid dependency key in --task", () => {
      const res = parseCliArgs(["git", "prepare", "--run-id", "run-101", "--task", "task-b:bad dep"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Invalid dependency task key");
      }
    });
  });

  describe("8. bflow mcp status argument parsing", () => {
    it("parses mcp status without services", () => {
      const res = parseCliArgs(["mcp", "status"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as McpStatusCommandArgs;
        expect(cmd.command).toBe("mcp status");
        expect(cmd.serviceIds).toEqual([]);
      }
    });

    it("parses mcp status with repeatable and comma-separated services", () => {
      const res = parseCliArgs(["mcp", "status", "--service", "gitnexus,rtk", "--service", "claude-mem"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as McpStatusCommandArgs;
        expect(cmd.serviceIds).toEqual(["gitnexus", "rtk", "claude-mem"]);
      }
    });

    it("rejects invalid service identifier in mcp status", () => {
      const res = parseCliArgs(["mcp", "status", "--service", "invalid service id"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Invalid service identifier");
      }
    });
  });

  describe("9. bflow tool status & tools status argument parsing", () => {
    it("parses tool status and tools status alias identically", () => {
      const res1 = parseCliArgs(["tool", "status", "--tool", "rtk"]);
      const res2 = parseCliArgs(["tools", "status", "--tool", "rtk"]);
      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      if (res1.ok && res2.ok) {
        const cmd1 = res1.value as ToolStatusCommandArgs;
        const cmd2 = res2.value as ToolStatusCommandArgs;
        expect(cmd1.command).toBe("tool status");
        expect(cmd2.command).toBe("tool status");
        expect(cmd1.toolIds).toEqual(["rtk"]);
        expect(cmd2.toolIds).toEqual(["rtk"]);
      }
    });

    it("parses repeatable and comma-separated --tool arguments", () => {
      const res = parseCliArgs(["tool", "status", "--tool", "rtk,gitnexus", "--tool", "ripgrep"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as ToolStatusCommandArgs;
        expect(cmd.toolIds).toEqual(["rtk", "gitnexus", "ripgrep"]);
      }
    });

    it("rejects invalid tool identifier", () => {
      const res = parseCliArgs(["tool", "status", "--tool", "bad tool id"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Invalid tool identifier");
      }
    });
  });

  describe("10. bflow skills sync & skills list argument parsing", () => {
    it("parses skills sync with mode: sync", () => {
      const res = parseCliArgs(["skills", "sync", "--provider", "claude"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as SkillsSyncCommandArgs;
        expect(cmd.command).toBe("skills sync");
        expect(cmd.mode).toBe("sync");
        expect(cmd.provider).toBe("claude");
      }
    });

    it("parses skills list with mode: list", () => {
      const res = parseCliArgs(["skills", "list", "--provider", "codex"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as SkillsSyncCommandArgs;
        expect(cmd.command).toBe("skills sync");
        expect(cmd.mode).toBe("list");
        expect(cmd.provider).toBe("codex");
      }
    });

    it("parses skills sync --list with mode: list", () => {
      const res = parseCliArgs(["skills", "sync", "--list", "--manifest-id", "man-1"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as SkillsSyncCommandArgs;
        expect(cmd.command).toBe("skills sync");
        expect(cmd.mode).toBe("list");
        expect(cmd.manifestId).toBe("man-1");
      }
    });

    it("rejects invalid provider for skills sync", () => {
      const res = parseCliArgs(["skills", "sync", "--provider", "openai"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Must be 'claude', 'codex', or 'agy'");
      }
    });
  });

  describe("11. bflow agent check argument parsing", () => {
    it("parses agent check with positional provider", () => {
      const res = parseCliArgs(["agent", "check", "claude"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as AgentCheckCommandArgs;
        expect(cmd.command).toBe("agent check");
        expect(cmd.provider).toBe("claude");
        expect(cmd.stage).toBe("preflight");
      }
    });

    it("parses agent check with --provider and --stage activated", () => {
      const res = parseCliArgs(["agent", "check", "--provider", "codex", "--stage", "activated", "--environment-id", "env-1"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const cmd = res.value as AgentCheckCommandArgs;
        expect(cmd.command).toBe("agent check");
        expect(cmd.provider).toBe("codex");
        expect(cmd.stage).toBe("activated");
        expect(cmd.environmentId).toBe("env-1");
      }
    });

    it("rejects invalid stage for agent check", () => {
      const res = parseCliArgs(["agent", "check", "--stage", "running"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Must be 'preflight' or 'activated'");
      }
    });

    it("rejects invalid provider for agent check", () => {
      const res = parseCliArgs(["agent", "check", "unsupported-provider"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Must be 'claude', 'codex', or 'agy'");
      }
    });
  });

  describe("12. High-level common flags validation", () => {
    it("rejects invalid correlation identifier", () => {
      const res = parseCliArgs(["repo", "inspect", "--correlation-id", "bad corr id"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Invalid correlation identifier");
      }
    });

    it("rejects invalid idempotency key", () => {
      const res = parseCliArgs(["task", "plan", "--spec", "./spec.json", "--idempotency-key", ""]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
      }
    });

    it("rejects invalid agent role", () => {
      const res = parseCliArgs(["repo", "inspect", "--role", "not-a-real-role"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Invalid role");
      }
    });

    it("rejects invalid permission mode", () => {
      const res = parseCliArgs(["repo", "inspect", "--permission-mode", "unrestricted"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Invalid permission mode");
      }
    });

    it("rejects invalid isolation kind", () => {
      const res = parseCliArgs(["repo", "inspect", "--isolation", "bare_metal"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Invalid isolation");
      }
    });

    it("rejects empty --actor value", () => {
      const res = parseCliArgs(["repo", "inspect", "--actor", "   "]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("validation");
        expect(res.error.message).toContain("Option '--actor' cannot be empty");
      }
    });
  });
});
