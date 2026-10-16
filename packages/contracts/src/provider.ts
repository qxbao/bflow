import { z } from "zod";
import { AgentSessionLocatorSchema } from "./agent.js";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";
import type { OperationResult } from "./errors.js";
import type { OperationOptions } from "./ports.js";
import { AgentCapabilitySchema, AgentRoleSchema } from "./session.js";
import {
  AgentProviderIdSchema, NonEmptyArgumentSchema, PlatformSchemaVersionSchema,
  SafeArgumentSchema, SecretReferenceSchema, Sha256DigestSchema, TrustScopeSchema
} from "./platform.js";

export const PermissionProfileSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  profileId: IdentifierSchema,
  mode: z.enum(["restricted", "workspace_auto", "unattended_isolated"]),
  scope: TrustScopeSchema,
  filesystem: z.enum(["read_only", "workspace_write"]),
  readableRoots: z.array(NonEmptyArgumentSchema),
  writableRoots: z.array(NonEmptyArgumentSchema),
  deniedRoots: z.array(NonEmptyArgumentSchema),
  isolation: z.enum(["provider_policy", "os_sandbox", "container"]),
  network: z.object({ mode: z.enum(["deny", "allowlist"]), allowedHosts: z.array(IdentifierSchema) }).strict(),
  allowedTools: z.array(IdentifierSchema),
  deniedAction: z.enum(["deny", "request_via_conversation"]),
  allowGlobalPermissionBypass: z.literal(false)
}).strict().superRefine((profile, ctx) => {
  if (profile.scope.kind === "machine") ctx.addIssue({ code: "custom", message: "agent permissions cannot have machine scope" });
  if (profile.filesystem === "read_only" && profile.writableRoots.length)
    ctx.addIssue({ code: "custom", message: "read-only permissions cannot grant writable roots" });
  if (profile.mode === "restricted" && profile.filesystem !== "read_only")
    ctx.addIssue({ code: "custom", message: "restricted profile is read-only" });
  if (profile.mode === "unattended_isolated" && (profile.isolation === "provider_policy" || profile.scope.kind !== "session"))
    ctx.addIssue({ code: "custom", message: "unattended execution requires session scope and OS isolation" });
  if (profile.network.mode === "deny" && profile.network.allowedHosts.length)
    ctx.addIssue({ code: "custom", message: "denied network cannot include allowed hosts" });
});
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

export const AgentEnvironmentSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  environmentId: IdentifierSchema,
  provider: AgentProviderIdSchema,
  role: AgentRoleSchema,
  scope: TrustScopeSchema.refine(scope => scope.kind === "session", "agent environment requires session scope"),
  cwd: NonEmptyArgumentSchema,
  stateDirectory: NonEmptyArgumentSchema,
  configFingerprint: Sha256DigestSchema,
  permissionProfile: PermissionProfileSchema,
  environmentVariables: z.record(SafeArgumentSchema),
  secretBindings: z.record(SecretReferenceSchema),
  requiredCapabilityIds: z.array(IdentifierSchema),
  requiredMcpServiceIds: z.array(IdentifierSchema),
  skillManifestDigest: Sha256DigestSchema
}).strict().superRefine((env, ctx) => {
  const a = env.scope, b = env.permissionProfile.scope;
  if (a.machineId !== b.machineId || b.kind === "machine" ||
      a.repositoryId !== b.repositoryId || a.workspaceRoot !== b.workspaceRoot ||
      (b.kind === "session" && a.sessionId !== b.sessionId))
    ctx.addIssue({ code: "custom", message: "environment and permission scope must identify the same repository/session" });
});
export type AgentEnvironment = z.infer<typeof AgentEnvironmentSchema>;

/** Reuses the existing AgentCapability shape; this envelope versions its catalog. */
export const AgentProviderDescriptorSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  provider: AgentProviderIdSchema,
  adapterVersion: NonEmptyArgumentSchema,
  executableName: NonEmptyArgumentSchema,
  capabilities: z.array(AgentCapabilitySchema),
  mcpTransports: z.array(z.enum(["stdio", "streamable_http"])),
  supportsUnattended: z.boolean(),
  supportsNativeBinding: z.boolean()
}).strict();
export type AgentProviderDescriptor = z.infer<typeof AgentProviderDescriptorSchema>;

export const AgentLaunchProfileSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  launchId: IdentifierSchema,
  environment: AgentEnvironmentSchema,
  providerVersion: NonEmptyArgumentSchema,
  executable: NonEmptyArgumentSchema,
  executableDigest: Sha256DigestSchema,
  argv: z.array(SafeArgumentSchema),
  configFiles: z.array(z.object({ path: NonEmptyArgumentSchema, digest: Sha256DigestSchema }).strict()),
  launchFingerprint: Sha256DigestSchema,
  interaction: z.enum(["conversation", "no_direct_user_input"]),
  expiresAt: IsoDateTimeSchema
}).strict().superRefine((profile, ctx) => {
  if (profile.environment.role !== "conversation" && profile.interaction !== "no_direct_user_input")
    ctx.addIssue({ code: "custom", message: "only Conversation may accept direct user input" });
});
export type AgentLaunchProfile = z.infer<typeof AgentLaunchProfileSchema>;

