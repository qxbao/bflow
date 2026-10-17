import { describe, expect, it } from "vitest";
import {
  type MCPServiceDefinition,
  MCPServiceDefinitionSchema,
  MCPServiceObservationSchema,
  type ScopedOperation,
  type TrustScope
} from "@bflow/contracts";
import {
  type ManagedBackendDriver,
  type ManagedBackendDriverFactory,
  ok
} from "../src/types.js";
import { BackendResourceManager } from "../src/resource-manager.js";

class MockDriver implements ManagedBackendDriver {
  readonly instanceId: string;
  readonly pid?: number | undefined;
  readonly startGeneration: number;
  readonly ownership: "bflow" | "external";
  alive = true;
  memoryBytes = 10 * 1024 * 1024;
  stopReasons: string[] = [];
  crashListeners: ((reason: string) => void)[] = [];

  constructor(
    instanceId: string,
    ownership: "bflow" | "external",
    generation: number,
    pid = 1234
  ) {
    this.instanceId = instanceId;
    this.ownership = ownership;
    this.startGeneration = generation;
    this.pid = pid;
  }

  async initialize() {
    return ok({
      protocolVersion: "2024-11-05",
      discoveredTools: ["read_file", "search_tree"]
    });
  }

  async getMemoryRssBytes(): Promise<number> {
    return this.memoryBytes;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async stop(reason?: string): Promise<void> {
    this.alive = false;
    if (reason) {
      this.stopReasons.push(reason);
    }
  }

  onCrash(listener: (reason: string) => void): () => void {
    this.crashListeners.push(listener);
    return () => {
      this.crashListeners = this.crashListeners.filter((l) => l !== listener);
    };
  }

  simulateCrash(reason = "sigsegv"): void {
    this.alive = false;
    for (const l of [...this.crashListeners]) {
      l(reason);
    }
  }
}

class MockDriverFactory implements ManagedBackendDriverFactory {
  createdDrivers: MockDriver[] = [];
  driverCreationDelayMs = 0;
  nextPid = 1000;

  async createDriver(
    definition: MCPServiceDefinition,
    _partitionKey: string,
    generation: number
  ) {
    if (this.driverCreationDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.driverCreationDelayMs));
    }
    const instanceId = `inst-${definition.serviceId}-${this.createdDrivers.length + 1}`;
    const driver = new MockDriver(
      instanceId,
      definition.connection.ownership,
      generation,
      this.nextPid++
    );
    this.createdDrivers.push(driver);
    return ok(driver);
  }
}

function createMockServiceDefinition(
  overrides?: Partial<MCPServiceDefinition>
): MCPServiceDefinition {
  const serviceId = overrides?.serviceId ?? "test-service";
  const kind = overrides?.connection?.kind ?? "stdio_mcp";
  const ownership = kind === "stdio_mcp" ? "bflow" : "external";

  const def: MCPServiceDefinition = {
    schemaVersion: 3,
    serviceId,
    revision: 1,
    scope: { kind: "machine", machineId: "mach-1" },
    tool: {
      schemaVersion: 3,
      toolId: serviceId,
      kind,
      version: "1.0.0",
      operations: ["read", "write"],
      resource: { sharing: "concurrent", maxConcurrency: 5 },
      required: true
    },
    connection:
      kind === "stdio_mcp"
        ? {
            kind: "stdio_mcp",
            executable: "node",
            argv: ["server.js"],
            environmentBindings: {
              API_KEY: "secret://my-key"
            },
            executableDigest: "a".repeat(64),
            ownership: "bflow",
            bridgeRequired: true
          }
        : {
            kind: "native_remote_mcp",
            endpoint: "http://127.0.0.1:8080",
            ownership: "external"
          },
    authentication: { mode: "none" },
    healthTimeoutMs: 5000,
    idleTimeoutMs: 2000,
    restartLimit: 3,
    ...overrides
  };

  const parsed = MCPServiceDefinitionSchema.safeParse(def);
  if (!parsed.success) {
    throw new Error(`Invalid test definition: ${parsed.error.message}`);
  }
  return parsed.data;
}

