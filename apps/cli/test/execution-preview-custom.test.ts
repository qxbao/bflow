import {SUPPORTED_CLI_COMMANDS} from '../src/command-reference.js';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {files} from '../../../packages/skills/test/fixtures.js';
import {initializeEnvironmentConfig,readEnvironmentConfig} from '../src/environment-config.js';
import {identifyRepository} from '../src/repository.js';
import {loadMachineSkillCatalog} from '../src/skill-catalog.js';
import {loadExecutionPreview} from '../src/execution-preview.js';
import {renderEnvironmentConfigYaml} from '../src/config-format.js';
import {buildHostPlatformOptions} from '../src/platform-options.js';
import {resolvePlatformConfiguration} from '../src/platform-resolution.js';
import {workflowPackDigest,readSkillApproval} from '@bflow/runtime';
import {runHighLevelCli} from '../src/high-level/index.js';
import {ExecutionResolutionSourcesSchema} from '@bflow/contracts';
import {loadHostExecutionResolution} from '../src/execution-preview.js';

let root:string;
beforeEach(async()=>{root=await mkdtemp('/tmp/preview-custom-');execFileSync('git',['init','--quiet',root]);await initializeEnvironmentConfig({cwd:root});vi.stubEnv('BFLOW_HOME',join(root,'machine'));});
afterEach(async()=>{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});});

it('applies locked pack settings to the inherited Developer template after resolving Coordinator defaults',async()=>{
 const repository=await identifyRepository(root);const config=await readEnvironmentConfig(repository);
 config.environment.roles=config.environment.roles.filter(role=>role.role!=='developer');
 const pack={schemaVersion:3 as const,id:'inherited-pack',version:'1',digest:'0'.repeat(64),
  defaults:{'roles.coordinator.model':'coordinator-pack','roles.developer.model':'developer-pack'},lockedFields:['roles.coordinator.model','roles.developer.model']};
 pack.digest=workflowPackDigest(pack);await writeFile(join(root,'.bflow/pack.json'),JSON.stringify(pack));
 config.environment.workflowPack={path:'.bflow/pack.json',id:pack.id,version:pack.version,digest:pack.digest};
 const resolution=await resolvePlatformConfiguration({repository,config,env:process.env});
 expect(resolution.input.config.environment.roles.find(role=>role.role==='developer')).toMatchObject({role:'developer',model:'developer-pack',required:false});
 delete (pack.defaults as Record<string,string>)['roles.developer.model'];pack.lockedFields=['roles.coordinator.model'];pack.digest=workflowPackDigest(pack);
 await writeFile(join(root,'.bflow/pack.json'),JSON.stringify(pack));config.environment.workflowPack.digest=pack.digest;
 const inherited=await resolvePlatformConfiguration({repository,config,env:process.env});
 expect(inherited.input.config.environment.roles.find(role=>role.role==='developer')?.model).toBe('coordinator-pack');
});

it('retains the tool policy transformation source when an explicit skill is omitted without its grant',async()=>{
 const repository=await identifyRepository(root);const config=await readEnvironmentConfig(repository);
 config.environment.roles.find(role=>role.role==='developer')!.skills=['using-bflow','use-context7'];
 await writeFile(join(root,'.bflow/config.yml'),renderEnvironmentConfigYaml(config));
 const preview=await loadExecutionPreview(root);
 const decision=preview.decisions.find(item=>item.field==='skills.developer')!;
 expect(decision.effective).not.toContainEqual(expect.objectContaining({skillId:'use-context7'}));
 expect(decision.source).toEqual({kind:'policy',locator:'environment.toolPolicy'});
 expect(decision.candidates).toContainEqual(expect.objectContaining({reason:'tool_policy_filter'}));
});

it('detects native profile model changes without exporting credential-bearing settings',async()=>{
 const repository=await identifyRepository(root);const config=await readEnvironmentConfig(repository);
 config.environment.roles.find(role=>role.role==='developer')!['profile-name']='preview-owner';
 await writeFile(join(root,'.bflow/config.yml'),renderEnvironmentConfigYaml(config));
 vi.stubEnv('AI_ISOLATOR_HOME',join(root,'isolator'));
 const profile=join(root,'isolator/profiles/codex--preview-owner');await mkdir(join(profile,'home/.codex'),{recursive:true});
 await writeFile(join(profile,'profile.env'),'AI_ISOLATOR_TOOL=codex\nAI_ISOLATOR_PROFILE=preview-owner\n');
 const file=join(profile,'home/.codex/config.toml');
 await writeFile(file,'model = "profile-first"\napi_key = "credential-canary-private"\n');
 const before=await loadExecutionPreview(root);
 await writeFile(file,'model = "profile-second"\napi_key = "credential-canary-private"\n');
 const after=await loadExecutionPreview(root);
 expect(after.components.profiles).not.toBe(before.components.profiles);
 expect(after.fingerprint).not.toBe(before.fingerprint);
 expect(JSON.stringify(after)).not.toContain('credential-canary-private');
});

