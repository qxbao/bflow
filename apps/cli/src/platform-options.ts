import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgenticHostPlatformOptions, HostPrepareResponse, PlatformRoleOption } from "@bflow/runtime";
import type { EnvironmentCompositionInput } from "./environment.js";
import { EnvironmentProviderSchema, type EnvironmentRoleConfig } from "./environment-config.js";
import { GATEWAY_CONTROL_LOCATOR_FILE } from "./gateway-control.js";
import { CONTEXT7_SERVICE_ID, CONTEXT7_TOOLS } from "./context7-constants.js";
import { SUPPORTED_CLI_COMMANDS } from "./command-reference.js";
import { loadMachineSkillCatalog, type MachineSkillCatalog } from "./skill-catalog.js";

/** Machine facts the host needs. Loaded once per startup; no provider is probed here. */
export interface HostPlatformContext {
  readonly machineId: string;
  /** Machine state directory (`platform.paths.state`), which holds the Gateway locator. */
  readonly stateDirectory: string;
  /** Machine data directory (`platform.paths.data`), which holds the skill store. */
  readonly dataDirectory: string;
  /** HOME selector for provider processes; under BFLOW_HOME this stays isolated from the account home. */
  readonly codexProcessHomeDirectory: string;
  /** Trusted Codex home read by the provider adapter; never comes from repository config. */
  readonly codexHomeDirectory: string;
  /** Private machine-owned approval store for Codex global hooks. */
  readonly codexHookApprovalPath: string;
  readonly skills: MachineSkillCatalog;
}

export interface HostPlatformDeps {
  readonly context: HostPlatformContext;
  readonly fileExists?: ((path: string) => boolean) | undefined;
  /** Whether the Gateway reports Context7 ready right now. Unknown counts as not ready. */
  readonly context7Ready?: boolean | undefined;
  /** Receives operator-visible warnings (degraded mode). */
  readonly warn?: ((message: string) => void) | undefined;
}

const CONTEXT7_SKILL_ID = "use-context7";

export async function loadHostPlatformContext(): Promise<HostPlatformContext> {
  const setup = await import("@bflow/machine-setup");
  const host = setup.defaultHostEnvironment();
  let platform = await setup.detectPlatformWithProbe(host);
  if (host.env.BFLOW_HOME) platform = setup.isolatedPlatformProfile(platform, resolve(host.env.BFLOW_HOME));
  const codexTrust = resolveCodexTrustPaths({
    environment: host.env,
    homeDirectory: host.homeDir,
    processHomeDirectory: platform.homeDir,
    machineStateDirectory: platform.paths.state
  });
  return {
    machineId: platform.machineId,
    stateDirectory: platform.paths.state,
    dataDirectory: platform.paths.data,
    ...codexTrust,
    skills: await loadMachineSkillCatalog()
  };
}

/** Resolves only trusted process/machine context; repository configuration cannot redirect approvals or Codex hooks. */
export function resolveCodexTrustPaths(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly processHomeDirectory: string;
  readonly machineStateDirectory: string;
}): { readonly codexHomeDirectory: string; readonly codexProcessHomeDirectory: string; readonly codexHookApprovalPath: string } {
  const isolatedRoot = input.environment.BFLOW_HOME;
  const codexHomeDirectory = isolatedRoot
    ? resolve(isolatedRoot, "providers", "codex")
    : input.environment.CODEX_HOME
      ? resolve(input.environment.CODEX_HOME)
      : join(input.homeDirectory, ".codex");
  const stateDirectory = isolatedRoot ? resolve(isolatedRoot, "state") : input.machineStateDirectory;
  return {
    codexHomeDirectory,
    codexProcessHomeDirectory: input.processHomeDirectory,
    codexHookApprovalPath: join(stateDirectory, "codex-hook-approvals.json")
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

  const context7 = environment.context7;
  const context7Active = context7?.enabled === true && (context7.required === true || deps.context7Ready === true);
  if (context7?.enabled === true && !context7Active)
    deps.warn?.("Context7 is enabled but the Gateway does not report it ready; roles start without documentation lookup (degraded). Run 'bflow doctor' for the cause, or set environment.context7.required to refuse to start without it.");
  const roles: PlatformRoleOption[] = environment.roles.map(role => roleOption(role, input, deps.context.skills, context7Active));
  // Developers are allocated dynamically in task worktrees; without a configured Developer, the template uses the Coordinator's provider.
  if (!configured.has("developer"))
    roles.push(roleOption({ role: "developer", cli: coordinator.cli, required: false,
      ...modelSettings(coordinator) }, input, deps.context.skills, context7Active));

  const locatorPath = join(deps.context.stateDirectory, GATEWAY_CONTROL_LOCATOR_FILE);
  const gatewayLocatorPath = (deps.fileExists ?? existsSync)(locatorPath) ? { gatewayLocatorPath: locatorPath } : {};
  return AgenticHostPlatformOptionsSchema.parse({
    schemaVersion: 3,
    machineId: deps.context.machineId,
    repositoryId: input.repository.id,
    roles,
    codexHomeDirectory: deps.context.codexHomeDirectory,
    codexProcessHomeDirectory: deps.context.codexProcessHomeDirectory,
    codexHookApprovalPath: deps.context.codexHookApprovalPath,
    skillsStoreRoot: join(deps.context.dataDirectory, "skills-store"),
    approvedBuiltinSkillDigests: [...deps.context.skills.approvedBuiltinSkillDigests],
    supportedCommands: [...SUPPORTED_CLI_COMMANDS],
    ...gatewayLocatorPath
  });
}

function roleOption(role: EnvironmentRoleConfig, input: EnvironmentCompositionInput, skills: MachineSkillCatalog, context7Active = false): PlatformRoleOption {
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
  // Per-role authorization: the Gateway grants Context7 only to roles whose approved skill definition allows them to use it.
  // The Conversation role never receives Gateway tool access.
  const context7Role = context7Active && role.role !== "conversation" &&
    skills.definitions.some(definition => definition.skillId === CONTEXT7_SKILL_ID && definition.allowedRoles.includes(role.role));
  return {
    role: role.role,
    provider: provider.data,
    required: role.required ?? true,
    ...modelSettings(role),
    permissionMode: role.permissionMode ?? environment.permissions?.mode ?? "workspace_auto",
    capabilityIds: [],
    mcpServiceIds: [...new Set([...(environment.requiredMcpServices ?? []), ...(context7Role ? [CONTEXT7_SERVICE_ID] : [])])],
    toolIds: [...new Set([...(environment.requiredTools ?? []), ...(context7Role ? CONTEXT7_TOOLS : [])])],
    skillSelections: skills.resolvePins(role.role, skillIds)
  };
}

/** Model selection and effort are role-local. */
function modelSettings(role: EnvironmentRoleConfig): Pick<PlatformRoleOption, "model" | "effort"> {
  return {
    ...(role.model !== undefined ? { model: role.model } : {}),
    ...(role.effort !== undefined ? { effort: role.effort } : {})
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
