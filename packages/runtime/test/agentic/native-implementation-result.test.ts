import {expect,it} from 'vitest';
import {AgentExecutionHandleSchema,AgentBindingReceiptSchema,AgentResultSchema} from '@bflow/contracts';
import {nativeImplementationResult} from '../../src/agentic/native-implementation-result.js';
const at='2026-11-02T00:00:00.000Z';
function input(){
 const handle=AgentExecutionHandleSchema.parse({executionId:'exec',requestId:'request',attemptId:'attempt',runId:'run',taskId:'task',idempotencyKey:'request',target:{transport:'herdr',agentId:'developer',paneId:'pane'},correlation:{token:'request',provenance:'orchestrator',verified:false},acceptedAt:at});
 const receipt=AgentBindingReceiptSchema.parse({schemaVersion:1,receiptId:'binding',issuerId:'host',handle,correlation:{token:'assignment',provenance:'transport',verified:true},observedAt:at,signature:{algorithm:'ed25519',value:Buffer.alloc(64).toString('base64')}});
 return {handle,receipt,completedAt:at};
}
it('constructs a contract-valid blocked native result with quality-gate code and blockage timestamp',()=>{
 const result=nativeImplementationResult({...input(),status:'blocked',blocked:{message:'Independent finding is disputed',since:at}});
 expect(AgentResultSchema.parse(result)).toMatchObject({status:'blocked',blockage:{code:'quality_gate',since:at,retryable:false},verification:{status:'verified'}});
});
it('does not turn blocked submission into success or accept missing blockage time/foreign proof',()=>{
 const i=input();expect(()=>nativeImplementationResult({...i,status:'blocked'})).toThrow();
 expect(()=>nativeImplementationResult({...i,status:'blocked',blocked:{message:'Blocked',since:'invalid'}})).toThrow();
 expect(()=>nativeImplementationResult({...i,status:'succeeded',receipt:{...i.receipt,handle:{...i.handle,executionId:'foreign'}}})).toThrow();
 expect(nativeImplementationResult({...i,status:'succeeded'}).status).toBe('succeeded');
});
