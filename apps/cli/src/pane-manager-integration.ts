import { basename, resolve } from "node:path";
import {
  EnvironmentDoctorReportSchema, PaneBindingSchema, SessionManifestSchema,
  type ContractError, type EnvironmentDoctorReport, type OperationOptions, type OperationResult,
  type PaneBinding, type SessionLifecycleManager, type SessionManifest
} from "@bflow/contracts";
import {
  FileSessionManifestStore, RolePaneManager, createHerdrSocketPort, isSupportedAgentKind, resolveTopologyRole,
  type AgentLaunchProfile, type HerdrCommandRunner, type HerdrSocketPort, type PermanentTopologyRole, type RoleAgentConfig,
  type SessionManifestStore, type TopologyRole
} from "@bflow/pane-manager";
import type { HostPrepareResponse } from "@bflow/runtime";
import type { EnvironmentCompositionInput, EnvironmentIntegration } from "./environment.js";
import { EnvironmentError } from "./environment.js";
import { environmentProcessRunner, namedSessionEnvironment, type EnvironmentProcessRunner } from "./environment-process.js";
import { openLifecycleHost, providerRoleArguments, type LifecycleHost, type LifecycleHostFactory } from "./agentic-host.js";
import { RoleStartupChecks } from "./role-startup-checks.js";
import { formatPlatformNotReady } from "./platform-options.js";
import { isGovernanceRoleConfig } from "./environment-config.js";

function failure<T>(message: string): OperationResult<T> {
  return { ok: false, error: { code: "validation", retryable: false, message } };
}

/** Real P13 command execution, scoped to one repository session without global env mutation. */
export function createNamedPaneRunner(input: EnvironmentCompositionInput, runner: EnvironmentProcessRunner): HerdrCommandRunner {
  return { async run(invocation) {
    if (invocation.signal?.aborted) return { exitCode: null, stdout: "", stderr: "", failure: "aborted", started: false };
    try {
      const result = await runner.run({ executable: input.config.environment.herdrBinary, args: invocation.args,
        cwd: input.repository.root, env: namedSessionEnvironment(input.repository.sessionName, input.env),
        ...(invocation.signal ? { signal: invocation.signal } : {}),
        ...(invocation.timeoutMs !== undefined ? { timeoutMs: invocation.timeoutMs } : {}) });
      return { ...result, started: true };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      return { exitCode: null, stdout: "", stderr: "", started: code === "ENOENT" || code === "EACCES" ? false : true,
        failure: invocation.signal?.aborted ? "aborted" : cause.includes("timed out") ? "timeout" : code === "ENOENT" || code === "EACCES" ? "spawn" : "runner", cause };
    }
  } };
}

/** Socket API port used to create env-bearing panes; injectable so tests can model Herdr without a Unix socket. */
export type PaneSocketFactory = (input: EnvironmentCompositionInput, runner: EnvironmentProcessRunner) => HerdrSocketPort;
export const defaultPaneSocket: PaneSocketFactory = (input, runner) =>
  createHerdrSocketPort({ runner: createNamedPaneRunner(input, runner), sessionId: input.repository.sessionName });

