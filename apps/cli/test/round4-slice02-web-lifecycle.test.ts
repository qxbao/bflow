import { randomUUID } from 'node:crypto';
import { open, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { interactionProjectId } from '@bflow/runtime';
import { createWebWorkspaceServices } from '../src/web-workspace-services.js';
import { initializeEnvironmentConfig } from '../src/environment-config.js';
import { EnvironmentLifecycle } from '../src/environment.js';
import { withLifecycleLock } from '../src/lifecycle-lock.js';
import { startWebCommand } from '../src/web-command.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, realpath } from 'node:fs/promises';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});

async function createTestProject() {
  const rawRoot = await mkdtemp(join(tmpdir(), 'bf-proj-'));
  const { realpath } = await import('node:fs/promises');
  const root = await realpath(rawRoot);
  roots.push(root);
  execFileSync('git', ['init', '--quiet', root]);
  await initializeEnvironmentConfig({ cwd: root });
  return {
    apiVersion: 1 as const,
    projectId: interactionProjectId(root),
    canonicalPath: root,
    displayName: 'test',
    registrationState: 'registered' as const
  };
}

describe('Round 4 Slice 2 — CLI Web Lifecycle & Locator Hardening', () => {
  it('settles an interrupted running lifecycle receipt on disk as reconciliation_required with actionable error', async () => {
    const p = await createTestProject();
    const receiptDir = join(p.canonicalPath, 'receipts');
    await mkdir(receiptDir, { recursive: true, mode: 0o700 });

    const opId = randomUUID();
    // Simulate a process crash leaving receipt on disk in 'running' state
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(JSON.stringify([p.projectId, opId])).digest('hex');
    const receiptFile = join(receiptDir, `${hash}.json`);

    const runningReceipt = {
      apiVersion: 1,
      projectId: p.projectId,
      operationId: opId,
      owner: 'local_lifecycle',
      operationKind: 'session_start',
      state: 'running',
      updatedAt: new Date(Date.now() - 60000).toISOString()
    };
    await writeFile(receiptFile, JSON.stringify(runningReceipt), { mode: 0o600 });

    // Open new workspace services (new process instance)
    const services = createWebWorkspaceServices({
      resolveProject: async () => p,
      receiptDirectory: receiptDir,
      createLifecycle: () => ({ up: vi.fn(), down: vi.fn(), doctor: vi.fn() })
    });

    // Call reconcileSessionOperation
    const reconciled = await services.reconcileSessionOperation({
      apiVersion: 1,
      projectId: p.projectId,
      operationId: opId,
      owner: 'local_lifecycle',
      operationKind: 'session_start',
      state: 'running',
      updatedAt: new Date().toISOString()
    });

    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) {
      expect(reconciled.value.state).toBe('reconciliation_required');
      expect(reconciled.value.error?.message).toMatch(/gián đoạn|khởi động lại|status/);
    }

    // Verify the receipt file on disk is NO LONGER stuck in 'running'
    const { readPreviewFile } = await import('../src/preview-files.js');
    const savedOnDisk = JSON.parse(await readPreviewFile(receiptFile, 1024 * 1024));
    expect(savedOnDisk.state).toBe('reconciliation_required');
    expect(savedOnDisk.error?.message).toMatch(/gián đoạn|khởi động lại|status/);
  });

  it('settles stopSession definitive refusal as failed when lock is held by another lifecycle operation', async () => {
    const p = await createTestProject();
    const receiptDir = join(p.canonicalPath, 'receipts');
    await mkdir(receiptDir, { recursive: true, mode: 0o700 });

    const opId = randomUUID();
    // A real lifecycle refusal before entering the operation carries typed unchanged evidence.
    const down = vi.fn((...args: Parameters<EnvironmentLifecycle['down']>) => new EnvironmentLifecycle(p.canonicalPath).down(...args));

    const services = createWebWorkspaceServices({
      resolveProject: async () => p,
      receiptDirectory: receiptDir,
      createLifecycle: () => ({ up: vi.fn(), down, doctor: vi.fn() })
    });

    await withLifecycleLock(join(p.canonicalPath, '.bflow/state'), async () => {
      const result = await services.stopSession(p.projectId, opId);
      // Lock contention leaves session untouched, so it is a definitive refusal (failed, not uncertain reconciliation_required)
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('validation');
        expect(result.error.message).toMatch(/vòng đời khác đang chạy|Another bflow up\/down/);
      }

      const reconciled = await services.reconcileSessionOperation({
        apiVersion: 1,
        projectId: p.projectId,
        operationId: opId,
        owner: 'local_lifecycle',
        operationKind: 'session_stop',
        state: 'running',
        updatedAt: new Date().toISOString()
      });
      expect(reconciled.ok).toBe(true);
      if (reconciled.ok) {
        expect(reconciled.value.state).toBe('failed');
      }
    });
  });

  it('recovers cleanly from a corrupted/empty locator file when the server state lock is free', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'bf-web-locator-')));
    roots.push(dir);
    const stateDir = join(dir, 'web-state');
    await mkdir(join(stateDir, 'owner'), { recursive: true, mode: 0o700 });
    // Write corrupted/empty instance.json
    const locatorPath = join(stateDir, 'instance.json');
    await writeFile(locatorPath, '{ truncated json...', { mode: 0o600 });

    const fakeAssets = join(dir, 'assets');
    await mkdir(fakeAssets, { recursive: true });
    await writeFile(join(fakeAssets, 'index.html'), '<script src="/assets/index.js"></script>');
    await mkdir(join(fakeAssets, 'assets'), { recursive: true });
    await writeFile(join(fakeAssets, 'assets/index.js'), 'console.log("hello");');

    const stderrLogs: string[] = [];
    const io = {
      stdout: () => {},
      stderr: (s: string) => { stderrLogs.push(s); }
    };

    const handle = await startWebCommand({ port: 4319, open: false }, {
      stateDirectory: stateDir,
      assetsDirectory: fakeAssets,
      io,
      interaction: async () => ({} as any)
    });

    try {
      expect(handle.origin).toContain('127.0.0.1:4319');
      expect(stderrLogs.some(l => l.includes('Dọn web instance') || l.includes('cũ'))).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
