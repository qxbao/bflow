import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BrowserCallerIdentity,
  type BrowserLauncher,
  type BrowserProcessHandle,
  type BrowserProfileLockMetadata,
  type ManagedBackendDriver,
  type ManagedBackendDriverFactory,
  type MCPServiceDefinition,
  type OSCommandResult,
  type OSCommandRunner,
  type OSServiceConfig,
  type ScopedOperation,
  type TrustScope,
  BackendResourceManager,
  BFLOW_SERVICE_MARKER,
  BflowOSServiceManager,
  DedicatedBrowserRuntime,
  err,
  getPersonalChromeProfilePaths,
  ok,
  resolveBflowOSPaths,
  resolveDedicatedProfileDir,
  validateBrowserProfileDirectory,
  validateLoopbackDebuggingHost
} from "../src/index.js";
import { MCPServiceDefinitionSchema } from "@bflow/contracts";

// ============================================================================
// Mock Implementations for Integration Testing
// ============================================================================

interface MockServiceState {
  active: "active" | "inactive" | "failed";
  enabled: boolean;
  pid: number;
  restarts: number;
  logs: string[];
}

class IntegrationMockOSCommandRunner implements OSCommandRunner {
  public calls: Array<{ argv: readonly string[]; options?: any }> = [];
  public services = new Map<string, MockServiceState>();

  private getOrCreate(id: string): MockServiceState {
    let s = this.services.get(id);
    if (!s) {
      s = { active: "inactive", enabled: true, pid: 0, restarts: 0, logs: [] };
      this.services.set(id, s);
    }
    return s;
  }

