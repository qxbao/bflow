import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openFilesystemArtifactStore } from '@bflow/artifact-store';
import { GitIntegrationEngine } from '@bflow/git-orchestrator';
import { ensureCodexWorkspaceTrust } from '@bflow/agent-providers';
import { createExecutionResolutionReader, readExecutionRepositorySnapshot } from '../../src/agentic/execution-binding.js';
import { resolvePrivateRuntimeStateDirectory } from '../../src/private-state.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
async function fixture(trusted = true, pinned = false) {
  const root = await realpath(await mkdtemp('/tmp/bflow-native-trust-')); roots.push(root);
  const repo = join(root,'repo'); await mkdir(repo);
  const git = (args:string[]) => execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Test','-c','user.email=test@localhost','-c','commit.gpgSign=false',...args],{cwd:repo,encoding:'utf8'}).trim();
  git(['init','--quiet']); await writeFile(join(repo,'.gitignore'),'.bflow/\n'); await writeFile(join(repo,'README.md'),'baseline\n'); git(['add','.']);git(['commit','--quiet','-m','baseline']);
  vi.stubEnv('XDG_STATE_HOME',join(root,'xdg-state'));
  if(pinned)await mkdir(join(root,'xdg-state/bflow/repositories',createHash('sha256').update(repo).digest('hex'),'state'),{recursive:true,mode:0o700});
  const state = resolvePrivateRuntimeStateDirectory(repo);
  const store = await openFilesystemArtifactStore({root:join(root,'artifacts'),storeId:'test-trust'});
  if (!store.ok) throw Error(store.error.message);
  const engine = await GitIntegrationEngine.open({repositoryPath:repo,artifactStore:store.value,worktreeRoot:join(repo,'.bflow/state/worktrees')});
  store.value.close();
  const config = join(root,'profiles/codex--personal/home/.codex/config.toml'); await mkdir(join(config,'..'),{recursive:true});
  await writeFile(config,'model = "gpt-6-luna"\n');if(trusted)await ensureCodexWorkspaceTrust(repo,config);
  const baseline = await readFile(config,'utf8');
  const plan = {schemaVersion:3,resolverVersion:'trust-test',policyVersion:'1',repository:await readExecutionRepositorySnapshot(repo),mode:'intake'};
  const reader = () => createExecutionResolutionReader({schemaVersion:3,repositoryRoot:repo,plan,files:[{component:'native-profile-settings-1',path:config,format:'bytes'}]});
  const prepare = async () => {
    const tree = await engine.prepareTask({runId:'run-1',taskId:'task-1',attemptId:'attempt-1',baseRevision:git(['rev-parse','HEAD']),ownedPaths:['src/value.js'],forbiddenPaths:[],developerId:'dev-1'});
    return tree;
  };
  return {root,repo,state,config,baseline,reader,prepare,git,engine};
}

it('keeps an accepted source reader valid when Bflow propagates trust to its recorded Git worktree',async()=>{
  const f=await fixture();const read=await f.reader();await read();const before=await read.readPrivateSources!();
  const tree=await f.prepare();expect(await ensureCodexWorkspaceTrust(tree.worktreePath,f.config)).toBe('trusted');
  await expect(read()).resolves.toMatchObject({mode:'intake'});
  expect(await read.readPrivateSources!()).toEqual(before);
});

it.each(['model = "other"\n','sandbox_mode = "danger-full-access"\n','[hooks]\ncommand = "changed"\n','[plugins.other]\nenabled = true\n','[projects."/outside"]\ntrust_level = "trusted"\n'])('still rejects unrelated native settings changes: %s',async(change)=>{
  const f=await fixture();const tree=await f.prepare();await ensureCodexWorkspaceTrust(tree.worktreePath,f.config);const read=await f.reader();
  await writeFile(f.config,change+f.baseline.replace('model = "gpt-6-luna"\n',''));
  await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});

