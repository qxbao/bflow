import type {
  AgentProviderId,
  AgentRole,
  ContractError,
  JsonValue,
  MCPClientRegistration,
  MCPServiceDefinition,
  MCPServiceObservation,
  MCPToolCall,
  MCPToolCallResult,
  OperationOptions,
  OperationResult,
  ScopedOperation,
  TrustScope
} from "@bflow/contracts";

export const DEFAULT_MCP_PROTOCOL_VERSION = "2025-11-25" as const;

export interface MCPTransportCapabilities {
  readonly streamableHttp: boolean;
  readonly stdio: boolean;
  readonly sse?: boolean;
  readonly supportsCancellation?: boolean;
  readonly maxFrameBytes?: number;
}

export type MCPConcurrencyModel =
  | "multiplexed"
  | "serialized"
  | "exclusive_lease"
  | "single_client_isolated"
  | "unsupported";

export type MCPSessionIsolationPolicy =
  | "protocol_session"
  | "repository_partition"
  | "session_partition"
  | "task_isolated"
  | "unsupported";

export type MCPSharedStatePolicy =
  | "stateless"
  | "partitioned_by_repo"
  | "partitioned_by_session"
  | "mutable_shared_exclusive"
  | "unsafe_unshareable";

export type MCPResourceOwnershipPolicy =
  | "bflow_managed"
  | "external_adopted"
  | "external_remote"
  | "exclusive_lease_bound";

export type MCPReconnectBehavior =
  | "reinitialize_session"
  | "stateless_retry"
  | "quarantine_on_disconnect"
  | "fail_closed";

export interface MCPBackendSharingPolicy {
  readonly transportCapabilities: MCPTransportCapabilities;
  readonly concurrencyModel: MCPConcurrencyModel;
  readonly sessionIsolationPolicy: MCPSessionIsolationPolicy;
  readonly sharedStatePolicy: MCPSharedStatePolicy;
  readonly resourceOwnership: MCPResourceOwnershipPolicy;
  readonly reconnectBehavior: MCPReconnectBehavior;
  readonly browserAffecting?: boolean;
  readonly mutatingTools?: readonly string[];
  readonly readOnlyTools?: readonly string[];
  readonly maxMemoryBytes?: number;
  readonly maxQueueSize?: number;
  readonly callTimeoutMs?: number;
}

export interface RegisteredMCPServiceEntry {
  readonly definition: MCPServiceDefinition;
  readonly policy: MCPBackendSharingPolicy;
  readonly configDigest: string;
  readonly registeredAt: string;
}

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

export type MCPUpstreamJsonObject = Readonly<Record<string, JsonValue>>;

/** MCP Tool definition as advertised by an upstream server, restricted to MCP Tool fields. */
export interface MCPUpstreamToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: MCPUpstreamJsonObject;
  readonly outputSchema?: MCPUpstreamJsonObject;
  readonly annotations?: MCPUpstreamJsonObject;
}

export interface MCPUpstreamToolList {
  readonly definitions: readonly MCPUpstreamToolDefinition[];
  /** Names whose upstream definition omitted inputSchema (gateway substituted an empty object schema). */
  readonly defaultedInputSchemaTools: readonly string[];
}

export interface MCPUpstreamInitializeResult {
  readonly protocolVersion: string;
  readonly discoveredTools: readonly string[];
  readonly toolDefinitions?: readonly MCPUpstreamToolDefinition[];
  readonly defaultedInputSchemaTools?: readonly string[];
  readonly serverInfo?: {
    readonly name: string;
    readonly version: string;
  };
}

