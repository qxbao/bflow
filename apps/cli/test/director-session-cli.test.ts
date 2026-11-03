import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManifestSchema, type SessionLifecycleManager, type SessionManifest } from "@bflow/contracts";
import {
  EnvironmentLifecycle, environmentProcessRunner, formatUpOutput, identifyRepository, readEnvironmentConfig, renderEnvironmentConfigYaml, runCli,
  type EnvironmentCompositionInput, type EnvironmentProcessRequest, type EnvironmentProcessRunner
} from "../src/index.js";
import { PaneManagerLifecycleAdapter } from "../src/pane-manager-integration.js";
import { DIRECTOR_ROLES_REMOVED_MESSAGE, V2_SESSION_RUNNING_MESSAGE } from "../src/director-messages.js";
import { LEGACY_ROLES_IGNORED_WARNING } from "../src/environment-config.js";

const now = "2026-11-03T00:00:00.000Z";
const linuxIt = it.skipIf(process.platform !== "linux");

class Herdr implements EnvironmentProcessRunner {
  readonly calls: EnvironmentProcessRequest[] = [];
  constructor(private readonly session: string, private readonly running = true) {}
  async run(request: EnvironmentProcessRequest) {
    if (request.executable === "git") return environmentProcessRunner.run(request);
    this.calls.push(request);
    const args = request.args.join(" ");
    const value = args === "status server --json" ? { running: this.running, session: this.session, protocol: 22, compatible: true } : {};
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
  }
}

