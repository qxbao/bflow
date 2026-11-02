import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { defaultHostEnvironment, detectPlatform, digest as policyDigest } from '@bflow/machine-setup';
import {
    RepositoryToolPolicySchema, WorkflowPackSchema, sameRoleProfilePin,
    type JsonValue, type PlanDecision, type RepositoryToolPolicy, type RoleToolRequirement
} from '@bflow/contracts';
import { canonicalPlanDigest, resolveWorkflowPack, workflowPackDigest } from '@bflow/runtime';
import type { EnvironmentCompositionInput } from './environment.js';
import {
    EnvironmentConfigEnvironmentSchema, isGovernanceRoleConfig,
    type EnvironmentGovernanceRoleConfig, type EnvironmentProvider, type EnvironmentRoleConfig
} from './environment-config.js';
import { DEEPWIKI_SERVICE_ID, DEEPWIKI_TOOLS } from './deepwiki-constants.js';
import { loadMachineSkillCatalog } from './skill-catalog.js';
import { readPreviewFile } from './preview-files.js';
import { loadSpecialistProfiles } from './specialist-profiles.js';
import type { PlatformRoleOption } from '@bflow/runtime';

export function selectedProfileName(role: EnvironmentRoleConfig, environment: EnvironmentCompositionInput['config']['environment']): string | undefined {
    return role['profile-name'] ?? environment.defaults?.[role.cli as EnvironmentProvider]?.['profile-name'];
}

/** Model selection and effort are role-local. */
export function modelSettings(role: EnvironmentRoleConfig): Pick<PlatformRoleOption, 'model' | 'effort'> {
    return {
        ...(role.model !== undefined ? { model: role.model } : {}),
        ...(role.effort !== undefined ? { effort: role.effort } : {})
    };
}

/** Preserve governance roles while inheriting only the Developer launch template. */
export function configuredPlatformRoles(input: EnvironmentCompositionInput): EnvironmentGovernanceRoleConfig[] {
    // The sos rescue role is launched by the host on demand and never joins platform readiness.
    const roles = input.config.environment.roles.filter(isGovernanceRoleConfig);
    const coordinator = roles.find(role => role.role === 'coordinator');
    if (!coordinator) throw new Error('Configuration must include a coordinator role');
    if (!roles.some(role => role.role === 'developer')) {
        const profile = selectedProfileName(coordinator, input.config.environment);
        roles.push({ role: 'developer', cli: coordinator.cli, required: false, ...modelSettings(coordinator), ...(profile ? { 'profile-name': profile } : {}) });
    }
    return roles;
}

