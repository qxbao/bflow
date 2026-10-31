import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MCPServiceDefinition, ScopedOperation, TrustScope } from "@bflow/contracts";
import {
  BackendResourceManager,
  BflowOSServiceManager,
  DedicatedBrowserRuntime,
  SafeOSCommandRunner,
  defaultIsPidAlive,
  ok,
  resolveDedicatedProfileDir,
  type ManagedBackendDriver,
  type ManagedBackendDriverFactory,
  type OSCommandResult,
  type OSCommandRunner,
  type OSServiceConfig
} from "../src/index.js";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
const spawnedPids: number[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => undefined);
  }
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ignore
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const MACHINE_SCOPE: TrustScope = { kind: "machine", machineId: "mach-r2-s3" };

function makeOp(scope: TrustScope = MACHINE_SCOPE): ScopedOperation {
  return {
    schemaVersion: 3,
    scope,
    idempotencyKey: `op-${randomUUID()}`
  };
}

function makeServiceDef(
  serviceId: string,
  overrides?: {
    readonly ownership?: "bflow" | "external";
    readonly sharing?: "concurrent" | "exclusive";
    readonly idleTimeoutMs?: number;
  }
): MCPServiceDefinition {
  const ownership = overrides?.ownership ?? "bflow";
  const sharing = overrides?.sharing ?? "concurrent";
  return {
    schemaVersion: 3,
    serviceId,
    revision: 1,
    scope: MACHINE_SCOPE,
    tool: {
      schemaVersion: 3,
      toolId: serviceId,
      kind: ownership === "external" ? "native_remote_mcp" : "stdio_mcp",
      version: "1.0.0",
      operations: ["check"],
      resource:
        sharing === "exclusive"
          ? { sharing: "exclusive", resourceKey: serviceId }
          : { sharing: "concurrent", maxConcurrency: 4 },
      required: false
    },
    connection:
      ownership === "external"
        ? {
            kind: "native_remote_mcp",
            endpoint: "http://127.0.0.1:44110/mcp",
            ownership: "external"
          }
        : {
            kind: "stdio_mcp",
            executable: process.execPath,
            executableDigest: "b".repeat(64),
            argv: [],
            environmentBindings: {},
            ownership: "bflow",
            bridgeRequired: true
          },
    authentication: { mode: "none" },
    healthTimeoutMs: 5_000,
    idleTimeoutMs: overrides?.idleTimeoutMs ?? 1_000,
    restartLimit: 3
  };
}

