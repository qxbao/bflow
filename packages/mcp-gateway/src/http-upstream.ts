import { randomUUID } from "node:crypto";
import type { ContractError, OperationOptions, OperationResult } from "@bflow/contracts";
import type { GatewayMetricsCollector } from "./metrics.js";
import type { GatewaySecretStore } from "./security.js";
import { normalizeUpstreamToolList } from "./tool-definitions.js";
import type {
  MCPUpstreamDriverInstance,
  MCPUpstreamInitializeResult,
  MCPUpstreamReconcileResult,
  MCPUpstreamToolCallInput,
  MCPUpstreamToolCallOutput,
  MCPUpstreamToolList,
  RegisteredMCPServiceEntry,
  UpstreamHttpEvent
} from "./types.js";
import { DEFAULT_MCP_PROTOCOL_VERSION, err, ok } from "./types.js";

/** Why an upstream HTTP request failed, carried in `ContractError.details.kind`. */
export type UpstreamFailureKind =
  | "auth_missing"
  | "auth_rejected"
  | "rate_limited"
  | "network"
  | "timeout"
  | "protocol"
  | "upstream_http"
  | "session_lost"
  | "cancelled";

export interface UpstreamRetryPolicy {
  /** Total attempts including the first one. 1 disables retry. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Fraction of the delay added or removed at random, 0..1. */
  readonly jitter: number;
  /** A Retry-After longer than this is not waited for; the caller gets `rate_limited` with `retryAfterMs`. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_UPSTREAM_RETRY_POLICY: UpstreamRetryPolicy = {
  maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000, jitter: 0.2, maxRetryAfterMs: 10_000
};

export interface HttpUpstreamOptions {
  readonly retry?: Partial<UpstreamRetryPolicy>;
  readonly metrics?: GatewayMetricsCollector | undefined;
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests; resolves early when the signal aborts. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  /** Upper bound for one response body, JSON or event stream. */
  readonly maxResponseBytes?: number;
}

interface RpcResponse {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly result?: any;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

interface RequestSpec {
  readonly body: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /** Safe to send again after an indeterminate failure. Notifications and read-only tools qualify. */
  readonly idempotent: boolean;
  /** Skips the lazy session handshake (used by the handshake itself). */
  readonly handshake?: boolean;
  readonly expectBody?: boolean;
}

class UpstreamFailure extends Error {
  constructor(
    readonly kind: UpstreamFailureKind,
    message: string,
    readonly extra: { status?: number; retryAfterMs?: number; attempts: number; retryable: boolean }
  ) {
    super(message);
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });

/** Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds, or undefined. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), 86_400) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/**
 * Reads the JSON-RPC message with the given id from a `text/event-stream` body. Other events (pings,
 * notifications, server requests) are ignored. The stream is cancelled once the answer is found.
 */
export async function readSseResponse(body: ReadableStream<Uint8Array>, id: string | number, maxBytes: number): Promise<RpcResponse | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error("Response exceeded the size limit");
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        let message: RpcResponse;
        try { message = JSON.parse(data) as RpcResponse; } catch { continue; }
        if (message && message.id !== undefined && message.id !== null && String(message.id) === String(id)
          && (message.result !== undefined || message.error !== undefined)) return message;
      }
    }
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Driver for a remote MCP server reached over Streamable HTTP, shared by every registered agent.
 *
 * - Speaks the protocol: `Accept` lists JSON and SSE, the negotiated protocol version is echoed, and an
 *   `Mcp-Session-Id` returned by the server is kept and sent back. A server that issues no session id is
 *   treated as stateless. When a server drops a session (HTTP 404) the handshake is repeated once.
 * - The upstream session is shared across agents. Authorization stays in the Gateway (per-registration
 *   service and tool grants); the upstream sees one Gateway client.
 * - Retries with exponential backoff and jitter, honouring Retry-After, only for requests that are safe to
 *   send twice: handshake, discovery and tools the host's policy lists read-only. Other calls run once, so an
 *   ambiguous failure is never replayed.
 * - Failures are structured in `error.details` (`kind`, `status`, `retryAfterMs`, `attempts`). The
 *   credential is never placed in an error, a log line or a metric.
 */
