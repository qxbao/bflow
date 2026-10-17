import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionManifestSchema,
  type ContractError,
  type MCPClientRegistration,
  type MCPServiceObservation,
  type OperationOptions,
  type OperationResult,
  type ScopedOperation,
  type TrustScope
} from "@bflow/contracts";
import { createFakeProviderRunner, type ProviderCommandRunner } from "@bflow/agent-providers";
import { SkillFileStore, SkillManager, bundleDigest, type BundleFiles } from "@bflow/skills";
import { failWith, ok } from "../../src/platform/errors.js";
import { Ed25519LaunchAttestationSigner } from "../../src/platform/attestation-signer.js";
import { RoleEnvironmentResolver } from "../../src/platform/environment.js";
import { FileLaunchJournal } from "../../src/platform/launch-journal.js";
import { GatewayRegistrationManager } from "../../src/platform/gateway-registrations.js";
import { ProviderReadiness } from "../../src/platform/provider-readiness.js";
import { SkillSessionStore } from "../../src/platform/skills-session.js";
import { DefaultPlatformReadinessService } from "../../src/platform/service.js";
import { createProviderAdapterFactory, createSkillResolver } from "../../src/platform/defaults.js";
import { HostPlatformSession } from "../../src/agentic/host-platform.js";
import type { AgenticHostPlatformOptions } from "../../src/platform/host-options.js";
import type { GatewayControlPort, GatewayRegistrationGrant, PlatformSessionIdentity } from "../../src/platform/ports.js";
import { withDeveloperLaunches } from "../../src/agentic/workspace.js";

// Pane Manager is consumed through its built dist, as the Agentic host does (runtime has no static dependency on it).
const paneModule: any = await import(new URL("../../../pane-manager/dist/index.js", import.meta.url).href);
const manifestModule: any = await import(new URL("../../../pane-manager/dist/manifest-store.js", import.meta.url).href);

const ENDPOINT = "http://127.0.0.1:7777/mcp";
const SESSION = "session-1";

/** Stateful Gateway control: registrations are real map entries, so revocation is observable. */
class FakeGatewayControl implements GatewayControlPort {
  readonly registrations = new Map<string, { registration: MCPClientRegistration; bearerToken: string }>();
  services: MCPServiceObservation[] = [];
  registerCount = 0;

  async register(registration: MCPClientRegistration, _options?: OperationOptions): Promise<OperationResult<GatewayRegistrationGrant>> {
    this.registerCount++;
    const bearerToken = randomBytes(24).toString("hex");
    this.registrations.set(registration.registrationId, { registration, bearerToken });
    return ok({ registration, bearerToken });
  }

  async revoke(registrationId: string, _operation: ScopedOperation, _options?: OperationOptions): Promise<OperationResult<void>> {
    if (!this.registrations.has(registrationId)) return failWith({ code: "not_found", retryable: false, message: "registration not found" });
    this.registrations.delete(registrationId);
    return ok(undefined);
  }

  async list(scope: TrustScope, _options?: OperationOptions): Promise<OperationResult<readonly MCPClientRegistration[]>> {
    return ok([...this.registrations.values()].map(entry => entry.registration)
      .filter(registration => JSON.stringify(registration.scope) === JSON.stringify(scope)));
  }

  async inspectServices(_operation: ScopedOperation, _options?: OperationOptions): Promise<OperationResult<readonly MCPServiceObservation[]>> {
    return ok(this.services);
  }

  tokens(): string[] {
    return [...this.registrations.values()].map(entry => entry.bearerToken);
  }
}

function observation(serviceId: string): MCPServiceObservation {
  return {
    schemaVersion: 3,
    serviceId,
    revision: 1,
    instanceId: `${serviceId}-instance`,
    status: "ready",
    protocolVersion: "2025-06-18",
    discoveredTools: ["search", "read"],
    ownership: "bflow",
    activeClientCount: 0,
    observedAt: "2026-10-18T00:00:00.000Z",
    diagnosticCode: "ok"
  };
}

