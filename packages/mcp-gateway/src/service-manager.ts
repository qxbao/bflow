import type {
  MCPServiceDefinition,
  MCPServiceObservation,
  OperationOptions,
  OperationResult,
  ScopedOperation,
  TrustScope
} from "@bflow/contracts";
import {
  MCPServiceDefinitionSchema,
  MCPServiceObservationSchema,
  ScopedOperationSchema
} from "@bflow/contracts";
import type {
  ExtendedMCPServiceManager,
  MCPUpstreamDriverFactory,
  MCPUpstreamDriverInstance,
  MCPUpstreamToolDefinition,
  MCPBackendSharingPolicy,
  RegisteredMCPServiceEntry
} from "./types.js";
import { err, ok } from "./types.js";
import {
  checkSchemaVersion,
  computePartitionKey,
  evaluateSharingCompatibility,
  GatewaySecretStore
} from "./security.js";
import { GatewayMetricsCollector } from "./metrics.js";
import { MCPServiceRegistry } from "./registry.js";
import { SubprocessStdioDriverFactory } from "./stdio-bridge.js";
import { HttpUpstreamDriverInstance } from "./http-upstream.js";

class DefaultUpstreamDriverFactory implements MCPUpstreamDriverFactory {
  private readonly stdioFactory: SubprocessStdioDriverFactory;

  constructor(
    private readonly metrics: GatewayMetricsCollector,
    private readonly secretStore: GatewaySecretStore
  ) {
    this.stdioFactory = new SubprocessStdioDriverFactory({
      secretStore: this.secretStore
    });
  }

  async createInstance(
    entry: RegisteredMCPServiceEntry,
    partitionKey: string,
    startGeneration: number
  ): Promise<OperationResult<MCPUpstreamDriverInstance>> {
    if (entry.definition.connection.kind === "stdio_mcp") {
      return this.stdioFactory.createInstance(entry, partitionKey, startGeneration);
    }
    if (
      entry.definition.connection.kind === "existing_shared_worker" ||
      entry.definition.connection.kind === "native_remote_mcp"
    ) {
      const instance = new HttpUpstreamDriverInstance(
        entry,
        partitionKey,
        startGeneration,
        this.secretStore,
        { metrics: this.metrics }
      );
      return ok(instance);
    }
    return err({
      code: "validation",
      retryable: false,
      message: `Unsupported connection kind: ${(entry.definition.connection as { kind: string }).kind}`
    });
  }
}

export interface ManagedPartitionState {
  readonly entry: RegisteredMCPServiceEntry;
  readonly partitionKey: string;
  instanceId: string;
  driver?: MCPUpstreamDriverInstance | undefined;
  status: "ready" | "starting" | "blocked" | "stopped" | "unknown";
  protocolVersion?: string | undefined;
  discoveredTools: string[];
  toolDefinitions?: readonly MCPUpstreamToolDefinition[] | undefined;
  defaultedInputSchemaTools?: readonly string[] | undefined;
  attachedScopes: Set<string>;
  activeClients: Set<string>;
  restartCount: number;
  diagnosticCode: string;
  startGeneration: number;
  inFlightEnsure?: Promise<OperationResult<MCPServiceObservation>> | undefined;
}

export interface DefaultMCPServiceManagerOptions {
  /**
   * Trusted sharing-policy overrides decided by the host (never by a service or a client), for example the tools a
   * known service provides read-only. Without a declaration the Gateway treats every tool as potentially mutating,
   * so a failed call is reported as `unknown` instead of its cause and is never replayed.
   */
  readonly policyOverrides?: ((service: MCPServiceDefinition) => Partial<MCPBackendSharingPolicy> | undefined) | undefined;
  readonly registry?: MCPServiceRegistry | undefined;
  readonly metrics?: GatewayMetricsCollector | undefined;
  readonly secretStore?: GatewaySecretStore | undefined;
  readonly driverFactory?: MCPUpstreamDriverFactory | undefined;
  readonly now?: (() => Date) | undefined;
  readonly hasUncertainCalls?: ((partitionKey: string) => boolean) | undefined;
}

