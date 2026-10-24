import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManifestSchema,
  PaneBindingSchema,
  type OperationOptions,
  type OperationResult
} from "@bflow/contracts";
import {
  type RolePaneManagerConfig,
  type CommandInvocation,
  type CommandOutcome,
  type HerdrCommandRunner,
  type WorktreeInspector,
  type WorktreeCleanlinessResult,
  type HerdrWorkspaceInfo,
  type HerdrTabInfo,
  type HerdrPaneInfo,
  type HerdrAgentInfo,
  type HerdrProcessInfo,
  type HerdrWorktreeInfo,
  type RoleHealthReport,
  type TopologyHealthSummary,
  type SessionManifestStore,
  PERMANENT_TOPOLOGY_ROLES
} from "../src/types.js";
import {
  RolePaneManager,
  createRolePaneManager
} from "../src/role-pane-manager.js";
import {
  InMemorySessionManifestStore,
  FileSessionManifestStore
} from "../src/manifest-store.js";
import {
  createProcessRunner,
  createGitWorktreeInspector
} from "../src/runner.js";

/**
 * Stateful FakeHerdrCommandRunner that simulates Herdr CLI 0.9.x protocol 22 / schema 1 JSON responses:
 * - workspace list, create, focus
 * - tab list, create, focus
 * - pane list, get, process-info, split, rename, move, close
 * - agent list, get, start, focus
 * - worktree create, open, remove
 * - ok and error responses ({ id: "1", error: { code, message } })
 */
class FakeHerdrCommandRunner implements HerdrCommandRunner {
  readonly calls: CommandInvocation[] = [];
  idCounter = 0;

  workspaces = new Map<string, HerdrWorkspaceInfo & { tabIds: string[] }>();
  tabs = new Map<string, HerdrTabInfo & { paneIds: string[] }>();
  panes = new Map<string, HerdrPaneInfo>();
  processInfos = new Map<string, HerdrProcessInfo>();
  agents = new Map<string, HerdrAgentInfo>();
  worktrees = new Map<string, HerdrWorktreeInfo>();

  onCommand?: (invocation: CommandInvocation) => CommandOutcome | undefined;

  toWorkspaceJson(w: HerdrWorkspaceInfo): Record<string, unknown> {
    return {
      workspace_id: w.workspaceId,
      label: w.label,
      active_tab_id: w.activeTabId,
      focused: w.focused,
      pane_count: w.paneCount,
      tab_count: w.tabCount,
      agent_status: w.agentStatus,
      ...(w.worktree !== undefined
        ? {
            worktree: {
              repo_key: w.worktree.repoKey,
              repo_name: w.worktree.repoName,
              repo_root: w.worktree.repoRoot,
              checkout_path: w.worktree.checkoutPath,
              is_linked_worktree: w.worktree.isLinkedWorktree
            }
          }
        : {})
    };
  }

  toTabJson(t: HerdrTabInfo): Record<string, unknown> {
    return {
      tab_id: t.tabId,
      workspace_id: t.workspaceId,
      label: t.label,
      focused: t.focused,
      pane_count: t.paneCount,
      agent_status: t.agentStatus
    };
  }

  toPaneJson(p: HerdrPaneInfo): Record<string, unknown> {
    return {
      pane_id: p.paneId,
      terminal_id: p.terminalId,
      workspace_id: p.workspaceId,
      tab_id: p.tabId,
      focused: p.focused,
      agent: p.agent,
      agent_status: p.agentStatus,
      revision: p.revision,
      ...(p.label !== undefined && p.label !== null ? { label: p.label } : {}),
      ...(p.cwd !== undefined && p.cwd !== null ? { cwd: p.cwd } : {}),
      ...(p.foregroundCwd !== undefined && p.foregroundCwd !== null ? { foreground_cwd: p.foregroundCwd } : {}),
      ...(p.session !== undefined ? { agent_session: p.session } : {})
    };
  }

  toAgentJson(a: HerdrAgentInfo): Record<string, unknown> {
    return {
      name: a.name,
      agent: a.agent,
      pane_id: a.paneId,
      terminal_id: a.terminalId,
      workspace_id: a.workspaceId,
      tab_id: a.tabId,
      focused: a.focused,
      agent_status: a.agentStatus,
      revision: a.revision,
      ...(a.interactiveReady !== undefined ? { interactive_ready: a.interactiveReady } : {}),
      ...(a.launchPending !== undefined ? { launch_pending: a.launchPending } : {}),
      ...(a.stateChangeSequence !== undefined ? { state_change_seq: a.stateChangeSequence } : {}),
      ...(a.cwd !== undefined && a.cwd !== null ? { cwd: a.cwd } : {}),
      ...(a.foregroundCwd !== undefined && a.foregroundCwd !== null ? { foreground_cwd: a.foregroundCwd } : {}),
      ...(a.session !== undefined ? { agent_session: a.session } : {})
    };
  }

  toProcessInfoJson(pi: HerdrProcessInfo): Record<string, unknown> {
    return {
      pane_id: pi.paneId,
      shell_pid: pi.shellPid,
      foreground_process_group_id: pi.foregroundProcessGroupId,
      foreground_processes: pi.foregroundProcesses.map((p) => ({
        pid: p.pid,
        ...(p.command !== undefined ? { command: p.command } : {}),
        ...(p.argv !== undefined ? { argv: p.argv } : {})
      })),
      ...(pi.tty !== undefined && pi.tty !== null ? { tty: pi.tty } : {})
    };
  }

