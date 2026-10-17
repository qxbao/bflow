import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { IdentifierSchema, MCPClientRegistrationSchema, MCPEndpointSchema, MCPResourceLeaseSchema,
  MCPResourceRenewRequestSchema, MCPResourceRequestSchema, MCPServiceDefinitionSchema, MCPServiceObservationSchema,
  MCPToolCallResultSchema, MCPToolCallSchema, PlatformSchemaVersionSchema, ScopedOperationSchema, Sha256DigestSchema, TrustScopeSchema,
  type ContractError, type MCPClientRegistration, type MCPResourceLease, type MCPResourceRenewRequest,
  type MCPResourceRequest, type MCPServiceDefinition, type MCPServiceObservation, type MCPToolCall,
  type MCPToolCallResult, type OperationOptions, type OperationResult, type ScopedOperation, type TrustScope } from "@bflow/contracts";

/** Private rendezvous file for role Runtimes. Holds the control token: written 0600, never logged. */
export const GATEWAY_CONTROL_LOCATOR_FILE = "gateway-control.json";
const SOCKET_FILE = "gateway-control.sock";
const MAX_SOCKET_PATH_BYTES = 100;
const MAX_FRAME_BYTES = 1024 * 1024;
const IDLE_TIMEOUT_MS = 10_000;

export const GatewayControlLocatorSchema = z.object({
  socketPath: z.string().refine(path => isAbsolute(path) && Buffer.byteLength(path) < MAX_SOCKET_PATH_BYTES,
    "control socket path must be absolute and shorter than the Unix socket limit"),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  endpoint: MCPEndpointSchema
}).strict();
export type GatewayControlLocator = z.infer<typeof GatewayControlLocatorSchema>;

/** Structural view of BflowSharedMCPGateway; the CLI loads the package dynamically, so no static type import. */
export interface GatewayControlGateway {
  register(client: MCPClientRegistration, options?: OperationOptions): Promise<OperationResult<MCPClientRegistration>>;
  revoke(registrationId: string, operation: ScopedOperation, options?: OperationOptions): Promise<OperationResult<void>>;
  acquireResource(request: MCPResourceRequest, options?: OperationOptions): Promise<OperationResult<MCPResourceLease>>;
  renewResource(request: MCPResourceRenewRequest, options?: OperationOptions): Promise<OperationResult<MCPResourceLease>>;
  releaseResource(lease: MCPResourceLease, operation: ScopedOperation, options?: OperationOptions): Promise<OperationResult<void>>;
  reconcileCall(request: MCPToolCall, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>>;
  readonly secretStore: { getClientTokenByRegistration(registrationId: string): string | undefined };
  readonly serviceManager: {
    inspect(serviceId: string, operation: ScopedOperation, options?: OperationOptions): Promise<OperationResult<MCPServiceObservation>>;
  };
}

export interface GatewayControlOptions {
  readonly gateway: GatewayControlGateway;
  readonly stateRoot: string;
  readonly machineId: string;
  /** Digest of the approved Gateway configuration this control endpoint serves. */
  readonly configDigest: string;
  /** Loopback Gateway MCP URL that role clients must be registered against. */
  readonly endpoint: string;
  /** Session workspace this control accepts. When omitted, requests must name a canonical existing directory. */
  readonly workspaceRoot?: string;
  readonly services: readonly MCPServiceDefinition[];
}

export interface GatewayControl {
  readonly locator: GatewayControlLocator;
  stop(): Promise<void>;
}

const METHODS = ["catalog", "register", "list", "acquire", "renew", "release", "reconcile", "revoke"] as const;
type Method = (typeof METHODS)[number];

const RequestSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  id: z.union([z.string().max(128), z.number()]),
  token: z.string().max(256),
  generation: z.string().max(256),
  method: z.enum(METHODS),
  params: z.unknown()
}).strict();

type ControlReply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: ContractError };
type FailureCode = "validation" | "conflict" | "not_found" | "corruption" | "transport_unavailable" | "cancelled";

function failure(code: FailureCode, message: string): ControlReply {
  return { ok: false, error: { code, retryable: code === "conflict" || code === "transport_unavailable", message } as ContractError };
}

/**
 * Starts the authenticated control endpoint through which Runtime registers role clients with the shared Gateway.
 * Tokens and the locator stay private; the control only ever delegates to the Gateway after scope and principal checks.
 */
