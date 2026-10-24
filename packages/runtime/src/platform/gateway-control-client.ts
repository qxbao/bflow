import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { ContractErrorSchema, IdentifierSchema, MCPClientRegistrationSchema, MCPEndpointSchema, MCPServiceObservationSchema, MCPToolCallSchema, MCPToolCallResultSchema,
  ScopedOperationSchema, TrustScopeSchema, ResolvedToolGrantSchema } from "@bflow/contracts";
import type { ContractError, MCPClientRegistration, MCPServiceObservation, OperationOptions, OperationResult,
  MCPToolCall, MCPToolCallResult, ScopedOperation, TrustScope, ResolvedToolGrant } from "@bflow/contracts";
import { fail, failWith, ok } from "./errors.js";
import type { GatewayControlPort, GatewayRegistrationGrant } from "./ports.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_LOCATOR_BYTES = 4096;
const MAX_SOCKET_PATH_BYTES = 100;
const LOCATOR_KEYS = ["socketPath", "token", "generation", "endpoint"] as const;

/** Mirrors the control endpoint locator written by the Gateway daemon (apps/cli). Strict: unknown keys are refused. */
interface Locator {
  readonly socketPath: string;
  readonly token: string;
  readonly generation: string;
  readonly endpoint: string;
}

/** Structural parser shape shared by contract schemas, so this package needs no direct zod dependency. */
interface Parser<T> {
  safeParse(input: unknown): { readonly success: true; readonly data: T } | { readonly success: false };
}

type Reply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: ContractError };

/**
 * Runtime-side client for the Gateway control endpoint. Stateless between calls; each call is one connection
 * carrying one newline-delimited request. The bearer token is returned to the caller and never logged here.
 */
export class GatewayControlClient implements GatewayControlPort {
  private constructor(private readonly locator: Locator) {}

