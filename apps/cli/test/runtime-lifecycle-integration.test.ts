import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionManifestSchema,
  EnvironmentDoctorReportSchema,
  type SessionLifecycleManager,
  type SessionManifest
} from "@bflow/contracts";
import {
  runCli,
  identifyRepository,
  defaultEnvironmentConfig,
  type RepositoryIdentity,
  type EnvironmentConfig,
  type EnvironmentProcessRequest,
  type EnvironmentProcessRunner,
  type McpLifecycleState
} from "../src/index.js";

const now = "2026-10-17T00:00:00.000Z";
const roles = ["conversation", "coordinator", "planner", "architect", "specifier", "reviewer", "qa"] as const;
// These lifecycle startup/shutdown scenarios acquire EnvironmentLifecycle's Linux flock guard.
const linuxDescribe = describe.skipIf(process.platform !== "linux");

function makeConfig(
  repository: RepositoryIdentity,
  provider: "claude" | "codex" | "agy" = "claude",
  overrides?: Partial<EnvironmentConfig["environment"]>
): string {
  const cfg = defaultEnvironmentConfig(repository, "test-repo", new Date(now), provider);
  cfg.environment.startupTimeoutMs = 5000;
  if (overrides) {
    cfg.environment = { ...cfg.environment, ...overrides };
  }
  return JSON.stringify(cfg, null, 2);
}

class FakeLifecycleProcessRunner implements EnvironmentProcessRunner {
  readonly requests: EnvironmentProcessRequest[] = [];
  readonly running = new Set<string>();
  currentSession?: string;
  missing = new Set<string>();
  authenticated = true;
  claudeStatus: unknown = { loggedIn: true };
  agyStatus: unknown = { loggedIn: true };
  agyStderr = "";
  agyBlocked = false;
  serverStarts = 0;

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

    const session = request.env?.["HERDR_SESSION"] ?? this.currentSession ?? "test-session";
    const args = request.args.join(" ");

    if (args === "--version") return { exitCode: 0, stdout: "1.0.0", stderr: "" };
    if (args === "--help") return { exitCode: 0, stdout: "herdr --session NAME; Run as headless server", stderr: "" };
    if (args === "api schema --json") return { exitCode: 0, stdout: JSON.stringify({ protocol: 22, schema_version: 1 }), stderr: "" };
    if (args === "status server --json") {
      return { exitCode: 0, stdout: JSON.stringify({ running: this.running.has(session), session, protocol: 22, compatible: true }), stderr: "" };
    }
    if (args === "server") {
      this.serverStarts++;
      this.running.add(session);
      return { exitCode: 0, stdout: "", stderr: "", pid: 999999 };
    }
    if (request.args[0] === "session" && request.args[1] === "stop") {
      const stopTarget = request.args[2] ?? session;
      this.running.delete(stopTarget);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (request.executable === "codex" && args === "login status") {
      return {
        exitCode: this.authenticated ? 0 : 1,
        stdout: "",
        stderr: this.authenticated ? "Logged in" : "not logged in [token-unauthenticated]"
      };
    }
    if (request.executable === "claude" && args === "auth status --json") {
      return { exitCode: 0, stdout: JSON.stringify(this.claudeStatus), stderr: "" };
    }
    if (request.executable === "agy") {
      if (args === "auth status") {
        if (this.agyBlocked) {
          return {
            exitCode: 1,
            stdout: JSON.stringify({ blocked: true, status: "blocked", reason: "Workspace policy restriction" }),
            stderr: this.agyStderr || "blocked by workspace policy"
          };
        }
        return { exitCode: this.authenticated ? 0 : 1, stdout: JSON.stringify(this.agyStatus), stderr: this.agyStderr };
      }
      if (args === "status --json") {
        if (this.agyBlocked) {
          return { exitCode: 0, stdout: JSON.stringify({ blocked: true, status: "blocked", reason: "Workspace policy restriction" }), stderr: "" };
        }
        return { exitCode: 0, stdout: JSON.stringify({ blocked: false, status: "ready" }), stderr: "" };
      }
    }
    if (args === "auth status") {
      return { exitCode: this.authenticated ? 0 : 1, stdout: "", stderr: "" };
    }

    return { exitCode: 0, stdout: "{}", stderr: "" };
  }
}