const skillBody = (name: string) => `---\nname: ${name}\ndescription: Inspect an assigned task before implementation.\n---\n\n${[
  "Supported roles", "Prerequisites", "Trigger conditions", "Required inputs", "Expected outputs", "Procedure",
  "Bflow commands", "Verification requirements", "Error handling", "Escalation rules", "Concrete examples"
].map(h => `## ${h}\n\nUse the accepted task and preserve Runtime authority.`).join("\n\n")}\n`;

const skillFiles = (name: string): BundleFiles => ({
  "SKILL.md": skillBody(name),
  "skill.json": JSON.stringify({
    version: "1.0.0",
    allowedRoles: ["developer"],
    supportedProviders: ["claude", "codex", "agy"],
    requiredCapabilityIds: [],
    requiredToolIds: [],
    dependencies: []
  })
});

type Json = Record<string, unknown>;
interface FakePane { paneId: string; workspaceId: string; tabId: string; agent: string | null; cwd?: string }
interface FakeAgent { name: string; kind: string; paneId: string; workspaceId: string; tabId: string }

/**
 * Minimal stateful Herdr command runner covering the Developer path: worktree create/open, pane
 * get/split/rename/close/process-info, agent list/get/start. Records every invocation with its env.
 */
class FakeHerdr {
  readonly calls: { args: string[]; env: Readonly<Record<string, string>> | undefined }[] = [];
  readonly panes = new Map<string, FakePane>();
  readonly agents = new Map<string, FakeAgent>();
  private seq = 0;

  startCalls(): { args: string[]; env: Readonly<Record<string, string>> | undefined }[] {
    return this.calls.filter(call => call.args[0] === "agent" && call.args[1] === "start");
  }

  private next(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private paneJson(pane: FakePane): Json {
    return {
      pane_id: pane.paneId, terminal_id: `term-${pane.paneId}`, workspace_id: pane.workspaceId, tab_id: pane.tabId,
      focused: false, agent: pane.agent, agent_status: pane.agent ? "idle" : "idle", revision: 1,
      ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {})
    };
  }

  private agentJson(agent: FakeAgent): Json {
    return {
      name: agent.name, agent: agent.kind, pane_id: agent.paneId, terminal_id: `term-${agent.paneId}`,
      workspace_id: agent.workspaceId, tab_id: agent.tabId, focused: false, agent_status: "idle", revision: 1,
      interactive_ready: true, launch_pending: false
    };
  }

  private newPane(workspaceId: string, tabId: string, cwd?: string): FakePane {
    const pane: FakePane = { paneId: this.next("pane"), workspaceId, tabId, agent: null, ...(cwd !== undefined ? { cwd } : {}) };
    this.panes.set(pane.paneId, pane);
    return pane;
  }

  private okJson(result: Json): { exitCode: number; stdout: string; stderr: string } {
    return { exitCode: 0, stdout: JSON.stringify({ id: "1", result }), stderr: "" };
  }

