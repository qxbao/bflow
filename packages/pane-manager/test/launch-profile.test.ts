import { describe, it, expect, vi } from "vitest";
import type { OperationResult } from "@bflow/contracts";
import {
  type AgentLaunchProfile,
  type CommandInvocation,
  type CommandOutcome,
  type HerdrCommandRunner,
  type LaunchObservation,
  type RoleHealthReport,
  type WorktreeInspector
} from "../src/types.js";
import { createRolePaneManager } from "../src/role-pane-manager.js";
import { InMemorySessionManifestStore } from "../src/manifest-store.js";

const PANE_ID = "pane-1";
const ENV_VALUE = "launch-env-value-9f2";

/** Minimal Herdr fake covering only the calls startAgentInPane makes for one free shell pane. */
class LaunchFakeRunner implements HerdrCommandRunner {
  readonly calls: CommandInvocation[] = [];
  started = false;

  async run(invocation: CommandInvocation): Promise<CommandOutcome> {
    this.calls.push(invocation);
    const [domain, action, ...rest] = invocation.args;
    const reply = (result: Record<string, unknown>): CommandOutcome => ({
      exitCode: 0,
      stdout: JSON.stringify({ id: "1", result }),
      stderr: ""
    });
    const paneJson = {
      pane_id: PANE_ID,
      terminal_id: "term-1",
      workspace_id: "ws-1",
      tab_id: "tab-1",
      focused: false,
      agent: this.started ? "claude" : null,
      agent_status: "idle",
      revision: 1
    };
    if (domain === "agent" && action === "list") return reply({ type: "agent_list", agents: [] });
    if (domain === "pane" && action === "get") return reply({ type: "pane_info", pane: paneJson });
    if (domain === "pane" && action === "rename") return reply({ type: "pane_info", pane: paneJson });
    if (domain === "pane" && action === "process-info") {
      return reply({
        type: "pane_process_info",
        process_info: {
          pane_id: PANE_ID,
          shell_pid: 1234,
          foreground_process_group_id: 1234,
          foreground_processes: []
        }
      });
    }
    if (domain === "agent" && action === "start") {
      this.started = true;
      const nameArg = rest[0]!;
      const kind = rest[rest.indexOf("--kind") + 1]!;
      return reply({
        type: "agent_started",
        agent: {
          name: nameArg,
          agent: kind,
          pane_id: PANE_ID,
          terminal_id: "term-1",
          workspace_id: "ws-1",
          tab_id: "tab-1",
          focused: false,
          agent_status: "idle",
          revision: 1,
          interactive_ready: true,
          launch_pending: false
        }
      });
    }
    return { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code: "unexpected", message: `${action}` } }) };
  }

  startCalls(): CommandInvocation[] {
    return this.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "start");
  }
}

const stubInspector = {
  inspect: async () => ({ ok: true, value: { exists: false, isClean: true, dirtyFiles: [] } })
} as unknown as WorktreeInspector;

const config = {
  sessionId: "sess-launch-1",
  projectName: "launch-project",
  workspaceRoot: "/test/launch-workspace",
  conversationSessionId: "conv-launch-1",
  maxDeveloperCapacity: 2
};

function makeLaunch(overrides: Partial<AgentLaunchProfile> = {}): AgentLaunchProfile {
  return {
    argv: ["--model", "sonnet-test"],
    env: { BFLOW_LAUNCH_TOKEN_REF: ENV_VALUE },
    launchId: "launch-claude-1",
    launchFingerprint: "sha256-fingerprint-abc123",
    provider: "claude",
    ...overrides
  };
}

function makeManager(runner: HerdrCommandRunner) {
  return createRolePaneManager({
    config,
    runner,
    store: new InMemorySessionManifestStore(),
    worktreeInspector: stubInspector
  });
}

