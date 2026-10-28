import { resolve, relative, isAbsolute } from 'node:path';
import { defaultHostEnvironment, detectPlatform, digest as policyDigest } from '@bflow/machine-setup';
import { configuredPlatformRoles, resolveRepositoryToolPolicy } from './platform-options.js';
import { RepositoryToolPolicySchema, WorkflowPackSchema, sameRoleProfilePin, type JsonValue, type PlanDecision } from '@bflow/contracts';
import { canonicalPlanDigest, resolveWorkflowPack, workflowPackDigest } from '@bflow/runtime';
import type { EnvironmentCompositionInput } from './environment.js';
import { EnvironmentConfigEnvironmentSchema, type EnvironmentRoleConfig, type EnvironmentProvider } from './environment-config.js';
import { loadMachineSkillCatalog } from './skill-catalog.js';
import { readPreviewFile } from './preview-files.js';
import { loadSpecialistProfiles } from './specialist-profiles.js';
import type { PlatformRoleOption } from '@bflow/runtime';
/** The execution and preview entrypoints both use this declarative pack resolution. */
export async function resolvePlatformConfiguration(input: EnvironmentCompositionInput) {
    const environment = input.config.environment;
    const roleProfiles = await loadSpecialistProfiles(input);
    const project: Record<string, JsonValue> = {};
    const catalog = await loadMachineSkillCatalog(input);
    for (const role of environment.roles) {
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
        const role = environment.roles.find(item => item.role === parts[1]);
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
    const materializeRole = (role: EnvironmentRoleConfig): EnvironmentRoleConfig => {
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
        return result as EnvironmentRoleConfig;
    };
    const explicitRoles = environment.roles.map(materializeRole);
    const inheritedRoles = environment.roles.some(role => role.role === 'developer') ? [] : ['developer'];
    // Inheritance sees the effective Coordinator, then Developer-specific pack defaults apply.
    const roles = configuredPlatformRoles({ ...input, config: { ...input.config,
        environment: { ...environment, roles: explicitRoles } } })
        .map(role => inheritedRoles.includes(role.role) ? materializeRole(role) : role);
    let resolved = EnvironmentConfigEnvironmentSchema.parse({ ...environment, roles });
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
    return { ...resolution, roleProfiles, inheritedRoles, input: { ...input, config: { ...input.config, environment: resolved } } };
}
export function decisionFor(decisions: readonly PlanDecision[], field: string) { return decisions.find(item => item.field === field); }

/** Preserve only real pack locks; an explicit base-role setting remains a profile default. */
export function rolePreferenceConstraints(decisions: readonly PlanDecision[], role: EnvironmentRoleConfig): Pick<PlatformRoleOption, 'preferenceConstraints'> {
    const locked = (key: 'model' | 'effort') => decisionFor(decisions, `roles.${role.role}.${key}`)?.rule?.kind === 'pack';
    const constraints = {
        ...(locked('model') && role.model !== undefined ? { model: role.model } : {}),
        ...(locked('effort') && role.effort !== undefined ? { effort: role.effort } : {})
    };
    return Object.keys(constraints).length ? { preferenceConstraints: constraints } : {};
}