it('does not exempt trust with no repository opt-in, a fabricated path, or an extra project setting',async()=>{
  const f=await fixture(false);const read=await f.reader();const tree=await f.prepare();await ensureCodexWorkspaceTrust(tree.worktreePath,f.config);
  await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
  const g=await fixture();const guarded=await g.reader();const fake=join(g.state,'worktrees','task-'+'f'.repeat(64));await mkdir(fake,{recursive:true});await ensureCodexWorkspaceTrust(fake,g.config);
  await expect(guarded()).rejects.toMatchObject({code:'execution_plan_drift'});
  await writeFile(g.config,g.baseline);const real=await g.prepare();await ensureCodexWorkspaceTrust(real.worktreePath,g.config);const checked=await g.reader();
  await writeFile(g.config,(await readFile(g.config,'utf8'))+'approval_policy = "never"\n');
  await expect(checked()).rejects.toMatchObject({code:'execution_plan_drift'});
});

it('does not exempt a recorded worktree whose Git binding was replaced with a symlink',async()=>{
  const f=await fixture();const read=await f.reader();const tree=await f.prepare();await ensureCodexWorkspaceTrust(tree.worktreePath,f.config);
  const marker=join(tree.worktreePath,'.git');await rm(marker);await symlink(join(f.repo,'.git'),marker);
  await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});

it('retains the normalization after the recorded worktree is safely cleaned',async()=>{
 const f=await fixture();const read=await f.reader();const tree=await f.prepare();await ensureCodexWorkspaceTrust(tree.worktreePath,f.config);
 await expect(read()).resolves.toMatchObject({mode:'intake'});
 await f.engine.cancelTask(tree.key);await f.engine.cleanupTask(tree.key);
 await expect(read()).resolves.toMatchObject({mode:'intake'});
});
it('does not exempt a forged directory even when it is registered as an ordinary Git worktree',async()=>{
 const f=await fixture();const read=await f.reader();const path=join(f.state,'worktrees','task-'+'a'.repeat(64));
 await mkdir(join(f.state,'worktrees'),{recursive:true});f.git(['worktree','add','-b','unowned',path,'HEAD']);await ensureCodexWorkspaceTrust(path,f.config);
 await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});
it('keeps explicit untrusted decisions and foreign/malformed ownership proof guarded',async()=>{
 const f=await fixture();const tree=await f.prepare();await ensureCodexWorkspaceTrust(tree.worktreePath,f.config);const read=await f.reader();
 const text=await readFile(f.config,'utf8');await writeFile(f.config,text.replace(/trust_level = "trusted"\n$/, 'trust_level = "untrusted"\n'));
 await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
 await writeFile(f.config,text);const common=f.git(['rev-parse','--path-format=absolute','--git-common-dir']);await writeFile(join(common,'bflow-git/state.json'),'{"version":1,"repository":"/foreign","tasks":{},"integrations":{}}');
 await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});

it('keeps non-UTF8 native settings byte changes visible to the raw guard',async()=>{
 const f=await fixture();const suffix=Buffer.from(f.baseline);await writeFile(f.config,Buffer.concat([Buffer.from([0xff,10]),suffix]));const read=await f.reader();
 await writeFile(f.config,Buffer.concat([Buffer.from([0xfe,10]),suffix]));await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});

it('uses the host worktree root when private runtime authority is pinned externally',async()=>{
 const f=await fixture(true,true);expect(f.state).not.toBe(join(f.repo,'.bflow/state'));const read=await f.reader();const tree=await f.prepare();
 expect(tree.worktreePath.startsWith(join(f.repo,'.bflow/state/worktrees')+'/')).toBe(true);
 await ensureCodexWorkspaceTrust(tree.worktreePath,f.config);await expect(read()).resolves.toMatchObject({mode:'intake'});
});
it('never removes a trust-table-shaped fragment from a multiline native auth command',async()=>{
 const f=await fixture();const tree=await f.prepare();const before=f.baseline+'\n[model_providers.local.auth]\ncommand = """\n[start]\n"""\n';await writeFile(f.config,before);const read=await f.reader();
 const entry='[projects.'+JSON.stringify(tree.worktreePath)+']\ntrust_level = "trusted"\n';
 await writeFile(f.config,before.replace('[start]', '\n'+entry+'[start]'));
 await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});

