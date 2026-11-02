import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWebConfiguration } from '../src/web-config-git.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('commits only reviewed configuration when the repository ignores .bflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-ignored-config-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Web configuration test'); git('config', 'user.email', 'web-config@localhost');
  await writeFile(join(root, '.gitignore'), '.bflow/\n');
  git('add', '.gitignore'); git('commit', '-qm', 'baseline');
  await mkdir(join(root, '.bflow'));
  await writeFile(join(root, '.bflow/config.yml'), 'projectName: reviewed\n');
  await writeFile(join(root, '.bflow/.gitignore'), 'state/\n');
  await writeFile(join(root, '.bflow/private-token'), 'must stay ignored');
  expect(await commitWebConfiguration(root)).toContain('Đã commit cấu hình Bflow:');
  expect(git('show', '--pretty=format:', '--name-only', 'HEAD').split('\n').sort()).toEqual(['.bflow/.gitignore', '.bflow/config.yml']);
  expect(git('show', 'HEAD:.bflow/config.yml')).toBe('projectName: reviewed');
  const head = git('rev-parse', 'HEAD');
  expect(await commitWebConfiguration(root)).toContain('không cần commit mới');
  expect(git('rev-parse', 'HEAD')).toBe(head);
});
