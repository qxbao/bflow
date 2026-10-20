import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManifestSchema } from "@bflow/contracts";
import type { HostPrepareResponse } from "@bflow/runtime";
import { FileSessionManifestStore, readBuiltinRolePrompt, resolveTopologyRole } from "@bflow/pane-manager";
import { EnvironmentLifecycle, PaneManagerLifecycleAdapter, createNamedPaneRunner, identifyRepository, readEnvironmentConfig, runCli, openPaneManagerEnvironment,
  renderEnvironmentConfigYaml, type EnvironmentCompositionInput } from "../src/index.js";
import { HerdrProcesses } from "./fixtures/herdr-processes.js";
import type { LifecycleHost } from "../src/agentic-host.js";

const linuxIt = it.skipIf(process.platform !== "linux");
describe("P12 composition with real P13 RolePaneManager", () => {
  let dir: string;
  let input: EnvironmentCompositionInput;
  let runner: HerdrProcesses;
  let host: LifecycleHost;
  const lifecycle = () => new EnvironmentLifecycle(dir, { runner,
    openIntegration: async composition => openPaneManagerEnvironment(composition, runner, async () => host,
      async () => ["--test-host-role-config"]) });
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "bflow-p12-p13-"))); execFileSync("git", ["init", "--quiet", dir]);
    expect((await runCli(["init"], { cwd: dir })).ok).toBe(true);
    const repository = await identifyRepository(dir);
    input = { repository, config: await readEnvironmentConfig(repository), env: { ...process.env, HERDR_SESSION: "foreign", HERDR_SOCKET: "/foreign" } };
    runner = new HerdrProcesses();
    host = {
      prepare: vi.fn(async () => ({ roleLaunch: Object.fromEntries(input.config.environment.roles.map(role => [role.role,
        { systemPrompt: `Trusted ${role.role} prompt`, mcpConfigFile: "/test/mcp.json", hooksSettingsFile: "/test/hooks.json" }])) })),
      activate: vi.fn(async () => ({ ok: true, value: undefined })),
      runtime: { findRuns: vi.fn(async () => ({ ok: true, value: { items: [] } })), getRun: vi.fn(async () => ({ ok: true, value: null })) },
      quiesce: vi.fn(async () => ({ ok: true, value: undefined })), checkpoint: vi.fn(), shutdown: vi.fn(async () => {}), close: vi.fn(async () => {})
    };
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
  const starts = (runner: HerdrProcesses) => runner.calls.filter((r) => r.args[0] === "agent" && r.args[1] === "start");
  // EnvironmentLifecycle startup/shutdown uses the Linux flock guard.
  linuxIt("pipelines health after durable role publication without holding later launches, and drains before up returns", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const checked: string[] = [];
    let firstCheckStartCount = 0;
    host.verifyRoleStartup = async (manifest, role) => {
      const persisted = SessionManifestSchema.parse(JSON.parse(await readFile(join(dir, `.bflow/state/panes/${input.repository.sessionName}.manifest.json`), "utf8")));
      expect(persisted.panes.some(pane => pane.role === role && pane.session)).toBe(true);
      if (checked.length === 0) firstCheckStartCount = starts(runner).length;
      checked.push(role);
      await gate;
      return { ok: true, value: undefined };
    };
    let settled = false;
    const pending = lifecycle().up().finally(() => { settled = true; });
    try {
      await expect.poll(() => starts(runner).length, { timeout: 15_000 }).toBe(7);
      await expect.poll(() => checked.length).toBe(3);
      expect(firstCheckStartCount).toBeLessThan(7);
      expect(settled).toBe(false);
      expect(host.activate).not.toHaveBeenCalled();
    } finally { release(); }
    const manifest = await pending;
    expect(manifest.panes).toHaveLength(7);
    expect(checked).toHaveLength(7);
  });

  linuxIt.each(["quiesce", "close"] as const)("waits for remote startup drain before %s after a disconnected check", async transition => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const remoteDrain = vi.fn(async () => { await gate; return { ok: true as const, value: undefined }; });
    Object.assign(host, { drainRoleStartup: remoteDrain });
    host.verifyRoleStartup = async () => ({ ok: false, error: { code: "transport_unavailable", retryable: true, message: "startup RPC disconnected" } });
    const integration = openPaneManagerEnvironment(input, runner, async () => host, async () => ["--test-host-role-config"]);
    const started = await integration.manager.up(input.repository.sessionName);
    expect(started.ok).toBe(false);
    let settled = false;
    const pending = (transition === "quiesce" ? integration.quiesce!({}) : integration.close!()).finally(() => { settled = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(remoteDrain).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(host[transition]).not.toHaveBeenCalled();
    } finally { release(); }
    await pending;
    expect(host[transition]).toHaveBeenCalledTimes(1);
  });

  linuxIt("does not schedule health from a failed manifest write", async () => {
    host.verifyRoleStartup = vi.fn(async () => ({ ok: true, value: undefined }));
    vi.spyOn(FileSessionManifestStore.prototype, "save").mockResolvedValue({ ok: false, error: { code: "corruption", retryable: false, message: "disk write failed" } });
    await expect(lifecycle().up()).rejects.toThrow("disk write failed");
    expect(host.verifyRoleStartup).not.toHaveBeenCalled();
  });

  linuxIt("starts all seven P13 roles with trusted host arguments and persists returned IDs", async () => {
    const environment = lifecycle();
    const manifest = await environment.up();
    expect(starts(runner)).toHaveLength(7); expect(manifest.panes.map((p) => p.role).sort()).toEqual(["conversation", "coordinator", "planner", "architect", "specifier", "reviewer", "qa"].sort());
    expect(manifest.status).toBe("up"); expect(new Set(manifest.panes.map((p) => p.tabId)).size).toBe(3);
    const saved = SessionManifestSchema.parse(JSON.parse(await readFile(join(dir, `.bflow/state/panes/${input.repository.sessionName}.manifest.json`), "utf8")));
    expect(saved.panes.map((p) => p.paneId)).toEqual(manifest.panes.map((p) => p.paneId));
    expect(saved.metadata?.["repositoryId"]).toBe(input.repository.id);
    expect(starts(runner).every(call => call.args.includes("--test-host-role-config"))).toBe(true);
    expect(host.prepare).toHaveBeenCalledTimes(1);
    expect(host.activate).toHaveBeenCalledWith(expect.objectContaining({ status: "up" }), expect.any(Object));
  });
  linuxIt("keeps a 600000ms config inside the CLI startup deadline and native Herdr start limit", async () => {
    const config = { ...input.config, environment: { ...input.config.environment, startupTimeoutMs: 600_000 } };
    await writeFile(join(dir, ".bflow/config.yml"), renderEnvironmentConfigYaml(config));
    expect((await lifecycle().up(299_999)).status).toBe("up");
    const calls = starts(runner);
    expect(calls).toHaveLength(7);
    for (const call of calls) {
      const timeout = Number(call.args[call.args.indexOf("--timeout") + 1]);
      expect(Number.isInteger(timeout)).toBe(true);
      expect(timeout).toBeGreaterThan(3000);
      expect(timeout).toBeLessThan(299_999);
      expect(call.timeoutMs).toBeLessThanOrEqual(300_000);
    }
  });
  linuxIt("reopens composition across CLI invocations without starting duplicate agents", async () => {
    await lifecycle().up();
    await lifecycle().up();
    expect(starts(runner)).toHaveLength(7);
    expect(runner.calls.filter((r) => r.args[0] === "workspace" && r.args[1] === "create")).toHaveLength(1);
  });
  linuxIt("refreshes live health and focuses Conversation through P13 before the TUI", async () => {
    const environment = lifecycle(); await environment.up();
    const first = await environment.status(); expect(first.liveObservation).toBe(true);
    const panes = runner.session(input.repository.sessionName).panes;
    panes.find((p) => p.name === "reviewer")!.agent_status = "blocked";
    const blocked = await environment.status(); expect(blocked.manifest?.status).toBe("degraded");
    expect(blocked.manifest?.panes.find((p) => p.role === "reviewer")?.transportState).toBe("blocked");
    await environment.attach();
    const last = runner.calls.findLast((r) => r.args[0] === "agent" && r.args[1] === "focus")!;
    expect(last.args[2]).toBe(blocked.manifest?.attachTarget.paneId);
    expect(runner.calls.findLast((r) => r.mode === "interactive")?.args).toEqual(["session", "attach", input.repository.sessionName]);
    expect((await environment.doctor()).healthy).toBe(false);
  });
  linuxIt("detects a shell replacing an agent instead of reporting a persisted idle state", async () => {
    const environment = lifecycle(); await environment.up();
    runner.session(input.repository.sessionName).panes.find((p) => p.name === "qa-verifier")!.agent = null;
    const observed = await environment.status();
    expect(observed.manifest?.panes.find((p) => p.role === "qa")?.transportState).toBe("disconnected");
  });
  linuxIt("stops failed blocked startup before allowing another dispatch", async () => {
    runner.blockedAgent = "coordinator";
    await expect(lifecycle().up()).rejects.toThrow(/is blocked during startup.*Automatic cleanup completed successfully/s);
    expect(runner.session(input.repository.sessionName).running).toBe(false);
    const count = starts(runner).length;
    expect(JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8")).phase).toBe("down");
    expect(starts(runner)).toHaveLength(count);
  });
  linuxIt("rejects a foreign durable manifest without dispatching P13 commands", async () => {
    await lifecycle().up();
    const file = join(dir, `.bflow/state/panes/${input.repository.sessionName}.manifest.json`);
    const manifest = JSON.parse(await readFile(file, "utf8")); manifest.workspaceRoot = "/other-repo";
    await writeFile(file, JSON.stringify(manifest)); const before = starts(runner).length;
    await expect(lifecycle().up()).rejects.toThrow("another repository");
    expect(starts(runner)).toHaveLength(before);
  });
  linuxIt("does not report stale idle bindings as live when P13 cannot persist its health refresh", async () => {
    await lifecycle().up();
    runner.session(input.repository.sessionName).panes.find((p) => p.name === "reviewer")!.agent_status = "blocked";
    vi.spyOn(FileSessionManifestStore.prototype, "save").mockResolvedValue({ ok: false, error: { code: "corruption", retryable: false, message: "disk write failed" } });
    const status = await lifecycle().status();
    expect(status.liveObservation).toBe(false);
    expect(status.issues.some((issue) => issue.includes("disk write failed"))).toBe(true);
  });
  it("scopes P13 process env without changing the global or incoming environment", async () => {
    const before = process.env["HERDR_SESSION"];
    const bridge = createNamedPaneRunner(input, runner);
    await bridge.run({ args: ["status", "server", "--json"] });
    expect(runner.calls[0]?.env?.["HERDR_SESSION"]).toBe(input.repository.sessionName);
    expect(runner.calls[0]?.env?.["HERDR_SOCKET"]).toBeUndefined();
    expect(input.env["HERDR_SESSION"]).toBe("foreign"); expect(process.env["HERDR_SESSION"]).toBe(before);
  });
  it("rejects foreign lifecycle IDs and does not fabricate graceful shutdown", async () => {
    const adapter = new PaneManagerLifecycleAdapter(input, runner);
    expect((await adapter.up("foreign")).ok).toBe(false); expect((await adapter.attach("foreign")).ok).toBe(false);
    expect((await adapter.getManifest("foreign")).ok).toBe(false); expect((await adapter.down(input.repository.sessionName)).ok).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });
  linuxIt("reports topology before up and shuts down only after the composed host lifecycle barrier", async () => {
    const environment = lifecycle();
    const report = await environment.doctor();
    expect(report.checks.find((c) => c.checkId === "p13-composition")?.status).toBe("passed");
    expect(host.prepare).not.toHaveBeenCalled();
    await environment.up();
    expect((await environment.down(true)).status).toBe("down");
    expect(host.quiesce).toHaveBeenCalledTimes(1);
    expect(host.shutdown).toHaveBeenCalledTimes(1);
    expect(runner.session(input.repository.sessionName).running).toBe(false);
  });
  it("passes cancellation to the P13 process runner without starting on an already-aborted signal", async () => {
    const controller = new AbortController(); controller.abort();
    const fake = { run: vi.fn() };
    expect(await createNamedPaneRunner(input, fake).run({ args: ["agent", "start", "chat"], signal: controller.signal })).toMatchObject({ failure: "aborted", started: false });
    expect(fake.run).not.toHaveBeenCalled();
  });
  linuxIt("shuts down an active topology with the default openLifecycleHost even when config roles use non-Claude CLI and no host daemon was started", async () => {
    await lifecycle().up();
    const defaultLifecycle = new EnvironmentLifecycle(dir, {
      runner,
      openIntegration: async composition => openPaneManagerEnvironment(composition, runner)
    });
    const stopped = await defaultLifecycle.down(true);
    expect(stopped.status).toBe("down");
    expect(runner.session(input.repository.sessionName).running).toBe(false);
  });
});