export class HttpUpstreamDriverInstance implements MCPUpstreamDriverInstance {
  readonly instanceId: string;
  readonly pid?: number;
  readonly startGeneration: number;
  readonly ownership: "bflow" | "external";
  private stopped = false;
  private readonly crashListeners = new Set<(reason: string) => void>();
  private readonly retry: UpstreamRetryPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly maxResponseBytes: number;
  private sessionId: string | undefined;
  private protocolVersion: string = DEFAULT_MCP_PROTOCOL_VERSION;
  private initialized = false;
  private handshake: Promise<void> | undefined;
  private readonly inFlight = new Map<string, AbortController>();
  private nextId = 1;

  constructor(
    readonly entry: RegisteredMCPServiceEntry,
    readonly partitionKey: string,
    startGeneration: number,
    private readonly secretStore: GatewaySecretStore,
    private readonly options: HttpUpstreamOptions = {}
  ) {
    this.startGeneration = startGeneration;
    this.ownership = entry.definition.connection.ownership;
    this.instanceId = `${entry.definition.serviceId}-http-${startGeneration}-${randomUUID().slice(0, 8)}`;
    this.retry = { ...DEFAULT_UPSTREAM_RETRY_POLICY, ...options.retry };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
  }

  isAlive(): boolean {
    return !this.stopped;
  }

  async stop(reason?: string): Promise<void> {
    this.stopped = true;
    for (const controller of this.inFlight.values()) controller.abort(new Error("Upstream driver stopped"));
    this.inFlight.clear();
    if (this.sessionId) {
      // Best effort: tell the server this session is over. A server without session support answers 405.
      const sessionId = this.sessionId;
      this.sessionId = undefined;
      try {
        await this.fetchImpl(this.endpoint(), { method: "DELETE", headers: { ...this.baseHeaders(), "Mcp-Session-Id": sessionId },
          redirect: "error", signal: AbortSignal.timeout(2_000) });
      } catch { /* the session is abandoned either way */ }
    }
    if (reason && reason.includes("crash")) {
      for (const listener of this.crashListeners) {
        try { listener(reason); } catch { /* ignore listener errors */ }
      }
    }
  }

  onCrash(listener: (reason: string) => void): () => void {
    this.crashListeners.add(listener);
    return () => { this.crashListeners.delete(listener); };
  }

  async getMemoryRssBytes(): Promise<number> {
    return 0;
  }

  private endpoint(): string {
    const connection = this.entry.definition.connection;
    if (connection.kind === "existing_shared_worker" || connection.kind === "native_remote_mcp") return connection.endpoint;
    throw new Error(`Invalid connection kind for HTTP driver: ${connection.kind}`);
  }

  private count(event: UpstreamHttpEvent): void {
    this.options.metrics?.recordUpstreamHttp(this.entry.definition.serviceId, event);
  }

