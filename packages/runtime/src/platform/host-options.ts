import { isAbsolute } from "node:path";
import { z } from "zod";
import { ProviderFailoverPolicySchema } from "@bflow/contracts";
import {
  SkillDependencyApprovalSchema, AgentHealthCheckSchema, AgentProviderIdSchema, AgentRoleSchema, IdentifierSchema, IsoDateTimeSchema,
  NonEmptyArgumentSchema, SafeArgumentSchema, Sha256DigestSchema, SkillPinSchema,
  RepositoryToolPolicySchema, ResolvedToolGrantSchema, RoleProfilePinSchema, RoleProfileCatalogSchema, ROLE_PROFILE_FEATURE,
  sameRoleProfilePin
} from "@bflow/contracts";

/**
 * Wire shapes between the CLI and the persistent Agentic host for P30 platform readiness.
 * The CLI derives `platform` from repository/machine configuration; the host owns every probe.
 */

export const PlatformRoleOptionSchema = z.object({
  role: AgentRoleSchema,
  specialistProfile: RoleProfilePinSchema.optional(),
  provider: AgentProviderIdSchema,
  failover: ProviderFailoverPolicySchema.optional(),
  profileName: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/).optional(),
  required: z.boolean(),
  model: z.string().trim().min(1).optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  /** Derived from actual workflow-pack locks; role model/effort alone are defaults. */
  preferenceConstraints: z.object({
    model: z.string().trim().min(1).optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional()
  }).strict().optional(),
  permissionMode: z.enum(["restricted", "workspace_auto", "unattended_isolated"]),
  capabilityIds: z.array(IdentifierSchema),
  mcpServiceIds: z.array(IdentifierSchema),
  toolIds: z.array(IdentifierSchema),
  skillSelections: z.array(z.object({
    skill: SkillPinSchema,
    required: z.boolean(),
    approvalReceiptId: IdentifierSchema.optional()
  }).strict()),
  dependencySkillApprovals: z.array(SkillDependencyApprovalSchema).optional(),
  environmentVariables: z.record(SafeArgumentSchema).optional(),
  isolation: z.object({ kind: z.enum(["os_sandbox", "container"]), proofId: IdentifierSchema }).strict().optional(),
  network: z.object({ mode: z.enum(["deny", "allowlist"]), allowedHosts: z.array(IdentifierSchema) }).strict().optional()
}).strict().superRefine((role, ctx) => {
  if (role.failover && (role.failover.role !== role.role || !role.model || !role.profileName))
    ctx.addIssue({ code: "custom", message: "Failover requires the same governance role and explicit primary model/profile" });
  if (role.provider === "agy" && role.effort !== undefined)
    ctx.addIssue({ code: "custom", path: ["effort"], message: "Agy effort must be encoded in the configured model name" });
});
export type PlatformRoleOption = z.infer<typeof PlatformRoleOptionSchema>;

