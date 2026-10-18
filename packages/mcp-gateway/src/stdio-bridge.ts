import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type {
  ContractError,
  JsonValue,
  OperationOptions,
  OperationResult
} from "@bflow/contracts";
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  MCPUpstreamDriverFactory,
  MCPUpstreamDriverInstance,
  MCPUpstreamInitializeResult,
  MCPUpstreamReconcileResult,
  MCPUpstreamToolCallInput,
  MCPUpstreamToolCallOutput,
  MCPUpstreamToolList,
  RegisteredMCPServiceEntry
} from "./types.js";
import { DEFAULT_MCP_PROTOCOL_VERSION, err, ok } from "./types.js";
import { isInteractiveMethodForbidden } from "./security.js";
import { normalizeUpstreamToolList } from "./tool-definitions.js";
import type { GatewaySecretStore } from "./security.js";
import { readLinuxProcessRssBytes } from "./metrics.js";

export interface StdioToHttpBridgeOptions {
  readonly instanceId: string;
  readonly startGeneration: number;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream | undefined;
  readonly pid?: number;
  readonly maxFrameBytes?: number | undefined;
  readonly maxPendingWrites?: number | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly onStop?: ((reason?: string) => Promise<void> | void) | undefined;
}

interface PendingRequest {
  readonly upstreamId: string;
  readonly clientRequestId: string;
  readonly callId?: string | undefined;
  readonly sessionId: string;
  readonly isToolCall: boolean;
  readonly resolve: (res: JsonRpcResponse) => void;
  readonly reject: (err: ContractError) => void;
  timeoutTimer?: NodeJS.Timeout | undefined;
}

/**
 * Bridges HTTP/Gateway requests to an upstream stdio MCP process using newline-delimited JSON-RPC 2.0.
 * Enforces frame size limits, backpressure, request remapping, and blocking of interactive prompts.
 */
export class StdioToHttpBridge implements MCPUpstreamDriverInstance {
  readonly instanceId: string;
  readonly startGeneration: number;
  readonly pid?: number;
  readonly ownership = "bflow" as const;

  private readonly stdin: NodeJS.WritableStream;
  private readonly stdout: NodeJS.ReadableStream;
  private readonly maxFrameBytes: number;
  private readonly maxPendingWrites: number;
  private readonly defaultTimeoutMs: number;
  private readonly onStopCallback?: ((reason?: string) => Promise<void> | void) | undefined;

  private alive = true;
  private requestSeq = 0;
  private pendingWrites = 0;
  private incomingBuffer = "";

  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly clientRequestToUpstreamId = new Map<string, string>();
  private readonly callIdToUpstreamId = new Map<string, string>();
  private readonly reconcileLedger = new Map<string, MCPUpstreamReconcileResult>();
  private readonly timedOutUpstreamRequests = new Map<
    string,
    { readonly clientRequestId: string; readonly callId?: string | undefined }
  >();
  private readonly crashListeners = new Set<(reason: string) => void>();

  constructor(options: StdioToHttpBridgeOptions) {
    this.instanceId = options.instanceId;
    this.startGeneration = options.startGeneration;
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    if (options.pid !== undefined) {
      this.pid = options.pid;
    }
    this.maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024; // 4MB default
    this.maxPendingWrites = options.maxPendingWrites ?? 128;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.onStopCallback = options.onStop;

    this.setupStreams(options.stderr);
  }

  private setupStreams(stderr?: NodeJS.ReadableStream): void {
    this.stdout.on("data", (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.incomingBuffer += str;

      if (
        Buffer.byteLength(this.incomingBuffer, "utf8") > this.maxFrameBytes &&
        !this.incomingBuffer.includes("\n")
      ) {
        this.triggerCrash("frame_size_exceeded");
        return;
      }

      let newlineIndex: number;
      while ((newlineIndex = this.incomingBuffer.indexOf("\n")) !== -1) {
        const line = this.incomingBuffer.slice(0, newlineIndex).trim();
        this.incomingBuffer = this.incomingBuffer.slice(newlineIndex + 1);

        if (line.length === 0) {
          continue;
        }

        if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
          this.triggerCrash("frame_size_exceeded");
          return;
        }

        this.handleInboundLine(line);
      }
    });

    this.stdout.on("end", () => {
      if (this.alive) {
        this.triggerCrash("stdout_closed");
      }
    });

    this.stdout.on("error", (err: Error) => {
      if (this.alive) {
        this.triggerCrash(`stdout_error: ${err.message}`);
      }
    });