/** Adapt P13's topology API to the frozen lifecycle port; no topology implementation lives here. */
export class PaneManagerLifecycleAdapter implements SessionLifecycleManager {
  private readonly store: SessionManifestStore;
  private readonly panes: RolePaneManager;
  private persistenceFailure: ContractError | undefined;
  constructor(private readonly input: EnvironmentCompositionInput, private readonly runner = environmentProcessRunner,
    roleArguments: Partial<Record<TopologyRole, readonly string[]>> = {}, roleLaunches: Partial<Record<TopologyRole, AgentLaunchProfile>> = {},
    socketFactory: PaneSocketFactory = defaultPaneSocket,
    onPublished?: (manifest: SessionManifest, options?: OperationOptions) => void) {
    const roles: PermanentTopologyRole[] = [];
    const roleConfigs: Partial<Record<TopologyRole, Partial<RoleAgentConfig>>> = {};
    for (const role of input.config.environment.roles) {
      const topologyRole = resolveTopologyRole(role.role);
      // Developer is a Runtime-launched task/worktree role. Its optional config entry
      // supplies a dynamic launch template and never creates a permanent P13 pane.
      // The sos role is spawned on demand by an exact BFLOWSOS chat turn, never at startup.
      if (role.role === "developer" || role.role === "sos") continue;
      if (topologyRole === null || topologyRole === "developer") {
        throw new Error(`Role '${role.role}' is not a permanent P13 role. Developers must be allocated by Runtime in task worktrees.`);
      }
      const kind = basename(role.cli);
      if (kind !== role.cli || !isSupportedAgentKind(kind)) throw new Error(`P13 requires a supported agent kind on PATH; custom executable '${role.cli}' is not supported`);
      roles.push(topologyRole);
      // Native arguments are owned by P13. No code, prompts or assignments are dispatched by P12.
      // A host-prepared v3 launch profile supersedes legacy argument injection for the same role.
      roleConfigs[topologyRole] = { agentKind: kind, startupTimeoutMs: input.config.environment.startupTimeoutMs,
        ...(roleLaunches[topologyRole] ? { launch: roleLaunches[topologyRole] } : {}),
        ...(roleArguments[topologyRole] ? { args: roleArguments[topologyRole] } : {}) };
    }
    const diskStore = new FileSessionManifestStore(resolve(input.repository.root, ".bflow/state/panes"));
    this.store = {
      load: async (sessionId, options) => {
        if (sessionId !== input.repository.sessionName) return failure("Foreign session requested from P13 manifest store");
        const result = await diskStore.load(sessionId, options);
        if (!result.ok || result.value === null) return result;
        return this.validate(result.value);
      },
      save: async (manifest, options) => {
        const validated = this.validate(manifest);
        const saved = validated.ok ? await diskStore.save(validated.value, options) : validated;
        if (!saved.ok) this.persistenceFailure = saved.error;
        else onPublished?.(saved.value, options);
        return saved;
      },
      delete: (sessionId, options) => sessionId === input.repository.sessionName
        ? diskStore.delete(sessionId, options) : Promise.resolve(failure("Foreign session requested from P13 manifest store"))
    };
    this.panes = new RolePaneManager({ config: {
      sessionId: input.repository.sessionName, workspaceRoot: input.repository.root, projectName: input.config.projectName,
      permanentRoles: roles, roleConfigs, maxDeveloperCapacity: input.config.environment.concurrency.maxConcurrency
    }, runner: createNamedPaneRunner(input, runner), store: this.store, defaultTimeoutMs: input.config.environment.startupTimeoutMs,
      // Launch env (Gateway tokens) must be set when a pane is created: Herdr agent start never forwards invocation env.
      socket: socketFactory(input, runner) });
  }
  private validate(raw: unknown): OperationResult<SessionManifest> {
    const result = SessionManifestSchema.safeParse(raw);
    if (!result.success) return failure(`Invalid P13 manifest: ${result.error.message}`);
    if (result.data.sessionId !== this.input.repository.sessionName || result.data.workspaceRoot !== this.input.repository.root ||
      result.data.metadata?.["repositoryId"] !== undefined && result.data.metadata["repositoryId"] !== this.input.repository.id)
      return failure("P13 manifest belongs to another repository/session");
    return { ok: true, value: SessionManifestSchema.parse({ ...result.data,
      metadata: { ...result.data.metadata, repositoryId: this.input.repository.id, sessionName: this.input.repository.sessionName } }) };
  }
  private matches(sessionId: string): boolean { return sessionId === this.input.repository.sessionName; }
  async init(manifest: SessionManifest, options?: OperationOptions): Promise<OperationResult<SessionManifest>> {
    const validated = this.validate(manifest);
    return validated.ok ? this.store.save(validated.value, options) : validated;
  }
  async up(sessionId: string, options?: OperationOptions): Promise<OperationResult<SessionManifest>> {
    if (!this.matches(sessionId)) return failure("Cannot start another repository's session");
    const saved = await this.store.load(sessionId, options);
    if (!saved.ok) return saved;
    const result = saved.value === null ? await this.panes.initializeTopology(options) : await this.panes.reconcileTopology(options);
    return result.ok ? this.validate(result.value) : result;
  }
  async getManifest(sessionId: string, options?: OperationOptions): Promise<OperationResult<SessionManifest | null>> {
    if (!this.matches(sessionId)) return failure("Cannot inspect another repository's session");
    const stored = await this.store.load(sessionId, options);
    if (!stored.ok || stored.value === null || stored.value.status === "down") return stored;
    // P12 calls this before server startup as well as for live status. Offline reads retain persisted facts.
    const probe = await this.runner.run({ executable: this.input.config.environment.herdrBinary, args: ["status", "server", "--json"],
      cwd: this.input.repository.root, env: namedSessionEnvironment(sessionId, this.input.env),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options?.signal ? { signal: options.signal } : {}) });
    if (probe.exitCode !== 0) return failure(`Cannot verify P13 server status: ${probe.stderr}`);
    const status: unknown = JSON.parse(probe.stdout);
    if (status === null || typeof status !== "object" || !("session" in status) || status.session !== sessionId || !("running" in status) || typeof status.running !== "boolean")
      return failure("P13 server probe returned an uncorrelated session");
    if (!status.running) return stored;
    // getManifest() in P13 only reads disk. Refresh via P13 health inspection before returning it to CLI.
    const refreshed = await this.panes.inspectTopologyHealth(options);
    if (!refreshed.ok) return refreshed;
    // P13 currently ignores store.save's error in health/focus. Do not label an old snapshot as a live observation.
    if (this.persistenceFailure) return { ok: false, error: this.persistenceFailure };
    return this.store.load(sessionId, options);
  }
  async attach(sessionId: string, options?: OperationOptions): Promise<OperationResult<PaneBinding>> {
    if (!this.matches(sessionId)) return failure("Cannot focus another repository's session");
    const result = await this.panes.focusConversationPane(options);
    if (!result.ok) return result;
    if (this.persistenceFailure) return { ok: false, error: this.persistenceFailure };
    const pane = PaneBindingSchema.parse(result.value);
    if (pane.role !== "conversation" || pane.sessionId !== sessionId) return failure("P13 returned a foreign Conversation pane");
    return { ok: true, value: pane };
  }
  async down(sessionId: string, options?: OperationOptions): Promise<OperationResult<SessionManifest>> {
    if (!this.matches(sessionId)) return failure("Cannot stop another repository's session");
    const stopped = await this.panes.shutdownTopology(options);
    return stopped.ok ? this.validate(stopped.value) : stopped;
  }
  async doctorSession(_options: { workspaceRoot: string }): Promise<EnvironmentDoctorReport> {
    const root = this.input.repository.root;
    if (_options.workspaceRoot !== root) throw new Error("Cannot diagnose another repository");
    const current = await this.getManifest(this.input.repository.sessionName, { timeoutMs: 5000 });
    const checks: EnvironmentDoctorReport["checks"] = [{ checkId: "p13-composition", name: "P13 lifecycle adapter", status: "passed", message: "Real RolePaneManager with repository-scoped runner and FileSessionManifestStore" },
      { checkId: "runtime-shutdown", name: "Runtime graceful shutdown", status: "warn", message: "Pane shutdown is available; the provider host must quiesce and persist aggregate checkpoints before it is called." }];
    if (!current.ok) checks.push({ checkId: "p13-manifest", name: "P13 manifest", status: "failed", message: current.error.message });
    else if (!current.value) checks.push({ checkId: "p13-manifest", name: "P13 manifest", status: "warn", message: "No topology manifest yet. Run bflow up." });
    else {
      const stopped = current.value.status === "down";
      if (stopped) checks.push({ checkId: "p13-stopped", name: "Session lifecycle", status: "passed",
        message: "Session is stopped; cancelled pane records describe completed shutdown, not current readiness." });
      for (const pane of current.value.panes) {
        if (stopped && pane.transportState === "cancelled") continue;
        checks.push({ checkId: `pane-${pane.bindingId}`.slice(0, 200), name: `${pane.role}: ${pane.paneId}`,
          status: ["idle", "done", "working"].includes(pane.transportState) ? "passed" : "failed", message: `Agent ${pane.agentId}: ${pane.transportState}` });
      }
    }
    return EnvironmentDoctorReportSchema.parse({ schemaVersion: 2, workspaceRoot: root, sessionId: this.input.repository.sessionName,
      healthy: !checks.some((check) => check.status === "failed"), checks, checkedAt: new Date().toISOString() });
  }
}

