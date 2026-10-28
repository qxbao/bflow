import { describe, expect, it, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { interactionProjectId } from '@bflow/runtime';
import { createWebWorkspaceServices } from '../src/web-workspace-services.js';
import { initializeEnvironmentConfig } from '../src/environment-config.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function project(config=true){const root=await mkdtemp(join(tmpdir(),'web-lifecycle '));roots.push(root);execFileSync('git',['init','--quiet',root]);if(config)await initializeEnvironmentConfig({cwd:root});return {apiVersion:1 as const,projectId:interactionProjectId(root),canonicalPath:root,displayName:'repo',registrationState:'registered' as const};}
describe('web workspace lifecycle',()=>{
 it('missing configuration has explicit remediation and never initializes files',async()=>{
  const p=await project(false),before=await readdir(p.canonicalPath);const s=createWebWorkspaceServices({resolveProject:async()=>p});
  const result=await s.startSession(p.projectId,randomUUID());expect(result).toMatchObject({ok:false,error:{code:'validation'}});if(!result.ok)expect(result.error.message).toMatch(/bflow init.*bflow setup/);expect(await readdir(p.canonicalPath)).toEqual(before);
 });
 it('refuses a resolver whose registered canonical identity differs',async()=>{
  const p=await project();const lifecycle=vi.fn();const s=createWebWorkspaceServices({resolveProject:async()=>({...p,projectId:'other'}),createLifecycle:lifecycle});
  expect(await s.startSession(p.projectId,randomUUID())).toMatchObject({ok:false});expect(lifecycle).not.toHaveBeenCalled();
 });
 it('does not resend an uncertain operation, even if lifecycle now appears ready or stopped',async()=>{
  const p=await project();const lifecycle=vi.fn();const s=createWebWorkspaceServices({resolveProject:async()=>p,createLifecycle:lifecycle});
  for(const operationKind of ['session_start','session_stop'] as const){const op={apiVersion:1 as const,operationId:randomUUID(),projectId:p.projectId,owner:'local_lifecycle' as const,operationKind,state:'reconciliation_required' as const,updatedAt:new Date().toISOString()};
   expect(await s.reconcileSessionOperation(op)).toEqual({ok:true,value:op});}
  expect(lifecycle).not.toHaveBeenCalled();
 });
 it('passes start through lifecycle preflight and returns only activated host health',async()=>{
  const p=await project();const up=vi.fn(async()=>({}));const readSession=vi.fn(async()=>({ok:true,value:{apiVersion:1,projectId:p.projectId,state:'ready',sessionId:'session',pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()}}));
  const s=createWebWorkspaceServices({resolveProject:async()=>p,createLifecycle:()=>({up,down:vi.fn(),doctor:vi.fn()}),readSession});
  expect(await s.startSession(p.projectId,randomUUID())).toMatchObject({ok:true,value:{state:'ready'}});expect(up).toHaveBeenCalledOnce();expect(readSession).toHaveBeenCalledOnce();
 });
 it('lost activated health remains uncertain after successful lifecycle start',async()=>{
  const p=await project();const s=createWebWorkspaceServices({resolveProject:async()=>p,createLifecycle:()=>({up:async()=>({}),down:vi.fn(),doctor:vi.fn()}),readSession:async()=>({ok:true,value:{apiVersion:1,projectId:p.projectId,state:'unavailable',pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()}})});
  expect(await s.startSession(p.projectId,randomUUID())).toMatchObject({ok:false,error:{code:'transport_unavailable'}});
 });
 it('uses confirmed orderly down with no force bypass',async()=>{
  const p=await project();const down=vi.fn(async()=>({status:'down'}));const s=createWebWorkspaceServices({resolveProject:async()=>p,createLifecycle:()=>({up:vi.fn(),down,doctor:vi.fn()})});
  expect(await s.stopSession(p.projectId,randomUUID())).toMatchObject({ok:true,value:{state:'stopped'}});expect(down).toHaveBeenCalledWith(true,undefined,false);
 });
 it('inspect uses shallow doctor without model diagnostics or setup',async()=>{
  const p=await project();const doctor=vi.fn(async()=>({schemaVersion:2,workspaceRoot:p.canonicalPath,sessionId:'test',healthy:false,checkedAt:new Date().toISOString(),checks:[{checkId:'missing',name:'missing',status:'failed',message:'Run bflow setup --check'}]}));
  const s=createWebWorkspaceServices({resolveProject:async()=>p,createLifecycle:()=>({up:vi.fn(),down:vi.fn(),doctor})});expect(await s.inspectProject(p.projectId)).toMatchObject({ok:true,value:{ready:false}});expect(doctor).toHaveBeenCalledWith(false);
 });
});
