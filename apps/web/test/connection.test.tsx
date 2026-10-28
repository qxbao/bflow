import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient, consumeBootstrap } from '../src/api/client';
import { subscribeEvents } from '../src/api/events';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('removes the pairing fragment synchronously before any network operation', () => {
  history.replaceState(null, '', '/projects/p/runs/r#bootstrap=private-secret');
  expect(consumeBootstrap()).toBe('private-secret');
  expect(location.hash).toBe('');
  expect(location.pathname).toBe('/projects/p/runs/r');
});
it('restores a cookie session and keeps CSRF only in client memory', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({apiVersion:1, sessionId:'browser', expiresAt:'2026-10-30T00:00:00Z', csrfToken:'csrf'})));
  vi.stubGlobal('fetch', fetcher);
  const api = new ApiClient(); await api.authenticate();
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/session');
  expect(localStorage.length).toBe(0);
});
it('rejects unknown response fields and versions', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({apiVersion:2, items:[]}))));
  await expect(new ApiClient().projects()).rejects.toThrow();
});
it('validates SSE scope/cursor, reloads on reset and closes on cleanup', () => {
  const handlers = new Map<string, (event: MessageEvent) => void>();
  const close = vi.fn();
  class Source { addEventListener(name: string, callback: (event: MessageEvent) => void) { handlers.set(name, callback); } close = close; }
  vi.stubGlobal('EventSource', Source);
  const changed = vi.fn(), state = vi.fn();
  const stop = subscribeEvents('p', changed, state);
  handlers.get('reset')?.({type:'reset',data:JSON.stringify({apiVersion:1,cursor:'epoch:1',projectId:'other',type:'reset',resourceIds:[],occurredAt:'2026-10-29T00:00:00Z'})} as MessageEvent);
  expect(changed).not.toHaveBeenCalled();
  handlers.get('reset')?.({type:'reset',data:JSON.stringify({apiVersion:1,cursor:'epoch:2',projectId:'p',type:'reset',resourceIds:[],occurredAt:'2026-10-29T00:00:00Z'})} as MessageEvent);
  expect(changed).toHaveBeenCalledOnce(); stop(); expect(close).toHaveBeenCalled();
});
it('rejects a schema-valid run for another requested identity', async () => {
  const {run}=await import('./fixtures');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({...run,runId:'other'}))));
  await expect(new ApiClient().run('p','run')).rejects.toThrow('invalid_response');
});
it('never renders an attachment response inline',async()=>{
  const cancel=vi.fn();vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,headers:new Headers({'Content-Type':'application/octet-stream','Content-Disposition':'attachment'}),body:{cancel}}));
  await expect(new ApiClient().artifact('p','artifact')).rejects.toThrow('attachment');expect(cancel).toHaveBeenCalledOnce();
});
it('reopens a permanently closed SSE with its last validated cursor and cancels retry on unmount',()=>{
 vi.useFakeTimers();
 const sources:{url:string;handlers:Map<string,(event:MessageEvent)=>void>;close:ReturnType<typeof vi.fn>}[]=[];
 class Source {
   entry;constructor(url:string){this.entry={url,handlers:new Map<string,(event:MessageEvent)=>void>(),close:vi.fn()};sources.push(this.entry);}
   addEventListener(kind:string,fn:(event:MessageEvent)=>void){this.entry.handlers.set(kind,fn);}close(){this.entry.close();}
 }
 vi.stubGlobal('EventSource',Source);const stop=subscribeEvents('p',vi.fn(),vi.fn());
 sources[0]?.handlers.get('reset')?.(new MessageEvent('reset',{data:JSON.stringify({apiVersion:1,cursor:'epoch:2',projectId:'p',type:'reset',resourceIds:[],occurredAt:'2026-10-29T00:00:00Z'})}));
 sources[0]?.handlers.get('error')?.(new MessageEvent('error'));
 vi.advanceTimersByTime(3000);expect(sources).toHaveLength(2);expect(sources[1]?.url).toContain('cursor=epoch%3A2');
 sources[1]?.handlers.get('error')?.(new MessageEvent('error'));stop();vi.advanceTimersByTime(60000);expect(sources).toHaveLength(2);vi.useRealTimers();
});
