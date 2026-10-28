import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, rename, unlink, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { IdentifierSchema } from '@bflow/contracts';
import { WebOperationSchema, type WebOperation } from '@bflow/contracts/web';
import { canonicalWebJson, WebOperationIndexRecordSchema, type WebOperationIndexRecord } from '@bflow/contracts/web-host';
import { HttpError } from './errors.js';

/** Local POSIX private files. Fails closed on foreign/symlink state; no same-UID or power-loss claim. */
export class PrivateState {
  private constructor(readonly directory:string,private lock:FileHandle,readonly principalId:string) {}
  static async open(directory:string):Promise<PrivateState> {
    if(!directory.startsWith('/')) throw new Error('State directory must be absolute');
    await mkdir(directory,{recursive:true,mode:0o700});
    const info=await lstat(directory);
    if(!info.isDirectory() || info.uid!==process.getuid?.() || (info.mode&0o077)!==0 || await realpath(directory)!==resolve(directory)) throw new Error('Unsafe private state directory');
    const lock=await open(join(directory,'server.lock'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    const state=new PrivateState(directory,lock,'');
    try {
      let principal=await state.read('principal.json');
      if(principal===undefined) {principal=randomUUID();await state.write('principal.json',principal);}
      return new PrivateState(directory,lock,IdentifierSchema.parse(principal));
    } catch(error) {await state.close();throw error;}
  }
  async read(name:string):Promise<unknown|undefined> {
    let file:FileHandle;
    try{file=await open(join(this.directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    try{const s=await file.stat();if(!s.isFile() || s.uid!==process.getuid?.() || (s.mode&0o077)!==0 || s.nlink!==1 || s.size>16*1024*1024)throw new Error('Unsafe private state file');
      const buffer=Buffer.alloc(s.size+1);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead!==s.size)throw new Error('State changed while reading');return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
    }finally{await file.close();}
  }
  async write(name:string,value:unknown):Promise<void> {
    const temporary=join(this.directory,`.tmp-${randomUUID()}`);
    const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {await file.writeFile(JSON.stringify(value));await file.sync();await file.close();await rename(temporary,join(this.directory,name));}
    finally{await file.close();await unlink(temporary).catch(()=>{});}
  }
  async names():Promise<string[]> {return readdir(this.directory);}
  async close():Promise<void>{await this.lock.close();await unlink(join(this.directory,'server.lock'));}
}
export interface IndexedOperation {index:WebOperationIndexRecord;operation:WebOperation}
export class OperationIndex {
  constructor(readonly state:PrivateState){}
  private name(projectId:string,id:string):string{return 'operation-'+createHash('sha256').update(canonicalWebJson([this.state.principalId,projectId,id])).digest('hex')+'.json';}
  private parse(raw:unknown):IndexedOperation {
    if(!raw || typeof raw!=='object' || !('index' in raw) || !('operation' in raw) || Object.keys(raw).length!==2)throw new Error('Invalid operation ledger');
    const index=WebOperationIndexRecordSchema.parse(raw.index),operation=WebOperationSchema.parse(raw.operation);
    if(index.principalId!==this.state.principalId || index.commandId!==operation.operationId || index.projectId!==operation.projectId || index.owner!==operation.owner || index.operationKind!==operation.operationKind)throw new Error('Operation ledger identity mismatch');
    return {index,operation};
  }
  async read(projectId:string,id:string):Promise<IndexedOperation|undefined>{
    const raw=await this.state.read(this.name(projectId,id));if(raw===undefined)return undefined;
    const value=this.parse(raw);if(value.index.projectId!==projectId || value.index.commandId!==id)throw new Error('Operation scope mismatch');return value;
  }
  async save(record:IndexedOperation):Promise<void>{const parsed=this.parse(record);const old=await this.read(parsed.index.projectId,parsed.index.commandId);
    if(old && canonicalWebJson(old.index)!==canonicalWebJson(parsed.index))throw new HttpError('operation_conflict');
    await this.state.write(this.name(parsed.index.projectId,parsed.index.commandId),parsed);
  }
  async unresolved(projectId:string):Promise<boolean>{for(const name of await this.state.names()) if(/^operation-[a-f0-9]{64}\.json$/.test(name)){
    const value=this.parse(await this.state.read(name));if(value.index.projectId===projectId && !['applied','failed'].includes(value.operation.state))return true;
  }return false;}
}
