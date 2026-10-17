import { fileURLToPath } from "node:url";
import type { AgentRole, SkillDefinition, SkillPin } from "@bflow/contracts";
import { SUPPORTED_CLI_COMMANDS } from "./command-reference.js";

/** P28 loader and pin binder from the built `@bflow/skills` package; loaded dynamically like the other workspace packages. */
interface SkillsModule {
  loadSkillCatalog(root: string, options: { source: "builtin"; supportedCommands: readonly string[] }):
    Promise<{ directory: string; definition: SkillDefinition }[]>;
  bindRoleSkills(input: unknown, role: AgentRole, catalog: SkillDefinition[]): { skill: SkillPin; required: boolean }[];
}

export interface MachineSkillCatalog {
  /** Approved builtin bundles, as `skills sync` pins them. */
  readonly entries: readonly { root: string; source: "builtin"; expectedDigest: string }[];
  readonly definitions: readonly SkillDefinition[];
  readonly approvedBuiltinSkillDigests: readonly string[];
  /** Resolves skill ids to exact pins for one role. Missing, ambiguous or role-forbidden ids throw naming the skill. */
  resolvePins(role: AgentRole, skillIds: readonly string[]): { skill: SkillPin; required: boolean }[];
}

/** Loads the repository's builtin skill catalog through the same P28 path `skills sync` uses. */
export async function loadMachineSkillCatalog(): Promise<MachineSkillCatalog> {
  const skills = (await import(new URL("../../../packages/skills/dist/index.js", import.meta.url).href)) as SkillsModule;
  const catalogRoot = fileURLToPath(new URL("../../../skills", import.meta.url));
  const items = await skills.loadSkillCatalog(catalogRoot, { source: "builtin", supportedCommands: SUPPORTED_CLI_COMMANDS });
  const definitions = items.map(item => item.definition);
  return {
    entries: items.map(item => ({ root: item.directory, source: "builtin", expectedDigest: item.definition.digest })),
    definitions,
    approvedBuiltinSkillDigests: definitions.map(definition => definition.digest),
    resolvePins: (role, skillIds) => skillIds.length === 0 ? []
      : skills.bindRoleSkills(Object.fromEntries([[role, [...skillIds]]]), role, definitions)
  };
}
