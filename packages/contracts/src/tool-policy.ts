import { z } from "zod";
import { IdentifierSchema } from "./common.js";
import { PlatformSchemaVersionSchema, Sha256DigestSchema, TrustScopeSchema } from "./platform.js";
import { AgentRoleSchema } from "./session.js";

export const ToolTriggerSchema = z.enum([
  "prior_context",
  "routine_command",
  "code_relationships",
  "external_documentation",
  "browser_inspection",
  "explicit"
]);
export type ToolTrigger = z.infer<typeof ToolTriggerSchema>;

export const ToolKindSchema = z.enum(["cli_only", "stdio_mcp", "native_remote_mcp", "existing_shared_worker"]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const ToolRequirednessSchema = z.enum(["required", "optional"]);
export type ToolRequiredness = z.infer<typeof ToolRequirednessSchema>;

const UniqueIdentifiersSchema = z.array(IdentifierSchema).min(1).refine(
  values => new Set(values).size === values.length,
  "values must be unique"
);

/** Repository-owned desired tool authority. The digest binds this exact policy snapshot. */
export const RepositoryToolPolicySchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  repositoryId: IdentifierSchema,
  scope: TrustScopeSchema,
  digest: Sha256DigestSchema,
  requirements: z.array(z.lazy(() => RoleToolRequirementSchema))
}).strict().superRefine((policy, context) => {
  if (policy.scope.kind !== "repository") {
    context.addIssue({ code: "custom", path: ["scope"], message: "repository tool policy requires repository scope" });
  } else if (policy.scope.repositoryId !== policy.repositoryId) {
    context.addIssue({ code: "custom", path: ["scope", "repositoryId"], message: "policy repositoryId must match scope" });
  }
  const seen = new Set<string>();
  policy.requirements.forEach((requirement, index) => {
    if (seen.has(requirement.toolId)) context.addIssue({ code: "custom", path: ["requirements", index, "toolId"], message: "tool requirements must be unique" });
    seen.add(requirement.toolId);
    if (requirement.memoryScope && policy.scope.kind === "repository" && requirement.memoryScope.repositoryId !== policy.scope.repositoryId) {
      context.addIssue({ code: "custom", path: ["requirements", index, "memoryScope", "repositoryId"], message: "memory scope must match policy repository" });
    }
  });
});

/** One repository requirement; operations are explicit authority, never inferred from capabilities. */
export const RoleToolRequirementSchema = z.object({
  toolId: IdentifierSchema,
  kind: ToolKindSchema,
  capabilityIds: UniqueIdentifiersSchema.optional(),
  serviceId: IdentifierSchema.optional(),
  operations: UniqueIdentifiersSchema,
  requiredness: ToolRequirednessSchema,
  roles: z.array(AgentRoleSchema).min(1).refine(values => new Set(values).size === values.length, "roles must be unique"),
  triggers: z.array(ToolTriggerSchema).min(1).refine(values => new Set(values).size === values.length, "triggers must be unique"),
  memoryScope: z.object({
    wing: IdentifierSchema,
    repositoryId: IdentifierSchema,
    access: z.literal("read_only")
  }).strict().optional(),
  cliCommandProfiles: UniqueIdentifiersSchema.optional()
}).strict().superRefine((requirement, context) => {
  if (requirement.memoryScope && requirement.serviceId === undefined) {
    context.addIssue({ code: "custom", path: ["serviceId"], message: "memory requirements require an explicit serviceId" });
  }
  if (requirement.memoryScope && requirement.kind === "cli_only") {
    context.addIssue({ code: "custom", path: ["kind"], message: "memory requirements must use an MCP service" });
  }
  if (requirement.cliCommandProfiles && requirement.kind !== "cli_only") {
    context.addIssue({ code: "custom", path: ["cliCommandProfiles"], message: "CLI command profiles require a CLI tool" });
  }
  if (requirement.cliCommandProfiles && requirement.cliCommandProfiles.length > 0 && requirement.serviceId !== undefined) {
    context.addIssue({ code: "custom", path: ["serviceId"], message: "CLI requirements cannot select an MCP service" });
  }
});
export type RoleToolRequirement = z.infer<typeof RoleToolRequirementSchema>;
export type RepositoryToolPolicy = z.infer<typeof RepositoryToolPolicySchema>;

const CliExecutableIdentitySchema = z.object({
  executablePath: z.string().min(1)
    .refine(value => !value.includes("\0"), "NUL is forbidden")
    .refine(value => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value), "executablePath must be absolute"),
  version: IdentifierSchema,
  digest: Sha256DigestSchema
}).strict();

const MemoryGrantScopeSchema = z.object({
  wing: IdentifierSchema,
  repositoryId: IdentifierSchema,
  access: z.literal("read_only")
}).strict();

/** Host-resolved per-session grant. Identity and scope are checked again at invocation ingress. */
export const ResolvedToolGrantSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  grantId: IdentifierSchema,
  policyDigest: Sha256DigestSchema,
  toolId: IdentifierSchema,
  capabilityIds: UniqueIdentifiersSchema.optional(),
  kind: ToolKindSchema,
  requiredness: ToolRequirednessSchema,
  role: AgentRoleSchema,
  scope: TrustScopeSchema,
  triggers: z.array(ToolTriggerSchema).min(1).refine(values => new Set(values).size === values.length, "triggers must be unique"),
  serviceId: IdentifierSchema.optional(),
  operations: UniqueIdentifiersSchema,
  cliIdentity: CliExecutableIdentitySchema.optional(),
  cliCommandProfiles: UniqueIdentifiersSchema.optional(),
  memoryScope: MemoryGrantScopeSchema.optional()
}).strict().superRefine((grant, context) => {
  if (grant.scope.kind !== "session") context.addIssue({ code: "custom", path: ["scope"], message: "resolved grant requires session scope" });
  if (grant.kind === "cli_only") {
    if (grant.serviceId !== undefined) context.addIssue({ code: "custom", path: ["serviceId"], message: "CLI grants cannot have serviceId" });
    if (grant.cliIdentity === undefined) context.addIssue({ code: "custom", path: ["cliIdentity"], message: "CLI grant requires trusted executable identity" });
  } else {
    if (grant.serviceId === undefined) context.addIssue({ code: "custom", path: ["serviceId"], message: "MCP grant requires serviceId" });
    if (grant.cliIdentity !== undefined || grant.cliCommandProfiles !== undefined) {
      context.addIssue({ code: "custom", path: ["cliIdentity"], message: "MCP grants cannot carry CLI authority" });
    }
  }
  if (grant.memoryScope && grant.scope.kind !== "machine" && grant.memoryScope.repositoryId !== grant.scope.repositoryId) {
    context.addIssue({ code: "custom", path: ["memoryScope", "repositoryId"], message: "memory scope must match grant repository" });
  }
});
export type ResolvedToolGrant = z.infer<typeof ResolvedToolGrantSchema>;
