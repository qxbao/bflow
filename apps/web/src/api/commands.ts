import { WebHttpContracts, WebCommandSchema, type WebCommand, type WebOperation } from '@bflow/contracts/web';
import { ApiClient, ApiError, projectPath } from './client';
export type InteractionBody = WebCommand extends infer C ? C extends WebCommand ? Omit<C,'apiVersion'|'projectId'|'commandId'> : never : never;
export type CommandBody = InteractionBody | {kind:'session_start'|'session_stop';force?:boolean};
export async function execute(api:ApiClient, command:WebCommand) {
  const parsed=WebCommandSchema.parse(command);
  const value=await api.request(`${projectPath(parsed.projectId)}/commands`,WebHttpContracts.command.response,'POST',parsed,40000);
  return check(value,parsed.projectId,parsed.commandId,parsed.kind);
}
function check(value:WebOperation,project:string,id:string,kind?:string) {
  if(value.projectId!==project || value.operationId!==id || (kind && value.operationKind!==kind))throw new ApiError('invalid_response');
  return value;
}
export async function readOperation(api:ApiClient,project:string,id:string) {
  return check(await api.request(`${projectPath(project)}/operations/${encodeURIComponent(id)}`,WebHttpContracts.operation.response,'GET',undefined,40000),project,id);
}
export async function fingerprint(body:CommandBody) {
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(body))));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function executeLifecycle(api:ApiClient,project:string,id:string,kind:'session_start'|'session_stop',force=false){
  const route=kind==='session_start'?WebHttpContracts.startSession:WebHttpContracts.stopSession;
  const body=route.body.parse({apiVersion:1,operationId:id,...(kind==='session_stop'?{confirmed:true,...(force?{force:true}:{})}:{})});
  const value=await api.request(`${projectPath(project)}/session/${kind==='session_start'?'start':'stop'}`,route.response,'POST',body,15000);
  return check(value,project,id,kind);
}

export type DecisionOutcome='approved'|'rejected'|'changes_requested';
/** `outcome` is non-sensitive display metadata for decisions; never a body, reason or authority. */
export type RecordEntry={slot:string;scope:string;commandId:string;fingerprint:string;kind:CommandBody['kind'];outcome?:DecisionOutcome};
export type Observation={record:RecordEntry;operation?:WebOperation;uncertain?:boolean;error?:unknown};
/** Recovery metadata only. This is never authority or a persisted command body. */
export class CommandStore {
  private busy=new Set<string>();
  constructor(readonly api:ApiClient,readonly projectId:string,readonly scope:string,readonly changed:()=>void=()=>{}){}
  get projectPrefix(){return `bflow:web:operations:${encodeURIComponent(this.projectId)}:`;}
  get prefix(){return this.projectPrefix+encodeURIComponent(this.scope)+':';}
  private key(record:RecordEntry){return this.projectPrefix+encodeURIComponent(record.scope)+':'+record.slot;}
  records():RecordEntry[]{
    const records:RecordEntry[]=[];
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);if(!key?.startsWith(this.projectPrefix))continue;
      try{const v=JSON.parse(localStorage.getItem(key)!);if(typeof v.slot==='string' && typeof v.scope==='string' && /^[\da-f-]{36}$/.test(v.commandId) && /^[a-f0-9]{64}$/.test(v.fingerprint) && ['create_request','revise_request','answer_clarification','answer_decision','resume','cancel','session_start','session_stop'].includes(v.kind) && (v.outcome===undefined || (v.kind==='answer_decision' && ['approved','rejected','changes_requested'].includes(v.outcome))) && key===this.key(v))records.push({slot:v.slot,scope:v.scope,commandId:v.commandId,fingerprint:v.fingerprint,kind:v.kind,...(v.outcome?{outcome:v.outcome}:{})});else throw new Error('invalid metadata');}catch{throw new Error('Mã phục hồi bị hỏng; cần đối chiếu thao tác trước khi tạo yêu cầu mới.');}
    }return records;
  }
  async observe(record:RecordEntry):Promise<Observation>{
    try{const operation=await readOperation(this.api,this.projectId,record.commandId);if(operation.operationKind!==record.kind)throw new ApiError('invalid_response');return {record,operation};}
    catch(error){return {record,uncertain:true,error};}
  }
  async submit(slot:string,body:CommandBody):Promise<Observation>{
    if(!navigator.locks)throw new Error('Trình duyệt chưa hỗ trợ khóa thao tác giữa các tab. Dùng trình duyệt hỗ trợ Web Locks.');
    if(this.busy.has(slot))throw new Error('Thao tác đang được tiếp nhận.');
    this.busy.add(slot);
    const run=async()=>{
      if(body.kind!=='session_start' && body.kind!=='session_stop')WebCommandSchema.parse({...body,apiVersion:1,projectId:this.projectId,commandId:crypto.randomUUID()});
      const digest=await fingerprint(body),existing=this.records().find(r=>r.slot===slot);
      if(existing){
        // Even an identical resubmit only observes; a missing ACK is not non-delivery.
        if(existing.fingerprint!==digest)throw new Error('Thao tác trước cần được đối chiếu trước khi gửi nội dung mới.');
        return this.observe(existing);
      }
      const record:RecordEntry={slot,scope:this.scope,commandId:crypto.randomUUID(),fingerprint:digest,kind:body.kind,...(body.kind==='answer_decision'?{outcome:body.outcome}:{})};
      localStorage.setItem(this.key(record),JSON.stringify(record));this.changed();
      try{const operation=body.kind==='session_start' || body.kind==='session_stop'?await executeLifecycle(this.api,this.projectId,record.commandId,body.kind,body.force):await execute(this.api,WebCommandSchema.parse({...body,apiVersion:1,projectId:this.projectId,commandId:record.commandId}));return {record,operation};}
      catch(error){
        // Registered definitive refusal has no accepted side effect. Persist no body/error text.
        if(error instanceof ApiError && ['invalid_request','forbidden','session_required','stale_version','operation_not_allowed','payload_too_large'].includes(error.code)){
          localStorage.removeItem(this.key(record));this.changed();throw error;
        }
        return {record,uncertain:true,error};
      }
    };
    try{return await navigator.locks.request(this.projectPrefix+slot,run);}finally{this.busy.delete(slot);}
  }
  async newIntent(slot:string){
    if(!navigator.locks)throw new Error('Trình duyệt chưa hỗ trợ khóa thao tác.');
    return navigator.locks.request(this.projectPrefix+slot,async()=>{
    const record=this.records().find(r=>r.slot===slot);if(!record)return;
    const observed=await this.observe(record);
    if(!observed.operation || !['applied','failed'].includes(observed.operation.state))throw new Error('Chưa xác định được kết quả. Chỉ đọc lại thao tác, chưa gửi yêu cầu mới.');
    localStorage.removeItem(this.key(record));this.changed();
    });
  }
}
