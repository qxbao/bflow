import { z } from "zod";
import {
  AgentRoleSchema,
  SkillDefinitionSchema,
  type AgentRole,
  type SkillDefinition,
  type SkillPin,
} from "@bflow/contracts";
import { readBundle, type BundleFiles } from "./storage.js";
import { validateSkill, type SkillSource } from "./validation.js";
import type { ResolveSkillsRequest } from "./manager.js";

export interface CatalogSkill {
  directory: string;
  files: BundleFiles;
  definition: SkillDefinition;
}
/** No auto-discovery of provider homes. Only an explicit, reviewed catalog root is loaded. */
export async function loadSkillCatalog(
  root: string,
  options: { source: SkillSource; supportedCommands: readonly string[] },
): Promise<CatalogSkill[]> {
  const all = await readBundle(root);
  const prefixes = Object.keys(all)
    .filter((p) => p.endsWith("/SKILL.md"))
    .map((p) => p.slice(0, -"SKILL.md".length))
    .sort();
  if (!prefixes.length)
    throw new Error("Skill catalog has no SKILL.md bundles");
  const result: CatalogSkill[] = [];
  for (const prefix of prefixes) {
    const files: BundleFiles = {};
    for (const [path, content] of Object.entries(all))
      if (path.startsWith(prefix)) files[path.slice(prefix.length)] = content;
    const definition = validateSkill(files, options);
    if (result.some((s) => s.definition.skillId === definition.skillId))
      throw new Error(`Duplicate skill name: ${definition.skillId}`);
    result.push({
      directory: `${root}/${prefix.slice(0, -1)}`,
      files,
      definition,
    });
  }
  return result;
}
export const RoleSkillNamesSchema = z.record(
  AgentRoleSchema,
  z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).min(1),
);
export const ConditionalRoleSkillBindingSchema = z.object({
  toolId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  skillId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  required: z.boolean().default(false),
}).strict();
export const ConditionalRoleSkillBindingsSchema = z.record(
  AgentRoleSchema,
  z.array(ConditionalRoleSkillBindingSchema),
);
export const RoleSkillBindingsSchema = z
  .object({
    schemaVersion: z.literal(3),
    bindings: RoleSkillNamesSchema,
    conditionalBindings: ConditionalRoleSkillBindingsSchema.default({}),
  })
  .strict();
export type RoleSkillNames = z.infer<typeof RoleSkillNamesSchema>;
export type ConditionalRoleSkillBinding = z.infer<typeof ConditionalRoleSkillBindingSchema>;

export interface ResolveRoleSkillSelectionsRequest {
  bindings: unknown;
  conditionalBindings?: unknown;
  role: AgentRole;
  catalog: SkillDefinition[];
  /** IDs from validated host grants; catalog metadata never supplies these. */
  grantedToolIds: readonly string[];
  requiredToolIds?: readonly string[];
}

/** Resolve workflow skills and add tool skills only when the host supplied a matching grant. */
export function resolveRoleSkillSelections(
  request: ResolveRoleSkillSelectionsRequest,
): ResolveSkillsRequest["selections"] {
  const conditional = ConditionalRoleSkillBindingsSchema.parse(request.conditionalBindings ?? {});
  const definitions = z.array(SkillDefinitionSchema).parse(request.catalog);
  const role = AgentRoleSchema.parse(request.role);
  const roleBindings = conditional[role] ?? [];
  const conditionalSkillIds = new Set(roleBindings.map((item) => item.skillId));
  const base = bindRoleSkills(request.bindings, role, request.catalog)
    .filter((item) => !conditionalSkillIds.has(item.skill.skillId));
  const granted = new Set(request.grantedToolIds);
  const required = new Set(request.requiredToolIds ?? []);
  const extra: ResolveSkillsRequest["selections"] = [];
  for (const binding of roleBindings) {
    const definition = definitions.find((item) => item.skillId === binding.skillId);
    if (!definition || !definition.allowedRoles.includes(role)) {
      throw new Error(`Missing or forbidden conditional skill pin: ${binding.skillId}`);
    }
    if (!granted.has(binding.toolId)) {
      if (binding.required || required.has(binding.toolId)) {
        throw new Error(`Required tool grant unavailable for conditional skill: ${binding.toolId}`);
      }
      continue;
    }
    if (extra.some((item) => item.skill.skillId === binding.skillId) || base.some((item) => item.skill.skillId === binding.skillId)) {
      throw new Error(`Duplicate conditional role skill binding: ${binding.skillId}`);
    }
    extra.push({
      skill: { skillId: definition.skillId, version: definition.version, digest: definition.digest },
      required: binding.required || required.has(binding.toolId),
    });
  }
  return [...base, ...extra];
}

export function bindRoleSkills(
  input: unknown,
  role: AgentRole,
  catalog: SkillDefinition[],
): ResolveSkillsRequest["selections"] {
  const bindings = RoleSkillNamesSchema.parse(input);
  const definitions = z.array(SkillDefinitionSchema).parse(catalog);
  const names = bindings[AgentRoleSchema.parse(role)];
  if (!names) throw new Error(`Missing role skill bindings: ${role}`);
  if (new Set(names).size !== names.length)
    throw new Error(`Duplicate role skill binding: ${role}`);
  return names.map((name) => {
    const candidates = definitions.filter((d) => d.skillId === name);
    if (candidates.length !== 1)
      throw new Error(
        `Missing or ambiguous skill pin for role binding: ${name}`,
      );
    const d = candidates[0]!;
    if (!d.allowedRoles.includes(role))
      throw new Error(`Role skill forbidden: ${name}`);
    const skill: SkillPin = {
      skillId: d.skillId,
      version: d.version,
      digest: d.digest,
    };
    return { skill, required: true };
  });
}
