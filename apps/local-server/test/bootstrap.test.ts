import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './helpers.js';
let f: Awaited<ReturnType<typeof fixture>>;
afterEach(async()=>{vi.restoreAllMocks();await f?.close();});
it('uses one-time bootstrap with 60s TTL, strict host-only cookie and reloadable CSRF',async()=>{
 f=await fixture();
 expect((await f.send('/api/v1/session/bootstrap','POST',{apiVersion:1,secret:'bad'})).status).toBe(401);
 const {headers,response,secret}=await f.login(); const cookie=response.headers['set-cookie']![0]!;
 expect(cookie).toContain('HttpOnly');expect(cookie).toContain('SameSite=Strict');expect(cookie).toContain('Path=/');expect(cookie).not.toMatch(/Domain=/i);
 expect((await f.send('/api/v1/session/bootstrap','POST',{apiVersion:1,secret})).status).toBe(401);
 const session=await f.send('/api/v1/session','GET',undefined,{Cookie:headers.Cookie});expect(session.json).toEqual(response.json);expect(session.headers['cache-control']).toBe('no-store');
 const expired=await f.server.issueBootstrap();const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+60001);
 expect((await f.send('/api/v1/session/bootstrap','POST',{apiVersion:1,secret:expired})).status).toBe(401);
 vi.mocked(Date.now).mockReturnValue(now+43200001);expect((await f.send('/api/v1/session','GET',undefined,headers)).status).toBe(401);
});
it('invalidates cookie and unconsumed bootstrap at restart',async()=>{
 f=await fixture(); const {headers}=await f.login();const secret=await f.server.issueBootstrap();await f.restart();
 expect((await f.send('/api/v1/session','GET',undefined,headers)).status).toBe(401);
 expect((await f.send('/api/v1/session/bootstrap','POST',{apiVersion:1,secret})).status).toBe(401);
});
