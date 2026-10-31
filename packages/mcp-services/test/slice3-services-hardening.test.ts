import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MCPServiceDefinition, ScopedOperation, TrustScope } from "@bflow/contracts";
import {
  BackendResourceManager,
  DedicatedBrowserRuntime,
  DefaultBrowserLauncher,
  SafeOSCommandRunner,
  err,
  ok,
  writeFileAtomic,
  type BrowserLauncher,
  type BrowserProcessHandle,
  type ManagedBackendDriver,
  type ManagedBackendDriverFactory,
  type OperationResult
} from "../src/index.js";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const MACHINE_SCOPE: TrustScope = { kind: "machine", machineId: "mach-s3" };

function makeServiceDef(serviceId: string): MCPServiceDefinition {
  return {
    schemaVersion: 3,
    serviceId,
    revision: 1,
    scope: MACHINE_SCOPE,
    tool: {
      schemaVersion: 3,
      toolId: serviceId,
      kind: "stdio_mcp",
      version: "1.0.0",
      operations: ["ping"],
      resource: { sharing: "concurrent", maxConcurrency: 4 },
      required: false
    },
    connection: {
      kind: "stdio_mcp",
      executable: process.execPath,
      executableDigest: "a".repeat(64),
      argv: [],
      environmentBindings: {},
      ownership: "bflow",
      bridgeRequired: true
    },
    authentication: { mode: "none" },
    healthTimeoutMs: 5_000,
    idleTimeoutMs: 10_000,
    restartLimit: 3
  };
}

function makeOp(scope: TrustScope = MACHINE_SCOPE): ScopedOperation {
  return {
    schemaVersion: 3,
    scope,
    idempotencyKey: `op-${randomUUID()}`
  };
}

