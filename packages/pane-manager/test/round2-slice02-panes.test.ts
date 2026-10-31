import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { OperationOptions, OperationResult, SessionManifest } from "@bflow/contracts";
import { ROLE_PROFILE_FEATURE, pinRoleProfile } from "@bflow/contracts";
import { createHerdrSocketPort } from "../src/herdr-socket.js";
import { FileSessionManifestStore, InMemorySessionManifestStore } from "../src/manifest-store.js";
import { buildProviderRoleLaunch, buildProviderRoleLaunchFromFiles } from "../src/provider-launch.js";
import { createRolePaneManager } from "../src/role-pane-manager.js";
import { readBuiltinRolePrompt } from "../src/role-prompts.js";
import type {
  AgentLaunchProfile,
  CommandInvocation,
  CommandOutcome,
  HerdrCommandRunner,
  HerdrSocketPort,
  RolePaneManagerConfig,
  SessionManifestStore,
  WorktreeCleanlinessResult,
  WorktreeInspector
} from "../src/types.js";

type Env = Readonly<Record<string, string>>;
type Json = Record<string, unknown>;

const ROOT = "/repo";
const roots: string[] = [];
const servers: Server[] = [];
const originalOpen = fsPromises.open;

let chatSource = "";
let coordinatorSource = "";
let reviewerSource = "";

beforeAll(async () => {
  chatSource = (await readBuiltinRolePrompt("chat"))?.source ?? "";
  coordinatorSource = (await readBuiltinRolePrompt("coordinator"))?.source ?? "";
  reviewerSource = (await readBuiltinRolePrompt("reviewer"))?.source ?? "";
});

