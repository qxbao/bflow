import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgenticHostPlatformOptions, HostPrepareResponse, PlatformRoleOption } from "@bflow/runtime";
import { createHash } from "node:crypto";
import type { RepositoryToolPolicy, ResolvedToolGrant, RoleToolRequirement } from "@bflow/contracts";
import { MCPServiceDefinitionSchema, OperationResultSchema, RepositoryToolPolicySchema, ResolvedToolGrantSchema,
  VerifiedToolExecutableIdentitySchema } from "@bflow/contracts";
import { digest as canonicalDigest } from "@bflow/machine-setup";
import { readGatewayReadiness } from "./gateway-readiness.js";
import type { EnvironmentCompositionInput } from "./environment.js";
import { EnvironmentProviderSchema, type EnvironmentProvider, type EnvironmentRoleConfig } from "./environment-config.js";
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
  /** Trusted ai-isolator state root; never supplied by repository configuration. */
  readonly isolatorStateRoot?: string;
  readonly skills: MachineSkillCatalog;
  /** Verified machine-owned CLI facts. Pins alone are not executable readiness. */
  readonly toolInventory?: ReadonlyMap<string, { readonly executablePath: string; readonly version: string; readonly digest: string; readonly capabilityIds?: readonly string[] }>;
  /** Strict machine-owned definitions read from the approved setup inventory. */
  readonly mcpServices?: readonly unknown[];
  /** Fresh Gateway observations; a configured service without a current ready observation is not a grant. */
  readonly serviceReadiness?: ReadonlyMap<string, { readonly status: "ready" | "blocked" | "missing" | "unknown"; readonly discoveredTools: readonly string[]; readonly reason?: string }>;
}

export interface HostPlatformDeps {
  readonly context: HostPlatformContext;
  readonly fileExists?: ((path: string) => boolean) | undefined;
  /** Whether the Gateway reports Context7 ready right now. Unknown counts as not ready. */
  readonly context7Ready?: boolean | undefined;
  /** Receives operator-visible warnings (degraded mode). */
  readonly warn?: ((message: string) => void) | undefined;
  readonly inventoryReason?: ((toolId: string) => string | undefined) | undefined;
  readonly onToolStatus?: ((status: ToolPolicyResolutionStatus) => void) | undefined;
}

