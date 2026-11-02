import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { openFilesystemArtifactStore } from '@bflow/artifact-store';
import { GitIntegrationEngine } from '@bflow/git-orchestrator';
import { ensureCodexWorkspaceTrust } from '@bflow/agent-providers';
import { createExecutionResolutionReader, resolvePrivateRuntimeStateDirectory } from '@bflow/runtime';
import { initializeEnvironmentConfig, readEnvironmentConfig } from '../src/environment-config.js';
import { identifyRepository } from '../src/repository.js';
import { renderEnvironmentConfigYaml } from '../src/config-format.js';
import { loadHostExecutionResolution } from '../src/execution-preview.js';
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it('CLI public projection and private expected digest agree with the reader after a managed trust append',async()=>{
 const top=await realpath(await mkdtemp('/tmp/cli-native-trust-'));roots.push(top);const root=join(top,'repo');await mkdir(root);
 const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Test','-c','user.email=test@localhost','-c','commit.gpgSign=false',...args],{cwd:root,encoding:'utf8'}).trim();
 git(['init','--quiet']);await writeFile(join(root,'README.md'),'baseline\n');git(['add','.']);git(['commit','--quiet','-m','baseline']);await initializeEnvironmentConfig({cwd:root});
 vi.stubEnv('BFLOW_HOME',join(top,'machine'));vi.stubEnv('AI_ISOLATOR_HOME',join(top,'native'));
 const profile=join(top,'native/profiles/codex--personal');const home=join(profile,'home/.codex');await mkdir(home,{recursive:true});
 await writeFile(join(profile,'profile.env'),'AI_ISOLATOR_TOOL=codex\nAI_ISOLATOR_PROFILE=personal\nAI_ISOLATOR_CREATED_AT=2026-11-02\n');
 const configFile=join(home,'config.toml');await writeFile(configFile,'model = "gpt-6-luna"\n');await ensureCodexWorkspaceTrust(root,configFile);
 const repository=await identifyRepository(root);const config=await readEnvironmentConfig(repository);config.environment.roles=config.environment.roles.filter(r=>r.role==='conversation'||r.role==='coordinator');
 for(const role of config.environment.roles){role.cli='codex';role['profile-name']='personal';role.model='gpt-6-luna';}
 await writeFile(join(root,'.bflow/config.yml'),renderEnvironmentConfigYaml(config));git(['add','.bflow/config.yml','.bflow/.gitignore']);git(['commit','--quiet','-m','Configure roles']);
 const input={repository,config,env:process.env};const before=await loadHostExecutionResolution(input);
 const state=resolvePrivateRuntimeStateDirectory(root);const store=await openFilesystemArtifactStore({root:join(top,'artifacts'),storeId:'trust-test'});if(!store.ok)throw Error(store.error.message);
 try{
  const engine=await GitIntegrationEngine.open({repositoryPath:root,artifactStore:store.value,worktreeRoot:join(state,'worktrees')});
  const tree=await engine.prepareTask({runId:'run',taskId:'task',attemptId:'attempt',baseRevision:git(['rev-parse','HEAD']),ownedPaths:['src/a.js'],developerId:'dev'});
  await ensureCodexWorkspaceTrust(tree.worktreePath,configFile);
  const after=await loadHostExecutionResolution(input);expect(after.plan.components.profiles).toBe(before.plan.components.profiles);
  const read=await createExecutionResolutionReader(after);await expect(read()).resolves.toMatchObject({mode:'intake'});
  const watched=after.files.find(f=>f.path===configFile)!;expect((await read.readPrivateSources!())[watched.component]).toBe(watched.expectedDigest);
 }finally{store.value.close();}
});
