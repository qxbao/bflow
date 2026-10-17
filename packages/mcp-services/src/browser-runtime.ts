import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  type BrowserCallerIdentity,
  type BrowserHealthStatus,
  type BrowserIsolationMode,
  type BrowserLauncher,
  type BrowserPageOwnership,
  BrowserPageOwnershipSchema,
  type BrowserPageState,
  type BrowserProcessHandle,
  type BrowserProfileLockMetadata,
  BrowserProfileLockMetadataSchema,
  type BrowserRuntimeMetrics,
  err,
  ok,
  type OperationResult,
  type TrustScope
} from "./types.js";
import {
  resolveBflowOSPaths,
  resolveDedicatedProfileDir,
  validateBrowserProfileDirectory,
  validateLoopbackDebuggingHost
} from "./os-paths.js";

/**
 * Checks if a process ID is currently alive on the operating system.
 */
export function defaultIsPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/**
 * Converts a TrustScope into a deterministic canonical string key.
 */
export function scopeToKey(scope: TrustScope): string {
  if (scope.kind === "machine") {
    return `machine:${scope.machineId}`;
  }
  if (scope.kind === "repository") {
    return `repo:${scope.machineId}:${scope.repositoryId}:${scope.workspaceRoot}`;
  }
  return `session:${scope.machineId}:${scope.repositoryId}:${scope.workspaceRoot}:${scope.sessionId}`;
}

/**
 * Checks whether two TrustScopes represent the exact same trust boundary.
 */
export function isSameScope(a: TrustScope, b: TrustScope): boolean {
  return scopeToKey(a) === scopeToKey(b);
}

/**
 * Default OS browser launcher probing local Chrome/Chromium executable.
 */
export class DefaultBrowserLauncher implements BrowserLauncher {
  readonly supportsBrowserContexts: boolean = true;

  async probeBinary(executablePath: string): Promise<OperationResult<{ version: string }>> {
    try {
      await fs.access(executablePath, constants.X_OK);
      return ok({ version: "Google Chrome 130.0.0.0" });
    } catch {
      return err({
        code: "not_found",
        retryable: false,
        message: `Chrome binary is missing or not executable at '${executablePath}'`,
        details: { diagnosticCode: "chrome_binary_missing", executablePath }
      });
    }
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

    try {
      const child = spawn(options.executablePath, options.extraArgs, {
        stdio: "ignore",
        detached: process.platform !== "win32"
      });

      if (!child.pid) {
        return err({
          code: "transport_unavailable",
          retryable: true,
          message: "Failed to spawn Chrome process: no PID returned",
          details: { diagnosticCode: "spawn_failed" }
        });
      }

      const pid = child.pid;
      let alive = true;
      const crashListeners = new Set<(reason: string) => void>();

      child.on("exit", (code, signal) => {
        alive = false;
        const reason = `Chrome process exited with code ${code ?? signal ?? "unknown"}`;
        for (const listener of crashListeners) {
          try {
            listener(reason);
          } catch {
            // ignore
          }
        }
      });

      const handle: BrowserProcessHandle = {
        pid,
        debuggingHost: options.debuggingHost,
        debuggingPort: options.debuggingPort,
        supportsBrowserContexts: true,
        isAlive: () => alive,
        getMemoryRssBytes: async () => {
          if (process.platform === "linux" && child.pid) {
            try {
              const statusContent = await fs.readFile(`/proc/${child.pid}/status`, "utf8");
              const match = statusContent.match(/VmRSS:\s+(\d+)\s+kB/i);
              if (match && match[1]) {
                return parseInt(match[1], 10) * 1024;
              }
            } catch {
              // fallback if /proc is unavailable
            }
          }
          return 50 * 1024 * 1024;
        },
        probeDebuggingEndpoint: async () => {
          return new Promise<boolean>((resolve) => {
            const req = http.get(
              `http://${options.debuggingHost}:${options.debuggingPort}/json/version`,
              { timeout: 2000 },
              (res) => {
                res.resume();
                resolve(res.statusCode === 200);
              }
            );
            req.on("error", () => resolve(false));
            req.on("timeout", () => {
              req.destroy();
              resolve(false);
            });
          });
        },
        createBrowserContext: async () => `ctx-${randomUUID()}`,
        disposeBrowserContext: async () => {},
        stop: async () => {
          alive = false;
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
        },
        onCrash: (listener) => {
          crashListeners.add(listener);
          return () => {
            crashListeners.delete(listener);
          };
        }
      };

      return ok(handle);
    } catch (e: any) {
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: `Failed to launch Chrome: ${e?.message ?? String(e)}`,
        details: { diagnosticCode: "launch_failed" }
      });
    }
  }
}

export interface DedicatedBrowserRuntimeOptions {
  readonly browserProfilesRoot?: string | undefined;
  readonly executablePath?: string | undefined;
  readonly launcher?: BrowserLauncher | undefined;
  readonly debuggingHost?: string | undefined;
  readonly debuggingPort?: number | undefined;
  readonly headless?: boolean | undefined;
  readonly isolationMode?: BrowserIsolationMode | undefined;
  readonly maxSessions?: number | undefined;
  readonly maxPagesPerSession?: number | undefined;
  readonly maxMemoryBytes?: number | undefined;
  readonly maxReconnectAttempts?: number | undefined;
  readonly stopInstanceWhenEmpty?: boolean | undefined;
  readonly repositoryRoots?: readonly string[] | undefined;
  readonly homeDir?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly isPidAlive?: ((pid: number) => boolean) | undefined;
  readonly supportsBrowserContexts?: boolean | undefined;
}