  /** Loads the private locator. Refuses symlinks, group/world-accessible files and files owned by another user. */
  static async fromLocator(path: string): Promise<OperationResult<GatewayControlClient>> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) return fail("validation", "Gateway control locator must be a regular file");
      if ((info.mode & 0o077) !== 0) return fail("validation", "Gateway control locator must not be readable by group or others");
      const uid = process.getuid?.();
      if (uid !== undefined && info.uid !== uid) return fail("validation", "Gateway control locator must be owned by the current user");
      if (info.size > MAX_LOCATOR_BYTES) return fail("validation", "Gateway control locator is too large");
      const locator = parseLocator(JSON.parse(await readFile(path, "utf8")));
      if (!locator) return fail("corruption", "Gateway control locator is malformed");
      return ok(new GatewayControlClient(locator));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fail("transport_unavailable", "Gateway control locator is absent; start the Gateway");
      if (error instanceof SyntaxError) return fail("corruption", "Gateway control locator is not valid JSON");
      return fail("validation", "Gateway control locator cannot be read");
    }
  }

  async register(registration: MCPClientRegistration, options?: OperationOptions, grants?: readonly ResolvedToolGrant[]):
    Promise<OperationResult<GatewayRegistrationGrant>> {
    const sent = MCPClientRegistrationSchema.safeParse(registration);
    if (!sent.success) return fail("validation", "Invalid Gateway client registration");
    const parsedGrants = (grants ?? []).map(grant => ResolvedToolGrantSchema.safeParse(grant));
    if (parsedGrants.some(grant => !grant.success) || parsedGrants.some(grant => {
      if (!grant.success) return true;
      const value = grant.data;
      return value.kind === "cli_only" || value.role !== sent.data.role || value.scope.kind !== "session" ||
        value.scope.sessionId !== sent.data.scope.sessionId || value.scope.repositoryId !== sent.data.scope.repositoryId ||
        value.scope.workspaceRoot !== sent.data.scope.workspaceRoot || !value.serviceId ||
        sent.data.serviceIds.length !== 1 || value.serviceId !== sent.data.serviceIds[0] ||
        value.operations.some(operation => !sent.data.allowedTools.includes(operation));
    })) return fail("validation", "Resolved Gateway grants do not match the exact registration scope, service and operations");
    const reply = await this.call("register", { client: sent.data,
      ...(grants === undefined ? {} : { toolGrants: parsedGrants.map(grant => grant.success ? grant.data : undefined) }) }, options);
    if (!reply.ok) return reply;
    const value = reply.value;
    if (!isRecord(value) || !hasExactKeys(value, ["registration", "token"]) || typeof value.token !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.token)) {
      return fail("corruption", "Gateway registration reply is malformed");
    }
    const echoed = MCPClientRegistrationSchema.safeParse(value.registration);
    if (!echoed.success) return fail("corruption", "Gateway registration reply is malformed");
    return ok({ registration: echoed.data, bearerToken: value.token });
  }

  async revoke(registrationId: string, operation: ScopedOperation, options?: OperationOptions): Promise<OperationResult<void>> {
    const id = IdentifierSchema.safeParse(registrationId);
    const parsedOperation = ScopedOperationSchema.safeParse(operation);
    if (!id.success || !parsedOperation.success) return fail("validation", "Invalid Gateway revoke request");
    const reply = await this.call("revoke", { registrationId: id.data, operation: parsedOperation.data }, options);
    if (!reply.ok) return reply;
    return reply.value === null ? ok(undefined) : fail("corruption", "Gateway revoke reply is malformed");
  }

  async list(scope: TrustScope, options?: OperationOptions): Promise<OperationResult<readonly MCPClientRegistration[]>> {
    const parsedScope = TrustScopeSchema.safeParse(scope);
    if (!parsedScope.success) return fail("validation", "Invalid Gateway list scope");
    const reply = await this.call("list", { scope: parsedScope.data }, options);
    if (!reply.ok) return reply;
    const listed = parseArray(reply.value, "registrations", MCPClientRegistrationSchema);
    return listed ? ok(listed) : fail("corruption", "Gateway list reply is malformed");
  }

  async inspectServices(operation: ScopedOperation, options?: OperationOptions):
    Promise<OperationResult<readonly MCPServiceObservation[]>> {
    const parsedOperation = ScopedOperationSchema.safeParse(operation);
    if (!parsedOperation.success) return fail("validation", "Invalid Gateway catalog request");
    const reply = await this.call("catalog", { operation: parsedOperation.data }, options);
    if (!reply.ok) return reply;
    const observed = parseArray(reply.value, "observations", MCPServiceObservationSchema);
    return observed ? ok(observed) : fail("corruption", "Gateway catalog reply is malformed");
  }

  async invokeTool(call: MCPToolCall, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>> {
    return this.toolCall("invoke_tool", call, options);
  }

  async reconcileToolCall(call: MCPToolCall, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>> {
    return this.toolCall("reconcile_tool_call", call, options);
  }

  private async toolCall(method: string, request: MCPToolCall, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>> {
    const parsed = MCPToolCallSchema.safeParse(request);
    if (!parsed.success) return fail("validation", "Invalid Gateway MCP tool call");
    const reply = await this.call(method, { call: parsed.data }, options);
    if (!reply.ok) return reply;
    const result = MCPToolCallResultSchema.safeParse(reply.value);
    return result.success && result.data.callId === parsed.data.callId
      ? ok(result.data) : fail("corruption", "Gateway MCP tool result is malformed or mismatched");
  }

  private async call(method: string, params: unknown, options?: OperationOptions): Promise<Reply> {
    const request = { schemaVersion: 3, id: randomUUID(), token: this.locator.token, generation: this.locator.generation,
      method, params };
    const reply = await this.exchange(request, options);
    if (!reply.ok) return reply;
    const parsed = parseReply(reply.value);
    if (!parsed) return fail("corruption", "Gateway control reply is malformed");
    return parsed;
  }

  /**
   * Connect and write failures are `transport_unavailable`: nothing was sent. Once the request is written, a timeout
   * or a close before reply is `timeout` with observation_only retry safety, because the Gateway may have applied it.
   */
  private exchange(request: unknown, options?: OperationOptions): Promise<OperationResult<unknown>> {
    return new Promise(resolve => {
      if (options?.signal?.aborted) {
        resolve(fail("cancelled", "Gateway control call was cancelled"));
        return;
      }
      let written = false;
      let settled = false;
      let buffer = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      let socket: Socket | undefined;
      const finish = (result: OperationResult<unknown>): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        socket?.destroy();
        resolve(result);
      };
      const uncertain = (message: string): OperationResult<unknown> => failWith({ code: "timeout", retryable: true,
        retrySafety: "observation_only", message });
      const onAbort = (): void => finish(fail("cancelled", "Gateway control call was cancelled"));

      timer = setTimeout(() => finish(written ? uncertain("Gateway control call timed out after the request was sent")
        : fail("transport_unavailable", "Gateway control connection timed out")), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      socket = createConnection(this.locator.socketPath);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        written = true;
        socket?.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          if (buffer.length > MAX_FRAME_BYTES) finish(fail("corruption", "Gateway control reply exceeds 1 MiB"));
          return;
        }
        if (newline > MAX_FRAME_BYTES) {
          finish(fail("corruption", "Gateway control reply exceeds 1 MiB"));
          return;
        }
        try {
          finish(ok(JSON.parse(buffer.slice(0, newline))));
        } catch {
          finish(fail("corruption", "Gateway control reply is not JSON"));
        }
      });
      socket.on("error", () => finish(written ? uncertain("Gateway control connection failed after the request was sent")
        : fail("transport_unavailable", "Gateway control endpoint is unreachable; start the Gateway")));
      socket.on("close", () => finish(written ? uncertain("Gateway control closed before replying")
        : fail("transport_unavailable", "Gateway control endpoint closed the connection")));
    });
  }
}

// ----------------------------------------------------------------- helpers

function parseLocator(value: unknown): Locator | undefined {
  if (!isRecord(value) || !hasExactKeys(value, LOCATOR_KEYS)) return undefined;
  const { socketPath, token, generation, endpoint } = value;
  if (typeof socketPath !== "string" || !isAbsolute(socketPath) || Buffer.byteLength(socketPath) >= MAX_SOCKET_PATH_BYTES) return undefined;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  if (typeof generation !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(generation)) return undefined;
  if (typeof endpoint !== "string" || !MCPEndpointSchema.safeParse(endpoint).success) return undefined;
  return { socketPath, token, generation, endpoint };
}

function parseReply(value: unknown): Reply | undefined {
  if (!isRecord(value)) return undefined;
  if (value.ok === true && hasExactKeys(value, ["ok", "value"])) return { ok: true, value: value.value };
  if (value.ok === false && hasExactKeys(value, ["ok", "error"])) {
    const error = ContractErrorSchema.safeParse(value.error);
    return error.success ? { ok: false, error: error.data } : undefined;
  }
  return undefined;
}

/** `{ [key]: T[] }` with every element validated by its contract schema. */
function parseArray<T>(value: unknown, key: string, parser: Parser<T>): T[] | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [key])) return undefined;
  const items = value[key];
  if (!Array.isArray(items)) return undefined;
  const parsed: T[] = [];
  for (const item of items) {
    const result = parser.safeParse(item);
    if (!result.success) return undefined;
    parsed.push(result.data);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
