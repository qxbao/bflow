import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { IdentifierSchema, MCPClientRegistrationSchema, MCPEndpointSchema, MCPResourceLeaseSchema,
  MCPResourceRenewRequestSchema, MCPResourceRequestSchema, MCPServiceDefinitionSchema, MCPServiceObservationSchema,
  MCPToolCallResultSchema, MCPToolCallSchema, PlatformSchemaVersionSchema, ResolvedToolGrantSchema, ScopedOperationSchema, Sha256DigestSchema, TrustScopeSchema,
  type ContractError, type MCPClientRegistration, type MCPResourceLease, type MCPResourceRenewRequest,
  type MCPResourceRequest, type MCPServiceDefinition, type MCPServiceObservation, type MCPToolCall,
  type MCPToolCallResult, type OperationOptions, type OperationResult, type ResolvedToolGrant, type ScopedOperation, type TrustScope } from "@bflow/contracts";

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
  call(request: MCPToolCall, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>>;
  reconcileCall(request: MCPToolCall, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>>;
  readonly secretStore: { getClientTokenByRegistration(registrationId: string): string | undefined };
  readonly serviceManager: {
    inspect(serviceId: string, operation: ScopedOperation, options?: OperationOptions): Promise<OperationResult<MCPServiceObservation>>;
    ensure?(service: MCPServiceDefinition, operation: ScopedOperation, options?: OperationOptions): Promise<OperationResult<MCPServiceObservation>>;
    stop?(serviceId: string, operation: ScopedOperation, options?: OperationOptions): Promise<OperationResult<MCPServiceObservation>>;
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
  /** Workspace for repository-bound services. When omitted, requests must name a canonical existing directory. */
  readonly workspaceRoot?: string;
  /** Trusted host grants for services approved for sharing across repositories; empty by default. */
  readonly machineSharedServiceIds?: readonly string[];
  readonly services: readonly MCPServiceDefinition[];
  /** Authenticated Runtime grants keyed by ephemeral Gateway registration. */
  readonly grantMap?: Map<string, readonly ResolvedToolGrant[]>;
  /** Dynamic handler to validate and start a repository-scoped service on the running Gateway. */
  readonly onRegisterRepositoryService?: (input: {
    readonly service: MCPServiceDefinition;
    readonly operation: ScopedOperation;
    readonly rawEntry?: unknown;
  }) => Promise<OperationResult<MCPServiceObservation>>;
  /** Dynamic handler to stop and remove a repository-scoped service on the running Gateway. */
  readonly onRemoveRepositoryService?: (input: {
    readonly serviceId: string;
    readonly operation: ScopedOperation;
  }) => Promise<OperationResult<void>>;
}

export interface GatewayControl {
  readonly locator: GatewayControlLocator;
  stop(): Promise<void>;
}

const METHODS = [
  "catalog",
  "register",
  "list",
  "acquire",
  "renew",
  "release",
  "invoke_tool",
  "reconcile_tool_call",
  "reconcile",
  "revoke",
  "register_repository_service",
  "remove_repository_service"
] as const;
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

  const machineSharedServiceIds = new Set(options.machineSharedServiceIds ?? []);
  for (const serviceId of machineSharedServiceIds) {
    const service = services.get(serviceId);
    if (!service || service.scope.kind !== "machine" || service.scope.machineId !== options.machineId) {
      throw new TypeError("Machine-shared services must be configured with this machine's scope");
    }
  }

  await ensurePrivateDirectory(options.stateRoot, uid);
  let socketDirectory = options.stateRoot;
  if (Buffer.byteLength(join(options.stateRoot, SOCKET_FILE)) >= MAX_SOCKET_PATH_BYTES) {
    // Keyed by state root so repositories with long paths never share (and fight over) one fallback socket.
    socketDirectory = `/tmp/bflow-gw-${uid}-${createHash("sha256").update(options.stateRoot).digest("hex").slice(0, 12)}`;
    await ensurePrivateDirectory(socketDirectory, uid);
  }
  const socketPath = join(socketDirectory, SOCKET_FILE);
  await removeStaleSocket(socketPath, uid);

  const locator = GatewayControlLocatorSchema.parse({ socketPath, token: randomBytes(32).toString("hex"),
    generation: randomBytes(16).toString("hex"), endpoint });
  const locatorPath = join(options.stateRoot, GATEWAY_CONTROL_LOCATOR_FILE);
  const service = new GatewayControlService({
    gateway: options.gateway,
    machineId: options.machineId,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    endpoint,
    services,
    machineSharedServiceIds,
    hasExplicitMachineShareList: options.machineSharedServiceIds !== undefined,
    ...(options.grantMap ? { grantMap: options.grantMap } : {}),
    ...(options.onRegisterRepositoryService ? { onRegisterRepositoryService: options.onRegisterRepositoryService } : {}),
    ...(options.onRemoveRepositoryService ? { onRemoveRepositoryService: options.onRemoveRepositoryService } : {}),
    token: locator.token,
    generation: locator.generation
  });

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
  readonly services: Map<string, MCPServiceDefinition>;
  readonly machineSharedServiceIds: ReadonlySet<string>;
  readonly hasExplicitMachineShareList: boolean;
  readonly grantMap?: Map<string, readonly ResolvedToolGrant[]>;
  readonly onRegisterRepositoryService?: GatewayControlOptions["onRegisterRepositoryService"];
  readonly onRemoveRepositoryService?: GatewayControlOptions["onRemoveRepositoryService"];
  readonly token: string;
  readonly generation: string;
}

const RegisterRepositoryServiceParamsSchema = z.union([
  z.object({
    service: MCPServiceDefinitionSchema,
    operation: ScopedOperationSchema,
    entry: z.unknown().optional()
  }).strict(),
  z.object({
    entry: z.object({
      schemaVersion: PlatformSchemaVersionSchema,
      repositoryId: IdentifierSchema,
      workspaceRoot: z.string().min(1),
      service: MCPServiceDefinitionSchema,
      registeredAt: z.string().datetime()
    }).strict(),
    operation: ScopedOperationSchema
  }).strict()
]);

/** Authorization and delegation. Registrations are tracked here so the control never trusts the Gateway's private state. */
class GatewayControlService {
  private readonly known = new Map<string, MCPClientRegistration>();

  constructor(private readonly settings: ServiceSettings) {}

  clear(): void {
    this.known.clear();
    this.settings.grantMap?.clear();
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
      case "invoke_tool": return this.invokeTool(params);
      case "reconcile_tool_call": return this.reconcileToolCall(params);
      case "reconcile": return this.reconcile(params);
      case "revoke": return this.revoke(params);
      case "register_repository_service": return this.registerRepositoryService(params);
      case "remove_repository_service": return this.removeRepositoryService(params);
    }
  }

  private async catalog(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(z.object({ operation: ScopedOperationSchema }).strict(), params, "catalog");
    if ("reply" in parsed) return parsed.reply;
    const denied = this.checkScope(parsed.data.operation.scope);
    if (denied) return denied;
    const observations: MCPServiceObservation[] = [];
    for (const serviceId of this.settings.services.keys()) {
      if (!this.serviceAllowed(serviceId, parsed.data.operation.scope)) continue;
      const inspected = await this.settings.gateway.serviceManager.inspect(serviceId, parsed.data.operation);
      if (!inspected.ok) return this.forward(inspected.error);
      const observation = MCPServiceObservationSchema.safeParse(inspected.value);
      if (!observation.success) return failure("corruption", "Gateway returned a malformed service observation");
      observations.push(observation.data);
    }
    return { ok: true, value: { observations } };
  }

  private async register(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(z.object({ client: MCPClientRegistrationSchema, toolGrants: z.array(ResolvedToolGrantSchema).optional() }).strict(), params, "register");
    if ("reply" in parsed) return parsed.reply;
    const client = parsed.data.client;
    const toolGrants = parsed.data.toolGrants;
    const denied = this.checkScope(client.scope);
    if (denied) return denied;
    if (client.role === "conversation") return failure("validation", "The conversation role never receives Gateway tool access");
    const granted = new Set<string>();
    for (const serviceId of client.serviceIds) {
      const service = this.settings.services.get(serviceId);
      if (!service) return failure("validation", "Requested service is not configured for this Gateway");
      if (!this.serviceAllowed(serviceId, client.scope)) return failure("validation", "Requested service is bound to a different workspace");
      for (const tool of service.tool.operations) granted.add(tool);
    }
    if (client.allowedTools.some(tool => !granted.has(tool))) {
      return failure("validation", "Requested tools are not offered by the configured services");
    }
    if (toolGrants !== undefined) {
      if (!this.settings.grantMap) return failure("validation", "Gateway control does not support resolved Runtime tool grants");
      for (const grant of toolGrants) {
        if (grant.role !== client.role || grant.kind === "cli_only" || !grant.serviceId || !client.serviceIds.includes(grant.serviceId) ||
            grant.scope.kind !== "session" || !sameScope(grant.scope, client.scope) ||
            grant.operations.some(operation => !client.allowedTools.includes(operation)))
          return failure("validation", "Resolved tool grant does not match the registered role, session, service and operations");
        const service = this.settings.services.get(grant.serviceId);
        if (!service || service.tool.toolId !== grant.toolId || service.tool.kind !== grant.kind ||
            grant.operations.some(operation => !service.tool.operations.includes(operation)))
          return failure("validation", "Resolved tool grant does not match the configured service definition");
      }
    }
    if (client.connection.transport !== "streamable_http" || client.connection.endpoint !== this.settings.endpoint) {
      return failure("validation", "Registration must target the Gateway control endpoint");
    }
    if (Date.parse(client.expiresAt) <= Date.now()) return failure("validation", "Registration is already expired");
    const existing = this.known.get(client.registrationId);
    if (existing && !isDeepStrictEqual(existing, client)) {
      return failure("conflict", "registrationId is already bound to a different client");
    }
    if (existing && this.settings.grantMap &&
        (this.settings.grantMap.has(client.registrationId) !== (toolGrants !== undefined) ||
          toolGrants !== undefined && !isDeepStrictEqual(this.settings.grantMap.get(client.registrationId), toolGrants))) {
      return failure("conflict", "registrationId is already bound to a different Runtime grant set");
    }

    if (toolGrants !== undefined) this.settings.grantMap?.set(client.registrationId, toolGrants);
    else this.settings.grantMap?.delete(client.registrationId);
    this.known.set(client.registrationId, client);
    const registered = await this.settings.gateway.register(client);
    if (!registered.ok) {
      if (!existing) {
        this.known.delete(client.registrationId);
        this.settings.grantMap?.delete(client.registrationId);
      }
      return this.forward(registered.error);
    }
    const token = this.settings.gateway.secretStore.getClientTokenByRegistration(client.registrationId);
    if (token === undefined) return failure("conflict", "Gateway did not issue a client token; retry with a new registration attempt");
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
    const owned = this.ownedCall(parsed.data.call);
    if ("reply" in owned) return owned.reply;
    return this.delegate(await this.settings.gateway.reconcileCall(parsed.data.call), MCPToolCallResultSchema);
  }

  private async invokeTool(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(z.object({ call: MCPToolCallSchema }).strict(), params, "invoke_tool");
    if ("reply" in parsed) return parsed.reply;
    const owned = this.ownedCall(parsed.data.call);
    if ("reply" in owned) return owned.reply;
    return this.delegate(await this.settings.gateway.call(parsed.data.call), MCPToolCallResultSchema);
  }

  private async reconcileToolCall(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(z.object({ call: MCPToolCallSchema }).strict(), params, "reconcile_tool_call");
    if ("reply" in parsed) return parsed.reply;
    const owned = this.ownedCall(parsed.data.call);
    if ("reply" in owned) return owned.reply;
    return this.delegate(await this.settings.gateway.reconcileCall(parsed.data.call), MCPToolCallResultSchema);
  }

  private ownedCall(call: MCPToolCall): { readonly registration: MCPClientRegistration } | { readonly reply: ControlReply } {
    const registration = this.known.get(call.registrationId);
    if (!registration || !registration.serviceIds.includes(call.serviceId) || !registration.allowedTools.includes(call.tool))
      return { reply: failure("validation", "Tool call does not belong to an authorized service, operation and registration") };
    const denied = this.checkScope(registration.scope);
    if (denied) return { reply: denied };
    const service = this.settings.services.get(call.serviceId);
    if (!service || !service.tool.operations.includes(call.tool))
      return { reply: failure("validation", "Tool operation is not in the configured service definition") };
    if (call.resourceLease && (call.resourceLease.registrationId !== registration.registrationId || call.resourceLease.serviceId !== call.serviceId))
      return { reply: failure("validation", "Resource lease belongs to a different registration") };
    const registrationGrants = this.settings.grantMap?.get(call.registrationId);
    if (registrationGrants !== undefined && !registrationGrants.some(grant => grant.serviceId === call.serviceId && grant.operations.includes(call.tool)))
      return { reply: failure("validation", "Tool call is outside the resolved Runtime grant") };
    if (service.tool.toolId === "mempalace" && !registrationGrants?.some(grant => grant.serviceId === call.serviceId &&
        grant.toolId === "mempalace" && grant.memoryScope))
      return { reply: failure("validation", "MemPalace calls require an explicit repository read-only memory grant") };
    return { registration };
  }

  private async revoke(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(z.object({ registrationId: IdentifierSchema, operation: ScopedOperationSchema }).strict(), params, "revoke");
    if ("reply" in parsed) return parsed.reply;
    const denied = this.checkScope(parsed.data.operation.scope);
    if (denied) return denied;
    const owned = this.ownedBy(parsed.data.registrationId, parsed.data.operation.scope);
    if ("reply" in owned) return owned.reply;
    const revoked = await this.settings.gateway.revoke(parsed.data.registrationId, parsed.data.operation);
    if (revoked.ok || revoked.error.code === "not_found") {
      this.known.delete(parsed.data.registrationId);
      this.settings.grantMap?.delete(parsed.data.registrationId);
    }
    return revoked.ok ? { ok: true, value: null } : this.forward(revoked.error);
  }

  private async registerRepositoryService(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(RegisterRepositoryServiceParamsSchema, params, "register_repository_service");
    if ("reply" in parsed) return parsed.reply;
    const service = "service" in parsed.data ? parsed.data.service : parsed.data.entry.service;
    const rawEntry = "entry" in parsed.data ? parsed.data.entry : undefined;
    const operation = parsed.data.operation;
    if (operation.scope.kind !== "repository" || service.scope.kind !== "repository") {
      return failure("validation", "register_repository_service requires repository scope");
    }
    if (operation.scope.machineId !== this.settings.machineId || service.scope.machineId !== this.settings.machineId) {
      return failure("validation", "Repository service operation belongs to a different machine");
    }
    if (
      service.scope.repositoryId !== operation.scope.repositoryId ||
      service.scope.workspaceRoot !== operation.scope.workspaceRoot
    ) {
      return failure("validation", "Repository service scope does not match operation scope");
    }
    if (!isCanonicalDirectory(service.scope.workspaceRoot)) {
      return failure("validation", "Repository service workspaceRoot is not a canonical existing directory");
    }

    if (this.settings.onRegisterRepositoryService) {
      const result = await this.settings.onRegisterRepositoryService({ service, operation, rawEntry });
      if (!result.ok) return this.forward(result.error);
      const observation = MCPServiceObservationSchema.safeParse(result.value);
      if (!observation.success) return failure("corruption", "Gateway returned a malformed service observation");
      this.settings.services.set(service.serviceId, service);
      return { ok: true, value: observation.data };
    }

    if (!this.settings.gateway.serviceManager.ensure) {
      return failure("validation", "Dynamic repository service registration is not supported on this Gateway control");
    }
    const ensured = await this.settings.gateway.serviceManager.ensure(service, operation);
    if (!ensured.ok) return this.forward(ensured.error);
    const observation = MCPServiceObservationSchema.safeParse(ensured.value);
    if (!observation.success) return failure("corruption", "Gateway returned a malformed service observation");
    this.settings.services.set(service.serviceId, service);
    return { ok: true, value: observation.data };
  }

  private async removeRepositoryService(params: unknown): Promise<ControlReply> {
    const parsed = parseParams(
      z.object({ serviceId: IdentifierSchema, operation: ScopedOperationSchema }).strict(),
      params,
      "remove_repository_service"
    );
    if ("reply" in parsed) return parsed.reply;
    const { serviceId, operation } = parsed.data;
    if (operation.scope.kind !== "repository") {
      return failure("validation", "remove_repository_service requires repository scope");
    }
    if (operation.scope.machineId !== this.settings.machineId) {
      return failure("validation", "Repository service operation belongs to a different machine");
    }
    const existing = this.settings.services.get(serviceId);
    if (existing) {
      if (existing.scope.kind !== "repository") {
        return failure("validation", "Cannot remove a machine-scoped service via remove_repository_service");
      }
      if (
        existing.scope.repositoryId !== operation.scope.repositoryId ||
        existing.scope.workspaceRoot !== operation.scope.workspaceRoot
      ) {
        return failure("validation", "Repository service belongs to a different workspace");
      }
    }

    if (this.settings.onRemoveRepositoryService) {
      const result = await this.settings.onRemoveRepositoryService({ serviceId, operation });
      if (!result.ok && result.error.code !== "not_found") return this.forward(result.error);
    } else if (existing && this.settings.gateway.serviceManager.stop) {
      const stopped = await this.settings.gateway.serviceManager.stop(serviceId, operation);
      if (!stopped.ok && stopped.error.code !== "not_found") return this.forward(stopped.error);
    }

    this.settings.services.delete(serviceId);
    return { ok: true, value: null };
  }

  /** Foreign workspaces may use only the machine services explicitly granted by the trusted host. */
  private checkScope(scope: TrustScope): ControlReply | undefined {
    if (scope.kind !== "session") return failure("validation", "Gateway control requires session scope");
    if (scope.machineId !== this.settings.machineId) return failure("validation", "Operation belongs to a different machine");
    const bound = this.settings.workspaceRoot;
    if (bound !== undefined && scope.workspaceRoot !== bound && this.settings.machineSharedServiceIds.size === 0) {
      return failure("validation", `The machine Gateway is bound to workspace '${bound}' but this operation targets '${scope.workspaceRoot}'. Run 'bflow setup --dir ${scope.workspaceRoot}' to rebind the Gateway to this repository, then retry.`);
    }
    if (scope.workspaceRoot === bound) return undefined;
    if (!isCanonicalDirectory(scope.workspaceRoot)) return failure("validation", "Operation belongs to a non-canonical workspace");
    return undefined;
  }

  private serviceAllowed(serviceId: string, scope: TrustScope): boolean {
    const service = this.settings.services.get(serviceId);
    if (!service) return false;
    if (service.scope.kind === "repository") {
      return (
        scope.kind !== "machine" &&
        scope.machineId === service.scope.machineId &&
        scope.repositoryId === service.scope.repositoryId &&
        scope.workspaceRoot === service.scope.workspaceRoot
      );
    }
    if (this.settings.workspaceRoot !== undefined) {
      return (
        (scope.kind !== "machine" && scope.workspaceRoot === this.settings.workspaceRoot) ||
        this.settings.machineSharedServiceIds.has(serviceId)
      );
    }
    return !this.settings.hasExplicitMachineShareList || this.settings.machineSharedServiceIds.has(serviceId);
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
  // A socket file alone does not prove a dead daemon: a live Gateway keeps answering and must not be displaced.
  if (await socketAnswers(path)) throw new Error("Another Gateway control is running for this state directory; refusing to replace its live socket");
  await rm(path, { force: true });
}

/** Connect probe: resolves true only when a listener accepts the connection within the timeout. */
function socketAnswers(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    const finish = (answered: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
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

async function sendGatewayControlRequest<T>(
  locatorPath: string,
  method: Method,
  params: unknown,
  responseSchema: z.ZodType<T>,
  timeoutMs = 15_000
): Promise<OperationResult<T>> {
  let locator: GatewayControlLocator;
  try {
    locator = GatewayControlLocatorSchema.parse(JSON.parse(await readFile(locatorPath, "utf8")));
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "transport_unavailable",
        message: `Gateway control locator is unavailable (${error instanceof Error ? error.message : String(error)})`,
        retryable: true
      } as ContractError
    };
  }

  return new Promise<OperationResult<T>>(resolve => {
    const socket = createConnection(locator.socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (result: OperationResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: {
          code: "transport_unavailable",
          message: `Gateway control request '${method}' timed out after ${timeoutMs}ms`,
          retryable: true
        } as ContractError
      });
    }, timeoutMs);

    socket.once("connect", () => {
      const request = {
        schemaVersion: 3,
        id: randomUUID(),
        token: locator.token,
        generation: locator.generation,
        method,
        params
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      try {
        const reply = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as ControlReply;
        if (!reply.ok) {
          finish({ ok: false, error: reply.error });
          return;
        }
        const parsed = responseSchema.safeParse(reply.value);
        if (!parsed.success) {
          finish({
            ok: false,
            error: {
              code: "corruption",
              message: `Gateway control returned malformed response for '${method}'`,
              retryable: false
            } as ContractError
          });
          return;
        }
        finish({ ok: true, value: parsed.data });
      } catch (error) {
        finish({
          ok: false,
          error: {
            code: "corruption",
            message: `Gateway control returned invalid JSON (${error instanceof Error ? error.message : String(error)})`,
            retryable: false
          } as ContractError
        });
      }
    });

    socket.once("error", error => {
      finish({
        ok: false,
        error: {
          code: "transport_unavailable",
          message: `Gateway control socket error: ${error.message}`,
          retryable: true
        } as ContractError
      });
    });

    socket.once("close", () => {
      if (!settled) {
        finish({
          ok: false,
          error: {
            code: "transport_unavailable",
            message: `Gateway control closed socket before replying to '${method}'`,
            retryable: true
          } as ContractError
        });
      }
    });
  });
}

export async function registerGatewayRepositoryService(
  locatorPath: string,
  params:
    | { readonly service: MCPServiceDefinition; readonly operation: ScopedOperation; readonly entry?: unknown }
    | {
        readonly entry: {
          readonly schemaVersion: 3;
          readonly repositoryId: string;
          readonly workspaceRoot: string;
          readonly service: MCPServiceDefinition;
          readonly registeredAt: string;
        };
        readonly operation: ScopedOperation;
      }
): Promise<OperationResult<MCPServiceObservation>> {
  return sendGatewayControlRequest(locatorPath, "register_repository_service", params, MCPServiceObservationSchema);
}

export async function removeGatewayRepositoryService(
  locatorPath: string,
  params: { readonly serviceId: string; readonly operation: ScopedOperation }
): Promise<OperationResult<null>> {
  return sendGatewayControlRequest(locatorPath, "remove_repository_service", params, z.null());
}
