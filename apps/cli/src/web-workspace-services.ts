import { constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  IdentifierSchema, ContractErrorSchema, EnvironmentDoctorReportSchema, ExecutionPlanSchema,
  type OperationResult,
} from '@bflow/contracts';
import {
  WebProjectSchema, WebProjectInspectionResultSchema, WebProjectSessionResultSchema,
  WebProjectPreviewResultSchema, WebOperationSchema, WebOperationResponseSchema,
  WebSessionStartRequestSchema,
  type LocalWorkspaceServices, type WebProject, type WebProjectSession, type WebOperation,
} from '@bflow/contracts/web';
import { openUserInteractionClient } from '@bflow/runtime';
import { EnvironmentLifecycle, startupLeftSessionUnchanged, type EnvironmentDependencies } from './environment.js';
import { identifyRepository } from './repository.js';
import { readEnvironmentConfig } from './environment-config.js';
import { readPreviewFile } from './preview-files.js';
import { createWebProjectSettings } from './web-project-settings.js';
import { loadExecutionPreview } from './execution-preview.js';

/** Owner-side resolver only. Never accept a path or cwd from an HTTP command. */
export interface WebWorkspaceOptions {
  resolveProject(projectId: string): Promise<WebProject>;
  environment?: EnvironmentDependencies;
  /** Production composition scopes receipts to its private BFLOW_HOME web state. */
  receiptDirectory?: string;
  createLifecycle?: (path: string) => Pick<EnvironmentLifecycle, 'up' | 'down' | 'doctor'>;
  readSession?: (project: WebProject, sessionId: string) => Promise<OperationResult<WebProjectSession>>;
}
const error = <T>(code: 'validation' | 'transport_unavailable', message: string): OperationResult<T> =>
  ({ ok: false, error: ContractErrorSchema.parse({ code, message, retryable: code === 'transport_unavailable' }) });

async function receiptRoot(directory:string,create=false):Promise<boolean>{
  if(!isAbsolute(directory))throw new Error('Lifecycle receipt directory must be absolute');
  if(create)await mkdir(directory,{recursive:true,mode:0o700});
  let info;try{info=await lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  if(!info.isDirectory() || info.uid!==process.getuid?.() || (info.mode&0o077)!==0 || await realpath(directory)!==directory)throw new Error('Unsafe lifecycle receipt directory');
  return true;
}
const receiptPath=(directory:string,projectId:string,id:string)=>join(directory,createHash('sha256').update(JSON.stringify([projectId,id])).digest('hex')+'.json');
async function readReceipt(directory:string,projectId:string,id:string):Promise<WebOperation|undefined>{
  if(!await receiptRoot(directory))return undefined;
  const path=receiptPath(directory,projectId,id);let info;
  try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  if(info.uid!==process.getuid?.() || (info.mode&0o077)!==0 || info.nlink!==1)throw new Error('Unsafe lifecycle receipt');
  const value=WebOperationSchema.parse(JSON.parse(await readPreviewFile(path,1024*1024)));
  if(value.projectId!==projectId || value.operationId!==id || value.owner!=='local_lifecycle')throw new Error('Foreign lifecycle receipt');
  return value;
}
async function syncDirectory(directory:string){const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
async function reserveReceipt(directory:string,operation:WebOperation):Promise<boolean>{
  await receiptRoot(directory,true);let handle;
  try{handle=await open(receiptPath(directory,operation.projectId,operation.operationId),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}
  catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}
  try{await handle.writeFile(JSON.stringify(WebOperationSchema.parse(operation)));await handle.sync();}finally{await handle.close();}
  await syncDirectory(directory);return true;
}
async function settleReceipt(directory:string,operation:WebOperation){
  const temp=join(directory,'pending-'+randomUUID()+'.tmp'),handle=await open(temp,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(WebOperationSchema.parse(operation)));await handle.sync();await handle.close();
    await rename(temp,receiptPath(directory,operation.projectId,operation.operationId));await syncDirectory(directory);
  }finally{await handle.close();await unlink(temp).catch(()=>{});}
}

/** Local, owner-generated diagnostics only (no credentials): control characters removed and bounded. */
function lifecycleFailureMessage(failure:unknown,kind:'session_start'|'session_stop'):string{
  const raw=failure instanceof Error?failure.message:String(failure);
  const text=raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'').trim().slice(0,3500);
  const lead=startupLeftSessionUnchanged(failure)
    ?'Khởi động bị chặn trước khi mở phiên; không có thay đổi cần đối chiếu. Khắc phục rồi bắt đầu thao tác mới.'
    :kind==='session_start'?'Khởi động chưa được xác nhận. Giữ operation ID; kiểm tra bflow status và bflow doctor trước khi khôi phục.'
    :'Dừng phiên chưa được xác nhận. Giữ nguyên checkpoint và kiểm tra bflow doctor; không tự gửi lại stop.';
  return text?`${lead}\n${text}`:lead;
}

