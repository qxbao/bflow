import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createExecutionResolutionReader, readExecutionRepositorySnapshot } from '../../src/agentic/execution-binding.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_EMAIL: 'test@example.test' }
  }).trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bflow-repository-snapshot-')); roots.push(root);
  git(root, 'init', '-b', 'main'); await writeFile(join(root, 'source.ts'), 'export const value=1;\n');
  git(root, 'add', 'source.ts'); git(root, 'commit', '-m', 'baseline');
  const repository = await readExecutionRepositorySnapshot(root);
  return { root, repository, sources: { schemaVersion: 3, repositoryRoot: root,
    plan: { schemaVersion: 3, resolverVersion: '1', policyVersion: '1', mode: 'intake', repository }, files: [] } };
}
it.each(['head', 'index', 'dirty', 'untracked'] as const)('fences %s drift using real repository state before the next effect', async change => {
  const { root, repository, sources } = await fixture();
  const read = await createExecutionResolutionReader(sources); await read();
  if (change === 'head') git(root, 'commit', '--allow-empty', '-m', 'new revision');
  else if (change === 'untracked') await writeFile(join(root, 'new.ts'), 'export const newValue=1;\n');
  else {
    await writeFile(join(root, 'source.ts'), 'export const value=2;\n');
    if (change === 'index') { git(root, 'add', 'source.ts'); await writeFile(join(root, 'source.ts'), 'export const value=1;\n'); }
  }
  expect(await readExecutionRepositorySnapshot(root)).not.toEqual(repository);
  const launch = vi.fn(); await expect(read().then(launch)).rejects.toMatchObject({ code: 'execution_plan_drift' }); expect(launch).not.toHaveBeenCalled();
  await expect(createExecutionResolutionReader(sources)).rejects.toMatchObject({ code: 'execution_plan_drift' });
});
it('leaves index/worktree untouched, ignores credential files and refuses unsafe source files', async () => {
  const { root, repository } = await fixture(); const index = join(root, '.git', 'index');
  const before = await readFile(index), names = await readdir(root);
  expect(await readExecutionRepositorySnapshot(root)).toEqual(repository); expect(await readFile(index)).toEqual(before); expect(await readdir(root)).toEqual(names);
  await writeFile(join(root, '.env'), 'TOKEN=canary');
  expect(await readExecutionRepositorySnapshot(root)).toEqual(repository);
});

it('tracks executable mode changes even when a file was already dirty', async () => {
  const { root } = await fixture(); const path = join(root, 'source.ts');
  await writeFile(path, 'already dirty\n'); const before = await readExecutionRepositorySnapshot(root);
  await chmod(path, 0o755); expect(await readExecutionRepositorySnapshot(root)).not.toEqual(before);
});
