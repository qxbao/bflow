import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionManifestSchema, type SessionLifecycleManager, type SessionManifest, type RuntimeService,
  type RecoveryCheckpoint, type WorkflowRunSnapshot, type CreateCheckpointCommand
} from "@bflow/contracts";
import { EnvironmentConfigSchema, EnvironmentError, EnvironmentLifecycle, identifyRepository, main, namedSessionEnvironment, parseCliArgs, parseConfigYaml,
  readEnvironmentConfig, renderEnvironmentConfigYaml, runCli, environmentProcessRunner, formatCommandError, type EnvironmentProcessRequest, type EnvironmentProcessRunner } from "../src/index.js";
import { PaneManagerLifecycleAdapter, openPaneManagerEnvironment } from "../src/pane-manager-integration.js";
import type { LifecycleHost } from "../src/agentic-host.js";

const now = "2026-10-16T00:00:00.000Z";
const linuxIt = it.skipIf(process.platform !== "linux");
const roles = ["conversation", "coordinator", "planner", "architect", "specifier", "reviewer", "qa"] as const;
const activeRun: WorkflowRunSnapshot = { runId: "active-run", workflowId: "workflow", workflowVersion: "1", status: "running", tasks: [], createdAt: now, updatedAt: now, version: 2, lastEventSequence: 2 };
function checkpoint(command: CreateCheckpointCommand): RecoveryCheckpoint {
  return { checkpointSchemaVersion: 1, codec: { name: "bflow.workflow-aggregate+json", version: 1 }, checkpointId: command.checkpointId,
    runId: command.runId, version: 2, eventSequence: 2, createdAt: now,
    state: { schemaVersion: 1, snapshot: { ...activeRun }, approvals: [], gateRequests: [], gateOutcomes: [], successfulAttempts: [], cancellations: [], retrySchedules: [], attemptBaselines: [], commands: [] } };
}

class FakeProcesses implements EnvironmentProcessRunner {
  readonly requests: EnvironmentProcessRequest[] = [];
  readonly running = new Set<string>();
  serverFails = false;
  authenticated = true;
  claudeStatus: unknown = { loggedIn: true };
  missing = new Set<string>();
  authCommands: string[] = [];
  async run(request: EnvironmentProcessRequest) {
    this.requests.push(request);
    if (request.executable === "git") return environmentProcessRunner.run(request);
    if (this.missing.has(request.executable)) throw new Error(`ENOENT ${request.executable}`);
    const session = request.env?.["HERDR_SESSION"] ?? "incorrect-default";
    const args = request.args.join(" ");
    if (args === "login status" || args === "auth status --json" || args === "auth status") this.authCommands.push(`${request.executable} ${args}`);
    if (args === "login status") return { exitCode: this.authenticated ? 0 : 1, stdout: "", stderr: this.authenticated ? "Logged in" : "secret-account-information" };
    if (args === "auth status --json") return { exitCode: 0, stdout: JSON.stringify(this.claudeStatus), stderr: "" };
    if (args === "auth status") return { exitCode: this.authenticated ? 0 : 1, stdout: "", stderr: "" };
    let value: unknown = {};
    if (args === "--help") return { exitCode: 0, stdout: "herdr --session NAME; Run as headless server", stderr: "" };
    if (args === "api schema --json") value = { protocol: 22, schema_version: 1 };
    if (args === "status server --json") value = { running: this.running.has(session), session, protocol: 22, compatible: true };
    if (args === "server") {
      if (this.serverFails) return { exitCode: 1, stdout: "", stderr: "cannot bind server" };
      this.running.add(session);
    }
    if (request.args[0] === "session" && request.args[1] === "stop") this.running.delete(request.args[2]!);
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
  }
}
function mockManager(repository: Awaited<ReturnType<typeof identifyRepository>>) {
  let current: SessionManifest | null = null;
  const create = () => SessionManifestSchema.parse({ schemaVersion: 2, sessionId: repository.sessionName, projectName: "repo", workspaceRoot: repository.root,
    herdrWorkspaceId: "w1", herdrTabId: "w1:t1", status: "up", conversationSessionId: "conversation-1", activeRunIds: [], metadata: { panePresentationVersion: 1 },
    panes: roles.map((role, i) => ({ schemaVersion: 2, bindingId: `binding-${i}`, sessionId: repository.sessionName, role, agentId: `agent-${i}`,
      workspaceId: "w1", tabId: "w1:t1", paneId: `w1:p${i}`, provider: "openai", agentKind: "codex", cwd: repository.root,
      isolationMode: "dedicated_pane", readOnlyWorkspace: role === "conversation", transportState: "idle", boundAt: now })),
    attachTarget: { role: "conversation", paneId: "w1:p0" }, createdAt: now, updatedAt: now });
  const manager: SessionLifecycleManager = {
    init: vi.fn(async (manifest) => ({ ok: true, value: manifest })),
    up: vi.fn(async () => { current = create(); return { ok: true, value: current }; }),
    down: vi.fn(async () => { current = { ...current!, status: "down" }; return { ok: true, value: current }; }),
    attach: vi.fn(async () => ({ ok: true, value: current!.panes[0]! })),
    getManifest: vi.fn(async () => ({ ok: true, value: current })),
    doctorSession: vi.fn(async () => ({ schemaVersion: 2, workspaceRoot: repository.root, sessionId: repository.sessionName, healthy: true,
      checks: [{ checkId: "panes", name: "panes", status: "passed", message: "test fixture" }], checkedAt: now }))
  };
  return { manager, create, set: (manifest: SessionManifest) => { current = manifest; }, get: () => current! };
}
function mockRuntime(runs: WorkflowRunSnapshot[] = []): RuntimeService {
  return {
    start: vi.fn(), resume: vi.fn(), cancel: vi.fn(), decide: vi.fn(), watch: vi.fn(),
    findRuns: vi.fn(async () => ({ ok: true, value: { items: runs } })),
    getRun: vi.fn(async (id) => ({ ok: true, value: runs.find((r) => r.runId === id) ?? null }))
  };
}