export interface WebWorkspaceServices extends LocalWorkspaceServices {
  /** Start/stop effects still running inside this process (owner-side shutdown only). */
  pendingLifecycle(): Promise<void>[];
}
export function createWebWorkspaceServices(options: WebWorkspaceOptions): WebWorkspaceServices {
  const inFlight = new Set<Promise<void>>();
  const settings=createWebProjectSettings({resolveProject:options.resolveProject,
    receiptDirectory:options.receiptDirectory??join(process.cwd(),'.bflow/state/web-settings')});
  const registered = async (projectId: string) => {
    IdentifierSchema.parse(projectId);
    const project = WebProjectSchema.parse(await options.resolveProject(projectId));
    if (project.projectId !== projectId || project.registrationState !== 'registered' ||
        await realpath(project.canonicalPath) !== project.canonicalPath ||
        projectId !== 'project-' + createHash('sha256').update(project.canonicalPath).digest('hex').slice(0, 32))
      throw new Error('Registered project identity mismatch');
    const repository = await identifyRepository(project.canonicalPath, options.environment?.runner);
    if (repository.root !== project.canonicalPath) throw new Error('Registered repository root changed');
    return { project, repository };
  };
  const context = async (projectId: string) => {
    const value = await registered(projectId);
    // No fallback configuration, init, setup, index or repository plugin execution.
    await readPreviewFile(join(value.repository.root, '.bflow/config.yml'));
    await readEnvironmentConfig(value.repository);
    return value;
  };
  const lifecycle = (path: string) => options.createLifecycle?.(path) ?? new EnvironmentLifecycle(path, options.environment);
  const readSession = options.readSession ?? (async (project, sessionId) => {
    const client = await openUserInteractionClient({ repositoryPath: project.canonicalPath, sessionId });
    return client.readProjectSession(project.projectId);
  });
  const directory=(project:WebProject)=>options.receiptDirectory??join(project.canonicalPath,'.bflow/state/web-lifecycle');
  const perform=async(project:WebProject,id:string,kind:'session_start'|'session_stop',effect:()=>Promise<OperationResult<WebProjectSession>>):Promise<OperationResult<WebProjectSession>>=>{
    const root=directory(project),initial=WebOperationSchema.parse({apiVersion:1,projectId:project.projectId,operationId:id,
      owner:'local_lifecycle',operationKind:kind,state:'running',updatedAt:new Date().toISOString()});
    if(!await reserveReceipt(root,initial)){
      const previous=await readReceipt(root,project.projectId,id);
      if(!previous || previous.operationKind!==kind)return error('validation','Lifecycle operation ID không khớp.');
      if(previous.state==='applied' && previous.result?.kind==='lifecycle')return WebProjectSessionResultSchema.parse({ok:true,value:previous.result.session});
      return error('transport_unavailable','Lifecycle operation chưa được xác nhận; không gửi lại effect.');
    }
    let result:OperationResult<WebProjectSession>;
    let finished!:()=>void;const tracked=new Promise<void>(resolve=>{finished=resolve;});inFlight.add(tracked);
    try{result=WebProjectSessionResultSchema.parse(await effect().finally(()=>{inFlight.delete(tracked);finished();}));}
    catch(failure){
      // Settle every outcome: an unsettled `running` receipt would never resolve for the browser.
      // Only a startup that proved no session side effect is definitive; anything else stays uncertain.
      const definitive=startupLeftSessionUnchanged(failure),message=lifecycleFailureMessage(failure,kind);
      await settleReceipt(root,WebOperationSchema.parse({...initial,state:definitive?'failed':'reconciliation_required',
        error:{apiVersion:1,code:definitive?'operation_not_allowed':'reconciliation_required',message,retryable:false,operationId:id,correlationId:randomUUID()},
        updatedAt:new Date().toISOString()}));
      return error(definitive?'validation':'transport_unavailable',message);
    }
    if(result.ok){
      if(result.value.projectId!==project.projectId)throw new Error('Foreign lifecycle session');
      await settleReceipt(root,WebOperationSchema.parse({...initial,state:'applied',result:{kind:'lifecycle',session:result.value},updatedAt:new Date().toISOString()}));
    } else await settleReceipt(root,WebOperationSchema.parse({...initial,state:'reconciliation_required',
      error:{apiVersion:1,code:'reconciliation_required',message:result.error.message.slice(0,4000),retryable:false,operationId:id,correlationId:randomUUID()},updatedAt:new Date().toISOString()}));
    return result;
  };
  const remediation = 'Mở Cài đặt dự án trên web để khởi tạo hoặc sửa cấu hình. Kiểm tra project đã đăng ký và cấu hình. Chạy bflow init trong kho mã; chạy bflow setup --check để kiểm tra môi trường. Dùng nút Khởi tạo / sửa GitNexus trong Cài đặt để khởi tạo rõ ràng; cài đặt máy vẫn thuộc machine setup.';
  return {
    ...settings,
    pendingLifecycle: () => [...inFlight,...settings.pending()],
    async inspectProject(projectId) {
      try {
        const { repository } = await registered(projectId);
        try { await readPreviewFile(join(repository.root, '.bflow/config.yml')); await readEnvironmentConfig(repository); }
        catch (failure) {
          // Not ready, and the reason is actionable: report it as a readiness check, never init.
          const missing = (failure as NodeJS.ErrnoException).code === 'ENOENT';
          return WebProjectInspectionResultSchema.parse({ ok: true, value: { apiVersion: 1, projectId, ready: false,
            checks: [{ id: 'repository-config', state: 'failed', message: missing
              ? 'Kho mã chưa có .bflow/config.yml. Dùng Khởi tạo / sửa GitNexus bên dưới (hoặc chạy bflow init) rồi kiểm tra lại.'
              : `Cấu hình .bflow/config.yml không hợp lệ: ${String(failure instanceof Error ? failure.message : failure).slice(0, 1000)}` }],
            observedAt: new Date().toISOString() } });
        }
        const report = EnvironmentDoctorReportSchema.parse(await lifecycle(repository.root).doctor(false));
        return WebProjectInspectionResultSchema.parse({ ok: true, value: {
          apiVersion: 1, projectId, ready: report.healthy,
          checks: report.checks.slice(0, 100).map(check => ({ id: check.checkId,
            state: check.status === 'passed' ? 'passed' : 'failed',
            message: check.message })), observedAt: new Date().toISOString(),
        }});
      } catch { return error('validation', remediation); }
    },
    async startSession(projectId, operationId) {
      let ctx: Awaited<ReturnType<typeof context>>;
      try { WebSessionStartRequestSchema.parse({ apiVersion: 1, operationId }); ctx = await context(projectId); }
      catch { return error('validation', remediation); }
      try {
        // EnvironmentLifecycle owns locks, provider preflight, startup receipts and activation.
        return await perform(ctx.project,operationId,'session_start',async()=>{
        await lifecycle(ctx.repository.root).up();
        const health = WebProjectSessionResultSchema.parse(await readSession(ctx.project, ctx.repository.sessionName));
        if (!health.ok || health.value.projectId !== projectId || health.value.state !== 'ready')
          return error('transport_unavailable', 'Chưa xác nhận activated host health. Đọc lại operation; không tự gửi lại start.');
        return health;
        });
      } catch { return error('transport_unavailable', 'Khởi động chưa được xác nhận. Giữ operation ID; kiểm tra bflow status và bflow doctor trước khi khôi phục.'); }
    },
    async stopSession(projectId, operationId, force = false) {
      let ctx: Awaited<ReturnType<typeof context>>;
      try { WebSessionStartRequestSchema.parse({ apiVersion: 1, operationId }); ctx = await context(projectId); }
      catch { return error('validation', remediation); }
      try {
        // Explicit web confirmation is checked by W03. Never force past unverified writers/checkpoints.
        return await perform(ctx.project,operationId,'session_stop',async()=>{
        const stopped = await lifecycle(ctx.repository.root).down(true, undefined, force);
        if (!('status' in stopped && stopped.status === 'down') && !('server' in stopped && stopped.server === 'stopped'))
          return error('transport_unavailable', 'Chưa xác nhận dừng phiên. Đọc lại operation; không tự gửi lại stop.');
        return WebProjectSessionResultSchema.parse({ ok: true, value: { apiVersion: 1, projectId,
          sessionId: ctx.repository.sessionName, state: 'stopped', pendingIntakes: [], blockers: [], updatedAt: new Date().toISOString() } });
        });
      } catch { return error('transport_unavailable', 'Dừng phiên chưa được xác nhận. Giữ nguyên checkpoint và kiểm tra bflow doctor; không tự gửi lại stop.'); }
    },
    async reconcileSessionOperation(input) {
      try {
        const operation = WebOperationSchema.parse(input);
        if (operation.owner !== 'local_lifecycle') return error('validation', 'Operation không thuộc lifecycle.');
        if (operation.state === 'applied' || operation.state === 'failed')
          return WebOperationResponseSchema.parse({ ok: true, value: operation });
        // Observation only, including missing config/host/stopped sessions. Never call up/down.
        const project=WebProjectSchema.parse(await options.resolveProject(operation.projectId));
        if(project.projectId!==operation.projectId)throw new Error('Foreign registered project');
        const saved=await readReceipt(directory(project),operation.projectId,operation.operationId);
        if(saved && saved.operationKind!==operation.operationKind)throw new Error('Lifecycle receipt kind mismatch');
        return WebOperationResponseSchema.parse({ok:true,value:saved && saved.state!=='running' && saved.state!=='accepted'?saved:
          {...operation,state:'reconciliation_required'}});
      } catch { return error('validation', 'Operation lifecycle không hợp lệ.'); }
    },
    async preview(projectId) {
      try {
        const { repository } = await context(projectId);
        const plan = ExecutionPlanSchema.parse(await loadExecutionPreview(repository.root));
        return WebProjectPreviewResultSchema.parse({ ok: true, value: { apiVersion: 1, projectId,
          available: true, summary: `Execution preview: ${plan.mode}. Đây là cấu hình dự kiến, chưa cấp quyền hay xác nhận readiness.`,
          blockers: plan.blockers.slice(0, 100).map(blocker => ({ code: blocker.code, message: blocker.code })),
          observedAt: new Date().toISOString(),
        }});
      } catch { return error('validation', remediation); }
    },
  };
}