export interface MCPUpstreamToolCallInput {
  readonly sessionId: string;
  readonly clientId: string;
  readonly requestId: string;
  readonly callId?: string | undefined;
  readonly tool: string;
  readonly arguments: JsonValue;
  readonly fencingToken?: number;
  readonly resourceKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface MCPUpstreamToolCallOutput {
  readonly isError?: boolean;
  readonly content: JsonValue;
}

export interface MCPUpstreamReconcileResult {
  readonly status: "completed" | "failed" | "not_delivered" | "unknown";
  readonly output?: JsonValue;
}

export interface MCPUpstreamDriverInstance {
  readonly instanceId: string;
  readonly pid?: number;
  readonly startGeneration: number;
  readonly ownership: "bflow" | "external";
  initialize(options?: OperationOptions): Promise<OperationResult<MCPUpstreamInitializeResult>>;
  listTools(sessionId: string, options?: OperationOptions): Promise<OperationResult<readonly string[]>>;
  listToolDefinitions?(sessionId: string, options?: OperationOptions): Promise<OperationResult<MCPUpstreamToolList>>;
  callTool(input: MCPUpstreamToolCallInput): Promise<OperationResult<MCPUpstreamToolCallOutput>>;
  cancelRequest?(requestId: string, reason?: string): Promise<void>;
  reconcileRequest?(callId: string, requestId: string): Promise<MCPUpstreamReconcileResult>;
  getMemoryRssBytes?(): Promise<number>;
  isAlive(): boolean;
  stop(reason?: string): Promise<void>;
  onCrash(listener: (reason: string) => void): () => void;
}

export interface MCPUpstreamDriverFactory {
  createInstance(
    entry: RegisteredMCPServiceEntry,
    partitionKey: string,
    startGeneration: number
  ): Promise<OperationResult<MCPUpstreamDriverInstance>>;
}

/** Events of the Gateway's HTTP client to a remote upstream (never carries credentials or payloads). */
export type UpstreamHttpEvent =
  | "request"
  | "retry"
  | "rate_limited"
  | "auth_failure"
  | "network_error"
  | "timeout"
  | "protocol_error"
  | "upstream_error"
  | "session_started"
  | "session_reinitialized";
export type UpstreamHttpCounters = Readonly<Record<UpstreamHttpEvent, number>>;
export const UPSTREAM_HTTP_EVENTS: readonly UpstreamHttpEvent[] = [
  "request", "retry", "rate_limited", "auth_failure", "network_error", "timeout", "protocol_error",
  "upstream_error", "session_started", "session_reinitialized"
];

export interface ServiceMetricsSnapshot {
  readonly serviceId: string;
  /** Present only for services that made remote HTTP requests. */
  readonly upstreamHttp?: UpstreamHttpCounters;
  readonly activeInstances: number;
  readonly activeProcesses: number;
  readonly memoryRssBytes: number;
  readonly activeClients: number;
  readonly activeCalls: number;
  readonly queuedCalls: number;
  readonly totalCalls: number;
  readonly failedCalls: number;
  readonly timedOutCalls: number;
  readonly cancelledCalls: number;
  readonly unknownCalls: number;
  readonly backpressureRejections: number;
  readonly restartCount: number;
  readonly latency: {
    readonly count: number;
    readonly minMs: number;
    readonly maxMs: number;
    readonly avgMs: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
  };
}

export interface GatewayMetricsSnapshot {
  readonly activeProcessCount: number;
  readonly maxProcessCount: number;
  readonly processLimitRejections: number;
  readonly totalMemoryRssBytes: number;
  readonly maxMemoryBytes: number;
  readonly memoryLimitTerminations: number;
  readonly activeClientConnections: number;
  readonly activeSessions: number;
  readonly activeToolCalls: number;
  readonly queuedToolCalls: number;
  readonly backpressureRejections: number;
  readonly totalToolCalls: number;
  readonly failedToolCalls: number;
  readonly timedOutToolCalls: number;
  readonly cancelledToolCalls: number;
  readonly unknownToolCalls: number;
  readonly latency: {
    readonly count: number;
    readonly minMs: number;
    readonly maxMs: number;
    readonly avgMs: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
  };
  readonly perService: Readonly<Record<string, ServiceMetricsSnapshot>>;
}

export interface GatewayAuditEntry {
  readonly auditId: string;
  readonly timestamp: string;
  readonly action:
    | "client.register"
    | "client.revoke"
    | "client.disconnect"
    | "service.ensure"
    | "service.start"
    | "service.stop"
    | "service.restart"
    | "resource.acquire"
    | "resource.renew"
    | "resource.release"
    | "tool.call"
    | "tool.reconcile"
    | "security.violation"
    | "interactive.blocked";
  readonly registrationId?: string;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly provider?: AgentProviderId;
  readonly role?: AgentRole;
  readonly scope?: TrustScope;
  readonly serviceId?: string;
  readonly configDigest?: string;
  readonly callId?: string;
  readonly leaseId?: string;
  readonly fencingToken?: number;
  readonly status: "succeeded" | "failed" | "blocked" | "unknown";
  readonly diagnosticCode: string;
  readonly message: string;
}

export interface ActiveClientSession {
  readonly sessionId: string;
  readonly registrationId: string;
  readonly registration: MCPClientRegistration;
  readonly createdAt: string;
  lastActiveAt: string;
  connected: boolean;
}

export interface RecordedCallLedgerEntry {
  readonly call: MCPToolCall;
  readonly requestId: string;
  readonly sessionId: string;
  readonly partitionKey: string;
  readonly instanceId: string;
  readonly fingerprint: string;
  readonly mutating: boolean;
  readonly dispatchedToUpstream: boolean;
  result: MCPToolCallResult;
}

export interface ExtendedMCPServiceManager {
  ensure(
    service: MCPServiceDefinition,
    operation: ScopedOperation,
    options?: (OperationOptions & { readonly clientId?: string | undefined }) | undefined
  ): Promise<OperationResult<MCPServiceObservation>>;
  inspect(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>>;
  release(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>>;
  start(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>>;
  stop(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>>;
  restart(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>>;
  status(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>>;
  health(
    serviceId: string,
    operation: ScopedOperation,
    options?: OperationOptions
  ): Promise<OperationResult<MCPServiceObservation>>;
}

export function ok<T>(value: T): OperationResult<T> {
  return { ok: true, value };
}

export function err<T = never>(error: ContractError): OperationResult<T> {
  return { ok: false, error };
}
