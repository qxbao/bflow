import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FileAgentRegistry } from "@bflow/agent-registry";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import {
  EnvironmentLifecycle,
  environmentProcessRunner,
  identifyRepository,
  namedSessionEnvironment,
  openPaneManagerEnvironment,
  readEnvironmentConfig,
  runCli,
  type EnvironmentProcessRequest,
  type EnvironmentProcessResult,
  type EnvironmentProcessRunner
} from "@bflow/cli";
import {
  AgentResultSchema,
  CreateCheckpointCommandSchema,
  RoleMessageSchema,
  VerificationResultSchema,
  WorkflowAggregateCheckpointStateSchema,
  type AgentExecutionHandle,
  type AgentRequest,
  type AgentTransport,
  type ApprovalDecision,
  type CreateCheckpointCommand,
  type PaneBinding,
  type QualityGate,
  type QualityGateDefinition,
  type RecoveryCheckpoint,
  type RoleMessage,
  type SessionManifest,
  type Specification,
  type WorkflowDefinition
} from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { openSqliteRunStore } from "@bflow/persistence";
import {
  AgenticWorkflowRuntime,
  createAgenticConversationHost,
  loadAgenticPolicies,
  type PanePolicy
} from "@bflow/runtime";
import { PolicyDetailsSchema, classifyChange, type ChangeAssessment } from "@bflow/specification";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const unwrap = <T>(r: { ok: boolean; value?: T; error?: { message?: string } }): T => {
  if (!r.ok) throw new Error(r.error?.message ?? JSON.stringify(r.error));
  return r.value as T;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "QA Tester",
      GIT_AUTHOR_EMAIL: "qa@bflow.local",
      GIT_COMMITTER_NAME: "QA Tester",
      GIT_COMMITTER_EMAIL: "qa@bflow.local"
    }
  }).trim();