    if (stderr) {
      stderr.on("data", () => {
        // Collect stderr silently or consume stream to avoid process blocking
      });
    }
  }

  private handleInboundLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (parseError) {
      this.triggerCrash(`malformed_json_frame: ${String(parseError)}`);
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      return;
    }

    const msg = parsed as Record<string, unknown>;

    if (typeof msg.method === "string") {
      this.handleInboundMethod(msg as unknown as JsonRpcRequest);
      return;
    }

    if ("id" in msg && msg.id !== undefined && msg.id !== null) {
      this.handleInboundResponse(msg as unknown as JsonRpcResponse);
      return;
    }
  }

  private handleInboundMethod(msg: JsonRpcRequest): void {
    if (isInteractiveMethodForbidden(msg.method)) {
      if (msg.id !== undefined && msg.id !== null) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32000,
            message: "Interactive user prompt blocked by Bflow Gateway; route via Conversation"
          }
        };
        this.writeRaw(JSON.stringify(errorResponse)).catch(() => {});
      }

      const blockedError: ContractError = {
        code: "validation",
        retryable: false,
        message: `Upstream attempted forbidden interactive method '${msg.method}'; route decision via Runtime -> Herdr -> Conversation`,
        details: {
          diagnosticCode: "interactive_prompt_blocked",
          method: msg.method
        } as unknown as JsonValue
      };

      for (const [upstreamId, pending] of this.pendingRequests.entries()) {
        if (pending.isToolCall) {
          if (pending.timeoutTimer) {
            clearTimeout(pending.timeoutTimer);
          }
          pending.reject(blockedError);
          this.reconcileLedger.set(pending.clientRequestId, {
            status: "failed",
            output: blockedError as unknown as JsonValue
          });
          this.pendingRequests.delete(upstreamId);
          this.clientRequestToUpstreamId.delete(pending.clientRequestId);
          if (pending.callId) {
            this.callIdToUpstreamId.delete(pending.callId);
          }
        }
      }
    }
  }

  private handleInboundResponse(msg: JsonRpcResponse): void {
    const upstreamId = String(msg.id);
    const pending = this.pendingRequests.get(upstreamId);
    if (!pending) {
      const timedOut = this.timedOutUpstreamRequests.get(upstreamId);
      if (timedOut) {
        this.timedOutUpstreamRequests.delete(upstreamId);
        const resultObj = msg.result as { isError?: boolean; content?: JsonValue } | undefined;
        const isError = Boolean(msg.error) || Boolean(resultObj?.isError);
        const output = (msg.error ?? resultObj?.content ?? (msg.result ?? null)) as JsonValue;
        const outcome: MCPUpstreamReconcileResult = {
          status: isError ? "failed" : "completed",
          output
        };
        this.reconcileLedger.set(timedOut.clientRequestId, outcome);
        if (timedOut.callId) {
          this.reconcileLedger.set(timedOut.callId, outcome);
        }
      }
      return;
    }

    this.pendingRequests.delete(upstreamId);
    this.clientRequestToUpstreamId.delete(pending.clientRequestId);
    if (pending.callId) {
      this.callIdToUpstreamId.delete(pending.callId);
    }
    if (pending.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
    }

    pending.resolve(msg);
  }

  private async writeRaw(line: string): Promise<void> {
    if (!this.alive) {
      throw new Error("Stdio bridge is not alive");
    }
    this.pendingWrites++;
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      let onDrain: (() => void) | undefined;
      let onError: ((err: Error) => void) | undefined;

      const cleanupAndFinish = (err?: Error) => {
        if (finished) return;
        finished = true;
        if (onDrain) (this.stdin as any).removeListener?.("drain", onDrain);
        if (onError) (this.stdin as any).removeListener?.("error", onError);
        this.pendingWrites = Math.max(0, this.pendingWrites - 1);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const flushed = this.stdin.write(line + "\n", "utf8", (error) => {
        if (error) {
          cleanupAndFinish(error);
        } else {
          cleanupAndFinish();
        }
      });

      if (!flushed) {
        onDrain = () => cleanupAndFinish();
        onError = (err: Error) => cleanupAndFinish(err);
        (this.stdin as any).once?.("drain", onDrain);
        (this.stdin as any).once?.("error", onError);
      }
    });
  }

  private async sendJsonRpcRequest(
    sessionId: string,
    method: string,
    params?: unknown,
    options?: {
      timeoutMs?: number | undefined;
      signal?: AbortSignal | undefined;
      clientRequestId?: string | undefined;
      callId?: string | undefined;
      isToolCall?: boolean | undefined;
    }
  ): Promise<OperationResult<JsonRpcResponse>> {
    if (!this.alive) {
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: "Stdio bridge is stopped or dead"
      });
    }

    if (options?.signal?.aborted) {
      return err({
        code: "cancelled",
        retryable: false,
        message: "Request was aborted before execution"
      });
    }

    if (this.pendingWrites >= this.maxPendingWrites) {
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: "Stdio bridge write backpressure limit reached"
      });
    }

    const upstreamId = `gw_${this.startGeneration}_${++this.requestSeq}_${sessionId}`;
    const clientReqId = options?.clientRequestId ?? upstreamId;

    this.clientRequestToUpstreamId.set(clientReqId, upstreamId);
    if (options?.callId) {
      this.callIdToUpstreamId.set(options.callId, upstreamId);
    }

    return new Promise<OperationResult<JsonRpcResponse>>((resolve) => {
      let timeoutTimer: NodeJS.Timeout | undefined;
      const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
      let writtenToStdin = false;

      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          this.pendingRequests.delete(upstreamId);
          this.clientRequestToUpstreamId.delete(clientReqId);
          if (options?.callId) {
            this.callIdToUpstreamId.delete(options.callId);
          }
          if (writtenToStdin) {
            this.timedOutUpstreamRequests.set(upstreamId, {
              clientRequestId: clientReqId,
              ...(options?.callId !== undefined ? { callId: options.callId } : {})
            });
            this.reconcileLedger.set(clientReqId, { status: "unknown" });
            if (options?.callId) {
              this.reconcileLedger.set(options.callId, { status: "unknown" });
            }
          } else {
            this.reconcileLedger.set(clientReqId, { status: "not_delivered" });
            if (options?.callId) {
              this.reconcileLedger.set(options.callId, { status: "not_delivered" });
            }
          }
          resolve(
            err({
              code: "timeout",
              retryable: true,
              retrySafety: writtenToStdin ? "observation_only" : "not_started",
              message: `Request '${method}' timed out after ${timeoutMs}ms`
            })
          );
        }, timeoutMs);
      }

      const abortHandler = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        this.pendingRequests.delete(upstreamId);
        this.clientRequestToUpstreamId.delete(clientReqId);
        if (options?.callId) {
          this.callIdToUpstreamId.delete(options.callId);
        }
        if (writtenToStdin) {
          this.timedOutUpstreamRequests.set(upstreamId, {
            clientRequestId: clientReqId,
            ...(options?.callId !== undefined ? { callId: options.callId } : {})
          });
          this.reconcileLedger.set(clientReqId, { status: "unknown" });
          if (options?.callId) {
            this.reconcileLedger.set(options.callId, { status: "unknown" });
          }
          this.sendCancelNotification(upstreamId, "Client aborted signal").catch(() => {});
        } else {
          this.reconcileLedger.set(clientReqId, { status: "not_delivered" });
          if (options?.callId) {
            this.reconcileLedger.set(options.callId, { status: "not_delivered" });
          }
        }
        resolve(
          err({
            code: "cancelled",
            retryable: false,
            message: "Request aborted by signal"
          })
        );
      };

      if (options?.signal) {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      const pending: PendingRequest = {
        upstreamId,
        clientRequestId: clientReqId,
        sessionId,
        isToolCall: options?.isToolCall ?? false,
        timeoutTimer,
        ...(options?.callId !== undefined ? { callId: options.callId } : {}),
        resolve: (rpcRes) => {
          if (options?.signal) {
            options.signal.removeEventListener("abort", abortHandler);
          }
          resolve(ok(rpcRes));
        },
        reject: (contractErr) => {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
          }
          if (options?.signal) {
            options.signal.removeEventListener("abort", abortHandler);
          }
          resolve(err(contractErr));
        }
      };

      this.pendingRequests.set(upstreamId, pending);

      const rpcMessage: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: upstreamId as JsonRpcId,
        method,
        ...(params !== undefined ? { params: params as Record<string, unknown> } : {})
      };

      this.writeRaw(JSON.stringify(rpcMessage))
        .then(() => {
          writtenToStdin = true;
        })
        .catch((writeError) => {
          this.pendingRequests.delete(upstreamId);
          this.clientRequestToUpstreamId.delete(clientReqId);
          if (options?.callId) {
            this.callIdToUpstreamId.delete(options.callId);
          }
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
          }
          if (options?.signal) {
            options.signal.removeEventListener("abort", abortHandler);
          }
          this.reconcileLedger.set(clientReqId, { status: "not_delivered" });
          if (options?.callId) {
            this.reconcileLedger.set(options.callId, { status: "not_delivered" });
          }
          resolve(
            err({
              code: "transport_unavailable",
              retryable: true,
              message: `Failed to write to stdio bridge: ${String(writeError)}`
            })
          );
        });
    });
  }

  private async sendCancelNotification(upstreamId: string, reason?: string): Promise<void> {
    const cancelNotif = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: {
        requestId: upstreamId,
        reason: reason ?? "cancelled"
      }
    };
    try {
      await this.writeRaw(JSON.stringify(cancelNotif));
    } catch {
      // Ignore write errors during cancellation notification
    }
  }

  async initialize(
    options?: OperationOptions
  ): Promise<OperationResult<MCPUpstreamInitializeResult>> {
    const initParams = {
      protocolVersion: DEFAULT_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "bflow-gateway",
        version: "0.1.0"
      }
    };

    const initRes = await this.sendJsonRpcRequest("init", "initialize", initParams, {
      timeoutMs: options?.timeoutMs
    });

    if (!initRes.ok) {
      return err(initRes.error);
    }

    if (initRes.value.error) {
      return err({
        code: "validation",
        retryable: false,
        message: `Upstream initialization failed: ${initRes.value.error.message}`,
        details: initRes.value.error as unknown as JsonValue
      });
    }

    const initializedNotif: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    };

    try {
      await this.writeRaw(JSON.stringify(initializedNotif));
    } catch (error) {
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: `Failed to send initialized notification: ${String(error)}`
      });
    }

    const listRes = await this.listToolDefinitions("init", options);
    if (!listRes.ok) {
      return err(listRes.error);
    }

    const resultObj = initRes.value.result as
      | {
          protocolVersion?: string;
          serverInfo?: { name: string; version: string };
        }
      | undefined;

    const negotiatedVersion =
      typeof resultObj?.protocolVersion === "string"
        ? resultObj.protocolVersion
        : DEFAULT_MCP_PROTOCOL_VERSION;

    return ok({
      protocolVersion: negotiatedVersion,
      discoveredTools: listRes.value.definitions.map(definition => definition.name),
      toolDefinitions: listRes.value.definitions,
      defaultedInputSchemaTools: listRes.value.defaultedInputSchemaTools,
      ...(resultObj?.serverInfo ? { serverInfo: resultObj.serverInfo } : {})
    });
  }

  async listTools(
    sessionId: string,
    options?: OperationOptions
  ): Promise<OperationResult<readonly string[]>> {
    const listRes = await this.listToolDefinitions(sessionId, options);
    if (!listRes.ok) {
      return err(listRes.error);
    }
    return ok(listRes.value.definitions.map(definition => definition.name));
  }

  async listToolDefinitions(
    sessionId: string,
    options?: OperationOptions
  ): Promise<OperationResult<MCPUpstreamToolList>> {
    const res = await this.sendJsonRpcRequest(sessionId, "tools/list", {}, {
      timeoutMs: options?.timeoutMs
    });

    if (!res.ok) {
      return err(res.error);
    }

    if (res.value.error) {
      return err({
        code: "validation",
        retryable: false,
        message: `Upstream tools/list failed: ${res.value.error.message}`,
        details: res.value.error as unknown as JsonValue
      });
    }

    return normalizeUpstreamToolList(res.value.result);
  }

  async callTool(
    input: MCPUpstreamToolCallInput
  ): Promise<OperationResult<MCPUpstreamToolCallOutput>> {
    const meta: Record<string, unknown> = {
      sessionId: input.sessionId,
      clientId: input.clientId,
      requestId: input.requestId,
      ...(input.callId !== undefined ? { callId: input.callId } : {})
    };
    if (input.fencingToken !== undefined) {
      meta.fencingToken = input.fencingToken;
    }
    if (input.resourceKey !== undefined) {
      meta.resourceKey = input.resourceKey;
    }

    const params: Record<string, unknown> = {
      name: input.tool,
      arguments: input.arguments,
      _meta: meta
    };

    const res = await this.sendJsonRpcRequest(input.sessionId, "tools/call", params, {
      clientRequestId: input.requestId,
      ...(input.callId !== undefined ? { callId: input.callId } : {}),
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      isToolCall: true
    });

    if (!res.ok) {
      if (!this.reconcileLedger.has(input.requestId)) {
        this.reconcileLedger.set(input.requestId, { status: "not_delivered" });
      }
      if (input.callId && !this.reconcileLedger.has(input.callId)) {
        this.reconcileLedger.set(input.callId, { status: "not_delivered" });
      }
      return err(res.error);
    }

    if (res.value.error) {
      this.reconcileLedger.set(input.requestId, {
        status: "failed",
        output: res.value.error as unknown as JsonValue
      });
      if (input.callId) {
        this.reconcileLedger.set(input.callId, {
          status: "failed",
          output: res.value.error as unknown as JsonValue
        });
      }
      return err({
        code: "validation",
        retryable: false,
        message: `Upstream tools/call failed: ${res.value.error.message}`,
        details: res.value.error as unknown as JsonValue
      });
    }

    const resultObj = res.value.result as
      | {
          isError?: boolean;
          content?: JsonValue;
        }
      | undefined;

    const isError = Boolean(resultObj?.isError);
    const content =
      resultObj?.content !== undefined
        ? resultObj.content
        : ((res.value.result ?? null) as JsonValue);

    this.reconcileLedger.set(input.requestId, {
      status: isError ? "failed" : "completed",
      output: content
    });
    if (input.callId) {
      this.reconcileLedger.set(input.callId, {
        status: isError ? "failed" : "completed",
        output: content
      });
    }

    return ok({
      isError,
      content
    });
  }

  async cancelRequest(requestId: string, reason?: string): Promise<void> {
    const upstreamId = this.clientRequestToUpstreamId.get(requestId);
    if (!upstreamId) {
      return;
    }

    await this.sendCancelNotification(upstreamId, reason);

    const pending = this.pendingRequests.get(upstreamId);
    if (pending) {
      this.pendingRequests.delete(upstreamId);
      this.clientRequestToUpstreamId.delete(requestId);
      if (pending.callId) {
        this.callIdToUpstreamId.delete(pending.callId);
      }
      if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
      }
      pending.reject({
        code: "cancelled",
        retryable: false,
        message: reason ?? "Request cancelled by host"
      });
    }
  }

  async reconcileRequest(
    callId: string,
    requestId: string
  ): Promise<MCPUpstreamReconcileResult> {
    const byCallId = this.reconcileLedger.get(callId);
    if (byCallId) {
      return byCallId;
    }
    const byReqId = this.reconcileLedger.get(requestId);
    if (byReqId) {
      return byReqId;
    }

    const upstreamId =
      this.clientRequestToUpstreamId.get(requestId) ?? this.callIdToUpstreamId.get(callId);
    if (upstreamId && this.pendingRequests.has(upstreamId)) {
      return { status: "unknown" };
    }

    return { status: "not_delivered" };
  }

  triggerCrash(reason: string): void {
    if (!this.alive) {
      return;
    }
    this.alive = false;

    const crashError: ContractError = {
      code: "transport_unavailable",
      retryable: true,
      message: `Upstream stdio process crashed: ${reason}`
    };

    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
      }
      pending.reject(crashError);
      this.reconcileLedger.set(pending.clientRequestId, { status: "unknown" });
      if (pending.callId) {
        this.reconcileLedger.set(pending.callId, { status: "unknown" });
      }
    }
    this.pendingRequests.clear();
    this.clientRequestToUpstreamId.clear();
    this.callIdToUpstreamId.clear();

    for (const listener of this.crashListeners) {
      try {
        listener(reason);
      } catch {
        // Ignore listener error
      }
    }
  }

  isAlive(): boolean {
    return this.alive;
  }

  async stop(reason?: string): Promise<void> {
    if (!this.alive) {
      return;
    }
    this.alive = false;

    const stopError: ContractError = {
      code: "transport_unavailable",
      retryable: true,
      message: `Upstream stdio driver stopped: ${reason ?? "stopped by host"}`
    };

    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
      }
      pending.reject(stopError);
    }
    this.pendingRequests.clear();
    this.clientRequestToUpstreamId.clear();
    this.callIdToUpstreamId.clear();

    if (this.onStopCallback) {
      try {
        await this.onStopCallback(reason);
      } catch {
        // Ignore stop callback error
      }
    }
  }

  onCrash(listener: (reason: string) => void): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  async getMemoryRssBytes(): Promise<number> {
    if (this.pid !== undefined && this.pid > 0) {
      return readLinuxProcessRssBytes(this.pid);
    }
    return 0;
  }
}

