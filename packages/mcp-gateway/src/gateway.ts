import { randomUUID } from "node:crypto";
import type {
  ContractError,
  MCPClientRegistration,
  MCPResourceLease,
  MCPResourceRenewRequest,
  MCPResourceRequest,
  MCPToolCall,
  MCPToolCallResult,
  JsonValue,
  ResolvedToolGrant,
  OperationOptions,
  OperationResult,
  ScopedOperation
} from "@bflow/contracts";
import {
  MCPClientRegistrationSchema,
  MCPResourceLeaseSchema,
  MCPResourceRenewRequestSchema,
  MCPResourceRequestSchema,
  MCPToolCallSchema,
  MCPToolCallResultSchema,
  ScopedOperationSchema,
  isTrustScopeWithin,
  ResolvedToolGrantSchema
} from "@bflow/contracts";
import type {
  ActiveClientSession,
  GatewayAuditEntry,
  GatewayMetricsSnapshot,
  MCPUpstreamToolCallInput,
  MCPUpstreamToolDefinition,
  RecordedCallLedgerEntry
} from "./types.js";
import { err, ok } from "./types.js";
import {
  checkSchemaVersion,
  computePayloadFingerprint,
  computePartitionKey,
  isInteractiveMethodForbidden,
  scrubSecrets,
  GatewaySecretStore
} from "./security.js";
import { GatewayMetricsCollector } from "./metrics.js";
import { MCPServiceRegistry } from "./registry.js";
import { DefaultMCPServiceManager, type DefaultMCPServiceManagerOptions } from "./service-manager.js";
import { fallbackToolDefinition, isSupportedJsonSchema, validateJsonSchema } from "./tool-definitions.js";
import { DurableGatewayCallLedger } from "./durable-ledger.js";

interface ResourceState {
  currentFence: number;
  activeLease?: MCPResourceLease | undefined;
  quarantinedByCallId?: string | undefined;
}

interface ConcurrencySlot {
  activeCalls: number;
  readonly queue: Array<{
    readonly requestId: string;
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: ContractError) => void;
  }>;
}

export interface BflowSharedMCPGatewayOptions {
  readonly registry?: MCPServiceRegistry | undefined;
  readonly serviceManager?: DefaultMCPServiceManager | undefined;
  readonly metrics?: GatewayMetricsCollector | undefined;
  readonly secretStore?: GatewaySecretStore | undefined;
  /** Trusted host decisions about known services; see `DefaultMCPServiceManagerOptions.policyOverrides`. */
  readonly policyOverrides?: DefaultMCPServiceManagerOptions["policyOverrides"];
  readonly now?: (() => Date) | undefined;
  /** Private durable receipt path. Intent records prevent uncertain calls from being replayed after restart. */
  readonly callLedgerPath?: string | undefined;
  /** Host-side trusted lookup; never infer an authority grant from skill metadata or tool names. */
  readonly toolGrantResolver?: ((registration: MCPClientRegistration, call: MCPToolCall) => ResolvedToolGrant | readonly ResolvedToolGrant[] | undefined) | undefined;
  /** Require every Gateway call to have a matching host-resolved tool grant. */
  readonly requireResolvedToolGrants?: boolean | ((registration: MCPClientRegistration) => boolean) | undefined;
}

export class BflowSharedMCPGateway {
  readonly registry: MCPServiceRegistry;
  readonly serviceManager: DefaultMCPServiceManager;
  readonly metrics: GatewayMetricsCollector;
  readonly secretStore: GatewaySecretStore;
  readonly now: () => Date;
  private readonly durableCallLedger?: DurableGatewayCallLedger;
  private readonly toolGrantResolver?: BflowSharedMCPGatewayOptions["toolGrantResolver"];
  private readonly requireResolvedToolGrants: boolean | ((registration: MCPClientRegistration) => boolean);

  private readonly registrations = new Map<string, MCPClientRegistration>();
  private readonly sessions = new Map<string, ActiveClientSession>();
  private readonly auditLog: GatewayAuditEntry[] = [];
  private readonly idempotencyCache = new Map<string, { fingerprint: string; result: any }>();
  private readonly resourceStates = new Map<string, ResourceState>();
  private readonly callLedger = new Map<string, RecordedCallLedgerEntry>();
  private readonly concurrencyQueues = new Map<string, ConcurrencySlot>();

  constructor(options?: BflowSharedMCPGatewayOptions) {
    this.registry = options?.registry ?? options?.serviceManager?.registry ?? new MCPServiceRegistry();
    this.metrics = options?.metrics ?? options?.serviceManager?.metrics ?? new GatewayMetricsCollector();
    this.secretStore = options?.secretStore ?? options?.serviceManager?.secretStore ?? new GatewaySecretStore();
    this.serviceManager =
      options?.serviceManager ??
      new DefaultMCPServiceManager({
        registry: this.registry,
        metrics: this.metrics,
        secretStore: this.secretStore,
        ...(options?.policyOverrides !== undefined ? { policyOverrides: options.policyOverrides } : {}),
        ...(options?.now !== undefined ? { now: options.now } : {})
      });
    this.now = options?.now ?? (() => new Date());
    if (options?.callLedgerPath) this.durableCallLedger = new DurableGatewayCallLedger(options.callLedgerPath);
    this.toolGrantResolver = options?.toolGrantResolver;
    this.requireResolvedToolGrants = options?.requireResolvedToolGrants ?? false;

    this.serviceManager.onCrash((partitionKey, reason) => {
      this.handleBackendCrash(partitionKey, reason);
    });

    this.serviceManager.setHasUncertainCallsCheck((partitionKey) =>
      Array.from(this.callLedger.values()).some(
        (e) => e.partitionKey === partitionKey && e.result.status === "unknown"
      )
    );
  }

  private getPartitionKeysForClient(reg: MCPClientRegistration): string[] {
    const keys: string[] = [];
    for (const serviceId of reg.serviceIds) {
      const entry = this.registry.getService(serviceId);
      if (entry) {
        const partRes = computePartitionKey(entry.definition, entry.policy, reg.scope);
        if (partRes.ok) {
          keys.push(partRes.value);
        }
      }
    }
    return keys;
  }

  private handleBackendCrash(partitionKey: string, reason: string): void {
    const nowIso = this.now().toISOString();
    for (const [callId, ledger] of this.callLedger.entries()) {
      if (ledger.partitionKey === partitionKey && ledger.result.status === "unknown") {
        ledger.result = {
          schemaVersion: 3,
          callId,
          status: "unknown",
          output: {
            diagnosticCode: "backend_crashed",
            message: `Upstream driver crashed: ${reason}`
          },
          observedAt: nowIso
        };
        if (ledger.call.resourceLease) {
          const resState = this.getResourceState(
            ledger.call.serviceId,
            ledger.call.resourceLease.resourceKey
          );
          resState.quarantinedByCallId = callId;
        }
      }
    }
  }

  private getResourceState(serviceId: string, resourceKey: string): ResourceState {
    const key = `${serviceId}:${resourceKey}`;
    let state = this.resourceStates.get(key);
    if (!state) {
      state = { currentFence: 0 };
      this.resourceStates.set(key, state);
    }
    return state;
  }

  private clearQuarantine(serviceId: string, callId: string): void {
    for (const [key, state] of this.resourceStates.entries()) {
      if (key.startsWith(`${serviceId}:`) && state.quarantinedByCallId === callId) {
        state.quarantinedByCallId = undefined;
      }
    }
  }

