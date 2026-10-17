import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManifestSchema } from "@bflow/contracts";
import { FileSessionManifestStore } from "@bflow/pane-manager";
import { EnvironmentLifecycle, PaneManagerLifecycleAdapter, createNamedPaneRunner, identifyRepository, readEnvironmentConfig, runCli, openPaneManagerEnvironment,
  type EnvironmentCompositionInput } from "../src/index.js";
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
  linuxIt("preserves failed blocked startup and refuses duplicate dispatch", async () => {
    runner.blockedAgent = "coordinator";
    await expect(lifecycle().up()).rejects.toThrow("CLI update confirmation");
    try { await lifecycle().up(); } catch (error) {
      const message = String(error); expect(message).toContain(input.repository.sessionName); expect(message).toContain("pane");
      expect(message).toContain("bflow up"); expect(message).toContain("do not delete .bflow");
    }
    const count = starts(runner).length;
    await expect(lifecycle().up()).rejects.toThrow("blocked");
    expect(starts(runner)).toHaveLength(count);
    const report = await lifecycle().doctor();
    expect(report.healthy).toBe(false);
    expect(report.checks.find((c) => c.checkId === "operation-recovery")?.status).toBe("failed");
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
  linuxIt("shuts down a partial non-Claude startup with the default openLifecycleHost without blocking on Claude hook validation", async () => {
    const defaultLifecycle = new EnvironmentLifecycle(dir, {
      runner,
      openIntegration: async composition => openPaneManagerEnvironment(composition, runner)
    });
    await expect(defaultLifecycle.up()).rejects.toThrow("requires Claude native hooks");
    expect(runner.session(input.repository.sessionName).running).toBe(true);
    const stopped = await defaultLifecycle.down(true);
    expect(stopped).toMatchObject({ server: "stopped", manifest: null });
    expect(runner.session(input.repository.sessionName).running).toBe(false);
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
