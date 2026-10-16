// Validates documentation assets against the built implementation in disposable repositories.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRoleSchema, RoleMessageSchema, WorkflowDefinitionSchema } from '../../packages/contracts/dist/index.js';
import { SpecificationDocumentSchema, ChangeAssessmentSchema, classifyChange } from '../../packages/specification/dist/index.js';
import { TestStrategyResolver, AssessmentSchema } from '../../packages/test-strategy/dist/index.js';
import { TOPOLOGY_ROLES, resolveTopologyRole, isSupportedAgentKind } from '../../packages/pane-manager/dist/index.js';
import { identifyRepository } from '../../apps/cli/dist/repository.js';
import { readEnvironmentConfig } from '../../apps/cli/dist/environment-config.js';
import { loadWorkflowDefinitionFromFile } from '../../apps/cli/dist/config.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = fileURLToPath(new URL('.', import.meta.url));
const json = async path => JSON.parse(await readFile(join(directory, path), 'utf8'));
const roles = await json('roles.host.json');
assert.deepEqual(Object.keys(roles.roleConfigs).sort(), [...TOPOLOGY_ROLES].sort());
for (const [role, config] of Object.entries(roles.roleConfigs)) {
  assert.equal(resolveTopologyRole(role), role);
  assert.ok(isSupportedAgentKind(config.agentKind));
}
assert.ok(!roles.permanentRoles.includes('developer'));
const fragment = await json('config.fragment.json');
for (const { role } of fragment.environment.roles) AgentRoleSchema.parse(role);
for (const key of ['repositoryId', 'workspaceRoot', 'sessionName']) assert.equal(fragment.environment[key], undefined);
const resolver = new TestStrategyResolver();
const expected = { feature: ['full', 'required'], bugfix: ['lightweight', 'required'], refactor: ['lightweight', 'recommended'], docs: ['lightweight', 'not_applicable'] };
for (const [kind, [level, mode]] of Object.entries(expected)) {
  const workflow = WorkflowDefinitionSchema.parse(await json(`workflows/${kind}.json`));
  const loaded = await loadWorkflowDefinitionFromFile(join(directory, `workflows/${kind}.json`));
  assert.ok(loaded.ok);
  const spec = SpecificationDocumentSchema.parse(await json(`specifications/${kind}.spec.json`));
  const assessment = ChangeAssessmentSchema.parse(await json(`sdd/${kind}.assessment.json`));
  assert.equal(classifyChange(assessment, spec.affectedPaths).level, level);
  AssessmentSchema.parse(spec.metadata.conditionalTdd);
  resolver.validateAgainstSpecification(spec.testStrategy, spec);
  assert.equal(spec.tddDecision.mode, mode);
  assert.ok(workflow.tasks.every(task => task.role === 'developer' && task.requiresApproval));
  assert.deepEqual(workflow.tasks[0].acceptanceCriteria, spec.acceptanceCriteria.map(c => c.id));
  assert.deepEqual(workflow.tasks[0].metadata.ownedPaths, spec.affectedPaths);
  console.log(`PASS ${kind}: WorkflowDefinition + P15 Specification + P16 ${mode} (${level})`);
}
RoleMessageSchema.parse(await json('messages/task-status.json'));
assert.equal(RoleMessageSchema.safeParse({ ...(await json('messages/task-status.json')), schema_version: 1 }).success, false);
console.log('PASS eight role configurations and RoleMessage ingress/invalid-version rejection');

const temporary = await mkdtemp(join(tmpdir(), 'bflow-dx-'));
const cli = join(root, 'apps/cli/dist/bin.js');
const call = (cwd, args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], { cwd, encoding: 'utf8' }));
try {
  const a = join(temporary, 'a', 'shop');
  const b = join(temporary, 'b', 'shop');
  for (const cwd of [a, b]) {
    await mkdir(cwd, { recursive: true });
    execFileSync('git', ['init', '-q', cwd]);
    call(cwd, ['init', '--name', 'portable-node']);
  }
  const identityA = await identifyRepository(a), identityB = await identifyRepository(b);
  const configA = await readEnvironmentConfig(identityA), configB = await readEnvironmentConfig(identityB);
  assert.notEqual(configA.environment.sessionName, configB.environment.sessionName);
  const path = join(a, '.bflow/config.yaml');
  const original = await readFile(path, 'utf8');
  const nested = join(a, 'src'); await mkdir(nested);
  call(nested, ['init', '--name', 'ignored-on-repeat']);
  assert.equal(await readFile(path, 'utf8'), original);
  execFileSync(process.execPath, [join(directory, 'apply.mjs'), a, 'bugfix']);
  const applied = await readEnvironmentConfig(identityA);
  for (const field of ['repositoryId', 'workspaceRoot', 'sessionName']) assert.equal(applied.environment[field], configA.environment[field]);
  assert.deepEqual(applied.storage, configA.storage);
  assert.equal(applied.runtimeId, configA.runtimeId);
  assert.equal(applied.defaultWorkflow.id, 'portable-bugfix');
  const bPath = join(b, '.bflow/config.yaml');
  const bOriginal = await readFile(bPath, 'utf8');
  await writeFile(bPath, await readFile(path));
  await assert.rejects(readEnvironmentConfig(identityB), /another repository/);
  await writeFile(bPath, 'environment:\n  herdrBinary: herdr\n');
  await assert.rejects(readEnvironmentConfig(identityB), /invalid JSON/);
  await writeFile(bPath, bOriginal);
  // Regression probe for a mismatch between current help text and actual CLI behavior.
  call(a, ['init', '--force', '--name', 'force-replaces-config']);
  assert.equal((await readEnvironmentConfig(identityA)).projectName, 'force-replaces-config');
  await mkdir(join(b, '.bflow/state'));
  assert.throws(() => execFileSync(process.execPath, [join(directory, 'apply.mjs'), b], { stdio: 'pipe' }));
  assert.equal(await readFile(bPath, 'utf8'), bOriginal);
  console.log('PASS CLI init/repeat/subdirectory, template application, identity isolation, moved config/YAML rejection, --force overwrite and existing-state guard');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log('PASS documentation assets; no live AI delivery or authenticated approval claimed');
