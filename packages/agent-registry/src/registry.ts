import {
  AcquireAgentLeaseRequestSchema, AgentConfigurationSchema, AgentLeaseSchema,
  AgentResolutionContextSchema, IdentifierSchema, ReleaseAgentLeaseRequestSchema, RenewAgentLeaseRequestSchema
} from "@ai-flow/contracts";
import type {
  AcquireAgentLeaseRequest, AgentConfiguration, AgentLease, AgentRegistry, AgentResolutionContext,
  ContractError, OperationOptions, OperationResult, ReleaseAgentLeaseRequest, RenewAgentLeaseRequest
} from "@ai-flow/contracts";
import { FileRegistryStore, RegistryLockTimeout } from "./store.js";
import type { RegistryState, StoredReceipt } from "./store.js";

const ok = <T>(value: T): OperationResult<T> => ({ ok: true, value });
const fail = <T>(error: ContractError): OperationResult<T> => ({ ok: false, error });
const validation = (message: string): ContractError => ({ code: "validation", retryable: false, message });
const conflict = (message: string): ContractError => ({ code: "conflict", retryable: true, message });
const notFound = (message: string): ContractError => ({ code: "not_found", retryable: false, message });

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, value: unknown): OperationResult<T> {
  const result = schema.safeParse(value);
  return result.success ? ok(result.data) : fail(validation(result.error.message));
}

function clockMs(state: RegistryState, clock: () => Date): number {
  const time = Math.max(clock().getTime(), Date.parse(state.lastNow));
  state.lastNow = new Date(time).toISOString();
  return time;
}

function active(entry: { lease: AgentLease; active: boolean }, time: number): boolean {
  return entry.active && Date.parse(entry.lease.expiresAt) > time;
}

function receipt(state: RegistryState, key: string, fingerprint: string): OperationResult<StoredReceipt | null> {
  const prior = state.receipts[key];
  if (!prior) return ok(null);
  return prior.fingerprint === fingerprint ? ok(prior) : fail(conflict("Idempotency key reused with different registry command"));
}

export interface FileAgentRegistryOptions { readonly stateFile: string; readonly clock?: () => Date }

export class FileAgentRegistry implements AgentRegistry {
  readonly #store: FileRegistryStore;
  readonly #clock: () => Date;

  constructor(options: FileAgentRegistryOptions) {
    this.#store = new FileRegistryStore(options.stateFile);
    this.#clock = options.clock ?? (() => new Date());
  }

  async #operate<T>(action: (state: RegistryState) => OperationResult<T>, options?: OperationOptions): Promise<OperationResult<T>> {
    try { return await this.#store.transaction(action, options); }
    catch (error) {
      if (error instanceof RegistryLockTimeout) return fail({ code: "timeout", retryable: true, retrySafety: "not_started", message: error.message });
      if (error instanceof DOMException && error.name === "AbortError") return fail({ code: "cancelled", retryable: false, message: error.message });
      return fail({ code: "corruption", retryable: false, message: error instanceof Error ? error.message : "Registry state error" });
    }
  }

