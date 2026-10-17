// Explicit opt-in; runs only inside the disposable integration-test user/container.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ManagedToolInstaller, OfficialProviderPluginAdapter, systemToolHost,
  createClaudeMemService, probeStdioMcp } from '../../dist/index.js';

if (!process.argv.includes('--apply')) throw new Error('Use --apply in a disposable user/container');
const root = process.env.BFLOW_LIVE_ROOT ?? join(homedir(), '.local/share/bflow-toolchain-live');
const dataDir = join(root, 'memory-data'), projectRoot = join(root, 'memory-project');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await mkdir(projectRoot, { recursive: true, mode: 0o700 });
await systemToolHost.run('git', ['init', '-q', projectRoot]);
await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_PROVIDER: 'host', CLAUDE_MEM_WORKER_PORT: '38177',
  CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_CHROMA_ENABLED: 'false' }), { flag: 'wx', mode: 0o600 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
const source = 'https://registry.npmjs.org/claude-mem/-/claude-mem-13.40.0.tgz';
const response = await fetch(source);
if (!response.ok) throw new Error(`Artifact HTTP ${response.status}`);
const integrity = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
const providers = process.argv.filter(arg => ['claude', 'codex', 'agy'].includes(arg));
const results = [];
for (const provider of providers.length ? providers : ['claude', 'codex', 'agy']) {
  const pin = { toolId: 'claude-mem', installerId: `bflow-memory-${provider}`, version: '13.40.0', source, integrity,
    recipe: { kind: 'provider_plugin', provider }, license: 'Apache-2.0' };
  const memory = { dataDir, projectRoot, project: projectRoot, port: 38177, startIfMissing: true };
  const installer = new ManagedToolInstaller({ managedRoot: join(root, 'tools'), pins: [pin],
    providerPlugin: new OfficialProviderPluginAdapter({ configuration: { managedRoot: join(root, 'native'), memory } }) });
  const plan = await installer.plan({ schemaVersion: 3, toolId: pin.toolId, installerId: pin.installerId, version: pin.version,
    source, integrity, destination: join(root, 'tools', `memory-${provider}`), scope: { kind: 'machine', machineId: 'disposable-live' },
    idempotencyKey: `memory-${provider}` });
  if (!plan.ok) throw new Error(plan.error.message);
  const request = { schemaVersion: 3, planId: `memory-${provider}`, planDigest: createHash('sha256').update(JSON.stringify(plan.value)).digest('hex'),
    step: plan.value, approvalReceiptId: 'explicit-live-setup' };
  let first = await installer.apply(request);
  if (first.ok && first.value.status === 'unknown' && process.argv.includes('--retry-reviewed')) {
    const intent = await readFile(`${request.step.toolInstall.destination}.native-pending.json`);
    first = await installer.retryNativeAfterReview(request, createHash('sha256').update(intent).digest('hex'));
  }
  const second = await installer.apply(request);
  results.push({ provider, first, second });
  console.log(JSON.stringify({ provider, first, second }));
  await writeFile(join(root, 'memory-results.json'), JSON.stringify({ source, integrity, results }, null, 2), { mode: 0o600 });
  if (!first.ok || !['applied', 'already_satisfied'].includes(first.value.status) || !second.ok || second.value.status !== 'already_satisfied') {
    process.exitCode = 1; break;
  }
}
if (!process.exitCode) {
  const operation = { schemaVersion: 3, scope: { kind: 'repository', machineId: 'disposable-live', repositoryId: 'memory-project', workspaceRoot: projectRoot }, idempotencyKey: 'memory-service' };
  const service = await createClaudeMemService({ dataDir, projectRoot, project: projectRoot, port: 38177, version: '13.40.0',
    operation, configRoot: join(root, 'config') });
  const connection = service.connection;
  const probe = await probeStdioMcp({ executable: connection.executable, argv: connection.argv, requiredTools: ['memory_recent', 'memory_search', 'memory_get'],
    call: { name: 'memory_recent', arguments: { limit: 1 } } });
  console.log(JSON.stringify({ memoryMcp: probe }));
}
