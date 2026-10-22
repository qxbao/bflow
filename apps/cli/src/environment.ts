import { AGY_LOGIN_REMEDIATION, probeAgyAccess } from "./agy-access.js";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ContractErrorSchema, CreateCheckpointCommandSchema,
  PaneBindingSchema, WorkflowRunSnapshotSchema, RecoveryCheckpointSchema, SessionManifestSchema, WorkflowAggregateCheckpointStateSchema,
  type ContractError, type CreateCheckpointCommand, type EnvironmentDoctorReport,
  type OperationOptions, type OperationResult, type RecoveryCheckpoint, type RuntimeService,
  type SessionLifecycleManager, type SessionManifest, type PaneBinding
} from "@bflow/contracts";
import { findExecutable } from "@bflow/machine-setup";
import { readEnvironmentConfig, type EnvironmentConfig, type EnvironmentRoleConfig } from "./environment-config.js";
import { environmentProcessRunner, namedSessionEnvironment, type EnvironmentProcessRunner } from "./environment-process.js";
import { identifyRepository, type RepositoryIdentity } from "./repository.js";
import { openPaneManagerEnvironment } from "./pane-manager-integration.js";
import { withLifecycleLock } from "./lifecycle-lock.js";
import { runDoctorDiagnostics } from "./doctor-integration.js";

/** CLI composition seam. The provider owns P13 bootstrap/reconciliation and Runtime checkpoint persistence. */
export interface EnvironmentIntegration {
  readonly requiresNativeSession?: boolean;
  /** Provider checks and launch material only. Must not create panes or dispatch roles. */
  readonly prepareRoles?: (options: OperationOptions) => Promise<void>;
  readonly manager: SessionLifecycleManager;
  readonly runtime?: Pick<RuntimeService, "findRuns" | "getRun">;
  /** Establish a shutdown barrier: stop intake/dispatch and drain in-flight state writes. */
  readonly quiesce?: (options: OperationOptions) => Promise<OperationResult<void>>;
  /** Quiesce dispatch and durably persist an aggregate checkpoint before returning. */
  readonly checkpoint?: (command: CreateCheckpointCommand, options: OperationOptions) => Promise<OperationResult<RecoveryCheckpoint>>;
  /** Start/reconcile the durable provider host after physical roles are ready. */
  readonly activate?: (manifest: SessionManifest, options: OperationOptions) => Promise<void>;
  /** Stop the host only after checkpoint, pane and named-session shutdown succeeds. */
  readonly shutdownHost?: () => Promise<void>;
  /** Force only: stop a host daemon that rejects this CLI's protocol ("Unknown host operation"). */
  readonly terminateIncompatibleHost?: () => Promise<void>;
  readonly close?: () => Promise<void>;
}

export const READY_TRANSPORT_STATES: ReadonlySet<string> = new Set(["idle", "done", "working", "accepted"]);

export interface ProviderProbeOverride {
  readonly available?: boolean;
  readonly version?: string;
  readonly authenticated?: boolean;
  readonly blocked?: boolean;
  readonly blockedReason?: string;
  readonly unsupportedFlags?: readonly string[];
  readonly readiness?: "ready" | "blocked" | "degraded" | "partial" | "unauthenticated" | "missing_binary";
}

export interface McpLifecycleState {
  readonly gatewayAvailable?: boolean;
  readonly services?: Record<string, {
    readonly status: "ready" | "degraded" | "unavailable" | "stopped";
    readonly discoveredTools?: readonly string[];
    readonly endpoint?: string;
    readonly ownership?: "bflow" | "external";
    readonly scope?: "machine" | "repository" | "session";
    readonly pid?: number;
  }>;
  readonly activeRepositories?: Set<string>;
  readonly sessionRegistrations?: Map<string, string[]>;
  readonly stoppedServices?: string[];
}

export interface EnvironmentCompositionInput {
  readonly repository: RepositoryIdentity;
  readonly config: EnvironmentConfig;
  readonly env: NodeJS.ProcessEnv;
}
export interface EnvironmentDependencies {
  /** Explicit opt-in model diagnostics; the default implementation uses the Runtime facade. */
  readonly probeProviderModels?: () => Promise<readonly import("@bflow/runtime").RolePreflightSummary[]>;
  readonly signal?: AbortSignal;
  readonly runner?: EnvironmentProcessRunner;
  readonly integration?: EnvironmentIntegration;
  readonly openIntegration?: (input: EnvironmentCompositionInput) => Promise<EnvironmentIntegration>;
  readonly env?: NodeJS.ProcessEnv;
  readonly mcpState?: McpLifecycleState;
  /** Test seam for the Context7 health check used by `up` and `doctor`. */
  readonly context7Health?: () => Promise<import("./docs-health.js").Context7Health>;
  readonly providerOverrides?: Partial<Record<"claude" | "codex" | "agy", ProviderProbeOverride>>;
  readonly toolOverrides?: Record<string, { installed: boolean; version?: string }>;
  readonly skillsOverride?: {
    readonly catalogDir?: string;
    readonly missingSkills?: readonly string[];
    readonly invalidReferences?: readonly string[];
    readonly versionIncompatible?: boolean;
  };
  readonly onProgress?: ((step: string) => void) | undefined;
  readonly onProgressDetail?: ((detail: string) => void) | undefined;
}
export interface EnvironmentStatus {
  readonly workspaceRoot: string;
  readonly sessionName: string;
  readonly server: "running" | "stopped" | "unknown";
  readonly configuration: "valid" | "invalid";
  readonly manifest: SessionManifest | null;
  readonly liveObservation: boolean;
  readonly issues: readonly string[];
}

export class EnvironmentError extends Error {
  constructor(readonly contractError: ContractError) { super(contractError.message); }
}
function fail(message: string, details?: any): never {
  throw new EnvironmentError({ code: "validation", retryable: false, message, ...(details !== undefined ? { details } : {}) });
}
function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new EnvironmentError(ContractErrorSchema.parse(result.error));
  return result.value;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("Invalid Herdr/CLI state response");
  return value as Record<string, unknown>;
}

class Deadline {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  context: string | undefined;
  readonly expires: number;
  constructor(timeoutMs: number, parent?: AbortSignal) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) fail("Timeout must be an integer from 1 to 600000 milliseconds");
    this.expires = Date.now() + timeoutMs;
    this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal;
  }
  remaining(): number {
    if (this.signal.aborted && !this.controller.signal.aborted) throw new EnvironmentError({ code: "cancelled", retryable: false,
      message: "Environment command interrupted. Session/state were preserved. Run bflow up to resume, or bflow down --yes to stop safely; do not delete .bflow." });
    const remaining = this.expires - Date.now();
    if (remaining <= 0) this.timeout();
    return remaining;
  }
  timeout(): never {
    this.controller.abort();
    throw new EnvironmentError({ code: "timeout", retryable: true, retrySafety: "observation_only",
      message: `Environment operation timed out. ${this.context ?? "Delivery may have occurred; run bflow status/doctor and reconcile the existing session before retrying."}` });
  }
  options(): OperationOptions { return { timeoutMs: this.remaining(), signal: this.signal, deadline: new Date(this.expires).toISOString() }; }
  async call<T>(operation: (options: OperationOptions) => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([operation(this.options()), new Promise<never>((_, reject) => {
        onAbort = () => reject(this.controller.signal.aborted
          ? new EnvironmentError({ code: "timeout", retryable: true, retrySafety: "observation_only", message: `Environment operation timed out. ${this.context ?? "Session/state preserved; run bflow status, then bflow up to reconcile or bflow down --yes to stop safely."}` })
          : new EnvironmentError({ code: "cancelled", retryable: false, message: "Command interrupted; session/state preserved. Run bflow up to resume or bflow down --yes to stop safely." }));
        this.signal.addEventListener("abort", onAbort, { once: true });
        if (this.signal.aborted) onAbort();
        timer = setTimeout(() => { try { this.timeout(); } catch (error) { reject(error); } }, this.remaining());
      })]);
    } finally { clearTimeout(timer); if (onAbort) this.signal.removeEventListener("abort", onAbort); }
  }
  async pause() { await new Promise((done) => setTimeout(done, Math.min(100, this.remaining()))); }
}