it('hands the daemon unique validated watches and uses execution skill selection when optional tools have no grants',async()=>{
 const repository=await identifyRepository(root);const config=await readEnvironmentConfig(repository);
 const input={repository,config,env:process.env};
 const declaration=await loadHostExecutionResolution(input);
 expect(ExecutionResolutionSourcesSchema.safeParse(declaration).success).toBe(true);
 const catalog=await loadMachineSkillCatalog(input);
 const options=await buildHostPlatformOptions(input,{context:{machineId:'m-test',stateDirectory:join(root,'machine/state'),dataDirectory:join(root,'machine/data'),codexHomeDirectory:join(root,'codex'),codexProcessHomeDirectory:join(root,'home'),codexHookApprovalPath:join(root,'machine/state/hooks.json'),skills:catalog},fileExists:()=>false});
 const preview=await loadExecutionPreview(root);
 expect(preview.policy.requiredCapabilities).toContain('implementation');
 for(const role of options.roles){
  const effective=preview.decisions.find(item=>item.field===`skills.${role.role}`)?.effective as {skillId:string}[];
  expect([...effective].sort((a,b)=>a.skillId.localeCompare(b.skillId)))
   .toEqual(role.skillSelections.map(item=>item.skill).sort((a,b)=>a.skillId.localeCompare(b.skillId)));
 }
});

it('executes pinned local custom skills through the same selection and machine receipt trust checks as preview',async()=>{
 const skills=await import('../../../packages/skills/src/index.js');
 const bundle=files('local-review');
 const directory=join(root,'.bflow/local-skills/local-review');await mkdir(directory,{recursive:true});
 for(const [name,content] of Object.entries(bundle))await writeFile(join(directory,name),content);
 const definition=skills.validateSkill(bundle,{source:'repository',supportedCommands:['status']});
 const repository=await identifyRepository(root);const config=await readEnvironmentConfig(repository);
 config.environment.skills={catalogDir:'.bflow/local-skills',pins:[{skillId:definition.skillId,version:definition.version,digest:definition.digest,approvalReceiptId:'owner-skill-1'}]};
 config.environment.roles.find(role=>role.role==='developer')!.skills=['local-review'];
 await writeFile(join(root,'.bflow/config.yml'),renderEnvironmentConfigYaml(config));
 const state=join(root,'machine/state');await mkdir(state,{recursive:true,mode:0o700});
 const receiptPath=join(state,'skill-approvals.json');
 await writeFile(receiptPath,JSON.stringify({schemaVersion:3,receipts:[{approvalReceiptId:'owner-skill-1',skillId:definition.skillId,version:definition.version,digest:definition.digest,dependencies:definition.dependencies,repositoryId:repository.id,sessionId:repository.sessionName,roles:['developer'],providers:['codex'],approvedAt:'2026-01-01T00:00:00.000Z'}]}),{mode:0o600});
 expect(await readSkillApproval(receiptPath,{approvalReceiptId:'owner-skill-1',skillId:definition.skillId,version:definition.version,digest:definition.digest,dependencies:definition.dependencies,role:'developer',provider:'codex',repositoryId:repository.id,sessionId:repository.sessionName})).toBe(true);
 const input={repository,config,env:process.env};const catalog=await loadMachineSkillCatalog(input);
 const options=await buildHostPlatformOptions(input,{context:{machineId:'m-test',stateDirectory:state,dataDirectory:join(root,'machine/data'),codexHomeDirectory:join(root,'codex'),codexProcessHomeDirectory:join(root,'home'),codexHookApprovalPath:join(state,'hooks.json'),skills:catalog},fileExists:()=>false});
 expect(options.roles.find(role=>role.role==='developer')!.skillSelections).toEqual([{skill:{skillId:definition.skillId,version:definition.version,digest:definition.digest},required:true,approvalReceiptId:'owner-skill-1'}]);
 const preview=await loadExecutionPreview(root);
 expect(preview.blockers).not.toContainEqual(expect.objectContaining({code:'custom_skill_approval_unavailable'}));
 expect(preview.decisions.find(item=>item.field==='skills.developer')!.effective).toEqual([{skillId:definition.skillId,version:definition.version,digest:definition.digest}]);
 const synced=await runHighLevelCli(['skills','sync','--provider','codex','--allow-machine-scope','--json'],{cwd:root});
 expect(synced.ok,synced.stdout+synced.stderr).toBe(true);
 const manager=new skills.SkillManager({store:new skills.SkillFileStore(join(root,'machine/data/skills-store')),supportedCommands:SUPPORTED_CLI_COMMANDS,authorize:async check=>readSkillApproval(receiptPath,{approvalReceiptId:check.approvalReceiptId,skillId:check.definition.skillId,version:check.definition.version,digest:check.definition.digest,dependencies:check.definition.dependencies,role:check.role,provider:check.provider,repositoryId:repository.id,sessionId:repository.sessionName})});
 const resolved=await manager.resolve({manifestId:'custom-test',environmentId:'custom-environment',scope:{kind:'session',machineId:'m-test',repositoryId:repository.id,workspaceRoot:root,sessionId:repository.sessionName},role:'developer',provider:'codex',capabilityIds:[],toolIds:[],selections:options.roles.find(role=>role.role==='developer')!.skillSelections});
 expect(resolved.manifest.skills.map(item=>item.skillId)).toEqual(['local-review']);
 await writeFile(join(directory,'SKILL.md'),bundle['SKILL.md']+'\nChanged instructions.\n');
 await expect(loadExecutionPreview(root)).rejects.toThrow();
});