  async run(argv: readonly string[], options?: any): Promise<OSCommandResult> {
    this.calls.push({ argv, options });
    const cmd = argv[0];

    // Linux systemctl
    if (cmd === "systemctl") {
      const sub = argv[2];
      const unit = argv.find((a) => a.endsWith(".service") || a.startsWith("bflow-")) ?? "";
      const serviceId = unit ? unit.replace(/^bflow-/, "").replace(/\.service$/, "") : "";

      if (sub === "daemon-reload") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "enable") {
        const s = this.getOrCreate(serviceId);
        s.enabled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "disable") {
        const s = this.getOrCreate(serviceId);
        s.enabled = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "start") {
        const s = this.getOrCreate(serviceId);
        s.active = "active";
        s.pid = 24001;
        s.logs.push(`Started ${serviceId}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "stop") {
        const s = this.getOrCreate(serviceId);
        s.active = "inactive";
        s.pid = 0;
        s.logs.push(`Stopped ${serviceId}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "restart") {
        const s = this.getOrCreate(serviceId);
        s.active = "active";
        s.pid = 24002;
        s.restarts++;
        s.logs.push(`Restarted ${serviceId}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "is-active") {
        const s = this.getOrCreate(serviceId);
        if (s.active === "active") {
          return { exitCode: 0, stdout: "active\n", stderr: "" };
        } else if (s.active === "failed") {
          return { exitCode: 3, stdout: "failed\n", stderr: "" };
        } else {
          return { exitCode: 3, stdout: "inactive\n", stderr: "" };
        }
      }
      if (sub === "is-enabled") {
        const s = this.getOrCreate(serviceId);
        return { exitCode: 0, stdout: s.enabled ? "enabled\n" : "disabled\n", stderr: "" };
      }
      if (sub === "show") {
        const s = this.getOrCreate(serviceId);
        return {
          exitCode: 0,
          stdout: `MainPID=${s.pid}\nNRestarts=${s.restarts}\n`,
          stderr: ""
        };
      }
    }

    // macOS launchctl
    if (cmd === "launchctl") {
      const sub = argv[1];
      const target = argv[2];

      if (sub === "bootstrap") {
        const plistPath = argv[3] ?? "";
        const idMatch = plistPath.match(/dev\.bflow\.(.+)\.plist$/);
        const serviceId = idMatch ? idMatch[1] : "";
        const s = this.getOrCreate(serviceId ?? "");
        s.active = "inactive";
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "bootout") {
        const serviceId = target ? target.split("dev.bflow.").pop() ?? "" : "";
        const s = this.getOrCreate(serviceId);
        s.active = "inactive";
        s.pid = 0;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "kickstart") {
        const isK = argv.includes("-k");
        const fullTarget = argv[argv.length - 1] ?? "";
        const serviceId = fullTarget.split("dev.bflow.").pop() ?? "";
        const s = this.getOrCreate(serviceId);
        s.active = "active";
        s.pid = 34001;
        if (isK) s.restarts++;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "enable") {
        const serviceId = target ? target.split("dev.bflow.").pop() ?? "" : "";
        const s = this.getOrCreate(serviceId);
        s.enabled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "disable") {
        const serviceId = target ? target.split("dev.bflow.").pop() ?? "" : "";
        const s = this.getOrCreate(serviceId);
        s.enabled = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (sub === "print") {
        const serviceId = target ? target.split("dev.bflow.").pop() ?? "" : "";
        const s = this.getOrCreate(serviceId);
        if (s.active === "active") {
          return {
            exitCode: 0,
            stdout: `state = running\npid = ${s.pid}\ndisabled = ${!s.enabled}\n`,
            stderr: ""
          };
        } else {
          return {
            exitCode: 0,
            stdout: `state = stopped\ndisabled = ${!s.enabled}\n`,
            stderr: ""
          };
        }
      }
    }

    // Windows schtasks
    if (cmd === "schtasks") {
      const sub = argv[1];
      const tnIndex = argv.indexOf("/TN");
      const tn = tnIndex !== -1 ? argv[tnIndex + 1] : "";
      const serviceId = tn ? tn.split("bflow-").pop() ?? "" : "";
      const s = this.getOrCreate(serviceId);

      if (sub === "/Create") {
        return { exitCode: 0, stdout: "SUCCESS: The scheduled task was successfully created.\n", stderr: "" };
      }
      if (sub === "/Run") {
        s.active = "active";
        s.pid = 44001;
        return { exitCode: 0, stdout: "SUCCESS: Attempted to run the scheduled task.\n", stderr: "" };
      }
      if (sub === "/End") {
        s.active = "inactive";
        s.pid = 0;
        return { exitCode: 0, stdout: "SUCCESS: The scheduled task was terminated successfully.\n", stderr: "" };
      }
      if (sub === "/Change") {
        if (argv.includes("/ENABLE")) s.enabled = true;
        if (argv.includes("/DISABLE")) s.enabled = false;
        return { exitCode: 0, stdout: "SUCCESS: The parameters of scheduled task were changed.\n", stderr: "" };
      }
      if (sub === "/Query") {
        const statusStr = s.active === "active" ? "Running" : "Ready";
        const schedStr = s.enabled ? "Enabled" : "Disabled";
        return {
          exitCode: 0,
          stdout: `TaskName: ${tn}\nStatus: ${statusStr}\nScheduled Task State: ${schedStr}\n`,
          stderr: ""
        };
      }
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class MockBackendDriver implements ManagedBackendDriver {
  readonly instanceId: string;
  readonly pid?: number | undefined;
  readonly startGeneration: number;
  readonly ownership: "bflow" | "external";
  alive = true;
  memoryBytes = 25 * 1024 * 1024;
  stopReasons: string[] = [];
  crashListeners: ((reason: string) => void)[] = [];

  constructor(
    instanceId: string,
    ownership: "bflow" | "external",
    generation: number,
    pid = 50000
  ) {
    this.instanceId = instanceId;
    this.ownership = ownership;
    this.startGeneration = generation;
    this.pid = pid;
  }

  async initialize() {
    return ok({
      protocolVersion: "2024-11-05",
      discoveredTools: ["read_source", "run_query"]
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
    if (reason) this.stopReasons.push(reason);
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

class MockBackendDriverFactory implements ManagedBackendDriverFactory {
  createdDrivers: MockBackendDriver[] = [];
  nextPid = 50000;

  async createDriver(
    definition: MCPServiceDefinition,
    _partitionKey: string,
    generation: number
  ) {
    const instanceId = `inst-${definition.serviceId}-${this.createdDrivers.length + 1}`;
    const driver = new MockBackendDriver(
      instanceId,
      definition.connection.ownership,
      generation,
      this.nextPid++
    );
    this.createdDrivers.push(driver);
    return ok(driver);
  }
}

class MockBrowserProcessHandle implements BrowserProcessHandle {
  pid: number;
  debuggingHost: string;
  debuggingPort: number;
  supportsBrowserContexts: boolean;

  alive = true;
  memoryRssBytes = 50 * 1024 * 1024;
  endpointAccessible = true;
  disposedContexts: string[] = [];
  stopped = false;
  stopReason?: string;
  private crashListeners = new Set<(reason: string) => void>();

  constructor(options?: {
    pid?: number;
    debuggingHost?: string;
    debuggingPort?: number;
    supportsBrowserContexts?: boolean;
    endpointAccessible?: boolean;
    memoryRssBytes?: number;
  }) {
    this.pid = options?.pid ?? 60000;
    this.debuggingHost = options?.debuggingHost ?? "127.0.0.1";
    this.debuggingPort = options?.debuggingPort ?? 9222;
    this.supportsBrowserContexts = options?.supportsBrowserContexts ?? true;
    this.endpointAccessible = options?.endpointAccessible ?? true;
    this.memoryRssBytes = options?.memoryRssBytes ?? 50 * 1024 * 1024;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async getMemoryRssBytes(): Promise<number> {
    return this.memoryRssBytes;
  }

  async probeDebuggingEndpoint(): Promise<boolean> {
    return this.endpointAccessible;
  }

  async createBrowserContext(): Promise<string> {
    return `ctx-mock-${Math.random().toString(36).slice(2, 10)}`;
  }

  async disposeBrowserContext(contextId: string): Promise<void> {
    this.disposedContexts.push(contextId);
  }

  async stop(reason?: string): Promise<void> {
    this.alive = false;
    this.stopped = true;
    this.stopReason = reason;
  }

  onCrash(listener: (reason: string) => void): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  simulateCrash(reason = "Simulated crash"): void {
    this.alive = false;
    for (const listener of this.crashListeners) {
      listener(reason);
    }
  }
}

class MockBrowserLauncher implements BrowserLauncher {
  binaryExists = true;
  supportsBrowserContexts = true;
  endpointAccessible = true;
  launchedHandles: MockBrowserProcessHandle[] = [];
  nextPid = 60000;

  async probeBinary(executablePath: string) {
    if (!this.binaryExists || executablePath.includes("missing")) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Chrome binary is missing at '${executablePath}'`,
        details: { diagnosticCode: "chrome_binary_missing", executablePath }
      });
    }
    return ok({ version: "Google Chrome 130.0.0.0" });
  }

