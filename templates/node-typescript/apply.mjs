// Run from the built Bflow checkout; target must already have `bflow init` output.
import { readFile, writeFile, mkdir, rename, lstat, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WorkflowDefinitionSchema } from '../../packages/contracts/dist/index.js';
import { identifyRepository } from '../../apps/cli/dist/repository.js';
import { readEnvironmentConfig } from '../../apps/cli/dist/environment-config.js';
import { DEFAULT_CONFIG_RELATIVE_PATH, resolveReadableConfigPath } from '../../apps/cli/dist/config.js';
import { parseConfigYaml, renderEnvironmentConfigYaml } from '../../apps/cli/dist/config-format.js';

const [target, kind = 'feature', ...extra] = process.argv.slice(2);
if (!target || extra.length || !['feature', 'bugfix', 'refactor', 'docs'].includes(kind)) {
  throw new Error('Usage: node templates/node-typescript/apply.mjs <repository> [feature|bugfix|refactor|docs]');
}
const repository = await identifyRepository(resolve(target));
await readEnvironmentConfig(repository); // Includes checkout identity validation.
const path = resolveReadableConfigPath(repository.root);
const canonicalPath = resolve(repository.root, DEFAULT_CONFIG_RELATIVE_PATH);
if (path !== canonicalPath) throw new Error('Run `bflow config-migrate` before applying templates so the canonical config stays unambiguous.');
const stateExists = await lstat(resolve(repository.root, '.bflow/state')).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
if (stateExists) throw new Error('Apply templates before the first bflow up; existing lifecycle state requires operator review.');
const directory = fileURLToPath(new URL('.', import.meta.url));
const fragment = JSON.parse(await readFile(resolve(directory, 'config.fragment.json'), 'utf8'));
if (!fragment?.environment || typeof fragment.environment !== 'object' || Array.isArray(fragment.environment)) {
  throw new Error('Portable fragment must contain an environment object');
}
for (const key of ['repositoryId', 'workspaceRoot', 'sessionName']) {
  if (Object.hasOwn(fragment.environment, key)) throw new Error(`Portable fragment must not set checkout identity: ${key}`);
}
const workflow = WorkflowDefinitionSchema.parse(JSON.parse(await readFile(resolve(directory, `workflows/${kind}.json`), 'utf8')));
const original = await readFile(path, 'utf8');
const current = parseConfigYaml(original);
// Keep runtime/storage fields and all three checkout identity fields from init.
const next = { ...current, defaultWorkflow: workflow,
  environment: { ...current.environment, ...fragment.environment } };
// Reuse the actual environment loader before touching the target. The scratch
// checkout root is substituted only for its path identity check; all policies,
// roles, workflow and storage values are validated exactly as they will be read.
const validationRoot = await mkdtemp(join(tmpdir(), 'bflow-config-'));
try {
  await mkdir(join(validationRoot, '.bflow'), { mode: 0o700 });
  await writeFile(join(validationRoot, DEFAULT_CONFIG_RELATIVE_PATH), renderEnvironmentConfigYaml({
    ...next, environment: { ...next.environment, workspaceRoot: validationRoot }
  }), { mode: 0o600, flag: 'wx' });
  await readEnvironmentConfig({ ...repository, root: validationRoot });
} finally {
  await rm(validationRoot, { recursive: true, force: true });
}
const backupDirectory = resolve(repository.root, '.bflow/data');
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const backup = resolve(backupDirectory, `config-before-template-${randomUUID()}.yml`);
await writeFile(backup, original, { mode: 0o600, flag: 'wx' });
const temporary = `${path}.${randomUUID()}.tmp`;
try {
  await writeFile(temporary, renderEnvironmentConfigYaml(next), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
} finally {
  await rm(temporary, { force: true });
}
await readEnvironmentConfig(repository);
console.log(`Applied ${kind} seed to ${path}; backup: ${backup}`);
console.log('P19 host registration, independent runners and authentication are still required.');
