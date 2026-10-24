import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  MCPClientRegistration,
  MCPResourceLease,
  MCPResourceRequest,
  MCPServiceDefinition,
  MCPToolCall,
  OperationOptions,
  OperationResult,
  ScopedOperation,
  TrustScope
} from "@bflow/contracts";
import { CURRENT_PLATFORM_SCHEMA_VERSION } from "@bflow/contracts";
import {
  BflowSharedMCPGateway,
  type BflowSharedMCPGatewayOptions,
  DefaultMCPServiceManager,
  GatewayMetricsCollector,
  GatewaySecretStore,
  MCPServiceRegistry,
  StdioToHttpBridge,
  SubprocessStdioDriverFactory,
  StreamableHttpGatewayServer,
  checkSchemaVersion,
  computePartitionKey,
  evaluateSharingCompatibility,
  isInteractiveMethodForbidden,
  ok,
  err,
  scrubSecrets,
  validateLoopbackHost,
  validateRequestOrigin,
  type MCPUpstreamDriverFactory,
  type MCPUpstreamDriverInstance,
  type MCPUpstreamInitializeResult,
  type MCPUpstreamReconcileResult,
  type MCPUpstreamToolCallInput,
  type MCPUpstreamToolCallOutput,
  type RegisteredMCPServiceEntry,
  normalizeUpstreamToolList,
  MCP_TOOL_DEFINITION_LIMITS,
  validateJsonSchema
} from "../src/index.js";

// ============================================================================
// Test Fixture Factories
// ============================================================================

function makeScope(
  kind: "machine" | "repository" | "session",
  options?: { machineId?: string; repoId?: string; sessionId?: string }
): TrustScope {
  const machineId = options?.machineId ?? "machine-test-1";
  if (kind === "machine") {
    return { kind: "machine", machineId };
  }
  const repositoryId = options?.repoId ?? "repo-main";
  const workspaceRoot = "/workspace";
  if (kind === "repository") {
    return { kind: "repository", machineId, repositoryId, workspaceRoot };
  }
  return {
    kind: "session",
    machineId,
    repositoryId,
    workspaceRoot,
    sessionId: options?.sessionId ?? `sess-${randomUUID().slice(0, 8)}`
  };
}

function makeScopedOp(scope?: TrustScope): ScopedOperation {
  return {
    schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
    scope: scope ?? makeScope("repository"),
    idempotencyKey: `idemp-op-${randomUUID()}`
  };
}

function makeServiceDefinition(
  serviceId: string,
  overrides?: Partial<MCPServiceDefinition>
): MCPServiceDefinition {
  const connectionKind = overrides?.connection?.kind ?? "stdio_mcp";
  let connection: any;
  let toolKind: any;

  if (connectionKind === "stdio_mcp") {
    toolKind = "stdio_mcp";
    connection = {
      kind: "stdio_mcp",
      executable: "node",
      argv: ["test-worker.js"],
      environmentBindings: {},
      executableDigest: "0".repeat(64),
      ownership: "bflow",
      bridgeRequired: true
    };
  } else if (connectionKind === "existing_shared_worker") {
    toolKind = "existing_shared_worker";
    connection = {
      kind: "existing_shared_worker",
      endpoint: "http://127.0.0.1:8080",
      workerId: `worker-${serviceId}`,
      ownership: "external"
    };
  } else {
    toolKind = "native_remote_mcp";
    connection = {
      kind: "native_remote_mcp",
      endpoint: "http://127.0.0.1:8080",
      ownership: "external"
    };
  }

  const sharing = overrides?.tool?.resource?.sharing ?? "concurrent";
  const resource =
    sharing === "exclusive"
      ? { sharing: "exclusive" as const, resourceKey: `res-${serviceId}` }
      : {
          sharing: "concurrent" as const,
          maxConcurrency: (overrides?.tool?.resource as any)?.maxConcurrency ?? 8
        };

  return {
    schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
    serviceId,
    revision: 1,
    scope: overrides?.scope ?? makeScope("machine"),
    tool: {
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      toolId: serviceId,
      kind: toolKind,
      version: "1.0.0",
      operations: overrides?.tool?.operations ?? ["echo", "compute"],
      resource,
      required: true
    },
    connection: overrides?.connection ?? connection,
    authentication: overrides?.authentication ?? { mode: "none" },
    healthTimeoutMs: 5000,
    idleTimeoutMs: 60000,
    restartLimit: overrides?.restartLimit ?? 3,
    ...overrides
  };
}

function makeClientRegistration(
  regId: string,
  serviceId: string,
  overrides?: Partial<MCPClientRegistration>
): MCPClientRegistration {
  const provider = overrides?.provider ?? "claude";
  const role = overrides?.role ?? "developer";
  return {
    schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
    registrationId: regId,
    provider,
    role,
    scope: overrides?.scope ?? (makeScope("session") as any),
    environmentId: "env-1",
    serviceIds: [serviceId],
    allowedTools: overrides?.allowedTools ?? ["echo", "compute"],
    connection: overrides?.connection ?? {
      transport: "streamable_http",
      endpoint: "http://127.0.0.1:8080",
      token: `secret://tokens/${regId}`
    },
    configDigest: "a".repeat(64),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    idempotencyKey: `idemp-reg-${regId}`,
    ...overrides
  };
}

interface MockDriverHooks {
  onInitialize?: (options?: OperationOptions) => Promise<OperationResult<MCPUpstreamInitializeResult>>;
  onListTools?: (sessionId: string) => Promise<OperationResult<readonly string[]>>;
  onCallTool?: (input: MCPUpstreamToolCallInput) => Promise<OperationResult<MCPUpstreamToolCallOutput>>;
  onCancelRequest?: (requestId: string, reason?: string) => Promise<void>;
  onReconcileRequest?: (callId: string, requestId: string) => Promise<MCPUpstreamReconcileResult>;
  onGetMemoryRssBytes?: () => Promise<number>;
  onStop?: (reason?: string) => Promise<void>;
}

class ControlledMockDriverInstance implements MCPUpstreamDriverInstance {
  readonly instanceId: string;
  readonly pid?: number;
  readonly startGeneration: number;
  readonly ownership: "bflow" | "external";
  private alive = true;
  private readonly crashListeners = new Set<(reason: string) => void>();

  constructor(
    readonly entry: RegisteredMCPServiceEntry,
    readonly partitionKey: string,
    startGeneration: number,
    private readonly hooks?: MockDriverHooks,
    pid?: number
  ) {
    this.startGeneration = startGeneration;
    this.ownership = entry.definition.connection.ownership;
    this.instanceId = `${entry.definition.serviceId}:${partitionKey}:${startGeneration}`;
    this.pid = pid ?? 9999;
  }

  isAlive(): boolean {
    return this.alive;
  }

  triggerCrash(reason: string): void {
    if (!this.alive) return;
    this.alive = false;
    for (const l of this.crashListeners) {
      try {
        l(reason);
      } catch {
        // ignore
      }
    }
  }

  onCrash(listener: (reason: string) => void): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  async stop(reason?: string): Promise<void> {
    this.alive = false;
    if (this.hooks?.onStop) {
      await this.hooks.onStop(reason);
    }
  }

  async initialize(options?: OperationOptions): Promise<OperationResult<MCPUpstreamInitializeResult>> {
    if (this.hooks?.onInitialize) {
      return this.hooks.onInitialize(options);
    }
    return ok({
      protocolVersion: "2025-11-25",
      discoveredTools: this.entry.definition.tool.operations,
      serverInfo: { name: "mock-backend", version: "1.0.0" }
    });
  }

  async listTools(sessionId: string, _options?: OperationOptions): Promise<OperationResult<readonly string[]>> {
    if (this.hooks?.onListTools) {
      return this.hooks.onListTools(sessionId);
    }
    return ok(this.entry.definition.tool.operations);
  }

  async callTool(input: MCPUpstreamToolCallInput): Promise<OperationResult<MCPUpstreamToolCallOutput>> {
    if (!this.alive) {
      return err({ code: "transport_unavailable", retryable: true, message: "Driver dead" });
    }
    if (this.hooks?.onCallTool) {
      return this.hooks.onCallTool(input);
    }
    return ok({
      isError: false,
      content: { echo: input.arguments, tool: input.tool }
    });
  }

  async cancelRequest(requestId: string, reason?: string): Promise<void> {
    if (this.hooks?.onCancelRequest) {
      await this.hooks.onCancelRequest(requestId, reason);
    }
  }

  async reconcileRequest(callId: string, requestId: string): Promise<MCPUpstreamReconcileResult> {
    if (this.hooks?.onReconcileRequest) {
      return this.hooks.onReconcileRequest(callId, requestId);
    }
    return { status: "unknown" };
  }

  async getMemoryRssBytes(): Promise<number> {
    if (this.hooks?.onGetMemoryRssBytes) {
      return this.hooks.onGetMemoryRssBytes();
    }
    return 1024 * 1024;
  }
}

class ProgrammableDriverFactory implements MCPUpstreamDriverFactory {
  createCount = 0;
  createdInstances: ControlledMockDriverInstance[] = [];

  constructor(
    private readonly hookBuilder?: (
      entry: RegisteredMCPServiceEntry,
      partitionKey: string,
      gen: number
    ) => MockDriverHooks
  ) {}

  async createInstance(
    entry: RegisteredMCPServiceEntry,
    partitionKey: string,
    startGeneration: number
  ): Promise<OperationResult<MCPUpstreamDriverInstance>> {
    this.createCount++;
    const hooks = this.hookBuilder ? this.hookBuilder(entry, partitionKey, startGeneration) : undefined;
    const inst = new ControlledMockDriverInstance(
      entry,
      partitionKey,
      startGeneration,
      hooks,
      1000 + this.createCount
    );
    this.createdInstances.push(inst);
    return ok(inst);
  }
}