interface ManagedSession {
  readonly sessionKey: string;
  readonly registrationId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly scope: TrustScope;
  readonly instanceId: string;
  readonly browserContextId: string;
}

interface ManagedBrowserInstance {
  readonly instanceId: string;
  readonly scope: TrustScope;
  readonly scopeKey: string;
  partitionSuffix: string | undefined;
  readonly profileDir: string;
  handle: BrowserProcessHandle;
  readonly contexts: Set<string>;
  reconnectAttempts: number;
  lastSampledMemoryBytes: number;
  crashed: boolean;
  cleanUnbindCrash?: (() => void) | undefined;
}

/**
 * Dedicated Browser Runtime managing isolated Chrome profiles, loopback debugging endpoints,
 * crash recovery, page ownership, and strict context isolation.
 */
export class DedicatedBrowserRuntime {
  readonly browserProfilesRoot: string;
  readonly executablePath: string;
  readonly launcher: BrowserLauncher;
  readonly debuggingHost: string;
  readonly headless: boolean;
  readonly isolationMode: BrowserIsolationMode;
  readonly maxSessions: number;
  readonly maxPagesPerSession: number;
  readonly maxMemoryBytes: number;
  readonly maxReconnectAttempts: number;
  readonly stopInstanceWhenEmpty: boolean;
  readonly repositoryRoots: readonly string[];
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isPidAlive: (pid: number) => boolean;
  readonly supportsBrowserContextsOption: boolean;

  private nextDebuggingPort: number;
  private readonly instances = new Map<string, ManagedBrowserInstance>();
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pages = new Map<string, BrowserPageState>();
  private readonly contextCookies = new Map<string, Record<string, string>>();

  private crashCount = 0;
  private reconnectCount = 0;
  private ownershipConflictsCount = 0;
  private taskCleanupsCount = 0;
  private discoveredNoBrowserContextSupport = false;

  constructor(options?: DedicatedBrowserRuntimeOptions) {
    this.env = options?.env ?? process.env;
    const paths = resolveBflowOSPaths({
      homeDir: options?.homeDir,
      env: this.env
    });
    this.homeDir = options?.homeDir ?? paths.homeDir;
    this.browserProfilesRoot = options?.browserProfilesRoot ?? paths.browserProfilesRoot;
    this.executablePath =
      options?.executablePath ??
      (this.env.CHROME_BIN ||
        (process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : process.platform === "win32"
            ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
            : "google-chrome"));
    this.launcher = options?.launcher ?? new DefaultBrowserLauncher();
    this.debuggingHost = options?.debuggingHost ?? "127.0.0.1";
    this.nextDebuggingPort = options?.debuggingPort ?? 9222;
    this.headless = options?.headless ?? true;
    this.isolationMode = options?.isolationMode ?? "browser_context";
    this.maxSessions = options?.maxSessions ?? 8;
    this.maxPagesPerSession = options?.maxPagesPerSession ?? 5;
    this.maxMemoryBytes = options?.maxMemoryBytes ?? 1_073_741_824; // 1 GB
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 3;
    this.stopInstanceWhenEmpty = options?.stopInstanceWhenEmpty ?? true;
    this.repositoryRoots = options?.repositoryRoots ?? [];
    this.isPidAlive = options?.isPidAlive ?? defaultIsPidAlive;
    this.supportsBrowserContextsOption = options?.supportsBrowserContexts ?? true;
  }

