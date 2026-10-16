import { basename, resolve } from "node:path";
import {
  EnvironmentDoctorReportSchema, PaneBindingSchema, SessionManifestSchema,
  type ContractError, type EnvironmentDoctorReport, type OperationOptions, type OperationResult,
  type PaneBinding, type SessionLifecycleManager, type SessionManifest
} from "@bflow/contracts";
import {
  FileSessionManifestStore, RolePaneManager, isSupportedAgentKind, resolveTopologyRole,
  type HerdrCommandRunner, type PermanentTopologyRole, type RoleAgentConfig,
  type SessionManifestStore, type TopologyRole
} from "@bflow/pane-manager";
import type { EnvironmentCompositionInput, EnvironmentIntegration } from "./environment.js";
import { environmentProcessRunner, namedSessionEnvironment, type EnvironmentProcessRunner } from "./environment-process.js";

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

/** Adapt P13's topology API to the frozen lifecycle port; no topology implementation lives here. */
export class PaneManagerLifecycleAdapter implements SessionLifecycleManager {
  private readonly store: SessionManifestStore;
  private readonly panes: RolePaneManager;
  private persistenceFailure: ContractError | undefined;
  constructor(private readonly input: EnvironmentCompositionInput, private readonly runner = environmentProcessRunner) {
    const roles: PermanentTopologyRole[] = [];
    const roleConfigs: Partial<Record<TopologyRole, Partial<RoleAgentConfig>>> = {};
    for (const role of input.config.environment.roles) {
      const topologyRole = resolveTopologyRole(role.role);
      if (topologyRole === null || topologyRole === "developer") {
        throw new Error(`Role '${role.role}' is not a permanent P13 role. Developers must be allocated by Runtime in task worktrees.`);
      }
      const kind = basename(role.cli);
      if (kind !== role.cli || !isSupportedAgentKind(kind)) throw new Error(`P13 requires a supported agent kind on PATH; custom executable '${role.cli}' is not supported`);
      roles.push(topologyRole);
      // Native arguments are owned by P13. No code, prompts or assignments are dispatched by P12.
      roleConfigs[topologyRole] = { agentKind: kind, startupTimeoutMs: input.config.environment.startupTimeoutMs };
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
        return saved;
      },
      delete: (sessionId, options) => sessionId === input.repository.sessionName
        ? diskStore.delete(sessionId, options) : Promise.resolve(failure("Foreign session requested from P13 manifest store"))
    };
    this.panes = new RolePaneManager({ config: {
      sessionId: input.repository.sessionName, workspaceRoot: input.repository.root, projectName: input.config.projectName,
      permanentRoles: roles, roleConfigs, maxDeveloperCapacity: input.config.environment.concurrency.maxConcurrency
    }, runner: createNamedPaneRunner(input, runner), store: this.store, defaultTimeoutMs: input.config.environment.startupTimeoutMs });
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
  async down(sessionId: string, _options?: OperationOptions): Promise<OperationResult<SessionManifest>> {
    if (!this.matches(sessionId)) return failure("Cannot stop another repository's session");
    return { ok: false, error: { code: "transport_unavailable", retryable: true,
      message: "P13 provides topology management but no graceful shutdown API. Compose Runtime quiesce/checkpoint and a lifecycle shutdown provider before down." } };
  }
  async doctorSession(_options: { workspaceRoot: string }): Promise<EnvironmentDoctorReport> {
    const root = this.input.repository.root;
    if (_options.workspaceRoot !== root) throw new Error("Cannot diagnose another repository");
    const current = await this.getManifest(this.input.repository.sessionName, { timeoutMs: 5000 });
    const checks: EnvironmentDoctorReport["checks"] = [{ checkId: "p13-composition", name: "P13 lifecycle adapter", status: "passed", message: "Real RolePaneManager with repository-scoped runner and FileSessionManifestStore" },
      { checkId: "runtime-shutdown", name: "Runtime graceful shutdown", status: "warn", message: "Runtime quiesce/checkpoint and P13 graceful shutdown API are unavailable; down remains guarded." }];
    if (!current.ok) checks.push({ checkId: "p13-manifest", name: "P13 manifest", status: "failed", message: current.error.message });
    else if (!current.value) checks.push({ checkId: "p13-manifest", name: "P13 manifest", status: "warn", message: "No topology manifest yet. Run bflow up." });
    else for (const pane of current.value.panes) checks.push({ checkId: `pane-${pane.bindingId}`.slice(0, 200), name: `${pane.role}: ${pane.paneId}`,
      status: ["idle", "done", "working"].includes(pane.transportState) ? "passed" : "failed", message: `Agent ${pane.agentId}: ${pane.transportState}` });
    return EnvironmentDoctorReportSchema.parse({ schemaVersion: 2, workspaceRoot: root, sessionId: this.input.repository.sessionName,
      healthy: !checks.some((check) => check.status === "failed"), checks, checkedAt: new Date().toISOString() });
  }
}

export function openPaneManagerEnvironment(input: EnvironmentCompositionInput, runner: EnvironmentProcessRunner = environmentProcessRunner): EnvironmentIntegration {
  return { manager: new PaneManagerLifecycleAdapter(input, runner) };
}
