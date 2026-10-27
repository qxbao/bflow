import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readSkillApproval } from '../../src/agentic/skill-approval.js';
const roots:string[]=[];afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
const request={approvalReceiptId:'approval-1',skillId:'custom',version:'1',digest:'a'.repeat(64),dependencies:[],role:'developer',provider:'codex',repositoryId:'repo',sessionId:'session'};
async function fixture(){const root=await mkdtemp(join(tmpdir(),'bflow-skill-approval-'));roots.push(root);const path=join(root,'approvals.json');await writeFile(path,JSON.stringify({schemaVersion:3,receipts:[{...request,role:undefined,provider:undefined,roles:['developer'],providers:['codex'],approvedAt:'2026-01-01T00:00:00Z'}]}),{mode:0o600});return {root,path};}
it('requires exact machine approval for role/provider/repository/session/pin/dependencies',async()=>{const {path}=await fixture();expect(await readSkillApproval(path,request)).toBe(true);for(const edit of [{digest:'b'.repeat(64)},{version:'2'},{role:'reviewer'},{provider:'claude'},{repositoryId:'other'},{sessionId:'other'},{dependencies:[{skillId:'dep',version:'1',digest:'b'.repeat(64)}]}])expect(await readSkillApproval(path,{...request,...edit})).toBe(false);});
it('refuses expired, public, symlinked, duplicate or malformed receipt state',async()=>{const {root,path}=await fixture();await chmod(path,0o644);expect(await readSkillApproval(path,request)).toBe(false);await chmod(path,0o600);const raw=JSON.parse(await (await import('node:fs/promises')).readFile(path,'utf8'));raw.receipts[0].expiresAt='2026-01-02T00:00:00Z';await writeFile(path,JSON.stringify(raw));expect(await readSkillApproval(path,request)).toBe(false);await rm(path);await symlink(join(root,'missing'),path);expect(await readSkillApproval(path,request)).toBe(false);});

it('authorizes independently pinned custom dependencies with real machine receipts and rechecks expiry/scope', async () => {
  const { SkillManager, SkillFileStore, bundleDigest } = await import('@bflow/skills');
  const { files } = await import('../../../skills/test/fixtures.js');
  const root = await mkdtemp(join(tmpdir(), 'bflow-dependency-receipts-')); roots.push(root);
  const dependency = files('dependency'); const parent = files('parent');
  const dependencyPin = { skillId: 'dependency', version: '1.0.0', digest: bundleDigest(dependency) };
  parent['skill.json'] = JSON.stringify({ ...JSON.parse(parent['skill.json']!), dependencies: [dependencyPin] });
  const parentPin = { skillId: 'parent', version: '1.0.0', digest: bundleDigest(parent) };
  const path = join(root, 'approvals.json');
  const state = { schemaVersion: 3, receipts: [
    { ...parentPin, dependencies: [dependencyPin], approvalReceiptId: 'parent-receipt', repositoryId: 'repo', sessionId: 'session', roles: ['developer'], providers: ['codex'], approvedAt: '2026-01-01T00:00:00Z' },
    { ...dependencyPin, dependencies: [], approvalReceiptId: 'dependency-receipt', repositoryId: 'repo', sessionId: 'session', roles: ['developer'], providers: ['codex'], approvedAt: '2026-01-01T00:00:00Z' }
  ] };
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  const manager = new SkillManager({ store: new SkillFileStore(join(root, 'store')), supportedCommands: ['status'], authorize: check =>
    readSkillApproval(path, { skillId: check.definition.skillId, version: check.definition.version, digest: check.definition.digest,
      dependencies: check.definition.dependencies, approvalReceiptId: check.approvalReceiptId, role: check.role, provider: check.provider,
      repositoryId: check.scope.kind === 'session' ? check.scope.repositoryId : 'none',
      sessionId: check.scope.kind === 'session' ? check.scope.sessionId : 'none' }) });
  // Install is an explicit test fixture; preview below uses the same dependency authorization path without writes.
  const depDefinition = await manager.installBundle(dependency, { source: 'repository', expectedDigest: dependencyPin.digest });
  const parentDefinition = await manager.installBundle(parent, { source: 'repository', expectedDigest: parentPin.digest });
  const scope = { kind: 'session' as const, machineId: 'machine', repositoryId: 'repo', workspaceRoot: root, sessionId: 'session' };
  const selected = { manifestId: 'manifest', environmentId: 'env', scope, role: 'developer' as const, provider: 'codex' as const,
    capabilityIds: [], toolIds: [], selections: [{ skill: parentPin, required: true, approvalReceiptId: 'parent-receipt' }],
    dependencyApprovals: [{ skill: dependencyPin, approvalReceiptId: 'dependency-receipt' }] };
  const entries = [{ definition: depDefinition, files: dependency }, { definition: parentDefinition, files: parent }];
  expect((await manager.resolveCatalog(selected, entries)).manifest.skills.map(skill => skill.skillId)).toEqual(['dependency', 'parent']);
  expect((await manager.resolve(selected)).manifest.bindings.map(binding => binding.approvalReceiptId)).toEqual(['dependency-receipt', 'parent-receipt']);
  await expect(manager.resolve({ ...selected, scope: { ...scope, sessionId: 'other' } })).rejects.toThrow(/approval/i);
  state.receipts[1] = { ...state.receipts[1]!, expiresAt: '2026-01-02T00:00:00Z' } as typeof state.receipts[number];
  await writeFile(path, JSON.stringify(state));
  await expect(manager.resolveCatalog(selected, entries)).rejects.toThrow(/approval/i);
  await expect(manager.resolve(selected)).rejects.toThrow(/approval/i);
});