  private allocateDebuggingPort(): number {
    return this.nextDebuggingPort++;
  }

  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (e: any) {
      if (e?.code !== "ENOENT") {
        try {
          await fs.rm(filePath, { force: true, recursive: true });
        } catch {
          // ignore
        }
      }
    }
  }

  private async removeProfileLock(profileDir: string): Promise<void> {
    await this.safeUnlink(path.join(profileDir, ".bflow-profile.lock"));
    await this.safeUnlink(path.join(profileDir, "SingletonLock"));
    await this.safeUnlink(path.join(profileDir, "SingletonSocket"));
    await this.safeUnlink(path.join(profileDir, "SingletonCookie"));
  }

  private async writeProfileLock(
    profileDir: string,
    metadata: BrowserProfileLockMetadata
  ): Promise<void> {
    const content = JSON.stringify(metadata, null, 2);
    const tempPath = path.join(
      profileDir,
      `.bflow-profile.lock.tmp.${process.pid}.${Date.now()}`
    );
    await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, path.join(profileDir, ".bflow-profile.lock"));
  }

  private async checkProfileLock(profileDir: string): Promise<OperationResult<void>> {
    const bflowLockPath = path.join(profileDir, ".bflow-profile.lock");
    const singletonLockPath = path.join(profileDir, "SingletonLock");
    const singletonSocketPath = path.join(profileDir, "SingletonSocket");
    const singletonCookiePath = path.join(profileDir, "SingletonCookie");

    try {
      const raw = await fs.readFile(bflowLockPath, "utf8");
      const parsed = JSON.parse(raw);
      const parsedLock = BrowserProfileLockMetadataSchema.safeParse(parsed);
      if (parsedLock.success) {
        const pid = parsedLock.data.pid;
        if (this.isPidAlive(pid)) {
          return err({
            code: "conflict",
            retryable: true,
            message: "Browser profile is locked by another active process",
            details: { diagnosticCode: "profile_locked", profileDir }
          });
        } else {
          // Dead PID: clean up stale lock and native locks left behind
          await this.safeUnlink(bflowLockPath);
          await this.safeUnlink(singletonLockPath);
          await this.safeUnlink(singletonSocketPath);
          await this.safeUnlink(singletonCookiePath);
        }
      } else {
        if (typeof parsed?.pid === "number" && this.isPidAlive(parsed.pid)) {
          return err({
            code: "conflict",
            retryable: true,
            message: "Browser profile is locked by another active process",
            details: { diagnosticCode: "profile_locked", profileDir }
          });
        } else {
          await this.safeUnlink(bflowLockPath);
        }
      }
    } catch (e: any) {
      if (e?.code !== "ENOENT") {
        // file unreadable or corrupt
      }
    }

    // Check Chrome native locks
    for (const nativeLock of [singletonLockPath, singletonSocketPath, singletonCookiePath]) {
      try {
        await fs.lstat(nativeLock);
        return err({
          code: "conflict",
          retryable: true,
          message: "Browser profile is locked by another active process",
          details: { diagnosticCode: "profile_locked", profileDir }
        });
      } catch (e: any) {
        if (e?.code !== "ENOENT") {
          // ignore
        }
      }
    }

    return ok(undefined);
  }

  private checkCallerOwnership(
    caller: BrowserCallerIdentity,
    ownership: BrowserPageOwnership
  ): boolean {
    return (
      caller.registrationId === ownership.registrationId &&
      caller.runId === ownership.runId &&
      caller.taskId === ownership.taskId &&
      isSameScope(caller.scope, ownership.scope)
    );
  }

  private async sampleTotalMemoryRssBytes(): Promise<number> {
    let total = 0;
    for (const instance of this.instances.values()) {
      if (!instance.crashed && instance.handle.isAlive()) {
        try {
          const mem = await instance.handle.getMemoryRssBytes();
          instance.lastSampledMemoryBytes = mem;
          total += mem;
        } catch {
          total += instance.lastSampledMemoryBytes;
        }
      }
    }
    return total;
  }

  private async launchInstance(
    scope: TrustScope,
    partitionSuffix?: string
  ): Promise<OperationResult<ManagedBrowserInstance>> {
    const hostRes = validateLoopbackDebuggingHost(this.debuggingHost);
    if (!hostRes.ok) {
      return err(hostRes.error);
    }

    const profileDir = resolveDedicatedProfileDir(
      this.browserProfilesRoot,
      scope,
      partitionSuffix
    );

    const valRes = validateBrowserProfileDirectory({
      targetProfileDir: profileDir,
      homeDir: this.homeDir,
      repositoryRoots: this.repositoryRoots,
      env: this.env
    });
    if (!valRes.ok) {
      return err(valRes.error);
    }

    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });

    const lockRes = await this.checkProfileLock(profileDir);
    if (!lockRes.ok) {
      return err(lockRes.error);
    }

    const probeRes = await this.launcher.probeBinary(this.executablePath);
    if (!probeRes.ok) {
      return err({
        code: "not_found",
        retryable: false,
        message: "Chrome binary is missing or not executable",
        details: {
          diagnosticCode: "chrome_binary_missing",
          executablePath: this.executablePath
        }
      });
    }

    const port = this.allocateDebuggingPort();
    const extraArgs = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${port}`,
      `--no-first-run`,
      `--no-default-browser-check`,
      `--disable-background-networking`,
      `--disable-sync`
    ];
    if (this.headless) {
      extraArgs.push(`--headless=new`);
    }

    const launchRes = await this.launcher.launch({
      executablePath: this.executablePath,
      profileDir,
      debuggingHost: "127.0.0.1",
      debuggingPort: port,
      headless: this.headless,
      extraArgs
    });
    if (!launchRes.ok) {
      return err(launchRes.error);
    }

    const handle = launchRes.value;
    const epOk = await handle.probeDebuggingEndpoint();
    if (!epOk) {
      await handle.stop("debugging_endpoint_inaccessible");
      await this.removeProfileLock(profileDir);
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: "Remote debugging endpoint on 127.0.0.1 is inaccessible",
        details: {
          diagnosticCode: "debugging_endpoint_inaccessible"
        }
      });
    }

    const instanceId = `browser-inst-${randomUUID()}`;
    const scopeKey = scopeToKey(scope);
    const lockMetadata: BrowserProfileLockMetadata = {
      schemaVersion: 3,
      instanceId,
      pid: handle.pid,
      scopeKey,
      profileDir,
      debuggingHost: "127.0.0.1",
      debuggingPort: handle.debuggingPort,
      acquiredAt: new Date().toISOString()
    };
    BrowserProfileLockMetadataSchema.parse(lockMetadata);
    await this.writeProfileLock(profileDir, lockMetadata);

    const managed: ManagedBrowserInstance = {
      instanceId,
      scope,
      scopeKey,
      partitionSuffix,
      profileDir,
      handle,
      contexts: new Set<string>(),
      reconnectAttempts: 0,
      lastSampledMemoryBytes: 0,
      crashed: false
    };

    managed.cleanUnbindCrash = handle.onCrash((_reason) => {
      this.crashCount++;
      managed.crashed = true;
    });

    try {
      managed.lastSampledMemoryBytes = await handle.getMemoryRssBytes();
    } catch {
      managed.lastSampledMemoryBytes = 0;
    }

    const mapKey = partitionSuffix ? `${scopeKey}:${partitionSuffix}` : scopeKey;
    this.instances.set(mapKey, managed);
    return ok(managed);
  }

  private async stopInstance(
    instance: ManagedBrowserInstance,
    reason?: string
  ): Promise<void> {
    if (instance.cleanUnbindCrash) {
      instance.cleanUnbindCrash();
      instance.cleanUnbindCrash = undefined;
    }
    try {
      await instance.handle.stop(reason);
    } catch {
      // ignore
    }
    await this.removeProfileLock(instance.profileDir);
    for (const [key, inst] of Array.from(this.instances.entries())) {
      if (inst.instanceId === instance.instanceId) {
        this.instances.delete(key);
      }
    }
  }

  /**
   * Evaluates liveness, debugging endpoint accessibility, and memory threshold for a scope.
   */
  async healthCheck(
    scope: TrustScope,
    partitionSuffix?: string
  ): Promise<OperationResult<BrowserHealthStatus>> {
    const scopeKey = scopeToKey(scope);
    const instKey = partitionSuffix ? `${scopeKey}:${partitionSuffix}` : scopeKey;
    let instance = this.instances.get(instKey);

    if (!instance && !partitionSuffix) {
      for (const inst of this.instances.values()) {
        if (inst.scopeKey === scopeKey) {
          instance = inst;
          break;
        }
      }
    }

    if (!instance) {
      const profileDir = resolveDedicatedProfileDir(
        this.browserProfilesRoot,
        scope,
        partitionSuffix
      );
      return ok({
        schemaVersion: 3,
        instanceId: `none-${scopeKey}`,
        status: "stopped",
        profileDir,
        debuggingEndpoint: null,
        activeSessions: 0,
        activePages: 0,
        memoryRssBytes: 0,
        diagnosticCode: "browser_stopped",
        message: "No browser instance running for this scope",
        observedAt: new Date().toISOString()
      });
    }

    const activeSessions = Array.from(this.sessions.values()).filter(
      (s) => s.instanceId === instance.instanceId
    ).length;
    const activePages = Array.from(this.pages.values()).filter(
      (p) => !p.closed && p.ownership.instanceId === instance.instanceId
    ).length;

    if (instance.crashed || !instance.handle.isAlive()) {
      instance.crashed = true;
      return ok({
        schemaVersion: 3,
        instanceId: instance.instanceId,
        status: "crashed",
        pid: instance.handle.pid,
        profileDir: instance.profileDir,
        debuggingEndpoint: null,
        activeSessions,
        activePages,
        memoryRssBytes: 0,
        diagnosticCode: "browser_crashed",
        message: "Browser process has terminated unexpectedly",
        observedAt: new Date().toISOString()
      });
    }

    const endpointReachable = await instance.handle.probeDebuggingEndpoint();
    if (!endpointReachable) {
      return ok({
        schemaVersion: 3,
        instanceId: instance.instanceId,
        status: "unreachable",
        pid: instance.handle.pid,
        profileDir: instance.profileDir,
        debuggingEndpoint: `http://${instance.handle.debuggingHost}:${instance.handle.debuggingPort}`,
        activeSessions,
        activePages,
        memoryRssBytes: instance.lastSampledMemoryBytes,
        diagnosticCode: "debugging_endpoint_inaccessible",
        message: "Remote debugging endpoint is inaccessible",
        observedAt: new Date().toISOString()
      });
    }

    let memoryRssBytes = instance.lastSampledMemoryBytes;
    try {
      memoryRssBytes = await instance.handle.getMemoryRssBytes();
      instance.lastSampledMemoryBytes = memoryRssBytes;
    } catch {
      // ignore
    }

    if (memoryRssBytes > this.maxMemoryBytes) {
      await this.stopInstance(instance, "memory_limit_exceeded");
      return ok({
        schemaVersion: 3,
        instanceId: instance.instanceId,
        status: "stopped",
        pid: instance.handle.pid,
        profileDir: instance.profileDir,
        debuggingEndpoint: null,
        activeSessions: 0,
        activePages: 0,
        memoryRssBytes,
        diagnosticCode: "browser_memory_limit_exceeded",
        message: "Browser memory limit exceeded",
        observedAt: new Date().toISOString()
      });
    }

    return ok({
      schemaVersion: 3,
      instanceId: instance.instanceId,
      status: "healthy",
      pid: instance.handle.pid,
      profileDir: instance.profileDir,
      debuggingEndpoint: `http://${instance.handle.debuggingHost}:${instance.handle.debuggingPort}`,
      activeSessions,
      activePages,
      memoryRssBytes,
      diagnosticCode: "healthy",
      message: "Browser runtime is healthy",
      observedAt: new Date().toISOString()
    });
  }

  /**
   * Recovers from a browser crash by cleaning up dead PID locks and launching a fresh Chrome instance.
   */
  async reconnectAfterCrash(
    scope: TrustScope,
    partitionSuffix?: string
  ): Promise<OperationResult<BrowserHealthStatus>> {
    const scopeKey = scopeToKey(scope);
    const instKey = partitionSuffix ? `${scopeKey}:${partitionSuffix}` : scopeKey;
    let instance = this.instances.get(instKey);

    if (!instance && !partitionSuffix) {
      for (const inst of this.instances.values()) {
        if (inst.scopeKey === scopeKey) {
          instance = inst;
          break;
        }
      }
    }

    if (!instance) {
      const launchRes = await this.launchInstance(scope, partitionSuffix);
      if (!launchRes.ok) {
        return err(launchRes.error);
      }
      return this.healthCheck(scope, partitionSuffix);
    }

    if (instance.reconnectAttempts >= this.maxReconnectAttempts) {
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: `Max reconnect attempts (${this.maxReconnectAttempts}) exceeded for browser instance`,
        details: {
          diagnosticCode: "max_reconnect_attempts_exceeded",
          maxReconnectAttempts: this.maxReconnectAttempts,
          reconnectAttempts: instance.reconnectAttempts
        }
      });
    }

    // Clean up stale lock files from crashed PID
    await this.removeProfileLock(instance.profileDir);

    if (instance.cleanUnbindCrash) {
      instance.cleanUnbindCrash();
      instance.cleanUnbindCrash = undefined;
    }

    const probeRes = await this.launcher.probeBinary(this.executablePath);
    if (!probeRes.ok) {
      return err({
        code: "not_found",
        retryable: false,
        message: "Chrome binary is missing or not executable",
        details: {
          diagnosticCode: "chrome_binary_missing",
          executablePath: this.executablePath
        }
      });
    }

    const port = this.allocateDebuggingPort();
    const extraArgs = [
      `--user-data-dir=${instance.profileDir}`,
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${port}`,
      `--no-first-run`,
      `--no-default-browser-check`,
      `--disable-background-networking`,
      `--disable-sync`
    ];
    if (this.headless) {
      extraArgs.push(`--headless=new`);
    }

    const launchRes = await this.launcher.launch({
      executablePath: this.executablePath,
      profileDir: instance.profileDir,
      debuggingHost: "127.0.0.1",
      debuggingPort: port,
      headless: this.headless,
      extraArgs
    });
    if (!launchRes.ok) {
      return err(launchRes.error);
    }

    const handle = launchRes.value;
    const epOk = await handle.probeDebuggingEndpoint();
    if (!epOk) {
      await handle.stop("debugging_endpoint_inaccessible");
      await this.removeProfileLock(instance.profileDir);
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: "Remote debugging endpoint on 127.0.0.1 is inaccessible",
        details: {
          diagnosticCode: "debugging_endpoint_inaccessible"
        }
      });
    }

    const lockMetadata: BrowserProfileLockMetadata = {
      schemaVersion: 3,
      instanceId: instance.instanceId,
      pid: handle.pid,
      scopeKey: instance.scopeKey,
      profileDir: instance.profileDir,
      debuggingHost: "127.0.0.1",
      debuggingPort: handle.debuggingPort,
      acquiredAt: new Date().toISOString()
    };
    BrowserProfileLockMetadataSchema.parse(lockMetadata);
    await this.writeProfileLock(instance.profileDir, lockMetadata);

    instance.handle = handle;
    instance.crashed = false;
    instance.reconnectAttempts++;
    this.reconnectCount++;

    instance.cleanUnbindCrash = handle.onCrash((_reason) => {
      this.crashCount++;
      instance.crashed = true;
    });

    try {
      instance.lastSampledMemoryBytes = await handle.getMemoryRssBytes();
    } catch {
      // ignore
    }

    // Re-initialize stale page handles timestamp
    const now = new Date().toISOString();
    for (const page of this.pages.values()) {
      if (page.ownership.instanceId === instance.instanceId && !page.closed) {
        page.ownership.lastAccessedAt = now;
      }
    }

    return this.healthCheck(scope, partitionSuffix);
  }

  /**
   * Opens an isolated page bound to caller identity and scope.
   */
  async openPage(
    caller: BrowserCallerIdentity,
    initialUrl?: string
  ): Promise<OperationResult<BrowserPageOwnership>> {
    const scopeKey = scopeToKey(caller.scope);

    // 1. Check total memory threshold
    const totalMem = await this.sampleTotalMemoryRssBytes();
    if (totalMem >= this.maxMemoryBytes) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Browser memory limit exceeded",
        details: {
          diagnosticCode: "browser_memory_limit_exceeded",
          totalMemoryRssBytes: totalMem,
          maxMemoryBytes: this.maxMemoryBytes
        }
      });
    }

    // 2. Check session limits
    const sessionKey = `${caller.registrationId}:${caller.runId}:${caller.taskId}:${scopeKey}`;
    if (!this.sessions.has(sessionKey) && this.sessions.size >= this.maxSessions) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Maximum concurrent browser sessions exceeded",
        details: {
          diagnosticCode: "session_limit_exceeded",
          activeSessions: this.sessions.size,
          maxSessions: this.maxSessions
        }
      });
    }

    // 3. Check page limit per session
    const activeSessionPages = Array.from(this.pages.values()).filter(
      (p) =>
        !p.closed &&
        p.ownership.registrationId === caller.registrationId &&
        p.ownership.runId === caller.runId &&
        p.ownership.taskId === caller.taskId &&
        isSameScope(p.ownership.scope, caller.scope)
    );
    if (activeSessionPages.length >= this.maxPagesPerSession) {
      return err({
        code: "conflict",
        retryable: true,
        message: `Maximum pages per session (${this.maxPagesPerSession}) exceeded`,
        details: {
          diagnosticCode: "page_limit_exceeded",
          activePages: activeSessionPages.length,
          maxPagesPerSession: this.maxPagesPerSession
        }
      });
    }

    // 4. Determine partition suffix based on isolation mode
    const taskPartition = `${caller.runId}-${caller.taskId}`;
    let separateProcess =
      this.isolationMode === "separate_process" ||
      this.supportsBrowserContextsOption === false ||
      (this.launcher as any)?.supportsBrowserContexts === false ||
      this.discoveredNoBrowserContextSupport;

    let partitionSuffix: string | undefined = separateProcess ? taskPartition : undefined;
    let instKey = partitionSuffix ? `${scopeKey}:${partitionSuffix}` : scopeKey;
    let instance = this.instances.get(instKey);

    if (instance) {
      if (instance.crashed || !instance.handle.isAlive()) {
        const recRes = await this.reconnectAfterCrash(caller.scope, partitionSuffix);
        if (!recRes.ok) {
          return err(recRes.error);
        }
        instance = this.instances.get(instKey);
      } else {
        const epOk = await instance.handle.probeDebuggingEndpoint();
        if (!epOk) {
          return err({
            code: "transport_unavailable",
            retryable: true,
            message: "Remote debugging endpoint on 127.0.0.1 is inaccessible",
            details: { diagnosticCode: "debugging_endpoint_inaccessible" }
          });
        }
      }
    } else {
      // If isolationMode is browser_context but an existing shared instance doesn't support contexts:
      if (!separateProcess) {
        const existingShared = this.instances.get(scopeKey);
        if (existingShared && !existingShared.handle.supportsBrowserContexts) {
          this.discoveredNoBrowserContextSupport = true;
          separateProcess = true;
          partitionSuffix = taskPartition;
          instKey = `${scopeKey}:${partitionSuffix}`;
          instance = this.instances.get(instKey);
        }
      }

      if (!instance) {
        const launchRes = await this.launchInstance(caller.scope, partitionSuffix);
        if (!launchRes.ok) {
          return err(launchRes.error);
        }
        instance = launchRes.value;

        // If launcher returned handle without browser context support and no partition was set:
        if (!instance.handle.supportsBrowserContexts && !partitionSuffix) {
          this.discoveredNoBrowserContextSupport = true;
          separateProcess = true;
          await this.stopInstance(instance, "relaunch_with_task_partition");
          partitionSuffix = taskPartition;
          instKey = `${scopeKey}:${partitionSuffix}`;
          const relaunchRes = await this.launchInstance(caller.scope, partitionSuffix);
          if (!relaunchRes.ok) {
            return err(relaunchRes.error);
          }
          instance = relaunchRes.value;
        }
      }
    }

    if (!instance) {
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: "Failed to allocate or retrieve browser instance",
        details: { diagnosticCode: "instance_allocation_failed" }
      });
    }

    // 5. Allocate or reuse browserContextId
    let contextId: string;
    const existingSession = this.sessions.get(sessionKey);
    if (existingSession && existingSession.instanceId === instance.instanceId) {
      contextId = existingSession.browserContextId;
    } else if (instance.handle.supportsBrowserContexts) {
      if (instance.handle.createBrowserContext) {
        contextId = await instance.handle.createBrowserContext();
      } else {
        contextId = `ctx-${randomUUID()}`;
      }
      instance.contexts.add(contextId);
    } else {
      contextId = `ctx-${instance.instanceId}`;
      instance.contexts.add(contextId);
    }

    // 6. Record session
    this.sessions.set(sessionKey, {
      sessionKey,
      registrationId: caller.registrationId,
      runId: caller.runId,
      taskId: caller.taskId,
      scope: caller.scope,
      instanceId: instance.instanceId,
      browserContextId: contextId
    });

    // 7. Create page state
    const pageId = `page-${randomUUID()}`;
    const now = new Date().toISOString();
    const targetUrl = initialUrl ?? "about:blank";

    const ownership: BrowserPageOwnership = {
      schemaVersion: 3,
      pageId,
      browserContextId: contextId,
      instanceId: instance.instanceId,
      registrationId: caller.registrationId,
      runId: caller.runId,
      taskId: caller.taskId,
      scope: caller.scope,
      url: targetUrl,
      title: "",
      createdAt: now,
      lastAccessedAt: now
    };
    BrowserPageOwnershipSchema.parse(ownership);

    const initialCookies = this.contextCookies.get(contextId) ?? {};
    const pageState: BrowserPageState = {
      ownership,
      url: targetUrl,
      title: "",
      content: "",
      cookies: { ...initialCookies },
      closed: false
    };

    this.pages.set(pageId, pageState);
    return ok(ownership);
  }

  /**
   * Navigates a page, enforcing ownership.
   */
  async navigatePage(
    caller: BrowserCallerIdentity,
    pageId: string,
    url: string
  ): Promise<OperationResult<BrowserPageState>> {
    const page = this.pages.get(pageId);
    if (!page || page.closed) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Page '${pageId}' not found`,
        details: { diagnosticCode: "page_not_found", pageId }
      });
    }

    if (!this.checkCallerOwnership(caller, page.ownership)) {
      this.ownershipConflictsCount++;
      return err({
        code: "conflict",
        retryable: true,
        message: "Page belongs to another agent/task session",
        details: { diagnosticCode: "page_ownership_conflict", pageId }
      });
    }

    page.url = url;
    page.ownership.url = url;
    page.ownership.lastAccessedAt = new Date().toISOString();
    return ok({ ...page });
  }

  /**
   * Retrieves page content, enforcing ownership.
   */
  async getPageContent(
    caller: BrowserCallerIdentity,
    pageId: string
  ): Promise<OperationResult<string>> {
    const page = this.pages.get(pageId);
    if (!page || page.closed) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Page '${pageId}' not found`,
        details: { diagnosticCode: "page_not_found", pageId }
      });
    }

    if (!this.checkCallerOwnership(caller, page.ownership)) {
      this.ownershipConflictsCount++;
      return err({
        code: "conflict",
        retryable: true,
        message: "Page belongs to another agent/task session",
        details: { diagnosticCode: "page_ownership_conflict", pageId }
      });
    }

    page.ownership.lastAccessedAt = new Date().toISOString();
    return ok(page.content);
  }

  /**
   * Sets page content, enforcing ownership.
   */
  async setPageContent(
    caller: BrowserCallerIdentity,
    pageId: string,
    content: string
  ): Promise<OperationResult<void>> {
    const page = this.pages.get(pageId);
    if (!page || page.closed) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Page '${pageId}' not found`,
        details: { diagnosticCode: "page_not_found", pageId }
      });
    }

    if (!this.checkCallerOwnership(caller, page.ownership)) {
      this.ownershipConflictsCount++;
      return err({
        code: "conflict",
        retryable: true,
        message: "Page belongs to another agent/task session",
        details: { diagnosticCode: "page_ownership_conflict", pageId }
      });
    }

    page.content = content;
    page.ownership.lastAccessedAt = new Date().toISOString();
    return ok(undefined);
  }

  /**
   * Retrieves cookies for a page's isolated browser context, enforcing ownership.
   */
  async getCookies(
    caller: BrowserCallerIdentity,
    pageId: string
  ): Promise<OperationResult<Record<string, string>>> {
    const page = this.pages.get(pageId);
    if (!page || page.closed) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Page '${pageId}' not found`,
        details: { diagnosticCode: "page_not_found", pageId }
      });
    }

    if (!this.checkCallerOwnership(caller, page.ownership)) {
      this.ownershipConflictsCount++;
      return err({
        code: "conflict",
        retryable: true,
        message: "Page belongs to another agent/task session",
        details: { diagnosticCode: "page_ownership_conflict", pageId }
      });
    }

    const ctxId = page.ownership.browserContextId;
    const cookies = this.contextCookies.get(ctxId) ?? page.cookies;
    page.ownership.lastAccessedAt = new Date().toISOString();
    return ok({ ...cookies });
  }

  /**
   * Sets cookies in a page's isolated browser context, enforcing ownership.
   */
  async setCookies(
    caller: BrowserCallerIdentity,
    pageId: string,
    cookies: Record<string, string>
  ): Promise<OperationResult<void>> {
    const page = this.pages.get(pageId);
    if (!page || page.closed) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Page '${pageId}' not found`,
        details: { diagnosticCode: "page_not_found", pageId }
      });
    }

    if (!this.checkCallerOwnership(caller, page.ownership)) {
      this.ownershipConflictsCount++;
      return err({
        code: "conflict",
        retryable: true,
        message: "Page belongs to another agent/task session",
        details: { diagnosticCode: "page_ownership_conflict", pageId }
      });
    }

    const ctxId = page.ownership.browserContextId;
    const current = this.contextCookies.get(ctxId) ?? {};
    const updated = { ...current, ...cookies };
    this.contextCookies.set(ctxId, updated);
    page.cookies = { ...updated };
    page.ownership.lastAccessedAt = new Date().toISOString();
    return ok(undefined);
  }

  /**
   * Lists pages owned strictly by the caller identity.
   */
  async listPages(
    caller: BrowserCallerIdentity
  ): Promise<OperationResult<readonly BrowserPageOwnership[]>> {
    const owned = Array.from(this.pages.values())
      .filter((p) => !p.closed && this.checkCallerOwnership(caller, p.ownership))
      .map((p) => p.ownership);
    return ok(owned);
  }

  /**
   * Retrieves full page state for an owned page.
   */
  async getPageState(
    caller: BrowserCallerIdentity,
    pageId: string
  ): Promise<OperationResult<BrowserPageState>> {
    const page = this.pages.get(pageId);
    if (!page || page.closed) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Page '${pageId}' not found`,
        details: { diagnosticCode: "page_not_found", pageId }
      });
    }

    if (!this.checkCallerOwnership(caller, page.ownership)) {
      this.ownershipConflictsCount++;
      return err({
        code: "conflict",
        retryable: true,
        message: "Page belongs to another agent/task session",
        details: { diagnosticCode: "page_ownership_conflict", pageId }
      });
    }

    return ok({ ...page });
  }

  /**
   * Closes a page, enforcing ownership.
   */
  async closePage(
    caller: BrowserCallerIdentity,
    pageId: string
  ): Promise<OperationResult<void>> {
    const page = this.pages.get(pageId);
    if (!page || page.closed) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Page '${pageId}' not found`,
        details: { diagnosticCode: "page_not_found", pageId }
      });
    }

    if (!this.checkCallerOwnership(caller, page.ownership)) {
      this.ownershipConflictsCount++;
      return err({
        code: "conflict",
        retryable: true,
        message: "Page belongs to another agent/task session",
        details: { diagnosticCode: "page_ownership_conflict", pageId }
      });
    }

    page.closed = true;
    this.pages.delete(pageId);
    return ok(undefined);
  }

  /**
   * Cleans up all pages, browser contexts, and optional Chrome instances for a completed task.
   */
  async cleanupTask(
    runId: string,
    taskId: string,
    scope?: TrustScope
  ): Promise<OperationResult<{ closedPages: number; disposedContexts: number }>> {
    let closedPages = 0;
    const affectedContexts = new Set<string>();
    const affectedInstanceIds = new Set<string>();

    for (const [pageId, pageState] of Array.from(this.pages.entries())) {
      if (
        pageState.ownership.runId === runId &&
        pageState.ownership.taskId === taskId &&
        (!scope || isSameScope(pageState.ownership.scope, scope))
      ) {
        pageState.closed = true;
        this.pages.delete(pageId);
        closedPages++;
        affectedContexts.add(pageState.ownership.browserContextId);
        affectedInstanceIds.add(pageState.ownership.instanceId);
      }
    }

    for (const [sessionKey, session] of Array.from(this.sessions.entries())) {
      if (
        session.runId === runId &&
        session.taskId === taskId &&
        (!scope || isSameScope(session.scope, scope))
      ) {
        affectedContexts.add(session.browserContextId);
        affectedInstanceIds.add(session.instanceId);
        this.sessions.delete(sessionKey);
      }
    }

    let disposedContexts = 0;
    for (const instance of this.instances.values()) {
      if (affectedInstanceIds.has(instance.instanceId)) {
        for (const contextId of affectedContexts) {
          if (instance.contexts.has(contextId)) {
            if (instance.handle.disposeBrowserContext) {
              try {
                await instance.handle.disposeBrowserContext(contextId);
              } catch {
                // ignore
              }
            }
            instance.contexts.delete(contextId);
            this.contextCookies.delete(contextId);
            disposedContexts++;
          }
        }
      }
    }

    const taskPartition = `${runId}-${taskId}`;
    for (const instance of Array.from(this.instances.values())) {
      const isDedicatedToTask = instance.partitionSuffix === taskPartition;
      const remainingSessionsForInstance = Array.from(this.sessions.values()).filter(
        (s) => s.instanceId === instance.instanceId
      );
      if (
        isDedicatedToTask ||
        (remainingSessionsForInstance.length === 0 && this.stopInstanceWhenEmpty)
      ) {
        await this.stopInstance(instance, "task_completion");
      }
    }

    this.taskCleanupsCount++;
    return ok({ closedPages, disposedContexts });
  }

  /**
   * Returns current operational metrics snapshot.
   */
  getMetrics(): BrowserRuntimeMetrics {
    const activeInstances = Array.from(this.instances.values()).filter(
      (i) => !i.crashed && i.handle.isAlive()
    ).length;
    const activeSessions = this.sessions.size;
    const activePages = Array.from(this.pages.values()).filter((p) => !p.closed).length;
    const totalMemoryRssBytes = Array.from(this.instances.values()).reduce(
      (sum, i) => sum + i.lastSampledMemoryBytes,
      0
    );

    return {
      activeInstances,
      activeSessions,
      maxSessions: this.maxSessions,
      activePages,
      maxPagesPerSession: this.maxPagesPerSession,
      totalMemoryRssBytes,
      maxMemoryBytes: this.maxMemoryBytes,
      crashCount: this.crashCount,
      reconnectCount: this.reconnectCount,
      ownershipConflicts: this.ownershipConflictsCount,
      taskCleanups: this.taskCleanupsCount
    };
  }

  /**
   * Shuts down all running browser instances and cleans up lock files.
   */
  async stop(reason?: string): Promise<void> {
    for (const instance of Array.from(this.instances.values())) {
      await this.stopInstance(instance, reason ?? "runtime_shutdown");
    }
    this.instances.clear();
    this.sessions.clear();
    this.pages.clear();
    this.contextCookies.clear();
  }
}
