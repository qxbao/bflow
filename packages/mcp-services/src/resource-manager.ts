import * as fs from "node:fs";
import {
  CURRENT_PLATFORM_SCHEMA_VERSION,
  type MCPServiceDefinition,
  MCPServiceDefinitionSchema,
  type MCPServiceManager,
  type MCPServiceObservation,
  MCPServiceObservationSchema,
  type OperationOptions,
  type OperationResult,
  type ScopedOperation,
  ScopedOperationSchema,
  type TrustScope
} from "@bflow/contracts";
import {
  err,
  ok,
  type BackendStartupMode,
  type ManagedBackendDriver,
  type ManagedBackendDriverFactory,
  type ManagedBackendRegistrationOptions,
  type PartitionResourceSnapshot,
  type ResourceManagerMetricsSnapshot
} from "./types.js";

export interface BackendResourceManagerOptions {
  readonly driverFactory: ManagedBackendDriverFactory;
  readonly maxProcessCount?: number | undefined;
  readonly maxTotalMemoryBytes?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

interface PartitionState {
  readonly partitionKey: string;
  readonly definition: MCPServiceDefinition;
  readonly options: ManagedBackendRegistrationOptions;
  driver?: ManagedBackendDriver | undefined;
  instanceId: string;
  pid?: number | undefined;
  status: "ready" | "starting" | "blocked" | "stopped" | "unknown";
  startupMode: BackendStartupMode;
  ownership: "bflow" | "external";
  readonly activeClientIds: Set<string>;
  readonly attachedScopes: Set<string>;
  activeCallCount: number;
  hasUncertainCalls: boolean;
  memoryRssBytes: number;
  maxMemoryBytes: number;
  idleSince: string | null;
  idleTimeoutMs: number;
  restartCount: number;
  startGeneration: number;
  diagnosticCode: string;
  protocolVersion?: string | undefined;
  discoveredTools: readonly string[];
  startingPromise?: Promise<OperationResult<MCPServiceObservation>> | undefined;
  crashListenerDisposer?: (() => void) | undefined;
}

export class BackendResourceManager implements MCPServiceManager {
  private readonly driverFactory: ManagedBackendDriverFactory;
  private readonly maxProcessCount: number;
  private readonly maxTotalMemoryBytes: number;
  private readonly now: () => Date;

  private activeProcessCount = 0;
  private peakMemoryRssBytes = 0;
  private idleCleanupsCount = 0;
  private memoryEvictionsCount = 0;
  private memoryLimitTerminations = 0;
  private processLimitRejections = 0;

  private readonly registeredBackends = new Map<
    string,
    { definition: MCPServiceDefinition; options: ManagedBackendRegistrationOptions }
  >();
  private readonly partitions = new Map<string, PartitionState>();

  constructor(
    factoryOrOptions: ManagedBackendDriverFactory | BackendResourceManagerOptions,
    extraOptions?: Partial<BackendResourceManagerOptions>
  ) {
    if ("createDriver" in factoryOrOptions && typeof (factoryOrOptions as any).createDriver === "function") {
      this.driverFactory = factoryOrOptions as ManagedBackendDriverFactory;
      this.maxProcessCount = extraOptions?.maxProcessCount ?? 8;
      this.maxTotalMemoryBytes = extraOptions?.maxTotalMemoryBytes ?? 2 * 1024 * 1024 * 1024;
      this.now = extraOptions?.now ?? (() => new Date());
    } else {
      const opts = factoryOrOptions as BackendResourceManagerOptions;
      this.driverFactory = opts.driverFactory;
      this.maxProcessCount = opts.maxProcessCount ?? 8;
      this.maxTotalMemoryBytes = opts.maxTotalMemoryBytes ?? 2 * 1024 * 1024 * 1024;
      this.now = opts.now ?? (() => new Date());
    }
  }