export class DefaultMCPServiceManager implements ExtendedMCPServiceManager {
  readonly registry: MCPServiceRegistry;
  readonly metrics: GatewayMetricsCollector;
  readonly secretStore: GatewaySecretStore;
  readonly driverFactory: MCPUpstreamDriverFactory;
  readonly now: () => Date;

  private readonly partitions = new Map<string, ManagedPartitionState>();
  private readonly crashListeners = new Set<(partitionKey: string, reason: string) => void>();
  private hasUncertainCalls?: ((partitionKey: string) => boolean) | undefined;
  private readonly policyOverrides: DefaultMCPServiceManagerOptions["policyOverrides"];

  constructor(options?: DefaultMCPServiceManagerOptions) {
    this.policyOverrides = options?.policyOverrides;
    this.registry = options?.registry ?? new MCPServiceRegistry();
    this.metrics = options?.metrics ?? new GatewayMetricsCollector();
    this.secretStore = options?.secretStore ?? new GatewaySecretStore();
    this.driverFactory =
      options?.driverFactory ??
      new DefaultUpstreamDriverFactory(this.metrics, this.secretStore);
    this.now = options?.now ?? (() => new Date());
    this.hasUncertainCalls = options?.hasUncertainCalls;
  }

  setHasUncertainCallsCheck(fn: (partitionKey: string) => boolean): void {
    this.hasUncertainCalls = fn;
  }

  onCrash(listener: (partitionKey: string, reason: string) => void): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  getDriver(partitionKey: string): MCPUpstreamDriverInstance | undefined {
    const state = this.partitions.get(partitionKey);
    return state?.driver;
  }

  getPartitionState(partitionKey: string): ManagedPartitionState | undefined {
    return this.partitions.get(partitionKey);
  }

  attachClient(partitionKey: string, clientId: string, entry?: RegisteredMCPServiceEntry): void {
    let state = this.partitions.get(partitionKey);
    if (!state) {
      const resolvedEntry =
        entry ??
        (() => {
          const atIdx = partitionKey.indexOf("@");
          if (atIdx > 0) {
            const serviceId = partitionKey.slice(0, atIdx);
            return this.registry.getService(serviceId);
          }
          return undefined;
        })();
      if (resolvedEntry) {
        state = {
          entry: resolvedEntry,
          partitionKey,
          instanceId: `pending-${resolvedEntry.definition.serviceId}`,
          status: "stopped",
          discoveredTools: [],
          attachedScopes: new Set(),
          activeClients: new Set(),
          restartCount: 0,
          diagnosticCode: "not_started",
          startGeneration: 0
        };
        this.partitions.set(partitionKey, state);
      }
    }
    if (state) {
      state.activeClients.add(clientId);
    }
  }

  detachClient(partitionKey: string, clientId: string): void {
    const state = this.partitions.get(partitionKey);
    if (state) {
      state.activeClients.delete(clientId);
    }
  }

  private formatScopeKey(scope: TrustScope): string {
    if (scope.kind === "machine") return `machine:${scope.machineId}`;
    if (scope.kind === "repository") {
      return `repo:${scope.machineId}:${scope.repositoryId}:${scope.workspaceRoot}`;
    }
    return `session:${scope.machineId}:${scope.repositoryId}:${scope.workspaceRoot}:${scope.sessionId}`;
  }

  private buildObservation(
    state: ManagedPartitionState,
    entry: RegisteredMCPServiceEntry
  ): MCPServiceObservation {
    return MCPServiceObservationSchema.parse({
      schemaVersion: 3,
      serviceId: entry.definition.serviceId,
      revision: entry.definition.revision,
      instanceId: state.instanceId,
      status: state.status,
      protocolVersion: state.protocolVersion,
      discoveredTools: state.discoveredTools,
      ownership: entry.definition.connection.ownership,
      activeClientCount: state.activeClients.size,
      observedAt: this.now().toISOString(),
      diagnosticCode: state.diagnosticCode
    });
  }