export async function startGatewayControl(options: GatewayControlOptions): Promise<GatewayControl> {
  const uid = currentUid();
  const endpoint = MCPEndpointSchema.parse(options.endpoint);
  IdentifierSchema.parse(options.machineId);
  Sha256DigestSchema.parse(options.configDigest);
  if (options.workspaceRoot !== undefined && !isAbsolute(options.workspaceRoot)) throw new TypeError("workspaceRoot must be absolute");
  const services = new Map<string, MCPServiceDefinition>();
  for (const service of options.services) {
    const parsed = MCPServiceDefinitionSchema.parse(service);
    services.set(parsed.serviceId, parsed);
  }

  await ensurePrivateDirectory(options.stateRoot, uid);
  let socketDirectory = options.stateRoot;
  if (Buffer.byteLength(join(options.stateRoot, SOCKET_FILE)) >= MAX_SOCKET_PATH_BYTES) {
    socketDirectory = `/tmp/bflow-gw-${uid}`;
    await ensurePrivateDirectory(socketDirectory, uid);
  }
  const socketPath = join(socketDirectory, SOCKET_FILE);
  await removeStaleSocket(socketPath, uid);

  const locator = GatewayControlLocatorSchema.parse({ socketPath, token: randomBytes(32).toString("hex"),
    generation: randomBytes(16).toString("hex"), endpoint });
  const locatorPath = join(options.stateRoot, GATEWAY_CONTROL_LOCATOR_FILE);
  const service = new GatewayControlService({ gateway: options.gateway, machineId: options.machineId,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }), endpoint, services,
    token: locator.token, generation: locator.generation });

  const sockets = new Set<Socket>();
  const server = createServer(socket => serveConnection(socket, service, sockets));
  await listen(server, socketPath);
  try {
    await chmod(socketPath, 0o600);
    await writeLocator(locatorPath, locator);
  } catch (error) {
    await closeServer(server);
    await rm(socketPath, { force: true });
    throw error;
  }

  let stopped = false;
  return {
    locator,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      service.clear();
      await rm(socketPath, { force: true });
      await removeOwnLocator(locatorPath, locator.generation);
    }
  };
}

/** One request per connection: newline-delimited JSON, bounded frame and idle time. */
function serveConnection(socket: Socket, service: GatewayControlService, sockets: Set<Socket>): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => socket.destroy());
  socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
  let pending = Buffer.alloc(0);
  let handling = false;
  socket.on("data", (chunk: Buffer) => {
    if (handling) return;
    pending = Buffer.concat([pending, chunk]);
    const newline = pending.indexOf(0x0a);
    if (newline === -1 && pending.length <= MAX_FRAME_BYTES) return;
    handling = true;
    socket.setTimeout(0);
    const reply = newline === -1 || newline > MAX_FRAME_BYTES
      ? Promise.resolve(failure("validation", "Control frame is missing or exceeds 1 MiB"))
      : service.handleLine(pending.subarray(0, newline).toString("utf8"));
    void reply.then(
      result => { socket.end(`${JSON.stringify(result)}\n`); },
      () => { socket.destroy(); }
    );
  });
}

interface ServiceSettings {
  readonly gateway: GatewayControlGateway;
  readonly machineId: string;
  readonly workspaceRoot?: string;
  readonly endpoint: string;
  readonly services: ReadonlyMap<string, MCPServiceDefinition>;
  readonly token: string;
  readonly generation: string;
}

/** Authorization and delegation. Registrations are tracked here so the control never trusts the Gateway's private state. */
class GatewayControlService {
  private readonly known = new Map<string, MCPClientRegistration>();

  constructor(private readonly settings: ServiceSettings) {}

  clear(): void {
    this.known.clear();
  }

