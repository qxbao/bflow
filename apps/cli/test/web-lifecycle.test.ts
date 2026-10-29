import { describe, expect, it, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { interactionProjectId } from '@bflow/runtime';
import { createWebWorkspaceServices } from '../src/web-workspace-services.js';
import { initializeEnvironmentConfig } from '../src/environment-config.js';
import { EnvironmentLifecycle, markStartupUnchanged, startupLeftSessionUnchanged } from '../src/environment.js';
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
it('recovers correlated lifecycle results after service restart without a host or resend',async()=>{
 const p=await project(),receiptDirectory=join(p.canonicalPath,'private web receipts');const up=vi.fn(async()=>({}));const down=vi.fn(async()=>({status:'down'}));
 const readSession=async()=>({ok:true as const,value:{apiVersion:1 as const,projectId:p.projectId,sessionId:'session',state:'ready' as const,pendingIntakes:[],blockers:[],updatedAt:new Date().toISOString()}});
 const options={resolveProject:async()=>p,receiptDirectory,createLifecycle:()=>({up,down,doctor:vi.fn()}),readSession};
 const first=createWebWorkspaceServices(options),id=crypto.randomUUID();expect(await first.startSession(p.projectId,id)).toMatchObject({ok:true});
 const restarted=createWebWorkspaceServices({...options,readSession:async()=>{throw Error('host absent');}});
 const pending={apiVersion:1 as const,projectId:p.projectId,operationId:id,owner:'local_lifecycle' as const,operationKind:'session_start' as const,state:'reconciliation_required' as const,updatedAt:new Date().toISOString()};
 expect(await restarted.reconcileSessionOperation(pending)).toMatchObject({ok:true,value:{state:'applied',operationId:id}});
 expect(await restarted.startSession(p.projectId,id)).toMatchObject({ok:true});expect(up).toHaveBeenCalledOnce();
 const stopId=crypto.randomUUID();expect(await first.stopSession(p.projectId,stopId)).toMatchObject({ok:true});
 expect(await restarted.reconcileSessionOperation({...pending,operationId:stopId,operationKind:'session_stop'})).toMatchObject({ok:true,value:{state:'applied',result:{session:{state:'stopped'}}}});expect(down).toHaveBeenCalledOnce();
});
it('retains an interrupted correlated lifecycle effect as uncertain and never resends its ID',async()=>{
 const p=await project();const up=vi.fn(async()=>{throw Error('ACK lost');});const options={resolveProject:async()=>p,receiptDirectory:join(p.canonicalPath,'receipts'),createLifecycle:()=>({up,down:vi.fn(),doctor:vi.fn()})};
 const id=crypto.randomUUID();expect(await createWebWorkspaceServices(options).startSession(p.projectId,id)).toMatchObject({ok:false});
 expect(await createWebWorkspaceServices(options).startSession(p.projectId,id)).toMatchObject({ok:false});expect(up).toHaveBeenCalledOnce();
});
describe('W09 lifecycle settlement and readiness',()=>{
 it('settles a start blocked before any session change as failed with the lifecycle remediation, not running',async()=>{
  const p=await project(),receiptDirectory=join(p.canonicalPath,'receipts');
  const up=vi.fn(async()=>{throw markStartupUnchanged(new Error('Provider readiness is not satisfied; no panes were started.\nMissing exact skill pin: review-code'));});
  const s=createWebWorkspaceServices({resolveProject:async()=>p,receiptDirectory,createLifecycle:()=>({up,down:vi.fn(),doctor:vi.fn()})});
  const id=randomUUID(),result=await s.startSession(p.projectId,id);
  expect(result).toMatchObject({ok:false,error:{code:'validation'}});if(!result.ok)expect(result.error.message).toContain('Missing exact skill pin: review-code');
  const pending={apiVersion:1 as const,projectId:p.projectId,operationId:id,owner:'local_lifecycle' as const,operationKind:'session_start' as const,state:'reconciliation_required' as const,updatedAt:new Date().toISOString()};
  const observed=await s.reconcileSessionOperation(pending);
  expect(observed).toMatchObject({ok:true,value:{state:'failed',error:{code:'operation_not_allowed',retryable:false}}});
  if(observed.ok)expect(observed.value.error?.message).toMatch(/Khởi động bị chặn.*\n.*Missing exact skill pin/s);
  expect(await s.startSession(p.projectId,id)).toMatchObject({ok:false});expect(up).toHaveBeenCalledOnce();
 });
 it('settles an unproven start failure as reconciliation_required with its message and never as failed',async()=>{
  const p=await project(),receiptDirectory=join(p.canonicalPath,'receipts');
  const s=createWebWorkspaceServices({resolveProject:async()=>p,receiptDirectory,createLifecycle:()=>({up:async()=>{throw new Error('pane creation timed out');},down:vi.fn(),doctor:vi.fn()})});
  const id=randomUUID();expect(await s.startSession(p.projectId,id)).toMatchObject({ok:false,error:{code:'transport_unavailable'}});
  const observed=await s.reconcileSessionOperation({apiVersion:1,projectId:p.projectId,operationId:id,owner:'local_lifecycle',operationKind:'session_start',state:'running',updatedAt:new Date().toISOString()});
  expect(observed).toMatchObject({ok:true,value:{state:'reconciliation_required'}});if(observed.ok)expect(observed.value.error?.message).toContain('pane creation timed out');
 });
 it('reports a missing repository configuration as a failed readiness check instead of an invalid request',async()=>{
  const p=await project(false),before=await readdir(p.canonicalPath),doctor=vi.fn();
  const s=createWebWorkspaceServices({resolveProject:async()=>p,createLifecycle:()=>({up:vi.fn(),down:vi.fn(),doctor})});
  expect(await s.inspectProject(p.projectId)).toMatchObject({ok:true,value:{ready:false,checks:[{id:'repository-config',state:'failed'}]}});
  expect(doctor).not.toHaveBeenCalled();expect(await readdir(p.canonicalPath)).toEqual(before);
 });
 it('real EnvironmentLifecycle marks a provider preflight refusal as leaving the session unchanged',async()=>{
  const p=await project();
  const life=new EnvironmentLifecycle(p.canonicalPath,{providerOverrides:{codex:{available:false},claude:{available:false},agy:{available:false}}} as any);
  const failure=await life.up().then(()=>undefined,e=>e);
  expect(failure).toBeInstanceOf(Error);expect(startupLeftSessionUnchanged(failure)).toBe(true);
 });
});
it('passes an explicit recovery stop through the existing checkpointed force lifecycle',async()=>{
 const p=await project(),down=vi.fn(async()=>({status:'down'}));const s=createWebWorkspaceServices({resolveProject:async()=>p,createLifecycle:()=>({up:vi.fn(),down,doctor:vi.fn()})});
 expect(await s.stopSession(p.projectId,randomUUID(),true)).toMatchObject({ok:true,value:{state:'stopped'}});expect(down).toHaveBeenCalledWith(true,undefined,true);
});