  private error(code: string, message: string): { exitCode: number; stdout: string; stderr: string } {
    return { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code, message } }) };
  }

  async run(invocation: { args: readonly string[]; env?: NodeJS.ProcessEnv | Readonly<Record<string, string>> | undefined }) {
    const args = [...invocation.args];
    const env = invocation.env === undefined ? undefined : { ...(invocation.env as Record<string, string>) };
    this.calls.push({ args, env });
    const [domain, action] = args;
    const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

    if (domain === "worktree" && (action === "create" || action === "open")) {
      const path = flag("--path") ?? "/worktree";
      const label = flag("--label") ?? "wt";
      const workspaceId = this.next("ws-wt");
      const tabId = this.next("tab-wt");
      const root = this.newPane(workspaceId, tabId, path);
      return this.okJson({
        type: action === "create" ? "worktree_created" : "worktree_opened",
        workspace: { workspace_id: workspaceId, label, active_tab_id: tabId, focused: false, pane_count: 1, tab_count: 1, agent_status: "idle" },
        tab: { tab_id: tabId, workspace_id: workspaceId, label: "developer", focused: false, pane_count: 1, agent_status: "idle" },
        root_pane: this.paneJson(root),
        worktree: { path, label, branch: flag("--branch") ?? null, is_linked_worktree: true, is_detached: false, is_bare: false, is_prunable: false, open_workspace_id: workspaceId }
      });
    }
    if (domain === "pane" && action === "split") {
      const source = this.panes.get(args[2] ?? "");
      if (!source) return this.error("pane_not_found", "pane not found");
      const pane = this.newPane(source.workspaceId, source.tabId, source.cwd);
      return this.okJson({ type: "pane_info", pane: this.paneJson(pane) });
    }
    if (domain === "pane" && action === "get") {
      const pane = this.panes.get(args[2] ?? "");
      if (!pane) return this.error("pane_not_found", "pane not found");
      return this.okJson({ type: "pane_info", pane: this.paneJson(pane) });
    }
    if (domain === "pane" && action === "process-info") {
      const paneId = flag("--pane") ?? "";
      return this.okJson({ type: "pane_process_info", process_info: {
        pane_id: paneId, shell_pid: 4242, foreground_process_group_id: 4242, foreground_processes: []
      } });
    }
    if (domain === "pane" && action === "rename") {
      const pane = this.panes.get(args[2] ?? "");
      if (!pane) return this.error("pane_not_found", "pane not found");
      return this.okJson({ type: "pane_info", pane: this.paneJson(pane) });
    }
    if (domain === "pane" && action === "close") {
      const paneId = args[2] ?? "";
      this.panes.delete(paneId);
      for (const [name, agent] of this.agents) if (agent.paneId === paneId) this.agents.delete(name);
      return this.okJson({ type: "ok" });
    }
    if (domain === "worktree" && action === "remove") {
      return this.okJson({ type: "worktree_removed", removed: true });
    }
    if (domain === "agent" && action === "list") {
      return this.okJson({ type: "agent_list", agents: [...this.agents.values()].map(agent => this.agentJson(agent)) });
    }
    if (domain === "agent" && action === "get") {
      const agent = [...this.agents.values()].find(candidate => candidate.paneId === args[2]);
      if (!agent) return this.error("agent_not_found", "agent not found");
      return this.okJson({ type: "agent_info", agent: this.agentJson(agent) });
    }
    if (domain === "agent" && action === "start") {
      const name = args[2] ?? "";
      const kind = flag("--kind") ?? "";
      const paneId = flag("--pane") ?? "";
      const pane = this.panes.get(paneId);
      if (!pane) return this.error("pane_not_found", "pane not found");
      const agent: FakeAgent = { name, kind, paneId, workspaceId: pane.workspaceId, tabId: pane.tabId };
      this.agents.set(name, agent);
      pane.agent = kind;
      return this.okJson({ type: "agent_started", agent: this.agentJson(agent) });
    }
    return this.error("unsupported", `unsupported fake Herdr command: ${args.join(" ")}`);
  }
}

/** Clean worktree inspector: every path is an unused, clean checkout. */
const cleanInspector = {
  async inspect(_worktreePath: string, _options?: OperationOptions) {
    return ok({ exists: false, isClean: true, dirtyFiles: [] as string[] });
  }
};

