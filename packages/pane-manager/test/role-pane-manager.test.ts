import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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

  // Scenario 1: Khởi tạo topology (Initialize full topology)
  describe("Scenario 1: Initialize full topology", () => {
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
});