  async resolve(role: string, context: AgentResolutionContext, options?: OperationOptions): Promise<OperationResult<AgentConfiguration | null>> {
    if (!role) return fail(validation("Agent role must not be empty"));
    const input = parse(AgentResolutionContextSchema, context);
    if (!input.ok) return input;
    context = input.value;
    return this.#operate((state) => {
      const candidates = Object.values(state.configurations).filter((agent) => agent.enabled && agent.role === role &&
        context.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)) &&
        (context.preferredAgentId === undefined || agent.agentId === context.preferredAgentId));
      candidates.sort((a, b) => b.priority - a.priority || a.agentId.localeCompare(b.agentId));
      return ok(candidates[0] ?? null);
    }, options);
  }

  async acquireLease(request: AcquireAgentLeaseRequest, options?: OperationOptions): Promise<OperationResult<AgentLease>> {
    const input = parse(AcquireAgentLeaseRequestSchema, request);
    if (!input.ok) return input;
    request = input.value;
    return this.#operate((state) => {
      const fingerprint = JSON.stringify(input.value);
      const prior = receipt(state, request.idempotencyKey, fingerprint);
      if (!prior.ok) return prior;
      if (prior.value) return prior.value.lease ? ok(prior.value.lease) : fail(conflict("Incompatible registry receipt"));
      const time = clockMs(state, this.#clock);
      const config = state.configurations[request.agentId];
      if (!config || !config.enabled) return fail(notFound("Agent is not configured or disabled"));
      if (state.leases[request.leaseId]) return fail(conflict("Lease ID already used"));
      if (Object.values(state.leases).some((entry) => entry.lease.runId === request.runId && entry.lease.taskId === request.taskId && entry.lease.attemptId === request.attemptId && active(entry, time))) return fail(conflict("Attempt already has an active lease"));
      const count = Object.values(state.leases).filter((entry) => entry.lease.agentId === request.agentId && active(entry, time)).length;
      if (count >= config.maxConcurrentTasks) return fail(conflict("Agent concurrency limit reached"));
      if (!Number.isFinite(time + request.ttlMs) || time + request.ttlMs > 8.64e15) return fail(validation("Lease TTL exceeds supported date range"));
      const token = (state.nextFencing[request.agentId] ?? 0) + 1;
      if (!Number.isSafeInteger(token)) return fail({ code: "corruption", retryable: false, message: "Fencing token exhausted" });
      state.nextFencing[request.agentId] = token;
      const lease = AgentLeaseSchema.parse({ leaseId: request.leaseId, agentId: request.agentId, runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, fencingToken: token, version: 0, acquiredAt: new Date(time).toISOString(), expiresAt: new Date(time + request.ttlMs).toISOString() });
      state.leases[lease.leaseId] = { lease, active: true };
      state.receipts[request.idempotencyKey] = { fingerprint, kind: "lease", lease };
      return ok(lease);
    }, options);
  }

  async renewLease(request: RenewAgentLeaseRequest, options?: OperationOptions): Promise<OperationResult<AgentLease>> {
    const input = parse(RenewAgentLeaseRequestSchema, request);
    if (!input.ok) return input;
    request = input.value;
    return this.#operate((state) => {
      const fingerprint = JSON.stringify(input.value);
      const prior = receipt(state, request.idempotencyKey, fingerprint);
      if (!prior.ok) return prior;
      if (prior.value) return prior.value.lease ? ok(prior.value.lease) : fail(conflict("Incompatible registry receipt"));
      const time = clockMs(state, this.#clock);
      const entry = state.leases[request.leaseId];
      if (!entry) return fail(notFound("Lease not found"));
      if (!active(entry, time)) return fail(conflict("Lease expired or released"));
      if (entry.lease.fencingToken !== request.fencingToken || entry.lease.version !== request.expectedVersion) return fail(conflict("Stale fencing token or lease version"));
      if (!Number.isFinite(time + request.ttlMs) || time + request.ttlMs > 8.64e15) return fail(validation("Lease TTL exceeds supported date range"));
      const lease = AgentLeaseSchema.parse({ ...entry.lease, version: entry.lease.version + 1, expiresAt: new Date(time + request.ttlMs).toISOString() });
      entry.lease = lease;
      state.receipts[request.idempotencyKey] = { fingerprint, kind: "lease", lease };
      return ok(lease);
    }, options);
  }

  async releaseLease(request: ReleaseAgentLeaseRequest, options?: OperationOptions): Promise<OperationResult<void>> {
    const input = parse(ReleaseAgentLeaseRequestSchema, request);
    if (!input.ok) return input;
    request = input.value;
    return this.#operate((state) => {
      const fingerprint = JSON.stringify(input.value);
      const prior = receipt(state, request.idempotencyKey, fingerprint);
      if (!prior.ok) return prior;
      if (prior.value) return prior.value.kind === "void" ? ok(undefined) : fail(conflict("Incompatible registry receipt"));
      const time = clockMs(state, this.#clock);
      const entry = state.leases[request.leaseId];
      if (!entry) return fail(notFound("Lease not found"));
      if (!active(entry, time)) return fail(conflict("Lease expired or already released"));
      if (entry.lease.fencingToken !== request.fencingToken || entry.lease.version !== request.expectedVersion) return fail(conflict("Stale fencing token or lease version"));
      entry.active = false;
      state.receipts[request.idempotencyKey] = { fingerprint, kind: "void" };
      return ok(undefined);
    }, options);
  }

  async list(role?: string, options?: OperationOptions): Promise<OperationResult<readonly AgentConfiguration[]>> {
    return this.#operate((state) => ok(Object.values(state.configurations).filter((agent) => role === undefined || agent.role === role).sort((a, b) => a.agentId.localeCompare(b.agentId))), options);
  }

  async upsert(configuration: AgentConfiguration, options?: OperationOptions): Promise<OperationResult<void>> {
    const input = parse(AgentConfigurationSchema, configuration);
    if (!input.ok) return input;
    configuration = input.value;
    return this.#operate((state) => {
      const time = clockMs(state, this.#clock);
      const occupied = Object.values(state.leases).filter((entry) => entry.lease.agentId === configuration.agentId && active(entry, time)).length;
      if (occupied > configuration.maxConcurrentTasks) return fail(conflict("Cannot lower capacity below active leases"));
      if (occupied > 0 && state.configurations[configuration.agentId] && JSON.stringify(state.configurations[configuration.agentId]) !== JSON.stringify(input.value)) return fail(conflict("Cannot change agent configuration while leases are active"));
      state.configurations[configuration.agentId] = input.value;
      return ok(undefined);
    }, options);
  }

  async remove(agentId: string, options?: OperationOptions): Promise<OperationResult<boolean>> {
    const identifier = parse(IdentifierSchema, agentId);
    if (!identifier.ok) return identifier;
    agentId = identifier.value;
    return this.#operate((state) => {
      const time = clockMs(state, this.#clock);
      if (Object.values(state.leases).some((entry) => entry.lease.agentId === agentId && active(entry, time))) return fail(conflict("Cannot remove agent with active leases"));
      if (!state.configurations[agentId]) return ok(false);
      delete state.configurations[agentId];
      return ok(true);
    }, options);
  }
}

export function createAgentRegistry(options: FileAgentRegistryOptions): AgentRegistry {
  return new FileAgentRegistry(options);
}
