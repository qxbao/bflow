import { environmentProcessRunner, type EnvironmentProcessRequest, type EnvironmentProcessRunner } from "../../src/environment-process.js";

interface Pane {
  pane_id: string; terminal_id: string; workspace_id: string; tab_id: string; revision: number;
  agent: string | null; agent_status: string; name: string | null; interactive_ready: boolean; launch_pending: boolean;
}
interface Tab { tab_id: string; workspace_id: string; label: string; }
interface Workspace { workspace_id: string; active_tab_id: string; label: string; }
interface Session { running: boolean; workspaces: Workspace[]; tabs: Tab[]; panes: Pane[]; }

/** Stateful wire fixture. Production P13 parses every response and makes every topology decision. */
export class HerdrProcesses implements EnvironmentProcessRunner {
  readonly calls: EnvironmentProcessRequest[] = [];
  readonly sessions = new Map<string, Session>();
  blockedAgent: string | undefined;
  private next = 0;
  session(name: string): Session {
    let session = this.sessions.get(name);
    if (!session) { session = { running: false, workspaces: [], tabs: [], panes: [] }; this.sessions.set(name, session); }
    return session;
  }
  async run(request: EnvironmentProcessRequest) {
    this.calls.push(request);
    if (request.executable === "git") return environmentProcessRunner.run(request);
    const args = request.args;
    const [domain, action, target] = args;
    const name = request.env?.["HERDR_SESSION"] ?? "inherited-default";
    const session = this.session(name);
    const flag = (key: string) => args[args.indexOf(key) + 1]!;
    const success = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
    const wire = (type: string, data: object) => success({ id: "1", result: { type, ...data } });
    const failure = (message: string) => ({ exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code: "invalid_target", message } }) });
    const newPane = (tab: Tab): Pane => {
      const pane: Pane = { pane_id: `p${++this.next}`, terminal_id: `term${this.next}`, workspace_id: tab.workspace_id,
        tab_id: tab.tab_id, revision: 1, agent: null, agent_status: "idle", name: null, interactive_ready: false, launch_pending: false };
      session.panes.push(pane); return pane;
    };
    const newTab = (workspaceId: string, label: string): Tab => {
      const tab = { tab_id: `t${++this.next}`, workspace_id: workspaceId, label }; session.tabs.push(tab); return tab;
    };
    if (domain === "--help") return { exitCode: 0, stdout: "herdr --session NAME; headless server", stderr: "" };
    if (domain === "--version" || request.executable !== "herdr") return { exitCode: 0, stdout: "0.9.0", stderr: "" };
    if (domain === "api") return success({ protocol: 22, schema_version: 1 });
    if (domain === "status") return success({ session: name, running: session.running, protocol: 22, compatible: true });
    if (domain === "server") { session.running = true; return success({}); }
    if (domain === "session" && action === "stop") { this.session(target!).running = false; return success({ stopped: true }); }
    if (domain === "session" && action === "attach") return session.running ? success({}) : failure("Session stopped");
    if (!session.running) return failure("Session stopped");
    if (domain === "workspace" && action === "list") return wire("workspace_list", { workspaces: session.workspaces });
    if (domain === "workspace" && action === "create") {
      const id = `w${++this.next}`; const tab = newTab(id, "conversation"); const pane = newPane(tab);
      const workspace = { workspace_id: id, active_tab_id: tab.tab_id, label: flag("--label") };
      session.workspaces.push(workspace); return wire("workspace_created", { workspace, tab, root_pane: pane });
    }
    if (domain === "workspace" && action === "focus") return wire("workspace_info", { workspace: session.workspaces.find((w) => w.workspace_id === target) });
    if (domain === "tab" && action === "list") return wire("tab_list", { tabs: session.tabs.filter((t) => t.workspace_id === flag("--workspace")) });
    if (domain === "tab" && action === "create") {
      const tab = newTab(flag("--workspace"), flag("--label")); return wire("tab_created", { tab, root_pane: newPane(tab) });
    }
    if (domain === "tab" && action === "focus") return wire("tab_info", { tab: session.tabs.find((t) => t.tab_id === target) });
    if (domain === "pane" && action === "list") return wire("pane_list", { panes: session.panes.filter((p) => p.workspace_id === flag("--workspace")) });
    if (domain === "pane" && action === "get") {
      const pane = session.panes.find((p) => p.pane_id === target); return pane ? wire("pane_info", { pane }) : failure("Pane missing");
    }
    if (domain === "pane" && action === "process-info") return wire("pane_process_info", { process_info: {
      pane_id: flag("--pane"), shell_pid: 1000, foreground_process_group_id: 1000, foreground_processes: [] } });
    if (domain === "pane" && action === "split") {
      const source = session.panes.find((p) => p.pane_id === target)!;
      return wire("pane_info", { pane: newPane(session.tabs.find((t) => t.tab_id === source.tab_id)!) });
    }
    if (domain === "agent" && action === "list") return wire("agent_list", { agents: session.panes.filter((p) => p.agent !== null) });
    if (domain === "agent" && action === "start") {
      const pane = session.panes.find((p) => p.pane_id === flag("--pane"))!;
      if (session.panes.some((p) => p.name === target)) return failure("Duplicate agent start");
      Object.assign(pane, { agent: flag("--kind"), name: target, agent_status: target === this.blockedAgent ? "blocked" : "idle", interactive_ready: true });
      if (target === this.blockedAgent) return { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code: "agent_not_ready", message: `${target} blocked` } }) };
      return wire("agent_started", { agent: pane });
    }
    if (domain === "agent" && (action === "get" || action === "focus")) {
      const pane = session.panes.find((p) => p.pane_id === target || p.name === target);
      return pane ? wire("agent_info", { agent: pane }) : failure("Agent missing");
    }
    throw new Error(`Unexpected test process: ${request.executable} ${args.join(" ")}`);
  }
}
