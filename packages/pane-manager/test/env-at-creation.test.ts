import { describe, it, expect, beforeAll } from "vitest";
import type { OperationResult } from "@bflow/contracts";
import type {
  AgentLaunchProfile,
  CommandInvocation,
  CommandOutcome,
  HerdrCommandRunner,
  HerdrSocketPort,
  RolePaneManagerConfig,
  WorktreeInspector
} from "../src/types.js";
import { createRolePaneManager } from "../src/role-pane-manager.js";
import { InMemorySessionManifestStore } from "../src/manifest-store.js";
import { readBuiltinRolePrompt } from "../src/role-prompts.js";

type Env = Readonly<Record<string, string>>;
type Json = Record<string, unknown>;

const CHAT_TOKEN = "tok-chat-AAAA1111";
const COORD_TOKEN = "tok-coord-BBBB2222";
const PLANNER_TOKEN = "tok-planner-CCCC3333";
const DEV_TOKEN = "tok-dev-DDDD4444";
const DEV2_TOKEN = "tok-dev-EEEE5555";
const TOKENS = [CHAT_TOKEN, COORD_TOKEN, PLANNER_TOKEN, DEV_TOKEN, DEV2_TOKEN];
const ROOT = "/work/demo";

let chatSource = "";
let coordinatorSource = "";
beforeAll(async () => {
  chatSource = (await readBuiltinRolePrompt("chat"))?.source ?? "";
  coordinatorSource = (await readBuiltinRolePrompt("coordinator"))?.source ?? "";
  expect(chatSource).not.toBe("");
  expect(coordinatorSource).not.toBe("");
});

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Herdr fake with one shared model behind two surfaces: the CLI runner and the socket port.
 * Panes created through the socket record the env they were born with; the CLI never sees env.
 */
class EnvHerdr implements HerdrCommandRunner {
  readonly calls: CommandInvocation[] = [];
  readonly socketCalls: { method: string; params: Json }[] = [];
  readonly paneEnv = new Map<string, Env>();
  readonly workspaces = new Map<string, { id: string; label: string; activeTabId: string }>();
  readonly tabs = new Map<string, { id: string; wsId: string; label: string }>();
  readonly panes = new Map<string, { id: string; tabId: string; wsId: string; agent: string | null; cwd: string }>();
  readonly agents = new Map<string, { name: string; kind: string; paneId: string }>();
  failSocketMethod: string | undefined;
  #seq = 0;