type Provider = "claude" | "codex" | "agy";
/** Provider-specific startup argv. Conversation/Coordinator must reference their original prompt, as P13 verifies. */
async function launchFor(role: string, provider: Provider): Promise<HostPrepareResponse["roleLaunch"][string]> {
  const source = (await readBuiltinRolePrompt(role as never))?.source ?? "";
  const topology = resolveTopologyRole(role);
  const argv = topology === "chat" || topology === "coordinator"
    ? provider === "claude" ? ["--append-system-prompt-file", source] : ["-c", `model_instructions_file=${JSON.stringify(source)}`]
    : [`--role-test=${role}`];
  return { systemPrompt: `Trusted ${role} prompt`, mcpConfigFile: "/test/mcp.json", hooksSettingsFile: "/test/hooks.json",
    launch: { provider, argv, env: { BFLOW_TEST_SECRET: "must-not-leak" }, launchId: `launch-${role}`, launchFingerprint: "a".repeat(64) } };
}

describe("P30 platform readiness in up", () => {
  let dir: string;
  let runner: HerdrProcesses;
  let base: EnvironmentCompositionInput;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "bflow-p30-up-"))); execFileSync("git", ["init", "--quiet", dir]);
    expect((await runCli(["init"], { cwd: dir })).ok).toBe(true);
    const repository = await identifyRepository(dir);
    base = { repository, config: await readEnvironmentConfig(repository), env: { ...process.env } };
    runner = new HerdrProcesses();
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
  const starts = () => runner.calls.filter((r) => r.args[0] === "agent" && r.args[1] === "start");
  const kindOf = (call: { args: readonly string[] }) => call.args[call.args.indexOf("--kind") + 1];
  const withProviders = (assign: (role: string) => Provider): EnvironmentCompositionInput => {
    const config = structuredClone(base.config);
    config.environment.roles = config.environment.roles.map(role => ({ ...role, cli: assign(role.role) }));
    return { ...base, config };
  };
  const hostWith = (roleLaunch: HostPrepareResponse["roleLaunch"], platform?: HostPrepareResponse["platform"]): LifecycleHost => ({
    prepare: vi.fn(async () => ({ roleLaunch, ...(platform ? { platform } : {}) })),
    activate: vi.fn(async () => ({ ok: true as const, value: undefined })),
    runtime: { findRuns: vi.fn(async () => ({ ok: true, value: { items: [] } })), getRun: vi.fn(async () => ({ ok: true, value: null })) },
    quiesce: vi.fn(async () => ({ ok: true, value: undefined })), checkpoint: vi.fn(), shutdown: vi.fn(async () => {}), close: vi.fn(async () => {})
  } as unknown as LifecycleHost);
  /** The Herdr server is started by `up` through the lifecycle; these tests drive the manager directly. */
  const serverRunning = (input: EnvironmentCompositionInput) => { runner.session(input.repository.sessionName).running = true; };
  /** Env-bearing panes are created through the Herdr socket API; the fixture models it over the same state. */
  const socketFor = (input: EnvironmentCompositionInput) => runner.socket(input.repository.sessionName);
  const roleLaunchesFor = async (input: EnvironmentCompositionInput) => Object.fromEntries(await Promise.all(
    input.config.environment.roles.map(async role => [role.role, await launchFor(role.role, role.cli as Provider)])));

  it("passes the startup budget to the host before evaluating blocked readiness", async () => {
    const host = hostWith({}, { ready: false, generation: 1, checkedAt: new Date().toISOString(), roles: [] });
    const options = { timeoutMs: 65_000, deadline: new Date(Date.now() + 65_000).toISOString(), signal: new AbortController().signal };
    const result = await openPaneManagerEnvironment(base, runner, async () => host).manager.up(base.repository.sessionName, options);
    expect(host.prepare).toHaveBeenCalledWith(options);
    expect(result.ok).toBe(false);
    expect(starts()).toHaveLength(0);
  });

  it.each(["cancelled", "expired"])("does not start panes after %s host preparation", async kind => {
    const controller = new AbortController();
    const options = { timeoutMs: 65_000, deadline: new Date(Date.now() + 65_000).toISOString(), signal: controller.signal };
    const host = hostWith({});
    host.prepare = vi.fn(async () => {
      if (kind === "cancelled") controller.abort();
      else options.deadline = new Date(Date.now() - 1).toISOString();
      return { roleLaunch: {} };
    });
    await expect(openPaneManagerEnvironment(base, runner, async () => host).manager.up(base.repository.sessionName, options))
      .rejects.toThrow(/interrupted|exceeded the startup deadline/);
    expect(starts()).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  linuxIt("starts an all-Codex configuration with the host-prepared launch profile", async () => {
    const input = withProviders(() => "codex");
    serverRunning(input);
    const host = hostWith(await roleLaunchesFor(input));
    const result = await openPaneManagerEnvironment(input, runner, async () => host, undefined, socketFor).manager.up(input.repository.sessionName);
    expect(result.ok ? "ok" : result.error.message).toBe("ok");
    expect(starts()).toHaveLength(7);
    expect(starts().every(call => kindOf(call) === "codex")).toBe(true);
    // Live finding: Herdr agent start never forwards invocation env, so the launch env must be set at pane creation.
    expect(starts().every(call => !JSON.stringify(call.env ?? {}).includes("must-not-leak") && !call.args.join(" ").includes("must-not-leak"))).toBe(true);
    expect(runner.calls.some(call => call.args.join(" ").includes("must-not-leak"))).toBe(false);
    const started = runner.session(input.repository.sessionName).panes.filter(pane => pane.agent !== null);
    expect(started).toHaveLength(7);
    expect(started.every(pane => pane.env?.["BFLOW_TEST_SECRET"] === "must-not-leak")).toBe(true);
    expect(host.prepare).toHaveBeenCalledTimes(1);
  });

  linuxIt("checks only current prepared launches while reconciling a saved prior generation", async () => {
    const input = withProviders(() => "codex");
    serverRunning(input);
    const previous = await roleLaunchesFor(input);
    const initial = await openPaneManagerEnvironment(input, runner, async () => hostWith(previous), undefined, socketFor)
      .manager.up(input.repository.sessionName);
    expect(initial.ok).toBe(true);
    const current = Object.fromEntries(Object.entries(previous).map(([role, descriptor]) => [role, { ...descriptor,
      launch: { ...descriptor.launch!, launchId: `new-${role}`, launchFingerprint: "b".repeat(64) } }]));
    const checked: string[] = [];
    const host = hostWith(current);
    host.verifyRoleStartup = async (manifest, role) => {
      const pane = manifest.panes.find(binding => binding.role === role)!;
      const launchId = pane.metadata?.["launchId"];
      checked.push(String(launchId));
      // The real daemon refuses receipts from a superseded prepared launch.
      return launchId === current[role]?.launch?.launchId
        ? { ok: true, value: undefined }
        : { ok: false, error: { code: "conflict", retryable: false, message: "Prior-generation launch was checked" } };
    };
    const result = await openPaneManagerEnvironment(input, runner, async () => host, undefined, socketFor)
      .manager.up(input.repository.sessionName);
    expect(result.ok ? "ok" : result.error.message).toBe("ok");
    expect(checked).toHaveLength(7);
    expect(checked.every(id => id.startsWith("new-"))).toBe(true);
    if (result.ok) expect(result.value.panes.every(pane => pane.metadata?.["launchId"] === `new-${pane.role}`)).toBe(true);
  });

  linuxIt("fails up with the readiness report before any agent start when a required role is blocked", async () => {
    const input = withProviders(role => role === "coordinator" ? "codex" : "claude");
    serverRunning(input);
    const roleLaunch = await roleLaunchesFor(input);
    const platform: HostPrepareResponse["platform"] = { ready: false, generation: 1, checkedAt: new Date().toISOString(), roles: [
      { role: "coordinator", provider: "codex", required: true, status: "blocked", message: "Codex is not authenticated",
        checks: [{ check: "authentication", status: "failed", code: "codex_auth_missing", message: "Codex login is missing", remediation: "Run codex login" }] },
      { role: "conversation", provider: "claude", required: true, status: "ready", checks: [] }
    ] };
    const result = await openPaneManagerEnvironment(input, runner, async () => hostWith(roleLaunch, platform)).manager.up(input.repository.sessionName);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("coordinator [codex]: blocked");
    expect(result.error.message).toContain("codex_auth_missing");
    expect(result.error.message).toContain("Codex login is missing");
    expect(result.error.message).not.toContain("conversation [claude]");
    expect(result.error.message).not.toContain("must-not-leak");
    expect(starts()).toHaveLength(0);
  });

  linuxIt("starts a mixed Claude, Codex and Agy configuration with each role's own provider", async () => {
    const input = withProviders(role => role === "conversation" ? "claude" : role === "coordinator" ? "codex" : "agy");
    serverRunning(input);
    const result = await openPaneManagerEnvironment(input, runner, async () => hostWith(await roleLaunchesFor(input)), undefined, socketFor).manager.up(input.repository.sessionName);
    expect(result.ok ? "ok" : result.error.message).toBe("ok");
    const kinds = starts().map(kindOf).sort();
    expect(kinds).toEqual(["agy", "agy", "agy", "agy", "agy", "claude", "codex"]);
  });

  linuxIt("keeps a configured Developer model as a dynamic template without creating a permanent pane", async () => {
    const input = withProviders(role => role === "coordinator" ? "codex" : "claude");
    const developer = { role: "developer" as const, cli: "codex" as const, required: false, model: "developer-codex", effort: "high" as const };
    input.config.environment.roles = input.config.environment.roles.map(role => role.role === "developer" ? developer : role);
    serverRunning(input);
    const permanentLaunches = await roleLaunchesFor(input);
    delete permanentLaunches["developer"];
    const host = hostWith(permanentLaunches);
    const result = await openPaneManagerEnvironment(input, runner, async composition => {
      expect(composition.config.environment.roles.find(role => role.role === "developer")).toMatchObject(developer);
      return host;
    }, undefined, socketFor).manager.up(input.repository.sessionName);
    expect(result.ok ? "ok" : result.error.message).toBe("ok");
    expect(starts()).toHaveLength(7);
    const manifest = result.ok ? result.value : undefined;
    expect(manifest?.panes).toHaveLength(7);
    expect(manifest?.panes.some(pane => pane.role === "developer")).toBe(false);
  });

  linuxIt("uses the legacy provider arguments when the host prepares no launch profile", async () => {
    const input = withProviders(() => "codex");
    serverRunning(input);
    const legacy: HostPrepareResponse["roleLaunch"] = Object.fromEntries(input.config.environment.roles.map(role => [role.role,
      { systemPrompt: "Trusted prompt", mcpConfigFile: "/test/mcp.json", hooksSettingsFile: "/test/hooks.json" }]));
    const launchArguments = vi.fn(async (kind: string, role: string) => ["--legacy-test", `${kind}:${role}`]);
    const result = await openPaneManagerEnvironment(input, runner, async () => hostWith(legacy), launchArguments).manager.up(input.repository.sessionName);
    expect(result.ok ? "ok" : result.error.message).toBe("ok");
    expect(launchArguments).toHaveBeenCalledTimes(7);
    expect(starts().every(call => call.args.includes("--legacy-test"))).toBe(true);
  });

  linuxIt("refuses a prepared launch whose provider differs from the configured role provider", async () => {
    const input = withProviders(() => "codex");
    const roleLaunch = await roleLaunchesFor(input);
    roleLaunch["coordinator"] = await launchFor("coordinator", "claude");
    serverRunning(input);
    const result = await openPaneManagerEnvironment(input, runner, async () => hostWith(roleLaunch)).manager.up(input.repository.sessionName);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("configuration selects 'codex'");
    expect(starts()).toHaveLength(0);
  });
});