  async launch(options: {
    readonly executablePath: string;
    readonly profileDir: string;
    readonly debuggingHost: string;
    readonly debuggingPort: number;
    readonly headless: boolean;
    readonly extraArgs: readonly string[];
  }) {
    const probe = await this.probeBinary(options.executablePath);
    if (!probe.ok) return err(probe.error);

    const handle = new MockBrowserProcessHandle({
      pid: this.nextPid++,
      debuggingHost: options.debuggingHost,
      debuggingPort: options.debuggingPort,
      supportsBrowserContexts: this.supportsBrowserContexts,
      endpointAccessible: this.endpointAccessible
    });
    this.launchedHandles.push(handle);
    return ok(handle);
  }
}

function createTestServiceDef(
  serviceId: string,
  ownership: "bflow" | "external" = "bflow",
  overrides?: Partial<MCPServiceDefinition>
): MCPServiceDefinition {
  const kind = ownership === "bflow" ? "stdio_mcp" : "native_remote_mcp";
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
    idleTimeoutMs: 1000,
    restartLimit: 3,
    ...overrides
  };

  const parsed = MCPServiceDefinitionSchema.safeParse(def);
  if (!parsed.success) {
    throw new Error(`Invalid test definition: ${parsed.error.message}`);
  }
  return parsed.data;
}

// ============================================================================
// End-to-End Integration Test Suite across 11 Scenarios
// ============================================================================

