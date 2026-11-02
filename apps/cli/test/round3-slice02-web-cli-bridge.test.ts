import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebChatMessageSchema } from '@bflow/contracts/web';
import { interactionProjectId, resolvePrivateRuntimeStateDirectory } from '@bflow/runtime';
import { terminateHostOwner } from '../src/agentic-host.js';
import { initializeEnvironmentConfig } from '../src/environment-config.js';
import { EnvironmentLifecycle } from '../src/environment.js';
import { PaneManagerLifecycleAdapter } from '../src/pane-manager-integration.js';
import { commitWebConfiguration } from '../src/web-config-git.js';
import { createWebInteractionServices } from '../src/web-interaction.js';
import { createWebProjectSettings } from '../src/web-project-settings.js';
import { createWebWorkspaceServices } from '../src/web-workspace-services.js';
import { HerdrProcesses } from './fixtures/herdr-processes.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeRepo(withConfig = true) {
  const rawRoot = await mkdtemp(join(tmpdir(), 'round3-slice02-cli-'));
  const root = await realpath(rawRoot);
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  if (withConfig) {
    await initializeEnvironmentConfig({ cwd: root });
  }
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

describe('Round 3 Slice 2 — Web/CLI/Host lifecycle, interaction, settings & recovery bridge', () => {
  it('re-acquires authenticated credentials for listMessages, sendMessage, and acknowledgeNotice when initial probe times out, and degrades connection refusal to transport_unavailable', async () => {
    const { project } = await makeRepo(true);
    let registerCalls = 0;
    const register = vi.fn(async (_host: unknown, registration: { principalId: string }) => {
      registerCalls++;
      if (registerCalls === 1) {
        // Exceed COLD_REGISTER_PROBE_MS (2500ms) on initial interaction() probe
        await new Promise(resolve => setTimeout(resolve, 2650));
      }
      return {
        credential: `cred-${registerCalls}`.padEnd(64, '0'),
        principalId: registration.principalId,
        socketPath: '/tmp/bflow-test.sock'
      };
    });

    const openClient = vi.fn(async (opts: { interaction?: { credential: string } }) => ({
      readProjectSession: async () => ({
        ok: true as const,
        value: {
          apiVersion: 1 as const,
          projectId: project.projectId,
          sessionId: 'host-1',
          state: 'ready' as const,
          pendingIntakes: [],
          blockers: [],
          updatedAt: new Date().toISOString()
        }
      }),
      listRuns: async () => ({ ok: true as const, value: { apiVersion: 1 as const, items: [] } }),
      readRun: async () => ({ ok: false as const, error: { code: 'not_found' as const, retryable: false, message: 'missing' } }),
      listDecisions: async () => ({ ok: true as const, value: { apiVersion: 1 as const, items: [] } }),
      execute: async () => ({ ok: false as const, error: { code: 'not_found' as const, retryable: false, message: 'none' } }),
      readOperation: async () => ({ ok: false as const, error: { code: 'not_found' as const, retryable: false, message: 'none' } }),
      async *events() {},
      acknowledgeNotice: async (_id: string, noticeId: string) =>
        opts.interaction
          ? { ok: true as const, value: { apiVersion: 1 as const, noticeId, displayedAt: new Date().toISOString() } }
          : { ok: false as const, error: { code: 'validation' as const, retryable: false, message: 'Interaction method or scope is not supported.' } },
      listMessages: async () =>
        opts.interaction
          ? { ok: true as const, value: { apiVersion: 1 as const, items: [] } }
          : { ok: false as const, error: { code: 'validation' as const, retryable: false, message: 'Interaction method or scope is not supported.' } },
      sendMessage: async (input: any) =>
        opts.interaction
          ? {
              ok: true as const,
              value: WebChatMessageSchema.parse({
                apiVersion: 1,
                messageId: input.messageId,
                sessionId: input.sessionId,
                sender: 'user',
                source: 'web',
                content: input.content,
                createdAt: new Date().toISOString(),
                delivery: 'queued'
              })
            }
          : { ok: false as const, error: { code: 'validation' as const, retryable: false, message: 'Interaction method or scope is not supported.' } },
      readArtifact: async () => ({ ok: false as const, error: { code: 'not_found' as const, retryable: false, message: 'none' } })
    }));

    const services = createWebInteractionServices(
      { principalId: 'ledger', resolveProject: async () => project },
      { register: register as any, openClient: openClient as any, sessionId: async () => 'host-1' }
    );
    const client = await services.interaction(project.projectId, {
      principalId: 'ledger',
      browserSessionId: 'browser-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const msgId = randomUUID();
    const history = await client.listMessages(project.projectId, 'conv-1');
    expect(history).toEqual({ ok: true, value: { apiVersion: 1, items: [] } });

    const sent = await client.sendMessage({
      apiVersion: 1,
      messageId: msgId,
      projectId: project.projectId,
      sessionId: 'conv-1',
      content: 'hello after slow probe'
    });
    expect(sent).toMatchObject({ ok: true, value: { messageId: msgId } });

    const acked = await client.acknowledgeNotice(project.projectId, 'notice-1');
    expect(acked).toMatchObject({ ok: true, value: { noticeId: 'notice-1' } });

    // When host registration genuinely fails (e.g. ECONNREFUSED), chat/notice return retryable transport_unavailable, never 400 validation
    const offlineServices = createWebInteractionServices(
      { principalId: 'ledger', resolveProject: async () => project },
      {
        register: (async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        }) as any,
        openClient: openClient as any,
        sessionId: async () => 'host-down'
      }
    );
    const offlineClient = await offlineServices.interaction(project.projectId, {
      principalId: 'ledger',
      browserSessionId: 'browser-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect(await offlineClient.listMessages(project.projectId, 'conv-1')).toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable', retryable: true }
    });
    expect(
      await offlineClient.sendMessage({
        apiVersion: 1,
        messageId: randomUUID(),
        projectId: project.projectId,
        sessionId: 'conv-1',
        content: 'offline'
      })
    ).toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable', retryable: true }
    });
    expect(await offlineClient.acknowledgeNotice(project.projectId, 'notice-1')).toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable', retryable: true }
    });
  }, 15_000);

  it('caches and coalesces issuer registration per live host owner.json PID, tolerates >2s loaded session reads, and re-registers immediately when host restarts', async () => {
    const { root, project } = await makeRepo(true);
    const stateDir = resolvePrivateRuntimeStateDirectory(root);
    const hostDir = join(stateDir, 'host', 'host-live');
    await mkdir(hostDir, { recursive: true, mode: 0o700 });
    await writeFile(join(hostDir, 'owner.json'), JSON.stringify({ pid: process.pid, generation: 1 }), { mode: 0o600 });

    let generation = 0;
    const seenCredentials: string[] = [];
    const register = vi.fn(async (_host: unknown, registration: { principalId: string }) => {
      await new Promise(resolve => setTimeout(resolve, 40));
      generation++;
      return {
        credential: `cred-gen-${generation}`.padEnd(64, 'x'),
        principalId: registration.principalId,
        socketPath: join(hostDir, 'host.sock')
      };
    });
    const openClient = vi.fn(async (opts: { interaction?: { credential: string } }) => ({
      readProjectSession: async () => {
        // Simulate loaded host taking 2400ms (> old 2000ms cap, < new 3800ms healthy cap)
        await new Promise(resolve => setTimeout(resolve, 2400));
        return {
          ok: true as const,
          value: {
            apiVersion: 1 as const,
            projectId: project.projectId,
            sessionId: 'host-live',
            state: 'ready' as const,
            pendingIntakes: [],
            blockers: [],
            updatedAt: new Date().toISOString()
          }
        };
      },
      listMessages: async () => {
        if (opts.interaction) seenCredentials.push(opts.interaction.credential);
        return { ok: true as const, value: { apiVersion: 1 as const, items: [] } };
      }
    }));

    const services = createWebInteractionServices(
      { principalId: 'ledger', resolveProject: async () => project },
      { register: register as any, openClient: openClient as any, sessionId: async () => 'host-live' }
    );
    const browser = {
      principalId: 'ledger',
      browserSessionId: 'browser-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };

    // 5 concurrent requests coalesce into 1 single register() call
    const clients = await Promise.all(Array.from({ length: 5 }, () => services.interaction(project.projectId, browser)));
    expect(register).toHaveBeenCalledTimes(1);

    // Warm sequential poll hits owner.json cache (still 1 register call) and survives 2400ms session read without flashing unavailable
    const warmClient = await services.interaction(project.projectId, browser);
    expect(register).toHaveBeenCalledTimes(1);
    const loadedSession = await warmClient.readProjectSession(project.projectId);
    expect(loadedSession).toMatchObject({ ok: true, value: { state: 'ready' } });
    await clients[0]!.listMessages(project.projectId, 'conv-1');
    expect(seenCredentials.at(-1)).toContain('cred-gen-1');

    // Host restarts (`down` -> `up`) writing a new owner.json stamp -> next interaction() immediately re-registers
    await writeFile(join(hostDir, 'owner.json'), JSON.stringify({ pid: process.pid, generation: 2 }), { mode: 0o600 });
    const recycledClient = await services.interaction(project.projectId, browser);
    expect(register).toHaveBeenCalledTimes(2);
    await recycledClient.listMessages(project.projectId, 'conv-1');
    expect(seenCredentials.at(-1)).toContain('cred-gen-2');
  }, 15_000);

  it('reports in-flight startSession/stopSession receipts as state=running during live execution, and reconciliation_required only after crash/restart', async () => {
    const { root, project } = await makeRepo(true);
    const receiptDirectory = join(root, 'lifecycle-receipts');
    let enteredUp!: () => void;
    const upEntered = new Promise<void>(resolve => {
      enteredUp = resolve;
    });
    let releaseUp!: () => void;
    const upGate = new Promise<void>(resolve => {
      releaseUp = resolve;
    });

    const options = {
      resolveProject: async () => project,
      receiptDirectory,
      createLifecycle: () => ({
        up: vi.fn(async () => {
          enteredUp();
          await upGate;
          return {} as any;
        }),
        down: vi.fn(async () => ({ status: 'down' as const }) as any),
        doctor: vi.fn()
      }),
      readSession: async () => ({
        ok: true as const,
        value: {
          apiVersion: 1 as const,
          projectId: project.projectId,
          sessionId: 'session-1',
          state: 'ready' as const,
          pendingIntakes: [],
          blockers: [],
          updatedAt: new Date().toISOString()
        }
      })
    };

    const liveWorkspace = createWebWorkspaceServices(options);
    const opId = randomUUID();
    const startPromise = liveWorkspace.startSession(project.projectId, opId);
    await upEntered;

    const pendingOp = {
      apiVersion: 1 as const,
      operationId: opId,
      projectId: project.projectId,
      owner: 'local_lifecycle' as const,
      operationKind: 'session_start' as const,
      state: 'reconciliation_required' as const,
      updatedAt: new Date().toISOString()
    };

    // Same live process knows `up()` is actively executing -> returns `running`, NOT false `reconciliation_required`
    const whileRunning = await liveWorkspace.reconcileSessionOperation(pendingOp);
    expect(whileRunning).toMatchObject({ ok: true, value: { operationId: opId, state: 'running' } });

    // A separate/restarted service instance without in-memory `inFlight` ownership still fails closed as `reconciliation_required`
    const crashedObserver = createWebWorkspaceServices(options);
    const afterCrash = await crashedObserver.reconcileSessionOperation(pendingOp);
    expect(afterCrash).toMatchObject({ ok: true, value: { operationId: opId, state: 'reconciliation_required' } });

    releaseUp();
    expect(await startPromise).toMatchObject({ ok: true, value: { state: 'ready' } });
    expect(await liveWorkspace.reconcileSessionOperation(pendingOp)).toMatchObject({
      ok: true,
      value: { operationId: opId, state: 'applied' }
    });
  });

  it('does not falsely fail doctor/status while another process actively holds lifecycle.guard, and treats accepted panes as healthy in doctorSession', async () => {
    const { root } = await makeRepo(true);
    const { identifyRepository } = await import('../src/repository.js');
    const { readEnvironmentConfig } = await import('../src/environment-config.js');
    const { withLifecycleLock } = await import('../src/lifecycle-lock.js');
    const repository = await identifyRepository(root);
    const config = await readEnvironmentConfig(repository);

    const stateDir = join(root, '.bflow', 'state');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });

    const fastDeps = {
      providerOverrides: {
        codex: { available: true, authenticated: true },
        claude: { available: true, authenticated: true },
        agy: { available: true, authenticated: true }
      },
      toolOverrides: {
        rtk: { installed: true, version: '0.1.0' },
        gitnexus: { installed: true, version: '0.1.0' },
        mempalace: { installed: true, version: '0.1.0' }
      },
      deepwikiHealth: async () => ({
        enabled: true,
        required: false,
        state: 'healthy' as const,
        checks: [],
        probe: { mode: 'none' as const },
        providers: [],
        serviceReadiness: {
          gateway: 'not_configured' as const,
          status: 'healthy' as const,
          discoveredTools: [],
          observedAt: null,
          ageMs: null
        }
      })
    };

    // Hold the production kernel flock on lifecycle.guard while operation.json is mid-flight
    await withLifecycleLock(stateDir, async () => {
      await writeFile(
        join(stateDir, 'operation.json'),
        JSON.stringify({ repositoryId: repository.id, sessionName: repository.sessionName, phase: 'manager_pending' }),
        { mode: 0o600 }
      );

      const runner = new HerdrProcesses();
      const lifecycle = new EnvironmentLifecycle(root, { runner, ...fastDeps });

      const activeDoctor = await lifecycle.doctor(false);
      const opCheckWhileLocked = activeDoctor.checks.find(c => c.checkId === 'operation-recovery');
      expect(opCheckWhileLocked).toMatchObject({
        status: 'passed',
        message: expect.stringContaining('currently active under the lifecycle lock')
      });

      const activeStatus = await lifecycle.status();
      expect(activeStatus.issues.some(issue => issue.includes('was interrupted'))).toBe(false);
    });

    // Once the lock holder exits without clearing operation.json, doctor & status immediately flag the interrupted crash
    const runner = new HerdrProcesses();
    const lifecycle = new EnvironmentLifecycle(root, { runner, ...fastDeps });
    const crashedDoctor = await lifecycle.doctor(false);
    expect(crashedDoctor.checks.find(c => c.checkId === 'operation-recovery')).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('unresolved')
    });
    const crashedStatus = await lifecycle.status();
    expect(crashedStatus.issues.some(issue => issue.includes('was interrupted'))).toBe(true);

    // Also verify PaneManagerLifecycleAdapter.doctorSession passes panes in `accepted` transportState
    const now = new Date().toISOString();
    const adapter = new PaneManagerLifecycleAdapter({ repository, config, env: { ...process.env } }, runner);
    const acceptedManifest = {
      schemaVersion: 2 as const,
      sessionId: repository.sessionName,
      workspaceRoot: root,
      workspaceId: 'ws-1',
      status: 'up' as const,
      createdAt: now,
      updatedAt: now,
      attachTarget: { workspaceId: 'ws-1', tabId: 'tab-conv', paneId: 'pane-conv' },
      activeRunIds: [],
      panes: [
        {
          bindingId: 'bind-conv',
          sessionId: repository.sessionName,
          workspaceId: 'ws-1',
          tabId: 'tab-conv',
          tabKind: 'conversation' as const,
          paneId: 'pane-conv',
          role: 'conversation' as const,
          agentId: 'agent-conv',
          transportState: 'accepted' as const,
          permanent: true,
          createdAt: now,
          lastHeartbeatAt: now
        }
      ],
      metadata: { repositoryId: repository.id, sessionName: repository.sessionName, panePresentationVersion: 1 }
    };
    vi.spyOn(adapter, 'getManifest').mockResolvedValue({
      ok: true,
      value: acceptedManifest
    });
    const paneReport = await adapter.doctorSession({ workspaceRoot: root });
    expect(paneReport.healthy).toBe(true);
    expect(paneReport.checks.find(c => c.checkId === 'pane-bind-conv')).toMatchObject({ status: 'passed' });
  }, 120_000);

  it('commits configuration when .bflow/.gitignore was missing pre-init, handles undefined/scalar YAML repairs, and reports missing Git identity cleanly', async () => {
    const { root } = await makeRepo(true);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Round3 Tester']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'round3@bflow.local']);

    // Delete .bflow/.gitignore to simulate a repo containing only .bflow/config.yml
    await unlink(join(root, '.bflow', '.gitignore'));

    const projectId = 'project-' + createHash('sha256').update(root).digest('hex').slice(0, 32);
    const settings = createWebProjectSettings({
      resolveProject: async () => ({
        apiVersion: 1,
        projectId,
        canonicalPath: root,
        displayName: 'repo',
        registrationState: 'registered'
      }),
      receiptDirectory: join(root, 'settings-receipts'),
      prepareGitNexus: async () => ({ status: 'ready', diagnostics: ['indexed'] })
    });

    const initial = await settings.readConfiguration(projectId);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(initial.value.gitIgnore).toBeUndefined();

    // 1. initializeProject with commitConfiguration=true succeeds even when .bflow/.gitignore had to be generated
    const initId = randomUUID();
    await settings.initializeProject(projectId, {
      apiVersion: 1,
      operationId: initId,
      acceptGitNexusLicense: true,
      update: false,
      commitConfiguration: true,
      expectedConfigurationRevision: initial.value.revision
    });
    await Promise.all(settings.pending());
    const initResult = await settings.readInitialization(projectId, initId);
    expect(initResult).toMatchObject({
      ok: true,
      value: { state: 'succeeded', message: expect.stringContaining('Đã commit cấu hình Bflow:') }
    });
    expect(execFileSync('git', ['-C', root, 'show', '--pretty=format:', '--name-only', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').sort()).toEqual([
      '.bflow/.gitignore',
      '.bflow/config.yml'
    ]);

    // 2. saveConfiguration handles undefined optional properties and scalar/broken YAML repair via values
    const afterCommit = await settings.readConfiguration(projectId);
    expect(afterCommit.ok).toBe(true);
    if (!afterCommit.ok) return;
    const validValues = structuredClone(afterCommit.value.values) as Record<string, any>;
    validValues.environment.roles[0].model = 'haiku';
    const withModel = await settings.saveConfiguration(projectId, {
      apiVersion: 1,
      expectedRevision: afterCommit.value.revision,
      values: validValues
    });
    expect(withModel.ok).toBe(true);
    if (!withModel.ok) return;

    const clearedModelValues = structuredClone(withModel.value.values) as Record<string, any>;
    clearedModelValues.environment.roles[0].model = undefined;
    const clearedModel = await settings.saveConfiguration(projectId, {
      apiVersion: 1,
      expectedRevision: withModel.value.revision,
      values: clearedModelValues
    });
    expect(clearedModel.ok).toBe(true);
    expect(await readFile(join(root, '.bflow', 'config.yml'), 'utf8')).not.toContain('model: null');

    // Corrupt config.yml to a scalar and repair via form `values`
    await writeFile(join(root, '.bflow', 'config.yml'), 'corrupted-scalar-config\n', 'utf8');
    const brokenSnap = await settings.readConfiguration(projectId);
    expect(brokenSnap.ok).toBe(true);
    if (!brokenSnap.ok) return;
    const repaired = await settings.saveConfiguration(projectId, {
      apiVersion: 1,
      expectedRevision: brokenSnap.value.revision,
      values: validValues
    });
    expect(repaired.ok).toBe(true);

    // 3. Missing Git identity throws clean Vietnamese remediation before staging files
    const noIdentRepo = await makeRepo(true);
    const emptyHome = await mkdtemp(join(tmpdir(), 'round3-empty-home-'));
    roots.push(emptyHome);
    const prevHome = process.env.HOME;
    const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    const prevConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    const prevEmail = process.env.EMAIL;
    process.env.HOME = emptyHome;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_CONFIG_GLOBAL = join(emptyHome, 'nonexistent-gitconfig');
    delete process.env.EMAIL;
    try {
      execFileSync('git', ['-C', noIdentRepo.root, 'config', 'user.useConfigOnly', 'true']);
      await expect(commitWebConfiguration(noIdentRepo.root)).rejects.toThrow(/Chưa cấu hình danh tính Git/);
      const staged = execFileSync('git', ['-C', noIdentRepo.root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim();
      expect(staged).toBe('');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem;
      if (prevConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevConfigGlobal;
      if (prevEmail !== undefined) process.env.EMAIL = prevEmail;
    }
  });

  it('recovers unreachable host owners and post-barrier shutdownHost failures under down --force, and unlinks dead owner sockets', async () => {
    const { root } = await makeRepo(true);
    const runner = new HerdrProcesses();
    const { identifyRepository } = await import('../src/repository.js');
    const { readEnvironmentConfig } = await import('../src/environment-config.js');
    const repository = await identifyRepository(root);
    const config = await readEnvironmentConfig(repository);
    const adapter = new PaneManagerLifecycleAdapter({ repository, config, env: { ...process.env } }, runner);

    const baseLifecycle = new EnvironmentLifecycle(root, {
      runner,
      integration: {
        manager: adapter,
        runtime: { findRuns: async () => ({ ok: true, value: { items: [] } }), getRun: async () => ({ ok: true, value: null }) },
        quiesce: async () => ({ ok: true, value: undefined })
      },
      providerOverrides: {
        codex: { available: true, authenticated: true },
        claude: { available: true, authenticated: true },
        agy: { available: true, authenticated: true }
      },
      toolOverrides: {
        rtk: { installed: true, version: '0.1.0' },
        gitnexus: { installed: true, version: '0.1.0' },
        mempalace: { installed: true, version: '0.1.0' }
      },
      deepwikiHealth: async () => ({
        enabled: true,
        required: false,
        state: 'healthy' as const,
        checks: [],
        probe: { mode: 'none' as const },
        providers: [],
        serviceReadiness: {
          gateway: 'not_configured' as const,
          status: 'healthy' as const,
          discoveredTools: [],
          observedAt: null,
          ageMs: null
        }
      })
    });
    await baseLifecycle.up();
    expect(runner.session(repository.sessionName).running).toBe(true);

    // 1. Unreachable live host owner: plain down fails closed with --force guidance; down --force stops Herdr & terminates owner
    const events: string[] = [];
    const makeUnreachable = () =>
      new EnvironmentLifecycle(root, {
        runner,
        integration: {
          manager: adapter,
          runtime: {
            findRuns: async () => ({
              ok: false,
              error: {
                code: 'transport_unavailable',
                retryable: true,
                message: 'Error: Host owner is still alive but unreachable; preserve the endpoint and reconcile'
              }
            }),
            getRun: async () => ({ ok: true, value: null })
          },
          quiesce: async () => ({ ok: true, value: undefined }),
          terminateIncompatibleHost: async () => {
            events.push('terminated-unreachable');
          }
        }
      });

    await expect(makeUnreachable().down(true, 3000, false)).rejects.toThrow(/Host owner is still alive but unreachable.*bflow down --force/);
    expect(runner.session(repository.sessionName).running).toBe(true);

    const forceStopped = await makeUnreachable().down(true, 3000, true);
    expect(forceStopped).toMatchObject({ status: 'down' });
    expect(events).toEqual(['terminated-unreachable']);
    expect(runner.session(repository.sessionName).running).toBe(false);

    // 2. Post-barrier shutdownHost failure under force=true falls back to terminateIncompatibleHost
    await baseLifecycle.up();
    const postBarrierLifecycle = new EnvironmentLifecycle(root, {
      runner,
      integration: {
        manager: adapter,
        runtime: { findRuns: async () => ({ ok: true, value: { items: [] } }), getRun: async () => ({ ok: true, value: null }) },
        quiesce: async () => ({ ok: true, value: undefined }),
        shutdownHost: async () => {
          throw new Error('Host stop acknowledgement received but endpoint is still present; reconcile its owner');
        },
        terminateIncompatibleHost: async () => {
          events.push('terminated-post-barrier');
        }
      }
    });
    const postBarrierStopped = await postBarrierLifecycle.down(true, 3000, true);
    expect(postBarrierStopped).toMatchObject({ status: 'down' });
    expect(events).toEqual(['terminated-unreachable', 'terminated-post-barrier']);

    // 3. terminateHostOwner unlinks leftover .sock and .native.sock when recorded PID is already dead
    const hostDir = join(root, 'dead-host');
    await mkdir(hostDir, { recursive: true, mode: 0o700 });
    const sockPath = join(hostDir, 'dead.sock');
    const nativeSockPath = join(hostDir, 'dead.native.sock');
    await writeFile(sockPath, '');
    await writeFile(nativeSockPath, '');
    // Spawn and await a short-lived process to obtain a guaranteed-dead valid PID
    const exitedChild = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = exitedChild.pid!;
    await new Promise(resolve => exitedChild.once('close', resolve));
    await writeFile(join(hostDir, 'owner.json'), JSON.stringify({ pid: deadPid }));
    await writeFile(join(hostDir, 'host.json'), JSON.stringify({ socketPath: sockPath }));

    await terminateHostOwner(hostDir);
    await expect(readFile(sockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(nativeSockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 90_000);
});