export function resolveRepositoryToolPolicy(input: EnvironmentCompositionInput, machineId: string): RepositoryToolPolicy | undefined {
    const explicit = input.config.environment.toolPolicy;
    if (explicit) {
        const parsed = RepositoryToolPolicySchema.parse(explicit);
        if (parsed.repositoryId !== input.repository.id || parsed.scope.kind !== 'repository' || parsed.scope.repositoryId !== input.repository.id || parsed.scope.machineId !== machineId || parsed.scope.workspaceRoot !== input.repository.root)
            throw new Error('environment.toolPolicy repository identity must match this repository');
        const { digest: _digest, ...body } = parsed;
        if (policyDigest(body) !== parsed.digest) throw new Error('environment.toolPolicy digest does not match its canonical contents');
        const legacyDeepWikiRoles = ['specifier', 'architect', 'planner', 'developer', 'reviewer', 'qa'];
        if (input.config.environment.deepwiki?.enabled === true) {
            const requirement = parsed.requirements.find(item => item.toolId === DEEPWIKI_SERVICE_ID && item.serviceId === DEEPWIKI_SERVICE_ID);
            if (!requirement || requirement.operations.length !== DEEPWIKI_TOOLS.length ||
                !DEEPWIKI_TOOLS.every(operation => requirement.operations.includes(operation)) ||
                requirement.requiredness !== (input.config.environment.deepwiki.required === true ? 'required' : 'optional') ||
                requirement.roles.length !== legacyDeepWikiRoles.length || !legacyDeepWikiRoles.every(role => requirement.roles.includes(role as typeof requirement.roles[number])))
                throw new Error('Legacy environment.deepwiki conflicts with environment.toolPolicy; retain its exact service, operation, requiredness and role allowlist or remove the legacy field');
        }
        return parsed;
    }
    const requirements: RoleToolRequirement[] = [];
    const deepwiki = input.config.environment.deepwiki;
    if (deepwiki?.enabled !== false) {
        const roles = ['specifier', 'architect', 'planner', 'developer', 'reviewer', 'qa'] as const;
        requirements.push({
            toolId: 'deepwiki',
            kind: 'native_remote_mcp',
            serviceId: DEEPWIKI_SERVICE_ID,
            operations: [...DEEPWIKI_TOOLS],
            requiredness: deepwiki?.required ? 'required' : 'optional',
            roles: [...roles],
            triggers: ['external_documentation']
        });
    }
    const tools = input.config.environment.tools;
    if (tools?.rtk?.enabled !== false) {
        requirements.push({
            toolId: 'rtk',
            kind: 'cli_only',
            operations: ['pipe'],
            ...(tools?.rtk?.cliCommandProfiles?.length ? { cliCommandProfiles: [...tools.rtk.cliCommandProfiles] } : {}),
            requiredness: tools?.rtk?.required ? 'required' : 'optional',
            roles: ['developer', 'reviewer', 'tester', 'qa'],
            triggers: ['routine_command']
        });
    }
    if (tools?.gitnexus?.enabled !== false) {
        requirements.push({
            toolId: 'gitnexus',
            kind: 'stdio_mcp',
            operations: ['query', 'context', 'impact'],
            requiredness: tools?.gitnexus?.required ? 'required' : 'optional',
            roles: ['architect', 'developer', 'reviewer', 'security'],
            triggers: ['code_relationships']
        });
    }
    if (tools?.mempalace?.enabled !== false) {
        const defaultMempalaceServiceId = `mempalace-${createHash('sha256').update(machineId).digest('hex').slice(0, 24)}`;
        requirements.push({
            toolId: 'mempalace',
            kind: 'stdio_mcp',
            serviceId: tools?.mempalace?.serviceId ?? defaultMempalaceServiceId,
            operations: ['mempalace_search'],
            requiredness: tools?.mempalace?.required ? 'required' : 'optional',
            roles: ['developer', 'qa', 'security'],
            triggers: ['prior_context'],
            memoryScope: {
                wing: tools?.mempalace?.wing ?? input.repository.id,
                repositoryId: input.repository.id,
                access: 'read_only'
            }
        });
    }
    if (tools?.['chrome-devtools-mcp']?.enabled !== false) {
        requirements.push({
            toolId: 'chrome-devtools-mcp',
            kind: 'stdio_mcp',
            operations: ['list_pages', 'new_page', 'navigate_page'],
            requiredness: tools?.['chrome-devtools-mcp']?.required ? 'required' : 'optional',
            roles: ['tester', 'qa'],
            triggers: ['browser_inspection']
        });
    }
    if (requirements.length === 0) return undefined;
    const base = {
        schemaVersion: 3 as const,
        repositoryId: input.repository.id,
        scope: {
            kind: 'repository' as const,
            machineId,
            repositoryId: input.repository.id,
            workspaceRoot: input.repository.root
        },
        requirements
    };
    return RepositoryToolPolicySchema.parse({ ...base, digest: policyDigest(base) });
}
/** The execution and preview entrypoints both use this declarative pack resolution. */
export async function resolvePlatformConfiguration(input: EnvironmentCompositionInput) {
    const environment = input.config.environment;
    const roleProfiles = await loadSpecialistProfiles(input);
    const project: Record<string, JsonValue> = {};
    const catalog = await loadMachineSkillCatalog(input);
    // The on-demand sos rescue role bypasses pack resolution and skill pins; it is passed through unchanged.
    const governanceRoles = environment.roles.filter(isGovernanceRoleConfig);
    const nonGovernanceRoles = environment.roles.filter(role => !isGovernanceRoleConfig(role));
    for (const role of governanceRoles) {
        project[`roles.${role.role}.provider`] = role.cli;
        if (role.specialistProfile !== undefined)
            project[`roles.${role.role}.specialistProfile`] = role.specialistProfile;
        if (role.model !== undefined)
            project[`roles.${role.role}.model`] = role.model;
        if (role.skills !== undefined)
            project[`skills.${role.role}`] = catalog.resolvePins(role.role, role.skills).map(item => item.skill);
        if (role.effort !== undefined)
            project[`roles.${role.role}.effort`] = role.effort;
        const profile = role['profile-name'] ?? environment.defaults?.[role.cli as EnvironmentProvider]?.['profile-name'];
        if (profile !== undefined)
            project[`roles.${role.role}.profile`] = profile;
    }
    let pack: unknown;
    let unavailable: {
        id: string;
        version: string;
    } | undefined;
    const selection = environment.workflowPack;
    if (selection) {
        try {
            const packPath = resolve(input.repository.root, selection.path);
            const rel = relative(input.repository.root, packPath);
            if (!rel || rel.startsWith('..') || isAbsolute(rel))
                throw new Error('Pack must stay inside repository');
            pack = WorkflowPackSchema.parse(JSON.parse(await readPreviewFile(packPath)));
            const parsed = WorkflowPackSchema.parse(pack);
            const { digest } = parsed;
            if (parsed.id !== selection.id || parsed.version !== selection.version || digest !== selection.digest || workflowPackDigest(parsed) !== digest)
                throw new Error('Workflow pack pin does not match');
        }
        catch {
            unavailable = { id: selection.id, version: selection.version };
            pack = undefined;
        }
    }
    const resolution = resolveWorkflowPack({ ...(pack ? { pack } : {}), ...(unavailable ? { unavailable } : {}), project });
    for (const decision of resolution.decisions) {
        const parts = decision.field.split('.');
        const role = governanceRoles.find(item => item.role === parts[1]);
        const field = parts[2];
        const locator = parts[0] === 'roles' && role
            ? field === 'profile' && role['profile-name'] === undefined
                ? `environment.defaults.${role.cli}.profile-name`
                : `environment.roles.${role.role}.${field === 'provider' ? 'cli' : field === 'profile' ? 'profile-name' : field}`
            : parts[0] === 'skills' ? `environment.roles.${parts[1]}.skills` : decision.field;
        for (const candidate of decision.candidates)
            if (candidate.source.kind === 'project')
                candidate.source.locator = locator;
        if (decision.source.kind === 'project')
            decision.source.locator = locator;
    }
    const materializeRole = (role: EnvironmentGovernanceRoleConfig): EnvironmentGovernanceRoleConfig => {
        const result: Record<string, unknown> = { ...role };
        for (const decision of resolution.decisions) {
            const prefix = `roles.${role.role}.`;
            if (decision.field.startsWith(prefix)) {
                const field = decision.field.slice(prefix.length);
                result[field === 'provider' ? 'cli' : field === 'profile' ? 'profile-name' : field] = decision.effective;
            }
            if (decision.field === `skills.${role.role}` && decision.source.kind === 'pack' && Array.isArray(decision.effective)) {
                const expected = decision.effective;
                const ids = expected.map(pin => typeof pin === 'object' && pin !== null && !Array.isArray(pin) ? String(pin.skillId) : '');
                const actual = catalog.resolvePins(role.role, ids).map(item => item.skill);
                if (canonicalPlanDigest(actual) !== canonicalPlanDigest(expected))
                    throw new Error('Workflow pack exact skill pin mismatch');
                result.skills = ids;
            }
        }
        return result as EnvironmentGovernanceRoleConfig;
    };
    const explicitRoles = governanceRoles.map(materializeRole);
    const inheritedRoles = environment.roles.some(role => role.role === 'developer') ? [] : ['developer'];
    // Inheritance sees the effective Coordinator, then Developer-specific pack defaults apply.
    const roles = configuredPlatformRoles({ ...input, config: { ...input.config,
        environment: { ...environment, roles: explicitRoles } } })
        .map(role => inheritedRoles.includes(role.role) ? materializeRole(role) : role);
    let resolved = EnvironmentConfigEnvironmentSchema.parse({ ...environment, roles: [...roles, ...nonGovernanceRoles] });
    for (const role of resolved.roles) {
        if (!role.specialistProfile) continue;
        const snapshot = roleProfiles.find(item => sameRoleProfilePin(item.pin, role.specialistProfile));
        if (!snapshot || snapshot.definition.baseRole !== role.role)
            throw new Error('Selected specialist profile is unavailable or incompatible with its governance role');
    }
    const packTools = resolution.decisions.find(decision => decision.field === 'tools.required');
    if (packTools && Array.isArray(packTools.effective)) {
        const host = defaultHostEnvironment();
        const machineId = detectPlatform({ ...host, env: { ...host.env, ...input.env } }).machineId;
        const base = resolveRepositoryToolPolicy({ ...input, config: { ...input.config, environment: resolved } }, machineId);
        const required = packTools.effective.filter((item): item is string => typeof item === 'string');
        const known = new Set(base?.requirements.map(item => item.toolId) ?? []);
        if (required.some(toolId => !known.has(toolId)))
            resolution.blockers.push({ code: 'pack_tool_requirement_unknown', decisionIds: ['tools.required'], source: packTools.source });
        if (base) {
            const { digest: _, ...body } = base;
            const effective = { ...body, requirements: base.requirements.map(requirement => required.includes(requirement.toolId) ? { ...requirement, requiredness: 'required' as const } : requirement) };
            resolved = { ...resolved, toolPolicy: RepositoryToolPolicySchema.parse({ ...effective, digest: policyDigest(effective) }) };
        }
    }
    return { ...resolution, workflowPack: pack === undefined ? undefined : WorkflowPackSchema.parse(pack), roleProfiles, inheritedRoles, input: { ...input, config: { ...input.config, environment: resolved } } };
}
export function decisionFor(decisions: readonly PlanDecision[], field: string) { return decisions.find(item => item.field === field); }

/** Preserve only real pack locks; an explicit base-role setting remains a profile default. */
export function rolePreferenceConstraints(decisions: readonly PlanDecision[], role: EnvironmentGovernanceRoleConfig): Pick<PlatformRoleOption, 'preferenceConstraints'> {
    const locked = (key: 'model' | 'effort') => decisionFor(decisions, `roles.${role.role}.${key}`)?.rule?.kind === 'pack';
    const constraints = {
        ...(locked('model') && role.model !== undefined ? { model: role.model } : {}),
        ...(locked('effort') && role.effort !== undefined ? { effort: role.effort } : {})
    };
    return Object.keys(constraints).length ? { preferenceConstraints: constraints } : {};
}