  readonly socket: HerdrSocketPort = {
    request: async (method, params): Promise<OperationResult<unknown>> => {
      this.socketCalls.push({ method, params: structuredClone(params) as Json });
      if (method === this.failSocketMethod) {
        return { ok: false, error: { code: "validation", retryable: false, message: `Herdr ${method} was rejected (invalid_env)` } };
      }
      const env = params["env"] as Env | undefined;
      if (method === "workspace.create") return { ok: true, value: this.createWorkspace(String(params["cwd"]), String(params["label"]), env) };
      if (method === "tab.create") return { ok: true, value: this.createTab(String(params["workspace_id"]), String(params["cwd"]), String(params["label"]), env) };
      if (method === "pane.split") {
        const pane = this.split(String(params["target_pane_id"]), env);
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
    const wsId = this.#id("ws"), tabId = this.#id("tab");
    this.workspaces.set(wsId, { id: wsId, label, activeTabId: tabId });
    this.tabs.set(tabId, { id: tabId, wsId, label: "1" });
    const paneId = this.#newPane(tabId, wsId, cwd, env);
    return { type: "workspace_created", workspace: this.workspaceJson(wsId), tab: this.tabJson(tabId), root_pane: this.paneJson(paneId) };
  }

  createTab(wsId: string, cwd: string, label: string, env: Env | undefined): Json {
    const tabId = this.#id("tab");
    this.tabs.set(tabId, { id: tabId, wsId, label });
    const paneId = this.#newPane(tabId, wsId, cwd, env);
    return { type: "tab_created", tab: this.tabJson(tabId), root_pane: this.paneJson(paneId) };
  }

  split(sourcePaneId: string, env: Env | undefined) {
    const source = this.panes.get(sourcePaneId);
    if (!source) throw new Error(`pane not found ${sourcePaneId}`);
    const id = this.#newPane(source.tabId, source.wsId, source.cwd, env);
    return this.panes.get(id)!;
  }

  workspaceJson(id: string): Json {
    const ws = this.workspaces.get(id)!;
    return { workspace_id: id, label: ws.label, active_tab_id: ws.activeTabId, focused: false, pane_count: 1, tab_count: 1, agent_status: "idle", number: 1 };
  }

  tabJson(id: string): Json {
    const tab = this.tabs.get(id)!;
    return { tab_id: id, workspace_id: tab.wsId, number: 1, label: tab.label, focused: false, pane_count: 1, agent_status: "idle" };
  }

  paneJson(id: string): Json {
    const pane = this.panes.get(id)!;
    return { pane_id: id, terminal_id: `term-${id}`, workspace_id: pane.wsId, tab_id: pane.tabId, focused: false,
      agent: pane.agent, agent_status: "idle", revision: 1, cwd: pane.cwd };
  }

  agentJson(name: string): Json {
    const agent = this.agents.get(name)!;
    const pane = this.panes.get(agent.paneId)!;
    return { name, agent: agent.kind, pane_id: agent.paneId, terminal_id: `term-${agent.paneId}`, workspace_id: pane.wsId, tab_id: pane.tabId,
      focused: false, agent_status: "idle", revision: 1, interactive_ready: true, launch_pending: false };
  }

  reply(result: Json): CommandOutcome {
    return { exitCode: 0, stdout: JSON.stringify({ id: "1", result }), stderr: "" };
  }

  fail(code: string): CommandOutcome {
    return { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code, message: `${code}` } }) };
  }

  async run(invocation: CommandInvocation): Promise<CommandOutcome> {
    this.calls.push(invocation);
    const [domain, action, ...rest] = invocation.args;
    if (domain === "workspace" && action === "list") {
      return this.reply({ type: "workspace_list", workspaces: [...this.workspaces.keys()].map(id => this.workspaceJson(id)) });
    }
    if (domain === "workspace" && action === "create") {
      return this.reply(this.createWorkspace(flag(rest, "--cwd") ?? ROOT, flag(rest, "--label") ?? "demo", undefined));
    }
    if (domain === "workspace" && action === "focus") return this.reply({ type: "workspace_info", workspace: this.workspaceJson(rest[0]!) });
    if (domain === "tab" && action === "list") {
      const ws = flag(rest, "--workspace");
      return this.reply({ type: "tab_list", tabs: [...this.tabs.keys()].filter(id => this.tabs.get(id)!.wsId === ws).map(id => this.tabJson(id)) });
    }
    if (domain === "tab" && action === "create") {
      return this.reply(this.createTab(flag(rest, "--workspace")!, flag(rest, "--cwd") ?? ROOT, flag(rest, "--label") ?? "tab", undefined));
    }
    if (domain === "tab" && (action === "focus" || action === "rename")) return this.reply({ type: "tab_info", tab: this.tabJson(rest[0]!) });
    if (domain === "pane" && action === "list") {
      const ws = flag(rest, "--workspace");
      return this.reply({ type: "pane_list", panes: [...this.panes.keys()].filter(id => this.panes.get(id)!.wsId === ws).map(id => this.paneJson(id)) });
    }
    if (domain === "pane" && action === "get") {
      return this.panes.has(rest[0]!) ? this.reply({ type: "pane_info", pane: this.paneJson(rest[0]!) }) : this.fail("pane_not_found");
    }
    if (domain === "pane" && action === "split") {
      const pane = this.split(rest[0]!, undefined);
      return this.reply({ type: "pane_info", pane: this.paneJson(pane.id) });
    }
    if (domain === "pane" && action === "close") {
      const id = rest[0]!;
      this.panes.delete(id);
      for (const [name, agent] of this.agents) if (agent.paneId === id) this.agents.delete(name);
      return this.reply({ type: "ok" });
    }
    if (domain === "pane" && action === "rename") return this.reply({ type: "pane_info", pane: this.paneJson(rest[0]!) });
    if (domain === "pane" && action === "process-info") {
      const id = flag(rest, "--pane") ?? rest[0]!;
      return this.reply({ type: "pane_process_info", process_info: { pane_id: id, shell_pid: 4242, foreground_process_group_id: 4242, foreground_processes: [] } });
    }
    if (domain === "pane" && action === "layout") {
      const pane = this.panes.get(flag(rest, "--pane")!)!;
      const siblings = [...this.panes.values()].filter(p => p.tabId === pane.tabId);
      return this.reply({ type: "pane_layout", layout: { workspace_id: pane.wsId, tab_id: pane.tabId,
        panes: siblings.map((p, i) => ({ pane_id: p.id, rect: { x: i * 40, y: 0, width: 40, height: 40 } })), splits: [] } });
    }
    if (domain === "agent" && action === "list") {
      return this.reply({ type: "agent_list", agents: [...this.agents.keys()].map(name => this.agentJson(name)) });
    }
    if (domain === "agent" && (action === "get" || action === "focus")) {
      const agent = [...this.agents.values()].find(a => a.paneId === rest[0]);
      return agent ? this.reply({ type: "agent_info", agent: this.agentJson(agent.name) }) : this.fail("agent_not_found");
    }
    if (domain === "agent" && action === "start") {
      const name = rest[0]!;
      const paneId = flag(rest, "--pane")!;
      const pane = this.panes.get(paneId);
      if (!pane) return this.fail("pane_not_found");
      pane.agent = flag(rest, "--kind") ?? "claude";
      this.agents.set(name, { name, kind: pane.agent, paneId });
      return this.reply({ type: "agent_started", agent: this.agentJson(name), argv: [] });
    }
    if (domain === "worktree" && action === "create") {
      const path = flag(rest, "--path")!;
      const label = flag(rest, "--label") ?? path;
      const created = this.createWorkspace(path, label, undefined);
      const wsId = (created.workspace as Json)["workspace_id"] as string;
      return this.reply({ ...created, type: "worktree_created", worktree: { path, label, branch: null, is_linked_worktree: true,
        is_detached: false, is_bare: false, is_prunable: false, open_workspace_id: wsId } });
    }
    return this.fail(`unsupported_${String(domain)}_${String(action)}`);
  }

  /** Every string that reached the CLI runner: argv, env keys and values. */
  cliSurface(): string {
    return JSON.stringify(this.calls.map(call => ({ args: call.args, env: call.env ?? null })));
  }

  agentStarts(): CommandInvocation[] {
    return this.calls.filter(call => call.args[0] === "agent" && call.args[1] === "start");
  }
}