interface OperationIntent { repositoryId: string; sessionName: string; phase: "server_starting" | "manager_pending" | "ready" | "stopping" | "down"; serverPid?: number; }

export class EnvironmentLifecycle {
  private readonly runner: EnvironmentProcessRunner;
  private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly cwd: string, private readonly dependencies: EnvironmentDependencies = {}) {
    this.runner = dependencies.runner ?? environmentProcessRunner;
    this.env = dependencies.env ?? process.env;
  }
  private progress(message: string) {
    try { this.dependencies.onProgress?.(message); } catch {}
  }
  private progressDetail(message: string) {
    try {
      if (this.dependencies.onProgressDetail) this.dependencies.onProgressDetail(message);
      else this.dependencies.onProgress?.(message);
    } catch {}
  }

  private statePath(repository: RepositoryIdentity, name: string) { return resolve(repository.root, ".bflow/state", name); }
  private async readJson(repository: RepositoryIdentity, name: string): Promise<unknown | null> {
    try { return JSON.parse(await readFile(this.statePath(repository, name), "utf8")) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async writeJson(repository: RepositoryIdentity, name: string, value: unknown) {
    const target = this.statePath(repository, name);
    const temp = `${target}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temp, target); } finally { await rm(temp, { force: true }); }
  }
  private async locked<T>(repository: RepositoryIdentity, operation: () => Promise<T>) {
    return withLifecycleLock(this.statePath(repository, "."), operation);
  }
  async recover(confirmed = false): Promise<EnvironmentStatus> {
    this.progress("Inspecting lifecycle state and migrating legacy lock...");
    const repository = await identifyRepository(this.cwd, this.runner);
    if (!confirmed) fail("Stop any old Bflow lifecycle command, then run bflow recover --yes to migrate its empty legacy lock. State, agents and worktrees are preserved.");
    await withLifecycleLock(this.statePath(repository, "."), async () => {
      const previous = await this.intent(repository), config = await readEnvironmentConfig(repository);
      if (previous?.phase === "server_starting" && !await this.probe(repository, config)) {
        if (previous.serverPid && this.processAlive(previous.serverPid)) fail(`Startup process ${previous.serverPid} is still alive. Wait for it before recovery; no startup was resent.`);
        await this.writeIntent(repository, "down");
      }
    }, true);
    return this.status();
  }
  private processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  }
  private validateManifest(raw: unknown, repository: RepositoryIdentity): SessionManifest {
    const manifest = SessionManifestSchema.parse(raw);
    if (manifest.workspaceRoot !== repository.root || manifest.sessionId !== repository.sessionName) fail("Session manifest belongs to another repository/session");
    const metadata = manifest.metadata;
    if (metadata?.["repositoryId"] !== undefined && metadata["repositoryId"] !== repository.id) fail("Manifest repository identity mismatch");
    return manifest;
  }
  private async savedManifest(repository: RepositoryIdentity) {
    const raw = await this.readJson(repository, "session.json");
    return raw === null ? null : this.validateManifest(raw, repository);
  }
  private async saveManifest(repository: RepositoryIdentity, raw: unknown) {
    const manifest = this.validateManifest(raw, repository);
    const saved = SessionManifestSchema.parse({ ...manifest, metadata: { ...manifest.metadata, repositoryId: repository.id, sessionName: repository.sessionName } });
    await this.writeJson(repository, "session.json", saved);
    return saved;
  }
  private async intent(repository: RepositoryIdentity): Promise<OperationIntent | null> {
    const raw = await this.readJson(repository, "operation.json");
    if (raw === null) return null;
    const state = object(raw);
    if (state["repositoryId"] !== repository.id || state["sessionName"] !== repository.sessionName ||
      !["server_starting", "manager_pending", "ready", "stopping", "down"].includes(String(state["phase"]))) fail("Environment operation belongs to another repository or is corrupt");
    if (state.serverPid !== undefined && (!Number.isSafeInteger(state.serverPid) || Number(state.serverPid) <= 1)) fail("Corrupt startup process receipt; preserve state and inspect bflow doctor.");
    return state as unknown as OperationIntent;
  }
  private writeIntent(repository: RepositoryIdentity, phase: OperationIntent["phase"]) {
    return this.writeJson(repository, "operation.json", { repositoryId: repository.id, sessionName: repository.sessionName, phase });
  }
  private async integration(repository: RepositoryIdentity, config: EnvironmentConfig): Promise<EnvironmentIntegration | undefined> {
    if (this.dependencies.integration) return this.dependencies.integration;
    const input = { repository, config, env: namedSessionEnvironment(repository.sessionName) };
    if (this.dependencies.openIntegration) return this.dependencies.openIntegration(input);
    // Explicit operator-selected composition module; never execute a module named in repository data.
    const path = process.env["BFLOW_ENVIRONMENT_MODULE"];
    if (!path) return openPaneManagerEnvironment(input, this.runner);
    const module: unknown = await import(pathToFileURL(resolve(path)).href);
    const factory = object(module)["openBflowEnvironment"];
    if (typeof factory !== "function") fail("BFLOW_ENVIRONMENT_MODULE must export openBflowEnvironment(input)");
    const integration: unknown = await factory(input);
    const result = object(integration);
    const manager = object(result["manager"]);
    for (const method of ["init", "up", "down", "attach", "getManifest", "doctorSession"]) if (typeof manager[method] !== "function") fail(`SessionLifecycleManager.${method} is unavailable`);
    // Interfaces are checked structurally here; all exchanged payloads are parsed at each call below.
    return integration as EnvironmentIntegration;
  }
  private async command(repository: RepositoryIdentity, binary: string, args: readonly string[], deadline?: Deadline) {
    const env = namedSessionEnvironment(repository.sessionName);
    if (binary === "git") for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const result = await this.runner.run({ executable: binary, args, cwd: repository.root,
      env, ...(deadline ? { signal: deadline.options().signal } : {}), timeoutMs: Math.min(5000, deadline?.remaining() ?? 5000) });
    if (result.exitCode !== 0) fail(`${binary} ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    return result.stdout;
  }
  private async probe(repository: RepositoryIdentity, config: EnvironmentConfig, deadline?: Deadline) {
    const raw: unknown = JSON.parse(await this.command(repository, config.environment.herdrBinary, ["status", "server", "--json"], deadline));
    const status = object(raw);
    if (status["session"] !== repository.sessionName || typeof status["running"] !== "boolean") fail("Herdr returned an uncorrelated session status");
    if (status["running"] && (status["protocol"] !== 22 || status["compatible"] === false || status["endpoint_compatible"] === false)) fail("Herdr server is incompatible; expected protocol 22");
    return status["running"];
  }
  private cleanupMcpSession(repository: RepositoryIdentity) {
    if (!this.dependencies.mcpState) return;
    this.dependencies.mcpState.sessionRegistrations?.delete(repository.sessionName);
    this.dependencies.mcpState.activeRepositories?.delete(repository.id);
    if (this.dependencies.mcpState.services && this.dependencies.mcpState.stoppedServices) {
      for (const [svcId, svc] of Object.entries(this.dependencies.mcpState.services)) {
        if (svc.ownership === "external" || svc.scope === "machine") continue;
        const stillReferenced = Array.from(this.dependencies.mcpState.sessionRegistrations?.values() ?? []).some((list) => list.includes(svcId));
        if (!stillReferenced && !this.dependencies.mcpState.stoppedServices.includes(svcId)) {
          this.dependencies.mcpState.stoppedServices.push(svcId);
        }
      }
    }
  }
  private startupFailureWithCleanup(error: unknown, outcome: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof EnvironmentError) return new EnvironmentError({ ...error.contractError, message: `${message}\nAutomatic cleanup ${outcome}.` });
    return new Error(`${message}\nAutomatic cleanup ${outcome}.`, { cause: error });
  }
  private readyPane(pane: PaneBinding): boolean {
    if (["starting", "blocked", "disconnected", "cancelled", "unknown"].includes(pane.transportState)) return false;
    if (pane.metadata?.["partialStart"] === true || pane.metadata?.["startupStatus"] === "partial") return false;
    return READY_TRANSPORT_STATES.has(pane.transportState);
  }
  private ready(manifest: SessionManifest, config: EnvironmentConfig): boolean {
    return manifest.status === "up" && config.environment.roles.filter((r) => r.role !== "developer" && (r.required ?? true)).every((r) =>
      manifest.panes.filter((pane) => pane.role === r.role).length === 1 &&
      manifest.panes.some((pane) => pane.role === r.role && this.readyPane(pane)));
  }
  private async checkpointRuns(integration: EnvironmentIntegration, runs: Map<string, { version: number }>, deadline: Deadline) {
    if (runs.size && !integration.checkpoint) fail("Runtime checkpoint/quiesce API is unavailable. Recovery data was preserved.");
    for (const [runId, run] of runs) {
      const command = CreateCheckpointCommandSchema.parse({ runId, expectedVersion: run.version, checkpointId: `shutdown-${randomUUID()}`, createdAt: new Date().toISOString() });
      const checkpoint = RecoveryCheckpointSchema.parse(unwrap(await deadline.call(opts => integration.checkpoint!(command, opts))));
      if (checkpoint.runId !== runId || checkpoint.version < run.version || checkpoint.codec.name !== "bflow.workflow-aggregate+json") fail(`Runtime returned an invalid aggregate checkpoint for '${runId}'`);
      const aggregate = WorkflowAggregateCheckpointStateSchema.parse(checkpoint.state);
      if (aggregate.snapshot.runId !== runId || aggregate.snapshot.version !== checkpoint.version || aggregate.snapshot.lastEventSequence !== checkpoint.eventSequence) fail("Aggregate checkpoint identity/version mismatch");
    }
  }
  async up(timeoutMs?: number): Promise<SessionManifest> {
    // Step 1: load_project_config
    this.progress("Checking repository and configuration...");
    const repository = await identifyRepository(this.cwd, this.runner);
    const config = await readEnvironmentConfig(repository);
    return this.locked(repository, async () => {
      const deadline = new Deadline(timeoutMs ?? config.environment.startupTimeoutMs, this.dependencies.signal);
      this.progress("Verifying dependencies and provider authentication...");

      // Step 2: validate_required_providers
      const fallbackNotices: string[] = [];
      const rolesToRun = config.environment.roles.map((r) => ({ ...r }));
      const cliAvailableCache = new Map<string, boolean>();
      const selectedProfiles = config.environment.defaults;
      const hasSelectedProfile = (role: EnvironmentRoleConfig) =>
        role["profile-name"] !== undefined ||
        selectedProfiles?.[role.cli as "claude" | "codex" | "agy"]?.["profile-name"] !== undefined;
      const providerAvailable = async (role: EnvironmentRoleConfig, cli: "claude" | "codex" | "agy") => {
        const override = this.dependencies.providerOverrides?.[cli];
        if (override?.available !== undefined) return override.available;
        if (override?.readiness === "missing_binary") return false;
        if (cliAvailableCache.has(cli)) return cliAvailableCache.get(cli)!;
        let available: boolean;
        if (hasSelectedProfile(role)) {
          const path = this.env[process.platform === "win32" ? "Path" : "PATH"] ?? this.env["PATH"] ?? "";
          available = await findExecutable(cli, path.split(delimiter), process.platform) !== null;
        } else {
          const probe = await this.runner.run({
            executable: cli,
            args: ["--version"],
            cwd: repository.root,
            env: namedSessionEnvironment(repository.sessionName),
            timeoutMs: Math.min(5000, deadline.remaining())
          }).catch(() => null);
          available = probe !== null && probe.exitCode === 0;
        }
        cliAvailableCache.set(cli, available);
        return available;
      };
      for (const role of rolesToRun) {
        if (role.required ?? true) {
          const cli = role.cli as "claude" | "codex" | "agy";
          let available = await providerAvailable(role, cli);
          if (!available) {
            if (config.environment.allowProviderFallback === true && role.fallbackCli) {
              const previousProvider = role.cli;
              fallbackNotices.push(`Role '${role.role}' fell back from '${role.cli}' to '${role.fallbackCli}'.`);
              role.cli = role.fallbackCli;
              if (role.cli !== previousProvider) delete role["profile-name"];
              const fallbackProvider = role.cli as "claude" | "codex" | "agy";
              available = await providerAvailable(role, fallbackProvider);
              if (!available) {
                const displayName = fallbackProvider === "codex" ? "OpenAI Codex CLI ('codex')" :
                  fallbackProvider === "claude" ? "Claude Code CLI ('claude')" : "Antigravity CLI ('agy')";
                const remediation = `Install ${displayName} and ensure it is on PATH, then run 'bflow doctor'.`;
                fail(`Missing fallback agent provider executable '${fallbackProvider}'. ${remediation}`,
                  { component: `provider:${fallbackProvider}`, remediation });
              }
            } else {
              const displayName = cli === "codex" ? "OpenAI Codex CLI ('codex')" : cli === "claude" ? "Claude Code CLI ('claude')" : "Antigravity CLI ('agy')";
              const remediation = `Install ${displayName} and ensure it is on PATH, then run 'bflow doctor'.`;
              fail(`Missing required agent provider executable '${cli}'. ${remediation}`, { component: `provider:${cli}`, remediation });
            }
          }
        }
      }

      // Step 3: validate_binaries_and_auth
      const help = await this.command(repository, config.environment.herdrBinary, ["--help"], deadline);
      if (!help.includes("--session") || !help.includes("headless")) fail("Installed Herdr does not advertise named sessions/headless server");
      const schema = object(JSON.parse(await this.command(repository, config.environment.herdrBinary, ["api", "schema", "--json"], deadline)) as unknown);
      if (schema["protocol"] !== 22 || schema["schema_version"] !== 1) fail("Unsupported Herdr API: expected protocol 22/schema 1");

      const requiresNativeAuthentication = (role: EnvironmentRoleConfig) =>
        !hasSelectedProfile(role);
      const distinctRequiredClis = Array.from(new Set(rolesToRun
        .filter((role) => (role.required ?? true) && requiresNativeAuthentication(role))
        .map((r) => r.cli as "claude" | "codex" | "agy")));
      for (const cli of distinctRequiredClis) {
        const override = this.dependencies.providerOverrides?.[cli];
        if (override?.available === false) {
          const remediation = cli === "codex"
            ? "Install OpenAI Codex CLI ('codex') and ensure it is on PATH, then run 'bflow doctor'."
            : cli === "claude"
            ? "Install Claude Code CLI ('claude') and ensure it is on PATH, then run 'bflow doctor'."
            : "Install Antigravity CLI ('agy') and ensure it is on PATH, then run 'bflow doctor'.";
          fail(`Missing required agent provider executable '${cli}'. ${remediation}`, { component: `provider:${cli}`, remediation });
        }
        if (override?.authenticated === false) {
          const remediation = cli === "agy" ? AGY_LOGIN_REMEDIATION
            : `Run '${cli === "codex" ? "codex login" : "claude auth login"}' and verify with 'bflow doctor'.`;
          fail(`Agent provider '${cli}' is not authenticated. ${remediation}`, { component: `provider:${cli}`, remediation });
        }
        if (override?.authenticated === undefined) {
          if (cli === "codex") {
            const result = await this.runner.run({
              executable: "codex",
              args: ["login", "status"],
              cwd: repository.root,
              env: namedSessionEnvironment(repository.sessionName),
              timeoutMs: Math.min(5000, deadline.remaining())
            });
            if (result.exitCode !== 0) {
              fail("Agent provider 'codex' is not authenticated. Run 'codex login' and verify with 'bflow doctor'.", { component: "provider:codex" });
            }
          } else if (cli === "claude") {
            const result = await this.runner.run({
              executable: "claude",
              args: ["auth", "status", "--json"],
              cwd: repository.root,
              env: namedSessionEnvironment(repository.sessionName),
              timeoutMs: Math.min(5000, deadline.remaining())
            });
            if (result.exitCode !== 0) {
              fail("Agent provider 'claude' is not authenticated. Run 'claude auth login' and verify with 'bflow doctor'.", { component: "provider:claude" });
            }
            let status: unknown;
            try { status = JSON.parse(result.stdout); } catch { fail("Agent provider 'claude' is not authenticated. Run 'claude auth login' and verify with 'bflow doctor'.", { component: "provider:claude" }); }
            if (object(status)["loggedIn"] !== true) {
              fail("Agent provider 'claude' is not authenticated. Run 'claude auth login' and verify with 'bflow doctor'.", { component: "provider:claude" });
            }
          } else if (cli === "agy") {
            const access = await probeAgyAccess(this.runner, {
              cwd: repository.root, env: namedSessionEnvironment(repository.sessionName),
              timeoutMs: Math.min(45_000, deadline.remaining()), signal: deadline.signal
            });
            if (access.status !== "available") fail(`${access.message} Remediation: ${access.remediation}`, {
              component: "provider:agy", remediation: access.remediation
            });
          }
        }
      }

      // Step 4: validate_permissions_and_trust
      if (config.environment.permissions?.trustedWorkspace === false) {
        fail("Workspace trust check failed: repository workspace is not trusted. Remediation: Set environment.permissions.trustedWorkspace to true in .bflow/config.yml or trust the workspace.", { component: "permissions" });
      }
      // Explicit opt-in only: pre-accept Claude Code's per-project trust dialog so headless panes are not stuck on it.
      if (config.environment.permissions?.trustedWorkspace === true && distinctRequiredClis.includes("claude")) {
        const { claudeConfigFile, ensureClaudeWorkspaceTrust } = await import("./claude-trust.js");
        await ensureClaudeWorkspaceTrust(repository.root, claudeConfigFile(this.env));
      }
      const isUnattended = config.environment.permissions?.mode === "unattended_isolated" || rolesToRun.some((r) => r.permissionMode === "unattended_isolated");
      if (isUnattended && config.environment.permissions?.isolation !== "os_sandbox" && config.environment.permissions?.isolation !== "container") {
        fail("Permission configuration invalid: 'unattended_isolated' requires 'os_sandbox' or 'container' isolation. Remediation: Configure environment.permissions.isolation as 'os_sandbox' or 'container', or switch permissionMode to 'workspace_auto'.", { component: "permissions" });
      }
      const unsupportedFlags: string[] = [];
      if (config.environment.permissions?.unsupportedFlags) {
        unsupportedFlags.push(...config.environment.permissions.unsupportedFlags);
      }
      for (const r of rolesToRun) {
        if (r.unsupportedFlags) unsupportedFlags.push(...r.unsupportedFlags);
      }
      for (const cli of ["claude", "codex", "agy"] as const) {
        const oFlags = this.dependencies.providerOverrides?.[cli]?.unsupportedFlags;
        if (oFlags) unsupportedFlags.push(...oFlags);
      }
      if (unsupportedFlags.length > 0) {
        fail(`Unsupported permission flags configured (${unsupportedFlags.join(", ")}). Remediation: Remove unsupported permission flags from .bflow/config.yml or upgrade the provider CLI.`, { component: "permissions" });
      }
      for (const role of rolesToRun) {
        for (const envKey of role.requiredEnv ?? []) {
          const val = this.env[envKey];
          if (!val || !val.trim()) {
            fail(`Missing required environment variable '${envKey}' for role '${role.role}'. Remediation: Export ${envKey} before running 'bflow up'.`, { component: `provider:${role.cli}` });
          }
        }
      }

      // Step 5: validate_required_mcp
      const requiredMcp = config.environment.requiredMcpServices ?? [];
      if (requiredMcp.length > 0 || this.dependencies.mcpState) {
        if (this.dependencies.mcpState?.gatewayAvailable === false) {
          fail("MCP Gateway service is unavailable. Remediation: Run 'bflow setup --apply' or 'bflow mcp status' to start and verify the MCP Gateway.", { component: "mcp:gateway" });
        }
        for (const serviceId of requiredMcp) {
          const service = this.dependencies.mcpState?.services?.[serviceId];
          if (!service || service.status !== "ready") {
            fail(`Required MCP service '${serviceId}' is unavailable. Remediation: Run 'bflow mcp status' or 'bflow setup --apply' to configure and start '${serviceId}'.`, { component: `mcp:${serviceId}` });
          }
        }
      }

      // Context7 is a hosted documentation service. When the repository marks it required, `up` refuses to start without a
      // Gateway-confirmed service; when optional, roles start without it and a warning is raised when roles are prepared.
      const context7 = config.environment.context7;
      if (context7?.enabled === true && context7.required === true) {
        const { collectContext7Health } = await import("./docs-command.js");
        const health = await (this.dependencies.context7Health?.() ?? collectContext7Health({ repository, config, env: this.env, probe: false }));
        const { requiredContext7Refusal } = await import("./docs-health.js");
        const refusal = requiredContext7Refusal(health);
        if (refusal) fail(refusal, { component: "mcp:context7" });
      }

      // Step 6: validate_skills
      const skillsOverride = this.dependencies.skillsOverride;
      if (skillsOverride?.missingSkills && skillsOverride.missingSkills.length > 0) {
        fail(`Required skills are missing: ${skillsOverride.missingSkills.join(", ")}. Remediation: Run 'bflow skills sync' or 'bflow setup --apply' to install missing skills.`, { component: "skills" });
      }
      if (skillsOverride?.invalidReferences && skillsOverride.invalidReferences.length > 0) {
        fail(`Invalid skill references detected: ${skillsOverride.invalidReferences.join(", ")}. Remediation: Fix role skill bindings in .bflow/config.yml or skills/roles/bindings.json and run 'bflow skills sync'.`, { component: "skills" });
      }
      if (skillsOverride?.versionIncompatible) {
        fail("Skill catalog version is incompatible with Platform v3. Remediation: Update skill bundles to schemaVersion 3 and run 'bflow skills sync'.", { component: "skills" });
      }
      if (config.environment.skills?.required || config.environment.skills?.requiredSkills?.length || config.environment.skills?.catalogDir || rolesToRun.some((r) => r.skills?.length)) {
        const catalogDir = resolve(repository.root, skillsOverride?.catalogDir ?? config.environment.skills?.catalogDir ?? ".bflow/skills");
        if (!existsSync(catalogDir)) {
          fail("Required skills are missing: catalog directory does not exist. Remediation: Run 'bflow skills sync' or 'bflow setup --apply' to install missing skills.", { component: "skills" });
        }
        const requestedSkills = Array.from(new Set([
          ...(config.environment.skills?.requiredSkills ?? []),
          ...rolesToRun.flatMap((r) => r.skills ?? [])
        ]));
        if (requestedSkills.length > 0) {
          const missing: string[] = [];
          for (const s of requestedSkills) {
            let found = existsSync(resolve(catalogDir, s, "SKILL.md"));
            if (!found) {
              try {
                const entries = readdirSync(catalogDir, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.isDirectory() && existsSync(resolve(catalogDir, entry.name, s, "SKILL.md"))) {
                    found = true;
                    break;
                  }
                }
              } catch {}
            }
            if (!found) {
              missing.push(s);
            }
          }
          if (missing.length > 0) {
            fail(`Required skills are missing: ${missing.join(", ")}. Remediation: Run 'bflow skills sync' or 'bflow setup --apply' to install missing skills.`, { component: "skills" });
          }
        }
      }

      // Step 7: verify_agent_readiness_preflight
      for (const cli of distinctRequiredClis) {
        const override = this.dependencies.providerOverrides?.[cli];
        if (override?.blocked === true || override?.readiness === "blocked") {
          fail(`Agent provider '${cli}' is blocked${override.blockedReason ? `: ${override.blockedReason}` : ""}. Remediation: Resolve the provider policy/workspace block and verify with 'bflow agent check ${cli}' or 'bflow doctor'.`, {
            component: `provider:${cli}`,
            remediation: `Resolve the provider policy/workspace block and verify with 'bflow agent check ${cli}' or 'bflow doctor'.`
          });
        }

      }

      this.progress("Composing session lifecycle integration...");
      const compositionConfig = fallbackNotices.length > 0
        ? { ...config, environment: { ...config.environment, roles: rolesToRun } }
        : config;
      const integration = await deadline.call(() => this.integration(repository, compositionConfig));
      if (!integration) fail("P13 SessionLifecycleManager is not composed. Supply CliContext.environment.openIntegration or BFLOW_ENVIRONMENT_MODULE; no roles were started.");

      let cleanupEligible = false;
      let roleDispatchAttempted = false;
      let startupError: unknown;
      let outcome: SessionManifest | undefined;
      try {
        this.progress("Inspecting existing session state...");
        const previous = await this.intent(repository);
        const saved = await this.savedManifest(repository);
        const running = await this.probe(repository, config, deadline);
        if (previous?.phase === "stopping" && running) fail("An interrupted shutdown must finish first. Run bflow down --yes, then bflow up. If pane cleanup is stuck, run bflow down --force. State and worktrees are preserved.");
        if (running && previous === null && saved === null) fail("Named session already exists without repository ownership evidence; refusing to adopt it");

        // Step 8: reconcile_herdr_session_and_panes
        let manifestRaw = unwrap(await deadline.call((opts) => integration.manager.getManifest(repository.sessionName, opts)));
        let manifest = manifestRaw === null ? null : this.validateManifest(manifestRaw, repository);
        if (running && previous?.phase === "manager_pending" && (manifest !== null || saved !== null)) cleanupEligible = true;
        if (!running) {
          if (previous?.phase === "server_starting") {
            if (!previous.serverPid) fail("Startup was interrupted before its server acknowledgement. Run bflow recover --yes after stopping any old Bflow command, then bflow up. State is preserved.");
            if (this.processAlive(previous.serverPid)) fail(`Startup process ${previous.serverPid} is still alive; wait and rerun bflow up. Use bflow status/doctor to inspect it; no duplicate server was started.`);
          }
          cleanupEligible = true;
          await this.writeIntent(repository, "server_starting");
          await mkdir(resolve(repository.root, ".bflow/logs"), { recursive: true, mode: 0o700 });
          this.progress("Starting Herdr headless server...");
          const started = await this.runner.run({ executable: config.environment.herdrBinary, args: ["server"], cwd: repository.root,
            env: namedSessionEnvironment(repository.sessionName), mode: "background", logPath: resolve(repository.root, ".bflow/logs/herdr.log") });
          if (started.exitCode !== 0) fail(`Herdr headless server failed to start: ${started.stderr}`);
          if (started.pid) await this.writeJson(repository, "operation.json", { repositoryId: repository.id, sessionName: repository.sessionName, phase: "server_starting", serverPid: started.pid });
          while (!await this.probe(repository, config, deadline)) await deadline.pause();
        } else {
          this.progress("Reusing running Herdr server...");
        }

        if (this.dependencies.mcpState) {
          this.dependencies.mcpState.activeRepositories?.add(repository.id);
          this.dependencies.mcpState.sessionRegistrations?.set(repository.sessionName, [...requiredMcp]);
        }

        // Step 9: start_required_agents
        if (!running || manifest === null || manifest.status === "down" || manifest.status === "degraded" || manifest.metadata?.["panePresentationVersion"] !== 1 || previous?.phase === "manager_pending") {
          if (previous?.phase === "manager_pending" && manifest === null)
            fail("Earlier role startup has no recoverable pane receipt; refusing duplicate agents. Run bflow down --yes to reconcile and stop the partial startup, then bflow up. Preserve .bflow.");
          if (integration.prepareRoles) {
            this.progress("Preparing provider environments and readiness...");
            await deadline.call(opts => integration.prepareRoles!(opts));
          }
          await this.writeIntent(repository, "manager_pending");
          cleanupEligible = true;
          roleDispatchAttempted = true;
          this.progress("Starting agent roles...");
          manifest = this.validateManifest(unwrap(await deadline.call((opts) => integration.manager.up(repository.sessionName, opts))), repository);
        } else {
          this.progress("Reconciling agent roles...");
        }

        // Step 10: confirm_roles_ready
        let reportedWaiting = false;
        let lastStartupObservation: string | undefined;
        const observeStartup = (message: string) => {
          if (message === lastStartupObservation) return;
          lastStartupObservation = message;
          this.progressDetail(message);
        };
        let reportedActivating = false;
        while (true) {
          const startupObservations: string[] = [];
          const nativeReady = !integration.requiresNativeSession || manifest.panes.filter(p => p.permanent).every(p => p.session);
          if ((!nativeReady || !this.ready(manifest, config)) && !reportedWaiting) {
            this.progress("Waiting for role transport and native readiness...");
            reportedWaiting = true;
          }
          if (!nativeReady) {
            deadline.context = `Waiting for native-session hooks: ${manifest.panes.filter(p => p.permanent && !p.session).map(p => `${p.role} (${p.paneId})`).join(", ")}. Inspect this session with herdr --session ${repository.sessionName} session attach ${repository.sessionName}; resolve its provider dialogs, then bflow up. State was preserved.`;
            startupObservations.push(`Waiting for native-session hooks: ${manifest.panes.filter(p => p.permanent && !p.session).map(p => p.role).join(", ")}`);
          }
          await this.saveManifest(repository, { ...manifest, status: manifest.status === "up" && (!this.ready(manifest, config) || !nativeReady) ? "initializing" : manifest.status });

          for (const p of manifest.panes) {
            if (config.environment.roles.some((r) => r.role !== "developer" && r.role === p.role && (r.required ?? true))) {
              if (p.metadata?.["partialStart"] === true || p.metadata?.["startupStatus"] === "partial") {
                await this.saveManifest(repository, { ...manifest, status: "degraded" });
                fail(`Agent provider for role '${p.role}' only partially started. Remediation: Inspect role pane logs via 'bflow doctor' or restart the session with 'bflow down --yes && bflow up'.`, { component: `role:${p.role}` });
              }
            }
          }

          const blocked = manifest.panes.find((p) => config.environment.roles.some((r) => r.role !== "developer" && r.role === p.role && (r.required ?? true)) && p.transportState === "blocked");
          if (blocked) {
            await this.saveManifest(repository, { ...manifest, status: "degraded" });
            fail(`Required role '${blocked.role}' is blocked during startup in pane '${blocked.paneId}'. Resolve it before retrying up.`);
          }

          if (this.ready(manifest, config) && nativeReady) {
            if (integration.activate) {
              if (!reportedActivating) {
                this.progress("Activating persistent runtime host...");
                reportedActivating = true;
              }
              try { await deadline.call(opts => integration.activate!(manifest!, opts)); }
              catch (error) {
                if (!(error instanceof EnvironmentError) || error.contractError.details === null || typeof error.contractError.details !== "object" ||
                    Array.isArray(error.contractError.details) || error.contractError.details.stage !== "native_startup") throw error;
                deadline.context = `${error.message} Run bflow status/doctor; resolve startup in its named pane, then bflow up, or bflow down --yes for a checked restart. Do not delete .bflow.`;
                observeStartup(deadline.context);
                await deadline.pause(); continue;
              }
            }
            break;
          }

          const missingOrStarting = config.environment.roles.filter(r => r.role !== "developer" && (r.required ?? true)).find(r => {
            const p = manifest!.panes.find(pane => pane.role === r.role);
            return !p || !this.readyPane(p);
          });
          if (missingOrStarting) {
            const roleName = missingOrStarting.role;
            const p = manifest.panes.find(pane => pane.role === roleName);
            const details = !p ? `missing pane for role '${roleName}'` : `role '${roleName}' in state '${p.transportState}'`;
            startupObservations.push(`Waiting for required roles: ${details}`);
            deadline.context = `timed out waiting for required roles to become ready (${details}). Remediation: Run 'bflow doctor' to inspect provider startup or 'bflow down --yes' to clean up.`;
          }

          // Native and transport observations share one mutable terminal line.
          // Deduplicate the combined current state so a resolved blocker cannot remain visible.
          observeStartup(startupObservations.join("; "));
          await deadline.pause();
          manifestRaw = unwrap(await deadline.call((opts) => integration.manager.getManifest(repository.sessionName, opts)));
          if (manifestRaw === null) fail("Role manager lost the startup manifest; startup outcome is unresolved");
          manifest = this.validateManifest(manifestRaw, repository);
        }

        if (!await this.probe(repository, config, deadline)) fail("Herdr server stopped before roles became ready");
        await this.writeIntent(repository, "ready");

        // Step 11: persist_environment_manifest
        const completedSteps = [
          "load_project_config",
          "validate_required_providers",
          "validate_binaries_and_auth",
          "validate_permissions_and_trust",
          "validate_required_mcp",
          "validate_skills",
          "verify_agent_readiness_preflight",
          "reconcile_herdr_session_and_panes",
          "start_required_agents",
          "confirm_roles_ready",
          "persist_environment_manifest",
          "report_success"
        ];
        const updatedMetadata: Record<string, unknown> = {
          ...(manifest.metadata ?? {}),
          repositoryId: repository.id,
          sessionName: repository.sessionName,
          stepsCompleted: completedSteps,
          ...(fallbackNotices.length > 0 ? { providerFallbacks: fallbackNotices } : {})
        };
        const finalManifest = await this.saveManifest(repository, { ...manifest, metadata: updatedMetadata });
        // Step 12: report_success
        outcome = finalManifest;
      } catch (error) {
        startupError = error;
      }
      let cleanupOutcome: string | undefined;
      if (startupError !== undefined && cleanupEligible) {
        try {
          if (roleDispatchAttempted && startupError instanceof EnvironmentError && ["timeout", "cancelled", "unknown_delivery"].includes(startupError.contractError.code)) {
            const cleanupDeadline = new Deadline(config.environment.shutdownTimeoutMs);
            const receipt = unwrap(await cleanupDeadline.call(opts => integration.manager.getManifest(repository.sessionName, opts)));
            if (receipt === null) fail("Startup delivery is uncertain and the manager has no recoverable pane receipt; state was preserved for reconciliation.");
            this.validateManifest(receipt, repository);
          }
          await this.downLocked(repository, config, true, undefined, undefined, integration);
          cleanupOutcome = "completed successfully";
        } catch (cleanupError) {
          cleanupOutcome = `failed and preserved the operation receipt and recovery state (${String(cleanupError)})`;
        }
      }
      let closeError: unknown;
      try { await new Deadline(config.environment.shutdownTimeoutMs).call(() => integration.close?.() ?? Promise.resolve()); }
      catch (error) {
        closeError = error;
        if (startupError === undefined) startupError = error;
      }
      if (closeError !== undefined && startupError !== closeError)
        cleanupOutcome = `${cleanupOutcome ?? "cleanup outcome is unknown"}; startup integration close also failed (${String(closeError)})`;
      if (closeError !== undefined && cleanupEligible && cleanupOutcome === undefined) {
        try {
          await this.downLocked(repository, config, true);
          cleanupOutcome = "completed after the startup integration failed to close";
        } catch (cleanupError) {
          cleanupOutcome = `failed after the startup integration failed to close (${String(cleanupError)})`;
        }
      }
      if (startupError !== undefined) throw this.startupFailureWithCleanup(startupError,
        cleanupOutcome ?? (cleanupEligible ? "was not completed" : "was not attempted because startup had not changed the session"));
      if (!outcome) fail("Startup completed without a session manifest.");
      await rm(this.statePath(repository, "operation.json"), { force: true });
      return outcome;
    });
  }
  async attach(): Promise<SessionManifest> {
    this.progress("Validating session and focusing Conversation pane...");
    const repository = await identifyRepository(this.cwd, this.runner);
    const config = await readEnvironmentConfig(repository);
    const manifest = await this.savedManifest(repository);
    if (!manifest || manifest.status === "down") fail("No active repository session. Run bflow up before attach.");
    const deadline = new Deadline(config.environment.startupTimeoutMs);
    if (!await this.probe(repository, config, deadline)) fail("Repository session is stopped. Run bflow up before attach.");
    const integration = await deadline.call(() => this.integration(repository, config));
    if (!integration) fail("P13 SessionLifecycleManager is unavailable; cannot verify/focus Conversation pane");
    try {
      const live = unwrap(await deadline.call((opts) => integration.manager.getManifest(repository.sessionName, opts)));
      if (live === null) fail("No live manifest for repository session");
      const current = this.validateManifest(live, repository);
      if (current.status !== "up" && current.status !== "degraded") fail("Repository session is not attachable");
      const pane = PaneBindingSchema.parse(unwrap(await deadline.call((opts) => integration.manager.attach(repository.sessionName, opts))));
      if (pane.sessionId !== repository.sessionName || pane.role !== "conversation" || pane.paneId !== current.attachTarget.paneId ||
        !current.panes.some((p) => p.paneId === pane.paneId && p.agentId === pane.agentId && p.workspaceId === pane.workspaceId && p.tabId === pane.tabId)) fail("Manager returned an incorrect Conversation attach target");
      if (!await this.probe(repository, config, deadline)) fail("Session stopped before attach");
      this.progress("Opening Herdr interactive terminal attach...");
      // session attach NAME is allowed only after positive live-session checks above.
      const attached = await this.runner.run({ executable: config.environment.herdrBinary, args: ["session", "attach", repository.sessionName],
        cwd: repository.root, env: namedSessionEnvironment(repository.sessionName), mode: "interactive" });
      if (attached.exitCode !== 0) fail(`Herdr TUI attach failed: ${attached.stderr || attached.exitCode}`);
      return current;
    } finally { await integration.close?.(); }
  }
  async down(confirmed = false, timeoutMs?: number, force = false): Promise<SessionManifest | EnvironmentStatus> {
    this.progress("Inspecting session state and running workflows...");
    const repository = await identifyRepository(this.cwd, this.runner);
    const config = await readEnvironmentConfig(repository);
    try {
      return await this.locked(repository, () => this.downLocked(repository, config, confirmed || force, timeoutMs, this.dependencies.signal, undefined, force));
    } catch (error) {
      // Only a host that cannot run the barrier at all is bypassed: an incompatible build, or an unactivated host that
      // refuses to quiesce over persisted work. Journal/run store stay on disk and the next `up` reconciles them.
      // Genuine barrier/checkpoint failures on an active host still abort a forced stop.
      if (!force || !/Unknown host operation|requires activation\/reconciliation before safe shutdown/.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    this.progress("Host daemon cannot run the shutdown barrier; force-stopping it. Durable state is preserved and the next 'bflow up' reconciles it.");
    return this.locked(repository, () => this.forceStopIncompatibleHost(repository, config, timeoutMs));
  }
  private async forceStopIncompatibleHost(repository: RepositoryIdentity, config: EnvironmentConfig, timeoutMs?: number): Promise<SessionManifest | EnvironmentStatus> {
    const deadline = new Deadline(timeoutMs ?? config.environment.shutdownTimeoutMs, this.dependencies.signal);
    const saved = await this.savedManifest(repository);
    const integration = await deadline.call(() => this.integration(repository, config));
    if (!integration?.terminateIncompatibleHost) fail("The incompatible host cannot be stopped by this CLI; state was preserved. Run bflow doctor.");
    try {
      await this.writeIntent(repository, "stopping");
      if (await this.probe(repository, config, deadline)) {
        this.progress("Force-stopping this repository's Herdr session...");
        try { await this.command(repository, config.environment.herdrBinary, ["session", "stop", repository.sessionName, "--json"], deadline); }
        catch (error) { if (await this.probe(repository, config, deadline)) throw error; }
        while (await this.probe(repository, config, deadline)) await deadline.pause();
      }
      this.progress("Stopping incompatible host process...");
      await deadline.call(() => integration.terminateIncompatibleHost!());
      await this.writeIntent(repository, "down");
      this.cleanupMcpSession(repository);
      if (!saved) return { workspaceRoot: repository.root, sessionName: repository.sessionName, server: "stopped" as const,
        configuration: "valid" as const, manifest: null, liveObservation: true, issues: [] };
      const at = new Date().toISOString();
      return await this.saveManifest(repository, { ...saved, status: "down", updatedAt: at, stoppedAt: at,
        panes: saved.panes.map(pane => ({ ...pane, transportState: "cancelled", lastHeartbeatAt: at })),
        metadata: { ...saved.metadata, shutdownMode: "force_incompatible_host" } });
    } finally { await deadline.call(() => integration.close?.() ?? Promise.resolve()); }
  }
  private async downLocked(repository: RepositoryIdentity, config: EnvironmentConfig, confirmed: boolean, timeoutMs?: number, signal?: AbortSignal,
    suppliedIntegration?: EnvironmentIntegration, force = false): Promise<SessionManifest | EnvironmentStatus> {
      const deadline = new Deadline(timeoutMs ?? config.environment.shutdownTimeoutMs, signal);
      const acquire = () => suppliedIntegration ? Promise.resolve(suppliedIntegration) : deadline.call(() => this.integration(repository, config));
      let saved = await this.savedManifest(repository);
      if (!saved) {
        // A blocked first role may leave only P13's durable startup receipt.
        // Recover ownership from that validated receipt, never from session name alone.
        const prior = await this.intent(repository);
        if (!prior || !["server_starting", "manager_pending", "down"].includes(prior.phase)) fail("No repository manifest. Run bflow status or bflow doctor; no session was stopped.");
        if (!await this.probe(repository, config, deadline)) {
          if (prior.serverPid && this.processAlive(prior.serverPid)) fail(`Startup process ${prior.serverPid} is still alive. Wait before retrying down; state was preserved.`);
          await this.writeIntent(repository, "down");
          this.cleanupMcpSession(repository);
          return { workspaceRoot: repository.root, sessionName: repository.sessionName, server: "stopped" as const,
            configuration: "valid" as const, manifest: null, liveObservation: true, issues: [] };
        }
        const recovery = await acquire();
        if (!recovery) fail("No role manager can reconcile the partial startup; no session was stopped.");
        try {
          const observed = unwrap(await deadline.call(opts => recovery.manager.getManifest(repository.sessionName, opts)));
          if (observed) saved = this.validateManifest(observed, repository);
        } finally { if (recovery !== suppliedIntegration) await deadline.call(() => recovery.close?.() ?? Promise.resolve()); }
        if (!saved) {
          if (!confirmed) fail("Startup stopped before a pane manifest was saved. Run bflow down --yes to stop this repository's server after checking that no workflows are active. Do not delete .bflow.");
          this.progress("Stopping partial startup session...");
          const empty = await acquire();
          if (!empty?.runtime || !empty.quiesce) fail("Cannot establish runtime shutdown safety; preserve state and inspect bflow doctor.");
          try {
            this.progress("Establishing runtime shutdown barrier...");
            unwrap(await deadline.call(opts => empty.quiesce!(opts)));
            this.progress("Recollecting active workflow runs...");
            const page = unwrap(await deadline.call(opts => empty.runtime!.findRuns({ status: ["queued", "running", "waiting", "blocked", "cancelling"], limit: 1 }, opts)));
            if (page.items.length || page.nextCursor) fail("Active workflows require their recoverable manifest and checkpoints; no session was stopped.");
            this.progress("Stopping Herdr session...");
            await this.command(repository, config.environment.herdrBinary, ["session", "stop", repository.sessionName, "--json"], deadline);
            while (await this.probe(repository, config, deadline)) await deadline.pause();
            this.progress("Shutting down persistent host...");
            if (empty.shutdownHost) await deadline.call(() => empty.shutdownHost!());
            await this.writeIntent(repository, "down");
            this.cleanupMcpSession(repository);
            return { workspaceRoot: repository.root, sessionName: repository.sessionName, server: "stopped" as const,
              configuration: "valid" as const, manifest: null, liveObservation: true, issues: [] };
          } finally { if (empty !== suppliedIntegration) await deadline.call(() => empty.close?.() ?? Promise.resolve()); }
        }
      }
      const running = await this.probe(repository, config, deadline);
      if (!running) {
        this.progress("Session server is stopped; reconciling state...");
        const offline = await acquire();
        if (offline?.shutdownHost) try {
          if (!offline.runtime || !offline.quiesce) fail("Cannot drain the retained host safely; state was preserved.");
          await this.writeIntent(repository, "stopping");
          this.progress("Establishing runtime shutdown barrier...");
          unwrap(await deadline.call(opts => offline.quiesce!(opts)));
          this.progress("Recollecting active workflow runs...");
          const active = new Map<string, { version: number }>(); let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            const page = unwrap(await deadline.call(opts => offline.runtime!.findRuns({ status: ["queued", "running", "waiting", "blocked", "cancelling"], limit: 500, ...(cursor ? { cursor } : {}) }, opts)));
            for (const input of page.items) { const run = WorkflowRunSnapshotSchema.parse(input); if (!["succeeded", "failed", "cancelled"].includes(run.status)) active.set(run.runId, { version: run.version }); }
            if (!page.nextCursor) break;
            if (seen.has(page.nextCursor)) fail("Runtime pagination did not advance during stopped-session recovery");
            cursor = page.nextCursor; seen.add(cursor);
          } while (true);
          for (const runId of saved.activeRunIds) if (!active.has(runId)) {
            const input = unwrap(await deadline.call(opts => offline.runtime!.getRun(runId, opts)));
            if (!input) fail(`Retained host cannot resolve run '${runId}'; no recovery state was cleared.`);
            const run = WorkflowRunSnapshotSchema.parse(input); if (!["succeeded", "failed", "cancelled"].includes(run.status)) active.set(runId, { version: run.version });
          }
          if (active.size > 0) {
            this.progress(`Writing aggregate checkpoints for ${active.size} active run(s)...`);
          }
          await this.checkpointRuns(offline, active, deadline);
          this.progress("Shutting down persistent host...");
          await deadline.call(() => offline.shutdownHost!());
        } finally { if (offline !== suppliedIntegration) await deadline.call(() => offline.close?.() ?? Promise.resolve()); }
        await this.writeIntent(repository, "down");
        this.cleanupMcpSession(repository);
        return this.saveManifest(repository, { ...saved, status: "down", updatedAt: new Date().toISOString(), stoppedAt: new Date().toISOString() });
      }
      const integration = await acquire();
      if (!integration) fail("Runtime is unavailable; cannot inspect active runs/checkpoint safely. Session remains running.");
      try {
        if (!integration.runtime) fail("Runtime is unavailable; cannot inspect active runs/checkpoint safely. Session remains running.");
        // Force uses the validated durable ownership receipt. A stale/unavailable pane
        // lookup must not prevent the Runtime barrier and authoritative session stop.
        let manifest = saved;
        if (!force) {
          const live = unwrap(await deadline.call((opts) => integration.manager.getManifest(repository.sessionName, opts)));
          if (live === null) fail("Role manager cannot reconcile the live session; refusing shutdown");
          manifest = this.validateManifest(live, repository);
        }
        const activeRuns = new Map<string, { version: number }>();
        const collectActiveRuns = async () => {
          activeRuns.clear();
          let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            const page = unwrap(await deadline.call((opts) => integration.runtime!.findRuns({ status: ["queued", "running", "waiting", "blocked", "cancelling"], limit: 500, ...(cursor ? { cursor } : {}) }, opts)));
            for (const run of page.items) {
              const parsed = WorkflowRunSnapshotSchema.parse(run);
              if (!["succeeded", "failed", "cancelled"].includes(parsed.status)) activeRuns.set(parsed.runId, { version: parsed.version });
            }
            if (!page.nextCursor) break;
            if (typeof page.nextCursor !== "string" || seen.has(page.nextCursor)) fail("Runtime pagination did not advance; cannot establish shutdown safety");
            cursor = page.nextCursor; seen.add(cursor);
          } while (true);
          for (const id of manifest.activeRunIds) if (!activeRuns.has(id)) {
            const result = unwrap(await deadline.call((opts) => integration.runtime!.getRun(id, opts)));
            if (result === null) fail(`Runtime cannot resolve manifest run '${id}'`);
            const run = WorkflowRunSnapshotSchema.parse(result);
            if (!["succeeded", "failed", "cancelled"].includes(run.status)) activeRuns.set(id, { version: run.version });
          }
        };
        await collectActiveRuns();
        const changes = await this.command(repository, "git", ["status", "--porcelain=v1", "--untracked-files=normal"], deadline);
        const busy = manifest.panes.some((p) => ["working", "starting", "accepted", "unknown", "disconnected", "blocked"].includes(p.transportState));
        if ((changes.trim() || activeRuns.size || busy) && !confirmed) fail(`Unsafe shutdown: ${activeRuns.size} active runs${changes.trim() ? ", uncommitted changes" : ""}${busy ? ", busy/unresolved agents" : ""}. Inspect state and rerun bflow down --yes to confirm. Nothing was stopped.`);
        if (activeRuns.size && !integration.checkpoint) fail("Runtime checkpoint/quiesce API is unavailable. --yes cannot bypass recovery checkpoint requirements.");
        if (!integration.quiesce) fail("Runtime shutdown barrier is unavailable; cannot stop intake/dispatch safely.");
        await this.writeIntent(repository, "stopping");
        this.progress("Establishing runtime shutdown barrier...");
        unwrap(await deadline.call((opts) => integration.quiesce!(opts)));
        // Runs may have advanced or appeared between the safety inspection and the barrier.
        this.progress("Recollecting active workflow runs...");
        await collectActiveRuns();
        if (activeRuns.size && !integration.checkpoint) fail("Runtime checkpoint/quiesce API is unavailable after shutdown barrier");
        if (activeRuns.size > 0) {
          this.progress(`Writing aggregate checkpoints for ${activeRuns.size} active run(s)...`);
        }
        await this.checkpointRuns(integration, activeRuns, deadline);
        await this.saveManifest(repository, { ...manifest, status: "stopping" });
        let stopped: SessionManifest | undefined;
        if (!force) {
          this.progress("Stopping agent roles gracefully...");
          try {
            stopped = this.validateManifest(unwrap(await deadline.call((opts) => integration.manager.down(repository.sessionName, opts))), repository);
            if (stopped.status !== "down") fail("Role manager did not confirm graceful shutdown; session was not force-stopped");
          } catch (error) {
            if (error instanceof EnvironmentError) throw new EnvironmentError({ ...error.contractError,
              message: error.message + " Run bflow down --force to finish stopping this repository session after checkpointing; state and worktrees are preserved." });
            throw error;
          }
        } else {
          deadline.context = "Force shutdown has not been confirmed. State/checkpoints are preserved; run bflow status, then bflow down --force to reconcile.";
        }
        this.progress(force ? "Force-stopping this repository's Herdr session..." : "Stopping Herdr session...");
        if (await this.probe(repository, config, deadline)) {
          try {
            await this.command(repository, config.environment.herdrBinary, ["session", "stop", repository.sessionName, "--json"], deadline);
          } catch (error) {
            // A lost acknowledgement is conclusive only after a fresh correlated
            // observation proves the server stopped. Never resend an uncertain stop.
            if (!force || await this.probe(repository, config, deadline)) throw error;
          }
        }
        while (await this.probe(repository, config, deadline)) await deadline.pause();
        if (!stopped) {
          const at = new Date().toISOString();
          stopped = this.validateManifest({ ...manifest, status: "down", updatedAt: at, stoppedAt: at,
            panes: manifest.panes.map(pane => ({ ...pane, transportState: "cancelled", lastHeartbeatAt: at })),
            metadata: { ...manifest.metadata, shutdownMode: "force" } }, repository);
        }
        await this.saveManifest(repository, { ...stopped, status: "stopping" });
        this.progress("Shutting down persistent host...");
        if (integration.shutdownHost) await deadline.call(() => integration.shutdownHost!());
        await this.writeIntent(repository, "down");
        const finalManifest = await this.saveManifest(repository, stopped);
        this.cleanupMcpSession(repository);
        return finalManifest;
      } finally { if (integration !== suppliedIntegration) await deadline.call(() => integration.close?.() ?? Promise.resolve()); }
  }
  async status(): Promise<EnvironmentStatus> {
    this.progress("Reading repository configuration and saved session state...");
    const repository = await identifyRepository(this.cwd, this.runner);
    const issues: string[] = [];
    let config: EnvironmentConfig;
    try { config = await readEnvironmentConfig(repository); }
    catch (error) { return { workspaceRoot: repository.root, sessionName: repository.sessionName, server: "unknown", configuration: "invalid", manifest: null, liveObservation: false, issues: [String(error)] }; }
    let manifest: SessionManifest | null = null;
    let server: EnvironmentStatus["server"] = "unknown";
    let liveObservation = false;
    try { manifest = await this.savedManifest(repository); } catch (error) { issues.push(String(error)); }
    try {
      const intent = await this.intent(repository);
      if (intent && ["server_starting", "manager_pending", "stopping"].includes(intent.phase))
        issues.push(`Environment operation '${intent.phase}' was interrupted. ${intent.phase === 'stopping' ? 'Run bflow down --yes to finish shutdown, then bflow up.' : 'Run bflow up to reconcile existing panes; if there is no recoverable receipt, bflow down --yes stops the partial startup.'} Preserve .bflow.`);
    } catch (error) { issues.push(String(error)); }
    this.progress("Checking session server and dependencies...");
    try { server = await this.probe(repository, config) ? "running" : "stopped"; } catch (error) { issues.push(String(error)); }
    for (const executable of new Set([config.environment.herdrBinary, ...config.environment.roles.map((r) => r.cli)])) {
      try { await this.command(repository, executable, ["--version"]); }
      catch (error) { issues.push(`Missing/unavailable dependency '${executable}': ${String(error)}`); }
    }
    if (server === "running") {
      this.progress("Reconciling live role observations...");
      const integration = await new Deadline(5000).call(() => this.integration(repository, config)).catch((error: unknown) => { issues.push(String(error)); return undefined; });
      if (integration) try {
        const deadline = new Deadline(5000);
        const current = unwrap(await deadline.call((opts) => integration.manager.getManifest(repository.sessionName, opts)));
        manifest = current === null ? null : this.validateManifest(current, repository);
        liveObservation = true;
      } catch (error) { issues.push(String(error)); } finally { await integration.close?.(); }
      else issues.push("P13 manager unavailable; pane/agent state is the last persisted observation");
    }
    return { workspaceRoot: repository.root, sessionName: repository.sessionName, server, configuration: "valid", manifest, liveObservation, issues };
  }
  async doctor(deep = false): Promise<EnvironmentDoctorReport> {
    this.progress("Reading repository configuration for diagnostics...");
    const repository = await identifyRepository(this.cwd, this.runner);
    let config: EnvironmentConfig | null = null;
    try { config = await readEnvironmentConfig(repository); } catch {}
    return runDoctorDiagnostics({
      repository,
      config,
      runner: this.runner,
      env: this.env,
      dependencies: this.dependencies,
      deep,
      probeSession: (cfg) => this.probe(repository, cfg),
      integration: (cfg) => this.integration(repository, cfg),
      intent: () => this.intent(repository),
      statePath: (name) => this.statePath(repository, name)
    });
  }
}