function createStreamMockBridge(options?: {
  tools?: string[];
  callHandler?: (params: { tool: string; args: any; reqId: string }) => any;
  noAutoReplyToCall?: boolean;
  onMethod?: (method: string, params: any) => void;
  maxFrameBytes?: number;
  maxPendingWrites?: number;
}) {
  const toBridge = new PassThrough(); // Upstream stdout -> Bridge stdout
  const fromBridge = new PassThrough(); // Bridge stdin -> Upstream stdin
  const tools = options?.tools ?? ["echo", "compute"];

  fromBridge.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (options?.onMethod) {
          options.onMethod(msg.method, msg.params);
        }
        if (msg.method === "initialize") {
          toBridge.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "stream-mock", version: "1.0.0" }
              }
            }) + "\n"
          );
        } else if (msg.method === "tools/list") {
          toBridge.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: tools.map(name => ({ name }))
              }
            }) + "\n"
          );
        } else if (msg.method === "tools/call") {
          if (options?.noAutoReplyToCall) {
            return;
          }
          const content = options?.callHandler
            ? options.callHandler({
                tool: msg.params?.name,
                args: msg.params?.arguments,
                reqId: String(msg.id)
              })
            : { echo: msg.params?.arguments };
          toBridge.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { isError: false, content }
            }) + "\n"
          );
        }
      } catch {
        // parse error ignored
      }
    }
  });

  const bridge = new StdioToHttpBridge({
    instanceId: `bridge-${randomUUID().slice(0, 6)}`,
    startGeneration: 1,
    stdin: fromBridge,
    stdout: toBridge,
    pid: 5432,
    ...(options?.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
    ...(options?.maxPendingWrites !== undefined ? { maxPendingWrites: options.maxPendingWrites } : {})
  });

  return { bridge, toBridge, fromBridge };
}

// ============================================================================
// Comprehensive Vitest Suite
// ============================================================================

