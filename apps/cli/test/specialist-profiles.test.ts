import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createExecutionResolutionReader, workflowPackDigest, resolveRoleProfile } from '@bflow/runtime';
import { pinRoleProfile } from '@bflow/contracts';
import { EnvironmentConfigEnvironmentSchema, EnvironmentRoleConfigSchema, initializeEnvironmentConfig, readEnvironmentConfig } from '../src/environment-config.js';
import { identifyRepository } from '../src/repository.js';
import { renderEnvironmentConfigYaml } from '../src/config-format.js';
import { resolvePlatformConfiguration } from '../src/platform-resolution.js';
import { loadExecutionPreview, loadHostExecutionResolution, loadExecutionResolution } from '../src/execution-preview.js';
import { buildHostPlatformOptions } from '../src/platform-options.js';
import { loadMachineSkillCatalog } from '../src/skill-catalog.js';
import { prepareExecutionExpectation } from '../src/execution-expectation.js';

const definition = { schemaVersion: 3 as const, profileId: 'backend-developer', version: '1.0.0', displayName: 'Backend developer',
  baseRole: 'developer' as const, additionalInstructions: 'private-profile-instruction-canary', skillPins: [], toolRequirements: [], restrictions: {} };
const pin = pinRoleProfile(definition);
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp('/tmp/cli-specialist-')); execFileSync('git', ['init', '--quiet', root]);
  await initializeEnvironmentConfig({ cwd: root }); vi.stubEnv('BFLOW_HOME', join(root, 'machine')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const repository = await identifyRepository(root); const config = await readEnvironmentConfig(repository);
  await mkdir(join(root, '.bflow/profiles'), { recursive: true });
  await writeFile(join(root, '.bflow/profiles/backend.json'), JSON.stringify(definition));
  Object.assign(config.environment, { specialistProfiles: [{ path: '.bflow/profiles/backend.json', pin }] });
  Object.assign(config.environment.roles.find(role => role.role === 'developer')!, { specialistProfile: pin });
  return { repository, config, env: process.env };
}
it('accepts exact specialist pins separately from native profile-name and rejects governance replacement', async () => {
  const input = await fixture();
  expect(EnvironmentConfigEnvironmentSchema.safeParse(input.config.environment).success).toBe(true);
  expect(EnvironmentRoleConfigSchema.safeParse({ role: 'developer', cli: 'codex', 'profile-name': 'native', specialistProfile: pin }).success).toBe(true);
  expect(EnvironmentRoleConfigSchema.safeParse({ role: 'conversation', cli: 'codex', specialistProfile: pin }).success).toBe(false);
  expect(EnvironmentRoleConfigSchema.safeParse({ role: 'developer', cli: 'codex', specialistProfile: { ...pin, extra: true } }).success).toBe(false);
});
it('resolves catalog snapshots and identical selected pins into actual host options and safe preview', async () => {
  const input = await fixture(); await writeFile(join(root, '.bflow/config.yml'), renderEnvironmentConfigYaml(input.config));
  const resolution = await resolvePlatformConfiguration(input);
  expect(resolution.roleProfiles?.[0]).toMatchObject({ pin, definition });
  const skills = await loadMachineSkillCatalog(input);
  const options = await buildHostPlatformOptions(input, { context: { machineId: 'm-test', stateDirectory: join(root, 'state'), dataDirectory: join(root, 'data'),
    codexHomeDirectory: join(root, 'codex'), codexProcessHomeDirectory: root, codexHookApprovalPath: join(root, 'hooks.json'), skills }, fileExists: () => false });
  expect(options).toMatchObject({ roleProfiles: [{ pin, definition }], roles: expect.arrayContaining([expect.objectContaining({ role: 'developer', specialistProfile: pin })]) });
  const preview = await loadExecutionPreview(root);
  expect(preview.decisions).toContainEqual(expect.objectContaining({ field: 'roles.developer.specialistProfile', effective: pin }));
  expect(JSON.stringify(preview)).not.toContain(definition.additionalInstructions);
  const actual = await loadExecutionResolution(input, options);
  expect(actual.components.profiles).toBe(preview.components.profiles);
  expect(actual.decisions.find(item => item.field === 'roles.developer.specialistProfile')).toEqual(preview.decisions.find(item => item.field === 'roles.developer.specialistProfile'));
  const declaration = await loadHostExecutionResolution(input);
  expect(declaration.files).toContainEqual(expect.objectContaining({ path: join(root, '.bflow/profiles/backend.json'), format: 'bytes', optional: false }));
});
it.each(['digest', 'duplicate', 'escape', 'symlink', 'parent-symlink', 'fifo', 'oversized', 'role-mismatch', 'missing-selection'] as const)('rejects unsafe or conflicting profile input: %s', async kind => {
  const input = await fixture(); const env = input.config.environment as typeof input.config.environment & { specialistProfiles: { path: string; pin: typeof pin }[] };
  if (kind === 'digest') await writeFile(join(root, '.bflow/profiles/backend.json'), JSON.stringify({ ...definition, additionalInstructions: 'changed' }));
  if (kind === 'duplicate') env.specialistProfiles.push(env.specialistProfiles[0]!);
  if (kind === 'escape') env.specialistProfiles[0]!.path = '../outside.json';
  if (kind === 'symlink') { await symlink('backend.json', join(root, '.bflow/profiles/link.json')); env.specialistProfiles[0]!.path = '.bflow/profiles/link.json'; }
  if (kind === 'parent-symlink') { await symlink('profiles', join(root, '.bflow/linked')); env.specialistProfiles[0]!.path = '.bflow/linked/backend.json'; }
  if (kind === 'fifo') { execFileSync('mkfifo', [join(root, '.bflow/profiles/pipe')]); env.specialistProfiles[0]!.path = '.bflow/profiles/pipe'; }
  if (kind === 'oversized') await writeFile(join(root, '.bflow/profiles/backend.json'), ' '.repeat(262145));
  if (kind === 'role-mismatch') Object.assign(input.config.environment.roles.find(role => role.role === 'qa')!, { specialistProfile: pin });
  if (kind === 'missing-selection') env.specialistProfiles = [];
  await expect(resolvePlatformConfiguration(input)).rejects.toThrow();
});
it('retains EP-01 byte drift rejection even for an identical normalized profile snapshot', async () => {
  const input = await fixture(); await writeFile(join(root, '.bflow/config.yml'), renderEnvironmentConfigYaml(input.config));
  const declaration = await loadHostExecutionResolution(input);
  const read = await createExecutionResolutionReader(declaration); await read();
  await writeFile(join(root, '.bflow/profiles/backend.json'), JSON.stringify(definition, null, 2));
  await expect(read()).rejects.toThrow();
});
it('blocks a saved expectation when profile restrictions and accepted selection change', async () => {
  const input = await fixture(); await writeFile(join(root, '.bflow/config.yml'), renderEnvironmentConfigYaml(input.config));
  const plan = await loadExecutionPreview(root); await writeFile(join(root, '.bflow/prior.json'), JSON.stringify(plan));
  const check = await prepareExecutionExpectation(root, '.bflow/prior.json');
  const changed = { ...definition, version: '1.0.1', restrictions: { writablePaths: ['test'] } };
  const selected = pinRoleProfile(changed);
  input.config.environment.specialistProfiles![0]!.pin = selected;
  input.config.environment.roles.find(role => role.role === 'developer')!.specialistProfile = selected;
  await writeFile(join(root, '.bflow/profiles/backend.json'), JSON.stringify(changed));
  await writeFile(join(root, '.bflow/config.yml'), renderEnvironmentConfigYaml(input.config));
  await expect(check()).rejects.toMatchObject({ contractError: { details: { reason: 'execution_plan_drift' } } });
});
it('the built binary exposes safe specialist identity without profile instruction bytes', async () => {
  const input = await fixture(); await writeFile(join(root, '.bflow/config.yml'), renderEnvironmentConfigYaml(input.config));
  const output = spawnSync(process.execPath, [resolve('apps/cli/dist/bin.js'), 'task', 'preview', '--json'], { cwd: root, env: process.env, encoding: 'utf8' });
  expect(output.status, output.stdout + output.stderr).toBe(0);
  const plan = JSON.parse(output.stdout).result.output.data.plan;
  expect(plan.decisions).toContainEqual(expect.objectContaining({ field: 'roles.developer.specialistProfile', effective: pin }));
  expect(output.stdout + output.stderr).not.toContain(definition.additionalInstructions);
});
it('previews pure policy rejection for unsupported read restrictions without a native probe', async () => {
  const input = await fixture();
  const restricted = { ...definition, restrictions: { readablePaths: ['src'] } }; const selected = pinRoleProfile(restricted);
  input.config.environment.specialistProfiles![0]!.pin = selected;
  input.config.environment.roles.find(role => role.role === 'developer')!.specialistProfile = selected;
  await writeFile(join(root, '.bflow/profiles/backend.json'), JSON.stringify(restricted));
  await writeFile(join(root, '.bflow/config.yml'), renderEnvironmentConfigYaml(input.config));
  const preview = await loadExecutionPreview(root);
  expect(preview.blockers).toContainEqual(expect.objectContaining({ code: 'specialist_profile_policy_unavailable', decisionIds: ['roles.developer.specialistProfile'] }));
  expect(preview.observations).toContainEqual(expect.objectContaining({ id: 'provider.developer.readiness', status: 'not_checked' }));
});
it('uses profile model preferences over unlocked role defaults in preview and actual launch policy', async () => {
  const input = await fixture();
  const preferred = { ...definition, preferences: { model: 'specialist-model' } }; const selected = pinRoleProfile(preferred);
  input.config.environment.specialistProfiles![0]!.pin = selected;
  const role = input.config.environment.roles.find(role => role.role === 'developer')!; role.specialistProfile = selected;
  await writeFile(join(root, '.bflow/profiles/backend.json'), JSON.stringify(preferred));
  await writeFile(join(root, '.bflow/config.yml'), renderEnvironmentConfigYaml(input.config));
  expect((await loadExecutionPreview(root)).decisions).toContainEqual(expect.objectContaining({ field: 'roles.developer.model', effective: 'specialist-model', source: { kind: 'policy', locator: 'environment.specialistProfiles' } }));
  role.model = 'explicit-model'; await writeFile(join(root, '.bflow/config.yml'), renderEnvironmentConfigYaml(input.config));
  const conflict = await loadExecutionPreview(root);
  expect(conflict.decisions).toContainEqual(expect.objectContaining({ field: 'roles.developer.model', effective: 'specialist-model', source: { kind: 'policy', locator: 'environment.specialistProfiles' } }));
  expect(conflict.blockers.some(item => item.code === 'specialist_profile_policy_unavailable')).toBe(false);
});
it.each([false, true])('preserves model/effort pack locks through host options and actual policy: locked=%s', async locked => {
  const input = await fixture();
  const preferred = { ...definition, preferences: { model: 'specialist-model', effort: 'high' as const } };
  const selected = pinRoleProfile(preferred);
  input.config.environment.specialistProfiles![0]!.pin = selected;
  const role = input.config.environment.roles.find(role => role.role === 'developer')!;
  Object.assign(role, { cli: 'codex', model: 'base-model', effort: 'low', specialistProfile: selected });
  await writeFile(join(root, '.bflow/profiles/backend.json'), JSON.stringify(preferred));
  const pack = { schemaVersion: 3 as const, id: 'model-pack', version: '1.0.0', digest: '0'.repeat(64),
    defaults: { 'roles.developer.model': 'pack-model', 'roles.developer.effort': 'medium' },
    lockedFields: locked ? ['roles.developer.model', 'roles.developer.effort'] : [] };
  pack.digest = workflowPackDigest(pack);
  await writeFile(join(root, '.bflow/pack.json'), JSON.stringify(pack));
  input.config.environment.workflowPack = { path: '.bflow/pack.json', id: pack.id, version: pack.version, digest: pack.digest };
  await writeFile(join(root, '.bflow/config.yml'), renderEnvironmentConfigYaml(input.config));
  const skills = await loadMachineSkillCatalog(input);
  const options = await buildHostPlatformOptions(input, { context: { machineId: 'm-test', stateDirectory: join(root, 'state'), dataDirectory: join(root, 'data'),
    codexHomeDirectory: join(root, 'codex'), codexProcessHomeDirectory: root, codexHookApprovalPath: join(root, 'hooks.json'), skills }, fileExists: () => false });
  const configured = options.roles.find(role => role.role === 'developer')!;
  expect(configured.preferenceConstraints).toEqual(locked ? { model: 'pack-model', effort: 'medium' } : undefined);
  const snapshot = options.roleProfiles![0]!;
  const requirement = { ...configured, cwd: root };
  if (locked) expect(() => resolveRoleProfile(snapshot, requirement)).toThrow(/model.*pack/i);
  else expect(resolveRoleProfile(snapshot, requirement)).toMatchObject({ model: 'specialist-model', effort: 'high' });
  const preview = await loadExecutionPreview(root);
  const actual = await loadExecutionResolution(input, options);
  for (const plan of [preview, actual]) {
    expect(plan.blockers.some(item => item.code === 'specialist_profile_policy_unavailable')).toBe(locked);
    if (!locked) expect(plan.decisions).toContainEqual(expect.objectContaining({ field: 'roles.developer.model', effective: 'specialist-model' }));
    else expect(plan.decisions).toContainEqual(expect.objectContaining({ field: 'roles.developer.model', effective: 'pack-model', rule: { kind: 'pack', locator: 'pack' } }));
  }
  expect(actual.decisions).toEqual(preview.decisions);
});
it('honors pack locks when selecting a compatible profile without mutating project pins', async () => {
  const input = await fixture();
  const alternate = { ...definition, profileId: 'data-engineer', displayName: 'Data engineer' }; const alternatePin = pinRoleProfile(alternate);
  await writeFile(join(root, '.bflow/profiles/data.json'), JSON.stringify(alternate));
  input.config.environment.specialistProfiles!.push({ path: '.bflow/profiles/data.json', pin: alternatePin });
  const pack = { schemaVersion: 3 as const, id: 'specialist-pack', version: '1.0.0', digest: '0'.repeat(64), defaults: { 'roles.developer.specialistProfile': alternatePin }, lockedFields: ['roles.developer.specialistProfile'] };
  pack.digest = workflowPackDigest(pack); await writeFile(join(root, '.bflow/pack.json'), JSON.stringify(pack));
  input.config.environment.workflowPack = { path: '.bflow/pack.json', id: pack.id, version: pack.version, digest: pack.digest };
  const resolved = await resolvePlatformConfiguration(input);
  expect(resolved.input.config.environment.roles.find(role => role.role === 'developer')!.specialistProfile).toEqual(alternatePin);
  expect(input.config.environment.roles.find(role => role.role === 'developer')!.specialistProfile).toEqual(pin);
  expect(resolved.decisions.find(item => item.field === 'roles.developer.specialistProfile')).toMatchObject({ effective: alternatePin, source: { kind: 'pack' } });
});
it.each(['pin', 'missing-role', 'catalog'] as const)('rejects an actual launch selection that differs from preview: %s', async mutation => {
  const input = await fixture(); const skills = await loadMachineSkillCatalog(input);
  const options = await buildHostPlatformOptions(input, { context: { machineId: 'm-test', stateDirectory: join(root, 'state'), dataDirectory: join(root, 'data'),
    codexHomeDirectory: join(root, 'codex'), codexProcessHomeDirectory: root, codexHookApprovalPath: join(root, 'hooks.json'), skills }, fileExists: () => false });
  if (mutation === 'pin') options.roles.find(role => role.role === 'developer')!.specialistProfile = { ...pin, digest: 'f'.repeat(64) };
  if (mutation === 'missing-role') options.roles = options.roles.filter(role => role.role !== 'developer');
  if (mutation === 'catalog') options.roleProfiles = [];
  const actual = await loadExecutionResolution(input, options);
  expect(actual.blockers).toContainEqual(expect.objectContaining({ code: 'specialist_profile_policy_unavailable' }));
});