  registerBackend(
    definition: MCPServiceDefinition,
    options?: ManagedBackendRegistrationOptions
  ): OperationResult<void> {
    const parsed = MCPServiceDefinitionSchema.safeParse(definition);
    if (!parsed.success) {
      return err({
        code: "validation",
        retryable: false,
        message: `Invalid MCP service definition: ${parsed.error.message}`,
        details: parsed.error.format()
      });
    }

    const validDef = parsed.data;
    if (validDef.schemaVersion !== CURRENT_PLATFORM_SCHEMA_VERSION) {
      return err({
        code: "unsupported_version",
        retryable: false,
        supportedVersions: [CURRENT_PLATFORM_SCHEMA_VERSION],
        receivedVersion: validDef.schemaVersion,
        message: `Unsupported schema version: ${validDef.schemaVersion}`
      });
    }

    const effectiveOptions: ManagedBackendRegistrationOptions = {
      startupMode: options?.startupMode ?? "lazy",
      idleTimeoutMs: options?.idleTimeoutMs ?? validDef.idleTimeoutMs,
      maxMemoryBytes: options?.maxMemoryBytes ?? 512 * 1024 * 1024,
      maxConcurrentClients: options?.maxConcurrentClients,
      isolateByRepository: options?.isolateByRepository
    };

    this.registeredBackends.set(validDef.serviceId, {
      definition: validDef,
      options: effectiveOptions
    });

    return ok(undefined);
  }

  async initializeUserSession(scope: TrustScope): Promise<readonly MCPServiceObservation[]> {
    const observations: MCPServiceObservation[] = [];

    for (const reg of this.registeredBackends.values()) {
      const startupMode = reg.options.startupMode ?? "lazy";
      const partitionKey = this.computePartitionKey(reg.definition, scope, reg.options);

      if (startupMode === "eager") {
        const op: ScopedOperation = {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          scope,
          idempotencyKey: `init-eager-${reg.definition.serviceId}-${this.now().getTime()}`
        };
        const res = await this.ensure(reg.definition, op);
        if (res.ok) {
          observations.push(MCPServiceObservationSchema.parse(res.value));
        } else {
          const p = this.partitions.get(partitionKey);
          if (p) {
            observations.push(this.createObservation(p));
          }
        }
      } else {
        let partition = this.partitions.get(partitionKey);
        if (!partition) {
          partition = {
            partitionKey,
            definition: reg.definition,
            options: reg.options,
            instanceId: `lazy-${reg.definition.serviceId}`,
            status: "stopped",
            startupMode: "lazy",
            ownership: reg.definition.connection.ownership,
            activeClientIds: new Set(),
            attachedScopes: new Set([this.formatScopeKey(scope)]),
            activeCallCount: 0,
            hasUncertainCalls: false,
            memoryRssBytes: 0,
            maxMemoryBytes: reg.options.maxMemoryBytes ?? 512 * 1024 * 1024,
            idleSince: null,
            idleTimeoutMs: reg.options.idleTimeoutMs ?? reg.definition.idleTimeoutMs,
            restartCount: 0,
            startGeneration: 0,
            diagnosticCode: "lazy_unstarted",
            discoveredTools: []
          };
          this.partitions.set(partitionKey, partition);
        }
        observations.push(this.createObservation(partition));
      }
    }

    return observations;
  }

  computePartitionKey(
    definition: MCPServiceDefinition,
    scope: TrustScope,
    options?: ManagedBackendRegistrationOptions
  ): string {
    const isolateRepo = options?.isolateByRepository ?? false;
    if ((isolateRepo || definition.connection.kind === "stdio_mcp") && scope.kind !== "machine") {
      return `${definition.serviceId}@repo:${scope.machineId}:${scope.repositoryId}`;
    }
    return `${definition.serviceId}@machine:${scope.machineId}`;
  }

