import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fileSyncFailureTargets = new Map<string, string>();
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const targetPath = String(args[0]);
      for (const [prefix, code] of fileSyncFailureTargets) {
        // Trigger on regular file writes (`wx` / `O_CREAT`), not only directory `r` opens
        if (targetPath.startsWith(prefix) && args[1] !== 'r') {
          return new Proxy(handle, {
            get(target, prop, receiver) {
              if (prop === 'sync') {
                return async () => {
                  throw Object.assign(new Error(`${code}: file fsync unsupported on FUSE/NTFS`), { code });
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            }
          });
        }
      }
      return handle;
    }) as typeof actual.open
  };
});

import { interactionProjectId } from '@bflow/runtime';
import { initializeEnvironmentConfig } from '../src/environment-config.js';
import { startWebCommand } from '../src/web-command.js';
import { commitWebConfiguration } from '../src/web-config-git.js';
import { createWebProjectSettings } from '../src/web-project-settings.js';
import { createWebWorkspaceServices } from '../src/web-workspace-services.js';

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  fileSyncFailureTargets.clear();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function makeRepo(configureIdentity = true) {
  const root = await fs.mkdtemp(join(tmpdir(), 'round2-slice04-cli-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  if (configureIdentity) {
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Bflow Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@bflow.local']);
  }
  await initializeEnvironmentConfig({ cwd: root });
  return {
    root,
    project: {
      apiVersion: 1 as const,
      projectId: interactionProjectId(root),
      canonicalPath: root,
      displayName: 'repo',
      registrationState: 'registered' as const
    }
  };
}

describe('Round 2 Slice 4 — CLI Web Git & FUSE file-sync hardening', () => {
  it('passes safe.directory to git in commitWebConfiguration, commits cleanly on unborn HEAD, and handles no-op staged diffs after git add --force without failing git commit', async () => {
    const { root } = await makeRepo(true);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const binDir = await fs.mkdtemp(join(tmpdir(), 'round2-slice04-gitbin-'));
    roots.push(binDir);

    // Wrapper git binary simulating NTFS/FUSE root-owned checkout that rejects commands lacking `-c safe.directory=<root>`,
    // and simulating stat-dirty porcelain status on a clean index after the initial commit.
    const flagFile = join(binDir, 'simulate-stat-dirty');
    const wrapperPath = join(binDir, 'git');
    await fs.writeFile(
      wrapperPath,
      `#!/usr/bin/env bash
if [[ "$*" != *"safe.directory="* ]]; then
  echo "fatal: detected dubious ownership in repository at '${root}'" >&2
  exit 128
fi
if [[ -f "${flagFile}" && "$*" == *"status --porcelain=v1"* ]]; then
  echo " M .bflow/config.yml"
  exit 0
fi
exec "${realGit}" "$@"
`,
      { mode: 0o755 }
    );
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    // 1. Unborn HEAD + dubious ownership mount -> succeeds because commitWebConfiguration passes `-c safe.directory=<canonicalRoot>`
    const firstMsg = await commitWebConfiguration(root);
    expect(firstMsg).toMatch(/^Đã commit cấu hình Bflow: [0-9a-f]{7,40}$/);

    // 2. Stat-dirty NTFS/FUSE file where `git status --porcelain=v1` reports modified, but `git add --force` produces zero staged diff
    await fs.writeFile(flagFile, '1');
    const secondMsg = await commitWebConfiguration(root);
    expect(secondMsg).toBe('Cấu hình Bflow đã có trong Git; không cần commit mới.');

    // 3. Unrelated staged user file is still protected before touching the index
    await fs.rm(flagFile, { force: true });
    await fs.writeFile(join(root, 'unrelated.txt'), 'user work');
    execFileSync(realGit, ['-C', root, 'add', 'unrelated.txt']);
    await expect(commitWebConfiguration(root)).rejects.toThrow(/Git index có file khác đang staged/);
  });

  it('tolerates EOPNOTSUPP/ENOSYS on regular file handle.sync() across web-project-settings, web-workspace-services, and web-command locator writes', async () => {
    const { root, project } = await makeRepo(true);
    const receiptDirectory = join(root, 'receipts');
    const webStateDirectory = join(root, 'web-state');
    const assetsDirectory = join(root, 'web-assets');
    await fs.mkdir(join(assetsDirectory, 'assets'), { recursive: true });
    await fs.writeFile(join(assetsDirectory, 'assets', 'app.js'), 'console.log("ok");');
    await fs.writeFile(
      join(assetsDirectory, 'index.html'),
      '<!doctype html><html><body><script type="module" src="/assets/app.js"></script></body></html>'
    );

    fileSyncFailureTargets.set(join(root, '.bflow', 'config.yml'), 'EOPNOTSUPP');
    fileSyncFailureTargets.set(receiptDirectory, 'EOPNOTSUPP');
    fileSyncFailureTargets.set(join(webStateDirectory, 'instance.json'), 'ENOSYS');
    fileSyncFailureTargets.set(join(webStateDirectory, 'server'), 'ENOSYS');

    // 1. web-project-settings saveConfiguration + initializeProject on FUSE file handle.sync()
    const settings = createWebProjectSettings({
      resolveProject: async () => ({
        ...project,
        projectId: 'project-' + createHash('sha256').update(root).digest('hex').slice(0, 32)
      }),
      receiptDirectory,
      prepareGitNexus: async () => ({ status: 'ready', diagnostics: ['GitNexus FUSE ok'] })
    });
    const before = await settings.readConfiguration(project.projectId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const saved = await settings.saveConfiguration(project.projectId, {
      apiVersion: 1,
      expectedRevision: before.value.revision,
      yaml: before.value.yaml.replace('maxConcurrency: 2', 'maxConcurrency: 3')
    });
    expect(saved).toMatchObject({ ok: true });

    const initOpId = randomUUID();
    const initStarted = await settings.initializeProject(project.projectId, {
      apiVersion: 1,
      operationId: initOpId,
      acceptGitNexusLicense: false,
      skipGitNexus: true,
      update: false
    });
    expect(initStarted).toMatchObject({ ok: true, value: { state: 'running' } });
    await Promise.all(settings.pending());
    const initDone = await settings.readInitialization(project.projectId, initOpId);
    expect(initDone).toMatchObject({ ok: true, value: { state: 'succeeded' } });

    // 2. web-workspace-services startSession + stopSession receipt reservation & settlement on FUSE file handle.sync()
    const workspace = createWebWorkspaceServices({
      resolveProject: async () => project,
      receiptDirectory,
      createLifecycle: () => ({
        up: vi.fn(async () => ({})),
        down: vi.fn(async () => ({ status: 'down' as const })),
        doctor: vi.fn()
      }),
      readSession: async () => ({
        ok: true,
        value: {
          apiVersion: 1,
          projectId: project.projectId,
          sessionId: 'session-1',
          state: 'ready',
          pendingIntakes: [],
          blockers: [],
          updatedAt: new Date().toISOString()
        }
      })
    });
    const started = await workspace.startSession(project.projectId, randomUUID());
    expect(started).toMatchObject({ ok: true, value: { state: 'ready' } });

    // 3. web-command startWebCommand writeLocator on FUSE file handle.sync()
    const freePort = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        const port = typeof addr === 'object' && addr ? addr.port : 43199;
        probe.close(err => (err ? reject(err) : resolve(port)));
      });
    });
    const handle = await startWebCommand(
      { port: freePort, open: false },
      {
        stateDirectory: webStateDirectory,
        assetsDirectory,
        io: { stdout: () => {}, stderr: () => {} },
        isTerminal: true
      }
    );
    try {
      expect(handle.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
    } finally {
      await handle.close();
    }
  });
});
