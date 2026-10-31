import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractErrorSchema, type OperationResult } from '@bflow/contracts';
import { WebProjectSchema, WebProjectConfigurationSchema, WebConfigurationSaveSchema, WebProjectInitRequestSchema,
  WebProjectInitializationSchema, WebProjectMutationStatusResultSchema, WebSessionStartRequestSchema, type WebProject, type WebProjectConfiguration, type WebConfigurationSave,
  type WebProjectInitRequest, type WebProjectInitialization } from '@bflow/contracts/web';
import { commitWebConfiguration } from './web-config-git.js';
import { identifyRepository } from './repository.js';
import { initializeEnvironmentConfig, readEnvironmentConfig } from './environment-config.js';
import { parseConfigYaml } from './config-format.js';
import { parseDocument } from 'yaml';
import { readPreviewFile } from './preview-files.js';
import { withLifecycleLock } from './lifecycle-lock.js';
import { prepareRepositoryGitNexus, resolveSetupPlatform } from './gateway-repositories.js';

const MAX_RECEIPT_BYTES=128*1024;
const ReceiptSchema=z.object({request:WebProjectInitRequestSchema,result:WebProjectInitializationSchema}).strict();
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function syncDirectorySafe(directory:string){
 let handle;
 try{handle=await open(directory,'r');await handle.sync();}
 catch(error){const code=(error as NodeJS.ErrnoException)?.code??'';if(!['EINVAL','ENOTSUP','EPERM','EACCES','EBADF','EISDIR','EROFS'].includes(code))throw error;}
 finally{await handle?.close().catch(()=>{});}
}
const failure=<T>(e:unknown,code:'validation'|'conflict'|'not_found'='validation'):OperationResult<T>=>({ok:false,error:ContractErrorSchema.parse({code,retryable:code==='conflict',message:(e instanceof Error?e.message:String(e)).slice(0,4000)})});
export interface WebProjectSettingsOptions {
 resolveProject(id:string):Promise<WebProject>;
 receiptDirectory:string;
 prepareGitNexus?:typeof prepareRepositoryGitNexus | ((input:Parameters<typeof prepareRepositoryGitNexus>[0])=>Promise<{status:string;diagnostics:readonly string[]}>);
}
/** Registered roots only. Jobs have durable IDs; a crashed worker never replays a mutation. */
export function createWebProjectSettings(options:WebProjectSettingsOptions){
 const pending=new Map<string,Promise<void>>();
 const activeProjects=new Map<string,string>();
 const registered=async(id:string)=>{
  const p=WebProjectSchema.parse(await options.resolveProject(id));
  if(p.projectId!==id || p.registrationState!=='registered' || await realpath(p.canonicalPath)!==p.canonicalPath || id!=='project-'+hash(p.canonicalPath).slice(0,32))throw Error('Registered project identity mismatch');
  const repository=await identifyRepository(p.canonicalPath);if(repository.root!==p.canonicalPath)throw Error('Repository root changed');return repository;
 };
 const configPath=(root:string)=>join(root,'.bflow/config.yml');
 const snapshot=async(id:string,root:string):Promise<WebProjectConfiguration>=>{
  const yaml=await readPreviewFile(configPath(root),180000);
  let gitIgnore:string|undefined;try{gitIgnore=await readPreviewFile(join(root,'.bflow/.gitignore'),180000);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  // Permit reading invalid YAML for repair through the full editor.
  let values:unknown={};try{const raw=parseConfigYaml(yaml);if(raw && typeof raw==='object' && !Array.isArray(raw))values=raw;}catch{}
  return WebProjectConfigurationSchema.parse({apiVersion:1,projectId:id,revision:hash(JSON.stringify([yaml,gitIgnore??null])),yaml,...(gitIgnore===undefined?{}:{gitIgnore}),values});
 };
 const receipt=(id:string,operationId:string)=>join(options.receiptDirectory,'init-'+hash(JSON.stringify([id,operationId]))+'.json');
 const writeReceipt=async(value:WebProjectInitialization,request:WebProjectInitRequest)=>{
  const path=receipt(value.projectId,value.operationId),temp=path+'.'+randomUUID()+'.tmp';
  const file=await open(temp,'wx',0o600);try{await file.writeFile(JSON.stringify(ReceiptSchema.parse({request,result:value})));await file.sync();await file.close();await rename(temp,path);await syncDirectorySafe(options.receiptDirectory);}finally{await file.close();await unlink(temp).catch(()=>{});}
 };
 const readJob=async(id:string,operationId:string)=>{
  WebSessionStartRequestSchema.parse({apiVersion:1,operationId});
  const {result:value}=ReceiptSchema.parse(JSON.parse(await readPreviewFile(receipt(id,operationId),MAX_RECEIPT_BYTES)));
  if(value.projectId!==id || value.operationId!==operationId)throw Error('Foreign initialization receipt');
  return value.state==='running' && !pending.has(receipt(id,operationId))?{...value,state:'interrupted' as const,message:'Khởi tạo bị gián đoạn. Kiểm tra điều kiện dự án trước khi bắt đầu thao tác mới.'}:value;
 };
 return {
  pending:()=>[...pending.values()],
  async projectMutationStatus(id:string){
   try{
    const jobs:WebProjectInitialization[]=[];
    for(const name of await readdir(options.receiptDirectory).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;})){
     if(!/^init-[a-f0-9]{64}\.json$/.test(name))continue;
     const saved=ReceiptSchema.parse(JSON.parse(await readPreviewFile(join(options.receiptDirectory,name),MAX_RECEIPT_BYTES)));
     if(saved.result.projectId===id)jobs.push(saved.result);
    }
    const settled=jobs.filter(job=>job.state==='succeeded').map(job=>job.updatedAt).sort().at(-1)??'';
    const unresolved=jobs.some(job=>job.state==='running' && job.updatedAt>=settled);
    return WebProjectMutationStatusResultSchema.parse({ok:true,value:{apiVersion:1,projectId:id,initializationPending:[...activeProjects.values()].includes(id)||unresolved}});
   }catch(e){return failure<never>(e);}
  },
  async readConfiguration(id:string):Promise<OperationResult<WebProjectConfiguration>>{
   try{const r=await registered(id);return {ok:true,value:await snapshot(id,r.root)};}catch(e){return failure(e);}
  },
  async saveConfiguration(id:string,input:WebConfigurationSave):Promise<OperationResult<WebProjectConfiguration>>{
   try{
    const request=WebConfigurationSaveSchema.parse(input),r=await registered(id);
    return await withLifecycleLock(join(r.root,'.bflow/state'),async()=>{
     const before=await snapshot(id,r.root);if(before.revision!==request.expectedRevision)return failure('Cấu hình đã đổi. Tải lại trước khi lưu.','conflict');
     let yaml=request.yaml;
     if(yaml===undefined){
      // Modify the YAML AST to retain comments, unknown untouched fields, and scalar styles.
      const doc=parseDocument(before.yaml);const patch=(old:unknown,next:unknown,path:(string|number)[])=>{
       if(JSON.stringify(old)===JSON.stringify(next))return;
       if(Array.isArray(old) && Array.isArray(next) && old.length===next.length){next.forEach((value,index)=>patch(old[index],value,[...path,index]));return;}
       if(old && next && typeof old==='object' && typeof next==='object' && !Array.isArray(old) && !Array.isArray(next)){
        const a=old as Record<string,unknown>,b=next as Record<string,unknown>;
        for(const key of Object.keys(a))if(!Object.hasOwn(b,key))doc.deleteIn([...path,key]);
        for(const [key,value] of Object.entries(b))patch(a[key],value,[...path,key]);
       }else doc.setIn(path,next);
      };patch(before.values,request.values,[]);yaml=doc.toString();
     }
     if(Buffer.byteLength(yaml,'utf8')>180000)throw Error('Cấu hình vượt quá 180000 byte.');
     await readEnvironmentConfig(r,yaml);
     const path=configPath(r.root),temp=path+'.web-'+randomUUID()+'.tmp';
     const file=await open(temp,'wx',0o600);
     try{
      await file.writeFile(yaml);await file.sync();await file.close();
      if((await snapshot(id,r.root)).revision!==request.expectedRevision)return failure('Cấu hình đã đổi. Tải lại trước khi lưu.','conflict');
      await rename(temp,path);await syncDirectorySafe(join(r.root,'.bflow'));
     }finally{await file.close();await unlink(temp).catch(()=>{});}
     return {ok:true as const,value:await snapshot(id,r.root)};
    });
   }catch(e){return failure(e);}
  },
  async readInitialization(id:string,operationId:string):Promise<OperationResult<WebProjectInitialization>>{
   try{await registered(id);return {ok:true,value:await readJob(id,operationId)};}catch(e){return failure(e,(e as NodeJS.ErrnoException).code==='ENOENT'?'not_found':'validation');}
  },
  async initializeProject(id:string,input:WebProjectInitRequest):Promise<OperationResult<WebProjectInitialization>>{
   try{
    const request=WebProjectInitRequestSchema.parse(input),r=await registered(id),path=receipt(id,request.operationId);
    if(!request.skipGitNexus && !request.acceptGitNexusLicense)throw Error('Xác nhận giấy phép GitNexus trước khi tạo chỉ mục.');
    await mkdir(options.receiptDirectory,{recursive:true,mode:0o700});
    const info=await lstat(options.receiptDirectory);
    if(!info.isDirectory() || await realpath(options.receiptDirectory)!==options.receiptDirectory || info.uid!==process.getuid?.() || (info.mode&0o077))throw Error('Unsafe initialization receipt directory');
    let file;try{file=await open(path,'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST'){const saved=ReceiptSchema.parse(JSON.parse(await readPreviewFile(path,MAX_RECEIPT_BYTES)));if(JSON.stringify(saved.request)!==JSON.stringify(request))return failure('Mã khởi tạo đã được dùng với lựa chọn khác.','conflict');return {ok:true,value:await readJob(id,request.operationId)};}throw e;}
    const initial:WebProjectInitialization={apiVersion:1,projectId:id,operationId:request.operationId,state:'running',message:'Đang chuẩn bị cấu hình, chỉ mục GitNexus và đăng ký Gateway…',updatedAt:new Date().toISOString()};
    try{await file.writeFile(JSON.stringify(ReceiptSchema.parse({request,result:initial})));await file.sync();}finally{await file.close();}
    activeProjects.set(path,id);
    let configurationCommitMessage:string|undefined;
    const task=withLifecycleLock(join(r.root,'.bflow/state'),async()=>{
     await registered(id);
     if(request.commitConfiguration && (await snapshot(id,r.root)).revision!==request.expectedConfigurationRevision)
       throw Error('Cấu hình đã đổi. Đọc lại cấu hình trước khi xác nhận commit.');
     if(request.commitConfiguration && request.skipGitNexus && (await readEnvironmentConfig(r)).environment.tools?.gitnexus?.enabled!==false)
       throw Error('Tắt GitNexus và lưu cấu hình trước; xem lại cấu hình rồi mới xác nhận commit.');
     await initializeEnvironmentConfig({cwd:r.root,update:request.update,...(request.provider?{provider:request.provider}:{})});
     if(request.skipGitNexus && (await readEnvironmentConfig(r)).environment.tools?.gitnexus?.enabled!==false){
      const path=configPath(r.root),doc=parseDocument(await readPreviewFile(path,180000));doc.setIn(['environment','tools','gitnexus','enabled'],false);
      const temp=path+'.web-'+randomUUID()+'.tmp',file=await open(temp,'wx',0o600);
      try{await file.writeFile(doc.toString());await file.sync();await file.close();await rename(temp,path);}finally{await file.close();await unlink(temp).catch(()=>{});}
     }
     const config=await readEnvironmentConfig(r);
     if(request.commitConfiguration && (await snapshot(id,r.root)).revision!==request.expectedConfigurationRevision)
       throw Error('Cấu hình đã đổi trong khởi tạo. Đọc lại cấu hình trước khi commit.');
     const gitMessage=request.commitConfiguration?await commitWebConfiguration(r.root):undefined;configurationCommitMessage=gitMessage;
     if(config.environment.tools?.gitnexus?.enabled===false)return {status:'ready',diagnostics:[...(gitMessage?[gitMessage]:[]),'Cấu hình đã sẵn sàng. GitNexus đang tắt trong cấu hình.']};
     const result=await (options.prepareGitNexus??prepareRepositoryGitNexus)({repository:r,platform:resolveSetupPlatform()});
     return {...result,diagnostics:[...(gitMessage?[gitMessage]:[]),...result.diagnostics]};
    }).then(result=>writeReceipt({...initial,state:result.status==='ready'?'succeeded':'failed',message:(result.diagnostics.join('\n') || 'Đã khởi tạo cấu hình, tạo chỉ mục và đăng ký GitNexus với Gateway.').slice(0,16000),updatedAt:new Date().toISOString()},request),e=>writeReceipt({...initial,state:'failed',message:[configurationCommitMessage,String(e instanceof Error?e.message:e)].filter(Boolean).join('\n').slice(0,16000),updatedAt:new Date().toISOString()},request)).finally(()=>{pending.delete(path);activeProjects.delete(path);});
    pending.set(path,task);void task.catch(()=>{});return {ok:true,value:initial};
   }catch(e){return failure(e);}
  }
 };
}