  async ensure(
    service: MCPServiceDefinition,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>> {
    const serviceParsed = MCPServiceDefinitionSchema.safeParse(service);
    if (!serviceParsed.success) {
      return err({
        code: "validation",
        retryable: false,
        message: `Invalid service definition: ${serviceParsed.error.message}`
      });
    }
    const opParsed = ScopedOperationSchema.safeParse(operation);
    if (!opParsed.success) {
      return err({
        code: "validation",
        retryable: false,
        message: `Invalid scoped operation: ${opParsed.error.message}`
      });
    }

    let reg = this.registeredBackends.get(service.serviceId);
    if (!reg) {
      this.registerBackend(service);
      reg = this.registeredBackends.get(service.serviceId)!;
    }

    const partitionKey = this.computePartitionKey(service, operation.scope, reg.options);
    let partition = this.partitions.get(partitionKey);

    if (!partition) {
      partition = {
        partitionKey,
        definition: service,
        options: reg.options,
        instanceId: `inst-${service.serviceId}-${Date.now()}`,
        status: "stopped",
        startupMode: reg.options.startupMode ?? "lazy",
        ownership: service.connection.ownership,
        activeClientIds: new Set(),
        attachedScopes: new Set([this.formatScopeKey(operation.scope)]),
        activeCallCount: 0,
        hasUncertainCalls: false,
        memoryRssBytes: 0,
        maxMemoryBytes: reg.options.maxMemoryBytes ?? 512 * 1024 * 1024,
        idleSince: null,
        idleTimeoutMs: reg.options.idleTimeoutMs ?? service.idleTimeoutMs,
        restartCount: 0,
        startGeneration: 0,
        diagnosticCode: "stopped",
        discoveredTools: []
      };
      this.partitions.set(partitionKey, partition);
    } else {
      partition.attachedScopes.add(this.formatScopeKey(operation.scope));
    }

    if (partition.status === "ready") {
      if (partition.driver && partition.driver.isAlive()) {
        partition.idleSince =
          partition.activeClientIds.size === 0 && partition.activeCallCount === 0
            ? (partition.idleSince ?? this.now().toISOString())
            : null;
        return ok(this.createObservation(partition, { diagnosticCode: "ok" }));
      }
      this.handleDriverCrash(partition, "process_exited");
    }

    if (partition.status === "starting" && partition.startingPromise) {
      return await partition.startingPromise;
    }

    if (partition.ownership === "bflow") {
      if (
        this.activeProcessCount >= this.maxProcessCount ||
        this.getTotalMemoryRssBytes() >= this.maxTotalMemoryBytes
      ) {
        await this.evictIdleBackendsUnderPressure();
      }

      if (this.activeProcessCount >= this.maxProcessCount) {
        this.processLimitRejections++;
        return err({
          code: "transport_unavailable",
          retryable: true,
          message: "Maximum backend process limit reached",
          details: { diagnosticCode: "process_limit_exceeded" }
        });
      }

      if (this.getTotalMemoryRssBytes() >= this.maxTotalMemoryBytes) {
        return err({
          code: "transport_unavailable",
          retryable: true,
          message: "Maximum memory limit reached",
          details: { diagnosticCode: "memory_limit_exceeded" }
        });
      }
    }

    partition.status = "starting";
    partition.diagnosticCode = "starting";
    const generation = partition.startGeneration + 1;
    partition.startGeneration = generation;

    const startPromise = (async (): Promise<OperationResult<MCPServiceObservation>> => {
      try {
        const driverRes = await this.driverFactory.createDriver(service, partitionKey, generation);
        if (!driverRes.ok) {
          partition.status = "stopped";
          partition.diagnosticCode = "driver_creation_failed";
          return driverRes;
        }

        const driver = driverRes.value;
        const initRes = await driver.initialize(options);
        if (!initRes.ok) {
          await driver.stop("initialization_failed");
          partition.status = "stopped";
          partition.diagnosticCode = "initialization_failed";
          return initRes;
        }

        partition.driver = driver;
        partition.instanceId = driver.instanceId;
        partition.pid = driver.pid;
        partition.status = "ready";
        partition.diagnosticCode = "ok";
        partition.protocolVersion = initRes.value.protocolVersion;
        partition.discoveredTools = [...initRes.value.discoveredTools];
        partition.idleSince =
          partition.activeClientIds.size === 0 && partition.activeCallCount === 0
            ? this.now().toISOString()
            : null;

        if (partition.ownership === "bflow") {
          this.activeProcessCount++;
        }

        if (partition.crashListenerDisposer) {
          partition.crashListenerDisposer();
        }
        partition.crashListenerDisposer = driver.onCrash((reason) => {
          this.handleDriverCrash(partition, reason);
        });

        return ok(this.createObservation(partition));
      } catch (e: any) {
        partition.status = "stopped";
        partition.diagnosticCode = "startup_exception";
        return err({
          code: "transport_unavailable",
          retryable: true,
          message: e?.message ?? "Failed to start backend driver"
        });
      } finally {
        partition.startingPromise = undefined;
      }
    })();

    partition.startingPromise = startPromise;
    return await startPromise;
  }

  async inspect(
    serviceId: string,
    operation: ScopedOperation,
    _options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>> {
    const opParsed = ScopedOperationSchema.safeParse(operation);
    if (!opParsed.success) {
      return err({
        code: "validation",
        retryable: false,
        message: `Invalid scoped operation: ${opParsed.error.message}`
      });
    }

    const reg = this.registeredBackends.get(serviceId);
    if (!reg) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Service ${serviceId} not registered`
      });
    }

    const partitionKey = this.computePartitionKey(reg.definition, operation.scope, reg.options);
    const partition = this.partitions.get(partitionKey);

    if (partition) {
      return ok(this.createObservation(partition));
    }

    return ok(MCPServiceObservationSchema.parse({
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      serviceId,
      revision: reg.definition.revision,
      instanceId: `lazy-${serviceId}`,
      status: "stopped",
      discoveredTools: [],
      ownership: reg.definition.connection.ownership,
      activeClientCount: 0,
      observedAt: this.now().toISOString(),
      diagnosticCode: "lazy_unstarted"
    }));
  }

  async release(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions & { readonly forceImmediateStop?: boolean }
  ): Promise<OperationResult<MCPServiceObservation>> {
    const opParsed = ScopedOperationSchema.safeParse(operation);
    if (!opParsed.success) {
      return err({
        code: "validation",
        retryable: false,
        message: `Invalid scoped operation: ${opParsed.error.message}`
      });
    }

    const reg = this.registeredBackends.get(serviceId);
    if (!reg) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Service ${serviceId} not registered`
      });
    }

