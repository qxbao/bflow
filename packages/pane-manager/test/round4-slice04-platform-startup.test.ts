import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { InMemorySessionManifestStore } from "../src/manifest-store.js";
import { buildProviderRoleLaunch, buildProviderRoleLaunchFromFiles } from "../src/provider-launch.js";
import { createRolePaneManager } from "../src/role-pane-manager.js";
import { readBuiltinRolePrompt } from "../src/role-prompts.js";
import { createHerdrSocketPort } from "../src/herdr-socket.js";
import type {
  AgentLaunchProfile,
  CommandInvocation,
  CommandOutcome,
  HerdrCommandRunner,
  RolePaneManagerConfig,
  WorktreeInspector
} from "../src/types.js";
import type { SessionManifest } from "@bflow/contracts";

const ROOT = "/repo";
const roots: string[] = [];
let chatPromptSource = "";
let coordinatorPromptSource = "";
let reviewerPromptSource = "";
let developerPromptSource = "";

beforeAll(async () => {
  chatPromptSource = (await readBuiltinRolePrompt("chat"))?.source ?? "";
  coordinatorPromptSource = (await readBuiltinRolePrompt("coordinator"))?.source ?? "";
  reviewerPromptSource = (await readBuiltinRolePrompt("reviewer"))?.source ?? "";
  developerPromptSource = (await readBuiltinRolePrompt("developer"))?.source ?? "";
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

class FakeHerdr implements HerdrCommandRunner {
  readonly calls: CommandInvocation[] = [];
  readonly workspaces = new Map<string, { id: string; label: string; activeTabId: string }>();
  readonly tabs = new Map<string, { id: string; wsId: string; label: string }>();
  readonly panes = new Map<string, { id: string; tabId: string; wsId: string; agent: string | null; cwd: string }>();
  readonly agents = new Map<
    string,
    {
      name: string;
      kind: string;
      paneId: string;
      agentStatus: string;
      interactiveReady: boolean;
      launchPending: boolean;
      session?: { source: string; kind: "id" | "path" | "opaque"; value: string };
    }
  >();
  nextWs = 1;
  nextTab = 1;
  nextPane = 1;
  failStartRole: string | null = null;
  delayedSessionRole: string | null = null;
  delayedSessionQueries = 0;

  get socket() {
    return {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "workspace.create") {
          const cwd = String(params["cwd"] ?? ROOT);
          const label = String(params["label"] ?? "ws");
          const wsId = `w${this.nextWs++}`;
          const tabId = `t${this.nextTab++}`;
          const paneId = `p${this.nextPane++}`;
          this.workspaces.set(wsId, { id: wsId, label, activeTabId: tabId });
          this.tabs.set(tabId, { id: tabId, wsId, label: "conversation" });
          this.panes.set(paneId, { id: paneId, tabId, wsId, agent: null, cwd });
          return {
            ok: true as const,
            value: {
              type: "workspace_created",
              workspace: { workspace_id: wsId, label, active_tab_id: tabId, focused: true, pane_count: 1 },
              tab: { tab_id: tabId, workspace_id: wsId, label: "conversation", focused: true, pane_count: 1, agent_status: "unknown" },
              root_pane: { pane_id: paneId, terminal_id: `term-${paneId}`, workspace_id: wsId, tab_id: tabId, focused: true, agent: null, agent_status: "unknown", revision: 1, cwd }
            }
          };
        }
        if (method === "tab.create") {
          const wsId = String(params["workspace_id"] ?? "w1");
          const label = String(params["label"] ?? "tab");
          const tabId = `t${this.nextTab++}`;
          const paneId = `p${this.nextPane++}`;
          this.tabs.set(tabId, { id: tabId, wsId, label });
          this.panes.set(paneId, { id: paneId, tabId, wsId, agent: null, cwd: ROOT });
          return {
            ok: true as const,
            value: {
              type: "tab_created",
              tab: { tab_id: tabId, workspace_id: wsId, label, focused: true, pane_count: 1, agent_status: "unknown" },
              root_pane: { pane_id: paneId, terminal_id: `term-${paneId}`, workspace_id: wsId, tab_id: tabId, focused: true, agent: null, agent_status: "unknown", revision: 1, cwd: ROOT }
            }
          };
        }
        if (method === "pane.split") {
          const targetId = String(params["target_pane_id"] ?? "p1");
          const cwd = String(params["cwd"] ?? ROOT);
          const source = this.panes.get(targetId);
          if (!source) throw new Error(`Target pane ${targetId} not found`);
          const paneId = `p${this.nextPane++}`;
          this.panes.set(paneId, { id: paneId, tabId: source.tabId, wsId: source.wsId, agent: null, cwd });
          return {
            ok: true as const,
            value: {
              type: "pane_info",
              pane: { pane_id: paneId, terminal_id: `term-${paneId}`, workspace_id: source.wsId, tab_id: source.tabId, focused: false, agent: null, agent_status: "unknown", revision: 1, cwd }
            }
          };
        }
        throw new Error(`Unhandled FakeHerdr socket method ${method}`);
      }
    };
  }

  split(sourcePaneId: string, cwd: string) {
    const source = this.panes.get(sourcePaneId);
    if (!source) throw new Error(`Source pane ${sourcePaneId} missing`);
    const paneId = `p${this.nextPane++}`;
    this.panes.set(paneId, { id: paneId, tabId: source.tabId, wsId: source.wsId, agent: null, cwd });
    return {
      type: "pane_info",
      pane: {
        pane_id: paneId,
        terminal_id: `term-${paneId}`,
        workspace_id: source.wsId,
        tab_id: source.tabId,
        focused: false,
        agent: null,
        agent_status: "unknown",
        revision: 1,
        cwd
      }
    };
  }

  reply(result: Record<string, unknown>): CommandOutcome {
    return { exitCode: 0, stdout: JSON.stringify({ id: "1", result }), stderr: "" };
  }

  fail(code: string, message = code): CommandOutcome {
    return { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code, message } }) };
  }

  async run(invocation: CommandInvocation): Promise<CommandOutcome> {
    this.calls.push(invocation);
    const [domain, action, ...rest] = invocation.args;

    if (domain === "workspace" && action === "list") {
      return this.reply({
        type: "workspace_list",
        workspaces: [...this.workspaces.values()].map(w => ({
          workspace_id: w.id,
          label: w.label,
          active_tab_id: w.activeTabId,
          focused: true,
          pane_count: [...this.panes.values()].filter(p => p.wsId === w.id).length
        }))
      });
    }

    if (domain === "tab" && action === "list") {
      const wsId = flag(rest, "--workspace") ?? "w1";
      return this.reply({
        type: "tab_list",
        tabs: [...this.tabs.values()].filter(t => t.wsId === wsId).map(t => ({
          tab_id: t.id,
          workspace_id: t.wsId,
          label: t.label,
          focused: true,
          pane_count: [...this.panes.values()].filter(p => p.tabId === t.id).length,
          agent_status: "unknown"
        }))
      });
    }

    if (domain === "pane" && action === "list") {
      const wsId = flag(rest, "--workspace") ?? "w1";
      return this.reply({
        type: "pane_list",
        panes: [...this.panes.values()].filter(p => p.wsId === wsId).map(p => ({
          pane_id: p.id,
          terminal_id: `term-${p.id}`,
          workspace_id: p.wsId,
          tab_id: p.tabId,
          focused: false,
          agent: p.agent,
          agent_status: p.agent ? "idle" : "unknown",
          revision: 1,
          cwd: p.cwd
        }))
      });
    }

    if (domain === "agent" && action === "list") {
      return this.reply({
        type: "agent_list",
        agents: [...this.agents.values()].map(a => {
          const pane = this.panes.get(a.paneId)!;
          return {
            pane_id: a.paneId,
            terminal_id: `term-${a.paneId}`,
            workspace_id: pane.wsId,
            tab_id: pane.tabId,
            focused: false,
            agent: a.kind,
            name: a.name,
            agent_status: a.agentStatus,
            revision: 1,
            interactive_ready: a.interactiveReady,
            launch_pending: a.launchPending,
            ...(a.session ? { agent_session: a.session } : {})
          };
        })
      });
    }

    if (domain === "pane" && (action === "process" || action === "process-info")) {
      const paneId = flag(rest, "--pane") ?? rest[0]!;
      return this.reply({
        type: "pane_process_info",
        process_info: {
          pane_id: paneId,
          shell_pid: 1000,
          foreground_process_group_id: 1000,
          foreground_processes: [{ pid: 1000, command: "bash" }]
        }
      });
    }

    if (domain === "pane" && action === "close") {
      const paneId = rest[0]!;
      this.panes.delete(paneId);
      for (const [name, agent] of this.agents) {
        if (agent.paneId === paneId) this.agents.delete(name);
      }
      return this.reply({ type: "ok" });
    }

    if (domain === "pane" && action === "rename") {
      const paneId = rest[0]!;
      const pane = this.panes.get(paneId);
      return this.reply({
        type: "pane_info",
        pane: {
          pane_id: paneId,
          terminal_id: `term-${paneId}`,
          workspace_id: pane?.wsId ?? "w1",
          tab_id: pane?.tabId ?? "t1",
          focused: false,
          agent: pane?.agent ?? null,
          agent_status: "idle",
          revision: 1
        }
      });
    }

    if (domain === "tab" && action === "rename") {
      return this.reply({ type: "tab_info", tab: { tab_id: rest[0]!, revision: 1 } });
    }

    if (domain === "pane" && action === "layout") {
      const paneId = flag(rest, "--pane") ?? rest[0]!;
      const pane = this.panes.get(paneId);
      const tabPanes = [...this.panes.values()].filter(p => p.tabId === pane?.tabId);
      return this.reply({
        type: "pane_layout",
        layout: {
          workspace_id: pane?.wsId ?? "w1",
          tab_id: pane?.tabId ?? "t1",
          panes: tabPanes.map((p, idx) => ({
            pane_id: p.id,
            rect: { x: idx * 100, y: 0, width: 100, height: 100 }
          })),
          splits: []
        }
      });
    }

    if (domain === "workspace" && action === "focus") {
      return this.reply({ type: "workspace_info", workspace: { workspace_id: rest[0]!, label: "ws", active_tab_id: "t1", focused: true, pane_count: 1 } });
    }

    if (domain === "tab" && action === "focus") {
      return this.reply({ type: "tab_info", tab: { tab_id: rest[0]!, workspace_id: "w1", label: "tab", focused: true, pane_count: 1, agent_status: "unknown" } });
    }

    if (domain === "agent" && action === "focus") {
      return this.reply({ type: "agent_info", agent: { pane_id: rest[0]!, terminal_id: `term-${rest[0]!}`, workspace_id: "w1", tab_id: "t1", focused: true, agent: "claude", name: "agent", agent_status: "idle", revision: 1 } });
    }

    if (domain === "worktree" && (action === "create" || action === "open")) {
      const path = flag(rest, "--path") ?? "/repo/.worktrees/wt";
      const label = flag(rest, "--label") ?? "dev";
      const wsId = `w${this.nextWs++}`;
      const tabId = `t${this.nextTab++}`;
      const paneId = `p${this.nextPane++}`;
      this.workspaces.set(wsId, { id: wsId, label, activeTabId: tabId });
      this.tabs.set(tabId, { id: tabId, wsId, label });
      this.panes.set(paneId, { id: paneId, tabId, wsId, agent: null, cwd: path });
      return this.reply({
        type: action === "create" ? "worktree_created" : "worktree_opened",
        workspace: { workspace_id: wsId, label, active_tab_id: tabId, focused: true, pane_count: 1 },
        tab: { tab_id: tabId, workspace_id: wsId, label, focused: true, pane_count: 1, agent_status: "unknown" },
        root_pane: { pane_id: paneId, terminal_id: `term-${paneId}`, workspace_id: wsId, tab_id: tabId, focused: true, agent: null, agent_status: "unknown", revision: 1, cwd: path },
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

    if (domain === "agent" && action === "start") {
      const name = rest[0]!;
      const kind = flag(rest, "--kind") ?? "claude";
      const paneId = flag(rest, "--pane") ?? "p1";
      if (this.failStartRole && name.includes(this.failStartRole)) {
        return this.fail("agent_not_ready", "Provider process failed to start");
      }
      const pane = this.panes.get(paneId);
      if (pane) pane.agent = name;
      const isDelayed = this.delayedSessionRole && name.includes(this.delayedSessionRole);
      const session = isDelayed ? undefined : { source: kind, kind: "id" as const, value: `sess-${name}` };
      this.agents.set(name, {
        name,
        kind,
        paneId,
        agentStatus: "idle",
        interactiveReady: true,
        launchPending: false,
        session
      });
      return this.reply({
        type: "agent_started",
        agent: {
          pane_id: paneId,
          terminal_id: `term-${paneId}`,
          workspace_id: pane?.wsId ?? "w1",
          tab_id: pane?.tabId ?? "t1",
          focused: true,
          agent: kind,
          name,
          agent_status: "idle",
          revision: 1,
          interactive_ready: true,
          launch_pending: false,
          ...(session ? { agent_session: session } : {})
        }
      });
    }

    if (domain === "agent" && action === "get") {
      const paneId = rest[0]!;
      const found = [...this.agents.values()].find(a => a.paneId === paneId);
      if (!found) {
        return this.fail("not_found", "Agent not found");
      }
      if (this.delayedSessionRole && found.name.includes(this.delayedSessionRole)) {
        this.delayedSessionQueries++;
        if (this.delayedSessionQueries >= 2) {
          found.session = { source: found.kind, kind: "id", value: `sess-${found.name}` };
        }
      }
      const pane = this.panes.get(paneId);
      return this.reply({
        type: "agent_info",
        agent: {
          pane_id: paneId,
          terminal_id: `term-${paneId}`,
          workspace_id: pane?.wsId ?? "w1",
          tab_id: pane?.tabId ?? "t1",
          focused: false,
          agent: found.kind,
          name: found.name,
          agent_status: found.agentStatus,
          revision: 1,
          interactive_ready: found.interactiveReady,
          launch_pending: found.launchPending,
          ...(found.session ? { agent_session: found.session } : {})
        }
      });
    }

    if (domain === "pane" && action === "get") {
      const paneId = rest[0]!;
      const pane = this.panes.get(paneId);
      if (!pane) {
        return this.fail("not_found", "Pane not found");
      }
      return this.reply({
        type: "pane_info",
        pane: {
          pane_id: paneId,
          terminal_id: `term-${paneId}`,
          workspace_id: pane.wsId,
          tab_id: pane.tabId,
          focused: false,
          agent: pane.agent,
          agent_status: pane.agent ? "idle" : "unknown",
          revision: 1,
          cwd: pane.cwd
        }
      });
    }

    if (domain === "pane" && action === "read") {
      return {
        exitCode: 0,
        stdout: "fatal error: cannot find module 'some-pkg'\nProcess exited with code 1\n",
        stderr: ""
      };
    }

    return this.reply({ type: "ok" });
  }
}

describe("Flow-04 Round 4 Platform Startup & Pane Manager hardening", () => {
  function makeLaunch(launchId: string, promptSource: string, model?: string): AgentLaunchProfile {
    return {
      provider: "claude",
      launchId,
      launchFingerprint: `fp-${launchId}`,
      env: { BFLOW_LAUNCH_ID: launchId, MCP_TIMEOUT: "120000" },
      argv: ["--append-system-prompt-file", promptSource],
      ...(model ? { model } : {})
    };
  }

  it("partial up that fails during agent startup keeps only the failed role's pane for diagnosis and recovers on retry", async () => {
    const herdr = new FakeHerdr();
    const store = new InMemorySessionManifestStore();
    const inspector: WorktreeInspector = {
      inspect: async () => ({ ok: true, value: { exists: false, isClean: true, dirtyFiles: [] } })
    };

    const config: RolePaneManagerConfig = {
      sessionId: "sess-round4-orphan",
      projectName: "orphan-test",
      workspaceRoot: ROOT,
      defaultProvider: "claude",
      defaultAgentKind: "claude",
      permanentRoles: ["chat", "coordinator", "reviewer"],
      roleConfigs: {
        chat: { agentKind: "claude", launch: makeLaunch("l-chat", chatPromptSource) },
        coordinator: { agentKind: "claude", launch: makeLaunch("l-coord", coordinatorPromptSource) },
        reviewer: { agentKind: "claude", launch: makeLaunch("l-rev", reviewerPromptSource) }
      }
    };

    const manager = createRolePaneManager({
      config,
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: inspector
    });

    // Make coordinator fail startup!
    herdr.failStartRole = "coordinator";
    const firstUp = await manager.initializeTopology();
    expect(firstUp.ok).toBe(false);

    // Any pane created for reviewer (which was queued behind the failed coordinator) must NOT be left as an unassigned orphan bare shell!
    const panesAfterFailedUp = [...herdr.panes.values()];
    const bareOrphanPanes = panesAfterFailedUp.filter(p => p.agent === null);
    // Only the failed role's own pane is preserved (for diagnosis); queued intents stay recoverable.
    expect(bareOrphanPanes.length).toBeLessThanOrEqual(1);
    if (!firstUp.ok) expect(firstUp.error.message).toContain(`pane '${bareOrphanPanes[0]?.id}'`);

    // Now fix coordinator and retry up!
    herdr.failStartRole = null;
    const secondUp = await manager.initializeTopology();
    expect(secondUp.ok).toBe(true);
    if (!secondUp.ok) return;

    expect(secondUp.value.status).toBe("up");
    expect(secondUp.value.panes.length).toBe(3);
  });

  it("settles native session across all providers when agent_started has pending session", async () => {
    const herdr = new FakeHerdr();
    const store = new InMemorySessionManifestStore();
    const inspector: WorktreeInspector = {
      inspect: async () => ({ ok: true, value: { exists: false, isClean: true, dirtyFiles: [] } })
    };

    const config: RolePaneManagerConfig = {
      sessionId: "sess-round4-session",
      projectName: "session-settle-test",
      workspaceRoot: ROOT,
      defaultProvider: "claude",
      defaultAgentKind: "claude",
      permanentRoles: ["chat"],
      roleConfigs: {
        chat: { agentKind: "claude", launch: makeLaunch("l-chat-sess", chatPromptSource) }
      }
    };

    const manager = createRolePaneManager({
      config,
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: inspector
    });

    // Simulate Claude's SessionStart taking a couple polling ticks
    herdr.delayedSessionRole = "chat";
    const init = await manager.initializeTopology();
    if (!init.ok) console.log("INIT ERROR:", init.error);
    expect(init.ok).toBe(true);
    if (!init.ok) return;

    const chatPane = init.value.panes.find(p => p.role === "conversation");
    expect(chatPane?.session).toBeDefined();
    expect(chatPane?.session?.value).toBe("sess-chat");
    expect(chatPane?.metadata?.["nativeSessionPending"]).toBeFalsy();
  });

  it("releaseDeveloper and releaseSpecialist reload latest manifest from store to avoid RMW race", async () => {
    const herdr = new FakeHerdr();
    const store = new InMemorySessionManifestStore();
    const inspector: WorktreeInspector = {
      inspect: async () => ({ ok: true, value: { exists: true, isClean: true, dirtyFiles: [] } })
    };

    const config: RolePaneManagerConfig = {
      sessionId: "sess-round4-rmw",
      projectName: "rmw-test",
      workspaceRoot: ROOT,
      defaultProvider: "claude",
      defaultAgentKind: "claude",
      permanentRoles: ["chat", "coordinator"],
      roleConfigs: {
        chat: { agentKind: "claude", launch: makeLaunch("l-chat", chatPromptSource) },
        coordinator: { agentKind: "claude", launch: makeLaunch("l-coord", coordinatorPromptSource) }
      }
    };

    const manager = createRolePaneManager({
      config,
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: inspector
    });

    const init = await manager.initializeTopology();
    if (!init.ok) console.log("INIT ERROR:", init.error);
    expect(init.ok).toBe(true);
    if (!init.ok) return;

    // Allocate a developer
    const devAlloc = await manager.allocateDeveloper({
      taskId: "task-rmw",
      worktreePath: "/repo/.worktrees/task-rmw",
      agentName: "dev-rmw"
    });
    expect(devAlloc.ok).toBe(true);
    if (!devAlloc.ok) return;

    // Simulate an external concurrent update to the store (e.g. heartbeat or attachTarget) while developer runs
    const currentManifestRes = await store.load("sess-round4-rmw");
    expect(currentManifestRes.ok).toBe(true);
    const concurrentManifest: SessionManifest = {
      ...currentManifestRes.value!,
      metadata: { ...currentManifestRes.value!.metadata, concurrentUpdateKey: "concurrent-value-123" }
    };
    await store.save(concurrentManifest);

    // Now release the developer with closePane
    const releaseRes = await manager.releaseDeveloper({ taskId: "task-rmw", closePane: true });
    expect(releaseRes.ok).toBe(true);
    if (!releaseRes.ok) return;

    // The saved manifest must NOT have clobbered the concurrent metadata!
    const finalManifestRes = await store.load("sess-round4-rmw");
    expect(finalManifestRes.ok).toBe(true);
    expect(finalManifestRes.value?.metadata?.["concurrentUpdateKey"]).toBe("concurrent-value-123");
    expect(finalManifestRes.value?.panes.some(p => p.metadata?.["taskId"] === "task-rmw")).toBe(false);
  });

  it("buildProviderRoleLaunch correctly injects model flag for both claude and codex", () => {
    const claudeLaunch = buildProviderRoleLaunch({
      agentKind: "claude",
      role: "chat",
      systemPrompt: "You are the chat assistant",
      model: "claude-3-7-sonnet"
    });
    expect(claudeLaunch).toContain("--model");
    expect(claudeLaunch[claudeLaunch.indexOf("--model") + 1]).toBe("claude-3-7-sonnet");

    const codexLaunch = buildProviderRoleLaunch({
      agentKind: "codex",
      role: "developer",
      systemPrompt: "You are developer",
      model: "o3-mini"
    });
    expect(codexLaunch).toContain("--model");
    expect(codexLaunch[codexLaunch.indexOf("--model") + 1]).toBe("o3-mini");
  });

  it("startupBlocked classifies provider crashes/errors accurately instead of generic interactive dialog", async () => {
    const herdr = new FakeHerdr();
    const store = new InMemorySessionManifestStore();
    const inspector: WorktreeInspector = {
      inspect: async () => ({ ok: true, value: { exists: false, isClean: true, dirtyFiles: [] } })
    };

    const config: RolePaneManagerConfig = {
      sessionId: "sess-round4-crash",
      projectName: "crash-diag-test",
      workspaceRoot: ROOT,
      defaultProvider: "claude",
      defaultAgentKind: "claude",
      permanentRoles: ["chat"],
      roleConfigs: {
        chat: { agentKind: "claude", launch: makeLaunch("l-chat-crash", chatPromptSource) }
      }
    };

    const manager = createRolePaneManager({
      config,
      runner: herdr,
      socket: herdr.socket,
      store,
      worktreeInspector: inspector
    });

    // Make chat fail startup with agent_blocked so #startupBlocked is triggered
    herdr.failStartRole = "chat";
    const init = await manager.initializeTopology();
    expect(init.ok).toBe(false);
    if (init.ok) return;

    expect(init.error.message).toContain("Provider process crashed or exited with an error in this pane");
  });
});
