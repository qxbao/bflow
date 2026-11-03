import type { CommandInvocation, CommandOutcome, HerdrCommandRunner } from "../../src/types.js";

/**
 * Stateful Herdr protocol 22 fake for Director-layout tests. Records every argv, models panes as idle shells or as a
 * foreground process launched by `pane run`, and lets tests simulate a viewer exit, a lost pane or a replaced terminal.
 */
interface FakePane {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
  label?: string;
  agent: string | null;
  shellPid: number;
  foreground?: { pid: number; argv: string[] };
}

interface FakeAgent { name: string; kind: string; paneId: string }

const ok = (result: Record<string, unknown>): CommandOutcome => ({ exitCode: 0, stdout: JSON.stringify({ id: "1", result }), stderr: "" });
const fail = (code: string, message: string): CommandOutcome => ({ exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code, message } }) });
const flag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

/** Splits the single-quoted command line produced by the progress pane back into argv. */
export function unquoteShellCommand(line: string): string[] {
  const argv: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) argv.push(match[1]!.replace(/'\\''/g, "'"));
  return argv;
}

export class DirectorHerdrFake implements HerdrCommandRunner {
  readonly calls: string[][] = [];
  readonly workspaces = new Map<string, { workspaceId: string; label: string; activeTabId: string; cwd: string }>();
  readonly tabs = new Map<string, { tabId: string; workspaceId: string; label: string }>();
  readonly panes = new Map<string, FakePane>();
  readonly agents = new Map<string, FakeAgent>();
  private counter = 0;
  /** When set, `pane run` fails with this outcome instead of launching. */
  paneRunOutcome?: CommandOutcome;
  /** When false, `pane run` is acknowledged but no process appears (unconfirmed launch). */
  launchStarts = true;

  private next(prefix: string): string { return `${prefix}-${++this.counter}`; }

  private createPane(workspaceId: string, tabId: string, cwd: string): FakePane {
    const pane: FakePane = { paneId: this.next("pane"), terminalId: this.next("term"), workspaceId, tabId, cwd, agent: null, shellPid: 1000 + this.counter };
    this.panes.set(pane.paneId, pane);
    return pane;
  }

  paneJson(pane: FakePane): Record<string, unknown> {
    return { pane_id: pane.paneId, terminal_id: pane.terminalId, workspace_id: pane.workspaceId, tab_id: pane.tabId, focused: false,
      agent: pane.agent, agent_status: pane.agent === null ? "unknown" : "idle", revision: 1, cwd: pane.cwd,
      ...(pane.label !== undefined ? { label: pane.label } : {}) };
  }

  private tabJson(tab: { tabId: string; workspaceId: string; label: string }): Record<string, unknown> {
    const paneCount = [...this.panes.values()].filter(pane => pane.tabId === tab.tabId).length;
    return { tab_id: tab.tabId, workspace_id: tab.workspaceId, label: tab.label, focused: false, pane_count: paneCount, agent_status: "unknown" };
  }

  private agentJson(agent: FakeAgent): Record<string, unknown> {
    const pane = this.panes.get(agent.paneId)!;
    return { name: agent.name, agent: agent.kind, pane_id: pane.paneId, terminal_id: pane.terminalId, workspace_id: pane.workspaceId,
      tab_id: pane.tabId, focused: false, agent_status: "idle", revision: 1, interactive_ready: true, launch_pending: false,
      agent_session: { source: "test", kind: "id", value: `session-${agent.name}` } };
  }

  /** The launched process exits and the pane returns to its shell prompt. */
  exitForeground(paneId: string): void { delete this.panes.get(paneId)!.foreground; }

  /** The pane disappears (closed outside Bflow). */
  removePane(paneId: string): void { this.panes.delete(paneId); }

  /** A restarted server reuses the public pane id for a new terminal. */
  replaceTerminal(paneId: string): void {
    const pane = this.panes.get(paneId)!;
    pane.terminalId = this.next("term");
    delete pane.foreground;
  }

  /** Another process (not the progress command) occupies the pane. */
  occupy(paneId: string, argv: string[]): void { this.panes.get(paneId)!.foreground = { pid: 9000 + ++this.counter, argv }; }

  count(...prefix: string[]): number {
    return this.calls.filter(args => prefix.every((part, index) => args[index] === part)).length;
  }

  async run(invocation: CommandInvocation): Promise<CommandOutcome> {
    const args = [...invocation.args];
    this.calls.push(args);
    const [domain, action, ...rest] = args;
    if (domain === "workspace") {
      if (action === "list") {
        return ok({ type: "workspace_list", workspaces: [...this.workspaces.values()].map(ws => ({ workspace_id: ws.workspaceId, label: ws.label,
          active_tab_id: ws.activeTabId, focused: false, pane_count: 1, tab_count: 1, agent_status: "unknown" })) });
      }
      if (action === "create") {
        const workspaceId = this.next("ws");
        const tab = { tabId: this.next("tab"), workspaceId, label: "1" };
        this.tabs.set(tab.tabId, tab);
        const cwd = flag(rest, "--cwd")!;
        const pane = this.createPane(workspaceId, tab.tabId, cwd);
        const ws = { workspaceId, label: flag(rest, "--label")!, activeTabId: tab.tabId, cwd };
        this.workspaces.set(workspaceId, ws);
        return ok({ type: "workspace_created", workspace: { workspace_id: workspaceId, label: ws.label, active_tab_id: tab.tabId, focused: false,
          pane_count: 1, tab_count: 1, agent_status: "unknown" }, tab: this.tabJson(tab), root_pane: this.paneJson(pane) });
      }
      if (action === "focus") {
        const ws = this.workspaces.get(rest[0]!);
        if (!ws) return fail("workspace_not_found", "workspace not found");
        return ok({ type: "workspace_info", workspace: { workspace_id: ws.workspaceId, label: ws.label, active_tab_id: ws.activeTabId, focused: true,
          pane_count: 1, tab_count: 1, agent_status: "unknown" } });
      }
    }
    if (domain === "tab") {
      if (action === "list") {
        const workspaceId = flag(rest, "--workspace");
        return ok({ type: "tab_list", tabs: [...this.tabs.values()].filter(tab => tab.workspaceId === workspaceId).map(tab => this.tabJson(tab)) });
      }
      if (action === "create") {
        const workspaceId = flag(rest, "--workspace")!;
        const tab = { tabId: this.next("tab"), workspaceId, label: flag(rest, "--label")! };
        this.tabs.set(tab.tabId, tab);
        const pane = this.createPane(workspaceId, tab.tabId, flag(rest, "--cwd")!);
        return ok({ type: "tab_created", tab: this.tabJson(tab), root_pane: this.paneJson(pane) });
      }
      if (action === "rename" || action === "focus") {
        const tab = this.tabs.get(rest[0]!);
        if (!tab) return fail("tab_not_found", "tab not found");
        if (action === "rename") tab.label = rest[1]!;
        return ok({ type: "tab_info", tab: this.tabJson(tab) });
      }
    }
    if (domain === "pane") {
      if (action === "list") {
        const workspaceId = flag(rest, "--workspace");
        if (workspaceId && !this.workspaces.has(workspaceId)) return fail("workspace_not_found", "workspace not found");
        return ok({ type: "pane_list", panes: [...this.panes.values()].filter(pane => pane.workspaceId === workspaceId).map(pane => this.paneJson(pane)) });
      }
      const paneId = action === "process-info" || action === "layout" ? flag(rest, "--pane")! : rest[0]!;
      const pane = this.panes.get(paneId);
      if (action === "split") {
        if (!pane) return fail("pane_not_found", "pane not found");
        return ok({ type: "pane_info", pane: this.paneJson(this.createPane(pane.workspaceId, pane.tabId, flag(rest, "--cwd")!)) });
      }
      if (!pane) return fail("pane_not_found", `pane ${paneId} not found`);
      if (action === "get") return ok({ type: "pane_info", pane: this.paneJson(pane) });
      if (action === "rename") { pane.label = rest[1]!; return ok({ type: "pane_info", pane: this.paneJson(pane) }); }
      if (action === "close") {
        // Like Herdr, closing a tab's last pane closes the tab, and a workspace's last tab closes the workspace.
        this.panes.delete(paneId);
        if (![...this.panes.values()].some(item => item.tabId === pane.tabId)) this.tabs.delete(pane.tabId);
        if (![...this.tabs.values()].some(tab => tab.workspaceId === pane.workspaceId)) this.workspaces.delete(pane.workspaceId);
        return ok({ type: "ok" });
      }
      if (action === "layout") {
        const panes = [...this.panes.values()].filter(item => item.tabId === pane.tabId);
        return ok({ type: "pane_layout", layout: { workspace_id: pane.workspaceId, tab_id: pane.tabId,
          panes: panes.map((item, index) => ({ pane_id: item.paneId, rect: { x: index * 40, y: 0, width: 40, height: 40 } })), splits: [] } });
      }
      if (action === "process-info") {
        const leader = pane.foreground;
        return ok({ type: "pane_process_info", process_info: { pane_id: pane.paneId, shell_pid: pane.shellPid,
          foreground_process_group_id: leader?.pid ?? pane.shellPid,
          foreground_processes: leader ? [{ pid: leader.pid, argv: leader.argv }] : [{ pid: pane.shellPid, argv: ["-zsh"] }] } });
      }
      if (action === "run") {
        if (this.paneRunOutcome) return this.paneRunOutcome;
        if (this.launchStarts) pane.foreground = { pid: 5000 + ++this.counter, argv: unquoteShellCommand(rest[1]!) };
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }
    if (domain === "agent") {
      if (action === "list") return ok({ type: "agent_list", agents: [...this.agents.values()].filter(agent => this.panes.has(agent.paneId)).map(agent => this.agentJson(agent)) });
      if (action === "start") {
        const pane = this.panes.get(flag(rest, "--pane")!);
        if (!pane) return fail("pane_not_found", "pane not found");
        const agent = { name: rest[0]!, kind: flag(rest, "--kind")!, paneId: pane.paneId };
        pane.agent = agent.kind;
        this.agents.set(agent.name, agent);
        return ok({ type: "agent_started", agent: this.agentJson(agent) });
      }
      if (action === "get" || action === "focus") {
        const agent = [...this.agents.values()].find(item => item.name === rest[0] || item.paneId === rest[0]);
        if (!agent || !this.panes.has(agent.paneId)) return fail("agent_not_found", "agent not found");
        return ok({ type: "agent_info", agent: this.agentJson(agent) });
      }
    }
    return fail("unsupported", `fake does not support ${args.join(" ")}`);
  }
}