function createMockOperation(overrides?: Partial<ScopedOperation>): ScopedOperation {
  return {
    schemaVersion: 3,
    scope: { kind: "machine", machineId: "mach-1" },
    idempotencyKey: `op-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...overrides
  };
}

describe("BackendResourceManager", () => {
  it("1. User session startup: lazy backends remain unstarted (0 processes, 0 RAM) while eager backends start immediately", async () => {
    const factory = new MockDriverFactory();
    const manager = new BackendResourceManager(factory);

    const lazyDef = createMockServiceDefinition({ serviceId: "lazy-heavy-service" });
    const eagerDef = createMockServiceDefinition({ serviceId: "eager-core-service" });

    manager.registerBackend(lazyDef, { startupMode: "lazy" });
    manager.registerBackend(eagerDef, { startupMode: "eager" });

    const scope: TrustScope = { kind: "machine", machineId: "mach-1" };
    const observations = await manager.initializeUserSession(scope);

    expect(observations).toHaveLength(2);

    const lazyObs = observations.find((o) => o.serviceId === "lazy-heavy-service")!;
    expect(lazyObs).toBeDefined();
    expect(lazyObs.status).toBe("stopped");
    expect(lazyObs.diagnosticCode).toBe("lazy_unstarted");
    expect(lazyObs.activeClientCount).toBe(0);
    expect(lazyObs.discoveredTools).toEqual([]);
    expect(MCPServiceObservationSchema.safeParse(lazyObs).success).toBe(true);

    const eagerObs = observations.find((o) => o.serviceId === "eager-core-service")!;
    expect(eagerObs).toBeDefined();
    expect(eagerObs.status).toBe("ready");
    expect(eagerObs.diagnosticCode).toBe("ok");
    expect(eagerObs.discoveredTools).toEqual(["read_file", "search_tree"]);
    expect(MCPServiceObservationSchema.safeParse(eagerObs).success).toBe(true);

    const metrics = manager.getMetricsSnapshot();
    expect(metrics.activeProcessCount).toBe(1);
    expect(metrics.runningBackendCount).toBe(1);
    expect(metrics.lazyStoppedCount).toBe(1);
    expect(factory.createdDrivers).toHaveLength(1);
  });

  it("2. Multiple clients (10 concurrent agents across claude, codex, agy) connecting to a lazy backend: triggers single-flight startup, spawns only 1 backend process, and reuses it", async () => {
    const factory = new MockDriverFactory();
    factory.driverCreationDelayMs = 30; // Simulate async startup delay
    const manager = new BackendResourceManager(factory);

    const lazyDef = createMockServiceDefinition({ serviceId: "shared-lazy-backend" });
    manager.registerBackend(lazyDef, { startupMode: "lazy" });

    const agentProviders = ["claude", "codex", "agy"] as const;
    const clientRoles = ["developer", "reviewer", "architect", "analyst"] as const;

    const clients = Array.from({ length: 10 }, (_, i) => {
      const provider = agentProviders[i % agentProviders.length];
      const role = clientRoles[i % clientRoles.length];
      return {
        clientId: `${provider}-${role}-${i + 1}`,
        operation: createMockOperation()
      };
    });

    const results = await Promise.all(
      clients.map((c) => manager.acquireClientSession("shared-lazy-backend", c.clientId, c.operation))
    );

    for (const res of results) {
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.status).toBe("ready");
        expect(res.value.activeClientCount).toBe(10);
        expect(res.value.instanceId).toBe(factory.createdDrivers[0].instanceId);
      }
    }

    expect(factory.createdDrivers).toHaveLength(1);
    expect(manager.getMetricsSnapshot().activeProcessCount).toBe(1);

    const partition = manager.getMetricsSnapshot().partitions["shared-lazy-backend@machine:mach-1"];
    expect(partition).toBeDefined();
    expect(partition.activeClientIds).toHaveLength(10);
  });

  it("3. Multiple repositories: Repo A and Repo B get isolated partitions for repository-scoped stdio backends without collision", async () => {
    const factory = new MockDriverFactory();
    const manager = new BackendResourceManager(factory);

    const stdioDef = createMockServiceDefinition({ serviceId: "repo-stdio-svc" });
    manager.registerBackend(stdioDef, { isolateByRepository: true });

    const scopeRepoA: TrustScope = {
      kind: "repository",
      machineId: "mach-1",
      repositoryId: "repo-alpha",
      workspaceRoot: "/workspace/alpha"
    };
    const scopeRepoB: TrustScope = {
      kind: "repository",
      machineId: "mach-1",
      repositoryId: "repo-beta",
      workspaceRoot: "/workspace/beta"
    };

    const opA = createMockOperation({ scope: scopeRepoA });
    const opB = createMockOperation({ scope: scopeRepoB });

    const resA = await manager.ensure(stdioDef, opA);
    const resB = await manager.ensure(stdioDef, opB);

    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    if (resA.ok && resB.ok) {
      expect(resA.value.instanceId).not.toBe(resB.value.instanceId);
    }

    expect(factory.createdDrivers).toHaveLength(2);
    expect(manager.getMetricsSnapshot().activeProcessCount).toBe(2);

    const keyA = manager.computePartitionKey(stdioDef, scopeRepoA, { isolateByRepository: true });
    const keyB = manager.computePartitionKey(stdioDef, scopeRepoB, { isolateByRepository: true });
    expect(keyA).toBe("repo-stdio-svc@repo:mach-1:repo-alpha");
    expect(keyB).toBe("repo-stdio-svc@repo:mach-1:repo-beta");

    // Another agent in Repo A reuses Repo A driver
    const opA2 = createMockOperation({
      scope: {
        kind: "session",
        machineId: "mach-1",
        repositoryId: "repo-alpha",
        workspaceRoot: "/workspace/alpha",
        sessionId: "sess-99"
      }
    });
    const resA2 = await manager.ensure(stdioDef, opA2);
    expect(resA2.ok).toBe(true);
    if (resA.ok && resA2.ok) {
      expect(resA2.value.instanceId).toBe(resA.value.instanceId);
    }
    expect(factory.createdDrivers).toHaveLength(2);
  });

  it("4. Active client protection: release and sweep refuse to stop backend while clients attached, calls in-flight, or uncertain calls exist", async () => {
    let mockTime = 10_000;
    const now = () => new Date(mockTime);

    const factory = new MockDriverFactory();
    const manager = new BackendResourceManager(factory, { now });

    const def = createMockServiceDefinition({ serviceId: "protected-svc", idleTimeoutMs: 500 });
    manager.registerBackend(def);

    const scope: TrustScope = { kind: "machine", machineId: "mach-1" };
    const op = createMockOperation({ scope });

    // Step A: Client is attached
    const attachRes = await manager.attachClient("protected-svc", "client-1", op);
    expect(attachRes.ok).toBe(true);
    const driver = factory.createdDrivers[0];
    expect(driver.isAlive()).toBe(true);

    // Release attempted while client is attached
    const rel1 = await manager.release("protected-svc", op, { forceImmediateStop: true });
    expect(rel1.ok).toBe(true);
    if (rel1.ok) {
      expect(rel1.value.status).toBe("ready");
      expect(rel1.value.diagnosticCode).toBe("retained_active_clients");
    }
    expect(driver.isAlive()).toBe(true);

    // Sweep attempted while client is attached
    mockTime += 2000;
    const sweep1 = await manager.sweepIdleBackends();
    expect(sweep1).toHaveLength(1);
    expect(sweep1[0].diagnosticCode).toBe("retained_active_clients");
    expect(driver.isAlive()).toBe(true);

    // Step B: Client detaches, but in-flight call is active
    await manager.detachClient("protected-svc", "client-1", op);
    manager.beginCall("protected-svc", scope);

    const rel2 = await manager.release("protected-svc", op, { forceImmediateStop: true });
    expect(rel2.ok).toBe(true);
    if (rel2.ok) {
      expect(rel2.value.status).toBe("ready");
      expect(rel2.value.diagnosticCode).toBe("retained_active_calls");
    }
    expect(driver.isAlive()).toBe(true);

    mockTime += 2000;
    const sweep2 = await manager.sweepIdleBackends();
    expect(sweep2).toHaveLength(1);
    expect(sweep2[0].diagnosticCode).toBe("retained_active_calls");
    expect(driver.isAlive()).toBe(true);

    // Step C: Call ends with uncertainty (awaiting reconciliation)
    manager.endCall("protected-svc", scope, true);

    const rel3 = await manager.release("protected-svc", op, { forceImmediateStop: true });
    expect(rel3.ok).toBe(true);
    if (rel3.ok) {
      expect(rel3.value.status).toBe("ready");
      expect(rel3.value.diagnosticCode).toBe("retained_for_reconciliation");
    }
    expect(driver.isAlive()).toBe(true);

    mockTime += 2000;
    const sweep3 = await manager.sweepIdleBackends();
    expect(sweep3).toHaveLength(1);
    expect(sweep3[0].diagnosticCode).toBe("retained_for_reconciliation");
    expect(driver.isAlive()).toBe(true);

    // Step D: Resolve uncertain calls, then sweep can clean up
    manager.resolveUncertainCalls("protected-svc", scope);
    mockTime += 1000;
    const sweep4 = await manager.sweepIdleBackends();
    expect(sweep4).toHaveLength(1);
    expect(sweep4[0].status).toBe("stopped");
    expect(sweep4[0].diagnosticCode).toBe("stopped_idle");
    expect(driver.isAlive()).toBe(false);
  });

  it("5. Idle timeout grace window: stays warm during idleTimeoutMs, reconnecting reuses instance, stops after idleTimeoutMs elapses", async () => {
    let mockTime = 100_000;
    const now = () => new Date(mockTime);

    const factory = new MockDriverFactory();
    const manager = new BackendResourceManager(factory, { now });

    const def = createMockServiceDefinition({ serviceId: "warm-svc", idleTimeoutMs: 1000 });
    manager.registerBackend(def);

    const op = createMockOperation();
    await manager.attachClient("warm-svc", "c1", op);
    const initialDriver = factory.createdDrivers[0];
    const initialInstanceId = initialDriver.instanceId;

    // Detach client at t=100_000
    await manager.detachClient("warm-svc", "c1", op);

    // Advance 400ms (< 1000ms idleTimeout)
    mockTime += 400;
    const sweepBefore = await manager.sweepIdleBackends();
    expect(sweepBefore).toHaveLength(0);
    expect(initialDriver.isAlive()).toBe(true);

    // Client reconnects within grace window at t=100_400
    const reattach = await manager.attachClient("warm-svc", "c2", op);
    expect(reattach.ok).toBe(true);
    if (reattach.ok) {
      expect(reattach.value.instanceId).toBe(initialInstanceId); // Warm reuse without respawn!
    }
    expect(factory.createdDrivers).toHaveLength(1);

    // Client detaches at t=100_500
    mockTime += 100;
    await manager.detachClient("warm-svc", "c2", op);

    // Advance 1200ms (> 1000ms idleTimeout) to t=101_700
    mockTime += 1200;
    const sweepAfter = await manager.sweepIdleBackends();
    expect(sweepAfter).toHaveLength(1);
    expect(sweepAfter[0].status).toBe("stopped");
    expect(sweepAfter[0].diagnosticCode).toBe("stopped_idle");
    expect(initialDriver.isAlive()).toBe(false);
    expect(manager.getMetricsSnapshot().idleCleanupsCount).toBe(1);
  });

  it("6. Process limits, memory usage tracking, idle eviction under pressure, and OOM termination", async () => {
    const factory = new MockDriverFactory();
    const manager = new BackendResourceManager(factory, {
      maxProcessCount: 2,
      maxTotalMemoryBytes: 1024 * 1024 * 1024
    });

    const s1 = createMockServiceDefinition({ serviceId: "svc-1", idleTimeoutMs: 10_000 });
    const s2 = createMockServiceDefinition({ serviceId: "svc-2", idleTimeoutMs: 10_000 });
    const s3 = createMockServiceDefinition({ serviceId: "svc-3", idleTimeoutMs: 10_000 });
    const s4 = createMockServiceDefinition({ serviceId: "svc-4", idleTimeoutMs: 10_000 });

    manager.registerBackend(s1);
    manager.registerBackend(s2);
    manager.registerBackend(s3);
    manager.registerBackend(s4);

    const op = createMockOperation();

    // Start svc-1 with client
    await manager.attachClient("svc-1", "c1", op);
    // Start svc-2 with client
    await manager.attachClient("svc-2", "c2", op);
    expect(manager.getMetricsSnapshot().activeProcessCount).toBe(2);

    // Detach client from svc-1 so svc-1 becomes idle (activeCallCount=0, activeClients=0)
    await manager.detachClient("svc-1", "c1", op);

    // Now start svc-3: manager must evict idle svc-1 under pressure
    const res3 = await manager.attachClient("svc-3", "c3", op);
    expect(res3.ok).toBe(true);
    expect(manager.getMetricsSnapshot().memoryEvictionsCount).toBe(1);
    expect(factory.createdDrivers[0].isAlive()).toBe(false); // svc-1 stopped
    expect(manager.getMetricsSnapshot().activeProcessCount).toBe(2); // svc-2 and svc-3 running

    // Now attempt to start svc-4 while both svc-2 and svc-3 have active clients
    const res4 = await manager.attachClient("svc-4", "c4", op);
    expect(res4.ok).toBe(false);
    if (!res4.ok) {
      expect(res4.error.code).toBe("transport_unavailable");
      expect((res4.error.details as any)?.diagnosticCode).toBe("process_limit_exceeded");
    }
    expect(manager.getMetricsSnapshot().processLimitRejections).toBe(1);

    // OOM Termination Test
    const oomDef = createMockServiceDefinition({ serviceId: "oom-svc" });
    manager.registerBackend(oomDef, { maxMemoryBytes: 50 * 1024 * 1024 }); // 50MB max

    // Detach svc-2 to free a process slot
    await manager.detachClient("svc-2", "c2", op);
    const oomRes = await manager.attachClient("oom-svc", "c-oom", op);
    expect(oomRes.ok).toBe(true);

    const oomDriver = factory.createdDrivers.find((d) => d.instanceId.includes("oom-svc"))!;
    oomDriver.memoryBytes = 100 * 1024 * 1024; // 100MB > 50MB max

    const metricsAfterSample = await manager.sampleMemoryUsage();
    expect(oomDriver.isAlive()).toBe(false);
    expect(oomDriver.stopReasons).toContain("memory_limit_exceeded");
    expect(metricsAfterSample.memoryLimitTerminations).toBe(1);

    const oomPartition = manager.getMetricsSnapshot().partitions["oom-svc@machine:mach-1"];
    expect(oomPartition.status).toBe("stopped");
    expect(oomPartition.diagnosticCode).toBe("memory_limit_exceeded");
  });

  it("7. External worker survival: adopted external backends are never killed during idle sweeps or release", async () => {
    let mockTime = 50_000;
    const now = () => new Date(mockTime);

    const factory = new MockDriverFactory();
    const manager = new BackendResourceManager(factory, { now });

    const extDef = createMockServiceDefinition({
      serviceId: "external-worker-svc",
      connection: {
        kind: "native_remote_mcp",
        endpoint: "http://127.0.0.1:8080",
        ownership: "external"
      },
      idleTimeoutMs: 500
    });
    manager.registerBackend(extDef);

    const op = createMockOperation();
    const ensureRes = await manager.ensure(extDef, op);
    expect(ensureRes.ok).toBe(true);

    const extDriver = factory.createdDrivers[0];
    expect(extDriver.ownership).toBe("external");
    expect(manager.getMetricsSnapshot().activeProcessCount).toBe(0); // External doesn't count against bflow processes

    // Advance past idleTimeout
    mockTime += 2000;
    const sweepRes = await manager.sweepIdleBackends();
    expect(extDriver.isAlive()).toBe(true); // Must NOT be killed!
    expect(sweepRes.some((o) => o.diagnosticCode === "external_retained")).toBe(true);

    // Call release on external backend
    const relRes = await manager.release("external-worker-svc", op, { forceImmediateStop: true });
    expect(relRes.ok).toBe(true);
    if (relRes.ok) {
      expect(relRes.value.status).toBe("ready");
      expect(relRes.value.diagnosticCode).toBe("external_retained");
    }
    expect(extDriver.isAlive()).toBe(true); // External worker STILL survives!
  });

  it("8. Crash recovery and validation edge cases", async () => {
    const factory = new MockDriverFactory();
    const manager = new BackendResourceManager(factory);

    // Invalid schema definition rejection
    const invalidDef = {
      schemaVersion: 2, // invalid version
      serviceId: "invalid-svc"
    } as any;
    const regRes = manager.registerBackend(invalidDef);
    expect(regRes.ok).toBe(false);
    if (!regRes.ok) {
      expect(regRes.error.code).toBe("validation");
    }

    // Inspect non-registered service
    const op = createMockOperation();
    const inspectRes = await manager.inspect("non-existent-svc", op);
    expect(inspectRes.ok).toBe(false);
    if (!inspectRes.ok) {
      expect(inspectRes.error.code).toBe("not_found");
    }

    // Crash recovery
    const crashDef = createMockServiceDefinition({ serviceId: "crash-svc" });
    manager.registerBackend(crashDef);
    const start1 = await manager.ensure(crashDef, op);
    expect(start1.ok).toBe(true);
    const driver1 = factory.createdDrivers[0];

    // Simulate crash
    driver1.simulateCrash("sigkill");
    const inspectAfterCrash = await manager.inspect("crash-svc", op);
    expect(inspectAfterCrash.ok).toBe(true);
    if (inspectAfterCrash.ok) {
      expect(inspectAfterCrash.value.status).toBe("stopped");
      expect(inspectAfterCrash.value.diagnosticCode).toBe("crashed_sigkill");
    }

    // Ensure again restarts the driver
    const start2 = await manager.ensure(crashDef, op);
    expect(start2.ok).toBe(true);
    expect(factory.createdDrivers).toHaveLength(2);
    expect(factory.createdDrivers[1].startGeneration).toBe(2);
    if (start2.ok) {
      expect(start2.value.status).toBe("ready");
    }
  });

  it("9. maxConcurrentClients rejection and multi-scope retention on release", async () => {
    const factory = new MockDriverFactory();
    const manager = new BackendResourceManager(factory);

    const serviceDef = createMockServiceDefinition({
      serviceId: "pooled-service"
    });

    // 1. Test maxConcurrentClients
    manager.registerBackend(serviceDef, { maxConcurrentClients: 2 });
    const scope1: TrustScope = {
      kind: "session",
      machineId: "m1",
      repositoryId: "repo-1",
      workspaceRoot: "/workspace/repo-1",
      sessionId: "s1"
    };
    const op1 = createMockOperation({ scope: scope1 });

    const attach1 = await manager.attachClient("pooled-service", "client-1", op1);
    expect(attach1.ok).toBe(true);
    if (attach1.ok) {
      expect(attach1.value.activeClientCount).toBe(1);
    }

    const attach2 = await manager.attachClient("pooled-service", "client-2", op1);
    expect(attach2.ok).toBe(true);
    if (attach2.ok) {
      expect(attach2.value.activeClientCount).toBe(2);
    }

    // 3rd client exceeds limit
    const attach3 = await manager.attachClient("pooled-service", "client-3", op1);
    expect(attach3.ok).toBe(false);
    if (!attach3.ok) {
      expect(attach3.error.code).toBe("conflict");
      expect(attach3.error.retryable).toBe(true);
      expect(attach3.error.details).toMatchObject({
        diagnosticCode: "client_limit_exceeded",
        serviceId: "pooled-service",
        maxConcurrentClients: 2
      });
    }

    // Re-attaching existing client succeeds
    const reattach1 = await manager.attachClient("pooled-service", "client-1", op1);
    expect(reattach1.ok).toBe(true);

    // Detach clients before testing release
    await manager.detachClient("pooled-service", "client-1", op1);
    await manager.detachClient("pooled-service", "client-2", op1);

    // 2. Test multi-scope retention on release
    // Two session scopes in the same repository share the stdio_mcp partition
    const scopeA: TrustScope = {
      kind: "session",
      machineId: "m1",
      repositoryId: "repo-1",
      workspaceRoot: "/workspace/repo-1",
      sessionId: "s-A"
    };
    const scopeB: TrustScope = {
      kind: "session",
      machineId: "m1",
      repositoryId: "repo-1",
      workspaceRoot: "/workspace/repo-1",
      sessionId: "s-B"
    };
    const opA = createMockOperation({ scope: scopeA });
    const opB = createMockOperation({ scope: scopeB });

    const ensureA = await manager.ensure(serviceDef, opA);
    expect(ensureA.ok).toBe(true);
    const ensureB = await manager.ensure(serviceDef, opB);
    expect(ensureB.ok).toBe(true);

    // Release scope A without forceImmediateStop -> retains backend because scope B is still attached
    const releaseA = await manager.release("pooled-service", opA);
    expect(releaseA.ok).toBe(true);
    if (releaseA.ok) {
      expect(releaseA.value.status).toBe("ready");
      expect(releaseA.value.diagnosticCode).toBe("retained_attached_scopes");
    }

    // Release scope B (last scope) with forceImmediateStop -> stops partition
    const releaseB = await manager.release("pooled-service", opB, { forceImmediateStop: true });
    expect(releaseB.ok).toBe(true);
    if (releaseB.ok) {
      expect(releaseB.value.status).toBe("stopped");
      expect(releaseB.value.diagnosticCode).toBe("released");
    }
  });
});