afterEach(async () => {
  if (fsPromises.open !== originalOpen) {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

class FakeHerdr implements HerdrCommandRunner {
  readonly calls: CommandInvocation[] = [];
  readonly socketCalls: { method: string; params: Json }[] = [];
  readonly workspaces = new Map<string, { id: string; label: string; activeTabId: string }>();
  readonly tabs = new Map<string, { id: string; wsId: string; label: string }>();
  readonly panes = new Map<string, { id: string; tabId: string; wsId: string; agent: string | null; cwd: string }>();
  readonly agents = new Map<string, {
    name: string;
    kind: string;
    paneId: string;
    agentStatus: string;
    interactiveReady: boolean;
    launchPending: boolean;
  }>();
  onCommand?: (invocation: CommandInvocation) => Promise<CommandOutcome | undefined> | CommandOutcome | undefined;
  onSocket?: (method: string, params: Json) => Promise<OperationResult<unknown> | undefined> | OperationResult<unknown> | undefined;
  #seq = 0;

  readonly socket: HerdrSocketPort = {
    request: async (method, params): Promise<OperationResult<unknown>> => {
      const cloned = structuredClone(params) as Json;
      this.socketCalls.push({ method, params: cloned });
      if (this.onSocket) {
        const intercepted = await this.onSocket(method, cloned);
        if (intercepted !== undefined) return intercepted;
      }
      if (method === "workspace.create") {
        return { ok: true, value: this.createWorkspace(String(params["cwd"]), String(params["label"])) };
      }
      if (method === "tab.create") {
        return { ok: true, value: this.createTab(String(params["workspace_id"]), String(params["cwd"]), String(params["label"])) };
      }
      if (method === "pane.split") {
        const targetId = String(params["target_pane_id"]);
        const source = this.panes.get(targetId);
        if (!source) {
          return { ok: false, error: { code: "not_found", retryable: false, message: "pane_not_found" } };
        }
        const cwd = typeof params["cwd"] === "string" ? params["cwd"] : source.cwd;
        const pane = this.split(targetId, cwd);
        return { ok: true, value: { type: "pane_info", pane: this.paneJson(pane.id) } };
      }
      return { ok: false, error: { code: "validation", retryable: false, message: `unsupported ${method}` } };
    }
  };

  #id(prefix: string): string {
    return `${prefix}-${++this.#seq}`;
  }

  #newPane(tabId: string, wsId: string, cwd: string): string {
    const id = this.#id("pane");
    this.panes.set(id, { id, tabId, wsId, agent: null, cwd });
    return id;
  }

  createWorkspace(cwd: string, label: string): Json {
    const wsId = this.#id("ws");
    const tabId = this.#id("tab");
    this.workspaces.set(wsId, { id: wsId, label, activeTabId: tabId });
    this.tabs.set(tabId, { id: tabId, wsId, label: "1" });
    const paneId = this.#newPane(tabId, wsId, cwd);
    return {
      type: "workspace_created",
      workspace: this.workspaceJson(wsId),
      tab: this.tabJson(tabId),
      root_pane: this.paneJson(paneId)
    };
  }

  createTab(wsId: string, cwd: string, label: string): Json {
    const tabId = this.#id("tab");
    this.tabs.set(tabId, { id: tabId, wsId, label });
    const paneId = this.#newPane(tabId, wsId, cwd);
    return { type: "tab_created", tab: this.tabJson(tabId), root_pane: this.paneJson(paneId) };
  }

  split(sourcePaneId: string, cwd: string) {
    const source = this.panes.get(sourcePaneId)!;
    const id = this.#newPane(source.tabId, source.wsId, cwd);
    return this.panes.get(id)!;
  }

  workspaceJson(id: string): Json {
    const ws = this.workspaces.get(id)!;
    return {
      workspace_id: id,
      label: ws.label,
      active_tab_id: ws.activeTabId,
      focused: false,
      pane_count: [...this.panes.values()].filter(p => p.wsId === id).length,
      tab_count: [...this.tabs.values()].filter(t => t.wsId === id).length,
      agent_status: "idle",
      number: 1
    };
  }

  tabJson(id: string): Json {
    const tab = this.tabs.get(id)!;
    return {
      tab_id: id,
      workspace_id: tab.wsId,
      number: 1,
      label: tab.label,
      focused: false,
      pane_count: [...this.panes.values()].filter(p => p.tabId === id).length,
      agent_status: "idle"
    };
  }

  paneJson(id: string): Json {
    const pane = this.panes.get(id)!;
    return {
      pane_id: id,
      terminal_id: `term-${id}`,
      workspace_id: pane.wsId,
      tab_id: pane.tabId,
      focused: false,
      agent: pane.agent,
      agent_status: "idle",
      revision: 1,
      cwd: pane.cwd
    };
  }

  agentJson(name: string): Json {
    const agent = this.agents.get(name)!;
    const pane = this.panes.get(agent.paneId)!;
    return {
      name,
      agent: agent.kind,
      pane_id: agent.paneId,
      terminal_id: `term-${agent.paneId}`,
      workspace_id: pane.wsId,
      tab_id: pane.tabId,
      focused: false,
      agent_status: agent.agentStatus,
      revision: 1,
      interactive_ready: agent.interactiveReady,
      launch_pending: agent.launchPending
    };
  }

  reply(result: Json): CommandOutcome {
    return { exitCode: 0, stdout: JSON.stringify({ id: "1", result }), stderr: "" };
  }

  fail(code: string, message = code): CommandOutcome {
    return { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code, message } }) };
  }

  async run(invocation: CommandInvocation): Promise<CommandOutcome> {
    this.calls.push(invocation);
    if (this.onCommand) {
      const intercepted = await this.onCommand(invocation);
      if (intercepted !== undefined) return intercepted;
    }
    const [domain, action, ...rest] = invocation.args;
    if (domain === "workspace" && action === "list") {
      return this.reply({ type: "workspace_list", workspaces: [...this.workspaces.keys()].map(id => this.workspaceJson(id)) });
    }
    if (domain === "workspace" && action === "create") {
      return this.reply(this.createWorkspace(flag(rest, "--cwd") ?? ROOT, flag(rest, "--label") ?? "demo"));
    }
    if (domain === "workspace" && action === "focus") {
      return this.workspaces.has(rest[0]!)
        ? this.reply({ type: "workspace_info", workspace: this.workspaceJson(rest[0]!) })
        : this.fail("workspace_not_found");
    }
    if (domain === "tab" && action === "list") {
      const ws = flag(rest, "--workspace");
      return this.reply({
        type: "tab_list",
        tabs: [...this.tabs.keys()].filter(id => this.tabs.get(id)!.wsId === ws).map(id => this.tabJson(id))
      });
    }
    if (domain === "tab" && action === "create") {
      return this.reply(this.createTab(flag(rest, "--workspace")!, flag(rest, "--cwd") ?? ROOT, flag(rest, "--label") ?? "tab"));
    }
    if (domain === "tab" && (action === "focus" || action === "rename")) {
      return this.reply({ type: "tab_info", tab: this.tabJson(rest[0]!) });
    }
    if (domain === "pane" && action === "list") {
      const ws = flag(rest, "--workspace");
      return this.reply({
        type: "pane_list",
        panes: [...this.panes.keys()].filter(id => this.panes.get(id)!.wsId === ws).map(id => this.paneJson(id))
      });
    }
    if (domain === "pane" && (action === "get" || action === "focus" || action === "rename")) {
      return this.panes.has(rest[0]!) ? this.reply({ type: "pane_info", pane: this.paneJson(rest[0]!) }) : this.fail("pane_not_found");
    }
    if (domain === "pane" && action === "split") {
      const source = this.panes.get(rest[0]!);
      if (!source) return this.fail("pane_not_found");
      const pane = this.split(rest[0]!, flag(rest, "--cwd") ?? source.cwd);
      return this.reply({ type: "pane_info", pane: this.paneJson(pane.id) });
    }
    if (domain === "pane" && action === "close") {
      const id = rest[0]!;
      if (!this.panes.has(id)) return this.fail("pane_not_found");
      this.panes.delete(id);
      for (const [name, agent] of this.agents) {
        if (agent.paneId === id) this.agents.delete(name);
      }
      return this.reply({ type: "ok" });
    }
    if (domain === "pane" && action === "process-info") {
      const id = flag(rest, "--pane") ?? rest[0]!;
      if (!this.panes.has(id)) return this.fail("pane_not_found");
      return this.reply({
        type: "pane_process_info",
        process_info: { pane_id: id, shell_pid: 4242, foreground_process_group_id: 4242, foreground_processes: [] }
      });
    }
    if (domain === "pane" && action === "layout") {
      const pane = this.panes.get(flag(rest, "--pane")!);
      if (!pane) return this.fail("pane_not_found");
      const siblings = [...this.panes.values()].filter(p => p.tabId === pane.tabId);
      return this.reply({
        type: "pane_layout",
        layout: {
          workspace_id: pane.wsId,
          tab_id: pane.tabId,
          panes: siblings.map((p, i) => ({ pane_id: p.id, rect: { x: i * 40, y: 0, width: 40, height: 40 } })),
          splits: []
        }
      });
    }
    if (domain === "agent" && action === "list") {
      return this.reply({ type: "agent_list", agents: [...this.agents.keys()].map(name => this.agentJson(name)) });
    }
    if (domain === "agent" && (action === "get" || action === "focus")) {
      const target = rest[0]!;
      const agent = this.agents.get(target) ?? [...this.agents.values()].find(a => a.paneId === target);
      return agent ? this.reply({ type: "agent_info", agent: this.agentJson(agent.name) }) : this.fail("agent_not_found");
    }
    if (domain === "agent" && action === "start") {
      const name = rest[0]!;
      const paneId = flag(rest, "--pane")!;
      const pane = this.panes.get(paneId);
      if (!pane) return this.fail("pane_not_found");
      pane.agent = flag(rest, "--kind") ?? "claude";
      this.agents.set(name, {
        name,
        kind: pane.agent,
        paneId,
        agentStatus: "idle",
        interactiveReady: true,
        launchPending: false
      });
      return this.reply({ type: "agent_started", agent: this.agentJson(name), argv: [] });
    }
    if (domain === "worktree" && (action === "create" || action === "open")) {
      const path = flag(rest, "--path")!;
      const label = flag(rest, "--label") ?? path;
      const created = this.createWorkspace(path, label);
      const wsId = (created.workspace as Json)["workspace_id"] as string;
      return this.reply({
        ...created,
        type: action === "create" ? "worktree_created" : "worktree_opened",
        worktree: {
          path,
          label,
          branch: flag(rest, "--branch") ?? null,
          is_linked_worktree: true,
          is_detached: false,
          is_bare: false,
          is_prunable: false,
          open_workspace_id: wsId
        }
      });
    }
    return this.fail(`unsupported_${String(domain)}_${String(action)}`);
  }
}