it('accepts the existing native root trust decision with a trailing slash',async()=>{
 const f=await fixture();await writeFile(f.config,f.baseline.replace(JSON.stringify(f.repo),JSON.stringify(f.repo+'/')));const read=await f.reader();const tree=await f.prepare();
 await ensureCodexWorkspaceTrust(tree.worktreePath,f.config);await expect(read()).resolves.toMatchObject({mode:'intake'});
});

it('retains accepted profile inputs when native startup appends only its generated presentation-state tables',async()=>{
 const f=await fixture();const read=await f.reader();const before=await read.readPrivateSources!();
 await writeFile(f.config,f.baseline+'\n[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n"gpt-6.1-sol" = 1\n');
 await expect(read()).resolves.toMatchObject({mode:'intake'});
 expect(await read.readPrivateSources!()).toEqual(before);
 await writeFile(f.config,(await readFile(f.config,'utf8')).replace('= 1\n','= 4\n'));
 await expect(read()).resolves.toMatchObject({mode:'intake'});
 expect(await read.readPrivateSources!()).toEqual(before);
});

it.each([
 '[tui]\nscreen_reader_detection_done = true\napproval_policy = "never"\n\n[tui.model_availability_nux]\n"gpt-6.1-sol" = 1\n',
 '[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n"gpt-6.1-sol" = "changed"\n',
 '[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n"gpt-6.1-sol" = 1\n\n[projects."/outside"]\ntrust_level = "trusted"\n'
])('keeps unknown or malformed settings beside presentation metadata guarded',async suffix=>{
 const f=await fixture();const read=await f.reader();await writeFile(f.config,f.baseline+'\n'+suffix);
 await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});

it('does not remove presentation-table-shaped bytes inside a multiline provider command',async()=>{
 const f=await fixture();const base=f.baseline+'\n[model_providers.local.auth]\ncommand = """\n[start]\n"""\n';
 await writeFile(f.config,base);const read=await f.reader();
 await writeFile(f.config,base.replace('[start]','[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n"gpt-6.1-sol" = 1\n'));
 await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});

it('preserves an unchanged legacy accepted digest that already included native presentation tables',async()=>{
 const f=await fixture();const text=f.baseline+'\n[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n"gpt-6.1-sol" = 4\n';
 await writeFile(f.config,text);const expectedDigest=createHash('sha256').update(text).digest('hex');
 const read=await createExecutionResolutionReader({schemaVersion:3,repositoryRoot:f.repo,
  plan:{schemaVersion:3,resolverVersion:'legacy-native-test',policyVersion:'1',repository:await readExecutionRepositorySnapshot(f.repo),mode:'intake'},
  files:[{component:'native-profile-settings-1',path:f.config,format:'bytes',expectedDigest}]});
 await expect(read()).resolves.toMatchObject({mode:'intake'});
 expect((await read.readPrivateSources!())['native-profile-settings-1']).toBe(expectedDigest);
 await writeFile(f.config,'approval_policy = "never"\n'+text);
 await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});

it('does not normalize duplicate model keys in generated presentation tables',async()=>{
 const f=await fixture();const read=await f.reader();
 await writeFile(f.config,f.baseline+'\n[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n"gpt-6.1-sol" = 1\n"gpt-6.1-sol" = 4\n');
 await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});

it.each(['[tui]','["tui"]','["\\u0074ui"]'])('does not erase a conflicting presentation-table definition after %s',async table=>{
 const f=await fixture();const base=f.baseline+'\n'+table+'\n';await writeFile(f.config,base);const read=await f.reader();
 await writeFile(f.config,base+'\n[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n"gpt-6.1-sol" = 1\n');
 await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});
