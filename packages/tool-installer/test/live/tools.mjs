// Explicit opt-in: installs only under BFLOW_LIVE_ROOT and uses disposable repositories/profiles.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ManagedToolInstaller, systemToolHost, ensureGitNexusIndex, createGitNexusService, createChromeService,
  probeStdioMcp, verifyChromeStartup, planRtkConfiguration, applyRtkConfiguration, runWithRtk } from '../../dist/index.js';

if (!process.argv.includes('--apply')) throw new Error('Use --apply for an explicit local smoke test');
const root = process.env.BFLOW_LIVE_ROOT ?? join(homedir(), '.local/share/bflow-toolchain-live');
await mkdir(root, { recursive: true, mode: 0o700 });
const selected = process.argv.filter(arg => ['rtk', 'gitnexus', 'chrome-devtools-mcp'].includes(arg));
const results = [];
for (const toolId of selected.length ? selected : ['rtk', 'gitnexus', 'chrome-devtools-mcp']) {
  const version = toolId === 'rtk' ? '0.49.0' : toolId === 'gitnexus' ? '1.6.12' : '1.11.0';
  const platform = process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const source = toolId === 'rtk' ? `https://github.com/rtk-ai/rtk/releases/download/v${version}/rtk-${arch}-${platform}.tar.gz` :
    `https://registry.npmjs.org/${toolId}/-/${toolId}-${version}.tgz`;
  const response = await fetch(source);
  if (!response.ok) throw new Error(`${toolId} artifact HTTP ${response.status}`);
  const integrity = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  const pin = { toolId, installerId: `bflow-live-${toolId}`, version, source, integrity,
    recipe: toolId === 'rtk' ? { kind: 'rtk_archive', archiveMember: 'rtk' } :
      { kind: 'npm', packageName: toolId, executable: toolId, allowBuildScripts: true },
    license: toolId === 'gitnexus' ? 'PolyForm-Noncommercial-1.0.0' : 'Apache-2.0' };
  const destination = join(root, 'tools', toolId);
  const installer = new ManagedToolInstaller({ managedRoot: join(root, 'tools'), pins: [pin] });
  const plan = await installer.plan({ schemaVersion: 3, toolId, installerId: pin.installerId, version, source, integrity,
    scope: { kind: 'machine', machineId: 'disposable-live' }, destination, idempotencyKey: `live-${toolId}` });
  if (!plan.ok) throw new Error(plan.error.message);
  const request = { schemaVersion: 3, planId: `live-${toolId}`, planDigest: createHash('sha256').update(JSON.stringify(plan.value)).digest('hex'),
    step: plan.value, approvalReceiptId: 'explicit-live-setup' };
  const first = await installer.apply(request), second = await installer.apply(request);
  const result = { toolId, pin, first, second };
  results.push(result);
  console.log(JSON.stringify(result));
  await writeFile(join(root, 'tools-results.json'), JSON.stringify(results, null, 2), { mode: 0o600 });
  if (!first.ok || !['applied', 'already_satisfied'].includes(first.value.status) || !second.ok || second.value.status !== 'already_satisfied') {
    process.exitCode = 1; continue;
  }
  const executable = toolId === 'rtk' ? join(destination, 'rtk') : join(destination, 'node_modules/.bin', toolId);
  if (toolId === 'rtk') {
    const failure = await runWithRtk(executable, [process.execPath, '-e', 'console.error("bflow-error-sentinel");process.exit(37)'], true);
    if (failure.exitCode !== 37 || !failure.stderr.includes('bflow-error-sentinel')) throw new Error('RTK changed the debug command error/exit status');
    for (const provider of ['claude', 'codex', 'agy']) {
      const repositoryRoot = join(root, `rtk-${provider}`); await mkdir(repositoryRoot, { recursive: true });
      const planned = await planRtkConfiguration({ executable, provider, repositoryRoot, stateRoot: join(root, 'rtk-state') });
      const configured = await applyRtkConfiguration(planned), repeated = await applyRtkConfiguration(planned);
      console.log(JSON.stringify({ rtkProvider: provider, configured, repeated }));
    }
  } else if (toolId === 'gitnexus') {
    for (const repositoryId of ['repo-one', 'repo-two']) {
      const repositoryRoot = join(root, repositoryId); await mkdir(repositoryRoot, { recursive: true });
      await systemToolHost.run('git', ['init', '-q', repositoryRoot]);
      await writeFile(join(repositoryRoot, 'example.ts'), 'export function hello(name: string) { return `Hello ${name}`; }\n');
      await systemToolHost.run('git', ['add', '.'], { cwd: repositoryRoot });
      await systemToolHost.run('git', ['-c', 'user.name=Bflow Test', '-c', 'user.email=test@bflow.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: repositoryRoot });
      const indexed = await ensureGitNexusIndex({ executable, repositoryRoot, stateRoot: join(root, 'index-state') });
      const fresh = await ensureGitNexusIndex({ executable, repositoryRoot, stateRoot: join(root, 'index-state') });
      console.log(JSON.stringify({ repositoryId, indexed, fresh }));
      if (!['indexed', 'fresh'].includes(indexed.status) || fresh.status !== 'fresh') { process.exitCode = 1; continue; }
      const operation = { schemaVersion: 3, scope: { kind: 'repository', machineId: 'disposable-live', repositoryId, workspaceRoot: repositoryRoot }, idempotencyKey: `service-${repositoryId}` };
      const service = await createGitNexusService({ executable, version, repositoryRoot, stateRoot: join(root, 'index-state'), configRoot: join(root, 'config'), operation });
      const connection = service.connection;
      const probe = await probeStdioMcp({ executable: connection.executable, argv: connection.argv,
        requiredTools: ['query', 'context', 'impact'], call: { name: 'list_repos', arguments: {} }, timeoutMs: 60_000 });
      console.log(JSON.stringify({ gitnexusMcp: repositoryId, probe }));
    }
  } else {
    const browserExecutable = process.env.BFLOW_CHROME_EXECUTABLE ?? (process.platform === 'darwin' ?
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
    const operation = { schemaVersion: 3, scope: { kind: 'repository', machineId: 'disposable-live', repositoryId: 'browser-repo', workspaceRoot: root }, idempotencyKey: 'chrome-service' };
    const service = await createChromeService({ managedRoot: join(root, 'browser'), repositoryId: 'browser-repo', taskId: 'task-one', browserExecutable,
      serverExecutable: executable, version, configRoot: join(root, 'config'), operation });
    const probe = await verifyChromeStartup(service);
    console.log(JSON.stringify({ chromeStartup: probe }));
  }
}
