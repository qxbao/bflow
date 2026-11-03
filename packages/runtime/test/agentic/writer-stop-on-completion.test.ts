import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { AgenticJournal } from '../../src/agentic/journal.js';
import { RoleMessageSchema } from '@bflow/contracts';
import { randomUUID } from 'node:crypto';
import { fixture, cleanups } from '../helpers/agentic-integration-fixture.js';
import type { AgentExecutionHandle } from '@bflow/contracts';
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
const proof=(handle:AgentExecutionHandle)=>({source:'linux_pid_namespace' as const,handle,observedAt:new Date().toISOString(),scopeId:randomUUID(),bootId:randomUUID(),initPid:1234,initStartTime:'123',namespace:'pid:[456]',receiptDigest:'a'.repeat(64)});
async function submitted(){
 const f=await fixture();await f.runtime.proposeWorkflow('run-1',f.spec,f.def);await f.runtime.tick();await f.evidence('implement');
 const state=await f.runtime.inspect() as any;const assignment=state.outbound.find((o:any)=>o.message.type==='task.assignment');const handle:AgentExecutionHandle=assignment.handle;
 const binding=f.panes.bindings.find(b=>b.agentId===handle.target.agentId)!;binding.metadata={...binding.metadata,runId:'run-1',taskId:'run-1-implement'};
 await f.submit();f.panes.missing.add(binding.paneId);return {f,handle,binding};
}
it('settles a succeeded missing-pane writer only after exact namespace stop proof, then starts independent verification',async()=>{
 const {f,handle}=await submitted();const stop=vi.fn(async()=>proof(handle));f.ports.stopDeveloperExecutionScope=stop;
 await f.runtime.tick();const run=await f.inspect();expect(stop).toHaveBeenCalled();expect(run.tasks[0].writerReleased).toBe(true);expect(run.tasks[0].changeSet).toBeDefined();
});
it.each(['absent','foreign','stale','future','transport_only'] as const)('retains writer and verification barrier for %s stop evidence',async(kind)=>{
 const {f,handle}=await submitted();const p=proof(handle);
 if(kind==='foreign')p.handle={...handle,executionId:'foreign'};
 if(kind==='stale')p.observedAt=new Date(Date.parse(handle.acceptedAt)-1).toISOString();
 if(kind==='future')p.observedAt=new Date(Date.now()+60000).toISOString();
 f.ports.stopDeveloperExecutionScope=async()=>kind==='absent'?undefined:kind==='transport_only'?{source:'correlated_transport',handle,observedAt:new Date().toISOString()}:p;
 await f.runtime.tick();const run=await f.inspect();expect(run.tasks[0].writerReleased).not.toBe(true);expect(run.tasks[0].changeSet).toBeUndefined();
});
it('does not stop a busy matching writer just because its result arrived',async()=>{
 const {f,handle,binding}=await submitted();f.panes.missing.delete(binding.paneId);f.panes.busy.add('developer');const stop=vi.fn(async()=>proof(handle));f.ports.stopDeveloperExecutionScope=stop;
 await f.runtime.tick();expect(stop).not.toHaveBeenCalled();expect((await f.inspect()).tasks[0].writerReleased).not.toBe(true);
});
it('does not stop a replacement allocation behind the same selector',async()=>{
 const {f,handle,binding}=await submitted();binding.paneId='replacement-pane';
 f.panes.inspectRoleHealth=async()=>({ok:true as const,value:{readyForPrompt:false,occupantMatches:false,paneExists:false,paneId:handle.target.paneId!,agentId:handle.target.agentId}});
 const stop=vi.fn(async()=>proof(handle));f.ports.stopDeveloperExecutionScope=stop;
 await f.runtime.tick();expect(stop).not.toHaveBeenCalled();expect((await f.inspect()).tasks[0].writerReleased).not.toBe(true);
});

it('retains writer while an uncertain delivery could still wake the allocation', async () => {
 const {f,handle}=await submitted();
 await new AgenticJournal(join(f.root,'journal'),f.repository).exclusive(async(state,save)=>{
  state.runs[0]!.nativeDeliveries=[{operationId:'pending-wake',message:RoleMessageSchema.parse({schema_version:2,message_id:'pending-wake',correlation_id:'correlation-1',run_id:'run-1',sender:{role:'coordinator'},recipient:{role:'developer',pane_id:handle.target.paneId},type:'task.status',payload:{action:'pending'},artifact_references:[],idempotency_key:'pending-wake'})}];await save();
 });
 const stop=vi.fn(async()=>proof(handle));f.ports.stopDeveloperExecutionScope=stop;
 const release=vi.spyOn(f.panes,'releaseDeveloper');await f.runtime.tick();
 expect(stop).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();expect((await f.inspect()).tasks[0].writerReleased).not.toBe(true);
});
it('recovers after metadata release side effect loses its acknowledgement before settlement',async()=>{
 const {f,handle,binding}=await submitted();const sealedProof=proof(handle);const stop=vi.fn(async()=>sealedProof);f.ports.stopDeveloperExecutionScope=stop;
 let crashed=false;f.ports.panes.releaseCancelledDeveloper=async()=>{
  binding.metadata={...binding.metadata,allocationStatus:'released'};
  if(!crashed){crashed=true;throw new Error('crash after metadata release');}
  return {ok:true,value:undefined};
 };
 await f.runtime.tick();
 expect((await f.inspect()).tasks[0].writerReleased).not.toBe(true);
 f.restart();await f.runtime.tick();
 expect(stop).toHaveBeenCalledTimes(2);expect((await f.inspect()).tasks[0].writerReleased).toBe(true);expect((await f.inspect()).tasks[0].changeSet).toBeDefined();
});
it('retains writer when namespace stop throws',async()=>{
 const {f}=await submitted();f.ports.stopDeveloperExecutionScope=async()=>{throw new Error('scope I/O unavailable');};
 await f.runtime.tick();const run=await f.inspect();expect(run.tasks[0].writerReleased).not.toBe(true);expect(run.tasks[0].changeSet).toBeUndefined();
});
