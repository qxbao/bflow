import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createWebProjectSettings } from '../src/web-project-settings.js';
import { initializeEnvironmentConfig } from '../src/environment-config.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(config=true){
 const root=await mkdtemp(join(tmpdir(),'web-settings-'));roots.push(root);execFileSync('git',['init','-q',root]);
 if(config)await initializeEnvironmentConfig({cwd:root});
 const p={apiVersion:1 as const,projectId:'project-'+createHash('sha256').update(root).digest('hex').slice(0,32),canonicalPath:root,displayName:'sample',registrationState:'registered' as const};
 const prepare=vi.fn(async()=>({status:'ready',indexed:true,registered:true,gatewayReady:true,diagnostics:[]}));
 const options={resolveProject:async()=>p,receiptDirectory:join(root,'receipts'),prepareGitNexus:prepare};
 return {root,p,prepare,options,service:createWebProjectSettings(options)};
}
it('initializes an unconfigured registered repository and never replays an operation ID',async()=>{
 const f=await fixture(false),request={apiVersion:1 as const,operationId:randomUUID(),acceptGitNexusLicense:true,update:false};
 expect(await f.service.initializeProject(f.p.projectId,request)).toMatchObject({ok:true,value:{state:'running'}});
 await Promise.all(f.service.pending());
 expect(await f.service.readInitialization(f.p.projectId,request.operationId)).toMatchObject({ok:true,value:{state:'succeeded'}});
 expect(await f.service.initializeProject(f.p.projectId,request)).toMatchObject({ok:true,value:{state:'succeeded'}});
 expect(f.prepare).toHaveBeenCalledOnce();expect(await readFile(join(f.root,'.bflow/config.yml'),'utf8')).toContain('conversation');
});
it('requires license approval and preserves the existing config on repair',async()=>{
 const f=await fixture(),path=join(f.root,'.bflow/config.yml'),before=await readFile(path,'utf8');
 expect(await f.service.initializeProject(f.p.projectId,{apiVersion:1,operationId:randomUUID(),acceptGitNexusLicense:false,update:false})).toMatchObject({ok:false});
 expect(f.prepare).not.toHaveBeenCalled();
 const request={apiVersion:1 as const,operationId:randomUUID(),acceptGitNexusLicense:true,update:false};
 await f.service.initializeProject(f.p.projectId,request);await Promise.all(f.service.pending());expect(await readFile(path,'utf8')).toBe(before);
});
it('validates before an atomic save and refuses stale revisions',async()=>{
 const f=await fixture(),initial=await f.service.readConfiguration(f.p.projectId);if(!initial.ok)throw Error('missing');
 const bad=await f.service.saveConfiguration(f.p.projectId,{apiVersion:1,expectedRevision:initial.value.revision,yaml:'bad: yaml'});
 expect(bad).toMatchObject({ok:false});expect((await f.service.readConfiguration(f.p.projectId))).toEqual(initial);
 const yaml=initial.value.yaml.replace('maxConcurrency: 2','maxConcurrency: 3').replace('projectName:','projectName:');
 const saved=await f.service.saveConfiguration(f.p.projectId,{apiVersion:1,expectedRevision:initial.value.revision,yaml:yaml+'\n# retained comment\n'});expect(saved).toMatchObject({ok:true});
 expect(await f.service.saveConfiguration(f.p.projectId,{apiVersion:1,expectedRevision:initial.value.revision,yaml})).toMatchObject({ok:false,error:{code:'conflict'}});
});
it('rejects symlinked configuration and foreign resolver identities',async()=>{
 const f=await fixture(),path=join(f.root,'.bflow/config.yml'),original=await readFile(path,'utf8');await rm(path);await writeFile(join(f.root,'outside.yml'),original);await symlink(join(f.root,'outside.yml'),path);
 expect(await f.service.readConfiguration(f.p.projectId)).toMatchObject({ok:false});
 const service=createWebProjectSettings({...f.options,resolveProject:async()=>({...f.p,projectId:'foreign'})});expect(await service.readConfiguration(f.p.projectId)).toMatchObject({ok:false});
});
it('retains untouched role comments while editing a model in the form',async()=>{
 const f=await fixture(),path=join(f.root,'.bflow/config.yml');let yaml=await readFile(path,'utf8');yaml=yaml.replace('role: coordinator','role: coordinator # owner coordinator comment');await writeFile(path,yaml);
 const snapshot=await f.service.readConfiguration(f.p.projectId);if(!snapshot.ok)throw Error();
 const values=structuredClone(snapshot.value.values),env=values.environment as any;env.roles[0].model='haiku';
 const saved=await f.service.saveConfiguration(f.p.projectId,{apiVersion:1,expectedRevision:snapshot.value.revision,values});expect(saved).toMatchObject({ok:true});expect(await readFile(path,'utf8')).toContain('# owner coordinator comment');
});
it('keeps large UTF-8 diagnostics readable and refuses changed input for an existing ID',async()=>{
 const f=await fixture();const s=createWebProjectSettings({...f.options,prepareGitNexus:async()=>({status:'blocked',diagnostics:['ắ'.repeat(16000)]})});
 const request={apiVersion:1 as const,operationId:randomUUID(),acceptGitNexusLicense:true,update:false};await s.initializeProject(f.p.projectId,request);await Promise.all(s.pending());
 expect(await s.readInitialization(f.p.projectId,request.operationId)).toMatchObject({ok:true,value:{state:'failed'}});
 expect(await s.initializeProject(f.p.projectId,{...request,update:true})).toMatchObject({ok:false,error:{code:'conflict'}});
});
it('blocks unregister while init runs or is interrupted, without replay after restart',async()=>{
 const f=await fixture();let finish!:(v:any)=>void;const prepare=vi.fn(()=>new Promise<any>(resolve=>{finish=resolve;}));const options={...f.options,prepareGitNexus:prepare},s=createWebProjectSettings(options);
 const request={apiVersion:1 as const,operationId:randomUUID(),acceptGitNexusLicense:true,update:false};await s.initializeProject(f.p.projectId,request);
 await vi.waitFor(()=>expect(prepare).toHaveBeenCalledOnce());
 expect(await s.projectMutationStatus(f.p.projectId)).toMatchObject({ok:true,value:{initializationPending:true}});
 const restarted=createWebProjectSettings(options);expect(await restarted.readInitialization(f.p.projectId,request.operationId)).toMatchObject({ok:true,value:{state:'interrupted'}});
 expect(await restarted.initializeProject(f.p.projectId,request)).toMatchObject({ok:true,value:{state:'interrupted'}});expect(prepare).toHaveBeenCalledOnce();
 expect(await restarted.projectMutationStatus(f.p.projectId)).toMatchObject({ok:true,value:{initializationPending:true}});
 finish({status:'ready',diagnostics:[]});await Promise.all(s.pending());expect(await s.projectMutationStatus(f.p.projectId)).toMatchObject({ok:true,value:{initializationPending:false}});
});
it('reports a missing receipt distinctly and supports initialization without GitNexus',async()=>{
 const f=await fixture(false);expect(await f.service.readInitialization(f.p.projectId,randomUUID())).toMatchObject({ok:false,error:{code:'not_found'}});
 await f.service.initializeProject(f.p.projectId,{apiVersion:1,operationId:randomUUID(),acceptGitNexusLicense:false,skipGitNexus:true,update:false});await Promise.all(f.service.pending());
 expect(f.prepare).not.toHaveBeenCalled();const result=await f.service.readConfiguration(f.p.projectId);expect(result).toMatchObject({ok:true,value:{values:{environment:{tools:{gitnexus:{enabled:false}}}}}});
});
it('explicit update rebinds a cloned configuration while preserving role model choices',async()=>{
 const f=await fixture(),path=join(f.root,'.bflow/config.yml'),snapshot=await f.service.readConfiguration(f.p.projectId);if(!snapshot.ok)throw Error();
 const {stringifyConfigYaml}=await import('../src/config-format.js');const values=snapshot.value.values,env=values.environment as any;env.workspaceRoot='/previous/repository';env.sessionName='previous-session';env.roles[0].model='haiku';await writeFile(path,stringifyConfigYaml(values));
 const request={apiVersion:1 as const,operationId:randomUUID(),acceptGitNexusLicense:true,update:true};
 await f.service.initializeProject(f.p.projectId,request);await Promise.all(f.service.pending());
 expect(await f.service.readInitialization(f.p.projectId,request.operationId)).toMatchObject({ok:true,value:{state:'succeeded'}});
 const result=await f.service.readConfiguration(f.p.projectId);expect(result).toMatchObject({ok:true,value:{values:{environment:{workspaceRoot:f.root,roles:expect.arrayContaining([expect.objectContaining({role:'conversation',model:'haiku'})])}}}});
});
it('commits only reviewed configuration, preserves other files and never runs repository hooks',async()=>{
 const f=await fixture();execFileSync('git',['-C',f.root,'config','user.name','Web settings test']);execFileSync('git',['-C',f.root,'config','user.email','web-settings@localhost']);
 const {chmod}=await import('node:fs/promises');const hook=join(f.root,'.git/hooks/pre-commit'),sentinel=join(f.root,'hook-ran');await writeFile(hook,'#!/bin/sh\ntouch "'+sentinel+'"\nexit 31\n');await chmod(hook,0o700);
 await writeFile(join(f.root,'application.ts'),'export const untouched = true;\n');
 const initial=await f.service.readConfiguration(f.p.projectId);if(!initial.ok)throw Error();
 const request={apiVersion:1 as const,operationId:randomUUID(),acceptGitNexusLicense:true,update:false,commitConfiguration:true,expectedConfigurationRevision:initial.value.revision};
 await f.service.initializeProject(f.p.projectId,request);await Promise.all(f.service.pending());expect(await f.service.readInitialization(f.p.projectId,request.operationId)).toMatchObject({ok:true,value:{state:'succeeded'}});
 expect(execFileSync('git',['-C',f.root,'show','--pretty=format:','--name-only','HEAD'],{encoding:'utf8'}).trim().split('\n').sort()).toEqual(['.bflow/.gitignore','.bflow/config.yml']);
 expect(await readFile(join(f.root,'application.ts'),'utf8')).toBe('export const untouched = true;\n');expect(await readFile(sentinel).then(()=>true,()=>false)).toBe(false);
 const head=execFileSync('git',['-C',f.root,'rev-parse','HEAD'],{encoding:'utf8'});
 await f.service.initializeProject(f.p.projectId,{...request,operationId:randomUUID()});await Promise.all(f.service.pending());expect(execFileSync('git',['-C',f.root,'rev-parse','HEAD'],{encoding:'utf8'})).toBe(head);
});
it('refuses a config commit with other staged files or a stale reviewed revision',async()=>{
 const f=await fixture(),initial=await f.service.readConfiguration(f.p.projectId);if(!initial.ok)throw Error();
 await writeFile(join(f.root,'application.ts'),'user work');execFileSync('git',['-C',f.root,'add','application.ts']);
 const request={apiVersion:1 as const,operationId:randomUUID(),acceptGitNexusLicense:true,update:false,commitConfiguration:true,expectedConfigurationRevision:initial.value.revision};
 await f.service.initializeProject(f.p.projectId,request);await Promise.all(f.service.pending());expect(await f.service.readInitialization(f.p.projectId,request.operationId)).toMatchObject({ok:true,value:{state:'failed',message:expect.stringContaining('staged')}});
 expect(execFileSync('git',['-C',f.root,'diff','--cached','--name-only'],{encoding:'utf8'}).trim()).toBe('application.ts');
 const stale={...request,operationId:randomUUID(),expectedConfigurationRevision:'b'.repeat(64)};await f.service.initializeProject(f.p.projectId,stale);await Promise.all(f.service.pending());expect(await f.service.readInitialization(f.p.projectId,stale.operationId)).toMatchObject({ok:true,value:{state:'failed',message:expect.stringContaining('Cấu hình đã đổi')}});
 expect(f.prepare).not.toHaveBeenCalled();
});
it('rejects executable clean filters before Git status/add can execute them',async()=>{
 const f=await fixture();execFileSync('git',['-C',f.root,'config','user.name','Web settings test']);execFileSync('git',['-C',f.root,'config','user.email','web-settings@localhost']);
 const sentinel=join(f.root,'filter-ran');await writeFile(join(f.root,'.gitattributes'),'.bflow/config.yml filter=web-probe\n');execFileSync('git',['-C',f.root,'config','filter.web-probe.clean','touch "'+sentinel+'"; cat']);
 const initial=await f.service.readConfiguration(f.p.projectId);if(!initial.ok)throw Error();
 const request={apiVersion:1 as const,operationId:randomUUID(),acceptGitNexusLicense:true,update:false,commitConfiguration:true,expectedConfigurationRevision:initial.value.revision};
 await f.service.initializeProject(f.p.projectId,request);await Promise.all(f.service.pending());
 expect(await f.service.readInitialization(f.p.projectId,request.operationId)).toMatchObject({ok:true,value:{state:'failed',message:expect.stringContaining('filter')}});
 expect(await readFile(sentinel).then(()=>true,()=>false)).toBe(false);expect(f.prepare).not.toHaveBeenCalled();
});
it('rejects disabling GitNexus and committing an enabled reviewed config before modifying it',async()=>{
 const f=await fixture(),initial=await f.service.readConfiguration(f.p.projectId);if(!initial.ok)throw Error();
 const request={apiVersion:1 as const,operationId:randomUUID(),acceptGitNexusLicense:false,skipGitNexus:true,update:false,commitConfiguration:true,expectedConfigurationRevision:initial.value.revision};
 await f.service.initializeProject(f.p.projectId,request);await Promise.all(f.service.pending());expect(await f.service.readInitialization(f.p.projectId,request.operationId)).toMatchObject({ok:true,value:{state:'failed'}});
 expect(await f.service.readConfiguration(f.p.projectId)).toEqual(initial);
});
it('commits already-disabled GitNexus config without rewriting the reviewed revision',async()=>{
 const f=await fixture();execFileSync('git',['-C',f.root,'config','user.name','Web settings test']);execFileSync('git',['-C',f.root,'config','user.email','web-settings@localhost']);
 const initial=await f.service.readConfiguration(f.p.projectId);if(!initial.ok)throw Error();const values=initial.value.values;(values.environment as any).tools.gitnexus.enabled=false;
 const saved=await f.service.saveConfiguration(f.p.projectId,{apiVersion:1,expectedRevision:initial.value.revision,values});if(!saved.ok)throw Error();
 const request={apiVersion:1 as const,operationId:randomUUID(),acceptGitNexusLicense:false,skipGitNexus:true,update:false,commitConfiguration:true,expectedConfigurationRevision:saved.value.revision};
 await f.service.initializeProject(f.p.projectId,request);await Promise.all(f.service.pending());expect(await f.service.readInitialization(f.p.projectId,request.operationId)).toMatchObject({ok:true,value:{state:'succeeded',message:expect.stringContaining('Đã commit')}});
 expect((await f.service.readConfiguration(f.p.projectId))).toEqual(saved);
});

