// Run from the built Bflow checkout; target must already have `bflow init` output.
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WorkflowDefinitionSchema } from '../../packages/contracts/dist/index.js';
import { identifyRepository } from '../../apps/cli/dist/repository.js';
import { readEnvironmentConfig } from '../../apps/cli/dist/environment-config.js';

const [target, kind = 'feature', ...extra] = process.argv.slice(2);
if (!target || extra.length || !['feature', 'bugfix', 'refactor', 'docs'].includes(kind)) {
  throw new Error('Usage: node templates/node-typescript/apply.mjs <repository> [feature|bugfix|refactor|docs]');
}
const repository = await identifyRepository(resolve(target));
await readEnvironmentConfig(repository); // Includes checkout identity validation.
const stateExists = await access(resolve(repository.root, '.bflow/state')).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
if (stateExists) throw new Error('Apply templates before the first bflow up; existing lifecycle state requires operator review.');
const directory = fileURLToPath(new URL('.', import.meta.url));
const fragment = JSON.parse(await readFile(resolve(directory, 'config.fragment.json'), 'utf8'));
const workflow = WorkflowDefinitionSchema.parse(JSON.parse(await readFile(resolve(directory, `workflows/${kind}.json`), 'utf8')));
const path = resolve(repository.root, '.bflow/config.yaml');
const original = await readFile(path, 'utf8');
const current = JSON.parse(original);
// Keep runtime/storage fields and all three checkout identity fields from init.
const next = { ...current, defaultWorkflow: workflow,
  environment: { ...current.environment, ...fragment.environment } };
const backupDirectory = resolve(repository.root, '.bflow/data');
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const backup = resolve(backupDirectory, `config-before-template-${randomUUID()}.json`);
await writeFile(backup, original, { mode: 0o600, flag: 'wx' });
const temporary = `${path}.${randomUUID()}.tmp`;
await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await rename(temporary, path);
await readEnvironmentConfig(repository);
console.log(`Applied ${kind} seed to ${path}; backup: ${backup}`);
console.log('P19 host registration, independent runners and authentication are still required.');
