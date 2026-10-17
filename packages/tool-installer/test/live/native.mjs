// Explicit opt-in smoke test. Run only in a disposable user/container: it installs native plugins.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ManagedToolInstaller, OfficialProviderPluginAdapter } from '../../dist/index.js';

if (!process.argv.includes('--apply')) throw new Error('Use --apply in a disposable user/container to run native installation');
const root = process.env.BFLOW_LIVE_ROOT ?? join(homedir(), '.local/share/bflow-toolchain-live');
await mkdir(root, { recursive: true, mode: 0o700 });
const source = 'https://codeload.github.com/obra/superpowers/tar.gz/bb92a77741419a4ab5f06e711a283343f1ada0c3';
const response = await fetch(source);
if (!response.ok) throw new Error(`Artifact HTTP ${response.status}`);
const integrity = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
const providers = process.argv.filter(arg => ['claude', 'codex', 'agy'].includes(arg));
const results = [];
for (const provider of providers.length ? providers : ['claude', 'codex', 'agy']) {
  const pin = { toolId: 'superpowers', installerId: `bflow-live-${provider}`, version: '7.0.0', source, integrity,
    recipe: { kind: 'provider_plugin', provider }, license: 'MIT' };
  const installer = new ManagedToolInstaller({ managedRoot: join(root, 'tools'), pins: [pin],
    providerPlugin: new OfficialProviderPluginAdapter({ configuration: { managedRoot: join(root, 'native') } }) });
  const planned = await installer.plan({ schemaVersion: 3, toolId: pin.toolId, installerId: pin.installerId,
    version: pin.version, source, integrity, scope: { kind: 'machine', machineId: 'disposable-live' },
    destination: join(root, 'tools', `superpowers-${provider}`), idempotencyKey: `live-${provider}` });
  if (!planned.ok) throw new Error(planned.error.message);
  const request = { schemaVersion: 3, planId: `live-${provider}`, planDigest: createHash('sha256')
    .update(JSON.stringify(planned.value)).digest('hex'), step: planned.value, approvalReceiptId: 'explicit-live-setup' };
  const first = await installer.apply(request);
  const second = await installer.apply(request);
  const result = { provider, first, second };
  results.push(result);
  console.log(JSON.stringify(result));
  await writeFile(join(root, 'native-results.json'), JSON.stringify({ source, integrity, results }, null, 2), { mode: 0o600 });
  if (!first.ok || !['applied', 'already_satisfied'].includes(first.value.status) || !second.ok || second.value.status !== 'already_satisfied')
    process.exitCode = 1;
}
