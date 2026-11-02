import {AgentBindingReceiptSchema,AgentExecutionHandleSchema,AgentResultSchema,type AgentBindingReceipt,type AgentExecutionHandle,type JsonValue} from '@bflow/contracts';
import {digest} from './journal.js';
/** Assemble a result only after the caller obtained its authenticated binding receipt from Core. */
export function nativeImplementationResult(input:{handle:AgentExecutionHandle;receipt:AgentBindingReceipt;status:'succeeded'|'blocked';completedAt:string;output?:JsonValue;blocked?:{message:string;since:string}}){
 const handle=AgentExecutionHandleSchema.parse(input.handle),receipt=AgentBindingReceiptSchema.parse(input.receipt);
 if(digest(receipt.handle)!==digest(handle)||!receipt.correlation.verified)throw new Error('Native implementation binding receipt differs');
 if(input.status==='blocked'&&!input.blocked)throw new Error('Blocked implementation requires blockage metadata');
 return AgentResultSchema.parse({requestId:handle.requestId,attemptId:handle.attemptId,runId:handle.runId,taskId:handle.taskId,executionId:handle.executionId,status:input.status,
  verification:{status:'verified',correlation:receipt.correlation,evidence:'Native Herdr host checked the actual assignment/session binding; independent acceptance is pending'},
  ...(input.output===undefined?{}:{output:input.output}),...(input.status==='blocked'?{blockage:{code:'quality_gate',message:input.blocked!.message,since:input.blocked!.since,retryable:false}}:{}),
  artifactProposals:[],retryable:false,startedAt:handle.acceptedAt,completedAt:input.completedAt});
}
