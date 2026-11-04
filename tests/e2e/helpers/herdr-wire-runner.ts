import { environmentProcessRunner, type EnvironmentProcessRequest, type EnvironmentProcessResult, type EnvironmentProcessRunner } from "@bflow/cli";

/**
 * The shared Herdr wire fake used by both E16 (tests/e2e/scenarios/e16-group-f-lifecycle.e2e.test.ts) and the E16-D Director
 * lifecycle variant; it is the single source, not a copy. Answers the Herdr CLI protocol the EnvironmentLifecycle/Pane Manager uses
 * and records every call. Not a live Herdr transport.
 */
export interface WirePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  revision: number;
  agent: string | null;
  agent_status: string;
  name: string | null;
  interactive_ready: boolean;
  launch_pending: boolean;
  label?: string;
  agent_session?: { source: string; kind: string; value: string };
}

export interface WireTab {
  tab_id: string;
  workspace_id: string;
  label: string | undefined;
}

export interface WireWorkspace {
  workspace_id: string;
  active_tab_id: string;
  label: string | undefined;
}

export interface WireSession {
  running: boolean;
  workspaces: WireWorkspace[];
  tabs: WireTab[];
  panes: WirePane[];
  /** Foreground process started by `pane run` (the Director progress viewer), keyed by pane. */
  viewers: Map<string, { pid: number; argv: string[] }>;
}