function startRequest(launch?: AgentLaunchProfile, extra: Record<string, unknown> = {}) {
  return {
    role: "developer" as const,
    paneId: PANE_ID,
    workspaceId: "ws-1",
    tabId: "tab-1",
    cwd: "/test/launch-workspace",
    agentName: "dev-launch",
    agentKind: "claude",
    ...(launch !== undefined ? { launch } : {}),
    ...extra
  };
}

describe("provider launch profile on role start", () => {
  it("starts with --kind <provider> and a -- separator; launch env is never passed to agent start", async () => {
    const runner = new LaunchFakeRunner();
    const manager = makeManager(runner);
    const result = await manager.startAgentInPane(startRequest(makeLaunch(), { timeoutMs: 5000 }));

    expect(result.ok).toBe(true);
    const [start] = runner.startCalls();
    expect(start!.args).toEqual([
      "agent", "start", "dev-launch", "--kind", "claude", "--pane", PANE_ID,
      "--timeout", "5000", "--", "--model", "sonnet-test"
    ]);
    // `agent start` types into the existing shell; env given here never reaches the provider.
    expect(start!.env).toBeUndefined();
    for (const call of runner.calls) {
      expect(call.env).toBeUndefined();
    }
    expect(JSON.stringify(runner.calls)).not.toContain(ENV_VALUE);
  });

  it("records launchId and launchFingerprint in binding metadata without env values", async () => {
    const runner = new LaunchFakeRunner();
    const manager = makeManager(runner);
    const result = await manager.startAgentInPane(startRequest(makeLaunch()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata).toMatchObject({
      launchId: "launch-claude-1",
      launchFingerprint: "sha256-fingerprint-abc123"
    });
    expect(result.value.provider).toBe("claude");
    expect(JSON.stringify(result.value)).not.toContain(ENV_VALUE);
    expect(JSON.stringify(result.value)).not.toContain("BFLOW_LAUNCH_TOKEN_REF");
  });

  it("rejects secret-looking argv with a validation error and no Herdr call", async () => {
    const secrets = ["sk-abcdefghijklmnop", "Bearer abc.def", "ghp_abcdefghijk", "AIzaSyD1234567890", "secret://vault/key"];
    for (const secret of secrets) {
      const runner = new LaunchFakeRunner();
      const manager = makeManager(runner);
      const result = await manager.startAgentInPane(startRequest(makeLaunch({ argv: ["--key", secret] })));
      expect(result.ok, secret).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("validation");
      expect(runner.calls, secret).toHaveLength(0);
    }
  });

  it("rejects argv items containing NUL or newline characters", async () => {
    const runner = new LaunchFakeRunner();
    const manager = makeManager(runner);
    const result = await manager.startAgentInPane(startRequest(makeLaunch({ argv: ["line\nbreak"] })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects invalid env keys before any Herdr call", async () => {
    for (const key of ["lower_case", "BAD-KEY", "1LEADING_DIGIT"]) {
      const runner = new LaunchFakeRunner();
      const manager = makeManager(runner);
      const result = await manager.startAgentInPane(startRequest(makeLaunch({ env: { [key]: "x" } })));
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("validation");
      expect(runner.calls, key).toHaveLength(0);
    }
  });

  it("rejects a launch provider that differs from the configured agent kind", async () => {
    const runner = new LaunchFakeRunner();
    const manager = makeManager(runner);
    const result = await manager.startAgentInPane(startRequest(makeLaunch({ provider: "codex" })));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.message).toMatch(/does not match/);
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("keeps the legacy args path byte-for-byte unchanged when no launch is set", async () => {
    const runner = new LaunchFakeRunner();
    const manager = makeManager(runner);
    const result = await manager.startAgentInPane(
      startRequest(undefined, { agentName: "dev-legacy", agentKind: "codex", args: ["--flag"], timeoutMs: 5000 })
    );

    expect(result.ok).toBe(true);
    const [start] = runner.startCalls();
    expect(start!.args).toEqual([
      "agent", "start", "dev-legacy", "--kind", "codex", "--pane", PANE_ID,
      "--timeout", "5000", "--", "--flag"
    ]);
    expect(start!.env).toBeUndefined();
    if (result.ok) expect(result.value.metadata).not.toHaveProperty("launchId");
  });
});

describe("inspectLaunchObservation", () => {
  function report(transportState: RoleHealthReport["transportState"], extra: Partial<RoleHealthReport> = {}): RoleHealthReport {
    return {
      bindingId: "binding-developer-pane-1",
      topologyRole: "developer",
      contractRole: "developer",
      agentId: "dev-launch",
      paneId: PANE_ID,
      workspaceId: "ws-1",
      tabId: "tab-1",
      status: "ready",
      transportState,
      readyForPrompt: transportState === "idle",
      paneExists: true,
      occupantMatches: true,
      observedAgent: {
        paneId: PANE_ID,
        terminalId: "term-1",
        workspaceId: "ws-1",
        tabId: "tab-1",
        focused: false,
        agent: "claude",
        name: "dev-launch",
        agentStatus: transportState,
        revision: 1,
        interactiveReady: true,
        launchPending: false
      },
      ...extra
    } as unknown as RoleHealthReport;
  }

  async function observe(transportState: RoleHealthReport["transportState"], extra: Partial<RoleHealthReport> = {}) {
    const manager = makeManager(new LaunchFakeRunner());
    const spy = vi.spyOn(manager, "inspectRoleHealth").mockResolvedValue({ ok: true, value: report(transportState, extra) });
    const result: OperationResult<LaunchObservation> = await manager.inspectLaunchObservation("dev-launch");
    expect(spy).toHaveBeenCalledWith("dev-launch", undefined);
    return result;
  }

  it("reports idle and working as interactive ready", async () => {
    for (const state of ["idle", "working"] as const) {
      const result = await observe(state);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject({ paneId: PANE_ID, agentName: "dev-launch", transportState: state, interactiveReady: true });
      }
    }
  });

  it("reports done only as transport state, still interactive-ready but never as success", async () => {
    const result = await observe("done");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.transportState).toBe("done");
      expect(Object.keys(result.value)).not.toContain("success");
      expect(Object.keys(result.value)).not.toContain("taskSucceeded");
    }
  });

  it("reports blocked and disconnected as not interactive ready", async () => {
    for (const state of ["blocked", "disconnected", "starting", "unknown"] as const) {
      const result = await observe(state);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.transportState).toBe(state);
        expect(result.value.interactiveReady).toBe(false);
      }
    }
  });

  it("is not interactive ready while launch is pending or Herdr marks interactive_ready false", async () => {
    const pending = await observe("idle", {
      observedAgent: { ...report("idle").observedAgent!, launchPending: true }
    });
    expect(pending.ok && pending.value.interactiveReady).toBe(false);
    expect(pending.ok && pending.value.launchPending).toBe(true);

    const notReady = await observe("idle", {
      observedAgent: { ...report("idle").observedAgent!, interactiveReady: false }
    });
    expect(notReady.ok && notReady.value.interactiveReady).toBe(false);
  });

  it("exposes the native session locator when Herdr reports one", async () => {
    const result = await observe("idle", {
      observedAgent: {
        ...report("idle").observedAgent!,
        session: { source: "claude", kind: "id", value: "session-abc" }
      } as RoleHealthReport["observedAgent"]
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nativeSession).toEqual({ source: "claude", kind: "id", value: "session-abc" });
    }
  });

  it("propagates inspection failures from the health path", async () => {
    const manager = makeManager(new LaunchFakeRunner());
    vi.spyOn(manager, "inspectRoleHealth").mockResolvedValue({
      ok: false,
      error: { code: "not_found", retryable: false, message: "Role binding not found" }
    });
    const result = await manager.inspectLaunchObservation("developer");
    expect(result.ok).toBe(false);
  });
});
