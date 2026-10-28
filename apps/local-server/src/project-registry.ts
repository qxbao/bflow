import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { WebPageSchema, WebProjectSchema, type WebProject } from '@bflow/contracts/web';
import { PrivateState, OperationIndex } from './operation-index.js';
import { HttpError } from './errors.js';
const exec=promisify(execFile);
export class ProjectRegistry {
  constructor(readonly state:PrivateState,readonly operations:OperationIndex){}
  async list():Promise<WebProject[]>{const raw=await this.state.read('projects.json');return raw===undefined?[]:WebPageSchema(WebProjectSchema).parse(raw).items;}
  async get(id:string):Promise<WebProject>{const project=(await this.list()).find(p=>p.projectId===id);if(!project)throw new HttpError('not_found');return project;}
  /** Revalidate identity before every injected backend call; never execute from a browser cwd. */
  async require(id:string):Promise<WebProject>{const p=await this.get(id);try{if(await realpath(p.canonicalPath)!==p.canonicalPath || !(await stat(p.canonicalPath)).isDirectory())throw new Error();
    const root=await this.gitRoot(p.canonicalPath);if(root!==p.canonicalPath)throw new Error();return p;
  }catch{throw new HttpError('unavailable');}}
  private async gitRoot(path:string):Promise<string>{
    const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
    const {stdout}=await exec('git',['--no-optional-locks','-C',path,'rev-parse','--show-toplevel'],{env,timeout:5000,maxBuffer:8192});
    return realpath(stdout.endsWith('\n')?stdout.slice(0,-1):stdout);
  }
  async register(path:string):Promise<{project:WebProject;created:boolean}>{
    let root:string;
    try{if(!isAbsolute(path) || await realpath(path)!==resolve(path))throw new Error();root=await this.gitRoot(path);}catch{throw new HttpError('invalid_request');}
    const project=WebProjectSchema.parse({apiVersion:1,projectId:'project-'+createHash('sha256').update(root).digest('hex').slice(0,32),canonicalPath:root,displayName:basename(root)||root,registrationState:'registered'});
    const items=await this.list(),previous=items.find(p=>p.projectId===project.projectId);if(previous)return {project:previous,created:false};
    if(items.length>=100)throw new HttpError('operation_not_allowed');
    await this.state.write('projects.json',WebPageSchema(WebProjectSchema).parse({apiVersion:1,items:[...items,project]}));return {project,created:true};
  }
  async unregister(id:string):Promise<void>{await this.get(id);if(await this.operations.unresolved(id))throw new HttpError('operation_conflict');
    await this.state.write('projects.json',{apiVersion:1,items:(await this.list()).filter(p=>p.projectId!==id)});
  }
}
