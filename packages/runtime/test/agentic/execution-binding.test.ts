import { mkdtemp, writeFile, rm, readdir, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionResolutionReader, readAcceptedExecutionPlanInput } from '../../src/agentic/execution-binding.js';
const roots:string[]=[];
afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'bflow-plan-bind-'));roots.push(root);const path=join(root,'config.json');await writeFile(path,'{"model":"a","nested":{"x":1}}');return {root,path};}
const plan={schemaVersion:3,resolverVersion:'1',policyVersion:'1',repository:{revision:'abc'},mode:'intake'};
describe('execution resolution source revalidation',()=>{
 it('reads current files before each effect and stops config drift with a sourced diff',async()=>{
  const {path}=await fixture();const reader=await createExecutionResolutionReader({schemaVersion:3,plan,files:[{component:'project-config',path,format:'json'}]});
  await reader();await writeFile(path,'{"model":"b"}');const effect=vi.fn();
  await expect(reader().then(effect)).rejects.toMatchObject({code:'execution_plan_drift',diff:{changed:true,changes:[expect.objectContaining({field:'inputs.project-config',reason:'source_changed_re_resolution_required',afterSource:{kind:'project',locator:'execution-source'}})]}});expect(effect).not.toHaveBeenCalled();
 });
 it('normalizes JSON formatting/key order but detects skill/profile byte changes without disclosing their content',async()=>{
  const {path}=await fixture();const reader=await createExecutionResolutionReader({schemaVersion:3,plan,files:[{component:'profile',path,format:'json'}]});
  await writeFile(path,'{ "nested": {"x":1}, "model":"a" }');await expect(reader()).resolves.toMatchObject({mode:'intake'});
  await writeFile(path,'{"password":"secret-canary"}');try{await reader();throw Error('expected drift');}catch(e){expect(JSON.stringify(e)).not.toContain('secret-canary');expect(JSON.stringify(e)).not.toContain(path);}
 });
 it('fails closed on deleted/symlinked sources and writes no state while reading',async()=>{
  const {root,path}=await fixture();const reader=await createExecutionResolutionReader({schemaVersion:3,plan,files:[{component:'skill',path,format:'bytes'}]});const before=await readdir(root);await reader();expect(await readdir(root)).toEqual(before);await rm(path);await symlink('/dev/null',path);await expect(reader()).rejects.toMatchObject({code:'execution_plan_drift'});
 });
 it('reads missing accepted state without creating directories, locks or stores',async()=>{
  const {root}=await fixture();const before=await readdir(root);expect(await readAcceptedExecutionPlanInput(root,'run-1')).toBeNull();expect(await readdir(root)).toEqual(before);
 });
});
it('binds caller-provided private digests before use and notices optional missing sources appearing',async()=>{
 const {root,path}=await fixture();
 await expect(createExecutionResolutionReader({schemaVersion:3,plan,files:[{component:'profile',path,format:'json',expectedDigest:'f'.repeat(64)}]})).rejects.toMatchObject({code:'execution_plan_drift'});
 const optional=join(root,'optional.json');
 const read=await createExecutionResolutionReader({schemaVersion:3,plan,files:[{component:'profile-optional',path:optional,format:'json',optional:true}]});
 await read();await writeFile(optional,'{}');await expect(read()).rejects.toMatchObject({code:'execution_plan_drift'});
});
