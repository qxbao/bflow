import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebDirectorProfileNameSchema } from '@bflow/contracts/web';
import { IsolatorProfileResolver, type IsolatorProfileIdentity } from '@bflow/runtime/platform/isolator-profile';
import { captureDirectorMachineEnvironment, DIRECTOR_MACHINE_ENV } from './director-machine-environment.js';
import type { DirectorLaunchProvider } from './director-terminal.js';

type ProfileOption={name:string;state:'available'|'unavailable';reason?:string};
export interface DirectorProfileSelection {
 readonly name:string;
 readonly executable:string;
 readonly identity:IsolatorProfileIdentity;
 readonly selectors:Readonly<Record<string,string>>;
}
export interface DirectorProfileAccess {
 list(provider:DirectorLaunchProvider):Promise<ProfileOption[]>;
 select(provider:DirectorLaunchProvider,name:string):Promise<DirectorProfileSelection>;
}
export class DirectorProfileError extends Error {}
const validName=(name:string)=>WebDirectorProfileNameSchema.safeParse(name).success;
const supported=(provider:DirectorLaunchProvider)=>provider==='codex'||provider==='claude';
/** Existing profiles only: the resolver validates ownership, metadata and selected backend. No login or profile creation. */
export function createDirectorProfileAccess(environment:Readonly<Record<string,string|undefined>>,
 find:(name:string)=>Promise<string|null>):DirectorProfileAccess{
 const realHome=resolve(environment.AI_ISOLATOR_REAL_HOME||environment.HOME||homedir());
 const stateRoot=resolve(environment.AI_ISOLATOR_HOME||join(realHome,'.local/share/ai-isolator'));
 const resolver=new IsolatorProfileResolver({stateRoot,environment,homeDirectory:realHome});
 const select=async(provider:DirectorLaunchProvider,name:string):Promise<DirectorProfileSelection>=>{
  if(!supported(provider)||!validName(name))throw new DirectorProfileError('Profile không hợp lệ cho ai-isolator.');
  const executable=await find('ai-isolator');
  if(!executable)throw new DirectorProfileError('Không tìm thấy ai-isolator trên máy này.');
  const result=await resolver.resolve(provider,name,{timeoutMs:3000});
  if(!result.ok)throw new DirectorProfileError(result.error.code==='transport_unavailable'||result.error.code==='timeout'
   ?'Backend của profile chưa sẵn sàng. Kiểm tra ai-isolator status.':'Profile không còn hợp lệ hoặc không truy cập được. Kiểm tra ai-isolator status.');
  return {name,executable,identity:result.value.identity,selectors:{AI_ISOLATOR_HOME:result.value.identity.stateRoot,AI_ISOLATOR_REAL_HOME:realHome,[DIRECTOR_MACHINE_ENV]:captureDirectorMachineEnvironment(environment)}};
 };
 return {select,async list(provider){
  if(!supported(provider))return [];
  let entries;
  try{entries=await readdir(join(stateRoot,'profiles'),{withFileTypes:true});}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const prefix=provider+'--';
  const names=entries.filter(entry=>entry.isDirectory()&&entry.name.startsWith(prefix)&&validName(entry.name.slice(prefix.length)))
   .map(entry=>entry.name.slice(prefix.length)).sort().slice(0,100);
  return Promise.all(names.map(async name=>{
   try{await select(provider,name);return {name,state:'available' as const};}
   catch(error){return {name,state:'unavailable' as const,reason:error instanceof DirectorProfileError?error.message:'Không kiểm tra được profile.'};}
  }));
 }};
}
