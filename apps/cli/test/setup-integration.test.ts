import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCliArgs,
  runCli,
  executeSetupCommand,
  issueSetupApproval,
  EnvironmentProviderSchema,
  DEFAULT_PROVIDER_BY_CLI,
  EnvironmentRoleConfigSchema,
  EnvironmentConfigSchema,
  EnvironmentConfigEnvironmentSchema,
  formatCommandSuccess,
  getHelpText,
  CLI_COMMAND_NAMES,
  type SetupCommandArgs,
  type CliContext
} from "../src/index.js";
import { defaultHostEnvironment, detectPlatform } from "@bflow/machine-setup";

describe("Task 1: Bflow Platform v3 Setup Integration & Lifecycle", () => {
  describe("1. Environment Config & Schemas", () => {
    it("expands EnvironmentProviderSchema to include claude, codex, and agy", () => {
      expect(EnvironmentProviderSchema.parse("claude")).toBe("claude");
      expect(EnvironmentProviderSchema.parse("codex")).toBe("codex");
      expect(EnvironmentProviderSchema.parse("agy")).toBe("agy");
      expect(() => EnvironmentProviderSchema.parse("unknown")).toThrow();
    });

    it("verifies DEFAULT_PROVIDER_BY_CLI mapping", () => {
      expect(DEFAULT_PROVIDER_BY_CLI).toEqual({
        claude: "anthropic",
        codex: "openai",
        agy: "google"
      });
    });

    it("extends EnvironmentRoleConfigSchema with v3 fields in strict mode", () => {
      const minimal = {
        role: "developer",
        cli: "claude"
      };
      const parsedMinimal = EnvironmentRoleConfigSchema.parse(minimal);
      expect(parsedMinimal.role).toBe("developer");
      expect(parsedMinimal.cli).toBe("claude");

      const fullV3 = {
        role: "developer",
        cli: "claude",
        required: true,
        permissionMode: "workspace_auto",
        fallbackCli: "codex",
        requiredEnv: ["ANTHROPIC_API_KEY"],
        skills: ["using-bflow", "implement-task"],
        unsupportedFlags: ["--experimental"]
      };
      const parsedFull = EnvironmentRoleConfigSchema.parse(fullV3);
      expect(parsedFull.permissionMode).toBe("workspace_auto");
      expect(parsedFull.fallbackCli).toBe("codex");
      expect(parsedFull.requiredEnv).toEqual(["ANTHROPIC_API_KEY"]);
      expect(parsedFull.skills).toEqual(["using-bflow", "implement-task"]);

      // Rejects unknown properties due to strict mode
      expect(() =>
        EnvironmentRoleConfigSchema.parse({
          ...minimal,
          unknownProperty: "bad"
        })
      ).toThrow();
    });

    it("extends EnvironmentConfigEnvironmentSchema with v3 fields in strict mode", () => {
      const baseEnv = {
        repositoryId: "repo-1",
        workspaceRoot: "/workspace",
        sessionName: "repo-session",
        herdrBinary: "herdr",
        roles: [{ role: "conversation", cli: "claude", required: true }, { role: "coordinator", cli: "claude", required: true }],
        sdd: { minimumLevel: "lightweight", approvalRequired: true },
        tdd: { policy: "conditional" },
        verification: { maxIterations: 3, onExhausted: "require_human" },
        concurrency: { maxConcurrency: 2 },
        startupTimeoutMs: 60000,
        shutdownTimeoutMs: 30000
      };

      // Parses without v3 optional fields
      const parsedBase = EnvironmentConfigEnvironmentSchema.parse(baseEnv);
      expect(parsedBase.repositoryId).toBe("repo-1");

      // Parses with all v3 optional fields
      const fullV3Env = {
        ...baseEnv,
        allowProviderFallback: true,
        permissions: {
          mode: "workspace_auto",
          isolation: "os_sandbox",
          trustedWorkspace: true,
          unsupportedFlags: ["--no-verify"]
        },
        requiredMcpServices: ["gitnexus", "chrome"],
        requiredTools: ["rtk"],
        skills: {
          required: true,
          catalogDir: "skills",
          bindingsPath: "skills/roles/bindings.json",
          requiredSkills: ["using-bflow"]
        }
      };
      const parsedFull = EnvironmentConfigEnvironmentSchema.parse(fullV3Env);
      expect(parsedFull.allowProviderFallback).toBe(true);
      expect(parsedFull.permissions?.mode).toBe("workspace_auto");
      expect(parsedFull.requiredMcpServices).toEqual(["gitnexus", "chrome"]);
      expect(parsedFull.requiredTools).toEqual(["rtk"]);
      expect(parsedFull.skills?.requiredSkills).toEqual(["using-bflow"]);

      // Strict mode rejects invalid nested fields
      expect(() =>
        EnvironmentConfigEnvironmentSchema.parse({
          ...baseEnv,
          permissions: { mode: "workspace_auto", extra: "illegal" }
        })
      ).toThrow();
      expect(() =>
        EnvironmentConfigEnvironmentSchema.parse({
          ...baseEnv,
          skills: { required: true, extra: "illegal" }
        })
      ).toThrow();
    });

    it("verifies EnvironmentConfigSchema has shape.environment and validates strict repository config", () => {
      expect(EnvironmentConfigSchema.shape.environment).toBe(EnvironmentConfigEnvironmentSchema);
    });
  });

  describe("2. CLI Command Parser for Init and Setup", () => {
    it("parses init with --provider agy", () => {
      const res = parseCliArgs(["init", "--provider", "agy"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("init");
        if (res.value.command === "init") {
          expect(res.value.provider).toBe("agy");
        }
      }
    });

    it("parses setup with default mode apply", () => {
      const res = parseCliArgs(["setup"]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.command).toBe("setup");
        if (res.value.command === "setup") {
          expect(res.value.mode).toBe("apply");
          expect(res.value.yes).toBe(false);
          expect(res.value.dir).toBeUndefined();
          expect(res.value.catalogDir).toBeUndefined();
        }
      }
    });

    it("parses setup modes: --check, --dry-run, --plan, --apply, --repair", () => {
      const checkRes = parseCliArgs(["setup", "--check"]);
      expect(checkRes.ok).toBe(true);
      if (checkRes.ok && checkRes.value.command === "setup") {
        expect(checkRes.value.mode).toBe("check");
      }

      const dryRunRes = parseCliArgs(["setup", "--dry-run"]);
      expect(dryRunRes.ok).toBe(true);
      if (dryRunRes.ok && dryRunRes.value.command === "setup") {
        expect(dryRunRes.value.mode).toBe("dry_run");
      }

      const planRes = parseCliArgs(["setup", "--plan"]);
      expect(planRes.ok).toBe(true);
      if (planRes.ok && planRes.value.command === "setup") {
        expect(planRes.value.mode).toBe("dry_run");
      }

      const applyRes = parseCliArgs(["setup", "--apply"]);
      expect(applyRes.ok).toBe(true);
      if (applyRes.ok && applyRes.value.command === "setup") {
        expect(applyRes.value.mode).toBe("apply");
      }

      const repairRes = parseCliArgs(["setup", "--repair"]);
      expect(repairRes.ok).toBe(true);
      if (repairRes.ok && repairRes.value.command === "setup") {
        expect(repairRes.value.mode).toBe("repair");
      }
    });

    it("parses setup flags --yes, -y, --dir, and --catalog-dir", () => {
      const res1 = parseCliArgs(["setup", "--apply", "--yes", "--dir", "./sub", "--catalog-dir", "./my-skills"]);
      expect(res1.ok).toBe(true);
      if (res1.ok && res1.value.command === "setup") {
        expect(res1.value.mode).toBe("apply");
        expect(res1.value.yes).toBe(true);
        expect(res1.value.dir).toBe("./sub");
        expect(res1.value.catalogDir).toBe("./my-skills");
      }

      const res2 = parseCliArgs(["setup", "-y"]);
      expect(res2.ok).toBe(true);
      if (res2.ok && res2.value.command === "setup") {
        expect(res2.value.yes).toBe(true);
      }
    });

    it("rejects conflicting mode flags", () => {
      const res1 = parseCliArgs(["setup", "--check", "--apply"]);
      expect(res1.ok).toBe(false);

      const res2 = parseCliArgs(["setup", "--dry-run", "--repair"]);
      expect(res2.ok).toBe(false);
    });

    it("rejects unexpected positional arguments for setup", () => {
      const res = parseCliArgs(["setup", "unexpected-arg"]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Unexpected positional argument 'unexpected-arg'");
      }
    });

    it("includes setup in CLI_COMMAND_NAMES", () => {
      expect(CLI_COMMAND_NAMES).toContain("setup");
    });
  });

  describe("3. Help and Formatter Integration", () => {
    it("provides setup help text in getHelpText and mentions agy in init help", () => {
      const setupHelp = getHelpText("setup");
      expect(setupHelp).toContain("Usage: bflow setup [options]");
      expect(setupHelp).toContain("--check");
      expect(setupHelp).toContain("--dry-run");
      expect(setupHelp).toContain("--apply");
      expect(setupHelp).toContain("--repair");

      const initHelp = getHelpText("init");
      expect(initHelp).toContain("claude, codex, or agy");

      const globalHelp = getHelpText("help");
      expect(globalHelp).toContain("setup");
    });

    it("formats setup command output in human-readable form", () => {
      const output = {
        mode: "apply" as const,
        machineId: "m-12345",
        os: "linux",
        serviceManagerKind: "systemd-user" as const,
        plan: {
          schemaVersion: 3 as const,
          planId: "plan-1",
          machineId: "m-12345",
          revision: 1,
          planDigest: "d".repeat(64),
          createdAt: new Date().toISOString(),
          idempotencyKey: "idem-1",
          steps: [
            {
              schemaVersion: 3 as const,
              stepId: "step-1",
              action: "install_tool" as const,
              componentId: "rtk",
              level: "machine" as const,
              scope: { kind: "machine" as const, machineId: "m-12345" },
              dependsOn: [],
              desiredStateDigest: "a".repeat(64),
              expectedStateDigest: null,
              requiresApproval: true,
              rollback: "remove_owned_install" as const,
              idempotencyKey: "step-1"
            }
          ]
        },
        receipt: {
          schemaVersion: 3 as const,
          receiptId: "receipt-1",
          planId: "plan-1",
          stepId: "step-1",
          status: "applied" as const,
          executedAt: new Date().toISOString(),
          durationMs: 100,
          diagnostics: [],
          observedStateDigest: "a".repeat(64)
        },
        tools: [{ toolId: "rtk", status: "ready", version: "1.0.0" }],
        skills: {
          catalogLoaded: true,
          skillCount: 10,
          syncedManifests: 4,
          storeRoot: "/data/skills-store"
        },
        diagnostics: ["Setup completed successfully"]
      };

      const formatted = formatCommandSuccess("setup", output, false);
      expect(formatted).toContain("Setup Mode:         APPLY");
      expect(formatted).not.toContain("Machine ID:");
      expect(formatted).toContain("Operating System:   linux");
      expect(formatted).toContain("Service Manager:    systemd-user");
      expect(formatted).toContain("Plan ID:            plan-1");
      expect(formatted).toContain("rtk: ready (1.0.0)");
      expect(formatted).toContain("Catalog Loaded:   yes");
      expect(formatted).toContain("Skill Count:      10");
      expect(formatted).toContain("Setup completed successfully");
    });

    it("formats doctor with metadata.groups rendering 5 groups while preserving checks", () => {
      const doctorData = {
        workspaceRoot: "/workspace",
        sessionId: "sess-1",
        healthy: true,
        checks: [
          { status: "passed", name: "herdr", message: "Herdr binary found" },
          { status: "passed", name: "git", message: "Git repository valid" }
        ],
        metadata: {
          groups: {
            Runtime: [
              { component: "Workflow Engine", status: "passed", detected_version: "2.0.0" }
            ],
            "Agent Providers": [
              { component: "claude", status: "passed", detected_version: "1.2.0" },
              { component: "agy", status: "warning", reason: "Authentication token expiring soon", remediation: "Run agy login" }
            ],
            MCP: [
              { component: "gitnexus", status: "passed" }
            ],
            Tools: [
              { component: "rtk", status: "passed", detected_version: "0.9.0" }
            ],
            Skills: [
              { component: "using-bflow", status: "passed" }
            ]
          }
        }
      };

      const formatted = formatCommandSuccess("doctor", doctorData as any, false);
      // Healthy details are summarized; actionable diagnostics remain visible.
      expect(formatted).toContain("Repository: /workspace");
      expect(formatted).toContain("Passed (2): herdr, git");

      // Renders groups
      expect(formatted).toContain("[Runtime]");
      expect(formatted).toContain("Passed (1): Workflow Engine");
      expect(formatted).toContain("[Agent Providers]");
      expect(formatted).toContain("- [WARN] agy: Authentication token expiring soon");
      expect(formatted).toContain("Next: Run agy login");
      expect(formatted).toContain("[MCP]");
      expect(formatted).toContain("[Tools]");
      expect(formatted).toContain("[Skills]");
    });
  });

  describe("4. Setup Execution & Injection", () => {
    it("issues valid setup approval receipt via issueSetupApproval", () => {
      const plan = {
        schemaVersion: 3 as const,
        planId: "test-plan",
        machineId: "m-test",
        revision: 1,
        planDigest: "f".repeat(64),
        createdAt: new Date().toISOString(),
        idempotencyKey: "idem-plan",
        steps: [
          {
            schemaVersion: 3 as const,
            stepId: "step-elevated",
            action: "install_tool" as const,
            componentId: "rtk",
            level: "machine" as const,
            scope: { kind: "machine" as const, machineId: "m-test" },
            dependsOn: [],
            desiredStateDigest: "1".repeat(64),
            expectedStateDigest: null,
            requiresApproval: true,
            rollback: "remove_owned_install" as const,
            idempotencyKey: "step-elevated"
          }
        ]
      };

      const approval = issueSetupApproval(plan, "cli-operator");
      expect(approval.schemaVersion).toBe(3);
      expect(approval.planId).toBe("test-plan");
      expect(approval.stepIds).toEqual(["step-elevated"]);
      expect((approval as any).approvedBy).toBe("cli-operator");
      expect(approval.receiptId).toMatch(/^approval-[a-f0-9]{24}$/);
    });

    it("executes setup command with injected custom machineSetup supporting plan & apply", async () => {
      const mockPlan = {
        schemaVersion: 3 as const,
        planId: "injected-plan",
        machineId: "m-injected",
        revision: 1,
        planDigest: "e".repeat(64),
        createdAt: new Date().toISOString(),
        idempotencyKey: "idem-injected",
        steps: [
          {
            schemaVersion: 3 as const,
            stepId: "step-1",
            action: "install_tool" as const,
            componentId: "rtk",
            level: "machine" as const,
            scope: { kind: "machine" as const, machineId: "m-injected" },
            dependsOn: [],
            desiredStateDigest: "2".repeat(64),
            expectedStateDigest: null,
            requiresApproval: true,
            rollback: "remove_owned_install" as const,
            idempotencyKey: "step-1"
          }
        ]
      };

      const mockReceipt = {
        schemaVersion: 3 as const,
        receiptId: "receipt-injected",
        planId: "injected-plan",
        stepId: "step-1",
        status: "applied" as const,
        executedAt: new Date().toISOString(),
        durationMs: 42,
        diagnostics: [],
        observedStateDigest: "2".repeat(64)
      };

      const planFn = vi.fn().mockResolvedValue({
        plan: mockPlan,
        tools: [{ toolId: "rtk", status: "ready", version: "0.9.1" }],
        diagnostics: ["Plan calculated"]
      });

      const applyFn = vi.fn().mockResolvedValue({
        receipt: mockReceipt,
        diagnostics: ["Step applied"]
      });

      const customMachineSetup = {
        plan: planFn,
        apply: applyFn
      };

      const args: SetupCommandArgs = {
        command: "setup",
        mode: "apply",
        yes: true,
        json: true,
        help: false
      };

      const tempDir = await mkdtemp(join(tmpdir(), "bflow-setup-test-"));
      try {
        const context: CliContext = {
          cwd: tempDir,
          setup: {
            isolatedRoot: tempDir,
            machineSetup: customMachineSetup
          }
        };

        const progress: string[] = [];
        const result = await executeSetupCommand(args, context, step => progress.push(step));
        expect(planFn).toHaveBeenCalledWith({ mode: "apply", config: expect.anything() });
        expect(applyFn).toHaveBeenCalledWith({
          mode: "apply",
          config: expect.anything(),
          approval: expect.objectContaining({ planId: "injected-plan", stepIds: ["step-1"] })
        });

        expect(result.mode).toBe("apply");
        expect(result.plan.planId).toBe("injected-plan");
        expect(result.receipt?.receiptId).toBe("receipt-injected");
        expect(result.tools).toEqual([{ toolId: "rtk", status: "ready", version: "0.9.1" }]);
        expect(result.diagnostics).toContain("Plan calculated");
        expect(result.diagnostics).toContain("Step applied");
        expect(progress).toContain("Building apply setup plan...");
        expect(progress).toContain("Applying approved setup steps...");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("runs bflow setup through runCli and returns exitCode 0 in check mode", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "bflow-cli-setup-"));
      try {
        const mockPlan = {
          schemaVersion: 3 as const,
          planId: "cli-plan",
          machineId: "m-cli",
          revision: 1,
          planDigest: "c".repeat(64),
          createdAt: new Date().toISOString(),
          idempotencyKey: "idem-cli",
          steps: []
        };

        const customMachineSetup = {
          plan: vi.fn().mockResolvedValue({
            plan: mockPlan,
            tools: [{ toolId: "rtk", status: "ready" }],
            diagnostics: []
          })
        };

        const result = await runCli(["setup", "--check", "--json"], {
          cwd: tempDir,
          setup: {
            isolatedRoot: tempDir,
            machineSetup: customMachineSetup
          }
        });

        expect(result.ok).toBe(true);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.ok).toBe(true);
        expect(parsed.command).toBe("setup");
        expect(parsed.data.mode).toBe("check");
        expect(parsed.data.plan.planId).toBe("cli-plan");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
