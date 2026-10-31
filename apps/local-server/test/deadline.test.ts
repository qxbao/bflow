import { describe, expect, it } from 'vitest';
import { client, fixture } from './helpers.js';

describe('long-running local-server route and command deadlines', () => {
  it('allows multi-role readiness inspection taking longer than the 15s HTTP socket idle timeout', async () => {
    const env = await fixture({
      inspectProject: async (projectId) => {
        await new Promise((r) => setTimeout(r, 15400));
        return {
          ok: true,
          value: {
            apiVersion: 1,
            projectId,
            ready: true,
            checks: [{ id: 'doctor', state: 'passed', message: 'Healthy' }],
            observedAt: '2026-10-31T06:00:00.000Z',
          },
        };
      },
    });
    try {
      const { headers } = await env.login();
      const repoPath = await env.repo();
      const reg = await env.send('/api/v1/projects', 'POST', { apiVersion: 1, path: repoPath }, headers);
      expect(reg.status).toBe(201);
      const id = reg.json.projectId;
      const res = await env.send(`/api/v1/projects/${encodeURIComponent(id)}/session/inspect`, 'POST', { apiVersion: 1 }, headers);
      expect(res.status).toBe(200);
      expect(res.json.ready).toBe(true);
    } finally {
      await env.close();
    }
  }, 25000);

  it('waits for structured host commands queued behind active Herdr journal ticks (>5s) instead of prematurely marking reconciliation_required', async () => {
    const env = await fixture({}, async (projectId) => ({
      ...client,
      readProjectSession: async () => ({
        ok: true as const,
        value: {
          apiVersion: 1 as const,
          projectId,
          sessionId: 'conv-host-1',
          state: 'ready' as const,
          pendingIntakes: [],
          blockers: [],
          updatedAt: '2026-10-31T06:00:00.000Z',
        },
      }),
      execute: async (command) => {
        await new Promise((r) => setTimeout(r, 5600));
        return {
          ok: true as const,
          value: {
            apiVersion: 1 as const,
            operationId: command.commandId,
            projectId: command.projectId,
            owner: 'host_interaction' as const,
            operationKind: command.kind,
            state: 'applied' as const,
            result: { kind: 'interaction' as const, runId: 'run-1', currentRunId: 'run-1' },
            updatedAt: '2026-10-31T06:00:06.000Z',
          },
        };
      },
    }));
    try {
      const { headers } = await env.login();
      const repoPath = await env.repo();
      const reg = await env.send('/api/v1/projects', 'POST', { apiVersion: 1, path: repoPath }, headers);
      const id = reg.json.projectId;
      const cmd = {
        apiVersion: 1,
        commandId: crypto.randomUUID(),
        projectId: id,
        kind: 'cancel',
        runId: 'run-1',
        reason: 'stop',
        expectedVersion: { revisionToken: 'v' },
      };
      const res = await env.send(`/api/v1/projects/${encodeURIComponent(id)}/commands`, 'POST', cmd, headers);
      expect(res.status).toBe(202);
      expect(res.json.state).toBe('applied');
    } finally {
      await env.close();
    }
  }, 15000);
});
