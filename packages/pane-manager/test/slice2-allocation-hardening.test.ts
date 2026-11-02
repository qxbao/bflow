import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OperationOptions, OperationResult, SessionManifest } from "@bflow/contracts";
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
import { createRolePaneManager } from "../src/role-pane-manager.js";
import { InMemorySessionManifestStore } from "../src/manifest-store.js";
import { readBuiltinRolePrompt } from "../src/role-prompts.js";

type Env = Readonly<Record<string, string>>;
type Json = Record<string, unknown>;

const ROOT = "/repo";

let chatSource = "";
let coordinatorSource = "";
beforeAll(async () => {
  chatSource = (await readBuiltinRolePrompt("chat"))?.source ?? "";
  coordinatorSource = (await readBuiltinRolePrompt("coordinator"))?.source ?? "";
});

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

class HardeningHerdrFake implements HerdrCommandRunner {
  readonly calls: CommandInvocation[] = [];
  readonly socketCalls: { method: string; params: Json }[] = [];
  readonly paneEnv = new Map<string, Env>();
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
  #seq = 0;

  readonly socket: HerdrSocketPort = {
    request: async (method, params): Promise<OperationResult<unknown>> => {
      this.socketCalls.push({ method, params: structuredClone(params) as Json });
      const env = params["env"] as Env | undefined;
      if (method === "workspace.create") {
        return { ok: true, value: this.createWorkspace(String(params["cwd"]), String(params["label"]), env) };
      }
      if (method === "tab.create") {
        return {
          ok: true,
          value: this.createTab(String(params["workspace_id"]), String(params["cwd"]), String(params["label"]), env)
        };
      }
      if (method === "pane.split") {
        const targetId = String(params["target_pane_id"]);
        const source = this.panes.get(targetId);
        if (!source) {
          return {
            ok: false,
            error: { code: "not_found", retryable: false, message: `Herdr ${method} target was not found (pane_not_found)` }
          };
        }
        const cwd = typeof params["cwd"] === "string" ? params["cwd"] : source.cwd;
        const pane = this.split(targetId, cwd, env);
        return { ok: true, value: { type: "pane_info", pane: this.paneJson(pane.id) } };
      }
      return { ok: false, error: { code: "validation", retryable: false, message: `unsupported ${method}` } };
    }
  };

