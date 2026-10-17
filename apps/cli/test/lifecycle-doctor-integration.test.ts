import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionManifestSchema,
  EnvironmentDoctorReportSchema,
  AgentRoleSchema,
  type SessionLifecycleManager,
  type SessionManifest,
  type OperationOptions,
  type OperationResult
} from "@bflow/contracts";
import {
  EnvironmentLifecycle,
  EnvironmentError,
  runDoctorDiagnostics,
  identifyRepository,
  defaultEnvironmentConfig,
  type RepositoryIdentity,
  type EnvironmentConfig,
  type EnvironmentProcessRequest,
  type EnvironmentProcessRunner,
  type McpLifecycleState,
  type ProviderProbeOverride
} from "../src/index.js";

const now = "2026-10-17T00:00:00.000Z";
// EnvironmentLifecycle.up/down use the Linux flock guard; doctor diagnostics stay portable.
const linuxDescribe = describe.skipIf(process.platform !== "linux");
const roles = ["conversation", "coordinator", "planner", "architect", "specifier", "reviewer", "qa"] as const;

function makeConfig(repository: RepositoryIdentity, overrides?: Partial<EnvironmentConfig["environment"]>): string {
  const cfg = defaultEnvironmentConfig(repository, "test-repo", new Date(now), "claude");
  cfg.environment.startupTimeoutMs = 5000;
  if (overrides) {
    cfg.environment = { ...cfg.environment, ...overrides };
  }
  return JSON.stringify(cfg, null, 2);
}

class FakeLifecycleProcessRunner implements EnvironmentProcessRunner {
  readonly requests: EnvironmentProcessRequest[] = [];
  readonly running = new Set<string>();
  missing = new Set<string>();
  authenticated = true;
  claudeStatus: unknown = { loggedIn: true };