describe("@bflow/mcp-gateway Verification & Architecture Invariants", () => {
  // --------------------------------------------------------------------------
  // Scenario 1: 10 Concurrent Clients Connecting Simultaneously
  // --------------------------------------------------------------------------
  describe("Scenario 1: 10 Concurrent Clients Connecting Simultaneously", () => {
    let gateway: BflowSharedMCPGateway;
    let server: StreamableHttpGatewayServer;
    let serverUrl: string;
    const providers = ["claude", "codex", "agy"] as const;
    const roles = [
      "developer",
      "reviewer",
      "qa",
      "tester",
      "coordinator",
      "planner",
      "architect",
      "specifier",
      "developer",
      "reviewer"
    ] as const;

    beforeAll(async () => {
      const driverFactory = new ProgrammableDriverFactory((_entry, _part, _gen) => ({
        onCallTool: async input => {
          // Add small jitter to simulate concurrent processing
          await new Promise(r => setTimeout(r, Math.random() * 20 + 5));
          return ok({
            isError: false,
            content: { clientPayload: input.arguments, processedBy: "mock" }
          });
        }
      }));

      gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });

      const serviceDef = makeServiceDefinition("svc-concurrent-10");
      gateway.registry.registerService(serviceDef);

      server = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
      serverUrl = await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    it("serves 10 simultaneous clients with overlapping JSON-RPC IDs without correlation collision", async () => {
      const clientCount = 10;
      const clientTokens: string[] = [];

      for (let i = 0; i < clientCount; i++) {
        const reg = makeClientRegistration(`client-${i}`, "svc-concurrent-10", {
          provider: providers[i % providers.length],
          role: roles[i % roles.length],
          scope: makeScope("session", { repoId: "repo-concurrent", sessionId: `sess-${i}` }) as any
        });
        const regRes = await gateway.register(reg);
        expect(regRes.ok).toBe(true);

        const token = gateway.secretStore.getClientTokenByRegistration(reg.registrationId);
        expect(token).toBeDefined();
        clientTokens.push(token!);
      }

      // Simultaneously dispatch 10 HTTP requests with id: 1
      const requests = clientTokens.map(async (token, idx) => {
        const res = await fetch(`${serverUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1, // Deliberate overlap across all 10 clients!
            method: "tools/call",
            params: {
              name: "echo",
              arguments: { clientIndex: idx, secretSeed: `seed-${idx}` }
            }
          })
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        return { idx, data };
      });

      const results = await Promise.all(requests);

      expect(results.length).toBe(10);
      for (const { idx, data } of results) {
        expect(data.jsonrpc).toBe("2.0");
        expect(data.id).toBe(1);
        expect(data.result).toBeDefined();
        expect(data.result.status).toBe("completed");
        expect(data.result.output.clientPayload.clientIndex).toBe(idx);
        expect(data.result.output.clientPayload.secretSeed).toBe(`seed-${idx}`);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Reusing a Running Backend (activeProcessCount === 1)
  // --------------------------------------------------------------------------
  describe("Scenario 2: Reusing a Running Backend (activeProcessCount === 1)", () => {
    it("ensures driver instance is created only ONCE when called concurrently and sequentially", async () => {
      const driverFactory = new ProgrammableDriverFactory();
      const serviceManager = new DefaultMCPServiceManager({ driverFactory });
      const service = makeServiceDefinition("svc-reuse-test");

      const repoScope = makeScope("repository", { repoId: "repo-reuse" });

      // 10 concurrent ensure calls from 10 different session operations in the same repo
      const concurrentCalls = Array.from({ length: 10 }, (_, i) => {
        const sessionScope = makeScope("session", { repoId: "repo-reuse", sessionId: `sess-reuse-${i}` });
        return serviceManager.ensure(service, makeScopedOp(sessionScope));
      });

      const concurrentResults = await Promise.all(concurrentCalls);
      for (const res of concurrentResults) {
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.value.status).toBe("ready");
          expect(res.value.instanceId).toBe(concurrentResults[0].ok ? (concurrentResults[0] as any).value.instanceId : "");
        }
      }

      // 10 sequential ensure calls
      for (let i = 0; i < 10; i++) {
        const sessionScope = makeScope("session", { repoId: "repo-reuse", sessionId: `sess-seq-${i}` });
        const res = await serviceManager.ensure(service, makeScopedOp(sessionScope));
        expect(res.ok).toBe(true);
      }

      expect(driverFactory.createCount).toBe(1);
      expect(serviceManager.metrics.snapshot().activeProcessCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Backend Lifecycle & Bounded restartLimit & External Worker Survival
  // --------------------------------------------------------------------------
  describe("Scenario 3: Backend Lifecycle & Bounded restartLimit & External Worker Survival", () => {
    it("transitions through start, status, health, restart, stop, and enforces restartLimit", async () => {
      const driverFactory = new ProgrammableDriverFactory();
      const serviceManager = new DefaultMCPServiceManager({ driverFactory });
      const service = makeServiceDefinition("svc-lifecycle", { restartLimit: 2 });
      serviceManager.registry.registerService(service);

      const op = makeScopedOp(makeScope("repository", { repoId: "repo-life" }));

      // start
      const startRes = await serviceManager.start("svc-lifecycle", op);
      expect(startRes.ok).toBe(true);
      if (startRes.ok) {
        expect(startRes.value.status).toBe("ready");
      }

      // status & health
      const statusRes = await serviceManager.status("svc-lifecycle", op);
      expect(statusRes.ok).toBe(true);
      const healthRes = await serviceManager.health("svc-lifecycle", op);
      expect(healthRes.ok).toBe(true);

      // restart #1
      const restart1 = await serviceManager.restart("svc-lifecycle", op);
      expect(restart1.ok).toBe(true);
      if (restart1.ok) {
        expect(restart1.value.status).toBe("ready");
        expect(restart1.value.instanceId).toContain(":2");
      }

      // restart #2
      const restart2 = await serviceManager.restart("svc-lifecycle", op);
      expect(restart2.ok).toBe(true);
      if (restart2.ok) {
        expect(restart2.value.status).toBe("ready");
        expect(restart2.value.instanceId).toContain(":3");
      }

      // restart #3 -> exceeds restartLimit of 2
      const restart3 = await serviceManager.restart("svc-lifecycle", op);
      expect(restart3.ok).toBe(true);
      if (restart3.ok) {
        expect(restart3.value.status).toBe("blocked");
        expect(restart3.value.diagnosticCode).toBe("restart_limit_exceeded");
      }
    });

    it("NEVER stops an external worker on release or stop", async () => {
      let externalDriverStopped = false;
      const driverFactory = new ProgrammableDriverFactory(() => ({
        onStop: async () => {
          externalDriverStopped = true;
        }
      }));

      const serviceManager = new DefaultMCPServiceManager({ driverFactory });
      const extService = makeServiceDefinition("svc-external-worker", {
        connection: {
          kind: "existing_shared_worker",
          endpoint: "http://127.0.0.1:8080",
          workerId: "ext-1",
          ownership: "external"
        }
      });
      serviceManager.registry.registerService(extService);

      const op = makeScopedOp(makeScope("repository", { repoId: "repo-ext" }));
      const ensureRes = await serviceManager.ensure(extService, op);
      expect(ensureRes.ok).toBe(true);

      // release
      const releaseRes = await serviceManager.release("svc-external-worker", op);
      expect(releaseRes.ok).toBe(true);
      expect(externalDriverStopped).toBe(false);

      // stop
      const stopRes = await serviceManager.stop("svc-external-worker", op);
      expect(stopRes.ok).toBe(true);
      expect(externalDriverStopped).toBe(false);
      if (stopRes.ok) {
        expect(stopRes.value.diagnosticCode).toBe("external_worker_detached");
      }
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Client Disconnect & Revocation
  // --------------------------------------------------------------------------
  describe("Scenario 4: Client Disconnect & Revocation", () => {
    it("handles client disconnect, token revocation with 401, while unaffected clients continue", async () => {
      const driverFactory = new ProgrammableDriverFactory();
      const gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });
      const service = makeServiceDefinition("svc-disconnect-test");
      gateway.registry.registerService(service);

      const server = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
      const serverUrl = await server.start();

      try {
        const clientTokens: string[] = [];
        const clientRegs: MCPClientRegistration[] = [];

        for (let i = 0; i < 10; i++) {
          const reg = makeClientRegistration(`disc-client-${i}`, "svc-disconnect-test", {
            scope: makeScope("session", { repoId: "repo-disc", sessionId: `disc-sess-${i}` }) as any
          });
          const res = await gateway.register(reg);
          expect(res.ok).toBe(true);
          clientRegs.push(reg);
          clientTokens.push(gateway.secretStore.getClientTokenByRegistration(reg.registrationId)!);
        }

        // Open session for Client 0
        const session0Res = gateway.openSession(clientRegs[0].registrationId);
        expect(session0Res.ok).toBe(true);
        const session0Id = session0Res.ok ? session0Res.value.sessionId : "";

        expect(gateway.getMetrics().activeClientConnections).toBe(1);

        // Disconnect Client 0 via DELETE /mcp
        const delRes = await fetch(`${serverUrl}/mcp`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${clientTokens[0]}`,
            "Mcp-Session-Id": session0Id
          }
        });
        expect(delRes.status).toBe(204);
        expect(gateway.getMetrics().activeClientConnections).toBe(0);

        // Revoke Client 0
        const revokeRes = await gateway.revoke(
          clientRegs[0].registrationId,
          makeScopedOp(clientRegs[0].scope)
        );
        expect(revokeRes.ok).toBe(true);

        // Client 0 calling with revoked token gets 401 Unauthorized
        const call0Res = await fetch(`${serverUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${clientTokens[0]}`
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "echo", arguments: { ping: true } }
          })
        });
        expect(call0Res.status).toBe(401);

        // Client 1..9 continue to work unaffected
        for (let i = 1; i < 10; i++) {
          const callRes = await fetch(`${serverUrl}/mcp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${clientTokens[i]}`
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "echo", arguments: { client: i } }
            })
          });
          expect(callRes.status).toBe(200);
          const data = await callRes.json();
          expect(data.result.output.echo.client).toBe(i);
        }
      } finally {
        await server.stop();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Sharing Policy & Resource Isolation
  // --------------------------------------------------------------------------
  describe("Scenario 5: Sharing Policy & Resource Isolation", () => {
    it("partitions stdio_mcp by repository so Repo A and Repo B get distinct backends", async () => {
      const driverFactory = new ProgrammableDriverFactory();
      const serviceManager = new DefaultMCPServiceManager({ driverFactory });
      const service = makeServiceDefinition("svc-repo-iso");

      const scopeA = makeScope("repository", { repoId: "repo-A" });
      const scopeB = makeScope("repository", { repoId: "repo-B" });

      const resA = await serviceManager.ensure(service, makeScopedOp(scopeA));
      const resB = await serviceManager.ensure(service, makeScopedOp(scopeB));

      expect(resA.ok).toBe(true);
      expect(resB.ok).toBe(true);

      if (resA.ok && resB.ok) {
        expect(resA.value.instanceId).not.toBe(resB.value.instanceId);
        expect(resA.value.instanceId).toContain("repo:repo-A");
        expect(resB.value.instanceId).toContain("repo:repo-B");
      }

      expect(driverFactory.createCount).toBe(2);
      expect(serviceManager.metrics.snapshot().activeProcessCount).toBe(2);
    });

    it("blocks services with unsupported concurrencyModel or unsafe_unshareable policy", async () => {
      const serviceManager = new DefaultMCPServiceManager();
      const unsafeService = makeServiceDefinition("svc-unsafe");

      serviceManager.registry.registerService(unsafeService, {
        concurrencyModel: "unsupported"
      });

      const res = await serviceManager.ensure(unsafeService, makeScopedOp());
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.status).toBe("blocked");
        expect(res.value.diagnosticCode).toBe("sharing_unsupported");
      }
    });

    it("enforces exclusive lease and monotonic fencing token for exclusive/browser tools", async () => {
      const driverFactory = new ProgrammableDriverFactory();
      const gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });
      const service = makeServiceDefinition("svc-exclusive-browser", {
        tool: {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          toolId: "svc-exclusive-browser",
          kind: "stdio_mcp",
          version: "1.0.0",
          operations: ["navigate", "click"],
          resource: { sharing: "exclusive", resourceKey: "browser-tab-1" },
          required: true
        }
      });
      gateway.registry.registerService(service);

      const clientA = makeClientRegistration("client-excl-A", "svc-exclusive-browser", {
        allowedTools: ["navigate", "click"]
      });
      const clientB = makeClientRegistration("client-excl-B", "svc-exclusive-browser", {
        allowedTools: ["navigate", "click"]
      });
      await gateway.register(clientA);
      await gateway.register(clientB);

      // 1. Tool call without lease is rejected
      const callNoLease: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-1",
        registrationId: clientA.registrationId,
        serviceId: "svc-exclusive-browser",
        tool: "navigate",
        input: { url: "https://example.com" },
        idempotencyKey: "idemp-call-1"
      };
      const resNoLease = await gateway.call(callNoLease);
      expect(resNoLease.ok).toBe(false);
      if (!resNoLease.ok) {
        expect((resNoLease.error.details as any)?.diagnosticCode).toBe("lease_required");
      }

      // 2. Client A acquires resource lease -> fencingToken = 1
      const reqLeaseA: MCPResourceRequest = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        scope: clientA.scope,
        registrationId: clientA.registrationId,
        serviceId: "svc-exclusive-browser",
        resourceKey: "browser-tab-1",
        ttlMs: 60_000,
        idempotencyKey: "idemp-lease-A1"
      };
      const leaseARes = await gateway.acquireResource(reqLeaseA);
      expect(leaseARes.ok).toBe(true);
      const leaseA = leaseARes.ok ? leaseARes.value : ({} as MCPResourceLease);
      expect(leaseA.fencingToken).toBe(1);

      // 3. Client B attempts to call with Client A's lease -> rejected
      const callWithOtherLease: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-2",
        registrationId: clientB.registrationId,
        serviceId: "svc-exclusive-browser",
        tool: "navigate",
        input: { url: "https://example.com" },
        resourceLease: leaseA,
        idempotencyKey: "idemp-call-2"
      };
      const resOtherLease = await gateway.call(callWithOtherLease);
      expect(resOtherLease.ok).toBe(false);

      // 4. Client A calls with valid lease -> succeeds
      const callValidA: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-3",
        registrationId: clientA.registrationId,
        serviceId: "svc-exclusive-browser",
        tool: "navigate",
        input: { url: "https://example.com" },
        resourceLease: leaseA,
        idempotencyKey: "idemp-call-3"
      };
      const resValidA = await gateway.call(callValidA);
      expect(resValidA.ok).toBe(true);

      // 5. Release lease and acquire new lease for Client B -> fencingToken = 2
      await gateway.releaseResource(leaseA, makeScopedOp(clientA.scope));

      const reqLeaseB: MCPResourceRequest = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        scope: clientB.scope,
        registrationId: clientB.registrationId,
        serviceId: "svc-exclusive-browser",
        resourceKey: "browser-tab-1",
        ttlMs: 60_000,
        idempotencyKey: "idemp-lease-B1"
      };
      const leaseBRes = await gateway.acquireResource(reqLeaseB);
      expect(leaseBRes.ok).toBe(true);
      const leaseB = leaseBRes.ok ? leaseBRes.value : ({} as MCPResourceLease);
      expect(leaseB.fencingToken).toBe(2);

      // 6. Stale fence call with leaseA is rejected
      const callStaleA: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-4",
        registrationId: clientA.registrationId,
        serviceId: "svc-exclusive-browser",
        tool: "navigate",
        input: { url: "https://example.com" },
        resourceLease: leaseA,
        idempotencyKey: "idemp-call-4"
      };
      const resStaleA = await gateway.call(callStaleA);
      expect(resStaleA.ok).toBe(false);
      if (!resStaleA.ok) {
        expect((resStaleA.error.details as any)?.diagnosticCode).toBe("stale_lease");
      }
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Tool Call Timeouts (Pre-Dispatch vs Post-Dispatch Mutating)
  // --------------------------------------------------------------------------
  describe("Scenario 6: Tool Call Timeouts (Pre-Dispatch vs Post-Dispatch Mutating)", () => {
    it("returns retrySafety: 'not_started' on pre-dispatch timeout in queue", async () => {
      let blockerRelease: (() => void) | undefined;
      const driverFactory = new ProgrammableDriverFactory((_entry, _part, _gen) => ({
        onCallTool: async () => {
          return new Promise(resolve => {
            blockerRelease = () => resolve(ok({ isError: false, content: "unblocked" }));
          });
        }
      }));

      const gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });
      const service = makeServiceDefinition("svc-pre-timeout", {
        tool: {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          toolId: "svc-pre-timeout",
          kind: "stdio_mcp",
          version: "1.0.0",
          operations: ["work"],
          resource: { sharing: "concurrent", maxConcurrency: 1 },
          required: true
        }
      });
      gateway.registry.registerService(service, { maxQueueSize: 5 });

      const client = makeClientRegistration("client-pre-timeout", "svc-pre-timeout", {
        allowedTools: ["work"]
      });
      await gateway.register(client);

      // Start Call 1 to hold the single concurrency slot
      const call1: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-blocker",
        registrationId: client.registrationId,
        serviceId: "svc-pre-timeout",
        tool: "work",
        input: {},
        idempotencyKey: "idemp-blocker"
      };
      const call1Promise = gateway.call(call1);

      // Call 2 waits in queue and has a short timeout of 50ms
      const call2: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-queued-timeout",
        registrationId: client.registrationId,
        serviceId: "svc-pre-timeout",
        tool: "work",
        input: {},
        idempotencyKey: "idemp-queued-timeout"
      };

      const res2 = await gateway.call(call2, { timeoutMs: 50 });
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error.code).toBe("timeout");
        expect(res2.error.retrySafety).toBe("not_started");
      }

      // Cleanup blocker
      if (blockerRelease) blockerRelease();
      await call1Promise;
    });

    it("returns status: 'unknown' on post-dispatch mutating timeout and quarantines resource", async () => {
      const driverFactory = new ProgrammableDriverFactory((_entry, _part, _gen) => ({
        onCallTool: async input => {
          // Takes 200ms to simulate slow mutating execution
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 200);
            if (input.signal) {
              input.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              });
            }
          });
          return ok({ isError: false, content: "slow_done" });
        },
        onReconcileRequest: async () => {
          return { status: "completed", output: { reconciledOutput: "done_after_timeout" } };
        }
      }));

      const gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });
      const service = makeServiceDefinition("svc-mutating-timeout", {
        tool: {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          toolId: "svc-mutating-timeout",
          kind: "stdio_mcp",
          version: "1.0.0",
          operations: ["mutate"],
          resource: { sharing: "exclusive", resourceKey: "db-res" },
          required: true
        }
      });
      gateway.registry.registerService(service);

      const client = makeClientRegistration("client-mut-timeout", "svc-mutating-timeout", {
        allowedTools: ["mutate"]
      });
      await gateway.register(client);

      const leaseRes = await gateway.acquireResource({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        scope: client.scope,
        registrationId: client.registrationId,
        serviceId: "svc-mutating-timeout",
        resourceKey: "db-res",
        ttlMs: 60_000,
        idempotencyKey: "idemp-lease-db"
      });
      expect(leaseRes.ok).toBe(true);
      const lease = leaseRes.ok ? leaseRes.value : ({} as MCPResourceLease);

      // Call mutating tool with timeout 50ms (upstream takes 200ms)
      const callMut: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-mutating-timeout-1",
        registrationId: client.registrationId,
        serviceId: "svc-mutating-timeout",
        tool: "mutate",
        input: { data: "state-update" },
        resourceLease: lease,
        idempotencyKey: "idemp-mut-1"
      };

      const resMut = await gateway.call(callMut, { timeoutMs: 50 });
      expect(resMut.ok).toBe(true);
      if (resMut.ok) {
        expect(resMut.value.status).toBe("unknown");
        expect((resMut.value.output as any).diagnosticCode).toBe("uncertain_mutating_outcome");
      }

      // Exclusive resource is now quarantined
      const callBlockedByQuarantine: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-quarantine-check",
        registrationId: client.registrationId,
        serviceId: "svc-mutating-timeout",
        tool: "mutate",
        input: {},
        resourceLease: lease,
        idempotencyKey: "idemp-quarantine-check"
      };
      const resBlocked = await gateway.call(callBlockedByQuarantine);
      expect(resBlocked.ok).toBe(false);
      if (!resBlocked.ok) {
        expect((resBlocked.error.details as any)?.diagnosticCode).toBe("resource_quarantined");
      }

      // Reconcile call resolves the uncertain status and clears quarantine
      const reconcileRes = await gateway.reconcileCall(callMut);
      expect(reconcileRes.ok).toBe(true);
      if (reconcileRes.ok) {
        expect(reconcileRes.value.status).toBe("completed");
        expect((reconcileRes.value.output as any).reconciledOutput).toBe("done_after_timeout");
      }

      // Resource is now usable again
      const callAfterReconcile: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-after-reconcile",
        registrationId: client.registrationId,
        serviceId: "svc-mutating-timeout",
        tool: "mutate",
        input: { data: "new" },
        resourceLease: lease,
        idempotencyKey: "idemp-after-reconcile"
      };
      const resAfter = await gateway.call(callAfterReconcile, { timeoutMs: 300 });
      expect(resAfter.ok).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Concurrent Requests, maxConcurrency Semaphore & Backpressure
  // --------------------------------------------------------------------------
  describe("Scenario 7: Concurrent Requests, maxConcurrency Semaphore & Backpressure", () => {
    it("enforces maxConcurrency: 2 and maxQueueSize: 3, rejecting remaining 3 with backpressure", async () => {
      let activeUpstreamCalls = 0;
      let peakConcurrency = 0;
      const driverFactory = new ProgrammableDriverFactory((_entry, _part, _gen) => ({
        onCallTool: async () => {
          activeUpstreamCalls++;
          peakConcurrency = Math.max(peakConcurrency, activeUpstreamCalls);
          await new Promise(r => setTimeout(r, 80));
          activeUpstreamCalls--;
          return ok({ isError: false, content: "ok" });
        }
      }));

      const gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });
      const service = makeServiceDefinition("svc-concurrency-test", {
        tool: {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          toolId: "svc-concurrency-test",
          kind: "stdio_mcp",
          version: "1.0.0",
          operations: ["work"],
          resource: { sharing: "concurrent", maxConcurrency: 2 },
          required: true
        }
      });
      gateway.registry.registerService(service, { maxQueueSize: 3 });

      const client = makeClientRegistration("client-concurrency", "svc-concurrency-test", {
        allowedTools: ["work"]
      });
      await gateway.register(client);

      // Send 8 concurrent calls
      const calls = Array.from({ length: 8 }, (_, i) => {
        const toolCall: MCPToolCall = {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          callId: `call-conc-${i}`,
          registrationId: client.registrationId,
          serviceId: "svc-concurrency-test",
          tool: "work",
          input: { idx: i },
          idempotencyKey: `idemp-conc-${i}`
        };
        return gateway.call(toolCall);
      });

      const results = await Promise.all(calls);

      const succeeded = results.filter(r => r.ok && (r as any).value.status === "completed");
      const rejectedBackpressure = results.filter(
        r => !r.ok && (r.error.details as any)?.diagnosticCode === "backpressure_limit_exceeded"
      );

      expect(succeeded.length).toBe(5); // 2 executing + 3 from queue
      expect(rejectedBackpressure.length).toBe(3); // 3 rejected immediately
      expect(peakConcurrency).toBeLessThanOrEqual(2);
      expect(gateway.getMetrics().backpressureRejections).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Session Leakage & Security Attempts
  // --------------------------------------------------------------------------
  describe("Scenario 8: Session Leakage & Security Attempts", () => {
    let gateway: BflowSharedMCPGateway;
    let server: StreamableHttpGatewayServer;
    let serverUrl: string;

    beforeAll(async () => {
      const driverFactory = new ProgrammableDriverFactory();
      gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });
      const service = makeServiceDefinition("svc-security-test", {
        tool: {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          toolId: "svc-security-test",
          kind: "stdio_mcp",
          version: "1.0.0",
          operations: ["echo", "compute"],
          resource: { sharing: "concurrent", maxConcurrency: 5 },
          required: true
        }
      });
      gateway.registry.registerService(service);

      server = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
      serverUrl = await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    it("rejects cross-project session ID usage with 403 Forbidden", async () => {
      const clientA = makeClientRegistration("client-sec-A", "svc-security-test", {
        scope: makeScope("session", { repoId: "repo-A", sessionId: "sess-A" }) as any
      });
      const clientB = makeClientRegistration("client-sec-B", "svc-security-test", {
        scope: makeScope("session", { repoId: "repo-B", sessionId: "sess-B" }) as any
      });
      await gateway.register(clientA);
      await gateway.register(clientB);

      const sessionA = gateway.openSession(clientA.registrationId);
      expect(sessionA.ok).toBe(true);

      const tokenB = gateway.secretStore.getClientTokenByRegistration(clientB.registrationId)!;

      // Client B attempts to send request with Client A's session ID
      const res = await fetch(`${serverUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenB}`,
          "Mcp-Session-Id": sessionA.ok ? sessionA.value.sessionId : ""
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: {} }
        })
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.message).toContain("Forbidden: session belongs to another client");
    });

    it("hides unauthorized tools from tools/list and rejects unpermitted tool calls", async () => {
      const client = makeClientRegistration("client-limited-tools", "svc-security-test", {
        allowedTools: ["echo"] // Only 'echo' is permitted, 'compute' is hidden
      });
      await gateway.register(client);
      const token = gateway.secretStore.getClientTokenByRegistration(client.registrationId)!;

      // 1. tools/list hides 'compute'
      const listRes = await fetch(`${serverUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list"
        })
      });
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.result.tools.map((t: any) => t.name)).toEqual(["echo"]);

      // 2. Calling guessed unauthorized tool 'compute' is rejected
      const callRes = await fetch(`${serverUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "compute", arguments: {} }
        })
      });
      expect(callRes.status).toBe(200);
      const callData = await callRes.json();
      expect(callData.error).toBeDefined();
      expect(callData.error.message).toContain("not authorized for client");
    });

    it("rejects browser Origin headers with 403 Forbidden", async () => {
      const client = makeClientRegistration("client-web-origin", "svc-security-test");
      await gateway.register(client);
      const token = gateway.secretStore.getClientTokenByRegistration(client.registrationId)!;

      const evilRes = await fetch(`${serverUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Origin: "https://evil.example.com"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      expect(evilRes.status).toBe(403);
      const evilData = await evilRes.json();
      expect(evilData.error.message).toContain("invalid origin header");
    });

    it("rejects non-loopback Host headers with 403 Forbidden", async () => {
      expect(validateLoopbackHost("evil.example.com")).toBe(false);
      expect(validateLoopbackHost("127.0.0.1:8080")).toBe(true);
      expect(validateLoopbackHost("localhost:3000")).toBe(true);
      expect(validateLoopbackHost("[::1]:8080")).toBe(true);
    });

    it("redacts bearer tokens, secret:// references, and API keys via scrubSecrets and audit log", () => {
      const rawText =
        "Log: Bearer secret-token-1234567890 and secret://vault/key and sk-abcdefgh12345678 and ghp_1234567890abcdef";
      const scrubbed = scrubSecrets(rawText);

      expect(scrubbed).not.toContain("secret-token-1234567890");
      expect(scrubbed).not.toContain("sk-abcdefgh12345678");
      expect(scrubbed).not.toContain("ghp_1234567890abcdef");
      expect(scrubbed).toContain("Bearer [REDACTED]");
      expect(scrubbed).toContain("secret://[REDACTED]");
      expect(scrubbed).toContain("[REDACTED_KEY]");
      expect(scrubbed).toContain("[REDACTED_TOKEN]");
    });

    it("intercepts and blocks upstream interactive elicitation/prompt methods", async () => {
      expect(isInteractiveMethodForbidden("elicitation/create")).toBe(true);
      expect(isInteractiveMethodForbidden("sampling/createMessage")).toBe(true);
      expect(isInteractiveMethodForbidden("echo")).toBe(false);

      // Verify StdioToHttpBridge handles forbidden inbound elicitation method
      let upstreamReceivedErrorResponse = false;
      const { bridge, toBridge, fromBridge } = createStreamMockBridge({
        tools: ["echo"],
        noAutoReplyToCall: true
      });

      fromBridge.on("data", chunk => {
        const text = chunk.toString();
        if (text.includes("Interactive user prompt blocked by Bflow Gateway")) {
          upstreamReceivedErrorResponse = true;
        }
      });

      const initRes = await bridge.initialize();
      expect(initRes.ok).toBe(true);

      // Start tool call
      const callPromise = bridge.callTool({
        sessionId: "sess-elic",
        clientId: "client-elic",
        requestId: "req-elic-1",
        tool: "echo",
        arguments: {}
      });

      // Upstream stdio process attempts to call elicitation/create
      toBridge.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "prompt-999",
          method: "elicitation/create",
          params: { message: "What is your password?" }
        }) + "\n"
      );

      const callRes = await callPromise;
      expect(callRes.ok).toBe(false);
      if (!callRes.ok) {
        expect((callRes.error.details as any)?.diagnosticCode).toBe("interactive_prompt_blocked");
      }
      expect(upstreamReceivedErrorResponse).toBe(true);
      await bridge.stop();
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Crash / Recovery & Reconciliation (reconcileCall)
  // --------------------------------------------------------------------------
  describe("Scenario 9: Crash / Recovery & Reconciliation (reconcileCall)", () => {
    it("does not reconcile a mutating call as completed when structuredContent violates outputSchema", async () => {
      const outputSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };
      const factory = new ProgrammableDriverFactory(() => ({
        onInitialize: async () => ok({ protocolVersion: "2025-11-25", discoveredTools: ["query"],
          toolDefinitions: [{ name: "query", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, outputSchema }],
          defaultedInputSchemaTools: [] }),
        onCallTool: async () => err({ code: "timeout", retryable: true, message: "simulated lost response" }),
        onReconcileRequest: async () => ({ status: "completed", output: [{ type: "text", text: "ok" }], structuredContent: { id: 7 } } as never)
      }));
      const serviceManager = new DefaultMCPServiceManager({ driverFactory: factory });
      const gateway = new BflowSharedMCPGateway({ serviceManager });
      const service = makeServiceDefinition("svc-output-reconcile", { tool: { schemaVersion: 3, toolId: "svc-output-reconcile",
        kind: "stdio_mcp", version: "1.0.0", operations: ["query"], resource: { sharing: "concurrent", maxConcurrency: 2 }, required: true } });
      expect(gateway.registry.registerService(service).ok).toBe(true);
      const scope = makeScope("session", { sessionId: "schema-output-reconcile-session" });
      const client = makeClientRegistration("schema-output-reconcile-client", service.serviceId, { scope, allowedTools: ["query"] });
      expect((await gateway.register(client)).ok).toBe(true);
      const call: MCPToolCall = { schemaVersion: 3, callId: "schema-output-reconcile-call", registrationId: client.registrationId,
        serviceId: service.serviceId, tool: "query", input: { q: "hello" }, idempotencyKey: "schema-output-reconcile-call" };
      const uncertain = await gateway.call(call);
      expect(uncertain.ok && uncertain.value.status).toBe("unknown");
      const reconciled = await gateway.reconcileCall(call);
      expect(reconciled.ok).toBe(true);
      if (reconciled.ok) expect(reconciled.value).toMatchObject({ status: "unknown", output: { diagnosticCode: "upstream_output_schema_invalid" } });
    });

    it("handles unexpected upstream crash during mutating call, quarantines resource, and reconciles cleanly", async () => {
      let activeBridge: StdioToHttpBridge | undefined;
      let reconcileOutcome: MCPUpstreamReconcileResult = { status: "unknown" };

      const driverFactory: MCPUpstreamDriverFactory = {
        createInstance: async (_entry, _part, _gen) => {
          const { bridge } = createStreamMockBridge({
            tools: ["mutate"],
            noAutoReplyToCall: true
          });
          activeBridge = bridge;
          const proxyDriver: MCPUpstreamDriverInstance = {
            instanceId: bridge.instanceId,
            pid: bridge.pid,
            startGeneration: bridge.startGeneration,
            ownership: bridge.ownership,
            initialize: opts => bridge.initialize(opts),
            listTools: (sess, opts) => bridge.listTools(sess, opts),
            callTool: input => bridge.callTool(input),
            cancelRequest: (reqId, reason) => bridge.cancelRequest(reqId, reason),
            reconcileRequest: async (callId, reqId) => {
              if (reconcileOutcome.status !== "unknown") {
                return reconcileOutcome;
              }
              return bridge.reconcileRequest(callId, reqId);
            },
            getMemoryRssBytes: () => bridge.getMemoryRssBytes(),
            isAlive: () => bridge.isAlive(),
            stop: reason => bridge.stop(reason),
            onCrash: listener => bridge.onCrash(listener)
          };
          return ok(proxyDriver);
        }
      };

      const gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });
      const service = makeServiceDefinition("svc-crash-test", {
        tool: {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          toolId: "svc-crash-test",
          kind: "stdio_mcp",
          version: "1.0.0",
          operations: ["mutate"],
          resource: { sharing: "exclusive", resourceKey: "res-crash" },
          required: true
        }
      });
      gateway.registry.registerService(service);

      const client = makeClientRegistration("client-crash", "svc-crash-test", {
        allowedTools: ["mutate"]
      });
      await gateway.register(client);

      const leaseRes = await gateway.acquireResource({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        scope: client.scope,
        registrationId: client.registrationId,
        serviceId: "svc-crash-test",
        resourceKey: "res-crash",
        ttlMs: 60_000,
        idempotencyKey: "idemp-crash-lease"
      });
      expect(leaseRes.ok).toBe(true);
      const lease = leaseRes.ok ? leaseRes.value : ({} as MCPResourceLease);

      const callCrash: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-crash-1",
        registrationId: client.registrationId,
        serviceId: "svc-crash-test",
        tool: "mutate",
        input: { update: "critical" },
        resourceLease: lease,
        idempotencyKey: "idemp-crash-call-1"
      };

      const callPromise = gateway.call(callCrash);

      // Give event loop a tick to ensure dispatch, then trigger unexpected crash
      await new Promise(r => setTimeout(r, 10));
      expect(activeBridge).toBeDefined();
      activeBridge!.triggerCrash("segfault");

      const callRes = await callPromise;
      expect(callRes.ok).toBe(true);
      if (callRes.ok) {
        expect(callRes.value.status).toBe("unknown");
      }

      // Verify exclusive resource is quarantined
      const secondCall: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-crash-2",
        registrationId: client.registrationId,
        serviceId: "svc-crash-test",
        tool: "mutate",
        input: {},
        resourceLease: lease,
        idempotencyKey: "idemp-crash-call-2"
      };
      const secondRes = await gateway.call(secondCall);
      expect(secondRes.ok).toBe(false);
      if (!secondRes.ok) {
        expect((secondRes.error.details as any)?.diagnosticCode).toBe("resource_quarantined");
      }

      // 1. First reconcile call while reconcileOutcome is still { status: "unknown" }
      const initialReconcileRes = await gateway.reconcileCall(callCrash);
      expect(initialReconcileRes.ok).toBe(true);
      if (initialReconcileRes.ok) {
        expect(initialReconcileRes.value.status).toBe("unknown");
      }

      // Verify exclusive resource is STILL quarantined
      const stillQuarantinedRes = await gateway.call(secondCall);
      expect(stillQuarantinedRes.ok).toBe(false);
      if (!stillQuarantinedRes.ok) {
        expect((stillQuarantinedRes.error.details as any)?.diagnosticCode).toBe("resource_quarantined");
      }

      // 2. Upstream reconciliation confirms not_delivered
      reconcileOutcome = { status: "not_delivered" };

      // Reconcile call again: resolves the outcome cleanly without automatic replay
      const reconcileRes = await gateway.reconcileCall(callCrash);
      expect(reconcileRes.ok).toBe(true);
      if (reconcileRes.ok) {
        expect(reconcileRes.value.status).toBe("failed");
      }

      // Exclusive resource is now unquarantined and can be renewed or acquired
      const renewRes = await gateway.renewResource({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        lease,
        ttlMs: 30_000,
        idempotencyKey: "idemp-renew-after-reconcile"
      });
      expect(renewRes.ok).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 10: RAM and Process Count Limits & Metrics
  // --------------------------------------------------------------------------
  describe("Scenario 10: RAM and Process Count Limits & Metrics", () => {
    it("rejects spawning beyond maxProcessCount and increments processLimitRejections", async () => {
      const metrics = new GatewayMetricsCollector({ maxProcessCount: 2 });
      const driverFactory = new ProgrammableDriverFactory();
      const serviceManager = new DefaultMCPServiceManager({ driverFactory, metrics });

      const svc1 = makeServiceDefinition("svc-proc-1");
      const svc2 = makeServiceDefinition("svc-proc-2");
      const svc3 = makeServiceDefinition("svc-proc-3");

      const res1 = await serviceManager.ensure(svc1, makeScopedOp());
      expect(res1.ok).toBe(true);
      expect(metrics.snapshot().activeProcessCount).toBe(1);

      const res2 = await serviceManager.ensure(svc2, makeScopedOp());
      expect(res2.ok).toBe(true);
      expect(metrics.snapshot().activeProcessCount).toBe(2);

      // Spawning 3rd process hits limit
      const res3 = await serviceManager.ensure(svc3, makeScopedOp());
      expect(res3.ok).toBe(false);
      if (!res3.ok) {
        expect((res3.error.details as any)?.diagnosticCode).toBe("process_limit_exceeded");
      }
      expect(metrics.snapshot().processLimitRejections).toBe(1);
    });

    it("terminates process exceeding maxMemoryBytes and increments memoryLimitTerminations", async () => {
      let currentRss = 50 * 1024 * 1024; // 50MB
      let stoppedReason: string | undefined;

      const driverFactory = new ProgrammableDriverFactory(() => ({
        onGetMemoryRssBytes: async () => currentRss,
        onStop: async reason => {
          stoppedReason = reason;
        }
      }));

      const metrics = new GatewayMetricsCollector({ maxMemoryBytes: 100 * 1024 * 1024 }); // 100MB limit
      const serviceManager = new DefaultMCPServiceManager({ driverFactory, metrics });
      const service = makeServiceDefinition("svc-mem-limit");

      const op = makeScopedOp();
      const res1 = await serviceManager.ensure(service, op);
      expect(res1.ok).toBe(true);

      // Simulate memory leak to 150MB
      currentRss = 150 * 1024 * 1024;

      // Next inspect terminates the process
      const inspectRes = await serviceManager.inspect("svc-mem-limit", op);
      expect(inspectRes.ok).toBe(true);
      if (inspectRes.ok) {
        expect(inspectRes.value.status).toBe("stopped");
        expect(inspectRes.value.diagnosticCode).toBe("memory_limit_exceeded");
      }

      expect(stoppedReason).toBe("memory_limit_exceeded");
      expect(metrics.snapshot().memoryLimitTerminations).toBe(1);
    });

    it("records and calculates latency percentiles accurately", () => {
      const collector = new GatewayMetricsCollector();

      // Record known sample durations
      const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      for (const dur of samples) {
        collector.recordCallStart("svc-latency");
        collector.recordCallEnd("svc-latency", "completed", dur);
      }

      const snap = collector.snapshot();
      expect(snap.totalToolCalls).toBe(10);
      expect(snap.latency.count).toBe(10);
      expect(snap.latency.minMs).toBe(10);
      expect(snap.latency.maxMs).toBe(100);
      expect(snap.latency.avgMs).toBe(55);
      expect(snap.latency.p50Ms).toBe(60);
      expect(snap.latency.p95Ms).toBe(100);
      expect(snap.latency.p99Ms).toBe(100);

      const perSvc = snap.perService["svc-latency"];
      expect(perSvc).toBeDefined();
      expect(perSvc.latency.avgMs).toBe(55);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Schema Version, Frame Limits & HTTP Diagnostics
  // --------------------------------------------------------------------------
  describe("Scenario 11: Schema Version, Frame Limits & HTTP Diagnostics", () => {
    it("validates platform schemaVersion 3 and rejects mismatched versions", () => {
      expect(checkSchemaVersion({ schemaVersion: 3 }).ok).toBe(true);
      expect(checkSchemaVersion({ schemaVersion: 2 }).ok).toBe(false);
      expect(checkSchemaVersion({ schemaVersion: "3" }).ok).toBe(false);
      expect(checkSchemaVersion(null).ok).toBe(false);
    });

    it("crashes StdioToHttpBridge when frame exceeds maxFrameBytes without newline", async () => {
      let crashedReason: string | undefined;
      const { bridge, toBridge } = createStreamMockBridge({ maxFrameBytes: 256 });
      bridge.onCrash(reason => {
        crashedReason = reason;
      });

      // Write oversized frame > 256 bytes without newline
      toBridge.write("A".repeat(300));
      await new Promise(r => setTimeout(r, 20));

      expect(crashedReason).toBe("frame_size_exceeded");
      expect(bridge.isAlive()).toBe(false);
      await bridge.stop();
    });

    it("serves HTTP /health and /metrics endpoints", async () => {
      const gateway = new BflowSharedMCPGateway();
      const server = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
      const serverUrl = await server.start();

      const reg = makeClientRegistration("client-diag", "svc-diag");
      // Add fake service to registry for client registration
      gateway.registry.registerService(makeServiceDefinition("svc-diag"));
      await gateway.register(reg);
      const token = gateway.secretStore.getClientTokenByRegistration(reg.registrationId)!;

      try {
        const healthRes = await fetch(`${serverUrl}/health`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        expect(healthRes.status).toBe(200);
        const healthData = await healthRes.json();
        expect(healthData.status).toBe("ok");

        const metricsRes = await fetch(`${serverUrl}/metrics`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        expect(metricsRes.status).toBe(200);
        const metricsData = await metricsRes.json();
        expect(metricsData.activeProcessCount).toBeDefined();
        expect(metricsData.latency).toBeDefined();
      } finally {
        await server.stop();
      }
    });

    it("handles streamable HTTP with SSE response when requested with Accept: text/event-stream", async () => {
      const driverFactory = new ProgrammableDriverFactory();
      const gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });
      const service = makeServiceDefinition("svc-sse-test");
      gateway.registry.registerService(service);

      const server = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
      const serverUrl = await server.start();

      try {
        const reg = makeClientRegistration("client-sse", "svc-sse-test");
        await gateway.register(reg);
        const token = gateway.secretStore.getClientTokenByRegistration(reg.registrationId)!;

        const sseRes = await fetch(`${serverUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 42,
            method: "tools/call",
            params: { name: "echo", arguments: { sseTest: true } }
          })
        });

        expect(sseRes.status).toBe(200);
        expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
        const bodyText = await sseRes.text();
        expect(bodyText).toContain("event: message");
        expect(bodyText).toContain('"id":42');
        expect(bodyText).toContain('"status":"completed"');
      } finally {
        await server.stop();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Remediation Regression Verification (R27-01 through R27-06)
  // --------------------------------------------------------------------------
  describe("Scenario 12: Remediation Regression Verification (R27-01 through R27-06)", () => {
    it("captures late upstream response arriving after client timeout into reconcileLedger", async () => {
      let interceptedReqId: string | undefined;
      const { bridge, toBridge, fromBridge } = createStreamMockBridge({
        tools: ["slow_mutate"],
        noAutoReplyToCall: true
      });

      fromBridge.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split("\n").filter(Boolean)) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.method === "tools/call") {
              interceptedReqId = parsed.id;
            }
          } catch {}
        }
      });

      const initRes = await bridge.initialize();
      expect(initRes.ok).toBe(true);

      const driverFactory: MCPUpstreamDriverFactory = {
        createInstance: async () => ok(bridge)
      };

      const gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });
      const service = makeServiceDefinition("svc-late-resp", {
        tool: {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          toolId: "svc-late-resp",
          kind: "stdio_mcp",
          version: "1.0.0",
          operations: ["slow_mutate"],
          resource: { sharing: "concurrent", maxConcurrency: 4 },
          required: true
        }
      });
      gateway.registry.registerService(service);

      const client = makeClientRegistration("client-late-resp", "svc-late-resp", {
        allowedTools: ["slow_mutate"]
      });
      await gateway.register(client);

      const callTool: MCPToolCall = {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        callId: "call-late-resp-1",
        registrationId: client.registrationId,
        serviceId: "svc-late-resp",
        tool: "slow_mutate",
        input: { data: "delayed" },
        idempotencyKey: "idemp-late-resp-1"
      };

      // Call tool with 40ms timeout, while upstream hasn't responded yet
      const callRes = await gateway.call(callTool, { timeoutMs: 40 });
      expect(callRes.ok).toBe(true);
      if (callRes.ok) {
        expect(callRes.value.status).toBe("unknown");
      }

      // Reconcile before upstream responds -> still unknown
      const recBefore = await gateway.reconcileCall(callTool);
      expect(recBefore.ok).toBe(true);
      if (recBefore.ok) {
        expect(recBefore.value.status).toBe("unknown");
      }

      // Now upstream sends late response on toBridge
      expect(interceptedReqId).toBeDefined();
      toBridge.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: interceptedReqId,
          result: {
            content: { lateExecutionFinished: true, processedVal: 123 }
          }
        }) + "\n"
      );

      // Give bridge event loop a turn to parse the inbound line
      await new Promise((r) => setTimeout(r, 20));

      // Reconcile call: now it resolves as completed with the late upstream output!
      const recAfter = await gateway.reconcileCall(callTool);
      expect(recAfter.ok).toBe(true);
      if (recAfter.ok) {
        expect(recAfter.value.status).toBe("completed");
        expect((recAfter.value.output as any).lateExecutionFinished).toBe(true);
        expect((recAfter.value.output as any).processedVal).toBe(123);
      }

      await bridge.stop();
    });

    it("spawns real child process (stdio_mcp) with executable digest check serving 10 concurrent clients", async () => {
      // Create a temporary script for real child process
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-child-test-"));
      const scriptPath = path.join(tmpDir, "server.cjs");
      const serverCode = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'real-node-child', version: '1.0.0' }
        }
      }) + '\\n');
    } else if (msg.method === 'notifications/initialized') {
      // no reply
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: [{ name: 'real_compute' }] }
      }) + '\\n');
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: { computed: (msg.params?.arguments?.n || 0) * 2 } }
      }) + '\\n');
    }
  } catch {
    // ignore parse error on invalid line
  }
});

