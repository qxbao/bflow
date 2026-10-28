import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ExecutionPlanInputSchema, SkillManifestSchema, type ExecutionPlanInput, type PlanDecision, type PlanObservation,
    type SkillDefinition, type TrustScope, type AgentRole, type AgentProviderId } from '@bflow/contracts';
import { defaultHostChecks, hostRoleCapabilities, buildExecutionPlan, canonicalPlanDigest, resolvePlanField, readSkillApproval,
    parseBehavioralCommands, parseMutationChecks, parseAppChecks, redactSecrets, isSensitiveKey, readExecutionRepositorySnapshot } from '@bflow/runtime';
import { defaultHostEnvironment, detectPlatform, isolatedPlatformProfile, MachineConfigSchema } from '@bflow/machine-setup';
import type { EnvironmentCompositionInput } from './environment.js';
import { identifyRepository } from './repository.js';
import { readEnvironmentConfig } from './environment-config.js';
import { resolveIsolatorStateRoot, configuredPlatformRoles, resolveRolePlatformOption, selectedProfileName, resolveRepositoryToolPolicy, resolveToolGrants, projectRecordedServiceReadiness } from './platform-options.js';
import { SUPPORTED_CLI_COMMANDS } from './command-reference.js';
import type { AgenticHostPlatformOptions } from '@bflow/runtime';
import { resolvePlatformConfiguration } from './platform-resolution.js';
import { loadMachineSkillCatalog } from './skill-catalog.js';
import { readPreviewFile } from './preview-files.js';
import { readGatewayReadiness } from './gateway-readiness.js';
import { readGatewayRepositoriesState } from './gateway-repositories.js';
export const EXECUTION_RESOLVER_VERSION = 'cli-platform-1';
/** Reads desired configuration and existing observations. No readiness inspector or mutable store is opened. */
export async function loadExecutionResolution(original: EnvironmentCompositionInput, actualPlatform?: AgenticHostPlatformOptions): Promise<ExecutionPlanInput> {
    const resolution = await resolvePlatformConfiguration(original);
    const input = resolution.input;
    const host = defaultHostEnvironment();
    host.env = { ...host.env, ...input.env };
    let platform = detectPlatform(host);
    if (host.env.BFLOW_HOME)
        platform = isolatedPlatformProfile(platform, resolve(host.env.BFLOW_HOME));
    const skills = await loadMachineSkillCatalog(input);
    const policy = resolveRepositoryToolPolicy(input, platform.machineId);
    const decisions: PlanDecision[] = [...resolution.decisions];
    const blockers: ExecutionPlanInput['blockers'] = [...resolution.blockers];
    const observations: PlanObservation[] = [];
    const profileProjection: Record<string, unknown> = {};
    const capabilityRequirements = new Set<string>();
    const source = (locator: string) => ({ kind: 'project' as const, locator });
    let machine: ReturnType<typeof MachineConfigSchema.parse> | undefined;
    try { machine = MachineConfigSchema.parse(JSON.parse(await readPreviewFile(join(platform.paths.config, 'machine.json')))); }
    catch { /* Observations are unavailable; no store or default is created. */ }
    const registrations = await readGatewayRepositoriesState(platform.paths.state, platform.machineId);
    const machineServices = machine?.mcpServices ?? [];
    const knownServiceIds = new Set(machineServices.map(service => service.serviceId));
    const services = [...machineServices, ...(registrations.status === 'valid' ? registrations.state?.repositories.map(item => item.service) ?? [] : [])
        .filter(service => !knownServiceIds.has(service.serviceId))];
    const recorded = new Map<string, Awaited<ReturnType<typeof readGatewayReadiness>>>();
    const serviceReadiness = new Map<string, Awaited<ReturnType<typeof projectRecordedServiceReadiness>>>();
    for (const service of services) {
        const observed = await readGatewayReadiness(platform.paths.state, service.serviceId);
        recorded.set(service.serviceId, observed);
        serviceReadiness.set(service.serviceId, await projectRecordedServiceReadiness(service, observed));
    }
    // Resolve against recorded facts using the execution evaluator. This does not issue or persist authority.
    // Executables are deliberately uninspected; their prospective grants remain unavailable in preview.
    const grants = resolveToolGrants(policy, {
        machineId: platform.machineId, stateDirectory: platform.paths.state, dataDirectory: platform.paths.data,
        codexHomeDirectory: join(platform.homeDir, '.codex'), codexProcessHomeDirectory: platform.homeDir,
        codexHookApprovalPath: join(platform.paths.state, 'codex-hook-approvals.json'),
        skills, mcpServices: services, serviceReadiness
    }, input, undefined, undefined, undefined, false);
    const skillModule = await import('@bflow/skills');
    const manager = new skillModule.SkillManager({
        store: new skillModule.SkillFileStore(join(platform.paths.data, 'skills-store')),
        supportedCommands: SUPPORTED_CLI_COMMANDS, approvedBuiltinDigests: skills.approvedBuiltinSkillDigests,
        authorize: async (check: { definition: SkillDefinition; scope: TrustScope; role: AgentRole; provider: AgentProviderId; approvalReceiptId: string | undefined }) =>
            check.scope.kind === 'session' && await readSkillApproval(join(platform.paths.state, 'skill-approvals.json'), {
            approvalReceiptId: check.approvalReceiptId, skillId: check.definition.skillId, version: check.definition.version,
            digest: check.definition.digest, dependencies: check.definition.dependencies, role: check.role, provider: check.provider,
            repositoryId: check.scope.repositoryId, sessionId: check.scope.sessionId
        })
    });
    for (const role of configuredPlatformRoles(input)) {
        const capabilities = [...hostRoleCapabilities(role.role),
            ...(role.role === 'conversation' ? [] : (decisions.find(item => item.field === 'capabilities.required')?.effective ?? []) as string[])];
        for (const capability of capabilities) capabilityRequirements.add(capability);
        const inherited = resolution.inheritedRoles.includes(role.role);
        const locator = `environment.roles.${inherited ? 'coordinator' : role.role}`;
        const add = (field: string, value: unknown, at: string) => {
            if (!decisions.some(item => item.field === field))
                decisions.push(resolvePlanField({ field, candidates: [{ source: source(at), value: JSON.parse(JSON.stringify(value)) }] }));
        };
        add(`roles.${role.role}.provider`, role.cli, `${locator}.cli`);
        add(`roles.${role.role}.model`, role.model ?? 'provider-default-unknown', `${locator}.model`);
        if (role.effort !== undefined)
            add(`roles.${role.role}.effort`, role.effort, `${locator}.effort`);
        if (role.failover !== undefined)
            add(`roles.${role.role}.failover`, role.failover, `${locator}.failover`);
        const profile = selectedProfileName(role, input.config.environment);
        if (profile !== undefined) {
            add(`roles.${role.role}.profile`, profile, role['profile-name'] ? `${locator}.profile-name` : `environment.defaults.${role.cli}.profile-name`);
            if (!/^[A-Za-z0-9._-]+$/.test(profile))
                throw new Error('Invalid native profile identity');
            const profileRoot = join(resolveIsolatorStateRoot(host.env, host.homeDir), 'profiles', `${role.cli}--${profile}`);
            try {
                const metadata = await readPreviewFile(join(profileRoot, 'profile.env'), 4096);
                const fields = Object.fromEntries(metadata.split(/\r?\n/).filter(line => /^(AI_ISOLATOR_TOOL|AI_ISOLATOR_PROFILE|AI_ISOLATOR_CREATED_AT)=/.test(line)).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
                const settings: Record<string, unknown> = {};
                for (const relative of ['home/.codex/config.toml', 'home/.claude/settings.json', 'codex-backend.mode', 'codex-lb.url']) {
                    try {
                        const content = await readPreviewFile(join(profileRoot, relative));
                        settings[relative] = redactSecrets(relative.endsWith('.json') ? JSON.parse(content) : content);
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                        settings[relative] = null;
                    }
                }
                profileProjection[`${role.cli}.${profile}`] = { metadata: fields, settings };
            }
            catch {
                blockers.push({ code: 'native_profile_unavailable', decisionIds: [`roles.${role.role}.profile`], source: source(`${locator}.profile-name`) });
            }
        }
        try {
            const option = actualPlatform?.roles.find(option => option.role === role.role)
                ?? resolveRolePlatformOption(role, input, skills, grants.filter(grant => grant.role === role.role));
            const selectedPins = option.skillSelections.map(item => item.skill);
            if (!skills.bundles) throw new Error('Skill snapshots unavailable');
            const resolved = await manager.resolveCatalog({
                manifestId: `preview-${role.role}`, environmentId: `preview-${role.role}`,
                scope: { kind: 'session', machineId: platform.machineId, repositoryId: input.repository.id,
                    workspaceRoot: input.repository.root, sessionId: input.repository.sessionName },
                role: role.role, provider: option.provider, capabilityIds: capabilities, toolIds: option.toolIds,
                selections: option.skillSelections, dependencyApprovals: option.dependencySkillApprovals
            }, skills.bundles);
            const manifest = SkillManifestSchema.parse(resolved.manifest);
            const pins = manifest.skills.map(item => ({ skillId: item.skillId, version: item.version, digest: item.digest }));
            for (const pin of pins) {
                const definition = skills.definitions.find(item => item.skillId === pin.skillId && item.digest === pin.digest)!;
                if (definition.source !== 'repository')
                    continue;
                const approval = input.config.environment.skills?.pins?.find(item => item.skillId === pin.skillId && item.digest === pin.digest);
                const authorized = approval && await readSkillApproval(join(platform.paths.state, 'skill-approvals.json'), {
                    approvalReceiptId: approval.approvalReceiptId, skillId: pin.skillId, version: pin.version, digest: pin.digest,
                    dependencies: definition.dependencies, role: role.role, provider: role.cli, repositoryId: input.repository.id, sessionId: input.repository.sessionName
                });
                observations.push({ id: `skill.${role.role}.${pin.skillId}.approval`, status: authorized ? 'observed' : 'not_checked', source: { kind: 'runtime', locator: 'machine.state/skill-approvals.json' } });
                if (!authorized)
                    blockers.push({ code: 'custom_skill_approval_unavailable', decisionIds: [`skills.${role.role}`], source: source('environment.skills.pins') });
            }
            const field = `skills.${role.role}`;
            const existing = decisions.findIndex(item => item.field === field);
            const prior = existing >= 0 ? decisions[existing] : undefined;
            let decision: PlanDecision = prior ?? resolvePlanField({ field, candidates: [{
                source: role.skills ? source(`${locator}.skills`) : { kind: 'builtin', locator: 'skills/roles/bindings.json' }, value: selectedPins
            }] });
            if (canonicalPlanDigest(decision.effective) !== canonicalPlanDigest(selectedPins)) {
                const policySource = { kind: 'policy' as const, locator: 'environment.toolPolicy' };
                decision = { ...decision, effective: selectedPins, source: policySource,
                    candidates: [...decision.candidates, { source: policySource, value: selectedPins, status: 'accepted', reason: 'tool_policy_filter' }] };
            }
            if (canonicalPlanDigest(selectedPins) !== canonicalPlanDigest(pins)) {
                const dependencySource = { kind: 'policy' as const, locator: 'skills/dependencies' };
                decision = { ...decision, effective: pins, source: dependencySource,
                    candidates: [...decision.candidates, { source: dependencySource, value: pins, status: 'accepted', reason: 'skill_dependencies' }] };
            }
            if (existing >= 0) decisions[existing] = decision;
            else
                decisions.push(decision);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '';
            const approval = message.startsWith('Skill approval unavailable') || message.startsWith('Repository skill approval');
            blockers.push({ code: approval ? 'custom_skill_approval_unavailable'
                : message.startsWith('Missing skill capability:') ? 'skill_capability_unavailable' : 'skill_pin_unavailable',
                decisionIds: [`skills.${role.role}`], source: source(approval ? 'environment.skills.pins' : `${locator}.skills`) });
        }
        observations.push({ id: `provider.${role.role}.readiness`, status: 'not_checked', outcome: 'unknown', reasonCode: 'live_preflight_not_performed', source: { kind: 'runtime', locator: 'provider-preflight' } });
    }
    for (const requirement of policy?.requirements ?? []) {
        const decisionId = 'tools.required';
        const locator = `environment.toolPolicy.requirements.${requirement.toolId}`;
        if (requirement.kind === 'cli_only') {
            const configured = machine?.toolPins.some(pin => pin.toolId === skills.canonicalToolId(requirement.toolId));
            observations.push({ id: `tool.${requirement.toolId}.executable`, status: 'not_checked', outcome: configured ? 'unknown' : 'missing', reasonCode: configured ? 'executable_not_inspected' : 'tool_pin_missing', grantState: 'unknown', source: { kind: 'runtime', locator: configured ? 'machine.toolPins.executable_not_inspected' : 'machine.toolPins.missing' } });
            if (requirement.requiredness === 'required' && !configured)
                blockers.push({ code: 'required_tool_pin_missing', decisionIds: [decisionId], source: source(locator) });
        }
        else {
            const matches = services.filter(service => service.tool.toolId === skills.canonicalToolId(requirement.toolId) && service.tool.kind === requirement.kind && (!requirement.serviceId || requirement.serviceId === service.serviceId));
            const observed = matches.length === 1 ? recorded.get(matches[0]!.serviceId) : undefined;
            const knownReady = matches.length === 1 && serviceReadiness.get(matches[0]!.serviceId)?.status === 'ready';
            observations.push({ id: `tool.${requirement.toolId}.readiness`, status: observed?.gateway === 'stale' ? 'stale' : observed?.observedAt ? 'observed' : 'not_checked', outcome: observed?.status ?? 'missing', reasonCode: observed?.gateway === 'stale' ? 'gateway_observation_stale' : matches.length === 0 ? 'service_definition_missing' : 'gateway_snapshot_only', grantState: 'unknown', source: { kind: 'runtime', locator: 'machine.state/setup-gateway-ready.json' }, ...(observed?.observedAt ? { checkedAt: observed.observedAt } : {}) });
            if (requirement.requiredness === 'required' && !knownReady)
                blockers.push({ code: observed?.gateway === 'stale' ? 'required_tool_readiness_stale' : 'required_tool_readiness_unavailable', decisionIds: [decisionId], source: source(locator) });
        }
    }
    const requirements = policy?.requirements ?? [];
    const requiredTools = requirements.filter(item => item.requiredness === 'required').map(item => item.toolId);
    if (!decisions.some(item => item.field === 'tools.required'))
        decisions.push(resolvePlanField({ field: 'tools.required', candidates: [{ source: source('environment.toolPolicy'), value: requiredTools }] }));
    const { revision, dirtyDigests } = await readExecutionRepositorySnapshot(input.repository.root);
    let ownerVerification: unknown = {};
    let appGateIds: string[] = [];
    try {
        const raw = JSON.parse(await readPreviewFile(join(input.repository.root, '.bflow/verification.json')));
        const commands = parseBehavioralCommands(raw.behavioralCommands);
        const mutations = parseMutationChecks(raw.mutationChecks, commands);
        const apps = parseAppChecks(raw.appChecks);
        const safeCommands = commands.map(command => ({ ...command, args: command.args.map((argument, index) => {
            const previous = command.args[index - 1];
            return previous?.startsWith('-') && !previous.includes('=') && isSensitiveKey(previous.replace(/^--?/, ''))
                ? '[REDACTED]' : argument;
        }) }));
        // Bind complete invocation/assertion semantics, not only labels. Credential fields remain private.
        ownerVerification = redactSecrets(JSON.parse(JSON.stringify({ commands: safeCommands, mutations, apps })));
        appGateIds = apps.map(suite => `host-app-${suite.id}`);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new Error('Owner verification inputs are invalid');
    }
    const requiredCapabilities = [...capabilityRequirements].sort();
    if (!decisions.some(decision => decision.field === 'capabilities.required'))
        decisions.push(resolvePlanField({ field: 'capabilities.required', candidates: [{ source: { kind: 'builtin', locator: 'preflight' }, value: requiredCapabilities }] }));
    const governance = { sdd: input.config.environment.sdd, tdd: input.config.environment.tdd, verification: input.config.environment.verification, fastPath: input.config.environment.fastPath, permissions: input.config.environment.permissions ?? {} };
    return ExecutionPlanInputSchema.parse({ schemaVersion: 3, resolverVersion: EXECUTION_RESOLVER_VERSION, policyVersion: 'bflow-host-1', repository: { revision, dirtyDigests }, components: { configuration: canonicalPlanDigest({ roles: input.config.environment.roles, skills: input.config.environment.skills ?? {}, governance }), ownerVerification: canonicalPlanDigest(ownerVerification), profiles: canonicalPlanDigest(profileProjection), skills: canonicalPlanDigest(skills.definitions.map(item => ({ skillId: item.skillId, version: item.version, digest: item.digest }))), toolPolicy: canonicalPlanDigest(requirements), workflow: canonicalPlanDigest(input.config.defaultWorkflow) }, decisions, observations, mode: 'intake', pack: resolution.pack, policy: { gates: [...defaultHostChecks({ verification: input.config.environment.verification }).map(gate => gate.id), ...appGateIds], tdd: 'unresolved', alternativeVerification: [], requiredTools, requiredCapabilities, explanations: intakePolicyExplanations(appGateIds.length > 0, input.config.environment.sdd.approvalRequired) }, blockers, unknowns: ['specification_unresolved', 'accepted_workflow_unresolved', 'task_dag_unresolved', 'provider_readiness_not_checked', 'cost_and_dynamic_allocations_unresolved'], approvalPoints: ['specification_design_approval_if_required', 'governed_scope_or_policy_change', 'git_integration_if_required'] });
}
/** Policy provenance for intake: values come from host policy/project config; TDD waits for an accepted specification. */
function intakePolicyExplanations(ownerGates: boolean, approvalRequired: boolean): ExecutionPlanInput['policy']['explanations'] {
    const awaiting = { source: { kind: 'policy' as const, locator: 'conditional-tdd-policy' as const }, reasonCode: 'awaiting_accepted_specification' as const };
    return [
        { field: 'gates', source: { kind: 'builtin', locator: 'host-check-policy' }, reasonCode: 'mandatory_host_checks' },
        ...(ownerGates ? [{ field: 'gates' as const, source: { kind: 'project' as const, locator: '.bflow/verification.json' as const }, reasonCode: 'owner_verification_configuration' as const }] : []),
        { field: 'tdd', ...awaiting },
        { field: 'alternativeVerification', ...awaiting },
        { field: 'approvalPoints', source: { kind: 'project', locator: 'environment.sdd.approvalRequired' }, reasonCode: 'project_governance_policy', required: approvalRequired }
    ];
}
export async function loadExecutionPreview(cwd: string, runId?: string) {
    const repository = await identifyRepository(cwd);
    // Validate regular-file config before the existing schema/identity reader.
    await readPreviewFile(join(repository.root, '.bflow/config.yml'));
    const config = await readEnvironmentConfig(repository);
    const current = await loadExecutionResolution({ repository, config, env: process.env });
    if (runId) {
        const runtime = await import('@bflow/runtime');
        const accepted = await runtime.readAcceptedExecutionPlanInput(repository.root, runId);
        if (accepted?.accepted && accepted.accepted.revision !== current.repository.revision)
            throw new Error('Accepted run revision does not match repository revision');
        if (!accepted?.accepted)
            throw new Error('Requested run has no accepted specification and workflow binding');
        const acceptedComponents = Object.fromEntries(Object.entries(accepted.components)
            .filter(([key]) => ['acceptedSpecification', 'acceptedWorkflow', 'acceptedStrategy'].includes(key)));
        const sameBindings = ['configuration', 'skills', 'profiles', 'toolPolicy', 'ownerVerification']
            .every(key => accepted.components[key] === current.components[key]);
        const decisions = sameBindings ? current.decisions.map(decision => decision.field.startsWith('skills.')
            ? accepted.decisions.find(previous => previous.field === decision.field) ?? decision : decision) : current.decisions;
        return buildExecutionPlan({ ...current, decisions, mode: 'accepted', accepted: accepted.accepted,
            components: { ...current.components, ...acceptedComponents }, repository: current.repository,
            unknowns: current.unknowns.filter(item => !['specification_unresolved', 'accepted_workflow_unresolved', 'task_dag_unresolved'].includes(item)).concat(accepted.unknowns), policy: accepted.policy });
    }
    return buildExecutionPlan(current);
}
/** Private host declarations: watched bytes/digests never appear in public preview output. */
export async function loadHostExecutionResolution(input: EnvironmentCompositionInput, actualPlatform?: AgenticHostPlatformOptions) {
    // A fallback-derived config is checked through the disk config it was derived from.
    const source = input.sourceConfig ?? input.config;
    const current = await readEnvironmentConfig(input.repository);
    if (canonicalPlanDigest(current) !== canonicalPlanDigest(source))
        throw new Error('Execution configuration changed before resolution');
    const resolved = await resolvePlatformConfiguration(input);
    const catalog = await loadMachineSkillCatalog(resolved.input);
    const host = defaultHostEnvironment();
    const environment = { ...host.env, ...input.env };
    let platform = detectPlatform({ ...host, env: environment });
    if (environment.BFLOW_HOME)
        platform = isolatedPlatformProfile(platform, resolve(environment.BFLOW_HOME));
    const files: {
        component: string;
        path: string;
        format: 'json' | 'bytes';
        optional: boolean;
        expectedDigest?: string;
    }[] = [];
    const add = (component: string, path: string, optional = false) => files.push({ component, path, format: path.endsWith('.json') ? 'json' : 'bytes', optional });
    add('configuration', join(input.repository.root, '.bflow/config.yml'));
    add('owner-verification', join(input.repository.root, '.bflow/verification.json'), true);
    for (const path of catalog.sourceFiles)
        add('skills', path);
    const config = resolved.input.config.environment;
    if (config.skills?.bindingsPath)
        add('skill-bindings', resolve(input.repository.root, config.skills.bindingsPath));
    if (config.workflowPack)
        add('workflow-pack', resolve(input.repository.root, config.workflowPack.path));
    add('machine-tools', join(platform.paths.config, 'machine.json'), true);
    add('skill-approvals', join(platform.paths.state, 'skill-approvals.json'), true);
    for (const role of configuredPlatformRoles(resolved.input)) {
        const profile = selectedProfileName(role, config);
        if (!profile || !/^[A-Za-z0-9._-]+$/.test(profile))
            continue;
        const profileRoot = join(resolveIsolatorStateRoot(environment, host.homeDir), 'profiles', `${role.cli}--${profile}`);
        add('native-profile', join(profileRoot, 'profile.env'));
        for (const path of ['home/.codex/config.toml', 'home/.claude/settings.json', 'codex-backend.mode', 'codex-lb.url'])
            add('native-profile-settings', join(profileRoot, path), true);
    }
    const unique = [...new Map(files.map(file => [file.path, file])).values()]
        .map((file, index) => ({ ...file, component: `${file.component}-${index}` }));
    const digest = async (file: typeof files[number]) => {
        try {
            const text = await readPreviewFile(file.path);
            return file.format === 'json' ? canonicalPlanDigest(JSON.parse(text)) : createHash('sha256').update(text).digest('hex');
        }
        catch (error) {
            if (file.optional && (error as NodeJS.ErrnoException).code === 'ENOENT')
                return canonicalPlanDigest({ missing: true });
            throw error;
        }
    };
    for (const file of unique)
        file.expectedDigest = await digest(file);
    const plan = await loadExecutionResolution(input, actualPlatform);
    const after = await readEnvironmentConfig(input.repository);
    if (canonicalPlanDigest(after) !== canonicalPlanDigest(source))
        throw new Error('Execution configuration changed during resolution');
    for (const file of unique)
        if (file.expectedDigest !== await digest(file))
            throw new Error('Execution input changed during resolution');
    return { schemaVersion: 3 as const, repositoryRoot: input.repository.root, plan, files: unique };
}