export const AgenticHostPlatformOptionsSchema = z.object({
  schemaVersion: z.literal(3),
  machineId: IdentifierSchema,
  repositoryId: IdentifierSchema,
  roleProfiles: RoleProfileCatalogSchema.optional(),
  /** Trusted machine AI-isolator state root. Never derived from repository role configuration. */
  isolatorStateRoot: z.string().min(1).refine(isAbsolute, "isolatorStateRoot must be absolute").optional(),
  /** One entry per role; a `developer` entry is the template for dynamic Developer launches. */
  roles: z.array(PlatformRoleOptionSchema).min(1),
  /** Root of the machine skill bundle store (`FileSkillStore`). */
  skillsStoreRoot: NonEmptyArgumentSchema,
  /** Trusted user Codex home used to inspect inherited global hooks. */
  codexHomeDirectory: NonEmptyArgumentSchema.optional(),
  /** Trusted HOME for the Codex process; isolated setup derives this separately from CODEX_HOME. */
  codexProcessHomeDirectory: NonEmptyArgumentSchema.optional(),
  /** Private machine-owned store recording explicit approval of exact global Codex hook snapshots. */
  codexHookApprovalPath: NonEmptyArgumentSchema.optional(),
  approvedBuiltinSkillDigests: z.array(Sha256DigestSchema),
  /** Trusted machine-owned exact custom skill authorization store; never repository supplied. */
  skillApprovalPath: NonEmptyArgumentSchema.refine(isAbsolute, "skillApprovalPath must be absolute").optional(),
  /**
   * Commands skills may reference, owned by the CLI command reference. Absent (older CLI) means none: skills that
   * reference a command then fail validation instead of being accepted against a guessed list.
   */
  supportedCommands: z.array(NonEmptyArgumentSchema).optional(),
  /** Private locator written by the Gateway daemon; absent means no Gateway (roles needing MCP are blocked). */
  gatewayLocatorPath: NonEmptyArgumentSchema.optional(),
  /** Explicit repository policy snapshot; absent remains default-deny for tool actions. */
  toolPolicy: RepositoryToolPolicySchema.optional(),
  /** Host-resolved grants bound to exact roles, operations and session scope. */
  toolGrants: z.array(ResolvedToolGrantSchema).optional(),
  /** Trusted machine service resource keys; never supplied by role tool arguments. */
  exclusiveMcpResources: z.record(IdentifierSchema, IdentifierSchema).optional()
}).strict().superRefine((options, ctx) => {
  const roles = options.roles.map(role => role.role);
  if (new Set(roles).size !== roles.length) ctx.addIssue({ code: "custom", message: "platform roles must be unique" });
  for (const required of ["conversation", "coordinator"] as const)
    if (!roles.includes(required)) ctx.addIssue({ code: "custom", message: `platform roles must include ${required}` });
  for (const [index, role] of options.roles.entries()) if (role.specialistProfile) {
    const snapshot = options.roleProfiles?.find(item => sameRoleProfilePin(item.pin, role.specialistProfile));
    if (!snapshot || snapshot.definition.baseRole !== role.role)
      ctx.addIssue({ code: "custom", path: ["roles", index, "specialistProfile"], message: "specialist profile must match exact catalog pin and base role" });
  }
});
export type AgenticHostPlatformOptions = z.infer<typeof AgenticHostPlatformOptionsSchema>;

export const RolePreflightSummarySchema = z.object({
  role: AgentRoleSchema,
  roleProfile: RoleProfilePinSchema.optional(),
  provider: AgentProviderIdSchema,
  required: z.boolean(),
  taskId: IdentifierSchema.optional(),
  status: z.enum(["ready", "blocked", "unsupported", "error"]),
  checks: z.array(AgentHealthCheckSchema),
  message: z.string().optional()
}).strict();

export const PlatformPreflightReportSchema = z.object({
  ready: z.boolean(),
  generation: z.number().int().positive(),
  roles: z.array(RolePreflightSummarySchema),
  checkedAt: IsoDateTimeSchema
}).strict().superRefine((report, ctx) => {
  const requiredReady = report.roles.filter(role => role.required).every(role => role.status === "ready");
  if (report.ready !== requiredReady) ctx.addIssue({ code: "custom", message: "ready must equal every required role being ready" });
});

/** Launch material for one role. `env` may carry Gateway bearer tokens: never persist or log it. */
export const HostLaunchMaterialSchema = z.object({
  roleProfile: RoleProfilePinSchema.optional(),
  features: z.array(z.string()).optional(),
  promptSource: NonEmptyArgumentSchema.optional(),
  provider: AgentProviderIdSchema,
  argv: z.array(SafeArgumentSchema),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()),
  launchId: IdentifierSchema,
  launchFingerprint: Sha256DigestSchema
}).strict().superRefine((material, ctx) => {
  if (material.roleProfile && !material.features?.includes(ROLE_PROFILE_FEATURE))
    ctx.addIssue({ code: "custom", message: "profiled launch requires custom specialist profile feature support" });
});
export type HostLaunchMaterial = z.infer<typeof HostLaunchMaterialSchema>;

export const HostRoleLaunchSchema = z.object({
  roleProfile: RoleProfilePinSchema.optional(),
  systemPrompt: z.string(),
  mcpConfigFile: NonEmptyArgumentSchema,
  hooksSettingsFile: NonEmptyArgumentSchema,
  /** Present when the host prepared a v3 provider launch; legacy hosts omit it. */
  launch: HostLaunchMaterialSchema.optional()
}).strict().superRefine((role, ctx) => {
  if (!sameRoleProfilePin(role.roleProfile, role.launch?.roleProfile))
    ctx.addIssue({ code: "custom", message: "host role and launch role profile pin mismatch" });
});
export type HostRoleLaunch = z.infer<typeof HostRoleLaunchSchema>;

/** Host `prepare` RPC result. `platform.ready === false` means: no pane side effects, fail `up` with the report. */
export const HostPrepareResponseSchema = z.object({
  roleLaunch: z.record(HostRoleLaunchSchema),
  platform: PlatformPreflightReportSchema.optional()
}).strict();
export type HostPrepareResponse = z.infer<typeof HostPrepareResponseSchema>;
