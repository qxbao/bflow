import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgenticHostPlatformOptions, HostPrepareResponse, PlatformRoleOption } from "@bflow/runtime";
import type { EnvironmentCompositionInput } from "./environment.js";
import { EnvironmentProviderSchema, type EnvironmentRoleConfig } from "./environment-config.js";
import { GATEWAY_CONTROL_LOCATOR_FILE } from "./gateway-control.js";
import { SUPPORTED_CLI_COMMANDS } from "./command-reference.js";
import { loadMachineSkillCatalog, type MachineSkillCatalog } from "./skill-catalog.js";

/** Machine facts the host needs. Loaded once per startup; no provider is probed here. */
export interface HostPlatformContext {
  readonly machineId: string;
  /** Machine state directory (`platform.paths.state`), which holds the Gateway locator. */
  readonly stateDirectory: string;
  /** Machine data directory (`platform.paths.data`), which holds the skill store. */
  readonly dataDirectory: string;
  readonly skills: MachineSkillCatalog;
}

export interface HostPlatformDeps {
  readonly context: HostPlatformContext;
  readonly fileExists?: ((path: string) => boolean) | undefined;
}

export async function loadHostPlatformContext(): Promise<HostPlatformContext> {
  const setup = await import("@bflow/machine-setup");
  const platform = await setup.detectPlatformWithProbe(setup.defaultHostEnvironment());
  return {
    machineId: platform.machineId,
    stateDirectory: platform.paths.state,
    dataDirectory: platform.paths.data,
    skills: await loadMachineSkillCatalog()
  };
}

/**
 * Derives the host's platform options from repository configuration and machine state.
 * Readiness is never decided here: the host's provider preflight owns every verdict, so
 * provider names are only validated as configuration values.
 */
export async function buildHostPlatformOptions(input: EnvironmentCompositionInput, deps: HostPlatformDeps): Promise<AgenticHostPlatformOptions> {
  const { AgenticHostPlatformOptionsSchema } = await import("@bflow/runtime");
  const environment = input.config.environment;
  const configured = new Map(environment.roles.map(role => [role.role, role] as const));
  const coordinator = configured.get("coordinator");
  if (!coordinator) throw new Error("Configuration must include a coordinator role");

  const roles: PlatformRoleOption[] = environment.roles.map(role => roleOption(role, input, deps.context.skills));
  // Developers are allocated dynamically in task worktrees; without a configured Developer, the template uses the Coordinator's provider.
  if (!configured.has("developer"))
    roles.push(roleOption({ role: "developer", cli: coordinator.cli, required: false,
      ...modelSettings(coordinator) }, input, deps.context.skills));

  const locatorPath = join(deps.context.stateDirectory, GATEWAY_CONTROL_LOCATOR_FILE);
  const gatewayLocatorPath = (deps.fileExists ?? existsSync)(locatorPath) ? { gatewayLocatorPath: locatorPath } : {};
  return AgenticHostPlatformOptionsSchema.parse({
    schemaVersion: 3,
    machineId: deps.context.machineId,
    repositoryId: input.repository.id,
    roles,
    skillsStoreRoot: join(deps.context.dataDirectory, "skills-store"),
    approvedBuiltinSkillDigests: [...deps.context.skills.approvedBuiltinSkillDigests],
    supportedCommands: [...SUPPORTED_CLI_COMMANDS],
    ...gatewayLocatorPath
  });
}

function roleOption(role: EnvironmentRoleConfig, input: EnvironmentCompositionInput, skills: MachineSkillCatalog): PlatformRoleOption {
  const environment = input.config.environment;
  const provider = EnvironmentProviderSchema.safeParse(role.cli);
  if (!provider.success) throw new Error(`Role '${role.role}' uses unsupported provider '${role.cli}'; select claude, codex or agy.`);
  // Environment-wide skills apply to every role their approved definition allows. Unknown ids stay so
  // resolution fails by name; explicit role skills are never filtered.
  const environmentSkills = (environment.skills?.requiredSkills ?? []).filter(skillId => {
    const definitions = skills.definitions.filter(definition => definition.skillId === skillId);
    return definitions.length === 0 || definitions.some(definition => definition.allowedRoles.includes(role.role));
  });
  const skillIds = [...new Set([...environmentSkills, ...(role.skills ?? [])])];
  return {
    role: role.role,
    provider: provider.data,
    required: role.required ?? true,
    ...modelSettings(role),
    permissionMode: role.permissionMode ?? environment.permissions?.mode ?? "workspace_auto",
    capabilityIds: [],
    mcpServiceIds: [...(environment.requiredMcpServices ?? [])],
    toolIds: [...(environment.requiredTools ?? [])],
    skillSelections: skills.resolvePins(role.role, skillIds)
  };
}

/** Model selection and effort are role-local; this shape stays additive while the config owner updates its schema. */
function modelSettings(role: EnvironmentRoleConfig): Pick<PlatformRoleOption, "model" | "effort"> {
  const settings = role as EnvironmentRoleConfig & { readonly model?: string; readonly effort?: PlatformRoleOption["effort"] };
  return {
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(settings.effort !== undefined ? { effort: settings.effort } : {})
  };
}

/**
 * Startup refusal for `ready: false`. Lists each non-ready role with its provider, status and the
 * failing adapter checks; the host's messages are passed through, and no launch environment is shown.
 */
export function formatPlatformNotReady(report: NonNullable<HostPrepareResponse["platform"]>): string {
  const lines = ["Provider readiness is not satisfied; no panes were started.", "Blocked roles:"];
  for (const role of report.roles) {
    if (role.status === "ready") continue;
    lines.push(`  - ${role.role} [${role.provider}]${role.required ? "" : " (optional)"}: ${role.status}`);
    if (role.message) lines.push(`      ${role.message}`);
    for (const check of role.checks.filter(item => item.status !== "passed"))
      lines.push(`      ${check.check} (${check.code}): ${check.message}${check.remediation ? ` Remediation: ${check.remediation}` : ""}`);
  }
  return lines.join("\n");
}