class CleanWorktreeInspector implements WorktreeInspector {
  async inspect(): Promise<OperationResult<WorktreeCleanlinessResult>> {
    return { ok: true, value: { exists: false, isClean: true, dirtyFiles: [] } };
  }
}

function makeLaunch(launchId: string, env: Env, sourceFile: string): AgentLaunchProfile {
  return {
    provider: "claude",
    launchId,
    launchFingerprint: `${launchId}-fp`,
    env,
    argv: ["--append-system-prompt-file", sourceFile]
  };
}

function baseConfig(overrides: Partial<RolePaneManagerConfig> = {}): RolePaneManagerConfig {
  return {
    sessionId: "r2-slice2-session",
    projectName: "r2-demo",
    workspaceRoot: ROOT,
    defaultAgentKind: "claude",
    maxDeveloperCapacity: 3,
    permanentRoles: ["chat", "coordinator", "reviewer"],
    roleConfigs: {
      chat: { agentKind: "claude", launch: makeLaunch("launch-chat", { BFLOW_LAUNCH_ID: "launch-chat" }, chatSource) },
      coordinator: {
        agentKind: "claude",
        launch: makeLaunch("launch-coord", { BFLOW_LAUNCH_ID: "launch-coord" }, coordinatorSource)
      },
      reviewer: {
        agentKind: "claude",
        launch: makeLaunch("launch-rev", { BFLOW_LAUNCH_ID: "launch-rev" }, reviewerSource)
      }
    },
    ...overrides
  };
}

