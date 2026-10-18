import { environmentProcessRunner, type EnvironmentProcessRequest, type EnvironmentProcessRunner } from "../../src/environment-process.js";
import type { HerdrSocketPort } from "@bflow/pane-manager";

interface Pane {
  pane_id: string; terminal_id: string; workspace_id: string; tab_id: string; revision: number;
  agent: string | null; agent_status: string; name: string | null; interactive_ready: boolean; launch_pending: boolean;
  /** Env the pane's shell was created with (socket API only); never part of CLI wire output. */
  env?: Record<string, string>;
}
interface Tab { tab_id: string; workspace_id: string; label: string; }
interface Workspace { workspace_id: string; active_tab_id: string; label: string; }
interface Session { running: boolean; workspaces: Workspace[]; tabs: Tab[]; panes: Pane[]; }

/** Stateful wire fixture. Production P13 parses every response and makes every topology decision. */
export class HerdrProcesses implements EnvironmentProcessRunner {
  readonly calls: EnvironmentProcessRequest[] = [];
  readonly socketCalls: { method: string; params: Record<string, unknown> }[] = [];
  readonly sessions = new Map<string, Session>();
  blockedAgent: string | undefined;
  private next = 0;
  session(name: string): Session {
    let session = this.sessions.get(name);
    if (!session) { session = { running: false, workspaces: [], tabs: [], panes: [] }; this.sessions.set(name, session); }
    return session;
  }
  /** Socket API port over the same state: creation methods mirror the CLI and record the pane env. */
  socket(sessionName: string): HerdrSocketPort {
    return { request: async (method, params) => {
      this.socketCalls.push({ method, params });
      const p = params as Record<string, string | undefined> & { env?: Record<string, string> };
      const args = method === "workspace.create" ? ["workspace", "create", "--cwd", p.cwd!, "--label", p.label!, "--no-focus"]
        : method === "tab.create" ? ["tab", "create", "--workspace", p.workspace_id!, "--cwd", p.cwd!, "--label", p.label!, "--no-focus"]
        : method === "pane.split" ? ["pane", "split", p.target_pane_id!, "--direction", p.direction!, "--cwd", p.cwd ?? "", "--no-focus"] : undefined;
      if (!args) return { ok: false, error: { code: "validation", retryable: false, message: `unsupported socket method ${method}` } };
      const outcome = await this.handle({ executable: "herdr", args, env: { HERDR_SESSION: sessionName } });
      if (outcome.exitCode !== 0) return { ok: false, error: { code: "validation", retryable: false, message: `${method} failed` } };
      const result = (JSON.parse(outcome.stdout) as { result: Record<string, { pane_id?: string }> }).result;
      const created = result["root_pane"] ?? result["pane"];
      const pane = this.session(sessionName).panes.find(item => item.pane_id === created?.pane_id);
      if (pane && p.env) pane.env = { ...p.env };
      return { ok: true, value: result };
    } };
  }
  async run(request: EnvironmentProcessRequest) {
    this.calls.push(request);
    return this.handle(request);
  }
  private async handle(request: EnvironmentProcessRequest) {
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
    if (domain === "tab" && action === "rename") {
      const tab = session.tabs.find(t => t.tab_id === target)!; tab.label = args[3]!; return wire("tab_info", {tab});
    }
    if (domain === "pane" && action === "rename") {
      const pane = session.panes.find(p => p.pane_id === target)!; Object.assign(pane, {label:args[3]}); return wire("pane_info", {pane});
    }
    if (domain === "pane" && action === "read") return {exitCode:0,stderr:"",stdout:"Update CLI? A new Codex version is available."};
    if (domain === "pane" && action === "layout") {
      const pane = session.panes.find(p=>p.pane_id === flag("--pane"))!;
      return wire("pane_layout", {layout:{workspace_id:pane.workspace_id,tab_id:pane.tab_id,
        panes:session.panes.filter(p=>p.tab_id===pane.tab_id).map((p,i)=>({pane_id:p.pane_id,rect:{x:i*40,y:0,width:40,height:40}})),splits:[]}});
    }
    if (domain === "pane" && action === "list") return wire("pane_list", { panes: session.panes.filter((p) => p.workspace_id === flag("--workspace")) });
    if (domain === "pane" && action === "close") {
      session.panes = session.panes.filter(pane => pane.pane_id !== target);
      return wire("ok", {});
    }
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
      Object.assign(pane, { agent: flag("--kind"), name: target, agent_status: target === this.blockedAgent ? "blocked" : "idle", interactive_ready: true, agent_session: {source:"herdr:"+flag("--kind"),kind:"id",value:"native-"+target} });
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