  async run(invocation: CommandInvocation): Promise<CommandOutcome> {
    this.calls.push(invocation);
    if (this.onCommand) {
      const intercepted = this.onCommand(invocation);
      if (intercepted !== undefined) return intercepted;
    }

    const { args } = invocation;
    const [domain, action, ...rest] = args;

    // workspace domain
    if (domain === "workspace") {
      if (action === "list") {
        const list = Array.from(this.workspaces.values()).map((w) => this.toWorkspaceJson(w));
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "workspace_list", workspaces: list } }),
          stderr: ""
        };
      }
      if (action === "create") {
        const labelIdx = rest.indexOf("--label");
        const label = labelIdx !== -1 && rest[labelIdx + 1] ? rest[labelIdx + 1]! : "workspace";
        const cwdIdx = rest.indexOf("--cwd");
        const cwd = cwdIdx !== -1 && rest[cwdIdx + 1] ? rest[cwdIdx + 1]! : "/workspace";

        const wsId = "ws-" + (++this.idCounter);
        const tabId = "tab-" + (++this.idCounter);
        const paneId = "pane-" + (++this.idCounter);
        const termId = "term-" + (++this.idCounter);

        const pane: HerdrPaneInfo = {
          paneId,
          terminalId: termId,
          workspaceId: wsId,
          tabId,
          focused: true,
          agent: null,
          agentStatus: "idle",
          revision: 1,
          cwd
        };
        this.panes.set(paneId, pane);
        this.processInfos.set(paneId, {
          paneId,
          shellPid: 1000 + this.idCounter,
          foregroundProcessGroupId: 1000 + this.idCounter,
          foregroundProcesses: []
        });

        const tab: HerdrTabInfo & { paneIds: string[] } = {
          tabId,
          workspaceId: wsId,
          label: "conversation",
          focused: true,
          paneCount: 1,
          agentStatus: "idle",
          paneIds: [paneId]
        };
        this.tabs.set(tabId, tab);

        const ws: HerdrWorkspaceInfo & { tabIds: string[] } = {
          workspaceId: wsId,
          label,
          activeTabId: tabId,
          focused: false,
          paneCount: 1,
          tabCount: 1,
          agentStatus: "idle",
          tabIds: [tabId]
        };
        this.workspaces.set(wsId, ws);

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "1",
            result: {
              type: "workspace_created",
              workspace: this.toWorkspaceJson(ws),
              tab: this.toTabJson(tab),
              root_pane: this.toPaneJson(pane)
            }
          }),
          stderr: ""
        };
      }
      if (action === "focus") {
        const wsId = rest[0];
        const ws = wsId ? this.workspaces.get(wsId) : undefined;
        if (!ws) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({
              id: "1",
              error: { code: "workspace_not_found", message: `Workspace not found: ${wsId}` }
            })
          };
        }
        for (const w of this.workspaces.values()) w.focused = false;
        ws.focused = true;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "workspace_info", workspace: this.toWorkspaceJson(ws) } }),
          stderr: ""
        };
      }
    }

    // tab domain
    if (domain === "tab") {
      if (action === "list") {
        const wsIdx = rest.indexOf("--workspace");
        const wsId = wsIdx !== -1 ? rest[wsIdx + 1] : undefined;
        const tabs = Array.from(this.tabs.values()).filter((t) => !wsId || t.workspaceId === wsId);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "tab_list", tabs: tabs.map((t) => this.toTabJson(t)) } }),
          stderr: ""
        };
      }
      if (action === "create") {
        const wsIdx = rest.indexOf("--workspace");
        const wsId = wsIdx !== -1 && rest[wsIdx + 1] ? rest[wsIdx + 1]! : "ws-default";
        const labelIdx = rest.indexOf("--label");
        const label = labelIdx !== -1 && rest[labelIdx + 1] ? rest[labelIdx + 1]! : "tab";
        const cwdIdx = rest.indexOf("--cwd");
        const cwd = cwdIdx !== -1 && rest[cwdIdx + 1] ? rest[cwdIdx + 1]! : "/workspace";

        const tabId = "tab-" + (++this.idCounter);
        const paneId = "pane-" + (++this.idCounter);
        const termId = "term-" + (++this.idCounter);

        const pane: HerdrPaneInfo = {
          paneId,
          terminalId: termId,
          workspaceId: wsId,
          tabId,
          focused: true,
          agent: null,
          agentStatus: "idle",
          revision: 1,
          cwd
        };
        this.panes.set(paneId, pane);
        this.processInfos.set(paneId, {
          paneId,
          shellPid: 1000 + this.idCounter,
          foregroundProcessGroupId: 1000 + this.idCounter,
          foregroundProcesses: []
        });

        const tab: HerdrTabInfo & { paneIds: string[] } = {
          tabId,
          workspaceId: wsId,
          label,
          focused: false,
          paneCount: 1,
          agentStatus: "idle",
          paneIds: [paneId]
        };
        this.tabs.set(tabId, tab);

        const ws = this.workspaces.get(wsId);
        if (ws) {
          ws.tabCount++;
          ws.paneCount++;
          ws.tabIds.push(tabId);
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "1",
            result: {
              type: "tab_created",
              tab: this.toTabJson(tab),
              root_pane: this.toPaneJson(pane)
            }
          }),
          stderr: ""
        };
      }
      if (action === "focus") {
        const tabId = rest[0];
        const tab = tabId ? this.tabs.get(tabId) : undefined;
        if (!tab) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({
              id: "1",
              error: { code: "tab_not_found", message: `Tab not found: ${tabId}` }
            })
          };
        }
        for (const t of this.tabs.values()) t.focused = false;
        tab.focused = true;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "tab_info", tab: this.toTabJson(tab) } }),
          stderr: ""
        };
      }
    }

    // pane domain
    if (domain === "pane") {
      if (action === "list") {
        const wsIdx = rest.indexOf("--workspace");
        const wsId = wsIdx !== -1 ? rest[wsIdx + 1] : undefined;
        if (wsId && !this.workspaces.has(wsId)) {
          return { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: {
            code: "workspace_not_found", message: `workspace ${wsId} not found`
          } }) };
        }
        const panes = Array.from(this.panes.values()).filter((p) => !wsId || p.workspaceId === wsId);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "pane_list", panes: panes.map((p) => this.toPaneJson(p)) } }),
          stderr: ""
        };
      }
      if (action === "get") {
        const paneId = rest[0];
        const pane = paneId ? this.panes.get(paneId) : undefined;
        if (!pane) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({
              id: "1",
              error: { code: "pane_not_found", message: `Pane not found: ${paneId}` }
            })
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "pane_info", pane: this.toPaneJson(pane) } }),
          stderr: ""
        };
      }
      if (action === "layout") {
        const id = rest[rest.indexOf("--pane") + 1]!;
        const pane = this.panes.get(id)!;
        const panes = [...this.panes.values()].filter(p => p.tabId === pane.tabId);
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ id: "1", result: { type: "pane_layout", layout: {
          workspace_id: pane.workspaceId, tab_id: pane.tabId, panes: panes.map((p,i) => ({ pane_id:p.paneId,
            rect:{x:i*40,y:0,width:40,height:40} })), splits:[] } } }) };
      }
      if (action === "process-info") {
        const paneIdx = rest.indexOf("--pane");
        const paneId = paneIdx !== -1 && rest[paneIdx + 1] ? rest[paneIdx + 1]! : (rest[0] ?? "");
        const pi = this.processInfos.get(paneId) ?? {
          paneId,
          shellPid: 1234,
          foregroundProcessGroupId: 1234,
          foregroundProcesses: []
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "1",
            result: { type: "pane_process_info", process_info: this.toProcessInfoJson(pi) }
          }),
          stderr: ""
        };
      }
      if (action === "split") {
        const sourcePaneId = rest[0]!;
        const source = this.panes.get(sourcePaneId);
        if (!source) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({
              id: "1",
              error: { code: "pane_not_found", message: `Source pane not found: ${sourcePaneId}` }
            })
          };
        }
        const newPaneId = "pane-" + (++this.idCounter);
        const newTermId = "term-" + (++this.idCounter);
        const newPane: HerdrPaneInfo = {
          paneId: newPaneId,
          terminalId: newTermId,
          workspaceId: source.workspaceId,
          tabId: source.tabId,
          focused: false,
          agent: null,
          agentStatus: "idle",
          revision: 1
        };
        this.panes.set(newPaneId, newPane);
        this.processInfos.set(newPaneId, {
          paneId: newPaneId,
          shellPid: 1000 + this.idCounter,
          foregroundProcessGroupId: 1000 + this.idCounter,
          foregroundProcesses: []
        });
        const tab = this.tabs.get(source.tabId);
        if (tab) {
          tab.paneCount++;
          tab.paneIds.push(newPaneId);
        }
        const ws = this.workspaces.get(source.workspaceId);
        if (ws) ws.paneCount++;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "pane_info", pane: this.toPaneJson(newPane) } }),
          stderr: ""
        };
      }
      if (action === "rename") {
        const paneId = rest[0]!;
        const label = rest[1] ?? "";
        const pane = this.panes.get(paneId);
        if (!pane) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({
              id: "1",
              error: { code: "pane_not_found", message: `Pane not found: ${paneId}` }
            })
          };
        }
        const updated = { ...pane, label };
        this.panes.set(paneId, updated);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "pane_info", pane: this.toPaneJson(updated) } }),
          stderr: ""
        };
      }
      if (action === "move") {
        const paneId = rest[0]!;
        const pane = this.panes.get(paneId);
        if (!pane) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({
              id: "1",
              error: { code: "pane_not_found", message: `Pane not found: ${paneId}` }
            })
          };
        }
        const prevPaneId = pane.paneId;
        const prevWs = pane.workspaceId;
        const prevTab = pane.tabId;
        const newPaneId = "pane-mv-" + (++this.idCounter);
        const newTermId = "term-mv-" + (++this.idCounter);
        this.panes.delete(prevPaneId);
        const movedPane: HerdrPaneInfo = {
          ...pane,
          paneId: newPaneId,
          terminalId: newTermId
        };
        this.panes.set(newPaneId, movedPane);
        for (const [key, ag] of this.agents.entries()) {
          if (ag.paneId === prevPaneId) {
            this.agents.set(key, { ...ag, paneId: newPaneId, terminalId: newTermId });
          }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "1",
            result: {
              type: "pane_move",
              move_result: {
                changed: true,
                previous_pane_id: prevPaneId,
                previous_workspace_id: prevWs,
                previous_tab_id: prevTab,
                pane: this.toPaneJson(movedPane),
                focused_pane_id: newPaneId
              }
            }
          }),
          stderr: ""
        };
      }
      if (action === "close") {
        const paneId = rest[0]!;
        this.panes.delete(paneId);
        this.processInfos.delete(paneId);
        for (const [key, ag] of this.agents.entries()) {
          if (ag.paneId === paneId) this.agents.delete(key);
        }
        return { exitCode: 0, stdout: JSON.stringify({ id: "1", result: { type: "ok" } }), stderr: "" };
      }
    }

    // agent domain
    if (domain === "agent") {
      if (action === "list") {
        const list = Array.from(this.agents.values()).map((a) => this.toAgentJson(a));
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "agent_list", agents: list } }),
          stderr: ""
        };
      }
      if (action === "get") {
        const target = rest[0];
        const agent = Array.from(this.agents.values()).find((a) => a.name === target || a.paneId === target);
        if (!agent) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({
              id: "1",
              error: { code: "agent_not_found", message: `Agent not found: ${target}` }
            })
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "agent_info", agent: this.toAgentJson(agent) } }),
          stderr: ""
        };
      }
      if (action === "start") {
        const name = rest[0]!;
        const kindIdx = rest.indexOf("--kind");
        const kind = kindIdx !== -1 && rest[kindIdx + 1] ? rest[kindIdx + 1]! : "pi";
        const paneIdx = rest.indexOf("--pane");
        const paneId = paneIdx !== -1 && rest[paneIdx + 1] ? rest[paneIdx + 1]! : (rest[1] ?? "");
        const pane = this.panes.get(paneId);
        if (!pane) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({
              id: "1",
              error: { code: "pane_not_found", message: `Pane not found: ${paneId}` }
            })
          };
        }
        pane.agent = kind;
        const ag: HerdrAgentInfo = {
          name,
          agent: kind,
          paneId,
          workspaceId: pane.workspaceId,
          tabId: pane.tabId,
          terminalId: pane.terminalId,
          focused: pane.focused,
          agentStatus: "idle",
          revision: 1,
          interactiveReady: true,
          launchPending: false
        };
        this.agents.set(name, ag);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "agent_started", agent: this.toAgentJson(ag) } }),
          stderr: ""
        };
      }
      if (action === "focus") {
        const target = rest[0];
        const agent = Array.from(this.agents.values()).find((a) => a.name === target || a.paneId === target);
        if (!agent) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({
              id: "1",
              error: { code: "agent_not_found", message: `Agent not found: ${target}` }
            })
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ id: "1", result: { type: "agent_info", agent: this.toAgentJson(agent) } }),
          stderr: ""
        };
      }
    }

    // worktree domain
    if (domain === "worktree") {
      if (action === "create" || action === "open") {
        const branchIdx = rest.indexOf("--branch");
        const branch = branchIdx !== -1 && rest[branchIdx + 1] ? rest[branchIdx + 1]! : null;
        const pathIdx = rest.indexOf("--path");
        const path = pathIdx !== -1 && rest[pathIdx + 1] ? rest[pathIdx + 1]! : "/worktree";
        const labelIdx = rest.indexOf("--label");
        const label = labelIdx !== -1 && rest[labelIdx + 1] ? rest[labelIdx + 1]! : "wt";

        const wtWsId = "ws-wt-" + (++this.idCounter);
        const wtTabId = "tab-wt-" + (++this.idCounter);
        const wtPaneId = "pane-wt-" + (++this.idCounter);
        const wtTermId = "term-wt-" + (++this.idCounter);

        const pane: HerdrPaneInfo = {
          paneId: wtPaneId,
          terminalId: wtTermId,
          workspaceId: wtWsId,
          tabId: wtTabId,
          focused: true,
          agent: null,
          agentStatus: "idle",
          revision: 1
        };
        this.panes.set(wtPaneId, pane);
        this.processInfos.set(wtPaneId, {
          paneId: wtPaneId,
          shellPid: 1000 + this.idCounter,
          foregroundProcessGroupId: 1000 + this.idCounter,
          foregroundProcesses: []
        });

        const tab: HerdrTabInfo & { paneIds: string[] } = {
          tabId: wtTabId,
          workspaceId: wtWsId,
          label: "developer",
          focused: true,
          paneCount: 1,
          agentStatus: "idle",
          paneIds: [wtPaneId]
        };
        this.tabs.set(wtTabId, tab);

        const ws: HerdrWorkspaceInfo & { tabIds: string[] } = {
          workspaceId: wtWsId,
          label,
          activeTabId: wtTabId,
          focused: false,
          paneCount: 1,
          tabCount: 1,
          agentStatus: "idle",
          tabIds: [wtTabId]
        };
        this.workspaces.set(wtWsId, ws);

        const wtInfo: HerdrWorktreeInfo = {
          path,
          label,
          branch,
          isLinkedWorktree: true,
          isDetached: false,
          isBare: false,
          isPrunable: false,
          openWorkspaceId: wtWsId
        };
        this.worktrees.set(path, wtInfo);

        const resType = action === "create" ? "worktree_created" : "worktree_opened";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "1",
            result: {
              type: resType,
              workspace: this.toWorkspaceJson(ws),
              tab: this.toTabJson(tab),
              root_pane: this.toPaneJson(pane),
              worktree: {
                path: wtInfo.path,
                label: wtInfo.label,
                branch: wtInfo.branch,
                is_linked_worktree: wtInfo.isLinkedWorktree,
                is_detached: wtInfo.isDetached,
                is_bare: wtInfo.isBare,
                is_prunable: wtInfo.isPrunable,
                open_workspace_id: wtInfo.openWorkspaceId
              }
            }
          }),
          stderr: ""
        };
      }
      if (action === "remove") {
        const wsIdx = rest.indexOf("--workspace");
        const wsId = wsIdx !== -1 && rest[wsIdx + 1] ? rest[wsIdx + 1]! : "";
        this.workspaces.delete(wsId);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "1",
            result: {
              type: "worktree_removed",
              workspace_id: wsId,
              path: "/worktree",
              forced: false
            }
          }),
          stderr: ""
        };
      }
    }

    return { exitCode: 0, stdout: JSON.stringify({ id: "1", result: { type: "ok" } }), stderr: "" };
  }

  simulateRestart(reassignIds = true): void {
    if (reassignIds) {
      const oldPanes = Array.from(this.panes.values());
      const oldAgents = Array.from(this.agents.values());
      const oldWs = Array.from(this.workspaces.values());
      const oldTabs = Array.from(this.tabs.values());

      this.workspaces.clear();
      this.tabs.clear();
      this.panes.clear();
      this.agents.clear();
      this.processInfos.clear();

      const idMap = new Map<string, string>();
      for (const w of oldWs) {
        const newId = "ws-restored-" + (++this.idCounter);
        idMap.set(w.workspaceId, newId);
        this.workspaces.set(newId, { ...w, workspaceId: newId, tabIds: [] });
      }
      for (const t of oldTabs) {
        const newId = "tab-restored-" + (++this.idCounter);
        idMap.set(t.tabId, newId);
        const newWsId = idMap.get(t.workspaceId) ?? t.workspaceId;
        this.tabs.set(newId, { ...t, tabId: newId, workspaceId: newWsId, paneIds: [] });
        this.workspaces.get(newWsId)?.tabIds.push(newId);
      }
      for (const p of oldPanes) {
        const newId = "pane-restored-" + (++this.idCounter);
        const newTermId = "term-restored-" + (++this.idCounter);
        idMap.set(p.paneId, newId);
        const newWsId = idMap.get(p.workspaceId) ?? p.workspaceId;
        const newTabId = idMap.get(p.tabId) ?? p.tabId;
        const newPane: HerdrPaneInfo = {
          ...p,
          paneId: newId,
          terminalId: newTermId,
          workspaceId: newWsId,
          tabId: newTabId
        };
        this.panes.set(newId, newPane);
        this.tabs.get(newTabId)?.paneIds.push(newId);
        this.processInfos.set(newId, {
          paneId: newId,
          shellPid: 2000 + this.idCounter,
          foregroundProcessGroupId: 2000 + this.idCounter,
          foregroundProcesses: []
        });
      }
      for (const a of oldAgents) {
        const newPaneId = idMap.get(a.paneId) ?? a.paneId;
        const p = this.panes.get(newPaneId);
        if (p) {
          const newAgent: HerdrAgentInfo = {
            ...a,
            paneId: newPaneId,
            terminalId: p.terminalId,
            workspaceId: p.workspaceId,
            tabId: p.tabId
          };
          this.agents.set(a.name ?? a.paneId, newAgent);
        }
      }
    }
  }
}

/**
 * FakeWorktreeInspector for simulating git worktree cleanliness
 */
class FakeWorktreeInspector implements WorktreeInspector {
  readonly worktrees = new Map<string, WorktreeCleanlinessResult>();
  failInspect = false;

  setCleanliness(worktreePath: string, result: Partial<WorktreeCleanlinessResult>): void {
    const existing = this.worktrees.get(worktreePath) ?? {
      exists: true,
      isClean: true,
      dirtyFiles: []
    };
    this.worktrees.set(worktreePath, { ...existing, ...result });
  }

