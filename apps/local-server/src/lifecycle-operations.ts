import { createHash } from 'node:crypto';
import { WebOperationSchema, WebOperationResponseSchema, WebSessionStopRequestSchema, WebProjectSessionResultSchema,
  type WebOperation, type WebCommand, type LocalWorkspaceServices, type UserInteractionClient } from '@bflow/contracts/web';
import { canonicalWebJson, webCommandFingerprint, WebOperationIndexRecordSchema } from '@bflow/contracts/web-host';
import type { WebAuthenticatedContext, WebOperationIndexRecord } from '@bflow/contracts/web-host';
import { IdentifierSchema, type OperationResult } from '@bflow/contracts';
import { OperationIndex, type IndexedOperation } from './operation-index.js';
import { HttpError, publicError, contractError, unwrap, observeWithinDeadline } from './errors.js';
const now=()=>new Date().toISOString();
const final=(op:WebOperation)=>op.state==='applied'||op.state==='failed';
const lifecycleMessage=(text:string)=>text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'').trim().slice(0,4000)||'Thao tác chưa được hỗ trợ.';
export class Operations {
  private closing=false;
  private queues=new Map<string,Promise<void>>();
  constructor(readonly index:OperationIndex,readonly workspace:LocalWorkspaceServices,readonly interaction:(projectId:string,context:WebAuthenticatedContext)=>Promise<UserInteractionClient>,
    private critical:<T>(fn:()=>Promise<T>)=>Promise<T>,private registered:(id:string)=>Promise<unknown>,private historical?: (record:WebOperationIndexRecord)=>Promise<OperationResult<WebOperation>>,private resolveHostSession?:(projectId:string)=>Promise<string>){}
  shutdown():void{this.closing=true;}
  private serial<T>(projectId:string,id:string,call:()=>Promise<T>):Promise<T>{
    const key=canonicalWebJson([projectId,id]),previous=this.queues.get(key)??Promise.resolve();
    const next=previous.then(()=>{if(this.closing)throw new HttpError('unavailable');return call();});
    const settled=next.then(()=>{},()=>{});this.queues.set(key,settled);
    void settled.then(()=>{if(this.queues.get(key)===settled)this.queues.delete(key);});return next;
  }
  lifecycle(projectId:string,id:string,kind:'session_start'|'session_stop',body:unknown,authorize:()=>void):Promise<WebOperation>{return this.serial(projectId,id,()=>{authorize();return this.deliverLifecycle(projectId,id,kind,body,authorize);});}
  command(command:WebCommand,authorize:()=>void,context:WebAuthenticatedContext):Promise<WebOperation>{return this.serial(command.projectId,command.commandId,()=>{authorize();return this.deliverCommand(command,authorize,context);});}
  private async reserve(projectId:string,id:string,kind:WebOperation['operationKind'],fingerprint:string,authorize:()=>void,hostSessionId?:string):Promise<IndexedOperation>{
    const index=WebOperationIndexRecordSchema.parse({schemaVersion:1,projectId,principalId:this.index.state.principalId,commandId:id,receiptId:id,
      owner:hostSessionId===undefined?'local_lifecycle':'host_interaction',operationKind:kind,fingerprint,...(hostSessionId===undefined?{}:{hostSessionId}),createdAt:now()});
    const operation=WebOperationSchema.parse({apiVersion:1,operationId:id,projectId,owner:index.owner,operationKind:kind,state:'accepted',updatedAt:now()});
    const record={index,operation};await this.critical(async()=>{if(this.closing)throw new HttpError('unavailable');await this.registered(projectId);authorize();await this.index.save(record);});return record;
  }
  private async update(record:IndexedOperation,operation:unknown):Promise<WebOperation>{
    const value=WebOperationSchema.parse(operation);
    if(value.projectId!==record.index.projectId || value.operationId!==record.index.commandId || value.owner!==record.index.owner || value.operationKind!==record.index.operationKind)throw new Error('Backend operation scope mismatch');
    if(final(record.operation) && canonicalWebJson(value)!==canonicalWebJson(record.operation))throw new Error('Final operation changed');
    await this.index.save({...record,operation:value});return value;
  }
  private async uncertain(record:IndexedOperation):Promise<WebOperation>{if(record.operation.state==='reconciliation_required')return record.operation;try{return await this.update(record,{...record.operation,state:'reconciliation_required',updatedAt:now()});}catch{throw new HttpError('reconciliation_required',record.index.commandId);}}
  private async deliverLifecycle(projectId:string,id:string,kind:'session_start'|'session_stop',body:unknown,authorize:()=>void):Promise<WebOperation>{
    const fingerprint=createHash('sha256').update(canonicalWebJson({projectId,kind,body})).digest('hex');
    const old=await this.index.read(projectId,id);
    if(old){if(old.index.fingerprint!==fingerprint || old.index.operationKind!==kind || old.index.owner!=='local_lifecycle')throw new HttpError('operation_conflict');return this.observe(old);}
    const record=await this.reserve(projectId,id,kind,fingerprint,authorize);
    try{
      const result=WebProjectSessionResultSchema.parse(await observeWithinDeadline(()=>kind==='session_start'?this.workspace.startSession(projectId,id):WebSessionStopRequestSchema.parse(body).force===true?this.workspace.stopSession(projectId,id,true):this.workspace.stopSession(projectId,id)));
      if(!result.ok){
        // The lifecycle composition is owner-local and returns its own remediation (no browser input, no secrets).
        if(result.error.code==='validation')return await this.update(record,{...record.operation,state:'failed',error:{...publicError(new HttpError('operation_not_allowed',id)),message:lifecycleMessage(result.error.message)},updatedAt:now()});
        if(['conflict','not_found','unsupported_version'].includes(result.error.code))return await this.update(record,{...record.operation,state:'failed',error:publicError(new HttpError(contractError(result.error).code,id)),updatedAt:now()});
        return await this.uncertain(record);
      }
      if(result.value.projectId!==projectId)throw new Error('Lifecycle project mismatch');
      return await this.update(record,{...record.operation,state:'applied',result:{kind:'lifecycle',session:result.value},updatedAt:now()});
    }catch{return this.uncertain(record);}
  }
  private async deliverCommand(command:WebCommand,authorize:()=>void,context:WebAuthenticatedContext):Promise<WebOperation>{
    const fingerprint=webCommandFingerprint(command),old=await this.index.read(command.projectId,command.commandId);
    if(old){if(old.index.fingerprint!==fingerprint || old.index.owner!=='host_interaction' || old.index.operationKind!==command.kind)throw new HttpError('operation_conflict');return this.observe(old,context);}
    const client=await observeWithinDeadline(()=>this.interaction(command.projectId,context));
    const session=unwrap(WebProjectSessionResultSchema.parse(await observeWithinDeadline(()=>client.readProjectSession(command.projectId))));
    if(session.projectId!==command.projectId || !session.sessionId || session.state!=='ready')throw new HttpError('unavailable');
    const hostSessionId=IdentifierSchema.parse(this.resolveHostSession?await observeWithinDeadline(()=>this.resolveHostSession!(command.projectId)):session.sessionId);
    const record=await this.reserve(command.projectId,command.commandId,command.kind,fingerprint,authorize,hostSessionId);
    try{
      const result=WebOperationResponseSchema.parse(await observeWithinDeadline(()=>client.execute(command),35000));
      if(!result.ok){if(['validation','conflict','not_found','unsupported_version'].includes(result.error.code))return await this.update(record,{...record.operation,state:'failed',error:publicError(new HttpError(contractError(result.error).code,command.commandId)),updatedAt:now()});return await this.uncertain(record);}
      return await this.update(record,result.value);
    }catch{return this.uncertain(record);}
  }
  private async observe(record:IndexedOperation,context?:WebAuthenticatedContext):Promise<WebOperation>{
    if(final(record.operation))return record.operation;
    try{
      let raw:unknown;
      if(record.index.owner==='local_lifecycle')raw=await observeWithinDeadline(()=>this.workspace.reconcileSessionOperation(record.operation));
      else if(this.historical)raw=await observeWithinDeadline(()=>this.historical!(record.index),35000);
      else {
        if(!context)throw new HttpError('unavailable');
        const client=await observeWithinDeadline(()=>this.interaction(record.index.projectId,context));
        const session=unwrap(WebProjectSessionResultSchema.parse(await observeWithinDeadline(()=>client.readProjectSession(record.index.projectId))));
        // The frozen client cannot authenticate a historical session in its operation DTO.
        // Fail closed rather than accepting another host's plausible same-ID receipt.
        if(session.projectId!==record.index.projectId || session.sessionId!==record.index.hostSessionId)return await this.uncertain(record);
        raw=await observeWithinDeadline(()=>client.readOperation(record.index.projectId,record.index.receiptId),35000);
      }
      const result=WebOperationResponseSchema.parse(raw);
      if(!result.ok)return await this.uncertain(record);
      if(result.value.result?.kind==='lifecycle' && result.value.result.session.projectId!==record.index.projectId)throw new Error('Lifecycle scope mismatch');
      return await this.update(record,result.value);
    }catch{return this.uncertain(record);}
  }
  read(projectId:string,id:string,authorize:()=>void,context:WebAuthenticatedContext):Promise<WebOperation>{return this.serial(projectId,id,async()=>{authorize();const record=await this.index.read(projectId,id);if(!record)throw new HttpError('not_found');return this.observe(record,context);});}
}
