import { z } from "zod";
import { IdentifierSchema, IdempotencyKeySchema, IsoDateTimeSchema, JsonValueSchema } from "./common.js";
import type { OperationResult } from "./errors.js";
import type { OperationOptions } from "./ports.js";
import { AgentProviderIdSchema, NonEmptyArgumentSchema, PlatformSchemaVersionSchema, SafeArgumentSchema,
  ScopedOperationSchema, SecretReferenceSchema, Sha256DigestSchema, TrustScopeSchema } from "./platform.js";
import { AgentRoleSchema } from "./session.js";
import { ToolCapabilitySchema } from "./setup.js";

/** No URL credentials/fragments; production endpoint policy is additionally enforced by the host. */
export const MCPEndpointSchema = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && !url.search &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}, "MCP endpoint requires HTTPS or loopback HTTP without credentials/query/fragment");

export const MCPServiceDefinitionSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  serviceId: IdentifierSchema,
  revision: z.number().int().positive(),
  scope: TrustScopeSchema,
  tool: ToolCapabilitySchema.refine(tool => tool.kind !== "cli_only", "CLI-only tools are not MCP services"),
  connection: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("existing_shared_worker"), endpoint: MCPEndpointSchema,
      workerId: IdentifierSchema, ownership: z.literal("external") }).strict(),
    z.object({ kind: z.literal("native_remote_mcp"), endpoint: MCPEndpointSchema, ownership: z.literal("external") }).strict(),
    z.object({ kind: z.literal("stdio_mcp"), executable: NonEmptyArgumentSchema,
      argv: z.array(SafeArgumentSchema), environmentBindings: z.record(SecretReferenceSchema),
      executableDigest: Sha256DigestSchema, ownership: z.literal("bflow"), bridgeRequired: z.literal(true) }).strict()
  ]),
  authentication: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("none") }).strict(),
    z.object({ mode: z.literal("bearer"), credential: SecretReferenceSchema }).strict(),
    z.object({ mode: z.literal("oauth"), credential: SecretReferenceSchema, audience: z.string().url() }).strict()
  ]),
  healthTimeoutMs: z.number().int().positive().max(60_000),
  idleTimeoutMs: z.number().int().positive(),
  restartLimit: z.number().int().nonnegative().max(10)
}).strict().superRefine((service, ctx) => {
  if (service.tool.kind !== service.connection.kind)
    ctx.addIssue({ code: "custom", message: "tool kind must match MCP connection kind" });
});
export type MCPServiceDefinition = z.infer<typeof MCPServiceDefinitionSchema>;

export const MCPClientRegistrationSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  registrationId: IdentifierSchema,
  provider: AgentProviderIdSchema,
  role: AgentRoleSchema,
  scope: TrustScopeSchema.refine(scope => scope.kind === "session", "MCP clients require session scope"),
  environmentId: IdentifierSchema,
  serviceIds: z.array(IdentifierSchema).min(1),
  allowedTools: z.array(IdentifierSchema).min(1),
  connection: z.discriminatedUnion("transport", [
    z.object({ transport: z.literal("streamable_http"), endpoint: MCPEndpointSchema,
      token: SecretReferenceSchema }).strict(),
    z.object({ transport: z.literal("stdio"), executable: NonEmptyArgumentSchema,
      executableDigest: Sha256DigestSchema, argv: z.array(SafeArgumentSchema), token: SecretReferenceSchema }).strict()
  ]),
  configDigest: Sha256DigestSchema,
  expiresAt: IsoDateTimeSchema,
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type MCPClientRegistration = z.infer<typeof MCPClientRegistrationSchema>;