    const partitionKey = this.computePartitionKey(reg.definition, operation.scope, reg.options);
    const partition = this.partitions.get(partitionKey);

    if (!partition || partition.status === "stopped") {
      if (partition) {
        return ok(this.createObservation(partition));
      }
      return ok(MCPServiceObservationSchema.parse({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        serviceId,
        revision: reg.definition.revision,
        instanceId: `lazy-${serviceId}`,
        status: "stopped",
        discoveredTools: [],
        ownership: reg.definition.connection.ownership,
        activeClientCount: 0,
        observedAt: this.now().toISOString(),
        diagnosticCode: "already_stopped"
      }));
    }

    if (partition.activeClientIds.size > 0) {
      return ok(this.createObservation(partition, { diagnosticCode: "retained_active_clients" }));
    }
    if (partition.activeCallCount > 0) {
      return ok(this.createObservation(partition, { diagnosticCode: "retained_active_calls" }));
    }
    if (partition.hasUncertainCalls) {
      return ok(this.createObservation(partition, { diagnosticCode: "retained_for_reconciliation" }));
    }
    if (partition.ownership === "external") {
      return ok(this.createObservation(partition, { diagnosticCode: "external_retained" }));
    }

    partition.attachedScopes.delete(this.formatScopeKey(operation.scope));

    if (!options?.forceImmediateStop && partition.attachedScopes.size > 0) {
      return ok(this.createObservation(partition, { diagnosticCode: "retained_attached_scopes" }));
    }