/** Startup proof, distinct from ADR 0003 task-execution binding receipts. */
export const AgentLaunchAttestationSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  receiptId: IdentifierSchema,
  issuerId: IdentifierSchema,
  launchId: IdentifierSchema,
  launchFingerprint: Sha256DigestSchema,
  sessionId: IdentifierSchema,
  paneId: IdentifierSchema,
  nativeSession: AgentSessionLocatorSchema,
  observedAt: IsoDateTimeSchema,
  signature: z.object({ algorithm: z.literal("ed25519"), value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict()
}).strict();
export type AgentLaunchAttestation = z.infer<typeof AgentLaunchAttestationSchema>;

export const AGENT_HEALTH_CHECKS = ["binary", "version", "authentication", "environment", "mcp",
  "launch_arguments", "permissions", "skills", "native_binding"] as const;
export const AgentHealthCheckSchema = z.object({
  check: z.enum(AGENT_HEALTH_CHECKS),
  status: z.enum(["passed", "failed", "unknown"]),
  code: IdentifierSchema,
  message: z.string().min(1),
  remediation: z.string().min(1).optional()
}).strict();
export type AgentHealthCheck = z.infer<typeof AgentHealthCheckSchema>;

export const AgentHealthResultSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  environmentId: IdentifierSchema,
  provider: AgentProviderIdSchema,
  role: AgentRoleSchema,
  configFingerprint: Sha256DigestSchema,
  stage: z.enum(["preflight", "activated"]),
  status: z.enum(["ready", "blocked", "unsupported"]),
  checkedAt: IsoDateTimeSchema,
  validUntil: IsoDateTimeSchema,
  checks: z.array(AgentHealthCheckSchema).min(1),
  launchAttestation: AgentLaunchAttestationSchema.optional()
}).strict().superRefine((health, ctx) => {
  const checks = health.checks.map(check => check.check);
  if (new Set(checks).size !== checks.length) ctx.addIssue({ code: "custom", message: "duplicate health check" });
  const ttl = Date.parse(health.validUntil) - Date.parse(health.checkedAt);
  if (ttl <= 0 || ttl > 300_000) ctx.addIssue({ code: "custom", message: "health TTL must be positive and at most five minutes" });
  if (health.launchAttestation && Date.parse(health.launchAttestation.observedAt) > Date.parse(health.checkedAt))
    ctx.addIssue({ code: "custom", message: "launch attestation must precede health observation" });
  if (health.status === "ready") {
    const required = AGENT_HEALTH_CHECKS.filter(check => health.stage === "activated" || check !== "native_binding");
    if (required.some(check => !health.checks.some(item => item.check === check && item.status === "passed")) ||
        health.checks.some(check => check.status !== "passed"))
      ctx.addIssue({ code: "custom", message: "ready requires every stage check to pass; unknown is not ready" });
    if (health.stage === "activated" && !health.launchAttestation)
      ctx.addIssue({ code: "custom", message: "activated readiness requires authenticated launch attestation" });
  }
});
export type AgentHealthResult = z.infer<typeof AgentHealthResultSchema>;

export const AgentHealthRequestSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  environment: AgentEnvironmentSchema,
  stage: z.enum(["preflight", "activated"]),
  launchProfile: AgentLaunchProfileSchema.optional(),
  launchAttestation: AgentLaunchAttestationSchema.optional(),
  requestedAt: IsoDateTimeSchema
}).strict().superRefine((request, ctx) => {
  const launch = request.launchProfile, receipt = request.launchAttestation;
  if (request.stage === "activated" && (!launch || !receipt))
    ctx.addIssue({ code: "custom", message: "activated check requires launch profile and receipt" });
  if (launch && (launch.environment.environmentId !== request.environment.environmentId ||
      launch.environment.configFingerprint !== request.environment.configFingerprint))
    ctx.addIssue({ code: "custom", message: "launch environment mismatch" });
  if (receipt && (!launch || receipt.launchId !== launch.launchId || receipt.launchFingerprint !== launch.launchFingerprint ||
      (request.environment.scope.kind === "session" && receipt.sessionId !== request.environment.scope.sessionId)))
    ctx.addIssue({ code: "custom", message: "launch receipt identity mismatch" });
});
export type AgentHealthRequest = z.infer<typeof AgentHealthRequestSchema>;

/** Produces launch data only. Herdr/Pane Manager retain process and transport ownership. */
export interface AgentProviderAdapter {
  readonly descriptor: AgentProviderDescriptor;
  checkHealth(request: AgentHealthRequest, options?: OperationOptions): Promise<OperationResult<AgentHealthResult>>;
  prepareLaunch(environment: AgentEnvironment, options?: OperationOptions): Promise<OperationResult<AgentLaunchProfile>>;
}
