import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { ServerResponse } from 'node:http';
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
        if (targetPath.startsWith(prefix) && args[1] !== 'r' && args[1] !== 0) {
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

import { PrivateState } from '../src/operation-index.js';
import { client, fixture } from './helpers.js';

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
let f: Awaited<ReturnType<typeof fixture>> | undefined;

afterEach(async () => {
  process.env.PATH = originalPath;
  fileSyncFailureTargets.clear();
  vi.restoreAllMocks();
  await f?.close();
  f = undefined;
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('Round 2 Slice 4 — Local Server FUSE, NTFS safe.directory & route timeout hardening', () => {
  it('tolerates EOPNOTSUPP/ENOSYS on regular file handle.sync() in PrivateState.open and PrivateState.write', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'round2-slice04-srv-fuse-'));
    tempDirs.push(root);
    const stateDir = join(root, 'state');
    fileSyncFailureTargets.set(stateDir, 'EOPNOTSUPP');

    const state = await PrivateState.open(stateDir);
    try {
      await state.write('projects.json', { apiVersion: 1, items: [] });
      expect(await state.read('projects.json')).toEqual({ apiVersion: 1, items: [] });
    } finally {
      await state.close();
    }
  });

  it('registers and revalidates NTFS/FUSE root-owned Git repositories (including subdirectories) via safe.directory without mutating global gitconfig', async () => {
    f = await fixture();
    const repoPath = await f.repo('ntfs-repo');
    const subDir = join(repoPath, 'packages', 'app');
    await fs.mkdir(subDir, { recursive: true });

    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const binDir = await fs.mkdtemp(join(tmpdir(), 'round2-slice04-srv-gitbin-'));
    tempDirs.push(binDir);
    await fs.writeFile(
      join(binDir, 'git'),
      `#!/usr/bin/env bash
if [[ "$*" != *"safe.directory="* ]]; then
  echo "fatal: detected dubious ownership in repository at '${repoPath}'" >&2
  exit 128
fi
exec "${realGit}" "$@"
`,
      { mode: 0o755 }
    );
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    const { headers } = await f.login();
    const registered = await f.send('/api/v1/projects', 'POST', { apiVersion: 1, path: subDir }, headers);
    expect(registered.status).toBe(201);
    expect(registered.json.canonicalPath).toBe(await fs.realpath(repoPath));

    // Revalidating via ProjectRegistry.require(id) on subsequent endpoints must also succeed
    const sessionRes = await f.send(`/api/v1/projects/${registered.json.projectId}/session`, 'GET', undefined, {
      Cookie: headers.Cookie
    });
    expect(sessionRes.status).toBe(503); // reaches client.readProjectSession (unavailable stub), NOT 400/registry failure
  });

  it('extends socket timeouts (>= 40s) on serialized project, configuration, initialization, lifecycle, and artifact routes so 15s server.timeout cannot destroy queued requests', async () => {
    const timeoutsByRoute: { url: string; method: string; ms: number }[] = [];
    const origSetTimeout = ServerResponse.prototype.setTimeout;
    vi.spyOn(ServerResponse.prototype, 'setTimeout').mockImplementation(function (this: ServerResponse, msecs: number, callback?: () => void) {
      timeoutsByRoute.push({
        url: this.req?.url ?? '',
        method: this.req?.method ?? '',
        ms: msecs
      });
      return origSetTimeout.call(this, msecs, callback);
    });

    f = await fixture(
      {
        saveConfiguration: async id => ({
          ok: true,
          value: { apiVersion: 1, projectId: id, revision: 'b'.repeat(64), yaml: 'schemaVersion: 1\n', values: { schemaVersion: 1 } }
        }),
        initializeProject: async (id, input) => ({
          ok: true,
          value: {
            apiVersion: 1,
            projectId: id,
            operationId: input.operationId,
            state: 'running',
            message: 'running',
            updatedAt: new Date().toISOString()
          }
        }),
        startSession: async id => ({
          ok: true,
          value: {
            apiVersion: 1,
            projectId: id,
            sessionId: 's-1',
            state: 'ready',
            pendingIntakes: [],
            blockers: [],
            updatedAt: new Date().toISOString()
          }
        })
      },
      async () => ({
        ...client,
        readArtifact: async () => ({
          ok: true as const,
          value: {
            metadata: {
              apiVersion: 1,
              artifactId: 'art-1',
              runId: 'run-1',
              mediaType: 'text/plain',
              checksum: { algorithm: 'sha256' as const, value: createHash('sha256').update('ok').digest('hex') },
              sizeBytes: 2,
              disposition: 'inline' as const,
              previewLimitBytes: 1024
            },
            chunks: (async function* () {
              yield new Uint8Array([111, 107]);
            })()
          }
        })
      })
    );

    const repoPath = await f.repo('timeout-repo');
    const { headers } = await f.login();

    const reg = await f.send('/api/v1/projects', 'POST', { apiVersion: 1, path: repoPath }, headers);
    expect(reg.status).toBe(201);
    const projectId = reg.json.projectId as string;

    const save = await f.send(
      `/api/v1/projects/${projectId}/configuration`,
      'PUT',
      { apiVersion: 1, expectedRevision: 'a'.repeat(64), yaml: 'schemaVersion: 1\n' },
      headers
    );
    expect(save.status).toBe(200);

    const init = await f.send(
      `/api/v1/projects/${projectId}/initializations`,
      'POST',
      { apiVersion: 1, operationId: randomUUID(), acceptGitNexusLicense: false, skipGitNexus: true, update: false },
      headers
    );
    expect(init.status).toBe(202);

    const start = await f.send(
      `/api/v1/projects/${projectId}/session/start`,
      'POST',
      { apiVersion: 1, operationId: randomUUID() },
      headers
    );
    expect(start.status).toBe(202);

    const art = await f.send(`/api/v1/projects/${projectId}/artifacts/art-1`, 'GET', undefined, { Cookie: headers.Cookie });
    expect(art.status).toBe(200);

    for (const expectedPath of [
      '/api/v1/projects',
      `/api/v1/projects/${projectId}/configuration`,
      `/api/v1/projects/${projectId}/initializations`,
      `/api/v1/projects/${projectId}/session/start`,
      `/api/v1/projects/${projectId}/artifacts/art-1`
    ]) {
      const matched = timeoutsByRoute.find(entry => entry.url === expectedPath && entry.ms >= 40_000);
      expect(matched, `Expected socket timeout >= 40000ms for ${expectedPath}`).toBeDefined();
    }
  });
});