describe("Slice 3 MCP Services hardening regressions", () => {
  it("S1: BackendResourceManager coalesces concurrent ensure()/attachClient() calls under process-limit eviction pressure without leaking duplicate drivers", async () => {
    const createdByService = new Map<string, ManagedBackendDriver[]>();
    const factory: ManagedBackendDriverFactory = {
      async createDriver(definition, _partitionKey, startGeneration) {
        let alive = true;
        const driver: ManagedBackendDriver = {
          instanceId: `${definition.serviceId}-gen-${startGeneration}-${randomUUID().slice(0, 6)}`,
          startGeneration,
          ownership: definition.connection.ownership,
          isAlive: () => alive,
          onCrash: () => () => {},
          async initialize() {
            await new Promise((r) => setTimeout(r, 25));
            return ok({ protocolVersion: "2025-11-25", discoveredTools: ["ping"] });
          },
          async stop() {
            // Async stop delay triggers the pre-starting await window during evictIdleBackendsUnderPressure()
            await new Promise((r) => setTimeout(r, 30));
            alive = false;
          }
        };
        const list = createdByService.get(definition.serviceId) ?? [];
        list.push(driver);
        createdByService.set(definition.serviceId, list);
        return ok(driver);
      }
    };

    const manager = new BackendResourceManager(factory, { maxProcessCount: 1 });
    const idleSvc = makeServiceDef("svc-idle");
    const targetSvc = makeServiceDef("svc-target");
    manager.registerBackend(idleSvc);
    manager.registerBackend(targetSvc);

    // Start svc-idle and detach so it occupies the single process slot while idle
    await manager.attachClient("svc-idle", "c-idle", makeOp());
    await manager.detachClient("svc-idle", "c-idle", makeOp());
    expect(manager.getMetricsSnapshot().activeProcessCount).toBe(1);

    // Two concurrent clients attach to unstarted svc-target while maxProcessCount === 1 forces async eviction
    const [attach1, attach2] = await Promise.all([
      manager.attachClient("svc-target", "c1", makeOp()),
      manager.attachClient("svc-target", "c2", makeOp())
    ]);
    expect(attach1.ok).toBe(true);
    expect(attach2.ok).toBe(true);

    const targetDrivers = createdByService.get("svc-target") ?? [];
    expect(targetDrivers).toHaveLength(1);
    expect(manager.getMetricsSnapshot().activeProcessCount).toBe(1);
  });

  it("S2: SafeOSCommandRunner guards >32-bit timeoutMs overflow & background grandchild pipe hangs, and writeFileAtomic survives concurrent same-ms writes", async () => {
    const runner = new SafeOSCommandRunner();

    // 1. > 2_147_483_647 ms timeout must not overflow signed 32-bit int into 1ms timeout kill
    const largeTimeoutRes = await runner.run(
      [process.execPath, "-e", "setTimeout(() => process.stdout.write('ok'), 20)"],
      { timeoutMs: 3_000_000_000 }
    );
    expect(largeTimeoutRes.timedOut).toBe(false);
    expect(largeTimeoutRes.exitCode).toBe(0);
    expect(largeTimeoutRes.stdout).toBe("ok");

    // 2. Background grandchild inheriting stdout/stderr must not hang SafeOSCommandRunner after parent exits
    const script = [
      "const { spawn } = require('node:child_process');",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { detached: true, stdio: 'inherit' });",
      "gc.unref();",
      "process.stdout.write(JSON.stringify({ gcPid: gc.pid }));",
      "process.exit(0);"
    ].join(" ");
    const t0 = Date.now();
    const gcRes = await runner.run([process.execPath, "-e", script], { timeoutMs: 2_000 });
    const elapsed = Date.now() - t0;
    let gcPid: number | undefined;
    try {
      gcPid = (JSON.parse(gcRes.stdout) as { gcPid?: number }).gcPid;
    } finally {
      if (gcPid) {
        try {
          process.kill(gcPid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
    expect(gcRes.timedOut).toBe(false);
    expect(gcRes.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(600);

    // 3. writeFileAtomic concurrent writes to identical file path
    const dir = await mkdtemp(join(tmpdir(), "bflow-atomic-s3-"));
    tempDirs.push(dir);
    const targetFile = join(dir, "unit.service");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => writeFileAtomic(targetFile, `unit-content-${i}`))
    );
    const finalContent = await readFile(targetFile, "utf8");
    expect(finalContent).toMatch(/^unit-content-\d+$/);
  });

  it("S3: DedicatedBrowserRuntime coalesces concurrent openPage() launches on the same scope, and DefaultBrowserLauncher handles broken-shebang async spawn errors without crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bflow-browser-s3-"));
    tempDirs.push(dir);
    const homeDir = join(dir, "home");
    const profilesRoot = join(dir, "profiles");
    const repoRoot = join(dir, "repo");

    let launchCalls = 0;
    const handles: BrowserProcessHandle[] = [];
    const slowLauncher: BrowserLauncher = {
      async probeBinary() {
        return ok({ version: "Chrome 130" });
      },
      async launch(opts): Promise<OperationResult<BrowserProcessHandle>> {
        launchCalls++;
        await new Promise((r) => setTimeout(r, 35));
        let alive = true;
        const handle: BrowserProcessHandle = {
          pid: 40_000 + launchCalls,
          debuggingHost: opts.debuggingHost,
          debuggingPort: opts.debuggingPort,
          supportsBrowserContexts: true,
          isAlive: () => alive,
          getMemoryRssBytes: async () => 32 * 1024 * 1024,
          probeDebuggingEndpoint: async () => true,
          createBrowserContext: async () => `ctx-${randomUUID()}`,
          disposeBrowserContext: async () => {},
          stop: async () => {
            alive = false;
          },
          onCrash: () => () => {}
        };
        handles.push(handle);
        return ok(handle);
      }
    };

    const scope: TrustScope = {
      kind: "repository",
      machineId: "m-1",
      repositoryId: "r-1",
      workspaceRoot: repoRoot
    };
    const runtime = new DedicatedBrowserRuntime({
      homeDir,
      browserProfilesRoot: profilesRoot,
      repositoryRoots: [repoRoot],
      launcher: slowLauncher,
      isolationMode: "browser_context"
    });
    cleanups.push(() => runtime.stop());

    const [page1, page2] = await Promise.all([
      runtime.openPage(
        { registrationId: "reg-1", runId: "run-1", taskId: "task-1", scope },
        "http://127.0.0.1:8080/one"
      ),
      runtime.openPage(
        { registrationId: "reg-2", runId: "run-1", taskId: "task-2", scope },
        "http://127.0.0.1:8080/two"
      )
    ]);
    expect(page1.ok).toBe(true);
    expect(page2.ok).toBe(true);
    expect(launchCalls).toBe(1);
    expect(handles.filter((h) => h.isAlive())).toHaveLength(1);

    // DefaultBrowserLauncher with an executable script whose shebang interpreter does not exist:
    // probeBinary(X_OK) passes, spawn() fails with async 'error' event (ENOENT) and pid === undefined.
    const brokenScript = join(dir, "broken-chrome.sh");
    await writeFile(brokenScript, "#!/nonexistent/bflow-missing-interpreter\nexit 0\n", "utf8");
    await chmod(brokenScript, 0o755);

    const realLauncher = new DefaultBrowserLauncher();
    const launchRes = await realLauncher.launch({
      executablePath: brokenScript,
      profileDir: join(profilesRoot, "broken"),
      debuggingHost: "127.0.0.1",
      debuggingPort: 19222,
      headless: true,
      extraArgs: []
    });
    // Wait one tick to ensure any async 'error' event on ChildProcess does not become uncaughtException
    await new Promise((r) => setTimeout(r, 20));
    expect(launchRes.ok).toBe(false);
    if (!launchRes.ok) {
      expect(launchRes.error.code).toBe("transport_unavailable");
    }
  });
});
