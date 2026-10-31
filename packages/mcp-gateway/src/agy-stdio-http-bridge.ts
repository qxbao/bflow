import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { IdentifierSchema, MCPEndpointSchema, MCPToolCallResultSchema } from "@bflow/contracts";

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface AgyGatewayBridgeOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly endpoint: string;
  readonly registrationId: string;
  readonly serviceIds: readonly string[];
  readonly bearerToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxLineBytes?: number;
}

interface GatewayResponse {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

const MAX_ACTIVE = 32;
const MAX_BODY_BYTES = 4 *  1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const MCP_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

export const agyStdioHttpCliPath = fileURLToPath(new URL("./agy-stdio-http-cli.js", import.meta.url));

/** A private stdio MCP client for Agy that reaches only its authenticated Gateway registration. */
export class AgyStdioHttpGatewayBridge {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly sessionNonce = randomUUID();
  private readonly toolServices = new Map<string, string>();
  private readonly calls = new Map<string, AbortController>();
  private readonly remoteCalls = new Map<string, string>();
  private readonly activeIds = new Set<string>();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly lifecycle = new AbortController();
  private initializeAttempted = false;
  private gatewaySessionId: string | undefined;
  private protocolVersion: string | undefined;
  private initialized = false;
  private closed = false;
  private writeTail: Promise<void> = Promise.resolve();
  private outputQueuedBytes = 0;
  private handshakeTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: AgyGatewayBridgeOptions) {
    if (!MCPEndpointSchema.safeParse(options.endpoint).success)
      throw new Error("Agy Gateway bridge endpoint is invalid");
    if (!IdentifierSchema.safeParse(options.registrationId).success)
      throw new Error("Agy Gateway bridge registration id is invalid");
    if (options.serviceIds.length === 0 || options.serviceIds.some(id => !IdentifierSchema.safeParse(id).success) ||
        new Set(options.serviceIds).size !== options.serviceIds.length)
      throw new Error("Agy Gateway bridge service ids are invalid");
    if (options.bearerToken.length === 0 || /[\r\n\0]/.test(options.bearerToken))
      throw new Error("Agy Gateway bridge bearer token is missing or invalid");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1)
      throw new Error("Agy Gateway bridge line limit is invalid");
  }

  async run(): Promise<void> {
    let pending = Buffer.alloc(0);
    let discardingOversizedLine = false;
    try {
      for await (const chunk of this.options.input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.length) {
          const newline = bytes.indexOf(0x0a, offset);
          const end = newline < 0 ? bytes.length : newline;
          const piece = bytes.subarray(offset, end);
          if (!discardingOversizedLine) {
            if (pending.length + piece.length > this.maxLineBytes) {
              pending = Buffer.alloc(0);
              discardingOversizedLine = true;
            } else {
              pending = pending.length ? Buffer.concat([pending, piece], pending.length + piece.length) : Buffer.from(piece);
            }
          }
          if (newline >= 0) {
            if (discardingOversizedLine) {
              await this.admitTask(() => this.write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP request exceeds size limit" } }));
            } else {
              let line = pending;
              if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
              pending = Buffer.alloc(0);
              await this.admitLine(line.toString("utf8"));
            }
            discardingOversizedLine = false;
          }
          offset = newline < 0 ? bytes.length : newline + 1;
        }
      }
      // EOF terminates an unfinished frame; it is never parsed as a complete request.
    } finally {
      this.lifecycle.abort(new Error("Agy Gateway bridge input closed"));
      for (const controller of this.calls.values()) controller.abort(new Error("Agy Gateway bridge closed"));
      await Promise.allSettled([...this.activeTasks]);
      await this.writeTail.catch(() => undefined);
      await this.closeGatewaySession();
      this.closed = true;
    }
  }

  private async admitLine(line: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" ||
          (value.id !== undefined && !isRpcId(value.id)) ||
          (value.params !== undefined && !isRecord(value.params))) return;
      request = value as JsonRpcRequest;
    } catch {
      return;
    }
    const key = request.id === undefined ? undefined : rpcIdKey(request.id);
    if (request.method === "notifications/cancelled") {
      await this.dispatch(request);
      return;
    }
    // Reject excess work before dispatch so a saturated peer can still send cancellation.
    if (this.activeTasks.size >= MAX_ACTIVE) {
      if (request.id !== undefined) await this.write({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Gateway bridge request capacity reached" } });
      return;
    }
    if (key && this.activeIds.has(key)) {
      await this.write({ jsonrpc: "2.0", id: request.id, error: { code: -32600, message: "Request id is already active" } });
      return;
    }
    if (key) this.activeIds.add(key);
    const task = this.dispatch(request).catch(async () => {
      if (request.id !== undefined)
        await this.write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Agy Gateway bridge request failed" } });
    }).catch(() => undefined).finally(() => {
      if (key) this.activeIds.delete(key);
      this.activeTasks.delete(task);
    });
    this.activeTasks.add(task);
  }

  private async admitTask(taskBody: () => Promise<void>): Promise<void> {
    while (this.activeTasks.size >= MAX_ACTIVE) await Promise.race(this.activeTasks);
    const task = taskBody().catch(() => undefined).finally(() => this.activeTasks.delete(task));
    this.activeTasks.add(task);
  }

  private async dispatch(request: JsonRpcRequest): Promise<void> {
    const id = request.id;
    if (request.method === "server/discover") {
      if (id !== undefined) await this.write({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (request.method === "notifications/roots/list_changed") return;
    if (request.method === "notifications/cancelled") {
      const requestedId = request.params?.requestId;
      if (isRpcId(requestedId)) {
        const key = rpcIdKey(requestedId);
        this.calls.get(key)?.abort(new Error("MCP request cancelled"));
        const remoteId = this.remoteCalls.get(key);
        if (remoteId) await this.notifyGatewayCancellation(remoteId);
      }
      return;
    }
    if (request.method === "ping") {
      if (id !== undefined) await this.write({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (request.method === "initialize" || request.method === "notifications/initialized" || request.method === "tools/list") {
      // Handshake transitions share a queue: initialize completes before notification and discovery.
      const previous = this.handshakeTail;
      let release!: () => void;
      this.handshakeTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        if (request.method === "initialize") await this.initialize(request);
        else if (request.method === "notifications/initialized") await this.initializedNotification(request);
        else await this.listTools(request);
      } finally { release(); }
      return;
    }
    if (id === undefined) return;
    if (request.method === "tools/call") {
      await this.callTool(request);
      return;
    }
    await this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Gateway method is unavailable" } });
  }

  private async initialize(request: JsonRpcRequest): Promise<void> {
    const id = request.id;
    if (id === undefined) return;
    const params = request.params;
    if (!params || typeof params.protocolVersion !== "string" || !MCP_PROTOCOL_VERSIONS.has(params.protocolVersion)) {
      await this.write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unsupported MCP protocol version" } });
      return;
    }
    if (this.initializeAttempted) {
      await this.write({ jsonrpc: "2.0", id, error: { code: -32600, message: "Gateway initialization was already attempted" } });
      return;
    }
    this.initializeAttempted = true;
    const response = await this.gatewayRequest(request);
    if (response.error !== undefined || !isRecord(response.result) || typeof response.result.protocolVersion !== "string" ||
        !MCP_PROTOCOL_VERSIONS.has(response.result.protocolVersion)) {
      await this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Gateway MCP initialization failed" } });
      return;
    }
    this.protocolVersion = response.result.protocolVersion;
    this.initialized = false;
    await this.write({ jsonrpc: "2.0", id, result: response.result });
  }

  private async initializedNotification(request: JsonRpcRequest): Promise<void> {
    if (!this.protocolVersion) return;
    const response = await this.gatewayRequest(request, undefined, true);
    this.initialized = response.error === undefined;
  }

  private async listTools(request: JsonRpcRequest): Promise<void> {
    const id = request.id;
    if (id === undefined) return;
    if (!this.initialized) {
      await this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: "MCP session is not initialized" } });
      return;
    }
    const response = await this.gatewayRequest(request);
    const result = isRecord(response.result) ? response.result : undefined;
    if (response.error !== undefined || !result || !Array.isArray(result.tools)) {
      await this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Gateway tool discovery failed" } });
      return;
    }
    const next = new Map<string, string>();
    for (const item of result.tools) {
      if (!isRecord(item) || !IdentifierSchema.safeParse(item.name).success ||
          !IdentifierSchema.safeParse(item.serviceId).success || !this.options.serviceIds.includes(item.serviceId)) {
        await this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Gateway returned invalid or out-of-scope tools" } });
        return;
      }
      if (next.has(item.name)) {
        await this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Gateway returned ambiguous tool names" } });
        return;
      }
      next.set(item.name, item.serviceId);
    }
    this.toolServices.clear();
    for (const [name, serviceId] of next) this.toolServices.set(name, serviceId);
    await this.write({ jsonrpc: "2.0", id, result: { tools: result.tools } });
  }

  private async callTool(request: JsonRpcRequest): Promise<void> {
    const id = request.id;
    if (id === undefined) return;
    const params = request.params;
    const args = params?.arguments ?? {};
    if (!this.initialized || !params || typeof params.name !== "string" || !isRecord(args)) {
      await this.write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Malformed Gateway tool call" } });
      return;
    }
    const serviceId = this.toolServices.get(params.name);
    if (!serviceId || !this.options.serviceIds.includes(serviceId) ||
        (params.serviceId !== undefined && params.serviceId !== serviceId)) {
      await this.write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Gateway tool is outside the registered service scope" } });
      return;
    }

    const localKey = rpcIdKey(id);
    const remoteId = this.remoteId(id);
    const callId = `agy-${randomUUID()}`;
    const controller = new AbortController();
    this.calls.set(localKey, controller);
    this.remoteCalls.set(localKey, remoteId);
    try {
      this.lifecycle.signal.throwIfAborted();
      const response = await this.fetchImpl(this.options.endpoint, {
        method: "POST", redirect: "error", headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id: remoteId, method: "tools/call", params: {
          name: params.name, arguments: args, serviceId, callId, idempotencyKey: `agy-${randomUUID()}`, timeoutMs: this.timeoutMs
        } }),
        signal: AbortSignal.any([this.lifecycle.signal, controller.signal, AbortSignal.timeout(this.timeoutMs)])
      });
      const raw: unknown = await readJsonBounded(response);
      if (!response.ok || !isRecord(raw) || raw.jsonrpc !== "2.0" || raw.id !== remoteId || raw.error !== undefined) {
        await this.write(toolError(id, `Gateway tool call failed (HTTP ${response.status})`));
        return;
      }
      const parsed = MCPToolCallResultSchema.safeParse(raw.result);
      if (!parsed.success || parsed.data.callId !== callId) {
        await this.write(toolError(id, "Gateway returned a malformed or mismatched tool call result"));
        return;
      }
      const unwrapped = unwrapGatewayToolOutput(parsed.data.output);
      await this.write({ jsonrpc: "2.0", id, result: {
        isError: parsed.data.status !== "completed" || unwrapped.innerIsError,
        content: parsed.data.status === "unknown"
          ? [{ type: "text", text: `Gateway outcome is unknown; do not retry this mutation. ${unwrapped.content[0]?.text ?? ""}` }]
          : unwrapped.content,
        ...(parsed.data.status !== "unknown" && unwrapped.structuredContent !== undefined
          ? { structuredContent: unwrapped.structuredContent }
          : {})
      } });
    } catch {
      await this.write(toolError(id, "Gateway tool call failed or was cancelled; outcome may be unknown. Do not retry a mutation."));
    } finally {
      this.calls.delete(localKey);
      this.remoteCalls.delete(localKey);
    }
  }

  private async gatewayRequest(request: JsonRpcRequest, signal?: AbortSignal, notification = false): Promise<GatewayResponse> {
    this.lifecycle.signal.throwIfAborted();
    const remoteId = request.id === undefined ? undefined : this.remoteId(request.id);
    const response = await this.fetchImpl(this.options.endpoint, {
      method: "POST", redirect: "error", headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", ...(remoteId === undefined ? {} : { id: remoteId }), method: request.method,
        ...(request.params ? { params: request.params } : {}) }),
      signal: AbortSignal.any([this.lifecycle.signal, signal ?? new AbortController().signal, AbortSignal.timeout(this.timeoutMs)])
    });
    if (request.method === "initialize") this.gatewaySessionId = response.headers.get("mcp-session-id") ?? undefined;
    if (notification && (response.status === 202 || response.ok)) return {};
    const raw: unknown = await readJsonBounded(response);
    if (!response.ok || !isRecord(raw) || raw.jsonrpc !== "2.0" || raw.id !== remoteId) return { error: { message: "Gateway request failed" } };
    return raw;
  }

  private async notifyGatewayCancellation(remoteId: string): Promise<void> {
    if (!this.gatewaySessionId) return;
    await this.fetchImpl(this.options.endpoint, {
      method: "POST", redirect: "error", headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: remoteId } }),
      signal: AbortSignal.timeout(1_000)
    }).then(response => response.body?.cancel()).catch(() => undefined);
  }

  private headers(): HeadersInit {
    return {
      "Content-Type": "application/json", Accept: "application/json",
      Authorization: `Bearer ${this.options.bearerToken}`,
      ...(this.gatewaySessionId ? { "Mcp-Session-Id": this.gatewaySessionId } : {}),
      ...(this.protocolVersion ? { "Mcp-Protocol-Version": this.protocolVersion } : {})
    };
  }

  private remoteId(id: string | number): string {
    return `${this.options.registrationId}-${this.sessionNonce}-${typeof id === "number" ? "n" : "s"}-${String(id)}`;
  }

  private async closeGatewaySession(): Promise<void> {
    const sessionId = this.gatewaySessionId;
    this.gatewaySessionId = undefined;
    if (!sessionId) return;
    await this.fetchImpl(this.options.endpoint, {
      method: "DELETE", redirect: "error",
      headers: { Authorization: `Bearer ${this.options.bearerToken}`, "Mcp-Session-Id": sessionId },
      signal: AbortSignal.timeout(1_000)
    }).then(response => response.body?.cancel()).catch(() => undefined);
  }

  private async write(value: unknown): Promise<void> {
    if (this.closed) return;
    let line = `${JSON.stringify(value)}\n`;
    let bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_OUTPUT_BYTES) {
      const id = isRecord(value) && isRpcId(value.id) ? value.id : null;
      line = `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Gateway result exceeds delivery limit; reconcile before retrying a mutation" } })}\n`;
      bytes = Buffer.byteLength(line, "utf8");
    }
    if (this.outputQueuedBytes + bytes > MAX_OUTPUT_BYTES * MAX_ACTIVE) throw new Error("Gateway output capacity reached");
    this.outputQueuedBytes += bytes;
    const write = this.writeTail.then(async () => {
      if (this.closed) return;
      if (this.options.output.destroyed || this.options.output.writableEnded) throw new Error("Gateway output is closed");
      if (!this.options.output.write(line)) await waitForDrain(this.options.output, Math.min(this.timeoutMs, 5_000));
    });
    this.writeTail = write.catch(() => undefined).finally(() => { this.outputQueuedBytes -= bytes; });
    await write;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function rpcIdKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function toolError(id: string | number, message: string): unknown {
  return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: message }] } };
}