it('uses pinned pack defaults and locks in execution and preview, retaining source and governed roles',async()=>{
 const repository=await identifyRepository(root);const config=await readEnvironmentConfig(repository);
 const developer=config.environment.roles.find(role=>role.role==='developer')!;developer.model='project-model';
 const pack={schemaVersion:3 as const,id:'quality-pack',version:'1.0.0',digest:'0'.repeat(64),defaults:{'roles.developer.model':'pack-model','roles.developer.profile':'native-specialist'},lockedFields:['roles.developer.model']};
 pack.digest=workflowPackDigest(pack);await writeFile(join(root,'.bflow/pack.json'),JSON.stringify(pack));
 config.environment.workflowPack={path:'.bflow/pack.json',id:pack.id,version:pack.version,digest:pack.digest};
 await writeFile(join(root,'.bflow/config.yml'),renderEnvironmentConfigYaml(config));
 const input={repository,config,env:process.env};const resolution=await resolvePlatformConfiguration(input);
 expect(resolution.input.config.environment.roles.find(role=>role.role==='developer')).toMatchObject({role:'developer',model:'pack-model','profile-name':'native-specialist'});
 const preview=await loadExecutionPreview(root);
 const decision=preview.decisions.find(item=>item.field==='roles.developer.model')!;
 expect(decision).toMatchObject({effective:'pack-model',source:{kind:'pack',locator:'pack'}});
 expect(decision.candidates).toContainEqual(expect.objectContaining({value:'project-model',status:'rejected'}));
 const catalog=await loadMachineSkillCatalog(input);
 const options=await buildHostPlatformOptions(input,{context:{machineId:'m-test',stateDirectory:'/state',dataDirectory:'/data',codexHomeDirectory:'/codex',codexProcessHomeDirectory:'/home',codexHookApprovalPath:'/state/hooks.json',skills:catalog},fileExists:()=>false});
 expect(options.roles.find(role=>role.role==='developer')).toMatchObject({role:'developer',model:'pack-model',profileName:'native-specialist'});
 const bad={...config,environment:{...config.environment,workflowPack:{...config.environment.workflowPack!,digest:'f'.repeat(64)}}};
 await expect(buildHostPlatformOptions({...input,config:bad},{context:{machineId:'m-test',stateDirectory:'/state',dataDirectory:'/data',codexHomeDirectory:'/codex',codexProcessHomeDirectory:'/home',codexHookApprovalPath:'/state/hooks.json',skills:catalog}})).rejects.toThrow();
});

it('resolves a role-fallback config against the disk config it was derived from, and still rejects unexplained divergence',async()=>{
 const repository=await identifyRepository(root);const config=await readEnvironmentConfig(repository);
 const derived={...config,environment:{...config.environment,roles:config.environment.roles.filter(role=>role.role!=='qa')}};
 const full=await loadHostExecutionResolution({repository,config,env:process.env});
 expect(full.plan.decisions.some(item=>item.field.startsWith('roles.qa.'))).toBe(true);
 const declaration=await loadHostExecutionResolution({repository,config:derived,sourceConfig:config,env:process.env});
 expect(declaration.plan.decisions.some(item=>item.field.startsWith('roles.qa.'))).toBe(false);
 await expect(loadHostExecutionResolution({repository,config:derived,env:process.env})).rejects.toThrow('Execution configuration changed before resolution');
});
