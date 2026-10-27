import { z } from "zod";
import { IdentifierSchema } from "./common.js";
import { AgentProviderIdSchema, NonEmptyArgumentSchema, PlatformSchemaVersionSchema,
  Sha256DigestSchema, TrustScopeSchema } from "./platform.js";
import { AgentRoleSchema } from "./session.js";

export const SkillPinSchema = z.object({
  skillId: IdentifierSchema,
  version: NonEmptyArgumentSchema,
  digest: Sha256DigestSchema
}).strict();
export type SkillPin = z.infer<typeof SkillPinSchema>;

/** Exact authorization for a dependency reached from selected skills; it never selects that skill. */
export const SkillDependencyApprovalSchema = z.object({
  skill: SkillPinSchema,
  approvalReceiptId: IdentifierSchema
}).strict();
export type SkillDependencyApproval = z.infer<typeof SkillDependencyApprovalSchema>;

export const SkillDefinitionSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  skillId: IdentifierSchema,
  version: NonEmptyArgumentSchema,
  digest: Sha256DigestSchema,
  source: z.enum(["builtin", "operator", "repository"]),
  entrypoint: NonEmptyArgumentSchema,
  description: z.string().min(1),
  allowedRoles: z.array(AgentRoleSchema).min(1),
  supportedProviders: z.array(AgentProviderIdSchema).min(1),
  requiredCapabilityIds: z.array(IdentifierSchema),
  requiredToolIds: z.array(IdentifierSchema),
  dependencies: z.array(SkillPinSchema),
  instructionOnly: z.literal(true)
}).strict().superRefine((skill, ctx) => {
  if (skill.dependencies.some(pin => pin.skillId === skill.skillId) ||
      new Set(skill.dependencies.map(pin => pin.skillId)).size !== skill.dependencies.length)
    ctx.addIssue({ code: "custom", message: "skill dependencies must be unique and cannot include self" });
});
export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;

export const RoleSkillBindingSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  bindingId: IdentifierSchema,
  role: AgentRoleSchema,
  provider: AgentProviderIdSchema,
  scope: TrustScopeSchema.refine(scope => scope.kind === "session", "role skill bindings require session scope"),
  skill: SkillPinSchema,
  required: z.boolean(),
  approvalReceiptId: IdentifierSchema.optional()
}).strict();
export type RoleSkillBinding = z.infer<typeof RoleSkillBindingSchema>;

export const SkillManifestSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  manifestId: IdentifierSchema,
  environmentId: IdentifierSchema,
  scope: TrustScopeSchema.refine(scope => scope.kind === "session", "skill manifests require session scope"),
  role: AgentRoleSchema,
  provider: AgentProviderIdSchema,
  digest: Sha256DigestSchema,
  skills: z.array(SkillDefinitionSchema),
  bindings: z.array(RoleSkillBindingSchema)
}).strict().superRefine((manifest, ctx) => {
  const definitions = new Map(manifest.skills.map(skill => [skill.skillId, skill]));
  const pinsMatch = (pin: SkillPin) => {
    const skill = definitions.get(pin.skillId);
    return skill && skill.version === pin.version && skill.digest === pin.digest;
  };
  if (definitions.size !== manifest.skills.length ||
      new Set(manifest.bindings.map(binding => binding.bindingId)).size !== manifest.bindings.length ||
      new Set(manifest.bindings.map(binding => binding.skill.skillId)).size !== manifest.bindings.length)
    ctx.addIssue({ code: "custom", message: "duplicate skill definition/binding" });
  const seen = new Set<string>();
  for (const skill of manifest.skills) {
    if (!skill.allowedRoles.includes(manifest.role) || !skill.supportedProviders.includes(manifest.provider) ||
        skill.dependencies.some(pin => !pinsMatch(pin) || !seen.has(pin.skillId)))
      ctx.addIssue({ code: "custom", message: "skills require compatible roles/providers and pinned dependencies in topological order" });
    seen.add(skill.skillId);
  }
  for (const binding of manifest.bindings) {
    const skill = definitions.get(binding.skill.skillId);
    if (!pinsMatch(binding.skill) || binding.role !== manifest.role || binding.provider !== manifest.provider ||
        JSON.stringify(binding.scope) !== JSON.stringify(manifest.scope) ||
        (skill?.source === "repository" && !binding.approvalReceiptId))
      ctx.addIssue({ code: "custom", message: "skill binding identity/scope/approval mismatch" });
  }
  if (manifest.skills.some(skill => !manifest.bindings.some(binding => binding.skill.skillId === skill.skillId)))
    ctx.addIssue({ code: "custom", message: "every resolved skill must have an explicit role binding" });
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