describe("P30 dynamic Developer launches end to end", () => {
  let baseDir: string;
  let workspace: string;
  let stateDirectory: string;
  let binaryPath: string;
  let gatewayControl: FakeGatewayControl;
  let skillPin: { skillId: string; version: string; digest: string };
  let skillDigest: string;
  let skillStoreRoot: string;
  let signer: Ed25519LaunchAttestationSigner;
  let skillManager: SkillManager;

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-developer-launch-")));
    workspace = join(baseDir, "workspace");
    stateDirectory = join(workspace, ".bflow/state/platform", SESSION);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(join(baseDir, "worktrees"), { recursive: true, mode: 0o700 });
    binaryPath = join(baseDir, "claude");
    await writeFile(binaryPath, "#!/bin/sh\necho ok\n", { mode: 0o700 });
    await chmod(binaryPath, 0o700);

    const files = skillFiles("inspect-task");
    skillDigest = bundleDigest(files);
    skillStoreRoot = join(baseDir, "store");
    skillManager = new SkillManager({
      store: new SkillFileStore(skillStoreRoot),
      supportedCommands: ["status", "help", "doctor"],
      approvedBuiltinDigests: [skillDigest]
    });
    const installed = await skillManager.installBundle(files, { source: "builtin", expectedDigest: skillDigest });
    skillPin = { skillId: installed.skillId, version: installed.version, digest: installed.digest };

    gatewayControl = new FakeGatewayControl();
    gatewayControl.services = [observation("svc-search")];
    signer = Ed25519LaunchAttestationSigner.generate("bflow-test-host");
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  function worktree(taskId: string): string {
    return join(baseDir, "worktrees", taskId);
  }

  /** Builds the real host composition: readiness service, HostPlatformSession, RolePaneManager and the launch wrapper. */
  async function buildHost(options: { runner?: ProviderCommandRunner; gateway?: boolean; maxCapacity?: number; mcpServiceIds?: string[] } = {}) {
    // The runtime prepares the task worktree before allocating its Developer; preflight requires it to exist.
    for (const taskId of ["run-1-t1", "run-1-t2", "run-1-legacy"]) await mkdir(worktree(taskId), { recursive: true, mode: 0o700 });
    const journal = new FileLaunchJournal(join(stateDirectory, "launch-journal.jsonl"));
    const providers = new ProviderReadiness({
      factory: createProviderAdapterFactory({
        runner: options.runner ?? createFakeProviderRunner({ scenario: "healthy" }),
        perProvider: { claude: { executablePath: binaryPath, allowTestFilesystemOwnership: true } }
      }),
      journal
    });
    const gateway = options.gateway === false ? undefined : new GatewayRegistrationManager({ control: gatewayControl, endpoint: ENDPOINT });
    const service = new DefaultPlatformReadinessService({
      environments: new RoleEnvironmentResolver(),
      skills: new SkillSessionStore({ resolver: createSkillResolver(skillManager) }),
      ...(gateway ? { gateway } : {}),
      providers,
      journal,
      signer,
      rolePrompt: role => `Role prompt for ${role}.`
    });
    const platform = {
      schemaVersion: 3,
      machineId: "machine-1",
      repositoryId: "repo-1",
      roles: [{
        role: "developer", provider: "claude", required: true, permissionMode: "workspace_auto",
        capabilityIds: [], mcpServiceIds: options.mcpServiceIds ?? [], toolIds: ["search"],
        skillSelections: [{ skill: skillPin, required: true }]
      }],
      skillsStoreRoot: skillStoreRoot,
      approvedBuiltinSkillDigests: [skillDigest]
    } as AgenticHostPlatformOptions;
    const session = new HostPlatformSession({
      service, platform, repositoryPath: workspace, sessionId: SESSION, stateDirectory,
      generationFile: join(stateDirectory, "generation.json"),
      launchesFile: join(stateDirectory, "launches.json"),
      hostCapabilities: {}
    });
    await session.prepare();

    const herdr = new FakeHerdr();
    const store = new manifestModule.InMemorySessionManifestStore();
    const chatPane = {
      schemaVersion: 2, bindingId: "binding-chat", sessionId: SESSION, role: "conversation", agentId: "chat",
      workspaceId: "ws-main", tabId: "tab-main", paneId: "pane-chat", provider: "claude", agentKind: "claude",
      cwd: workspace, isolationMode: "dedicated_pane", readOnlyWorkspace: false, permanent: true,
      transportState: "idle", boundAt: "2026-10-18T00:00:00.000Z"
    };
    const coordinatorPane = { ...chatPane, bindingId: "binding-coordinator", role: "coordinator", agentId: "coordinator", paneId: "pane-coordinator" };
    const manifest = SessionManifestSchema.parse({
      schemaVersion: 2, sessionId: SESSION, projectName: "bflow", workspaceRoot: workspace, herdrWorkspaceId: "ws-main",
      herdrTabId: "tab-main", status: "up", conversationSessionId: "conv-1", activeRunIds: [], panes: [chatPane, coordinatorPane],
      attachTarget: { role: "conversation", paneId: "pane-chat" },
      createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z"
    });
    await store.save(manifest);
    const rolePanes = new paneModule.RolePaneManager({
      config: {
        sessionId: SESSION, projectName: "bflow", workspaceRoot: workspace, conversationSessionId: "conv-1",
        maxDeveloperCapacity: options.maxCapacity ?? 2, defaultAgentKind: "claude"
      },
      runner: herdr, store, worktreeInspector: cleanInspector
    });
    const panes = withDeveloperLaunches(rolePanes, {
      allocate: request => session.allocateDeveloper(request.taskId, request.worktreePath),
      release: taskId => session.releaseDeveloper(taskId)
    });
    return { service, session, journal, herdr, store, rolePanes, panes };
  }

  /** The launch's bearer token inside one Herdr invocation env: the value that is a live Gateway token. */
  function tokenIn(call: { env: Readonly<Record<string, string>> | undefined } | undefined): string | undefined {
    const live = gatewayControl.tokens();
    return Object.values(call?.env ?? {}).find(value => live.includes(value));
  }

  function allocation(taskId: string) {
    return {
      taskId,
      runId: "run-1",
      worktreePath: worktree(taskId),
      branchName: `feat/${taskId}`,
      agentName: `dev-${taskId}`
    };
  }

  async function journalEntries(journal: FileLaunchJournal): Promise<{ kind: string; launchId: string }[]> {
    return (await journal.entries()).map(entry => entry as unknown as { kind: string; launchId: string });
  }

  /** Every regular file under the test base directory, so secrets can be searched for on disk. */
  async function filesUnder(directory: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...await filesUnder(path));
      else if (entry.isFile()) found.push(path);
    }
    return found;
  }

  it("allocates a Developer pane for the task worktree with the prepared launch and journals the intent", async () => {
    const host = await buildHost();
    const prepareSpy = vi.spyOn(host.service, "prepareDeveloper");

    const result = await host.panes.allocateDeveloper(allocation("run-1-t1"));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    const [identity, requirement] = prepareSpy.mock.calls[0]!;
    expect(requirement.cwd).toBe(worktree("run-1-t1"));
    expect(requirement.taskId).toBe("run-1-t1");
    expect(identity.sessionId).toBe(SESSION);
    const prepared = await prepareSpy.mock.results[0]!.value as { ok: true; value: { launch: { launchId: string; launchFingerprint: string; argv: string[]; env: Record<string, string> } } };
    const launch = prepared.value.launch;

    const starts = host.herdr.startCalls();
    expect(starts).toHaveLength(1);
    const start = starts[0]!;
    const paneId = result.value.paneId;
    expect(start.args.slice(0, 4)).toEqual(["agent", "start", "dev-run-1-t1", "--kind"]);
    expect(start.args[start.args.indexOf("--kind") + 1]).toBe("claude");
    expect(start.args[start.args.indexOf("--pane") + 1]).toBe(paneId);
    expect(start.args.slice(start.args.indexOf("--") + 1)).toEqual(launch.argv);
    // No Gateway services for this role, so the invocation carries no launch env.
    expect(Object.keys(launch.env)).toHaveLength(0);

    expect(result.value.metadata).toEqual(expect.objectContaining({
      topologyRole: "developer",
      taskId: "run-1-t1",
      launchId: launch.launchId,
      launchFingerprint: launch.launchFingerprint,
      allocationStatus: "active"
    }));
    expect(result.value.worktreePath).toBe(worktree("run-1-t1"));
    expect(result.value.agentKind).toBe("claude");

    const entries = await journalEntries(host.journal);
    expect(entries).toEqual([expect.objectContaining({ kind: "intent", launchId: launch.launchId })]);
    expect(host.session.status().status.launches).toEqual([expect.objectContaining({
      launchId: launch.launchId, role: "developer", provider: "claude", taskId: "run-1-t1", state: "intent"
    })]);
  });

  it("refuses a Developer whose preflight is blocked: no agent start, no pane, Gateway registration revoked", async () => {
    const host = await buildHost({
      runner: createFakeProviderRunner({ scenario: "auth_expired" }),
      mcpServiceIds: ["svc-search"]
    });

    const result = await host.panes.allocateDeveloper(allocation("run-1-t1"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/launch is blocked/);

    expect(gatewayControl.registerCount).toBe(1);
    expect(gatewayControl.registrations.size).toBe(0);
    expect(host.herdr.startCalls()).toHaveLength(0);
    expect(host.herdr.calls.some(call => call.args[0] === "worktree")).toBe(false);
    expect(host.herdr.panes.size).toBe(0);
    expect(await journalEntries(host.journal)).toEqual([]);
    expect(host.session.status().status.launches).toEqual([]);
  });

  it("passes the Gateway token only in the invocation env and keeps it out of manifest, journal and disk", async () => {
    const host = await buildHost({ mcpServiceIds: ["svc-search"] });

    const result = await host.panes.allocateDeveloper(allocation("run-1-t1"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(gatewayControl.registrations.size).toBe(1);
    const [token] = gatewayControl.tokens();
    expect(token).toBeTruthy();

    const start = host.herdr.startCalls()[0]!;
    expect(Object.values(start.env ?? {})).toContain(token);
    expect(start.args.join(" ")).not.toContain(token);

    const manifest = await host.rolePanes.getManifest();
    expect(JSON.stringify(manifest)).not.toContain(token);
    expect(JSON.stringify(result.value)).not.toContain(token);

    for (const file of await filesUnder(baseDir)) {
      const content = await readFile(file, "utf8").catch(() => "");
      expect(content.includes(token!), `token leaked into ${file}`).toBe(false);
    }
  });

  it("releases a completed Developer once: launch released, registration revoked, status and journal updated", async () => {
    const host = await buildHost({ mcpServiceIds: ["svc-search"] });
    const releaseSpy = vi.spyOn(host.service, "releaseLaunch");
    const allocated = await host.panes.allocateDeveloper(allocation("run-1-t1"));
    expect(allocated.ok).toBe(true);
    if (!allocated.ok) return;
    const launchId = allocated.value.metadata?.["launchId"] as string;

    const released = await host.panes.releaseDeveloper({ taskId: "run-1-t1", closePane: false, removeWorktree: false });
    expect(released.ok).toBe(true);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(launchId);
    expect(gatewayControl.registrations.size).toBe(0);
    expect(host.herdr.panes.has(allocated.value.paneId)).toBe(false);
    expect(host.session.status().status.launches).toEqual([expect.objectContaining({ launchId, state: "released" })]);
    expect((await journalEntries(host.journal)).map(entry => entry.kind)).toEqual(["intent", "released"]);

    // Idempotent: a second release does not call the readiness service again and does not fail.
    const again = await host.panes.releaseDeveloper({ taskId: "run-1-t1", closePane: false, removeWorktree: false });
    expect(again.ok).toBe(true);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect((await journalEntries(host.journal)).map(entry => entry.kind)).toEqual(["intent", "released"]);
  });

  it("releases a cancelled Developer by closing its pane and revoking its launch", async () => {
    const host = await buildHost({ mcpServiceIds: ["svc-search"] });
    const allocated = await host.panes.allocateDeveloper(allocation("run-1-t2"));
    expect(allocated.ok).toBe(true);
    if (!allocated.ok) return;
    const launchId = allocated.value.metadata?.["launchId"] as string;

    const cancelled = await host.panes.releaseDeveloper({ taskId: "run-1-t2", closePane: true, removeWorktree: false });
    expect(cancelled.ok).toBe(true);
    expect(host.herdr.calls.some(call => call.args[0] === "pane" && call.args[1] === "close" && call.args[2] === allocated.value.paneId)).toBe(true);
    expect(gatewayControl.registrations.size).toBe(0);
    expect(host.session.status().status.launches).toEqual([expect.objectContaining({ launchId, state: "released" })]);
    const manifest = await host.rolePanes.getManifest();
    expect(manifest.ok && manifest.value?.panes.some(pane => pane.role === "developer")).toBe(false);
  });

  it("keeps two concurrent Developers on distinct launches and registrations, and releasing one leaves the other", async () => {
    const host = await buildHost({ mcpServiceIds: ["svc-search"] });
    const first = await host.panes.allocateDeveloper(allocation("run-1-t1"));
    const second = await host.panes.allocateDeveloper(allocation("run-1-t2"));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const firstLaunch = first.value.metadata?.["launchId"];
    const secondLaunch = second.value.metadata?.["launchId"];
    expect(firstLaunch).toBeTruthy();
    expect(secondLaunch).toBeTruthy();
    expect(firstLaunch).not.toBe(secondLaunch);
    expect(gatewayControl.registrations.size).toBe(2);

    const [firstStart, secondStart] = host.herdr.startCalls();
    const firstToken = tokenIn(firstStart);
    const secondToken = tokenIn(secondStart);
    expect(firstToken).toBeTruthy();
    expect(secondToken).toBeTruthy();
    expect(firstToken).not.toBe(secondToken);

    const released = await host.panes.releaseDeveloper({ taskId: "run-1-t1", closePane: false, removeWorktree: false });
    expect(released.ok).toBe(true);
    expect(gatewayControl.registrations.size).toBe(1);
    expect(gatewayControl.tokens()).toEqual([secondToken]);
    expect(host.session.status().status.launches).toEqual(expect.arrayContaining([
      expect.objectContaining({ launchId: firstLaunch, state: "released" }),
      expect.objectContaining({ launchId: secondLaunch, state: "intent" })
    ]));
  });

  it("allocates a legacy Developer unchanged when no launch port is configured", async () => {
    const host = await buildHost();
    const prepareSpy = vi.spyOn(host.service, "prepareDeveloper");

    const result = await host.rolePanes.allocateDeveloper(allocation("run-1-legacy"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(prepareSpy).not.toHaveBeenCalled();
    const start = host.herdr.startCalls()[0]!;
    expect(start.args).toEqual(expect.arrayContaining(["--kind", "claude", "--pane", result.value.paneId]));
    expect(start.args).not.toContain("--");
    expect(start.env).toBeUndefined();
    expect(result.value.metadata?.["launchId"]).toBeUndefined();
    expect(result.value.metadata?.["taskId"]).toBe("run-1-legacy");
    expect(host.session.status().status.launches).toEqual([]);
  });

  it("releases the prepared launch when Pane Manager refuses the allocation (capacity), leaking no registration", async () => {
    const host = await buildHost({ mcpServiceIds: ["svc-search"], maxCapacity: 1 });
    const first = await host.panes.allocateDeveloper(allocation("run-1-t1"));
    expect(first.ok).toBe(true);

    const refused = await host.panes.allocateDeveloper(allocation("run-1-t2"));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toMatch(/capacity/i);

    // Only the admitted Developer keeps a Gateway registration and an unreleased launch.
    expect(gatewayControl.registrations.size).toBe(1);
    const states = host.session.status().status.launches.map(launch => ({ taskId: launch.taskId, state: launch.state }));
    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "run-1-t1", state: "intent" }),
      expect.objectContaining({ taskId: "run-1-t2", state: "released" })
    ]));
  });

  it("does not reuse a released Developer pane for a new launch, so no agent keeps a revoked token", async () => {
    const host = await buildHost({ mcpServiceIds: ["svc-search"] });
    const first = await host.panes.allocateDeveloper(allocation("run-1-t1"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstToken = tokenIn(host.herdr.startCalls()[0]);

    expect((await host.panes.releaseDeveloper({ taskId: "run-1-t1", closePane: false, removeWorktree: false })).ok).toBe(true);
    const second = await host.panes.allocateDeveloper(allocation("run-1-t1"));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const starts = host.herdr.startCalls();
    expect(starts).toHaveLength(2);
    const secondToken = tokenIn(starts[1]);
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);
    expect(second.value.metadata?.["launchId"]).toBeTruthy();
    expect(host.herdr.panes.has(first.value.paneId)).toBe(false);
    expect(gatewayControl.tokens()).toEqual([secondToken]);
  });
});
