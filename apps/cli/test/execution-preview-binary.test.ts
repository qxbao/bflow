import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtemp, rm, writeFile, readFile, readdir, realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeEnvironmentConfig,readEnvironmentConfig} from '../src/environment-config.js';
import {identifyRepository} from '../src/repository.js';
import {loadExecutionPreview} from '../src/execution-preview.js';
import {prepareExecutionExpectation} from '../src/execution-expectation.js';
import {renderEnvironmentConfigYaml} from '../src/config-format.js';
import {runHighLevelCli} from '../src/high-level/index.js';
import type {HighLevelServices} from '../src/high-level/services.js';

let root:string;
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),'preview-binary-')));execFileSync('git',['init','--quiet',root]);await initializeEnvironmentConfig({cwd:root});});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
function binary(args:string[]){return spawnSync(process.execPath,[resolve('apps/cli/dist/bin.js'),...args],{cwd:root,encoding:'utf8',env:{...process.env,HOME:join(root,'home'),BFLOW_HOME:join(root,'machine')}});}

it('built binary displays intake JSON/text and malformed compare without creating state',async()=>{
 const before=await readdir(root);
 const json=binary(['task','preview','--json']);
 expect(json.status,json.stderr).toBe(0);
 const value=JSON.parse(json.stdout);
 expect(value.command).toBe('task.preview');
 expect(value.result.output.data.plan.mode).toBe('intake');
 expect(value.result.output.data.plan.accepted).toBeUndefined();
 expect(value.result.output.data.plan.policy.explanations).toContainEqual(expect.objectContaining({
  field:'gates',source:{kind:'builtin',locator:'host-check-policy'},reasonCode:'mandatory_host_checks'
 }));
 const human=binary(['task','preview']).stdout;
 expect(human).toContain('Fingerprint:');
 expect(human).toContain('Gates:');
 expect(human).toContain('Conditional TDD: unresolved');
 expect(human).toContain('Why gates: mandatory_host_checks (builtin: host-check-policy)');
 expect(human).toContain('Why approvalPoints: project_governance_policy (project: environment.sdd.approvalRequired)');
 expect(human).toContain('Readiness:');
 await writeFile(join(root,'bad.json'),JSON.stringify({schemaVersion:999,secret:'sk-canary-preview-value'}));
 const invalid=binary(['task','preview','--compare','bad.json','--json']);
 expect(invalid.status).not.toBe(0);expect(invalid.stdout+invalid.stderr).not.toContain('sk-canary-preview-value');
 expect((await readdir(root)).filter(item=>item!=='bad.json')).toEqual(before);
});

it('keeps all mutation/probe ports unreachable in successful preview',async()=>{
 const forbidden=vi.fn(()=>{throw new Error('FORBIDDEN preview effect');});
 const services={machine:{platform:forbidden,runner:forbidden},providers:{check:forbidden},specification:{parse:forbidden},strategy:{resolve:forbidden},openResources:forbidden,openRuntime:forbidden,verification:forbidden,skills:forbidden} as unknown as HighLevelServices;
 const result=await runHighLevelCli(['task','preview','--json'],{cwd:root,services});
 expect(result.ok,result.stderr).toBe(true);expect(forbidden).not.toHaveBeenCalled();
});

it('saved preview expectation detects meaningful drift before creating a lock or host state',async()=>{
 const plan=await loadExecutionPreview(root);await writeFile(join(root,'.bflow/preview.json'),JSON.stringify(plan));
 const guard=await prepareExecutionExpectation(root,'.bflow/preview.json');await guard();
 const repository=await identifyRepository(root);const config=await readEnvironmentConfig(repository);
 config.environment.roles.find(role=>role.role==='coordinator')!.model='changed-model';
 await writeFile(join(root,'.bflow/config.yml'),renderEnvironmentConfigYaml(config));
 await expect(guard()).rejects.toMatchObject({contractError:{code:'conflict',details:{reason:'execution_plan_drift',diff:{changed:true}}}});
 const before=await readdir(root);
 const up=binary(['up','--expect-plan','.bflow/preview.json','--json']);
 expect(up.status).not.toBe(0);expect(up.stdout+up.stderr).toContain('execution_plan_drift');
 expect(await readdir(root)).toEqual(before);
});

it('does not leak secret canaries from invalid role selections in JSON or text',async()=>{
 const path=join(root,'.bflow/config.yml');const config=await readEnvironmentConfig(await identifyRepository(root));
 config.environment.roles[0]!.cli='sk-canary-preview-value';
 await writeFile(path,renderEnvironmentConfigYaml(config));
 for(const flags of [[],['--json']]){const out=binary(['task','preview',...flags]);expect(out.status).not.toBe(0);expect(out.stdout+out.stderr).not.toContain('sk-canary-preview-value');}
});

