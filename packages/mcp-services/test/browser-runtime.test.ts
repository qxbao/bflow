import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BrowserCallerIdentity,
  type BrowserLauncher,
  type BrowserProcessHandle,
  type BrowserProfileLockMetadata,
  err,
  ok,
  type OperationResult,
  type TrustScope
} from "../src/types.js";
import {
  getPersonalChromeProfilePaths,
  resolveBflowOSPaths,
  resolveDedicatedProfileDir,
  validateBrowserProfileDirectory,
  validateLoopbackDebuggingHost
} from "../src/os-paths.js";
import {
  DedicatedBrowserRuntime,
  defaultIsPidAlive,
  isSameScope,
  scopeToKey
} from "../src/browser-runtime.js";

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
    this.pid = options?.pid ?? Math.floor(10000 + Math.random() * 50000);
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
    return `mock-ctx-${randomUUID().slice(0, 8)}`;
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
  supportsBrowserContexts = true;
  handleSupportsBrowserContexts?: boolean;
  binaryExists = true;
  endpointAccessibleOnLaunch = true;
  handles: MockBrowserProcessHandle[] = [];
  nextPid = 20000;

  constructor(options?: {
    supportsBrowserContexts?: boolean;
    handleSupportsBrowserContexts?: boolean;
  }) {
    if (options?.supportsBrowserContexts !== undefined) {
      this.supportsBrowserContexts = options.supportsBrowserContexts;
    }
    if (options?.handleSupportsBrowserContexts !== undefined) {
      this.handleSupportsBrowserContexts = options.handleSupportsBrowserContexts;
    }
  }

  async probeBinary(executablePath: string): Promise<OperationResult<{ version: string }>> {
    if (!this.binaryExists) {
      return err({
        code: "not_found",
        retryable: false,
        message: "Chrome binary is missing or not executable",
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
  }): Promise<OperationResult<BrowserProcessHandle>> {
    const probe = await this.probeBinary(options.executablePath);
    if (!probe.ok) return err(probe.error);

    const handle = new MockBrowserProcessHandle({
      pid: this.nextPid++,
      debuggingHost: options.debuggingHost,
      debuggingPort: options.debuggingPort,
      supportsBrowserContexts: this.handleSupportsBrowserContexts ?? this.supportsBrowserContexts,
      endpointAccessible: this.endpointAccessibleOnLaunch
    });
    this.handles.push(handle);
    return ok(handle);
  }
}

describe("DedicatedBrowserRuntime", () => {
  let tmpDir: string;
  let homeDir: string;
  let browserProfilesRoot: string;
  let repoRoot: string;
  let testScope: TrustScope;
  let mockLauncher: MockBrowserLauncher;
  let activeRuntimes: DedicatedBrowserRuntime[] = [];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bflow-browser-test-"));
    homeDir = path.join(tmpDir, "home");
    browserProfilesRoot = path.join(tmpDir, "browser-profiles");
    repoRoot = path.join(tmpDir, "repo");

    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(browserProfilesRoot, { recursive: true });
    await fs.mkdir(repoRoot, { recursive: true });

    testScope = {
      kind: "repository",
      machineId: "mach-1",
      repositoryId: "repo-1",
      workspaceRoot: repoRoot
    };

    mockLauncher = new MockBrowserLauncher();
    activeRuntimes = [];
  });

  afterEach(async () => {
    for (const r of activeRuntimes) {
      try {
        await r.stop();
      } catch {
        // ignore
      }
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createRuntime(options?: Partial<ConstructorParameters<typeof DedicatedBrowserRuntime>[0]>): DedicatedBrowserRuntime {
    const runtime = new DedicatedBrowserRuntime({
      homeDir,
      browserProfilesRoot,
      repositoryRoots: [repoRoot],
      launcher: mockLauncher,
      executablePath: "/usr/bin/google-chrome",
      ...options
    });
    activeRuntimes.push(runtime);
    return runtime;
  }

  function createCaller(runId = "run-1", taskId = "task-1", regId = "reg-1", scope = testScope): BrowserCallerIdentity {
    return {
      registrationId: regId,
      runId,
      taskId,
      scope
    };
  }

  describe("Requirement 1: OS-Standard Data Directory & Profile Protection", () => {
    it("resolves standard OS user-level paths on Linux, macOS, and Windows", () => {
      const linuxPaths = resolveBflowOSPaths({
        platform: "linux",
        homeDir: "/home/testuser",
        env: { HOME: "/home/testuser" }
      });
      expect(linuxPaths.browserProfilesRoot).toBe("/home/testuser/.local/share/bflow/browser-profiles");

      const darwinPaths = resolveBflowOSPaths({
        platform: "darwin",
        homeDir: "/Users/testuser",
        env: { HOME: "/Users/testuser" }
      });
      expect(darwinPaths.browserProfilesRoot).toBe("/Users/testuser/Library/Application Support/bflow/browser-profiles");

      const winPaths = resolveBflowOSPaths({
        platform: "win32",
        homeDir: "C:\\Users\\testuser",
        env: {
          USERPROFILE: "C:\\Users\\testuser",
          LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
          APPDATA: "C:\\Users\\testuser\\AppData\\Roaming"
        }
      });
      expect(winPaths.platform).toBe("win32");
      expect(winPaths.browserProfilesRoot).toMatch(/bflow[\\/]browser-profiles$/);
    });

    it("rejects browser profile directory placed inside any git repository (repository_profile_forbidden)", async () => {
      const forbiddenDir = path.join(repoRoot, ".chrome-profile");
      const val = validateBrowserProfileDirectory({
        targetProfileDir: forbiddenDir,
        homeDir,
        repositoryRoots: [repoRoot]
      });

      expect(val.ok).toBe(false);
      if (!val.ok) {
        expect(val.error.code).toBe("validation");
        expect(val.error.details).toMatchObject({
          diagnosticCode: "repository_profile_forbidden"
        });
      }
    });

    it("rejects browser profile directory conflicting with personal Chrome profile (personal_profile_forbidden)", async () => {
      const personalPaths = getPersonalChromeProfilePaths(homeDir);
      expect(personalPaths.length).toBeGreaterThan(0);

      const conflictDir = path.join(homeDir, ".config", "google-chrome");
      const val = validateBrowserProfileDirectory({
        targetProfileDir: conflictDir,
        homeDir,
        repositoryRoots: [repoRoot]
      });

      expect(val.ok).toBe(false);
      if (!val.ok) {
        expect(val.error.code).toBe("validation");
        expect(val.error.details).toMatchObject({
          diagnosticCode: "personal_profile_forbidden"
        });
      }
    });

    it("creates dedicated profile directory with mode 0o700", async () => {
      const runtime = createRuntime();
      const caller = createCaller();
      const pageRes = await runtime.openPage(caller);

      expect(pageRes.ok).toBe(true);
      const expectedDir = resolveDedicatedProfileDir(browserProfilesRoot, testScope);
      const stat = await fs.stat(expectedDir);
      expect(stat.isDirectory()).toBe(true);
      // In POSIX systems, verify permission bits (0o700)
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o700);
      }
    });
  });

  describe("Requirement 2: Loopback-Only Debugging Endpoint", () => {
    it("allows loopback hosts 127.0.0.1, localhost, and [::1]", () => {
      expect(validateLoopbackDebuggingHost("127.0.0.1")).toMatchObject({ ok: true, value: "127.0.0.1" });
      expect(validateLoopbackDebuggingHost("localhost")).toMatchObject({ ok: true, value: "localhost" });
      expect(validateLoopbackDebuggingHost("[::1]")).toMatchObject({ ok: true, value: "[::1]" });
      expect(validateLoopbackDebuggingHost("::1")).toMatchObject({ ok: true, value: "[::1]" });
    });

    it("rejects non-loopback hosts with non_loopback_forbidden", async () => {
      const hostRes = validateLoopbackDebuggingHost("0.0.0.0");
      expect(hostRes.ok).toBe(false);
      if (!hostRes.ok) {
        expect(hostRes.error.code).toBe("validation");
        expect(hostRes.error.details).toMatchObject({ diagnosticCode: "non_loopback_forbidden" });
      }

      const lanRes = validateLoopbackDebuggingHost("192.168.1.100");
      expect(lanRes.ok).toBe(false);
      if (!lanRes.ok) {
        expect(lanRes.error.code).toBe("validation");
        expect(lanRes.error.details).toMatchObject({ diagnosticCode: "non_loopback_forbidden" });
      }

      const runtime = createRuntime({ debuggingHost: "0.0.0.0" });
      const openRes = await runtime.openPage(createCaller());
      expect(openRes.ok).toBe(false);
      if (!openRes.ok) {
        expect(openRes.error.code).toBe("validation");
        expect(openRes.error.details).toMatchObject({ diagnosticCode: "non_loopback_forbidden" });
      }
    });
  });

  describe("Requirement 3: Browser Profile Lock (SingletonLock & .bflow-profile.lock)", () => {
    it("rejects startup with profile_locked when Chrome native SingletonLock exists", async () => {
      const profileDir = resolveDedicatedProfileDir(browserProfilesRoot, testScope);
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(profileDir, "SingletonLock"), "mock-lock");

      const runtime = createRuntime();
      const openRes = await runtime.openPage(createCaller());

      expect(openRes.ok).toBe(false);
      if (!openRes.ok) {
        expect(openRes.error.code).toBe("conflict");
        expect(openRes.error.retryable).toBe(true);
        expect(openRes.error.details).toMatchObject({
          diagnosticCode: "profile_locked",
          profileDir
        });
      }
    });

    it("rejects startup with profile_locked when .bflow-profile.lock belongs to an active process", async () => {
      const profileDir = resolveDedicatedProfileDir(browserProfilesRoot, testScope);
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });

      const activeLock: BrowserProfileLockMetadata = {
        schemaVersion: 3,
        instanceId: "inst-active",
        pid: 12345,
        scopeKey: scopeToKey(testScope),
        profileDir,
        debuggingHost: "127.0.0.1",
        debuggingPort: 9222,
        acquiredAt: new Date().toISOString()
      };
      await fs.writeFile(path.join(profileDir, ".bflow-profile.lock"), JSON.stringify(activeLock), { mode: 0o600 });

      const runtime = createRuntime({
        isPidAlive: (pid) => pid === 12345
      });
      const openRes = await runtime.openPage(createCaller());

      expect(openRes.ok).toBe(false);
      if (!openRes.ok) {
        expect(openRes.error.code).toBe("conflict");
        expect(openRes.error.details).toMatchObject({
          diagnosticCode: "profile_locked"
        });
      }
    });

    it("safely cleans up stale .bflow-profile.lock belonging to a dead PID and starts successfully", async () => {
      const profileDir = resolveDedicatedProfileDir(browserProfilesRoot, testScope);
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });

      const staleLock: BrowserProfileLockMetadata = {
        schemaVersion: 3,
        instanceId: "inst-stale",
        pid: 99999,
        scopeKey: scopeToKey(testScope),
        profileDir,
        debuggingHost: "127.0.0.1",
        debuggingPort: 9222,
        acquiredAt: new Date().toISOString()
      };
      await fs.writeFile(path.join(profileDir, ".bflow-profile.lock"), JSON.stringify(staleLock), { mode: 0o600 });
      await fs.writeFile(path.join(profileDir, "SingletonLock"), "stale-native-lock");

      const runtime = createRuntime({
        isPidAlive: (pid) => pid !== 99999
      });
      const openRes = await runtime.openPage(createCaller());

      expect(openRes.ok).toBe(true);

      // Verify the old dead lock was replaced with the fresh active PID
      const lockContent = await fs.readFile(path.join(profileDir, ".bflow-profile.lock"), "utf8");
      const newLock = JSON.parse(lockContent);
      expect(newLock.pid).not.toBe(99999);
    });

    it("writes .bflow-profile.lock with mode 0o600 and removes it on clean stop", async () => {
      const runtime = createRuntime();
      const openRes = await runtime.openPage(createCaller());
      expect(openRes.ok).toBe(true);

      const profileDir = resolveDedicatedProfileDir(browserProfilesRoot, testScope);
      const lockPath = path.join(profileDir, ".bflow-profile.lock");

      const stat = await fs.stat(lockPath);
      expect(stat.isFile()).toBe(true);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o600);
      }

      await runtime.stop();

      await expect(fs.access(lockPath)).rejects.toThrow();
    });
  });

  describe("Requirement 4: Chrome Binary Missing Probe", () => {
    it("returns chrome_binary_missing when binary probe fails and leaves no stale lock", async () => {
      mockLauncher.binaryExists = false;
      const runtime = createRuntime();
      const openRes = await runtime.openPage(createCaller());

      expect(openRes.ok).toBe(false);
      if (!openRes.ok) {
        expect(openRes.error.code).toBe("not_found");
        expect(openRes.error.retryable).toBe(false);
        expect(openRes.error.details).toMatchObject({
          diagnosticCode: "chrome_binary_missing"
        });
      }

      const profileDir = resolveDedicatedProfileDir(browserProfilesRoot, testScope);
      const lockPath = path.join(profileDir, ".bflow-profile.lock");
      await expect(fs.access(lockPath)).rejects.toThrow();
    });
  });

  describe("Requirement 5: Remote Debugging Endpoint Verification", () => {
    it("returns debugging_endpoint_inaccessible on launch when loopback probe fails", async () => {
      mockLauncher.endpointAccessibleOnLaunch = false;
      const runtime = createRuntime();
      const openRes = await runtime.openPage(createCaller());

      expect(openRes.ok).toBe(false);
      if (!openRes.ok) {
        expect(openRes.error.code).toBe("transport_unavailable");
        expect(openRes.error.retryable).toBe(true);
        expect(openRes.error.details).toMatchObject({
          diagnosticCode: "debugging_endpoint_inaccessible"
        });
      }

      const profileDir = resolveDedicatedProfileDir(browserProfilesRoot, testScope);
      const lockPath = path.join(profileDir, ".bflow-profile.lock");
      await expect(fs.access(lockPath)).rejects.toThrow();
    });

    it("returns unreachable and debugging_endpoint_inaccessible on mid-run health check failure", async () => {
      const runtime = createRuntime();
      const openRes = await runtime.openPage(createCaller());
      expect(openRes.ok).toBe(true);

      const handle = mockLauncher.handles[0]!;
      handle.endpointAccessible = false;

      const health = await runtime.healthCheck(testScope);
      expect(health.ok).toBe(true);
      if (health.ok) {
        expect(health.value.status).toBe("unreachable");
        expect(health.value.diagnosticCode).toBe("debugging_endpoint_inaccessible");
      }
    });
  });

  describe("Requirement 6: Browser Crash & Automatic Reconnect", () => {
    it("detects browser crash, cleans up dead PID lock, relaunches, and restores healthy status", async () => {
      const runtime = createRuntime();
      const caller = createCaller();
      const openRes = await runtime.openPage(caller, "https://example.com");
      expect(openRes.ok).toBe(true);

      const firstHandle = mockLauncher.handles[0]!;
      const firstPid = firstHandle.pid;

      // Simulate crash
      firstHandle.simulateCrash("SIGSEGV unexpected exit");

      // Verify healthCheck detects crash
      const healthBefore = await runtime.healthCheck(testScope);
      expect(healthBefore.ok).toBe(true);
      if (healthBefore.ok) {
        expect(healthBefore.value.status).toBe("crashed");
        expect(healthBefore.value.diagnosticCode).toBe("browser_crashed");
      }

      // Reconnect after crash
      const recRes = await runtime.reconnectAfterCrash(testScope);
      expect(recRes.ok).toBe(true);
      if (recRes.ok) {
        expect(recRes.value.status).toBe("healthy");
        expect(recRes.value.diagnosticCode).toBe("healthy");
        expect(recRes.value.pid).not.toBe(firstPid);
      }

      const metrics = runtime.getMetrics();
      expect(metrics.crashCount).toBe(1);
      expect(metrics.reconnectCount).toBe(1);

      // Verify existing page is still tracked and accessible
      const contentRes = await runtime.getPageContent(caller, openRes.value!.pageId);
      expect(contentRes.ok).toBe(true);
    });

    it("enforces maxReconnectAttempts and rejects reconnect when exceeded", async () => {
      const runtime = createRuntime({ maxReconnectAttempts: 2 });
      await runtime.openPage(createCaller());

      const handle = mockLauncher.handles[0]!;
      handle.simulateCrash();

      // First reconnect -> attempt 1
      const rec1 = await runtime.reconnectAfterCrash(testScope);
      expect(rec1.ok).toBe(true);

      mockLauncher.handles[1]!.simulateCrash();

      // Second reconnect -> attempt 2
      const rec2 = await runtime.reconnectAfterCrash(testScope);
      expect(rec2.ok).toBe(true);

      mockLauncher.handles[2]!.simulateCrash();

      // Third reconnect -> attempts (2) >= maxReconnectAttempts (2) -> rejected
      const rec3 = await runtime.reconnectAfterCrash(testScope);
      expect(rec3.ok).toBe(false);
      if (!rec3.ok) {
        expect(rec3.error.code).toBe("transport_unavailable");
        expect(rec3.error.details).toMatchObject({
          diagnosticCode: "max_reconnect_attempts_exceeded",
          maxReconnectAttempts: 2
        });
      }
    });
  });

  describe("Requirement 7: Shared Chrome Isolation, Page Ownership, & Cookie Privacy", () => {
    it("allocates distinct browserContextIds for separate agent sessions on shared Chrome", async () => {
      const runtime = createRuntime({ isolationMode: "browser_context" });
      const callerA = createCaller("run-1", "task-1", "agent-a");
      const callerB = createCaller("run-1", "task-2", "agent-b");

      const pageA = await runtime.openPage(callerA, "https://app-a.local");
      const pageB = await runtime.openPage(callerB, "https://app-b.local");

      expect(pageA.ok).toBe(true);
      expect(pageB.ok).toBe(true);

      // Same Chrome process instance
      expect(pageA.value!.instanceId).toBe(pageB.value!.instanceId);
      // Different isolated browser context IDs
      expect(pageA.value!.browserContextId).not.toBe(pageB.value!.browserContextId);
    });

    it("rejects cross-agent page navigation, content reading, and cookie access with page_ownership_conflict", async () => {
      const runtime = createRuntime();
      const callerA = createCaller("run-1", "task-1", "agent-a");
      const callerB = createCaller("run-1", "task-2", "agent-b");

      const pageA = await runtime.openPage(callerA, "https://app-a.local");
      expect(pageA.ok).toBe(true);
      const pageIdA = pageA.value!.pageId;

      await runtime.setPageContent(callerA, pageIdA, "<h1>Agent A Secret Content</h1>");
      await runtime.setCookies(callerA, pageIdA, { sessionToken: "secret-token-agent-a" });

      // Agent B attempting navigatePage on Agent A's page
      const navRes = await runtime.navigatePage(callerB, pageIdA, "https://evil.local");
      expect(navRes.ok).toBe(false);
      if (!navRes.ok) {
        expect(navRes.error.code).toBe("conflict");
        expect(navRes.error.details).toMatchObject({
          diagnosticCode: "page_ownership_conflict",
          pageId: pageIdA
        });
      }

      // Agent B attempting getPageContent on Agent A's page
      const contentRes = await runtime.getPageContent(callerB, pageIdA);
      expect(contentRes.ok).toBe(false);
      if (!contentRes.ok) {
        expect(contentRes.error.code).toBe("conflict");
        expect(contentRes.error.details).toMatchObject({
          diagnosticCode: "page_ownership_conflict"
        });
      }

      // Agent B attempting setPageContent on Agent A's page
      const setContentRes = await runtime.setPageContent(callerB, pageIdA, "tampered");
      expect(setContentRes.ok).toBe(false);
      if (!setContentRes.ok) {
        expect(setContentRes.error.code).toBe("conflict");
        expect(setContentRes.error.details).toMatchObject({
          diagnosticCode: "page_ownership_conflict"
        });
      }

      // Agent B attempting getCookies on Agent A's page
      const getCookiesRes = await runtime.getCookies(callerB, pageIdA);
      expect(getCookiesRes.ok).toBe(false);
      if (!getCookiesRes.ok) {
        expect(getCookiesRes.error.code).toBe("conflict");
        expect(getCookiesRes.error.details).toMatchObject({
          diagnosticCode: "page_ownership_conflict"
        });
      }

      // Agent B attempting closePage on Agent A's page
      const closeRes = await runtime.closePage(callerB, pageIdA);
      expect(closeRes.ok).toBe(false);
      if (!closeRes.ok) {
        expect(closeRes.error.code).toBe("conflict");
        expect(closeRes.error.details).toMatchObject({
          diagnosticCode: "page_ownership_conflict"
        });
      }

      const metrics = runtime.getMetrics();
      expect(metrics.ownershipConflicts).toBe(5);
    });

    it("never exposes Agent A's tabs in listPages for Agent B", async () => {
      const runtime = createRuntime();
      const callerA = createCaller("run-1", "task-1", "agent-a");
      const callerB = createCaller("run-1", "task-2", "agent-b");

      await runtime.openPage(callerA, "https://agent-a.internal/page1");
      await runtime.openPage(callerA, "https://agent-a.internal/page2");
      await runtime.openPage(callerB, "https://agent-b.internal/page1");

      const pagesA = await runtime.listPages(callerA);
      expect(pagesA.ok).toBe(true);
      expect(pagesA.value!.length).toBe(2);
      expect(pagesA.value!.every((p) => p.registrationId === "agent-a")).toBe(true);

      const pagesB = await runtime.listPages(callerB);
      expect(pagesB.ok).toBe(true);
      expect(pagesB.value!.length).toBe(1);
      expect(pagesB.value![0]!.registrationId).toBe("agent-b");
      expect(pagesB.value![0]!.url).toBe("https://agent-b.internal/page1");
    });

    it("completely isolates cookies across contexts: Agent B never sees Agent A's cookies", async () => {
      const runtime = createRuntime();
      const callerA = createCaller("run-1", "task-1", "agent-a");
      const callerB = createCaller("run-1", "task-2", "agent-b");

      const pageA = await runtime.openPage(callerA);
      const pageB = await runtime.openPage(callerB);

      await runtime.setCookies(callerA, pageA.value!.pageId, { auth: "bearer-token-a", user: "alice" });

      const cookiesA = await runtime.getCookies(callerA, pageA.value!.pageId);
      expect(cookiesA.ok).toBe(true);
      expect(cookiesA.value).toEqual({ auth: "bearer-token-a", user: "alice" });

      const cookiesB = await runtime.getCookies(callerB, pageB.value!.pageId);
      expect(cookiesB.ok).toBe(true);
      expect(cookiesB.value).toEqual({});
    });

    it("partitions into separate processes and profiles when supportsBrowserContexts is false", async () => {
      mockLauncher.supportsBrowserContexts = false;
      const runtime = createRuntime({ isolationMode: "browser_context" });

      const callerA = createCaller("run-1", "task-1", "agent-a");
      const callerB = createCaller("run-1", "task-2", "agent-b");

      const pageA = await runtime.openPage(callerA);
      const pageB = await runtime.openPage(callerB);

      expect(pageA.ok).toBe(true);
      expect(pageB.ok).toBe(true);

      // Separate instances
      expect(pageA.value!.instanceId).not.toBe(pageB.value!.instanceId);
      expect(mockLauncher.handles.length).toBe(2);

      // Different processes and debugging ports
      expect(mockLauncher.handles[0]!.pid).not.toBe(mockLauncher.handles[1]!.pid);
      expect(mockLauncher.handles[0]!.debuggingPort).not.toBe(mockLauncher.handles[1]!.debuggingPort);
    });

    it("partitions into separate processes when isolationMode is separate_process", async () => {
      const runtime = createRuntime({ isolationMode: "separate_process" });

      const callerA = createCaller("run-1", "task-1", "agent-a");
      const callerB = createCaller("run-1", "task-2", "agent-b");

      const pageA = await runtime.openPage(callerA);
      const pageB = await runtime.openPage(callerB);

      expect(pageA.ok).toBe(true);
      expect(pageB.ok).toBe(true);
      expect(pageA.value!.instanceId).not.toBe(pageB.value!.instanceId);
    });

    it("dynamically recovers when supportsBrowserContexts: false is only discovered at runtime from the handle", async () => {
      // Launcher claims supportsBrowserContexts = true, but launched handles return supportsBrowserContexts = false
      const dynamicMockLauncher = new MockBrowserLauncher({
        supportsBrowserContexts: true,
        handleSupportsBrowserContexts: false
      });
      const runtime = createRuntime({
        launcher: dynamicMockLauncher,
        isolationMode: "browser_context",
        supportsBrowserContexts: true
      });

      const callerA = createCaller("run-1", "task-1", "agent-a");
      const callerB = createCaller("run-1", "task-2", "agent-b");

      // Agent A (Task 1) opens page: initial shared launch discovers supportsBrowserContexts = false,
      // cleans up un-suffixed instance and relaunches with task partition
      const pageA = await runtime.openPage(callerA);
      expect(pageA.ok).toBe(true);

      // Agent B (Task 2) opens page on the same scope: must not hit profile_locked and gets separate instance
      const pageB = await runtime.openPage(callerB);
      expect(pageB.ok).toBe(true);

      expect(pageA.value!.instanceId).not.toBe(pageB.value!.instanceId);

      // Profile directories must be distinct per-task directories
      const profileDirA = resolveDedicatedProfileDir(browserProfilesRoot, testScope, "run-1-task-1");
      const profileDirB = resolveDedicatedProfileDir(browserProfilesRoot, testScope, "run-1-task-2");
      expect(profileDirA).not.toBe(profileDirB);
    });
  });

  describe("Requirement 8: Concurrency Limits and Task Completion Cleanup", () => {
    it("enforces maxPagesPerSession limit with page_limit_exceeded", async () => {
      const runtime = createRuntime({ maxPagesPerSession: 2 });
      const caller = createCaller();

      const p1 = await runtime.openPage(caller);
      expect(p1.ok).toBe(true);

      const p2 = await runtime.openPage(caller);
      expect(p2.ok).toBe(true);

      const p3 = await runtime.openPage(caller);
      expect(p3.ok).toBe(false);
      if (!p3.ok) {
        expect(p3.error.code).toBe("conflict");
        expect(p3.error.details).toMatchObject({
          diagnosticCode: "page_limit_exceeded"
        });
      }
    });

    it("enforces maxSessions limit with session_limit_exceeded", async () => {
      const runtime = createRuntime({ maxSessions: 2 });

      const s1 = await runtime.openPage(createCaller("run-1", "task-1", "agent-1"));
      expect(s1.ok).toBe(true);

      const s2 = await runtime.openPage(createCaller("run-1", "task-2", "agent-2"));
      expect(s2.ok).toBe(true);

      const s3 = await runtime.openPage(createCaller("run-1", "task-3", "agent-3"));
      expect(s3.ok).toBe(false);
      if (!s3.ok) {
        expect(s3.error.code).toBe("conflict");
        expect(s3.error.details).toMatchObject({
          diagnosticCode: "session_limit_exceeded"
        });
      }
    });

    it("enforces maxMemoryBytes limit with browser_memory_limit_exceeded", async () => {
      const runtime = createRuntime({ maxMemoryBytes: 100 * 1024 * 1024 });

      // First page opens when handle memory is 50MB (within 100MB)
      const p1 = await runtime.openPage(createCaller("run-1", "task-1"));
      expect(p1.ok).toBe(true);

      // Increase handle memory to 150MB
      mockLauncher.handles[0]!.memoryRssBytes = 150 * 1024 * 1024;

      // Opening next page fails due to memory limit
      const p2 = await runtime.openPage(createCaller("run-1", "task-2"));
      expect(p2.ok).toBe(false);
      if (!p2.ok) {
        expect(p2.error.code).toBe("conflict");
        expect(p2.error.details).toMatchObject({
          diagnosticCode: "browser_memory_limit_exceeded"
        });
      }

      // Health check also detects and stops browser
      const health = await runtime.healthCheck(testScope);
      expect(health.ok).toBe(true);
      if (health.ok) {
        expect(health.value.status).toBe("stopped");
        expect(health.value.diagnosticCode).toBe("browser_memory_limit_exceeded");
      }
    });

    it("cleans up task resources, disposes contexts, stops empty instance, and increments taskCleanups", async () => {
      const runtime = createRuntime({ stopInstanceWhenEmpty: true });
      const caller1 = createCaller("run-10", "task-1", "agent-1");
      const caller2 = createCaller("run-10", "task-2", "agent-2");

      const p1 = await runtime.openPage(caller1, "https://page-1.local");
      const p2 = await runtime.openPage(caller1, "https://page-2.local");
      const p3 = await runtime.openPage(caller2, "https://page-3.local");

      expect(p1.ok).toBe(true);
      expect(p2.ok).toBe(true);
      expect(p3.ok).toBe(true);

      const cleanupRes1 = await runtime.cleanupTask("run-10", "task-1", testScope);
      expect(cleanupRes1.ok).toBe(true);
      if (cleanupRes1.ok) {
        expect(cleanupRes1.value.closedPages).toBe(2);
        expect(cleanupRes1.value.disposedContexts).toBe(1);
      }

      // Agent 1 pages are now closed
      const pagesAfter1 = await runtime.listPages(caller1);
      expect(pagesAfter1.ok).toBe(true);
      expect(pagesAfter1.value!.length).toBe(0);

      // Agent 2 pages still active
      const pagesAfter2 = await runtime.listPages(caller2);
      expect(pagesAfter2.ok).toBe(true);
      expect(pagesAfter2.value!.length).toBe(1);

      // Now cleanup task-2 (last active session for this instance)
      const cleanupRes2 = await runtime.cleanupTask("run-10", "task-2", testScope);
      expect(cleanupRes2.ok).toBe(true);
      if (cleanupRes2.ok) {
        expect(cleanupRes2.value.closedPages).toBe(1);
        expect(cleanupRes2.value.disposedContexts).toBe(1);
      }

      // Instance was empty, so it stopped and removed .bflow-profile.lock
      const handle = mockLauncher.handles[0]!;
      expect(handle.stopped).toBe(true);

      const profileDir = resolveDedicatedProfileDir(browserProfilesRoot, testScope);
      await expect(fs.access(path.join(profileDir, ".bflow-profile.lock"))).rejects.toThrow();

      const metrics = runtime.getMetrics();
      expect(metrics.taskCleanups).toBe(2);
      expect(metrics.activePages).toBe(0);
      expect(metrics.activeSessions).toBe(0);
    });
  });

  describe("Utility functions", () => {
    it("scopeToKey & isSameScope handle all TrustScope kinds", () => {
      const machineScope: TrustScope = { kind: "machine", machineId: "m1" };
      const repoScope: TrustScope = {
        kind: "repository",
        machineId: "m1",
        repositoryId: "r1",
        workspaceRoot: "/workspace"
      };
      const sessionScope: TrustScope = {
        kind: "session",
        machineId: "m1",
        repositoryId: "r1",
        workspaceRoot: "/workspace",
        sessionId: "s1"
      };

      expect(scopeToKey(machineScope)).toBe("machine:m1");
      expect(scopeToKey(repoScope)).toBe("repo:m1:r1:/workspace");
      expect(scopeToKey(sessionScope)).toBe("session:m1:r1:/workspace:s1");

      expect(isSameScope(machineScope, { kind: "machine", machineId: "m1" })).toBe(true);
      expect(isSameScope(machineScope, { kind: "machine", machineId: "m2" })).toBe(false);
      expect(isSameScope(repoScope, { ...repoScope })).toBe(true);
      expect(isSameScope(sessionScope, { ...sessionScope })).toBe(true);
    });

    it("defaultIsPidAlive returns true for current process and false for non-existent PID", () => {
      expect(defaultIsPidAlive(process.pid)).toBe(true);
      expect(defaultIsPidAlive(-1)).toBe(false);
      expect(defaultIsPidAlive(0)).toBe(false);
      expect(defaultIsPidAlive(9999999)).toBe(false);
    });
  });
});