describe("Round 2 Slice 03 — MCP Services Adversarial Hardening", () => {
  it("R2-S1: BackendResourceManager evicts dead/expired exclusive client leases, resets activeCallCount on driver crash, and never stops external adopted workers", async () => {
    let nowMs = 1_700_000_000_000;
    const aliveClients = new Set<string>();
    const crashTriggers = new Map<string, (reason: string) => void>();
    const stoppedInstances: string[] = [];

    const factory: ManagedBackendDriverFactory = {
      async createDriver(definition, _partitionKey, generation) {
        let alive = true;
        const listeners = new Set<(reason: string) => void>();
        const instanceId = `${definition.serviceId}-g${generation}`;
        crashTriggers.set(definition.serviceId, (reason) => {
          alive = false;
          for (const l of listeners) l(reason);
        });
        const driver: ManagedBackendDriver = {
          instanceId,
          startGeneration: generation,
          ownership: definition.connection.ownership,
          isAlive: () => alive,
          async initialize() {
            return ok({ protocolVersion: "2025-11-25", discoveredTools: ["check"] });
          },
          async stop() {
            alive = false;
            stoppedInstances.push(instanceId);
          },
          onCrash(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          }
        };
        return ok(driver);
      }
    };

    const manager = new BackendResourceManager({
      driverFactory: factory,
      now: () => new Date(nowMs),
      isClientAlive: (clientId: string) => aliveClients.has(clientId)
    } as any);

    const browserDef = makeServiceDef("chrome-devtools", {
      sharing: "exclusive",
      idleTimeoutMs: 1_000
    });
    manager.registerBackend(browserDef, {
      maxConcurrentClients: 1,
      clientLeaseTtlMs: 5_000
    } as any);

    // 1. Live client holds exclusive slot; second live client is rejected with conflict
    aliveClients.add("dev-1");
    aliveClients.add("dev-2");
    const attach1 = await manager.attachClient("chrome-devtools", "dev-1", makeOp());
    expect(attach1.ok).toBe(true);

    const attachBlocked = await manager.attachClient("chrome-devtools", "dev-2", makeOp());
    expect(attachBlocked.ok).toBe(false);
    if (!attachBlocked.ok) {
      expect(attachBlocked.error.code).toBe("conflict");
    }

    // 2. Holder dev-1 crashes without calling detachClient -> dev-2 must acquire cleanly
    aliveClients.delete("dev-1");
    const attachAfterCrash = await manager.attachClient("chrome-devtools", "dev-2", makeOp());
    expect(attachAfterCrash.ok).toBe(true);

    // 3. Holder dev-2 remains alive in PID table, but its client lease expires without detachClient -> qa-1 must acquire
    aliveClients.add("qa-1");
    nowMs += 6_000;
    const attachAfterExpiry = await manager.attachClient("chrome-devtools", "qa-1", makeOp());
    expect(attachAfterExpiry.ok).toBe(true);

    await manager.detachClient("chrome-devtools", "qa-1", makeOp());

    // 4. Driver crashes mid-call while activeCallCount > 0 -> activeCallCount must reset so restarted idle backend sweeps cleanly
    expect(manager.beginCall("chrome-devtools", MACHINE_SCOPE).ok).toBe(true);
    crashTriggers.get("chrome-devtools")?.("segfault");

    const pk = manager.computePartitionKey(browserDef, MACHINE_SCOPE);
    expect(manager.getMetricsSnapshot().partitions[pk]?.activeCallCount).toBe(0);

    // Restart backend, advance past idleTimeoutMs, and verify sweepIdleBackends stops it rather than leaking retained_active_calls
    const restarted = await manager.ensure(browserDef, makeOp());
    expect(restarted.ok).toBe(true);
    nowMs += 2_000;
    const swept = await manager.sweepIdleBackends(new Date(nowMs));
    expect(swept.find((o) => o.serviceId === "chrome-devtools")?.diagnosticCode).toBe("stopped_idle");

    // 5. Invariant: external adopted workers are NEVER stopped on idle sweep or forceImmediateStop release
    const externalDef = makeServiceDef("adopted-gitnexus", {
      ownership: "external",
      idleTimeoutMs: 500
    });
    manager.registerBackend(externalDef);
    expect((await manager.ensure(externalDef, makeOp())).ok).toBe(true);
    nowMs += 2_000;
    const extSweep = await manager.sweepIdleBackends(new Date(nowMs));
    expect(extSweep.find((o) => o.serviceId === "adopted-gitnexus")?.diagnosticCode).toBe("external_retained");
    const extRelease = await manager.release("adopted-gitnexus", makeOp(), { forceImmediateStop: true });
    expect(extRelease.ok).toBe(true);
    if (extRelease.ok) {
      expect(extRelease.value.diagnosticCode).toBe("external_retained");
    }
    expect(stoppedInstances.some((id) => id.startsWith("adopted-gitnexus"))).toBe(false);
  });

  it("R2-S2: DedicatedBrowserRuntime skips occupied loopback ports, retries startup CDP readiness probe, and DefaultBrowserLauncher reaps detached helper children on stop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bflow-r2-browser-"));
    tempDirs.push(dir);
    const homeDir = join(dir, "home");
    const profilesRoot = join(dir, "profiles");
    const repoRoot = join(dir, "repo");
    await mkdir(repoRoot, { recursive: true });

    // Occupy a loopback TCP port to simulate an existing local DevTools/Chrome listener
    const blocker = net.createServer();
    const blockerSockets = new Set<net.Socket>();
    blocker.on("connection", (sock) => {
      blockerSockets.add(sock);
      sock.on("close", () => blockerSockets.delete(sock));
    });
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const sock of blockerSockets) sock.destroy();
          blocker.close(() => resolve());
        })
    );
    const occupiedPort = (blocker.address() as net.AddressInfo).port;

    // Create an executable fake Chrome binary that:
    //  1) spawns a child helper process in the same detached process group and records helperPid
    //  2) waits 90ms before binding its /json/version CDP HTTP server on --remote-debugging-port
    const fakeChrome = join(dir, "fake-chrome.mjs");
    const fakeChromeSource = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const portArg = process.argv.find((a) => a.startsWith("--remote-debugging-port="));
const dirArg = process.argv.find((a) => a.startsWith("--user-data-dir="));
const port = Number(portArg.split("=")[1]);
const profileDir = dirArg.split("=")[1];

const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
fs.writeFileSync(path.join(profileDir, "helper-pid.json"), JSON.stringify({ helperPid: helper.pid, mainPid: process.pid }));

setTimeout(() => {
  const srv = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/130.0.0.0" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  srv.listen(port, "127.0.0.1");
}, 90);