  async handleLine(text: string): Promise<ControlReply> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return failure("validation", "Control request is not JSON");
    }
    const envelope = RequestSchema.safeParse(raw);
    if (!envelope.success) return failure("validation", "Control request is malformed");
    if (!this.authenticated(envelope.data.token, envelope.data.generation)) {
      return failure("validation", "Control request is not authenticated for this Gateway generation");
    }
    try {
      return await this.dispatch(envelope.data.method, envelope.data.params);
    } catch {
      return failure("corruption", "Gateway control request failed");
    }
  }

  private authenticated(token: string, generation: string): boolean {
    const tokenMatches = constantTimeEqual(token, this.settings.token);
    const generationMatches = constantTimeEqual(generation, this.settings.generation);
    return tokenMatches && generationMatches;
  }

  private async dispatch(method: Method, params: unknown): Promise<ControlReply> {
    switch (method) {
      case "catalog": return this.catalog(params);
      case "register": return this.register(params);
      case "list": return this.list(params);
      case "acquire": return this.acquire(params);
      case "renew": return this.renew(params);
      case "release": return this.release(params);
      case "reconcile": return this.reconcile(params);
      case "revoke": return this.revoke(params);
    }
  }

  private async catalog(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(z.object({ operation: ScopedOperationSchema }).strict(), params, "catalog");
    if ("reply" in parsed) return parsed.reply;
    const denied = this.checkScope(parsed.data.operation.scope);
    if (denied) return denied;
    const observations: MCPServiceObservation[] = [];
    for (const serviceId of this.settings.services.keys()) {
      const inspected = await this.settings.gateway.serviceManager.inspect(serviceId, parsed.data.operation);
      if (!inspected.ok) return this.forward(inspected.error);
      const observation = MCPServiceObservationSchema.safeParse(inspected.value);
      if (!observation.success) return failure("corruption", "Gateway returned a malformed service observation");
      observations.push(observation.data);
    }
    return { ok: true, value: { observations } };
  }

  private async register(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(z.object({ client: MCPClientRegistrationSchema }).strict(), params, "register");
    if ("reply" in parsed) return parsed.reply;
    const client = parsed.data.client;
    const denied = this.checkScope(client.scope);
    if (denied) return denied;
    if (client.role === "conversation") return failure("validation", "The conversation role never receives Gateway tool access");
    const granted = new Set<string>();
    for (const serviceId of client.serviceIds) {
      const service = this.settings.services.get(serviceId);
      if (!service) return failure("validation", "Requested service is not configured for this Gateway");
      for (const tool of service.tool.operations) granted.add(tool);
    }
    if (client.allowedTools.some(tool => !granted.has(tool))) {
      return failure("validation", "Requested tools are not offered by the configured services");
    }
    if (client.connection.transport !== "streamable_http" || client.connection.endpoint !== this.settings.endpoint) {
      return failure("validation", "Registration must target the Gateway control endpoint");
    }
    if (Date.parse(client.expiresAt) <= Date.now()) return failure("validation", "Registration is already expired");
    const existing = this.known.get(client.registrationId);
    if (existing && (existing.role !== client.role || existing.provider !== client.provider || !sameScope(existing.scope, client.scope))) {
      return failure("validation", "registrationId already belongs to a different principal");
    }

    const registered = await this.settings.gateway.register(client);
    if (!registered.ok) return this.forward(registered.error);
    const token = this.settings.gateway.secretStore.getClientTokenByRegistration(client.registrationId);
    if (token === undefined) return failure("conflict", "Gateway did not issue a client token; retry with a new registration attempt");
    this.known.set(client.registrationId, client);
    return { ok: true, value: { registration: client, token } };
  }

  private list(params: unknown): ControlReply {
    const parsed = parseParams(z.object({ scope: TrustScopeSchema }).strict(), params, "list");
    if ("reply" in parsed) return parsed.reply;
    const denied = this.checkScope(parsed.data.scope);
    if (denied) return denied;
    const registrations = [...this.known.values()].filter(registration => sameScope(registration.scope, parsed.data.scope));
    return { ok: true, value: { registrations } };
  }

  private async acquire(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(MCPResourceRequestSchema, params, "acquire");
    if ("reply" in parsed) return parsed.reply;
    const denied = this.checkScope(parsed.data.scope);
    if (denied) return denied;
    const owned = this.ownedBy(parsed.data.registrationId, parsed.data.scope);
    if ("reply" in owned) return owned.reply;
    if (!owned.registration.serviceIds.includes(parsed.data.serviceId)) return failure("validation", "Service is not granted to this registration");
    return this.delegate(await this.settings.gateway.acquireResource(parsed.data), MCPResourceLeaseSchema);
  }

  private async renew(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(MCPResourceRenewRequestSchema, params, "renew");
    if ("reply" in parsed) return parsed.reply;
    const known = this.known.get(parsed.data.lease.registrationId);
    if (!known || !known.serviceIds.includes(parsed.data.lease.serviceId)) {
      return failure("validation", "Resource lease does not belong to a registered client");
    }
    return this.delegate(await this.settings.gateway.renewResource(parsed.data), MCPResourceLeaseSchema);
  }

  private async release(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(z.object({ lease: MCPResourceLeaseSchema, operation: ScopedOperationSchema }).strict(), params, "release");
    if ("reply" in parsed) return parsed.reply;
    const denied = this.checkScope(parsed.data.operation.scope);
    if (denied) return denied;
    const owned = this.ownedBy(parsed.data.lease.registrationId, parsed.data.operation.scope);
    if ("reply" in owned) return owned.reply;
    const released = await this.settings.gateway.releaseResource(parsed.data.lease, parsed.data.operation);
    return released.ok ? { ok: true, value: null } : this.forward(released.error);
  }

  private async reconcile(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(z.object({ call: MCPToolCallSchema }).strict(), params, "reconcile");
    if ("reply" in parsed) return parsed.reply;
    const known = this.known.get(parsed.data.call.registrationId);
    if (!known || !known.serviceIds.includes(parsed.data.call.serviceId)) {
      return failure("validation", "Tool call does not belong to a registered client");
    }
    return this.delegate(await this.settings.gateway.reconcileCall(parsed.data.call), MCPToolCallResultSchema);
  }

  private async revoke(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(z.object({ registrationId: IdentifierSchema, operation: ScopedOperationSchema }).strict(), params, "revoke");
    if ("reply" in parsed) return parsed.reply;
    const denied = this.checkScope(parsed.data.operation.scope);
    if (denied) return denied;
    const owned = this.ownedBy(parsed.data.registrationId, parsed.data.operation.scope);
    if ("reply" in owned) return owned.reply;
    const revoked = await this.settings.gateway.revoke(parsed.data.registrationId, parsed.data.operation);
    if (revoked.ok || revoked.error.code === "not_found") this.known.delete(parsed.data.registrationId);
    return revoked.ok ? { ok: true, value: null } : this.forward(revoked.error);
  }

  /** Only session scope from this control's machine and workspace is ever accepted. */
  private checkScope(scope: TrustScope): ControlReply | undefined {
    if (scope.kind !== "session") return failure("validation", "Gateway control requires session scope");
    if (scope.machineId !== this.settings.machineId) return failure("validation", "Operation belongs to a different machine");
    const workspaceAllowed = this.settings.workspaceRoot !== undefined
      ? scope.workspaceRoot === this.settings.workspaceRoot
      : isCanonicalDirectory(scope.workspaceRoot);
    if (!workspaceAllowed) return failure("validation", "Operation belongs to a foreign or non-canonical workspace");
    return undefined;
  }

  private ownedBy(registrationId: string, scope: TrustScope):
    { readonly registration: MCPClientRegistration } | { readonly reply: ControlReply } {
    const registration = this.known.get(registrationId);
    if (!registration || !sameScope(registration.scope, scope)) {
      return { reply: failure("validation", "Registration does not belong to this session scope") };
    }
    return { registration };
  }

  private delegate<T>(result: OperationResult<T>, schema: z.ZodType<T>): ControlReply {
    if (!result.ok) return this.forward(result.error);
    const parsed = schema.safeParse(result.value);
    return parsed.success ? { ok: true, value: parsed.data } : failure("corruption", "Gateway returned a malformed result");
  }

  private forward(error: ContractError): ControlReply {
    return { ok: false, error: { ...error, message: this.redact(error.message) } as ContractError };
  }

  private redact(text: string): string {
    return text.split(this.settings.token).join("[REDACTED]")
      .replace(/Bearer\s+\S+/g, "Bearer [REDACTED]")
      .replace(/secret:\/\/\S+/g, "secret://[REDACTED]");
  }
}

