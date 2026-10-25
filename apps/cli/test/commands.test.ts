import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractErrorSchema,
  WorkflowDefinitionSchema,
  type ApprovalDecision,
  type CancellationRequest,
  type ResumeRunInput,
  type RuntimeService,
  type StartRunInput,
  type WorkflowDefinition,
  type WorkflowRunSnapshot
} from "@bflow/contracts";
import {
  executeCommand,
  main,
  parseCliArgs,
  runCli,
  CLI_EXIT_CODES,
  parseConfigYaml,
  stringifyConfigYaml
} from "../src/index.js";
import type { CliContext } from "../src/index.js";

const sampleRunningSnapshot: WorkflowRunSnapshot = {
  runId: "run-sample-1",
  workflowId: "sdlc-standard-workflow",
  workflowVersion: "1.0.0",
  status: "running",
  input: { requirement: "Build auth feature" },
  tasks: [
    {
      taskId: "plan",
      status: "succeeded",
      attempt: 1,
      generation: 0,
      version: 1
    },
    {
      taskId: "implement",
      status: "running",
      attempt: 1,
      generation: 0,
      version: 1
    },
    {
      taskId: "review",
      status: "pending",
      attempt: 0,
      generation: 0,
      version: 0
    },
    {
      taskId: "qa",
      status: "pending",
      attempt: 0,
      generation: 0,
      version: 0
    }
  ],
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:01:00.000Z",
  version: 3,
  lastEventSequence: 10
};

const sampleWaitingSnapshot: WorkflowRunSnapshot = {
  runId: "run-waiting-1",
  workflowId: "sdlc-standard-workflow",
  workflowVersion: "1.0.0",
  status: "waiting",
  tasks: [
    {
      taskId: "plan",
      status: "succeeded",
      attempt: 1,
      generation: 0,
      version: 1
    },
    {
      taskId: "implement",
      status: "succeeded",
      attempt: 1,
      generation: 0,
      version: 2
    },
    {
      taskId: "review",
      status: "succeeded",
      attempt: 1,
      generation: 0,
      version: 3
    },
    {
      taskId: "qa",
      status: "waiting",
      attempt: 1,
      generation: 0,
      version: 4,
      blockage: {
        code: "awaiting_approval",
        message: "Mandatory human sign-off required for QA release",
        since: "2026-10-15T00:05:00.000Z",
        retryable: false
      }
    }
  ],
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:05:00.000Z",
  version: 5,
  lastEventSequence: 15
};

function createMockRuntime(overrides?: Partial<RuntimeService>): RuntimeService {
  return {
    start: vi.fn(async () => ({ ok: true as const, value: sampleRunningSnapshot })),
    resume: vi.fn(async () => ({ ok: true as const, value: sampleRunningSnapshot })),
    cancel: vi.fn(async () => ({ ok: true as const, value: sampleRunningSnapshot })),
    decide: vi.fn(async () => ({ ok: true as const, value: sampleRunningSnapshot })),
    getRun: vi.fn(async () => ({ ok: true as const, value: sampleRunningSnapshot })),
    findRuns: vi.fn(async () => ({
      ok: true as const,
      value: { items: [sampleRunningSnapshot], nextCursor: null, hasMore: false }
    })),
    watch: vi.fn(async function* () {}),
    ...overrides
  };
}