function createMockManager(
  repository: RepositoryIdentity,
  options?: {
    customUp?: () => Promise<SessionManifest>;
    partialStartRole?: string;
    startingRole?: string;
    onUpBeforeReturn?: () => void | Promise<void>;
  }
) {
  let current: SessionManifest | null = null;
  const create = (overrides?: Partial<SessionManifest>) =>
    SessionManifestSchema.parse({
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
      panes: roles.map((role, i) => {
        let transportState = "idle";
        const meta: Record<string, unknown> = {};
        if (options?.partialStartRole === role) {
          meta["partialStart"] = true;
          meta["startupStatus"] = "partial";
        }
        if (options?.startingRole === role) {
          transportState = "starting";
        }
        return {
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
          transportState,
          boundAt: now,
          metadata: meta
        };
      }),
      attachTarget: { role: "conversation", paneId: "w1:p0" },
      createdAt: now,
      updatedAt: now,
      ...overrides
    });

  const upFn = vi.fn(async () => {
    current = create();
    if (options?.onUpBeforeReturn) {
      await options.onUpBeforeReturn();
    }
    if (options?.customUp) {
      current = await options.customUp();
      return { ok: true as const, value: current };
    }
    return { ok: true as const, value: current };
  });

  const manager: SessionLifecycleManager = {
    init: vi.fn(async (m) => ({ ok: true as const, value: m })),
    up: upFn,
    down: vi.fn(async () => {
      const downManifest = create({ status: "down", stoppedAt: new Date().toISOString() });
      current = downManifest;
      return { ok: true as const, value: downManifest };
    }),
    getManifest: vi.fn(async () => ({ ok: true as const, value: current })),
    saveManifest: vi.fn(async (m) => {
      current = m;
      return { ok: true as const, value: m };
    }),
    focusConversation: vi.fn(async () => ({
      ok: true as const,
      value: { role: "conversation", paneId: "w1:p0" }
    })),
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

function createMockIntegration(
  repository: RepositoryIdentity,
  options?: {
    customUp?: () => Promise<SessionManifest>;
    partialStartRole?: string;
    startingRole?: string;
    onUpBeforeReturn?: () => void | Promise<void>;
  }
) {
  const mock = createMockManager(repository, options);
  const runtime = {
    findRuns: vi.fn(async () => ({ ok: true as const, value: { items: [], nextCursor: undefined } })),
    getRun: vi.fn(async () => ({ ok: true as const, value: null }))
  };
  const quiesce = vi.fn(async () => ({ ok: true as const, value: undefined }));
  return {
    ...mock,
    integration: {
      manager: mock.manager,
      runtime,
      quiesce
    }
  };
}

describe("Task 3: Full 11-Scenario Integration Test Suite & Platform v3 Lifecycle", () => {
  let dir: string;
  let runner: FakeLifecycleProcessRunner;
  let repository: RepositoryIdentity;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bflow-lifecycle-e2e-"));
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: dir });
    runner = new FakeLifecycleProcessRunner();
    repository = await identifyRepository(dir, runner);
    runner.currentSession = repository.sessionName;
    await mkdir(join(dir, ".bflow"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ==========================================
  // Scenario 1: Required Claude unavailable
  // ==========================================
  linuxDescribe("Scenario 1: Required Claude unavailable", () => {
    it("fails bflow up with actionable remediation, no Herdr server started, and bflow doctor reports fail", async () => {
      await writeFile(join(dir, ".bflow/config.yaml"), makeConfig(repository, "claude"));
      runner.missing.add("claude");
      const { integration, manager } = createMockIntegration(repository);

      // Human output
      const humanRes = await runCli(["up"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(humanRes.ok).toBe(false);
      expect(humanRes.exitCode).not.toBe(0);
      expect(humanRes.stderr).toContain("claude");
      expect(humanRes.stderr).toContain("Claude Code CLI");
      expect(humanRes.stderr).toContain("bflow doctor");
      // Verify no Herdr server started
      expect(runner.running.has(repository.sessionName)).toBe(false);
      expect(manager.up).not.toHaveBeenCalled();

      // JSON output
      const jsonRes = await runCli(["up", "--json"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(jsonRes.ok).toBe(false);
      expect(jsonRes.exitCode).not.toBe(0);
      const parsedJson = JSON.parse(jsonRes.stdout);
      expect(parsedJson.ok).toBe(false);
      expect(parsedJson.error.message).toContain("claude");
      expect(parsedJson.error.details?.component).toBe("provider:claude");
      expect(parsedJson.error.details?.remediation).toContain("bflow doctor");

      // Verify bflow doctor --json
      const doctorRes = await runCli(["doctor", "--json"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(doctorRes.exitCode).not.toBe(0);
      const doctorData = JSON.parse(doctorRes.stdout);
      expect(doctorData.data.healthy).toBe(false);
      const agentClaudeCheck = doctorData.data.metadata.groups.agent_providers.find(
        (c: any) => c.checkId === "agent-claude"
      );
      expect(agentClaudeCheck).toBeDefined();
      expect(agentClaudeCheck.status).toBe("fail");
      expect(agentClaudeCheck.component).toBe("claude");
      expect(agentClaudeCheck.remediation).toContain("Claude Code CLI");
    });
  });

  // ==========================================
  // Scenario 2: Required Codex unauthenticated
  // ==========================================
  linuxDescribe("Scenario 2: Required Codex unauthenticated", () => {
    it("fails bflow up with redacted secret, identifies provider:codex, instructs codex login, no server started", async () => {
      await writeFile(join(dir, ".bflow/config.yaml"), makeConfig(repository, "codex"));
      runner.authenticated = false;
      const { integration } = createMockIntegration(repository);

      // Human output
      const humanRes = await runCli(["up"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(humanRes.ok).toBe(false);
      expect(humanRes.exitCode).not.toBe(0);
      expect(humanRes.stderr).toContain("codex");
      expect(humanRes.stderr).toContain("codex login");
      // Check secret stderr redaction (no raw tokens leaked)
      expect(humanRes.stderr).not.toContain("token-unauthenticated");
      expect(runner.running.has(repository.sessionName)).toBe(false);

      // JSON output
      const jsonRes = await runCli(["up", "--json"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(jsonRes.ok).toBe(false);
      const parsed = JSON.parse(jsonRes.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.message).toContain("codex");
      expect(parsed.error.details?.component).toBe("provider:codex");
      expect(parsed.error.message).toContain("codex login");
    });
  });

  // ==========================================
  // Scenario 3: Required Agy blocked
  // ==========================================
  linuxDescribe("Scenario 3: Required Agy blocked", () => {
    it("fails when agy is blocked via providerOverrides", async () => {
      await writeFile(join(dir, ".bflow/config.yaml"), makeConfig(repository, "agy"));
      const { integration } = createMockIntegration(repository);

      const humanRes = await runCli(["up"], {
        cwd: dir,
        environment: {
          runner,
          integration,
          providerOverrides: {
            agy: {
              available: true,
              authenticated: true,
              blocked: true,
              blockedReason: "Workspace policy restriction"
            }
          }
        }
      });
      expect(humanRes.ok).toBe(false);
      expect(humanRes.stderr).toContain("agy");
      expect(humanRes.stderr).toContain("blocked");
      expect(humanRes.stderr).toContain("Workspace policy restriction");
      expect(humanRes.stderr).toContain("bflow agent check agy");
      expect(runner.running.has(repository.sessionName)).toBe(false);

      const jsonRes = await runCli(["up", "--json"], {
        cwd: dir,
        environment: {
          runner,
          integration,
          providerOverrides: {
            agy: {
              available: true,
              authenticated: true,
              blocked: true,
              blockedReason: "Workspace policy restriction"
            }
          }
        }
      });
      expect(jsonRes.ok).toBe(false);
      const parsed = JSON.parse(jsonRes.stdout);
      expect(parsed.error.details?.component).toBe("provider:agy");
      expect(parsed.error.details?.remediation).toContain("bflow agent check agy");
    });

    it("fails when agy is blocked via runner agy output", async () => {
      await writeFile(join(dir, ".bflow/config.yaml"), makeConfig(repository, "agy"));
      runner.agyBlocked = true;
      const { integration } = createMockIntegration(repository);

      const humanRes = await runCli(["up"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(humanRes.ok).toBe(false);
      expect(humanRes.stderr).toContain("agy");
      expect(humanRes.stderr).toContain("blocked");
      expect(runner.running.has(repository.sessionName)).toBe(false);
    });
  });

  // ==========================================
  // Scenario 4: Permission flags unsupported
  // ==========================================
  linuxDescribe("Scenario 4: Permission flags unsupported", () => {
    it("fails when unsupported permission flags are configured", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, "claude", {
          permissions: {
            mode: "workspace_auto",
            unsupportedFlags: ["--dangerously-skip-permissions"]
          }
        })
      );
      const { integration } = createMockIntegration(repository);

      const humanRes = await runCli(["up"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(humanRes.ok).toBe(false);
      expect(humanRes.stderr).toContain("Unsupported permission flags configured");
      expect(humanRes.stderr).toContain("--dangerously-skip-permissions");

      const jsonRes = await runCli(["up", "--json"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(jsonRes.ok).toBe(false);
      const parsed = JSON.parse(jsonRes.stdout);
      expect(parsed.error.details?.component).toBe("permissions");
      expect(parsed.error.message).toContain("Remove unsupported permission flags");
    });

    it("fails when unattended_isolated is configured without os_sandbox or container isolation", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, "claude", {
          permissions: {
            mode: "unattended_isolated"
          }
        })
      );
      const { integration } = createMockIntegration(repository);

      const jsonRes = await runCli(["up", "--json"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(jsonRes.ok).toBe(false);
      const parsed = JSON.parse(jsonRes.stdout);
      expect(parsed.error.details?.component).toBe("permissions");
      expect(parsed.error.message).toContain("'unattended_isolated' requires 'os_sandbox' or 'container'");
    });
  });

  // ==========================================
  // Scenario 5: MCP unavailable
  // ==========================================
  linuxDescribe("Scenario 5: MCP unavailable", () => {
    it("fails when required MCP service is unavailable", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, "claude", {
          requiredMcpServices: ["gitnexus"]
        })
      );
      const { integration } = createMockIntegration(repository);

      const mcpState: McpLifecycleState = {
        gatewayAvailable: true,
        services: {
          gitnexus: { status: "unavailable" }
        }
      };

      const humanRes = await runCli(["up"], {
        cwd: dir,
        environment: { runner, integration, mcpState }
      });
      expect(humanRes.ok).toBe(false);
      expect(humanRes.stderr).toContain("Required MCP service 'gitnexus' is unavailable");
      expect(humanRes.stderr).toContain("bflow mcp status");

      const jsonRes = await runCli(["up", "--json"], {
        cwd: dir,
        environment: { runner, integration, mcpState }
      });
      expect(jsonRes.ok).toBe(false);
      const parsed = JSON.parse(jsonRes.stdout);
      expect(parsed.error.details?.component).toBe("mcp:gitnexus");
    });

    it("fails when MCP Gateway service is unavailable", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, "claude", {
          requiredMcpServices: ["gitnexus"]
        })
      );
      const { integration } = createMockIntegration(repository);

      const mcpState: McpLifecycleState = {
        gatewayAvailable: false
      };

      const jsonRes = await runCli(["up", "--json"], {
        cwd: dir,
        environment: { runner, integration, mcpState }
      });
      expect(jsonRes.ok).toBe(false);
      const parsed = JSON.parse(jsonRes.stdout);
      expect(parsed.error.details?.component).toBe("mcp:gateway");
      expect(parsed.error.message).toContain("MCP Gateway service is unavailable");
    });
  });

  // ==========================================
  // Scenario 6: Skills missing
  // ==========================================
  linuxDescribe("Scenario 6: Skills missing", () => {
    it("fails when required skills are missing from catalog", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, "claude", {
          skills: {
            required: true,
            requiredSkills: ["using-bflow", "missing-skill-xyz"]
          }
        })
      );
      const { integration } = createMockIntegration(repository);

      const humanRes = await runCli(["up"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(humanRes.ok).toBe(false);
      expect(humanRes.stderr).toContain("Required skills are missing");
      expect(humanRes.stderr).toContain("bflow skills sync");

      const jsonRes = await runCli(["up", "--json"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(jsonRes.ok).toBe(false);
      const parsed = JSON.parse(jsonRes.stdout);
      expect(parsed.error.details?.component).toBe("skills");
      expect(parsed.error.message).toContain("bflow skills sync");
    });

    it("fails when skills directory does not exist", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, "claude", {
          skills: {
            catalogDir: "non-existent-skills-dir"
          }
        })
      );
      const { integration } = createMockIntegration(repository);

      const jsonRes = await runCli(["up", "--json"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(jsonRes.ok).toBe(false);
      const parsed = JSON.parse(jsonRes.stdout);
      expect(parsed.error.details?.component).toBe("skills");
      expect(parsed.error.message).toContain("catalog directory does not exist");
    });
  });

  // ==========================================
  // Scenario 7: Provider partially starts
  // ==========================================
  linuxDescribe("Scenario 7: Provider partially starts", () => {
    it("fails immediately on partialStart role and automatically stops the partial startup", async () => {
      await writeFile(join(dir, ".bflow/config.yaml"), makeConfig(repository, "claude"));
      const { integration } = createMockIntegration(repository, { partialStartRole: "reviewer" });

      const humanRes = await runCli(["up"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(humanRes.ok).toBe(false);
      expect(humanRes.exitCode).not.toBe(0);
      expect(humanRes.stderr).toContain("Agent provider for role 'reviewer' only partially started");
      expect(humanRes.stderr).toContain("bflow doctor");

      // The role error remains visible, but the repository-owned partial startup is stopped.
      const sessionPath = join(dir, ".bflow/state/session.json");
      expect(existsSync(sessionPath)).toBe(true);
      const savedManifest = JSON.parse(await readFile(sessionPath, "utf8"));
      expect(savedManifest.status).toBe("down");
      expect(savedManifest.status).not.toBe("up");
    });

    it("times out on role staying in starting state and automatically stops the partial startup", async () => {
      await writeFile(
        join(dir, ".bflow/config.yaml"),
        makeConfig(repository, "claude", { startupTimeoutMs: 1000 })
      );
      const { integration } = createMockIntegration(repository, { startingRole: "reviewer" });

      const humanRes = await runCli(["up"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(humanRes.ok).toBe(false);
      expect(humanRes.exitCode).not.toBe(0);

      // The startup timeout remains visible, and shutdown leaves a terminal manifest.
      const sessionPath = join(dir, ".bflow/state/session.json");
      expect(existsSync(sessionPath)).toBe(true);
      const savedManifest = JSON.parse(await readFile(sessionPath, "utf8"));
      expect(savedManifest.status).toBe("down");
      expect(savedManifest.status).not.toBe("up");
    });
  });

  // ==========================================
  // Scenario 8: Multiple repositories
  // ==========================================
  linuxDescribe("Scenario 8: Multiple repositories", () => {
    it("manages independent sessions and manifests across multiple repositories", async () => {
      const dirA = await mkdtemp(join(tmpdir(), "bflow-repo-a-"));
      const dirB = await mkdtemp(join(tmpdir(), "bflow-repo-b-"));
      try {
        execFileSync("git", ["init"], { cwd: dirA });
        execFileSync("git", ["init"], { cwd: dirB });

        const sharedRunner = new FakeLifecycleProcessRunner();
        const sharedMcpState: McpLifecycleState = {
          gatewayAvailable: true,
          activeRepositories: new Set<string>(),
          sessionRegistrations: new Map<string, string[]>()
        };

        const repoA = await identifyRepository(dirA, sharedRunner);
        const repoB = await identifyRepository(dirB, sharedRunner);

        await mkdir(join(dirA, ".bflow"), { recursive: true });
        await mkdir(join(dirB, ".bflow"), { recursive: true });
        await writeFile(join(dirA, ".bflow/config.yaml"), makeConfig(repoA, "claude"));
        await writeFile(join(dirB, ".bflow/config.yaml"), makeConfig(repoB, "codex"));

        const fixtureA = createMockIntegration(repoA);
        const fixtureB = createMockIntegration(repoB);

        const resA = await runCli(["up", "--json"], {
          cwd: dirA,
          environment: { runner: sharedRunner, integration: fixtureA.integration, mcpState: sharedMcpState }
        });
        expect(resA.ok).toBe(true);

        const resB = await runCli(["up", "--json"], {
          cwd: dirB,
          environment: { runner: sharedRunner, integration: fixtureB.integration, mcpState: sharedMcpState }
        });
        expect(resB.ok).toBe(true);

        // Both sessions running independently in runner
        expect(sharedRunner.running.has(repoA.sessionName)).toBe(true);
        expect(sharedRunner.running.has(repoB.sessionName)).toBe(true);
        expect(repoA.sessionName).not.toBe(repoB.sessionName);

        // Manifests isolated in distinct session.json files
        const manifestA = JSON.parse(await readFile(join(dirA, ".bflow/state/session.json"), "utf8"));
        const manifestB = JSON.parse(await readFile(join(dirB, ".bflow/state/session.json"), "utf8"));
        expect(manifestA.sessionId).toBe(repoA.sessionName);
        expect(manifestB.sessionId).toBe(repoB.sessionName);

        // Both registered in mcpState
        expect(sharedMcpState.activeRepositories?.has(repoA.id)).toBe(true);
        expect(sharedMcpState.activeRepositories?.has(repoB.id)).toBe(true);
        expect(sharedMcpState.sessionRegistrations?.has(repoA.sessionName)).toBe(true);
        expect(sharedMcpState.sessionRegistrations?.has(repoB.sessionName)).toBe(true);
      } finally {
        await rm(dirA, { recursive: true, force: true });
        await rm(dirB, { recursive: true, force: true });
      }
    });
  });

  // ==========================================
  // Scenario 9: Up interrupted
  // ==========================================
  linuxDescribe("Scenario 9: Up interrupted", () => {
    it("handles abort interruption safely, preserves files, and reconciles on retry", async () => {
      await writeFile(join(dir, ".bflow/config.yaml"), makeConfig(repository, "claude"));

      // Uncommitted workspace file
      await writeFile(join(dir, "scratch-work.txt"), "Important in-progress work");
      const configBefore = await readFile(join(dir, ".bflow/config.yaml"), "utf8");

      let shouldAbort = true;
      const abortController = new AbortController();
      const fixture = createMockIntegration(repository, {
        onUpBeforeReturn: () => {
          if (shouldAbort) {
            abortController.abort();
          }
        }
      });

      const interruptedRes = await runCli(["up"], {
        cwd: dir,
        operationOptions: { signal: abortController.signal },
        environment: { runner, integration: fixture.integration }
      });

      expect(interruptedRes.ok).toBe(false);
      expect(interruptedRes.exitCode).not.toBe(0);

      // Verify uncommitted file and config are intact
      expect(await readFile(join(dir, "scratch-work.txt"), "utf8")).toBe("Important in-progress work");
      expect(await readFile(join(dir, ".bflow/config.yaml"), "utf8")).toBe(configBefore);

      const serverStartsBefore = runner.serverStarts;

      // Second run: succeeds and reconciles
      shouldAbort = false;
      const secondRes = await runCli(["up"], {
        cwd: dir,
        environment: { runner, integration: fixture.integration }
      });

      expect(secondRes.ok).toBe(true);
      expect(secondRes.exitCode).toBe(0);
      // The failed attempt stopped its server, so retry starts a fresh repository session.
      expect(runner.serverStarts).toBe(serverStartsBefore + 1);
    });
  });

  // ==========================================
  // Scenario 10: Up repeated
  // ==========================================
  linuxDescribe("Scenario 10: Up repeated", () => {
    it("is idempotent: returns same sessionId, starts server once, calls manager.up once", async () => {
      await writeFile(join(dir, ".bflow/config.yaml"), makeConfig(repository, "claude"));
      const { integration, manager } = createMockIntegration(repository);

      const firstRes = await runCli(["up", "--json"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(firstRes.ok).toBe(true);
      expect(firstRes.exitCode).toBe(0);
      const firstData = JSON.parse(firstRes.stdout);
      const sessionId = firstData.data.sessionId;
      expect(sessionId).toBe(repository.sessionName);
      expect(runner.serverStarts).toBe(1);
      expect(manager.up).toHaveBeenCalledTimes(1);

      const secondRes = await runCli(["up", "--json"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(secondRes.ok).toBe(true);
      expect(secondRes.exitCode).toBe(0);
      const secondData = JSON.parse(secondRes.stdout);
      expect(secondData.data.sessionId).toBe(sessionId);

      // Verify server was not restarted and manager.up was not called again
      expect(runner.serverStarts).toBe(1);
      expect(manager.up).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================
  // Scenario 11: Down with another project still active
  // ==========================================
  linuxDescribe("Scenario 11: Down with another project still active", () => {
    it("tears down repoA while keeping repoB active and stopping only repoA-local MCP services", async () => {
      const dirA = await mkdtemp(join(tmpdir(), "bflow-down-a-"));
      const dirB = await mkdtemp(join(tmpdir(), "bflow-down-b-"));
      try {
        execFileSync("git", ["init"], { cwd: dirA });
        execFileSync("git", ["init"], { cwd: dirB });

        const sharedRunner = new FakeLifecycleProcessRunner();
        const sharedMcpState: McpLifecycleState = {
          gatewayAvailable: true,
          activeRepositories: new Set<string>(),
          sessionRegistrations: new Map<string, string[]>(),
          services: {
            gitnexus: { status: "ready", scope: "machine" },
            "claude-mem-adapter": { status: "ready" },
            "local-mcp-a": { status: "ready" }
          },
          stoppedServices: []
        };

        const repoA = await identifyRepository(dirA, sharedRunner);
        const repoB = await identifyRepository(dirB, sharedRunner);

        await mkdir(join(dirA, ".bflow"), { recursive: true });
        await mkdir(join(dirB, ".bflow"), { recursive: true });
        await writeFile(
          join(dirA, ".bflow/config.yaml"),
          makeConfig(repoA, "claude", {
            requiredMcpServices: ["gitnexus", "claude-mem-adapter", "local-mcp-a"]
          })
        );
        await writeFile(
          join(dirB, ".bflow/config.yaml"),
          makeConfig(repoB, "claude", {
            requiredMcpServices: ["gitnexus", "claude-mem-adapter"]
          })
        );

        const fixtureA = createMockIntegration(repoA);
        const fixtureB = createMockIntegration(repoB);

        // Bring both up
        await runCli(["up"], {
          cwd: dirA,
          environment: { runner: sharedRunner, integration: fixtureA.integration, mcpState: sharedMcpState }
        });
        await runCli(["up"], {
          cwd: dirB,
          environment: { runner: sharedRunner, integration: fixtureB.integration, mcpState: sharedMcpState }
        });

        expect(sharedRunner.running.has(repoA.sessionName)).toBe(true);
        expect(sharedRunner.running.has(repoB.sessionName)).toBe(true);

        // Bring down repoA
        const downRes = await runCli(["down", "--yes"], {
          cwd: dirA,
          environment: { runner: sharedRunner, integration: fixtureA.integration, mcpState: sharedMcpState }
        });
        expect(downRes.ok).toBe(true);

        // repoA is stopped and deregistered
        expect(sharedRunner.running.has(repoA.sessionName)).toBe(false);
        expect(sharedMcpState.activeRepositories?.has(repoA.id)).toBe(false);
        expect(sharedMcpState.sessionRegistrations?.has(repoA.sessionName)).toBe(false);

        // repoB is STILL running and registered
        expect(sharedRunner.running.has(repoB.sessionName)).toBe(true);
        expect(sharedMcpState.activeRepositories?.has(repoB.id)).toBe(true);
        expect(sharedMcpState.sessionRegistrations?.has(repoB.sessionName)).toBe(true);

        // Shared/machine MCP services were NOT stopped
        expect(sharedMcpState.stoppedServices).not.toContain("gitnexus");
        expect(sharedMcpState.stoppedServices).not.toContain("claude-mem-adapter");

        // local-mcp-a WAS stopped
        expect(sharedMcpState.stoppedServices).toContain("local-mcp-a");
      } finally {
        await rm(dirA, { recursive: true, force: true });
        await rm(dirB, { recursive: true, force: true });
      }
    });
  });

  // ==========================================
  // Scenario 12: 5-Group bflow doctor & bflow setup End-to-End Verification
  // ==========================================
  describe("Scenario 12: 5-Group bflow doctor & bflow setup End-to-End Verification", () => {
    it("doctor report contains all 5 groups and all check items have required fields", async () => {
      await writeFile(join(dir, ".bflow/config.yaml"), makeConfig(repository, "claude"));
      const { integration } = createMockIntegration(repository);

      // JSON output verification
      const doctorJsonRes = await runCli(["doctor", "--json"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(doctorJsonRes.ok).toBe(true);
      const parsed = JSON.parse(doctorJsonRes.stdout);
      expect(parsed.data).toBeDefined();
      const groups = parsed.data.metadata.groups;
      expect(groups.runtime).toBeDefined();
      expect(groups.agent_providers).toBeDefined();
      expect(groups.mcp).toBeDefined();
      expect(groups.tools).toBeDefined();
      expect(groups.skills).toBeDefined();

      // Verify every check item in every group has required schema fields
      for (const groupName of ["runtime", "agent_providers", "mcp", "tools", "skills"] as const) {
        const checkList = groups[groupName];
        expect(Array.isArray(checkList)).toBe(true);
        expect(checkList.length).toBeGreaterThan(0);
        for (const check of checkList) {
          expect(typeof check.checkId).toBe("string");
          expect(check.group).toBe(groupName);
          expect(typeof check.component).toBe("string");
          expect(["pass", "warning", "fail", "skipped"]).toContain(check.status);
          expect(check.detected_version === null || typeof check.detected_version === "string").toBe(true);
          expect(typeof check.reason).toBe("string");
          expect(typeof check.remediation).toBe("string");
          if (check.repair_command !== undefined) {
            expect(typeof check.repair_command).toBe("string");
          }
        }
      }

      // Verify bflow-global-config is in runtime group
      const globalConfigCheck = groups.runtime.find((c: any) => c.checkId === "bflow-global-config");
      expect(globalConfigCheck).toBeDefined();
      expect(globalConfigCheck.component).toBe("global-config");
      expect(globalConfigCheck.status).toBe("pass");
      expect(globalConfigCheck.detected_version).toBe("3");

      // Human output verification
      const doctorHumanRes = await runCli(["doctor"], {
        cwd: dir,
        environment: { runner, integration }
      });
      expect(doctorHumanRes.ok).toBe(true);
      expect(doctorHumanRes.stdout).toContain("Component Groups:");
      expect(doctorHumanRes.stdout).toContain("[runtime]");
      expect(doctorHumanRes.stdout).toContain("[agent_providers]");
      expect(doctorHumanRes.stdout).toContain("[mcp]");
      expect(doctorHumanRes.stdout).toContain("[tools]");
      expect(doctorHumanRes.stdout).toContain("[skills]");
    });

    it("verifies bflow setup in all modes (--check, --dry-run, --apply --yes, --repair --yes)", async () => {
      const mockPlan = {
        schemaVersion: 3 as const,
        planId: "integration-plan",
        machineId: "m-test",
        revision: 1,
        planDigest: "d".repeat(64),
        createdAt: new Date().toISOString(),
        idempotencyKey: "idem-test",
        steps: [{ stepId: "test:step", name: "Test Step", component: "tools", requiresApproval: true }]
      };
      const mockReceipt = {
        schemaVersion: 3 as const,
        receiptId: "receipt-integration-test",
        planId: "integration-plan",
        planDigest: "d".repeat(64),
        machineId: "m-test",
        stepIds: ["test:step"],
        approvedBy: "cli-operator",
        approvedAt: new Date().toISOString()
      };

      const customMachineSetup = {
        plan: vi.fn().mockImplementation(async (opts: any) => ({
          plan: mockPlan,
          tools: [{ toolId: "rtk", status: "ready", version: "1.0.0" }],
          diagnostics: [`Plan mode: ${opts.mode}`]
        })),
        apply: vi.fn().mockImplementation(async (opts: any) => ({
          receipt: mockReceipt,
          tools: [{ toolId: "rtk", status: "ready", version: "1.0.0" }],
          diagnostics: [`Apply mode: ${opts.mode}`]
        }))
      };

      // 1. --check
      const checkRes = await runCli(["setup", "--check", "--json"], {
        cwd: dir,
        setup: { isolatedRoot: dir, machineSetup: customMachineSetup }
      });
      expect(checkRes.ok).toBe(true);
      const checkData = JSON.parse(checkRes.stdout);
      expect(checkData.data.mode).toBe("check");
      expect(checkData.data.plan.planId).toBe("integration-plan");

      // 2. --dry-run
      const dryRes = await runCli(["setup", "--dry-run", "--json"], {
        cwd: dir,
        setup: { isolatedRoot: dir, machineSetup: customMachineSetup }
      });
      expect(dryRes.ok).toBe(true);
      const dryData = JSON.parse(dryRes.stdout);
      expect(dryData.data.mode).toBe("dry_run");

      // 3. --apply --yes
      const applyRes = await runCli(["setup", "--apply", "--yes", "--json"], {
        cwd: dir,
        setup: { isolatedRoot: dir, machineSetup: customMachineSetup }
      });
      expect(applyRes.ok).toBe(true);
      const applyData = JSON.parse(applyRes.stdout);
      expect(applyData.data.mode).toBe("apply");
      expect(applyData.data.receipt?.receiptId).toBe("receipt-integration-test");

      // 4. --repair --yes
      const repairRes = await runCli(["setup", "--repair", "--yes", "--json"], {
        cwd: dir,
        setup: { isolatedRoot: dir, machineSetup: customMachineSetup }
      });
      expect(repairRes.ok).toBe(true);
      const repairData = JSON.parse(repairRes.stdout);
      expect(repairData.data.mode).toBe("repair");
    });
  });
});