// ----------------------------------------------------------------- helpers

type Parsed<T> = { readonly data: T } | { readonly reply: ControlReply };

function parseParams<S extends z.ZodTypeAny>(schema: S, input: unknown, method: string): Parsed<z.output<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { data: parsed.data as z.output<S> };
  const details = parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join(".") || "params"}: ${issue.message}`).join("; ");
  return { reply: failure("validation", `Invalid ${method} parameters: ${details}`) };
}

function sameScope(left: TrustScope, right: TrustScope): boolean {
  return left.kind === "session" && right.kind === "session" && left.machineId === right.machineId &&
    left.repositoryId === right.repositoryId && left.workspaceRoot === right.workspaceRoot && left.sessionId === right.sessionId;
}

function isCanonicalDirectory(path: string): boolean {
  try {
    return isAbsolute(path) && realpathSync(path) === path && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Gateway control requires POSIX Unix sockets");
  return uid;
}

async function ensurePrivateDirectory(directory: string, uid: number): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== uid) throw new Error("Gateway control directory must be a directory owned by the current user");
  if ((info.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
  return directory;
}

async function removeStaleSocket(path: string, uid: number): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isSocket() || info.uid !== uid) throw new Error("Refusing to replace a non-socket or foreign control path");
  await rm(path, { force: true });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}

/** Atomic replace: temp file (0600) → fsync → rename. */
async function writeLocator(path: string, locator: GatewayControlLocator): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(locator)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Removes the locator only while it still names this generation, so a newer daemon's file survives. */
async function removeOwnLocator(path: string, generation: string): Promise<void> {
  try {
    const saved = GatewayControlLocatorSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (saved.success && saved.data.generation === generation) await rm(path, { force: true });
  } catch {
    // Missing or unreadable locator: nothing of this generation remains to remove.
  }
}