    const forceStop = options?.forceImmediateStop === true || partition.idleTimeoutMs <= 0;
    if (forceStop) {
      if (partition.crashListenerDisposer) {
        partition.crashListenerDisposer();
        partition.crashListenerDisposer = undefined;
      }
      if (partition.driver) {
        await partition.driver.stop("released");
        partition.driver = undefined;
      }
      partition.status = "stopped";
      partition.diagnosticCode = "released";
      partition.memoryRssBytes = 0;
      partition.idleSince = null;
      if (partition.ownership === "bflow") {
        this.activeProcessCount = Math.max(0, this.activeProcessCount - 1);
      }
      return ok(this.createObservation(partition));
    }

    if (partition.idleSince === null) {
      partition.idleSince = this.now().toISOString();
    }
    return ok(this.createObservation(partition, { diagnosticCode: "idle_grace_period" }));
  }

  async attachClient(
    serviceId: string,
    clientId: string,
    operation: ScopedOperation
  ): Promise<OperationResult<MCPServiceObservation>> {
    const reg = this.registeredBackends.get(serviceId);
    if (!reg) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Service ${serviceId} not registered`
      });
    }

    const partitionKey = this.computePartitionKey(reg.definition, operation.scope, reg.options);
    let partition = this.partitions.get(partitionKey);
    if (!partition) {
      partition = {
        partitionKey,
        definition: reg.definition,
        options: reg.options,
        instanceId: `inst-${serviceId}-${Date.now()}`,
        status: "stopped",
        startupMode: reg.options.startupMode ?? "lazy",
        ownership: reg.definition.connection.ownership,
        activeClientIds: new Set(),
        attachedScopes: new Set([this.formatScopeKey(operation.scope)]),
        activeCallCount: 0,
        hasUncertainCalls: false,
        memoryRssBytes: 0,
        maxMemoryBytes: reg.options.maxMemoryBytes ?? 512 * 1024 * 1024,
        idleSince: null,
        idleTimeoutMs: reg.options.idleTimeoutMs ?? reg.definition.idleTimeoutMs,
        restartCount: 0,
        startGeneration: 0,
        diagnosticCode: "stopped",
        discoveredTools: []
      };
      this.partitions.set(partitionKey, partition);
    }

    if (
      reg.options.maxConcurrentClients !== undefined &&
      !partition.activeClientIds.has(clientId) &&
      partition.activeClientIds.size >= reg.options.maxConcurrentClients
    ) {
      return err({
        code: "conflict",
        retryable: true,
        message: `Maximum concurrent clients (${reg.options.maxConcurrentClients}) reached for backend '${serviceId}'`,
        details: {
          diagnosticCode: "client_limit_exceeded",
          serviceId,
          maxConcurrentClients: reg.options.maxConcurrentClients
        }
      });
    }

    partition.activeClientIds.add(clientId);
    partition.idleSince = null;

    const ensureRes = await this.ensure(reg.definition, operation);
    if (!ensureRes.ok) {
      partition.activeClientIds.delete(clientId);
      return ensureRes;
    }

    if (
      reg.options.maxConcurrentClients !== undefined &&
      partition.activeClientIds.size > reg.options.maxConcurrentClients
    ) {
      partition.activeClientIds.delete(clientId);
      return err({
        code: "conflict",
        retryable: true,
        message: `Maximum concurrent clients (${reg.options.maxConcurrentClients}) reached for backend '${serviceId}'`,
        details: {
          diagnosticCode: "client_limit_exceeded",
          serviceId,
          maxConcurrentClients: reg.options.maxConcurrentClients
        }
      });
    }

    return ok(this.createObservation(partition));
  }

  async acquireClientSession(
    serviceId: string,
    clientId: string,
    operation: ScopedOperation
  ): Promise<OperationResult<MCPServiceObservation>> {
    return this.attachClient(serviceId, clientId, operation);
  }

  async detachClient(
    serviceId: string,
    clientId: string,
    operation: ScopedOperation
  ): Promise<OperationResult<MCPServiceObservation>> {
    const reg = this.registeredBackends.get(serviceId);
    if (!reg) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Service ${serviceId} not registered`
      });
    }

    const partitionKey = this.computePartitionKey(reg.definition, operation.scope, reg.options);
    const partition = this.partitions.get(partitionKey);
    if (!partition) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Partition for service ${serviceId} not found`
      });
    }

    partition.activeClientIds.delete(clientId);
    if (
      partition.activeClientIds.size === 0 &&
      partition.activeCallCount === 0 &&
      !partition.hasUncertainCalls
    ) {
      partition.idleSince = this.now().toISOString();
    }

    return ok(this.createObservation(partition));
  }

  beginCall(serviceId: string, scope: TrustScope): OperationResult<void> {
    const reg = this.registeredBackends.get(serviceId);
    if (!reg) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Service ${serviceId} not registered`
      });
    }
    const partitionKey = this.computePartitionKey(reg.definition, scope, reg.options);
    const partition = this.partitions.get(partitionKey);
    if (!partition) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Partition for service ${serviceId} not found`
      });
    }
    if (partition.status === "stopped") {
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: `Partition ${partitionKey} is not running`
      });
    }

    partition.activeCallCount++;
    partition.idleSince = null;
    return ok(undefined);
  }

  endCall(serviceId: string, scope: TrustScope, uncertain?: boolean): OperationResult<void> {
    const reg = this.registeredBackends.get(serviceId);
    if (!reg) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Service ${serviceId} not registered`
      });
    }
    const partitionKey = this.computePartitionKey(reg.definition, scope, reg.options);
    const partition = this.partitions.get(partitionKey);
    if (!partition) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Partition for service ${serviceId} not found`
      });
    }

    if (partition.activeCallCount > 0) {
      partition.activeCallCount--;
    }
    if (uncertain) {
      partition.hasUncertainCalls = true;
    }
    if (
      partition.activeClientIds.size === 0 &&
      partition.activeCallCount === 0 &&
      !partition.hasUncertainCalls
    ) {
      partition.idleSince = this.now().toISOString();
    }
    return ok(undefined);
  }

  resolveUncertainCalls(serviceId: string, scope: TrustScope): OperationResult<void> {
    const reg = this.registeredBackends.get(serviceId);
    if (!reg) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Service ${serviceId} not registered`
      });
    }
    const partitionKey = this.computePartitionKey(reg.definition, scope, reg.options);
    const partition = this.partitions.get(partitionKey);
    if (!partition) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Partition for service ${serviceId} not found`
      });
    }

    partition.hasUncertainCalls = false;
    if (partition.activeClientIds.size === 0 && partition.activeCallCount === 0) {
      partition.idleSince = this.now().toISOString();
    }
    return ok(undefined);
  }

  async sweepIdleBackends(nowParam?: Date): Promise<readonly MCPServiceObservation[]> {
    const currentTime = (nowParam ?? this.now()).getTime();
    const swept: MCPServiceObservation[] = [];

    for (const partition of this.partitions.values()) {
      if (partition.status !== "ready") {
        continue;
      }

      if (partition.activeClientIds.size > 0) {
        swept.push(this.createObservation(partition, { diagnosticCode: "retained_active_clients" }));
        continue;
      }
      if (partition.activeCallCount > 0) {
        swept.push(this.createObservation(partition, { diagnosticCode: "retained_active_calls" }));
        continue;
      }
      if (partition.hasUncertainCalls) {
        swept.push(this.createObservation(partition, { diagnosticCode: "retained_for_reconciliation" }));
        continue;
      }

      if (partition.idleSince === null) {
        partition.idleSince = new Date(currentTime).toISOString();
        continue;
      }

      const elapsed = currentTime - Date.parse(partition.idleSince);
      if (elapsed < partition.idleTimeoutMs) {
        continue;
      }

      if (partition.ownership === "external") {
        swept.push(this.createObservation(partition, { diagnosticCode: "external_retained" }));
        continue;
      }

      if (partition.crashListenerDisposer) {
        partition.crashListenerDisposer();
        partition.crashListenerDisposer = undefined;
      }
      if (partition.driver) {
        await partition.driver.stop("stopped_idle");
        partition.driver = undefined;
      }
      partition.status = "stopped";
      partition.diagnosticCode = "stopped_idle";
      partition.memoryRssBytes = 0;
      partition.idleSince = null;
      if (partition.ownership === "bflow") {
        this.activeProcessCount = Math.max(0, this.activeProcessCount - 1);
      }
      this.idleCleanupsCount++;

      swept.push(this.createObservation(partition));
    }

    return swept;
  }

  async sampleMemoryUsage(): Promise<ResourceManagerMetricsSnapshot> {
    for (const partition of this.partitions.values()) {
      if (partition.status !== "ready" || !partition.driver) {
        continue;
      }

      if (!partition.driver.isAlive()) {
        this.handleDriverCrash(partition, "process_exited");
        continue;
      }

      let rss = partition.memoryRssBytes;
      if (typeof partition.driver.getMemoryRssBytes === "function") {
        try {
          rss = await partition.driver.getMemoryRssBytes();
        } catch {
          // ignore error
        }
      } else if (partition.pid && process.platform === "linux") {
        try {
          const content = await fs.promises.readFile(`/proc/${partition.pid}/status`, "utf8");
          const match = content.match(/VmRSS:\s+(\d+)\s+kB/i);
          const vmRss = match?.[1];
          if (vmRss) {
            rss = parseInt(vmRss, 10) * 1024;
          }
        } catch {
          // ignore error
        }
      }

      partition.memoryRssBytes = rss;

      if (partition.memoryRssBytes > partition.maxMemoryBytes) {
        if (
          partition.activeCallCount === 0 ||
          partition.memoryRssBytes > partition.maxMemoryBytes * 1.5
        ) {
          if (partition.crashListenerDisposer) {
            partition.crashListenerDisposer();
            partition.crashListenerDisposer = undefined;
          }
          await partition.driver.stop("memory_limit_exceeded");
          partition.driver = undefined;
          partition.status = "stopped";
          partition.diagnosticCode = "memory_limit_exceeded";
          partition.memoryRssBytes = 0;
          if (partition.ownership === "bflow") {
            this.activeProcessCount = Math.max(0, this.activeProcessCount - 1);
          }
          this.memoryLimitTerminations++;
        }
      }
    }

    return this.getMetricsSnapshot();
  }

  getMetricsSnapshot(): ResourceManagerMetricsSnapshot {
    const totalMemory = this.getTotalMemoryRssBytes();
    if (totalMemory > this.peakMemoryRssBytes) {
      this.peakMemoryRssBytes = totalMemory;
    }

    let lazyStoppedCount = 0;
    let runningBackendCount = 0;
    let idleBackendCount = 0;
    const partitionsSnapshot: Record<string, PartitionResourceSnapshot> = {};

    for (const [key, p] of this.partitions.entries()) {
      partitionsSnapshot[key] = {
        partitionKey: p.partitionKey,
        serviceId: p.definition.serviceId,
        instanceId: p.instanceId,
        status: p.status,
        startupMode: p.startupMode,
        ownership: p.ownership,
        pid: p.pid,
        activeClientIds: Array.from(p.activeClientIds),
        attachedScopes: Array.from(p.attachedScopes),
        activeCallCount: p.activeCallCount,
        hasUncertainCalls: p.hasUncertainCalls,
        memoryRssBytes: p.memoryRssBytes,
        maxMemoryBytes: p.maxMemoryBytes,
        idleSince: p.idleSince,
        idleTimeoutMs: p.idleTimeoutMs,
        restartCount: p.restartCount,
        startGeneration: p.startGeneration,
        diagnosticCode: p.diagnosticCode
      };

      if (p.status === "stopped") {
        lazyStoppedCount++;
      } else if (p.status === "ready" || p.status === "starting") {
        runningBackendCount++;
        if (
          p.status === "ready" &&
          p.activeClientIds.size === 0 &&
          p.activeCallCount === 0 &&
          !p.hasUncertainCalls
        ) {
          idleBackendCount++;
        }
      }
    }

    return {
      activeProcessCount: this.activeProcessCount,
      maxProcessCount: this.maxProcessCount,
      totalMemoryRssBytes: totalMemory,
      peakMemoryRssBytes: this.peakMemoryRssBytes,
      maxTotalMemoryBytes: this.maxTotalMemoryBytes,
      lazyStoppedCount,
      runningBackendCount,
      idleBackendCount,
      idleCleanupsCount: this.idleCleanupsCount,
      memoryEvictionsCount: this.memoryEvictionsCount,
      memoryLimitTerminations: this.memoryLimitTerminations,
      processLimitRejections: this.processLimitRejections,
      partitions: partitionsSnapshot
    };
  }

  getTotalMemoryRssBytes(): number {
    let total = 0;
    for (const p of this.partitions.values()) {
      if (p.status === "ready" || p.status === "starting") {
        total += p.memoryRssBytes;
      }
    }
    return total;
  }

  private async evictIdleBackendsUnderPressure(): Promise<number> {
    let evicted = 0;
    for (const p of this.partitions.values()) {
      if (
        p.status === "ready" &&
        p.ownership === "bflow" &&
        p.activeClientIds.size === 0 &&
        p.activeCallCount === 0 &&
        !p.hasUncertainCalls
      ) {
        if (p.crashListenerDisposer) {
          p.crashListenerDisposer();
          p.crashListenerDisposer = undefined;
        }
        if (p.driver) {
          await p.driver.stop("evicted_under_pressure");
          p.driver = undefined;
        }
        p.status = "stopped";
        p.diagnosticCode = "evicted_under_pressure";
        p.memoryRssBytes = 0;
        this.activeProcessCount = Math.max(0, this.activeProcessCount - 1);
        this.memoryEvictionsCount++;
        evicted++;

        if (
          this.activeProcessCount < this.maxProcessCount &&
          this.getTotalMemoryRssBytes() < this.maxTotalMemoryBytes
        ) {
          break;
        }
      }
    }
    return evicted;
  }

  private handleDriverCrash(partition: PartitionState, reason: string): void {
    if (partition.driver) {
      if (partition.ownership === "bflow" && partition.status === "ready") {
        this.activeProcessCount = Math.max(0, this.activeProcessCount - 1);
      }
      partition.driver = undefined;
    }
    partition.status = "stopped";
    partition.diagnosticCode = `crashed_${reason}`;
    partition.memoryRssBytes = 0;
    partition.restartCount++;
    if (partition.crashListenerDisposer) {
      partition.crashListenerDisposer();
      partition.crashListenerDisposer = undefined;
    }
  }

  private formatScopeKey(scope: TrustScope): string {
    if (scope.kind === "machine") {
      return `machine:${scope.machineId}`;
    }
    if (scope.kind === "repository") {
      return `repo:${scope.machineId}:${scope.repositoryId}`;
    }
    return `session:${scope.machineId}:${scope.repositoryId}:${scope.sessionId}`;
  }

  private createObservation(
    partition: PartitionState,
    override?: {
      readonly status?: "ready" | "starting" | "blocked" | "stopped" | "unknown" | undefined;
      readonly diagnosticCode?: string | undefined;
    }
  ): MCPServiceObservation {
    const status = override?.status ?? partition.status;
    const diagnosticCode = override?.diagnosticCode ?? partition.diagnosticCode;

    const protocolVersion =
      status === "ready" ? (partition.protocolVersion ?? "2025-11-25") : undefined;
    const discoveredTools =
      status === "ready"
        ? partition.discoveredTools.length > 0
          ? partition.discoveredTools
          : [partition.definition.serviceId]
        : [];

    const observation: MCPServiceObservation = {
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      serviceId: partition.definition.serviceId,
      revision: partition.definition.revision,
      instanceId: partition.instanceId,
      status,
      protocolVersion,
      discoveredTools: [...discoveredTools],
      ownership: partition.ownership,
      activeClientCount: partition.activeClientIds.size,
      observedAt: this.now().toISOString(),
      diagnosticCode
    };

    return MCPServiceObservationSchema.parse(observation);
  }
}
