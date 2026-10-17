import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  PlatformSchemaVersionSchema,
  SafeArgumentSchema,
  SecretReferenceSchema,
  TrustScopeSchema,
  type ContractError,
  type JsonValue,
  type MCPClientRegistration,
  type MCPResourceLease,
  type MCPServiceDefinition,
  type MCPServiceObservation,
  type OperationOptions,
  type OperationResult,
  type ScopedOperation,
  type TrustScope
} from "@bflow/contracts";

export const BFLOW_SERVICE_MARKER = "Managed by bflow" as const;

export type SupportedOSPlatform = "linux" | "darwin" | "win32";
export type OSServiceBackendKind = "systemd-user" | "launchd" | "windows-startup";

export const OSServiceConfigSchema = z
  .object({
    schemaVersion: PlatformSchemaVersionSchema,
    serviceId: IdentifierSchema,
    description: z.string().min(1).max(256),
    program: z.string().min(1),
    args: z.array(SafeArgumentSchema),
    workingDirectory: z.string().min(1).optional(),
    env: z.record(z.string()).default({}),
    healthEndpointUrl: z.string().url().optional(),
    healthTimeoutMs: z.number().int().positive().max(60_000).default(5_000),
    keepAliveOnCrash: z.boolean().default(true),
    enableOnLogin: z.boolean().default(true),
    restartSec: z.number().int().positive().max(300).default(2),
    maxRestartBurst: z.number().int().positive().max(20).default(5)
  })
  .strict();
export type OSServiceConfig = z.infer<typeof OSServiceConfigSchema>;

export type OSServiceLifecycleState =
  | "running"
  | "stopped"
  | "failed"
  | "activating"
  | "deactivating"
  | "not_installed"
  | "unknown";

export const OSServiceStatusSchema = z
  .object({
    schemaVersion: PlatformSchemaVersionSchema,
    serviceId: IdentifierSchema,
    backendKind: z.enum(["systemd-user", "launchd", "windows-startup"]),
    installed: z.boolean(),
    enabledOnLogin: z.boolean(),
    state: z.enum([
      "running",
      "stopped",
      "failed",
      "activating",
      "deactivating",
      "not_installed",
      "unknown"
    ]),
    pid: z.number().int().positive().optional(),
    unitPath: z.string(),
    unitDigest: z.string().nullable(),
    restartCount: z.number().int().nonnegative(),
    observedAt: IsoDateTimeSchema,
    diagnosticCode: z.string().min(1),
    diagnostics: z.array(z.string())
  })
  .strict();
export type OSServiceStatus = z.infer<typeof OSServiceStatusSchema>;

export interface OSServiceHealthReport {
  readonly schemaVersion: 3;
  readonly serviceId: string;
  readonly healthy: boolean;
  readonly processAlive: boolean;
  readonly endpointReachable: boolean;
  readonly status: OSServiceStatus;
  readonly latencyMs: number;
  readonly diagnosticCode: string;
  readonly message: string;
  readonly observedAt: string;
}

export interface OSServiceLogOptions {
  readonly lines?: number | undefined;
  readonly since?: string | undefined;
}

export interface OSServiceLogResult {
  readonly serviceId: string;
  readonly lines: readonly string[];
  readonly source: "journalctl" | "logfile" | "windows-event";
  readonly observedAt: string;
}

export interface OSServiceRepairResult {
  readonly serviceId: string;
  readonly repaired: boolean;
  readonly actionsTaken: readonly string[];
  readonly status: OSServiceStatus;
  readonly health: OSServiceHealthReport;
}

export interface OSCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean | undefined;
}

export interface OSCommandRunner {
  run(
    argv: readonly string[],
    options?: {
      readonly cwd?: string | undefined;
      readonly env?: Readonly<Record<string, string>> | undefined;
      readonly timeoutMs?: number | undefined;
    }
  ): Promise<OSCommandResult>;
}