it('names a moved or copied repository configuration instead of a generic invalid-input error',async()=>{
 const path=join(root,'.bflow/config.yml');
 await writeFile(path,(await readFile(path,'utf8')).replace(/repositoryId: [a-f0-9]{64}/,`repositoryId: ${'a'.repeat(64)}`));
 for(const flags of [[],['--json']]){
  const out=binary(['task','preview',...flags]);
  expect(out.status).not.toBe(0);
  expect(out.stdout+out.stderr).toContain('Configuration belongs to another repository or was moved');
 }
 const json=JSON.parse(binary(['task','preview','--json']).stdout);
 expect(json.result.error.details).toEqual({reason:'repository_identity_mismatch'});
});

it('fingerprints verification invocation changes even when command identities stay the same',async()=>{
 const path=join(root,'.bflow/verification.json');
 const command={id:'unit',command:'node --test',executable:process.execPath,args:['--test','test/first.test.js'],method:'unit_test',levels:['unit'],testNames:['example'],testPaths:['test/first.test.js'],timeoutMs:1000};
 await writeFile(path,JSON.stringify({schemaVersion:1,behavioralCommands:[command]}));
 const before=binary(['task','preview','--json']);expect(before.status,before.stdout+before.stderr).toBe(0);
 const a=JSON.parse(before.stdout).result.output.data.plan;
 command.args=['--test','test/second.test.js'];
 await writeFile(path,JSON.stringify({schemaVersion:1,behavioralCommands:[command]}));
 const after=binary(['task','preview','--json']);expect(after.status,after.stdout+after.stderr).toBe(0);
 const b=JSON.parse(after.stdout).result.output.data.plan;
 expect(b.components.ownerVerification).not.toBe(a.components.ownerVerification);
 expect(b.fingerprint).not.toBe(a.fingerprint);
});

it('checks actual Runtime resolution before launch when preflight resolves a previously unknown tool skill',async()=>{
 const runtime=await import('@bflow/runtime');const {loadMachineSkillCatalog}=await import('../src/skill-catalog.js');
 const repository=await identifyRepository(root);const config=await readEnvironmentConfig(repository);
 const catalog=await loadMachineSkillCatalog({repository,config,env:process.env});
 const skill=catalog.definitions.find(item=>item.skillId==='use-context7')!;
 const before=await loadExecutionPreview(root);await writeFile(join(root,'.bflow/preview.json'),JSON.stringify(before));
 const {fingerprint:_,...actual}=before;
 const decision=actual.decisions.find(item=>item.field==='skills.developer')!;
 decision.effective=[...(decision.effective as object[]),{skillId:skill.skillId,version:skill.version,digest:skill.digest}] as never;
 const guard=await prepareExecutionExpectation(root,'.bflow/preview.json');
 await expect(guard(actual)).rejects.toMatchObject({contractError:{details:{reason:'execution_plan_drift',currentPlan:{fingerprint:expect.any(String)}}}});
 const resolved=runtime.buildExecutionPlan(actual);await writeFile(join(root,'.bflow/resolved.json'),JSON.stringify(resolved));
 const retry=await prepareExecutionExpectation(root,'.bflow/resolved.json');
 expect(()=>retry.assertResolved()).toThrow();
 await retry(actual);expect(()=>retry.assertResolved()).not.toThrow();
});

it('blocked required tools retain requirement sources without contacting machine ports',async()=>{
 const repository=await identifyRepository(root);const config=await readEnvironmentConfig(repository);
 config.environment.tools={rtk:{enabled:true,required:true},gitnexus:{enabled:false},mempalace:{enabled:false},'chrome-devtools-mcp':{enabled:false}};
 config.environment.context7={enabled:false};
 await writeFile(join(root,'.bflow/config.yml'),renderEnvironmentConfigYaml(config));
 const before=await readdir(root);
 const forbidden=vi.fn(()=>{throw new Error('FORBIDDEN blocked preview effect');});
 const services={machine:{platform:forbidden,runner:forbidden},providers:{check:forbidden},specification:{parse:forbidden},strategy:{resolve:forbidden},openResources:forbidden,openRuntime:forbidden,verification:forbidden,skills:forbidden} as unknown as HighLevelServices;
 vi.stubEnv('BFLOW_HOME',join(root,'missing-machine'));
 try{
  const result=await runHighLevelCli(['task','preview','--json'],{cwd:root,services});
  expect(result.exitCode).toBe(3);expect(forbidden).not.toHaveBeenCalled();
  const data=JSON.parse(result.stdout).result.output.data;
  expect(data.plan.blockers).toContainEqual(expect.objectContaining({code:'required_tool_pin_missing',source:{kind:'project',locator:'environment.toolPolicy.requirements.rtk'}}));
  expect(data.plan.decisions.find((item:{field:string})=>item.field==='tools.required').effective).toContain('rtk');
  expect(await readdir(root)).toEqual(before);
 }finally{vi.unstubAllEnvs();}
});
