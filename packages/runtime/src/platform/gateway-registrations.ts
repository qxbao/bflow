import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentProviderIdSchema, AgentRoleSchema, IsoDateTimeSchema, MCPClientRegistrationSchema, MCPEndpointSchema,
  MCPServiceObservationSchema, Sha256DigestSchema, TrustScopeSchema
  , MCPToolCallSchema, MCPToolCallResultSchema
} from "@bflow/contracts";
import type {
  AgentProviderId, AgentRole, ContractError, JsonValue, MCPClientRegistration,
  MCPServiceObservation, MCPToolCall, MCPToolCallResult, OperationOptions, OperationResult, ScopedOperation, TrustScope
} from "@bflow/contracts";
import { fail, failWith, ok } from "./errors.js";
import type {
  GatewayControlPort, GatewayRegistrationGrant, GatewayRegistrationPort, GatewayRegistrationVerification,
  GatewayRoleRequest, LostGatewayRegistration, PlatformSessionIdentity, RoleGatewayAccess
} from "./ports.js";

const LEDGER_FILE = "gateway-registrations.json";
const LEDGER_SCHEMA_VERSION = 3;
const DEFAULT_TTL_MS = 3_600_000;
const SECRET_NAMESPACE = "secret://bflow";
const TOKEN_ENV_PREFIX = "BFLOW_MCP_TOKEN_";
const MAX_ENV_NAME_LENGTH = 64;

/**
 * `lost`: a `registered` entry the Gateway no longer serves (restart, or expiry). Added without a schema bump:
 * older files never contain it, and it is only written by `verifyRegistrations`.
 */
type LedgerState = "intent" | "registered" | "unknown" | "lost" | "revoked";
const LEDGER_STATES: readonly LedgerState[] = ["intent", "registered", "unknown", "lost", "revoked"];

/** Durable, token-free record of one Gateway registration attempt. */
interface LedgerEntry {
  readonly registrationId: string;
  readonly role: AgentRole;
  readonly provider: AgentProviderId;
  readonly taskId?: string;
  readonly environmentId: string;
  readonly serviceIds: readonly string[];
  readonly allowedTools: readonly string[];
  readonly configDigest: string;
  readonly state: LedgerState;
  /** Gateway echo of the registration; present once a register has been acknowledged. Never holds a token value. */
  readonly registration?: MCPClientRegistration;
  readonly updatedAt: string;
}

type LedgerEntries = Readonly<Record<string, LedgerEntry>>;

/** Errors that stay inside this module; converted to OperationResult at the port boundary. */
class GatewayPortError extends Error {
  constructor(readonly failure: ContractError) {
    super(failure.message);
  }
}

class LedgerError extends Error {
  constructor(readonly code: "validation" | "corruption", message: string) {
    super(message);
  }
}

export interface GatewayRegistrationManagerOptions {
  readonly control: GatewayControlPort;
  /** Gateway MCP URL that role clients connect to (HTTPS, or loopback HTTP). */
  readonly endpoint: string;
  readonly now?: () => Date;
  /** Registration lifetime; defaults to and is capped at one hour. */
  readonly registrationTtlMs?: number;
}

/**
 * Runtime-side registration of role MCP clients with the shared Gateway.
 *
 * Bearer tokens exist only in this process's memory. A restarted process cannot recover a token, so a
 * registration it finds without one is revoked and registered again. Tokens never reach the ledger or errors.
 */
