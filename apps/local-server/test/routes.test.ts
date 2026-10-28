import { afterEach, expect, it } from 'vitest';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.js';
let f: Awaited<ReturnType<typeof fixture>>;
afterEach(async()=>{await f?.close();});
it('keeps API errors JSON, rejects malformed inputs/query and never leaks backend details',async()=>{
 f=await fixture();const {headers}=await f.login();
 for(const path of ['/api/v2/foo','/api/v1/unknown','/api','/api/v1/projects/nope/runs']) {const r=await f.send(path,'GET',undefined,headers);expect(r.status).toBe(404);expect(r.headers['content-type']).toContain('application/json');}
 for(const body of ['{',{apiVersion:1,path:'/tmp',trusted:true}]) expect((await f.send('/api/v1/projects','POST',body,headers)).status).toBe(400);
 expect((await f.send('/api/v1/projects?unexpected=1','GET',undefined,headers)).status).toBe(400);
 const p=(await f.send('/api/v1/projects','POST',{apiVersion:1,path:await f.repo()},headers)).json.projectId;
 expect((await f.send(`/api/v1/projects/${p}/runs?limit=0`,'GET',undefined,headers)).status).toBe(400);
 expect((await f.send(`/api/v1/projects/${p}/runs?limit=1&limit=2`,'GET',undefined,headers)).status).toBe(400);
 const r=await f.send(`/api/v1/projects/${p}/preview`,'GET',undefined,headers);expect(r.status).toBe(503);expect(r.body).not.toContain('/secret/socket');
 expect((await f.send(`/api/v1/projects/${p}/commands`,'POST',{apiVersion:1,commandId:crypto.randomUUID(),projectId:'other',kind:'cancel',runId:'run',expectedVersion:{revisionToken:'v'},reason:'x'},headers)).status).toBe(403);
});
it('serves SPA after API handling and rejects encoded traversal and asset symlink escape',async()=>{
 f=await fixture();await writeFile(join(f.directory,'private.txt'),'SECRET');await symlink(join(f.directory,'private.txt'),join(f.assetsDirectory,'leak.txt'));
 expect((await f.send('/projects/detail')).body).toContain('SPA');
 for(const path of ['/../private.txt','/%2e%2e/private.txt','/%2e%2e%2fprivate.txt','/%252e%252e/private.txt','/leak.txt','/%00','/%zz']) {const r=await f.send(path);expect(r.status).toBeGreaterThanOrEqual(400);expect(r.body).not.toContain('SECRET');}
});
it('rejects GET bodies rather than ignoring unknown boundary data',async()=>{
 f=await fixture();const {headers}=await f.login();expect((await f.send('/api/v1/projects','GET',{apiVersion:1,unexpected:true},headers)).status).toBe(400);
});
it('serves the root bootstrap landing page',async()=>{
 f=await fixture();const r=await f.send('/');expect(r.status).toBe(200);expect(r.body).toContain('SPA');
});
it('does not discard unsupported query data after a second question mark',async()=>{
 f=await fixture();const {headers}=await f.login();expect((await f.send('/api/v1/projects??unexpected=1','GET',undefined,headers)).status).toBe(400);
});