describe("Bflow MCP Services Integration Scenarios", () => {
  let tmpRoot: string;
  let homeDir: string;
  let mockRunner: IntegrationMockOSCommandRunner;
  let driverFactory: MockBackendDriverFactory;
  let browserLauncher: MockBrowserLauncher;

  const defaultServiceConfig: OSServiceConfig = {
    schemaVersion: 3,
    serviceId: "mcp-gateway",
    description: "Bflow Shared MCP Gateway",
    program: "/usr/local/bin/node",
    args: ["/opt/bflow/mcp-gateway/daemon.js", "--host", "127.0.0.1", "--port", "43110"],
    workingDirectory: "/opt/bflow",
    env: {
      BFLOW_GATEWAY_HOST: "127.0.0.1",
      BFLOW_GATEWAY_PORT: "43110"
    },
    healthEndpointUrl: "http://127.0.0.1:43110/health",
    healthTimeoutMs: 1000,
    keepAliveOnCrash: true,
    enableOnLogin: true,
    restartSec: 2,
    maxRestartBurst: 5
  };

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "bflow-int-test-"));
    homeDir = path.join(tmpRoot, "home", "developer");
    await mkdir(homeDir, { recursive: true });

    mockRunner = new IntegrationMockOSCommandRunner();
    driverFactory = new MockBackendDriverFactory();
    browserLauncher = new MockBrowserLauncher();
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Scenario 1 — OS service startup
  // --------------------------------------------------------------------------
  it("Scenario 1 — OS service startup across Linux, macOS, and Windows with static template verification", async () => {
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const linuxTemplatePath = path.join(pkgRoot, "services", "linux", "bflow-mcp-gateway.service");
    const macosTemplatePath = path.join(pkgRoot, "services", "macos", "dev.bflow.mcp-gateway.plist");
    const windowsTemplatePath = path.join(pkgRoot, "services", "windows", "bflow-mcp-gateway-task.xml");

    // 1. Verify static template files exist on disk and have loopback bindings & BFLOW_SERVICE_MARKER
    const linuxTmpl = await readFile(linuxTemplatePath, "utf8");
    expect(linuxTmpl).toContain(BFLOW_SERVICE_MARKER);
    expect(linuxTmpl).toContain("127.0.0.1");

    const macosTmpl = await readFile(macosTemplatePath, "utf8");
    expect(macosTmpl).toContain(BFLOW_SERVICE_MARKER);
    expect(macosTmpl).toContain("127.0.0.1");

    const winTmpl = await readFile(windowsTemplatePath, "utf8");
    expect(winTmpl).toContain(BFLOW_SERVICE_MARKER);
    expect(winTmpl).toContain("127.0.0.1");

    // 2. Linux systemd-user installation and startup
    const linuxMgr = new BflowOSServiceManager({
      env: {},
      platform: "linux",
      homeDir,
      runner: mockRunner,
      healthProbe: async () => true
    });
    const linuxInstall = await linuxMgr.install(defaultServiceConfig);
    expect(linuxInstall.ok).toBe(true);
    expect(linuxInstall.value.installed).toBe(true);
    expect(linuxInstall.value.backendKind).toBe("systemd-user");
    expect(linuxInstall.value.unitPath).toContain("systemd/user/bflow-mcp-gateway.service");

    const linuxStart = await linuxMgr.start("mcp-gateway");
    expect(linuxStart.ok).toBe(true);
    expect(linuxStart.value.state).toBe("running");

    // 3. macOS launchd installation and startup
    const macosMgr = new BflowOSServiceManager({
      env: {},
      platform: "darwin",
      homeDir,
      uid: 501,
      runner: mockRunner,
      healthProbe: async () => true
    });
    const macosInstall = await macosMgr.install(defaultServiceConfig);
    expect(macosInstall.ok).toBe(true);
    expect(macosInstall.value.installed).toBe(true);
    expect(macosInstall.value.backendKind).toBe("launchd");
    expect(macosInstall.value.unitPath).toContain("LaunchAgents/dev.bflow.mcp-gateway.plist");

    const macosStart = await macosMgr.start("mcp-gateway");
    expect(macosStart.ok).toBe(true);
    expect(macosStart.value.state).toBe("running");

    // 4. Windows startup unverified vs verified
    const winUnverifiedMgr = new BflowOSServiceManager({
      env: {},
      platform: "win32",
      homeDir,
      runner: mockRunner,
      windowsVerified: false
    });
    const unverifiedRes = await winUnverifiedMgr.install(defaultServiceConfig);
    expect(unverifiedRes.ok).toBe(false);
    expect(unverifiedRes.error.details?.diagnosticCode).toBe("windows_unverified");

    const winVerifiedMgr = new BflowOSServiceManager({
      env: {},
      platform: "win32",
      homeDir,
      runner: mockRunner,
      windowsVerified: true,
      healthProbe: async () => true
    });
    const winInstall = await winVerifiedMgr.install(defaultServiceConfig);
    expect(winInstall.ok).toBe(true);
    expect(winInstall.value.installed).toBe(true);
    expect(winInstall.value.backendKind).toBe("windows-startup");

    const winStart = await winVerifiedMgr.start("mcp-gateway");
    expect(winStart.ok).toBe(true);
    expect(winStart.value.state).toBe("running");
  });

  // --------------------------------------------------------------------------
  // Scenario 2 — Service restart & auto-recovery
  // --------------------------------------------------------------------------
  it("Scenario 2 — Service restart & auto-recovery without root privileges", async () => {
    let healthProbeSuccess = true;
    const manager = new BflowOSServiceManager({
      env: {},
      platform: "linux",
      homeDir,
      runner: mockRunner,
      healthProbe: async () => healthProbeSuccess
    });

    await manager.install(defaultServiceConfig);
    await manager.start("mcp-gateway");

    // Simulate crash: service state failed and health check failing
    const mockState = mockRunner.services.get("mcp-gateway")!;
    mockState.active = "failed";
    healthProbeSuccess = false;

    const initialHealth = await manager.healthCheck("mcp-gateway");
    expect(initialHealth.ok).toBe(true);
    expect(initialHealth.value.healthy).toBe(false);

    // Auto-recovery via recoverIfDead()
    healthProbeSuccess = true;
    const recoverRes = await manager.recoverIfDead("mcp-gateway", defaultServiceConfig);
    expect(recoverRes.ok).toBe(true);
    expect(recoverRes.value.healthy).toBe(true);
    expect(recoverRes.value.processAlive).toBe(true);

    // Verify unowned unit file protection during repair()
    const unitPath = manager.unitPath("mcp-gateway");
    await writeFile(unitPath, "# Custom unmanaged unit\n[Unit]\nDescription=Alien\n", "utf8");
    const unownedRepair = await manager.repair("mcp-gateway", defaultServiceConfig);
    expect(unownedRepair.ok).toBe(false);
    expect(unownedRepair.error.details?.diagnosticCode).toBe("unowned_unit_file");

    // Restore ownership marker and test repair() creating a backup
    await writeFile(unitPath, `# ${BFLOW_SERVICE_MARKER}\n[Unit]\nDescription=Tampered\n`, "utf8");
    const validRepair = await manager.repair("mcp-gateway", defaultServiceConfig);
    expect(validRepair.ok).toBe(true);
    expect(validRepair.value.repaired).toBe(true);
    expect(validRepair.value.actionsTaken.some((a) => a.startsWith("backed_up_unit:"))).toBe(true);

    // Verify restart burst limit enforcement (service must be unhealthy to check burst limit)
    mockState.active = "failed";
    healthProbeSuccess = false;
    for (let i = 0; i < 5; i++) {
      await manager.restart("mcp-gateway");
    }
    const burstExceeded = await manager.recoverIfDead("mcp-gateway", defaultServiceConfig);
    expect(burstExceeded.ok).toBe(false);
    expect(burstExceeded.error.details?.diagnosticCode).toBe("restart_limit_exceeded");
  });

  // --------------------------------------------------------------------------
  // Scenario 3 — System login simulation & lazy vs eager backends
  // --------------------------------------------------------------------------
  it("Scenario 3 — System login simulation chained with initializeUserSession: 0 RAM lazy backends until demand", async () => {
    const serviceManager = new BflowOSServiceManager({
      env: {},
      platform: "linux",
      homeDir,
      runner: mockRunner
    });
    await serviceManager.install(defaultServiceConfig);

    // 1. Simulate OS login
    const loginRes = await serviceManager.simulateUserLogin();
    expect(loginRes.ok).toBe(true);
    expect(loginRes.value.length).toBeGreaterThan(0);
    expect(loginRes.value[0]?.state).toBe("running");

    // 2. Resource manager initialization
    const resourceManager = new BackendResourceManager({
      driverFactory
    });

    const eagerService = createTestServiceDef("shared-tools");
    const lazyBrowserService = createTestServiceDef("chrome-devtools-mcp");
    const lazyGitnexusService = createTestServiceDef("gitnexus");

    const r1 = resourceManager.registerBackend(eagerService, { startupMode: "eager" });
    const r2 = resourceManager.registerBackend(lazyBrowserService, { startupMode: "lazy" });
    const r3 = resourceManager.registerBackend(lazyGitnexusService, { startupMode: "lazy" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);

    const machineScope: TrustScope = { kind: "machine", machineId: "node-1" };
    const observations = await resourceManager.initializeUserSession(machineScope);

    // Eager backend is ready; lazy backends are stopped and unstarted
    expect(observations.length).toBe(3);
    const eagerObs = observations.find((o) => o.serviceId === "shared-tools");
    expect(eagerObs?.status).toBe("ready");

    const lazyBrowserObs = observations.find((o) => o.serviceId === "chrome-devtools-mcp");
    expect(lazyBrowserObs?.status).toBe("stopped");
    expect(lazyBrowserObs?.diagnosticCode).toBe("lazy_unstarted");

    const lazyGitnexusObs = observations.find((o) => o.serviceId === "gitnexus");
    expect(lazyGitnexusObs?.status).toBe("stopped");
    expect(lazyGitnexusObs?.diagnosticCode).toBe("lazy_unstarted");

    const metricsBeforeDemand = resourceManager.getMetricsSnapshot();
    expect(metricsBeforeDemand.activeProcessCount).toBe(1); // only eager
    expect(metricsBeforeDemand.lazyStoppedCount).toBe(2);

    // 3. First agent tool demand launches lazy backend
    const op: ScopedOperation = {
      schemaVersion: 3,
      scope: machineScope,
      idempotencyKey: "call-1"
    };
    const demandRes = await resourceManager.ensure(lazyBrowserService, op);
    expect(demandRes.ok).toBe(true);
    expect(demandRes.value.status).toBe("ready");

    const metricsAfterDemand = resourceManager.getMetricsSnapshot();
    expect(metricsAfterDemand.activeProcessCount).toBe(2);
    expect(metricsAfterDemand.lazyStoppedCount).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 4 — Multiple clients
  // --------------------------------------------------------------------------
  it("Scenario 4 — Multiple concurrent clients attach to single backend and prevent sweep termination", async () => {
    const resourceManager = new BackendResourceManager({
      driverFactory
    });

    const sharedDef = createTestServiceDef("multi-agent-backend");
    const regRes = resourceManager.registerBackend(sharedDef, { idleTimeoutMs: 500 });
    expect(regRes.ok).toBe(true);

    const machineScope: TrustScope = { kind: "machine", machineId: "m-shared" };
    const op: ScopedOperation = {
      schemaVersion: 3,
      scope: machineScope,
      idempotencyKey: "client-connect"
    };

    // Attach Claude, Codex, Agy
    const c1 = await resourceManager.attachClient("multi-agent-backend", "agent-claude", op);
    const c2 = await resourceManager.attachClient("multi-agent-backend", "agent-codex", op);
    const c3 = await resourceManager.attachClient("multi-agent-backend", "agent-agy", op);

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    expect(c3.ok).toBe(true);

    const metrics = resourceManager.getMetricsSnapshot();
    expect(metrics.activeProcessCount).toBe(1); // Single process shared across clients

    // Sweep idle backends should refuse to kill while clients are active
    const sweepWhileActive = await resourceManager.sweepIdleBackends(new Date(Date.now() + 5000));
    expect(sweepWhileActive.length).toBe(1);
    expect(sweepWhileActive[0]?.diagnosticCode).toBe("retained_active_clients");

    // Detach two clients: still retained
    await resourceManager.detachClient("multi-agent-backend", "agent-claude", op);
    await resourceManager.detachClient("multi-agent-backend", "agent-codex", op);

    const sweepWithOneClient = await resourceManager.sweepIdleBackends(new Date(Date.now() + 5000));
    expect(sweepWithOneClient[0]?.diagnosticCode).toBe("retained_active_clients");

    // Detach final client: enters idle grace period
    await resourceManager.detachClient("multi-agent-backend", "agent-agy", op);

    // Advance time past idle timeout (500ms): backend should now be stopped
    const sweepAfterAllDetached = await resourceManager.sweepIdleBackends(new Date(Date.now() + 1000));
    expect(sweepAfterAllDetached.length).toBe(1);
    expect(sweepAfterAllDetached[0]?.status).toBe("stopped");
    expect(sweepAfterAllDetached[0]?.diagnosticCode).toBe("stopped_idle");

    expect(resourceManager.getMetricsSnapshot().activeProcessCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 5 — Multiple repositories
  // --------------------------------------------------------------------------
  it("Scenario 5 — Multiple repositories connect concurrently with strict process and profile isolation", async () => {
    const resourceManager = new BackendResourceManager({
      driverFactory
    });

    const repoServiceDef = createTestServiceDef("repo-tool-backend");
    const regRes = resourceManager.registerBackend(repoServiceDef, { isolateByRepository: true });
    expect(regRes.ok).toBe(true);

    const repoAlphaRoot = path.join(tmpRoot, "repo-alpha");
    const repoBetaRoot = path.join(tmpRoot, "repo-beta");
    await mkdir(repoAlphaRoot, { recursive: true });
    await mkdir(repoBetaRoot, { recursive: true });

    const scopeAlpha: TrustScope = {
      kind: "repository",
      machineId: "mach-1",
      repositoryId: "repo-alpha",
      workspaceRoot: repoAlphaRoot
    };
    const scopeBeta: TrustScope = {
      kind: "repository",
      machineId: "mach-1",
      repositoryId: "repo-beta",
      workspaceRoot: repoBetaRoot
    };

    // 1. Backend resource manager partition isolation
    const opAlpha: ScopedOperation = { schemaVersion: 3, scope: scopeAlpha, idempotencyKey: "op-a" };
    const opBeta: ScopedOperation = { schemaVersion: 3, scope: scopeBeta, idempotencyKey: "op-b" };

    const resA = await resourceManager.ensure(repoServiceDef, opAlpha);
    const resB = await resourceManager.ensure(repoServiceDef, opBeta);

    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    expect(resA.value.instanceId).not.toBe(resB.value.instanceId);
    expect(resourceManager.getMetricsSnapshot().activeProcessCount).toBe(2);

    // 2. Browser runtime profile and context isolation per repository
    const browserRuntime = new DedicatedBrowserRuntime({
      homeDir,
      browserProfilesRoot: path.join(tmpRoot, "profiles"),
      launcher: browserLauncher,
      repositoryRoots: [repoAlphaRoot, repoBetaRoot]
    });

    const callerAlpha: BrowserCallerIdentity = {
      registrationId: "reg-1",
      runId: "run-alpha",
      taskId: "task-1",
      scope: scopeAlpha
    };
    const callerBeta: BrowserCallerIdentity = {
      registrationId: "reg-2",
      runId: "run-beta",
      taskId: "task-2",
      scope: scopeBeta
    };

    const pageA = await browserRuntime.openPage(callerAlpha, "https://alpha.internal");
    const pageB = await browserRuntime.openPage(callerBeta, "https://beta.internal");

    expect(pageA.ok).toBe(true);
    expect(pageB.ok).toBe(true);

    // Dedicated profile directories are strictly separate and contain repo ID prefix
    const profileA = resolveDedicatedProfileDir(browserRuntime.browserProfilesRoot, scopeAlpha);
    const profileB = resolveDedicatedProfileDir(browserRuntime.browserProfilesRoot, scopeBeta);
    expect(profileA).not.toBe(profileB);
    expect(profileA).toContain("repo-repo-alpha");
    expect(profileB).toContain("repo-repo-beta");

    // Cross-repository tab visibility is completely blocked
    const listA = await browserRuntime.listPages(callerAlpha);
    const listB = await browserRuntime.listPages(callerBeta);
    expect(listA.value.map((p) => p.pageId)).toContain(pageA.value.pageId);
    expect(listA.value.map((p) => p.pageId)).not.toContain(pageB.value.pageId);
    expect(listB.value.map((p) => p.pageId)).toContain(pageB.value.pageId);
    expect(listB.value.map((p) => p.pageId)).not.toContain(pageA.value.pageId);

    await browserRuntime.stop();
  });

  // --------------------------------------------------------------------------
  // Scenario 6 — Browser profile locked
  // --------------------------------------------------------------------------
  it("Scenario 6 — Browser profile locked detection, rejection, and dead-PID stale lock recovery", async () => {
    const browserProfilesRoot = path.join(tmpRoot, "profiles");
    const repoRoot = path.join(tmpRoot, "workspace");
    await mkdir(repoRoot, { recursive: true });

    // 1. Verify directory validation: cannot be inside repo or personal Chrome dir
    const insideRepo = path.join(repoRoot, "chrome-data");
    const valRepo = validateBrowserProfileDirectory({
      targetProfileDir: insideRepo,
      homeDir,
      repositoryRoots: [repoRoot]
    });
    expect(valRepo.ok).toBe(false);
    expect(valRepo.error.details?.diagnosticCode).toBe("repository_profile_forbidden");

    const personalDirs = getPersonalChromeProfilePaths(homeDir);
    if (personalDirs.length > 0 && personalDirs[0]) {
      const valPersonal = validateBrowserProfileDirectory({
        targetProfileDir: personalDirs[0],
        homeDir
      });
      expect(valPersonal.ok).toBe(false);
      expect(valPersonal.error.details?.diagnosticCode).toBe("personal_profile_forbidden");
    }

    // 2. Active profile lock blocks launch
    let mockPidAlive = true;
    const browserRuntime = new DedicatedBrowserRuntime({
      homeDir,
      browserProfilesRoot,
      launcher: browserLauncher,
      isPidAlive: (_pid) => mockPidAlive
    });

    const scope: TrustScope = { kind: "machine", machineId: "local-m" };
    const caller: BrowserCallerIdentity = {
      registrationId: "reg-test",
      runId: "run-lock",
      taskId: "task-lock",
      scope
    };

    // Manually plant active .bflow-profile.lock
    const profileDir = resolveDedicatedProfileDir(browserProfilesRoot, scope);
    await mkdir(profileDir, { recursive: true });
    const lockMeta: BrowserProfileLockMetadata = {
      schemaVersion: 3,
      instanceId: "foreign-inst",
      pid: 99999,
      scopeKey: "machine:local-m",
      profileDir,
      debuggingHost: "127.0.0.1",
      debuggingPort: 9222,
      acquiredAt: new Date().toISOString()
    };
    await writeFile(path.join(profileDir, ".bflow-profile.lock"), JSON.stringify(lockMeta), "utf8");

    // Launch should fail with profile_locked
    const lockedRes = await browserRuntime.openPage(caller);
    expect(lockedRes.ok).toBe(false);
    expect(lockedRes.error.details?.diagnosticCode).toBe("profile_locked");

    // 3. Stale lock recovery: when lock owner PID is dead, launch automatically cleans up lock
    mockPidAlive = false;
    const recoveredRes = await browserRuntime.openPage(caller);
    expect(recoveredRes.ok).toBe(true);

    await browserRuntime.stop();
  });

  // --------------------------------------------------------------------------
  // Scenario 7 — Browser crash
  // --------------------------------------------------------------------------
  it("Scenario 7 — Browser crash detection, stale lock cleanup, and reconnectAfterCrash() recovery", async () => {
    const browserRuntime = new DedicatedBrowserRuntime({
      homeDir,
      browserProfilesRoot: path.join(tmpRoot, "profiles"),
      launcher: browserLauncher
    });

    const scope: TrustScope = { kind: "machine", machineId: "m-crash" };
    const caller: BrowserCallerIdentity = {
      registrationId: "reg-c",
      runId: "run-c",
      taskId: "task-c",
      scope
    };

    const pageRes = await browserRuntime.openPage(caller, "https://initial.test");
    expect(pageRes.ok).toBe(true);

    const initialHealth = await browserRuntime.healthCheck(scope);
    expect(initialHealth.ok).toBe(true);
    expect(initialHealth.value.status).toBe("healthy");

    // Simulate browser crash
    const handle = browserLauncher.launchedHandles[0]!;
    handle.simulateCrash("SIGKILL");

    const crashedHealth = await browserRuntime.healthCheck(scope);
    expect(crashedHealth.ok).toBe(true);
    expect(crashedHealth.value.status).toBe("crashed");
    expect(crashedHealth.value.diagnosticCode).toBe("browser_crashed");

    // Reconnect after crash
    const reconnectRes = await browserRuntime.reconnectAfterCrash(scope);
    expect(reconnectRes.ok).toBe(true);
    expect(reconnectRes.value.status).toBe("healthy");

    const metrics = browserRuntime.getMetrics();
    expect(metrics.crashCount).toBe(1);
    expect(metrics.reconnectCount).toBe(1);

    await browserRuntime.stop();
  });

  // --------------------------------------------------------------------------
  // Scenario 8 — Page ownership conflict & shared Chrome isolation
  // --------------------------------------------------------------------------
  it("Scenario 8 — Page ownership conflict, cookie isolation, and separate process fallback", async () => {
    const browserRuntime = new DedicatedBrowserRuntime({
      homeDir,
      browserProfilesRoot: path.join(tmpRoot, "profiles"),
      launcher: browserLauncher,
      isolationMode: "browser_context"
    });

    const scope: TrustScope = { kind: "machine", machineId: "m-perm" };
    const agentA: BrowserCallerIdentity = {
      registrationId: "agent-a",
      runId: "run-1",
      taskId: "task-1",
      scope
    };
    const agentB: BrowserCallerIdentity = {
      registrationId: "agent-b",
      runId: "run-2",
      taskId: "task-2",
      scope
    };

    // Agent A opens a page and sets cookies
    const pageA = await browserRuntime.openPage(agentA, "https://site-a.org");
    expect(pageA.ok).toBe(true);
    await browserRuntime.setCookies(agentA, pageA.value.pageId, { auth_session: "token-secret-a" });
    await browserRuntime.setPageContent(agentA, pageA.value.pageId, "<h1>Secret A</h1>");

    // Agent B attempts to interact with Agent A's page: all operations MUST fail with page_ownership_conflict
    const navB = await browserRuntime.navigatePage(agentB, pageA.value.pageId, "https://evil.org");
    expect(navB.ok).toBe(false);
    expect(navB.error.details?.diagnosticCode).toBe("page_ownership_conflict");

    const contentB = await browserRuntime.getPageContent(agentB, pageA.value.pageId);
    expect(contentB.ok).toBe(false);
    expect(contentB.error.details?.diagnosticCode).toBe("page_ownership_conflict");

    const setContentB = await browserRuntime.setPageContent(agentB, pageA.value.pageId, "<p>Hacked</p>");
    expect(setContentB.ok).toBe(false);
    expect(setContentB.error.details?.diagnosticCode).toBe("page_ownership_conflict");

    const cookieB = await browserRuntime.getCookies(agentB, pageA.value.pageId);
    expect(cookieB.ok).toBe(false);
    expect(cookieB.error.details?.diagnosticCode).toBe("page_ownership_conflict");

    const setCookieB = await browserRuntime.setCookies(agentB, pageA.value.pageId, { evil: "true" });
    expect(setCookieB.ok).toBe(false);
    expect(setCookieB.error.details?.diagnosticCode).toBe("page_ownership_conflict");

    const closeB = await browserRuntime.closePage(agentB, pageA.value.pageId);
    expect(closeB.ok).toBe(false);
    expect(closeB.error.details?.diagnosticCode).toBe("page_ownership_conflict");

    // listPages hides Agent A's tabs from Agent B
    const listB = await browserRuntime.listPages(agentB);
    expect(listB.ok).toBe(true);
    expect(listB.value.length).toBe(0);

    // Fallback to separate process when supportsBrowserContexts === false
    const noContextLauncher = new MockBrowserLauncher();
    noContextLauncher.supportsBrowserContexts = false;
    const fallbackRuntime = new DedicatedBrowserRuntime({
      homeDir,
      browserProfilesRoot: path.join(tmpRoot, "fallback-profiles"),
      launcher: noContextLauncher,
      supportsBrowserContexts: false
    });

    const p1 = await fallbackRuntime.openPage(agentA, "https://p1.org");
    const p2 = await fallbackRuntime.openPage(agentB, "https://p2.org");
    expect(p1.ok).toBe(true);
    expect(p2.ok).toBe(true);
    expect(p1.value.instanceId).not.toBe(p2.value.instanceId); // Separate instances spawned

    await browserRuntime.stop();
    await fallbackRuntime.stop();
  });

  // --------------------------------------------------------------------------
  // Scenario 9 — Chrome binary missing
  // --------------------------------------------------------------------------
  it("Scenario 9 — Chrome binary missing fails fast without orphan lock files or processes", async () => {
    browserLauncher.binaryExists = false;
    const browserRuntime = new DedicatedBrowserRuntime({
      homeDir,
      browserProfilesRoot: path.join(tmpRoot, "profiles"),
      launcher: browserLauncher,
      executablePath: "/nonexistent/chrome"
    });

    const scope: TrustScope = { kind: "machine", machineId: "m-bin" };
    const caller: BrowserCallerIdentity = {
      registrationId: "reg-missing",
      runId: "run-m",
      taskId: "task-m",
      scope
    };

    const launchRes = await browserRuntime.openPage(caller);
    expect(launchRes.ok).toBe(false);
    expect(launchRes.error.details?.diagnosticCode).toBe("chrome_binary_missing");

    // Verify no lock file created
    const profileDir = resolveDedicatedProfileDir(browserRuntime.browserProfilesRoot, scope);
    let lockExists = false;
    try {
      await access(path.join(profileDir, ".bflow-profile.lock"));
      lockExists = true;
    } catch {
      lockExists = false;
    }
    expect(lockExists).toBe(false);
    expect(browserLauncher.launchedHandles.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 10 — Remote debugging endpoint inaccessible
  // --------------------------------------------------------------------------
  it("Scenario 10 — Remote debugging endpoint inaccessible & non-loopback host rejection", async () => {
    // 1. Non-loopback host rejected
    const nonLoopbackCheck = validateLoopbackDebuggingHost("0.0.0.0");
    expect(nonLoopbackCheck.ok).toBe(false);
    expect(nonLoopbackCheck.error.details?.diagnosticCode).toBe("non_loopback_forbidden");

    const publicIpCheck = validateLoopbackDebuggingHost("192.168.1.50");
    expect(publicIpCheck.ok).toBe(false);
    expect(publicIpCheck.error.details?.diagnosticCode).toBe("non_loopback_forbidden");

    // 2. Unreachable loopback debugging endpoint fails fast
    browserLauncher.endpointAccessible = false;
    const browserRuntime = new DedicatedBrowserRuntime({
      homeDir,
      browserProfilesRoot: path.join(tmpRoot, "profiles"),
      launcher: browserLauncher,
      debuggingHost: "127.0.0.1"
    });

    const scope: TrustScope = { kind: "machine", machineId: "m-endpoint" };
    const caller: BrowserCallerIdentity = {
      registrationId: "reg-ep",
      runId: "run-ep",
      taskId: "task-ep",
      scope
    };

    const openRes = await browserRuntime.openPage(caller);
    expect(openRes.ok).toBe(false);
    expect(openRes.error.details?.diagnosticCode).toBe("debugging_endpoint_inaccessible");

    // Cleaned up locks and stopped handle
    expect(browserLauncher.launchedHandles[0]?.stopped).toBe(true);
    const profileDir = resolveDedicatedProfileDir(browserRuntime.browserProfilesRoot, scope);
    let lockExists = false;
    try {
      await access(path.join(profileDir, ".bflow-profile.lock"));
      lockExists = true;
    } catch {
      lockExists = false;
    }
    expect(lockExists).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Scenario 11 — Idle resource cleanup & task cleanup
  // --------------------------------------------------------------------------
  it("Scenario 11 — Immediate task cleanup and idle backend sweep freeing RAM after idleTimeoutMs", async () => {
    // 1. Browser runtime immediate task cleanup
    const browserRuntime = new DedicatedBrowserRuntime({
      homeDir,
      browserProfilesRoot: path.join(tmpRoot, "profiles"),
      launcher: browserLauncher
    });

    const scope: TrustScope = { kind: "machine", machineId: "m-cleanup" };
    const caller: BrowserCallerIdentity = {
      registrationId: "reg-task",
      runId: "run-complete",
      taskId: "task-complete",
      scope
    };

    await browserRuntime.openPage(caller, "https://task-page-1.com");
    await browserRuntime.openPage(caller, "https://task-page-2.com");
    expect(browserRuntime.getMetrics().activePages).toBe(2);

    // Complete task: pages & contexts cleaned up immediately
    const cleanupRes = await browserRuntime.cleanupTask("run-complete", "task-complete", scope);
    expect(cleanupRes.ok).toBe(true);
    expect(cleanupRes.value.closedPages).toBe(2);
    expect(browserRuntime.getMetrics().activePages).toBe(0);

    // 2. Backend resource manager idle timeout sweep
    const resourceManager = new BackendResourceManager({
      driverFactory
    });

    const warmDef = createTestServiceDef("warm-backend");
    const regRes = resourceManager.registerBackend(warmDef, { idleTimeoutMs: 1000 });
    expect(regRes.ok).toBe(true);

    const op: ScopedOperation = {
      schemaVersion: 3,
      scope,
      idempotencyKey: "warm-op"
    };

    const ensRes = await resourceManager.ensure(warmDef, op);
    expect(ensRes.ok).toBe(true);
    expect(resourceManager.getMetricsSnapshot().activeProcessCount).toBe(1);

    // Release to start idle grace period
    await resourceManager.release("warm-backend", op);

    // Sweep before idleTimeoutMs (500ms): backend remains warm and running
    const earlySweep = await resourceManager.sweepIdleBackends(new Date(Date.now() + 500));
    expect(earlySweep.length).toBe(0);
    expect(resourceManager.getMetricsSnapshot().activeProcessCount).toBe(1);

    // New client arrives before timeout: reuses warm instance
    await resourceManager.ensure(warmDef, op);
    expect(resourceManager.getMetricsSnapshot().activeProcessCount).toBe(1);

    // Release again and advance time past 1000ms
    await resourceManager.release("warm-backend", op);
    const expiredSweep = await resourceManager.sweepIdleBackends(new Date(Date.now() + 2000));
    expect(expiredSweep.length).toBe(1);
    expect(expiredSweep[0]?.status).toBe("stopped");
    expect(expiredSweep[0]?.diagnosticCode).toBe("stopped_idle");

    // RAM freed and process stopped
    expect(resourceManager.getMetricsSnapshot().activeProcessCount).toBe(0);

    await browserRuntime.stop();
  });
});
