import { AgentRequestSchema, RoleMessageSchema, type AgentRequest } from '@bflow/contracts';
import { compactPolicyReviewDossier } from './mcp-output-views.js';
import { digest, record, type Outbound, type JournalState } from './journal.js';

/** Keep the complete envelope in outbox/receipts; a newly pinned transport request carries exactly this bounded presentation. */
export function projectPolicyPhaseEnvelope(input: unknown) {
 const message=RoleMessageSchema.parse(input);
 if(Buffer.byteLength(JSON.stringify(message),'utf8')<=60000||message.type!=='verification.requested')return message;
 if(!message.payload||typeof message.payload!=='object'||Array.isArray(message.payload))return message;
 const payload=record(message.payload);if(payload.kind!=='conditional_evidence')return message;
 const compact=record(compactPolicyReviewDossier(payload.specification as never,payload.strategy as never));
 const projected=RoleMessageSchema.parse({...message,payload:{...payload,specification:compact.specification,strategy:compact.strategy,priorEvidence:compact.priorEvidence,presentation:compact.presentation}});
 if(Buffer.byteLength(JSON.stringify(projected),'utf8')>60000)throw Error('Policy prompt exceeds bounded transport presentation; inspect the host dossier');
 return projected;
}
/** Only used while creating a new request; never changes an already pinned request. */
export function projectPolicyPhaseRequest(input: AgentRequest): AgentRequest {
 const request=AgentRequestSchema.parse(input);
 if(Buffer.byteLength(request.instruction,'utf8')<=60000)return request;
 const context=RoleMessageSchema.safeParse(request.context);
 if(!context.success||context.data.type!=='verification.requested'||record(context.data.payload).kind!=='conditional_evidence')return request;
 const message=RoleMessageSchema.parse(JSON.parse(request.instruction));
 if(digest(request.context)!==digest(message))throw Error('Policy prompt differs from pinned request context');
 const projected=projectPolicyPhaseEnvelope(message);
 return AgentRequestSchema.parse({...request,instruction:JSON.stringify(projected),context:projected});
}

/** Node's exact spawn E2BIG is a pre-exec failure, not a timeout or a remote observation.
 * Recover only the retained, oversized, original policy request, with no handle or reply.
 * Runtime must still reconcile, renew its lease and dispatch normally. Never edits the request. */
export function provenPrelaunchPolicyFailure(out: Outbound, inbox: JournalState['inbox'], platform=process.platform): boolean {
 try {
  if(out.leaseRenewal||out.leaseReacquisition||out.prelaunchFailure||platform!=='linux'||out.status!=='unknown_delivery'||out.handle||out.error!=='Error: transport_unavailable: spawn E2BIG'||!out.request)return false;
  const request=AgentRequestSchema.parse(out.request),message=RoleMessageSchema.parse(out.message),payload=record(message.payload);
  return message.type==='verification.requested'&&payload.kind==='conditional_evidence'&&message.recipient.role==='qa'&&
   request.requestId===`request-${digest(message.message_id)}`&&request.idempotency.key===message.idempotency_key&&
   request.runId===message.run_id&&request.taskId===`phase-${payload.taskId}-${payload.phase}`&&request.role==='qa'&&request.attemptId===out.attemptId&&request.taskId===out.taskId&&
   request.instruction===JSON.stringify(message)&&digest(request.context)===digest(message)&&
   Buffer.byteLength(request.instruction,'utf8')>131072&&
   !inbox.some(item=>item.status!=='rejected'&&item.message.causation_id===message.message_id);
 }catch{return false;}
}

export class PrelaunchRegistryRecoveryError extends Error {}
export function prelaunchLeaseIdentity(out: Outbound) {
 const seed=out.prelaunchFailure ? digest([out.message.message_id,'prelaunch-rebind',out.prelaunchFailure.reconciledAt]) : digest(out.message.message_id);
 return {leaseId:`lease-${seed}`,idempotencyKey:out.prelaunchFailure?`acquire:prelaunch:${seed}`:`acquire:${out.message.message_id}`};
}
export async function recoverPrelaunchPolicyDeliveries(runtime: {reconcileDelivery(id:string):Promise<unknown>}, state: Pick<JournalState,'outbound'|'inbox'>, held:(error:Error)=>void) {
 for(const pending of state.outbound) if(provenPrelaunchPolicyFailure(pending,state.inbox)) {
  try {await runtime.reconcileDelivery(pending.message.message_id);}
  catch(error) {if(!(error instanceof PrelaunchRegistryRecoveryError))throw error;held(error);}
 }
}