/** Splits the single-quoted command line the progress pane sends to `pane run` back into argv. */
export function unquoteShellCommand(line: string): string[] {
  const argv: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) argv.push(match[1]!.replace(/'\\''/g, "'"));
  return argv;
}

export class HerdrWireRunner implements EnvironmentProcessRunner {
  calls: EnvironmentProcessRequest[] = [];
  sessions = new Map<string, WireSession>();
  next = 0;

  session(name: string): WireSession {
    let s = this.sessions.get(name);
    if (!s) {
      s = { running: false, workspaces: [], tabs: [], panes: [], viewers: new Map() };
      this.sessions.set(name, s);
    }
    return s;
  }

  async run(request: EnvironmentProcessRequest): Promise<EnvironmentProcessResult> {
    this.calls.push(request);
    if (request.executable === "git") return environmentProcessRunner.run(request);
    const args = request.args;
    const [domain, action, target] = args;
    const name = request.env?.["HERDR_SESSION"] ?? "inherited-default";
    const session = this.session(name);
    const flag = (key: string): string | undefined => {
      const idx = args.indexOf(key);
      return idx >= 0 ? args[idx + 1] : undefined;
    };
    const success = (value: unknown): EnvironmentProcessResult => ({
      exitCode: 0,
      stdout: JSON.stringify(value),
      stderr: ""
    });
    const wire = (type: string, data: Record<string, unknown>): EnvironmentProcessResult =>
      success({ id: "1", result: { type, ...data } });
    const failure = (message: string): EnvironmentProcessResult => ({
      exitCode: 1,
      stdout: "",
      stderr: JSON.stringify({ id: "1", error: { code: "invalid_target", message } })
    });
    const newPane = (tab: WireTab): WirePane => {
      const pane: WirePane = {
        pane_id: `p${++this.next}`,
        terminal_id: `term${this.next}`,
        workspace_id: tab.workspace_id,
        tab_id: tab.tab_id,
        revision: 1,
        agent: null,
        agent_status: "idle",
        name: null,
        interactive_ready: false,
        launch_pending: false
      };
      session.panes.push(pane);
      return pane;
    };
    const newTab = (workspaceId: string, label: string | undefined): WireTab => {
      const tab: WireTab = { tab_id: `t${++this.next}`, workspace_id: workspaceId, label };
      session.tabs.push(tab);
      return tab;
    };

    if (domain === "--help") return { exitCode: 0, stdout: "herdr --session NAME; headless server", stderr: "" };
    if (domain === "--version") return { exitCode: 0, stdout: "0.9.5", stderr: "" };
    if (request.executable === "claude" && args.join(" ") === "auth status --json") {
      return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
    }
    if (request.executable === "codex" && args.join(" ") === "login status") {
      return { exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" };
    }
    if (request.executable === "agy") {
      return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, blocked: false, status: "ready" }), stderr: "" };
    }
    if (request.executable !== "herdr") return { exitCode: 0, stdout: "1.0.0", stderr: "" };
    if (domain === "api") return success({ protocol: 22, schema_version: 1 });
    if (domain === "status") return success({ session: name, running: session.running, protocol: 22, compatible: true });
    if (domain === "server") {
      session.running = true;
      return { exitCode: 0, stdout: "{}", stderr: "", pid: process.pid };
    }
    if (domain === "session" && action === "stop" && target) {
      Object.assign(this.session(target), { running: false, workspaces: [], tabs: [], panes: [], viewers: new Map() });
      return success({ stopped: true });
    }
    if (domain === "session" && action === "attach") {
      return session.running ? success({}) : failure("Session stopped");
    }
    if (!session.running) return failure("Session stopped");
    if (domain === "workspace" && action === "list") return wire("workspace_list", { workspaces: session.workspaces });
    if (domain === "workspace" && action === "create") {
      const id = `w${++this.next}`;
      const tab = newTab(id, "conversation");
      const pane = newPane(tab);
      const workspace: WireWorkspace = { workspace_id: id, active_tab_id: tab.tab_id, label: flag("--label") };
      session.workspaces.push(workspace);
      return wire("workspace_created", { workspace, tab, root_pane: pane });
    }
    if (domain === "workspace" && action === "focus") {
      return wire("workspace_info", { workspace: session.workspaces.find((w) => w.workspace_id === target) });
    }
    if (domain === "tab" && action === "list") {
      return wire("tab_list", { tabs: session.tabs.filter((t) => t.workspace_id === flag("--workspace")) });
    }
    if (domain === "tab" && action === "create") {
      const tab = newTab(flag("--workspace") ?? "w1", flag("--label"));
      return wire("tab_created", { tab, root_pane: newPane(tab) });
    }
    if (domain === "tab" && action === "focus") {
      return wire("tab_info", { tab: session.tabs.find((t) => t.tab_id === target) });
    }
    if (domain === "tab" && action === "rename") {
      const tab = session.tabs.find((t) => t.tab_id === target);
      if (tab) tab.label = args[3];
      return wire("tab_info", { tab });
    }
    if (domain === "pane" && action === "rename") {
      const pane = session.panes.find((p) => p.pane_id === target);
      if (pane) Object.assign(pane, { label: args[3] });
      return wire("pane_info", { pane });
    }
    if (domain === "pane" && action === "read") {
      return { exitCode: 0, stderr: "", stdout: "Ready." };
    }
    if (domain === "pane" && action === "layout") {
      const pane = session.panes.find((p) => p.pane_id === flag("--pane"));
      if (!pane) return failure("Pane missing");
      return wire("pane_layout", {
        layout: {
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          panes: session.panes
            .filter((p) => p.tab_id === pane.tab_id)
            .map((p, i) => ({ pane_id: p.pane_id, rect: { x: i * 40, y: 0, width: 40, height: 40 } })),
          splits: []
        }
      });
    }
    if (domain === "pane" && action === "list") {
      return wire("pane_list", { panes: session.panes.filter((p) => p.workspace_id === flag("--workspace")) });
    }
    if (domain === "pane" && action === "close") {
      session.panes = session.panes.filter((pane) => pane.pane_id !== target);
      if (target) session.viewers.delete(target);
      return wire("ok", {});
    }
    if (domain === "pane" && action === "get") {
      const pane = session.panes.find((p) => p.pane_id === target);
      return pane ? wire("pane_info", { pane }) : failure("Pane missing");
    }
    if (domain === "pane" && action === "run" && target) {
      // Herdr acknowledges `pane run` with empty output; the pane's foreground group becomes the launched command.
      if (!session.panes.some((p) => p.pane_id === target)) return failure("Pane missing");
      session.viewers.set(target, { pid: 5000 + ++this.next, argv: unquoteShellCommand(args[3] ?? "") });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (domain === "pane" && action === "process-info") {
      const viewer = session.viewers.get(flag("--pane") ?? "");
      if (viewer) {
        return wire("pane_process_info", {
          process_info: {
            pane_id: flag("--pane"),
            shell_pid: 1000,
            foreground_process_group_id: viewer.pid,
            foreground_processes: [{ pid: viewer.pid, argv: viewer.argv }]
          }
        });
      }
      return wire("pane_process_info", {
        process_info: {
          pane_id: flag("--pane"),
          shell_pid: 1000,
          foreground_process_group_id: 1000,
          foreground_processes: []
        }
      });
    }
    if (domain === "pane" && action === "split") {
      const source = session.panes.find((p) => p.pane_id === target);
      const tab = source ? session.tabs.find((t) => t.tab_id === source.tab_id) : undefined;
      if (!tab) return failure("Tab missing");
      return wire("pane_info", { pane: newPane(tab) });
    }
    if (domain === "agent" && action === "list") {
      return wire("agent_list", { agents: session.panes.filter((p) => p.agent !== null) });
    }
    if (domain === "agent" && action === "start" && target) {
      const pane = session.panes.find((p) => p.pane_id === flag("--pane"));
      if (session.panes.some((p) => p.name === target)) return failure("Duplicate agent start");
      if (pane) {
        Object.assign(pane, {
          agent: flag("--kind") ?? "claude",
          name: target,
          agent_status: "idle",
          interactive_ready: true,
          agent_session: { source: "herdr:" + (flag("--kind") ?? "claude"), kind: "id", value: "native-" + target }
        });
      }
      return wire("agent_started", { agent: pane });
    }
    if (domain === "agent" && (action === "get" || action === "focus")) {
      const pane = session.panes.find((p) => p.pane_id === target || p.name === target);
      return pane ? wire("agent_info", { agent: pane }) : failure("Agent missing");
    }
    return success({});
  }
}