  private recordAudit(entry: Omit<GatewayAuditEntry, "auditId" | "timestamp">): void {
    const auditId = `audit-${randomUUID()}`;
    const timestamp = this.now().toISOString();
    const scrubbedMessage = scrubSecrets(entry.message);
    const fullEntry: GatewayAuditEntry = {
      auditId,
      timestamp,
      ...entry,
      message: scrubbedMessage
    };
    this.auditLog.push(fullEntry);
  }

  private checkIdempotency<T>(
    idempotencyKey: string,
    payload: unknown
  ): { cached?: OperationResult<T>; conflict?: boolean } {
    const existing = this.idempotencyCache.get(idempotencyKey);
    if (!existing) return {};
    const currentFingerprint = computePayloadFingerprint(payload);
    if (existing.fingerprint === currentFingerprint) {
      return { cached: existing.result };
    }
    return { conflict: true };
  }

  private recordIdempotency<T>(
    idempotencyKey: string,
    payload: unknown,
    result: OperationResult<T>
  ): void {
    const fingerprint = computePayloadFingerprint(payload);
    this.idempotencyCache.set(idempotencyKey, { fingerprint, result });
  }

  getAuditLog(): readonly GatewayAuditEntry[] {
    return [...this.auditLog];
  }

  getMetrics(): GatewayMetricsSnapshot {
    return this.metrics.snapshot();
  }

  authenticateToken(bearerToken: string): OperationResult<MCPClientRegistration> {
    const registrationId = this.secretStore.resolveRegistrationByToken(bearerToken);
    if (!registrationId) {
      this.recordAudit({
        action: "security.violation",
        status: "blocked",
        diagnosticCode: "unauthorized_token",
        message: "Invalid or unresolvable bearer token"
      });
      return err({ code: "validation", retryable: false, message: "Invalid bearer token" });
    }
    const reg = this.registrations.get(registrationId);
    if (!reg) {
      this.recordAudit({
        action: "security.violation",
        registrationId,
        status: "blocked",
        diagnosticCode: "unknown_registration",
        message: "Registration not found for token"
      });
      return err({ code: "validation", retryable: false, message: "Registration not found" });
    }
    if (Date.parse(reg.expiresAt) <= this.now().getTime()) {
      this.recordAudit({
        action: "security.violation",
        registrationId,
        status: "blocked",
        diagnosticCode: "registration_expired",
        message: "Registration expired"
      });
      return err({ code: "validation", retryable: false, message: "Registration has expired" });
    }
    return ok(reg);
  }

  openSession(registrationId: string): OperationResult<ActiveClientSession> {
    const reg = this.registrations.get(registrationId);
    if (!reg) {
      return err({ code: "not_found", retryable: false, message: "Registration not found" });
    }
    if (Date.parse(reg.expiresAt) <= this.now().getTime()) {
      return err({ code: "validation", retryable: false, message: "Registration has expired" });
    }

    for (const serviceId of reg.serviceIds) {
      const entry = this.registry.getService(serviceId);
      if (!entry) continue;
      const partRes = computePartitionKey(entry.definition, entry.policy, reg.scope);
      if (!partRes.ok) continue;
      const partitionKey = partRes.value;

      if (entry.policy.concurrencyModel === "single_client_isolated") {
        const state = this.serviceManager.getPartitionState(partitionKey);
        if (state && Array.from(state.activeClients).some((c) => c !== registrationId)) {
          return err({
            code: "conflict",
            retryable: true,
            message:
              "Service policy single_client_isolated forbids multiple concurrent clients in the same partition",
            details: { diagnosticCode: "single_client_limit" }
          });
        }
      }
      this.serviceManager.attachClient(partitionKey, registrationId, entry);
    }

    const sessionId = `session-${randomUUID()}`;
    const nowIso = this.now().toISOString();
    const session: ActiveClientSession = {
      sessionId,
      registrationId,
      registration: reg,
      createdAt: nowIso,
      lastActiveAt: nowIso,
      connected: true
    };

    this.sessions.set(sessionId, session);
    this.metrics.recordClientConnect(reg.serviceIds[0]);
    this.metrics.setActiveSessions(this.sessions.size);

    return ok(session);
  }

  getSession(sessionId: string): ActiveClientSession | undefined {
    return this.sessions.get(sessionId);
  }

  disconnectSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.connected = false;
      this.sessions.delete(sessionId);
      this.metrics.recordClientDisconnect(session.registration.serviceIds[0]);
      this.metrics.setActiveSessions(this.sessions.size);

      const hasOtherConnected = Array.from(this.sessions.values()).some(
        (s) => s.registrationId === session.registrationId && s.connected
      );
      if (!hasOtherConnected) {
        for (const p of this.getPartitionKeysForClient(session.registration)) {
          this.serviceManager.detachClient(p, session.registrationId);
        }
      }