export interface ToolPolicyResolutionStatus {
  readonly role: string;
  readonly toolId: string;
  readonly requiredness: "required" | "optional";
  readonly installed: boolean;
  readonly allowed: true;
  readonly granted: boolean;
  readonly ready: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export async function loadHostPlatformContext(input?: EnvironmentCompositionInput): Promise<HostPlatformContext> {
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
  const machineConfigPath = join(platform.paths.config, "machine.json");
  const machineConfig = await setup.loadMachineConfig(machineConfigPath);
  const mcpServices = machineConfig.status === "valid" ? machineConfig.config!.mcpServices : [];
  const skills = await loadMachineSkillCatalog();
  const toolInventory = new Map<string, { executablePath: string; version: string; digest: string }>();
  const cliRequirements = input?.config.environment.toolPolicy?.requirements.filter(requirement => requirement.kind === "cli_only") ?? [];
  if (cliRequirements.length && machineConfig.status === "valid") {
    const { defaultToolCatalog, ManagedToolInstaller } = await import(
      new URL("../../../packages/tool-installer/dist/index.js", import.meta.url).href);
    const catalog = defaultToolCatalog(platform.os, platform.arch);
    const VerifiedExecutableInspectionSchema = OperationResultSchema(VerifiedToolExecutableIdentitySchema);
    const requested = new Set(cliRequirements.map(requirement => skills.canonicalToolId(requirement.toolId)));
    for (const pin of machineConfig.config!.toolPins.filter(item => requested.has(item.toolId))) {
      const approved = catalog.pins.find((candidate: { toolId: string; installerId: string; version: string; integrity: string; source: string }) =>
        candidate.toolId === pin.toolId && candidate.installerId === pin.installerId &&
        candidate.version === pin.version && candidate.integrity === pin.integrity && candidate.source === pin.source);
      if (!approved) continue;
      const inspector = new ManagedToolInstaller({ managedRoot: join(platform.paths.data, "tools"), pins: [approved] });
      const result = await inspector.inspectExecutable({ schemaVersion: 3, toolId: pin.toolId, installerId: pin.installerId,
        version: pin.version, source: pin.source, integrity: pin.integrity, destination: join(platform.paths.data, "tools", pin.toolId),
        scope: { kind: "machine", machineId: platform.machineId },
        idempotencyKey: `inspect:${platform.machineId}:${pin.toolId}:${pin.version}:${pin.integrity}` });
      const receipt = VerifiedExecutableInspectionSchema.safeParse(result);
      if (!receipt.success || !receipt.data.ok || receipt.data.value.toolId !== pin.toolId ||
          receipt.data.value.version !== pin.version || receipt.data.value.artifactIntegrity !== pin.integrity) continue;
      toolInventory.set(pin.toolId, { executablePath: receipt.data.value.executablePath, version: receipt.data.value.version,
        digest: receipt.data.value.executableDigest });
    }
  }
  const serviceRequirements = input?.config.environment.toolPolicy?.requirements.filter(requirement => requirement.kind !== "cli_only") ?? [];
  const requestedServices = new Set(mcpServices.filter(raw => {
    const parsed = MCPServiceDefinitionSchema.safeParse(raw);
    return parsed.success && serviceRequirements.some(requirement => parsed.data.tool.toolId === skills.canonicalToolId(requirement.toolId) &&
      parsed.data.tool.kind === requirement.kind && (requirement.serviceId === undefined || parsed.data.serviceId === requirement.serviceId) &&
      requirement.operations.every(operation => parsed.data.tool.operations.includes(operation)));
  }).map(raw => (raw as { serviceId: string }).serviceId));
  if (input?.config.environment.context7?.enabled === true) requestedServices.add(CONTEXT7_SERVICE_ID);
  const toolInstaller = await import(new URL("../../../packages/tool-installer/dist/index.js", import.meta.url).href);
  const serviceReadiness = new Map<string, { status: "ready" | "blocked" | "missing" | "unknown"; discoveredTools: readonly string[]; reason?: string }>();
  for (const serviceId of requestedServices) {
    const observed = await readGatewayReadiness(platform.paths.state, serviceId);
    const service = mcpServices.map(raw => MCPServiceDefinitionSchema.safeParse(raw)).find(parsed => parsed.success && parsed.data.serviceId === serviceId);
    const projected = service?.success && observed.observation
      ? toolInstaller.projectVerifiedServiceCapability({ service: service.data, observation: observed.observation })
      : undefined;
    serviceReadiness.set(serviceId, projected?.status === "ready"
      ? { status: "ready", discoveredTools: projected.operations }
      : { status: observed.status === "ready" ? "blocked" : observed.status, discoveredTools: observed.discoveredTools,
        reason: projected && projected.status === "blocked" ? projected.diagnostic : "no fresh authenticated Gateway service observation" });
  }
  return {
    machineId: platform.machineId,
    stateDirectory: platform.paths.state,
    dataDirectory: platform.paths.data,
    isolatorStateRoot: resolveIsolatorStateRoot(host.env, host.homeDir),
    ...codexTrust,
    skills, toolInventory, mcpServices, serviceReadiness
  };
}

export function resolveIsolatorStateRoot(
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string
): string {
  if (environment.AI_ISOLATOR_HOME) return resolve(environment.AI_ISOLATOR_HOME);
  const realHome = environment.AI_ISOLATOR_REAL_HOME || homeDirectory;
  return resolve(realHome, ".local", "share", "ai-isolator");
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

  if ((environment.requiredTools?.length ?? 0) > 0)
    throw new Error(`Legacy environment.requiredTools has no role or operation allowlist; remove it and add explicit role requirements under environment.toolPolicy (legacy IDs: ${environment.requiredTools!.join(", ")}).`);
  if ((environment.requiredMcpServices?.length ?? 0) > 0)
    throw new Error(`Legacy environment.requiredMcpServices cannot be safely mapped to role operations; migrate each service to environment.toolPolicy with explicit role and operation allowlists (services: ${environment.requiredMcpServices!.join(", ")}).`);
  const toolPolicy = resolveRepositoryToolPolicy(input, deps.context.machineId);
  const serviceReadiness = new Map(deps.context.serviceReadiness ?? []);
  if (environment.context7?.enabled === true && !serviceReadiness.has(CONTEXT7_SERVICE_ID) && deps.context7Ready !== undefined)
    serviceReadiness.set(CONTEXT7_SERVICE_ID, { status: deps.context7Ready ? "ready" : "blocked",
      discoveredTools: deps.context7Ready ? [...CONTEXT7_TOOLS] : [] });
  const toolContext = { ...deps.context, serviceReadiness };
  const toolGrants = resolveToolGrants(toolPolicy, toolContext, input, deps.warn, deps.inventoryReason, deps.onToolStatus);
  const grantsByRole = new Map<string, ResolvedToolGrant[]>();
  for (const grant of toolGrants) grantsByRole.set(grant.role, [...(grantsByRole.get(grant.role) ?? []), grant]);
  const roles: PlatformRoleOption[] = environment.roles.map(role => roleOption(role, input, deps.context.skills, grantsByRole.get(role.role) ?? [], deps.warn));
  // Developers are allocated dynamically in task worktrees; without a configured Developer, the template uses the Coordinator's provider.
  if (!configured.has("developer")) {
    const inheritedProfileName = selectedProfileName(coordinator, environment);
    roles.push(roleOption({ role: "developer", cli: coordinator.cli, required: false,
      ...modelSettings(coordinator),
      ...(inheritedProfileName !== undefined ? { "profile-name": inheritedProfileName } : {})
    }, input, deps.context.skills, grantsByRole.get("developer") ?? [], deps.warn));
  }

  const locatorPath = join(deps.context.stateDirectory, GATEWAY_CONTROL_LOCATOR_FILE);
  const gatewayLocatorPath = (deps.fileExists ?? existsSync)(locatorPath) ? { gatewayLocatorPath: locatorPath } : {};
  const hasSelectedProfiles = environment.roles.some(role => selectedProfileName(role, environment) !== undefined) ||
    (!configured.has("developer") && selectedProfileName(coordinator, environment) !== undefined);
  return AgenticHostPlatformOptionsSchema.parse({
    schemaVersion: 3,
    machineId: deps.context.machineId,
    repositoryId: input.repository.id,
    roles,
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(toolGrants.length ? { toolGrants } : {}),
    codexHomeDirectory: deps.context.codexHomeDirectory,
    codexProcessHomeDirectory: deps.context.codexProcessHomeDirectory,
    codexHookApprovalPath: deps.context.codexHookApprovalPath,
    skillsStoreRoot: join(deps.context.dataDirectory, "skills-store"),
    approvedBuiltinSkillDigests: [...deps.context.skills.approvedBuiltinSkillDigests],
    supportedCommands: [...SUPPORTED_CLI_COMMANDS],
    ...(hasSelectedProfiles && deps.context.isolatorStateRoot
      ? { isolatorStateRoot: deps.context.isolatorStateRoot }
      : {}),
    ...gatewayLocatorPath
  });
}

function roleOption(role: EnvironmentRoleConfig, input: EnvironmentCompositionInput, skills: MachineSkillCatalog,
  grants: readonly ResolvedToolGrant[] = [], warn?: (message: string) => void): PlatformRoleOption {
  const environment = input.config.environment;
  const provider = EnvironmentProviderSchema.safeParse(role.cli);
  if (!provider.success) throw new Error(`Role '${role.role}' uses unsupported provider '${role.cli}'; select claude, codex or agy.`);
  // Environment-wide required skills add to required role bindings; explicit role.skills replaces only defaults.
  const environmentSkills = (environment.skills?.requiredSkills ?? []).filter(skillId => {
    const definitions = skills.definitions.filter(definition => definition.skillId === skillId);
    return definitions.length === 0 || definitions.some(definition => definition.allowedRoles.includes(role.role));
  });
  const defaultBindings = skills.roleBindings as { bindings?: Record<string, string[]>;
    conditionalBindings?: Record<string, { skillId: string; toolId: string; requiredness?: "required" | "optional" }[]> };
  const conditional = defaultBindings.conditionalBindings?.[role.role] ?? [];
  const conditionalSkillIds = new Set(conditional.map(binding => binding.skillId));
  const inheritedSkillIds = role.skills ?? defaultBindings.bindings?.[role.role] ?? [];
  const grantsByTool = new Map(grants.map(grant => [skills.canonicalToolId(grant.toolId), grant]));
  const grantForBinding = (binding: { readonly toolId: string }) => grantsByTool.get(skills.canonicalToolId(binding.toolId));
  const applicableConditional = role.skills === undefined ? conditional : conditional.filter(binding => role.skills!.includes(binding.skillId));
  const missingRequiredBindings = applicableConditional.filter(binding => (binding.requiredness ?? "optional") === "required" && !grantForBinding(binding));
  if (missingRequiredBindings.length)
    throw new Error(`Role '${role.role}' requires a tool-backed skill grant for: ${missingRequiredBindings.map(binding => binding.toolId).join(", ")}`);
  for (const binding of applicableConditional.filter(item => (item.requiredness ?? "optional") === "optional" && !grantForBinding(item)))
    warn?.(`Optional skill '${binding.skillId}' for role '${role.role}' is skipped because tool '${binding.toolId}' has no approved grant`);
  const skillIds = [...new Set([
    ...inheritedSkillIds.filter(skillId => !conditionalSkillIds.has(skillId)),
    ...environmentSkills,
    ...applicableConditional.filter(binding => grantForBinding(binding)).map(binding => binding.skillId)
  ])];
  const grantedToolIds = new Set(grants.map(grant => skills.canonicalToolId(grant.toolId)));
  const definitionsById = new Map(skills.definitions.map(definition => [definition.skillId, definition]));
  const eligibleSkillIds = skillIds.filter(skillId => {
    const definition = definitionsById.get(skillId);
    if (!definition) return true;
    const missing = definition.requiredToolIds.map(toolId => skills.canonicalToolId(toolId)).filter(toolId => !grantedToolIds.has(toolId));
    if (missing.length && environmentSkills.includes(skillId))
      throw new Error(`Required skill '${skillId}' for role '${role.role}' has no approved tool grant: ${missing.join(", ")}`);
    if (missing.length) warn?.(`Skill '${skillId}' for role '${role.role}' is skipped because it has no approved tool grant: ${missing.join(", ")}`);
    return missing.length === 0;
  });
  const skillSelections = skills.resolvePins(role.role, eligibleSkillIds).map(selection => {
    const conditionalBinding = conditional.find(binding => binding.skillId === selection.skill.skillId);
    const grant = conditionalBinding ? grantForBinding(conditionalBinding) : undefined;
    return { ...selection, required: conditionalBinding
      ? conditionalBinding.requiredness === "required" || grant?.requiredness === "required"
      : (definitionsById.get(selection.skill.skillId)?.requiredToolIds.length ?? 0) === 0 };
  });
  const requiredSkillIds = new Set(environmentSkills);
  const normalizedSelections = skillSelections.map(selection => requiredSkillIds.has(selection.skill.skillId)
    ? { ...selection, required: true } : selection);
  if (environment.skills?.required === true && !normalizedSelections.some(selection => selection.skill.skillId === "using-bflow"))
    throw new Error(`Role '${role.role}' requires a non-empty workflow skill manifest; preserve using-bflow in the role skill override.`);
  const roleGrants = grants.filter(grant => grant.role === role.role);
  return {
    role: role.role,
    provider: provider.data,
    required: role.required ?? true,
    ...profileSettings(selectedProfileName(role, environment)),
    ...modelSettings(role),
    permissionMode: role.permissionMode ?? environment.permissions?.mode ?? "workspace_auto",
    capabilityIds: [],
    mcpServiceIds: [...new Set(roleGrants.filter(grant => grant.serviceId).map(grant => grant.serviceId!))],
    toolIds: [...new Set(roleGrants.map(grant => grant.toolId))],
    skillSelections: normalizedSelections
  };
}

export function resolveRepositoryToolPolicy(input: EnvironmentCompositionInput, machineId: string): RepositoryToolPolicy | undefined {
  const explicit = input.config.environment.toolPolicy;
  if (explicit) {
    const parsed = RepositoryToolPolicySchema.parse(explicit);
    if (parsed.repositoryId !== input.repository.id || parsed.scope.kind !== "repository" || parsed.scope.repositoryId !== input.repository.id || parsed.scope.machineId !== machineId || parsed.scope.workspaceRoot !== input.repository.root)
      throw new Error("environment.toolPolicy repository identity must match this repository");
    const { digest: _digest, ...body } = parsed;
    if (canonicalDigest(body) !== parsed.digest) throw new Error("environment.toolPolicy digest does not match its canonical contents");
    const legacyContext7Roles = ["specifier", "architect", "planner", "developer", "reviewer", "qa"];
    if (input.config.environment.context7?.enabled === true) {
      const requirement = parsed.requirements.find(item => item.toolId === CONTEXT7_SERVICE_ID && item.serviceId === CONTEXT7_SERVICE_ID);
      if (!requirement || requirement.operations.length !== CONTEXT7_TOOLS.length ||
          !CONTEXT7_TOOLS.every(operation => requirement.operations.includes(operation)) ||
          requirement.requiredness !== (input.config.environment.context7.required === true ? "required" : "optional") ||
          requirement.roles.length !== legacyContext7Roles.length || !legacyContext7Roles.every(role => requirement.roles.includes(role as typeof requirement.roles[number])))
        throw new Error("Legacy environment.context7 conflicts with environment.toolPolicy; retain its exact service, operation, requiredness and role allowlist or remove the legacy field");
    }
    return parsed;
  }
  const context7 = input.config.environment.context7;
  if (context7?.enabled !== true) return undefined;
  const roles = ["specifier", "architect", "planner", "developer", "reviewer", "qa"] as const;
  const requirement: RoleToolRequirement = { toolId: "context7", kind: "native_remote_mcp", serviceId: CONTEXT7_SERVICE_ID,
    operations: [...CONTEXT7_TOOLS], requiredness: context7.required ? "required" : "optional", roles: [...roles],
    triggers: ["external_documentation"] };
  const base = { schemaVersion: 3 as const, repositoryId: input.repository.id,
    scope: { kind: "repository" as const, machineId, repositoryId: input.repository.id, workspaceRoot: input.repository.root }, requirements: [requirement] };
  return RepositoryToolPolicySchema.parse({ ...base, digest: canonicalDigest(base) });
}

export function resolveToolGrants(policy: RepositoryToolPolicy | undefined, context: HostPlatformContext, input: EnvironmentCompositionInput,
  warn?: (message: string) => void, inventoryReason?: (toolId: string) => string | undefined,
  onStatus?: (status: ToolPolicyResolutionStatus) => void, strictRequired = true): ResolvedToolGrant[] {
  if (!policy) return [];
  const grants: ResolvedToolGrant[] = [];
  const machineServices = (context.mcpServices ?? []).map(service => MCPServiceDefinitionSchema.parse(service));
  for (const requirement of policy.requirements) for (const role of requirement.roles) {
    if (role === "conversation") throw new Error("Conversation role cannot receive a tool grant");
    const canonicalToolId = context.skills.canonicalToolId(requirement.toolId);
    let installed = false;
    let ready = false;
    let granted = false;
    let version: string | undefined;
    let reason: string | undefined;
    const report = () => onStatus?.({ role, toolId: requirement.toolId, requiredness: requirement.requiredness,
      installed, allowed: true, granted, ready, ...(version ? { version } : {}), ...(reason ? { reason } : {}) });
    let serviceId: string | undefined;
    let cliIdentity: ResolvedToolGrant["cliIdentity"];
    let capabilityIds: string[] | undefined;
    if (requirement.kind === "cli_only") {
      const inventory = context.toolInventory?.get(canonicalToolId);
      if (!inventory) {
        reason = inventoryReason?.(requirement.toolId) ?? "no verified machine executable identity is available";
        report();
        if (requirement.requiredness === "required" && strictRequired) throw new Error(`Required tool '${requirement.toolId}' for role '${role}' is unavailable: ${reason}`);
        warn?.(`Optional tool '${requirement.toolId}' for role '${role}' is degraded: ${reason}`);
        continue;
      }
      installed = true;
      ready = true;
      version = inventory.version;
      cliIdentity = { executablePath: inventory.executablePath, version: inventory.version, digest: inventory.digest };
      capabilityIds = inventory.capabilityIds ? [...inventory.capabilityIds] : undefined;
    } else {
      const matches = machineServices.filter(service => service.tool.toolId === canonicalToolId && service.tool.kind === requirement.kind &&
        (requirement.serviceId === undefined || service.serviceId === requirement.serviceId) &&
        requirement.operations.every(operation => service.tool.operations.includes(operation)) &&
        ((service.scope.kind === "machine" && service.scope.machineId === context.machineId) ||
          (service.scope.kind === "repository" && service.scope.machineId === context.machineId && service.scope.repositoryId === input.repository.id &&
            service.scope.workspaceRoot === input.repository.root) ||
          (service.scope.kind === "session" && service.scope.machineId === context.machineId && service.scope.repositoryId === input.repository.id &&
            service.scope.workspaceRoot === input.repository.root && service.scope.sessionId === input.repository.sessionName)));
      if (matches.length !== 1) {
        reason = matches.length === 0 ? "no approved machine service matches tool ID, kind and operation allowlist" : "multiple approved services match; specify serviceId";
        report();
        if (requirement.requiredness === "required" && strictRequired) throw new Error(`Required tool '${requirement.toolId}' for role '${role}' is unavailable: ${reason}`);
        warn?.(`Optional tool '${requirement.toolId}' for role '${role}' is degraded: ${reason}`);
        continue;
      }
      installed = true;
      version = matches[0]!.tool.version;
      serviceId = matches[0]!.serviceId;
      const readiness = context.serviceReadiness?.get(serviceId);
      ready = readiness?.status === "ready" && requirement.operations.every(operation => readiness.discoveredTools.includes(operation));
      if (!ready) {
        reason = readiness?.reason ?? (readiness ? `Gateway status is ${readiness.status} or required operations were not discovered` : "Gateway has no current ready observation");
        report();
        if (requirement.requiredness === "required" && strictRequired) throw new Error(`Required tool '${requirement.toolId}' for role '${role}' is unavailable: ${reason}`);
        warn?.(`Optional tool '${requirement.toolId}' for role '${role}' is degraded: ${reason}`);
        continue;
      }
    }
    if (grants.some(grant => grant.role === role && grant.toolId === canonicalToolId))
      throw new Error(`Tool policy contains overlapping alias requirements for '${canonicalToolId}' and role '${role}'`);
    const grant = ResolvedToolGrantSchema.parse({ schemaVersion: 3, grantId: `grant-${createHash("sha256").update([policy.digest, canonicalToolId, role].join(":")).digest("hex").slice(0, 32)}`,
      policyDigest: policy.digest, toolId: canonicalToolId, ...(capabilityIds?.length ? { capabilityIds } : {}), kind: requirement.kind,
      requiredness: requirement.requiredness, role, scope: { kind: "session", machineId: context.machineId, repositoryId: input.repository.id,
        workspaceRoot: input.repository.root, sessionId: input.repository.sessionName }, triggers: requirement.triggers,
      ...(serviceId ? { serviceId } : {}), operations: requirement.operations,
      ...(cliIdentity ? { cliIdentity } : {}), ...(requirement.cliCommandProfiles ? { cliCommandProfiles: requirement.cliCommandProfiles } : {}),
      ...(requirement.memoryScope ? { memoryScope: requirement.memoryScope } : {}) });
    grants.push(grant);
    granted = true;
    report();
  }
  return grants;
}

function selectedProfileName(role: EnvironmentRoleConfig, environment: EnvironmentCompositionInput["config"]["environment"]): string | undefined {
  return role["profile-name"] ?? environment.defaults?.[role.cli as EnvironmentProvider]?.["profile-name"];
}

function profileSettings(profileName: string | undefined): { readonly profileName?: string } {
  return profileName === undefined ? {} : { profileName };
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
