import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { AgentRole, SkillDefinition, SkillPin, ResolvedToolGrant } from "@bflow/contracts";
import { SUPPORTED_CLI_COMMANDS } from "./command-reference.js";
import type { EnvironmentConfig } from "./environment-config.js";

/** P28 loader and pin binder from the built `@bflow/skills` package; loaded dynamically like the other workspace packages. */
interface SkillsModule {
  RoleSkillBindingsSchema: { parse(input: unknown): { schemaVersion: 3; bindings: Record<string, string[]>; conditionalBindings: Record<string, { skillId: string; toolId: string; required: boolean }[]> } };
  loadSkillCatalog(root: string, options: { source: "builtin"; supportedCommands: readonly string[] }):
    Promise<{ directory: string; definition: SkillDefinition }[]>;
  bindRoleSkills(input: unknown, role: AgentRole, catalog: SkillDefinition[]): { skill: SkillPin; required: boolean }[];
  resolveRoleSkillSelections(input: { bindings: unknown; conditionalBindings: unknown; role: AgentRole; catalog: SkillDefinition[]; grantedToolIds: readonly string[] }): { skill: SkillPin; required: boolean }[];
}

export interface MachineSkillCatalog {
  /** Approved builtin bundles, as `skills sync` pins them. */
  readonly entries: readonly { root: string; source: "builtin"; expectedDigest: string }[];
  readonly definitions: readonly SkillDefinition[];
  readonly roleBindings: { schemaVersion: 3; bindings: Record<string, string[]>; conditionalBindings: Record<string, { skillId: string; toolId: string; required: boolean }[]> };
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
  const roleBindings = skills.RoleSkillBindingsSchema.parse(JSON.parse(await readFile(fileURLToPath(new URL("../../../skills/roles/bindings.json", import.meta.url)), "utf8")));
  const conditionalBindings = roleBindings.conditionalBindings;
  return {
    entries: items.map(item => ({ root: item.directory, source: "builtin", expectedDigest: item.definition.digest })),
    definitions,
    roleBindings,
    conditionalBindings,
    canonicalToolId: (toolId: string) => toolInstaller.canonicalToolId(toolId),
    approvedBuiltinSkillDigests: definitions.map(definition => definition.digest),
    resolvePins: (role, skillIds) => skillIds.length === 0 ? []
      : skills.bindRoleSkills(Object.fromEntries([[role, [...skillIds]]]), role, definitions),
    resolveRolePins: (role, grants) => skills.resolveRoleSkillSelections({ bindings: roleBindings.bindings, conditionalBindings,
      role, catalog: definitions, grantedToolIds: grants.map(grant => grant.toolId) })
  };
}

/** Validate bundled instruction selection here; Runtime prepare verifies the stored exact manifests before launch. */
export async function validateBundledStartupSkills(environment: EnvironmentConfig["environment"], storeRoot?: string): Promise<void> {
  if (environment.skills?.catalogDir || environment.skills?.bindingsPath)
    throw new Error("Custom skill catalogDir/bindingsPath require an approved resolver; use the bundled catalog and bindings.");
  const catalog = await loadMachineSkillCatalog();
  let installed: SkillDefinition[] | undefined;
  if (storeRoot) {
    const module = await import(new URL("../../../packages/skills/dist/index.js", import.meta.url).href);
    installed = await new module.SkillManager({ store: new module.SkillFileStore(storeRoot),
      supportedCommands: SUPPORTED_CLI_COMMANDS, approvedBuiltinDigests: catalog.approvedBuiltinSkillDigests }).list();
  }
  for (const role of environment.roles) {
    const defaults = catalog.resolveRolePins(role.role, []).map(item => item.skill.skillId);
    const required = (environment.skills?.requiredSkills ?? []).filter(id =>
      !catalog.definitions.some(definition => definition.skillId === id) ||
      catalog.definitions.some(definition => definition.skillId === id && definition.allowedRoles.includes(role.role)));
    const ids = [...new Set([...(role.skills ?? defaults), ...required])];
    const pins = catalog.resolvePins(role.role, ids);
    if (installed && pins.some(pin => !installed.some(definition => definition.digest === pin.skill.digest)))
      throw new Error(`Role '${role.role}' is missing an exact pinned skill bundle in the machine skill store; run approved skills setup.`);
    if (environment.skills?.required && !pins.some(item => item.skill.skillId === "using-bflow"))
      throw new Error(`Role '${role.role}' requires its approved workflow skills; preserve using-bflow.`);
  }
}