describe("Round 2 Slice 2 — pane-manager hardening", () => {
  it("buildProviderRoleLaunchFromFiles rejects directory paths cleanly without raw EISDIR and buildProviderRoleLaunch emits valid TOML without undefined/raw DEL", async () => {
    const dir = await makeTempDir("bflow-r2-provider-launch-");
    const mcpDir = join(dir, "mcp-dir");
    const hooksFile = join(dir, "hooks.json");
    await mkdir(mcpDir, { mode: 0o700 });
    await writeFile(hooksFile, JSON.stringify({ hooks: {} }), { mode: 0o600 });

    await expect(
      buildProviderRoleLaunchFromFiles({
        agentKind: "claude",
        role: "developer",
        systemPrompt: "Role instructions",
        mcpConfigFile: mcpDir,
        hooksSettingsFile: hooksFile
      })
    ).rejects.toThrow(/regular file/i);

    const args = buildProviderRoleLaunch({
      agentKind: "codex",
      role: "developer",
      systemPrompt: "Role instructions",
      mcpServers: {
        bflow: {
          command: "/usr/bin/node",
          args: ["/host/mcp.js", "del-\x7f-char"],
          ...({ env: undefined } as unknown as Record<string, never>)
        }
      }
    });
    const joined = args.join(" ");
    expect(joined).not.toContain("=undefined");
    expect(joined).not.toContain("\x7f");
    expect(joined).toContain("\\u007f");
  });

  it("closes newly created worktree/specialist panes when mid-flight pane.split or pre-dispatch startAgentInPane fails (zero leaked Herdr panes)", async () => {
    const herdr = new FakeHerdr();
    const store = new InMemorySessionManifestStore();
    const manager = createRolePaneManager({
      config: baseConfig(),
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: new CleanWorktreeInspector()
    });
    expect((await manager.initializeTopology()).ok).toBe(true);
    const baselinePanes = new Set(herdr.panes.keys());

    // 1. Developer worktree created, then pane.split fails -> root wtPaneId MUST be closed!
    herdr.onSocket = method => {
      if (method === "pane.split") {
        return { ok: false, error: { code: "transport_unavailable", retryable: true, message: "split failed" } };
      }
      return undefined;
    };
    const splitFailed = await manager.allocateDeveloper({
      taskId: "task-split-fail",
      worktreePath: "/repo/.worktrees/task-split-fail",
      launch: makeLaunch("launch-dev-split", { BFLOW_LAUNCH_ID: "launch-dev-split" }, chatSource)
    });
    expect(splitFailed.ok).toBe(false);
    expect([...herdr.panes.keys()]).toEqual([...baselinePanes]);

    // 2. Developer worktree created + split succeeds, then startAgentInPane fails on Herdr agent start -> split pane MUST be closed!
    herdr.onSocket = undefined;
    herdr.onCommand = async invocation => {
      if (invocation.args[0] === "agent" && invocation.args[1] === "start") {
        return { exitCode: 1, stdout: "", stderr: "invalid launch flag" };
      }
      return undefined;
    };
    const promptFailed = await manager.allocateDeveloper({
      taskId: "task-prompt-fail",
      worktreePath: "/repo/.worktrees/task-prompt-fail",
      launch: {
        provider: "claude",
        launchId: "launch-bad-prompt",
        launchFingerprint: "fp-bad",
        env: { BFLOW_LAUNCH_ID: "launch-bad-prompt" },
        argv: ["--append-system-prompt-file", "/nonexistent/prompt.txt"]
      }
    });
    herdr.onCommand = undefined;
    expect(promptFailed.ok).toBe(false);
    expect([...herdr.panes.keys()]).toEqual([...baselinePanes]);

    // 3. Profiled specialist split succeeds, then startAgentInPane fails prompt validation before launchIntent -> split pane MUST be closed!
    const definition = {
      schemaVersion: 3 as const,
      profileId: "sec-reviewer",
      version: "1.0.0",
      displayName: "Security Reviewer",
      baseRole: "reviewer" as const,
      additionalInstructions: "Audit boundaries.",
      skillPins: [],
      toolRequirements: [],
      restrictions: {}
    };
    const snapshot = {
      schemaVersion: 3 as const,
      pin: pinRoleProfile(definition),
      definition,
      baseRolePolicyDigest: "a".repeat(64),
      resolutionPolicyVersion: ROLE_PROFILE_FEATURE
    };
    const specFailed = await manager.allocateSpecialist({
      role: "reviewer",
      taskId: "task-spec-fail",
      roleProfile: snapshot,
      launch: {
        provider: "claude",
        launchId: "launch-spec-bad",
        launchFingerprint: "fp-spec-bad",
        env: { BFLOW_LAUNCH_ID: "launch-spec-bad" },
        argv: ["--append-system-prompt-file", "/nonexistent/reviewer-prompt.txt"],
        roleProfile: snapshot.pin,
        features: [ROLE_PROFILE_FEATURE]
      }
    });
    expect(specFailed.ok).toBe(false);
    expect([...herdr.panes.keys()]).toEqual([...baselinePanes]);
  });

  it("inspectTopologyHealth running concurrently with allocateDeveloper and activeRunIds updates does NOT clobber new Developer bindings or activeRunIds", async () => {
    const herdr = new FakeHerdr();
    const store = new InMemorySessionManifestStore();

    let healthInspectionStartedResolve: (() => void) | undefined;
    const healthInspectionStarted = new Promise<void>(resolve => {
      healthInspectionStartedResolve = resolve;
    });
    let allowHealthFinishResolve: (() => void) | undefined;
    const allowHealthFinish = new Promise<void>(resolve => {
      allowHealthFinishResolve = resolve;
    });
    let intercepting = false;

    herdr.onCommand = async invocation => {
      if (intercepting && invocation.args[0] === "agent" && invocation.args[1] === "get") {
        intercepting = false;
        healthInspectionStartedResolve?.();
        await allowHealthFinish;
      }
      return undefined;
    };

    const manager = createRolePaneManager({
      config: baseConfig(),
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: new CleanWorktreeInspector()
    });
    expect((await manager.initializeTopology()).ok).toBe(true);

    intercepting = true;
    const healthPromise = manager.inspectTopologyHealth();
    await healthInspectionStarted;

    // While inspectTopologyHealth is mid-flight with its T0 manifest snapshot, allocate a Developer AND record activeRunIds!
    const devPrompt = (await readBuiltinRolePrompt("developer"))!.source;
    const allocated = await manager.allocateDeveloper({
      taskId: "task-concurrent-dev",
      worktreePath: "/repo/.worktrees/task-concurrent-dev",
      launch: makeLaunch("launch-concurrent-dev", { BFLOW_LAUNCH_ID: "launch-concurrent-dev" }, devPrompt)
    });
    expect(allocated.ok).toBe(true);
    if (!allocated.ok) return;

    const latestBeforeHealthSave = await store.load("r2-slice2-session");
    expect(latestBeforeHealthSave.ok && latestBeforeHealthSave.value !== null).toBe(true);
    if (!latestBeforeHealthSave.ok || !latestBeforeHealthSave.value) return;
    await store.save({
      ...latestBeforeHealthSave.value,
      activeRunIds: ["run-live-1"]
    });

    allowHealthFinishResolve?.();
    const health = await healthPromise;
    expect(health.ok).toBe(true);

    const finalLoaded = await store.load("r2-slice2-session");
    expect(finalLoaded.ok && finalLoaded.value !== null).toBe(true);
    if (!finalLoaded.ok || !finalLoaded.value) return;

    expect(finalLoaded.value.activeRunIds).toEqual(["run-live-1"]);
    expect(finalLoaded.value.panes.some(p => p.bindingId === allocated.value.bindingId)).toBe(true);
  });

  it("FileSessionManifestStore rejects directory manifest paths, tolerates FUSE/NTFS fsync EINVAL, and serializes concurrent saves", async () => {
    const dir = await makeTempDir("bflow-r2-manifest-store-");
    const fileStore = new FileSessionManifestStore(dir);

    // 1. Directory at manifest path returns corruption OperationResult (no raw EISDIR throw)
    await mkdir(join(dir, "dir-session.manifest.json"), { mode: 0o700 });
    const dirLoaded = await fileStore.load("dir-session");
    expect(dirLoaded.ok).toBe(false);
    if (!dirLoaded.ok) {
      expect(dirLoaded.error.code).toBe("corruption");
    }

    // 2. Tolerates FUSE/NTFS EINVAL on file/directory sync and serializes concurrent saves so roleProfiles conflict check cannot be bypassed
    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      handle.sync = async () => {
        const err = new Error("EINVAL: invalid argument, fsync") as NodeJS.ErrnoException;
        err.code = "EINVAL";
        throw err;
      };
      return handle;
    }) as typeof originalOpen;
    syncBuiltinESMExports();

    const definition = {
      schemaVersion: 3 as const,
      profileId: "immutable-prof",
      version: "1.0.0",
      displayName: "Immutable Prof",
      baseRole: "developer" as const,
      additionalInstructions: "Keep profile v1.",
      skillPins: [],
      toolRequirements: [],
      restrictions: {}
    };
    const snapshotV1 = {
      schemaVersion: 3 as const,
      pin: pinRoleProfile(definition),
      definition,
      baseRolePolicyDigest: "b".repeat(64),
      resolutionPolicyVersion: ROLE_PROFILE_FEATURE
    };

    const baseManifest: SessionManifest = {
      schemaVersion: 2,
      sessionId: "race-session",
      projectName: "demo",
      workspaceRoot: "/repo",
      herdrWorkspaceId: "ws-1",
      herdrTabId: "tab-1",
      status: "up",
      conversationSessionId: "race-session",
      activeRunIds: [],
      panes: [
        {
          schemaVersion: 2,
          bindingId: "bind-chat",
          sessionId: "race-session",
          role: "conversation",
          paneGroup: "conversation",
          agentId: "chat-1",
          workspaceId: "ws-1",
          tabId: "tab-1",
          paneId: "pane-chat",
          provider: "claude",
          agentKind: "claude",
          cwd: "/repo",
          isolationMode: "dedicated_pane",
          readOnlyWorkspace: true,
          transportState: "idle",
          boundAt: "2026-10-31T00:00:00.000Z"
        },
        {
          schemaVersion: 2,
          bindingId: "bind-coord",
          sessionId: "race-session",
          role: "coordinator",
          paneGroup: "coordination",
          agentId: "coord-1",
          workspaceId: "ws-1",
          tabId: "tab-1",
          paneId: "pane-coord",
          provider: "claude",
          agentKind: "claude",
          cwd: "/repo",
          isolationMode: "dedicated_pane",
          readOnlyWorkspace: true,
          transportState: "idle",
          boundAt: "2026-10-31T00:00:00.000Z"
        }
      ],
      attachTarget: { role: "conversation", paneId: "pane-chat" },
      createdAt: "2026-10-31T00:00:00.000Z",
      updatedAt: "2026-10-31T00:00:00.000Z"
    };

    // Writer 1 saves roleProfiles: [snapshotV1]; Writer 2 concurrently tries to save roleProfiles: [] (dropping immutable snapshot!).
    // Serialized queue guarantees Writer 2 runs after Writer 1 and gets rejected by snapshotConflict!
    const [firstSave, secondSave] = await Promise.all([
      fileStore.save({ ...baseManifest, roleProfiles: [snapshotV1] }),
      fileStore.save({ ...baseManifest, updatedAt: "2026-10-31T00:00:01.000Z" })
    ]);
    expect(firstSave.ok).toBe(true);
    expect(secondSave.ok).toBe(false);
    if (!secondSave.ok) {
      expect(secondSave.error.code).toBe("conflict");
    }
  });

  it("createHerdrSocketPort enforces OperationOptions.deadline, shares remaining timeout budget, and decodes split multi-byte UTF-8 chunks", async () => {
    const dir = await makeTempDir("bflow-r2-socket-");
    const socketPath = join(dir, "h.sock");

    const server = createServer(conn => {
      let buf = "";
      conn.on("data", chunk => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl)) as { id: string };
        const payload = Buffer.from(
          `${JSON.stringify({ id: req.id, result: { label: "Tiếng Việt 🚀 chuẩn" } })}\n`,
          "utf8"
        );
        // Split right inside multi-byte UTF-8 sequences ("ế" and "🚀") across 3 chunks
        const cut1 = payload.indexOf(Buffer.from("ế", "utf8")) + 1;
        const cut2 = payload.indexOf(Buffer.from("🚀", "utf8")) + 2;
        conn.write(payload.subarray(0, cut1));
        setTimeout(() => {
          conn.write(payload.subarray(cut1, cut2));
          setTimeout(() => {
            conn.write(payload.subarray(cut2));
          }, 5);
        }, 5);
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(socketPath, resolve));

    let observedStatusTimeouts: number[] = [];
    const port = createHerdrSocketPort({
      sessionId: "sock-sess",
      runner: {
        run: async invocation => {
          observedStatusTimeouts.push(invocation.timeoutMs ?? -1);
          await new Promise(resolve => setTimeout(resolve, 40));
          return {
            exitCode: 0,
            stdout: JSON.stringify({ session: "sock-sess", running: true, socket: socketPath }),
            stderr: ""
          };
        }
      }
    });

    // 1. Expired deadline fails immediately without invoking status server or connecting
    const expired = await port.request(
      "pane.split",
      {},
      { deadline: new Date(Date.now() - 50).toISOString() }
    );
    expect(expired.ok).toBe(false);
    expect(observedStatusTimeouts).toHaveLength(0);

    // 2. Near-future deadline clamps status server timeoutMs and decodes split UTF-8 response cleanly
    const okRes = await port.request(
      "pane.split",
      {},
      { deadline: new Date(Date.now() + 800).toISOString(), timeoutMs: 30_000 }
    );
    expect(okRes).toEqual({ ok: true, value: { label: "Tiếng Việt 🚀 chuẩn" } });
    expect(observedStatusTimeouts[0]).toBeLessThanOrEqual(800);
    expect(observedStatusTimeouts[0]).toBeGreaterThan(0);
  });
});