describe("CLI Command Execution - runCli & executeCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bflow-cli-test-"));
    execFileSync("git", ["init", "--quiet", tempDir]);
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("1. bflow --help and <cmd> --help execution", () => {
    it("executes global --help returning exitCode 0 and usage text in stdout", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("Usage: bflow <command>");
      expect(result.stderr).toBe("");
    });

    it("executes -h, empty args, and 'help' command identically", async () => {
      const resH = await runCli(["-h"]);
      expect(resH.exitCode).toBe(0);
      expect(resH.ok).toBe(true);
      expect(resH.stdout).toContain("Usage: bflow <command>");

      const resEmpty = await runCli([]);
      expect(resEmpty.exitCode).toBe(0);
      expect(resEmpty.ok).toBe(true);
      expect(resEmpty.stdout).toContain("Usage: bflow <command>");

      const resHelp = await runCli(["help"]);
      expect(resHelp.exitCode).toBe(0);
      expect(resHelp.ok).toBe(true);
      expect(resHelp.stdout).toContain("Usage: bflow <command>");
    });

    it("executes command-specific help for all 6 core commands", async () => {
      const commands = ["init", "run", "status", "approve", "resume", "cancel"] as const;

      for (const cmd of commands) {
        const res = await runCli([cmd, "--help"]);
        expect(res.exitCode).toBe(0);
        expect(res.ok).toBe(true);
        expect(res.stdout).toContain(`Usage: bflow ${cmd}`);
      }
    });

    it("supports --json flag with --help output", async () => {
      const res = await runCli(["--help", "--json"]);
      expect(res.exitCode).toBe(0);
      expect(res.ok).toBe(true);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe("help");
      expect(parsed.data.helpText).toContain("Usage: bflow <command>");
    });
  });

  describe("2. bflow init execution & overwrite protection", () => {
    it("creates readable .bflow/config.yml with valid defaultWorkflow in fresh directory", async () => {
      const result = await runCli(["init"], { cwd: tempDir });
      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("bflow repository configuration");

      const configFilePath = join(tempDir, ".bflow", "config.yml");
      const content = await readFile(configFilePath, "utf-8");
      const parsed = parseConfigYaml(content) as Record<string, any>;
      expect(content).toContain("# Bflow repository configuration");
      expect(content).toContain("  roles:");
      expect(content).not.toContain("{\n");

      expect(parsed.schemaVersion).toBe("1");
      expect(parsed.projectName).toBeDefined();
      expect(parsed.defaultWorkflow).toBeDefined();

      const wfValidation = WorkflowDefinitionSchema.safeParse(parsed.defaultWorkflow);
      expect(wfValidation.success).toBe(true);
    });

    it("preserves existing configuration across repeat init, and overwrites when --force is specified", async () => {
      await runCli(["init", "--name", "initial-project"], { cwd: tempDir });
      const path = join(tempDir, ".bflow", "config.yml");
      const original = await readFile(path, "utf8");
      const confirmOverwrite = vi.fn().mockResolvedValue(true);
      const result = await runCli(["init", "--name", "changed"], { cwd: tempDir, confirmOverwrite });
      expect(result.ok).toBe(true);
      expect(await readFile(path, "utf8")).toBe(original);
      expect(confirmOverwrite).not.toHaveBeenCalled();

      // With --force, configuration is overwritten
      const forceResult = await runCli(["init", "--name", "changed", "--force"], { cwd: tempDir, confirmOverwrite });
      expect(forceResult.ok).toBe(true);
      const updated = await readFile(path, "utf8");
      expect(updated).not.toBe(original);
      const parsed = parseConfigYaml(updated) as Record<string, any>;
      expect(parsed.projectName).toBe("changed");
    });

    it("updates existing configuration with --update by saving custom values, deleting old file, upserting onto fresh defaults, and resetting comments", async () => {
      await runCli(["init", "--name", "custom-project", "--provider", "agy"], { cwd: tempDir });
      const configPath = join(tempDir, ".bflow", "config.yml");
      const rawBefore = parseConfigYaml(await readFile(configPath, "utf8")) as Record<string, any>;

      // Simulate an older or hand-edited config missing newer default sections (tools, permissions, skills, defaults)
      // and without comments, while having custom role models, sdd level, and disabled rtk.
      delete rawBefore.environment.permissions;
      delete rawBefore.environment.skills;
      delete rawBefore.environment.defaults;
      rawBefore.environment.sdd = { minimumLevel: "full", approvalRequired: false };
      rawBefore.environment.verification = { maxIterations: 5, onExhausted: "require_human" };
      rawBefore.environment.tools = { rtk: { enabled: false, required: false } };
      rawBefore.environment.roles = rawBefore.environment.roles.map((r: any) =>
        r.role === "coordinator"
          ? { ...r, model: "gemini-3.1-pro-high", "profile-name": "lead-profile" }
          : r.role === "conversation"
            ? { ...r, model: "gemini-3-flash-low" }
            : r
      );
      await writeFile(configPath, "# stripped old comment\n" + stringifyConfigYaml(rawBefore), "utf8");

      const updateRes = await runCli(["init", "--update", "--json"], { cwd: tempDir });
      expect(updateRes.exitCode).toBe(0);
      expect(updateRes.ok).toBe(true);
      const envelope = JSON.parse(updateRes.stdout);
      expect(envelope.data.updated).toBe(true);
      expect(envelope.data.overwritten).toBe(true);

      const contentAfter = await readFile(configPath, "utf8");
      expect(contentAfter).not.toContain("# stripped old comment");
      expect(contentAfter).toContain("# BFLOW REPOSITORY CONFIGURATION (.bflow/config.yml)");
      expect(contentAfter).toContain("enum: `codex` | `claude` | `agy`");

      const parsedAfter = parseConfigYaml(contentAfter) as Record<string, any>;
      expect(parsedAfter.projectName).toBe("custom-project");
      expect(parsedAfter.environment.sdd).toEqual({ minimumLevel: "full", approvalRequired: false });
      expect(parsedAfter.environment.verification).toEqual({ maxIterations: 5, onExhausted: "require_human", regressionScope: "affected" });
      // Preserved custom disabled tool while populating missing default tools
      expect(parsedAfter.environment.tools).toEqual({
        rtk: { enabled: false, required: false },
        gitnexus: { enabled: true, required: false },
        mempalace: { enabled: true, required: false },
        "chrome-devtools-mcp": { enabled: true, required: false }
      });
      // Restored missing default sections
      expect(parsedAfter.environment.permissions).toEqual({
        mode: "workspace_auto",
        isolation: "provider_policy",
        trustedWorkspace: true
      });
      expect(parsedAfter.environment.skills).toEqual({
        required: false,
        requiredSkills: []
      });
      expect(parsedAfter.environment.defaults).toEqual({
        codex: {},
        claude: {},
        agy: {}
      });
      // Preserved custom role models and profile-name
      const coordinator = parsedAfter.environment.roles.find((r: any) => r.role === "coordinator");
      expect(coordinator).toMatchObject({
        role: "coordinator",
        cli: "agy",
        model: "gemini-3.1-pro-high",
        "profile-name": "lead-profile"
      });
      const conversation = parsedAfter.environment.roles.find((r: any) => r.role === "conversation");
      expect(conversation).toMatchObject({
        role: "conversation",
        cli: "agy",
        model: "gemini-3-flash-low"
      });
    });

    it("creates configuration in custom subproject directory with custom name", async () => {
      await mkdir(join(tempDir, "services", "auth"), { recursive: true });
      const result = await runCli(
        ["init", "--dir", "services/auth", "--name", "auth-service"],
        { cwd: tempDir }
      );
      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);

      const subConfigPath = join(tempDir, ".bflow", "config.yml");
      const content = await readFile(subConfigPath, "utf-8");
      const parsed = parseConfigYaml(content) as Record<string, any>;
      expect(parsed.projectName).toBe("auth-service");
    });

    it("supports --json output for bflow init", async () => {
      const result = await runCli(["init", "--name", "json-test", "--json"], {
        cwd: tempDir
      });
      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);

      const envelope = JSON.parse(result.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe("init");
      expect(envelope.data.config.projectName).toBe("json-test");
      expect(envelope.data.configPath).toContain("config.yml");
    });
  });

  describe("3. bflow run execution & config validation", () => {
    it("calls runtime.start with natural language requirement and valid workflow", async () => {
      const runtime = createMockRuntime();
      const result = await runCli(["run", "Build user authentication service"], {
        cwd: tempDir,
        runtime
      });

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(runtime.start).toHaveBeenCalledTimes(1);

      const startInput = (runtime.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as StartRunInput;
      expect(startInput.input).toEqual({ requirement: "Build user authentication service" });
      expect(startInput.runId).toBeDefined();

      const wfValidation = WorkflowDefinitionSchema.safeParse(startInput.definition);
      expect(wfValidation.success).toBe(true);
    });

    it("never auto-approves when run enters waiting or blocked state", async () => {
      const runtime = createMockRuntime({
        start: vi.fn(async () => ({ ok: true as const, value: sampleWaitingSnapshot }))
      });

      const result = await runCli(["run", "Implement billing checkout"], {
        cwd: tempDir,
        runtime
      });

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(runtime.start).toHaveBeenCalledTimes(1);

      // CRITICAL REQUIREMENT: "Không tự động phê duyệt thay người dùng"
      expect(runtime.decide).not.toHaveBeenCalled();

      // Output should inform the user how to record human approval
      expect(result.stdout).toContain("bflow approve qa");
      expect(result.stdout).toContain("WAITING");
    });

    it("fails closed when .bflow/config.yml in cwd contains malformed YAML", async () => {
      await runCli(["init"], { cwd: tempDir });
      const configPath = join(tempDir, ".bflow", "config.yml");
      await writeFile(configPath, "{ invalid json content: 123", "utf-8");

      const runtime = createMockRuntime();
      const result = await runCli(["run", "Build feature"], { cwd: tempDir, runtime });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("corruption");
      expect(ContractErrorSchema.safeParse(result.error).success).toBe(true);
      expect(runtime.start).not.toHaveBeenCalled();
    });

    it("fails closed when .bflow/config.yml has unsupported schemaVersion", async () => {
      await runCli(["init"], { cwd: tempDir });
      const configPath = join(tempDir, ".bflow", "config.yml");
      const original = parseConfigYaml(await readFile(configPath, "utf-8")) as Record<string, any>;

      const corruptVersion = { ...original, schemaVersion: "2" };
      await writeFile(configPath, stringifyConfigYaml(corruptVersion), "utf-8");

      const runtime = createMockRuntime();
      const result = await runCli(["run", "Build feature"], { cwd: tempDir, runtime });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("unsupported_version");
      expect(ContractErrorSchema.safeParse(result.error).success).toBe(true);
      expect(runtime.start).not.toHaveBeenCalled();
    });

    it("fails closed when .bflow/config.yml is missing required fields", async () => {
      await runCli(["init"], { cwd: tempDir });
      const configPath = join(tempDir, ".bflow", "config.yml");
      await writeFile(configPath, JSON.stringify({ schemaVersion: "1" }), "utf-8");

      const runtime = createMockRuntime();
      const result = await runCli(["run", "Build feature"], { cwd: tempDir, runtime });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("corruption");
      expect(ContractErrorSchema.safeParse(result.error).success).toBe(true);
      expect(runtime.start).not.toHaveBeenCalled();
    });

    it("supports custom --run-id", async () => {
      const runtime = createMockRuntime();
      const result = await runCli(
        ["run", "Build feature", "--run-id", "my-custom-run-99"],
        { cwd: tempDir, runtime }
      );

      expect(result.exitCode).toBe(0);
      const startInput = (runtime.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as StartRunInput;
      expect(startInput.runId).toBe("my-custom-run-99");
    });

    it("supports custom --workflow definition JSON file", async () => {
      await runCli(["init"], { cwd: tempDir });
      const configPath = join(tempDir, ".bflow", "config.yml");
      const configContent = parseConfigYaml(await readFile(configPath, "utf-8")) as Record<string, any>;
      const customWf: WorkflowDefinition = {
        ...configContent.defaultWorkflow,
        id: "custom-pipeline-wf",
        name: "Custom Pipeline Workflow"
      };

      const customWfPath = join(tempDir, "custom-workflow.json");
      await writeFile(customWfPath, JSON.stringify(customWf, null, 2), "utf-8");

      const runtime = createMockRuntime();
      const result = await runCli(
        ["run", "Build custom pipeline", "--workflow", customWfPath],
        { cwd: tempDir, runtime }
      );

      expect(result.exitCode).toBe(0);
      const startInput = (runtime.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as StartRunInput;
      expect(startInput.definition.id).toBe("custom-pipeline-wf");
    });

    it("propagates RuntimeService errors with non-zero exit code", async () => {
      const runtime = createMockRuntime({
        start: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "conflict" as const,
            retryable: true as const,
            message: "Run 'run-101' already exists"
          }
        }))
      });

      const result = await runCli(["run", "Build service", "--run-id", "run-101"], {
        cwd: tempDir,
        runtime
      });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("conflict");
      expect(result.stderr).toContain("already exists");
    });

    it("supports --json output for both success and error", async () => {
      const runtime = createMockRuntime();
      const successRes = await runCli(["run", "Build feature", "--json"], {
        cwd: tempDir,
        runtime
      });

      expect(successRes.exitCode).toBe(0);
      const envelope = JSON.parse(successRes.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe("run");
      expect(envelope.data.runId).toBe("run-sample-1");

      const failingRuntime = createMockRuntime({
        start: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "validation" as const,
            retryable: false as const,
            message: "Invalid definition structure"
          }
        }))
      });

      const errorRes = await runCli(["run", "Build feature", "--json"], {
        cwd: tempDir,
        runtime: failingRuntime
      });

      expect(errorRes.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      const errEnvelope = JSON.parse(errorRes.stderr);
      expect(errEnvelope.ok).toBe(false);
      expect(errEnvelope.error.code).toBe("validation");
    });
  });

  describe("4. bflow status and bflow status <run-id>", () => {
    it("calls runtime.findRuns when no runId is provided", async () => {
      const runtime = createMockRuntime({
        findRuns: vi.fn(async () => ({
          ok: true as const,
          value: {
            items: [sampleRunningSnapshot, sampleWaitingSnapshot],
            nextCursor: null,
            hasMore: false
          }
        }))
      });

      const result = await runCli(["status"], { runtime });
      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(runtime.findRuns).toHaveBeenCalledTimes(1);
      expect(result.stdout).toContain("run-sample-1");
      expect(result.stdout).toContain("run-waiting-1");
    });

    it("passes filter flags to runtime.findRuns", async () => {
      const runtime = createMockRuntime();
      const result = await runCli(
        [
          "status",
          "--status",
          "running,waiting",
          "--workflow-id",
          "sdlc-standard-workflow",
          "--limit",
          "10",
          "--cursor",
          "cursor-abc"
        ],
        { runtime }
      );

      expect(result.exitCode).toBe(0);
      expect(runtime.findRuns).toHaveBeenCalledWith(
        {
          status: ["running", "waiting"],
          workflowId: "sdlc-standard-workflow",
          limit: 10,
          cursor: "cursor-abc"
        },
        undefined
      );
    });

    it("handles empty runs list gracefully", async () => {
      const runtime = createMockRuntime({
        findRuns: vi.fn(async () => ({
          ok: true as const,
          value: { items: [], nextCursor: null, hasMore: false }
        }))
      });

      const result = await runCli(["status"], { runtime });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No workflow runs found");
    });

    it("calls runtime.getRun(runId) when runId is provided and formats task progress", async () => {
      const runtime = createMockRuntime({
        getRun: vi.fn(async (id: string) => {
          if (id === "run-waiting-1") return { ok: true as const, value: sampleWaitingSnapshot };
          return { ok: true as const, value: null };
        })
      });

      const result = await runCli(["status", "run-waiting-1"], { runtime });
      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(runtime.getRun).toHaveBeenCalledWith("run-waiting-1", undefined);
      expect(result.stdout).toContain("Run ID:   run-waiting-1");
      expect(result.stdout).toContain("qa");
      expect(result.stdout).toContain("awaiting_approval");
      expect(result.stdout).toContain("Notice: Run is waiting on 'qa'");
    });

    it("returns exitCode 1 and not_found error when getRun returns null", async () => {
      const runtime = createMockRuntime({
        getRun: vi.fn(async () => ({ ok: true as const, value: null }))
      });

      const result = await runCli(["status", "non-existent-run"], { runtime });
      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("not_found");
      expect(result.stderr).toContain("non-existent-run");
    });

    it("supports --json output for single run and list queries", async () => {
      const runtime = createMockRuntime();
      const listRes = await runCli(["status", "--json"], { runtime });
      expect(listRes.exitCode).toBe(0);
      const listEnvelope = JSON.parse(listRes.stdout);
      expect(listEnvelope.ok).toBe(true);
      expect(listEnvelope.data.items).toHaveLength(1);

      const singleRes = await runCli(["status", "run-sample-1", "--json"], { runtime });
      expect(singleRes.exitCode).toBe(0);
      const singleEnvelope = JSON.parse(singleRes.stdout);
      expect(singleEnvelope.ok).toBe(true);
      expect(singleEnvelope.data.runId).toBe("run-sample-1");
    });
  });

  describe("5. bflow approve <task-id> execution & disambiguation", () => {
    it("approves task with explicit --run flag", async () => {
      const runtime = createMockRuntime({
        getRun: vi.fn(async () => ({ ok: true as const, value: sampleWaitingSnapshot })),
        decide: vi.fn(async () => ({ ok: true as const, value: sampleRunningSnapshot }))
      });

      const result = await runCli(
        ["approve", "qa", "--run", "run-waiting-1", "--by", "alice_lead"],
        { runtime }
      );

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(runtime.decide).toHaveBeenCalledTimes(1);

      const decision = (runtime.decide as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ApprovalDecision;
      expect(decision.schemaVersion).toBe(1);
      expect(decision.runId).toBe("run-waiting-1");
      expect(decision.target).toEqual({ type: "task", taskId: "qa" });
      expect(decision.decision).toBe("approved");
      expect(decision.decidedBy).toBe("alice_lead");
    });

    it("auto-resolves run when --run is omitted and exactly 1 active run contains task", async () => {
      const runtime = createMockRuntime({
        findRuns: vi.fn(async () => ({
          ok: true as const,
          value: { items: [sampleWaitingSnapshot], nextCursor: null, hasMore: false }
        })),
        decide: vi.fn(async () => ({ ok: true as const, value: sampleRunningSnapshot }))
      });

      const result = await runCli(["approve", "qa", "--by", "bob_operator"], { runtime });
      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(runtime.findRuns).toHaveBeenCalledTimes(1);
      expect(runtime.decide).toHaveBeenCalledTimes(1);

      const decision = (runtime.decide as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ApprovalDecision;
      expect(decision.runId).toBe("run-waiting-1");
      expect(decision.decidedBy).toBe("bob_operator");
    });

    it("smart disambiguation: selects waiting/awaiting_approval run over running/pending run without conflict", async () => {
      // Run 1: Waiting on QA with blockage awaiting_approval
      const waitingRun: WorkflowRunSnapshot = {
        ...sampleWaitingSnapshot,
        runId: "run-target-waiting"
      };

      // Run 2: Running, but QA task is still pending (not awaiting approval)
      const runningRun: WorkflowRunSnapshot = {
        ...sampleRunningSnapshot,
        runId: "run-other-running"
      };

      const runtime = createMockRuntime({
        findRuns: vi.fn(async () => ({
          ok: true as const,
          value: { items: [runningRun, waitingRun], nextCursor: null, hasMore: false }
        })),
        decide: vi.fn(async () => ({ ok: true as const, value: sampleRunningSnapshot }))
      });

      const result = await runCli(["approve", "qa", "--by", "alice_lead"], { runtime });

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(runtime.decide).toHaveBeenCalledTimes(1);

      const decision = (runtime.decide as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ApprovalDecision;
      expect(decision.runId).toBe("run-target-waiting");
    });

    it("supports multi-page pagination when searching for active runs", async () => {
      // Page 1 contains a run without the target task
      const otherRun: WorkflowRunSnapshot = {
        ...sampleRunningSnapshot,
        runId: "run-page1",
        tasks: [{ taskId: "plan", status: "running", attempt: 1, generation: 0, version: 1 }]
      };

      // Page 2 contains the run awaiting approval on QA
      const targetRun: WorkflowRunSnapshot = {
        ...sampleWaitingSnapshot,
        runId: "run-page2-qa"
      };

      const runtime = createMockRuntime({
        findRuns: vi.fn(async (query?: { cursor?: string }) => {
          if (query?.cursor === "page-2-cursor") {
            return {
              ok: true as const,
              value: { items: [targetRun], nextCursor: null, hasMore: false }
            };
          }
          return {
            ok: true as const,
            value: { items: [otherRun], nextCursor: "page-2-cursor", hasMore: true }
          };
        }),
        decide: vi.fn(async () => ({ ok: true as const, value: sampleRunningSnapshot }))
      });

      const result = await runCli(["approve", "qa", "--by", "alice_lead"], { runtime });

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(runtime.findRuns).toHaveBeenCalledTimes(2);
      expect(runtime.decide).toHaveBeenCalledTimes(1);

      const decision = (runtime.decide as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ApprovalDecision;
      expect(decision.runId).toBe("run-page2-qa");
    });

    it("returns not_found when no active runs contain the specified task without --run", async () => {
      const runtime = createMockRuntime({
        findRuns: vi.fn(async () => ({
          ok: true as const,
          value: { items: [], nextCursor: null, hasMore: false }
        }))
      });

      const result = await runCli(["approve", "nonexistent-task", "--by", "alice"], {
        runtime
      });

      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("not_found");
      expect(runtime.decide).not.toHaveBeenCalled();
    });

    it("returns conflict when multiple runs are both awaiting approval for the same task without --run", async () => {
      const run1 = { ...sampleWaitingSnapshot, runId: "run-waiting-1" };
      const run2 = { ...sampleWaitingSnapshot, runId: "run-waiting-2" };

      const runtime = createMockRuntime({
        findRuns: vi.fn(async () => ({
          ok: true as const,
          value: { items: [run1, run2], nextCursor: null, hasMore: false }
        }))
      });

      const result = await runCli(["approve", "qa", "--by", "alice"], { runtime });
      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("conflict");
      expect(result.stderr).toContain("Multiple active runs");
      expect(runtime.decide).not.toHaveBeenCalled();
    });

    it("rejects AI and automated approver identities with USAGE_ERROR and never calls decide", async () => {
      const runtime = createMockRuntime();

      const automatedIdentities = ["bot", "ai-assistant", "claude", "reviewer", "gpt-4"];
      for (const actor of automatedIdentities) {
        const result = await runCli(
          ["approve", "qa", "--run", "run-waiting-1", "--by", actor],
          { runtime }
        );

        expect(result.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("validation");
        expect(runtime.decide).not.toHaveBeenCalled();
      }
    });

    it("supports changes_requested with mandatory reason", async () => {
      const runtime = createMockRuntime({
        getRun: vi.fn(async () => ({ ok: true as const, value: sampleWaitingSnapshot }))
      });

      const result = await runCli(
        [
          "approve",
          "qa",
          "--run",
          "run-waiting-1",
          "--by",
          "alice_lead",
          "--decision",
          "changes_requested",
          "--reason",
          "Add boundary unit tests for empty string payloads"
        ],
        { runtime }
      );

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);

      const decision = (runtime.decide as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ApprovalDecision;
      expect(decision.decision).toBe("changes_requested");
      expect(decision.reason).toBe("Add boundary unit tests for empty string payloads");
    });

    it("supports rejected decision with reason", async () => {
      const runtime = createMockRuntime({
        getRun: vi.fn(async () => ({ ok: true as const, value: sampleWaitingSnapshot }))
      });

      const result = await runCli(
        [
          "approve",
          "qa",
          "--run",
          "run-waiting-1",
          "--by",
          "alice_lead",
          "--decision",
          "rejected",
          "--reason",
          "Requirement deprecated by product direction"
        ],
        { runtime }
      );

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);

      const decision = (runtime.decide as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ApprovalDecision;
      expect(decision.decision).toBe("rejected");
      expect(decision.reason).toBe("Requirement deprecated by product direction");
    });

    it("supports --json output for approve command", async () => {
      const runtime = createMockRuntime({
        getRun: vi.fn(async () => ({ ok: true as const, value: sampleWaitingSnapshot }))
      });

      const result = await runCli(
        ["approve", "qa", "--run", "run-waiting-1", "--by", "alice", "--json"],
        { runtime }
      );

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe("approve");
    });
  });

  describe("6. bflow resume <run-id> execution", () => {
    it("calls runtime.resume with valid ResumeRunInput", async () => {
      const runtime = createMockRuntime();
      const result = await runCli(
        ["resume", "run-sample-1", "--idempotency-key", "resume-key-10"],
        { runtime }
      );

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(runtime.resume).toHaveBeenCalledTimes(1);

      const input = (runtime.resume as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ResumeRunInput;
      expect(input.runId).toBe("run-sample-1");
      expect(input.idempotencyKey).toBe("resume-key-10");
      expect(input.requestedAt).toBeDefined();
    });

    it("handles not_found and conflict errors from runtime.resume", async () => {
      const runtimeNotFound = createMockRuntime({
        resume: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "not_found" as const,
            retryable: false as const,
            message: "Run 'run-999' not found"
          }
        }))
      });

      const resNotFound = await runCli(["resume", "run-999"], { runtime: runtimeNotFound });
      expect(resNotFound.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(resNotFound.ok).toBe(false);
      expect(resNotFound.error?.code).toBe("not_found");

      const runtimeConflict = createMockRuntime({
        resume: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "conflict" as const,
            retryable: true as const,
            message: "Cannot resume a terminal run"
          }
        }))
      });

      const resConflict = await runCli(["resume", "run-terminal"], { runtime: runtimeConflict });
      expect(resConflict.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(resConflict.ok).toBe(false);
      expect(resConflict.error?.code).toBe("conflict");
    });

    it("supports --json output for resume command", async () => {
      const runtime = createMockRuntime();
      const result = await runCli(["resume", "run-sample-1", "--json"], { runtime });
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe("resume");
      expect(envelope.data.runId).toBe("run-sample-1");
    });
  });

  describe("7. bflow cancel <run-id> execution", () => {
    it("calls runtime.cancel with explicit --expected-version", async () => {
      const runtime = createMockRuntime();
      const result = await runCli(
        [
          "cancel",
          "run-sample-1",
          "--expected-version",
          "3",
          "--reason",
          "Operator cancelled",
          "--by",
          "alice_lead"
        ],
        { runtime }
      );

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(runtime.cancel).toHaveBeenCalledTimes(1);

      const req = (runtime.cancel as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as CancellationRequest;
      expect(req.runId).toBe("run-sample-1");
      expect(req.expectedVersion).toBe(3);
      expect(req.reason).toBe("Operator cancelled");
      expect(req.requestedBy).toBe("alice_lead");
    });

    it("queries runtime.getRun to auto-discover version when --expected-version is omitted", async () => {
      const runtime = createMockRuntime({
        getRun: vi.fn(async () => ({ ok: true as const, value: sampleRunningSnapshot }))
      });

      const result = await runCli(["cancel", "run-sample-1"], { runtime });
      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(runtime.getRun).toHaveBeenCalledWith("run-sample-1", undefined);
      expect(runtime.cancel).toHaveBeenCalledTimes(1);

      const req = (runtime.cancel as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as CancellationRequest;
      expect(req.expectedVersion).toBe(sampleRunningSnapshot.version);
    });

    it("supports task-specific cancellation with --task", async () => {
      const runtime = createMockRuntime();
      const result = await runCli(
        ["cancel", "run-sample-1", "--task", "implement", "--expected-version", "3"],
        { runtime }
      );

      expect(result.exitCode).toBe(0);
      const req = (runtime.cancel as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as CancellationRequest;
      expect(req.taskId).toBe("implement");
    });

    it("handles missing run when getRun returns null during auto-discovery", async () => {
      const runtime = createMockRuntime({
        getRun: vi.fn(async () => ({ ok: true as const, value: null }))
      });

      const result = await runCli(["cancel", "missing-run"], { runtime });
      expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("not_found");
      expect(runtime.cancel).not.toHaveBeenCalled();
    });

    it("supports --json output for cancel command", async () => {
      const runtime = createMockRuntime();
      const result = await runCli(
        ["cancel", "run-sample-1", "--expected-version", "3", "--json"],
        { runtime }
      );

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe("cancel");
    });
  });

  describe("8. Missing RuntimeService handling & ContractErrorSchema compliance", () => {
    it("returns valid transport_unavailable error conforming to ContractErrorSchema with retryable: true", async () => {
      const commandsRequiringRuntime: readonly (readonly string[])[] = [
        ["run", "Build service"],
        ["status", "run-123"],
        ["approve", "qa", "--by", "alice"],
        ["resume", "run-123"],
        ["cancel", "run-123", "--expected-version", "1"]
      ];

      for (const argv of commandsRequiringRuntime) {
        const result = await runCli(argv, { cwd: tempDir, runtime: undefined });
        expect(result.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("transport_unavailable");
        expect(result.error?.retryable).toBe(true);
        expect(result.stderr).toContain("RuntimeService is not configured");

        // ContractErrorSchema strict validation
        const parseErr = ContractErrorSchema.safeParse(result.error);
        expect(parseErr.success).toBe(true);
      }
    });
  });

  describe("9. main() entrypoint & executeCommand direct invocation", () => {
    it("executes CLI via main() entrypoint with process.exitCode management", async () => {
      const prevExitCode = process.exitCode;
      try {
        const stdoutMessages: string[] = [];
        const io = {
          stdout: (msg: string) => stdoutMessages.push(msg),
          stderr: () => {}
        };

        const result = await main(["--help"], { io });
        expect(result.exitCode).toBe(0);
        expect(result.ok).toBe(true);
        expect(process.exitCode).toBe(0);
        expect(stdoutMessages.some((m) => m.includes("Usage: bflow <command>"))).toBe(true);

        const errorResult = await main(["--unknown-command-xyz"], { io });
        expect(errorResult.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
        expect(errorResult.ok).toBe(false);
        expect(process.exitCode).toBe(CLI_EXIT_CODES.USAGE_ERROR);
      } finally {
        process.exitCode = prevExitCode;
      }
    });

    it("executes parsed command object directly through executeCommand", async () => {
      const parsed = parseCliArgs(["init", "--name", "direct-test"]);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const result = await executeCommand(parsed.value, { cwd: tempDir });
        expect(result.exitCode).toBe(0);
        expect(result.ok).toBe(true);
      }
    });

    it("wires custom io callbacks for stdout and stderr in executeCommand", async () => {
      const stdoutMessages: string[] = [];
      const stderrMessages: string[] = [];

      const io = {
        stdout: (msg: string) => stdoutMessages.push(msg),
        stderr: (msg: string) => stderrMessages.push(msg)
      };

      const parsedHelp = parseCliArgs(["--help"]);
      if (parsedHelp.ok) {
        await executeCommand(parsedHelp.value, { io });
        expect(stdoutMessages.length).toBeGreaterThan(0);
        expect(stdoutMessages[0]).toContain("Usage: bflow <command>");
      }

      const parsedStatus = parseCliArgs(["status", "run-123"]);
      if (parsedStatus.ok) {
        await executeCommand(parsedStatus.value, { io, runtime: undefined });
        expect(stderrMessages.length).toBeGreaterThan(0);
        expect(stderrMessages[0]).toContain("RuntimeService is not configured");
      }
    });

    it("outputs semver version on --version and -v with exit code 0 and empty stderr", async () => {
      const prevExitCode = process.exitCode;
      try {
        const io = { stdout: () => {}, stderr: () => {} };
        const longRes = await main(["--version"], { io });
        expect(longRes.exitCode).toBe(0);
        expect(longRes.ok).toBe(true);
        expect(longRes.stderr).toBe("");
        expect(longRes.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

        const shortRes = await main(["-v"], { io });
        expect(shortRes.exitCode).toBe(0);
        expect(shortRes.ok).toBe(true);
        expect(shortRes.stderr).toBe("");
        expect(shortRes.stdout.trim()).toBe(longRes.stdout.trim());

        const jsonRes = await main(["--version", "--json"], { io });
        expect(jsonRes.exitCode).toBe(0);
        const parsed = JSON.parse(jsonRes.stdout);
        expect(parsed.ok).toBe(true);
        expect(parsed.command).toBe("version");
        expect(parsed.data.version).toMatch(/^\d+\.\d+\.\d+/);
      } finally {
        process.exitCode = prevExitCode;
      }
    });

    it("composes RuntimeService in main() for business commands after bflow init and closes stores cleanly", async () => {
      const prevExitCode = process.exitCode;
      const prevHerdrBin = process.env["BFLOW_HERDR_BIN"];
      try {
        const fakeHerdrPath = join(tempDir, "fake-herdr.mjs");
        const fakeHerdrScript = `#!/usr/bin/env node
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
        await writeFile(fakeHerdrPath, fakeHerdrScript, "utf8");
        await chmod(fakeHerdrPath, 0o755);
        process.env["BFLOW_HERDR_BIN"] = fakeHerdrPath;

        const io = { stdout: () => {}, stderr: () => {} };

        const initRes = await main(["init", "--json"], { cwd: tempDir, io });
        expect(initRes.exitCode).toBe(0);
        expect(initRes.ok).toBe(true);

        const runRes = await main(
          ["run", "Implement authentication flow", "--run-id", "run-composed-1", "--json"],
          { cwd: tempDir, io }
        );
        expect(runRes.exitCode, runRes.stderr + runRes.stdout).toBe(0);
        expect(runRes.ok).toBe(true);
        const runEnvelope = JSON.parse(runRes.stdout);
        expect(runEnvelope.ok).toBe(true);
        expect(runEnvelope.command).toBe("run");
        expect(runEnvelope.data.runId).toBe("run-composed-1");

        const statusRes = await main(["status", "run-composed-1", "--json"], { cwd: tempDir, io });
        expect(statusRes.exitCode).toBe(0);
        expect(statusRes.ok).toBe(true);
        const statusEnvelope = JSON.parse(statusRes.stdout);
        expect(statusEnvelope.ok).toBe(true);
        expect(statusEnvelope.data.runId).toBe("run-composed-1");

        const resumeRes = await main(["resume", "run-composed-1", "--json"], { cwd: tempDir, io });
        expect(resumeRes.exitCode).toBe(0);
        expect(resumeRes.ok).toBe(true);

        const cancelRes = await main(
          ["cancel", "run-composed-1", "--reason", "Operator cancelled", "--json"],
          { cwd: tempDir, io }
        );
        expect(cancelRes.exitCode).toBe(0);
        expect(cancelRes.ok).toBe(true);
        const cancelEnvelope = JSON.parse(cancelRes.stdout);
        expect(cancelEnvelope.ok).toBe(true);
        expect(["cancelling", "cancelled"]).toContain(cancelEnvelope.data.status);
      } finally {
        if (prevHerdrBin === undefined) {
          delete process.env["BFLOW_HERDR_BIN"];
        } else {
          process.env["BFLOW_HERDR_BIN"] = prevHerdrBin;
        }
        process.exitCode = prevExitCode;
      }
    });

    it("fails closed in main() when .bflow/config.yml is missing or malformed", async () => {
      const prevExitCode = process.exitCode;
      try {
        const io = { stdout: () => {}, stderr: () => {} };

        const missingRes = await main(["status", "run-123", "--json"], { cwd: tempDir, io });
        expect(missingRes.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
        expect(missingRes.ok).toBe(false);
        expect(missingRes.error?.code).toBe("not_found");

        await main(["init"], { cwd: tempDir, io });
        await writeFile(join(tempDir, ".bflow", "config.yml"), "{ invalid yaml", "utf8");

        const malformedRes = await main(["run", "Test malformed config", "--json"], {
          cwd: tempDir,
          io
        });
        expect(malformedRes.exitCode).toBe(CLI_EXIT_CODES.RUNTIME_ERROR);
        expect(malformedRes.ok).toBe(false);
        expect(malformedRes.error?.code).toBe("corruption");
      } finally {
        process.exitCode = prevExitCode;
      }
    });
  });
});
