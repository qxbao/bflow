import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManifestSchema } from "@bflow/contracts";
import { FileSessionManifestStore } from "@bflow/pane-manager";
import { EnvironmentLifecycle, PaneManagerLifecycleAdapter, createNamedPaneRunner, identifyRepository, readEnvironmentConfig, runCli,
  type EnvironmentCompositionInput } from "../src/index.js";
import { HerdrProcesses } from "./fixtures/herdr-processes.js";

describe("P12 composition with real P13 RolePaneManager", () => {
  let dir: string;
  let input: EnvironmentCompositionInput;
  let runner: HerdrProcesses;
  beforeEach(async () => {
    dir = await mkdtemp("/tmp/bflow-p12-p13-"); execFileSync("git", ["init", "--quiet", dir]);
    expect((await runCli(["init"], { cwd: dir })).ok).toBe(true);
    const repository = await identifyRepository(dir);
    input = { repository, config: await readEnvironmentConfig(repository), env: { ...process.env, HERDR_SESSION: "foreign", HERDR_SOCKET: "/foreign" } };
    runner = new HerdrProcesses();
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
  const starts = (runner: HerdrProcesses) => runner.calls.filter((r) => r.args[0] === "agent" && r.args[1] === "start");
  it("default bflow up starts all seven P13 roles and persists their real returned IDs", async () => {
    const lifecycle = new EnvironmentLifecycle(dir, { runner });
    const manifest = await lifecycle.up();
    expect(starts(runner)).toHaveLength(7); expect(manifest.panes.map((p) => p.role).sort()).toEqual(["conversation", "coordinator", "planner", "architect", "specifier", "reviewer", "qa"].sort());
    expect(manifest.status).toBe("up"); expect(new Set(manifest.panes.map((p) => p.tabId)).size).toBe(3);
    const saved = SessionManifestSchema.parse(JSON.parse(await readFile(join(dir, `.bflow/state/panes/${input.repository.sessionName}.manifest.json`), "utf8")));
    expect(saved.panes.map((p) => p.paneId)).toEqual(manifest.panes.map((p) => p.paneId));
    expect(saved.metadata?.["repositoryId"]).toBe(input.repository.id);
  });
  it("reopens composition across CLI invocations without starting duplicate agents", async () => {
    await new EnvironmentLifecycle(dir, { runner }).up();
    await new EnvironmentLifecycle(dir, { runner }).up();
    expect(starts(runner)).toHaveLength(7);
    expect(runner.calls.filter((r) => r.args[0] === "workspace" && r.args[1] === "create")).toHaveLength(1);
  });
  it("refreshes live health and focuses Conversation through P13 before the TUI", async () => {
    const lifecycle = new EnvironmentLifecycle(dir, { runner }); await lifecycle.up();
    const first = await lifecycle.status(); expect(first.liveObservation).toBe(true);
    const panes = runner.session(input.repository.sessionName).panes;
    panes.find((p) => p.name === "reviewer")!.agent_status = "blocked";
    const blocked = await lifecycle.status(); expect(blocked.manifest?.status).toBe("degraded");
    expect(blocked.manifest?.panes.find((p) => p.role === "reviewer")?.transportState).toBe("blocked");
    await lifecycle.attach();
    const last = runner.calls.findLast((r) => r.args[0] === "agent" && r.args[1] === "focus")!;
    expect(last.args[2]).toBe(blocked.manifest?.attachTarget.paneId);
    expect(runner.calls.findLast((r) => r.mode === "interactive")?.args).toEqual(["session", "attach", input.repository.sessionName]);
    expect((await lifecycle.doctor()).healthy).toBe(false);
  });
  it("detects a shell replacing an agent instead of reporting a persisted idle state", async () => {
    const lifecycle = new EnvironmentLifecycle(dir, { runner }); await lifecycle.up();
    runner.session(input.repository.sessionName).panes.find((p) => p.name === "qa-verifier")!.agent = null;
    const observed = await lifecycle.status();
    expect(observed.manifest?.panes.find((p) => p.role === "qa")?.transportState).toBe("disconnected");
  });
  it("preserves failed blocked startup and refuses duplicate dispatch", async () => {
    runner.blockedAgent = "coordinator";
    await expect(new EnvironmentLifecycle(dir, { runner }).up()).rejects.toThrow("readiness");
    const count = starts(runner).length;
    await expect(new EnvironmentLifecycle(dir, { runner }).up()).rejects.toThrow("refusing duplicate");
    expect(starts(runner)).toHaveLength(count);
    const report = await new EnvironmentLifecycle(dir, { runner }).doctor();
    expect(report.healthy).toBe(false);
    expect(report.checks.find((c) => c.checkId === "operation-recovery")?.status).toBe("failed");
  });
  it("rejects a foreign durable manifest without dispatching P13 commands", async () => {
    await new EnvironmentLifecycle(dir, { runner }).up();
    const file = join(dir, `.bflow/state/panes/${input.repository.sessionName}.manifest.json`);
    const manifest = JSON.parse(await readFile(file, "utf8")); manifest.workspaceRoot = "/other-repo";
    await writeFile(file, JSON.stringify(manifest)); const before = starts(runner).length;
    await expect(new EnvironmentLifecycle(dir, { runner }).up()).rejects.toThrow("another repository");
    expect(starts(runner)).toHaveLength(before);
  });
  it("does not report stale idle bindings as live when P13 cannot persist its health refresh", async () => {
    await new EnvironmentLifecycle(dir, { runner }).up();
    runner.session(input.repository.sessionName).panes.find((p) => p.name === "reviewer")!.agent_status = "blocked";
    vi.spyOn(FileSessionManifestStore.prototype, "save").mockResolvedValue({ ok: false, error: { code: "corruption", retryable: false, message: "disk write failed" } });
    const status = await new EnvironmentLifecycle(dir, { runner }).status();
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
  it("reports composition before up and refuses down without Runtime safety APIs", async () => {
    const lifecycle = new EnvironmentLifecycle(dir, { runner });
    const report = await lifecycle.doctor();
    expect(report.checks.find((c) => c.checkId === "p13-composition")?.status).toBe("passed");
    await lifecycle.up(); await expect(lifecycle.down(true)).rejects.toThrow("Runtime is unavailable");
    expect(runner.session(input.repository.sessionName).running).toBe(true);
  });
  it("passes cancellation to the P13 process runner without starting on an already-aborted signal", async () => {
    const controller = new AbortController(); controller.abort();
    const fake = { run: vi.fn() };
    expect(await createNamedPaneRunner(input, fake).run({ args: ["agent", "start", "chat"], signal: controller.signal })).toMatchObject({ failure: "aborted", started: false });
    expect(fake.run).not.toHaveBeenCalled();
  });
});