  #id(prefix: string): string {
    return `${prefix}-${++this.#seq}`;
  }

  #newPane(tabId: string, wsId: string, cwd: string, env: Env | undefined): string {
    const id = this.#id("pane");
    this.panes.set(id, { id, tabId, wsId, agent: null, cwd });
    if (env !== undefined) this.paneEnv.set(id, { ...env });
    return id;
  }

  createWorkspace(cwd: string, label: string, env: Env | undefined): Json {
    const wsId = this.#id("ws");
    const tabId = this.#id("tab");
    this.workspaces.set(wsId, { id: wsId, label, activeTabId: tabId });
    this.tabs.set(tabId, { id: tabId, wsId, label: "1" });
    const paneId = this.#newPane(tabId, wsId, cwd, env);
    return {
      type: "workspace_created",
      workspace: this.workspaceJson(wsId),
      tab: this.tabJson(tabId),
      root_pane: this.paneJson(paneId)
    };
  }

  createTab(wsId: string, cwd: string, label: string, env: Env | undefined): Json {
    const tabId = this.#id("tab");
    this.tabs.set(tabId, { id: tabId, wsId, label });
    const paneId = this.#newPane(tabId, wsId, cwd, env);
    return { type: "tab_created", tab: this.tabJson(tabId), root_pane: this.paneJson(paneId) };
  }

  split(sourcePaneId: string, cwd: string, env: Env | undefined) {
    const source = this.panes.get(sourcePaneId);
    if (!source) throw new Error(`pane not found ${sourcePaneId}`);
    const id = this.#newPane(source.tabId, source.wsId, cwd, env);
    return this.panes.get(id)!;
  }

  workspaceJson(id: string): Json {
    const ws = this.workspaces.get(id)!;
    const paneCount = [...this.panes.values()].filter(p => p.wsId === id).length;
    const tabCount = [...this.tabs.values()].filter(t => t.wsId === id).length;
    return {
      workspace_id: id,
      label: ws.label,
      active_tab_id: ws.activeTabId,
      focused: false,
      pane_count: paneCount,
      tab_count: tabCount,
      agent_status: "idle",
      number: 1
    };
  }

  tabJson(id: string): Json {
    const tab = this.tabs.get(id)!;
    const paneCount = [...this.panes.values()].filter(p => p.tabId === id).length;
    return {
      tab_id: id,
      workspace_id: tab.wsId,
      number: 1,
      label: tab.label,
      focused: false,
      pane_count: paneCount,
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
      return this.reply(this.createWorkspace(flag(rest, "--cwd") ?? ROOT, flag(rest, "--label") ?? "demo", undefined));
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
      return this.reply(this.createTab(flag(rest, "--workspace")!, flag(rest, "--cwd") ?? ROOT, flag(rest, "--label") ?? "tab", undefined));
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
    if (domain === "pane" && action === "get") {
      return this.panes.has(rest[0]!) ? this.reply({ type: "pane_info", pane: this.paneJson(rest[0]!) }) : this.fail("pane_not_found");
    }
    if (domain === "pane" && action === "split") {
      const source = this.panes.get(rest[0]!);
      if (!source) return this.fail("pane_not_found");
      const pane = this.split(rest[0]!, flag(rest, "--cwd") ?? source.cwd, undefined);
      return this.reply({ type: "pane_info", pane: this.paneJson(pane.id) });
    }
    if (domain === "pane" && action === "close") {
      const id = rest[0]!;
      if (!this.panes.has(id)) return this.fail("pane_not_found", `pane ${id} not found`);
      this.panes.delete(id);
      for (const [name, agent] of this.agents) {
        if (agent.paneId === id) this.agents.delete(name);
      }
      return this.reply({ type: "ok" });
    }
    if (domain === "pane" && action === "rename") {
      return this.panes.has(rest[0]!) ? this.reply({ type: "pane_info", pane: this.paneJson(rest[0]!) }) : this.fail("pane_not_found");
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
      if (this.agents.has(name) && this.agents.get(name)!.paneId !== paneId) {
        return this.fail("confirmation_required", `agent ${name} already exists`);
      }
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
      const created = this.createWorkspace(path, label, undefined);
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
    if (domain === "worktree" && action === "remove") {
      const wsId = flag(rest, "--workspace")!;
      if (!this.workspaces.has(wsId)) return this.fail("workspace_not_found", `workspace ${wsId} not found`);
      this.workspaces.delete(wsId);
      for (const [tabId, tab] of this.tabs) {
        if (tab.wsId === wsId) this.tabs.delete(tabId);
      }
      for (const [paneId, pane] of this.panes) {
        if (pane.wsId === wsId) {
          this.panes.delete(paneId);
          for (const [name, agent] of this.agents) {
            if (agent.paneId === paneId) this.agents.delete(name);
          }
        }
      }
      return this.reply({ type: "worktree_removed", workspace_id: wsId, path: "/worktree", forced: false });
    }
    return this.fail(`unsupported_${String(domain)}_${String(action)}`);
  }
}

class MutableWorktreeInspector implements WorktreeInspector {
  readonly states = new Map<string, WorktreeCleanlinessResult>();

  set(path: string, state: WorktreeCleanlinessResult): void {
    this.states.set(path, state);
  }

  async inspect(path: string): Promise<OperationResult<WorktreeCleanlinessResult>> {
    return {
      ok: true,
      value: this.states.get(path) ?? { exists: false, isClean: true, dirtyFiles: [] }
    };
  }
}

function makeLaunch(launchId: string, env: Env, argv?: string[]): AgentLaunchProfile {
  return {
    provider: "claude",
    launchId,
    launchFingerprint: `${launchId}-fp`,
    env,
    argv: argv ?? ["--append-system-prompt-file", chatSource]
  };
}

function baseConfig(overrides: Partial<RolePaneManagerConfig> = {}): RolePaneManagerConfig {
  return {
    sessionId: "slice2-hardening-session",
    projectName: "slice2-demo",
    workspaceRoot: ROOT,
    defaultAgentKind: "claude",
    maxDeveloperCapacity: 3,
    permanentRoles: ["chat", "coordinator"],
    roleConfigs: {
      chat: { agentKind: "claude", launch: makeLaunch("launch-chat", { BFLOW_LAUNCH_ID: "launch-chat" }) },
      coordinator: {
        agentKind: "claude",
        launch: makeLaunch("launch-coord", { BFLOW_LAUNCH_ID: "launch-coord" }, ["--append-system-prompt-file", coordinatorSource])
      }
    },
    ...overrides
  };
}

describe("Slice 2 RolePaneManager allocation & release hardening", () => {
  let herdr: HardeningHerdrFake;
  let store: InMemorySessionManifestStore;
  let inspector: MutableWorktreeInspector;

  beforeEach(() => {
    herdr = new HardeningHerdrFake();
    store = new InMemorySessionManifestStore();
    inspector = new MutableWorktreeInspector();
  });

  it("removes phantom active Developer binding on releaseDeveloper({ closePane: true }) when its Herdr pane is already gone, unlocking the worktree", async () => {
    const manager = createRolePaneManager({
      config: baseConfig(),
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: inspector
    });
    expect((await manager.initializeTopology()).ok).toBe(true);

    const wtPath = "/repo/.worktrees/task-dead-1";
    const allocated = await manager.allocateDeveloper({
      taskId: "task-dead-1",
      worktreePath: wtPath,
      branchName: "feat/dead-1"
    });
    expect(allocated.ok).toBe(true);
    if (!allocated.ok) return;

    // Simulate Herdr pane crash/closure before releaseDeveloper runs (e.g. w4:p2 / w1:pE gone).
    herdr.panes.delete(allocated.value.paneId);
    for (const [name, agent] of herdr.agents) {
      if (agent.paneId === allocated.value.paneId) herdr.agents.delete(name);
    }
    inspector.set(wtPath, { exists: true, isClean: true, dirtyFiles: [] });

    const released = await manager.releaseDeveloper({
      taskId: "task-dead-1",
      closePane: true,
      removeWorktree: false
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.paneClosed).toBe(true);
    expect(released.value.manifest.panes.some(p => p.bindingId === allocated.value.bindingId)).toBe(false);

    // Subsequent task on the same clean worktree/branch must not hit a phantom single-writer lock.
    const next = await manager.allocateDeveloper({
      taskId: "task-after-dead-1",
      worktreePath: wtPath,
      branchName: "feat/dead-1"
    });
    expect(next.ok).toBe(true);
  });

  it("does NOT drop the Developer binding when pane close fails and pane get times out (unconfirmed absence)", async () => {
    const manager = createRolePaneManager({
      config: baseConfig(),
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: inspector
    });
    expect((await manager.initializeTopology()).ok).toBe(true);

    const wtPath = "/repo/.worktrees/task-timeout";
    const allocated = await manager.allocateDeveloper({
      taskId: "task-timeout",
      worktreePath: wtPath
    });
    expect(allocated.ok).toBe(true);
    if (!allocated.ok) return;

    inspector.set(wtPath, { exists: true, isClean: true, dirtyFiles: [] });
    herdr.onCommand = invocation => {
      if (invocation.args[0] === "pane" && (invocation.args[1] === "close" || invocation.args[1] === "get")) {
        return { exitCode: null, stdout: "", stderr: "", failure: "timeout", cause: "Herdr socket timeout" };
      }
      return undefined;
    };

    const released = await manager.releaseDeveloper({
      taskId: "task-timeout",
      closePane: true,
      removeWorktree: false
    });
    expect(released.ok).toBe(false);
    const saved = await store.load("slice2-hardening-session");
    expect(saved.ok && saved.value?.panes.some(p => p.bindingId === allocated.value.bindingId)).toBe(true);
  });

  it("removes phantom Developer binding on releaseDeveloper({ removeWorktree: true }) when Herdr workspace and worktree directory are already absent", async () => {
    const manager = createRolePaneManager({
      config: baseConfig(),
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: inspector
    });
    expect((await manager.initializeTopology()).ok).toBe(true);

    const wtPath = "/repo/.worktrees/task-wt-gone";
    const allocated = await manager.allocateDeveloper({
      taskId: "task-wt-gone",
      worktreePath: wtPath
    });
    expect(allocated.ok).toBe(true);
    if (!allocated.ok) return;

    // Simulate Herdr worktree workspace already closed and directory already removed on disk.
    herdr.workspaces.delete(allocated.value.workspaceId);
    herdr.panes.delete(allocated.value.paneId);
    for (const [name, agent] of herdr.agents) {
      if (agent.paneId === allocated.value.paneId) herdr.agents.delete(name);
    }
    inspector.set(wtPath, { exists: false, isClean: true, dirtyFiles: [] });

    const released = await manager.releaseDeveloper({
      taskId: "task-wt-gone",
      closePane: true,
      removeWorktree: true
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.worktreeRemoved).toBe(true);
    expect(released.value.paneClosed).toBe(true);
    expect(released.value.manifest.panes.some(p => p.bindingId === allocated.value.bindingId)).toBe(false);
  });

  it("serializes concurrent allocateDeveloper and releaseDeveloper mutations so neither clobbers SessionManifest", async () => {
    let releaseLoadedBarrierResolve: (() => void) | undefined;
    const releaseLoadedBarrier = new Promise<void>(resolve => {
      releaseLoadedBarrierResolve = resolve;
    });
    let armed = false;
    let releaseLoadObserved = false;

    const racingStore: SessionManifestStore = {
      async load(sessionId: string, options?: OperationOptions) {
        const res = await store.load(sessionId, options);
        if (armed && !releaseLoadObserved) {
          releaseLoadObserved = true;
          releaseLoadedBarrierResolve?.();
        }
        return res;
      },
      async save(manifest: SessionManifest, options?: OperationOptions) {
        return store.save(manifest, options);
      }
    };

    const manager = createRolePaneManager({
      config: baseConfig(),
      runner: herdr,
      socket: herdr.socket,
      store: racingStore,
      worktreeInspector: inspector
    });
    expect((await manager.initializeTopology()).ok).toBe(true);

    const allocA = await manager.allocateDeveloper({
      taskId: "task-a",
      worktreePath: "/repo/.worktrees/task-a"
    });
    expect(allocA.ok).toBe(true);
    if (!allocA.ok) return;
    inspector.set("/repo/.worktrees/task-a", { exists: true, isClean: true, dirtyFiles: [] });

    // Delay pane close for task-a so an unserialized allocateDeveloper(task-b) would interleave its load/save.
    armed = true;
    herdr.onCommand = async invocation => {
      if (invocation.args[0] === "pane" && invocation.args[1] === "close" && invocation.args[2] === allocA.value.paneId) {
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      return undefined;
    };

    const releasePromise = manager.releaseDeveloper({
      taskId: "task-a",
      closePane: true,
      removeWorktree: false
    });
    await releaseLoadedBarrier;
    const allocBPromise = manager.allocateDeveloper({
      taskId: "task-b",
      worktreePath: "/repo/.worktrees/task-b"
    });

    const [releasedA, allocB] = await Promise.all([releasePromise, allocBPromise]);
    expect(releasedA.ok).toBe(true);
    expect(allocB.ok).toBe(true);

    const finalManifest = await store.load("slice2-hardening-session");
    expect(finalManifest.ok).toBe(true);
    if (!finalManifest.ok || !finalManifest.value) return;
    const devTaskIds = finalManifest.value.panes
      .filter(p => p.role === "developer")
      .map(p => p.metadata?.["taskId"]);
    expect(devTaskIds).toEqual(["task-b"]);
  });

  it("passes cwd and focus:false when splitting a released Developer pane and keeps the workspace/manifest consistent if agent start fails", async () => {
    const manager = createRolePaneManager({
      config: baseConfig(),
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: inspector
    });
    expect((await manager.initializeTopology()).ok).toBe(true);

    const wtPath = "/repo/.worktrees/reuse-env";
    const first = await manager.allocateDeveloper({
      taskId: "task-1",
      worktreePath: wtPath,
      launch: makeLaunch("launch-dev-1", { BFLOW_LAUNCH_ID: "launch-dev-1" }, [])
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    inspector.set(wtPath, { exists: true, isClean: true, dirtyFiles: [] });
    expect((await manager.releaseDeveloper({ taskId: "task-1", closePane: false, removeWorktree: false })).ok).toBe(true);

    herdr.socketCalls.length = 0;
    herdr.onCommand = invocation => {
      if (invocation.args[0] === "agent" && invocation.args[1] === "start") {
        return herdr.fail("agent_blocked", "simulated startup rejection");
      }
      return undefined;
    };

    const second = await manager.allocateDeveloper({
      taskId: "task-2",
      worktreePath: wtPath,
      launch: makeLaunch("launch-dev-2", { BFLOW_LAUNCH_ID: "launch-dev-2" }, [])
    });
    expect(second.ok).toBe(false);

    const splitCall = herdr.socketCalls.find(c => c.method === "pane.split");
    expect(splitCall?.params).toMatchObject({
      target_pane_id: first.value.paneId,
      direction: "right",
      cwd: wtPath,
      focus: false
    });

    // Every Developer binding still recorded in SessionManifest must point to a pane that actually exists in Herdr.
    const saved = await store.load("slice2-hardening-session");
    expect(saved.ok).toBe(true);
    if (!saved.ok || !saved.value) return;
    for (const dev of saved.value.panes.filter(p => p.role === "developer")) {
      expect(herdr.panes.has(dev.paneId)).toBe(true);
    }
  });

  it("reports a same-task readiness conflict instead of false single-writer conflict when an active task Developer is still starting", async () => {
    const manager = createRolePaneManager({
      config: baseConfig(),
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: inspector
    });
    expect((await manager.initializeTopology()).ok).toBe(true);

    const wtPath = "/repo/.worktrees/task-starting";
    const first = await manager.allocateDeveloper({
      taskId: "task-starting",
      worktreePath: wtPath
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const live = herdr.agents.get(first.value.agentId)!;
    herdr.agents.set(first.value.agentId, {
      ...live,
      agentStatus: "starting",
      interactiveReady: false,
      launchPending: true
    });

    const retry = await manager.allocateDeveloper({
      taskId: "task-starting",
      worktreePath: wtPath
    });
    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.error.code).toBe("conflict");
    expect(retry.error.message).not.toMatch(/Another developer agent/i);
    expect(retry.error.message).toContain("task-starting");
  });

  it("prefers active Developer bindings over earlier released bindings in getRoleBinding('developer') and inspectRoleHealth('developer')", async () => {
    const manager = createRolePaneManager({
      config: baseConfig(),
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: inspector
    });
    expect((await manager.initializeTopology()).ok).toBe(true);

    const oldAlloc = await manager.allocateDeveloper({
      taskId: "task-old",
      worktreePath: "/repo/.worktrees/task-old"
    });
    expect(oldAlloc.ok).toBe(true);
    if (!oldAlloc.ok) return;
    inspector.set("/repo/.worktrees/task-old", { exists: true, isClean: true, dirtyFiles: [] });
    expect((await manager.releaseDeveloper({ taskId: "task-old", closePane: false, removeWorktree: false })).ok).toBe(true);

    const activeAlloc = await manager.allocateDeveloper({
      taskId: "task-active",
      worktreePath: "/repo/.worktrees/task-active"
    });
    expect(activeAlloc.ok).toBe(true);
    if (!activeAlloc.ok) return;

    const roleBinding = await manager.getRoleBinding("developer");
    expect(roleBinding.ok).toBe(true);
    if (roleBinding.ok) {
      expect(roleBinding.value?.bindingId).toBe(activeAlloc.value.bindingId);
    }

    const health = await manager.inspectRoleHealth("developer");
    expect(health.ok).toBe(true);
    if (health.ok) {
      expect(health.value.bindingId).toBe(activeAlloc.value.bindingId);
    }
  });
});