const STRUCTURED_ENVELOPE_KEYS = new Set(["content", "structuredContent", "isError", "_meta"]);

function unwrapGatewayToolOutput(output: unknown): {
  readonly content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  readonly structuredContent?: unknown;
  readonly innerIsError: boolean;
} {
  if (
    isRecord(output) &&
    Object.keys(output).every(key => STRUCTURED_ENVELOPE_KEYS.has(key)) &&
    ("structuredContent" in output ||
      (Array.isArray(output.content) && output.content.every(item => isRecord(item) && typeof item.type === "string")))
  ) {
    const rawContent = "content" in output ? output.content : output.structuredContent;
    return {
      content: toolContent(rawContent),
      ...(output.structuredContent !== undefined ? { structuredContent: output.structuredContent } : {}),
      innerIsError: output.isError === true
    };
  }
  return { content: toolContent(output), innerIsError: false };
}

function toolContent(output: unknown): Array<{ type: string; text?: string; [key: string]: unknown }> {
  if (Array.isArray(output) && output.every(item => isRecord(item) && typeof item.type === "string"))
    return output;
  return [{ type: "text", text: JSON.stringify(output) ?? "null" }];
}

async function readJsonBounded(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8")); }
  catch { return undefined; }
}

async function waitForDrain(output: Writable, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => onError(new Error("Gateway output closed before drain"));
    const timer = setTimeout(() => onError(new Error("Gateway output drain deadline exceeded")), timeoutMs);
    const cleanup = () => { clearTimeout(timer); output.off("drain", onDrain); output.off("error", onError); output.off("close", onClose); };
    output.once("drain", onDrain);
    output.once("error", onError);
    output.once("close", onClose);
  });
}

export async function runAgyStdioHttpGatewayBridge(options: Omit<AgyGatewayBridgeOptions, "input" | "output" | "bearerToken"> & {
  readonly tokenEnvironmentName: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly input?: Readable;
  readonly output?: Writable;
}): Promise<void> {
  const environment = options.environment ?? process.env;
  const token = environment[options.tokenEnvironmentName];
  if (!token) throw new Error("Agy Gateway bridge token environment variable is missing");
  await new AgyStdioHttpGatewayBridge({ ...options, input: options.input ?? process.stdin, output: options.output ?? process.stdout, bearerToken: token }).run();
}