it('preserves proof of a completed config commit when later indexing fails',async()=>{
 const f=await fixture();execFileSync('git',['-C',f.root,'config','user.name','Web settings test']);execFileSync('git',['-C',f.root,'config','user.email','web-settings@localhost']);
 const initial=await f.service.readConfiguration(f.p.projectId);if(!initial.ok)throw Error();
 const service=createWebProjectSettings({...f.options,prepareGitNexus:async()=>{throw Error('index backend disconnected');}});
 const request={apiVersion:1 as const,operationId:randomUUID(),acceptGitNexusLicense:true,update:false,commitConfiguration:true,expectedConfigurationRevision:initial.value.revision};
 await service.initializeProject(f.p.projectId,request);await Promise.all(service.pending());
 const result=await service.readInitialization(f.p.projectId,request.operationId);expect(result).toMatchObject({ok:true,value:{state:'failed',message:expect.stringContaining('Đã commit cấu hình Bflow:')}});
 if(!result.ok)throw Error();expect(result.value.message).toContain('index backend disconnected');
});
it('pins local Git ignore rules together with the configuration revision',async()=>{
 const f=await fixture(),initial=await f.service.readConfiguration(f.p.projectId);if(!initial.ok)throw Error();
 expect(initial.value.gitIgnore).toContain('state/');await writeFile(join(f.root,'.bflow/.gitignore'),'# changed after review\n');
 expect(await f.service.saveConfiguration(f.p.projectId,{apiVersion:1,expectedRevision:initial.value.revision,yaml:initial.value.yaml})).toMatchObject({ok:false,error:{code:'conflict'}});
});