export interface OSServiceManagerPort {
  readonly platform: SupportedOSPlatform;
  readonly backendKind: OSServiceBackendKind;
  unitPath(serviceId: string): string;
  renderDefinition(config: OSServiceConfig): OperationResult<string>;
  install(config: OSServiceConfig): Promise<OperationResult<OSServiceStatus>>;
  start(serviceId: string): Promise<OperationResult<OSServiceStatus>>;
  stop(serviceId: string): Promise<OperationResult<OSServiceStatus>>;
  restart(serviceId: string): Promise<OperationResult<OSServiceStatus>>;
  enableOnLogin(serviceId: string): Promise<OperationResult<OSServiceStatus>>;
  disableOnLogin(serviceId: string): Promise<OperationResult<OSServiceStatus>>;
  status(serviceId: string): Promise<OperationResult<OSServiceStatus>>;
  logs(serviceId: string, options?: OSServiceLogOptions): Promise<OperationResult<OSServiceLogResult>>;
  healthCheck(serviceId: string): Promise<OperationResult<OSServiceHealthReport>>;
  repair(serviceId: string, config: OSServiceConfig): Promise<OperationResult<OSServiceRepairResult>>;
  recoverIfDead(serviceId: string, config?: OSServiceConfig): Promise<OperationResult<OSServiceHealthReport>>;
  simulateUserLogin(): Promise<OperationResult<readonly OSServiceStatus[]>>;
}

// ============================================================================
// Resource Management Types
// ============================================================================

export type BackendStartupMode = "lazy" | "eager";

export interface ManagedBackendRegistrationOptions {
  readonly startupMode?: BackendStartupMode | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly maxMemoryBytes?: number | undefined;
  readonly maxConcurrentClients?: number | undefined;
  readonly isolateByRepository?: boolean | undefined;
}

export interface ManagedBackendDriver {
  readonly instanceId: string;
  readonly pid?: number | undefined;
  readonly startGeneration: number;
  readonly ownership: "bflow" | "external";
  initialize(options?: OperationOptions): Promise<
    OperationResult<{
      readonly protocolVersion: string;
      readonly discoveredTools: readonly string[];
    }>
  >;
  getMemoryRssBytes?(): Promise<number>;
  isAlive(): boolean;
  stop(reason?: string): Promise<void>;
  onCrash(listener: (reason: string) => void): () => void;
}

export interface ManagedBackendDriverFactory {
  createDriver(
    definition: MCPServiceDefinition,
    partitionKey: string,
    generation: number
  ): Promise<OperationResult<ManagedBackendDriver>>;
}

export interface PartitionResourceSnapshot {
  readonly partitionKey: string;
  readonly serviceId: string;
  readonly instanceId: string;
  readonly status: "ready" | "starting" | "blocked" | "stopped" | "unknown";
  readonly startupMode: BackendStartupMode;
  readonly ownership: "bflow" | "external";
  readonly pid?: number | undefined;
  readonly activeClientIds: readonly string[];
  readonly attachedScopes: readonly string[];
  readonly activeCallCount: number;
  readonly hasUncertainCalls: boolean;
  readonly memoryRssBytes: number;
  readonly maxMemoryBytes: number;
  readonly idleSince: string | null;
  readonly idleTimeoutMs: number;
  readonly restartCount: number;
  readonly startGeneration: number;
  readonly diagnosticCode: string;
}

export interface ResourceManagerMetricsSnapshot {
  readonly activeProcessCount: number;
  readonly maxProcessCount: number;
  readonly totalMemoryRssBytes: number;
  readonly peakMemoryRssBytes: number;
  readonly maxTotalMemoryBytes: number;
  readonly lazyStoppedCount: number;
  readonly runningBackendCount: number;
  readonly idleBackendCount: number;
  readonly idleCleanupsCount: number;
  readonly memoryEvictionsCount: number;
  readonly memoryLimitTerminations: number;
  readonly processLimitRejections: number;
  readonly partitions: Readonly<Record<string, PartitionResourceSnapshot>>;
}

// ============================================================================
// Dedicated Browser Runtime Types
// ============================================================================

