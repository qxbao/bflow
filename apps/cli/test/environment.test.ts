import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionManifestSchema, type SessionLifecycleManager, type SessionManifest, type RuntimeService,
  type RecoveryCheckpoint, type WorkflowRunSnapshot, type CreateCheckpointCommand
} from "@bflow/contracts";
import { EnvironmentError, EnvironmentLifecycle, identifyRepository, main, namedSessionEnvironment, parseCliArgs, runCli,
  environmentProcessRunner, type EnvironmentConfig, type EnvironmentProcessRequest, type EnvironmentProcessRunner } from "../src/index.js";
import { PaneManagerLifecycleAdapter } from "../src/pane-manager-integration.js";

const now = "2026-10-16T00:00:00.000Z";
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
  async run(request: EnvironmentProcessRequest) {
    this.requests.push(request);
    if (request.executable === "git") return environmentProcessRunner.run(request);
    if (this.missing.has(request.executable)) throw new Error(`ENOENT ${request.executable}`);
    const session = request.env?.["HERDR_SESSION"] ?? "incorrect-default";
    const args = request.args.join(" ");
    if (args === "login status") return { exitCode: this.authenticated ? 0 : 1, stdout: "", stderr: this.authenticated ? "Logged in" : "secret-account-information" };
    if (args === "auth status --json") return { exitCode: 0, stdout: JSON.stringify(this.claudeStatus), stderr: "" };
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
      await expect(readFile(join(other, ".bflow/config.yaml"))).rejects.toThrow();
    } finally { await rm(other, { recursive: true, force: true }); }
  });
  it("fails startup before launching Herdr when provider is not authenticated and redacts auth diagnostics", async () => {
    runner.authenticated = false;
    await expect(lifecycle.up()).rejects.toThrow("not authenticated");
    expect(runner.requests.some(request => request.args[0] === "server")).toBe(false);
    expect(fixture.manager.up).not.toHaveBeenCalled();
    const report = await lifecycle.doctor();
    expect(report.healthy).toBe(false);
    expect(report.checks.find(check => check.checkId === "auth-codex")?.status).toBe("failed");
    expect(JSON.stringify(report)).not.toContain("secret-account-information");
  });
  it("reconciles manager_pending only with an existing validated physical manifest", async () => {
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
  it("can shut down a failed first startup using the manager's durable topology receipt", async () => {
    vi.mocked(fixture.manager.up).mockImplementation(async () => {
      fixture.set({ ...fixture.create(), status: "degraded" });
      throw new Error("role blocked after receipt persisted");
    });
    await expect(lifecycle.up()).rejects.toThrow("role blocked");
    await expect(readFile(join(dir, ".bflow/state/session.json"))).rejects.toThrow();
    const stopped = await lifecycle.down(true);
    expect(stopped.status).toBe("down");
    expect(fixture.manager.down).toHaveBeenCalledTimes(1);
    expect(runner.running.has(repository.sessionName)).toBe(false);
  });
  it("requires an authenticated Claude status payload rather than accepting exit zero alone", async () => {
    const path = join(dir, ".bflow/config.yaml");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.environment.roles = config.environment.roles.map((role: object) => ({ ...role, cli: "claude" }));
    await writeFile(path, JSON.stringify(config));
    runner.claudeStatus = { loggedIn: false, email: "private-account@example.test" };
    await expect(lifecycle.up()).rejects.toThrow("not authenticated");
    expect(fixture.manager.up).not.toHaveBeenCalled();
    const report = await lifecycle.doctor();
    expect(report.checks.find(check => check.checkId === "auth-claude")?.status).toBe("failed");
    expect(JSON.stringify(report)).not.toContain("private-account@example.test");
  });
  it("activates the real host only after roles are ready and does not report ready when host startup fails", async () => {
    const activate = vi.fn(async () => { throw new Error("host startup failed"); });
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, activate } });
    await expect(composed.up()).rejects.toThrow("host startup failed");
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ status: "up" }), expect.any(Object));
    const state = JSON.parse(await readFile(join(dir, ".bflow/state/operation.json"), "utf8"));
    expect(state.phase).toBe("manager_pending");
  });
  it("waits for authenticated native startup receipts without resending role startup", async () => {
    const activate = vi.fn(async () => undefined).mockRejectedValueOnce(new EnvironmentError({ code: "conflict", retryable: true,
      message: "Native hook is still publishing its receipt", details: { stage: "native_startup" } }));
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, activate } });
    expect((await composed.up()).status).toBe("up");
    expect(activate).toHaveBeenCalledTimes(2); expect(fixture.manager.up).toHaveBeenCalledTimes(1);
    expect(runner.requests.filter(r => r.args[0] === "server")).toHaveLength(1);
  });
  it("retains actionable native-hook context when activation readiness times out", async () => {
    const activate = vi.fn(async () => { throw new EnvironmentError({ code: "conflict", retryable: true,
      message: "Coordinator pane pane-7 is still publishing its native receipt", details: { stage: "native_startup" } }); });
    const composed = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, activate } });
    await expect(composed.up(350)).rejects.toThrow("Coordinator pane pane-7");
    expect(fixture.manager.up).toHaveBeenCalledTimes(1);
  });
  it("resolves nested and symlink paths to the same repository", async () => {
    await mkdir(join(dir, "nested")); await symlink(dir, join(dir, "alias"));
    expect(await identifyRepository(join(dir, "nested"))).toEqual(repository);
    expect(await identifyRepository(join(dir, "alias"))).toEqual(repository);
    expect((await runCli(["init"], { cwd: join(dir, "nested") })).ok).toBe(true);
    await expect(readFile(join(dir, "nested/.bflow/config.yaml"))).rejects.toThrow();
  });
  it("separates two repositories with the same basename", async () => {
    const a = join(dir, "a/same"); const b = join(dir, "b/same");
    await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
    execFileSync("git", ["init", "--quiet", a]); execFileSync("git", ["init", "--quiet", b]);
    expect((await identifyRepository(a)).sessionName).not.toBe((await identifyRepository(b)).sessionName);
  });
  it("preserves config on repeat init and ignores state/log/secrets without hiding config", async () => {
    const before = await readFile(join(dir, ".bflow/config.yaml"), "utf8");
    await runCli(["init", "--name", "replacement"], { cwd: dir, environment: { runner } });
    expect(await readFile(join(dir, ".bflow/config.yaml"), "utf8")).toBe(before);
    const ignore = await readFile(join(dir, ".bflow/.gitignore"), "utf8");
    expect(ignore.match(/secrets\//g)).toHaveLength(1); expect(ignore).not.toContain("config.yaml");
    execFileSync("git", ["check-ignore", ".bflow/state/run", ".bflow/logs/log", ".bflow/secrets/token"], { cwd: dir });
    expect(runner.requests).toHaveLength(0);
  });
  it("initializes Claude roles explicitly and preserves existing provider selection on repeat init", async () => {
    const other = await mkdtemp("/tmp/bflow-provider-init-");
    try {
      execFileSync("git", ["init", "--quiet", other]);
      expect((await runCli(["init", "--provider", "claude"], { cwd: other })).ok).toBe(true);
      const path = join(other, ".bflow/config.yaml");
      const before = await readFile(path, "utf8");
      expect(JSON.parse(before).environment.roles.every((role: { cli: string }) => role.cli === "claude")).toBe(true);
      expect((await runCli(["init", "--provider", "codex"], { cwd: other })).ok).toBe(true);
      expect(await readFile(path, "utf8")).toBe(before);
    } finally { await rm(other, { recursive: true, force: true }); }
  });
  it("rejects an unsupported provider before writing any configuration", async () => {
    const other = await mkdtemp("/tmp/bflow-provider-invalid-");
    try {
      execFileSync("git", ["init", "--quiet", other]);
      expect(parseCliArgs(["init", "--provider", "arbitrary-command"]).ok).toBe(false);
      expect((await runCli(["init", "--provider", "arbitrary-command"], { cwd: other })).ok).toBe(false);
      await expect(readFile(join(other, ".bflow/config.yaml"))).rejects.toThrow();
    } finally { await rm(other, { recursive: true, force: true }); }
  });
  it("starts a headless server and reuses ready roles without duplicate startup", async () => {
    const first = await lifecycle.up(); const second = await lifecycle.up();
    expect(first.sessionId).toBe(second.sessionId); expect(fixture.manager.up).toHaveBeenCalledTimes(1);
    expect(runner.requests.filter((r) => r.mode === "background")).toHaveLength(1);
    const saved = SessionManifestSchema.parse(JSON.parse(await readFile(join(dir, ".bflow/state/session.json"), "utf8")));
    expect(saved.metadata?.["repositoryId"]).toBe(repository.id); expect(saved.panes).toHaveLength(roles.length);
  });
  it("does not fabricate success when the default P13 receives malformed topology responses", async () => {
    await expect(new EnvironmentLifecycle(dir, { runner,
      openIntegration: async input => ({ manager: new PaneManagerLifecycleAdapter(input, runner) }) }).up()).rejects.toThrow();
    expect(runner.requests.some((r) => r.args[0] === "workspace" && r.args[1] === "list")).toBe(true);
  });
  it("rejects attach before up without starting any session", async () => {
    await expect(lifecycle.attach()).rejects.toThrow("Run bflow up");
    expect(runner.requests.filter((r) => r.executable === "herdr")).toHaveLength(0);
  });
  it("focuses Conversation through the manager before opening the matching named TUI", async () => {
    await lifecycle.up(); await lifecycle.attach();
    expect(fixture.manager.attach).toHaveBeenCalledWith(repository.sessionName, expect.any(Object));
    const attach = runner.requests.find((r) => r.mode === "interactive")!;
    expect(attach.args).toEqual(["session", "attach", repository.sessionName]);
    expect(attach.env?.["HERDR_SESSION"]).toBe(repository.sessionName);
  });
  it("rejects a manager attach target belonging to another role", async () => {
    await lifecycle.up(); vi.mocked(fixture.manager.attach).mockResolvedValue({ ok: true, value: fixture.get().panes[1]! });
    await expect(lifecycle.attach()).rejects.toThrow("incorrect Conversation");
    expect(runner.requests.some((r) => r.mode === "interactive")).toBe(false);
  });
  it("reports blocked startup and re-observes without duplicate agents", async () => {
    const manifest = fixture.create(); manifest.panes[1]!.transportState = "blocked";
    vi.mocked(fixture.manager.up).mockImplementation(async () => { fixture.set(manifest); return { ok: true, value: manifest }; });
    await expect(lifecycle.up()).rejects.toThrow("coordinator' is blocked");
    await expect(lifecycle.up()).rejects.toThrow("blocked"); expect(fixture.manager.up).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(await readFile(join(dir, ".bflow/state/session.json"), "utf8")); expect(saved.status).toBe("degraded");
  });
  it("does not report success when a required role is missing", async () => {
    const partial = fixture.create(); partial.panes = partial.panes.filter((p) => p.role !== "reviewer");
    vi.mocked(fixture.manager.up).mockImplementation(async () => { fixture.set(partial); return { ok: true, value: partial }; });
    await expect(lifecycle.up(500)).rejects.toThrow("timed out");
    expect(fixture.manager.up).toHaveBeenCalledTimes(1);
  });
  it("retains uncertain startup and forbids automatic resend", async () => {
    vi.mocked(fixture.manager.up).mockImplementation(async () => new Promise(() => {}));
    await expect(lifecycle.up(500)).rejects.toThrow("timed out");
    await expect(lifecycle.up()).rejects.toThrow("refusing duplicate"); expect(fixture.manager.up).toHaveBeenCalledTimes(1);
  });
  it("reports server launch failure without creating roles", async () => {
    runner.serverFails = true;
    await expect(lifecycle.up()).rejects.toThrow("cannot bind"); expect(fixture.manager.up).not.toHaveBeenCalled();
  });
  it("refuses a foreign manifest and never touches its session", async () => {
    const foreign = { ...fixture.create(), sessionId: "foreign" };
    await mkdir(join(dir, ".bflow/state")); await writeFile(join(dir, ".bflow/state/session.json"), JSON.stringify(foreign));
    await expect(lifecycle.attach()).rejects.toThrow(); await expect(lifecycle.down(true)).rejects.toThrow();
    expect(runner.requests.some((r) => r.args.includes("stop"))).toBe(false);
  });
  it("refuses an existing named session without ownership evidence", async () => {
    runner.running.add(repository.sessionName);
    await expect(lifecycle.up()).rejects.toThrow("ownership evidence"); expect(fixture.manager.up).not.toHaveBeenCalled();
  });
  it("serializes lifecycle mutations with a repository lock", async () => {
    await mkdir(join(dir, ".bflow/state/lifecycle.lock"), { recursive: true });
    await expect(lifecycle.up()).rejects.toThrow("legacy lifecycle lock");
    expect(fixture.manager.up).not.toHaveBeenCalled();
    const config = await readFile(join(dir, ".bflow/config.yaml"), "utf8");
    const recovered = await runCli(["recover", "--yes", "--json"], { cwd: dir, environment: { runner, integration: { manager: fixture.manager } } });
    expect(recovered.ok).toBe(true); expect(JSON.parse(recovered.stdout).command).toBe("recover");
    expect(await readFile(join(dir, ".bflow/config.yaml"), "utf8")).toBe(config);
    expect((await lifecycle.up()).status).toBe("up");
  });
  it("requires confirmation for active runs and does not stop agents", async () => {
    await lifecycle.up();
    const runtime = mockRuntime([activeRun]);
    lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime } });
    await expect(lifecycle.down()).rejects.toThrow("1 active runs"); expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  it("never bypasses checkpoints with --yes", async () => {
    await lifecycle.up(); lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime([activeRun]) } });
    await expect(lifecycle.down(true)).rejects.toThrow("checkpoint/quiesce API"); expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  it("checkpoints active runs before graceful shutdown and stops only the selected named session", async () => {
    await lifecycle.up(); runner.running.add("other-repository");
    const save = vi.fn(async (command: CreateCheckpointCommand) => ({ ok: true as const, value: checkpoint(command) }));
    lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime([activeRun]), quiesce: async () => ({ ok: true, value: undefined }), checkpoint: save } });
    const stopped = await lifecycle.down(true);
    expect(stopped.status).toBe("down"); expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fixture.manager.down).mock.invocationCallOrder[0]!);
    expect(runner.running.has("other-repository")).toBe(true); expect(runner.running.has(repository.sessionName)).toBe(false);
    expect(runner.requests.filter((r) => r.args.includes("stop")).map((r) => r.args)).toEqual([["session", "stop", repository.sessionName, "--json"]]);
    expect((await lifecycle.down()).status).toBe("down"); expect(fixture.manager.down).toHaveBeenCalledTimes(1);
    expect(await readFile(join(dir, ".bflow/config.yaml"), "utf8")).toContain("defaultWorkflow");
  });
  it("rejects a checkpoint for a different run", async () => {
    await lifecycle.up();
    lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime([activeRun]), quiesce: async () => ({ ok: true, value: undefined }), checkpoint: async (command) => ({ ok: true, value: { ...checkpoint(command), runId: "foreign" } }) } });
    await expect(lifecycle.down(true)).rejects.toThrow("invalid aggregate checkpoint"); expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  it("requires confirmation for dirty files and keeps them after down", async () => {
    await lifecycle.up(); await writeFile(join(dir, "keep-me.txt"), "preserve");
    await expect(lifecycle.down()).rejects.toThrow("uncommitted changes"); await lifecycle.down(true);
    expect(await readFile(join(dir, "keep-me.txt"), "utf8")).toBe("preserve");
  });
  it("recollects and checkpoints a run that appeared before the shutdown barrier", async () => {
    await lifecycle.up();
    const runs: WorkflowRunSnapshot[] = [];
    const save = vi.fn(async (command: CreateCheckpointCommand) => ({ ok: true as const, value: checkpoint(command) }));
    lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime(runs),
      quiesce: async () => { runs.push(activeRun); return { ok: true, value: undefined }; }, checkpoint: save } });
    await lifecycle.down(true);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ runId: activeRun.runId }), expect.any(Object));
  });
  it("refuses shutdown when the Runtime barrier is not composed", async () => {
    await lifecycle.up();
    lifecycle = new EnvironmentLifecycle(dir, { runner, integration: { manager: fixture.manager, runtime: mockRuntime() } });
    await expect(lifecycle.down(true)).rejects.toThrow("shutdown barrier");
    expect(fixture.manager.down).not.toHaveBeenCalled();
  });
  it("does not force-stop after graceful shutdown times out", async () => {
    await lifecycle.up(); vi.mocked(fixture.manager.down).mockImplementation(async () => new Promise(() => {}));
    await expect(lifecycle.down(true, 500)).rejects.toThrow("timed out");
    expect(runner.requests.some((r) => r.args.includes("stop"))).toBe(false);
    vi.mocked(fixture.manager.down).mockImplementation(async () => ({ ok: true, value: { ...fixture.get(), status: "down" } }));
    expect((await lifecycle.down(true)).status).toBe("down");
    expect(fixture.manager.down).toHaveBeenCalledTimes(2);
    expect(runner.running.has(repository.sessionName)).toBe(false);
  });
  it("reports live server, panes and agent state", async () => {
    await lifecycle.up(); const status = await lifecycle.status();
    expect(status.server).toBe("running"); expect(status.liveObservation).toBe(true); expect(status.manifest?.panes).toHaveLength(7);
  });
  it("cancels an in-flight up and resumes the same saved topology without deleting state", async () => {
    const abort = new AbortController(), sentinel = join(dir, "notes.txt"); await writeFile(sentinel, "uncommitted work");
    const original = fixture.manager.up;
    vi.mocked(fixture.manager.up).mockImplementationOnce(async () => {
      fixture.set({ ...fixture.create(), status: "initializing" });
      await new Promise(() => {}); return { ok: true, value: fixture.get() };
    });
    const interrupted = new EnvironmentLifecycle(dir, { runner, signal: abort.signal, integration: { manager: fixture.manager } });
    const pending = interrupted.up();
    await expect.poll(() => vi.mocked(original).mock.calls.length).toBe(1); abort.abort();
    await expect(pending).rejects.toMatchObject({ contractError: { code: "cancelled" } });
    expect((await lifecycle.up()).status).toBe("up");
    expect(runner.requests.filter(r => r.args[0] === "server")).toHaveLength(1);
    expect(await readFile(sentinel, "utf8")).toBe("uncommitted work");
  });
  it("recovers a pre-manifest stopped startup and keeps configuration intact", async () => {
    const config = await readFile(join(dir, ".bflow/config.yaml"), "utf8");
    await mkdir(join(dir, ".bflow/state"), { recursive: true });
    await writeFile(join(dir, ".bflow/state/operation.json"), JSON.stringify({ repositoryId: repository.id, sessionName: repository.sessionName, phase: "server_starting" }));
    await expect(lifecycle.up()).rejects.toThrow("bflow recover --yes");
    await expect(lifecycle.recover()).rejects.toThrow("recover --yes");
    await lifecycle.recover(true); expect((await lifecycle.up()).status).toBe("up");
    expect(await readFile(join(dir, ".bflow/config.yaml"), "utf8")).toBe(config);
  });
  it("stops a server-only partial startup after the runtime barrier and rejects active work", async () => {
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
  it("finishes a retained host after the Herdr server has already stopped", async () => {
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
    const path = join(dir, ".bflow/config.yaml"); const config: EnvironmentConfig = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...config, environment: { ...config.environment, repositoryId: "other" } }));
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
  it.each(["up", "down", "attach", "doctor", "recover"])("supports %s and its help", (command) => {
    expect(parseCliArgs([command, "--json"]).ok).toBe(true); expect(parseCliArgs([command, "--help"]).ok).toBe(true);
  });
  it.each([["up", "--timeout", "0"], ["down", "--timeout", "NaN"], ["up", "--timeout", "600001"], ["up", "--yes"], ["attach", "--timeout", "10"], ["doctor", "extra"]])("rejects invalid flags %s %s", (...args) => {
    expect(parseCliArgs(args).ok).toBe(false);
  });
  it("removes inherited socket, remote and caller pane context", () => {
    expect(namedSessionEnvironment("repo-session", { PATH: "/bin", HERDR_SOCKET: "/wrong", HERDR_PANE_ID: "other", HERDR_SESSION: "other", HERDR_ENV: "1", HERDR_CONFIG_PATH: "/explicit/config" }))
      .toEqual({ PATH: "/bin", HERDR_CONFIG_PATH: "/explicit/config", HERDR_SESSION: "repo-session" });
  });
});