  async run(request: EnvironmentProcessRequest) {
    this.requests.push(request);
    if (request.executable === "git") {
      const result = execFileSync("git", request.args, {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        encoding: "utf8"
      });
      return { exitCode: 0, stdout: result, stderr: "" };
    }
    if (this.missing.has(request.executable)) {
      return { exitCode: 127, stdout: "", stderr: `command not found: ${request.executable}` };
    }

    const session = request.env?.["HERDR_SESSION"] ?? "test-session";
    const args = request.args.join(" ");

    if (args === "--version") return { exitCode: 0, stdout: "1.0.0", stderr: "" };
    if (args === "--help") return { exitCode: 0, stdout: "herdr --session NAME; Run as headless server", stderr: "" };
    if (args === "api schema --json") return { exitCode: 0, stdout: JSON.stringify({ protocol: 22, schema_version: 1 }), stderr: "" };
    if (args === "status server --json") {
      return { exitCode: 0, stdout: JSON.stringify({ running: this.running.has(session), session, protocol: 22, compatible: true }), stderr: "" };
    }
    if (args === "server") {
      this.running.add(session);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (request.args[0] === "session" && request.args[1] === "stop") {
      this.running.delete(request.args[2]!);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args === "login status") {
      return { exitCode: this.authenticated ? 0 : 1, stdout: "", stderr: this.authenticated ? "Logged in" : "not logged in" };
    }
    if (args === "auth status --json") {
      return { exitCode: 0, stdout: JSON.stringify(this.claudeStatus), stderr: "" };
    }
    if (args === "auth status") {
      return { exitCode: this.authenticated ? 0 : 1, stdout: "", stderr: "" };
    }

    return { exitCode: 0, stdout: "{}", stderr: "" };
  }
}

function createMockManager(repository: RepositoryIdentity) {
  let current: SessionManifest | null = null;
  const create = (overrides?: Partial<SessionManifest>) => SessionManifestSchema.parse({
    schemaVersion: 2,
    sessionId: repository.sessionName,
    projectName: "test-repo",
    workspaceRoot: repository.root,
    herdrWorkspaceId: "w1",
    herdrTabId: "w1:t1",
    status: "up",
    conversationSessionId: "conversation-1",
    activeRunIds: [],
    metadata: { panePresentationVersion: 1 },
    panes: roles.map((role, i) => ({
      schemaVersion: 2,
      bindingId: `binding-${i}`,
      sessionId: repository.sessionName,
      role,
      agentId: `agent-${i}`,
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: `w1:p${i}`,
      provider: "anthropic",
      agentKind: "claude",
      cwd: repository.root,
      isolationMode: "dedicated_pane",
      readOnlyWorkspace: role === "conversation",
      transportState: "idle",
      boundAt: now
    })),
    attachTarget: { role: "conversation", paneId: "w1:p0" },
    createdAt: now,
    updatedAt: now,
    ...overrides
  });

  const manager: SessionLifecycleManager = {
    init: vi.fn(async (m) => ({ ok: true, value: m })),
    up: vi.fn(async () => { current = create(); return { ok: true, value: current }; }),
    down: vi.fn(async () => {
      const downManifest = create({ status: "down", stoppedAt: new Date().toISOString() });
      current = downManifest;
      return { ok: true, value: downManifest };
    }),
    getManifest: vi.fn(async () => ({ ok: true, value: current })),
    saveManifest: vi.fn(async (m) => { current = m; return { ok: true, value: m }; }),
    focusConversation: vi.fn(async () => ({ ok: true, value: { role: "conversation", paneId: "w1:p0" } })),
    doctorSession: vi.fn(async () => ({
      schemaVersion: 2,
      workspaceRoot: repository.root,
      sessionId: repository.sessionName,
      healthy: true,
      checks: [{ checkId: "herdr-panes", name: "panes", status: "passed", message: "All panes ready" }],
      checkedAt: new Date().toISOString()
    }))
  };

  return { manager, create, get: () => current, set: (m: SessionManifest | null) => { current = m; } };
}

describe("Task 2: Platform v3 Lifecycle & Doctor Integration", () => {
  let dir: string;
  let runner: FakeLifecycleProcessRunner;
  let repository: RepositoryIdentity;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bflow-task2-test-"));
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: dir });
    runner = new FakeLifecycleProcessRunner();
    repository = await identifyRepository(dir, runner);
    await mkdir(join(dir, ".bflow"), { recursive: true });
    await writeFile(join(dir, ".bflow/config.yaml"), makeConfig(repository));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("runDoctorDiagnostics", () => {
    it.each([false, true])("probes the repository session despite inherited Herdr context (running=%s)", async (running) => {
      if (running) runner.running.add(repository.sessionName);
      const inheritedEnv = {
        ...process.env,
        HERDR_SESSION: "another-repository",
        HERDR_SOCKET: "/tmp/another-repository.sock",
        HERDR_PANE_ID: "another-pane",
        HERDR_CONFIG_PATH: "/tmp/operator-herdr-config.toml"
      };
      const fixture = createMockManager(repository);
      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        env: inheritedEnv,
        integration: { manager: fixture.manager }
      });

      const report = await lifecycle.doctor();

      expect(report.checks.find((check) => check.checkId === "herdr-session")).toMatchObject({
        status: "passed",
        message: running ? "Repository named session is running" : "Repository named session is stopped (run bflow up)"
      });
      const statusRequest = runner.requests.find((request) => request.args.join(" ") === "status server --json")!;
      expect(statusRequest.env).toMatchObject({
        HERDR_SESSION: repository.sessionName,
        HERDR_CONFIG_PATH: "/tmp/operator-herdr-config.toml"
      });
      expect(statusRequest.env).not.toHaveProperty("HERDR_SOCKET");
      expect(statusRequest.env).not.toHaveProperty("HERDR_PANE_ID");
      expect(inheritedEnv.HERDR_SESSION).toBe("another-repository");
    });