export interface SubprocessStdioDriverFactoryOptions {
  readonly verifyExecutableDigest?: boolean | undefined;
  readonly secretStore?: GatewaySecretStore | undefined;
  readonly defaultTimeoutMs?: number | undefined;
}

/**
 * Factory for creating StdioToHttpBridge instances by spawning child processes.
 */
export class SubprocessStdioDriverFactory implements MCPUpstreamDriverFactory {
  constructor(private readonly options?: SubprocessStdioDriverFactoryOptions | undefined) {}

  async createInstance(
    entry: RegisteredMCPServiceEntry,
    partitionKey: string,
    startGeneration: number
  ): Promise<OperationResult<MCPUpstreamDriverInstance>> {
    if (entry.definition.connection.kind !== "stdio_mcp") {
      return err({
        code: "validation",
        retryable: false,
        message: "SubprocessStdioDriverFactory only supports stdio_mcp connection kind"
      });
    }

    const conn = entry.definition.connection;

    if (this.options?.verifyExecutableDigest) {
      try {
        const realExec = await fs.promises.realpath(conn.executable);
        const st = await fs.promises.stat(realExec);
        if (!st.isFile()) {
          return err({
            code: "validation",
            retryable: false,
            message: `Executable '${conn.executable}' is not a regular file`,
            details: { diagnosticCode: "executable_not_file" }
          });
        }
        if ((st.mode & 0o111) === 0) {
          return err({
            code: "validation",
            retryable: false,
            message: `Executable '${conn.executable}' lacks execute permission`,
            details: { diagnosticCode: "executable_not_executable" }
          });
        }
        if ((st.mode & 0o022) !== 0) {
          return err({
            code: "validation",
            retryable: false,
            message: `Executable '${conn.executable}' is group or world writable`,
            details: { diagnosticCode: "executable_insecure_permissions" }
          });
        }
        const fileBytes = await fs.promises.readFile(realExec);
        const digest = createHash("sha256").update(fileBytes).digest("hex");
        if (digest !== conn.executableDigest) {
          return err({
            code: "corruption",
            retryable: false,
            message: `Executable digest mismatch for '${conn.executable}': expected ${conn.executableDigest}, got ${digest}`
          });
        }
      } catch (readError) {
        return err({
          code: "validation",
          retryable: false,
          message: `Failed to inspect executable for digest verification: ${String(readError)}`
        });
      }
    }

    const safeBaseEnvKeys = [
      "PATH",
      "HOME",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "USER",
      "NODE_ENV",
      "SYSTEMROOT"
    ];
    const resolvedEnv: Record<string, string> = {};
    for (const key of safeBaseEnvKeys) {
      const val = process.env[key];
      if (val !== undefined) {
        resolvedEnv[key] = val;
      }
    }

    for (const [envKey, secretRef] of Object.entries(conn.environmentBindings)) {
      const secretValue = this.options?.secretStore?.getSecret(secretRef);
      if (secretValue === undefined) {
        return err({
          code: "validation",
          retryable: false,
          message: `Missing secret binding for environment variable '${envKey}'`,
          details: { diagnosticCode: "missing_secret_binding", envKey }
        });
      }
      resolvedEnv[envKey] = secretValue;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(conn.executable, conn.argv as string[], {
        stdio: ["pipe", "pipe", "pipe"],
        env: resolvedEnv
      });
    } catch (spawnError) {
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: `Failed to spawn stdio MCP child process: ${String(spawnError)}`
      });
    }

    if (!child.stdin || !child.stdout) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: "Failed to establish child stdio pipes"
      });
    }

    const instanceId = `${entry.definition.serviceId}:${partitionKey}:${startGeneration}`;

    const bridge = new StdioToHttpBridge({
      instanceId,
      startGeneration,
      stdin: child.stdin,
      stdout: child.stdout,
      ...(child.stderr ? { stderr: child.stderr } : {}),
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      ...(entry.policy.transportCapabilities.maxFrameBytes !== undefined
        ? { maxFrameBytes: entry.policy.transportCapabilities.maxFrameBytes }
        : {}),
      ...(this.options?.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: this.options.defaultTimeoutMs }
        : {}),
      onStop: async (_reason) => {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      }
    });

    child.on("error", (error) => {
      bridge.triggerCrash(`Child process error: ${error.message}`);
    });

    child.on("exit", (code, signal) => {
      bridge.triggerCrash(`Child process exited with code ${code}, signal ${signal}`);
    });

    return ok(bridge);
  }
}