`;
      fs.writeFileSync(scriptPath, serverCode, { mode: 0o644 });

      try {
        const realNodeExec = fs.realpathSync(process.execPath);
        let targetExec = realNodeExec;

        try {
          fs.chmodSync(realNodeExec, 0o755);
        } catch {
          // ignore if read-only or not owner
        }

        const initialStat = fs.statSync(realNodeExec);
        if ((initialStat.mode & 0o022) !== 0) {
          const safeNodeExec = path.join(tmpDir, "node");
          fs.copyFileSync(realNodeExec, safeNodeExec);
          fs.chmodSync(safeNodeExec, 0o755);
          targetExec = safeNodeExec;
        }

        const nodeBytes = fs.readFileSync(targetExec);
        const nodeDigest = createHash("sha256").update(nodeBytes).digest("hex");

        const secretStore = new GatewaySecretStore();
        const stdioFactory = new SubprocessStdioDriverFactory({
          verifyExecutableDigest: true,
          secretStore,
          defaultTimeoutMs: 30_000
        });

        const service = makeServiceDefinition("svc-real-subprocess", {
          healthTimeoutMs: 30_000,
          connection: {
            kind: "stdio_mcp",
            executable: targetExec,
            argv: [scriptPath],
            environmentBindings: {},
            executableDigest: nodeDigest,
            ownership: "bflow",
            bridgeRequired: true
          },
          tool: {
            schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
            toolId: "svc-real-subprocess",
            kind: "stdio_mcp",
            version: "1.0.0",
            operations: ["real_compute"],
            resource: { sharing: "concurrent", maxConcurrency: 10 },
            required: true
          }
        });

        const serviceManager = new DefaultMCPServiceManager({
          driverFactory: stdioFactory,
          secretStore
        });
        const gateway = new BflowSharedMCPGateway({
          serviceManager,
          secretStore
        });
        gateway.registry.registerService(service);

        // Register 10 clients
        const clientCount = 10;
        const clients: MCPClientRegistration[] = [];
        for (let i = 0; i < clientCount; i++) {
          const client = makeClientRegistration(`client-real-${i}`, "svc-real-subprocess", {
            allowedTools: ["real_compute"]
          });
          await gateway.register(client);
          clients.push(client);
        }

        // Execute 10 concurrent calls
        const callPromises = clients.map(async (client, idx) => {
          const toolCall: MCPToolCall = {
            schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
            callId: `call-real-${idx}`,
            registrationId: client.registrationId,
            serviceId: "svc-real-subprocess",
            tool: "real_compute",
            input: { n: idx + 1 },
            idempotencyKey: `idemp-real-${idx}`
          };
          return gateway.call(toolCall);
        });

        const callResults = await Promise.all(callPromises);
        for (let i = 0; i < clientCount; i++) {
          const res = callResults[i]!;
          if (!res.ok) {
            console.error(`Client ${i} call failed:`, JSON.stringify(res.error, null, 2));
          }
          expect(res.ok).toBe(true);
          if (res.ok) {
            expect(res.value.status).toBe("completed");
            expect((res.value.output as any).computed).toBe((i + 1) * 2);
          }
        }

        const op = makeScopedOp(clients[0]!.scope);
        await serviceManager.stop("svc-real-subprocess", op);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("verifies repository-scoped operator revocation, stale lease release rejection, and single_client_isolated limit", async () => {
      const driverFactory = new ProgrammableDriverFactory();
      const gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });

      // 1. Repository-scoped operator revoking a session registration
      const sessionScope = makeScope("session", { repoId: "repo-auth", sessionId: "sess-user-1" });
      const reg = makeClientRegistration("client-scoped-auth", "svc-scoped-auth", {
        scope: sessionScope as any
      });
      const service = makeServiceDefinition("svc-scoped-auth");
      gateway.registry.registerService(service);
      await gateway.register(reg);

      const token = gateway.secretStore.getClientTokenByRegistration(reg.registrationId)!;
      expect(gateway.authenticateToken(token).ok).toBe(true);

      const repoOp = makeScopedOp(makeScope("repository", { repoId: "repo-auth" }));
      const revokeRes = await gateway.revoke(reg.registrationId, repoOp);
      expect(revokeRes.ok).toBe(true);
      expect(gateway.authenticateToken(token).ok).toBe(false);

      // 2. Stale lease releaseResource rejection (stale_lease)
      const serviceExclusive = makeServiceDefinition("svc-excl-stale", {
        tool: {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          toolId: "svc-excl-stale",
          kind: "stdio_mcp",
          version: "1.0.0",
          operations: ["echo"],
          resource: { sharing: "exclusive", resourceKey: "excl-key-1" },
          required: true
        }
      });
      gateway.registry.registerService(serviceExclusive);
      const clientExcl = makeClientRegistration("client-excl", "svc-excl-stale");
      await gateway.register(clientExcl);

      const leaseRes = await gateway.acquireResource({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        scope: clientExcl.scope,
        registrationId: clientExcl.registrationId,
        serviceId: "svc-excl-stale",
        resourceKey: "excl-key-1",
        ttlMs: 60_000,
        idempotencyKey: "idemp-lease-stale"
      });
      expect(leaseRes.ok).toBe(true);
      const activeLease = leaseRes.ok ? leaseRes.value : ({} as MCPResourceLease);

      // Stale lease with mismatched fencingToken
      const staleReleaseRes = await gateway.releaseResource(
        { ...activeLease, fencingToken: activeLease.fencingToken + 10 },
        makeScopedOp(clientExcl.scope)
      );
      expect(staleReleaseRes.ok).toBe(false);
      if (!staleReleaseRes.ok) {
        expect((staleReleaseRes.error.details as any)?.diagnosticCode).toBe("stale_lease");
      }

      // Valid release succeeds
      const validRelease = await gateway.releaseResource(activeLease, makeScopedOp(clientExcl.scope));
      expect(validRelease.ok).toBe(true);

      // 3. Service with policy single_client_isolated rejecting 2nd client on same partition
      const serviceIsolated = makeServiceDefinition("svc-single-client-iso");
      const regRes = gateway.registry.registerService(serviceIsolated, {
        concurrencyModel: "single_client_isolated",
        sessionIsolationPolicy: "session_partition",
        sharedStatePolicy: "partitioned_by_session",
        browserAffecting: false,
        callTimeoutMs: 30_000
      });
      expect(regRes.ok).toBe(true);

      const isoScope = makeScope("session", { repoId: "repo-iso", sessionId: "sess-iso-shared" });
      const client1 = makeClientRegistration("client-iso-1", "svc-single-client-iso", {
        scope: isoScope as any
      });
      const client2 = makeClientRegistration("client-iso-2", "svc-single-client-iso", {
        scope: isoScope as any
      });
      await gateway.register(client1);
      await gateway.register(client2);

      const sess1 = gateway.openSession(client1.registrationId);
      expect(sess1.ok).toBe(true);

      // Client 2 attempting to open session on the same partition is rejected with single_client_limit
      const sess2 = gateway.openSession(client2.registrationId);
      expect(sess2.ok).toBe(false);
      if (!sess2.ok) {
        expect((sess2.error.details as any)?.diagnosticCode).toBe("single_client_limit");
      }
    });

    it("returns HTTP 413 Payload Too Large when request body exceeds maxBodyBytes", async () => {
      const driverFactory = new ProgrammableDriverFactory();
      const gateway = new BflowSharedMCPGateway({
        serviceManager: new DefaultMCPServiceManager({ driverFactory })
      });
      const service = makeServiceDefinition("svc-body-limit");
      gateway.registry.registerService(service);

      // Server configured with 512 bytes maxBodyBytes
      const server = new StreamableHttpGatewayServer({
        gateway,
        host: "127.0.0.1",
        port: 0,
        maxBodyBytes: 512
      });
      const serverUrl = await server.start();

      try {
        const client = makeClientRegistration("client-body-limit", "svc-body-limit");
        await gateway.register(client);
        const token = gateway.secretStore.getClientTokenByRegistration(client.registrationId)!;

        // Construct oversized payload (> 512 bytes)
        const hugePayload = "X".repeat(2048);
        const res = await fetch(`${serverUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "echo", arguments: { huge: hugePayload } }
          })
        });

        expect(res.status).toBe(413);
        const data = await res.json();
        expect(data.error).toBeDefined();
        expect(data.error.code).toBe(-32000);
        expect(data.error.message).toBe("Payload Too Large");
      } finally {
        await server.stop();
      }
    });
  });
});