  private buildUnstartedObservation(entry: RegisteredMCPServiceEntry): MCPServiceObservation {
    return MCPServiceObservationSchema.parse({
      schemaVersion: 3,
      serviceId: entry.definition.serviceId,
      revision: entry.definition.revision,
      instanceId: `unstarted-${entry.definition.serviceId}`,
      status: "stopped",
      discoveredTools: [],
      ownership: entry.definition.connection.ownership,
      activeClientCount: 0,
      observedAt: this.now().toISOString(),
      diagnosticCode: "not_started"
    });
  }

  async ensure(
    service: MCPServiceDefinition,
    operation: ScopedOperation,
    options?: (OperationOptions & { readonly clientId?: string | undefined }) | undefined
  ): Promise<OperationResult<MCPServiceObservation>> {
    const verService = checkSchemaVersion(service);
    if (!verService.ok) return verService;
    const verOp = checkSchemaVersion(operation);
    if (!verOp.ok) return verOp;

    const parsedService = MCPServiceDefinitionSchema.safeParse(service);
    if (!parsedService.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parsedService.error.message,
        details: parsedService.error.flatten() as any
      });
    }
    const parsedOp = ScopedOperationSchema.safeParse(operation);
    if (!parsedOp.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parsedOp.error.message,
        details: parsedOp.error.flatten() as any
      });
    }

    let entry = this.registry.getService(service.serviceId);
    if (!entry) {
      const regRes = this.registry.registerService(service, this.policyOverrides?.(service));
      if (!regRes.ok) return regRes;
      entry = regRes.value;
    }

    const partRes = computePartitionKey(entry.definition, entry.policy, operation.scope);
    if (!partRes.ok) {
      const details = partRes.error.details as Record<string, unknown> | undefined;
      if (details?.diagnosticCode === "sharing_unsupported" || partRes.error.message.includes("sharing")) {
        return ok(
          MCPServiceObservationSchema.parse({
            schemaVersion: 3,
            serviceId: service.serviceId,
            revision: service.revision,
            instanceId: `blocked-${service.serviceId}`,
            status: "blocked",
            discoveredTools: [],
            ownership: service.connection.ownership,
            activeClientCount: 0,
            observedAt: this.now().toISOString(),
            diagnosticCode: "sharing_unsupported"
          })
        );
      }
      return partRes;
    }
    const partitionKey = partRes.value;

    let state = this.partitions.get(partitionKey);
    const otherClientsCount = (options as { clientId?: string } | undefined)?.clientId
      ? state?.activeClients.has((options as { clientId?: string }).clientId!)
        ? Math.max(0, state.activeClients.size - 1)
        : (state?.activeClients.size ?? 0)
      : (state?.activeClients.size ?? 0);

    const compat = evaluateSharingCompatibility(
      entry.definition,
      entry.policy,
      operation.scope,
      otherClientsCount
    );
    if (!compat.ok) {
      return compat;
    }

    if (options?.signal?.aborted) {
      return err({
        code: "cancelled",
        retryable: false,
        message: "Service ensure cancelled before execution"
      });
    }

    const awaitEnsureForCaller = async (
      sharedEnsure: Promise<OperationResult<MCPServiceObservation>>,
      targetState: typeof state
    ): Promise<OperationResult<MCPServiceObservation>> => {
      const callerSignal = options?.signal;
      const callerTimeoutMs =
        options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
          ? options.timeoutMs
          : undefined;

      if (!callerSignal && callerTimeoutMs === undefined) {
        const res = await sharedEnsure;
        if (res.ok && targetState) {
          targetState.attachedScopes.add(this.formatScopeKey(operation.scope));
        }
        return res;
      }

      const res = await new Promise<OperationResult<MCPServiceObservation>>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (outcome: OperationResult<MCPServiceObservation>) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
          resolve(outcome);
        };

        const onAbort = () => {
          finish(
            err({
              code: "cancelled",
              retryable: false,
              message: "Service ensure cancelled by caller signal"
            })
          );
        };

        if (callerSignal) {
          if (callerSignal.aborted) {
            onAbort();
            return;
          }
          callerSignal.addEventListener("abort", onAbort, { once: true });
        }

        if (callerTimeoutMs !== undefined) {
          timer = setTimeout(() => {
            finish(
              err({
                code: "timeout",
                retryable: true,
                retrySafety: "observation_only",
                message: `Timed out waiting for service '${service.serviceId}' readiness`
              })
            );
          }, Math.min(2_147_483_647, Math.ceil(callerTimeoutMs)));
        }

        sharedEnsure.then(finish, (e) =>
          finish(
            err({
              code: "transport_unavailable",
              retryable: true,
              message: e instanceof Error ? e.message : String(e)
            })
          )
        );
      });

      if (res.ok && targetState) {
        targetState.attachedScopes.add(this.formatScopeKey(operation.scope));
      }
      return res;
    };

    if (state?.inFlightEnsure) {
      return awaitEnsureForCaller(state.inFlightEnsure, state);
    }

    if (state && state.status === "ready" && state.driver?.isAlive()) {
      state.attachedScopes.add(this.formatScopeKey(operation.scope));
      if (state.driver.getMemoryRssBytes) {
        const rss = await state.driver.getMemoryRssBytes();
        this.metrics.updateProcessMemory(service.serviceId, state.instanceId, rss);
        const maxMem = entry.policy.maxMemoryBytes ?? this.metrics.maxMemoryBytes;
        if (rss > maxMem) {
          this.metrics.recordMemoryLimitTermination();
          await state.driver.stop("memory_limit_exceeded");
          if (entry.definition.connection.ownership === "bflow") {
            this.metrics.recordProcessStop(service.serviceId, state.instanceId);
          }
          state.status = "stopped";
          state.diagnosticCode = "memory_limit_exceeded";
          return err({
            code: "transport_unavailable",
            retryable: true,
            message: "Backend exceeded memory limit"
          });
        }
      }
      return ok(this.buildObservation(state, entry));
    }

    if (entry.definition.connection.ownership === "bflow") {
      const canSpawn = this.metrics.canSpawnProcess(service.serviceId);
      if (!canSpawn) {
        return err({
          code: "transport_unavailable",
          retryable: true,
          message: "Process limit reached",
          details: { diagnosticCode: "process_limit_exceeded" }
        });
      }
    }

    if (!state) {
      state = {
        entry,
        partitionKey,
        instanceId: `pending-${service.serviceId}`,
        status: "starting",
        discoveredTools: [],
        attachedScopes: new Set(),
        activeClients: new Set(),
        restartCount: 0,
        diagnosticCode: "starting",
        startGeneration: 0
      };
      this.partitions.set(partitionKey, state);
    } else {
      state.status = "starting";
      state.diagnosticCode = "starting";
    }

    const currentGen = state.startGeneration + 1;
    state.startGeneration = currentGen;

    const capturedEntry = entry;
    const capturedState = state;

    let ensurePromise!: Promise<OperationResult<MCPServiceObservation>>;
    ensurePromise = (async (): Promise<OperationResult<MCPServiceObservation>> => {
      try {
        const driverRes = await this.driverFactory.createInstance(
          capturedEntry,
          partitionKey,
          currentGen
        );
        if (!driverRes.ok) {
          capturedState.status = "unknown";
          capturedState.diagnosticCode = "spawn_failed";
          return driverRes;
        }
        const driver = driverRes.value;
        if (capturedEntry.definition.connection.ownership === "bflow") {
          this.metrics.recordProcessStart(service.serviceId, driver.instanceId, driver.pid);
        }

        const initRes = await driver.initialize({
          timeoutMs: service.healthTimeoutMs
        });

        if (!initRes.ok) {
          if (capturedEntry.definition.connection.ownership === "bflow") {
            await driver.stop("init_failed");
            this.metrics.recordProcessStop(service.serviceId, driver.instanceId);
          }
          capturedState.status = "unknown";
          capturedState.diagnosticCode = "init_failed";
          return initRes;
        }

        const discoveredTools = initRes.value.discoveredTools;
        const protocolVersion = initRes.value.protocolVersion;

        const hasProto = Boolean(protocolVersion && protocolVersion.trim().length > 0);
        const hasTools = discoveredTools.length > 0;
        const missingRequired = service.tool.operations.filter(
          op => !discoveredTools.includes(op)
        );

        if (!hasProto || !hasTools || missingRequired.length > 0) {
          if (capturedEntry.definition.connection.ownership === "bflow") {
            await driver.stop("missing_required_tools");
            this.metrics.recordProcessStop(service.serviceId, driver.instanceId);
          }
          capturedState.status = "blocked";
          capturedState.diagnosticCode = "missing_required_tools";
          capturedState.driver = undefined;
          return ok(
            MCPServiceObservationSchema.parse({
              schemaVersion: 3,
              serviceId: service.serviceId,
              revision: service.revision,
              instanceId: driver.instanceId,
              status: "blocked",
              protocolVersion: protocolVersion || undefined,
              discoveredTools: [...discoveredTools],
              ownership: service.connection.ownership,
              activeClientCount: capturedState.activeClients.size,
              observedAt: this.now().toISOString(),
              diagnosticCode: "missing_required_tools"
            })
          );
        }

        capturedState.driver = driver;
        capturedState.status = "ready";
        capturedState.instanceId = driver.instanceId;
        capturedState.protocolVersion = protocolVersion;
        capturedState.discoveredTools = [...discoveredTools];
        capturedState.toolDefinitions = initRes.value.toolDefinitions;
        capturedState.defaultedInputSchemaTools = initRes.value.defaultedInputSchemaTools;
        capturedState.diagnosticCode = "ready";

        driver.onCrash(reason => {
          capturedState.status = "unknown";
          capturedState.diagnosticCode = "unexpected_crash";
          if (capturedEntry.definition.connection.ownership === "bflow") {
            this.metrics.recordProcessStop(service.serviceId, driver.instanceId);
          }
          for (const listener of this.crashListeners) {
            try {
              listener(partitionKey, reason);
            } catch {
              // ignore listener errors
            }
          }
        });

        return ok(this.buildObservation(capturedState, capturedEntry));
      } catch (e) {
        capturedState.status = "unknown";
        capturedState.diagnosticCode = "unexpected_error";
        return err({
          code: "transport_unavailable",
          retryable: true,
          message: e instanceof Error ? e.message : String(e)
        });
      } finally {
        if (capturedState.inFlightEnsure === ensurePromise) {
          capturedState.inFlightEnsure = undefined;
        }
      }
    })();

    state.inFlightEnsure = ensurePromise;
    return awaitEnsureForCaller(ensurePromise, state);
  }

  async inspect(
    serviceId: string,
    operation: ScopedOperation,
    _options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>> {
    const verOp = checkSchemaVersion(operation);
    if (!verOp.ok) return verOp;
    const parsedOp = ScopedOperationSchema.safeParse(operation);
    if (!parsedOp.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parsedOp.error.message,
        details: parsedOp.error.flatten() as any
      });
    }

    const entry = this.registry.getService(serviceId);
    if (!entry) {
      return err({ code: "not_found", retryable: false, message: `Service ${serviceId} not found` });
    }

    const partRes = computePartitionKey(entry.definition, entry.policy, operation.scope);
    if (!partRes.ok) return partRes;
    const partitionKey = partRes.value;

    const state = this.partitions.get(partitionKey);
    if (!state) {
      return ok(this.buildUnstartedObservation(entry));
    }

    if (state.driver) {
      if (!state.driver.isAlive() && state.status === "ready") {
        state.status = "stopped";
        state.diagnosticCode = "process_not_alive";
      } else if (state.driver.isAlive() && state.driver.getMemoryRssBytes) {
        const rss = await state.driver.getMemoryRssBytes();
        this.metrics.updateProcessMemory(serviceId, state.instanceId, rss);
        const maxMem = entry.policy.maxMemoryBytes ?? this.metrics.maxMemoryBytes;
        if (rss > maxMem) {
          this.metrics.recordMemoryLimitTermination();
          await state.driver.stop("memory_limit_exceeded");
          if (entry.definition.connection.ownership === "bflow") {
            this.metrics.recordProcessStop(serviceId, state.instanceId);
          }
          state.status = "stopped";
          state.diagnosticCode = "memory_limit_exceeded";
        }
      }
    }

    return ok(this.buildObservation(state, entry));
  }

  async status(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>> {
    return this.inspect(serviceId, operation, options);
  }

  async health(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>> {
    return this.inspect(serviceId, operation, options);
  }

  async start(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>> {
    const entry = this.registry.getService(serviceId);
    if (!entry) {
      return err({ code: "not_found", retryable: false, message: `Service ${serviceId} not found` });
    }
    return this.ensure(entry.definition, operation, options);
  }

  async release(
    serviceId: string,
    operation: ScopedOperation,
    _options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>> {
    const verOp = checkSchemaVersion(operation);
    if (!verOp.ok) return verOp;
    const parsedOp = ScopedOperationSchema.safeParse(operation);
    if (!parsedOp.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parsedOp.error.message,
        details: parsedOp.error.flatten() as any
      });
    }

    const entry = this.registry.getService(serviceId);
    if (!entry) {
      return err({ code: "not_found", retryable: false, message: `Service ${serviceId} not found` });
    }

    const partRes = computePartitionKey(entry.definition, entry.policy, operation.scope);
    if (!partRes.ok) return partRes;
    const partitionKey = partRes.value;

    const state = this.partitions.get(partitionKey);
    if (!state) {
      return ok(this.buildUnstartedObservation(entry));
    }

    state.attachedScopes.delete(this.formatScopeKey(operation.scope));

    if (entry.definition.connection.ownership === "external") {
      return ok(this.buildObservation(state, entry));
    }

    if (state.attachedScopes.size === 0 && state.activeClients.size === 0) {
      if (this.hasUncertainCalls?.(partitionKey)) {
        state.diagnosticCode = "retained_for_reconciliation";
      } else {
        if (state.driver?.isAlive()) {
          await state.driver.stop("stopped_idle");
          this.metrics.recordProcessStop(serviceId, state.instanceId);
        }
        state.status = "stopped";
        state.diagnosticCode = "stopped_idle";
      }
    }

    return ok(this.buildObservation(state, entry));
  }

  async stop(
    serviceId: string,
    operation: ScopedOperation,
    _options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>> {
    const verOp = checkSchemaVersion(operation);
    if (!verOp.ok) return verOp;
    const parsedOp = ScopedOperationSchema.safeParse(operation);
    if (!parsedOp.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parsedOp.error.message,
        details: parsedOp.error.flatten() as any
      });
    }

    const entry = this.registry.getService(serviceId);
    if (!entry) {
      return err({ code: "not_found", retryable: false, message: `Service ${serviceId} not found` });
    }

    const partRes = computePartitionKey(entry.definition, entry.policy, operation.scope);
    if (!partRes.ok) return partRes;
    const partitionKey = partRes.value;

    const state = this.partitions.get(partitionKey);
    if (!state) {
      return ok(this.buildUnstartedObservation(entry));
    }

    if (entry.definition.connection.ownership === "bflow") {
      if (state.driver?.isAlive()) {
        await state.driver.stop("stopped");
        this.metrics.recordProcessStop(serviceId, state.instanceId);
      }
      state.status = "stopped";
      state.diagnosticCode = "stopped";
      return ok(this.buildObservation(state, entry));
    } else {
      state.attachedScopes.delete(this.formatScopeKey(operation.scope));
      state.diagnosticCode = "external_worker_detached";
      return ok(this.buildObservation(state, entry));
    }
  }

  async restart(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>> {
    const verOp = checkSchemaVersion(operation);
    if (!verOp.ok) return verOp;
    const parsedOp = ScopedOperationSchema.safeParse(operation);
    if (!parsedOp.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parsedOp.error.message,
        details: parsedOp.error.flatten() as any
      });
    }

    const entry = this.registry.getService(serviceId);
    if (!entry) {
      return err({ code: "not_found", retryable: false, message: `Service ${serviceId} not found` });
    }

    const partRes = computePartitionKey(entry.definition, entry.policy, operation.scope);
    if (!partRes.ok) return partRes;
    const partitionKey = partRes.value;

    let state = this.partitions.get(partitionKey);
    if (!state) {
      return this.ensure(entry.definition, operation, options);
    }

    if (state.restartCount >= entry.definition.restartLimit) {
      if (entry.definition.connection.ownership === "bflow" && state.driver?.isAlive()) {
        await state.driver.stop("restart_limit_exceeded");
        this.metrics.recordProcessStop(serviceId, state.instanceId);
      }
      state.status = "blocked";
      state.diagnosticCode = "restart_limit_exceeded";
      return ok(this.buildObservation(state, entry));
    }

    state.restartCount += 1;
    this.metrics.recordRestart(serviceId);

    if (entry.definition.connection.ownership === "bflow" && state.driver?.isAlive()) {
      await state.driver.stop("restart");
      this.metrics.recordProcessStop(serviceId, state.instanceId);
    }

    const currentGen = state.startGeneration + 1;
    state.startGeneration = currentGen;
    state.status = "starting";
    state.diagnosticCode = "restarting";

    const driverRes = await this.driverFactory.createInstance(entry, partitionKey, currentGen);
    if (!driverRes.ok) {
      state.status = "unknown";
      state.diagnosticCode = "spawn_failed";
      return driverRes;
    }
    const driver = driverRes.value;
    if (entry.definition.connection.ownership === "bflow") {
      this.metrics.recordProcessStart(serviceId, driver.instanceId, driver.pid);
    }

    const initTimeout = options?.timeoutMs ?? entry.definition.healthTimeoutMs;
    const initOptions: OperationOptions = {
      timeoutMs: initTimeout,
      ...(options?.signal !== undefined ? { signal: options.signal } : {})
    };
    const initRes = await driver.initialize(initOptions);

    if (!initRes.ok) {
      if (entry.definition.connection.ownership === "bflow") {
        await driver.stop("init_failed");
        this.metrics.recordProcessStop(serviceId, driver.instanceId);
      }
      state.status = "unknown";
      state.diagnosticCode = "init_failed";
      return initRes;
    }

    const discoveredTools = initRes.value.discoveredTools;
    const protocolVersion = initRes.value.protocolVersion;
    const missingRequired = entry.definition.tool.operations.filter(
      op => !discoveredTools.includes(op)
    );

    if (!protocolVersion || discoveredTools.length === 0 || missingRequired.length > 0) {
      if (entry.definition.connection.ownership === "bflow") {
        await driver.stop("missing_required_tools");
        this.metrics.recordProcessStop(serviceId, driver.instanceId);
      }
      state.status = "blocked";
      state.diagnosticCode = "missing_required_tools";
      return ok(
        MCPServiceObservationSchema.parse({
          schemaVersion: 3,
          serviceId,
          revision: entry.definition.revision,
          instanceId: driver.instanceId,
          status: "blocked",
          protocolVersion: protocolVersion || undefined,
          discoveredTools: [...discoveredTools],
          ownership: entry.definition.connection.ownership,
          activeClientCount: state.activeClients.size,
          observedAt: this.now().toISOString(),
          diagnosticCode: "missing_required_tools"
        })
      );
    }

    state.driver = driver;
    state.status = "ready";
    state.instanceId = driver.instanceId;
    state.protocolVersion = protocolVersion;
    state.discoveredTools = [...discoveredTools];
    state.toolDefinitions = initRes.value.toolDefinitions;
    state.defaultedInputSchemaTools = initRes.value.defaultedInputSchemaTools;
    state.diagnosticCode = "ready";

    const capturedEntry = entry;
    const capturedState = state;
    driver.onCrash(reason => {
      capturedState.status = "unknown";
      capturedState.diagnosticCode = "unexpected_crash";
      if (capturedEntry.definition.connection.ownership === "bflow") {
        this.metrics.recordProcessStop(serviceId, driver.instanceId);
      }
      for (const listener of this.crashListeners) {
        try {
          listener(partitionKey, reason);
        } catch {
          // ignore
        }
      }
    });

    return ok(this.buildObservation(state, entry));
  }
}
