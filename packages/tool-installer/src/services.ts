import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveLocalOrDist(rel: string): string {
  const local = fileURLToPath(new URL(rel, import.meta.url));
  if (existsSync(local)) return local;
  const inDist = fileURLToPath(new URL(`../dist/${rel.replace(/^\.\//, "")}`, import.meta.url));
  if (existsSync(inDist)) return inDist;
  return local;
}
import { z } from "zod";
import { MCPServiceDefinitionSchema, MCPServiceObservationSchema, MCPResourceLeaseSchema, MCPToolCallResultSchema,
  MCPToolCallSchema,
  ScopedOperationSchema, type MCPServiceDefinition, type MCPServiceManager, type SharedMCPGateway,
  type ScopedOperation, type MCPResourceLease, type MCPToolCall, type MCPToolCallResult } from "@bflow/contracts";
import { atomicJson, fileDigest, privateDirectory, readRegular, sha256 } from "./files.js";
import { createToolCapability } from "./installer.js";
import { FileToolCapabilityRegistry, planChromeSession } from "./integrations.js";
import { probeStdioMcp } from "./mcp-probe.js";

export const ToolLaunchSpecSchema = z.object({ schemaVersion: z.literal(3), executable: z.string().min(1),
  executableDigest: z.string().regex(/^[a-f0-9]{64}$/), argv: z.array(z.string()), cwd: z.string(),
  environment: z.record(z.string()), lockPath: z.string().optional(),
  verifiedFiles: z.array(z.object({ path: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).optional(),
  browserOwner: z.object({ taskId: z.string(), repositoryId: z.string(), profileDir: z.string() }).strict().optional() }).strict();
export type ToolLaunchSpec = z.infer<typeof ToolLaunchSpecSchema>;

/** The Gateway launches this pinned shim; the shim validates its spec and upstream binary before spawning. */
export async function createManagedMcpService(input: {
  toolId: "gitnexus" | "chrome-devtools-mcp" | "mempalace"; version: string;
  serviceId: string; revision?: number; operation: ScopedOperation; configRoot: string; launch: ToolLaunchSpec;
  resourceKey?: string;
}): Promise<MCPServiceDefinition> {
  const operation = ScopedOperationSchema.parse(input.operation);
  const spec = ToolLaunchSpecSchema.parse(input.launch);
  if (!isAbsolute(spec.executable) || !isAbsolute(spec.cwd) || (spec.lockPath && !isAbsolute(spec.lockPath)))
    throw new Error("Tool launch paths must be absolute");
  if (Object.keys(spec.environment).some(key => !["GITNEXUS_HOME", "GITNEXUS_MCP_ALLOWED_REPOS", "GITNEXUS_MCP_READ_ONLY",
    "GITNEXUS_SHARED_STORE"].includes(key))) throw new Error("Unapproved tool launch environment key");
  if (await fileDigest(spec.executable) !== spec.executableDigest) throw new Error("Tool binary changed before service configuration");
  const root = await privateDirectory(input.configRoot);
  const specDigest = sha256(JSON.stringify(spec));
  const specPath = join(root, `${input.serviceId}-${specDigest}.json`);
  await atomicJson(specPath, spec);
  const launcher = resolveLocalOrDist("./service-launcher.js");
  const base = createToolCapability(input.toolId, input.version, operation.scope.kind === "machine" ? operation.scope.machineId : operation.scope.repositoryId);
  return MCPServiceDefinitionSchema.parse({ schemaVersion: 3, serviceId: input.serviceId, revision: input.revision ?? 1,
    scope: operation.scope, tool: { ...base, kind: "stdio_mcp", ...(input.resourceKey ? {
      resource: { sharing: "exclusive", resourceKey: input.resourceKey } } : {}) },
    connection: { kind: "stdio_mcp", executable: process.execPath, executableDigest: await fileDigest(process.execPath),
      argv: [launcher, specPath, specDigest, await fileDigest(launcher)], environmentBindings: {}, ownership: "bflow", bridgeRequired: true },
    authentication: { mode: "none" }, healthTimeoutMs: 15_000, idleTimeoutMs: 60_000, restartLimit: 2 });
}

export async function createGitNexusService(input: {
  executable: string; version: string; repositoryRoot: string; stateRoot: string; configRoot: string; operation: ScopedOperation;
}): Promise<MCPServiceDefinition> {
  const root = await privateDirectory(input.repositoryRoot);
  const state = await privateDirectory(input.stateRoot);
  const home = await privateDirectory(join(state, "gitnexus-home"));
  return createManagedMcpService({ toolId: "gitnexus", version: input.version,
    serviceId: `gitnexus-${sha256(root).slice(0, 24)}`, operation: input.operation, configRoot: input.configRoot,
    resourceKey: `gitnexus-${sha256(root).slice(0, 24)}`, launch: { schemaVersion: 3, executable: input.executable,
      executableDigest: await fileDigest(input.executable), argv: ["mcp"], cwd: root,
      environment: { GITNEXUS_HOME: home, GITNEXUS_MCP_ALLOWED_REPOS: root, GITNEXUS_MCP_READ_ONLY: "1", GITNEXUS_SHARED_STORE: "off" },
      lockPath: join(state, `gitnexus-storage-${sha256(root)}.lock`) } });
}

/** MemPalace uses its own palace configuration (MEMPALACE_* and ~/.mempalace); setup never relocates or
 * overrides it. Its stdio proxy shares a hub across sessions, so the service is concurrent, not exclusive. */
export async function createMemPalaceService(input: {
  executable: string; version: string; stateRoot: string; configRoot: string; operation: ScopedOperation;
}): Promise<MCPServiceDefinition> {
  const state = await privateDirectory(input.stateRoot);
  const operation = ScopedOperationSchema.parse(input.operation);
  return createManagedMcpService({ toolId: "mempalace", version: input.version,
    serviceId: `mempalace-${sha256(operation.scope.machineId).slice(0, 24)}`, operation, configRoot: input.configRoot,
    launch: { schemaVersion: 3, executable: input.executable, executableDigest: await fileDigest(input.executable),
      argv: [], cwd: state, environment: {} } });
}

/** The hosted DeepWiki MCP endpoint. Fixed: a configuration file cannot redirect queries to another host. */
export const DEEPWIKI_MCP_ENDPOINT = "https://mcp.deepwiki.com/mcp";
export const DEEPWIKI_SERVICE_ID = "deepwiki";
export const DEEPWIKI_TOOLS = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"] as const;

/**
 * DeepWiki as a remote MCP service shared through the Gateway: no local process, no credential, one upstream for every agent.
 * Neither the endpoint nor an authentication mode is a parameter.
 */
export function createDeepWikiRemoteService(input: {
  operation: ScopedOperation; revision?: number; required?: boolean;
}): MCPServiceDefinition {
  const operation = ScopedOperationSchema.parse(input.operation);
  const base = createToolCapability("deepwiki", "hosted", operation.scope.kind === "machine" ? operation.scope.machineId : operation.scope.repositoryId);
  return MCPServiceDefinitionSchema.parse({ schemaVersion: 3, serviceId: DEEPWIKI_SERVICE_ID, revision: input.revision ?? 1, scope: operation.scope,
    tool: { ...base, operations: [...DEEPWIKI_TOOLS], required: input.required ?? false },
    connection: { kind: "native_remote_mcp", endpoint: DEEPWIKI_MCP_ENDPOINT, ownership: "external" },
    authentication: { mode: "none" },
    healthTimeoutMs: 20_000, idleTimeoutMs: 60_000, restartLimit: 3 });
}

/**
 * Sharing-policy declarations Bflow itself makes about services it knows. Matching is by the exact hosted endpoint, so a
 * different server cannot inherit it by naming its tool `deepwiki`. DeepWiki's three tools only read documentation, which lets
 * the Gateway report a failure with its cause and lets the upstream driver retry safely instead of treating each failure as
 * an uncertain write.
 */
export function trustedGatewayPolicy(service: MCPServiceDefinition): { readOnlyTools: string[] } | undefined {
  if (service.tool.toolId === "mempalace" && service.connection.kind === "stdio_mcp" &&
      service.connection.executable === process.execPath && service.connection.argv.length === 4 &&
      service.connection.argv[0] === resolveLocalOrDist("./service-launcher.js"))
    return { readOnlyTools: ["mempalace_search"] };
  return service.connection.kind === "native_remote_mcp" && service.connection.endpoint === DEEPWIKI_MCP_ENDPOINT && service.tool.toolId === "deepwiki"
    ? { readOnlyTools: [...DEEPWIKI_TOOLS] } : undefined;
}

export async function createChromeService(input: {
  managedRoot: string; repositoryId: string; taskId: string; browserExecutable: string; serverExecutable: string;
  version: string; configRoot: string; operation: ScopedOperation;
}): Promise<MCPServiceDefinition> {
  const profile = await planChromeSession(input);
  if (profile.status !== "ready") throw new Error(profile.diagnostic);
  return createManagedMcpService({ toolId: "chrome-devtools-mcp", version: input.version, serviceId: profile.resourceKey,
    operation: input.operation, configRoot: input.configRoot, resourceKey: profile.resourceKey,
    launch: { schemaVersion: 3, executable: input.serverExecutable, executableDigest: await fileDigest(input.serverExecutable),
      argv: [...profile.argv, "--headless", "--no-usage-statistics"], cwd: dirname(profile.profileDir), environment: {},
      lockPath: join(profile.profileDir, ".bflow-profile.lock"),
      browserOwner: { taskId: input.taskId, repositoryId: input.repositoryId, profileDir: profile.profileDir } } });
}

/** Parses real service-manager evidence. An ensure call without readiness never registers a capability. */
export async function ensureGatewayTool(input: {
  manager: MCPServiceManager; service: MCPServiceDefinition; operation: ScopedOperation;
  registry: FileToolCapabilityRegistry; scopeKey: string; requiredTools: readonly string[];
}) {
  const service = MCPServiceDefinitionSchema.parse(input.service);
  const operation = ScopedOperationSchema.parse(input.operation);
  if (service.tool.toolId === "chrome-devtools-mcp") await verifyChromeStartup(service);
  const result = await input.manager.ensure(service, operation);
  if (!result.ok) { await input.registry.revoke(input.scopeKey, service.tool.toolId); return result; }
  const observation = MCPServiceObservationSchema.parse(result.value);
  const age = Date.now() - Date.parse(observation.observedAt);
  if (observation.status !== "ready" || observation.serviceId !== service.serviceId || observation.revision !== service.revision ||
    observation.ownership !== service.connection.ownership || age < -1000 || age > 60_000 ||
    !input.requiredTools.length || input.requiredTools.some(tool => !observation.discoveredTools.includes(tool))) {
    await input.registry.revoke(input.scopeKey, service.tool.toolId);
    throw new Error("Gateway has not verified the exact service and required tool set");
  }
  await input.registry.register(service.tool, { verified: true, version: service.tool.version, scopeKey: input.scopeKey });
  return result;
}

/** Proves on-demand browser launch with the configured managed profile, then shuts down the setup process. */
export async function verifyChromeStartup(raw: MCPServiceDefinition) {
  const service = MCPServiceDefinitionSchema.parse(raw);
  if (service.tool.toolId !== "chrome-devtools-mcp" || service.connection.kind !== "stdio_mcp")
    throw new Error("Chrome setup requires the managed stdio service");
  return probeStdioMcp({ executable: service.connection.executable, argv: service.connection.argv,
    requiredTools: ["list_pages", "new_page", "navigate_page"], call: { name: "list_pages", arguments: {} }, timeoutMs: 45_000 });
}

/** One task owns the whole private browser profile. All page operations carry the current Gateway lease. */
export class BrowserPageSession {
  readonly #gateway: SharedMCPGateway;
  readonly #service: MCPServiceDefinition;
  readonly #operation: ScopedOperation;
  readonly #registrationId: string;
  readonly #taskId: string;
  readonly #stateFile: string;
  #lease: MCPResourceLease | null = null;
  #uncertain: MCPToolCall | null = null;
  #inFlight = false;
  constructor(input: { gateway: SharedMCPGateway; service: MCPServiceDefinition; operation: ScopedOperation;
    registrationId: string; taskId: string; stateFile: string }) {
    this.#gateway = input.gateway; this.#service = MCPServiceDefinitionSchema.parse(input.service);
    this.#operation = ScopedOperationSchema.parse(input.operation); this.#registrationId = input.registrationId;
    this.#taskId = input.taskId; this.#stateFile = input.stateFile;
    if (this.#service.tool.toolId !== "chrome-devtools-mcp" || this.#service.tool.resource.sharing !== "exclusive")
      throw new Error("Browser session requires an exclusive Chrome service");
  }
  async acquire(taskId: string): Promise<void> {
    if (taskId !== this.#taskId || this.#lease) throw new Error("Browser profile is owned by another task or transaction");
    const connection = this.#service.connection;
    if (connection.kind !== "stdio_mcp") throw new Error("Managed browser requires a pinned stdio launch specification");
    const spec = ToolLaunchSpecSchema.parse(JSON.parse(await readRegular(connection.argv[1]!)));
    if (sha256(JSON.stringify(spec)) !== connection.argv[2] || spec.browserOwner?.taskId !== taskId)
      throw new Error("Browser profile belongs to a different task");
    try {
      const prior = JSON.parse(await readRegular(this.#stateFile)) as { lease?: unknown; pendingCall?: unknown };
      if (prior.lease || prior.pendingCall) throw new Error("Recover the retained browser transaction before acquiring another page");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const resource = this.#service.tool.resource;
    if (resource.sharing !== "exclusive") throw new Error("Missing exclusive browser resource");
    const result = await this.#gateway.acquireResource({ ...this.#operation, registrationId: this.#registrationId,
      serviceId: this.#service.serviceId, resourceKey: resource.resourceKey, ttlMs: 60_000 });
    if (!result.ok) throw new Error(result.error.message);
    const lease = MCPResourceLeaseSchema.parse(result.value);
    if (lease.registrationId !== this.#registrationId || lease.serviceId !== this.#service.serviceId || lease.resourceKey !== resource.resourceKey ||
      Date.parse(lease.expiresAt) <= Date.now()) throw new Error("Gateway returned an unrelated or expired browser lease");
    this.#lease = lease;
    await privateDirectory(dirname(this.#stateFile));
    await atomicJson(this.#stateFile, { schemaVersion: 3, taskId, lease, pendingCall: null });
  }
  async call(taskId: string, tool: string, input: MCPToolCall["input"]): Promise<MCPToolCallResult> {
    if (taskId !== this.#taskId || !this.#lease || this.#inFlight || this.#uncertain) throw new Error("Browser session is busy, unowned or uncertain");
    if (Date.parse(this.#lease.expiresAt) <= Date.now()) throw new Error("Browser transaction lease expired");
    const request = MCPToolCallSchema.parse({ schemaVersion: 3, callId: randomUUID(), registrationId: this.#registrationId,
      serviceId: this.#service.serviceId, tool, input, resourceLease: this.#lease, idempotencyKey: randomUUID() });
    this.#inFlight = true;
    this.#uncertain = request;
    try {
      await atomicJson(this.#stateFile, { schemaVersion: 3, taskId, lease: this.#lease, pendingCall: request });
      const result = await this.#gateway.call(request);
      if (!result.ok) throw new Error(result.error.message);
      const value = MCPToolCallResultSchema.parse(result.value);
      if (value.callId !== request.callId) throw new Error("Uncorrelated browser call result");
      if (value.status !== "unknown") {
        await atomicJson(this.#stateFile, { schemaVersion: 3, taskId, lease: this.#lease, pendingCall: null });
        this.#uncertain = null;
      }
      return value;
    } finally { this.#inFlight = false; }
  }
  async reconcile(): Promise<MCPToolCallResult | null> {
    if (!this.#uncertain) return null;
    const result = await this.#gateway.reconcileCall(this.#uncertain);
    if (!result.ok) throw new Error(result.error.message);
    const value = MCPToolCallResultSchema.parse(result.value);
    if (value.callId !== this.#uncertain.callId) throw new Error("Uncorrelated browser reconciliation");
    if (value.status !== "unknown") {
      await atomicJson(this.#stateFile, { schemaVersion: 3, taskId: this.#taskId, lease: this.#lease, pendingCall: null });
      this.#uncertain = null;
    }
    return value;
  }
  async recover(): Promise<void> {
    if (this.#lease || this.#inFlight) throw new Error("Browser transaction already loaded");
    const state = z.object({ schemaVersion: z.literal(3), taskId: z.literal(this.#taskId),
      lease: MCPResourceLeaseSchema.nullable(), pendingCall: MCPToolCallSchema.nullable() }).strict()
      .parse(JSON.parse(await readRegular(this.#stateFile)));
    if (state.lease && (state.lease.serviceId !== this.#service.serviceId || state.lease.registrationId !== this.#registrationId))
      throw new Error("Retained browser lease belongs to another service/client");
    this.#lease = state.lease; this.#uncertain = state.pendingCall;
    if (this.#uncertain) await this.reconcile();
  }
  async renew(): Promise<void> {
    if (!this.#lease || this.#inFlight || this.#uncertain) throw new Error("Browser transaction cannot be renewed in its current state");
    const result = await this.#gateway.renewResource({ schemaVersion: 3, lease: this.#lease, ttlMs: 60_000, idempotencyKey: randomUUID() });
    if (!result.ok) throw new Error(result.error.message);
    const lease = MCPResourceLeaseSchema.parse(result.value);
    if (lease.leaseId !== this.#lease.leaseId || lease.fencingToken !== this.#lease.fencingToken ||
      lease.resourceKey !== this.#lease.resourceKey || lease.registrationId !== this.#registrationId || lease.serviceId !== this.#service.serviceId)
      throw new Error("Gateway renewed a different browser lease");
    this.#lease = lease;
    await atomicJson(this.#stateFile, { schemaVersion: 3, taskId: this.#taskId, lease, pendingCall: null });
  }
  async release(): Promise<void> {
    if (!this.#lease || this.#inFlight || this.#uncertain) throw new Error("Reconcile the browser operation before releasing its page");
    const result = await this.#gateway.releaseResource(this.#lease, this.#operation);
    if (!result.ok) throw new Error(result.error.message);
    this.#lease = null;
    await atomicJson(this.#stateFile, { schemaVersion: 3, taskId: this.#taskId, lease: null, pendingCall: null });
  }
}