describe("P12 repository environment lifecycle", () => {
  let dir: string;
  let runner: FakeProcesses;
  let fixture: ReturnType<typeof mockManager>;
  let repository: Awaited<ReturnType<typeof identifyRepository>>;
  let lifecycle: EnvironmentLifecycle;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bflow-p12-test-"));
    execFileSync("git", ["init", "--quiet", dir]);
    expect((await runCli(["init"], { cwd: dir })).ok).toBe(true);
    repository = await identifyRepository(dir);
    runner = new FakeProcesses(); fixture = mockManager(repository);
    lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime(), quiesce: async () => ({ ok: true, value: undefined }) } });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("rejects non-Git init without creating configuration", async () => {
    const other = await mkdtemp(join(tmpdir(), "bflow-p12-nongit-"));
    try {
      const result = await runCli(["init"], { cwd: other });
      expect(result.ok).toBe(false); expect(result.stderr).toContain("Not a Git");
      await expect(readFile(join(other, ".bflow/config.yml"))).rejects.toThrow();
    } finally { await rm(other, { recursive: true, force: true }); }
  });
  it("defaults verification.regressionScope to affected", async () => {
    const raw = parseConfigYaml(await readFile(join(dir, ".bflow/config.yml"), "utf8")) as { environment: { verification: { regressionScope?: unknown } } };
    expect(raw.environment.verification.regressionScope).toBe("affected");
    const loaded = await readEnvironmentConfig(repository);
    expect(loaded.environment.verification.regressionScope).toBe("affected");
  });
  it("reads legacy config without regressionScope as affected", async () => {
    const path = join(dir, ".bflow/config.yml");
    const raw = parseConfigYaml(await readFile(path, "utf8")) as Record<string, unknown>;
    const env = raw["environment"] as Record<string, unknown>;
    env["verification"] = { maxIterations: 3, onExhausted: "require_human" };
    await writeFile(path, renderEnvironmentConfigYaml(raw));
    const loaded = await readEnvironmentConfig(repository);
    expect(loaded.environment.verification.regressionScope).toBe("affected");
  });
  it("rejects unknown regressionScope", async () => {
    const path = join(dir, ".bflow/config.yml");
    const raw = parseConfigYaml(await readFile(path, "utf8")) as Record<string, unknown>;
    const env = raw["environment"] as Record<string, unknown>;
    env["verification"] = { maxIterations: 3, onExhausted: "require_human", regressionScope: "some" };
    await writeFile(path, renderEnvironmentConfigYaml(raw));
    await expect(readEnvironmentConfig(repository)).rejects.toThrow("Invalid SDLC policies, concurrency or timeouts");
  });
  // EnvironmentLifecycle uses the production Linux flock repository guard.
  linuxIt("fails startup before launching Herdr when provider is not authenticated and redacts auth diagnostics", async () => {
    runner.authenticated = false;
    await expect(lifecycle.up()).rejects.toThrow("not authenticated");
    expect(runner.requests.some(request => request.args[0] === "server")).toBe(false);
    expect(fixture.manager.up).not.toHaveBeenCalled();
    const report = await lifecycle.doctor();
    expect(report.healthy).toBe(false);
    expect(report.checks.find(check => check.checkId === "auth-codex")?.status).toBe("failed");
    expect(JSON.stringify(report)).not.toContain("secret-account-information");
  });

  linuxIt("defers authentication for a selected profile role while retaining binary checks", async () => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    config.environment.roles = config.environment.roles.map(role => ({
      ...role,
      required: role.role === "conversation" || role.role === "coordinator",
      ...(role.role === "conversation" || role.role === "coordinator" ? { "profile-name": "work" } : {})
    }));
    await writeFile(path, renderEnvironmentConfigYaml(config));
    runner.authenticated = false;
    const profileLifecycle = new EnvironmentLifecycle(dir, {
      runner, integration: { manager: fixture.manager, runtime: mockRuntime(), quiesce: async () => ({ ok: true, value: undefined }) },
      providerOverrides: { codex: { available: true, authenticated: false } }
    });

    expect((await profileLifecycle.up()).status).toBe("up");
    expect(runner.requests.some(request => ["codex", "claude", "agy"].includes(request.executable))).toBe(false);
    expect(runner.authCommands).toEqual([]);
  });

  linuxIt("keeps native authentication checks when selected and unselected roles share a provider", async () => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    config.environment.roles = config.environment.roles.map(role => ({
      ...role,
      required: role.role === "conversation" || role.role === "coordinator" || role.role === "planner",
      ...(role.role === "conversation" || role.role === "coordinator" ? { "profile-name": "work" } : {})
    }));
    await writeFile(path, renderEnvironmentConfigYaml(config));
    runner.authenticated = false;
    const profileLifecycle = new EnvironmentLifecycle(dir, {
      runner, env: { PATH: "" },
      providerOverrides: { codex: { available: true } },
      integration: { manager: fixture.manager, runtime: mockRuntime(), quiesce: async () => ({ ok: true, value: undefined }) }
    });

    await expect(profileLifecycle.up()).rejects.toThrow("not authenticated");
    expect(runner.authCommands).toEqual(["codex login status"]);
  });

  linuxIt("resolves profile selection after provider fallback and honors that provider default", async () => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    config.environment.allowProviderFallback = true;
    config.environment.defaults = { claude: { "profile-name": "fallback-profile" } };
    config.environment.roles = config.environment.roles.map(role =>
      role.role === "conversation" || role.role === "coordinator"
        ? { ...role, required: true, fallbackCli: "claude" }
        : { ...role, required: false });
    await writeFile(path, renderEnvironmentConfigYaml(config));
    runner.authenticated = false;
    const fallbackLifecycle = new EnvironmentLifecycle(dir, {
      runner, integration: { manager: fixture.manager, runtime: mockRuntime(), quiesce: async () => ({ ok: true, value: undefined }) },
      providerOverrides: { codex: { available: false }, claude: { available: true, authenticated: false } }
    });

    expect((await fallbackLifecycle.up()).status).toBe("up");
    expect(runner.requests.some(request => ["codex", "claude", "agy"].includes(request.executable))).toBe(false);
    expect(runner.authCommands).toEqual([]);
  });

  linuxIt("checks fallback provider presence after applying the fallback profile default", async () => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    config.environment.allowProviderFallback = true;
    config.environment.defaults = { claude: { "profile-name": "fallback-profile" } };
    config.environment.roles = config.environment.roles.map(role =>
      role.role === "conversation" || role.role === "coordinator"
        ? { ...role, required: true, fallbackCli: "claude" }
        : { ...role, required: false });
    await writeFile(path, renderEnvironmentConfigYaml(config));
    const fallbackLifecycle = new EnvironmentLifecycle(dir, {
      runner, integration: { manager: fixture.manager, runtime: mockRuntime(), quiesce: async () => ({ ok: true, value: undefined }) },
      providerOverrides: { codex: { available: false }, claude: { available: false } }
    });

    await expect(fallbackLifecycle.up()).rejects.toThrow("Missing fallback agent provider executable 'claude'");
    expect(fixture.manager.up).not.toHaveBeenCalled();
  });
  linuxIt("does not shut down a healthy preexisting session when startup validation fails before mutation", async () => {
    await lifecycle.up();
    const invalid = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager },
      providerOverrides: { codex: { authenticated: false } } });
    await expect(invalid.up()).rejects.toThrow("not authenticated");
    expect(fixture.manager.down).not.toHaveBeenCalled();
    expect(runner.running.has(repository.sessionName)).toBe(true);
  });
  linuxIt("does not require a dynamic Developer template to have a permanent startup pane", async () => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    expect(config.environment.roles.find(role => role.role === "developer")).toMatchObject({ cli: "codex", required: false });
    await writeFile(path, renderEnvironmentConfigYaml(config));
    const manifest = await lifecycle.up();
    expect(manifest.status).toBe("up");
    expect(manifest.panes.some(pane => pane.role === "developer")).toBe(false);
  });
  linuxIt("reconciles manager_pending only with an existing validated physical manifest", async () => {
    await lifecycle.up();
    // Health can mark an incomplete but idle topology up; the pending receipt
    // still requires P13 reconciliation to create the remaining role panes.
    fixture.set({ ...fixture.get(), status: "up" });
    await writeFile(join(dir, ".bflow/state/operation.json"), JSON.stringify({ repositoryId: repository.id, sessionName: repository.sessionName, phase: "manager_pending" }));
    const recovered = await lifecycle.up();
    expect(recovered.status).toBe("up");
    expect(fixture.manager.up).toHaveBeenCalledTimes(2);
    expect(runner.requests.filter(request => request.args[0] === "server")).toHaveLength(1);
  });
  linuxIt("cleans an owned partial startup on retry when its pane receipt is recoverable", async () => {
    await mkdir(join(dir, ".bflow/state"), { recursive: true });
    await writeFile(join(dir, ".bflow/state/operation.json"), JSON.stringify({ repositoryId: repository.id, sessionName: repository.sessionName, phase: "manager_pending" }));
    fixture.set({ ...fixture.create(), status: "degraded" });
    await writeFile(join(dir, ".bflow/state/session.json"), JSON.stringify(fixture.get()));
    runner.running.add(repository.sessionName);
    vi.mocked(fixture.manager.up).mockImplementation(async () => { throw new Error("retried role startup failed"); });
    await expect(lifecycle.up()).rejects.toThrow(/retried role startup failed\nAutomatic cleanup completed successfully\./);
    expect(runner.running.has(repository.sessionName)).toBe(false);
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("down");
    expect(fixture.manager.up).toHaveBeenCalledOnce();
  });
  linuxIt("can shut down a failed first startup using the manager's durable topology receipt", async () => {
    runner.running.add("other-repository");
    vi.mocked(fixture.manager.up).mockImplementation(async () => {
      fixture.set({ ...fixture.create(), status: "degraded" });
      throw new Error("role blocked after receipt persisted");
    });
    await expect(lifecycle.up()).rejects.toThrow("role blocked");
    expect(fixture.manager.down).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("down");
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/session.json"), "utf8")).status).toBe("down");
    expect(runner.running.has(repository.sessionName)).toBe(false);
    expect(runner.running.has("other-repository")).toBe(true);
  });
  linuxIt("prepares Agy readiness before starting a new Herdr server", async () => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    config.environment.roles = config.environment.roles.map(role => ({ ...role, cli: "agy" }));
    await writeFile(path, renderEnvironmentConfigYaml(config));
    const original = runner.run.bind(runner);
    vi.spyOn(runner, "run").mockImplementation(async request => request.executable !== "agy" ? original(request) :
      (runner.requests.push(request), request.args.join(" ") === "models"
        ? { exitCode: 0, stdout: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n", stderr: "Fetching available models..." }
        : request.args.join(" ") === "--version" ? { exitCode: 0, stdout: "agy 1.4.2", stderr: "" }
        : { exitCode: 2, stdout: "", stderr: `Error: unexpected argument "${request.args[0]}".` }));
    const prepareRoles = vi.fn(async () => { throw new Error("host readiness sentinel"); });
    const quiesce = vi.fn(async () => ({ ok: true, value: undefined }));
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, prepareRoles,
      runtime: mockRuntime([activeRun]), quiesce } });
    await expect(composed.up()).rejects.toThrow("host readiness sentinel");
    expect(prepareRoles).toHaveBeenCalledOnce();
    expect(fixture.manager.up).not.toHaveBeenCalled();
    expect(runner.requests.some(request => request.args[0] === "server")).toBe(false);
    expect(fixture.manager.down).not.toHaveBeenCalled();
    expect(quiesce).not.toHaveBeenCalled();
    await expect(readFile(join(dir, ".bflow/state/operation.json"))).rejects.toThrow();
    const report = await composed.doctor();
    expect(report.checks.find(check => check.checkId === "auth-agy")?.status).toBe("passed");
    const requests = runner.requests.filter(request => request.executable === "agy");
    expect(requests.filter(request => request.args.join(" ") === "models")).toHaveLength(2);
    expect(requests.some(request => request.args[0] === "auth" || request.args[0] === "status")).toBe(false);
  });
  linuxIt("preserves a saved manifest and active run when offline provider preparation fails", async () => {
    const saved = fixture.create(); saved.activeRunIds = [activeRun.runId];
    await mkdir(join(dir, ".bflow/state"), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, ".bflow/state/session.json"), JSON.stringify(saved));
    const before = await readFile(join(dir, ".bflow/state/session.json"), "utf8");
    const prepareRoles = vi.fn(async () => { throw new Error("Agy native capability unavailable"); });
    const quiesce = vi.fn(async () => ({ ok: true, value: undefined }));
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, prepareRoles,
      runtime: mockRuntime([activeRun]), quiesce } });

    await expect(composed.up()).rejects.toThrow("Agy native capability unavailable");

    expect(runner.requests.some(request => request.args[0] === "server")).toBe(false);
    expect(fixture.manager.up).not.toHaveBeenCalled();
    expect(fixture.manager.down).not.toHaveBeenCalled();
    expect(quiesce).not.toHaveBeenCalled();
    expect(await readFile(join(dir, ".bflow/state/session.json"), "utf8")).toBe(before);
    await expect(readFile(join(dir, ".bflow/state/operation.json"))).rejects.toThrow();
  });
  linuxIt("prepares provider roles before starting Herdr on a new session", async () => {
    const order: string[] = [];
    const prepareRoles = vi.fn(async () => { order.push("prepare"); });
    const original = runner.run.bind(runner);
    vi.spyOn(runner, "run").mockImplementation(async request => {
      if (request.executable === "herdr" && request.args[0] === "server") order.push("server");
      return original(request);
    });
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, prepareRoles, runtime: mockRuntime() } });

    const result = await composed.up();

    expect(result.status).toBe("up");
    expect(prepareRoles).toHaveBeenCalledOnce();
    expect(fixture.manager.up).toHaveBeenCalledOnce();
    expect(order).toEqual(["prepare", "server"]);
  });
  linuxIt.each([
    ["mixed model list and policy denial", 0, "gemini-3.8-flash-high\tGemini 3.8 Flash\n", "blocked by workspace policy", "agent provider 'agy' is blocked"],
    ["mixed model list and auth denial", 0, "gemini-3.8-flash-high\tGemini 3.8 Flash\n", "not logged in", "not authenticated"],
    ["network failure", 1, "", "connection refused token=private-sentinel", "access check failed"],
    ["explicit authentication failure", 1, "", "not logged in token=private-sentinel", "not authenticated"],
    ["policy block", 1, JSON.stringify({ status: "blocked", reason: "Workspace policy restriction" }), "", "blocked"],
    ["explicit JSON rejection", 0, JSON.stringify({ authenticated: false }), "", "not authenticated"],
    ["empty output", 0, "", "", "access check failed"],
    ["incomplete output", 0, "Fetching available models...", "", "access check failed"]
  ])("does not treat Agy %s as successful access", async (_label, exitCode, stdout, stderr, expected) => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    config.environment.roles = config.environment.roles.map(role => ({ ...role, cli: "agy" }));
    await writeFile(path, renderEnvironmentConfigYaml(config));
    const original = runner.run.bind(runner);
    vi.spyOn(runner, "run").mockImplementation(async request => request.executable === "agy" && request.args[0] !== "--version"
      ? { exitCode, stdout, stderr } : original(request));
    const result = await runCli(["up"], { cwd: dir, environment: { runner, integration: { manager: fixture.manager } } });
    expect(result.ok).toBe(false);
    expect(result.stderr.toLowerCase()).toContain(expected);
    expect(result.stderr).not.toContain("private-sentinel");
    expect(result.stderr).not.toContain("agy auth login");
    expect(result.stderr).not.toContain("claude auth login");
    expect(result.stderr).not.toContain("codex login");
    const report = await lifecycle.doctor();
    expect(report.checks.find(check => check.checkId === "auth-agy")?.status).toBe("failed");
    expect(JSON.stringify(report)).not.toContain("private-sentinel");
    expect(fixture.manager.up).not.toHaveBeenCalled();
    expect(runner.requests.some(request => request.args[0] === "server")).toBe(false);
  });
  linuxIt("requires an authenticated Claude status payload rather than accepting exit zero alone", async () => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    config.environment.roles = config.environment.roles.map(role => ({ ...role, cli: "claude" }));
    await writeFile(path, renderEnvironmentConfigYaml(config));
    runner.claudeStatus = { loggedIn: false, email: "private-account@example.test" };
    await expect(lifecycle.up()).rejects.toThrow("not authenticated");
    expect(fixture.manager.up).not.toHaveBeenCalled();
    const report = await lifecycle.doctor();
    expect(report.checks.find(check => check.checkId === "auth-claude")?.status).toBe("failed");
    expect(JSON.stringify(report)).not.toContain("private-account@example.test");
  });
  linuxIt("activates the real host only after roles are ready and does not report ready when host startup fails", async () => {
    const activate = vi.fn(async () => { throw new Error("host startup failed"); });
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime(),
      quiesce: async () => ({ ok: true, value: undefined }), activate } });
    await expect(composed.up()).rejects.toThrow("host startup failed");
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ status: "up" }), expect.any(Object));
    expect(fixture.manager.down).toHaveBeenCalledTimes(1);
    expect(runner.running.has(repository.sessionName)).toBe(false);
  });
  linuxIt("prints the cleanup outcome on its own line while retaining the typed startup error", async () => {
    const message = "agent start timeout must be greater than 3000ms and at most 300000ms";
    const original = new EnvironmentError({ code: "transport_unavailable", retryable: true, message, details: { role: "conversation" } });
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime(),
      quiesce: async () => ({ ok: true, value: undefined }), activate: async () => { throw original; } } });
    const failure = await composed.up().catch(error => error);
    expect(failure).toBeInstanceOf(EnvironmentError);
    if (!(failure instanceof EnvironmentError)) throw failure;
    expect(failure.contractError).toMatchObject({ code: "transport_unavailable", details: { role: "conversation" } });
    expect(failure.message).toBe(message + "\nAutomatic cleanup completed successfully.");
    const human = formatCommandError(failure.contractError, "up", false).split("\n");
    expect(human[0]).toBe("Error [transport_unavailable]: " + message);
    expect(human[1]).toBe("Automatic cleanup completed successfully.");
    const json = JSON.parse(formatCommandError(failure.contractError, "up", true));
    expect(json.error.message).toBe(failure.message);
    expect(original.message).toBe(message);
  });
  linuxIt("preserves the composed host without creating Herdr when readiness preflight blocks startup", async () => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    const input = { repository, config, env: process.env };
    const host: LifecycleHost = {
      prepare: vi.fn(async () => ({ roleLaunch: {}, platform: { ready: false, generation: 1, checkedAt: now, roles: [
        { role: "coordinator", provider: "codex", required: true, status: "blocked", message: "missing provider authentication",
          checks: [{ check: "authentication", status: "failed", code: "auth_missing", message: "provider login missing", remediation: "login" }] }
      ] } })),
      activate: vi.fn(async () => ({ ok: true as const, value: undefined })),
      runtime: mockRuntime(),
      quiesce: vi.fn(async () => ({ ok: true as const, value: undefined })),
      checkpoint: vi.fn(), shutdown: vi.fn(async () => {}), close: vi.fn(async () => {})
    };
    const composed = new EnvironmentLifecycle(dir, { runner, openIntegration: async () =>
      openPaneManagerEnvironment(input, runner, async () => host) });
    await expect(composed.up()).rejects.toThrow(/Provider readiness is not satisfied.*missing provider authentication/s);
    expect(host.prepare).toHaveBeenCalledOnce();
    expect(host.shutdown).not.toHaveBeenCalled();
    expect(host.quiesce).not.toHaveBeenCalled();
    expect(runner.requests.some(request => request.args[0] === "server")).toBe(false);
    expect(fixture.manager.up).not.toHaveBeenCalled();
    expect(runner.running.has(repository.sessionName)).toBe(false);
  });
  linuxIt("waits for authenticated native startup receipts without resending role startup", async () => {
    const activate = vi.fn(async () => undefined).mockRejectedValueOnce(new EnvironmentError({ code: "conflict", retryable: true,
      message: "Native hook is still publishing its receipt", details: { stage: "native_startup" } }));
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime(),
      quiesce: async () => ({ ok: true, value: undefined }), activate } });
    expect((await composed.up()).status).toBe("up");
    expect(activate).toHaveBeenCalledTimes(2); expect(fixture.manager.up).toHaveBeenCalledTimes(1);
    expect(runner.requests.filter(r => r.args[0] === "server")).toHaveLength(1);
  });
  linuxIt("deduplicates native and transport waits independently while both remain pending", async () => {
    const observations: string[] = [];
    const manifest = SessionManifestSchema.parse({ ...fixture.create(), status: "initializing", panes: fixture.create().panes.map(pane => ({ ...pane, permanent: true, transportState: "starting" })) });
    fixture.set(manifest);
    vi.mocked(fixture.manager.up).mockResolvedValue({ ok: true, value: manifest });
    let polls = 0;
    vi.mocked(fixture.manager.getManifest).mockImplementation(async () => {
      if (++polls > 2) throw new Error("Fixture polling ended");
      return { ok: true, value: manifest };
    });
    const composed = new EnvironmentLifecycle(dir, { runner, onProgress: message => observations.push(message),
      integration: { manager: fixture.manager, requiresNativeSession: true, runtime: mockRuntime(), quiesce: async () => ({ ok: true, value: undefined }) } });
    await expect(composed.up(5000)).rejects.toThrow("Fixture polling ended");
    expect(observations.filter(message => message.includes("Waiting for native-session hooks:"))).toHaveLength(1);
    expect(observations.filter(message => message.includes("Waiting for required roles:"))).toHaveLength(1);
    expect(observations.findIndex(message => message.includes("Waiting for role transport"))).toBeLessThan(observations.findIndex(message => message.includes("Waiting for native-session hooks:")));
  });

  linuxIt("refreshes the current startup blocker when transport becomes ready before native receipts", async () => {
    const details: string[] = [];
    const pending = SessionManifestSchema.parse({ ...fixture.create(), status: "initializing",
      panes: fixture.create().panes.map(pane => ({ ...pane, permanent: true, transportState: "starting" })) });
    const transportReady = SessionManifestSchema.parse({ ...pending,
      panes: pending.panes.map(pane => ({ ...pane, transportState: "idle" })) });
    vi.mocked(fixture.manager.up).mockResolvedValue({ ok: true, value: pending });
    vi.mocked(fixture.manager.getManifest).mockResolvedValueOnce({ ok: true, value: null })
      .mockResolvedValueOnce({ ok: true, value: transportReady }).mockRejectedValueOnce(new Error("Fixture polling ended"));
    const composed = new EnvironmentLifecycle(dir, { runner, onProgressDetail: message => details.push(message),
      integration: { manager: fixture.manager, requiresNativeSession: true, runtime: mockRuntime(), quiesce: async () => ({ ok: true, value: undefined }) } });
    await expect(composed.up(5000)).rejects.toThrow("Fixture polling ended");
    expect(details.at(-1)).toContain("Waiting for native-session hooks:");
    expect(details.at(-1)).not.toContain("state 'starting'");
    expect(fixture.manager.up).toHaveBeenCalledTimes(1);
  });

  linuxIt("clears native blockers from progress when receipts finish while transport is still starting", async () => {
    const details: string[] = [];
    const pending = SessionManifestSchema.parse({ ...fixture.create(), status: "initializing",
      panes: fixture.create().panes.map(pane => ({ ...pane, permanent: true, transportState: "starting" })) });
    const withReceipts = (all: boolean) => SessionManifestSchema.parse({ ...pending, panes: pending.panes.map((pane, i) => ({ ...pane,
      ...(all || i === 0 ? { session: { source: "herdr:codex", kind: "id", value: `native-${i}` } } : {}) })) });
    vi.mocked(fixture.manager.up).mockResolvedValue({ ok: true, value: pending });
    vi.mocked(fixture.manager.getManifest).mockResolvedValueOnce({ ok: true, value: null })
      .mockResolvedValueOnce({ ok: true, value: withReceipts(false) }).mockResolvedValueOnce({ ok: true, value: withReceipts(true) })
      .mockRejectedValueOnce(new Error("Fixture polling ended"));
    const composed = new EnvironmentLifecycle(dir, { runner, onProgressDetail: message => details.push(message),
      integration: { manager: fixture.manager, requiresNativeSession: true, runtime: mockRuntime(), quiesce: async () => ({ ok: true, value: undefined }) } });
    await expect(composed.up(5000)).rejects.toThrow("Fixture polling ended");
    expect(details.at(-1)).toContain("Waiting for required roles:");
    expect(details.at(-1)).not.toContain("Waiting for native-session hooks:");
    expect(fixture.manager.up).toHaveBeenCalledTimes(1);
  });

  it("reports status and each diagnostic group without deriving readiness from progress", async () => {
    const observations: string[] = [];
    const composed = new EnvironmentLifecycle(dir, { runner, onProgress: message => observations.push(message),
      integration: { manager: fixture.manager } });
    const status = await composed.status();
    expect(status.server).toBe("stopped");
    expect(observations).toContain("Reading repository configuration and saved session state...");
    expect(observations).toContain("Checking session server and dependencies...");
    observations.length = 0;
    const doctor = await composed.doctor();
    expect(doctor.schemaVersion).toBe(2);
    expect(observations).toEqual(["Reading repository configuration for diagnostics...", "Checking Runtime and lifecycle health...",
      "Checking agent providers and authentication...", "Checking shared MCP services...", "Checking installed tools...", "Checking approved skills..."]);
  });

  linuxIt("publishes changing native startup observations before the deadline, without duplicates", async () => {
    const observations: string[] = [];
    let attempts = 0;
    const activate = async () => {
      attempts++;
      if (attempts > 3) return;
      throw new EnvironmentError({ code: "conflict", retryable: true,
        message: attempts < 3 ? "Coordinator pane pane-7 waiting for receipt" : "Verifier pane pane-8 waiting for receipt",
        details: { stage: "native_startup" } });
    };
    const composed = new EnvironmentLifecycle(dir, { runner, onProgress: message => observations.push(message),
      integration: { manager: fixture.manager, runtime: mockRuntime(), quiesce: async () => ({ ok: true, value: undefined }), activate } });
    expect((await composed.up(5000)).status).toBe("up");
    expect(observations.filter(message => message.includes("Coordinator pane pane-7"))).toHaveLength(1);
    expect(observations.filter(message => message.includes("Verifier pane pane-8"))).toHaveLength(1);
    expect(fixture.manager.up).toHaveBeenCalledTimes(1);
  });
  linuxIt("retains actionable native-hook context when activation readiness times out", async () => {
    const activate = vi.fn(async () => { throw new EnvironmentError({ code: "conflict", retryable: true,
      message: "Coordinator pane pane-7 is still publishing its native receipt", details: { stage: "native_startup" } }); });
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime(),
      quiesce: async () => ({ ok: true, value: undefined }), activate } });
    await expect(composed.up(1500)).rejects.toThrow("Coordinator pane pane-7");
    expect(fixture.manager.up).toHaveBeenCalledTimes(1);
    expect(fixture.manager.down).toHaveBeenCalledTimes(1);
    expect(runner.running.has(repository.sessionName)).toBe(false);
  });
  linuxIt("preserves the startup error and operation receipt when automatic shutdown is unsafe", async () => {
    const activate = vi.fn(async () => { throw new Error("original activation failure"); });
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, activate } });
    await expect(composed.up()).rejects.toThrow(/original activation failure.*Automatic cleanup failed.*Runtime is unavailable/s);
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("manager_pending");
    expect(runner.running.has(repository.sessionName)).toBe(true);
    expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  linuxIt("checkpoints active work before automatically stopping a failed startup", async () => {
    const save = vi.fn(async (command: CreateCheckpointCommand) => ({ ok: true as const, value: checkpoint(command) }));
    const runtime = mockRuntime([activeRun]);
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime, checkpoint: save,
      quiesce: async () => ({ ok: true, value: undefined }), activate: async () => { throw new Error("activation failure"); } } });
    await expect(composed.up()).rejects.toThrow(/activation failure.*Automatic cleanup completed successfully/s);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fixture.manager.down).mock.invocationCallOrder[0]!);
    expect(runner.running.has(repository.sessionName)).toBe(false);
  });
  linuxIt("bounds automatic host shutdown and preserves stopping state when cleanup times out", async () => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    config.environment.shutdownTimeoutMs = 3000;
    await writeFile(path, renderEnvironmentConfigYaml(config));
    const shutdownHost = vi.fn(async () => new Promise<void>(() => {}));
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime(),
      quiesce: async () => ({ ok: true, value: undefined }), shutdownHost,
      activate: async () => { throw new Error("original startup failure"); } } });
    await expect(composed.up()).rejects.toThrow(/original startup failure.*Automatic cleanup failed.*timed out/s);
    expect(runner.running.has(repository.sessionName)).toBe(false);
    expect(shutdownHost).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("stopping");
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/session.json"), "utf8")).status).toBe("stopping");
  });
  linuxIt("uses the live startup integration for shutdown before closing it", async () => {
    let closed = false;
    vi.mocked(fixture.manager.up).mockImplementation(async () => {
      fixture.set({ ...fixture.create(), status: "degraded" });
      throw new Error("role startup failed");
    });
    vi.mocked(fixture.manager.down).mockImplementation(async () => {
      if (closed) throw new Error("integration already closed");
      fixture.set({ ...fixture.get(), status: "down" });
      return { ok: true, value: fixture.get() };
    });
    const close = vi.fn(async () => { closed = true; throw new Error("integration close failed"); });
    const withClose = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime(),
      quiesce: async () => ({ ok: true, value: undefined }), close } });
    await expect(withClose.up()).rejects.toThrow(/role startup failed.*Automatic cleanup completed successfully.*integration close failed/s);
    expect(fixture.manager.down).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
  });
  linuxIt("reports a close failure after successful startup and attempts safe cleanup", async () => {
    const close = vi.fn(async () => { throw new Error("startup integration close timed out"); });
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime(),
      quiesce: async () => ({ ok: true, value: undefined }), close } });
    await expect(composed.up()).rejects.toThrow(/startup integration close timed out.*Automatic cleanup failed after the startup integration failed to close/s);
    expect(close).toHaveBeenCalledTimes(2);
    expect(fixture.manager.down).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("down");
  });
  it("resolves nested and symlink paths to the same repository", async () => {
    await mkdir(join(dir, "nested")); await symlink(dir, join(dir, "alias"));
    expect(await identifyRepository(join(dir, "nested"))).toEqual(repository);
    expect(await identifyRepository(join(dir, "alias"))).toEqual(repository);
    expect((await runCli(["init"], { cwd: join(dir, "nested") })).ok).toBe(true);
    await expect(readFile(join(dir, "nested/.bflow/config.yml"))).rejects.toThrow();
  });
  it("separates two repositories with the same basename", async () => {
    const a = join(dir, "a/same"); const b = join(dir, "b/same");
    await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
    execFileSync("git", ["init", "--quiet", a]); execFileSync("git", ["init", "--quiet", b]);
    expect((await identifyRepository(a)).sessionName).not.toBe((await identifyRepository(b)).sessionName);
  });
  it("preserves config on repeat init and ignores state/log/secrets without hiding config", async () => {
    const before = await readFile(join(dir, ".bflow/config.yml"), "utf8");
    await runCli(["init", "--name", "replacement"], { cwd: dir, environment: { runner } });
    expect(await readFile(join(dir, ".bflow/config.yml"), "utf8")).toBe(before);
    const ignore = await readFile(join(dir, ".bflow/.gitignore"), "utf8");
    expect(ignore.match(/secrets\//g)).toHaveLength(1); expect(ignore).not.toContain("config.yml");
    execFileSync("git", ["check-ignore", ".bflow/state/run", ".bflow/logs/log", ".bflow/secrets/token"], { cwd: dir });
    expect(runner.requests).toHaveLength(0);
  });
  it("initializes Claude roles explicitly and preserves existing provider selection on repeat init", async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), "bflow-provider-init-")));
    try {
      execFileSync("git", ["init", "--quiet", other]);
      expect((await runCli(["init", "--provider", "claude"], { cwd: other })).ok).toBe(true);
      const path = join(other, ".bflow/config.yml");
      const before = await readFile(path, "utf8");
      const config = EnvironmentConfigSchema.parse(parseConfigYaml(before));
      expect(config.environment.roles.every(role => role.cli === "claude")).toBe(true);
      expect(config.environment.roles.filter(role => role.role === "developer")).toEqual([
        { role: "developer", cli: "claude", required: false }
      ]);
      expect((await runCli(["init", "--provider", "codex"], { cwd: other })).ok).toBe(true);
      expect(await readFile(path, "utf8")).toBe(before);
    } finally { await rm(other, { recursive: true, force: true }); }
  });
  it("rejects an unsupported provider before writing any configuration", async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), "bflow-provider-invalid-")));
    try {
      execFileSync("git", ["init", "--quiet", other]);
      expect(parseCliArgs(["init", "--provider", "arbitrary-command"]).ok).toBe(false);
      expect((await runCli(["init", "--provider", "arbitrary-command"], { cwd: other })).ok).toBe(false);
      await expect(readFile(join(other, ".bflow/config.yml"))).rejects.toThrow();
    } finally { await rm(other, { recursive: true, force: true }); }
  });
  linuxIt("starts a headless server and reuses ready roles without duplicate startup", async () => {
    const first = await lifecycle.up(); const second = await lifecycle.up();
    expect(first.sessionId).toBe(second.sessionId); expect(fixture.manager.up).toHaveBeenCalledTimes(1);
    expect(runner.requests.filter((r) => r.mode === "background")).toHaveLength(1);
    const saved = SessionManifestSchema.parse(JSON.parse(await readFile(join(dir, ".bflow/state/session.json"), "utf8")));
    expect(saved.metadata?.["repositoryId"]).toBe(repository.id); expect(saved.panes).toHaveLength(roles.length);
  });
  linuxIt("does not fabricate success when the default P13 receives malformed topology responses", async () => {
    await expect(new EnvironmentLifecycle(dir, { runner,
      openIntegration: async input => ({ manager: new PaneManagerLifecycleAdapter(input, runner) }) }).up()).rejects.toThrow();
    expect(runner.requests.some((r) => r.args[0] === "workspace" && r.args[1] === "list")).toBe(true);
  });
  it("rejects attach before up without starting any session", async () => {
    await expect(lifecycle.attach()).rejects.toThrow("Run bflow up");
    expect(runner.requests.filter((r) => r.executable === "herdr")).toHaveLength(0);
  });
  linuxIt("focuses Conversation through the manager before opening the matching named TUI", async () => {
    await lifecycle.up(); await lifecycle.attach();
    expect(fixture.manager.attach).toHaveBeenCalledWith(repository.sessionName, expect.any(Object));
    const attach = runner.requests.find((r) => r.mode === "interactive")!;
    expect(attach.args).toEqual(["session", "attach", repository.sessionName]);
    expect(attach.env?.["HERDR_SESSION"]).toBe(repository.sessionName);
  });
  linuxIt("keeps raw progress off the terminal while attach owns it", async () => {
    await lifecycle.up();
    const chunks: string[] = [];
    const result = await main(["attach"], { cwd: dir, io: { stdout: () => {}, stderr: () => {}, stderrRaw: chunk => chunks.push(chunk) },
      presentation: { interactive: true }, environment: { runner, integration: { manager: fixture.manager } } });
    expect(result.exitCode).toBe(0);
    expect(chunks).toEqual([]);
    process.exitCode = 0;
  });
  linuxIt("rejects a manager attach target belonging to another role", async () => {
    await lifecycle.up(); vi.mocked(fixture.manager.attach).mockResolvedValue({ ok: true, value: fixture.get().panes[1]! });
    await expect(lifecycle.attach()).rejects.toThrow("incorrect Conversation");
    expect(runner.requests.some((r) => r.mode === "interactive")).toBe(false);
  });
  linuxIt("reports blocked startup and re-observes without duplicate agents", async () => {
    const manifest = fixture.create(); manifest.panes[1]!.transportState = "blocked";
    vi.mocked(fixture.manager.up).mockImplementation(async () => { fixture.set(manifest); return { ok: true, value: manifest }; });
    await expect(lifecycle.up()).rejects.toThrow("coordinator' is blocked");
    await expect(lifecycle.up()).rejects.toThrow("blocked"); expect(fixture.manager.up).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(await readFile(join(dir, ".bflow/state/session.json"), "utf8")); expect(saved.status).toBe("down");
  });
  linuxIt("does not report success when a required role is missing", async () => {
    const partial = fixture.create(); partial.panes = partial.panes.filter((p) => p.role !== "reviewer");
    vi.mocked(fixture.manager.up).mockImplementation(async () => { fixture.set(partial); return { ok: true, value: partial }; });
    await expect(lifecycle.up(500)).rejects.toThrow("timed out");
    expect(fixture.manager.up).toHaveBeenCalledTimes(1);
  });
  linuxIt("retains uncertain startup and forbids automatic resend", async () => {
    vi.mocked(fixture.manager.up).mockImplementation(async () => new Promise(() => {}));
    await expect(lifecycle.up(500)).rejects.toThrow(/timed out.*\nAutomatic cleanup failed.*no recoverable pane receipt/s);
    expect(runner.running.has(repository.sessionName)).toBe(true);
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("manager_pending");
    await expect(lifecycle.up()).rejects.toThrow("no recoverable pane receipt"); expect(fixture.manager.up).toHaveBeenCalledTimes(1);
    await expect(lifecycle.up()).rejects.toThrow("no recoverable pane receipt");
    expect(fixture.manager.up).toHaveBeenCalledTimes(1);
    expect(runner.running.has(repository.sessionName)).toBe(true);
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("manager_pending");
  });
  linuxIt("preserves unknown_delivery when the manager has no recoverable startup receipt", async () => {
    vi.mocked(fixture.manager.up).mockResolvedValue({ ok: false, error: {
      code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message: "Startup delivery is unknown"
    } });
    await expect(lifecycle.up()).rejects.toThrow(/delivery is unknown\nAutomatic cleanup failed.*no recoverable pane receipt/is);
    expect(runner.running.has(repository.sessionName)).toBe(true);
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("manager_pending");
    expect(fixture.manager.up).toHaveBeenCalledOnce();
  });
  linuxIt("reports server launch failure without creating roles", async () => {
    runner.serverFails = true;
    await expect(lifecycle.up()).rejects.toThrow("cannot bind"); expect(fixture.manager.up).not.toHaveBeenCalled();
  });
  linuxIt("refuses a foreign manifest and never touches its session", async () => {
    const foreign = { ...fixture.create(), sessionId: "foreign" };
    await mkdir(join(dir, ".bflow/state")); await writeFile(join(dir, ".bflow/state/session.json"), JSON.stringify(foreign));
    await expect(lifecycle.attach()).rejects.toThrow(); await expect(lifecycle.down(true)).rejects.toThrow();
    expect(runner.requests.some((r) => r.args.includes("stop"))).toBe(false);
  });
  linuxIt("refuses an existing named session without ownership evidence", async () => {
    runner.running.add(repository.sessionName);
    await expect(lifecycle.up()).rejects.toThrow("ownership evidence"); expect(fixture.manager.up).not.toHaveBeenCalled();
  });
  linuxIt("serializes lifecycle mutations with a repository lock", async () => {
    await mkdir(join(dir, ".bflow/state/lifecycle.lock"), { recursive: true });
    await expect(lifecycle.up()).rejects.toThrow("legacy lifecycle lock");
    expect(fixture.manager.up).not.toHaveBeenCalled();
    const config = await readFile(join(dir, ".bflow/config.yml"), "utf8");
    const recovered = await runCli(["recover", "--yes", "--json"], { cwd: dir, environment: { runner, integration: { manager: fixture.manager } } });
    expect(recovered.ok).toBe(true); expect(JSON.parse(recovered.stdout).command).toBe("recover");
    expect(await readFile(join(dir, ".bflow/config.yml"), "utf8")).toBe(config);
    expect((await lifecycle.up()).status).toBe("up");
  });
  it.each([null, "true"])("reports the exact config path for invalid role.required %j before shutdown", async required => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    const reviewerIndex = config.environment.roles.findIndex(role => role.role === "reviewer");
    expect(reviewerIndex).toBeGreaterThanOrEqual(0);
    const raw = { ...config, environment: { ...config.environment, roles: config.environment.roles.map(role =>
      role.role === "reviewer" ? { ...role, required } : role) } };
    const content = renderEnvironmentConfigYaml(raw);
    await writeFile(path, content);
    for (const json of [false, true]) {
      const result = await runCli(["down", ...(json ? ["--json"] : [])], { cwd: dir,
        environment: { runner, integration: { manager: fixture.manager } } });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("validation");
      const output = json ? JSON.parse(result.stdout).error.message : result.stderr;
      expect(output).toContain(".bflow/config.yml");
      expect(output).toContain(`environment.roles[${reviewerIndex}].required`);
      expect(output).toContain("Expected boolean");
      if (!json) expect(output).toContain("Inspect .bflow/config.yml");
    }
    expect(await readFile(path, "utf8")).toBe(content);
    expect(fixture.manager.down).not.toHaveBeenCalled();
    expect(runner.requests.filter(request => request.executable !== "git")).toEqual([]);
  });
  it("reports the exact config path for an invalid nested permission boolean", async () => {
    const path = join(dir, ".bflow/config.yml");
    const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    await writeFile(path, renderEnvironmentConfigYaml({ ...config, environment: { ...config.environment,
      permissions: { trustedWorkspace: null } } }));
    const result = await runCli(["down", "--json"], { cwd: dir,
      environment: { runner, integration: { manager: fixture.manager } } });
    expect(result.error?.message).toContain("environment.permissions.trustedWorkspace");
    expect(result.error?.message).toContain("Expected boolean, received null");
    expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  linuxIt("requires confirmation for active runs and does not stop agents", async () => {
    await lifecycle.up();
    const runtime = mockRuntime([activeRun]);
    lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime } });
    await expect(lifecycle.down()).rejects.toThrow("1 active runs"); expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  linuxIt("never bypasses checkpoints with --yes", async () => {
    await lifecycle.up(); lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime([activeRun]) } });
    await expect(lifecycle.down(true)).rejects.toThrow("checkpoint/quiesce API"); expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  linuxIt("checkpoints active runs before graceful shutdown and stops only the selected named session", async () => {
    await lifecycle.up(); runner.running.add("other-repository");
    const save = vi.fn(async (command: CreateCheckpointCommand) => ({ ok: true as const, value: checkpoint(command) }));
    lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime([activeRun]), quiesce: async () => ({ ok: true, value: undefined }), checkpoint: save } });
    const stopped = await lifecycle.down(true);
    expect(stopped.status).toBe("down"); expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fixture.manager.down).mock.invocationCallOrder[0]!);
    expect(runner.running.has("other-repository")).toBe(true); expect(runner.running.has(repository.sessionName)).toBe(false);
    expect(runner.requests.filter((r) => r.args.includes("stop")).map((r) => r.args)).toEqual([["session", "stop", repository.sessionName, "--json"]]);
    expect((await lifecycle.down()).status).toBe("down"); expect(fixture.manager.down).toHaveBeenCalledTimes(1);
    expect(await readFile(join(dir, ".bflow/config.yml"), "utf8")).toContain("defaultWorkflow");
  });
  linuxIt("rejects a checkpoint for a different run", async () => {
    await lifecycle.up();
    lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime([activeRun]), quiesce: async () => ({ ok: true, value: undefined }), checkpoint: async (command) => ({ ok: true, value: { ...checkpoint(command), runId: "foreign" } }) } });
    await expect(lifecycle.down(true)).rejects.toThrow("invalid aggregate checkpoint"); expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  linuxIt("requires confirmation for dirty files and keeps them after down", async () => {
    await lifecycle.up(); await writeFile(join(dir, "keep-me.txt"), "preserve");
    await expect(lifecycle.down()).rejects.toThrow("uncommitted changes"); await lifecycle.down(true);
    expect(await readFile(join(dir, "keep-me.txt"), "utf8")).toBe("preserve");
  });
  linuxIt("recollects and checkpoints a run that appeared before the shutdown barrier", async () => {
    await lifecycle.up();
    const runs: WorkflowRunSnapshot[] = [];
    const save = vi.fn(async (command: CreateCheckpointCommand) => ({ ok: true as const, value: checkpoint(command) }));
    lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime(runs),
      quiesce: async () => { runs.push(activeRun); return { ok: true, value: undefined }; }, checkpoint: save } });
    await lifecycle.down(true);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ runId: activeRun.runId }), expect.any(Object));
  });
  linuxIt("refuses shutdown when the Runtime barrier is not composed", async () => {
    await lifecycle.up();
    lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime() } });
    await expect(lifecycle.down(true)).rejects.toThrow("shutdown barrier");
    expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  linuxIt("does not force-stop after graceful shutdown times out", async () => {
    await lifecycle.up(); vi.mocked(fixture.manager.down).mockImplementation(async () => new Promise(() => {}));
    await expect(lifecycle.down(true, 500)).rejects.toThrow("timed out");
    expect(runner.requests.some((r) => r.args.includes("stop"))).toBe(false);
    vi.mocked(fixture.manager.down).mockImplementation(async () => ({ ok: true, value: { ...fixture.get(), status: "down" } }));
    expect((await lifecycle.down(true)).status).toBe("down");
    expect(fixture.manager.down).toHaveBeenCalledTimes(2);
    expect(runner.running.has(repository.sessionName)).toBe(false);
  });
  linuxIt("force down checkpoints before stopping the owned session despite unavailable pane topology", async () => {
    await lifecycle.up(); runner.running.add("other-repository");
    const worktree = join(dir, "worktrees", "task", "keep.txt");
    await mkdir(join(dir, "worktrees", "task"), { recursive: true });
    await writeFile(worktree, "uncommitted developer work");
    const config = await readFile(join(dir, ".bflow/config.yml"), "utf8");
    const events: string[] = [];
    const run = runner.run.bind(runner);
    vi.spyOn(runner, "run").mockImplementation(async request => {
      if (request.args[0] === "session" && request.args[1] === "stop") events.push("session-stop");
      return run(request);
    });
    vi.mocked(fixture.manager.getManifest).mockClear().mockResolvedValue({ ok: false, error: { code: "not_found", retryable: false, message: "workspace w1 not found" } });
    const save = vi.fn(async (command: CreateCheckpointCommand) => {
      events.push("checkpoint"); return { ok: true as const, value: checkpoint(command) };
    });
    const forced = new EnvironmentLifecycle(dir, { runner, integration: {
      manager: fixture.manager, runtime: mockRuntime([activeRun]), checkpoint: save,
      quiesce: async () => { events.push("quiesce"); return { ok: true, value: undefined }; },
      shutdownHost: async () => { events.push("host-shutdown"); }
    } });
    const stopped = await forced.down(false, 3000, true);
    expect(stopped.status).toBe("down");
    expect(events).toEqual(["quiesce", "checkpoint", "session-stop", "host-shutdown"]);
    expect(fixture.manager.getManifest).not.toHaveBeenCalled();
    expect(fixture.manager.down).not.toHaveBeenCalled();
    expect(runner.running.has("other-repository")).toBe(true);
    expect(runner.running.has(repository.sessionName)).toBe(false);
    expect(await readFile(worktree, "utf8")).toBe("uncommitted developer work");
    expect(await readFile(join(dir, ".bflow/config.yml"), "utf8")).toBe(config);
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("down");
    expect((await forced.down(false, 3000, true)).status).toBe("down");
    expect(runner.requests.filter(r => r.args[0] === "session" && r.args[1] === "stop")).toHaveLength(1);
  });
  linuxIt("force down escapes an interrupted workspace shutdown and allows the next up", async () => {
    await lifecycle.up();
    vi.mocked(fixture.manager.down).mockResolvedValue({ ok: false, error: { code: "not_found", retryable: false, message: "workspace w1 not found" } });
    await expect(lifecycle.down(true)).rejects.toThrow("workspace w1 not found");
    await expect(lifecycle.up()).rejects.toThrow("interrupted shutdown");
    expect((await lifecycle.down(false, 3000, true)).status).toBe("down");
    expect((await lifecycle.up()).status).toBe("up");
    expect(fixture.manager.up).toHaveBeenCalledTimes(2);
    expect(fixture.manager.down).toHaveBeenCalledTimes(1);
  });
  linuxIt("force down skips an unresponsive graceful role stop", async () => {
    await lifecycle.up();
    vi.mocked(fixture.manager.down).mockImplementation(() => new Promise(() => {}));
    expect((await lifecycle.down(false, 3000, true)).status).toBe("down");
    expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  linuxIt("force down cannot bypass a failed Runtime barrier", async () => {
    await lifecycle.up();
    const forced = new EnvironmentLifecycle(dir, { runner, integration: {
      manager: fixture.manager, runtime: mockRuntime(),
      quiesce: async () => ({ ok: false, error: { code: "conflict", retryable: true, message: "dispatch still in flight" } })
    } });
    await expect(forced.down(true, 3000, true)).rejects.toThrow("dispatch still in flight");
    expect(runner.running.has(repository.sessionName)).toBe(true);
    expect(runner.requests.some(r => r.args[0] === "session" && r.args[1] === "stop")).toBe(false);
  });
  linuxIt("force down stops a host daemon that rejects the protocol, but plain down does not", async () => {
    await lifecycle.up();
    const events: string[] = [];
    const incompatible = () => ({ ok: false as const, error: { code: "transport_unavailable" as const, retryable: true, message: "Error: Error: Unknown host operation" } });
    const make = () => new EnvironmentLifecycle(dir, { runner, integration: {
      manager: fixture.manager, runtime: mockRuntime(), quiesce: async () => incompatible(),
      shutdownHost: async () => { events.push("graceful-host"); },
      terminateIncompatibleHost: async () => { events.push("terminate-host"); }
    } });
    await expect(make().down(true, 3000)).rejects.toThrow("Unknown host operation");
    expect(runner.running.has(repository.sessionName)).toBe(true);
    const stopped = await make().down(false, 3000, true);
    expect(stopped.status).toBe("down");
    expect(events).toEqual(["terminate-host"]);
    expect(runner.running.has(repository.sessionName)).toBe(false);
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("down");
    expect((await lifecycle.up()).status).toBe("up");
    const unactivated = new EnvironmentLifecycle(dir, { runner, integration: {
      manager: fixture.manager, runtime: mockRuntime(),
      quiesce: async () => ({ ok: false, error: { code: "transport_unavailable", retryable: true, message: "Error: Persisted agentic work requires activation/reconciliation before safe shutdown" } }),
      terminateIncompatibleHost: async () => { events.push("terminate-unactivated"); }
    } });
    await expect(unactivated.down(true, 3000)).rejects.toThrow("requires activation");
    expect((await unactivated.down(false, 3000, true)).status).toBe("down");
    expect(events.at(-1)).toBe("terminate-unactivated");
    expect((await lifecycle.up()).status).toBe("up");
    const unrecoveredRun = new EnvironmentLifecycle(dir, { runner, integration: {
      manager: fixture.manager, runtime: mockRuntime(),
      quiesce: async () => ({ ok: false, error: { code: "transport_unavailable", retryable: true, message: "Error: Error: Persisted Core run requires activation/recovery before safe shutdown" } }),
      terminateIncompatibleHost: async () => { events.push("terminate-unrecovered-run"); }
    } });
    await expect(unrecoveredRun.down(true, 3000)).rejects.toThrow("requires activation/recovery");
    expect((await unrecoveredRun.down(false, 3000, true)).status).toBe("down");
    expect(events.at(-1)).toBe("terminate-unrecovered-run");
    expect(runner.running.has(repository.sessionName)).toBe(false);
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("down");
  });
  linuxIt("force down cannot bypass failed aggregate checkpoint persistence", async () => {
    await lifecycle.up();
    const forced = new EnvironmentLifecycle(dir, { runner, integration: {
      manager: fixture.manager, runtime: mockRuntime([activeRun]),
      quiesce: async () => ({ ok: true, value: undefined }),
      checkpoint: async () => ({ ok: false, error: { code: "corruption", retryable: false, message: "checkpoint disk failure" } })
    } });
    await expect(forced.down(true, 3000, true)).rejects.toThrow("checkpoint disk failure");
    expect(runner.running.has(repository.sessionName)).toBe(true);
    expect(runner.requests.some(r => r.args[0] === "session" && r.args[1] === "stop")).toBe(false);
  });
  linuxIt("force down preserves stopping state until a fresh probe confirms the server is gone", async () => {
    await lifecycle.up();
    const run = runner.run.bind(runner);
    vi.spyOn(runner, "run").mockImplementation(async request => {
      if (request.args[0] === "session" && request.args[1] === "stop") return { exitCode: 0, stdout: "{}", stderr: "" };
      return run(request);
    });
    await expect(lifecycle.down(true, 500, true)).rejects.toMatchObject({ contractError: { code: "timeout" } });
    expect(runner.running.has(repository.sessionName)).toBe(true);
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("stopping");
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/session.json"), "utf8")).status).toBe("stopping");
  });
  linuxIt("force down reconciles a lost stop acknowledgement without resending shutdown", async () => {
    await lifecycle.up();
    const run = runner.run.bind(runner);
    const stop = vi.fn();
    vi.spyOn(runner, "run").mockImplementation(async request => {
      if (request.args[0] === "session" && request.args[1] === "stop") {
        stop(); runner.running.delete(repository.sessionName);
        return { exitCode: 1, stdout: "", stderr: "socket closed after stopping" };
      }
      return run(request);
    });
    expect((await lifecycle.down(false, 3000, true)).status).toBe("down");
    expect(stop).toHaveBeenCalledOnce();
  });
  linuxIt("force down refuses to stop a session using a foreign saved manifest", async () => {
    await lifecycle.up();
    const path = join(dir, ".bflow/state/session.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...saved, workspaceRoot: "/foreign-repository" }));
    await expect(lifecycle.down(true, 3000, true)).rejects.toThrow("another repository");
    expect(runner.running.has(repository.sessionName)).toBe(true);
    expect(runner.requests.some(r => r.args[0] === "session" && r.args[1] === "stop")).toBe(false);
  });
  linuxIt("routes down --force from the CLI to the checkpointed session stop", async () => {
    await lifecycle.up();
    vi.mocked(fixture.manager.getManifest).mockResolvedValue({ ok: false, error: { code: "not_found", retryable: false, message: "workspace w1 not found" } });
    const result = await runCli(["down", "--force", "--json"], { cwd: dir, environment: {
      runner, integration: { manager: fixture.manager, runtime: mockRuntime(), quiesce: async () => ({ ok: true, value: undefined }) }
    } });
    expect(result.exitCode).toBe(0);
    expect(runner.running.has(repository.sessionName)).toBe(false);
    expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  linuxIt("reports live server, panes and agent state", async () => {
    await lifecycle.up(); const status = await lifecycle.status();
    expect(status.server).toBe("running"); expect(status.liveObservation).toBe(true); expect(status.manifest?.panes).toHaveLength(7);
  });
  linuxIt("cancels an in-flight up and resumes the same saved topology without deleting state", async () => {
    const abort = new AbortController(), sentinel = join(dir, "notes.txt"); await writeFile(sentinel, "uncommitted work");
    const original = fixture.manager.up;
    vi.mocked(fixture.manager.up).mockImplementationOnce(async () => {
      fixture.set({ ...fixture.create(), status: "initializing" });
      await new Promise(() => {}); return { ok: true, value: fixture.get() };
    });
    const interrupted = new EnvironmentLifecycle(dir, { runner, signal: abort.signal, integration: { manager: fixture.manager,
      runtime: mockRuntime(), quiesce: async () => ({ ok: true, value: undefined }) } });
    const pending = interrupted.up();
    await expect.poll(() => vi.mocked(original).mock.calls.length).toBe(1); abort.abort();
    await expect(pending).rejects.toMatchObject({ contractError: { code: "cancelled" } });
    expect((await lifecycle.up()).status).toBe("up");
    expect(runner.requests.filter(r => r.args[0] === "server")).toHaveLength(2);
    expect(await readFile(sentinel, "utf8")).toBe("uncommitted work");
  });
  linuxIt("recovers a pre-manifest stopped startup and keeps configuration intact", async () => {
    const config = await readFile(join(dir, ".bflow/config.yml"), "utf8");
    await mkdir(join(dir, ".bflow/state"), { recursive: true });
    await writeFile(join(dir, ".bflow/state/operation.json"), JSON.stringify({ repositoryId: repository.id, sessionName: repository.sessionName, phase: "server_starting" }));
    await expect(lifecycle.up()).rejects.toThrow("bflow recover --yes");
    await expect(lifecycle.recover()).rejects.toThrow("recover --yes");
    await lifecycle.recover(true); expect((await lifecycle.up()).status).toBe("up");
    expect(await readFile(join(dir, ".bflow/config.yml"), "utf8")).toBe(config);
  });
  linuxIt("stops a server-only partial startup after the runtime barrier and rejects active work", async () => {
    await mkdir(join(dir, ".bflow/state"), { recursive: true });
    await writeFile(join(dir, ".bflow/state/operation.json"), JSON.stringify({ repositoryId: repository.id, sessionName: repository.sessionName, phase: "manager_pending" }));
    runner.running.add(repository.sessionName);
    await expect(lifecycle.down()).rejects.toThrow("down --yes");
    const active = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime([activeRun]), quiesce: async () => ({ ok: true, value: undefined }) } });
    await expect(active.down(true)).rejects.toThrow("Active workflows");
    expect(runner.running.has(repository.sessionName)).toBe(true);
    expect((await lifecycle.down(true)).server).toBe("stopped");
    expect(runner.running.has(repository.sessionName)).toBe(false);
  });
  linuxIt("finishes a retained host after the Herdr server has already stopped", async () => {
    await lifecycle.up(); runner.running.delete(repository.sessionName);
    const shutdownHost = vi.fn(async () => undefined), quiesce = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const save = vi.fn(async (command: CreateCheckpointCommand) => ({ ok: true as const, value: checkpoint(command) }));
    const resumed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager,
      runtime: mockRuntime([activeRun]), checkpoint: save, quiesce, shutdownHost } });
    expect((await resumed.down(true)).status).toBe("down");
    expect(quiesce).toHaveBeenCalled(); expect(save).toHaveBeenCalled(); expect(shutdownHost).toHaveBeenCalledOnce();
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(shutdownHost.mock.invocationCallOrder[0]!);
  });
  it("diagnoses missing dependencies and configuration without starting servers", async () => {
    runner.missing.add("codex");
    const report = await lifecycle.doctor(); expect(report.healthy).toBe(false);
    expect(report.checks.some((c) => c.checkId === "agent-codex" && c.status === "failed")).toBe(true);
    expect(runner.requests.some((r) => r.mode === "background")).toBe(false);
  });
  it("rejects copied config identity", async () => {
    const path = join(dir, ".bflow/config.yml"); const config = EnvironmentConfigSchema.parse(parseConfigYaml(await readFile(path, "utf8")));
    await writeFile(path, renderEnvironmentConfigYaml({ ...config, environment: { ...config.environment, repositoryId: "other" } }));
    await expect(lifecycle.up()).rejects.toThrow("another repository");
  });
  it("routes main status to environment without opening the workflow runtime", async () => {
    const before = process.exitCode;
    try {
      const result = await main(["status", "--json"], { cwd: dir, io: { stdout() {}, stderr() {} }, environment: { runner } });
      expect(JSON.parse(result.stdout).data.server).toBe("stopped");
    } finally { process.exitCode = before; }
  });
});