export function openPaneManagerEnvironment(input: EnvironmentCompositionInput, runner: EnvironmentProcessRunner = environmentProcessRunner,
  hostFactory: LifecycleHostFactory = openLifecycleHost,
  launchArguments = providerRoleArguments, socketFactory: PaneSocketFactory = defaultPaneSocket): EnvironmentIntegration {
  // Read-only commands do not start a daemon. It is opened only for startup or
  // authoritative shutdown queries, and survives the invoking CLI's exit.
  let host: Promise<LifecycleHost> | undefined;
  const connect = () => host ??= hostFactory(input);
  let manager = new PaneManagerLifecycleAdapter(input, runner, {}, {}, socketFactory);
  // Latest platform preflight from this process; doctor reports it only when present.
  let lastPlatform: HostPrepareResponse["platform"];
  let prepared = false;
  let startupChecks: RoleStartupChecks | undefined;
  // Client cancellation closes its socket before the daemon necessarily finishes writing proofs.
  // A separate uncancelled control barrier must acknowledge drainage before destructive cleanup.
  let startupDrain: Promise<void> | undefined;
  const stopStartupChecks = () => startupDrain ??= (async () => {
    await startupChecks?.drain(true);
    if (host) {
      const active = await host;
      const drained = await active.drainRoleStartup?.();
      if (drained && !drained.ok) throw new EnvironmentError(drained.error);
    }
  })();
  const assertPreparationCurrent = (options?: OperationOptions) => {
    if (options?.signal?.aborted) throw new EnvironmentError({ code: "cancelled", retryable: false,
      message: "Role preparation was interrupted; reconcile the host before retrying." });
    if (options?.deadline !== undefined && Date.parse(options.deadline) <= Date.now())
      throw new EnvironmentError({ code: "timeout", retryable: true, retrySafety: "observation_only",
        message: "Role preparation exceeded the startup deadline; reconcile the host before retrying." });
  };
  const prepare = async (options?: OperationOptions): Promise<OperationResult<void>> => {
    const drained = await startupChecks?.drain(true);
    if (drained && !drained.ok) return drained;
    assertPreparationCurrent(options);
    const descriptors = await (await connect()).prepare(options);
    startupDrain = undefined;
    assertPreparationCurrent(options);
    lastPlatform = descriptors.platform;
    // Readiness is the host's verdict; a blocked report stops before any pane is created.
    if (descriptors.platform && !descriptors.platform.ready) return failure(formatPlatformNotReady(descriptors.platform));
    const args: Partial<Record<TopologyRole, readonly string[]>> = {};
    const launches: Partial<Record<TopologyRole, AgentLaunchProfile>> = {};
    for (const role of input.config.environment.roles) {
      if (role.role === "developer" || role.role === "sos") continue;
      const launch = descriptors.roleLaunch[role.role];
      const topology = resolveTopologyRole(role.role);
      if (!launch || !topology) return failure(`Host has no trusted launch descriptor for ${role.role}`);
      if (launch.launch) {
        if (launch.launch.provider !== role.cli)
          return failure(`Host prepared provider '${launch.launch.provider}' for role ${role.role}, but configuration selects '${role.cli}'.`);
        launches[topology] = launch.launch;
      } else {
        args[topology] = await launchArguments(role.cli, role.role, launch);
      }
    }
    startupChecks = new RoleStartupChecks(input.config.environment.roles.filter(isGovernanceRoleConfig).filter(role => role.role !== "developer" && (role.required ?? true)).map(role => role.role),
      async (manifest, role, operation) => {
        const active = await connect();
        return active.verifyRoleStartup ? active.verifyRoleStartup(manifest, role, operation) : { ok: true, value: undefined };
      }, Object.fromEntries(Object.entries(descriptors.roleLaunch).flatMap(([role, descriptor]) =>
        descriptor.launch ? [[role, { launchId: descriptor.launch.launchId, launchFingerprint: descriptor.launch.launchFingerprint }]] : [])));
    manager = new PaneManagerLifecycleAdapter(input, runner, args, launches, socketFactory, (manifest, operation) => startupChecks!.published(manifest, operation));
    prepared = true;
    return { ok: true, value: undefined };
  };
  return {
    requiresNativeSession: true,
    prepareRoles: async options => {
      const result = await prepare(options);
      if (!result.ok) throw new EnvironmentError(result.error);
    },
    manager: {
      init: (manifest, options) => manager.init(manifest, options),
      async up(sessionId, options) {
        if (sessionId !== input.repository.sessionName) return failure("Cannot start another repository's session");
        if (!prepared) {
          const readiness = await prepare(options);
          if (!readiness.ok) return readiness;
        }
        assertPreparationCurrent(options);
        let result: OperationResult<SessionManifest>;
        try { result = await manager.up(sessionId, options); }
        catch (error) { await startupChecks?.drain(true); throw error; }
        const health = await startupChecks?.drain(!result.ok);
        return result.ok && health && !health.ok ? health : result;
      },
      getManifest: (sessionId, options) => manager.getManifest(sessionId, options),
      attach: (sessionId, options) => manager.attach(sessionId, options),
      down: (sessionId, options) => manager.down(sessionId, options),
      async doctorSession(options) {
        const report = await manager.doctorSession(options);
        if (!lastPlatform) return report;
        const checks = [...report.checks, ...lastPlatform.roles.map(role => ({
          checkId: `platform-${role.role}`, name: `${role.role} provider readiness (${role.provider})`,
          status: role.status === "ready" ? "passed" as const : role.required ? "failed" as const : "warn" as const,
          message: role.message ?? `Preflight status: ${role.status}`
        }))];
        return { ...report, healthy: !checks.some(check => check.status === "failed"), checks };
      }
    },
    runtime: {
      findRuns: async (query, options) => (await connect()).runtime.findRuns(query, options),
      getRun: async (runId, options) => (await connect()).runtime.getRun(runId, options)
    },
    async activate(manifest, options) {
      const health = await startupChecks?.drain(true);
      if (health && !health.ok) throw new EnvironmentError(health.error);
      const result = await (await connect()).activate(manifest, options);
      if (!result.ok) throw new EnvironmentError(result.error);
    },
    quiesce: async options => { await stopStartupChecks(); return (await connect()).quiesce(options); },
    checkpoint: async (command, options) => (await connect()).checkpoint(command, options),
    shutdownHost: async () => { await stopStartupChecks(); await (await connect()).shutdown(); },
    terminateIncompatibleHost: async () => {
      await stopStartupChecks();
      const owner = await connect();
      if (!owner.terminateOwner) throw new Error("This host cannot be terminated by the CLI; preserve state and inspect bflow doctor");
      await owner.terminateOwner();
    },
    async close() { await stopStartupChecks(); if (host) await (await host).close(); }
  };
}