  /** Headers that never change for this upstream. Throws `auth_missing` when a configured credential is absent. */
  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocolVersion
    };
    const auth = this.entry.definition.authentication;
    if (auth.mode === "bearer" || auth.mode === "oauth") {
      const token = this.secretStore.getSecret(auth.credential);
      if (!token) {
        throw new UpstreamFailure("auth_missing", `Credential ${auth.credential} is configured for this service but unavailable`,
          { attempts: 0, retryable: false });
      }
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  private toError(failure: UpstreamFailure): ContractError {
    const details = { kind: failure.kind, attempts: failure.extra.attempts,
      ...(failure.extra.status !== undefined ? { status: failure.extra.status } : {}),
      ...(failure.extra.retryAfterMs !== undefined ? { retryAfterMs: failure.extra.retryAfterMs } : {}) };
    switch (failure.kind) {
      case "timeout":
        return { code: "timeout", retryable: true, retrySafety: "observation_only", message: failure.message, details };
      case "cancelled":
        return { code: "cancelled", retryable: false, message: failure.message, details };
      case "auth_missing":
      case "auth_rejected":
        return { code: "validation", retryable: false, message: failure.message, details };
      case "protocol":
        return { code: "corruption", retryable: false, message: failure.message, details };
      default:
        return { code: "transport_unavailable", retryable: true, message: failure.message, details };
    }
  }

  private backoffMs(attempt: number): number {
    const raw = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    const spread = raw * this.retry.jitter;
    return Math.max(0, Math.round(raw - spread + this.random() * spread * 2));
  }

  /**
   * The Gateway aborts a call's signal when the call's own timeout expires, which can happen before this driver's timer for the
   * same duration. An abort whose reason names a timeout is a timeout, not a cancellation, so retry guidance and metrics stay right.
   */
  private abortFailure(signal: AbortSignal | undefined, attempt: number): UpstreamFailure {
    const reason = signal?.reason;
    const text = reason instanceof Error ? `${reason.name} ${reason.message}` : String(reason ?? "");
    return /time(?:d)?[ -]?out/i.test(text)
      ? new UpstreamFailure("timeout", "Upstream request timed out", { attempts: attempt, retryable: true })
      : new UpstreamFailure("cancelled", "Upstream request was cancelled", { attempts: attempt, retryable: false });
  }

  /** One HTTP exchange; throws an UpstreamFailure describing the outcome. */
  private async exchange(spec: RequestSpec, attempt: number, remainingMs: number): Promise<RpcResponse | null> {
    if (spec.signal?.aborted) throw this.abortFailure(spec.signal, attempt);
    const controller = new AbortController();
    const requestId = spec.body["id"] as string | number | undefined;
    const trackKey = requestId === undefined ? undefined : String(requestId);
    if (trackKey) this.inFlight.set(trackKey, controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("Timeout")); }, Math.max(1, remainingMs));
    const onAbort = () => controller.abort(spec.signal?.reason ?? new Error("Aborted"));
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const headers = this.baseHeaders();
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
      this.count("request");
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint(), { method: "POST", headers, body: JSON.stringify(spec.body),
          signal: controller.signal, redirect: "error" });
      } catch (error) {
        if (error instanceof UpstreamFailure) throw error;
        if (timedOut) throw new UpstreamFailure("timeout", "Upstream request timed out", { attempts: attempt, retryable: true });
        // The controller is aborted only by the caller's signal, cancelRequest, stop() or the timeout handled above.
        if (controller.signal.aborted) throw this.abortFailure(spec.signal, attempt);
        throw new UpstreamFailure("network", `Upstream connection failed: ${(error as { cause?: { code?: string } })?.cause?.code ?? (error instanceof Error ? error.name : "error")}`,
          { attempts: attempt, retryable: true });
      }
      const status = response.status;
      if (status === 401 || status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamFailure("auth_rejected", `Upstream rejected the credential (HTTP ${status})`, { status, attempts: attempt, retryable: false });
      }
      if (status === 404 && this.sessionId) {
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamFailure("session_lost", "Upstream session is no longer valid", { status, attempts: attempt, retryable: true });
      }
      if (status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.now());
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamFailure("rate_limited", "Upstream rate limit reached (HTTP 429)",
          { status, attempts: attempt, retryable: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
      }
      if (status >= 500) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.now());
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamFailure("upstream_http", `Upstream server error (HTTP ${status})`,
          { status, attempts: attempt, retryable: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamFailure("protocol", `Upstream refused the request (HTTP ${status})`, { status, attempts: attempt, retryable: false });
      }
      const issued = response.headers.get("mcp-session-id");
      if (issued && issued !== this.sessionId) { this.sessionId = issued; this.count("session_started"); }
      if (spec.expectBody === false) { await response.body?.cancel().catch(() => undefined); return null; }
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      try {
        if (type.includes("text/event-stream")) {
          if (!response.body) throw new Error("empty event stream");
          return await readSseResponse(response.body, requestId ?? "", this.maxResponseBytes);
        }
        const text = await response.text();
        if (text.length > this.maxResponseBytes) throw new Error("Response exceeded the size limit");
        return text.trim() ? JSON.parse(text) as RpcResponse : null;
      } catch (error) {
        if (timedOut) throw new UpstreamFailure("timeout", "Upstream response timed out", { attempts: attempt, retryable: true });
        if (spec.signal?.aborted) throw this.abortFailure(spec.signal, attempt);
        throw new UpstreamFailure("protocol", `Upstream sent an unreadable response: ${error instanceof Error ? error.message : "error"}`,
          { attempts: attempt, retryable: false });
      }
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      if (trackKey) this.inFlight.delete(trackKey);
    }
  }

  /** Sends a request, retrying only what is safe, and reports metrics for each outcome. */
  private async send(spec: RequestSpec): Promise<RpcResponse | null> {
    const deadline = this.now() + spec.timeoutMs;
    let sessionRetried = false;
    for (let attempt = 1; ; attempt++) {
      if (!spec.handshake) await this.ensureSession(spec.signal);
      try {
        return await this.exchange(spec, attempt, deadline - this.now());
      } catch (error) {
        if (!(error instanceof UpstreamFailure)) throw error;
        this.recordFailure(error);
        if (error.kind === "session_lost" && !sessionRetried && !spec.handshake) {
          // The server rejected the session before processing the request, so replaying is safe.
          sessionRetried = true;
          this.initialized = false; this.sessionId = undefined; this.handshake = undefined;
          this.count("session_reinitialized");
          attempt--;
          continue;
        }
        const retryable = error.extra.retryable && spec.idempotent && attempt < this.retry.maxAttempts;
        if (!retryable) throw error;
        const wait = Math.max(error.extra.retryAfterMs ?? 0, this.backoffMs(attempt));
        if ((error.extra.retryAfterMs ?? 0) > this.retry.maxRetryAfterMs || this.now() + wait >= deadline) throw error;
        this.count("retry");
        await this.sleep(wait, spec.signal);
        if (spec.signal?.aborted) throw this.abortFailure(spec.signal, attempt);
      }
    }
  }

  private recordFailure(error: UpstreamFailure): void {
    switch (error.kind) {
      case "rate_limited": this.count("rate_limited"); break;
      case "auth_missing": case "auth_rejected": this.count("auth_failure"); break;
      case "network": this.count("network_error"); break;
      case "timeout": this.count("timeout"); break;
      case "protocol": this.count("protocol_error"); break;
      case "upstream_http": this.count("upstream_error"); break;
      default: break;
    }
  }

  /**
   * Single-flight initialize + notifications/initialized. Concurrent callers share one handshake, so it must not depend on
   * any one caller: it runs on the service's own health timeout and without a caller's signal. A caller that is cancelled
   * while waiting stops waiting; the handshake itself continues for the others.
   */
  private async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    if (signal?.aborted) throw new UpstreamFailure("cancelled", "Upstream request was cancelled", { attempts: 0, retryable: false });
    this.handshake ??= this.performHandshake(this.entry.definition.healthTimeoutMs).finally(() => { this.handshake = undefined; });
    if (!signal) { await this.handshake; return; }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new UpstreamFailure("cancelled", "Upstream request was cancelled", { attempts: 0, retryable: false }));
      signal.addEventListener("abort", onAbort, { once: true });
      this.handshake!.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private async performHandshake(timeoutMs: number): Promise<void> {
    const id = this.nextId++;
    const response = await this.send({ handshake: true, idempotent: true, timeoutMs, signal: undefined,
      body: { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: DEFAULT_MCP_PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: "bflow-gateway", version: "0.1.0" } } } });
    if (!response || response.error || !response.result) {
      throw new UpstreamFailure("protocol", `Upstream initialize failed: ${response?.error?.message ?? "no result"}`, { attempts: 1, retryable: false });
    }
    if (typeof response.result.protocolVersion === "string") this.protocolVersion = response.result.protocolVersion;
    this.lastInitialize = response.result;
    // The session is usable only after the server has been told the client is initialized. Marking it earlier would let
    // concurrent callers send requests before the notification, and a failed notification would never be retried.
    await this.send({ handshake: true, idempotent: true, timeoutMs, signal: undefined, expectBody: false,
      body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    this.initialized = true;
  }
  private lastInitialize: { protocolVersion?: string; serverInfo?: { name: string; version: string } } | undefined;

  private fail<T>(error: unknown): OperationResult<T> {
    if (error instanceof UpstreamFailure) return err(this.toError(error));
    return err({ code: "transport_unavailable", retryable: true, message: error instanceof Error ? error.message : String(error) });
  }

  async initialize(options?: OperationOptions): Promise<OperationResult<MCPUpstreamInitializeResult>> {
    try {
      this.initialized = false; this.sessionId = undefined; this.handshake = undefined;
      await this.ensureSession(options?.signal);
      const listed = await this.listToolDefinitions("init", options);
      if (!listed.ok) return err(listed.error);
      const serverInfo = this.lastInitialize?.serverInfo;
      return ok({
        protocolVersion: this.protocolVersion,
        discoveredTools: listed.value.definitions.map(definition => definition.name),
        toolDefinitions: listed.value.definitions,
        defaultedInputSchemaTools: listed.value.defaultedInputSchemaTools,
        ...(serverInfo ? { serverInfo } : {})
      });
    } catch (error) {
      return this.fail(error);
    }
  }

  async listTools(sessionId: string, options?: OperationOptions): Promise<OperationResult<readonly string[]>> {
    const listed = await this.listToolDefinitions(sessionId, options);
    return listed.ok ? ok(listed.value.definitions.map(definition => definition.name)) : err(listed.error);
  }

  async listToolDefinitions(_sessionId: string, options?: OperationOptions): Promise<OperationResult<MCPUpstreamToolList>> {
    const timeoutMs = options?.timeoutMs ?? this.entry.definition.healthTimeoutMs;
    try {
      const id = this.nextId++;
      const response = await this.send({ idempotent: true, timeoutMs, signal: options?.signal,
        body: { jsonrpc: "2.0", id, method: "tools/list", params: {} } });
      if (!response) return err({ code: "corruption", retryable: false, message: "Upstream tools/list returned no response", details: { kind: "protocol" } });
      if (response.error) {
        return err({ code: "validation", retryable: false, message: `Upstream tools/list failed: ${String(response.error.message ?? "error")}`, details: { kind: "protocol" } });
      }
      return normalizeUpstreamToolList(response.result);
    } catch (error) {
      return this.fail(error);
    }
  }

  /**
   * A tool is safe to replay only when the host's own policy lists it read-only. A server's `readOnlyHint` annotation is
   * advice from the party being called and is deliberately not trusted: it is the same rule the Gateway applies when it
   * decides whether a failed call is an uncertain write.
   */
  private isReplayable(tool: string): boolean {
    return this.entry.policy.readOnlyTools?.includes(tool) ?? false;
  }

  async callTool(input: MCPUpstreamToolCallInput): Promise<OperationResult<MCPUpstreamToolCallOutput>> {
    const timeoutMs = input.timeoutMs ?? this.entry.policy.callTimeoutMs ?? 60_000;
    try {
      const response = await this.send({ idempotent: this.isReplayable(input.tool), timeoutMs, signal: input.signal,
        body: { jsonrpc: "2.0", id: input.requestId, method: "tools/call", params: { name: input.tool, arguments: input.arguments } } });
      if (!response) return err({ code: "corruption", retryable: false, message: "Upstream tools/call returned no response", details: { kind: "protocol" } });
      if (response.error) return ok({ isError: true, content: response.error.message ?? (response.error as never) });
      return ok({ isError: Boolean(response.result?.isError), content: response.result?.content ?? response.result ?? null });
    } catch (error) {
      return this.fail(error);
    }
  }

  async cancelRequest(requestId: string, _reason?: string): Promise<void> {
    this.inFlight.get(requestId)?.abort(new Error("Cancelled"));
  }

  async reconcileRequest(_callId: string, _requestId: string): Promise<MCPUpstreamReconcileResult> {
    return { status: "unknown" };
  }
}
