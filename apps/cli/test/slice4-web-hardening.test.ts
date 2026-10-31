import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fsyncEinvalTargets = new Set<string>();
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (fsyncEinvalTargets.has(String(args[0])) && args[1] === 'r') {
        return new Proxy(handle, {
          get(target, prop, receiver) {
            if (prop === 'sync') {
              return async () => {
                throw Object.assign(new Error('EINVAL: invalid argument, fsync'), { code: 'EINVAL' });
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
      return handle;
    }) as typeof actual.open
  };
});
import { interactionProjectId } from '@bflow/runtime';
import { initializeEnvironmentConfig } from '../src/environment-config.js';
import { createWebInteractionServices } from '../src/web-interaction.js';
import { createWebProjectSettings } from '../src/web-project-settings.js';
import { createWebWorkspaceServices } from '../src/web-workspace-services.js';

const roots: string[] = [];

afterEach(async () => {
  fsyncEinvalTargets.clear();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'slice4-cli-web-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
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

describe('Slice 4 — CLI Web composition adversarial hardening', () => {
  it('succeeds when FUSE/NTFS directory fsync throws EINVAL during lifecycle receipt reservation/settlement and config saves', async () => {
    const { root, project } = await makeProject();
    const receiptDirectory = join(root, 'receipts');
    const bflowDir = join(root, '.bflow');
    fsyncEinvalTargets.add(receiptDirectory);
    fsyncEinvalTargets.add(bflowDir);

    // 1. WebWorkspaceServices startSession + stopSession on FUSE/NTFS directory
    const up = vi.fn(async () => ({}));
    const down = vi.fn(async () => ({ status: 'down' as const }));
    const workspace = createWebWorkspaceServices({
      resolveProject: async () => project,
      receiptDirectory,
      createLifecycle: () => ({ up, down, doctor: vi.fn() }),
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

    const startId = randomUUID();
    const started = await workspace.startSession(project.projectId, startId);
    expect(started).toMatchObject({ ok: true, value: { state: 'ready' } });
    expect(up).toHaveBeenCalledOnce();

    const stopId = randomUUID();
    const stopped = await workspace.stopSession(project.projectId, stopId);
    expect(stopped).toMatchObject({ ok: true, value: { state: 'stopped' } });
    expect(down).toHaveBeenCalledOnce();

    // 2. WebProjectSettings saveConfiguration on FUSE/NTFS .bflow directory
    const settings = createWebProjectSettings({
      resolveProject: async () => ({
        ...project,
        projectId: 'project-' + createHash('sha256').update(root).digest('hex').slice(0, 32)
      }),
      receiptDirectory
    });
    const before = await settings.readConfiguration(project.projectId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const updatedYaml = before.value.yaml.replace('maxConcurrency: 2', 'maxConcurrency: 4');
    const saved = await settings.saveConfiguration(project.projectId, {
      apiVersion: 1,
      expectedRevision: before.value.revision,
      yaml: updatedYaml
    });
    expect(saved).toMatchObject({ ok: true });
  });

  it('degrades hung host socket timeouts during interaction() and readProjectSession() to state=unavailable within local-server 5s deadline', async () => {
    const { project } = await makeProject();
    // Simulate a frozen/stopping host socket whose IPC calls never resolve within 5s
    const neverResolves = () => new Promise<never>(() => {});
    const services = createWebInteractionServices(
      { principalId: 'ledger-principal', resolveProject: async () => project },
      {
        register: neverResolves as any,
        sessionId: async () => 'host-frozen',
        openClient: (async () => ({
          readProjectSession: neverResolves,
          listRuns: neverResolves,
          readRun: neverResolves,
          listDecisions: neverResolves,
          execute: neverResolves,
          readOperation: neverResolves,
          async *events() {},
          acknowledgeNotice: neverResolves,
          listMessages: neverResolves,
          sendMessage: neverResolves,
          readArtifact: neverResolves
        })) as any
      }
    );

    const startedAt = Date.now();
    const client = await services.interaction(project.projectId, {
      principalId: 'ledger-principal',
      browserSessionId: 'browser-1',
      expiresAt: new Date(Date.now() + 60000).toISOString()
    });
    const sessionRes = await client.readProjectSession(project.projectId);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(4500);
    expect(sessionRes).toMatchObject({
      ok: true,
      value: {
        projectId: project.projectId,
        sessionId: 'host-frozen',
        state: 'unavailable'
      }
    });
  });
});