describe("Scenario 13: Upstream tool definitions propagate to Gateway tools/list", () => {
  const toolDefinitionWorker = `
const fs = require('fs');
const readline = require('readline');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const callResult = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : { content: [{ type: 'text', text: 'ok' }] };
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'defs-worker', version: '1.0.0' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: payload } }) + '\\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: callResult }) + '\\n');
  }
});
`;

  function setupStdioWorker(tools: unknown, gatewayOptions?: BflowSharedMCPGatewayOptions, callResult?: unknown) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-defs-test-"));
    const scriptPath = path.join(tmpDir, "worker.cjs");
    const payloadPath = path.join(tmpDir, "tools.json");
    const callResultPath = path.join(tmpDir, "call-result.json");
    fs.writeFileSync(scriptPath, toolDefinitionWorker, { mode: 0o644 });
    fs.writeFileSync(payloadPath, JSON.stringify(tools), { mode: 0o644 });
    if (callResult !== undefined) fs.writeFileSync(callResultPath, JSON.stringify(callResult), { mode: 0o600 });
    const serviceId = `svc-defs-${randomUUID().slice(0, 8)}`;
    const service = makeServiceDefinition(serviceId, {
      healthTimeoutMs: 30_000,
      connection: {
        kind: "stdio_mcp",
        executable: process.execPath,
        argv: [scriptPath, payloadPath, ...(callResult === undefined ? [] : [callResultPath])],
        environmentBindings: {},
        executableDigest: "0".repeat(64),
        ownership: "bflow",
        bridgeRequired: true
      } as any,
      tool: {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        toolId: serviceId,
        kind: "stdio_mcp",
        version: "1.0.0",
        operations: ["query"],
        resource: { sharing: "concurrent", maxConcurrency: 4 },
        required: true
      } as any
    });
    const secretStore = new GatewaySecretStore();
    const serviceManager = new DefaultMCPServiceManager({
      driverFactory: new SubprocessStdioDriverFactory({ secretStore, defaultTimeoutMs: 30_000 }),
      secretStore
    });
    const gateway = new BflowSharedMCPGateway({ serviceManager, secretStore, ...gatewayOptions });
    gateway.registry.registerService(service);
    return {
      serviceId,
      gateway,
      cleanup: async () => {
        await serviceManager.stop(serviceId, makeScopedOp(makeScope("machine"))).catch(() => undefined);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    };
  }

  it("normalizes upstream definitions, defaults missing inputSchema, and strips unknown fields", () => {
    const res = normalizeUpstreamToolList({
      tools: [
        {
          name: "query",
          title: "Query",
          description: "Run a query",
          inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          outputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          _meta: { internal: true }
        },
        { name: "bare" }
      ]
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.definitions).toEqual([
      {
        name: "query",
        title: "Query",
        description: "Run a query",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true }
      },
      { name: "bare", inputSchema: { type: "object" } }
    ]);
    expect(res.value.defaultedInputSchemaTools).toEqual(["bare"]);
  });

  it("rejects output schemas containing constraints the Gateway cannot enforce", () => {
    const result = normalizeUpstreamToolList({ tools: [{ name: "query", inputSchema: { type: "object" },
      outputSchema: { type: "object", patternProperties: { "^id$": { type: "string" } } } }] });
    expect(result.ok).toBe(false);
  });

  it("blocks an explicit grant registration when its real stdio definition omits inputSchema", async () => {
    const { serviceId, gateway, cleanup } = setupStdioWorker([{ name: "query" }], {
      requireResolvedToolGrants: true,
      toolGrantResolver: (registered, request) => ({ schemaVersion: 3, grantId: "grant-schema-required",
        policyDigest: "a".repeat(64), toolId: request.serviceId, kind: "stdio_mcp", requiredness: "required",
        role: registered.role, scope: registered.scope, triggers: ["explicit"], serviceId: request.serviceId, operations: ["query"] })
    });
    const registration = makeClientRegistration("reg-schema-required", serviceId, { role: "developer", allowedTools: ["query"] });
    try {
      const result = await gateway.register(registration);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("no enforceable negotiated input schema");
      expect(gateway.secretStore.getClientTokenByRegistration(registration.registrationId)).toBeUndefined();
    } finally { await cleanup(); }
  });

  it("rejects malformed, duplicate, non-object-typed, oversized and over-count upstream lists", () => {
    const cases: unknown[] = [
      undefined,
      { tools: "nope" },
      { tools: ["query"] },
      { tools: [{ description: "no name" }] },
      { tools: [{ name: "a", inputSchema: "not-object" }] },
      { tools: [{ name: "a", inputSchema: { type: "array" } }] },
      { tools: [{ name: "a", inputSchema: { type: "object", properties: { q: { type: "string", pattern: "^safe$" } } } }] },
      { tools: [{ name: "a" }, { name: "a" }] },
      { tools: [{ name: "a", description: "x".repeat(MCP_TOOL_DEFINITION_LIMITS.maxDefinitionBytes) }] },
      {
        tools: Array.from({ length: MCP_TOOL_DEFINITION_LIMITS.maxTools + 1 }, (_, i) => ({ name: `t${i}` }))
      }
    ];
    for (const raw of cases) {
      const res = normalizeUpstreamToolList(raw);
      expect(res.ok, String(JSON.stringify(raw)).slice(0, 80)).toBe(false);
    }
    expect(validateJsonSchema("not-an-object", { required: ["wing"] })).toBe(false);
    expect(validateJsonSchema({ wing: "ok", extra: true }, { type: "object", properties: { wing: { type: "string" } }, additionalProperties: false })).toBe(false);
  });

  it("advertises upstream definitions over HTTP tools/list with serviceId, honouring allowedTools", async () => {
    const tools = [
      {
        name: "query",
        title: "Query",
        description: "Run a query",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        _meta: { internal: true }
      },
      { name: "bare" },
      { name: "hidden", inputSchema: { type: "object" } }
    ];
    const { serviceId, gateway, cleanup } = setupStdioWorker(tools);
    const server = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
    try {
      const serverUrl = await server.start();
      const client = makeClientRegistration(`client-defs-${randomUUID().slice(0, 6)}`, serviceId, {
        allowedTools: ["query", "bare"]
      });
      await gateway.register(client);
      const token = gateway.secretStore.getClientTokenByRegistration(client.registrationId)!;

      const res = await fetch(`${serverUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      const listed = data.result.tools as any[];
      expect(listed.map(t => t.name).sort()).toEqual(["bare", "query"]);

      const query = listed.find(t => t.name === "query");
      expect(query).toEqual({
        name: "query",
        title: "Query",
        description: "Run a query",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        serviceId
      });
      expect(query).not.toHaveProperty("_meta");

      const bare = listed.find(t => t.name === "bare");
      expect(bare).toEqual({ name: "bare", inputSchema: { type: "object" }, serviceId });

      expect(
        gateway
          .getAuditLog()
          .some(e => e.diagnosticCode === "tool_input_schema_defaulted" && e.message.includes("bare"))
      ).toBe(true);
    } finally {
      await server.stop();
      await cleanup();
    }
  });

  it("fails the service when the upstream returns a malformed tool definition", async () => {
    const { serviceId, gateway, cleanup } = setupStdioWorker([{ name: "query", inputSchema: "broken" }]);
    try {
      const scope = makeScope("machine");
      const res = await gateway.serviceManager.ensure(
        gateway.registry.getService(serviceId)!.definition,
        makeScopedOp(scope)
      );
      expect(res.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("does not report a mutating call completed when structuredContent violates outputSchema", async () => {
    const { serviceId, gateway, cleanup } = setupStdioWorker([{
      name: "query", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      outputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
    }], undefined, { content: [{ type: "text", text: "completed" }], structuredContent: { id: 42 } });
    try {
      const scope = makeScope("session", { sessionId: "schema-output-session" });
      const client = makeClientRegistration("schema-output-client", serviceId, { scope, allowedTools: ["query"] });
      expect((await gateway.register(client)).ok).toBe(true);
      const result = await gateway.call({ schemaVersion: 3, callId: "schema-output-call", registrationId: client.registrationId,
        serviceId, tool: "query", input: { q: "hello" }, idempotencyKey: "schema-output-call" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toMatchObject({ status: "unknown", output: { diagnosticCode: "upstream_output_schema_invalid" } });
      expect(JSON.stringify(result)).not.toContain("42");
    } finally {
      await cleanup();
    }
  });

  it("accepts structuredContent that satisfies the advertised outputSchema", async () => {
    const { serviceId, gateway, cleanup } = setupStdioWorker([{
      name: "query", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      outputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
    }], undefined, { content: [{ type: "text", text: "ok" }], structuredContent: { id: "result-1" } });
    try {
      const scope = makeScope("session", { sessionId: "schema-output-valid-session" });
      const client = makeClientRegistration("schema-output-valid-client", serviceId, { scope, allowedTools: ["query"] });
      expect((await gateway.register(client)).ok).toBe(true);
      const result = await gateway.call({ schemaVersion: 3, callId: "schema-output-valid-call", registrationId: client.registrationId,
        serviceId, tool: "query", input: { q: "hello" }, idempotencyKey: "schema-output-valid-call" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe("completed");
    } finally {
      await cleanup();
    }
  });

  it("keeps a real stdio call unknown after restart without persisting its input or replaying it", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ledger-live-"));
    const scriptPath = path.join(tmpDir, "worker.cjs");
    const counterPath = path.join(tmpDir, "side-effects.txt");
    const ledgerPath = path.join(tmpDir, "gateway-calls.jsonl");
    const worker = `const fs=require('fs');const rl=require('readline').createInterface({input:process.stdin,terminal:false});rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'ledger-worker',version:'1'}}})+String.fromCharCode(10));else if(m.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'mempalace_search',inputSchema:{type:'object',properties:{wing:{type:'string',enum:['approved-wing']},query:{type:'string',minLength:1}},required:['wing','query'],additionalProperties:false}},{name:'mempalace_write',inputSchema:{type:'object',properties:{wing:{type:'string'},content:{type:'string'}},required:['wing','content'],additionalProperties:false}}]}})+String.fromCharCode(10));else if(m.method==='tools/call'){fs.appendFileSync(${JSON.stringify(counterPath)},'x');setTimeout(()=>{},10000);}});`;
    fs.writeFileSync(scriptPath, worker, { mode: 0o600 });
    const serviceId = "mempalace-ledger-test";
    const service = makeServiceDefinition(serviceId, {
      scope: makeScope("repository", { repoId: "repo-a" }),
      tool: { schemaVersion: 3, toolId: "mempalace", kind: "stdio_mcp", version: "3.11.0", operations: ["mempalace_search", "mempalace_write"],
        resource: { sharing: "concurrent", maxConcurrency: 2 }, required: true },
      connection: { kind: "stdio_mcp", executable: process.execPath, argv: [scriptPath], environmentBindings: {},
        executableDigest: createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex"), ownership: "bflow", bridgeRequired: true }
    });
    const scope = makeScope("session", { repoId: "repo-a", sessionId: "sess-live-ledger" });
    const client = makeClientRegistration("reg-live-ledger", serviceId, { scope, allowedTools: ["mempalace_search", "mempalace_write"] });
    const grant = { schemaVersion: 3 as const, grantId: "grant-live-ledger", policyDigest: "a".repeat(64), toolId: "mempalace",
      kind: "stdio_mcp" as const, requiredness: "required" as const, role: "developer" as const, scope,
      triggers: ["prior_context" as const], serviceId, operations: ["mempalace_search"] };
    const memoryGrant = { ...grant, memoryScope: { wing: "approved-wing", repositoryId: "repo-a", access: "read_only" as const } };
    let activeGrant = grant;
    const makeGateway = () => {
      const gateway = new BflowSharedMCPGateway({ callLedgerPath: ledgerPath, requireResolvedToolGrants: true,
        policyOverrides: () => ({ readOnlyTools: ["mempalace_search"] }), toolGrantResolver: () => [activeGrant] });
      gateway.registry.registerService(service, { readOnlyTools: ["mempalace_search"] });
      return gateway;
    };
    const call: MCPToolCall = { schemaVersion: 3, callId: "call-live-ledger", registrationId: client.registrationId,
      serviceId, tool: "mempalace_search", input: { wing: "approved-wing", query: "private query text" }, idempotencyKey: "idem-live-ledger" };
    const firstGateway = makeGateway();
    try {
      expect((await firstGateway.register(client)).ok).toBe(true);
      activeGrant = { ...memoryGrant, operations: ["mempalace_write"] };
      const maliciousRegistration = await firstGateway.register({ ...client, registrationId: "reg-memory-write" });
      expect(maliciousRegistration.ok).toBe(false);
      const memoryWrite = await firstGateway.call({ ...call, callId: "call-memory-write", idempotencyKey: "idem-memory-write",
        tool: "mempalace_write", input: { wing: "approved-wing", content: "must not be written" } });
      expect(memoryWrite.ok).toBe(false);
      expect(fs.existsSync(counterPath)).toBe(false);
      activeGrant = grant;
      const unscopedStatus = await firstGateway.call({ ...call, callId: "call-memory-status", idempotencyKey: "idem-memory-status",
        tool: "mempalace_status", input: { wing: "approved-wing" } });
      expect(unscopedStatus.ok).toBe(false);
      const unscopedSearch = await firstGateway.call({ ...call, callId: "call-unscoped-search", idempotencyKey: "idem-unscoped-search" }, { timeoutMs: 100 });
      expect(unscopedSearch.ok).toBe(false);
      expect(fs.existsSync(counterPath)).toBe(false);
      activeGrant = memoryGrant;
      const first = await firstGateway.call(call, { timeoutMs: 150 });
      // The read-only transport reports its timeout; the durable intent still
      // prevents replay and must recover as unknown after restart.
      expect(first.ok).toBe(false);
      expect(fs.readFileSync(counterPath, "utf8")).toBe("x");
      const ledger = fs.readFileSync(ledgerPath, "utf8");
      expect(ledger).not.toContain("private query text");
    } finally {
      await firstGateway.serviceManager.stop(serviceId, makeScopedOp(makeScope("machine"))).catch(() => undefined);
    }

    const secondGateway = makeGateway();
    try {
      expect((await secondGateway.register(client)).ok).toBe(true);
      const recovered = await secondGateway.call(call);
      expect(recovered.ok && recovered.value.status).toBe("unknown");
      expect(fs.readFileSync(counterPath, "utf8")).toBe("x");
      const conflicting = await secondGateway.call({ ...call, input: { q: "changed request" }, idempotencyKey: "idem-live-ledger-2" });
      expect(conflicting.ok).toBe(false);
      expect(fs.readFileSync(counterPath, "utf8")).toBe("x");
    } finally {
      await secondGateway.serviceManager.stop(serviceId, makeScopedOp(makeScope("machine"))).catch(() => undefined);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Agy stdio to authenticated Gateway HTTP bridge", () => {
  it("initializes, lists and calls tools through the real Gateway without retrying an unknown call", async () => {
    const calls: string[] = [];
    const driverFactory = new ProgrammableDriverFactory(() => ({
      onCallTool: async input => {
        calls.push(input.tool);
        if (input.tool === "compute") throw new Error("fixture upstream failure after dispatch");
        return ok({ isError: false, content: [{ type: "text", text: "gateway-echo-result" }] });
      }
    }));
    const gateway = new BflowSharedMCPGateway({ serviceManager: new DefaultMCPServiceManager({ driverFactory }) });
    gateway.registry.registerService(makeServiceDefinition("svc-agy-bridge"));
    const server = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bflow-agy-bridge-test-"));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const base = await server.start();
      const registration = makeClientRegistration("agy-bridge", "svc-agy-bridge", {
        provider: "agy", role: "developer", allowedTools: ["echo", "compute"],
        scope: makeScope("session", { sessionId: "agy-bridge-session" }) as any
      });
      const registered = await gateway.register(registration);
      expect(registered.ok).toBe(true);
      const token = gateway.secretStore.getClientTokenByRegistration(registration.registrationId);
      expect(token).toBeDefined();

      const entry = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "dist", "agy-stdio-http-cli.js");
      child = spawn(process.execPath, [entry, `${base}/mcp`, registration.registrationId, "BFLOW_GATEWAY_TOKEN", JSON.stringify(["svc-agy-bridge"])], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, BFLOW_GATEWAY_TOKEN: token! },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let buffer = "";
      let stderr = "";
      const pending = new Map<string | number, { resolve: (value: any) => void }>();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf("\n"); if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message: any; try { message = JSON.parse(line); } catch { continue; }
          const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter.resolve(message); }
        }
      });
      child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
      const request = (id: number, method: string, params?: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Agy bridge response timed out for ${method}`)); }, 5000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); } });
        child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      });

      const initialized = await request(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agy-probe", version: "1.4.5" } });
      expect(initialized.result.protocolVersion).toBeDefined();
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const listed = await request(2, "tools/list");
      expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(["echo", "compute"]);

      const completed = await request(3, "tools/call", { name: "echo", arguments: { text: "fixture" } });
      expect(completed.result).toMatchObject({ isError: false, content: [{ text: "gateway-echo-result" }] });
      const unknown = await request(4, "tools/call", { name: "compute", arguments: { value: 1 } });
      expect(unknown.result.isError).toBe(true);
      expect(unknown.result.content[0].text).toContain("unknown");
      expect(calls).toEqual(["echo", "compute"]);
      expect(stderr).not.toContain(token!);
    } finally {
      child?.kill("SIGTERM");
      await server.stop();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