describe("Director session CLI (B2a task 8)", () => {
  let dir: string;
  let repository: Awaited<ReturnType<typeof identifyRepository>>;
  const stateFile = (name: string) => join(dir, ".bflow/state", name);

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "bflow-director-cli-")));
    execFileSync("git", ["init", "--quiet", dir]);
    expect((await runCli(["init"], { cwd: dir })).ok).toBe(true);
    repository = await identifyRepository(dir);
    await mkdir(join(dir, ".bflow/state/panes"), { recursive: true });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function writeLegacyRoles() {
    const config = await readEnvironmentConfig(repository);
    const withLegacy = { ...config, environment: { ...config.environment, roles: [
      { role: "conversation" as const, cli: "codex", required: true },
      { role: "coordinator" as const, cli: "claude", required: true },
      ...config.environment.roles
    ] } };
    delete (withLegacy as { diagnostics?: unknown }).diagnostics;
    await writeFile(join(dir, ".bflow/config.yml"), renderEnvironmentConfigYaml(withLegacy));
  }

  const v3 = (overrides: Record<string, unknown> = {}, phase = "running"): SessionManifest => SessionManifestSchema.parse({
    schemaVersion: 3, sessionId: repository.sessionName, projectName: "repo", workspaceRoot: repository.root,
    herdrWorkspaceId: "w1", herdrTabId: "w1:t1", status: "up", conversationSessionId: "conversation-1", activeRunIds: [],
    panes: [], progressPane: { tabId: "w1:t9", paneId: "w1:p9", command: ["/usr/bin/node", "/x/bin.js", "progress", "--follow"], phase, restarts: [] },
    attachTarget: { role: "progress", tabId: "w1:t9", paneId: "w1:p9" }, createdAt: now, updatedAt: now,
    metadata: { repositoryId: repository.id, sessionName: repository.sessionName }, ...overrides
  });
  const v2 = (status: "up" | "down"): SessionManifest => SessionManifestSchema.parse({
    schemaVersion: 2, sessionId: repository.sessionName, projectName: "repo", workspaceRoot: repository.root,
    herdrWorkspaceId: "w1", herdrTabId: "w1:t1", status, conversationSessionId: "conversation-1", activeRunIds: [],
    panes: ["conversation", "coordinator"].map((role, i) => ({ schemaVersion: 2, bindingId: `b-${i}`, sessionId: repository.sessionName, role,
      agentId: `agent-${i}`, workspaceId: "w1", tabId: "w1:t1", paneId: `w1:p${i}`, provider: "openai", agentKind: "codex", cwd: repository.root,
      isolationMode: "dedicated_pane", readOnlyWorkspace: role === "conversation", transportState: "idle", boundAt: now })),
    attachTarget: { role: "conversation", paneId: "w1:p0" }, createdAt: now, updatedAt: now,
    metadata: { repositoryId: repository.id, sessionName: repository.sessionName }
  });

  it("reads a configuration that still lists conversation/coordinator, filters the roles and warns", async () => {
    await writeLegacyRoles();
    const config = await readEnvironmentConfig(repository);
    expect(config.environment.roles.map(role => role.role)).not.toContain("conversation");
    expect(config.environment.roles.map(role => role.role)).not.toContain("coordinator");
    expect(config.environment.roles.length).toBeGreaterThan(0);
    expect(config.diagnostics).toEqual([LEGACY_ROLES_IGNORED_WARNING]);
    expect(LEGACY_ROLES_IGNORED_WARNING).toBe("Đã bỏ qua vai conversation/coordinator (Director thay thế). Chạy `bflow config-migrate` để gỡ khỏi cấu hình.");
  });

  it("a fresh configuration has no conversation/coordinator role and reads without a warning", async () => {
    const text = await readFile(join(dir, ".bflow/config.yml"), "utf8");
    expect(text).not.toMatch(/^\s*- role: ["']?(conversation|coordinator)/m);
    expect((await readEnvironmentConfig(repository)).diagnostics).toBeUndefined();
  });

  it("config-migrate removes the entries, keeps a .bak and is idempotent", async () => {
    await writeLegacyRoles();
    const before = await readFile(join(dir, ".bflow/config.yml"), "utf8");
    const result = await runCli(["config-migrate", "--json"], { cwd: dir });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data.removedRoles).toEqual(["conversation", "coordinator"]);
    const backups = (await readdir(join(dir, ".bflow"))).filter(name => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dir, ".bflow", backups[0]!), "utf8")).toBe(before);
    const after = await readFile(join(dir, ".bflow/config.yml"), "utf8");
    expect(after).not.toMatch(/^\s*- role: ["']?(conversation|coordinator)/m);
    expect((await readEnvironmentConfig(repository)).diagnostics).toBeUndefined();
    const text = await runCli(["config-migrate"], { cwd: dir });
    expect(text.exitCode).toBe(0);
    const repeat = await runCli(["config-migrate", "--json"], { cwd: dir });
    expect(JSON.parse(repeat.stdout).data.removedRoles).toBeUndefined();
    expect((await readdir(join(dir, ".bflow"))).filter(name => name.endsWith(".bak"))).toHaveLength(1);
  });

  it("config-migrate prints the removal sentence", async () => {
    await writeLegacyRoles();
    const result = await runCli(["config-migrate"], { cwd: dir });
    expect(result.stdout).toContain(DIRECTOR_ROLES_REMOVED_MESSAGE);
  });

  it("init --update removes the entries with a backup and reports removedRoles", async () => {
    await writeLegacyRoles();
    const result = await runCli(["init", "--update", "--no-gitnexus", "--json"], { cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.removedRoles).toEqual(["conversation", "coordinator"]);
    expect((await readdir(join(dir, ".bflow"))).filter(name => name.endsWith(".bak")).length).toBeGreaterThanOrEqual(1);
    const roles = (await readEnvironmentConfig(repository)).environment.roles.map(role => role.role);
    expect(roles).not.toContain("conversation");
    expect(roles).not.toContain("coordinator");
    expect((await readEnvironmentConfig(repository)).diagnostics).toBeUndefined();
  });

  linuxIt("up refuses a running v2 session with the exact message and never composes the integration", async () => {
    await writeFile(stateFile("session.json"), JSON.stringify(v2("up")));
    const openIntegration = vi.fn();
    const lifecycle = new EnvironmentLifecycle(dir, { runner: new Herdr(repository.sessionName, false), openIntegration });
    const failure = await lifecycle.up().then(() => undefined, (error: unknown) => error as { message: string; contractError?: { details?: { remediation?: string } } });
    expect(failure?.message).toBe(V2_SESSION_RUNNING_MESSAGE);
    expect(V2_SESSION_RUNNING_MESSAGE).toBe("Phiên v2 (có pane Conversation/Coordinator) đang chạy. Chạy `bflow down` rồi `bflow up` để nâng cấp lên phiên Director.");
    expect(failure?.contractError?.details?.remediation).toBe("bflow down");
    expect(openIntegration).not.toHaveBeenCalled();
  });

  linuxIt("attach on a v3 manifest calls attachProgress and then herdr session attach", async () => {
    await writeFile(stateFile("session.json"), JSON.stringify(v3()));
    const runner = new Herdr(repository.sessionName);
    const order: string[] = [];
    let captured: EnvironmentCompositionInput | undefined;
    const manager: SessionLifecycleManager = {
      init: vi.fn(), up: vi.fn(), down: vi.fn(),
      attach: vi.fn(async () => { order.push("attach"); return { ok: false as const, error: { code: "validation" as const, retryable: false, message: "no" } }; }),
      attachProgress: vi.fn(async () => { order.push("attachProgress"); return { ok: true as const, value: { tabId: "w1:t9", paneId: "w1:p9" } }; }),
      getManifest: vi.fn(async () => ({ ok: true as const, value: v3() })),
      doctorSession: vi.fn()
    };
    const progress: string[] = [];
    const lifecycle = new EnvironmentLifecycle(dir, { runner, onProgress: message => progress.push(message),
      openIntegration: async input => { captured = input; return { manager }; } });
    const original = runner.run.bind(runner);
    runner.run = async request => { if (request.args[0] === "session" && request.args[1] === "attach") order.push("session attach"); return original(request); };
    const manifest = await lifecycle.attach();
    expect(manifest.schemaVersion).toBe(3);
    expect(order).toEqual(["attachProgress", "session attach"]);
    expect(manager.attach).not.toHaveBeenCalled();
    expect(progress).toContain("Đang mở tab tiến trình Bflow...");
    expect(captured?.progressCommand).toBeDefined();
  });

  linuxIt("attach rejects a progress target that differs from manifest.attachTarget", async () => {
    await writeFile(stateFile("session.json"), JSON.stringify(v3()));
    const manager = {
      init: vi.fn(), up: vi.fn(), down: vi.fn(), attach: vi.fn(),
      attachProgress: vi.fn(async () => ({ ok: true as const, value: { tabId: "w1:t9", paneId: "w1:other" } })),
      getManifest: vi.fn(async () => ({ ok: true as const, value: v3() })), doctorSession: vi.fn()
    } as unknown as SessionLifecycleManager;
    const runner = new Herdr(repository.sessionName);
    const lifecycle = new EnvironmentLifecycle(dir, { runner, openIntegration: async () => ({ manager }) });
    await expect(lifecycle.attach()).rejects.toThrow(/incorrect progress attach target/);
    expect(runner.calls.some(call => call.args[0] === "session" && call.args[1] === "attach")).toBe(false);
  });

  linuxIt("the composition receives an absolute progressCommand ending in progress --follow", async () => {
    await writeFile(stateFile("session.json"), JSON.stringify(v3()));
    let captured: EnvironmentCompositionInput | undefined;
    const manager = { init: vi.fn(), up: vi.fn(), down: vi.fn(), attach: vi.fn(),
      attachProgress: vi.fn(async () => ({ ok: true as const, value: { tabId: "w1:t9", paneId: "w1:p9" } })),
      getManifest: vi.fn(async () => ({ ok: true as const, value: v3() })), doctorSession: vi.fn() } as unknown as SessionLifecycleManager;
    await new EnvironmentLifecycle(dir, { runner: new Herdr(repository.sessionName), openIntegration: async input => { captured = input; return { manager }; } }).attach();
    const command = captured!.progressCommand!;
    expect(command.slice(-2)).toEqual(["progress", "--follow"]);
    expect(command.slice(0, -2).length).toBeGreaterThanOrEqual(2);
    expect(command.slice(0, -2).every(part => isAbsolute(part))).toBe(true);
  });

  describe("PaneManagerLifecycleAdapter on a v3 manifest", () => {
    const input = (): EnvironmentCompositionInput => ({ repository, env: {}, config: undefined as never });
    async function adapter(manifest: SessionManifest) {
      await writeFile(join(dir, ".bflow/state/panes", `${repository.sessionName}.manifest.json`), JSON.stringify(manifest));
      const config = await readEnvironmentConfig(repository);
      return new PaneManagerLifecycleAdapter({ ...input(), config, progressCommand: ["/usr/bin/node", "/x/bin.js", "progress", "--follow"] },
        new Herdr(repository.sessionName, false));
    }

    it("attach fails with the attachProgress hint", async () => {
      const result = await (await adapter(v3())).attach(repository.sessionName);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe("Director session: use attachProgress");
    });

    it("doctor passes director-progress-pane when running", async () => {
      const report = await (await adapter(v3())).doctorSession({ workspaceRoot: repository.root });
      expect(report.checks.find(check => check.checkId === "director-progress-pane")?.status).toBe("passed");
    });

    it("doctor warns when the progress pane is not running", async () => {
      const report = await (await adapter(v3({ status: "degraded" }, "failed"))).doctorSession({ workspaceRoot: repository.root });
      const check = report.checks.find(item => item.checkId === "director-progress-pane");
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("bflow up");
      expect(report.healthy).toBe(true);
    });
  });

  describe("formatters", () => {
    it("up shows the progress tab and the Director guidance line", () => {
      const text = formatUpOutput(v3(), false, false);
      expect(text).toContain("Tab tiến trình: pane w1:p9 (running)");
      expect(text).not.toContain("để mở lại");
      expect(text).toContain("Hạ tầng Bflow đã sẵn sàng. Phiên làm việc bắt đầu khi bạn mở CLI (Claude Code/Codex/Agy) trong kho này và chạy /bflow-start.");
    });
    it("up hints at bflow up when the progress pane is not running", () => {
      expect(formatUpOutput(v3({ status: "degraded" }, "failed"), false, true)).toContain("Tab tiến trình: pane w1:p9 (failed) — chạy `bflow up` để mở lại");
    });
    it("v2 output is unchanged", () => {
      const text = formatUpOutput(v2("up"), false, true);
      expect(text).toContain("Khung chat:");
      expect(text).not.toContain("Tab tiến trình");
    });
  });
});