  async inspect(
    worktreePath: string,
    _options?: OperationOptions
  ): Promise<OperationResult<WorktreeCleanlinessResult>> {
    if (this.failInspect) {
      return {
        ok: false,
        error: { code: "validation", retryable: false, message: "Inspection failed" }
      };
    }
    const res = this.worktrees.get(worktreePath) ?? {
      exists: false,
      isClean: true,
      dirtyFiles: []
    };
    return { ok: true, value: res };
  }
}

describe("RolePaneManager Verification Suite", () => {
  let runner: FakeHerdrCommandRunner;
  let inspector: FakeWorktreeInspector;
  let store: InMemorySessionManifestStore;
  const config: RolePaneManagerConfig = {
    sessionId: "sess-test-1",
    projectName: "bflow-project",
    workspaceRoot: "/test/workspace",
    conversationSessionId: "conv-1",
    maxDeveloperCapacity: 2
  };

  beforeEach(() => {
    runner = new FakeHerdrCommandRunner();
    inspector = new FakeWorktreeInspector();
    store = new InMemorySessionManifestStore();
  });
  it("labels every role and splits Coordination into a balanced 2x2 without restarting on reconciliation", async () => {
    const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
    const first = await manager.initializeTopology(); expect(first.ok).toBe(true); if (!first.ok) return;
    const chat = first.value.panes.find(p => p.role === "conversation")!;
    expect(runner.panes.get(chat.paneId)?.label).toBe("Chat · Conversation");
    const splits = runner.calls.filter(c => c.args[0] === "pane" && c.args[1] === "split");
    const coordination = first.value.panes.find(p => p.role === "coordinator")!.tabId;
    const grouped = splits.filter(c => runner.panes.get(c.args[2]!)?.tabId === coordination);
    expect(grouped.map(c => c.args[c.args.indexOf("--direction") + 1])).toEqual(["right", "down", "down"]);
    expect(grouped[1]!.args[2]).not.toBe(grouped[2]!.args[2]);
    for (const pane of first.value.panes) expect(runner.panes.get(pane.paneId)?.label).toBeTruthy();
    const starts = runner.calls.filter(c => c.args[0] === "agent" && c.args[1] === "start").length;
    expect((await manager.reconcileTopology()).ok).toBe(true);
    expect(runner.calls.filter(c => c.args[0] === "agent" && c.args[1] === "start")).toHaveLength(starts);
    expect((await manager.getManifest() as {ok:true;value:typeof first.value}).value.attachTarget).toEqual(first.value.attachTarget);
  });
  it("loads the original Chat and Coordinator prompts through Codex native file options before first turn", async () => {
    const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
    const result = await manager.initializeTopology(); expect(result.ok).toBe(true); if (!result.ok) return;
    for (const role of ["conversation", "coordinator"]) {
      const pane = result.value.panes.find(p => p.role === role)!;
      const start = runner.calls.find(c => c.args[0] === "agent" && c.args[1] === "start" && c.args.includes(pane.paneId))!;
      expect(start.args.find(a => a.startsWith("model_instructions_file="))).toContain(role === "conversation" ? "agents/chat/system-prompt.md" : "agents/coordinator/system-prompt.md");
      expect(start.args.some(a => a.includes("\n"))).toBe(false);
      expect(pane.metadata?.promptInitialized).toBe(true);
    }
  });
  it("accepts a provider launch profile whose prompt file carries the original role prompt for each provider", async () => {
    const { readBuiltinRolePrompt } = await import("../src/role-prompts.js");
    const { writeFile } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "bflow-launch-prompt-"));
    try {
      const chat = await readBuiltinRolePrompt("conversation"), coordinator = await readBuiltinRolePrompt("coordinator");
      if (!chat || !coordinator) throw new Error("original role prompts are missing");
      const promptFor = async (name: string, text: string) => { const path = join(directory, name); await writeFile(path, text, "utf8"); return path; };
      const settingsFor = async (name: string, systemPromptFile: string) => {
        const path = join(directory, name); await writeFile(path, JSON.stringify({ systemPromptFile }), "utf8"); return path;
      };
      const chatPrompt = await promptFor("chat-claude.md", chat.prompt + "\n\nHost integration.");
      const coordinatorPrompt = await promptFor("coordinator-codex.md", coordinator.prompt);
      const agySettings = await settingsFor("agy-settings.json", await promptFor("agy-prompt.md", chat.prompt));
      const coordinatorAgy = await promptFor("coordinator-agy.md", coordinator.prompt);
      const agyCoordinatorSettings = await settingsFor("agy-coordinator-settings.json", coordinatorAgy);
      const profile = (provider: "claude" | "codex" | "agy", argv: string[], launchId: string) =>
        ({ provider, argv, env: {}, launchId, launchFingerprint: `${launchId}-fingerprint` });
      const manager = createRolePaneManager({ config: { ...config, roleConfigs: {
        chat: { agentKind: "claude", launch: profile("claude", ["--settings", "/dev/null", "--append-system-prompt-file", chatPrompt], "chat-claude") },
        coordinator: { agentKind: "codex", launch: profile("codex", ["-c", `model_instructions_file=${JSON.stringify(coordinatorPrompt)}`], "coordinator-codex") }
      } }, runner, store, worktreeInspector: inspector });
      const claudeOnly = await manager.initializeTopology();
      expect(claudeOnly.ok).toBe(true);
      const agyConfig = createRolePaneManager({ config: { ...config, roleConfigs: {
        chat: { agentKind: "agy", launch: profile("agy", ["--settings", agySettings], "chat-agy") },
        coordinator: { agentKind: "agy", launch: profile("agy", ["--settings", agyCoordinatorSettings], "coordinator-agy") }
      } }, runner: new FakeHerdrCommandRunner(), store: new InMemorySessionManifestStore(), worktreeInspector: inspector });
      const agy = await agyConfig.initializeTopology();
      expect(agy.ok).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("rejects a provider launch profile whose files do not carry the original role prompt", async () => {
    const { writeFile } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "bflow-launch-prompt-bad-"));
    try {
      const unrelated = join(directory, "unrelated.md");
      await writeFile(unrelated, "Some other instructions entirely.", "utf8");
      const manager = createRolePaneManager({ config: { ...config, roleConfigs: {
        chat: { agentKind: "codex", launch: { provider: "codex", argv: [`model_instructions_file=${JSON.stringify(unrelated)}`], env: {}, launchId: "chat-bad", launchFingerprint: "chat-bad-fp" } }
      } }, runner, store, worktreeInspector: inspector });
      const result = await manager.initializeTopology();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("must reference the original Bflow role prompt");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("waits for a new pane's pending process snapshot instead of starting into an unobserved foreground", async () => {
    let pending = true;
    runner.onCommand = call => {
      if (call.args[0] === "pane" && call.args[1] === "process-info" && pending) {
        pending = false;
        expect(runner.calls.some(c => c.args[0] === "agent" && c.args[1] === "start")).toBe(false);
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({id:"1",result:{type:"pane_process_info",process_info:{pane_id:call.args[call.args.indexOf("--pane")+1]}}}) };
      }
    };
    const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
    expect((await manager.initializeTopology()).ok).toBe(true);
    expect(runner.calls.filter(c => c.args[0] === "agent" && c.args[1] === "start")).toHaveLength(7);
  });
  it("does not resend an uncertain agent start even if its output mentions a busy pane", async () => {
    runner.onCommand = invocation => invocation.args[0] === "agent" && invocation.args[1] === "start"
      ? { exitCode: null, failure: "timeout", stdout: "agent_pane_busy", stderr: "acknowledgement timed out" } : undefined;
    const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
    expect((await manager.initializeTopology()).ok).toBe(false);
    const starts = runner.calls.filter(call => call.args[0] === "agent" && call.args[1] === "start");
    expect(starts).toHaveLength(4);
    expect(new Set(starts.map(call => call.args[2])).size).toBe(starts.length);
  });
  it("retries an acknowledged busy rejection and preserves the configured provider timeout", async () => {
    let rejected = false;
    runner.onCommand = invocation => {
      if (!rejected && invocation.args[0] === "agent" && invocation.args[1] === "start") {
        rejected = true;
        return { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code: "agent_pane_busy", message: "Pane is not an available shell" } }) };
      }
    };
    const manager = createRolePaneManager({ config: { ...config, roleConfigs: { chat: { startupTimeoutMs: 90_000 } } }, runner, store, worktreeInspector: inspector });
    expect((await manager.initializeTopology()).ok).toBe(true);
    const starts = runner.calls.filter(call => call.args[0] === "agent" && call.args[1] === "start");
    expect(starts).toHaveLength(8);
    const chatStarts = starts.filter(call => call.args[2] === "chat");
    expect(chatStarts.length).toBeGreaterThan(0);
    expect(chatStarts.every(call => call.args[call.args.indexOf("--timeout") + 1] === "90000")).toBe(true);
  });
  describe("native agent startup budgets", () => {
    const request = { role: "developer" as const, paneId: "pane-budget", workspaceId: "ws-budget", tabId: "tab-budget", cwd: config.workspaceRoot };
    const epoch = Date.parse("2026-10-19T00:00:00.000Z");
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(epoch);
      runner.panes.set(request.paneId, { paneId: request.paneId, terminalId: "term-budget", workspaceId: request.workspaceId,
        tabId: request.tabId, agent: null, agentStatus: "idle", focused: false, revision: 1 });
      runner.processInfos.set(request.paneId, { paneId: request.paneId, shellPid: 1000,
        foregroundProcessGroupId: 1000, foregroundProcesses: [{ pid: 1000, command: "zsh" }] });
    });
    afterEach(() => vi.useRealTimers());
    const starts = () => runner.calls.filter(call => call.args[0] === "agent" && call.args[1] === "start");

    it.each([3001, 90000, 299999, 300000, 300001, 600000])("bounds configured timeout %s to the native maximum", async timeoutMs => {
      const manager = createRolePaneManager({ config: { ...config, roleConfigs: { developer: { startupTimeoutMs: timeoutMs } } }, runner });
      const pending = manager.startAgentInPane(request);
      await vi.runAllTimersAsync();
      expect((await pending).ok).toBe(true);
      expect(starts()).toHaveLength(1);
      const call = starts()[0]!;
      expect(call.args[call.args.indexOf("--timeout") + 1]).toBe(String(Math.min(timeoutMs, 300000)));
      expect(call.timeoutMs).toBe(Math.min(timeoutMs, 300000));
    });

    it("preserves a request timeout below the role timeout", async () => {
      const manager = createRolePaneManager({ config: { ...config, roleConfigs: { developer: { startupTimeoutMs: 600000 } } }, runner });
      const pending = manager.startAgentInPane({ ...request, timeoutMs: 90000 });
      await vi.runAllTimersAsync();
      expect((await pending).ok).toBe(true);
      expect(starts()[0]!.args[starts()[0]!.args.indexOf("--timeout") + 1]).toBe("90000");
    });

    it.each([
      [{ timeoutMs: 10000 }, 9100],
      [{ deadline: new Date(epoch + 10000).toISOString() }, 9100],
      [{ timeoutMs: 300000, deadline: new Date(epoch + 600000).toISOString() }, 299100]
    ] as const)("uses the remaining operation budget %j", async (options, expected) => {
      const manager = createRolePaneManager({ config, runner });
      const pending = manager.startAgentInPane({ ...request, timeoutMs: 600000 }, options);
      await vi.runAllTimersAsync();
      expect((await pending).ok).toBe(true);
      const call = starts()[0]!;
      expect(call.args[call.args.indexOf("--timeout") + 1]).toBe(String(expected));
      expect(call.timeoutMs).toBe(expected);
    });

    it("honors a request override and the remaining lifecycle budget without dropping cancellation", async () => {
      const signal = new AbortController().signal;
      const manager = createRolePaneManager({ config: { ...config, roleConfigs: { developer: { startupTimeoutMs: 600000 } } }, runner });
      const pending = manager.startAgentInPane({ ...request, timeoutMs: 90000 }, { timeoutMs: 20000, deadline: new Date(epoch + 10000).toISOString(), signal });
      await vi.runAllTimersAsync();
      expect((await pending).ok).toBe(true);
      const call = starts()[0]!;
      expect(call.args[call.args.indexOf("--timeout") + 1]).toBe("9100");
      expect(call.timeoutMs).toBe(9100);
      expect(call.signal).toBe(signal);
    });

    it.each([1, 3000])("does not widen a short requested timeout %s", async timeoutMs => {
      const manager = createRolePaneManager({ config, runner });
      const pending = manager.startAgentInPane({ ...request, timeoutMs });
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started", details: { started: false } } });
      expect(starts()).toHaveLength(0);
    });

    it.each([NaN, Infinity, -1, 0, 3001.5])("rejects invalid timeout %s before Herdr calls", async timeoutMs => {
      const manager = createRolePaneManager({ config, runner });
      const pending = manager.startAgentInPane({ ...request, timeoutMs });
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ ok: false, error: { code: "validation" } });
      expect(runner.calls).toHaveLength(0);
    });

    it.each([
      { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: -1 }, { timeoutMs: 3001.5 }, { deadline: "invalid" }
    ])("rejects invalid operation options %j before Herdr calls", async options => {
      const manager = createRolePaneManager({ config, runner });
      const pending = manager.startAgentInPane(request, options);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ ok: false, error: { code: "validation" } });
      expect(runner.calls).toHaveLength(0);
    });

    it.each([
      { timeoutMs: 3000 }, { timeoutMs: 3900 }, { deadline: new Date(epoch - 1).toISOString() },
      { deadline: new Date(epoch + 3900).toISOString() }
    ])("does not launch when the lifecycle budget has expired or become too short: %j", async options => {
      const manager = createRolePaneManager({ config, runner });
      const pending = manager.startAgentInPane(request, options);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started", details: { started: false } } });
      expect(starts()).toHaveLength(0);
    });

    it("recomputes the remaining budget after an acknowledged busy rejection", async () => {
      runner.onCommand = call => call.args[0] === "agent" && call.args[1] === "start"
        ? { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code: "agent_pane_busy", message: "busy" } }) } : undefined;
      const manager = createRolePaneManager({ config, runner });
      const pending = manager.startAgentInPane(request, { timeoutMs: 4200 });
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started", details: { started: false } } });
      expect(starts()).toHaveLength(1);
      expect(starts()[0]!.args[starts()[0]!.args.indexOf("--timeout") + 1]).toBe("3300");
    });

    it("does not dispatch when cancelled during shell readiness", async () => {
      const controller = new AbortController();
      runner.onCommand = call => {
        if (call.args[0] === "pane" && call.args[1] === "process-info") controller.abort();
        return undefined;
      };
      const manager = createRolePaneManager({ config, runner });
      const pending = manager.startAgentInPane(request, { signal: controller.signal });
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(starts()).toHaveLength(0);
    });
  });
  it("explains Codex update blocking with exact targets and never echoes raw screen secrets or accepts the dialog", async () => {
    const secret = "SCREEN_SECRET_CANARY_DO_NOT_ECHO";
    runner.onCommand = invocation => {
      if (invocation.args[0] === "agent" && invocation.args[1] === "start") return { exitCode: 1, stdout: "", stderr: '{"error":{"code":"agent_not_ready","message":"blocked"}}' };
      if (invocation.args[0] === "pane" && invocation.args[1] === "read") return { exitCode: 0, stderr: "", stdout: `Update CLI? New Codex version available. ${secret}` };
    };
    const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
    const result = await manager.initializeTopology(); expect(result.ok).toBe(false); if (result.ok) return;
    expect(result.error.message).toContain("CLI update confirmation"); expect(result.error.message).toContain(config.sessionId);
    expect(result.error.message).toContain("bflow up"); expect(result.error.details).toMatchObject({ role: "chat", provider: "codex" });
    expect(JSON.stringify(result.error)).not.toContain(secret);
    expect(runner.calls.some(c => c.args.includes("send-keys") || c.args.includes("send-text"))).toBe(false);
  });
  it("captures late native sessions only for recorded launches and never rewrites an already-bound session", async () => {
    const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
    const first = await manager.initializeTopology(); expect(first.ok).toBe(true); if (!first.ok) return;
    const chat = first.value.panes.find(p => p.role === "conversation")!;
    expect(chat.session).toBeUndefined(); expect(chat.metadata?.nativeSessionPending).toBe(true);
    const agent = runner.agents.get("chat")!; runner.agents.set("chat", { ...agent, session: { source: "herdr:codex", kind: "id", value: "first-native-session" } });
    expect((await manager.inspectTopologyHealth()).ok).toBe(true);
    const saved = await manager.getManifest(); expect(saved.ok).toBe(true); if (!saved.ok || !saved.value) return;
    expect(saved.value.panes.find(p => p.paneId === chat.paneId)?.session?.value).toBe("first-native-session");
    runner.agents.set("chat", { ...agent, session: { source: "herdr:codex", kind: "id", value: "replacement-native-session" } });
    const observed = await manager.inspectRoleHealth("chat"); expect(observed.ok && observed.value.status).toBe("agent_replaced");
    const retry = await manager.reconcileTopology(); expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.message).toContain("Native session changed");
  });

  // Scenario 1: Khởi tạo topology (Initialize full topology)
  describe("Scenario 1: Initialize full topology", () => {
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>(accept => { resolve = accept; });
      return { promise, resolve };
    }

    function delayedStartup(failedRole?: string, failureKind = "timeout") {
      const gates = new Map(PERMANENT_TOPOLOGY_ROLES.map(role => [role as string, deferred()]));
      const started: string[] = [];
      const snapshots: Awaited<ReturnType<SessionManifestStore["load"]>>[] = [];
      let active = 0, maximum = 0;
      const delayedRunner: HerdrCommandRunner = { run: async invocation => {
        if (invocation.args[0] !== "agent" || invocation.args[1] !== "start") return runner.run(invocation);
        const role = invocation.args[2]!;
        snapshots.push(await store.load(config.sessionId));
        started.push(role); active++; maximum = Math.max(maximum, active);
        try {
          await gates.get(role)!.promise;
          if (role === failedRole) {
            if (failureKind === "throw") throw new Error("Injected runner failure");
            return failureKind === "blocked"
              ? { exitCode: 1, stdout: "", stderr: "agent_blocked" }
              : { exitCode: null, failure: "timeout" as const, stdout: "agent_pane_busy", stderr: "uncertain acknowledgement" };
          }
          return await runner.run(invocation);
        } finally { active--; }
      } };
      return { gates, started, snapshots, runner: delayedRunner,
        get active() { return active; }, get maximum() { return maximum; },
        drain: () => { for (const gate of gates.values()) gate.resolve(); } };
    }

    it("overlaps at most four role starts after durable intents and retains every binding in configured order", async () => {
      const delayed = delayedStartup();
      const saved: number[] = [];
      let writing = 0, concurrentWrites = 0;
      const serializedStore: SessionManifestStore = { load: (...args) => store.load(...args), save: async (manifest, options) => {
        writing++; concurrentWrites = Math.max(concurrentWrites, writing);
        try {
          await new Promise<void>(accept => setImmediate(accept));
          saved.push(manifest.panes.length);
          return await store.save(manifest, options);
        } finally { writing--; }
      } };
      const manager = createRolePaneManager({ config, runner: delayed.runner, store: serializedStore, worktreeInspector: inspector });
      let settled = false;
      const outcome = manager.initializeTopology().then(result => { settled = true; return result; });
      try {
        await vi.waitFor(() => expect(delayed.started).toHaveLength(4), { timeout: 5000 });
        expect(new Set(delayed.started)).toEqual(new Set(["chat", "coordinator", "planner", "analyst"]));
        for (const snapshot of delayed.snapshots) {
          expect(snapshot.ok && snapshot.value?.panes).toHaveLength(7);
          expect(snapshot.ok && snapshot.value?.status).toBe("initializing");
        }
        for (const [finished, next] of [["planner", "architect"], ["architect", "reviewer"], ["reviewer", "qa-verifier"]]) {
          delayed.gates.get(finished!)!.resolve();
          await vi.waitFor(() => expect(delayed.started.at(-1)).toBe(next), { timeout: 5000 });
        }
        expect(settled).toBe(false);
        delayed.drain();
        const result = await outcome;
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.panes.map(pane => pane.role))
          .toEqual(["conversation", "coordinator", "planner", "specifier", "architect", "reviewer", "qa"]);
        expect(delayed.maximum).toBe(4);
        expect(concurrentWrites).toBe(1);
        expect(saved.every((count, index) => index === 0 || count >= saved[index - 1]!)).toBe(true);
        const final = await store.load(config.sessionId);
        expect(final.ok && final.value?.panes).toHaveLength(7);
      } finally { delayed.drain(); await outcome; }
    });

    it.each(["timeout", "throw", "blocked"])("drains started roles and leaves queued intents intact after a %s", async failureKind => {
      const delayed = delayedStartup("planner", failureKind);
      const manager = createRolePaneManager({ config, runner: delayed.runner, store, worktreeInspector: inspector });
      let settled = false;
      const outcome = manager.initializeTopology().then(result => { settled = true; return result; });
      try {
        await vi.waitFor(() => expect(delayed.started).toHaveLength(4), { timeout: 5000 });
        delayed.gates.get("planner")!.resolve();
        await vi.waitFor(() => expect(delayed.active).toBe(3));
        expect(settled).toBe(false);
        expect(delayed.started).toHaveLength(4);
        delayed.drain();
        expect((await outcome).ok).toBe(false);
        expect(delayed.started).toHaveLength(4);
        const saved = await store.load(config.sessionId);
        expect(saved.ok && saved.value?.status).toBe("initializing");
        expect(saved.ok && saved.value?.panes).toHaveLength(7);
        if (saved.ok) {
          expect(saved.value?.panes.find(pane => pane.role === "planner")?.metadata?.["launchIntent"]).toBe(true);
          expect(saved.value?.panes.find(pane => pane.role === "architect")?.metadata?.["launchQueued"]).toBe(true);
        }
      } finally { delayed.drain(); await outcome; }
    });

    it("does not launch queued roles after cancellation and drains starts already in flight", async () => {
      const delayed = delayedStartup();
      const controller = new AbortController();
      const manager = createRolePaneManager({ config, runner: delayed.runner, store, worktreeInspector: inspector });
      let settled = false;
      const outcome = manager.initializeTopology({ signal: controller.signal }).then(result => { settled = true; return result; });
      try {
        await vi.waitFor(() => expect(delayed.started).toHaveLength(4), { timeout: 5000 });
        controller.abort();
        expect(settled).toBe(false);
        delayed.drain();
        expect((await outcome).ok).toBe(false);
        expect(delayed.started).toHaveLength(4);
        const saved = await store.load(config.sessionId);
        expect(saved.ok && saved.value?.panes).toHaveLength(7);
      } finally { delayed.drain(); await outcome; }
    });

    it("stops undispatched workers when an attempted-launch intent fails to persist", async () => {
      const delayed = delayedStartup();
      let denied = false;
      const failingStore: SessionManifestStore = { load: (...args) => store.load(...args), save: async (manifest, options) => {
        const planner = manifest.panes.find(pane => pane.role === "planner");
        if (!denied && planner?.metadata?.["launchQueued"] === false) {
          denied = true;
          return { ok: false, error: { code: "corruption", retryable: false, message: "dispatch intent write denied" } };
        }
        return store.save(manifest, options);
      } };
      const manager = createRolePaneManager({ config, runner: delayed.runner, store: failingStore, worktreeInspector: inspector });
      let settled = false;
      const outcome = manager.initializeTopology().then(result => { settled = true; return result; });
      try {
        await vi.waitFor(() => expect(delayed.started).toHaveLength(2), { timeout: 5000 });
        expect(delayed.started).not.toContain("planner");
        expect(delayed.started).not.toContain("analyst");
        expect(settled).toBe(false);
        delayed.drain();
        const result = await outcome;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toBe("dispatch intent write denied");
        expect(delayed.started).toHaveLength(2);
        const saved = await store.load(config.sessionId);
        expect(saved.ok && saved.value?.panes).toHaveLength(7);
      } finally { delayed.drain(); await outcome; }
    });

    it("rejects colliding permanent agent names before concurrent launch side effects", async () => {
      const manager = createRolePaneManager({ config: { ...config, permanentRoles: ["chat", "coordinator"],
        roleConfigs: { ...config.roleConfigs, coordinator: { agentName: "chat" } } }, runner, store, worktreeInspector: inspector });
      const result = await manager.initializeTopology();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("conflict");
      expect(runner.calls.filter(call => call.args[0] === "agent" && call.args[1] === "start")).toHaveLength(0);
    });

    it("does not dispatch workers cancelled while their intent writes are pending", async () => {
      const controller = new AbortController();
      const cancellingStore: SessionManifestStore = { load: (...args) => store.load(...args), save: async (manifest, options) => {
        const saved = await store.save(manifest, options);
        if (manifest.panes.some(pane => pane.metadata?.["launchQueued"] === false)) controller.abort();
        return saved;
      } };
      const manager = createRolePaneManager({ config, runner, store: cancellingStore, worktreeInspector: inspector });
      const result = await manager.initializeTopology({ signal: controller.signal });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("cancelled");
      expect(runner.calls.filter(call => call.args[0] === "agent" && call.args[1] === "start")).toHaveLength(0);
      const saved = await store.load(config.sessionId);
      expect(saved.ok && saved.value?.panes).toHaveLength(7);
    });

    it("returns failures by configured role order after out-of-order failures have drained", async () => {
      const delayed = delayedStartup("planner");
      runner.onCommand = invocation => invocation.args[0] === "agent" && invocation.args[1] === "start" && invocation.args[2] === "chat"
        ? { exitCode: 1, stdout: "", stderr: "agent_blocked" } : undefined;
      const manager = createRolePaneManager({ config, runner: delayed.runner, store, worktreeInspector: inspector });
      const outcome = manager.initializeTopology();
      try {
        await vi.waitFor(() => expect(delayed.started).toHaveLength(4), { timeout: 5000 });
        delayed.gates.get("planner")!.resolve();
        await vi.waitFor(() => expect(delayed.active).toBe(3));
        delayed.drain();
        const result = await outcome;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("chat");
        expect(delayed.started).toHaveLength(4);
      } finally { delayed.drain(); await outcome; }
    });

    it("persists launch intent before startup and reconciles blocked partial startup in its original pane", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      let failedPane = "";
      runner.onCommand = invocation => {
        if (invocation.args[0] !== "agent" || invocation.args[1] !== "start" || invocation.args[2] !== "coordinator") return;
        failedPane = invocation.args[invocation.args.indexOf("--pane") + 1]!;
        const pane = runner.panes.get(failedPane)!;
        pane.agent = "codex";
        runner.agents.set("coordinator", { name: "coordinator", agent: "codex", paneId: failedPane,
          terminalId: pane.terminalId, workspaceId: pane.workspaceId, tabId: pane.tabId,
          focused: false, agentStatus: "blocked", revision: 1, interactiveReady: false, launchPending: true });
        return { exitCode: 1, stdout: "", stderr: "agent_blocked" };
      };
      expect((await manager.initializeTopology()).ok).toBe(false);
      const pending = await store.load(config.sessionId);
      expect(pending.ok && pending.value?.status).toBe("initializing");
      expect(pending.ok && pending.value?.panes.find(p => p.role === "coordinator")?.paneId).toBe(failedPane);
      runner.onCommand = undefined;
      const before = runner.calls.length;
      expect((await manager.reconcileTopology()).ok).toBe(false);
      expect(runner.calls.slice(before).filter(c => c.args[0] === "pane" && c.args[1] === "split")).toHaveLength(0);
      expect(runner.calls.slice(before).filter(c => c.args[0] === "agent" && c.args[1] === "start")).toHaveLength(0);
      const occupant = runner.agents.get("coordinator")!;
      runner.agents.set("coordinator", { ...occupant, agentStatus: "idle", interactiveReady: true, launchPending: false });
      expect((await manager.reconcileTopology()).ok).toBe(true);
      expect(runner.calls.filter(c => c.args[0] === "agent" && c.args[1] === "start" && c.args[2] === "coordinator")).toHaveLength(1);
    });

    it("does not start an agent when launch intent cannot be preserved", async () => {
      const failingStore: SessionManifestStore = { load: (...args) => store.load(...args),
        save: async () => ({ ok: false, error: { code: "corruption", retryable: false, message: "write denied" } }) };
      const manager = createRolePaneManager({ config, runner, store: failingStore, worktreeInspector: inspector });
      expect((await manager.initializeTopology()).ok).toBe(false);
      expect(runner.calls.filter(c => c.args[0] === "agent" && c.args[1] === "start")).toHaveLength(0);
    });

    it("creates Conversation workspace, Conversation tab, Coordination tab, Verification tab, and all permanent roles", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const initResult = await manager.initializeTopology();

      expect(initResult.ok).toBe(true);
      if (!initResult.ok) return;

      const manifest = initResult.value;
      // Verifies SessionManifestSchema and PaneBindingSchema validation
      expect(SessionManifestSchema.safeParse(manifest).success).toBe(true);
      for (const pane of manifest.panes) {
        expect(PaneBindingSchema.safeParse(pane).success).toBe(true);
      }

      // Verifies creation of all permanent roles
      expect(manifest.panes).toHaveLength(7);
      const roles = manifest.panes.map((p) => p.role);
      expect(roles).toContain("conversation");
      expect(roles).toContain("coordinator");
      expect(roles).toContain("planner");
      expect(roles).toContain("specifier");
      expect(roles).toContain("architect");
      expect(roles).toContain("reviewer");
      expect(roles).toContain("qa");

      // Verifies root panes vs split panes
      const chatBinding = manifest.panes.find((p) => p.role === "conversation")!;
      expect(chatBinding.paneGroup).toBe("conversation");
      expect(manifest.attachTarget.paneId).toBe(chatBinding.paneId);

      // Verifies process-info shell-readiness check was performed before agent start
      const processInfoCalls = runner.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "process-info");
      expect(processInfoCalls.length).toBeGreaterThanOrEqual(7);

      // Verifies manifest status is 'up'
      expect(manifest.status).toBe("up");
    });

    it("supports configurable subset of permanent roles", async () => {
      const customConfig: RolePaneManagerConfig = {
        ...config,
        sessionId: "sess-subset",
        permanentRoles: ["chat", "coordinator"]
      };
      const manager = createRolePaneManager({ config: customConfig, runner, store, worktreeInspector: inspector });
      const initResult = await manager.initializeTopology();

      expect(initResult.ok).toBe(true);
      if (!initResult.ok) return;

      const manifest = initResult.value;
      expect(manifest.panes).toHaveLength(2);
      expect(manifest.panes.map((p) => p.role).sort()).toEqual(["conversation", "coordinator"]);
      expect(manifest.status).toBe("up");
    });
  });

  // Scenario 2: Khởi tạo lại không trùng (Idempotent re-initialization without duplication)
  describe("Scenario 2: Idempotent re-initialization without duplication", () => {
    it("reuses existing workspace, tabs, panes, and agents without calling create/split/start again", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const firstInit = await manager.initializeTopology();
      expect(firstInit.ok).toBe(true);
      if (!firstInit.ok) return;

      const firstManifest = firstInit.value;
      const initialCallCount = runner.calls.length;

      // Call initializeTopology again
      const secondInit = await manager.initializeTopology();
      expect(secondInit.ok).toBe(true);
      if (!secondInit.ok) return;

      const secondManifest = secondInit.value;
      expect(secondManifest.herdrWorkspaceId).toBe(firstManifest.herdrWorkspaceId);
      expect(secondManifest.panes.map((p) => p.paneId)).toEqual(firstManifest.panes.map((p) => p.paneId));

      // No new workspace create or pane split or agent start should have run
      const postCalls = runner.calls.slice(initialCallCount);
      const creates = postCalls.filter(
        (c) =>
          (c.args[0] === "workspace" && c.args[1] === "create") ||
          (c.args[0] === "tab" && c.args[1] === "create") ||
          (c.args[0] === "pane" && c.args[1] === "split") ||
          (c.args[0] === "agent" && c.args[1] === "start")
      );
      expect(creates).toHaveLength(0);
    });
  });

  // Scenario 3: Role đã có pane (Role already has an existing shell pane)
  describe("Scenario 3: Role already has existing shell pane", () => {
    it("reuses existing pane and only runs agent start without splitting duplicate pane", async () => {
      // Pre-seed runner with a workspace and an available shell pane (agent: null)
      const wsOutcome = await runner.run({ args: ["workspace", "create", "--label", config.projectName, "--cwd", config.workspaceRoot] });
      const wsData = JSON.parse(wsOutcome.stdout);
      const rootPaneId = wsData.result.root_pane.pane_id;

      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const initResult = await manager.initializeTopology();

      expect(initResult.ok).toBe(true);
      if (!initResult.ok) return;

      // Chat role should have reused the pre-existing root pane
      const chatPane = initResult.value.panes.find((p) => p.role === "conversation")!;
      expect(chatPane.paneId).toBe(rootPaneId);
    });
  });

  // Scenario 4: Agent không sẵn sàng (Agent not ready / shell busy / blocked / unknown)
  describe("Scenario 4: Agent not ready / shell busy / blocked / unknown", () => {
    it("Case A: rejects before agent start with conflict when pane shell is busy", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();

      // Split a pane for a new role
      const rootPaneId = Array.from(runner.panes.keys())[0]!;
      const splitRes = await runner.run({ args: ["pane", "split", rootPaneId, "--direction", "right"] });
      const newPaneId = JSON.parse(splitRes.stdout).result.pane.pane_id;

      // Mark pane shell process as busy (foregroundProcessGroupId != shellPid)
      runner.processInfos.set(newPaneId, {
        paneId: newPaneId,
        shellPid: 1000,
        foregroundProcessGroupId: 9999, // busy!
        foregroundProcesses: [{ pid: 9999, command: "make build" }]
      });

      const startRes = await manager.startAgentInPane({
        role: "developer",
        paneId: newPaneId,
        workspaceId: "ws-1",
        tabId: "tab-1",
        cwd: config.workspaceRoot,
        agentName: "dev-test"
      });

      expect(startRes.ok).toBe(false);
      if (!startRes.ok) {
        expect(startRes.error.code).toBe("conflict");
        expect(startRes.error.message).toMatch(/busy|foreground/i);
      }
    });

    it("Case B: inspectRoleHealth reports not_ready when pane exists but agent is null", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();

      // Manually wipe agent from chat pane in runner
      const chatAgent = runner.agents.get("chat")!;
      runner.panes.get(chatAgent.paneId)!.agent = null;
      runner.agents.delete("chat");

      const healthRes = await manager.inspectRoleHealth("chat");
      expect(healthRes.ok).toBe(true);
      if (healthRes.ok) {
        expect(healthRes.value.status).toBe("not_ready");
        expect(healthRes.value.readyForPrompt).toBe(false);
        expect(healthRes.value.paneExists).toBe(true);
      }

      // focusConversationPane() must return conflict when conversation agent is not running
      const focusRes = await manager.focusConversationPane();
      expect(focusRes.ok).toBe(false);
      if (!focusRes.ok) {
        expect(focusRes.error.code).toBe("conflict");
      }
    });

    it("Case C: detects blocked or unknown agent status accurately as not ready", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();

      // Set coordinator agent status to blocked
      const coord = runner.agents.get("coordinator")!;
      runner.agents.set("coordinator", { ...coord, agentStatus: "blocked" });

      const healthRes = await manager.inspectRoleHealth("coordinator");
      expect(healthRes.ok).toBe(true);
      if (healthRes.ok) {
        expect(healthRes.value.status).toBe("blocked");
        expect(healthRes.value.readyForPrompt).toBe(false);
      }

      // Set planner agent status to unknown
      const planner = runner.agents.get("planner")!;
      runner.agents.set("planner", { ...planner, agentStatus: "unknown" });

      const plannerHealth = await manager.inspectRoleHealth("planner");
      expect(plannerHealth.ok).toBe(true);
      if (plannerHealth.ok) {
        expect(plannerHealth.value.status).toBe("unknown");
        expect(plannerHealth.value.readyForPrompt).toBe(false);
      }
    });

    it("Case D: rejects duplicate or invalid agent name before starting", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();

      // Invalid name
      const invalidRes = await manager.startAgentInPane({
        role: "developer",
        paneId: "pane-1",
        workspaceId: "ws-1",
        tabId: "tab-1",
        cwd: config.workspaceRoot,
        agentName: "Invalid Name!"
      });
      expect(invalidRes.ok).toBe(false);
      if (!invalidRes.ok) {
        expect(invalidRes.error.code).toBe("validation");
      }

      // Duplicate name (chat is already running)
      const existingPaneId = Array.from(runner.panes.keys())[0]!;
      const splitRes = await runner.run({ args: ["pane", "split", existingPaneId, "--direction", "right"] });
      const duplicatePaneId = JSON.parse(splitRes.stdout).result.pane.pane_id;
      const duplicateRes = await manager.startAgentInPane({
        role: "developer",
        paneId: duplicatePaneId,
        workspaceId: "ws-1",
        tabId: "tab-1",
        cwd: config.workspaceRoot,
        agentName: "chat" // collision
      });
      expect(duplicateRes.ok).toBe(false);
      if (!duplicateRes.ok) {
        expect(duplicateRes.error.code).toBe("conflict");
      }
    });
  });

  // Scenario 5: Pane biến mất (Pane disappeared / closed unexpectedly)
  describe("Scenario 5: Pane disappeared unexpectedly", () => {
    it("detects pane_missing, marks manifest degraded, and recovers with new pane_id", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();

      // Simulate unexpected pane closure for analyst role
      const analystBinding = (await manager.getRoleBinding("analyst")).ok
        ? (await manager.getRoleBinding("analyst")) as { ok: true; value: any }
        : null;
      const oldPaneId = analystBinding!.value.paneId;
      runner.panes.delete(oldPaneId);
      runner.agents.delete("analyst");

      // Inspect health -> detects anomaly and updates status to degraded
      const health = await manager.inspectTopologyHealth();
      expect(health.ok).toBe(true);
      if (health.ok) {
        expect(health.value.healthy).toBe(false);
        const anomaly = health.value.anomalies.find((a) => a.topologyRole === "analyst");
        expect(anomaly).toBeDefined();
        expect(anomaly?.kind).toBe("pane_missing");
      }

      const degradedManifest = await manager.getManifest();
      expect(degradedManifest.ok).toBe(true);
      if (degradedManifest.ok) {
        expect(degradedManifest.value?.status).toBe("degraded");
      }

      // Reconcile topology -> recreates pane and updates binding to new paneId
      const reconcile = await manager.reconcileTopology();
      expect(reconcile.ok).toBe(true);
      if (reconcile.ok) {
        const updatedAnalyst = reconcile.value.panes.find((p) => p.role === "specifier")!;
        expect(updatedAnalyst.paneId).not.toBe(oldPaneId);
        expect(reconcile.value.status).toBe("up");
      }
    });
  });

  // Scenario 6: Agent bị thay thế (Agent replaced in pane)
  describe("Scenario 6: Agent replaced in pane", () => {
    it("detects agent_replaced when occupant changes in bound pane", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();

      const reviewerBinding = (await manager.getRoleBinding("reviewer")) as { ok: true; value: any };
      const paneId = reviewerBinding.value.paneId;

      // Replace agent occupant in that pane
      runner.agents.set("reviewer", {
        ...runner.agents.get("reviewer")!,
        name: "intruder-agent",
        agent: "claude"
      });

      const healthRes = await manager.inspectRoleHealth("reviewer");
      expect(healthRes.ok).toBe(true);
      if (healthRes.ok) {
        expect(healthRes.value.status).toBe("agent_replaced");
        expect(healthRes.value.occupantMatches).toBe(false);
        expect(healthRes.value.readyForPrompt).toBe(false);
      }
    });
  });

  // Scenario 7: Developer chạy song song & Ràng buộc Worktree
  describe("Scenario 7: Parallel developers, capacity limits, and dirty worktree guards", () => {
    it("allocates multiple developers concurrently up to capacity and enforces guards", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();

      // Allocate Dev 1
      inspector.setCleanliness("/repo/.worktrees/task-1", { exists: false, isClean: true, dirtyFiles: [] });
      const dev1Res = await manager.allocateDeveloper({
        taskId: "task-1",
        worktreePath: "/repo/.worktrees/task-1",
        branchName: "feat/task-1"
      });
      expect(dev1Res.ok).toBe(true);
      if (!dev1Res.ok) return;

      // Allocate Dev 2
      inspector.setCleanliness("/repo/.worktrees/task-2", { exists: false, isClean: true, dirtyFiles: [] });
      const dev2Res = await manager.allocateDeveloper({
        taskId: "task-2",
        worktreePath: "/repo/.worktrees/task-2",
        branchName: "feat/task-2"
      });
      expect(dev2Res.ok).toBe(true);
      if (!dev2Res.ok) return;

      // Reject Dev 3 when capacity is 2
      inspector.setCleanliness("/repo/.worktrees/task-3", { exists: false, isClean: true, dirtyFiles: [] });
      const dev3Res = await manager.allocateDeveloper({
        taskId: "task-3",
        worktreePath: "/repo/.worktrees/task-3",
        branchName: "feat/task-3"
      });
      expect(dev3Res.ok).toBe(false);
      if (!dev3Res.ok) {
        expect(dev3Res.error.code).toBe("conflict");
        expect(dev3Res.error.message).toMatch(/capacity/i);
      }

      // Single-writer mutex: reject allocating on same worktreePath or branchName
      const duplicatePathRes = await manager.allocateDeveloper({
        taskId: "task-other",
        worktreePath: "/repo/.worktrees/task-1"
      });
      expect(duplicatePathRes.ok).toBe(false);
      if (!duplicatePathRes.ok) {
        expect(duplicatePathRes.error.code).toBe("conflict");
      }

      // Dirty worktree allocation guard: reject allocating in a dirty worktree
      // First release clean task-2 so active count (1) < capacity limit (2)
      await manager.releaseDeveloper({ taskId: "task-2", closePane: true });
      inspector.setCleanliness("/repo/.worktrees/task-dirty", { exists: true, isClean: false, dirtyFiles: ["dirty.ts"] });
      const dirtyAllocRes = await manager.allocateDeveloper({
        taskId: "task-dirty",
        worktreePath: "/repo/.worktrees/task-dirty"
      });
      expect(dirtyAllocRes.ok).toBe(false);
      if (!dirtyAllocRes.ok) {
        expect(dirtyAllocRes.error.code).toBe("conflict");
        expect(dirtyAllocRes.error.message).toMatch(/uncommitted/i);
      }

      // Dirty worktree release guard: reject releasing/closing dirty worktree
      inspector.setCleanliness("/repo/.worktrees/task-1", { exists: true, isClean: false, dirtyFiles: ["wip.ts"] });
      const dirtyReleaseRes = await manager.releaseDeveloper({ taskId: "task-1", closePane: true });
      expect(dirtyReleaseRes.ok).toBe(false);
      if (!dirtyReleaseRes.ok) {
        expect(dirtyReleaseRes.error.code).toBe("conflict");
        expect(dirtyReleaseRes.error.message).toMatch(/uncommitted/i);
      }

      // Clean worktree release: safely closes or removes
      inspector.setCleanliness("/repo/.worktrees/task-1", { exists: true, isClean: true, dirtyFiles: [] });
      const cleanReleaseRes = await manager.releaseDeveloper({ taskId: "task-1", closePane: true, removeWorktree: true });
      expect(cleanReleaseRes.ok).toBe(true);
      if (cleanReleaseRes.ok) {
        expect(cleanReleaseRes.value.worktreeRemoved).toBe(true);
        expect(cleanReleaseRes.value.paneClosed).toBe(true);
      }
    });

    it("retains ignored dependencies on release and pane close while refusing worktree removal and actual edits", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();
      const path = "/repo/.worktrees/ignored-dependencies";
      const allocation = await manager.allocateDeveloper({ taskId: "ignored-task", worktreePath: path });
      expect(allocation.ok).toBe(true);
      inspector.setCleanliness(path, { exists: true, isClean: false, dirtyFiles: ["node_modules/"], ignoredFiles: ["node_modules/"] } as any);
      expect((await manager.releaseDeveloper({ taskId: "ignored-task", removeWorktree: true })).ok).toBe(false);
      inspector.setCleanliness(path, { exists: true, isClean: false, dirtyFiles: ["node_modules/", "source.ts"], ignoredFiles: ["node_modules/"] } as any);
      expect((await manager.releaseDeveloper({ taskId: "ignored-task", closePane: false, removeWorktree: false })).ok).toBe(false);
      inspector.setCleanliness(path, { exists: true, isClean: false, dirtyFiles: ["node_modules/"], ignoredFiles: ["node_modules/"] } as any);
      expect(await manager.releaseDeveloper({ taskId: "ignored-task", closePane: false, removeWorktree: false })).toMatchObject({ ok: true, value: { paneClosed: false, worktreeRemoved: false, retainedForReuse: true } });
      const closesByPolicy = createRolePaneManager({ config: { ...config, reuseIdleDeveloperPanes: false }, runner, store, worktreeInspector: inspector });
      expect(await closesByPolicy.releaseDeveloper({ taskId: "ignored-task", closePane: false, removeWorktree: false })).toMatchObject({ ok: true, value: { paneClosed: true, worktreeRemoved: false, retainedForReuse: false } });
    });

    it("safely reuses idle released developer pane for new task without duplicate worktree create/open", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();

      const wtPath = "/repo/.worktrees/reuse-wt";
      inspector.setCleanliness(wtPath, { exists: false, isClean: true, dirtyFiles: [] });

      // Allocate task-reuse-1
      const alloc1 = await manager.allocateDeveloper({
        taskId: "task-reuse-1",
        worktreePath: wtPath,
        branchName: "feat/reuse-1"
      });
      expect(alloc1.ok).toBe(true);
      if (!alloc1.ok) return;

      const originalPaneId = alloc1.value.paneId;
      const initialWtCalls = runner.calls.filter((c) => c.args[0] === "worktree").length;

      // Release task-reuse-1 with closePane: false, removeWorktree: false
      inspector.setCleanliness(wtPath, { exists: true, isClean: true, dirtyFiles: [] });
      const releaseRes = await manager.releaseDeveloper({
        taskId: "task-reuse-1",
        closePane: false,
        removeWorktree: false
      });
      expect(releaseRes.ok).toBe(true);
      if (!releaseRes.ok) return;

      expect(releaseRes.value.retainedForReuse).toBe(true);
      expect(releaseRes.value.paneClosed).toBe(false);
      expect(releaseRes.value.worktreeRemoved).toBe(false);

      // Now allocate task-reuse-2 on the same worktree
      const alloc2 = await manager.allocateDeveloper({
        taskId: "task-reuse-2",
        worktreePath: wtPath,
        branchName: "feat/reuse-2"
      });
      expect(alloc2.ok).toBe(true);
      if (!alloc2.ok) return;

      // Pane ID must match the original retained pane
      expect(alloc2.value.paneId).toBe(originalPaneId);

      // No new worktree create or worktree open should have been called
      const postWtCalls = runner.calls.filter((c) => c.args[0] === "worktree").length;
      expect(postWtCalls).toBe(initialWtCalls);
    });
  });

  // Scenario 8: Khôi phục mapping sau restart & Pane move ID update
  describe("Scenario 8: Recover mapping after restart & pane move ID update", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "bflow-test-store-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("recovers mapping after Herdr restart, updating all IDs and attachTarget to new Herdr IDs", async () => {
      const fileStore = new FileSessionManifestStore(tempDir);
      const manager = createRolePaneManager({ config, runner, store: fileStore, worktreeInspector: inspector });
      const initRes = await manager.initializeTopology();
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      const oldManifest = initRes.value;
      const oldChatPaneId = oldManifest.attachTarget.paneId;

      // Simulate Herdr restart renumbering all workspaces, tabs, panes, terminals
      runner.simulateRestart(true);

      // Create a fresh manager instance simulating process restart
      const freshManager = createRolePaneManager({ config, runner, store: fileStore, worktreeInspector: inspector });
      const recoverRes = await freshManager.recoverAfterRestart();

      expect(recoverRes.ok).toBe(true);
      if (!recoverRes.ok) return;

      const recoveredManifest = recoverRes.value;
      // Verifies old IDs were replaced by new IDs
      expect(recoveredManifest.herdrWorkspaceId).not.toBe(oldManifest.herdrWorkspaceId);
      expect(recoveredManifest.attachTarget.paneId).not.toBe(oldChatPaneId);

      const recoveredChat = recoveredManifest.panes.find((p) => p.role === "conversation")!;
      expect(recoveredManifest.attachTarget.paneId).toBe(recoveredChat.paneId);
    });

    it("brings the topology up despite a stale Developer binding left by a cancelled run", async () => {
      const fileStore = new FileSessionManifestStore(tempDir);
      const manager = createRolePaneManager({ config, runner, store: fileStore, worktreeInspector: inspector });
      const initRes = await manager.initializeTopology();
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      const chat = initRes.value.panes.find((p) => p.role === "conversation")!;
      const stale = { ...chat, bindingId: "binding-dev-stale", role: "developer" as const, agentId: "dev-stale", paneId: "w9:p9",
        workspaceId: "w9", tabId: "w9:t1", permanent: false, worktreePath: join(tempDir, "gone"), readOnlyWorkspace: false,
        transportState: "disconnected" as const };
      const saved = await fileStore.save({ ...initRes.value, panes: [...initRes.value.panes, stale] });
      expect(saved.ok).toBe(true);

      const again = await createRolePaneManager({ config, runner, store: fileStore, worktreeInspector: inspector }).initializeTopology();
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value.status).toBe("up");
      expect(again.value.panes.find((p) => p.bindingId === "binding-dev-stale")?.transportState).toBe("disconnected");
    });

    it("updates pane ID on moveRolePane without keeping old pane ID", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();

      const coordBinding = (await manager.getRoleBinding("coordinator")) as { ok: true; value: any };
      const oldCoordPaneId = coordBinding.value.paneId;

      const moveRes = await manager.moveRolePane("coordinator", {
        mode: "new_tab",
        label: "custom-coord-tab"
      });

      expect(moveRes.ok).toBe(true);
      if (!moveRes.ok) return;

      const updatedBinding = moveRes.value;
      expect(updatedBinding.paneId).not.toBe(oldCoordPaneId);

      // Verify manifest was updated
      const manifest = (await manager.getManifest()) as { ok: true; value: any };
      const manifestCoord = manifest.value.panes.find((p: any) => p.role === "coordinator");
      expect(manifestCoord.paneId).toBe(updatedBinding.paneId);
    });

    it("recovers and re-launches agents when panes are restored at shell prompt (agent === null) after restart", async () => {
      const fileStore = new FileSessionManifestStore(tempDir);
      const manager = createRolePaneManager({ config, runner, store: fileStore, worktreeInspector: inspector });
      const initRes = await manager.initializeTopology();
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      const oldManifest = initRes.value;

      // Simulate restart with new IDs AND agent processes cleared (restored at shell prompt)
      runner.simulateRestart(true);
      for (const p of runner.panes.values()) {
        p.agent = null;
      }
      runner.agents.clear();

      const freshManager = createRolePaneManager({ config, runner, store: fileStore, worktreeInspector: inspector });
      const recoverRes = await freshManager.recoverAfterRestart();

      expect(recoverRes.ok).toBe(true);
      if (!recoverRes.ok) return;

      const recoveredManifest = recoverRes.value;
      expect(recoveredManifest.status).toBe("up");
      expect(recoveredManifest.herdrWorkspaceId).not.toBe(oldManifest.herdrWorkspaceId);

      // Verifies all permanent roles are running agents again in their panes
      for (const pane of recoveredManifest.panes) {
        expect(pane.paneId).not.toBe(oldManifest.panes.find((p) => p.role === pane.role)?.paneId);
        const liveAgent = Array.from(runner.agents.values()).find((a) => a.paneId === pane.paneId);
        expect(liveAgent).toBeDefined();
        expect(liveAgent?.agentStatus).toBe("idle");
      }
    });
  });

  // Scenario 9: Focus đúng chat pane
  describe("Scenario 9: Focus conversation chat pane", () => {
    it("focuses workspace, conversation tab, and chat pane, returning attachTarget binding", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();

      const focusCallsBefore = runner.calls.filter((c) => c.args[1] === "focus").length;

      const focusRes = await manager.focusConversationPane();
      expect(focusRes.ok).toBe(true);
      if (!focusRes.ok) return;

      const binding = focusRes.value;
      expect(binding.role).toBe("conversation");
      expect(binding.paneGroup).toBe("conversation");

      const manifest = (await manager.getManifest()) as { ok: true; value: any };
      expect(manifest.value.attachTarget.paneId).toBe(binding.paneId);

      const focusCallsAfter = runner.calls.filter((c) => c.args[1] === "focus");
      expect(focusCallsAfter.length).toBeGreaterThan(focusCallsBefore);
    });
  });

  // Protocol Corruption & Runner / WorktreeInspector Unit Tests
  describe("Protocol Corruption & Runner / WorktreeInspector Unit Tests", () => {
    let gitTempDir: string;

    beforeEach(async () => {
      gitTempDir = await mkdtemp(join(tmpdir(), "bflow-git-test-"));
    });

    afterEach(async () => {
      await rm(gitTempDir, { recursive: true, force: true });
    });

    it("catches HerdrProtocolError on malformed JSON and returns corruption ContractError", async () => {
      runner.onCommand = (inv) => {
        if (inv.args[0] === "workspace" && inv.args[1] === "list") {
          return { exitCode: 0, stdout: "{ malformed json", stderr: "" };
        }
        return undefined;
      };

      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const result = await manager.initializeTopology();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("corruption");
        expect(result.error.retryable).toBe(false);
      }
    });

    it("createProcessRunner handles validation of arguments and AbortSignal", async () => {
      const runner = createProcessRunner("herdr");

      // Reject null byte in args
      const invalidOutcome = await runner.run({ args: ["workspace\0", "list"] });
      expect(invalidOutcome.failure).toBe("invalid_arguments");

      // AbortSignal
      const controller = new AbortController();
      controller.abort();
      const abortOutcome = await runner.run({
        args: ["workspace", "list"],
        signal: controller.signal
      });
      expect(abortOutcome.failure).toBe("aborted");
    });

    it("createGitWorktreeInspector inspects non-existent and real git repositories accurately", async () => {
      const gitInspector = createGitWorktreeInspector("git");

      // Non-existent path returns exists: false, isClean: true
      const nonExistent = await gitInspector.inspect("/non/existent/path/for/sure/12345");
      expect(nonExistent.ok).toBe(true);
      if (nonExistent.ok) {
        expect(nonExistent.value.exists).toBe(false);
        expect(nonExistent.value.isClean).toBe(true);
        expect(nonExistent.value.dirtyFiles).toEqual([]);
      }

      // Real git init directory - clean
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { writeFile } = await import("node:fs/promises");
      const exec = promisify(execFile);

      await exec("git", ["init", gitTempDir]);
      await exec("git", ["-C", gitTempDir, "config", "user.name", "Test"]);
      await exec("git", ["-C", gitTempDir, "config", "user.email", "test@test.com"]);

      const cleanRes = await gitInspector.inspect(gitTempDir);
      expect(cleanRes.ok).toBe(true);
      if (cleanRes.ok) {
        expect(cleanRes.value.exists).toBe(true);
        expect(cleanRes.value.isClean).toBe(true);
        expect(cleanRes.value.dirtyFiles).toEqual([]);
      }

      // Add dirty untracked file
      await writeFile(join(gitTempDir, "dirty.txt"), "hello");
      const dirtyRes = await gitInspector.inspect(gitTempDir);
      expect(dirtyRes.ok).toBe(true);
      if (dirtyRes.ok) {
        expect(dirtyRes.value.exists).toBe(true);
        expect(dirtyRes.value.isClean).toBe(false);
        expect(dirtyRes.value.dirtyFiles).toContain("dirty.txt");
      }
    });
  });

  describe("P13 Audit Remediation Tests: shutdownTopology, store.save error propagation, and developer reallocation", () => {
    let runner: FakeHerdrCommandRunner;
    let store: InMemorySessionManifestStore;
    let inspector: FakeWorktreeInspector;
    let config: RolePaneManagerConfig;

    beforeEach(() => {
      runner = new FakeHerdrCommandRunner();
      store = new InMemorySessionManifestStore();
      inspector = new FakeWorktreeInspector();
      config = {
        sessionId: "remediation-session",
        projectName: "remediation-project",
        workspaceRoot: "/workspace/remediation"
      };
    });

    it("shutdownTopology closes live panes, updates status to down, and sets transportState to cancelled", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const initRes = await manager.initializeTopology();
      expect(initRes.ok).toBe(true);

      const shutdownRes = await manager.shutdownTopology();
      expect(shutdownRes.ok).toBe(true);
      if (!shutdownRes.ok) return;

      expect(shutdownRes.value.status).toBe("down");
      expect(shutdownRes.value.panes.every((p) => p.transportState === "cancelled")).toBe(true);

      // Verify pane close commands were executed in runner
      const closeCalls = runner.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close");
      expect(closeCalls.length).toBeGreaterThanOrEqual(initRes.ok ? initRes.value.panes.length : 1);

      // Verify persisted manifest is down
      const loaded = await store.load(config.sessionId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok && loaded.value) {
        expect(loaded.value.status).toBe("down");
        expect(loaded.value.panes.every((p) => p.transportState === "cancelled")).toBe(true);
      }
    });

    it("closes Developer worktree panes before the source workspace's role panes", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      expect((await manager.initializeTopology()).ok).toBe(true);
      inspector.setCleanliness("/repo/.worktrees/task-1", { exists: false, isClean: true, dirtyFiles: [] });
      const developer = await manager.allocateDeveloper({ taskId: "task-1", worktreePath: "/repo/.worktrees/task-1", branchName: "feat/task-1" });
      expect(developer.ok).toBe(true);
      if (!developer.ok) return;
      const before = runner.calls.length;
      expect((await manager.shutdownTopology()).ok).toBe(true);
      const closed = runner.calls.slice(before).filter((c) => c.args[0] === "pane" && c.args[1] === "close").map((c) => c.args[2]);
      // Herdr refuses to close the source workspace's last pane while a linked worktree workspace is open.
      expect(closed[0]).toBe(developer.value.paneId);
      expect(closed.length).toBeGreaterThan(1);
    });

    it.each(["error", "timeout"])("does not record shutdown success when pane close returns %s", async failure => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const initialized = await manager.initializeTopology();
      expect(initialized.ok).toBe(true);
      runner.onCommand = invocation => invocation.args[0] === "pane" && invocation.args[1] === "close"
        ? failure === "timeout"
          ? { exitCode: null, stdout: "", stderr: "", failure: "timeout", started: true }
          : { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "denied", message: "cannot close" } }) }
        : undefined;
      const result = await manager.shutdownTopology();
      expect(result.ok).toBe(false);
      const persisted = await store.load(config.sessionId);
      expect(persisted.ok).toBe(true);
      if (persisted.ok && initialized.ok) expect(persisted.value).toEqual(initialized.value);
      expect(runner.panes.size).toBeGreaterThan(0);
    });

    it("retries partial shutdown only for panes confirmed present by a fresh successful listing", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const initial = await manager.initializeTopology();
      if (!initial.ok) throw new Error("initialize failed");
      const firstPane = initial.value.panes[0]!.paneId;
      let count = 0;
      runner.onCommand = invocation => {
        if (invocation.args[0] === "pane" && invocation.args[1] === "close" && ++count === 2)
          return { exitCode: null, stdout: "", stderr: "", failure: "timeout", started: true };
      };
      expect((await manager.shutdownTopology()).ok).toBe(false);
      expect(runner.panes.has(firstPane)).toBe(false);
      runner.onCommand = undefined;
      const before = runner.calls.length;
      const result = await manager.shutdownTopology();
      expect(result.ok && result.value.status).toBe("down");
      expect(runner.calls.slice(before).some(c => c.args[0] === "pane" && c.args[1] === "close" && c.args[2] === firstPane)).toBe(false);
    });

    it("finishes shutdown when the recorded workspace has already disappeared", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const initialized = await manager.initializeTopology();
      if (!initialized.ok) throw new Error("initialize failed");
      runner.workspaces.clear();
      runner.panes.clear();
      runner.agents.clear();
      await runner.run({ args: ["workspace", "create", "--label", "operator-workspace", "--cwd", "/other/repository"] });
      const unrelatedPaneIds = [...runner.panes.keys()];
      const result = await manager.shutdownTopology();
      expect(result.ok && result.value.status).toBe("down");
      expect([...runner.panes.keys()]).toEqual(unrelatedPaneIds);
      const persisted = await store.load(config.sessionId);
      expect(persisted.ok && persisted.value?.status).toBe("down");
    });

    it("closes a developer in its own workspace after the primary workspace disappears, preserving the worktree", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const initialized = await manager.initializeTopology();
      if (!initialized.ok) throw new Error("initialize failed");
      const worktreePath = "/repo/.worktrees/shutdown-developer";
      inspector.setCleanliness(worktreePath, { exists: false, isClean: true, dirtyFiles: [] });
      const developer = await manager.allocateDeveloper({ taskId: "shutdown-task", worktreePath, agentName: "dev-shutdown" });
      if (!developer.ok) throw new Error(developer.error.message);
      runner.workspaces.delete(initialized.value.herdrWorkspaceId);
      for (const pane of initialized.value.panes) {
        runner.panes.delete(pane.paneId);
        runner.agents.delete(pane.agentId);
      }
      const result = await manager.shutdownTopology();
      expect(result.ok && result.value.status).toBe("down");
      expect(runner.panes.has(developer.value.paneId)).toBe(false);
      expect(runner.agents.has("dev-shutdown")).toBe(false);
      expect(runner.worktrees.has(worktreePath)).toBe(true);
    });

    it.each(["timeout", "malformed", "permission"])("does not infer absent panes from a failed pane listing: %s", async failure => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const initialized = await manager.initializeTopology();
      if (!initialized.ok) throw new Error("initialize failed");
      runner.onCommand = invocation => {
        if (invocation.args[0] !== "pane" || invocation.args[1] !== "list") return;
        if (failure === "timeout") return { exitCode: null, stdout: "", stderr: "", failure: "timeout", started: true };
        if (failure === "malformed") return { exitCode: 0, stdout: "{}", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code: "denied", message: "permission denied" } }) };
      };
      const result = await manager.shutdownTopology();
      expect(result.ok).toBe(false);
      const persisted = await store.load(config.sessionId);
      expect(persisted.ok && persisted.value).toEqual(initialized.value);
      expect(runner.panes.size).toBe(initialized.value.panes.length);
    });

    it.each(["timeout", "malformed", "contradictory"])("keeps the manifest when workspace absence cannot be established: %s", async failure => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const initialized = await manager.initializeTopology();
      if (!initialized.ok) throw new Error("initialize failed");
      runner.onCommand = invocation => {
        if (invocation.args[0] === "pane" && invocation.args[1] === "list") {
          return { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code: "workspace_not_found", message: "workspace missing" } }) };
        }
        if (invocation.args[0] === "workspace" && invocation.args[1] === "list") {
          if (failure === "timeout") return { exitCode: null, stdout: "", stderr: "", failure: "timeout", started: true };
          if (failure === "malformed") return { exitCode: 0, stdout: "{}", stderr: "" };
        }
      };
      const result = await manager.shutdownTopology();
      expect(result.ok).toBe(false);
      const persisted = await store.load(config.sessionId);
      expect(persisted.ok && persisted.value).toEqual(initialized.value);
      expect(runner.panes.size).toBe(initialized.value.panes.length);
    });

    it("propagates store.save error in inspectTopologyHealth, focusConversationPane, and allocateDeveloper", async () => {
      const normalManager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      const initRes = await normalManager.initializeTopology();
      expect(initRes.ok).toBe(true);

      const failingStore: SessionManifestStore = {
        load: (sessionId, opts) => store.load(sessionId, opts),
        save: async () => ({
          ok: false,
          error: { code: "io", retryable: true, message: "Disk write failure simulated" }
        })
      };

      const failingManager = createRolePaneManager({
        config,
        runner,
        store: failingStore,
        worktreeInspector: inspector
      });

      // 1. inspectTopologyHealth
      const healthRes = await failingManager.inspectTopologyHealth();
      expect(healthRes.ok).toBe(false);
      if (!healthRes.ok) {
        expect(healthRes.error.code).toBe("io");
      }

      // 2. focusConversationPane
      const focusRes = await failingManager.focusConversationPane();
      expect(focusRes.ok).toBe(false);
      if (!focusRes.ok) {
        expect(focusRes.error.code).toBe("io");
      }

      // 3. allocateDeveloper (new worktree path)
      inspector.setCleanliness("/repo/.worktrees/fail-save-new", { exists: false, isClean: true, dirtyFiles: [] });
      const allocNewRes = await failingManager.allocateDeveloper({
        taskId: "task-fail-new",
        worktreePath: "/repo/.worktrees/fail-save-new"
      });
      expect(allocNewRes.ok).toBe(false);
      if (!allocNewRes.ok) {
        expect(allocNewRes.error.code).toBe("io");
      }

      // 4. allocateDeveloper (reused pane path)
      // First allocate and release cleanly using normalManager
      inspector.setCleanliness("/repo/.worktrees/fail-save-reuse", { exists: false, isClean: true, dirtyFiles: [] });
      const allocClean = await normalManager.allocateDeveloper({
        taskId: "task-reuse-prep",
        worktreePath: "/repo/.worktrees/fail-save-reuse"
      });
      expect(allocClean.ok).toBe(true);
      inspector.setCleanliness("/repo/.worktrees/fail-save-reuse", { exists: true, isClean: true, dirtyFiles: [] });
      const releaseClean = await normalManager.releaseDeveloper({
        taskId: "task-reuse-prep",
        closePane: false,
        removeWorktree: false
      });
      expect(releaseClean.ok).toBe(true);

      // Now attempt reuse with failing manager
      const allocReuseRes = await failingManager.allocateDeveloper({
        taskId: "task-reuse-fail",
        worktreePath: "/repo/.worktrees/fail-save-reuse"
      });
      expect(allocReuseRes.ok).toBe(false);
      if (!allocReuseRes.ok) {
        expect(allocReuseRes.error.code).toBe("io");
      }
    });

    it("reallocating a released developer slot with a new agentName splits fresh pane and closes old pane", async () => {
      const manager = createRolePaneManager({ config, runner, store, worktreeInspector: inspector });
      await manager.initializeTopology();

      const wtPath = "/repo/.worktrees/realloc-wt";
      inspector.setCleanliness(wtPath, { exists: false, isClean: true, dirtyFiles: [] });

      // Step 1: Allocate developer with dev-orig
      const alloc1 = await manager.allocateDeveloper({
        taskId: "task-100",
        worktreePath: wtPath,
        agentName: "dev-orig"
      });
      expect(alloc1.ok).toBe(true);
      if (!alloc1.ok) return;
      expect(alloc1.value.agentId).toBe("dev-orig");
      const oldPaneId = alloc1.value.paneId;

      // Step 2: Release developer but retain pane
      inspector.setCleanliness(wtPath, { exists: true, isClean: true, dirtyFiles: [] });
      const releaseRes = await manager.releaseDeveloper({
        taskId: "task-100",
        closePane: false,
        removeWorktree: false
      });
      expect(releaseRes.ok).toBe(true);
      if (!releaseRes.ok) return;
      expect(releaseRes.value.retainedForReuse).toBe(true);

      // Step 3: Reallocate with a NEW agentName: "dev-new"
      const alloc2 = await manager.allocateDeveloper({
        taskId: "task-200",
        worktreePath: wtPath,
        agentName: "dev-new"
      });
      expect(alloc2.ok).toBe(true);
      if (!alloc2.ok) return;

      expect(alloc2.value.agentId).toBe("dev-new");
      expect(alloc2.value.metadata?.["taskId"]).toBe("task-200");
      expect(alloc2.value.metadata?.["allocationStatus"]).toBe("active");
      // The pane should have been replaced (fresh split pane, not the old occupied pane)
      expect(alloc2.value.paneId).not.toBe(oldPaneId);

      // Verify the old pane was closed
      const closeCalls = runner.calls.filter(
        (c) => c.args[0] === "pane" && c.args[1] === "close" && c.args[2] === oldPaneId
      );
      expect(closeCalls.length).toBe(1);

      // Verify manifest reflects dev-new
      const manifestRes = await manager.getManifest();
      expect(manifestRes.ok).toBe(true);
      if (manifestRes.ok && manifestRes.value) {
        const devPanes = manifestRes.value.panes.filter((p) => p.role === "developer");
        expect(devPanes.some((p) => p.agentId === "dev-new" && p.paneId === alloc2.value.paneId)).toBe(true);
        expect(devPanes.some((p) => p.paneId === oldPaneId)).toBe(false);
      }
    });

    it("automatically replaces and restarts a host-launched permanent Agy pane that idles without a native session hook", async () => {
      const { readBuiltinRolePrompt } = await import("../src/role-prompts.js");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const directory = await realpath(await mkdtemp(join(tmpdir(), "bflow-agy-recovery-")));
      try {
        const chat = await readBuiltinRolePrompt("chat"), coordinator = await readBuiltinRolePrompt("coordinator");
        if (!chat || !coordinator) throw new Error("original role prompts are missing");
        const chatHome = join(directory, "agy-home", "conversation");
        const coordHome = join(directory, "agy-home", "coordinator");
        await mkdir(join(chatHome, ".gemini", "config"), { recursive: true, mode: 0o700 });
        await mkdir(join(coordHome, ".gemini", "config"), { recursive: true, mode: 0o700 });
        const chatPrompt = join(directory, "conversation.system-prompt.txt");
        const coordPrompt = join(directory, "coordinator.system-prompt.txt");
        await writeFile(chatPrompt, chat.prompt, { mode: 0o600 });
        await writeFile(coordPrompt, coordinator.prompt, { mode: 0o600 });
        const scriptFor = (promptPath: string) => [
          'import { readFileSync } from "node:fs";',
          `const systemMessage = readFileSync(${JSON.stringify(promptPath)}, "utf8");`,
          'process.stdout.write(JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage } }] }) + "\\n");'
        ].join("\n");
        const chatHook = join(chatHome, ".gemini", "config", "bflow-session-start.mjs");
        const coordHook = join(coordHome, ".gemini", "config", "bflow-session-start.mjs");
        await writeFile(chatHook, scriptFor(chatPrompt), { mode: 0o600 });
        await writeFile(coordHook, scriptFor(coordPrompt), { mode: 0o600 });
        await writeFile(join(chatHome, ".gemini", "config", "hooks.json"), JSON.stringify({ bflow: { SessionStart: [{ type: "command", command: `'/trusted/node' '${chatHook}'`, timeout: 30 }] } }), { mode: 0o600 });
        await writeFile(join(coordHome, ".gemini", "config", "hooks.json"), JSON.stringify({ bflow: { SessionStart: [{ type: "command", command: `'/trusted/node' '${coordHook}'`, timeout: 30 }] } }), { mode: 0o600 });

        let nowMs = Date.parse("2026-10-24T08:00:00.000Z");
        const fakeRunner = new FakeHerdrCommandRunner();
        const fakeStore = new InMemorySessionManifestStore();
        const fakeSocket = {
          request: async (method: string, params: Record<string, unknown>) => {
            const args = method === "workspace.create"
              ? ["workspace", "create", "--cwd", String(params["cwd"]), "--label", String(params["label"]), "--no-focus"]
              : method === "tab.create"
                ? ["tab", "create", "--workspace", String(params["workspace_id"]), "--cwd", String(params["cwd"]), "--label", String(params["label"]), "--no-focus"]
                : ["pane", "split", String(params["target_pane_id"]), "--direction", String(params["direction"] ?? "right"), "--cwd", String(params["cwd"] ?? "/workspace"), "--no-focus"];
            const outcome = await fakeRunner.run({ args });
            const parsed = JSON.parse(outcome.stdout);
            return { ok: true as const, value: parsed.result };
          }
        };
        const agyManager = createRolePaneManager({
          config: {
            ...config,
            permanentRoles: ["chat", "coordinator"],
            roleConfigs: {
              chat: {
                agentKind: "agy",
                launch: { provider: "agy", argv: ["--model", "gemini-3.8-flash-medium"], env: { HOME: chatHome }, launchId: "launch-chat", launchFingerprint: "fp-chat" }
              },
              coordinator: {
                agentKind: "agy",
                launch: { provider: "agy", argv: ["--model", "gemini-4-argon-high"], env: { HOME: coordHome }, launchId: "launch-coord", launchFingerprint: "fp-coord" }
              }
            }
          },
          runner: fakeRunner,
          store: fakeStore,
          socket: fakeSocket,
          worktreeInspector: inspector,
          clock: () => new Date(nowMs)
        });
        const init = await agyManager.initializeTopology();
        expect(init.ok).toBe(true);
        if (!init.ok) return;
        const originalChatPane = init.value.panes.find(p => p.role === "conversation")!;
        expect(originalChatPane.metadata?.["nativeSessionPending"]).toBe(true);

        nowMs += 10_000;
        const health = await agyManager.inspectTopologyHealth();
        expect(health.ok).toBe(true);
        const manifestAfter = await agyManager.getManifest();
        expect(manifestAfter.ok).toBe(true);
        if (manifestAfter.ok && manifestAfter.value) {
          const restartedChat = manifestAfter.value.panes.find(p => p.role === "conversation")!;
          expect(restartedChat.paneId).not.toBe(originalChatPane.paneId);
          expect(restartedChat.metadata?.["nativeSessionRetries"]).toBe(1);
          expect(manifestAfter.value.attachTarget.paneId).toBe(restartedChat.paneId);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