const inspector: WorktreeInspector = {
  inspect: async () => ({ ok: true, value: { exists: false, isClean: true, dirtyFiles: [] } })
};

function launch(launchId: string, env: Env, provider: "claude" = "claude", argv?: string[]): AgentLaunchProfile {
  return { provider, launchId, launchFingerprint: `${launchId}-fingerprint`, env, argv: argv ?? ["--append-system-prompt-file", chatSource] };
}

function chatLaunch(launchId = "launch-chat-1", token = CHAT_TOKEN) {
  return launch(launchId, { BFLOW_MCP_TOKEN_CHAT: token, BFLOW_LAUNCH_ID: launchId });
}

function coordinatorLaunch(launchId = "launch-coord-1", token = COORD_TOKEN) {
  return launch(launchId, { BFLOW_MCP_TOKEN_COORD: token }, "claude", ["--append-system-prompt-file", coordinatorSource]);
}

function plannerLaunch() {
  return launch("launch-planner-1", { BFLOW_MCP_TOKEN_PLANNER: PLANNER_TOKEN }, "claude", ["--model", "planner-test"]);
}

function config(overrides: Partial<RolePaneManagerConfig> = {}, roleLaunches: Record<string, AgentLaunchProfile | undefined> = {}): RolePaneManagerConfig {
  return {
    sessionId: "bflow-env-test",
    projectName: "demo",
    workspaceRoot: ROOT,
    defaultAgentKind: "claude",
    permanentRoles: ["chat", "coordinator", "planner", "reviewer"],
    roleConfigs: {
      chat: { agentKind: "claude", ...(roleLaunches["chat"] ? { launch: roleLaunches["chat"] } : {}) },
      coordinator: { agentKind: "claude", ...(roleLaunches["coordinator"] ? { launch: roleLaunches["coordinator"] } : {}) },
      planner: { agentKind: "claude", ...(roleLaunches["planner"] ? { launch: roleLaunches["planner"] } : {}) },
      reviewer: { agentKind: "claude" }
    },
    ...overrides
  };
}