export type BrowserIsolationMode = "browser_context" | "separate_process";

export const BrowserProfileLockMetadataSchema = z
  .object({
    schemaVersion: PlatformSchemaVersionSchema,
    instanceId: IdentifierSchema,
    pid: z.number().int().positive(),
    scopeKey: z.string().min(1),
    profileDir: z.string().min(1),
    debuggingHost: z.literal("127.0.0.1"),
    debuggingPort: z.number().int().min(1).max(65535),
    acquiredAt: IsoDateTimeSchema
  })
  .strict();
export type BrowserProfileLockMetadata = z.infer<typeof BrowserProfileLockMetadataSchema>;

export const BrowserPageOwnershipSchema = z
  .object({
    schemaVersion: PlatformSchemaVersionSchema,
    pageId: IdentifierSchema,
    browserContextId: IdentifierSchema,
    instanceId: IdentifierSchema,
    registrationId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    scope: TrustScopeSchema,
    url: z.string(),
    title: z.string(),
    createdAt: IsoDateTimeSchema,
    lastAccessedAt: IsoDateTimeSchema
  })
  .strict();
export type BrowserPageOwnership = z.infer<typeof BrowserPageOwnershipSchema>;

export interface BrowserCallerIdentity {
  readonly registrationId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly scope: TrustScope;
  readonly lease?: MCPResourceLease | undefined;
}

export interface BrowserPageState {
  readonly ownership: BrowserPageOwnership;
  url: string;
  title: string;
  content: string;
  cookies: Record<string, string>;
  closed: boolean;
}

export interface BrowserHealthStatus {
  readonly schemaVersion: 3;
  readonly instanceId: string;
  readonly status: "healthy" | "crashed" | "unreachable" | "stopped" | "profile_locked" | "binary_missing";
  readonly pid?: number | undefined;
  readonly profileDir: string;
  readonly debuggingEndpoint: string | null;
  readonly activeSessions: number;
  readonly activePages: number;
  readonly memoryRssBytes: number;
  readonly diagnosticCode: string;
  readonly message: string;
  readonly observedAt: string;
}

export interface BrowserProcessHandle {
  readonly pid: number;
  readonly debuggingHost: string;
  readonly debuggingPort: number;
  readonly supportsBrowserContexts: boolean;
  isAlive(): boolean;
  getMemoryRssBytes(): Promise<number>;
  probeDebuggingEndpoint(): Promise<boolean>;
  createBrowserContext?(): Promise<string>;
  disposeBrowserContext?(contextId: string): Promise<void>;
  stop(reason?: string): Promise<void>;
  onCrash(listener: (reason: string) => void): () => void;
}

export interface BrowserLauncher {
  probeBinary(executablePath: string): Promise<OperationResult<{ version: string }>>;
  launch(options: {
    readonly executablePath: string;
    readonly profileDir: string;
    readonly debuggingHost: string;
    readonly debuggingPort: number;
    readonly headless: boolean;
    readonly extraArgs: readonly string[];
  }): Promise<OperationResult<BrowserProcessHandle>>;
}

export interface BrowserRuntimeMetrics {
  readonly activeInstances: number;
  readonly activeSessions: number;
  readonly maxSessions: number;
  readonly activePages: number;
  readonly maxPagesPerSession: number;
  readonly totalMemoryRssBytes: number;
  readonly maxMemoryBytes: number;
  readonly crashCount: number;
  readonly reconnectCount: number;
  readonly ownershipConflicts: number;
  readonly taskCleanups: number;
}

export function ok<T>(value: T): OperationResult<T> {
  return { ok: true, value };
}

export function err<T = never>(error: ContractError): OperationResult<T> {
  return { ok: false, error };
}

export {
  SecretReferenceSchema,
  type ContractError,
  type JsonValue,
  type MCPClientRegistration,
  type MCPResourceLease,
  type MCPServiceDefinition,
  type MCPServiceObservation,
  type OperationOptions,
  type OperationResult,
  type ScopedOperation,
  type TrustScope
};