function hasHerdr(): boolean {
  try {
    execFileSync("herdr", ["--version"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

interface WirePane {
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

interface WireTab {
  tab_id: string;
  workspace_id: string;
  label: string | undefined;
}

interface WireWorkspace {
  workspace_id: string;
  active_tab_id: string;
  label: string | undefined;
}

interface WireSession {
  running: boolean;
  workspaces: WireWorkspace[];
  tabs: WireTab[];
  panes: WirePane[];
}

class HerdrWireRunner implements EnvironmentProcessRunner {
  calls: EnvironmentProcessRequest[] = [];
  sessions = new Map<string, WireSession>();
  next = 0;

  session(name: string): WireSession {
    let s = this.sessions.get(name);
    if (!s) {
      s = { running: false, workspaces: [], tabs: [], panes: [] };
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
      Object.assign(this.session(target), { running: false, workspaces: [], tabs: [], panes: [] });
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
      return wire("ok", {});
    }
    if (domain === "pane" && action === "get") {
      const pane = session.panes.find((p) => p.pane_id === target);
      return pane ? wire("pane_info", { pane }) : failure("Pane missing");
    }
    if (domain === "pane" && action === "process-info") {
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

class InMemoryTransport implements AgentTransport {
  sentRequests: AgentRequest[] = [];

  async initialize() {
    return {
      ok: true as const,
      value: {
        transportName: "herdr" as const,
        protocolVersion: "22",
        supportsStreaming: true,
        supportsCancellation: true,
        supportsResume: true,
        supportsSubmissionCorrelation: true
      }
    };
  }

  async send(request: AgentRequest) {
    this.sentRequests.push(request);
    const handle: AgentExecutionHandle = {
      executionId: randomUUID(),
      requestId: request.requestId,
      attemptId: request.attemptId,
      runId: request.runId,
      taskId: request.taskId,
      idempotencyKey: request.idempotency.key,
      target: request.target,
      correlation: { token: request.requestId, provenance: "transport", verified: true },
      acceptedAt: new Date().toISOString()
    };
    return {
      ok: true as const,
      value: {
        status: "accepted" as const,
        requestId: request.requestId,
        attemptId: request.attemptId,
        runId: request.runId,
        taskId: request.taskId,
        observedAt: handle.acceptedAt,
        handle
      }
    };
  }

  async reconcile(request: {
    readonly requestId: string;
    readonly attemptId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly idempotencyKey: string;
    readonly target: AgentRequest["target"];
    readonly requestedAt: string;
  }) {
    const now = new Date().toISOString();
    return {
      ok: true as const,
      value: {
        status: "bound" as const,
        observedAt: now,
        handle: {
          executionId: `exec-${request.requestId}`,
          requestId: request.requestId,
          attemptId: request.attemptId,
          runId: request.runId,
          taskId: request.taskId,
          idempotencyKey: request.idempotencyKey,
          target: request.target,
          correlation: { token: request.requestId, provenance: "transport" as const, verified: true },
          acceptedAt: now
        }
      }
    };
  }

  async wait(handle: AgentExecutionHandle) {
    return {
      ok: true as const,
      value: {
        handle,
        state: "done" as const,
        correlationVerified: true,
        observedAt: new Date().toISOString()
      }
    };
  }

  async *read() {
    // No streaming needed for this harness
  }

  async cancel(_handle: AgentExecutionHandle, request: { readonly cancellationId: string }) {
    return {
      ok: true as const,
      value: {
        schemaVersion: 1 as const,
        cancellationId: request.cancellationId,
        status: "accepted" as const,
        observedAt: new Date().toISOString()
      }
    };
  }
}

describe("E16 — Group F: End-to-End Lifecycle (bflow init, up, attach, Conversation SDLC, down, up & resume)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync("/tmp/bflow-e2e-group-f-");
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("[LIVE HERDR 0.9.5 DAEMON] starts named session, creates 3 Bflow tabs, focuses Conversation agent, stops on down, and restarts on resume", async () => {
    if (!hasHerdr()) return;

    const liveDir = join(tmpRoot, "live-herdr-repo");
    mkdirSync(liveDir, { recursive: true });
    git(liveDir, "init", "-b", "main");
    writeFileSync(join(liveDir, "README.md"), "# Live Herdr Repo\n");
    git(liveDir, "add", ".");
    git(liveDir, "commit", "-m", "initial");

    const liveInitRes = await runCli(["init", "--json"], { cwd: liveDir });
    expect(liveInitRes.ok).toBe(true);

    const liveSessionName = `bflow-e2e-f-${process.pid}`;
    const liveBaseEnv: Record<string, string | undefined> = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_"))),
      XDG_CONFIG_HOME: join(liveDir, ".herdr-cfg"),
      XDG_DATA_HOME: join(liveDir, ".herdr-data"),
      XDG_RUNTIME_DIR: liveDir,
      TMPDIR: "/tmp",
      HERDR_CONFIG_PATH: join(liveDir, ".herdr-cfg/config.toml"),
      ZDOTDIR: liveDir,
      HERDR_SESSION: liveSessionName
    };
    mkdirSync(liveBaseEnv.XDG_CONFIG_HOME!, { recursive: true });
    mkdirSync(liveBaseEnv.XDG_DATA_HOME!, { recursive: true });
    writeFileSync(liveBaseEnv.HERDR_CONFIG_PATH!, "# Isolated QA Group F Herdr config\n");
    writeFileSync(join(liveDir, ".zshrc"), "# Isolated zshrc\n");

    const runLiveHerdr = (args: string[]) =>
      environmentProcessRunner.run({
        executable: "herdr",
        args: ["--session", liveSessionName, ...args],
        cwd: liveDir,
        env: namedSessionEnvironment(liveSessionName, liveBaseEnv),
        timeoutMs: 15_000
      });

    let server1 = spawn("herdr", ["--session", liveSessionName, "server"], {
      env: namedSessionEnvironment(liveSessionName, liveBaseEnv),
      stdio: "ignore"
    });
    let server2: ReturnType<typeof spawn> | null = null;

    try {
      mkdirSync(join(liveDir, ".bflow/logs"), { recursive: true, mode: 0o700 });

      await expect
        .poll(
          async () => {
            try {
              const st = await runLiveHerdr(["status", "server", "--json"]);
              return st.exitCode === 0 && JSON.parse(st.stdout).running === true;
            } catch {
              return false;
            }
          },
          { timeout: 10_000, interval: 100 }
        )
        .toBe(true);

      const wsCreateRes = await runLiveHerdr([
        "workspace",
        "create",
        "--cwd",
        liveDir,
        "--label",
        "bflow-group-f",
        "--no-focus"
      ]);
      expect(wsCreateRes.exitCode).toBe(0);
      const wsCreated = (
        JSON.parse(wsCreateRes.stdout) as {
          result: {
            workspace: { workspace_id: string };
            tab: { tab_id: string };
            root_pane: { pane_id: string };
          };
        }
      ).result;
      const wsId = wsCreated.workspace.workspace_id;
      const convTabId = wsCreated.tab.tab_id;
      const convPaneId = wsCreated.root_pane.pane_id;

      const renameConvRes = await runLiveHerdr(["tab", "rename", convTabId, "Conversation"]);
      expect(renameConvRes.exitCode).toBe(0);

      const coordTabRes = await runLiveHerdr([
        "tab",
        "create",
        "--workspace",
        wsId,
        "--cwd",
        liveDir,
        "--label",
        "Coordination",
        "--no-focus"
      ]);
      expect(coordTabRes.exitCode).toBe(0);

      const verifTabRes = await runLiveHerdr([
        "tab",
        "create",
        "--workspace",
        wsId,
        "--cwd",
        liveDir,
        "--label",
        "Verification",
        "--no-focus"
      ]);
      expect(verifTabRes.exitCode).toBe(0);

      const tabListRes = await runLiveHerdr(["tab", "list", "--workspace", wsId]);
      expect(tabListRes.exitCode).toBe(0);
      const liveTabs = (
        JSON.parse(tabListRes.stdout) as { result: { tabs: Array<{ tab_id: string; label: string }> } }
      ).result.tabs;
      expect(liveTabs.map((t) => t.label)).toEqual(
        expect.arrayContaining(["Conversation", "Coordination", "Verification"])
      );

      const actorScript = join(liveDir, "conv-actor.mjs");
      writeFileSync(
        actorScript,
        [
          "import { spawnSync } from 'node:child_process';",
          "let seq = Date.now();",
          "function report() {",
          "  spawnSync(process.env.HERDR_BIN_PATH ?? 'herdr', [",
          "    'pane', 'report-agent', process.env.HERDR_PANE_ID,",
          "    '--source', 'bflow:conversation', '--agent', 'bflow-conversation',",
          "    '--state', 'idle', '--seq', String(++seq),",
          "    '--agent-session-id', 'conv-live-1'",
          "  ], { env: process.env, encoding: 'utf8' });",
          "}",
          "setInterval(report, 250);",
          "report();"
        ].join("\n")
      );

      const paneRunRes = await runLiveHerdr(["pane", "run", convPaneId, `node ${actorScript}`]);
      expect(paneRunRes.exitCode).toBe(0);

      await expect
        .poll(
          async () => {
            const agentGetRes = await runLiveHerdr(["agent", "get", convPaneId]);
            if (agentGetRes.exitCode !== 0) return null;
            const agentGetJson = (
              JSON.parse(agentGetRes.stdout) as {
                result: { agent: { pane_id: string; agent: string; agent_status: string } };
              }
            ).result.agent;
            return {
              pane_id: agentGetJson.pane_id,
              agent: agentGetJson.agent,
              agent_status: agentGetJson.agent_status
            };
          },
          { timeout: 10_000, interval: 150 }
        )
        .toEqual({
          pane_id: convPaneId,
          agent: "bflow-conversation",
          agent_status: "idle"
        });

      const stopRes = await runLiveHerdr(["session", "stop", liveSessionName]);
      expect(stopRes.exitCode).toBe(0);
      if (server1.exitCode === null) server1.kill("SIGTERM");

      // Resume live Herdr session after down
      server2 = spawn("herdr", ["--session", liveSessionName, "server"], {
        env: namedSessionEnvironment(liveSessionName, liveBaseEnv),
        stdio: "ignore"
      });
      await expect
        .poll(
          async () => {
            try {
              const st = await runLiveHerdr(["status", "server", "--json"]);
              return st.exitCode === 0 && JSON.parse(st.stdout).running === true;
            } catch {
              return false;
            }
          },
          { timeout: 10_000, interval: 100 }
        )
        .toBe(true);
    } finally {
      await runLiveHerdr(["session", "stop", liveSessionName]).catch(() => {});
      if (server1.exitCode === null) server1.kill("SIGTERM");
      if (server2 && server2.exitCode === null) server2.kill("SIGTERM");
    }
  }, 30_000);

  it("[HARNESS + REAL SQLITE / ARTIFACT STORE / GIT WORKTREES] executes full lifecycle: init -> up -> attach -> Conversation SDLC task -> down (guard + checkpoint) -> up & resume", async () => {
    const repoDir = join(tmpRoot, "sdlc-repo");
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "QA Tester");
    git(repoDir, "config", "user.email", "qa@bflow.local");
    writeFileSync(join(repoDir, "guide.md"), "initial guide\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "sdlc-repo", version: "1.0.0" }, null, 2) + "\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "initial commit");

    // F1: bflow init (first run + second run idempotency)
    const initFirst = await runCli(["init", "--json"], { cwd: repoDir });
    const initSecond = await runCli(["init", "--json"], { cwd: repoDir });
    expect(initFirst.ok).toBe(true);
    expect(initSecond.ok).toBe(true);
    expect(existsSync(join(repoDir, ".bflow/config.yaml"))).toBe(true);
    expect(existsSync(join(repoDir, ".bflow/.gitignore"))).toBe(true);
    const bflowGitignore = readFileSync(join(repoDir, ".bflow/.gitignore"), "utf8");
    expect(bflowGitignore).toContain("state/");
    expect(bflowGitignore).toContain("logs/");

    git(repoDir, "add", ".bflow");
    git(repoDir, "commit", "-m", "chore: initialize bflow config");

    const repository = await identifyRepository(repoDir);
    const envConfig = await readEnvironmentConfig(repository);

    const runtimeStateRoot = join(tmpRoot, "runtime-storage");
    mkdirSync(runtimeStateRoot, { recursive: true });
    const dbPath = join(runtimeStateRoot, "runs.db");
    const artifactsPath = join(runtimeStateRoot, "artifacts");
    const registryPath = join(runtimeStateRoot, "registry.json");
    const journalDir = join(runtimeStateRoot, "journal");
    const convContextDir = join(runtimeStateRoot, "conversation-context");

    let runStore = unwrap(openSqliteRunStore({ filename: dbPath }));
    const artifactStore = unwrap(await openFilesystemArtifactStore({ root: artifactsPath, storeId: "qa-f-store" }));
    const registry = new FileAgentRegistry({ stateFile: registryPath });
    const transport = new InMemoryTransport();
    const keyPair = generateKeyPairSync("ed25519");
    const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const bindingReceiptKeys = { "native-qa-host": publicKey };

    const checks: QualityGateDefinition[] = [
      {
        id: "review",
        name: "review",
        evaluator: "review",
        required: true,
        timeout: { executionTimeoutMs: 5000, onTimeout: "block" },
        configuration: {
          kind: "review",
          method: "manual_review",
          criterionIds: ["ac-1"],
          testNames: ["ac-1: Guide documentation is updated"],
          role: "reviewer",
          levels: []
        }
      },
      {
        id: "regression",
        name: "regression",
        evaluator: "regression",
        required: true,
        timeout: { executionTimeoutMs: 5000, onTimeout: "block" },
        configuration: {
          kind: "deterministic",
          method: "integration_test",
          command: "test-regression",
          criterionIds: ["ac-1"],
          testNames: ["ac-1: Guide documentation is updated"],
          role: "tester",
          levels: ["integration"]
        }
      }
    ];

    const gates: QualityGate[] = checks.map((check) => ({
      id: check.id,
      evaluate: async (context) => {
        const config = context.definition.configuration as {
          role: "reviewer" | "tester";
          method: string;
          command?: string;
          testNames: string[];
          criterionIds: string[];
        };
        const input = context.input as {
          sourceRevision: string;
          specFingerprint: string;
          scope: "task" | "workflow";
        };
        return {
          ok: true,
          value: {
            gateId: context.definition.id,
            runId: context.runId,
            ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
            evaluationId: randomUUID(),
            status: "passed",
            findings: [],
            producedArtifacts: [],
            evaluatedAt: new Date().toISOString(),
            metadata: {
              verification: {
                schemaVersion: 2,
                checkId: check.id,
                runId: context.runId,
                ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
                ...(context.attemptId !== undefined ? { attemptId: context.attemptId } : {}),
                sourceRevision: input.sourceRevision,
                specFingerprint: input.specFingerprint,
                scope: input.scope,
                independentExecution: true,
                isolated: true,
                executorId: config.role === "reviewer" ? "independent-reviewer-host" : "independent-tester-host",
                role: config.role,
                method: config.method,
                ...(config.command ? { command: config.command, exitCode: 0 } : {}),
                testNames: config.testNames,
                criteria: config.criterionIds.map((criterionId) => ({
                  criterionId,
                  passed: true,
                  summary: "Independently verified criterion"
                })),
                summary: "Independent gate check passed"
              }
            }
          }
        };
      }
    }));

    let activeManifest!: SessionManifest;
    const devBindings: PaneBinding[] = [];

    const panePolicy: PanePolicy = {
      async getManifest() {
        return { ok: true, value: activeManifest };
      },
      async getRoleBinding(selector) {
        const all = [...(activeManifest?.panes ?? []), ...devBindings];
        return {
          ok: true,
          value: all.find((p) => [p.role, p.bindingId, p.paneId, p.agentId].includes(selector)) ?? null
        };
      },
      async inspectRoleHealth(selector) {
        const b = unwrap(await this.getRoleBinding(selector));
        if (!b) throw new Error(`No pane for ${String(selector)}`);
        return {
          ok: true,
          value: { readyForPrompt: true, occupantMatches: true, paneId: b.paneId, agentId: b.agentId }
        };
      },
      async allocateDeveloper(req) {
        const existing = devBindings.find((p) => p.agentId === req.agentName);
        if (existing) return { ok: true, value: existing };
        const base = activeManifest.panes[0]!;
        const devPane: PaneBinding = {
          ...base,
          bindingId: `binding-${req.agentName}`,
          role: "developer",
          paneGroup: "developer_worktree",
          agentId: req.agentName,
          paneId: `pane-${req.agentName}`,
          cwd: req.worktreePath,
          worktreePath: req.worktreePath,
          readOnlyWorkspace: false,
          session: { source: "herdr:claude", kind: "id", value: `sess-${req.agentName}` }
        };
        devBindings.push(devPane);
        return { ok: true, value: devPane };
      },
      async releaseDeveloper() {
        return { ok: true, value: undefined };
      }
    };

    const recordedHumanApprovalIds = new Set<string>();
    let engine = new DeterministicWorkflowEngine({ bindingReceiptKeys });
    let runtime!: AgenticWorkflowRuntime;

    const buildRuntime = async () => {
      const policies = await loadAgenticPolicies({
        repositoryPath: repoDir,
        artifactStore,
        gates,
        loadSpecification: (id) => runtime.loadSpecification(id),
        authorizeApprover: (decision) => ["coordinator", "human-1"].includes(decision.decidedBy)
      });
      runtime = new AgenticWorkflowRuntime(
        {
          engine,
          runStore,
          artifactStore,
          registry,
          transport,
          panes: panePolicy,
          policies,
          roleCapabilities: {
            developer: ["implementation"],
            coordinator: ["coordination"],
            conversation: ["conversation"],
            specifier: ["specification"],
            architect: ["architecture"],
            planner: ["planning"],
            reviewer: ["review"],
            qa: ["verification", "testing"],
            tester: ["testing"]
          },
          taskChecks: checks,
          workflowChecks: checks,
          authenticateMessage: async () => true,
          authenticateResult: async () => true,
          authenticateEvidence: async () => true,
          authenticateGateResult: async () => true,
          authorizeHuman: async (decision) => recordedHumanApprovalIds.has(decision.approvalId),
          projectApprovalRequired: () => false
        },
        { journalDirectory: journalDir, repositoryPath: repoDir }
      );
      return runtime;
    };

    await buildRuntime();

    const inspectRun = async (runId: string) =>
      (await runtime.inspect(runId)) as unknown as {
        status: string;
        tasks: Array<{
          taskId: string;
          spec: {
            strategy: {
              tddDecision: { decisionId: string };
              specId: string;
              criterionMappings: Array<{ testNames: string[] }>;
            };
          };
          cycle: { status: string };
        }>;
        workflowCycle: { status: string };
        workflowChange: { branchName: string; headCommitHash: string };
      };

    const inspectState = async () =>
      (await runtime.inspect()) as unknown as {
        runs?: Array<{ runId: string }>;
        outbound: Array<{
          runId?: string;
          taskId?: string;
          message: RoleMessage;
          handle?: AgentExecutionHandle;
        }>;
      };

    const wireRunner = new HerdrWireRunner();
    const savedCheckpoints: RecoveryCheckpoint[] = [];
    let hostQuiesceCount = 0;
    let hostShutdownCount = 0;

    const host = {
      prepare: async () => ({
        roleLaunch: Object.fromEntries(
          envConfig.environment.roles.map((r) => [
            r.role,
            {
              systemPrompt: `Trusted ${r.role} prompt`,
              mcpConfigFile: "/tmp/mcp.json",
              hooksSettingsFile: "/tmp/hooks.json"
            }
          ])
        )
      }),
      activate: async (manifest: SessionManifest) => {
        activeManifest = {
          ...manifest,
          panes: manifest.panes.map((p) => ({
            ...p,
            session: p.session ?? { source: `herdr:${p.agentKind}`, kind: "id", value: `native-${p.role}` }
          }))
        };
        return { ok: true as const, value: undefined };
      },
      runtime: {
        findRuns: async (query: { status?: string[] }, opts?: { signal?: AbortSignal }) => {
          const inspected = await inspectState();
          const items = [];
          for (const r of inspected.runs ?? []) {
            const stored = unwrap(await runStore.get(r.runId, opts));
            if (stored && (!query.status || query.status.includes(stored.snapshot.status))) {
              items.push(stored.snapshot);
            }
          }
          return { ok: true as const, value: { items } };
        },
        getRun: async (runId: string, opts?: { signal?: AbortSignal }) => {
          const stored = unwrap(await runStore.get(runId, opts));
          return { ok: true as const, value: stored ? stored.snapshot : null };
        }
      },
      quiesce: async () => {
        hostQuiesceCount++;
        return { ok: true as const, value: undefined };
      },
      checkpoint: async (command: CreateCheckpointCommand) => {
        const parsedCmd = CreateCheckpointCommandSchema.parse(command);
        const cpRes = await engine.createCheckpoint(parsedCmd);
        if (!cpRes.ok) return cpRes;
        unwrap(await runStore.saveCheckpoint(cpRes.value, parsedCmd.expectedVersion));
        savedCheckpoints.push(cpRes.value);
        return cpRes;
      },
      shutdown: async () => {
        hostShutdownCount++;
      },
      close: async () => {}
    };

    const makeLifecycle = () =>
      new EnvironmentLifecycle(repoDir, {
        runner: wireRunner,
        openIntegration: async (composition) =>
          openPaneManagerEnvironment(
            composition,
            wireRunner,
            async () => host as never,
            async () => ["--trusted-role-launch"]
          )
      });

    // F2: bflow up + idempotent second up
    const manifestUp1 = await makeLifecycle().up();
    const agentStartsAfterUp1 = wireRunner.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "start").length;
    const manifestUp1Idempotent = await makeLifecycle().up();
    const agentStartsAfterUp2 = wireRunner.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "start").length;

    expect(manifestUp1.status).toBe("up");
    expect(manifestUp1.panes).toHaveLength(7);
    expect(new Set(manifestUp1.panes.map((p) => p.tabId)).size).toBe(3);
    expect(manifestUp1Idempotent.status).toBe("up");
    expect(agentStartsAfterUp1).toBe(7);
    expect(agentStartsAfterUp2).toBe(7);

    // F3: bflow attach
    const attachedManifest = await makeLifecycle().attach();
    const lastFocusCall = [...wireRunner.calls].reverse().find((c) => c.args[0] === "agent" && c.args[1] === "focus");
    expect(attachedManifest.attachTarget.role).toBe("conversation");
    expect(lastFocusCall?.args[2]).toBe(attachedManifest.attachTarget.paneId);

    // F4: Conversation Agent Executing Full SDLC Task (run-sdlc-1)
    const nowIso = new Date().toISOString();
    const makeSpecAndWorkflow = (
      specId: string,
      runId: string,
      targetFile: string
    ): { spec: Specification; wf: WorkflowDefinition } => {
      const assessment: ChangeAssessment = {
        kind: "documentation",
        behaviorChange: false,
        modules: ["example"],
        securityImpact: false,
        publicApiImpact: false,
        dataSchemaImpact: false,
        architectureImpact: false,
        migrationRequired: false,
        risk: "low",
        unresolvedQuestions: []
      };
      const affectedPaths = [targetFile];
      const classification = classifyChange(assessment, affectedPaths);
      const details = PolicyDetailsSchema.parse({
        policyVersion: 1,
        assessment,
        functionalRequirements: [],
        technicalConstraints: [],
        apiDataContracts: [],
        risksAndTradeoffs: [],
        traceability: [{ criterionId: "ac-1", taskIds: ["implement"] }]
      });
      const spec: Specification = {
        schemaVersion: 2,
        specId,
        runId,
        sessionId: activeManifest.conversationSessionId,
        level: classification.level,
        complexity: classification.complexity,
        riskLevel: classification.riskLevel,
        version: 1,
        title: `Update ${targetFile} with release checklist`,
        summary: `Add verified release checklist section to ${targetFile}`,
        problemStatement: "The current guide does not include the release checklist",
        scope: { inScope: [`Update ${targetFile}`], outOfScope: ["Unrelated modules"] },
        acceptanceCriteria: [
          {
            id: "ac-1",
            description: "Guide documentation is updated",
            category: "functional",
            verificationMethod: "integration_test",
            required: true,
            status: "pending",
            evidenceArtifactIds: []
          }
        ],
        affectedPaths,
        traceabilityTaskIds: ["implement"],
        status: "draft",
        createdBy: "analyst",
        createdAt: nowIso,
        updatedAt: nowIso,
        metadata: {
          sdd: JSON.parse(JSON.stringify(details)),
          conditionalTdd: {
            policyVersion: 1,
            taskId: "implement",
            taskType: "domain_logic",
            changeImpact: {
              surfaces: ["domain_logic"],
              behaviorChanged: true,
              deterministic: true,
              regressionReproducible: true,
              securitySensitive: false,
              dataMigration: false,
              scope: "local"
            },
            infrastructure: {
              readiness: "ready",
              commands: [{ method: "integration_test", command: "test-regression", level: "integration" }]
            },
            testability: {
              level: "automated",
              rationale: "Repeatable behavioral check is available"
            },
            riskClassification: "low",
            conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] }
          }
        }
      };
      const wf: WorkflowDefinition = {
        schemaVersion: "1",
        id: `wf-${specId}`,
        name: `Workflow for ${specId}`,
        version: "1.0.0",
        tasks: [
          {
            id: "implement",
            title: "implement",
            role: "developer",
            instruction: `Update ${targetFile}`,
            acceptanceCriteria: ["ac-1"],
            retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
            timeout: { executionTimeoutMs: 60000, heartbeatTimeoutMs: 10000, onTimeout: "block" },
            requiresApproval: false,
            qualityGates: [],
            metadata: { ownedPaths: [targetFile] }
          }
        ],
        dependencies: [],
        qualityGates: [],
        maxConcurrency: 1,
        failurePolicy: "block",
        recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
      };
      return { spec, wf };
    };

    const convBinding = activeManifest.panes.find((p) => p.role === "conversation")!;
    const chatHost = await createAgenticConversationHost({
      runtime,
      manifest: activeManifest,
      contextDirectory: convContextDir,
      onHumanDecision: async (decision) => {
        recordedHumanApprovalIds.add(decision.approvalId);
      }
    });

    const userIntakeTurn = (await chatHost.handleUserTurn({
      sessionId: activeManifest.conversationSessionId,
      messageId: "turn-sdlc-intake-1",
      content: "Please implement the release checklist in guide.md with acceptance criteria: Guide documentation is updated.",
      provenance: {
        origin: "user",
        authenticatedUser: true,
        userId: "human-1",
        paneId: convBinding.paneId,
        channel: "herdr_attach"
      }
    })) as { ok: boolean };
    expect(userIntakeTurn.ok).toBe(true);

    const { spec: spec1, wf: wf1 } = makeSpecAndWorkflow("spec-sdlc-1", "run-sdlc-1", "guide.md");
    const delegation1 = {
      schemaVersion: 2,
      delegationId: "delegation-sdlc-1",
      messageId: "msg-intake-1",
      correlationId: "corr-sdlc-1",
      sessionId: activeManifest.conversationSessionId,
      runId: "run-sdlc-1",
      requestedBy: "conversation",
      targetRole: "coordinator",
      title: spec1.title,
      objective: spec1.summary,
      specificationId: spec1.specId,
      sddLevel: spec1.level,
      acceptanceCriteria: spec1.acceptanceCriteria,
      inputArtifacts: [],
      priority: "normal",
      requestedAt: nowIso,
      idempotencyKey: "idem-intake-1"
    };

    const makeEnvelope = (type: RoleMessage["type"], payload: unknown, extra: Record<string, unknown> = {}): RoleMessage =>
      RoleMessageSchema.parse({
        schema_version: 2,
        message_id: randomUUID(),
        correlation_id: extra["run_id"] === "run-resume-2" ? "corr-resume-2" : "corr-sdlc-1",
        run_id: "run-sdlc-1",
        sender: { role: "conversation", agent_id: convBinding.agentId, pane_id: convBinding.paneId },
        recipient: { role: "coordinator" },
        type,
        payload,
        artifact_references: [],
        idempotency_key: randomUUID(),
        ...extra
      });

    await runtime.receiveHerdr(
      makeEnvelope("delegation.request", delegation1, {
        message_id: "msg-intake-1",
        idempotency_key: "idem-intake-1"
      })
    );
    await runtime.proposeWorkflow("run-sdlc-1", spec1, wf1);
    await runtime.tick();

    const submitTddEvidence = async (runId: string, taskId: string, phase: "red" | "green" | "refactor") => {
      const run = await inspectRun(runId);
      const task = run.tasks.find((t) => t.taskId === taskId)!;
      const strategy = task.spec.strategy;
      const startedAt = new Date().toISOString();
      const bytes = Buffer.from(`${runId}-${taskId}-${phase}-${randomUUID()}`);
      const ref = unwrap(
        await artifactStore.put({
          options: {
            artifactId: randomUUID(),
            runId,
            taskId,
            kind: "test-result",
            mediaType: "text/plain",
            expectedIntegrity: {
              checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
              sizeBytes: bytes.length
            },
            idempotencyKey: randomUUID()
          },
          content: (async function* () {
            yield bytes;
          })()
        })
      );
      const red = phase === "red";
      const result = VerificationResultSchema.parse({
        schemaVersion: 2,
        verificationId: randomUUID(),
        runId,
        taskId,
        cycleNumber: 1,
        attemptId: randomUUID(),
        status: red ? "failed" : "passed",
        independentExecution: true,
        evaluatedCriteria: [
          {
            criterionId: "ac-1",
            passed: !red,
            evidenceArtifactId: ref.artifactId,
            summary: "Observed target behavior",
            command: "test-regression",
            exitCode: red ? 1 : 0
          }
        ],
        qualityGateResults: [],
        evidenceArtifacts: [ref],
        findings: [],
        verifiedBy: "tester",
        startedAt,
        completedAt: new Date().toISOString(),
        metadata: {
          conditionalTdd: {
            phase,
            decisionId: strategy.tddDecision.decisionId,
            specId: strategy.specId,
            sourceRevision: red ? "base-source" : "implementation-source",
            testRevision: "unchanged-tests",
            testNames: strategy.criterionMappings[0]!.testNames,
            ...(red ? { failureKind: "target_behavior" } : {}),
            observations: [
              {
                method: "integration_test",
                criterionId: "ac-1",
                evidenceArtifactId: ref.artifactId,
                summary: "Independent observation",
                command: "test-regression",
                exitCode: red ? 1 : 0
              }
            ]
          }
        }
      });
      await runtime.receiveHerdr(
        makeEnvelope("verification.result", result, {
          run_id: runId,
          sender: { role: "tester" }
        })
      );
    };

    const submitDeveloperWork = async (runId: string, taskId: string, file: string, content: string) => {
      const state = await inspectState();
      const outbound = [...state.outbound]
        .reverse()
        .find(
          (out) =>
            (out.runId ?? out.message.run_id) === runId &&
            out.taskId === taskId &&
            out.message.type === "task.assignment"
        )!;
      const handle = outbound.handle!;
      const worktreePath = handle.target.worktreePath!;
      writeFileSync(join(worktreePath, file), content);
      git(worktreePath, "add", file);
      git(worktreePath, "commit", "-m", `feat(${runId}): update ${file}`);
      const snap = unwrap(await engine.getSnapshot(runId))!;
      const taskSnap = snap.tasks.find((t) => t.taskId === taskId)!;
      const result = AgentResultSchema.parse({
        requestId: handle.requestId,
        attemptId: handle.attemptId,
        runId,
        taskId,
        executionId: handle.executionId,
        status: "succeeded",
        verification: {
          status: "verified",
          evidence: "Authenticated host result",
          correlation: taskSnap.bindingVerification?.receipt.correlation ?? handle.correlation
        },
        artifactProposals: [],
        retryable: false,
        startedAt: handle.acceptedAt,
        completedAt: new Date().toISOString()
      });
      await runtime.receiveHerdr(
        makeEnvelope("implementation.submitted", result, {
          run_id: runId,
          causation_id: outbound.message.message_id,
          sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId }
        })
      );
    };

    await submitTddEvidence("run-sdlc-1", "implement", "red");
    const authImpl1 = (await runtime.authorizeImplementation("run-sdlc-1", "implement")) as unknown as {
      authorized: boolean;
    };
    expect(authImpl1.authorized).toBe(true);
    await submitTddEvidence("run-sdlc-1", "implement", "green");
    await submitTddEvidence("run-sdlc-1", "implement", "refactor");
    await submitDeveloperWork("run-sdlc-1", "implement", "guide.md", "# Release Checklist\n- [x] Verified\n");

    await runtime.tick();
    await runtime.tick();

    const run1BeforeApproval = await inspectRun("run-sdlc-1");
    expect(run1BeforeApproval.status).toBe("awaiting_approval");

    const approvalReqOut1 = (await inspectState()).outbound.find(
      (out) => (out.runId ?? out.message.run_id) === "run-sdlc-1" && out.message.type === "approval.request"
    )!;
    await chatHost.receiveHerdr({
      ...approvalReqOut1.message,
      sender: { role: "coordinator", agent_id: "coordinator" },
      recipient: { role: "conversation" }
    });
    const userApproveTurn1 = (await chatHost.handleUserTurn({
      sessionId: activeManifest.conversationSessionId,
      messageId: "turn-sdlc-approve-1",
      content: "approve",
      provenance: {
        origin: "user",
        authenticatedUser: true,
        userId: "human-1",
        paneId: convBinding.paneId,
        channel: "herdr_attach"
      }
    })) as { ok: boolean };
    expect(userApproveTurn1.ok).toBe(true);
    await runtime.flushOutbound();
    const decisionOut1 = (await inspectState()).outbound.find(
      (out) => (out.runId ?? out.message.run_id) === "run-sdlc-1" && out.message.type === "approval.decision"
    )!;
    await runtime.receiveHerdr(decisionOut1.message);

    const run1Final = await inspectRun("run-sdlc-1");
    const run1Stored = unwrap(await runStore.get("run-sdlc-1"));
    expect(run1Final.status).toBe("completed");
    expect(run1Stored?.snapshot.status).toBe("succeeded");

    // F5: bflow down (Mid-run shutdown guard + Confirmed down with aggregate checkpoint)
    writeFileSync(join(repoDir, "other.md"), "initial other\n");
    git(repoDir, "add", "other.md");
    git(repoDir, "commit", "-m", "add other.md");

    const { spec: spec2, wf: wf2 } = makeSpecAndWorkflow("spec-resume-2", "run-resume-2", "other.md");
    const delegation2 = {
      ...delegation1,
      delegationId: "delegation-resume-2",
      messageId: "msg-intake-2",
      correlationId: "corr-resume-2",
      runId: "run-resume-2",
      title: spec2.title,
      objective: spec2.summary,
      specificationId: spec2.specId,
      idempotencyKey: "idem-intake-2"
    };
    await runtime.receiveHerdr(
      makeEnvelope("delegation.request", delegation2, {
        run_id: "run-resume-2",
        correlation_id: "corr-resume-2",
        message_id: "msg-intake-2",
        idempotency_key: "idem-intake-2"
      })
    );
    await runtime.proposeWorkflow("run-resume-2", spec2, wf2);
    await runtime.tick();

    const devDispatchesBeforeDown = transport.sentRequests.filter(
      (r) => r.runId === "run-resume-2" && r.role === "developer"
    ).length;
    expect(devDispatchesBeforeDown).toBe(1);

    await expect(makeLifecycle().down(false)).rejects.toThrow(/Unsafe shutdown: 1 active runs/);

    const downConfirmedManifest = (await makeLifecycle().down(true)) as SessionManifest;
    expect(downConfirmedManifest.status).toBe("down");
    expect(hostQuiesceCount).toBeGreaterThan(0);
    expect(hostShutdownCount).toBeGreaterThan(0);

    await expect(makeLifecycle().attach()).rejects.toThrow(/No active repository session/);

    const latestCheckpoint = savedCheckpoints[savedCheckpoints.length - 1]!;
    expect(latestCheckpoint.codec.name).toBe("bflow.workflow-aggregate+json");
    const parsedAggregateCheckpoint = WorkflowAggregateCheckpointStateSchema.parse(latestCheckpoint.state);
    expect(parsedAggregateCheckpoint.snapshot.status).toBe("running");

    // F6: bflow up and Resume
    runStore.close();
    runStore = unwrap(openSqliteRunStore({ filename: dbPath }));
    const storedRun2 = unwrap(await runStore.get("run-resume-2"))!;
    const storedCheckpoint2 = unwrap(await runStore.loadLatestCheckpoint("run-resume-2"))!;
    const storedEventsPage2 = unwrap(await runStore.readEvents("run-resume-2", { limit: 100 }));
    const tailEvents2 = storedEventsPage2.items.filter((e) => e.sequence > storedCheckpoint2.eventSequence);

    const verifyRecoveryEngine = new DeterministicWorkflowEngine({ definitions: [wf2], bindingReceiptKeys });
    const recoveredEngineState = unwrap(
      await verifyRecoveryEngine.recover({
        runId: "run-resume-2",
        checkpoint: storedCheckpoint2,
        events: tailEvents2,
        expectedVersion: storedRun2.snapshot.version
      })
    );
    expect(recoveredEngineState.snapshot.status).toBe("running");

    engine = new DeterministicWorkflowEngine({ bindingReceiptKeys });
    await buildRuntime();

    const manifestUpResume = await makeLifecycle().up();
    expect(manifestUpResume.status).toBe("up");

    await runtime.tick();
    const devDispatchesAfterResumeTick = transport.sentRequests.filter(
      (r) => r.runId === "run-resume-2" && r.role === "developer"
    ).length;
    expect(devDispatchesAfterResumeTick).toBe(devDispatchesBeforeDown);

    await submitTddEvidence("run-resume-2", "implement", "red");
    await runtime.authorizeImplementation("run-resume-2", "implement");
    await submitTddEvidence("run-resume-2", "implement", "green");
    await submitTddEvidence("run-resume-2", "implement", "refactor");
    await submitDeveloperWork("run-resume-2", "implement", "other.md", "# Resumed Feature\nCompleted after bflow up & resume.\n");

    await runtime.tick();
    await runtime.tick();

    const approvalReqOut2 = (await inspectState()).outbound.find(
      (out) => (out.runId ?? out.message.run_id) === "run-resume-2" && out.message.type === "approval.request"
    )!;
    const resumedConvBinding = activeManifest.panes.find((p) => p.role === "conversation")!;
    const resumedChatHost = await createAgenticConversationHost({
      runtime,
      manifest: activeManifest,
      contextDirectory: convContextDir,
      onHumanDecision: async (decision: ApprovalDecision) => {
        recordedHumanApprovalIds.add(decision.approvalId);
      }
    });
    await resumedChatHost.receiveHerdr({
      ...approvalReqOut2.message,
      sender: { role: "coordinator", agent_id: "coordinator" },
      recipient: { role: "conversation" }
    });
    await resumedChatHost.handleUserTurn({
      sessionId: activeManifest.conversationSessionId,
      messageId: "turn-sdlc-approve-2",
      content: "approve",
      provenance: {
        origin: "user",
        authenticatedUser: true,
        userId: "human-1",
        paneId: resumedConvBinding.paneId,
        channel: "herdr_attach"
      }
    });
    await runtime.flushOutbound();
    const decisionOut2 = (await inspectState()).outbound.find(
      (out) => (out.runId ?? out.message.run_id) === "run-resume-2" && out.message.type === "approval.decision"
    )!;
    await runtime.receiveHerdr(decisionOut2.message);

    const run2Final = await inspectRun("run-resume-2");
    const run2StoredFinal = unwrap(await runStore.get("run-resume-2"));
    expect(run2Final.status).toBe("completed");
    expect(run2StoredFinal?.snapshot.status).toBe("succeeded");
    const otherAtIntegrationCommit = git(repoDir, "show", `${run2Final.workflowChange.headCommitHash}:other.md`);
    expect(otherAtIntegrationCommit).toContain("# Resumed Feature");

    await makeLifecycle().down(true);
    runStore.close();
    artifactStore.close();
  }, 180_000);
});