      this.recordAudit({
        action: "client.disconnect",
        registrationId: session.registrationId,
        sessionId,
        status: "succeeded",
        diagnosticCode: "disconnected",
        message: "Client session disconnected"
      });
    }
  }

  async listToolsForClient(
    registrationId: string,
    _sessionId?: string,
    options?: OperationOptions
  ): Promise<
    OperationResult<
      readonly { serviceId: string; tool: string; definition: MCPUpstreamToolDefinition }[]
    >
  > {
    const reg = this.registrations.get(registrationId);
    if (!reg) {
      return err({ code: "not_found", retryable: false, message: "Registration not found" });
    }
    if (Date.parse(reg.expiresAt) <= this.now().getTime()) {
      return err({ code: "validation", retryable: false, message: "Registration has expired" });
    }

    const results: { serviceId: string; tool: string; definition: MCPUpstreamToolDefinition }[] = [];
    for (const serviceId of reg.serviceIds) {
      const entry = this.registry.getService(serviceId);
      if (!entry) continue;

      const partRes = computePartitionKey(entry.definition, entry.policy, reg.scope);
      if (!partRes.ok) continue;

      const ensureRes = await this.serviceManager.ensure(
        entry.definition,
        {
          schemaVersion: 3,
          scope: reg.scope,
          idempotencyKey: `list-tools-${randomUUID()}`
        },
        options
      );
      if (!ensureRes.ok) continue;

      const state = this.serviceManager.getPartitionState(partRes.value);
      const known = new Map((state?.toolDefinitions ?? []).map(definition => [definition.name, definition]));
      const defaulted = new Set(state?.defaultedInputSchemaTools ?? []);
      for (const tool of ensureRes.value.discoveredTools) {
        if (!reg.allowedTools.includes(tool)) continue;
        if (defaulted.has(tool)) {
          this.recordAudit({
            action: "service.ensure",
            registrationId,
            serviceId,
            scope: reg.scope,
            status: "succeeded",
            diagnosticCode: "tool_input_schema_defaulted",
            message: `Upstream tool '${tool}' omitted inputSchema; advertised as {"type":"object"}`
          });
        }
        results.push({ serviceId, tool, definition: known.get(tool) ?? fallbackToolDefinition(tool) });
      }
    }

    return ok(results);
  }

  async register(
    client: MCPClientRegistration,
    _options?: OperationOptions
  ): Promise<OperationResult<MCPClientRegistration>> {
    const verRes = checkSchemaVersion(client);
    if (!verRes.ok) return verRes;

    const parseResult = MCPClientRegistrationSchema.safeParse(client);
    if (!parseResult.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parseResult.error.message,
        details: parseResult.error.flatten() as any
      });
    }

    const idCheck = this.checkIdempotency<MCPClientRegistration>(
      client.idempotencyKey,
      client
    );
    if (idCheck.cached) return idCheck.cached;
    if (idCheck.conflict) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Conflicting payload for idempotencyKey"
      });
    }

    if (Date.parse(client.expiresAt) <= this.now().getTime()) {
      return err({
        code: "validation",
        retryable: false,
        message: "Client registration is already expired"
      });
    }

    for (const serviceId of client.serviceIds) {
      const entry = this.registry.getService(serviceId);
      if (!entry) {
        return err({
          code: "not_found",
          retryable: false,
          message: `Service '${serviceId}' not found in registry`
        });
      }
    }

    const strictToolRegistration = typeof this.requireResolvedToolGrants === "function"
      ? this.requireResolvedToolGrants(client) : this.requireResolvedToolGrants;
    if (strictToolRegistration) {
      const grants = this.toolGrantResolver?.(client, {
        schemaVersion: 3, callId: "registration-preflight", registrationId: client.registrationId,
        serviceId: client.serviceIds[0]!, tool: client.allowedTools[0]!, input: {}, idempotencyKey: client.idempotencyKey
      });
      const grantValues = grants === undefined ? [] : Array.isArray(grants) ? grants : [grants];
      const parsedGrants = grantValues.map(value => ResolvedToolGrantSchema.safeParse(value));
      if (parsedGrants.some(parsed => !parsed.success)) {
        return err({ code: "validation", retryable: false, message: "Resolved tool grants failed schema validation during registration" });
      }
      if (!parsedGrants.length) {
        return err({ code: "validation", retryable: false, message: "A new Gateway registration requires at least one resolved tool grant" });
      }
      for (const serviceId of client.serviceIds) {
        const entry = this.registry.getService(serviceId)!;
        const grantsForService = parsedGrants.flatMap(parsed => parsed.success ? [parsed.data] : [])
          .filter(grant => grant.serviceId === serviceId && grant.role === client.role &&
            computePayloadFingerprint(grant.scope) === computePayloadFingerprint(client.scope));
        if (!grantsForService.length) continue;
        if (grantsForService.some(grant => grant.toolId !== entry.definition.tool.toolId || grant.kind !== entry.definition.tool.kind ||
            grant.operations.some(operationName => !entry.definition.tool.operations.includes(operationName)))) {
          return err({ code: "validation", retryable: false, message: `Resolved grant does not match service '${serviceId}' capability` });
        }
        if (grantsForService.some(grant => grant.memoryScope &&
            grant.operations.some(operationName => !entry.policy.readOnlyTools?.includes(operationName)))) {
          return err({ code: "validation", retryable: false,
            message: `Memory-scoped grant for service '${serviceId}' may authorize only configured read-only operations` });
        }
        const operation: ScopedOperation = { schemaVersion: 3, scope: client.scope, idempotencyKey: client.idempotencyKey };
        const ensured = await this.serviceManager.ensure(entry.definition, operation, { timeoutMs: entry.definition.healthTimeoutMs });
        if (!ensured.ok || ensured.value.status !== "ready") {
          return err({ code: "transport_unavailable", retryable: true,
            message: `Gateway service '${serviceId}' is unavailable during grant preflight` });
        }
        const partition = computePartitionKey(entry.definition, entry.policy, client.scope);
        if (!partition.ok) return partition;
        const state = this.serviceManager.getPartitionState(partition.value);
        if (!state) return err({ code: "transport_unavailable", retryable: true, message: `Gateway service '${serviceId}' has no negotiated partition` });
        const requestedOperations = [...new Set(grantsForService.flatMap(grant => grant.operations))];
        for (const operationName of requestedOperations) {
          if (!entry.definition.tool.operations.includes(operationName)) {
            return err({ code: "validation", retryable: false, message: `Operation '${operationName}' is outside service '${serviceId}' configuration` });
          }
          const definition = state.toolDefinitions?.find(tool => tool.name === operationName);
          if (!definition || state.defaultedInputSchemaTools?.includes(operationName) || !isSupportedJsonSchema(definition.inputSchema) ||
              definition.outputSchema !== undefined && !isSupportedJsonSchema(definition.outputSchema)) {
            if (grantsForService.some(grant => grant.requiredness === "required" && grant.operations.includes(operationName))) {
              state.status = "blocked";
              state.diagnosticCode = "tool_schema_unavailable";
            }
            return err({ code: "validation", retryable: false,
              message: `Operation '${operationName}' has no enforceable negotiated input schema` });
          }
        }
        const schemaDigest = computePayloadFingerprint({
          tools: [...(state.toolDefinitions ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
          defaultedInputSchemaTools: [...(state.defaultedInputSchemaTools ?? [])].sort()
        });
        if (this.durableCallLedger && !this.durableCallLedger.pinServiceSchema({ serviceId, revision: entry.definition.revision,
          serviceConfigDigest: entry.configDigest, schemaDigest })) {
          state.status = "blocked";
          state.diagnosticCode = "tool_schema_drift";
          return err({ code: "validation", retryable: false, message: `Gateway service '${serviceId}' schema drifted without a revision change` });
        }
      }
    }

    const token = this.secretStore.issueClientToken(
      client.registrationId,
      client.connection.token
    );
    this.secretStore.setSecret(client.connection.token, token);

    this.registrations.set(client.registrationId, client);

    this.recordAudit({
      action: "client.register",
      registrationId: client.registrationId,
      provider: client.provider,
      role: client.role,
      scope: client.scope,
      configDigest: client.configDigest,
      status: "succeeded",
      diagnosticCode: "registered",
      message: "Client registration registered"
    });

    const result = ok(client);
    this.recordIdempotency(client.idempotencyKey, client, result);
    return result;
  }

  async revoke(
    registrationId: string,
    operation: ScopedOperation,
    _options?: OperationOptions
  ): Promise<OperationResult<void>> {
    const verRes = checkSchemaVersion(operation);
    if (!verRes.ok) return verRes;

    const parseResult = ScopedOperationSchema.safeParse(operation);
    if (!parseResult.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parseResult.error.message,
        details: parseResult.error.flatten() as any
      });
    }

    const reg = this.registrations.get(registrationId);
    if (!reg) {
      return err({ code: "not_found", retryable: false, message: "Registration not found" });
    }

    if (!isTrustScopeWithin(reg.scope, operation.scope)) {
      return err({ code: "validation", retryable: false, message: "Cross-scope revocation denied" });
    }

    this.secretStore.revokeClientToken(registrationId);

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.registrationId === registrationId) {
        this.disconnectSession(sessionId);
      }
    }

    for (const p of this.getPartitionKeysForClient(reg)) {
      this.serviceManager.detachClient(p, registrationId);
    }

    for (const state of this.resourceStates.values()) {
      if (state.activeLease?.registrationId === registrationId) {
        state.activeLease = undefined;
      }
    }

    this.registrations.delete(registrationId);

    this.recordAudit({
      action: "client.revoke",
      registrationId,
      status: "succeeded",
      diagnosticCode: "revoked",
      message: "Client registration revoked"
    });

    return ok(undefined);
  }

  async acquireResource(
    request: MCPResourceRequest,
    _options?: OperationOptions
  ): Promise<OperationResult<MCPResourceLease>> {
    const verRes = checkSchemaVersion(request);
    if (!verRes.ok) return verRes;

    const parseResult = MCPResourceRequestSchema.safeParse(request);
    if (!parseResult.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parseResult.error.message,
        details: parseResult.error.flatten() as any
      });
    }

    const idCheck = this.checkIdempotency<MCPResourceLease>(
      request.idempotencyKey,
      request
    );
    if (idCheck.cached) return idCheck.cached;
    if (idCheck.conflict) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Conflicting payload for idempotencyKey"
      });
    }

    const reg = this.registrations.get(request.registrationId);
    if (!reg || Date.parse(reg.expiresAt) <= this.now().getTime()) {
      return err({
        code: "validation",
        retryable: false,
        message: "Client registration not found or expired"
      });
    }

    if (!isTrustScopeWithin(request.scope, reg.scope)) {
      return err({ code: "validation", retryable: false, message: "Scope mismatch" });
    }

    const entry = this.registry.getService(request.serviceId);
    if (!entry) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Service '${request.serviceId}' not found`
      });
    }

    const resState = this.getResourceState(request.serviceId, request.resourceKey);
    if (resState.quarantinedByCallId) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Exclusive resource is quarantined pending call reconciliation",
        details: {
          diagnosticCode: "resource_quarantined",
          quarantinedByCallId: resState.quarantinedByCallId
        }
      });
    }

    const nowMs = this.now().getTime();
    if (resState.activeLease) {
      const isExpired = Date.parse(resState.activeLease.expiresAt) <= nowMs;
      if (!isExpired) {
        if (resState.activeLease.registrationId === request.registrationId) {
          const res = ok(resState.activeLease);
          this.recordIdempotency(request.idempotencyKey, request, res);
          return res;
        }
        return err({
          code: "conflict",
          retryable: true,
          message: "Resource is currently leased to another client",
          details: {
            diagnosticCode: "resource_busy",
            activeLeaseId: resState.activeLease.leaseId
          }
        });
      }
    }

    resState.currentFence += 1;
    const leaseId = `lease-${randomUUID()}`;
    const acquiredAt = this.now().toISOString();
    const expiresAt = new Date(nowMs + request.ttlMs).toISOString();

    const lease: MCPResourceLease = MCPResourceLeaseSchema.parse({
      schemaVersion: 3,
      leaseId,
      serviceId: request.serviceId,
      resourceKey: request.resourceKey,
      registrationId: request.registrationId,
      fencingToken: resState.currentFence,
      acquiredAt,
      expiresAt
    });

    resState.activeLease = lease;

    this.recordAudit({
      action: "resource.acquire",
      registrationId: request.registrationId,
      serviceId: request.serviceId,
      leaseId,
      fencingToken: lease.fencingToken,
      status: "succeeded",
      diagnosticCode: "acquired",
      message: "Resource lease acquired"
    });

    const res = ok(lease);
    this.recordIdempotency(request.idempotencyKey, request, res);
    return res;
  }

  async renewResource(
    request: MCPResourceRenewRequest,
    _options?: OperationOptions
  ): Promise<OperationResult<MCPResourceLease>> {
    const verRes = checkSchemaVersion(request);
    if (!verRes.ok) return verRes;

    const parseResult = MCPResourceRenewRequestSchema.safeParse(request);
    if (!parseResult.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parseResult.error.message,
        details: parseResult.error.flatten() as any
      });
    }

    const idCheck = this.checkIdempotency<MCPResourceLease>(
      request.idempotencyKey,
      request
    );
    if (idCheck.cached) return idCheck.cached;
    if (idCheck.conflict) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Conflicting payload for idempotencyKey"
      });
    }

    const reg = this.registrations.get(request.lease.registrationId);
    if (!reg || Date.parse(reg.expiresAt) <= this.now().getTime()) {
      return err({
        code: "validation",
        retryable: false,
        message: "Client registration not found or expired"
      });
    }

    const resState = this.getResourceState(
      request.lease.serviceId,
      request.lease.resourceKey
    );
    if (resState.quarantinedByCallId) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Exclusive resource is quarantined pending call reconciliation",
        details: {
          diagnosticCode: "resource_quarantined",
          quarantinedByCallId: resState.quarantinedByCallId
        }
      });
    }

    if (
      !resState.activeLease ||
      resState.activeLease.leaseId !== request.lease.leaseId ||
      resState.activeLease.registrationId !== request.lease.registrationId
    ) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Stale or invalid lease renewal attempt",
        details: { diagnosticCode: "stale_lease" }
      });
    }

    if (resState.activeLease.fencingToken !== request.lease.fencingToken) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Fencing token mismatch",
        details: { diagnosticCode: "fencing_token_mismatch" }
      });
    }

    const nowMs = this.now().getTime();
    if (Date.parse(resState.activeLease.expiresAt) <= nowMs) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Lease has already expired",
        details: { diagnosticCode: "lease_expired" }
      });
    }

    const newExpiresAt = new Date(nowMs + request.ttlMs).toISOString();
    const renewedLease: MCPResourceLease = MCPResourceLeaseSchema.parse({
      ...resState.activeLease,
      expiresAt: newExpiresAt
    });

    resState.activeLease = renewedLease;

    this.recordAudit({
      action: "resource.renew",
      registrationId: renewedLease.registrationId,
      serviceId: renewedLease.serviceId,
      leaseId: renewedLease.leaseId,
      fencingToken: renewedLease.fencingToken,
      status: "succeeded",
      diagnosticCode: "renewed",
      message: "Resource lease renewed"
    });

    const res = ok(renewedLease);
    this.recordIdempotency(request.idempotencyKey, request, res);
    return res;
  }

  async releaseResource(
    lease: MCPResourceLease,
    operation: ScopedOperation,
    _options?: OperationOptions
  ): Promise<OperationResult<void>> {
    const verLease = checkSchemaVersion(lease);
    if (!verLease.ok) return verLease;
    const verOp = checkSchemaVersion(operation);
    if (!verOp.ok) return verOp;

    const parseLease = MCPResourceLeaseSchema.safeParse(lease);
    if (!parseLease.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parseLease.error.message,
        details: parseLease.error.flatten() as any
      });
    }

    const parseOp = ScopedOperationSchema.safeParse(operation);
    if (!parseOp.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parseOp.error.message,
        details: parseOp.error.flatten() as any
      });
    }

    const reg = this.registrations.get(lease.registrationId);
    if (reg && !isTrustScopeWithin(reg.scope, operation.scope)) {
      return err({
        code: "validation",
        retryable: false,
        message: "Cross-scope resource lease release denied",
        details: { diagnosticCode: "cross_scope_denied" }
      });
    }

    const resState = this.getResourceState(lease.serviceId, lease.resourceKey);
    if (resState.quarantinedByCallId) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Cannot release quarantined resource before call reconciliation",
        details: {
          diagnosticCode: "resource_quarantined",
          quarantinedByCallId: resState.quarantinedByCallId
        }
      });
    }

    if (
      resState.activeLease &&
      (resState.activeLease.leaseId !== lease.leaseId ||
        resState.activeLease.fencingToken !== lease.fencingToken)
    ) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Stale resource lease cannot release active lease",
        details: { diagnosticCode: "stale_lease" }
      });
    }

    if (
      resState.activeLease?.leaseId === lease.leaseId &&
      resState.activeLease?.fencingToken === lease.fencingToken
    ) {
      resState.activeLease = undefined;
      this.recordAudit({
        action: "resource.release",
        registrationId: lease.registrationId,
        serviceId: lease.serviceId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        status: "succeeded",
        diagnosticCode: "released",
        message: "Resource lease released"
      });
    }

    return ok(undefined);
  }

  private async acquireConcurrencySlot(
    serviceId: string,
    partitionKey: string,
    maxConcurrency: number,
    maxQueueSize: number,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<OperationResult<() => void>> {
    let slot = this.concurrencyQueues.get(partitionKey);
    if (!slot) {
      slot = { activeCalls: 0, queue: [] };
      this.concurrencyQueues.set(partitionKey, slot);
    }

    if (slot.activeCalls < maxConcurrency) {
      slot.activeCalls += 1;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          slot!.activeCalls -= 1;
          this.processNextInQueue(partitionKey);
        }
      };
      return ok(release);
    }

    if (slot.queue.length >= maxQueueSize) {
      this.metrics.recordBackpressureRejection(serviceId);
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: "Backpressure limit reached",
        details: { diagnosticCode: "backpressure_limit_exceeded" }
      });
    }

    this.metrics.recordQueueEnter(serviceId);
    const requestId = randomUUID();

    return new Promise<OperationResult<() => void>>((resolve) => {
      let cancelTimer: (() => void) | undefined;
      let abortListener: (() => void) | undefined;

      const cleanup = () => {
        if (cancelTimer) cancelTimer();
        if (signal && abortListener) signal.removeEventListener("abort", abortListener);
        this.metrics.recordQueueExit(serviceId);
        const idx = slot!.queue.findIndex(item => item.requestId === requestId);
        if (idx !== -1) {
          slot!.queue.splice(idx, 1);
        }
      };

      if (timeoutMs && timeoutMs > 0) {
        cancelTimer = scheduleSafeTimeout(() => {
          cleanup();
          resolve(
            err({
              code: "timeout",
              retryable: true,
              retrySafety: "not_started",
              message: "Timed out waiting in queue before upstream dispatch"
            })
          );
        }, timeoutMs);
      }

      if (signal) {
        if (signal.aborted) {
          cleanup();
          resolve(
            err({
              code: "cancelled",
              retryable: false,
              message: "Call cancelled while queued"
            })
          );
          return;
        }
        abortListener = () => {
          cleanup();
          resolve(
            err({
              code: "cancelled",
              retryable: false,
              message: "Call cancelled while queued"
            })
          );
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }

      slot!.queue.push({
        requestId,
        resolve: (slotRelease: () => void) => {
          cleanup();
          resolve(ok(slotRelease));
        },
        reject: (error: ContractError) => {
          cleanup();
          resolve(err(error));
        }
      });
    });
  }

  private processNextInQueue(partitionKey: string): void {
    const slot = this.concurrencyQueues.get(partitionKey);
    if (!slot || slot.queue.length === 0) return;
    const next = slot.queue.shift();
    if (next) {
      slot.activeCalls += 1;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          slot.activeCalls -= 1;
          this.processNextInQueue(partitionKey);
        }
      };
      next.resolve(release);
    }
  }

  async call(
    request: MCPToolCall,
    options?: OperationOptions
  ): Promise<OperationResult<MCPToolCallResult>> {
    const verRes = checkSchemaVersion(request);
    if (!verRes.ok) return verRes;

    const parseResult = MCPToolCallSchema.safeParse(request);
    if (!parseResult.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parseResult.error.message,
        details: parseResult.error.flatten() as any
      });
    }

    const reg = this.registrations.get(request.registrationId);
    if (!reg) {
      return err({ code: "not_found", retryable: false, message: "Client registration not found" });
    }
    if (Date.parse(reg.expiresAt) <= this.now().getTime()) {
      return err({ code: "validation", retryable: false, message: "Client registration has expired" });
    }

    let grant: ResolvedToolGrant | undefined;
    const rawGrants = this.toolGrantResolver?.(reg, request);
    if (rawGrants !== undefined) {
      const candidates = Array.isArray(rawGrants) ? rawGrants : [rawGrants];
      const parsedGrants = candidates.map(candidate => ResolvedToolGrantSchema.safeParse(candidate));
      if (parsedGrants.some(candidate => !candidate.success))
        return err({ code: "validation", retryable: false, message: "Resolved tool grant failed schema validation" });
      const service = this.registry.getService(request.serviceId)?.definition;
      const matches = parsedGrants.map(candidate => candidate.success ? candidate.data : undefined).filter((candidate): candidate is ResolvedToolGrant =>
        candidate !== undefined && candidate.role === reg.role && candidate.toolId === service?.tool.toolId &&
        candidate.serviceId === request.serviceId && candidate.operations.includes(request.tool) &&
        computePayloadFingerprint(candidate.scope) === computePayloadFingerprint(reg.scope));
      if (matches.length > 1) return err({ code: "validation", retryable: false, message: "Multiple resolved grants authorize the same Gateway operation" });
      grant = matches[0];
      if (!grant) {
        return err({ code: "validation", retryable: false, message: "Resolved tool grant does not authorize this role, service, operation, or scope" });
      }
      if (grant.memoryScope) {
        const input = request.input !== null && typeof request.input === "object" && !Array.isArray(request.input)
          ? request.input as Record<string, unknown> : {};
        const memory = grant.memoryScope;
        const service = this.registry.getService(request.serviceId);
        if (!service?.policy.readOnlyTools?.includes(request.tool)) {
          return err({ code: "validation", retryable: false,
            message: "Memory-scoped access is limited to configured read-only operations" });
        }
        if (input.wing !== memory.wing) {
          return err({ code: "validation", retryable: false, message: "Scoped memory access must name the granted read-only wing" });
        }
      }
    } else if (typeof this.requireResolvedToolGrants === "function" ? this.requireResolvedToolGrants(reg) : this.requireResolvedToolGrants) {
      return err({ code: "validation", retryable: false, message: "No host-resolved tool grant is available" });
    }

    if (this.registry.getService(request.serviceId)?.definition.tool.toolId === "mempalace" && !grant?.memoryScope) {
      return err({ code: "validation", retryable: false, message: "Memory invocation requires an explicit repository-bound read-only scope" });
    }
    if (!reg.serviceIds.includes(request.serviceId)) {
      this.recordAudit({
        action: "security.violation",
        registrationId: reg.registrationId,
        serviceId: request.serviceId,
        status: "blocked",
        diagnosticCode: "unauthorized_service",
        message: "Service not permitted for client"
      });
      return err({
        code: "validation",
        retryable: false,
        message: `Client is not authorized for service '${request.serviceId}'`
      });
    }

    if (!reg.allowedTools.includes(request.tool)) {
      this.recordAudit({
        action: "security.violation",
        registrationId: reg.registrationId,
        serviceId: request.serviceId,
        status: "blocked",
        diagnosticCode: "unauthorized_tool",
        message: "Tool not permitted for client"
      });
      return err({
        code: "validation",
        retryable: false,
        message: `Tool '${request.tool}' is not authorized for client`
      });
    }

    const entry = this.registry.getService(request.serviceId);
    if (!entry) {
      return err({
        code: "not_found",
        retryable: false,
        message: `Service '${request.serviceId}' not found`
      });
    }

    if (!entry.definition.tool.operations.includes(request.tool)) {
      return err({ code: "validation", retryable: false, message: "Operation is not part of the configured service capability" });
    }

    // Authenticate current authority before revealing even a previously stored receipt.
    const idCheck = this.checkIdempotency<MCPToolCallResult>(request.idempotencyKey, request);
    if (idCheck.conflict) return err({ code: "conflict", retryable: true, message: "Conflicting payload for idempotencyKey" });
    const existingCall = this.callLedger.get(request.callId);
    if (existingCall) {
      if (existingCall.call.registrationId !== reg.registrationId || existingCall.fingerprint !== computePayloadFingerprint(request))
        return err({ code: "conflict", retryable: true, message: "callId is already bound to another Gateway principal or request" });
      return ok(existingCall.result);
    }
    const durableEntry = this.durableCallLedger?.get(request.callId);
    if (durableEntry) {
      if (durableEntry.registrationId !== reg.registrationId || durableEntry.requestDigest !== computePayloadFingerprint(request))
        return err({ code: "conflict", retryable: true, message: "callId is already bound to another Gateway principal or request" });
      return ok(durableEntry.result);
    }
    if (idCheck.cached) return idCheck.cached;

    if (isInteractiveMethodForbidden(request.tool)) {
      this.recordAudit({
        action: "interactive.blocked",
        registrationId: reg.registrationId,
        serviceId: request.serviceId,
        status: "blocked",
        diagnosticCode: "interactive_blocked",
        message: "Interactive tool method is forbidden"
      });
      return err({
        code: "validation",
        retryable: false,
        message: `Interactive tool method '${request.tool}' is forbidden`,
        details: { diagnosticCode: "interactive_blocked" }
      });
    }

    const isExclusive =
      entry.definition.tool.resource.sharing === "exclusive" ||
      entry.policy.browserAffecting === true ||
      entry.policy.concurrencyModel === "exclusive_lease";

    const resourceKey =
      entry.definition.tool.resource.sharing === "exclusive"
        ? entry.definition.tool.resource.resourceKey
        : (request.resourceLease?.resourceKey ?? "default");

    let resState: ResourceState | undefined;
    if (isExclusive) {
      if (!request.resourceLease) {
        return err({
          code: "validation",
          retryable: false,
          message: "Exclusive resource lease is required for this tool",
          details: { diagnosticCode: "lease_required" }
        });
      }

      resState = this.getResourceState(request.serviceId, resourceKey);
      if (resState.quarantinedByCallId) {
        return err({
          code: "conflict",
          retryable: true,
          message: "Exclusive resource is quarantined pending call reconciliation",
          details: {
            diagnosticCode: "resource_quarantined",
            quarantinedByCallId: resState.quarantinedByCallId
          }
        });
      }

      const activeLease = resState.activeLease;
      const nowMs = this.now().getTime();
      if (
        !activeLease ||
        activeLease.leaseId !== request.resourceLease.leaseId ||
        activeLease.registrationId !== request.registrationId ||
        activeLease.serviceId !== request.serviceId ||
        activeLease.resourceKey !== request.resourceLease.resourceKey ||
        activeLease.resourceKey !== resourceKey ||
        activeLease.fencingToken !== request.resourceLease.fencingToken ||
        activeLease.fencingToken !== resState.currentFence ||
        Date.parse(activeLease.expiresAt) <= nowMs
      ) {
        return err({
          code: "conflict",
          retryable: true,
          message: "Invalid, stale, or expired resource lease",
          details: { diagnosticCode: "stale_lease" }
        });
      }
    }

    const partRes = computePartitionKey(entry.definition, entry.policy, reg.scope);
    if (!partRes.ok) return partRes;
    const partitionKey = partRes.value;

    if (entry.policy.concurrencyModel === "single_client_isolated") {
      const state = this.serviceManager.getPartitionState(partitionKey);
      if (state && Array.from(state.activeClients).some((c) => c !== reg.registrationId)) {
        return err({
          code: "conflict",
          retryable: true,
          message:
            "Service policy single_client_isolated forbids multiple concurrent clients in the same partition",
          details: { diagnosticCode: "single_client_limit" }
        });
      }
    }

    const ensureRes = await this.serviceManager.ensure(
      entry.definition,
      {
        schemaVersion: 3,
        scope: reg.scope,
        idempotencyKey: request.idempotencyKey
      },
      { ...options, clientId: reg.registrationId }
    );
    if (!ensureRes.ok) return ensureRes;
    if (ensureRes.value.status !== "ready") {
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: `Service is not ready (status: ${ensureRes.value.status})`,
        details: { diagnosticCode: ensureRes.value.diagnosticCode }
      });
    }

    this.serviceManager.attachClient(partitionKey, reg.registrationId, entry);

    const driver = this.serviceManager.getDriver(partitionKey);
    if (!driver || !driver.isAlive()) {
      return err({
        code: "transport_unavailable",
        retryable: true,
        message: "Driver is not available or alive"
      });
    }

    const currentPartition = this.serviceManager.getPartitionState(partitionKey);
    const negotiatedDefinition = currentPartition?.toolDefinitions?.find((tool) => tool.name === request.tool);
    const strictSchema = grant !== undefined;
    const definition = negotiatedDefinition ?? (!strictSchema ? fallbackToolDefinition(request.tool) : undefined);
    if (this.durableCallLedger && currentPartition) {
      const schemaDigest = computePayloadFingerprint({
        tools: [...(currentPartition.toolDefinitions ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
        defaultedInputSchemaTools: [...(currentPartition.defaultedInputSchemaTools ?? [])].sort()
      });
      if (!this.durableCallLedger.pinServiceSchema({ serviceId: request.serviceId, revision: entry.definition.revision,
        serviceConfigDigest: entry.configDigest, schemaDigest })) {
        currentPartition.status = "blocked";
        currentPartition.diagnosticCode = "tool_schema_drift";
        return err({ code: "validation", retryable: false, message: "Negotiated tool schema drifted without a service revision change" });
      }
    }
    if (!definition || (strictSchema && currentPartition?.defaultedInputSchemaTools?.includes(request.tool)) ||
        !validateJsonSchema(request.input, definition.inputSchema)) {
      return err({ code: "validation", retryable: false, message: "Tool input does not match the currently discovered upstream schema" });
    }

    const maxConcurrency =
      entry.definition.tool.resource.sharing === "concurrent"
        ? entry.policy.concurrencyModel === "serialized"
          ? 1
          : entry.definition.tool.resource.maxConcurrency
        : 1;
    const maxQueueSize = entry.policy.maxQueueSize ?? 32;

    const queueTimeoutMs = options?.timeoutMs ?? entry.policy.callTimeoutMs ?? 60_000;
    const slotRes = await this.acquireConcurrencySlot(
      request.serviceId,
      partitionKey,
      maxConcurrency,
      maxQueueSize,
      options?.signal,
      queueTimeoutMs
    );
    if (!slotRes.ok) return slotRes;
    const releaseSlot = slotRes.value;

    if (isExclusive && resState) {
      const activeLease = resState.activeLease;
      const nowMs = this.now().getTime();
      if (
        resState.quarantinedByCallId ||
        !activeLease ||
        activeLease.leaseId !== request.resourceLease?.leaseId ||
        activeLease.fencingToken !== resState.currentFence ||
        Date.parse(activeLease.expiresAt) <= nowMs
      ) {
        releaseSlot();
        return err({
          code: "conflict",
          retryable: true,
          message: "Resource lease expired or superseded while queued",
          details: { diagnosticCode: "stale_lease_at_dispatch" }
        });
      }
    }

    if (options?.signal?.aborted) {
      releaseSlot();
      return err({
        code: "cancelled",
        retryable: false,
        message: "Tool call cancelled before upstream dispatch"
      });
    }

    const isReadOnly = entry.policy.readOnlyTools?.includes(request.tool) ?? false;
    const mutating = !isReadOnly;
    const requestId = `req-${randomUUID()}`;
    const fingerprint = computePayloadFingerprint(request);

    const initialResult: MCPToolCallResult = {
      schemaVersion: 3,
      callId: request.callId,
      status: "unknown",
      output: null,
      observedAt: this.now().toISOString()
    };

    const ledgerEntry: RecordedCallLedgerEntry = {
      call: request,
      requestId,
      sessionId: reg.scope.sessionId,
      partitionKey,
      instanceId: driver.instanceId,
      fingerprint,
      mutating,
      dispatchedToUpstream: true,
      result: initialResult
    };
    this.durableCallLedger?.recordIntent(request);
    this.callLedger.set(request.callId, ledgerEntry);

    this.metrics.recordCallStart(request.serviceId);
    const startTime = Date.now();

    const callTimeoutMs = options?.timeoutMs ?? entry.policy.callTimeoutMs ?? 60_000;
    const abortCtrl = new AbortController();
    let timedOut = false;
    const cancelTimeoutTimer = scheduleSafeTimeout(() => {
      timedOut = true;
      abortCtrl.abort(new Error("Call timeout"));
    }, callTimeoutMs);

    const onParentAbort = () => {
      abortCtrl.abort(options?.signal?.reason ?? new Error("Aborted"));
    };
    if (options?.signal) {
      options.signal.addEventListener("abort", onParentAbort, { once: true });
    }

    try {
      const upstreamInput: MCPUpstreamToolCallInput = {
        sessionId: reg.scope.sessionId,
        clientId: reg.registrationId,
        requestId,
        callId: request.callId,
        tool: request.tool,
        arguments: request.input,
        ...(request.resourceLease?.fencingToken !== undefined
          ? { fencingToken: request.resourceLease.fencingToken }
          : {}),
        ...(request.resourceLease?.resourceKey !== undefined
          ? { resourceKey: request.resourceLease.resourceKey }
          : {}),
        signal: abortCtrl.signal,
        timeoutMs: callTimeoutMs
      };

      const upstreamRes = await driver.callTool(upstreamInput);

      cancelTimeoutTimer();
      if (options?.signal) {
        options.signal.removeEventListener("abort", onParentAbort);
      }

      const durationMs = Date.now() - startTime;

      if (!upstreamRes.ok) {
        if (driver.cancelRequest) {
          await driver.cancelRequest(requestId, "tool_call_failed").catch(() => {});
        }

        const diagCode = (upstreamRes.error.details as Record<string, unknown> | undefined)
          ?.diagnosticCode;
        if (diagCode === "interactive_prompt_blocked") {
          this.metrics.recordCallEnd(request.serviceId, "failed", durationMs);
          this.recordAudit({
            action: "interactive.blocked",
            registrationId: reg.registrationId,
            serviceId: request.serviceId,
            callId: request.callId,
            status: "blocked",
            diagnosticCode: "interactive_prompt_blocked",
            message: upstreamRes.error.message
          });
          return upstreamRes;
        }

        if (mutating) {
          if (timedOut || upstreamRes.error.code === "timeout") {
            this.metrics.recordMutatingTimeoutOrCancel("timeout", request.serviceId);
          } else if (options?.signal?.aborted || upstreamRes.error.code === "cancelled") {
            this.metrics.recordMutatingTimeoutOrCancel("cancelled", request.serviceId);
          }
          this.metrics.recordCallEnd(request.serviceId, "unknown", durationMs);
          const uncertainResult: MCPToolCallResult = MCPToolCallResultSchema.parse({
            schemaVersion: 3,
            callId: request.callId,
            status: "unknown",
            output: {
              diagnosticCode: "uncertain_mutating_outcome",
              message:
                "Mutating tool call outcome is unknown after failure; reconcile before retry"
            },
            observedAt: this.now().toISOString()
          });
          ledgerEntry.result = uncertainResult;
          this.durableCallLedger?.recordResult(request.callId, uncertainResult);
          if (isExclusive && resState) {
            resState.quarantinedByCallId = request.callId;
          }
          this.recordAudit({
            action: "tool.call",
            registrationId: reg.registrationId,
            serviceId: request.serviceId,
            callId: request.callId,
            status: "unknown",
            diagnosticCode: "uncertain_mutating_outcome",
            message: "Mutating tool call outcome unknown after upstream failure"
          });
          const res = ok(uncertainResult);
          this.recordIdempotency(request.idempotencyKey, request, res);
          return res;
        } else {
          this.metrics.recordCallEnd(request.serviceId, "failed", durationMs);
          return upstreamRes;
        }
      }

      const outputSchema = negotiatedDefinition?.outputSchema;
      let resolvedStructuredContent = upstreamRes.value.structuredContent;
      if (!upstreamRes.value.isError && outputSchema !== undefined && resolvedStructuredContent === undefined) {
        resolvedStructuredContent = trySynthesizeStructuredContent(upstreamRes.value.content, outputSchema);
      }
      const invalidStructuredOutput = !upstreamRes.value.isError && outputSchema !== undefined &&
        (resolvedStructuredContent === undefined || !validateJsonSchema(resolvedStructuredContent, outputSchema));
      if (invalidStructuredOutput) {
        const invalidResult: MCPToolCallResult = MCPToolCallResultSchema.parse({ schemaVersion: 3, callId: request.callId,
          status: mutating ? "unknown" : "failed",
          output: { diagnosticCode: "upstream_output_schema_invalid", message: "Upstream structuredContent did not match its advertised output schema" },
          observedAt: this.now().toISOString() });
        const status = invalidResult.status;
        this.metrics.recordCallEnd(request.serviceId, status, durationMs);
        ledgerEntry.result = invalidResult;
        this.durableCallLedger?.recordResult(request.callId, invalidResult);
        if (mutating && isExclusive && resState) resState.quarantinedByCallId = request.callId;
        this.recordAudit({ action: "tool.call", registrationId: reg.registrationId, serviceId: request.serviceId,
          callId: request.callId, status: status === "unknown" ? "unknown" : "failed",
          diagnosticCode: "upstream_output_schema_invalid", message: "Upstream output schema validation failed" });
        const res = ok(invalidResult);
        this.recordIdempotency(request.idempotencyKey, request, res);
        return res;
      }

      const outcomeStatus = upstreamRes.value.isError ? "failed" : "completed";
      this.metrics.recordCallEnd(request.serviceId, outcomeStatus, durationMs);

      const callResult: MCPToolCallResult = MCPToolCallResultSchema.parse({
        schemaVersion: 3,
        callId: request.callId,
        status: outcomeStatus,
        output: preserveStructuredToolOutput(upstreamRes.value.content, resolvedStructuredContent),
        observedAt: this.now().toISOString()
      });

      ledgerEntry.result = callResult;
      this.durableCallLedger?.recordResult(request.callId, callResult);
      this.recordAudit({
        action: "tool.call",
        registrationId: reg.registrationId,
        serviceId: request.serviceId,
        callId: request.callId,
        status: outcomeStatus === "completed" ? "succeeded" : "failed",
        diagnosticCode: outcomeStatus,
        message: `Tool call ${outcomeStatus}`
      });

      const res = ok(callResult);
      this.recordIdempotency(request.idempotencyKey, request, res);
      return res;
    } catch (e) {
      cancelTimeoutTimer();
      if (options?.signal) {
        options.signal.removeEventListener("abort", onParentAbort);
      }

      const durationMs = Date.now() - startTime;
      if (driver.cancelRequest) {
        await driver.cancelRequest(requestId, "timeout_or_abort").catch(() => {});
      }

      if (mutating) {
        if (timedOut) {
          this.metrics.recordMutatingTimeoutOrCancel("timeout", request.serviceId);
        } else if (options?.signal?.aborted) {
          this.metrics.recordMutatingTimeoutOrCancel("cancelled", request.serviceId);
        }
        this.metrics.recordCallEnd(request.serviceId, "unknown", durationMs);
        const uncertainResult: MCPToolCallResult = MCPToolCallResultSchema.parse({
          schemaVersion: 3,
          callId: request.callId,
          status: "unknown",
          output: {
            diagnosticCode: "uncertain_mutating_outcome",
            message:
              "Mutating tool call outcome is unknown after timeout/crash; reconcile before retry"
          },
          observedAt: this.now().toISOString()
        });
        ledgerEntry.result = uncertainResult;
        this.durableCallLedger?.recordResult(request.callId, uncertainResult);
        if (isExclusive && resState) {
          resState.quarantinedByCallId = request.callId;
        }
        this.recordAudit({
          action: "tool.call",
          registrationId: reg.registrationId,
          serviceId: request.serviceId,
          callId: request.callId,
          status: "unknown",
          diagnosticCode: "uncertain_mutating_outcome",
          message: "Mutating tool call outcome unknown after exception"
        });
        const res = ok(uncertainResult);
        this.recordIdempotency(request.idempotencyKey, request, res);
        return res;
      } else {
        if (timedOut) {
          this.metrics.recordCallEnd(request.serviceId, "timeout", durationMs);
          return err({
            code: "timeout",
            retryable: true,
            retrySafety: "observation_only",
            message: "Read-only tool call timed out"
          });
        }
        if (options?.signal?.aborted) {
          this.metrics.recordCallEnd(request.serviceId, "cancelled", durationMs);
          return err({
            code: "cancelled",
            retryable: false,
            message: "Read-only tool call was cancelled"
          });
        }
        this.metrics.recordCallEnd(request.serviceId, "failed", durationMs);
        return err({
          code: "transport_unavailable",
          retryable: true,
          message: e instanceof Error ? e.message : String(e)
        });
      }
    } finally {
      releaseSlot();
    }
  }

  async reconcileCall(
    request: MCPToolCall,
    _options?: OperationOptions
  ): Promise<OperationResult<MCPToolCallResult>> {
    const verRes = checkSchemaVersion(request);
    if (!verRes.ok) return verRes;

    const parseResult = MCPToolCallSchema.safeParse(request);
    if (!parseResult.success) {
      return err({
        code: "validation",
        retryable: false,
        message: parseResult.error.message,
        details: parseResult.error.flatten() as any
      });
    }

    const ledger = this.callLedger.get(request.callId);
    if (!ledger) {
      const registration = this.registrations.get(request.registrationId);
      if (!registration || Date.parse(registration.expiresAt) <= this.now().getTime() ||
          !registration.serviceIds.includes(request.serviceId) || !registration.allowedTools.includes(request.tool)) {
        return err({ code: "validation", retryable: false, message: "Call reconciliation requires a current authorized Gateway registration" });
      }
      const durable = this.durableCallLedger?.get(request.callId);
      if (durable) {
        if (durable.registrationId !== request.registrationId || durable.requestDigest !== computePayloadFingerprint(request)) {
          return err({ code: "conflict", retryable: true, message: "Call ID is already bound to another Gateway principal or request" });
        }
        return ok(durable.result);
      }
      return err({
        code: "not_found",
        retryable: false,
        message: `Call '${request.callId}' not found in ledger`
      });
    }

    if (ledger.call.registrationId !== request.registrationId) {
      return err({
        code: "conflict",
        retryable: true,
        message: "Cross-client call reconciliation denied"
      });
    }

    if (ledger.result.status === "completed" || ledger.result.status === "failed") {
      return ok(ledger.result);
    }

    const driver = this.serviceManager.getDriver(ledger.partitionKey);
    if (driver?.reconcileRequest) {
      const rec = await driver.reconcileRequest(request.callId, ledger.requestId);
      if (rec.status === "completed" || rec.status === "failed") {
        const outputSchema = this.serviceManager.getPartitionState(ledger.partitionKey)?.toolDefinitions?.find(tool => tool.name === request.tool)?.outputSchema;
        let resolvedStructuredContent = rec.structuredContent;
        const candidateOutput = rec.output ?? ledger.result.output;
        if (rec.status === "completed" && outputSchema !== undefined && resolvedStructuredContent === undefined) {
          resolvedStructuredContent = trySynthesizeStructuredContent(candidateOutput, outputSchema);
        }
        const invalidStructuredOutput = rec.status === "completed" && outputSchema !== undefined &&
          (resolvedStructuredContent === undefined || !validateJsonSchema(resolvedStructuredContent, outputSchema));
        if (invalidStructuredOutput) {
          const status = ledger.mutating ? "unknown" : "failed";
          ledger.result = MCPToolCallResultSchema.parse({ schemaVersion: 3, callId: request.callId, status,
            output: { diagnosticCode: "upstream_output_schema_invalid", message: "Reconciled structuredContent did not match its advertised output schema" },
            observedAt: this.now().toISOString() });
          this.durableCallLedger?.recordResult(request.callId, ledger.result);
          if (ledger.mutating && ledger.call.resourceLease) {
            this.getResourceState(request.serviceId, ledger.call.resourceLease.resourceKey).quarantinedByCallId = request.callId;
          }
          this.recordAudit({ action: "tool.reconcile", registrationId: request.registrationId, serviceId: request.serviceId,
            callId: request.callId, status: status === "unknown" ? "unknown" : "failed",
            diagnosticCode: "upstream_output_schema_invalid", message: "Reconciled output schema validation failed" });
          return ok(ledger.result);
        }
        ledger.result = MCPToolCallResultSchema.parse({
          schemaVersion: 3,
          callId: request.callId,
          status: rec.status,
          output: preserveStructuredToolOutput(candidateOutput, resolvedStructuredContent),
          observedAt: this.now().toISOString()
        });
        this.durableCallLedger?.recordResult(request.callId, ledger.result);
        this.clearQuarantine(request.serviceId, request.callId);
        this.recordAudit({
          action: "tool.reconcile",
          registrationId: request.registrationId,
          serviceId: request.serviceId,
          callId: request.callId,
          status: "succeeded",
          diagnosticCode: rec.status,
          message: `Call reconciled as ${rec.status}`
        });
        return ok(ledger.result);
      }
      if (rec.status === "not_delivered") {
        ledger.result = MCPToolCallResultSchema.parse({
          schemaVersion: 3,
          callId: request.callId,
          status: "failed",
          output: {
            diagnosticCode: "not_delivered",
            message: "Upstream confirmed request was not delivered"
          },
          observedAt: this.now().toISOString()
        });
        this.durableCallLedger?.recordResult(request.callId, ledger.result);
        this.clearQuarantine(request.serviceId, request.callId);
        this.recordAudit({
          action: "tool.reconcile",
          registrationId: request.registrationId,
          serviceId: request.serviceId,
          callId: request.callId,
          status: "succeeded",
          diagnosticCode: "not_delivered",
          message: "Call reconciled as not delivered"
        });
        return ok(ledger.result);
      }
    }

    return ok(ledger.result);
  }
}

const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

function scheduleSafeTimeout(callback: () => void, delayMs: number): () => void {
  if (!Number.isFinite(delayMs)) return () => {};
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = Math.max(0, Math.ceil(delayMs));

  const arm = () => {
    if (cancelled) return;
    const slice = Math.min(remaining, MAX_SAFE_TIMEOUT_MS);
    remaining -= slice;
    timer = setTimeout(() => {
      if (cancelled) return;
      if (remaining > 0) {
        arm();
      } else {
        callback();
      }
    }, slice);
  };

  arm();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function trySynthesizeStructuredContent(content: JsonValue, outputSchema: Readonly<Record<string, JsonValue>>): JsonValue | undefined {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const first = content[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) return undefined;
  const record = first as Record<string, unknown>;
  if (record.type !== "text" || typeof record.text !== "string") return undefined;
  try {
    const parsed = JSON.parse(record.text) as JsonValue;
    return validateJsonSchema(parsed, outputSchema) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function preserveStructuredToolOutput(content: JsonValue, structuredContent: JsonValue | undefined): JsonValue {
  return structuredContent === undefined ? content : { content, structuredContent };
}
