import { afterEach, expect, it } from 'vitest';
import { mkdir, symlink, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from './helpers.js';
let f: Awaited<ReturnType<typeof fixture>>;
afterEach(async()=>{await f?.close();});
it('registers only canonical Git roots without setup and persists identity read-only',async()=>{
 f=await fixture();const {headers}=await f.login();const path=await f.repo();const config=await readFile(join(path,'.git/config'),'utf8');
 const r=await f.send('/api/v1/projects','POST',{apiVersion:1,path},headers);expect(r.status).toBe(201);expect(r.json.projectId).toBe('project-'+createHash('sha256').update(path).digest('hex').slice(0,32));
 const sub=join(path,'sub');await mkdir(sub);const duplicate=await f.send('/api/v1/projects','POST',{apiVersion:1,path:sub},headers);expect(duplicate.status).toBe(200);expect(duplicate.json).toEqual(r.json);
 expect(await readFile(join(path,'.git/config'),'utf8')).toBe(config);expect((await stat(f.stateDirectory)).mode&0o777).toBe(0o700);
 await f.restart();const login=await f.login();expect((await f.send('/api/v1/projects','GET',undefined,login.headers)).json.items).toEqual([r.json]);
});
it('rejects nonrepositories, relative paths, symlinks and unconfirmed unregister',async()=>{
 f=await fixture();const {headers}=await f.login();const path=await f.repo();const link=join(f.directory,'link');await symlink(path,link);
 for(const path of ['relative',link,f.directory,'/no-such-w03-repo']) expect((await f.send('/api/v1/projects','POST',{apiVersion:1,path},headers)).status).toBe(400);
 const project=(await f.send('/api/v1/projects','POST',{apiVersion:1,path},headers)).json;
 expect((await f.send('/api/v1/projects/'+project.projectId,'DELETE',{apiVersion:1},headers)).status).toBe(400);
 expect((await f.send('/api/v1/projects/'+project.projectId,'DELETE',{apiVersion:1,confirmed:true},headers)).status).toBe(204);
});
it('rejects private state symlinks/unsafe permissions and refuses a second state owner',async()=>{
 f=await fixture();const {createLocalWebServer}=await import('../src/index.js');const {workspace,client}=await import('./helpers.js');
 const options={host:'127.0.0.1' as const,port:0,stateDirectory:f.stateDirectory,assetsDirectory:f.assetsDirectory,workspace,interaction:async()=>client};
 await expect(createLocalWebServer(options)).rejects.toThrow();
 const link=join(f.directory,'linked-state');await symlink(f.stateDirectory,link);await expect(createLocalWebServer({...options,stateDirectory:link})).rejects.toThrow();
 const {chmod}=await import('node:fs/promises');const unsafe=join(f.directory,'unsafe');await mkdir(unsafe);await chmod(unsafe,0o755);await expect(createLocalWebServer({...options,stateDirectory:unsafe})).rejects.toThrow();
});
it('preserves whitespace in canonical Git paths instead of registering a sibling repository',async()=>{
 f=await fixture();const {headers}=await f.login();const sibling=await f.repo('trailing');const path=await f.repo('trailing ');
 const r=await f.send('/api/v1/projects','POST',{apiVersion:1,path},headers);expect(r.status).toBe(201);expect(r.json.canonicalPath).toBe(path);expect(r.json.canonicalPath).not.toBe(sibling);
});