setTimeout(() => process.exit(0), 5000);
`;
    await writeFile(fakeChrome, fakeChromeSource, "utf8");
    await chmod(fakeChrome, 0o755);

    const scope: TrustScope = {
      kind: "repository",
      machineId: "m-r2",
      repositoryId: "repo-r2",
      workspaceRoot: repoRoot
    };

    const runtime = new DedicatedBrowserRuntime({
      homeDir,
      browserProfilesRoot: profilesRoot,
      repositoryRoots: [repoRoot],
      executablePath: fakeChrome,
      debuggingPort: occupiedPort,
      startupProbeTimeoutMs: 1_500
    } as any);
    cleanups.push(() => runtime.stop());

    const pageRes = await runtime.openPage(
      { registrationId: "reg-1", runId: "run-1", taskId: "task-1", scope },
      "http://127.0.0.1:8080"
    );
    expect(pageRes.ok).toBe(true);

    const healthRes = await runtime.healthCheck(scope);
    expect(healthRes.ok).toBe(true);
    if (!healthRes.ok) return;
    expect(healthRes.value.status).toBe("healthy");
    expect(healthRes.value.debuggingEndpoint).not.toBe(`http://127.0.0.1:${occupiedPort}`);

    const profileDir = resolveDedicatedProfileDir(profilesRoot, scope);
    const pidInfo = JSON.parse(await readFile(join(profileDir, "helper-pid.json"), "utf8")) as {
      helperPid: number;
      mainPid: number;
    };
    spawnedPids.push(pidInfo.mainPid, pidInfo.helperPid);

    expect(defaultIsPidAlive(pidInfo.mainPid)).toBe(true);
    expect(defaultIsPidAlive(pidInfo.helperPid)).toBe(true);

    await runtime.stop();

    expect(defaultIsPidAlive(pidInfo.mainPid)).toBe(false);
    expect(defaultIsPidAlive(pidInfo.helperPid)).toBe(false);
  });

  it("R2-S3: SafeOSCommandRunner enforces default timeout & synthesizes headless Linux XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS, and BflowOSServiceManager surfaces bus/timeout diagnostics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bflow-r2-os-"));
    tempDirs.push(dir);

    // 1. SafeOSCommandRunner enforces defaultTimeoutMs even when caller omits options.timeoutMs
    const timedRunner = new SafeOSCommandRunner({ defaultTimeoutMs: 80 } as any);
    const t0 = Date.now();
    const hungRes = await timedRunner.run([process.execPath, "-e", "setTimeout(() => {}, 1500)"]);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(700);
    expect(hungRes.timedOut).toBe(true);
    expect(hungRes.exitCode).toBe(124);

    // 2. Headless Linux systemd --user env synthesis when XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS are missing
    const fakeRunRoot = join(dir, "run-user");
    const fakeUserRuntimeDir = join(fakeRunRoot, "4242");
    await mkdir(fakeUserRuntimeDir, { recursive: true });
    await writeFile(join(fakeUserRuntimeDir, "bus"), "", "utf8");

    const linuxRunner = new SafeOSCommandRunner({
      platform: "linux",
      uid: 4242,
      userRuntimeRootDir: fakeRunRoot,
      baseEnv: { PATH: process.env.PATH ?? "" }
    } as any);

    const envRes = await linuxRunner.run([
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify({ xdg: process.env.XDG_RUNTIME_DIR ?? null, dbus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null }))",
      "--",
      "--user"
    ]);
    expect(envRes.exitCode).toBe(0);
    expect(JSON.parse(envRes.stdout)).toEqual({
      xdg: fakeUserRuntimeDir,
      dbus: `unix:path=${join(fakeUserRuntimeDir, "bus")}`
    });

    // 3. BflowOSServiceManager.status() surfaces systemd_user_bus_unavailable and service_command_timeout
    const homeDir = join(dir, "home");
    let mode: "bus_error" | "timeout" = "bus_error";
    const stubRunner: OSCommandRunner = {
      async run(): Promise<OSCommandResult> {
        if (mode === "timeout") {
          return { exitCode: 124, stdout: "", stderr: "", timedOut: true };
        }
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Failed to connect to bus: No medium found\n"
        };
      }
    };

    const svcMgr = new BflowOSServiceManager({
      platform: "linux",
      homeDir,
      uid: 4242,
      env: {},
      runner: stubRunner
    });

    const cfg: OSServiceConfig = {
      schemaVersion: 3,
      serviceId: "gateway",
      description: "Bflow MCP Gateway",
      program: process.execPath,
      args: ["--version"],
      env: {},
      healthTimeoutMs: 5_000,
      keepAliveOnCrash: true,
      enableOnLogin: true,
      restartSec: 2,
      maxRestartBurst: 5
    };
    const installRes = await svcMgr.install(cfg);
    expect(installRes.ok).toBe(true);
    if (installRes.ok) {
      expect(installRes.value.diagnosticCode).toBe("systemd_user_bus_unavailable");
      expect(installRes.value.diagnostics.join(" ")).toMatch(/XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|bus/i);
    }

    mode = "timeout";
    const timeoutStatus = await svcMgr.status("gateway");
    expect(timeoutStatus.ok).toBe(true);
    if (timeoutStatus.ok) {
      expect(timeoutStatus.value.diagnosticCode).toBe("service_command_timeout");
    }
  });
});