    it.each([
      { session: "another-repository", running: false },
      { session: "another-repository", running: true, protocol: 22 },
      { running: false },
      { running: "false" }
    ])("rejects an uncorrelated or malformed session response: %j", async (status) => {
      const statusRunner: EnvironmentProcessRunner = {
        run: async (request) => request.args.join(" ") === "status server --json"
          ? { exitCode: 0, stdout: JSON.stringify(status), stderr: "" }
          : runner.run(request)
      };
      const report = await runDoctorDiagnostics({ repository, config: null, runner: statusRunner });

      expect(report.checks.find((check) => check.checkId === "herdr-session")).toMatchObject({
        status: "failed",
        message: "Herdr returned an uncorrelated session status"
      });
    });

    it("returns valid EnvironmentDoctorReport matching schema with 5 diagnostic groups", async () => {
      const report = await runDoctorDiagnostics({
        repository,
        config: null,
        runner,
        env: process.env,
        dependencies: {},
        probeSession: async () => false,
        intent: async () => null,
        statePath: (n) => resolve(dir, ".bflow/state", n)
      });

      const parsed = EnvironmentDoctorReportSchema.parse(report);
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.workspaceRoot).toBe(repository.root);
      expect(parsed.sessionId).toBe(repository.sessionName);
      expect(Array.isArray(parsed.checks)).toBe(true);

      const metadata = parsed.metadata as any;
      expect(metadata).toBeDefined();
      expect(metadata.groups).toBeDefined();
      expect(metadata.groups.runtime).toBeDefined();
      expect(metadata.groups.agent_providers).toBeDefined();
      expect(metadata.groups.mcp).toBeDefined();
      expect(metadata.groups.tools).toBeDefined();
      expect(metadata.groups.skills).toBeDefined();
    });

    it("evaluates agent providers using providerOverrides when supplied", async () => {
      const providerOverrides: Record<"claude" | "codex" | "agy", ProviderProbeOverride> = {
        claude: { available: true, authenticated: true, version: "2.1.0" },
        codex: { available: false, authenticated: false, remediation: "Install codex via npm i -g @openai/codex" },
        agy: { available: true, authenticated: false }
      };

      const cfg: EnvironmentConfig = JSON.parse(
        makeConfig(repository, {
          roles: [
            { role: "conversation", cli: "claude", required: true },
            { role: "coordinator", cli: "codex", required: true },
            { role: "developer", cli: "agy", required: true }
          ]
        })
      );
      const report = await runDoctorDiagnostics({
        repository,
        config: cfg,
        runner,
        env: process.env,
        dependencies: { providerOverrides },
        probeSession: async () => false,
        intent: async () => null,
        statePath: (n) => resolve(dir, ".bflow/state", n)
      });

      const checks = report.checks;
      const claudeCheck = checks.find((c) => c.checkId === "agent-claude");
      expect(claudeCheck).toBeDefined();
      expect(claudeCheck?.status).toBe("passed");
      expect(claudeCheck?.message).toContain("2.1.0");

      const codexCheck = checks.find((c) => c.checkId === "agent-codex");
      expect(codexCheck).toBeDefined();
      expect(codexCheck?.status).toBe("failed");
      expect(codexCheck?.remediation).toContain("Install OpenAI Codex CLI");

      const agyCheck = checks.find((c) => c.checkId === "auth-agy");
      expect(agyCheck).toBeDefined();
      expect(agyCheck?.status).toBe("failed");
      expect(agyCheck?.message).toContain("not authenticated");
    });

    it("evaluates tools and skills via toolOverrides and skillsOverride", async () => {
      const cfg: EnvironmentConfig = JSON.parse(makeConfig(repository, { requiredTools: ["rtk"] }));
      const report = await runDoctorDiagnostics({
        repository,
        config: cfg,
        runner,
        env: process.env,
        dependencies: {
          toolOverrides: {
            rtk: { installed: false }
          },
          skillsOverride: {
            missingSkills: ["custom-skill"]
          }
        },
        probeSession: async () => false,
        intent: async () => null,
        statePath: (n) => resolve(dir, ".bflow/state", n)
      });

      const rtkCheck = report.checks.find((c) => c.checkId === "tool-rtk");
      expect(rtkCheck?.status).toBe("failed");
      expect(rtkCheck?.remediation).toContain("install 'rtk'");

      const skillsCheck = report.checks.find((c) => c.checkId === "skills-shared-installed");
      expect(skillsCheck?.status).toBe("failed");
      expect(skillsCheck?.message).toContain("missing: custom-skill");
    });
  });

  linuxDescribe("EnvironmentLifecycle.up() 12-step Sequence Validation", () => {
    it("fails when required provider is missing and has no fallback", async () => {
      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        providerOverrides: {
          claude: { available: false, authenticated: false }
        }
      });

      await expect(lifecycle.up()).rejects.toThrow("Missing required agent provider executable 'claude'");
    });

    it("falls back to fallbackCli when primary provider is missing but fallback is available", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, {
          allowProviderFallback: true,
          roles: roles.map((r) => ({
            role: AgentRoleSchema.parse(r),
            cli: "claude",
            fallbackCli: "codex",
            required: true
          }))
        })
      );

      const fixture = createMockManager(repository);

      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        providerOverrides: {
          claude: { available: false, authenticated: false },
          codex: { available: true, authenticated: true }
        },
        openIntegration: async () => ({ manager: fixture.manager })
      });

      const manifest = await lifecycle.up();
      expect(manifest.status).toBe("up");
      const metadata = manifest.metadata as any;
      expect(metadata?.providerFallbacks).toBeDefined();
      expect(metadata.providerFallbacks[0]).toContain("fell back from 'claude' to 'codex'");
    });

    it("fails when provider is not authenticated", async () => {
      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        providerOverrides: {
          claude: { available: true, authenticated: false }
        }
      });

      await expect(lifecycle.up()).rejects.toThrow("Agent provider 'claude' is not authenticated");
    });

    it("fails when permissions mode is unattended_isolated without os_sandbox or container isolation", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, {
          permissions: {
            mode: "unattended_isolated",
            isolation: "provider_policy",
            trustedWorkspace: true
          }
        })
      );

      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        providerOverrides: {
          claude: { available: true, authenticated: true }
        }
      });

      await expect(lifecycle.up()).rejects.toThrow("unattended_isolated' requires 'os_sandbox' or 'container' isolation");
    });

    it("fails when unsupported permission flags are configured", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, {
          permissions: {
            mode: "workspace_auto",
            trustedWorkspace: true,
            unsupportedFlags: ["--dangerously-skip-permissions"]
          }
        })
      );

      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        providerOverrides: {
          claude: { available: true, authenticated: true }
        }
      });

      await expect(lifecycle.up()).rejects.toThrow("Unsupported permission flags configured");
    });

    it("fails when role has missing requiredEnv variable", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, {
          roles: roles.map((r) => ({
            role: AgentRoleSchema.parse(r),
            cli: "claude",
            required: true,
            ...(r === "conversation" ? { requiredEnv: ["ANTHROPIC_CUSTOM_KEY"] } : {})
          }))
        })
      );

      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        env: {},
        providerOverrides: {
          claude: { available: true, authenticated: true }
        }
      });

      await expect(lifecycle.up()).rejects.toThrow("Missing required environment variable 'ANTHROPIC_CUSTOM_KEY'");
    });

    it("fails when required MCP services are requested but gateway is unavailable", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, {
          requiredMcpServices: ["git-service"]
        })
      );

      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        mcpState: {
          gatewayAvailable: false
        },
        providerOverrides: {
          claude: { available: true, authenticated: true }
        }
      });

      await expect(lifecycle.up()).rejects.toThrow("MCP Gateway service is unavailable");
    });

    it("records completed steps in manifest metadata after successful up", async () => {
      const fixture = createMockManager(repository);

      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        providerOverrides: {
          claude: { available: true, authenticated: true }
        },
        openIntegration: async () => ({ manager: fixture.manager })
      });

      const manifest = await lifecycle.up();
      const metadata = manifest.metadata as any;
      expect(metadata?.stepsCompleted).toBeDefined();
      expect(metadata.stepsCompleted).toContain("load_project_config");
      expect(metadata.stepsCompleted).toContain("validate_required_providers");
      expect(metadata.stepsCompleted).toContain("validate_binaries_and_auth");
      expect(metadata.stepsCompleted).toContain("validate_permissions_and_trust");
      expect(metadata.stepsCompleted).toContain("validate_required_mcp");
      expect(metadata.stepsCompleted).toContain("validate_skills");
      expect(metadata.stepsCompleted).toContain("verify_agent_readiness_preflight");
      expect(metadata.stepsCompleted).toContain("reconcile_herdr_session_and_panes");
      expect(metadata.stepsCompleted).toContain("start_required_agents");
      expect(metadata.stepsCompleted).toContain("confirm_roles_ready");
      expect(metadata.stepsCompleted).toContain("persist_environment_manifest");
      expect(metadata.stepsCompleted).toContain("report_success");
    });
  });

  linuxDescribe("EnvironmentLifecycle.down() Multi-Repository Shared MCP Protection", () => {
    it("protects shared and external MCP services when down is executed", async () => {
      const fixture = createMockManager(repository);

      const mcpState: McpLifecycleState = {
        gatewayAvailable: true,
        sessionRegistrations: new Map<string, string[]>([
          [repository.sessionName, ["svc-shared", "svc-repo-only"]],
          ["other-session-456", ["svc-shared", "svc-other-only"]]
        ]),
        activeRepositories: new Set<string>([repository.id, "other-repo-id"]),
        services: {
          "svc-shared": { scope: "session", ownership: "managed" },
          "svc-repo-only": { scope: "session", ownership: "managed" },
          "svc-machine": { scope: "machine", ownership: "managed" },
          "svc-external": { scope: "session", ownership: "external" }
        },
        stoppedServices: []
      };

      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        mcpState,
        providerOverrides: {
          claude: { available: true, authenticated: true }
        },
        openIntegration: async () => ({
          manager: fixture.manager,
          runtime: {
            findRuns: async () => ({ ok: true, value: { items: [] } })
          } as any,
          quiesce: async () => ({ ok: true, value: undefined }),
          shutdownHost: async () => {}
        })
      });

      // Bring up and then bring down
      await lifecycle.up();
      expect(mcpState.sessionRegistrations.has(repository.sessionName)).toBe(true);

      await lifecycle.down(true);

      // Session registration must be removed
      expect(mcpState.sessionRegistrations.has(repository.sessionName)).toBe(false);

      // svc-shared is still referenced by other-session-456, so it must NOT be stopped!
      expect(mcpState.stoppedServices).not.toContain("svc-shared");

      // svc-machine is machine scope, must NOT be stopped
      expect(mcpState.stoppedServices).not.toContain("svc-machine");

      // svc-external is external ownership, must NOT be stopped
      expect(mcpState.stoppedServices).not.toContain("svc-external");

      // svc-repo-only was only referenced by current session, so it MUST be stopped!
      expect(mcpState.stoppedServices).toContain("svc-repo-only");
    });
  });

  describe("EnvironmentLifecycle.doctor() Integration", () => {
    it("delegates to runDoctorDiagnostics and reflects healthy state", async () => {
      const fixture = createMockManager(repository);

      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        providerOverrides: {
          claude: { available: true, authenticated: true, version: "2.1.0" },
          codex: { available: true, authenticated: true, version: "0.9.0" },
          agy: { available: true, authenticated: true, version: "1.0.0" }
        },
        toolOverrides: [
          { name: "git", available: true, version: "2.40.0" },
          { name: "pnpm", available: true, version: "9.0.0" },
          { name: "flock", available: true, version: "2.38" }
        ],
        openIntegration: async () => ({ manager: fixture.manager })
      });

      const report = await lifecycle.doctor();
      expect(report.schemaVersion).toBe(2);
      expect(report.workspaceRoot).toBe(repository.root);
      expect(report.sessionId).toBe(repository.sessionName);
      expect(report.checks.length).toBeGreaterThan(0);
      const metadata = report.metadata as any;
      expect(metadata?.groups).toBeDefined();
    });
  });
});