export const MCPServiceObservationSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  serviceId: IdentifierSchema,
  revision: z.number().int().positive(),
  instanceId: IdentifierSchema,
  status: z.enum(["ready", "starting", "blocked", "stopped", "unknown"]),
  protocolVersion: NonEmptyArgumentSchema.optional(),
  discoveredTools: z.array(IdentifierSchema),
  ownership: z.enum(["bflow", "external"]),
  activeClientCount: z.number().int().nonnegative(),
  observedAt: IsoDateTimeSchema,
  diagnosticCode: IdentifierSchema
}).strict().superRefine((observation, ctx) => {
  if (observation.status === "ready" && (!observation.protocolVersion || !observation.discoveredTools.length))
    ctx.addIssue({ code: "custom", message: "ready service requires negotiated protocol and discovered tools" });
});
export type MCPServiceObservation = z.infer<typeof MCPServiceObservationSchema>;

/** Gateway-owned resource lease, separate from AgentRegistry task leases. */
export const MCPResourceLeaseSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  leaseId: IdentifierSchema,
  serviceId: IdentifierSchema,
  resourceKey: IdentifierSchema,
  registrationId: IdentifierSchema,
  fencingToken: z.number().int().positive(),
  acquiredAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema
}).strict().refine(lease => Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt), "resource lease must expire after acquisition");
export type MCPResourceLease = z.infer<typeof MCPResourceLeaseSchema>;

export const MCPResourceRequestSchema = ScopedOperationSchema.extend({
  registrationId: IdentifierSchema,
  serviceId: IdentifierSchema,
  resourceKey: IdentifierSchema,
  ttlMs: z.number().int().positive().max(300_000)
}).strict();
export type MCPResourceRequest = z.infer<typeof MCPResourceRequestSchema>;

export const MCPResourceRenewRequestSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  lease: MCPResourceLeaseSchema,
  ttlMs: z.number().int().positive().max(300_000),
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type MCPResourceRenewRequest = z.infer<typeof MCPResourceRenewRequestSchema>;

export const MCPToolCallSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  callId: IdentifierSchema,
  registrationId: IdentifierSchema,
  serviceId: IdentifierSchema,
  tool: IdentifierSchema,
  input: JsonValueSchema,
  resourceLease: MCPResourceLeaseSchema.optional(),
  idempotencyKey: IdempotencyKeySchema
}).strict().superRefine((call, ctx) => {
  if (call.resourceLease && (call.resourceLease.registrationId !== call.registrationId || call.resourceLease.serviceId !== call.serviceId))
    ctx.addIssue({ code: "custom", message: "resource lease belongs to a different client/service" });
});
export type MCPToolCall = z.infer<typeof MCPToolCallSchema>;

export const MCPToolCallResultSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  callId: IdentifierSchema,
  status: z.enum(["completed", "failed", "unknown"]),
  output: JsonValueSchema,
  observedAt: IsoDateTimeSchema
}).strict();
export type MCPToolCallResult = z.infer<typeof MCPToolCallResultSchema>;

export interface MCPServiceManager {
  ensure(service: MCPServiceDefinition, operation: import("./platform.js").ScopedOperation,
    options?: OperationOptions): Promise<OperationResult<MCPServiceObservation>>;
  inspect(serviceId: string, operation: import("./platform.js").ScopedOperation,
    options?: OperationOptions): Promise<OperationResult<MCPServiceObservation>>;
  release(serviceId: string, operation: import("./platform.js").ScopedOperation,
    options?: OperationOptions): Promise<OperationResult<MCPServiceObservation>>;
}

/** Tool connectivity only. Never a substitute transport for RoleMessage. */
export interface SharedMCPGateway {
  register(client: MCPClientRegistration, options?: OperationOptions): Promise<OperationResult<MCPClientRegistration>>;
  revoke(registrationId: string, operation: import("./platform.js").ScopedOperation,
    options?: OperationOptions): Promise<OperationResult<void>>;
  acquireResource(request: MCPResourceRequest, options?: OperationOptions): Promise<OperationResult<MCPResourceLease>>;
  renewResource(request: MCPResourceRenewRequest, options?: OperationOptions): Promise<OperationResult<MCPResourceLease>>;
  releaseResource(lease: MCPResourceLease, operation: import("./platform.js").ScopedOperation,
    options?: OperationOptions): Promise<OperationResult<void>>;
  call(request: MCPToolCall, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>>;
  reconcileCall(request: MCPToolCall, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>>;
}