export class GatewayRegistrationManager implements GatewayRegistrationPort {
  private readonly control: GatewayControlPort;
  private readonly endpoint: string;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly tokens = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: GatewayRegistrationManagerOptions) {
    const endpoint = MCPEndpointSchema.safeParse(options.endpoint);
    if (!endpoint.success) throw new TypeError("Gateway endpoint must be HTTPS or loopback HTTP without credentials");
    const ttl = options.registrationTtlMs ?? DEFAULT_TTL_MS;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > DEFAULT_TTL_MS) {
      throw new RangeError(`registrationTtlMs must be an integer in (0, ${DEFAULT_TTL_MS}]`);
    }
    this.control = options.control;
    this.endpoint = endpoint.data;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = ttl;
  }

  async ensureForRole(identity: PlatformSessionIdentity, request: GatewayRoleRequest,
    options?: OperationOptions): Promise<OperationResult<RoleGatewayAccess>> {
    if (request.serviceIds.length === 0) return ok({ registrations: [], observations: [], tokenEnvironment: {} });
    return this.serialize(() => this.guard(async () => {
      const scope = sessionScope(identity);
      const now = this.now();
      const registration = this.buildRegistration(identity, scope, request, now);
      const operation = scopedOperation(scope, registration.registrationId);
      const observations = request.toolGrants === undefined
        ? await this.assertServicesReady(request, operation, options)
        : undefined;

      const path = ledgerPath(identity);
      let entries = (await readLedger(path)).entries;
      const existing = entries[registration.registrationId];
      const cached = this.tokens.get(registration.registrationId);
      if (existing?.state === "registered" && existing.registration && cached !== undefined &&
          Date.parse(existing.registration.expiresAt) > now.getTime()) {
        return accessFor(existing.registration, cached,
          observations ?? await this.assertServicesReadyForRegistration(identity, path, entries, existing,
            request, operation, scope, options));
      }

      if (existing) entries = await this.reconcile(identity, path, entries, existing, scope, options);

      const intent = makeEntry(registration, request.taskId, "intent", now);
      entries = { ...entries, [intent.registrationId]: intent };
      await writeLedger(identity, path, entries);

      const sent = await this.control.register(registration, options, request.toolGrants);
      if (!sent.ok) {
        if (isUncertain(sent.error.code)) {
          await writeLedger(identity, path, { ...entries, [intent.registrationId]: { ...intent, state: "unknown" } });
        } else {
          await writeLedger(identity, path, withoutEntry(entries, intent.registrationId));
        }
        throw new GatewayPortError(sent.error);
      }

      const verified = verifyGrant(sent.value, registration);
      if (!verified) {
        await writeLedger(identity, path, { ...entries, [intent.registrationId]: { ...intent, state: "unknown" } });
        reject("corruption", "Gateway registration response does not match the requested registration");
      }

      const registered: LedgerEntry = { ...makeEntry(registration, request.taskId, "registered", now),
        registration: verified.registration };
      const registeredEntries = { ...entries, [registered.registrationId]: registered };
      await writeLedger(identity, path, registeredEntries);
      this.tokens.set(registered.registrationId, verified.bearerToken);
      return accessFor(verified.registration, verified.bearerToken,
        observations ?? await this.assertServicesReadyForRegistration(identity, path, registeredEntries, registered,
          request, operation, scope, options));
    }));
  }

  /**
   * Compares this generation's `registered` (and `lost`) entries with the Gateway listing for the session scope.
   * A registration that is not listed, differs in registrationId/scope/serviceIds/allowedTools/expiresAt, or has
   * expired is marked `lost` and its in-memory token dropped. A failed `list` changes nothing and reports `uncertain`.
   * A lost registration's running provider process still holds the old token: only a new launch receives a new one.
   */
  async verifyRegistrations(identity: PlatformSessionIdentity, options?: OperationOptions):
    Promise<OperationResult<GatewayRegistrationVerification>> {
    return this.serialize(() => this.guard<GatewayRegistrationVerification>(async () => {
      const scope = sessionScope(identity);
      const now = this.now();
      const checkedAt = now.toISOString();
      const path = ledgerPath(identity);
      const entries = (await readLedger(path)).entries;
      const tracked = Object.values(entries).filter(entry => entry.state === "registered" || entry.state === "lost");
      if (tracked.length === 0) return ok({ checkedAt, healthy: true, lost: [], uncertain: false });

      const listed = await this.control.list(scope, options);
      if (!listed.ok) {
        // Any failure to ask leaves the Gateway state unknown: keep the ledger as it is and report it.
        const lost = Object.values(entries).filter(entry => entry.state === "lost").map(lostReference);
        return ok({ checkedAt, healthy: false, lost, uncertain: true });
      }

      const remoteById = new Map(listed.value.map(registration => [registration.registrationId, registration]));
      const next: Record<string, LedgerEntry> = { ...entries };
      const lost: LostGatewayRegistration[] = [];
      let changed = false;
      for (const entry of tracked) {
        if (entry.state === "lost") {
          lost.push(lostReference(entry));
          continue;
        }
        const local = entry.registration;
        if (local === undefined) continue;
        const remote = remoteById.get(entry.registrationId);
        if (remote !== undefined && sameRegistration(remote, local, now)) continue;
        next[entry.registrationId] = { ...entry, state: "lost", updatedAt: checkedAt };
        this.tokens.delete(entry.registrationId);
        lost.push(lostReference(entry));
        changed = true;
      }
      if (changed) await writeLedger(identity, path, next);
      return ok({ checkedAt, healthy: lost.length === 0, lost, uncertain: false });
    }));
  }

  async revokeRole(identity: PlatformSessionIdentity, role: AgentRole, taskId?: string,
    options?: OperationOptions): Promise<OperationResult<void>> {
    return this.serialize(() => this.guard(async () => {
      const scope = sessionScope(identity);
      const path = ledgerPath(identity);
      const entries = (await readLedger(path)).entries;
      const matches = Object.values(entries).filter(entry => entry.role === role && entry.taskId === taskId);
      await this.revokeEntries(identity, path, entries, matches, scope, options);
      return ok(undefined);
    }));
  }

  /** Revokes this session's registrations in every generation ledger; shared and external services keep running. */
  async revokeSession(identity: PlatformSessionIdentity, options?: OperationOptions): Promise<OperationResult<void>> {
    return this.serialize(() => this.guard(async () => {
      const scope = sessionScope(identity);
      for (const generation of await generationDirectories(identity.stateDirectory)) {
        const path = join(identity.stateDirectory, generation, LEDGER_FILE);
        const entries = (await readLedger(path)).entries;
        await this.revokeEntries(identity, path, entries, Object.values(entries), scope, options);
      }
      return ok(undefined);
    }));
  }

  async invokeTool(identity: PlatformSessionIdentity, role: AgentRole, taskId: string | undefined, serviceId: string,
    operation: string, input: JsonValue, callId: string, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>> {
    return this.callRegisteredTool(identity, role, taskId, serviceId, operation, input, callId, false, options);
  }

  async reconcileToolCall(identity: PlatformSessionIdentity, role: AgentRole, taskId: string | undefined, serviceId: string,
    operation: string, input: JsonValue, callId: string, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>> {
    return this.callRegisteredTool(identity, role, taskId, serviceId, operation, input, callId, true, options);
  }

  private async callRegisteredTool(identity: PlatformSessionIdentity, role: AgentRole, taskId: string | undefined, serviceId: string,
    operation: string, input: JsonValue, callId: string, reconcile: boolean, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>> {
    return this.serialize(() => this.guard(async () => {
      const path = ledgerPath(identity), entries = (await readLedger(path)).entries;
      const entry = Object.values(entries).find(item => item.state === "registered" && item.role === role && item.taskId === taskId &&
        item.serviceIds.includes(serviceId) && item.allowedTools.includes(operation) && item.registration !== undefined &&
        item.registration.scope.sessionId === identity.sessionId && item.registration.scope.repositoryId === identity.repositoryId &&
        item.registration.scope.workspaceRoot === identity.workspaceRoot && item.registration.expiresAt > this.now().toISOString());
      if (!entry?.registration) throw new GatewayPortError({ code: "not_found", retryable: false,
        message: "No current Gateway registration grants this role, task, service and operation" });
      const call: MCPToolCall = { schemaVersion: 3, callId, registrationId: entry.registrationId, serviceId,
        tool: operation, input, idempotencyKey: callId };
      const parsed = MCPToolCallSchema.safeParse(call);
      if (!parsed.success) reject("validation", "Invalid Gateway tool call");
      const result = reconcile ? await this.control.reconcileToolCall(parsed.data, options) : await this.control.invokeTool(parsed.data, options);
      if (!result.ok) throw new GatewayPortError(result.error);
      const checked = MCPToolCallResultSchema.safeParse(result.value);
      if (!checked.success || checked.data.callId !== callId) reject("corruption", "Gateway tool result is malformed or mismatched");
      return ok(checked.data);
    }));
  }

  private buildRegistration(identity: PlatformSessionIdentity, scope: TrustScope, request: GatewayRoleRequest,
    now: Date): MCPClientRegistration {
    const serviceIds = [...request.serviceIds].sort();
    const allowedTools = [...request.allowedTools].sort();
    const digest = createHash("sha256").update(JSON.stringify([
      identity.sessionId, identity.generation, request.role, request.taskId ?? "", request.environmentId,
      serviceIds, allowedTools, request.configDigest
    ])).digest("hex");
    const registrationId = `reg-${digest.slice(0, 32)}`;
    const parsed = MCPClientRegistrationSchema.safeParse({
      schemaVersion: 3,
      registrationId,
      provider: request.provider,
      role: request.role,
      scope,
      environmentId: request.environmentId,
      serviceIds,
      allowedTools,
      connection: {
        transport: "streamable_http",
        endpoint: this.endpoint,
        token: `${SECRET_NAMESPACE}/${identity.sessionId}/${registrationId}`
      },
      configDigest: request.configDigest,
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      // Fresh per attempt: a re-register after revoke must not be deduplicated into the revoked record.
      idempotencyKey: `${registrationId}:${randomUUID()}`
    });
    if (!parsed.success) {
      reject("validation", "Invalid Gateway client registration", parsed.error.issues.map(issue => issue.message));
    }
    return parsed.data;
  }

  /** Fail-closed: every requested service must be ready and expose every requested tool, before any register. */
  private async assertServicesReady(request: GatewayRoleRequest, operation: ScopedOperation,
    options?: OperationOptions): Promise<readonly MCPServiceObservation[]> {
    const inspected = await this.control.inspectServices(operation, options);
    if (!inspected.ok) throw new GatewayPortError(inspected.error);
    if (!Array.isArray(inspected.value)) reject("corruption", "Gateway service inspection is malformed");

    const requested = unique(request.serviceIds);
    const byService = new Map<string, MCPServiceObservation>();
    for (const raw of inspected.value as readonly unknown[]) {
      const parsed = MCPServiceObservationSchema.safeParse(raw);
      if (!parsed.success) reject("corruption", "Gateway returned a malformed service observation");
      if (requested.includes(parsed.data.serviceId) && !byService.has(parsed.data.serviceId)) {
        byService.set(parsed.data.serviceId, parsed.data);
      }
    }

    const missingServices = requested.filter(serviceId => byService.get(serviceId)?.status !== "ready");
    const discovered = new Set(requested.flatMap(serviceId => byService.get(serviceId)?.discoveredTools ?? []));
    const missingTools = unique(request.allowedTools).filter(tool => !discovered.has(tool));
    if (missingServices.length > 0 || missingTools.length > 0) {
      reject("validation", "Requested Gateway services or tools are not ready", { missingServices, missingTools });
    }
    return requested.flatMap(serviceId => byService.get(serviceId) ?? []);
  }

  private async assertServicesReadyForRegistration(identity: PlatformSessionIdentity, path: string,
    entries: LedgerEntries, entry: LedgerEntry, request: GatewayRoleRequest, operation: ScopedOperation,
    scope: TrustScope, options?: OperationOptions): Promise<readonly MCPServiceObservation[]> {
    try {
      return await this.assertServicesReady(request, operation, options);
    } catch (readinessError) {
      try {
        await this.revokeEntries(identity, path, entries, [entry], scope, options);
      } catch (cleanupError) {
        const cleanupCode = cleanupError instanceof GatewayPortError ? cleanupError.failure.code : "corruption";
        throw new GatewayPortError({ code: "conflict", retryable: true,
          message: "Gateway registration readiness failed and cleanup could not be confirmed",
          details: { diagnosticCode: "gateway_readiness_cleanup_failed", cleanupCode } });
      }
      throw readinessError;
    }
  }

  /**
   * Clears an earlier attempt before registering again. An `intent`, `unknown` or `lost` attempt is listed first,
   * because the Gateway may have accepted it even though the reply was lost. A `registered` entry reaching this point
   * has no live in-memory token: its bearer cannot be recovered after a restart, so it is revoked outright.
   * Re-registering only helps a NEW launch; a running provider process keeps the token it was started with.
   */
  private async reconcile(identity: PlatformSessionIdentity, path: string, entries: LedgerEntries, entry: LedgerEntry,
    scope: TrustScope, options?: OperationOptions): Promise<LedgerEntries> {
    if (entry.state === "revoked") return entries;
    if (entry.state === "intent" || entry.state === "unknown" || entry.state === "lost") {
      const listed = await this.control.list(scope, options);
      if (!listed.ok) throw new GatewayPortError(listed.error);
      if (!listed.value.some(registration => registration.registrationId === entry.registrationId)) return entries;
    }
    return this.revokeEntries(identity, path, entries, [entry], scope, options);
  }

  /**
   * Revokes each non-revoked entry; Gateway `not_found` counts as already revoked. Uncertain failures mark the entry
   * `unknown`. The remaining entries are still processed, then the first failure is returned.
   */
  private async revokeEntries(identity: PlatformSessionIdentity, path: string, entries: LedgerEntries,
    targets: readonly LedgerEntry[], scope: TrustScope, options?: OperationOptions): Promise<LedgerEntries> {
    const now = this.now().toISOString();
    const next: Record<string, LedgerEntry> = { ...entries };
    // An unconfirmed entry the Gateway no longer lists (e.g. after a Gateway restart) is already gone; the Gateway
    // would refuse to revoke a registration it does not know, so it is retired locally instead.
    let listed: ReadonlySet<string> | undefined;
    if (targets.some(entry => entry.state === "intent" || entry.state === "unknown" || entry.state === "lost")) {
      const result = await this.control.list(scope, options);
      if (!result.ok) throw new GatewayPortError(result.error);
      listed = new Set(result.value.map(registration => registration.registrationId));
    }
    let failure: ContractError | undefined;
    for (const entry of targets) {
      if (entry.state === "revoked") continue;
      if (entry.state !== "registered" && listed !== undefined && !listed.has(entry.registrationId)) {
        next[entry.registrationId] = { ...entry, state: "revoked", updatedAt: now };
        this.tokens.delete(entry.registrationId);
        continue;
      }
      const result = await this.control.revoke(entry.registrationId, scopedOperation(scope, entry.registrationId), options);
      if (result.ok || result.error.code === "not_found") {
        next[entry.registrationId] = { ...entry, state: "revoked", updatedAt: now };
        this.tokens.delete(entry.registrationId);
        continue;
      }
      failure ??= result.error;
      if (isUncertain(result.error.code)) {
        next[entry.registrationId] = { ...entry, state: "unknown", updatedAt: now };
        this.tokens.delete(entry.registrationId);
      }
    }
    await writeLedger(identity, path, next);
    if (failure) throw new GatewayPortError(failure);
    return next;
  }

  /** Serializes calls within this process; the ledger is not coordinated across processes. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async guard<T>(run: () => Promise<OperationResult<T>>): Promise<OperationResult<T>> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GatewayPortError) return failWith(error.failure);
      if (error instanceof LedgerError) return fail(error.code, error.message);
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === "string") return fail("corruption", `Gateway registration ledger I/O failed (${code})`);
      throw error;
    }
  }
}

// ----------------------------------------------------------------- helpers

function reject(code: "validation" | "corruption", message: string, details?: JsonValue): never {
  const result = fail<never>(code, message, details);
  if (result.ok) throw new Error("unreachable");
  throw new GatewayPortError(result.error);
}

function sessionScope(identity: PlatformSessionIdentity): TrustScope {
  if (!Number.isInteger(identity.generation) || identity.generation <= 0) {
    reject("validation", "Session generation must be a positive integer");
  }
  const parsed = TrustScopeSchema.safeParse({
    kind: "session",
    machineId: identity.machineId,
    repositoryId: identity.repositoryId,
    workspaceRoot: identity.workspaceRoot,
    sessionId: identity.sessionId
  });
  if (!parsed.success) reject("validation", "Invalid session identity for Gateway registration");
  return parsed.data;
}

function scopedOperation(scope: TrustScope, idempotencyKey: string): ScopedOperation {
  return { schemaVersion: 3, scope, idempotencyKey };
}

function ledgerPath(identity: PlatformSessionIdentity): string {
  return join(identity.stateDirectory, `gen-${identity.generation}`, LEDGER_FILE);
}

function isUncertain(code: ContractError["code"]): boolean {
  return code === "timeout" || code === "transport_unavailable" || code === "unknown_delivery" || code === "cancelled";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function lostReference(entry: LedgerEntry): LostGatewayRegistration {
  return {
    registrationId: entry.registrationId,
    role: entry.role,
    ...(entry.taskId === undefined ? {} : { taskId: entry.taskId })
  };
}

/** A listed registration still matches the ledger echo and has not expired (order-insensitive arrays). */
function sameRegistration(remote: MCPClientRegistration, local: MCPClientRegistration, now: Date): boolean {
  if (remote.registrationId !== local.registrationId) return false;
  if (canonical(remote.scope) !== canonical(local.scope)) return false;
  if (!sameSet(remote.serviceIds, local.serviceIds) || !sameSet(remote.allowedTools, local.allowedTools)) return false;
  const remoteExpiry = Date.parse(remote.expiresAt);
  return remoteExpiry === Date.parse(local.expiresAt) && remoteExpiry > now.getTime();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function withoutEntry(entries: LedgerEntries, registrationId: string): Record<string, LedgerEntry> {
  const next: Record<string, LedgerEntry> = { ...entries };
  delete next[registrationId];
  return next;
}

function makeEntry(registration: MCPClientRegistration, taskId: string | undefined, state: LedgerState,
  now: Date): LedgerEntry {
  return {
    registrationId: registration.registrationId,
    role: registration.role,
    provider: registration.provider,
    ...(taskId === undefined ? {} : { taskId }),
    environmentId: registration.environmentId,
    serviceIds: registration.serviceIds,
    allowedTools: registration.allowedTools,
    configDigest: registration.configDigest,
    state,
    updatedAt: now.toISOString()
  };
}

/** Checks the Gateway's echo against what was sent; arrays are compared order-insensitively. */
function verifyGrant(grant: GatewayRegistrationGrant, sent: MCPClientRegistration):
  { registration: MCPClientRegistration; bearerToken: string } | undefined {
  const parsed = MCPClientRegistrationSchema.safeParse(grant.registration);
  if (!parsed.success || typeof grant.bearerToken !== "string" || grant.bearerToken.length === 0) return undefined;
  if (canonical(projection(parsed.data)) !== canonical(projection(sent))) return undefined;
  return { registration: parsed.data, bearerToken: grant.bearerToken };
}

function projection(registration: MCPClientRegistration): MCPClientRegistration {
  return { ...registration, serviceIds: [...registration.serviceIds].sort(), allowedTools: [...registration.allowedTools].sort() };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

function accessFor(registration: MCPClientRegistration, bearerToken: string,
  observations: readonly MCPServiceObservation[]): OperationResult<RoleGatewayAccess> {
  return ok({
    registrations: [registration],
    observations,
    tokenEnvironment: { [tokenEnvironmentName(registration.registrationId)]: bearerToken }
  });
}

/** `BFLOW_MCP_TOKEN_<UPPER registration suffix>`, restricted to `[A-Z0-9_]`, at most 64 characters. */
/** Env var carrying a registration's bearer token; adapters reference it by name only. */
export function tokenEnvironmentName(registrationId: string): string {
  const suffix = registrationId.replace(/^reg-/, "").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const name = `${TOKEN_ENV_PREFIX}${suffix}`;
  if (name.length > MAX_ENV_NAME_LENGTH) reject("validation", "Gateway token environment name is too long");
  return name;
}

// ------------------------------------------------------------- ledger I/O

/** Returns false when the path is absent; refuses symlinks and wrong file types. */
async function assertNotSymlink(path: string, kind: "directory" | "file"): Promise<boolean> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return false;
  if (info.isSymbolicLink()) throw new LedgerError("validation", `Refusing symlinked Gateway ledger ${kind}`);
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) {
    throw new LedgerError("validation", `Gateway ledger ${kind} has an unexpected type`);
  }
  return true;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNotSymlink(directory, "directory");
}

async function generationDirectories(stateDirectory: string): Promise<string[]> {
  if (!(await assertNotSymlink(stateDirectory, "directory"))) return [];
  const generations: string[] = [];
  for (const entry of await readdir(stateDirectory, { withFileTypes: true })) {
    if (!/^gen-[1-9]\d*$/.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new LedgerError("validation", "Refusing symlinked Gateway ledger generation");
    if (entry.isDirectory()) generations.push(entry.name);
  }
  return generations.sort();
}

async function readLedger(path: string): Promise<{ entries: LedgerEntries }> {
  if (!(await assertNotSymlink(join(path, ".."), "directory"))) return { entries: {} };
  if (!(await assertNotSymlink(path, "file"))) return { entries: {} };
  const text = await readFile(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LedgerError("corruption", "Gateway registration ledger is not valid JSON");
  }
  return { entries: parseEntries(raw) };
}

/** Atomic replace: temp file (0600) → fsync → rename. Callers pass the full entry set. */
async function writeLedger(identity: PlatformSessionIdentity, path: string, entries: LedgerEntries): Promise<void> {
  await ensurePrivateDirectory(identity.stateDirectory);
  await ensurePrivateDirectory(join(path, ".."));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: LEDGER_SCHEMA_VERSION, entries }, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

// ------------------------------------------------------------ ledger parse

const LEDGER_KEYS = ["schemaVersion", "entries"] as const;
const ENTRY_KEYS = ["registrationId", "role", "provider", "taskId", "environmentId", "serviceIds", "allowedTools",
  "configDigest", "state", "registration", "updatedAt"] as const;

function parseEntries(raw: unknown): LedgerEntries {
  if (!isRecord(raw) || raw.schemaVersion !== LEDGER_SCHEMA_VERSION || !isRecord(raw.entries) || hasExtraKeys(raw, LEDGER_KEYS)) {
    throw new LedgerError("corruption", "Gateway registration ledger has an unsupported shape");
  }
  const entries: Record<string, LedgerEntry> = {};
  for (const [key, value] of Object.entries(raw.entries)) {
    const entry = parseEntry(value);
    if (entry.registrationId !== key) throw new LedgerError("corruption", "Gateway registration ledger key mismatch");
    entries[key] = entry;
  }
  return entries;
}

function parseEntry(raw: unknown): LedgerEntry {
  if (!isRecord(raw) || hasExtraKeys(raw, ENTRY_KEYS)) {
    throw new LedgerError("corruption", "Gateway registration ledger entry is malformed");
  }
  const role = AgentRoleSchema.safeParse(raw.role);
  const provider = AgentProviderIdSchema.safeParse(raw.provider);
  const digest = Sha256DigestSchema.safeParse(raw.configDigest);
  const updatedAt = IsoDateTimeSchema.safeParse(raw.updatedAt);
  const state = LEDGER_STATES.find(candidate => candidate === raw.state);
  if (typeof raw.registrationId !== "string" || raw.registrationId.trim().length === 0 ||
      typeof raw.environmentId !== "string" || raw.environmentId.length === 0 ||
      !isStringArray(raw.serviceIds) || raw.serviceIds.length === 0 ||
      !isStringArray(raw.allowedTools) || raw.allowedTools.length === 0 ||
      (raw.taskId !== undefined && (typeof raw.taskId !== "string" || raw.taskId.length === 0)) ||
      !role.success || !provider.success || !digest.success || !updatedAt.success || state === undefined) {
    throw new LedgerError("corruption", "Gateway registration ledger entry has invalid fields");
  }
  let registration: MCPClientRegistration | undefined;
  if (raw.registration !== undefined) {
    const parsed = MCPClientRegistrationSchema.safeParse(raw.registration);
    if (!parsed.success || parsed.data.registrationId !== raw.registrationId) {
      throw new LedgerError("corruption", "Gateway registration ledger holds an invalid registration");
    }
    registration = parsed.data;
  }
  if (state === "registered" && registration === undefined) {
    throw new LedgerError("corruption", "Registered ledger entry is missing its registration");
  }
  return {
    registrationId: raw.registrationId,
    role: role.data,
    provider: provider.data,
    ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
    environmentId: raw.environmentId,
    serviceIds: raw.serviceIds,
    allowedTools: raw.allowedTools,
    configDigest: digest.data,
    state,
    ...(registration === undefined ? {} : { registration }),
    updatedAt: updatedAt.data
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0);
}

function hasExtraKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some(key => !allowed.includes(key));
}
