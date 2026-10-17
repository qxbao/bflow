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
export const RoleSkillBindingsSchema = z
  .object({ schemaVersion: z.literal(3), bindings: RoleSkillNamesSchema })
  .strict();
export type RoleSkillNames = z.infer<typeof RoleSkillNamesSchema>;
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
