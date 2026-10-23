import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { AgentRole, SkillDefinition, SkillPin, ResolvedToolGrant } from "@bflow/contracts";
import { SUPPORTED_CLI_COMMANDS } from "./command-reference.js";

/** P28 loader and pin binder from the built `@bflow/skills` package; loaded dynamically like the other workspace packages. */
interface SkillsModule {
  loadSkillCatalog(root: string, options: { source: "builtin"; supportedCommands: readonly string[] }):
    Promise<{ directory: string; definition: SkillDefinition }[]>;
  bindRoleSkills(input: unknown, role: AgentRole, catalog: SkillDefinition[]): { skill: SkillPin; required: boolean }[];
  resolveRoleSkillSelections(input: { bindings: unknown; conditionalBindings: unknown; role: AgentRole; catalog: SkillDefinition[]; grantedToolIds: readonly string[] }): { skill: SkillPin; required: boolean }[];
}

export interface MachineSkillCatalog {
  /** Approved builtin bundles, as `skills sync` pins them. */
  readonly entries: readonly { root: string; source: "builtin"; expectedDigest: string }[];
  readonly definitions: readonly SkillDefinition[];
  readonly roleBindings: unknown;
  readonly conditionalBindings: unknown;
  readonly canonicalToolId: (toolId: string) => string;
  readonly approvedBuiltinSkillDigests: readonly string[];
  /** Resolves skill ids to exact pins for one role. Missing, ambiguous or role-forbidden ids throw naming the skill. */
  resolvePins(role: AgentRole, skillIds: readonly string[]): { skill: SkillPin; required: boolean }[];
  resolveRolePins(role: AgentRole, grants: readonly ResolvedToolGrant[]): { skill: SkillPin; required: boolean }[];
}

/** Loads the repository's builtin skill catalog through the same P28 path `skills sync` uses. */
export async function loadMachineSkillCatalog(): Promise<MachineSkillCatalog> {
  const skills = (await import(new URL("../../../packages/skills/dist/index.js", import.meta.url).href)) as SkillsModule;
  const catalogRoot = fileURLToPath(new URL("../../../skills", import.meta.url));
  const toolInstaller = await import(new URL("../../../packages/tool-installer/dist/index.js", import.meta.url).href);
  const items = await skills.loadSkillCatalog(catalogRoot, { source: "builtin", supportedCommands: SUPPORTED_CLI_COMMANDS });
  const definitions = items.map(item => item.definition);
  const roleBindings = JSON.parse(await readFile(fileURLToPath(new URL("../../../skills/roles/bindings.json", import.meta.url)), "utf8")) as unknown;
  const conditionalBindings = (roleBindings as { conditionalBindings?: unknown }).conditionalBindings ?? {};
  return {
    entries: items.map(item => ({ root: item.directory, source: "builtin", expectedDigest: item.definition.digest })),
    definitions,
    roleBindings,
    conditionalBindings,
    canonicalToolId: (toolId: string) => toolInstaller.canonicalToolId(toolId),
    approvedBuiltinSkillDigests: definitions.map(definition => definition.digest),
    resolvePins: (role, skillIds) => skillIds.length === 0 ? []
      : skills.bindRoleSkills(Object.fromEntries([[role, [...skillIds]]]), role, definitions),
    resolveRolePins: (role, grants) => skills.resolveRoleSkillSelections({ bindings: roleBindings, conditionalBindings,
      role, catalog: definitions, grantedToolIds: grants.map(grant => grant.toolId) })
  };
}