describe("environment command parsing and session context", () => {
  it("keeps provider auto-updates disabled from the earliest lifecycle subprocess", async () => {
    const base = { PATH: process.env.PATH, DISABLE_AUTOUPDATER: "0" };
    const result = await environmentProcessRunner.run({ executable: process.execPath,
      args: ["-e", "process.stdout.write(process.env.DISABLE_AUTOUPDATER || 'unset')"],
      cwd: process.cwd(), env: namedSessionEnvironment("test-session", base) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1");
    expect(base.DISABLE_AUTOUPDATER).toBe("0");
  });
  it.each(["up", "down", "attach", "doctor", "recover"])("supports %s and its help", (command) => {
    expect(parseCliArgs([command, "--json"]).ok).toBe(true); expect(parseCliArgs([command, "--help"]).ok).toBe(true);
  });
  it.each([["up", "--timeout", "0"], ["down", "--timeout", "NaN"], ["up", "--timeout", "600001"], ["up", "--yes"], ["attach", "--timeout", "10"], ["doctor", "extra"]])("rejects invalid flags %s %s", (...args) => {
    expect(parseCliArgs(args).ok).toBe(false);
  });
  it("removes inherited socket, remote and caller pane context", () => {
    expect(namedSessionEnvironment("repo-session", { PATH: "/bin", HERDR_SOCKET: "/wrong", HERDR_PANE_ID: "other", HERDR_SESSION: "other", HERDR_ENV: "1", HERDR_CONFIG_PATH: "/explicit/config" }))
      .toEqual({ PATH: "/bin", DISABLE_AUTOUPDATER: "1", HERDR_CONFIG_PATH: "/explicit/config", HERDR_SESSION: "repo-session" });
  });
});
