import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationResult, ResolvedRoleProfileSnapshot } from "@bflow/contracts";
import { ROLE_PROFILE_FEATURE, pinRoleProfile } from "@bflow/contracts";
import { InMemorySessionManifestStore } from "../src/manifest-store.js";
import { buildProviderRoleLaunch } from "../src/provider-launch.js";
import { createRolePaneManager } from "../src/role-pane-manager.js";
import { readBuiltinRolePrompt } from "../src/role-prompts.js";
import { createProcessRunner, mapCommandFailure, parseOkResponse } from "../src/runner.js";
import type {
  AgentLaunchProfile,
  CommandInvocation,
  CommandOutcome,
  HerdrCommandRunner,
  HerdrSocketPort,
  RolePaneManagerConfig,
  WorktreeInspector
} from "../src/types.js";

type Json = Record<string, unknown>;

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
    }
  >();
  onCommand?: (invocation: CommandInvocation) => Promise<CommandOutcome | undefined> | CommandOutcome | undefined;
  #seq = 0;

  readonly socket: HerdrSocketPort = {
    request: async (method, params): Promise<OperationResult<unknown>> => {
      if (method === "workspace.create") {
        return { ok: true, value: this.createWorkspace(String(params["cwd"]), String(params["label"])) };
      }
      if (method === "tab.create") {
        return {
          ok: true,
          value: this.createTab(String(params["workspace_id"]), String(params["cwd"]), String(params["label"]))
        };
      }
      if (method === "pane.split") {
        const targetId = String(params["target_pane_id"]);
        const source = this.panes.get(targetId);
        if (!source) {
          return { ok: false, error: { code: "not_found", retryable: false, message: "pane_not_found" } };
        }
        const cwd = typeof params["cwd"] === "string" ? params["cwd"] : source.cwd;
        const pane = this.split(targetId, cwd);
        return { ok: true, value: { type: "pane_info", pane: this.paneJson(pane.id) } };
      }
      return { ok: false, error: { code: "validation", retryable: false, message: `unsupported ${method}` } };
    }
  };

  #id(prefix: string): string {
    return `${prefix}-${++this.#seq}`;
  }

  #newPane(tabId: string, wsId: string, cwd: string): string {
    const id = this.#id("pane");
    this.panes.set(id, { id, tabId, wsId, agent: null, cwd });
    return id;
  }

  createWorkspace(cwd: string, label: string): Json {
    const wsId = this.#id("ws");
    const tabId = this.#id("tab");
    this.workspaces.set(wsId, { id: wsId, label, activeTabId: tabId });
    this.tabs.set(tabId, { id: tabId, wsId, label: "1" });
    const paneId = this.#newPane(tabId, wsId, cwd);
    return {
      type: "workspace_created",
      workspace: this.workspaceJson(wsId),
      tab: this.tabJson(tabId),
      root_pane: this.paneJson(paneId)
    };
  }

  createTab(wsId: string, cwd: string, label: string): Json {
    const tabId = this.#id("tab");
    this.tabs.set(tabId, { id: tabId, wsId, label });
    const paneId = this.#newPane(tabId, wsId, cwd);
    return { type: "tab_created", tab: this.tabJson(tabId), root_pane: this.paneJson(paneId) };
  }

  split(sourcePaneId: string, cwd: string) {
    const source = this.panes.get(sourcePaneId)!;
    const id = this.#newPane(source.tabId, source.wsId, cwd);
    return this.panes.get(id)!;
  }

  workspaceJson(id: string): Json {
    const ws = this.workspaces.get(id)!;
    return {
      workspace_id: id,
      label: ws.label,
      active_tab_id: ws.activeTabId,
      focused: false,
      pane_count: [...this.panes.values()].filter(p => p.wsId === id).length,
      tab_count: [...this.tabs.values()].filter(t => t.wsId === id).length,
      agent_status: "idle"
    };
  }

  tabJson(id: string): Json {
    const tab = this.tabs.get(id)!;
    return {
      tab_id: id,
      workspace_id: tab.wsId,
      label: tab.label,
      focused: false,
      pane_count: [...this.panes.values()].filter(p => p.tabId === id).length,
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
      return this.reply(this.createWorkspace(flag(rest, "--cwd") ?? ROOT, flag(rest, "--label") ?? "demo"));
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
      return this.reply(this.createTab(flag(rest, "--workspace")!, flag(rest, "--cwd") ?? ROOT, flag(rest, "--label") ?? "tab"));
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
    if (domain === "pane" && (action === "get" || action === "focus" || action === "rename")) {
      return this.panes.has(rest[0]!) ? this.reply({ type: "pane_info", pane: this.paneJson(rest[0]!) }) : this.fail("pane_not_found");
    }
    if (domain === "pane" && action === "split") {
      const source = this.panes.get(rest[0]!);
      if (!source) return this.fail("pane_not_found");
      const pane = this.split(rest[0]!, flag(rest, "--cwd") ?? source.cwd);
      return this.reply({ type: "pane_info", pane: this.paneJson(pane.id) });
    }
    if (domain === "pane" && action === "close") {
      const id = rest[0]!;
      if (!this.panes.has(id)) return this.fail("pane_not_found");
      this.panes.delete(id);
      for (const [name, agent] of this.agents) {
        if (agent.paneId === id) this.agents.delete(name);
      }
      return this.reply({ type: "ok" });
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
    if (domain === "worktree" && (action === "create" || action === "open")) {
      const path = flag(rest, "--path") ?? "/repo/.worktrees/wt";
      const label = flag(rest, "--label") ?? "dev";
      const created = this.createWorkspace(path, label);
      return this.reply({
        type: action === "create" ? "worktree_created" : "worktree_opened",
        workspace: created["workspace"],
        tab: created["tab"],
        root_pane: created["root_pane"],
        worktree: {
          path,
          label,
          branch: flag(rest, "--branch") ?? null,
          is_linked_worktree: true,
          is_detached: false,
          is_bare: false,
          is_prunable: false,
          open_workspace_id: (created["workspace"] as Json)["workspace_id"]
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
    return this.fail("unsupported_command", invocation.args.join(" "));
  }
}

function makeProfileSnapshot(
  profileId: string,
  baseRole: "reviewer" | "developer"
): ResolvedRoleProfileSnapshot {
  const definition = {
    schemaVersion: 3 as const,
    profileId,
    version: "1.0.0",
    displayName: `${profileId} display`,
    baseRole,
    additionalInstructions: "Follow scoped domain rules.",
    skillPins: [],
    toolRequirements: [],
    restrictions: {}
  };
  return {
    schemaVersion: 3,
    pin: pinRoleProfile(definition),
    definition,
    baseRolePolicyDigest: "a".repeat(64),
    resolutionPolicyVersion: ROLE_PROFILE_FEATURE
  };
}

function makeProfileLaunch(
  launchId: string,
  snapshot: ResolvedRoleProfileSnapshot,
  promptSource: string
): AgentLaunchProfile {
  return {
    provider: "claude",
    launchId,
    launchFingerprint: `fp-${launchId}`,
    env: { BFLOW_LAUNCH_ID: launchId },
    argv: ["--append-system-prompt-file", promptSource],
    roleProfile: snapshot.pin,
    features: [ROLE_PROFILE_FEATURE]
  };
}

describe("Flow-04 pane-manager runner hardening and dynamic profile rollback/recovery", () => {
  it("injects Codex startup_timeout_sec=120 and tool_timeout_sec=600 in buildProviderRoleLaunch and strips them from Claude --mcp-config", () => {
    const codexArgs = buildProviderRoleLaunch({
      agentKind: "codex",
      role: "developer",
      systemPrompt: "Implement feature.",
      mcpServers: {
        bflow: { command: "/usr/bin/node", args: ["host.js"] },
        slowSvc: {
          command: "/usr/bin/node",
          args: ["slow.js"],
          startup_timeout_sec: 240,
          tool_timeout_sec: 900
        }
      }
    });
    const mcpArg = codexArgs.find(arg => arg.startsWith("mcp_servers="));
    expect(mcpArg).toBeDefined();
    expect(mcpArg).toContain('"startup_timeout_sec"=120,"tool_timeout_sec"=600');
    expect(mcpArg).toContain('"startup_timeout_sec"=240,"tool_timeout_sec"=900');

    const claudeArgs = buildProviderRoleLaunch({
      agentKind: "claude",
      role: "developer",
      systemPrompt: "Implement feature.",
      mcpServers: {
        bflow: {
          command: "/usr/bin/node",
          args: ["host.js"],
          startup_timeout_sec: 120,
          tool_timeout_sec: 600
        }
      }
    });
    const claudeMcpJson = claudeArgs[claudeArgs.indexOf("--mcp-config") + 1]!;
    expect(JSON.parse(claudeMcpJson)).toEqual({
      mcpServers: {
        bflow: {
          command: "/usr/bin/node",
          args: ["host.js"]
        }
      }
    });
  });

  it("createProcessRunner preserves split multi-byte UTF-8 chunks, bounds orphaned grandchild pipe drain, and classifies E2BIG as invalid_arguments", async () => {
    const nodeRunner = createProcessRunner(process.execPath);

    // 1. Split 4-byte UTF-8 sequence across separate writes
    const splitOutcome = await nodeRunner.run({
      args: [
        "-e",
        `
        const buf = Buffer.from("Xin chào 🚀 Việt Nam", "utf8");
        process.stdout.write(buf.subarray(0, 10));
        setTimeout(() => {
          process.stdout.write(buf.subarray(10, 12));
          setTimeout(() => process.stdout.write(buf.subarray(12)), 10);
        }, 10);
        `
      ],
      timeoutMs: 5_000
    });
    expect(splitOutcome.exitCode).toBe(0);
    expect(splitOutcome.stdout).toBe("Xin chào 🚀 Việt Nam");

    // 2. Orphaned grandchild inherits stdout FD and sleeps 15s while child exits immediately -> settles within <500ms!
    const startedAt = Date.now();
    const drainOutcome = await nodeRunner.run({
      args: [
        "-e",
        `
        const { spawn } = require("node:child_process");
        const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
          detached: true,
          stdio: ["ignore", process.stdout, process.stderr]
        });
        orphan.unref();
        process.stdout.write('{"id":"1","result":{"type":"ok"}}');
        process.exit(0);
        `
      ],
      timeoutMs: 10_000
    });
    const elapsedMs = Date.now() - startedAt;
    expect(drainOutcome.exitCode).toBe(0);
    expect(drainOutcome.failure).toBeUndefined();
    expect(elapsedMs).toBeLessThan(800);
    expect(() => parseOkResponse(drainOutcome)).not.toThrow();

    // 3. Pre-exec E2BIG (oversized argv) maps to invalid_arguments / validation with started: false
    const hugeArg = "x".repeat(3 * 1024 * 1024);
    const e2bigOutcome = await nodeRunner.run({
      args: ["-e", "process.exit(0)", hugeArg],
      timeoutMs: 5_000
    });
    expect(e2bigOutcome.started).toBe(false);
    expect(e2bigOutcome.failure).toBe("invalid_arguments");
    expect(mapCommandFailure(e2bigOutcome)?.code).toBe("validation");
  });

  it("mapCommandFailure & parseOkResponse tolerate CLI warning noise around single JSON envelopes and classify extended not_found / plain-text errors while rejecting arbitrary garbage", () => {
    expect(() =>
      parseOkResponse({
        exitCode: 0,
        stdout: 'WARN herdr_cli: experimental flag\n{"id":"1","result":{"type":"ok"}}\n',
        stderr: "",
        started: true
      })
    ).not.toThrow();

    expect(
      mapCommandFailure({
        exitCode: 1,
        stdout: "",
        stderr: 'WARN herdr_cli: fallback\n{"id":"1","error":{"code":"target_not_found","message":"target %99 not found"}}\n',
        started: true
      })
    ).toMatchObject({ code: "not_found", retryable: false });

    expect(
      mapCommandFailure({
        exitCode: 1,
        stdout: '{"id":"1","error":{"code":"session_not_found","message":"session gone"}}',
        stderr: "",
        started: true
      })
    ).toMatchObject({ code: "not_found", retryable: false });

    expect(
      mapCommandFailure({
        exitCode: 1,
        stdout: "",
        stderr: "Error: pane %404 not found",
        started: true
      })
    ).toMatchObject({ code: "not_found", retryable: false });

    expect(
      mapCommandFailure({
        exitCode: 1,
        stdout: "",
        stderr: "Error: failed to connect to herdr socket: ECONNREFUSED",
        started: true
      })
    ).toMatchObject({ code: "transport_unavailable", retryable: true });

    expect(
      mapCommandFailure({
        exitCode: 1,
        stdout: "",
        stderr: "not-json",
        started: true
      })
    ).toMatchObject({ code: "corruption", retryable: false });
  });

  it("recovers profiled specialist and profiled Developer allocations cleanly after pre-run start failures or vanished panes without leaking panes or deadlocking capacity", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow04-panes-")));
    roots.push(dir);
    const herdr = new FakeHerdr();
    const store = new InMemorySessionManifestStore();
    const inspector: WorktreeInspector = {
      inspect: async () => ({ ok: true, value: { exists: false, isClean: true, dirtyFiles: [] } })
    };
    function makeBaseLaunch(launchId: string, promptSource: string): AgentLaunchProfile {
      return {
        provider: "claude",
        launchId,
        launchFingerprint: `fp-${launchId}`,
        env: { BFLOW_LAUNCH_ID: launchId },
        argv: ["--append-system-prompt-file", promptSource]
      };
    }
    const config: RolePaneManagerConfig = {
      sessionId: "sess-flow04",
      projectName: "flow04",
      workspaceRoot: ROOT,
      defaultProvider: "claude",
      defaultAgentKind: "claude",
      maxDeveloperCapacity: 2,
      permanentRoles: ["chat", "coordinator", "reviewer"],
      roleConfigs: {
        chat: { agentKind: "claude", launch: makeBaseLaunch("launch-chat", chatPromptSource) },
        coordinator: { agentKind: "claude", launch: makeBaseLaunch("launch-coord", coordinatorPromptSource) },
        reviewer: { agentKind: "claude", launch: makeBaseLaunch("launch-rev", reviewerPromptSource) }
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
    if (!init.ok) {
      throw new Error(`initializeTopology failed: ${JSON.stringify(init.error)}`);
    }
    expect(init.ok).toBe(true);
    const baselinePanes = [...herdr.panes.keys()];

    // 1. Profiled specialist fails on Herdr `agent start` before running (pane.agent remains null):
    //    rolls back launchIntent, closes split pane immediately, and allows retry with a new launchId!
    const reviewerProfile = makeProfileSnapshot("sec-reviewer", "reviewer");
    let failNextStart = true;
    herdr.onCommand = async invocation => {
      if (failNextStart && invocation.args[0] === "agent" && invocation.args[1] === "start") {
        failNextStart = false;
        return herdr.fail("invalid_arguments", "unrecognized CLI flag");
      }
      return undefined;
    };

    const firstSpec = await manager.allocateSpecialist({
      role: "reviewer",
      taskId: "review-task-1",
      roleProfile: reviewerProfile,
      launch: makeProfileLaunch("launch-spec-1", reviewerProfile, reviewerPromptSource)
    });
    expect(firstSpec.ok).toBe(false);
    expect([...herdr.panes.keys()]).toEqual(baselinePanes);

    const retrySpec = await manager.allocateSpecialist({
      role: "reviewer",
      taskId: "review-task-1",
      roleProfile: reviewerProfile,
      launch: makeProfileLaunch("launch-spec-2", reviewerProfile, reviewerPromptSource)
    });
    expect(retrySpec.ok).toBe(true);
    if (!retrySpec.ok) return;

    // 2. If the active profiled specialist pane vanishes (e.g. closed in an earlier host generation),
    //    subsequent specialist allocation prunes it instead of deadlocking capacity!
    herdr.panes.delete(retrySpec.value.paneId);
    for (const [name, agent] of herdr.agents) {
      if (agent.paneId === retrySpec.value.paneId) herdr.agents.delete(name);
    }

    const nextSpec = await manager.allocateSpecialist({
      role: "reviewer",
      taskId: "review-task-2",
      roleProfile: reviewerProfile,
      launch: makeProfileLaunch("launch-spec-3", reviewerProfile, reviewerPromptSource)
    });
    expect(nextSpec.ok).toBe(true);
    if (nextSpec.ok) {
      expect((await manager.releaseSpecialist({ taskId: "review-task-2" })).ok).toBe(true);
    }

    // 3. Profiled Developer fails on `agent start` (pane.agent remains null) -> closes split pane and allows retry with new launchId!
    const devProfile = makeProfileSnapshot("backend-dev", "developer");
    failNextStart = true;
    const failedDev = await manager.allocateDeveloper({
      taskId: "dev-task-1",
      worktreePath: "/repo/.worktrees/dev-task-1",
      roleProfile: devProfile,
      launch: makeProfileLaunch("launch-dev-1", devProfile, developerPromptSource)
    });
    expect(failedDev.ok).toBe(false);
    expect([...herdr.panes.keys()]).toEqual(baselinePanes);

    const retryDev = await manager.allocateDeveloper({
      taskId: "dev-task-1",
      worktreePath: "/repo/.worktrees/dev-task-1",
      roleProfile: devProfile,
      launch: makeProfileLaunch("launch-dev-2", devProfile, developerPromptSource)
    });
    expect(retryDev.ok).toBe(true);
    if (!retryDev.ok) return;

    // 4. If the profiled Developer pane vanishes, reallocating the same task + profile with a new launchId prunes the dead entry and succeeds!
    herdr.panes.delete(retryDev.value.paneId);
    for (const [name, agent] of herdr.agents) {
      if (agent.paneId === retryDev.value.paneId) herdr.agents.delete(name);
    }
    const reallocatedDev = await manager.allocateDeveloper({
      taskId: "dev-task-1",
      worktreePath: "/repo/.worktrees/dev-task-1",
      roleProfile: devProfile,
      launch: makeProfileLaunch("launch-dev-3", devProfile, developerPromptSource)
    });
    expect(reallocatedDev.ok).toBe(true);

    // 5. Conversely, an uncertain timeout during `agent start` MUST retain launchIntent in the manifest!
    herdr.onCommand = async invocation => {
      if (invocation.args[0] === "agent" && invocation.args[1] === "start") {
        return {
          exitCode: null,
          stdout: "",
          stderr: "",
          failure: "timeout",
          started: true,
          cause: "timed out waiting for agent start"
        };
      }
      return undefined;
    };
    const uncertainSpec = await manager.allocateSpecialist({
      role: "reviewer",
      taskId: "review-uncertain",
      roleProfile: reviewerProfile,
      launch: makeProfileLaunch("launch-spec-timeout", reviewerProfile, reviewerPromptSource)
    });
    expect(uncertainSpec.ok).toBe(false);
    const afterTimeoutManifest = await store.load(config.sessionId);
    expect(
      afterTimeoutManifest.ok &&
        afterTimeoutManifest.value?.panes.some(
          p => p.metadata?.["taskId"] === "review-uncertain" && p.metadata?.["launchIntent"] === true
        )
    ).toBe(true);
  });
});