function setup(roleLaunches: Record<string, AgentLaunchProfile | undefined>, options: { socket?: boolean } = {}) {
  const runner = new EnvHerdr();
  const store = new InMemorySessionManifestStore();
  const manager = createRolePaneManager({
    config: config({}, roleLaunches),
    runner,
    store,
    worktreeInspector: inspector,
    ...(options.socket === false ? {} : { socket: runner.socket })
  });
  return { runner, store, manager };
}

function assertNoTokens(runner: EnvHerdr): void {
  const surface = runner.cliSurface();
  for (const token of TOKENS) expect(surface).not.toContain(token);
}

describe("launch env is applied at pane creation through the Herdr socket", () => {
  it("creates env-bearing roles through workspace.create, tab.create and pane.split and keeps legacy roles on the CLI", async () => {
    const { runner, manager } = setup({ chat: chatLaunch(), coordinator: coordinatorLaunch(), planner: plannerLaunch() });
    const result = await manager.initializeTopology();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(runner.socketCalls.map(call => call.method)).toEqual(["workspace.create", "tab.create", "pane.split"]);
    const [wsCall, tabCall, splitCall] = runner.socketCalls;
    expect(wsCall!.params).toMatchObject({ cwd: ROOT, label: "demo", focus: false, env: { BFLOW_MCP_TOKEN_CHAT: CHAT_TOKEN, BFLOW_LAUNCH_ID: "launch-chat-1" } });
    expect(tabCall!.params).toMatchObject({ cwd: ROOT, label: "coordination", focus: false, env: { BFLOW_MCP_TOKEN_COORD: COORD_TOKEN } });
    expect(splitCall!.params).toMatchObject({ direction: "right", cwd: ROOT, focus: false, env: { BFLOW_MCP_TOKEN_PLANNER: PLANNER_TOKEN } });

    const chat = result.value.panes.find(p => p.role === "conversation")!;
    const coordinator = result.value.panes.find(p => p.role === "coordinator")!;
    const planner = result.value.panes.find(p => p.role === "planner")!;
    const reviewer = result.value.panes.find(p => p.metadata?.["topologyRole"] === "reviewer")!;
    expect(runner.paneEnv.get(chat.paneId)).toEqual({ BFLOW_MCP_TOKEN_CHAT: CHAT_TOKEN, BFLOW_LAUNCH_ID: "launch-chat-1" });
    expect(runner.paneEnv.get(coordinator.paneId)).toEqual({ BFLOW_MCP_TOKEN_COORD: COORD_TOKEN });
    expect(runner.paneEnv.get(planner.paneId)).toEqual({ BFLOW_MCP_TOKEN_PLANNER: PLANNER_TOKEN });
    expect(runner.paneEnv.has(reviewer.paneId)).toBe(false);
    expect(chat.metadata).toMatchObject({ launchId: "launch-chat-1" });

    // Legacy reviewer tab is created through the CLI, without env.
    const cliTabCreates = runner.calls.filter(call => call.args[0] === "tab" && call.args[1] === "create");
    expect(cliTabCreates.map(call => call.args)).toEqual([
      ["tab", "create", "--workspace", expect.any(String), "--cwd", ROOT, "--label", "verification", "--no-focus"]
    ]);
    expect(runner.calls.some(call => call.args[0] === "workspace" && call.args[1] === "create")).toBe(false);
  });

  it("never gives the provider env through agent start or any CLI invocation", async () => {
    const { runner, manager } = setup({ chat: chatLaunch(), coordinator: coordinatorLaunch(), planner: plannerLaunch() });
    expect((await manager.initializeTopology()).ok).toBe(true);

    expect(runner.agentStarts().length).toBeGreaterThan(0);
    for (const start of runner.agentStarts()) expect(start.env).toBeUndefined();
    for (const call of runner.calls) expect(call.env).toBeUndefined();
    assertNoTokens(runner);
  });

  it("fails validation before any side effect when env is required but no socket port is configured", async () => {
    const { runner, store, manager } = setup({ chat: chatLaunch() }, { socket: false });
    const result = await manager.initializeTopology();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.error.message).not.toContain(CHAT_TOKEN);
    expect(runner.calls).toHaveLength(0);
    expect(runner.socketCalls).toHaveLength(0);
    expect(await store.load("bflow-env-test")).toEqual({ ok: true, value: null });
  });

  it("uses the CLI path unchanged for a topology whose roles carry no env", async () => {
    const { runner, manager } = setup({}, { socket: false });
    const result = await manager.initializeTopology();
    expect(result.ok).toBe(true);
    expect(runner.socketCalls).toHaveLength(0);
    expect(runner.calls.some(call => call.args[0] === "workspace" && call.args[1] === "create")).toBe(true);
    expect(runner.calls.filter(call => call.args[0] === "tab" && call.args[1] === "create")).toHaveLength(2);
  });

  it("does not hide a socket failure behind a successful pane; the error carries no env values", async () => {
    const { runner, manager } = setup({ chat: chatLaunch(), coordinator: coordinatorLaunch() });
    runner.failSocketMethod = "tab.create";
    const result = await manager.initializeTopology();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(COORD_TOKEN);
    expect(JSON.stringify(result)).not.toContain(CHAT_TOKEN);
    assertNoTokens(runner);
  });

  it("closes a pane recorded for a different launch and recreates it with the new env", async () => {
    const runner = new EnvHerdr();
    const store = new InMemorySessionManifestStore();
    const first = createRolePaneManager({ config: config({}, { chat: chatLaunch("launch-chat-1", CHAT_TOKEN) }), runner, store,
      worktreeInspector: inspector, socket: runner.socket });
    const initial = await first.initializeTopology();
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const oldChat = initial.value.panes.find(p => p.role === "conversation")!;

    const second = createRolePaneManager({ config: config({}, { chat: chatLaunch("launch-chat-2", DEV2_TOKEN) }), runner, store,
      worktreeInspector: inspector, socket: runner.socket });
    const reconciled = await second.reconcileTopology();
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;

    const newChat = reconciled.value.panes.find(p => p.role === "conversation")!;
    expect(newChat.paneId).not.toBe(oldChat.paneId);
    expect(newChat.metadata).toMatchObject({ launchId: "launch-chat-2" });
    expect(runner.paneEnv.get(newChat.paneId)).toEqual({ BFLOW_MCP_TOKEN_CHAT: DEV2_TOKEN, BFLOW_LAUNCH_ID: "launch-chat-2" });
    expect(runner.calls.some(call => call.args[0] === "pane" && call.args[1] === "close" && call.args[2] === oldChat.paneId)).toBe(true);
    const split = runner.socketCalls.at(-1)!;
    expect(split.method).toBe("pane.split");
    expect(split.params["env"]).toEqual({ BFLOW_MCP_TOKEN_CHAT: DEV2_TOKEN, BFLOW_LAUNCH_ID: "launch-chat-2" });
    // The old pane closed before the new chat agent started, so the agent name never conflicted.
    const closeIndex = runner.calls.findIndex(call => call.args[0] === "pane" && call.args[1] === "close" && call.args[2] === oldChat.paneId);
    const startIndex = runner.calls.findIndex((call, index) => index > closeIndex && call.args[0] === "agent" && call.args[1] === "start" && call.args[2] === "chat");
    expect(startIndex).toBeGreaterThan(closeIndex);
    expect(JSON.stringify(reconciled.value)).not.toContain(DEV2_TOKEN);
    assertNoTokens(runner);
  });

  it("keeps an env-bearing role's pane when its recorded launch is unchanged", async () => {
    const runner = new EnvHerdr();
    const store = new InMemorySessionManifestStore();
    const build = () => createRolePaneManager({ config: config({}, { chat: chatLaunch("launch-chat-1") }), runner, store,
      worktreeInspector: inspector, socket: runner.socket });
    expect((await build().initializeTopology()).ok).toBe(true);
    const socketBefore = runner.socketCalls.length;
    const startsBefore = runner.agentStarts().length;
    const again = await build().reconcileTopology();
    expect(again.ok).toBe(true);
    expect(runner.socketCalls).toHaveLength(socketBefore);
    expect(runner.agentStarts()).toHaveLength(startsBefore);
  });

  it("creates a Developer pane with env through the socket and closes the worktree root pane", async () => {
    const { runner, manager } = setup({ chat: chatLaunch() });
    expect((await manager.initializeTopology()).ok).toBe(true);

    const developer = await manager.allocateDeveloper({ taskId: "task-1", worktreePath: "/work/demo-wt/task-1",
      branchName: "agent/dev/task-1", agentName: "dev-task-1", launch: launch("launch-dev-1", { BFLOW_MCP_TOKEN_DEV: DEV_TOKEN }) });
    expect(developer.ok).toBe(true);
    if (!developer.ok) return;

    expect(runner.calls.some(call => call.args[0] === "worktree" && call.args[1] === "create")).toBe(true);
    const devSplit = runner.socketCalls.at(-1)!;
    expect(devSplit.method).toBe("pane.split");
    expect(devSplit.params).toMatchObject({ cwd: "/work/demo-wt/task-1", env: { BFLOW_MCP_TOKEN_DEV: DEV_TOKEN } });
    expect(runner.paneEnv.get(developer.value.paneId)).toEqual({ BFLOW_MCP_TOKEN_DEV: DEV_TOKEN });
    expect(developer.value.metadata).toMatchObject({ launchId: "launch-dev-1", allocationStatus: "active" });
    const worktreeRootId = devSplit.params["target_pane_id"];
    expect(runner.calls.some(call => call.args[0] === "pane" && call.args[1] === "close" && call.args[2] === worktreeRootId)).toBe(true);
    for (const start of runner.agentStarts()) expect(start.env).toBeUndefined();
    assertNoTokens(runner);
  });

  it("does not reuse a released Developer pane created for another launch", async () => {
    const { runner, manager } = setup({ chat: chatLaunch() });
    expect((await manager.initializeTopology()).ok).toBe(true);
    const first = await manager.allocateDeveloper({ taskId: "task-1", worktreePath: "/work/demo-wt/task-1", agentName: "dev-task-1",
      launch: launch("launch-dev-1", { BFLOW_MCP_TOKEN_DEV: DEV_TOKEN }) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const released = await manager.releaseDeveloper({ taskId: "task-1" });
    expect(released.ok).toBe(true);
    expect(runner.panes.has(first.value.paneId)).toBe(true);

    const second = await manager.allocateDeveloper({ taskId: "task-1", worktreePath: "/work/demo-wt/task-1", agentName: "dev-task-1",
      launch: launch("launch-dev-2", { BFLOW_MCP_TOKEN_DEV: DEV2_TOKEN }) });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.paneId).not.toBe(first.value.paneId);
    expect(second.value.metadata).toMatchObject({ launchId: "launch-dev-2" });
    expect(runner.paneEnv.get(second.value.paneId)).toEqual({ BFLOW_MCP_TOKEN_DEV: DEV2_TOKEN });
    expect(runner.panes.has(first.value.paneId)).toBe(false);
    const split = runner.socketCalls.at(-1)!;
    expect(split.params).toMatchObject({ target_pane_id: first.value.paneId, env: { BFLOW_MCP_TOKEN_DEV: DEV2_TOKEN } });
    assertNoTokens(runner);
  });

  it("requires a socket port before allocating a Developer with env", async () => {
    const { runner, manager } = setup({}, { socket: false });
    expect((await manager.initializeTopology()).ok).toBe(true);
    const before = runner.calls.length;
    const result = await manager.allocateDeveloper({ taskId: "task-9", worktreePath: "/work/demo-wt/task-9",
      launch: launch("launch-dev-9", { BFLOW_MCP_TOKEN_DEV: DEV_TOKEN }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(runner.calls.length).toBe(before);
  });

  it("keeps a legacy Developer (no env) on the CLI split path", async () => {
    const { runner, manager } = setup({}, { socket: false });
    expect((await manager.initializeTopology()).ok).toBe(true);
    const result = await manager.allocateDeveloper({ taskId: "task-2", worktreePath: "/work/demo-wt/task-2", agentName: "dev-task-2" });
    expect(result.ok).toBe(true);
    expect(runner.socketCalls).toHaveLength(0);
    expect(runner.calls.some(call => call.args[0] === "worktree" && call.args[1] === "create")).toBe(true);
  });
});
